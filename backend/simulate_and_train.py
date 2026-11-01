#!/usr/bin/env python3
"""
backend/simulate_and_train.py
=============================
HydroShield OD - spatial graphs, storm simulator and severity model.

What it does
------------
1. Builds a road graph Gr (120 nodes, 200 directed edges) and a drainage graph
   Gd (25 nodes, DR-01..DR-25) for Bhubaneswar (Nayapalli / ISKCON NH-16) or
   Cuttack (Badambadi / SCB Medical). DR-01..DR-05 are pinned to the real
   landmark coordinates. Remaining geometry is SYNTHETIC (jittered street grid
   inside the study bounding box), and is labelled as such in every export.
2. Runs a seeded storm-scenario simulator: 60 scenarios x 250 segment-time
   samples = 15,000 rows.
3. Trains a RandomForestClassifier (train/test split strictly by scenario_id),
   compares it with a rainfall-threshold baseline, and exports:
       data/roads.geojson, data/drains.geojson, data/link_table.csv,
       data/hospitals.json, data/simulated_samples.csv,
       models/severity_model.joblib, models/metrics_comparison.json

Usage
-----
    pip install numpy pandas scikit-learn networkx joblib
    python backend/simulate_and_train.py                    # Bhubaneswar
    python backend/simulate_and_train.py --area cuttack     # Cuttack
    python backend/simulate_and_train.py --seed 7 --out-dir backend

Honesty note
------------
Labels come from the simulator's own hydraulic rule plus hidden noise, so the
reported scores measure "how well ML recovers the simulator", not real-world
flood-forecast skill. Report them as simulation benchmarks.
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import joblib
import networkx as nx
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import accuracy_score, confusion_matrix, f1_score, precision_recall_fscore_support
from sklearn.model_selection import GroupKFold

# --------------------------------------------------------------------------- #
# Configuration
# --------------------------------------------------------------------------- #
N_ROAD_NODES, GRID_ROWS, GRID_COLS = 120, 10, 12
N_ROAD_EDGES = 200
N_DRAINS = 25
N_SCENARIOS, N_SAMPLES = 60, 15_000
N_TEST_SCENARIOS = 12
TIMESTEPS, STEP_MIN = 24, 5            # 24 x 5 min = 2 h storm window

SEVERITY_LABELS = {0: "Normal", 1: "Watch", 2: "Severe", 3: "Critical"}
DEPTH_THRESHOLDS_M = (0.10, 0.30, 0.60)       # true depth -> severity
RAIN_THRESHOLDS_MM_HR = (15.0, 40.0, 65.0)    # baseline rule: rainfall -> severity

FEATURES = [
    "rainfall_mm_hr", "antecedent_wetness", "relative_elevation_m", "slope",
    "upstream_contributing_nodes", "drain_capacity_proxy", "blockage_fraction",
    "flow_to_capacity_ratio", "water_level_m", "sensor_age_sec",
]

AREAS = {
    "bhubaneswar": {
        "title": "Bhubaneswar - Nayapalli / ISKCON NH-16 (Drainage Channel No. 4)",
        "bbox": (20.2880, 20.3050, 85.8120, 85.8320),     # lat_min, lat_max, lon_min, lon_max
        "terrain": "slope",
        "tags": [
            ("DR-01", "ISKCON Temple NH-16 Box Culvert", 20.2961, 85.8245),
            ("DR-02", "CRP Square Main Junction Inlet", 20.2915, 85.8168),
            ("DR-03", "Behera Sahi / VIP Colony Low-Point Drain", 20.2982, 85.8260),
            ("DR-04", "Jayadev Vihar Hospital Connector Grate", 20.2998, 85.8285),
            ("DR-05", "Drainage Channel No. 4 Outfall", 20.2930, 85.8305),
        ],
        # Approximate locations OUTSIDE the box -> snapped to the nearest boundary node
        # (gateway nodes). Verify exact coordinates before any real use.
        "hospitals": [
            ("KIMS corridor gateway (north)", 20.3540, 85.8170),
            ("Capital Hospital corridor gateway (south-east)", 20.2630, 85.8380),
            ("AIIMS corridor gateway (south-west)", 20.2310, 85.7740),
        ],
    },
    "cuttack": {
        "title": "Cuttack - Badambadi / Matamath (Main Storm Water Channel No. 1)",
        "bbox": (20.4550, 20.4720, 85.8700, 85.8920),
        "terrain": "saucer",
        "tags": [
            ("DR-01", "Badambadi Bus Terminal Main Culvert", 20.4625, 85.8792),
            ("DR-02", "SCB Medical Road / Mangalabag Drain Inlet", 20.4710, 85.8865),
            ("DR-03", "Pithapur / Dolamundai Junction Conduit", 20.4652, 85.8810),
            ("DR-04", "Chhatra Bazar MSWC-1 Open Channel Bridge", 20.4605, 85.8895),
            ("DR-05", "Matamath Sluice Gate & Pump House Forebay", 20.4535, 85.8760),
        ],
        "hospitals": [
            ("SCB Medical College & Hospital (approach)", 20.4710, 85.8865),
            ("District hospital gateway (approx.)", 20.4580, 85.8840),
        ],
    },
}

ROAD_CLASSES = {  # speed km/h, criticality weight
    "arterial": (40.0, 1.0),
    "collector": (30.0, 0.6),
    "local": (20.0, 0.3),
    "ring_bypass": (35.0, 0.5),
}


# --------------------------------------------------------------------------- #
# Geometry helpers
# --------------------------------------------------------------------------- #
def meters_per_deg(lat: float) -> tuple[float, float]:
    return 110_574.0, 111_320.0 * math.cos(math.radians(lat))


def dist_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Equirectangular distance in metres between (lat, lon) points (fine at ~3 km)."""
    mlat, mlon = meters_per_deg((a[0] + b[0]) / 2)
    return math.hypot((a[0] - b[0]) * mlat, (a[1] - b[1]) * mlon)


