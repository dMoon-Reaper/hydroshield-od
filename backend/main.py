#!/usr/bin/env python3
"""
backend/main.py  -  HydroShield OD command-centre API
================================================================
FastAPI + NetworkX + SQLite3 + WebSockets.

Run (from the project root, after running simulate_and_train.py once):
    set NFC_HMAC_SECRET=pick-a-long-random-string        (Windows cmd)
    uvicorn backend.main:app --reload --port 8000
or:
    python backend/main.py

Endpoints
    GET  /api/state                        map layers, predictions, ranked work orders, benchmark
    POST /api/scenario                     storm / wetness / blockage / stale-sensor controls
    POST /api/nfc-scan                     HMAC-signed scan from nfc_bridge.py  -> WebSocket push
    POST /api/nfc-enroll                   HMAC-signed: bind a physical tag UID to a drain asset
    POST /api/nfc-simulate                 UI fallback "Simulate NFC Tap" (unsigned, flagged SIMULATED)
    POST /api/work-order/{id}/decision     Approve | Override | Defer | MarkCleared
    GET  /api/logs/export-csv              nfc_events | audit_log | work_orders  (CSV)
    GET  /api/synopsis/metadata            data for the Documentation card
    GET  /api/audit/verify                 re-checks the audit-log hash chain
    WS   /ws                               live events
"""
from __future__ import annotations

import asyncio
import csv
import hashlib
import hmac
import io
import json
import math
import os
import re
import sqlite3
import threading
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal, Optional

import joblib
import networkx as nx
import numpy as np
import pandas as pd
import uvicorn
from fastapi import FastAPI, Header, HTTPException, Query, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

# --------------------------------------------------------------------------- #
# Config
# --------------------------------------------------------------------------- #
BASE = Path(__file__).resolve().parent
DATA_DIR = Path(os.getenv("FLOOD_DATA_DIR", BASE / "data"))
MODEL_DIR = Path(os.getenv("FLOOD_MODEL_DIR", BASE / "models"))
DB_PATH = Path(os.getenv("FLOOD_DB_PATH", BASE / "flood_command.db"))