def make_terrain(cfg: dict):
    lat0, lat1, lon0, lon1 = cfg["bbox"]
    clat, clon = (lat0 + lat1) / 2, (lon0 + lon1) / 2

    def elev(lat: float, lon: float) -> float:
        ln = (lon - lon0) / (lon1 - lon0)
        la = (lat - lat0) / (lat1 - lat0)
        ripple = 0.35 * math.sin(14 * ln) * math.cos(11 * la)
        if cfg["terrain"] == "slope":
            # Upland ridge (west / north-west) falling to the valley floor (east / south-east)
            u = float(np.clip(0.7 * (1 - ln) + 0.3 * la, 0, 1))
            return 18.0 + 27.0 * u ** 1.1 + 1.5 * ripple
        # Saucer: low centre, ring embankment on the rim
        r = math.hypot((ln - 0.5) * 2, (la - 0.5) * 2)
        return 6.0 + 4.0 * min(r, 1.2) ** 2 + 0.3 * ripple

    return elev


# --------------------------------------------------------------------------- #
# Road graph Gr
# --------------------------------------------------------------------------- #
def build_road_graph(cfg: dict, elev, rng: np.random.Generator) -> nx.DiGraph:
    lat0, lat1, lon0, lon1 = cfg["bbox"]
    m_lat, m_lon = 0.06 * (lat1 - lat0), 0.06 * (lon1 - lon0)
    cell_lat = (lat1 - lat0 - 2 * m_lat) / (GRID_ROWS - 1)
    cell_lon = (lon1 - lon0 - 2 * m_lon) / (GRID_COLS - 1)

    G = nx.DiGraph(name="Gr")
    idx = lambda r, c: r * GRID_COLS + c
    for r in range(GRID_ROWS):
        for c in range(GRID_COLS):
            lat = lat0 + m_lat + r * cell_lat + rng.uniform(-0.25, 0.25) * cell_lat
            lon = lon0 + m_lon + c * cell_lon + rng.uniform(-0.25, 0.25) * cell_lon
            G.add_node(idx(r, c), lat=lat, lon=lon, row=r, col=c, name="", pinned=False)

    def pin(name: str, lat: float, lon: float, kind: str) -> int:
        free = [n for n, d in G.nodes(data=True) if not d["pinned"]]
        best = min(free, key=lambda n: dist_m((G.nodes[n]["lat"], G.nodes[n]["lon"]), (lat, lon)))
        G.nodes[best].update(name=name, pinned=True, kind=kind)
        return best

    tag_nodes = {}
    for did, name, lat, lon in cfg["tags"]:
        n = pin(f"{did}: {name}", lat, lon, "nfc_tag")
        G.nodes[n].update(lat=lat, lon=lon)           # exact landmark coordinates
        tag_nodes[did] = n
    G.graph["tag_nodes"] = tag_nodes

    hosp_nodes = []
    for name, lat, lon in cfg["hospitals"]:
        hosp_nodes.append(pin(f"HOSPITAL: {name}", lat, lon, "hospital"))
    G.graph["hospital_nodes"] = hosp_nodes

    # Backbone: one-way serpentine ring through all 120 nodes (guarantees strong connectivity)
    order = []
    for r in range(GRID_ROWS):
        cols = range(GRID_COLS) if r % 2 == 0 else range(GRID_COLS - 1, -1, -1)
        order += [idx(r, c) for c in cols]
    ring = list(zip(order, order[1:])) + [(order[-1], order[0])]
    used = set()
    for u, v in ring:
        cls = "ring_bypass" if (u, v) == ring[-1] else rng.choice(["collector", "local"], p=[0.45, 0.55])
        G.add_edge(u, v, road_class=str(cls), oneway=True)
        used.add(frozenset((u, v)))

    # 40 extra two-way links (80 directed edges) between grid neighbours -> 200 edges total
    cand = []
    for r in range(GRID_ROWS):
        for c in range(GRID_COLS):
            for dr, dc in ((0, 1), (1, 0)):
                rr, cc = r + dr, c + dc
                if rr < GRID_ROWS and cc < GRID_COLS and frozenset((idx(r, c), idx(rr, cc))) not in used:
                    cand.append((idx(r, c), idx(rr, cc)))
    need_pairs = (N_ROAD_EDGES - len(ring)) // 2
    for i in rng.choice(len(cand), size=need_pairs, replace=False):
        u, v = cand[i]
        cls = str(rng.choice(["arterial", "collector"], p=[0.6, 0.4]))
        G.add_edge(u, v, road_class=cls, oneway=False)
        G.add_edge(v, u, road_class=cls, oneway=False)
    assert G.number_of_nodes() == N_ROAD_NODES and G.number_of_edges() == N_ROAD_EDGES
    assert nx.is_strongly_connected(G)

    # Edge attributes
    z_all = [elev(d["lat"], d["lon"]) for _, d in G.nodes(data=True)]
    z_min = min(z_all)
    for k, (u, v, d) in enumerate(G.edges(data=True)):
        a, b = G.nodes[u], G.nodes[v]
        length = max(dist_m((a["lat"], a["lon"]), (b["lat"], b["lon"])), 20.0)
        za, zb = elev(a["lat"], a["lon"]), elev(b["lat"], b["lon"])
        speed = ROAD_CLASSES[d["road_class"]][0]
        d.update(
            edge_id=f"R{k:03d}", length_m=length,
            travel_min=length / (speed * 1000 / 60),
            slope=abs(za - zb) / length,
            rel_elev=(za + zb) / 2 - z_min,
            mid_lat=(a["lat"] + b["lat"]) / 2, mid_lon=(a["lon"] + b["lon"]) / 2,
        )

    # Criticality = share of shortest paths to the nearest hospital that use the edge, blended with class
    use = {e: 0 for e in G.edges}
    for n in G.nodes:
        if n in hosp_nodes:
            continue
        best = min(
            (nx.single_source_dijkstra(G, n, target=h, weight="travel_min") for h in hosp_nodes),
            key=lambda t: t[0],
        )
        path = best[1]
        for e in zip(path, path[1:]):
            use[e] += 1
    mx = max(use.values()) or 1
    for e, d in G.edges.items():
        d["hospital_path_share"] = use[e] / mx
        d["criticality"] = round(0.6 * use[e] / mx + 0.4 * ROAD_CLASSES[d["road_class"]][1], 4)
    return G