PROJECT_BRAND_NAME = os.getenv("PROJECT_BRAND_NAME", "HydroShield OD")
FORMERLY = "HydroShield OD"
_DEFAULT_SECRET = "dev-secret-change-me"
NFC_SECRET = os.getenv("NFC_HMAC_SECRET", _DEFAULT_SECRET).encode()
ALLOW_SIMULATED_SCANS = os.getenv("ALLOW_SIMULATED_SCANS", "1") == "1"
CORS_ORIGINS = os.getenv("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(",")

TS_TOLERANCE_S = 120          # reject signed requests older/newer than this (replay protection)
DEBOUNCE_S = 3.0              # same UID within this window is ignored
CLEAR_WINDOW_S = 24 * 3600    # a scan older than this no longer verifies "Mark Cleared"
CAP_MIN = 60.0                # ambulance time used when a hospital is unreachable
CLOSE_P, PENALISE_P, PENALISE_X = 0.60, 0.30, 3.0
WORK_ORDER_MIN_IMPACT = 0.03
SEVERITY_LABELS_DEFAULT = {0: "Normal", 1: "Watch", 2: "Severe", 3: "Critical"}
CRITICAL_NAME = re.compile(r"hospital|medical|scb|aiims|kims", re.I)

STORM_PRESETS = {
    "calm": {"rainfall_mm_hr": 10, "antecedent_wetness": 0.3},
    "moderate": {"rainfall_mm_hr": 50, "antecedent_wetness": 0.5},
    "cloudburst": {"rainfall_mm_hr": 110, "antecedent_wetness": 0.8},
}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def rnd(x, n=3):
    return None if x is None else round(float(x), n)


def meters(a, b) -> float:
    mlat = 110_574.0
    mlon = 111_320.0 * math.cos(math.radians((a[0] + b[0]) / 2))
    return math.hypot((a[0] - b[0]) * mlat, (a[1] - b[1]) * mlon)


# --------------------------------------------------------------------------- #
# SQLite store (assets, nfc_events, work_orders, audit_log)
# --------------------------------------------------------------------------- #
SCHEMA = """
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS assets(
    asset_id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL,
    lat REAL NOT NULL, lon REAL NOT NULL, critical INTEGER NOT NULL DEFAULT 0,
    nfc_uid TEXT UNIQUE, enrolled_ts TEXT
);
CREATE TABLE IF NOT EXISTS nfc_events(
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, uid TEXT, asset_id TEXT,
    source TEXT NOT NULL, reader_id TEXT, signature_valid INTEGER NOT NULL,
    accepted INTEGER NOT NULL, note TEXT
);
CREATE TABLE IF NOT EXISTS work_orders(
    id INTEGER PRIMARY KEY AUTOINCREMENT, drain_id TEXT NOT NULL, status TEXT NOT NULL,
    priority_score REAL NOT NULL, p_severe REAL NOT NULL, impact REAL NOT NULL,
    detour_delta_min REAL, recommended_action TEXT,
    created_ts TEXT NOT NULL, updated_ts TEXT NOT NULL,
    verification_source TEXT, verified_ts TEXT, last_decision TEXT, operator TEXT
);
CREATE TABLE IF NOT EXISTS audit_log(
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, actor TEXT NOT NULL,
    action TEXT NOT NULL, entity TEXT, entity_id TEXT, detail TEXT,
    prev_hash TEXT NOT NULL, hash TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS nfc_no_update BEFORE UPDATE ON nfc_events
BEGIN SELECT RAISE(ABORT, 'nfc_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS nfc_no_delete BEFORE DELETE ON nfc_events
BEGIN SELECT RAISE(ABORT, 'nfc_events is append-only'); END;
"""

OPEN_STATUSES = ("Pending", "Approved", "Overridden", "Deferred")


class Store:
    def __init__(self, path: Path):
        self.conn = sqlite3.connect(str(path), check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.lock = threading.RLock()
        with self.lock:
            self.conn.executescript(SCHEMA)
            self.conn.commit()

    # -- generic -----------------------------------------------------------
    def q(self, sql: str, args=()) -> list[dict]:
        with self.lock:
            return [dict(r) for r in self.conn.execute(sql, args).fetchall()]

    def x(self, sql: str, args=()) -> int:
        with self.lock:
            cur = self.conn.execute(sql, args)
            self.conn.commit()
            return cur.lastrowid

    # -- audit (hash-chained) ---------------------------------------------
    @staticmethod
    def _hash(prev, ts, actor, action, entity, entity_id, detail) -> str:
        blob = "|".join([prev, ts, actor, action, entity or "", entity_id or "", detail])
        return hashlib.sha256(blob.encode()).hexdigest()

    def audit(self, actor: str, action: str, entity: str | None = None, entity_id: str | None = None, detail: dict | None = None):
        with self.lock:
            row = self.conn.execute("SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1").fetchone()
            prev = row["hash"] if row else "GENESIS"
            ts, d = now_iso(), json.dumps(detail or {}, sort_keys=True, default=str)
            h = self._hash(prev, ts, actor, action, entity, entity_id, d)
            self.conn.execute(
                "INSERT INTO audit_log(ts,actor,action,entity,entity_id,detail,prev_hash,hash) VALUES(?,?,?,?,?,?,?,?)",
                (ts, actor, action, entity, entity_id, d, prev, h),
            )
            self.conn.commit()

    def verify_chain(self) -> dict:
        rows = self.q("SELECT * FROM audit_log ORDER BY id")
        prev = "GENESIS"
        for r in rows:
            exp = self._hash(prev, r["ts"], r["actor"], r["action"], r["entity"], r["entity_id"], r["detail"])
            if r["prev_hash"] != prev or r["hash"] != exp:
                return {"valid": False, "entries": len(rows), "first_bad_id": r["id"]}
            prev = r["hash"]
        return {"valid": True, "entries": len(rows), "head_hash": prev}

    # -- assets ------------------------------------------------------------
    def seed_assets(self, drains: dict, hospitals: list[dict]):
        if self.q("SELECT 1 FROM assets LIMIT 1"):
            return
        with self.lock:
            for did, d in drains.items():
                if d["nfc_tagged"]:
                    crit = 1 if CRITICAL_NAME.search(d["name"]) else 0
                    self.conn.execute("INSERT INTO assets(asset_id,name,kind,lat,lon,critical) VALUES(?,?,?,?,?,?)",
                                      (did, d["name"], "nfc_drain", d["lat"], d["lon"], crit))
            for i, h in enumerate(hospitals, 1):
                self.conn.execute("INSERT INTO assets(asset_id,name,kind,lat,lon,critical) VALUES(?,?,?,?,?,1)",
                                  (f"HOSP-{i}", h["name"], "hospital", h["lat"], h["lon"]))
            self.conn.commit()
        self.audit("system", "ASSETS_SEEDED", "assets", None, {"drains": sum(d["nfc_tagged"] for d in drains.values()), "hospitals": len(hospitals)})

    def critical_points(self) -> list[tuple[float, float]]:
        return [(r["lat"], r["lon"]) for r in self.q("SELECT lat,lon FROM assets WHERE critical=1")]

    # -- work orders -------------------------------------------------------
    def sync_work_orders(self, drains: dict):
        """Create / refresh / stand-down work orders from the latest consequence ranking."""
        with self.lock:
            for did, s in drains.items():
                cur = self.conn.execute(
                    "SELECT * FROM work_orders WHERE drain_id=? AND status!='Cleared' ORDER BY id DESC LIMIT 1", (did,)
                ).fetchone()
                latest_any = self.conn.execute(
                    "SELECT status FROM work_orders WHERE drain_id=? ORDER BY id DESC LIMIT 1", (did,)
                ).fetchone()
                ts = now_iso()
                if latest_any and latest_any["status"] == "Cleared" and s.get("blockage_fraction", 1.0) <= 0.02:
                    continue
                if s["impact"] >= WORK_ORDER_MIN_IMPACT:
                    if cur is None:
                        cur_id = self.conn.execute(
                            "INSERT INTO work_orders(drain_id,status,priority_score,p_severe,impact,detour_delta_min,recommended_action,created_ts,updated_ts)"
                            " VALUES(?,?,?,?,?,?,?,?,?)",
                            (did, "Pending", s["impact"], s["p_severe"], s["impact"], s["detour_delta_min"], s["recommended_action"], ts, ts),
                        ).lastrowid
                        self.conn.commit()
                        self.audit("system", "WORK_ORDER_CREATED", "work_order", str(cur_id), {"drain_id": did, "impact": s["impact"]})
                        continue
                    status = "Pending" if cur["status"] == "Stood Down" else cur["status"]
                    self.conn.execute(
                        "UPDATE work_orders SET status=?,priority_score=?,p_severe=?,impact=?,detour_delta_min=?,recommended_action=?,updated_ts=? WHERE id=?",
                        (status, s["impact"], s["p_severe"], s["impact"], s["detour_delta_min"], s["recommended_action"], ts, cur["id"]),
                    )
                elif cur is not None and cur["status"] == "Pending":
                    self.conn.execute("UPDATE work_orders SET status='Stood Down',impact=?,priority_score=?,p_severe=?,updated_ts=? WHERE id=?",
                                      (s["impact"], s["impact"], s["p_severe"], ts, cur["id"]))
            self.conn.commit()

    def ranked_work_orders(self) -> dict:
        names = {r["asset_id"]: r["name"] for r in self.q("SELECT asset_id,name FROM assets")}
        open_rows = self.q(f"SELECT * FROM work_orders WHERE status IN ({','.join('?' * len(OPEN_STATUSES))}) ORDER BY priority_score DESC", OPEN_STATUSES)
        closed = self.q("SELECT * FROM work_orders WHERE status IN ('Cleared','Stood Down') ORDER BY updated_ts DESC LIMIT 15")
        for i, r in enumerate(open_rows, 1):
            r["rank"] = i
        for r in open_rows + closed:
            r["asset_name"] = names.get(r["drain_id"])
        return {"open": open_rows, "recent_closed": closed}


# --------------------------------------------------------------------------- #
# Graph consequence engine
# --------------------------------------------------------------------------- #
class Engine:
    def __init__(self):
        need = [DATA_DIR / n for n in ("roads.geojson", "drains.geojson", "link_table.csv", "hospitals.json")] + [
            MODEL_DIR / "severity_model.joblib", MODEL_DIR / "metrics_comparison.json"]
        missing = [str(p) for p in need if not p.exists()]
        if missing:
            raise RuntimeError("Missing files - run `python backend/simulate_and_train.py` first:\n  " + "\n  ".join(missing))

        bundle = joblib.load(MODEL_DIR / "severity_model.joblib")
        self.model = bundle["model"]
        self.model.n_jobs = 1
        self.features: list[str] = bundle["feature_names"]
        self.labels = {int(k): v for k, v in bundle.get("severity_labels", SEVERITY_LABELS_DEFAULT).items()}
        self.area = bundle.get("area", "unknown")
        self.metrics = json.loads((MODEL_DIR / "metrics_comparison.json").read_text(encoding="utf-8"))

        roads = json.loads((DATA_DIR / "roads.geojson").read_text(encoding="utf-8"))
        hosp = json.loads((DATA_DIR / "hospitals.json").read_text(encoding="utf-8"))
        dr = json.loads((DATA_DIR / "drains.geojson").read_text(encoding="utf-8"))
        link = pd.read_csv(DATA_DIR / "link_table.csv").set_index("road_edge_id")

        # Road graph Gr
        self.node_xy = {n["id"]: (n["lat"], n["lon"]) for n in hosp["road_nodes"]}
        self.node_name = {n["id"]: n["name"] for n in hosp["road_nodes"]}
        self.hospitals = hosp["hospitals"]
        self.hospital_nodes = [h["road_node"] for h in self.hospitals]
        self.Gr = nx.DiGraph()
        self.road_feats: list[dict] = []
        rows = []
        for f in roads["features"]:
            p = f["properties"]
            self.Gr.add_edge(p["u"], p["v"], edge_id=p["edge_id"], travel_min=p["travel_min"])
            self.road_feats.append(f)
            a, b = self.node_xy[p["u"]], self.node_xy[p["v"]]
            rows.append({"edge_id": p["edge_id"], "u": p["u"], "v": p["v"], "travel_min": p["travel_min"],
                         "mid_lat": (a[0] + b[0]) / 2, "mid_lon": (a[1] + b[1]) / 2, "road_class": p["road_class"]})
        st = pd.DataFrame(rows).set_index("edge_id").join(link[[
            "drain_id", "relative_elevation_m", "slope", "upstream_contributing_nodes",
            "drain_capacity_proxy", "catchment_km2", "criticality"]])
        self.static = st
        self.rel_max = float(st["relative_elevation_m"].max() or 1.0)
        self.origins = [n for n in self.Gr.nodes if n not in set(self.hospital_nodes)]

        # Drainage graph Gd
        self.Gd = nx.DiGraph()
        self.drains: dict[str, dict] = {}
        for f in dr["features"]:
            p = f["properties"]
            if p["feature_type"] == "drain_node":
                lon, lat = f["geometry"]["coordinates"]
                self.drains[p["drain_id"]] = {**p, "lat": lat, "lon": lon}
                self.Gd.add_node(p["drain_id"])
            else:
                self.Gd.add_edge(p["from"], p["to"])
        self.drain_feats = [f for f in dr["features"] if f["properties"]["feature_type"] == "drain_node"]
        self.conduit_feats = [f for f in dr["features"] if f["properties"]["feature_type"] == "conduit"]

        # Scenario state
        rng = np.random.default_rng(7)
        self.base_block = {d: float(rng.uniform(0.04, 0.18)) for d in self.drains}
        self.lock = threading.RLock()
        self.reset_scenario()
        self.set_critical_points([])
        self.result: dict = {}

    # -- scenario ----------------------------------------------------------
    def reset_scenario(self):
        self.sc = {"preset": "calm", "rainfall_mm_hr": 20.0, "antecedent_wetness": 0.4, "global_blockage": 0.0,
                   "blockage": {}, "sensor_age_default": 45.0, "stale_drains": set(), "stale_age_sec": 1500.0}

    def set_critical_points(self, pts: list[tuple[float, float]]):
        S = self.static
        n_assets = []
        for _, r in S.iterrows():
            c = sum(1 for p in pts if meters((r.mid_lat, r.mid_lon), p) <= 600)
            hosp_end = int(r.u in self.hospital_nodes or r.v in self.hospital_nodes)
            n_assets.append(min(1.0, (c + 2 * hosp_end) / 2.0))
        S["critical_assets_affected"] = n_assets
        lowness = 1.0 - S["relative_elevation_m"] / self.rel_max
        up = S["upstream_contributing_nodes"] / max(S["upstream_contributing_nodes"].max(), 1)
        S["exposure_proxy"] = (0.6 * lowness + 0.4 * up).clip(0, 1)
        S["lowness"] = lowness

    def apply_update(self, upd: dict):
        with self.lock:
            if upd.get("reset"):
                self.reset_scenario()
            if upd.get("preset"):
                self.sc.update(STORM_PRESETS[upd["preset"]])
                self.sc["preset"] = upd["preset"]
            for k in ("rainfall_mm_hr", "antecedent_wetness", "global_blockage"):
                if upd.get(k) is not None:
                    self.sc[k] = float(upd[k])
                    self.sc["preset"] = "custom"
            for d, v in (upd.get("blockage") or {}).items():
                if d not in self.drains:
                    raise KeyError(d)
                self.sc["blockage"][d] = float(v)
            if upd.get("stale_sensors") is not None:
                if upd["stale_sensors"]:
                    targets = upd.get("stale_drains") or list(self.drains)
                    bad = [d for d in targets if d not in self.drains]
                    if bad:
                        raise KeyError(bad[0])
                    self.sc["stale_drains"] = set(targets)
                    if upd.get("sensor_age_sec") is not None:
                        self.sc["stale_age_sec"] = float(upd["sensor_age_sec"])
                else:
                    self.sc["stale_drains"] = set()
            elif upd.get("sensor_age_sec") is not None:
                self.sc["stale_age_sec"] = float(upd["sensor_age_sec"])

    def scenario_view(self) -> dict:
        s = self.sc
        return {"preset": s["preset"], "rainfall_mm_hr": s["rainfall_mm_hr"], "antecedent_wetness": s["antecedent_wetness"],
                "global_blockage": s["global_blockage"], "blockage_overrides": dict(s["blockage"]),
                "stale_drains": sorted(s["stale_drains"]), "stale_age_sec": s["stale_age_sec"]}

    # -- helpers for ambulance routing ------------------------------------
    def _graph(self, weights: list[Optional[float]], reverse: bool) -> nx.DiGraph:
        G = nx.DiGraph()
        G.add_nodes_from(self.Gr.nodes)
        for (u, v), w in zip(self._edge_uv, weights):
            if w is not None:
                G.add_edge(v, u, w=w) if reverse else G.add_edge(u, v, w=w)
        return G

    def _mean_time(self, weights) -> tuple[float, int]:
        H = self._graph(weights, reverse=True)
        d = nx.multi_source_dijkstra_path_length(H, self.hospital_nodes, weight="w")
        vals = [min(d.get(n, CAP_MIN), CAP_MIN) for n in self.origins]
        return float(np.mean(vals)), sum(1 for n in self.origins if n not in d)

    def _amb(self, G: nx.DiGraph, origin: str) -> tuple[float, Optional[str]]:
        best, who = CAP_MIN, None
        for h in self.hospital_nodes:
            try:
                L = nx.shortest_path_length(G, origin, h, weight="w")
            except (nx.NetworkXNoPath, nx.NodeNotFound):
                continue
            if L < best:
                best, who = L, h
        return float(best), who

    # -- the main computation ---------------------------------------------
    def compute(self) -> dict:
        with self.lock:
            S = self.static
            sc = self.sc
            self._edge_uv = list(zip(S["u"], S["v"]))
            rain, wet = sc["rainfall_mm_hr"], sc["antecedent_wetness"]

            blk_d, age_d = {}, {}
            for d in self.drains:
                blk_d[d] = sc["blockage"].get(d, min(0.95, self.base_block[d] + sc["global_blockage"]))
                age_d[d] = sc["stale_age_sec"] if d in sc["stale_drains"] else sc["sensor_age_default"]
            block = S["drain_id"].map(blk_d).astype(float).clip(0, 0.95)
            age = S["drain_id"].map(age_d).astype(float)

            # simulated telemetry (same hydraulic rule as the training simulator, without noise)
            runoff_c = 0.5 + 0.4 * wet
            q_in = runoff_c * rain * S["catchment_km2"] / 3.6
            ratio = q_in / (S["drain_capacity_proxy"] * (1 - block) + 1e-6)
            ponding = (ratio - 0.7).clip(lower=0) * 0.6 * (0.4 + 1.2 * S["lowness"]) * (1.0 - (S["slope"] * 20).clip(upper=0.5))
            sheet = 0.004 * max(0.0, rain - 40) * S["lowness"]
            depth_true = (ponding + sheet).clip(0, 2.5)
            observed = depth_true * np.exp(-age / 1800.0)

            X = pd.DataFrame({
                "rainfall_mm_hr": rain, "antecedent_wetness": wet, "relative_elevation_m": S["relative_elevation_m"],
                "slope": S["slope"], "upstream_contributing_nodes": S["upstream_contributing_nodes"],
                "drain_capacity_proxy": S["drain_capacity_proxy"], "blockage_fraction": block,
                "flow_to_capacity_ratio": ratio, "water_level_m": observed, "sensor_age_sec": age,
            })[self.features]
            proba = self.model.predict_proba(X)
            classes = np.asarray(self.model.classes_)
            p_sev = proba[:, classes >= 2].sum(axis=1)
            pred = classes[proba.argmax(axis=1)]
            quality = np.where(age <= 120, 1.0, np.exp(-(age - 120) / 900.0)).clip(0.1, 1.0)
            conf = proba.max(axis=1) * quality

            # ambulance network: closed / penalised segments
            tm = S["travel_min"].to_numpy(dtype=float)
            w_cur: list[Optional[float]] = []
            for i in range(len(S)):
                if p_sev[i] >= CLOSE_P:
                    w_cur.append(None)
                elif p_sev[i] >= PENALISE_P:
                    w_cur.append(float(tm[i] * PENALISE_X))
                else:
                    w_cur.append(float(tm[i]))
            t_free, _ = self._mean_time([float(x) for x in tm])
            t_cur, unreachable = self._mean_time(w_cur)

            mean_delta = np.zeros(len(S))
            for i in range(len(S)):
                if p_sev[i] < 0.02:
                    continue                       # negligible probability -> consequence ~0, skip the sweep
                w_open, w_closed = list(w_cur), list(w_cur)
                w_open[i], w_closed[i] = float(tm[i]), None
                mean_delta[i] = max(0.0, self._mean_time(w_closed)[0] - self._mean_time(w_open)[0])
            detour_pen = mean_delta / max(mean_delta.max(), 1.0)

            impact = p_sev * (0.30 * S["criticality"].to_numpy() + 0.30 * detour_pen
                              + 0.25 * S["critical_assets_affected"].to_numpy() + 0.15 * S["exposure_proxy"].to_numpy())

            E = pd.DataFrame({
                "p_severe": p_sev, "severity": pred, "confidence": conf, "impact": impact,
                "detour_penalty": detour_pen, "mean_detour_delta_min": mean_delta,
                "depth_est_m": depth_true.to_numpy(), "depth_observed_m": observed.to_numpy(),
                "ratio": ratio.to_numpy(), "blockage": block.to_numpy(), "age": age.to_numpy(),
                "closed": [w is None for w in w_cur], "penalised": [(w is not None and w > tm[i] + 1e-9) for i, w in enumerate(w_cur)],
            }, index=S.index)
            E = E.join(S[["drain_id", "criticality", "critical_assets_affected", "exposure_proxy", "u", "v"]])

            # per-drain summary + exact ambulance times for the worst linked segment
            F_free = self._graph([float(x) for x in tm], reverse=False)
            drains: dict[str, dict] = {}
            for d, grp in E.groupby("drain_id"):
                top = grp["impact"].idxmax()
                t = grp.loc[top]
                info = {
                    "drain_id": d, "name": self.drains[d]["name"], "lat": self.drains[d]["lat"], "lon": self.drains[d]["lon"],
                    "nfc_tagged": bool(self.drains[d]["nfc_tagged"]),
                    "impact": rnd(t.impact, 4), "p_severe": rnd(grp.p_severe.max(), 4),
                    "severity": int(grp.severity.max()), "severity_label": self.labels.get(int(grp.severity.max())),
                    "top_edge_id": top, "water_depth_m": rnd(grp.depth_est_m.max()), "blockage_fraction": rnd(grp.blockage.max()),
                    "flow_to_capacity": rnd(grp.ratio.max()), "sensor_age_sec": rnd(grp.age.max(), 0),
                    "confidence": rnd(grp.confidence.min(), 3), "linked_edges": int(len(grp)),
                    "detour_delta_min": None, "ambulance": None,
                }
                info["recommended_action"] = (
                    "Dispatch JCB desilting crew - clear blockage" if info["blockage_fraction"] >= 0.5
                    else "Dispatch mobile dewatering pump" if info["flow_to_capacity"] >= 1.0
                    else "Field inspection - verify by NFC tap")
                if info["impact"] >= WORK_ORDER_MIN_IMPACT:
                    i = S.index.get_loc(top)
                    w_open, w_closed = list(w_cur), list(w_cur)
                    w_open[i], w_closed[i] = float(tm[i]), None
                    G_open, G_closed = self._graph(w_open, reverse=False), self._graph(w_closed, reverse=False)
                    origin = int(t.u)
                    t_free_o, _ = self._amb(F_free, origin)
                    t_open, h_open = self._amb(G_open, origin)
                    t_closed, h_closed = self._amb(G_closed, origin)
                    info["detour_delta_min"] = rnd(max(0.0, t_closed - t_open), 2)
                    info["ambulance"] = {
                        "origin_node": origin, "origin_name": self.node_name.get(origin) or origin,
                        "free_flow_min": rnd(t_free_o, 2), "current_min": rnd(t_open, 2),
                        "if_segment_closed_min": rnd(t_closed, 2), "detour_delta_min": info["detour_delta_min"],
                        "nearest_hospital": self.node_name.get(h_closed or h_open),
                        "unreachable": bool(t_closed >= CAP_MIN),
                    }
                drains[d] = info

            counts = {self.labels.get(int(k), str(k)): int(v) for k, v in pd.Series(pred).value_counts().items()}
            self.result = {
                "edges": E, "drains": drains,
                "ambulance_summary": {
                    "mean_time_free_flow_min": rnd(t_free, 2), "mean_time_current_min": rnd(t_cur, 2),
                    "mean_delay_min": rnd(t_cur - t_free, 2), "unreachable_origins": int(unreachable),
                    "closed_segments": int(sum(E.closed)), "penalised_segments": int(sum(E.penalised)),
                    "rule": f"closed if P(severe+)>={CLOSE_P}; x{PENALISE_X:g} travel time if >={PENALISE_P}",
                },
                "severity_counts": counts,
            }
            return self.result

    # -- API views ---------------------------------------------------------
    def map_layers(self) -> dict:
        E = self.result["edges"]
        roads = []
        for f in self.road_feats:
            eid = f["properties"]["edge_id"]
            r = E.loc[eid]
            roads.append({"type": "Feature", "geometry": f["geometry"], "properties": {
                **f["properties"], "p_severe": rnd(r.p_severe, 4), "severity": int(r.severity),
                "severity_label": self.labels.get(int(r.severity)), "impact": rnd(r.impact, 4),
                "closed": bool(r.closed), "penalised": bool(r.penalised), "confidence": rnd(r.confidence),
                "water_depth_m": rnd(r.depth_est_m)}})
        dfeat = []
        for f in self.drain_feats:
            s = self.result["drains"][f["properties"]["drain_id"]]
            dfeat.append({"type": "Feature", "geometry": f["geometry"], "properties": {
                **f["properties"], **{k: s[k] for k in ("impact", "p_severe", "severity", "severity_label", "water_depth_m",
                                                          "blockage_fraction", "flow_to_capacity", "sensor_age_sec", "confidence")}}})
        return {"roads": {"type": "FeatureCollection", "features": roads},
                "drains": {"type": "FeatureCollection", "features": dfeat},
                "conduits": {"type": "FeatureCollection", "features": self.conduit_feats}}

    def data_quality(self) -> dict:
        per = []
        for d, s in self.result["drains"].items():
            age = s["sensor_age_sec"]
            flags = []
            if age > 600:
                flags.append("STALE")
            if s["flow_to_capacity"] > 25 or s["water_depth_m"] >= 2.5 or self.sc["rainfall_mm_hr"] > 250:
                flags.append("OUT_OF_RANGE")
            per.append({"drain_id": d, "sensor_age_sec": age, "confidence": s["confidence"], "flags": flags})
        return {"stale_sensors": sum("STALE" in p["flags"] for p in per),
                "out_of_range": sum("OUT_OF_RANGE" in p["flags"] for p in per),
                "rule": "STALE if age>600 s; confidence = top-class probability x freshness factor", "per_drain": per}


# --------------------------------------------------------------------------- #
# WebSocket manager
# --------------------------------------------------------------------------- #
class WSManager:
    def __init__(self):
        self.clients: set[WebSocket] = set()

    async def connect(self, ws: WebSocket):
        await ws.accept()
        self.clients.add(ws)

    def drop(self, ws: WebSocket):
        self.clients.discard(ws)

    async def broadcast(self, msg: dict):
        dead = []
        for ws in list(self.clients):
            try:
                await ws.send_json(msg)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.drop(ws)


# --------------------------------------------------------------------------- #
# App wiring
# --------------------------------------------------------------------------- #
ENGINE: Engine
STORE: Store
WS = WSManager()
_recent_uid: dict[str, float] = {}
_seen_nonces: dict[str, float] = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    global ENGINE, STORE
    if NFC_SECRET == _DEFAULT_SECRET.encode():
        print("WARNING: NFC_HMAC_SECRET not set - using the insecure development secret.")
    STORE = Store(DB_PATH)
    ENGINE = Engine()
    STORE.seed_assets(ENGINE.drains, ENGINE.hospitals)
    ENGINE.set_critical_points(STORE.critical_points())
    ENGINE.compute()
    STORE.sync_work_orders(ENGINE.result["drains"])
    STORE.audit("system", "SERVER_STARTED", "system", None, {"area": ENGINE.area, "brand": PROJECT_BRAND_NAME})
    yield


app = FastAPI(title=f"{PROJECT_BRAND_NAME} Command API", version="1.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=CORS_ORIGINS, allow_methods=["*"], allow_headers=["*"])


def recompute() -> None:
    ENGINE.compute()
    STORE.sync_work_orders(ENGINE.result["drains"])


def build_state() -> dict:
    E = ENGINE.result["edges"]
    top = E.sort_values("impact", ascending=False).head(10)
    nfc = STORE.q("SELECT id,ts,uid,asset_id,source,signature_valid,accepted,note FROM nfc_events ORDER BY id DESC LIMIT 15")
    return {
        "brand": {"name": PROJECT_BRAND_NAME, "formerly": FORMERLY},
        "area": ENGINE.area,
        "generated_at": now_iso(),
        "hospitals": [{"name": h["name"], "lat": h["lat"], "lon": h["lon"], "verified_coordinates": h.get("verified_coordinates", False)} for h in ENGINE.hospitals],
        "provenance": {"geometry": "SYNTHETIC grid anchored to real landmark coordinates", "telemetry": "SIMULATED",
                       "nfc": "LIVE USB hardware via nfc_bridge.py (events flagged SIMULATED_UI when the UI fallback is used)"},
        "scenario": ENGINE.scenario_view(),
        "map_layers": ENGINE.map_layers(),
        "predictions": {
            "severity_counts": ENGINE.result["severity_counts"],
            "top_segments": [{"edge_id": i, "drain_id": r.drain_id, "p_severe": rnd(r.p_severe, 4), "severity": ENGINE.labels.get(int(r.severity)),
                              "impact": rnd(r.impact, 4)} for i, r in top.iterrows()],
            "drains": ENGINE.result["drains"],
            "impact_formula": "Impact(e)=P(severe_or_critical)*(0.30*criticality+0.30*detour_penalty+0.25*critical_assets_affected+0.15*exposure_proxy)",
        },
        "ambulance": ENGINE.result["ambulance_summary"],
        "work_orders": STORE.ranked_work_orders(),
        "benchmark": ENGINE.metrics,
        "data_quality": ENGINE.data_quality(),
        "nfc_recent": nfc,
    }


@app.get("/api/health")
def health():
    return {"ok": True, "brand": PROJECT_BRAND_NAME, "area": ENGINE.area, "time": now_iso()}


@app.get("/api/state")
def get_state():
    with ENGINE.lock:
        return build_state()


# ---- scenario ------------------------------------------------------------ #
class ScenarioUpdate(BaseModel):
    preset: Optional[Literal["calm", "moderate", "cloudburst"]] = None
    rainfall_mm_hr: Optional[float] = Field(None, ge=0, le=250)
    antecedent_wetness: Optional[float] = Field(None, ge=0, le=1)
    global_blockage: Optional[float] = Field(None, ge=0, le=0.95)
    blockage: Optional[dict[str, float]] = Field(None, description="drain_id -> blockage fraction 0..0.95")
    stale_sensors: Optional[bool] = None
    stale_drains: Optional[list[str]] = None
    sensor_age_sec: Optional[float] = Field(None, ge=0, le=86_400)
    reset: bool = False
    operator: str = "operator"


@app.post("/api/scenario")
async def post_scenario(body: ScenarioUpdate):
    upd = body.model_dump(exclude_none=True)
    if any(not (0 <= v <= 0.95) for v in (upd.get("blockage") or {}).values()):
        raise HTTPException(422, "blockage values must be within 0..0.95")

    def work():
        ENGINE.apply_update(upd)
        recompute()
        STORE.audit(body.operator, "SCENARIO_UPDATED", "scenario", None, {k: v for k, v in upd.items() if k != "operator"})

    try:
        await asyncio.to_thread(work)
    except KeyError as e:
        raise HTTPException(404, f"unknown drain_id {e}")
    state = await asyncio.to_thread(get_state)
    await WS.broadcast({"type": "state_update", "reason": "scenario", "state": state})
    return state


# ---- NFC ------------------------------------------------------------------ #
class NfcScan(BaseModel):
    uid: str = Field(min_length=4, max_length=32)
    ts: float
    nonce: str = Field(min_length=8, max_length=64)
    reader_id: Optional[str] = None


class NfcEnroll(NfcScan):
    drain_id: str


class NfcSimulate(BaseModel):
    drain_id: str
    operator: str = "operator"


def _sig_ok(raw: bytes, header: Optional[str]) -> bool:
    if not header:
        return False
    given = header.strip().lower().removeprefix("sha256=")
    return hmac.compare_digest(hmac.new(NFC_SECRET, raw, hashlib.sha256).hexdigest(), given)


def _log_nfc(uid, asset_id, source, reader, sig_ok, accepted, note):
    STORE.x("INSERT INTO nfc_events(ts,uid,asset_id,source,reader_id,signature_valid,accepted,note) VALUES(?,?,?,?,?,?,?,?)",
            (now_iso(), uid, asset_id, source, reader, int(sig_ok), int(accepted), note))


def _scan_payload(drain_id: str, source: str, uid: Optional[str]) -> dict:
    with ENGINE.lock:
        s = ENGINE.result["drains"][drain_id]
    wo = next((w for w in STORE.ranked_work_orders()["open"] if w["drain_id"] == drain_id), None)
    return {"type": "nfc_scan", "source": source, "uid": uid, "ts": now_iso(), "drain": s, "work_order": wo,
            "ambulance": s["ambulance"],
            "fly_to": {"latitude": s["lat"], "longitude": s["lon"], "zoom": 16.5, "pitch": 55, "bearing": 20, "duration_ms": 2200},
            "radar_pulse": True}


async def _finish_scan(drain_id: str, source: str, uid: Optional[str]):
    payload = await asyncio.to_thread(_scan_payload, drain_id, source, uid)
    await WS.broadcast(payload)
    return payload


def _check_fresh(p: NfcScan):
    now = time.time()
    for k in [k for k, t in _seen_nonces.items() if now - t > TS_TOLERANCE_S * 2]:
        _seen_nonces.pop(k, None)
    if abs(now - p.ts) > TS_TOLERANCE_S:
        return "stale_timestamp"
    if p.nonce in _seen_nonces:
        return "replayed_nonce"
    _seen_nonces[p.nonce] = now
    return None


@app.post("/api/nfc-scan")
async def nfc_scan(request: Request, x_signature: Optional[str] = Header(None)):
    raw = await request.body()
    if not _sig_ok(raw, x_signature):
        await asyncio.to_thread(_log_nfc, None, None, "HARDWARE", None, False, False, "bad_signature")
        await asyncio.to_thread(STORE.audit, "nfc_reader", "NFC_REJECTED", "nfc_events", None, {"reason": "bad_signature", "bytes": len(raw)})
        raise HTTPException(401, "invalid X-Signature")
    try:
        p = NfcScan.model_validate_json(raw)
    except Exception:
        raise HTTPException(422, "malformed payload")
    uid = p.uid.upper()
    problem = _check_fresh(p)
    if problem:
        await asyncio.to_thread(_log_nfc, uid, None, "HARDWARE", p.reader_id, True, False, problem)
        raise HTTPException(409, problem)
    if time.time() - _recent_uid.get(uid, 0) < DEBOUNCE_S:
        return {"status": "debounced"}

    rows = await asyncio.to_thread(STORE.q, "SELECT asset_id FROM assets WHERE nfc_uid=?", (uid,))
    if not rows:
        await asyncio.to_thread(_log_nfc, uid, None, "HARDWARE", p.reader_id, True, False, "unknown_uid")
        await asyncio.to_thread(STORE.audit, "nfc_reader", "NFC_UNKNOWN_UID", "nfc_events", None, {"uid": uid})
        await WS.broadcast({"type": "nfc_unknown", "uid": uid, "ts": now_iso(),
                            "hint": "Enroll with: python backend/nfc_bridge.py --enroll DR-01"})
        raise HTTPException(404, "unknown tag UID - enroll it first")
    _recent_uid[uid] = time.time()          # debounce only known tags
    drain_id = rows[0]["asset_id"]
    await asyncio.to_thread(_log_nfc, uid, drain_id, "HARDWARE", p.reader_id, True, True, "ok")
    await asyncio.to_thread(STORE.audit, p.reader_id or "nfc_reader", "NFC_SCAN", "asset", drain_id, {"uid": uid, "source": "HARDWARE"})
    return {"status": "ok", "event": await _finish_scan(drain_id, "HARDWARE", uid)}


@app.post("/api/nfc-enroll")
async def nfc_enroll(request: Request, x_signature: Optional[str] = Header(None)):
    raw = await request.body()
    if not _sig_ok(raw, x_signature):
        await asyncio.to_thread(STORE.audit, "nfc_reader", "NFC_ENROLL_REJECTED", "assets", None, {"reason": "bad_signature"})
        raise HTTPException(401, "invalid X-Signature")
    try:
        p = NfcEnroll.model_validate_json(raw)
    except Exception:
        raise HTTPException(422, "malformed payload")
    problem = _check_fresh(p)
    if problem:
        raise HTTPException(409, problem)
    uid = p.uid.upper()

    def work():
        if not STORE.q("SELECT 1 FROM assets WHERE asset_id=? AND kind='nfc_drain'", (p.drain_id,)):
            return "no_asset"
        STORE.x("UPDATE assets SET nfc_uid=NULL,enrolled_ts=NULL WHERE nfc_uid=?", (uid,))
        STORE.x("UPDATE assets SET nfc_uid=?,enrolled_ts=? WHERE asset_id=?", (uid, now_iso(), p.drain_id))
        STORE.audit(p.reader_id or "nfc_reader", "NFC_ENROLLED", "asset", p.drain_id, {"uid": uid})
        return "ok"

    if await asyncio.to_thread(work) == "no_asset":
        raise HTTPException(404, f"{p.drain_id} is not an NFC-tagged asset")
    return {"status": "enrolled", "drain_id": p.drain_id, "uid": uid}


@app.post("/api/nfc-simulate")
async def nfc_simulate(body: NfcSimulate):
    if not ALLOW_SIMULATED_SCANS:
        raise HTTPException(403, "simulated scans disabled")
    if not await asyncio.to_thread(STORE.q, "SELECT 1 FROM assets WHERE asset_id=? AND kind='nfc_drain'", (body.drain_id,)):
        raise HTTPException(404, f"{body.drain_id} is not an NFC-tagged asset")
    await asyncio.to_thread(_log_nfc, None, body.drain_id, "SIMULATED_UI", "ui", False, True, "simulated_tap")
    await asyncio.to_thread(STORE.audit, body.operator, "NFC_SIMULATED", "asset", body.drain_id, {"source": "SIMULATED_UI"})
    return {"status": "ok", "event": await _finish_scan(body.drain_id, "SIMULATED_UI", None)}


# ---- work-order decisions ------------------------------------------------- #
class Decision(BaseModel):
    action: Literal["Approve", "Override", "Defer", "MarkCleared"]
    operator: str = Field(min_length=2, max_length=64)
    reason: Optional[str] = Field(None, max_length=500)
    defer_minutes: Optional[int] = Field(None, ge=1, le=1440)


STATUS_FOR = {"Approve": "Approved", "Override": "Overridden", "Defer": "Deferred", "MarkCleared": "Cleared"}


@app.post("/api/work-order/{wo_id}/decision")
async def decide(wo_id: int, body: Decision):
    def work():
        rows = STORE.q("SELECT * FROM work_orders WHERE id=?", (wo_id,))
        if not rows:
            return 404, "work order not found"
        wo = rows[0]
        if wo["status"] in ("Cleared", "Stood Down"):
            return 409, f"work order is {wo['status']}; no further decisions"
        if body.action == "Override" and not (body.reason and len(body.reason.strip()) >= 3):
            return 422, "Override requires a reason"
        detail = {"action": body.action, "reason": body.reason, "defer_minutes": body.defer_minutes,
                  "from_status": wo["status"], "ai_recommendation": wo["recommended_action"], "impact": wo["impact"]}
        verification = None
        if body.action == "MarkCleared":
            scan = STORE.q("SELECT ts,source FROM nfc_events WHERE asset_id=? AND accepted=1 ORDER BY id DESC LIMIT 1", (wo["drain_id"],))
            fresh = scan and (datetime.now(timezone.utc) - datetime.fromisoformat(scan[0]["ts"])).total_seconds() <= CLEAR_WINDOW_S
            if not fresh and not (body.reason and len(body.reason.strip()) >= 3):
                return 409, "NFC verification required: tap this asset's tag first (or give a reason to clear without a scan)"
            verification = scan[0]["source"] if fresh else "MANUAL_OVERRIDE"
            detail.update(verification_source=verification, scan_ts=scan[0]["ts"] if fresh else None)
            with ENGINE.lock:
                ENGINE.sc["blockage"][wo["drain_id"]] = 0.02      # field-verified clear
        STORE.x("UPDATE work_orders SET status=?,last_decision=?,operator=?,updated_ts=?,verification_source=COALESCE(?,verification_source),"
                "verified_ts=CASE WHEN ? IS NULL THEN verified_ts ELSE ? END WHERE id=?",
                (STATUS_FOR[body.action], body.action, body.operator, now_iso(), verification, verification, now_iso(), wo_id))
        STORE.audit(body.operator, f"DECISION_{body.action.upper()}", "work_order", str(wo_id), {**detail, "drain_id": wo["drain_id"]})
        recompute()
        return 200, None

    code, err = await asyncio.to_thread(work)
    if code != 200:
        raise HTTPException(code, err)
    state = await asyncio.to_thread(get_state)
    await WS.broadcast({"type": "decision", "work_order_id": wo_id, "action": body.action, "state": state})
    return state


# ---- logs / synopsis ------------------------------------------------------ #
_CSV_TABLES = {"nfc_events", "audit_log", "work_orders"}


def _safe(v):
    s = "" if v is None else str(v)
    return "'" + s if s[:1] in ("=", "+", "-", "@") else s       # CSV-injection guard


@app.get("/api/logs/export-csv")
def export_csv(table: str = Query("audit_log")):
    if table not in _CSV_TABLES:
        raise HTTPException(400, f"table must be one of {sorted(_CSV_TABLES)}")
    rows = STORE.q(f"SELECT * FROM {table} ORDER BY id")
    buf = io.StringIO()
    cols = list(rows[0].keys()) if rows else [r["name"] for r in STORE.q(f"PRAGMA table_info({table})")]
    w = csv.writer(buf)
    w.writerow(cols)
    for r in rows:
        w.writerow([_safe(r[c]) for c in cols])
    safe_brand = re.sub(r"\s+", "_", PROJECT_BRAND_NAME.lower())
    fname = f"{safe_brand}_{table}_{datetime.now(timezone.utc):%Y%m%d_%H%M%S}.csv"
    return Response(buf.getvalue(), media_type="text/csv", headers={"Content-Disposition": f'attachment; filename="{fname}"'})


@app.get("/api/audit/verify")
def audit_verify():
    return STORE.verify_chain()


@app.get("/api/synopsis/metadata")
def synopsis():
    m = ENGINE.metrics
    return {
        "brand": PROJECT_BRAND_NAME, "formerly": FORMERLY, "generated_at": now_iso(), "area": ENGINE.area,
        "graphs": {"road_nodes": ENGINE.Gr.number_of_nodes(), "road_edges": ENGINE.Gr.number_of_edges(),
                   "drain_nodes": ENGINE.Gd.number_of_nodes(), "conduits": ENGINE.Gd.number_of_edges()},
        "model": {"type": type(ENGINE.model).__name__, "features": ENGINE.features, "classes": ENGINE.labels,
                  "macro_f1": m["random_forest"]["macro_f1"], "baseline_macro_f1": m["rainfall_threshold_baseline"]["macro_f1"],
                  "group_kfold_macro_f1_mean": m["group_kfold_macro_f1"]["mean"], "split": m["dataset"]["split"],
                  "test_scenarios": m["dataset"]["test_scenarios"], "caveat": m["provenance"]["warning"]},
        "log_counts": {t: STORE.q(f"SELECT COUNT(*) c FROM {t}")[0]["c"] for t in ("assets", "nfc_events", "work_orders", "audit_log")},
        "audit_chain": STORE.verify_chain(),
        "nfc_tags_enrolled": STORE.q("SELECT COUNT(*) c FROM assets WHERE nfc_uid IS NOT NULL")[0]["c"],
        "downloads": {"audit_log_csv": "/api/logs/export-csv?table=audit_log", "nfc_events_csv": "/api/logs/export-csv?table=nfc_events",
                      "work_orders_csv": "/api/logs/export-csv?table=work_orders", "model_card_json": "/api/state (benchmark)"},
        "provenance": {"geometry": "synthetic grid anchored to real landmarks", "telemetry": "simulated"},
    }


# ---- websocket ------------------------------------------------------------ #
@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await WS.connect(ws)
    try:
        await ws.send_json({"type": "snapshot", "state": await asyncio.to_thread(get_state)})
        while True:
            msg = await ws.receive_text()
            if msg == "ping":
                await ws.send_json({"type": "pong", "ts": now_iso()})
    except WebSocketDisconnect:
        pass
    finally:
        WS.drop(ws)


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=int(os.getenv("PORT", "8000")))