# --------------------------------------------------------------------------- #
# Drainage graph Gd
# --------------------------------------------------------------------------- #
def build_drain_graph(cfg: dict, elev, rng: np.random.Generator) -> nx.DiGraph:
    lat0, lat1, lon0, lon1 = cfg["bbox"]
    pts = {did: (lat, lon, name) for did, name, lat, lon in cfg["tags"]}
    for i in range(6, N_DRAINS + 1):
        for _ in range(500):
            p = (rng.uniform(lat0, lat1), rng.uniform(lon0, lon1))
            if all(dist_m(p, (q[0], q[1])) > 150 for q in pts.values()):
                break
        pts[f"DR-{i:02d}"] = (p[0], p[1], f"Synthetic inlet {i:02d}")

    z = {d: elev(p[0], p[1]) for d, p in pts.items()}
    z["DR-05"] = min(z.values()) - 0.5                       # outfall = lowest point
    z["DR-01"] = max(min(z["DR-01"], float(np.percentile(list(z.values()), 25))), z["DR-05"] + 0.3)

    G = nx.DiGraph(name="Gd")
    for d, (lat, lon, name) in pts.items():
        G.add_node(d, lat=lat, lon=lon, name=name, invert_elev_m=z[d],
                   nfc_tagged=d in {t[0] for t in cfg["tags"]})
    for d in G.nodes:
        if d == "DR-05":
            continue
        lower = [o for o in G.nodes if z[o] < z[d]]
        if d == "DR-01" or not lower:
            down = "DR-05"                                   # culvert discharges to the outfall channel
        else:
            down = min(lower, key=lambda o: dist_m((pts[d][0], pts[d][1]), (pts[o][0], pts[o][1])))
        G.add_edge(d, down, length_m=dist_m((pts[d][0], pts[d][1]), (pts[down][0], pts[down][1])))
    assert nx.is_directed_acyclic_graph(G)

    for d in G.nodes:
        n_up = len(nx.ancestors(G, d))
        area = 0.03 * (n_up + 1) * float(rng.lognormal(0, 0.25))      # km2 catchment (proxy)
        G.nodes[d].update(
            upstream_contributing_nodes=n_up,
            catchment_km2=round(area, 4),
            drain_capacity_proxy=round(1.5 + 0.45 * (n_up + 1) + float(rng.normal(0, 0.15)), 3),  # m3/s proxy
        )
    return G


def build_link_table(Gr: nx.DiGraph, Gd: nx.DiGraph) -> pd.DataFrame:
    rows = []
    for u, v, d in Gr.edges(data=True):
        best = min(Gd.nodes, key=lambda n: dist_m((d["mid_lat"], d["mid_lon"]), (Gd.nodes[n]["lat"], Gd.nodes[n]["lon"])))
        dd = Gd.nodes[best]
        rows.append({
            "road_edge_id": d["edge_id"], "road_u": u, "road_v": v, "drain_id": best,
            "distance_m": round(dist_m((d["mid_lat"], d["mid_lon"]), (dd["lat"], dd["lon"])), 1),
            "relative_elevation_m": round(d["rel_elev"], 3), "slope": round(d["slope"], 5),
            "upstream_contributing_nodes": dd["upstream_contributing_nodes"],
            "drain_capacity_proxy": dd["drain_capacity_proxy"],
            "catchment_km2": dd["catchment_km2"],
            "criticality": d["criticality"], "road_class": d["road_class"],
        })
    return pd.DataFrame(rows)


# --------------------------------------------------------------------------- #
# Scenario simulator
# --------------------------------------------------------------------------- #
def severity_from_depth(depth: np.ndarray) -> np.ndarray:
    return np.digitize(depth, DEPTH_THRESHOLDS_M)


def simulate(link: pd.DataFrame, Gd: nx.DiGraph, rng: np.random.Generator) -> pd.DataFrame:
    drains = list(Gd.nodes)
    rel_max = link["relative_elevation_m"].max() or 1.0
    per = N_SAMPLES // N_SCENARIOS
    rows = []
    for sid in range(N_SCENARIOS):
        kind = rng.choice(["light", "moderate", "extreme"], p=[0.25, 0.40, 0.35])
        peak = {"light": rng.uniform(15, 40), "moderate": rng.uniform(40, 75), "extreme": rng.uniform(75, 160)}[kind]
        t_peak, width = rng.uniform(6, 18), rng.uniform(3, 7)
        wetness = float(rng.beta(2, 2))
        base_block = {d: float(rng.beta(1.2, 6)) for d in drains}
        for d in rng.choice(drains, size=int(rng.integers(0, 4)), replace=False):
            base_block[d] = float(rng.beta(6, 2))                      # choked drain
        if rng.random() < 0.25:
            base_block["DR-01"] = float(rng.beta(6, 2))                # culvert bottleneck scenario
        for _ in range(per):
            seg = link.iloc[int(rng.integers(len(link)))]
            t = int(rng.integers(TIMESTEPS))
            rain = max(0.0, peak * math.exp(-0.5 * ((t - t_peak) / width) ** 2) + rng.normal(0, 2.0))
            block = float(np.clip(base_block[seg.drain_id] + 0.15 * t / TIMESTEPS * rng.random() + rng.normal(0, 0.02), 0, 0.95))
            runoff_c = 0.5 + 0.4 * wetness
            q_in = runoff_c * rain * seg.catchment_km2 / 3.6                   # rational method, m3/s
            ratio = q_in / (seg.drain_capacity_proxy * (1 - block) + 1e-6)
            lowness = 1.0 - seg.relative_elevation_m / rel_max
            ponding = max(0.0, ratio - 0.7) * 0.6 * (0.4 + 1.2 * lowness) * (1.0 - min(seg.slope * 20, 0.5))
            sheet = 0.004 * max(0.0, rain - 40) * lowness
            true_depth = float(np.clip(ponding + sheet + rng.normal(0, 0.04), 0, 2.5))   # hidden noise
            age = float(rng.exponential(60) if rng.random() > 0.06 else rng.uniform(600, 3600))
            observed = float(np.clip(true_depth * math.exp(-age / 1800) + rng.normal(0, 0.02 + age / 40_000), 0, 2.5))
            rows.append({
                "scenario_id": sid, "scenario_kind": kind, "t_step": t, "road_edge_id": seg.road_edge_id,
                "drain_id": seg.drain_id, "rainfall_mm_hr": rain, "antecedent_wetness": wetness,
                "relative_elevation_m": seg.relative_elevation_m, "slope": seg.slope,
                "upstream_contributing_nodes": seg.upstream_contributing_nodes,
                "drain_capacity_proxy": seg.drain_capacity_proxy, "blockage_fraction": block,
                "flow_to_capacity_ratio": ratio, "water_level_m": observed, "sensor_age_sec": age,
                "true_depth_m": true_depth, "severity": int(severity_from_depth(np.array([true_depth]))[0]),
            })
    return pd.DataFrame(rows)


# --------------------------------------------------------------------------- #
# Model, baseline, metrics
# --------------------------------------------------------------------------- #
def score(y_true, y_pred) -> dict:
    labels = [0, 1, 2, 3]
    p, r, f, _ = precision_recall_fscore_support(y_true, y_pred, labels=labels, zero_division=0)
    sev_true, sev_pred = np.asarray(y_true) >= 2, np.asarray(y_pred) >= 2
    tp = int((sev_true & sev_pred).sum())
    return {
        "macro_f1": round(float(f1_score(y_true, y_pred, average="macro", labels=labels, zero_division=0)), 4),
        "accuracy": round(float(accuracy_score(y_true, y_pred)), 4),
        "per_class_f1": {SEVERITY_LABELS[i]: round(float(f[i]), 4) for i in labels},
        "per_class_precision": {SEVERITY_LABELS[i]: round(float(p[i]), 4) for i in labels},
        "per_class_recall": {SEVERITY_LABELS[i]: round(float(r[i]), 4) for i in labels},
        "severe_or_critical_recall": round(tp / max(int(sev_true.sum()), 1), 4),
        "severe_or_critical_precision": round(tp / max(int(sev_pred.sum()), 1), 4),
        "confusion_matrix": confusion_matrix(y_true, y_pred, labels=labels).tolist(),
    }


def rainfall_baseline(rain: np.ndarray, thresholds=RAIN_THRESHOLDS_MM_HR) -> np.ndarray:
    return np.digitize(rain, thresholds)


def tune_baseline_thresholds(rain: np.ndarray, y: np.ndarray) -> tuple:
    """Fair baseline: pick the 3 rainfall cut-offs that maximise macro-F1 on TRAINING data only."""
    grid = np.arange(5, 130, 5.0)
    best, best_f = RAIN_THRESHOLDS_MM_HR, -1.0
    for a in grid:
        for b in grid[grid > a]:
            for c in grid[grid > b]:
                f = f1_score(y, np.digitize(rain, (a, b, c)), average="macro", labels=[0, 1, 2, 3], zero_division=0)
                if f > best_f:
                    best, best_f = (float(a), float(b), float(c)), f
    return best


def make_rf(seed: int) -> RandomForestClassifier:
    return RandomForestClassifier(
        n_estimators=300, max_depth=14, min_samples_leaf=3,
        class_weight="balanced_subsample", n_jobs=-1, random_state=seed,
    )


def train_and_evaluate(df: pd.DataFrame, seed: int):
    rng = np.random.default_rng(seed + 1)
    scen = np.arange(N_SCENARIOS)
    test_sc = np.sort(rng.choice(scen, size=N_TEST_SCENARIOS, replace=False))
    is_test = df["scenario_id"].isin(test_sc).to_numpy()
    train, test = df[~is_test], df[is_test]
    assert set(train.scenario_id).isdisjoint(set(test.scenario_id)), "scenario leakage!"

    clf = make_rf(seed).fit(train[FEATURES], train["severity"])
    pred = clf.predict(test[FEATURES])
    rain_cuts = tune_baseline_thresholds(train["rainfall_mm_hr"].to_numpy(), train["severity"].to_numpy())
    base = rainfall_baseline(test["rainfall_mm_hr"].to_numpy(), rain_cuts)

    cv = []
    for tr, te in GroupKFold(n_splits=5).split(df, df["severity"], df["scenario_id"]):
        m = make_rf(seed).fit(df.iloc[tr][FEATURES], df.iloc[tr]["severity"])
        cv.append(f1_score(df.iloc[te]["severity"], m.predict(df.iloc[te][FEATURES]), average="macro"))

    ml, rb = score(test["severity"], pred), score(test["severity"], base)
    metrics = {
        "provenance": {
            "geometry": "SYNTHETIC jittered street grid in study bbox; DR-01..DR-05 and hospital gateways pinned to landmark coordinates",
            "telemetry": "SIMULATED (seeded scenario generator)",
            "warning": "Scores measure recovery of the simulator's hydraulic rule, not real-world forecast skill.",
        },
        "dataset": {
            "n_samples": int(len(df)), "n_scenarios": N_SCENARIOS,
            "train_scenarios": int((~np.isin(scen, test_sc)).sum()), "test_scenarios": int(len(test_sc)),
            "test_scenario_ids": test_sc.tolist(), "n_train": int(len(train)), "n_test": int(len(test)),
            "split": "strictly by scenario_id",
            "class_balance_all": {SEVERITY_LABELS[k]: int(v) for k, v in df["severity"].value_counts().sort_index().items()},
        },
        "labels": SEVERITY_LABELS,
        "label_rule_depth_m": {"watch_from": DEPTH_THRESHOLDS_M[0], "severe_from": DEPTH_THRESHOLDS_M[1], "critical_from": DEPTH_THRESHOLDS_M[2]},
        "baseline_rule_mm_hr": {"watch_from": rain_cuts[0], "severe_from": rain_cuts[1], "critical_from": rain_cuts[2],
                                "note": "cut-offs tuned on training scenarios only (fair baseline); untuned defaults were " + str(RAIN_THRESHOLDS_MM_HR)},
        "random_forest": ml,
        "rainfall_threshold_baseline": rb,
        "macro_f1_gain": round(ml["macro_f1"] - rb["macro_f1"], 4),
        "group_kfold_macro_f1": {"folds": [round(float(x), 4) for x in cv], "mean": round(float(np.mean(cv)), 4), "std": round(float(np.std(cv)), 4)},
        "feature_importance": {f: round(float(i), 4) for f, i in sorted(zip(FEATURES, clf.feature_importances_), key=lambda x: -x[1])},
        "features": FEATURES,
    }
    return clf, metrics


# --------------------------------------------------------------------------- #
# Exports
# --------------------------------------------------------------------------- #
def export_roads(Gr: nx.DiGraph, link: pd.DataFrame, path: Path, area: str):
    lk = link.set_index("road_edge_id")
    feats = []
    for u, v, d in Gr.edges(data=True):
        a, b = Gr.nodes[u], Gr.nodes[v]
        feats.append({
            "type": "Feature",
            "geometry": {"type": "LineString", "coordinates": [[a["lon"], a["lat"]], [b["lon"], b["lat"]]]},
            "properties": {
                "edge_id": d["edge_id"], "u": u, "v": v, "road_class": d["road_class"], "oneway": d["oneway"],
                "length_m": round(d["length_m"], 1), "travel_min": round(d["travel_min"], 3),
                "relative_elevation_m": round(d["rel_elev"], 3), "slope": round(d["slope"], 5),
                "criticality": d["criticality"], "linked_drain": lk.loc[d["edge_id"], "drain_id"],
                "u_name": a["name"], "v_name": b["name"],
                "provenance": "SYNTHETIC_GRID_ANCHORED_TO_REAL_LANDMARKS", "area": area,
            },
        })
    path.write_text(json.dumps({"type": "FeatureCollection", "name": "roads", "features": feats}, indent=1), encoding="utf-8")


def export_nodes_into_hospitals(Gr: nx.DiGraph, cfg: dict, path: Path):
    out = {
        "hospitals": [
            {"road_node": n, "name": Gr.nodes[n]["name"], "lat": Gr.nodes[n]["lat"], "lon": Gr.nodes[n]["lon"],
             "verified_coordinates": False}
            for n in Gr.graph["hospital_nodes"]
        ],
        "nfc_tag_road_nodes": {k: v for k, v in Gr.graph["tag_nodes"].items()},
        "road_nodes": [{"id": n, "lat": d["lat"], "lon": d["lon"], "name": d["name"]} for n, d in Gr.nodes(data=True)],
    }
    path.write_text(json.dumps(out, indent=1), encoding="utf-8")


def export_drains(Gd: nx.DiGraph, path: Path, area: str):
    feats = []
    for n, d in Gd.nodes(data=True):
        feats.append({
            "type": "Feature", "geometry": {"type": "Point", "coordinates": [d["lon"], d["lat"]]},
            "properties": {
                "feature_type": "drain_node", "drain_id": n, "name": d["name"], "nfc_tagged": d["nfc_tagged"],
                "invert_elev_m": round(d["invert_elev_m"], 3),
                "upstream_contributing_nodes": d["upstream_contributing_nodes"],
                "catchment_km2": d["catchment_km2"], "drain_capacity_proxy": d["drain_capacity_proxy"],
                "provenance": "REAL_COORDINATES" if d["nfc_tagged"] else "SYNTHETIC", "area": area,
            },
        })
    for u, v, d in Gd.edges(data=True):
        a, b = Gd.nodes[u], Gd.nodes[v]
        feats.append({
            "type": "Feature",
            "geometry": {"type": "LineString", "coordinates": [[a["lon"], a["lat"]], [b["lon"], b["lat"]]]},
            "properties": {"feature_type": "conduit", "from": u, "to": v, "length_m": round(d["length_m"], 1), "provenance": "SYNTHETIC"},
        })
    path.write_text(json.dumps({"type": "FeatureCollection", "name": "drains", "features": feats}, indent=1), encoding="utf-8")


# --------------------------------------------------------------------------- #
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--area", choices=list(AREAS), default="bhubaneswar", help="study basin (default: bhubaneswar)")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--out-dir", type=Path, default=Path(__file__).resolve().parent, help="writes <out>/data and <out>/models")
    args = ap.parse_args()

    cfg = AREAS[args.area]
    rng = np.random.default_rng(args.seed)
    data_dir, model_dir = args.out_dir / "data", args.out_dir / "models"
    data_dir.mkdir(parents=True, exist_ok=True)
    model_dir.mkdir(parents=True, exist_ok=True)

    print(f"[1/4] Building graphs for {cfg['title']}")
    elev = make_terrain(cfg)
    Gr = build_road_graph(cfg, elev, rng)
    Gd = build_drain_graph(cfg, elev, rng)
    link = build_link_table(Gr, Gd)
    print(f"      Gr: {Gr.number_of_nodes()} nodes / {Gr.number_of_edges()} directed edges | "
          f"Gd: {Gd.number_of_nodes()} nodes / {Gd.number_of_edges()} conduits")

    print(f"[2/4] Simulating {N_SCENARIOS} scenarios -> {N_SAMPLES} samples")
    df = simulate(link, Gd, rng)
    print("      class balance:", {SEVERITY_LABELS[k]: int(v) for k, v in df.severity.value_counts().sort_index().items()})

    print("[3/4] Training RandomForest (split by scenario_id) and scoring baseline")
    clf, metrics = train_and_evaluate(df, args.seed)
    metrics["area"] = args.area
    metrics["seed"] = args.seed

    print("[4/4] Exporting artefacts")
    export_roads(Gr, link, data_dir / "roads.geojson", args.area)
    export_drains(Gd, data_dir / "drains.geojson", args.area)
    export_nodes_into_hospitals(Gr, cfg, data_dir / "hospitals.json")
    link.to_csv(data_dir / "link_table.csv", index=False)
    df.to_csv(data_dir / "simulated_samples.csv", index=False)
    # The bundle keeps feature order with the estimator so the API cannot mis-order columns.
    joblib.dump({"model": clf, "feature_names": FEATURES, "severity_labels": SEVERITY_LABELS, "area": args.area},
                model_dir / "severity_model.joblib")
    (model_dir / "metrics_comparison.json").write_text(json.dumps(metrics, indent=2), encoding="utf-8")

    rf, rb = metrics["random_forest"], metrics["rainfall_threshold_baseline"]
    print("\n=== Held-out scenario results ({} test scenarios) ===".format(N_TEST_SCENARIOS))
    print(f"RandomForest   macro-F1 {rf['macro_f1']:.3f} | acc {rf['accuracy']:.3f} | severe+ recall {rf['severe_or_critical_recall']:.3f}")
    print(f"Rain baseline  macro-F1 {rb['macro_f1']:.3f} | acc {rb['accuracy']:.3f} | severe+ recall {rb['severe_or_critical_recall']:.3f}")
    print(f"GroupKFold(5)  macro-F1 {metrics['group_kfold_macro_f1']['mean']:.3f} +/- {metrics['group_kfold_macro_f1']['std']:.3f}")
    print("NOTE: simulation benchmark only - not field-calibrated hydrology.")
    print(f"Files written under {args.out_dir}/data and {args.out_dir}/models")


if __name__ == "__main__":
    main()
