/**
 * src/pages/GovernmentCommandDashboard.tsx  -  Tier-2 command centre (/command-center)
 * ------------------------------------------------------------------------------------
 * Needs the FastAPI backend from backend/main.py (REST + WebSocket).
 * Deps: react, framer-motion, three, @react-three/fiber, @react-three/drei, lucide-react,
 *       maplibre-gl, @deck.gl/core, @deck.gl/layers, @deck.gl/geo-layers, @deck.gl/mapbox
 * Env:  VITE_API_BASE=http://127.0.0.1:8000
 *
 * Modules: 1 Basin overview + storm controls | 2 3D GIS map + asset inspector |
 *          3 Road-graph consequence + 108 hospital detour | 4 Work-order queue (human in the loop) |
 *          5 Live NFC feed | 6 AI vs baseline benchmark + data quality
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Canvas, useFrame } from "@react-three/fiber";
import { Edges, OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { ColumnLayer, PathLayer, ScatterplotLayer, TextLayer } from "@deck.gl/layers";
import { TripsLayer } from "@deck.gl/geo-layers";
import type { Layer, PickingInfo } from "@deck.gl/core";
import {
  Activity, ArrowLeft, Ambulance as AmbulanceIcon, Check, Clock as ClockIcon, Cpu, Gauge, Landmark, Layers, MapPin, Moon,
  Radio, ShieldCheck, Sun, X, Zap,
} from "lucide-react";

/* ------------------------------------------------------------------ */
/* Config + types                                                     */
/* ------------------------------------------------------------------ */
const API: string = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_API_BASE ?? "http://127.0.0.1:8000";
const WS_URL = API.replace(/^http/, "ws") + "/ws";
const BRAND = "HydroShield OD";
const SEV_LABELS = ["Normal", "Watch", "Severe", "Critical"] as const;
const SEV_HEX = ["#16A34A", "#CA8A04", "#EA580C", "#DC2626"];
const SEV_RGB: [number, number, number][] = [[22, 163, 74], [234, 179, 8], [234, 88, 12], [220, 38, 38]];
const AREAS = { bhubaneswar: "Bhubaneswar: Nayapalli NH-16", cuttack: "Cuttack: Badambadi MSWC-1" } as const;
type AreaKey = keyof typeof AREAS;
type Theme = "dark" | "light";

interface Ambulance { origin_node: number; origin_name: string; free_flow_min: number; current_min: number; if_segment_closed_min: number; detour_delta_min: number; nearest_hospital: string | null; unreachable: boolean }
interface DrainPred {
  drain_id: string; name: string; lat: number; lon: number; nfc_tagged: boolean; impact: number; p_severe: number; severity: number; severity_label: string;
  top_edge_id: string; water_depth_m: number; blockage_fraction: number; flow_to_capacity: number; sensor_age_sec: number; confidence: number;
  linked_edges: number; detour_delta_min: number | null; ambulance: Ambulance | null; recommended_action: string;
}
interface WorkOrder { id: number; drain_id: string; status: string; priority_score: number; p_severe: number; impact: number; detour_delta_min: number | null; recommended_action: string; updated_ts: string; verification_source: string | null; last_decision: string | null; operator: string | null; rank?: number; asset_name?: string }
interface NfcEvent { id: number; ts: string; uid: string | null; asset_id: string | null; source: string; signature_valid: number; accepted: number; note: string | null }
interface Feature<P> { type: "Feature"; geometry: { type: string; coordinates: number[] | number[][] }; properties: P }
interface FC<P> { type: "FeatureCollection"; features: Feature<P>[] }
interface RoadProps { edge_id: string; road_class: string; closed: boolean; penalised: boolean; p_severe: number; severity: number; severity_label: string; impact: number; linked_drain: string; water_depth_m: number }
interface DrainProps { drain_id: string; name: string; nfc_tagged: boolean; severity: number; water_depth_m: number; p_severe: number }
interface Hospital { name: string; lat: number; lon: number; verified_coordinates: boolean }
interface ClassStats { macro_f1: number; accuracy: number; per_class_f1: Record<string, number>; severe_or_critical_recall: number }
interface CommandState {
  brand: { name: string; formerly: string }; area: string; generated_at: string; hospitals: Hospital[];
  scenario: { preset: string; rainfall_mm_hr: number; antecedent_wetness: number; global_blockage: number; blockage_overrides: Record<string, number>; stale_drains: string[]; stale_age_sec: number };
  map_layers: { roads: FC<RoadProps>; drains: FC<DrainProps>; conduits: FC<Record<string, unknown>> };
  predictions: { severity_counts: Record<string, number>; top_segments: { edge_id: string; drain_id: string; p_severe: number; severity: string; impact: number }[]; drains: Record<string, DrainPred>; impact_formula: string };
  ambulance: { mean_time_free_flow_min: number; mean_time_current_min: number; mean_delay_min: number; unreachable_origins: number; closed_segments: number; penalised_segments: number; rule: string };
  work_orders: { open: WorkOrder[]; recent_closed: WorkOrder[] };
  benchmark: { random_forest: ClassStats; rainfall_threshold_baseline: ClassStats; group_kfold_macro_f1: { mean: number; std: number }; feature_importance: Record<string, number>; dataset: { test_scenarios: number; n_samples: number; split: string }; provenance: { warning: string }; baseline_rule_mm_hr: { watch_from: number; severe_from: number; critical_from: number } };
  data_quality: { stale_sensors: number; out_of_range: number; rule: string; per_drain: { drain_id: string; sensor_age_sec: number; confidence: number; flags: string[] }[] };
  nfc_recent: NfcEvent[];
}
interface ScanMsg { type: "nfc_scan"; source: string; ts: string; uid: string | null; drain: DrainPred; ambulance: Ambulance | null; fly_to: { latitude: number; longitude: number; zoom: number; pitch: number; bearing: number; duration_ms: number } }
interface WsMsg { type: string; state?: CommandState; uid?: string; ts?: string }

class ApiError extends Error {
  status: number;
  constructor(status: number, msg: string) { super(msg); this.status = status; }
}
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${API}${path}`, { headers: { "Content-Type": "application/json" }, ...init });
  if (!r.ok) {
    let msg = r.statusText;
    try { const j = await r.json(); msg = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail ?? j); } catch { /* keep statusText */ }
    throw new ApiError(r.status, msg);
  }
  return r.json() as Promise<T>;
}
const errText = (e: unknown) => (e instanceof ApiError ? `${e.status}: ${e.message}` : e instanceof Error ? e.message : String(e));
const fmtIST = (iso: string) => new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const pct = (x: number) => `${Math.round(x * 100)}%`;

/* ------------------------------------------------------------------ */
/* Live state hook (REST + WebSocket with back-off + polling fallback) */
/* ------------------------------------------------------------------ */
function useCommand() {
  const [state, setState] = useState<CommandState | null>(null);
  const [conn, setConn] = useState<"connecting" | "live" | "offline">("connecting");
  const [scan, setScan] = useState<ScanMsg | null>(null);
  const [unknownUid, setUnknownUid] = useState<string | null>(null);
  const lastScan = useRef("");
  const refresh = useCallback(async () => { try { setState(await api<CommandState>("/api/state")); } catch { /* shown via conn */ } }, []);
  const pushScan = useCallback((m: ScanMsg) => {
    const k = `${m.ts}|${m.drain.drain_id}`;
    if (k === lastScan.current) return;
    lastScan.current = k;
    setScan(m);
  }, []);

  useEffect(() => {
    let ws: WebSocket | null = null, closed = false, retry = 1000, timer: number | undefined;
    const connect = () => {
      ws = new WebSocket(WS_URL);
      ws.onopen = () => { setConn("live"); retry = 1000; };
      ws.onmessage = (e: MessageEvent<string>) => {
        const m = JSON.parse(e.data) as WsMsg;
        if (m.state) setState(m.state);
        if (m.type === "nfc_scan") { pushScan(m as unknown as ScanMsg); void refresh(); }
        if (m.type === "nfc_unknown" && m.uid) { setUnknownUid(m.uid); void refresh(); }
      };
      ws.onclose = () => { setConn("offline"); if (!closed) { timer = window.setTimeout(connect, retry); retry = Math.min(retry * 2, 10000); } };
      ws.onerror = () => ws?.close();
    };
    void refresh(); connect();
    const poll = window.setInterval(() => { if (ws?.readyState !== WebSocket.OPEN) void refresh(); }, 10000);
    return () => { closed = true; window.clearTimeout(timer); window.clearInterval(poll); ws?.close(); };
  }, [refresh, pushScan]);

  return { state, setState, conn, scan, pushScan, unknownUid, refresh };
}

/* ------------------------------------------------------------------ */
/* Styles                                                             */
/* ------------------------------------------------------------------ */
const STYLES = `
.cc-root{--bg:#050B14;--panel:#0F172A;--panel2:#16233B;--text:#E6EEF8;--muted:#9FB0C6;--accent:#38BDF8;--gold:#F59E0B;--gold-text:#FBBF24;--line:rgba(56,189,248,.38);--ok:#22C55E;--bad:#F87171;
 background:var(--bg);color:var(--text);transition:background-color .4s,color .4s;font-size:14px}
.cc-root[data-theme="light"]{--bg:#F8FAFC;--panel:#FFFFFF;--panel2:#EEF2F7;--text:#0F172A;--muted:#475569;--accent:#1E3A8A;--gold:#D97706;--gold-text:#92400E;--line:#CBD5E1;--ok:#166534;--bad:#B91C1C}
.cc-root *{transition-property:background-color,border-color,color,box-shadow;transition-duration:.4s}
.cc-panel{background:var(--panel);border:1px solid var(--line);border-top:3px solid var(--gold);border-radius:12px}
.cc-bar{background:color-mix(in srgb,var(--panel) 92%,transparent);border-bottom:1px solid var(--line);backdrop-filter:blur(10px)}
.cc-focus:focus-visible{outline:3px solid var(--gold);outline-offset:2px}
.cc-btn{display:inline-flex;align-items:center;justify-content:center;gap:.4rem;border-radius:8px;padding:.45rem .8rem;min-height:36px;font-weight:600;font-size:13px;border:1px solid var(--line);background:var(--panel2);color:var(--text)}
.cc-btn:hover:not(:disabled){border-color:var(--accent)}
.cc-btn:disabled{opacity:.5;cursor:not-allowed}
.cc-btn-primary{background:var(--accent);color:#fff;border-color:transparent}
.cc-root[data-theme="dark"] .cc-btn-primary{color:#04121f}
.cc-chip{display:inline-flex;align-items:center;gap:.3rem;border-radius:999px;padding:.12rem .55rem;font-size:11px;font-weight:700;letter-spacing:.02em;border:1px solid color-mix(in srgb,var(--c) 55%,transparent);background:color-mix(in srgb,var(--c) 16%,transparent);color:var(--text)}
.cc-map .maplibregl-canvas{transition:filter .4s}
.cc-root[data-theme="dark"] .cc-map .maplibregl-canvas{filter:invert(1) hue-rotate(180deg) brightness(.72) contrast(.9) saturate(.7)}
.cc-range{width:100%;accent-color:var(--accent)}
.cc-input{background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:.4rem .6rem;color:var(--text);min-height:36px;width:100%}
@media (prefers-reduced-motion:reduce){.cc-root *{transition-duration:.01ms!important}}
`;

/* ------------------------------------------------------------------ */
/* Generic UI                                                         */
/* ------------------------------------------------------------------ */
const Chip = ({ children, c = "var(--accent)", title }: { children: ReactNode; c?: string; title?: string }) => (
  <span className="cc-chip" style={{ ["--c" as string]: c }} title={title}>{children}</span>
);
const SevChip = ({ sev }: { sev: number }) => <Chip c={SEV_HEX[sev] ?? "#64748B"}>{SEV_LABELS[sev] ?? "?"}</Chip>;

function Module({ n, title, icon: Icon, children, className = "", right }: { n: number; title: string; icon: typeof Activity; children: ReactNode; className?: string; right?: ReactNode }) {
  return (
    <section className={`cc-panel flex flex-col ${className}`} aria-labelledby={`m${n}`}>
      <header className="flex items-center justify-between gap-2 px-4 pt-3 pb-2">
        <h2 id={`m${n}`} className="flex items-center gap-2 text-sm font-bold uppercase tracking-wide">
          <span className="grid size-6 place-items-center rounded-md text-xs font-black" style={{ background: "var(--gold)", color: "#fff" }}>{n}</span>
          <Icon className="size-4" style={{ color: "var(--accent)" }} aria-hidden /> {title}
        </h2>
        {right}
      </header>
      <div className="flex-1 px-4 pb-4">{children}</div>
    </section>
  );
}

function Bar({ value, max = 1, color = "var(--accent)", label }: { value: number; max?: number; color?: string; label: string }) {
  return (
    <div className="h-2.5 w-full overflow-hidden rounded-full" style={{ background: "var(--panel2)" }} role="img" aria-label={label}>
      <motion.div className="h-full rounded-full" style={{ background: color }} initial={false} animate={{ width: `${Math.max(0, Math.min(value / max, 1)) * 100}%` }} transition={{ type: "spring", stiffness: 260, damping: 20 }} />
    </div>
  );
}

function Slider({ id, label, value, min, max, step, fmt, onCommit, disabled }: { id: string; label: string; value: number; min: number; max: number; step: number; fmt: (n: number) => string; onCommit: (n: number) => void; disabled?: boolean }) {
  const [v, setV] = useState(value);
  const editing = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => { if (!editing.current) setV(value); }, [value]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const change = (n: number) => {
    editing.current = true; setV(n);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { editing.current = false; onCommit(n); }, 350);
  };
  return (
    <div>
      <div className="flex justify-between text-xs"><label htmlFor={id} className="font-semibold">{label}</label><output htmlFor={id} className="tabular-nums" style={{ color: "var(--muted)" }}>{fmt(v)}</output></div>
      <input id={id} type="range" className="cc-range cc-focus" min={min} max={max} step={step} value={v} disabled={disabled} onChange={(e) => change(Number(e.target.value))} />
    </div>
  );
}

function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { onClose(); return; }
      if (e.key !== "Tab" || !ref.current) return;
      const f = ref.current.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])');
      if (!f.length) return;
      const a = f[0], b = f[f.length - 1];
      if (e.shiftKey && document.activeElement === a) { e.preventDefault(); b.focus(); }
      else if (!e.shiftKey && document.activeElement === b) { e.preventDefault(); a.focus(); }
    };
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("keydown", key); prev?.focus(); };
  }, [onClose]);
  return (
    <motion.div className="fixed inset-0 z-[80] grid place-items-center p-4" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <div className="absolute inset-0 bg-black/60" onClick={onClose} aria-hidden />
      <motion.div ref={ref} role="dialog" aria-modal="true" aria-label={title} className="cc-panel relative max-h-[92vh] w-full max-w-4xl overflow-y-auto p-4 shadow-2xl"
        initial={{ opacity: 0, y: 30, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 20 }} transition={{ type: "spring", stiffness: 260, damping: 20 }}>
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-lg font-bold">{title}</h2>
          <button ref={closeRef} onClick={onClose} className="cc-btn cc-focus" aria-label="Close dialog"><X className="size-4" aria-hidden /> Close</button>
        </div>
        {children}
      </motion.div>
    </motion.div>
  );
}

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = window.setInterval(() => setNow(new Date()), 1000); return () => window.clearInterval(t); }, []);
  return (
    <div className="flex items-center gap-1.5 tabular-nums" title="Indian Standard Time">
      <ClockIcon className="size-4" aria-hidden />
      <span className="font-semibold">{now.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false })}</span>
      <span className="text-xs" style={{ color: "var(--muted)" }}>IST</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 3D GIS map (MapLibre + Deck.gl)                                    */
/* ------------------------------------------------------------------ */
interface MapShow { roads: boolean; conduits: boolean; water: boolean; labels: boolean }
interface FlyReq { lat: number; lon: number; zoom: number; pitch: number; bearing: number; n: number }
interface PulseReq { lat: number; lon: number; n: number }
type RoadF = Feature<RoadProps>;
type DrainF = Feature<DrainProps>;
type ConduitDatum = { path: [number, number][]; timestamps: number[] };

function mapStyle(): maplibregl.StyleSpecification {
  return {
    version: 8,
    sources: { osm: { type: "raster", tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"], tileSize: 256, maxzoom: 19, attribution: "© OpenStreetMap contributors" } },
    layers: [{ id: "bg", type: "background", paint: { "background-color": "#dfe7ef" } }, { id: "osm", type: "raster", source: "osm", paint: { "raster-opacity": 0.85 } }],
  };
}

function GisMap({ state, selected, onSelect, fly, pulse, theme, show, reduce }: {
  state: CommandState; selected: string | null; onSelect: (id: string) => void; fly: FlyReq | null; pulse: PulseReq | null; theme: Theme; show: MapShow; reduce: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const overlayRef = useRef<MapboxOverlay | null>(null);
  const fitted = useRef(false);
  const pulseRef = useRef<{ lat: number; lon: number; t0: number } | null>(null);
  const latest = useRef({ state, selected, theme, show, onSelect });
  latest.current = { state, selected, theme, show, onSelect };
  const clock = useRef(0);

  const conduits = useMemo<ConduitDatum[]>(
    () => state.map_layers.conduits.features.map((f) => ({ path: f.geometry.coordinates as [number, number][], timestamps: [0, 1] })),
    [state.map_layers.conduits],
  );

  const build = useCallback((t: number): Layer[] => {
    const { state: s, selected: sel, theme: th, show: sh } = latest.current;
    const dark = th === "dark";
    const layers: Layer[] = [];
    if (sh.roads) {
      layers.push(new PathLayer<RoadF>({
        id: "roads", data: s.map_layers.roads.features, pickable: true, widthUnits: "meters", widthMinPixels: 2,
        getPath: (f) => f.geometry.coordinates as [number, number][],
        getColor: (f) => (f.properties.closed ? [220, 38, 38, 240] : f.properties.penalised ? [245, 158, 11, 235] : dark ? [34, 197, 94, 210] : [21, 128, 61, 220]),
        getWidth: (f) => (f.properties.road_class === "arterial" ? 9 : f.properties.road_class === "collector" ? 6 : 4),
        capRounded: true, jointRounded: true,
      }));
    }
    if (sh.conduits) {
      layers.push(new PathLayer<ConduitDatum>({ id: "conduit-base", data: conduits, getPath: (d) => d.path, getColor: [56, 189, 248, 90], widthMinPixels: 2, getWidth: 4 }));
      layers.push(new TripsLayer<ConduitDatum>({
        id: "conduit-flow", data: conduits, getPath: (d) => d.path, getTimestamps: (d) => d.timestamps, getColor: [125, 211, 252, 255],
        widthMinPixels: 3, getWidth: 6, trailLength: 0.6, currentTime: (t / 2200) % 1.6, fadeTrail: true, capRounded: true,
      }));
    }
    if (sh.water) {
      layers.push(new ColumnLayer<DrainF>({
        id: "water", data: s.map_layers.drains.features, pickable: true, diskResolution: 20, radius: 26, extruded: true, elevationScale: 1,
        getPosition: (f) => f.geometry.coordinates as [number, number],
        getElevation: (f) => Math.max(f.properties.water_depth_m, 0.02) * 70,
        getFillColor: (f) => [...(SEV_RGB[f.properties.severity] ?? SEV_RGB[0]), 215] as [number, number, number, number],
        material: { ambient: 0.6, diffuse: 0.6, shininess: 24 },
      }));
    }
    layers.push(new ScatterplotLayer<DrainF>({
      id: "assets", data: s.map_layers.drains.features.filter((f) => f.properties.nfc_tagged), pickable: true, stroked: true, filled: false,
      getPosition: (f) => f.geometry.coordinates as [number, number], radiusUnits: "meters", getRadius: 38, lineWidthMinPixels: 2,
      getLineColor: dark ? [56, 189, 248, 255] : [30, 58, 138, 255],
    }));
    if (sel) {
      const d = s.predictions.drains[sel];
      if (d) layers.push(new ScatterplotLayer({ id: "selected", data: [d], getPosition: (x: DrainPred) => [x.lon, x.lat], stroked: true, filled: false, radiusUnits: "meters", getRadius: 62, lineWidthMinPixels: 4, getLineColor: [245, 158, 11, 255] }));
    }
    const p = pulseRef.current;
    if (p) {
      const el = performance.now() - p.t0;
      if (el < 3600) {
        const ph = (el % 1200) / 1200;
        layers.push(new ScatterplotLayer({ id: "pulse", data: [p], getPosition: (x: { lat: number; lon: number }) => [x.lon, x.lat], stroked: true, filled: false, radiusUnits: "meters", getRadius: 40 + 520 * ph, lineWidthMinPixels: 3, getLineColor: [245, 158, 11, Math.round(255 * (1 - ph))], updateTriggers: { getRadius: el, getLineColor: el } }));
      } else pulseRef.current = null;
    }
    layers.push(new ScatterplotLayer<Hospital>({ id: "hospitals", data: s.hospitals, getPosition: (h) => [h.lon, h.lat], getFillColor: [37, 99, 235, 230], getLineColor: [255, 255, 255, 255], stroked: true, radiusUnits: "pixels", getRadius: 9, lineWidthMinPixels: 2 }));
    if (sh.labels) {
      layers.push(new TextLayer<DrainF>({
        id: "labels", data: s.map_layers.drains.features.filter((f) => f.properties.nfc_tagged), getPosition: (f) => f.geometry.coordinates as [number, number],
        getText: (f) => f.properties.drain_id, getSize: 13, getColor: dark ? [226, 232, 240, 255] : [15, 23, 42, 255], getPixelOffset: [0, -26], fontWeight: 700,
        background: true, getBackgroundColor: dark ? [5, 11, 20, 225] : [255, 255, 255, 235], backgroundPadding: [4, 2],
      }));
      layers.push(new TextLayer<Hospital>({ id: "hospital-labels", data: s.hospitals, getPosition: (h) => [h.lon, h.lat], getText: () => "H 108", getSize: 12, getColor: dark ? [147, 197, 253, 255] : [30, 64, 175, 255], getPixelOffset: [0, 18], fontWeight: 700 }));
    }
    return layers;
  }, [conduits]);

  // init map + overlay once
  useEffect(() => {
    if (!host.current) return;
    const map = new maplibregl.Map({ container: host.current, style: mapStyle(), center: [85.8245, 20.2961], zoom: 14.5, pitch: 55, bearing: 15, attributionControl: { compact: true } });
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-left");
    const overlay = new MapboxOverlay({
      interleaved: false, layers: [],
      onClick: (info: PickingInfo) => {
        const o = info.object as { properties?: { drain_id?: string; linked_drain?: string } } | undefined;
        const id = o?.properties?.drain_id ?? o?.properties?.linked_drain;
        if (id) latest.current.onSelect(id);
      },
      getTooltip: (info: PickingInfo) => {
        const o = info.object as { properties?: Record<string, unknown> } | undefined;
        const p = o?.properties;
        if (!p) return null;
        const text = info.layer?.id === "roads"
          ? `Segment ${p.edge_id}\n${p.closed ? "BLOCKED" : p.penalised ? "DEGRADED" : "ACCESSIBLE"} | P(severe+) ${pct(Number(p.p_severe))}`
          : `${p.drain_id}: ${p.name}\n${p.severity_label ?? ""} | depth ${Number(p.water_depth_m).toFixed(2)} m`;
        return { text, style: { fontSize: "12px", backgroundColor: "#0F172A", color: "#E6EEF8", border: "1px solid #38BDF8" } };
      },
    });
    map.addControl(overlay as unknown as maplibregl.IControl);
    mapRef.current = map; overlayRef.current = overlay;

    let raf = 0, last = 0;
    const loop = (ts: number) => {
      if (ts - last > 33) { last = ts; clock.current = ts; overlay.setProps({ layers: build(ts) }); }
      raf = requestAnimationFrame(loop);
    };
    if (!reduce) raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); overlay.finalize(); map.remove(); mapRef.current = null; overlayRef.current = null; };
  }, [build, reduce]);

  // redraw on data changes (also covers reduced-motion where no loop runs)
  useEffect(() => { overlayRef.current?.setProps({ layers: build(clock.current) }); }, [state, selected, theme, show, build]);

  // fit to the study area once
  useEffect(() => {
    const map = mapRef.current;
    if (!map || fitted.current) return;
    const b = new maplibregl.LngLatBounds();
    state.map_layers.roads.features.forEach((f) => (f.geometry.coordinates as [number, number][]).forEach((c) => b.extend(c as [number, number])));
    if (!b.isEmpty()) { map.fitBounds(b, { padding: 60, pitch: 55, bearing: 15, duration: 0 }); fitted.current = true; }
  }, [state.map_layers.roads]);

  // NFC fly-to + radar pulse
  useEffect(() => {
    if (!fly || !mapRef.current) return;
    mapRef.current.flyTo({ center: [fly.lon, fly.lat], zoom: fly.zoom, pitch: fly.pitch, bearing: fly.bearing, duration: reduce ? 0 : 2200, essential: true });
  }, [fly, reduce]);
  useEffect(() => { if (pulse) pulseRef.current = { lat: pulse.lat, lon: pulse.lon, t0: performance.now() }; }, [pulse]);

  return <div ref={host} className="cc-map h-full w-full overflow-hidden rounded-lg" role="application" aria-label="3D flood map. Use the asset list below the map for keyboard access." />;
}

/* ------------------------------------------------------------------ */
/* Three.js culvert cutaway                                           */
/* ------------------------------------------------------------------ */
const CW = 3, CH = 2.4, CL = 9;
function rng32(seed: number) { let a = seed; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function Flow({ fill, speed }: { fill: number; speed: number }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const seeds = useMemo(() => { const r = rng32(11); return Array.from({ length: 44 }, () => ({ x: r() * CL, y: r(), z: r() - 0.5 })); }, []);
  useFrame((_, dt) => {
    const m = ref.current; if (!m) return;
    seeds.forEach((p, i) => {
      p.x = (p.x + dt * speed) % CL;
      dummy.position.set(-CL / 2 + p.x, -CH / 2 + 0.12 + p.y * Math.max(fill * CH - 0.25, 0.02), p.z * (CW - 0.5));
      dummy.scale.setScalar(fill > 0.04 ? 1 : 0);
      dummy.updateMatrix(); m.setMatrixAt(i, dummy.matrix);
    });
    m.instanceMatrix.needsUpdate = true;
  });
  return <instancedMesh ref={ref} args={[undefined, undefined, 44]}><sphereGeometry args={[0.07, 8, 8]} /><meshBasicMaterial color="#e0f2fe" /></instancedMesh>;
}

function CulvertScene({ fill, ponding, blockage, ratio, sev, animate }: { fill: number; ponding: number; blockage: number; ratio: number; sev: number; animate: boolean }) {
  const debris = useMemo(() => {
    const r = rng32(7);
    return Array.from({ length: 22 }, () => ({
      pos: [-CL / 2 + 0.35 + r() * 1.7, -CH / 2 + 0.15 + r() * (CH - 0.4), (r() - 0.5) * (CW - 0.5)] as [number, number, number],
      size: [0.35 + r() * 0.5, 0.25 + r() * 0.45, 0.35 + r() * 0.5] as [number, number, number], rot: r() * 3,
    }));
  }, []);
  const shown = Math.round(blockage * debris.length);
  const wh = Math.max(fill * CH, 0.001);
  const ph = ponding * 0.6;
  return (
    <>
      <ambientLight intensity={0.8} /><directionalLight position={[5, 8, 6]} intensity={1.1} />
      {/* floor + back wall + road slab (front wall removed = cutaway) */}
      <mesh position={[0, -CH / 2 - 0.08, 0]}><boxGeometry args={[CL, 0.16, CW]} /><meshStandardMaterial color="#64748b" /></mesh>
      <mesh position={[0, 0, -CW / 2 - 0.06]}><boxGeometry args={[CL, CH, 0.12]} /><meshStandardMaterial color="#94a3b8" transparent opacity={0.55} /></mesh>
      <mesh position={[0, CH / 2 + 0.15, 0]}><boxGeometry args={[CL + 2, 0.3, CW + 1.6]} /><meshStandardMaterial color="#334155" /></mesh>
      <mesh position={[0, 0, CW / 2]}><boxGeometry args={[CL, CH, 0.02]} /><meshBasicMaterial color="#7dd3fc" transparent opacity={0.07} /><Edges color="#38bdf8" /></mesh>
      {/* water inside the culvert: height tracks flow/capacity */}
      <mesh position={[0, -CH / 2 + wh / 2, 0]}><boxGeometry args={[CL - 0.1, wh, CW - 0.12]} /><meshStandardMaterial color="#0ea5e9" transparent opacity={0.55} /></mesh>
      <Flow fill={fill} speed={animate ? 0.5 + 2.2 * Math.min(ratio, 1.5) * (1 - 0.85 * blockage) : 0} />
      {/* surface ponding on the road once the culvert surcharges */}
      {ponding > 0.01 && <mesh position={[0, CH / 2 + 0.3 + ph / 2, 0]}><boxGeometry args={[CL + 1.6, ph, CW + 1.2]} /><meshStandardMaterial color={SEV_HEX[sev]} transparent opacity={0.55} /></mesh>}
      {/* debris at the inlet */}
      {debris.slice(0, shown).map((d, i) => <mesh key={i} position={d.pos} rotation={[d.rot, d.rot * 0.7, 0]}><boxGeometry args={d.size} /><meshStandardMaterial color="#78350f" roughness={1} /></mesh>)}
      <OrbitControls enablePan={false} minDistance={6} maxDistance={18} maxPolarAngle={Math.PI / 2.05} />
    </>
  );
}

function CutawayDialog({ drain, onClose, reduce }: { drain: DrainPred; onClose: () => void; reduce: boolean }) {
  const fill = Math.min(drain.flow_to_capacity / 1.5, 1);
  return (
    <Dialog title={`Culvert cutaway: ${drain.drain_id} ${drain.name}`} onClose={onClose}>
      <div className="grid gap-4 md:grid-cols-[1fr_260px]">
        <div className="h-[340px] overflow-hidden rounded-lg" style={{ background: "linear-gradient(#0b1220,#16233B)" }}>
          <Canvas camera={{ position: [7, 3.2, 9], fov: 45 }} dpr={[1, 1.5]}>
            <CulvertScene fill={fill} ponding={drain.water_depth_m} blockage={drain.blockage_fraction} ratio={drain.flow_to_capacity} sev={drain.severity} animate={!reduce} />
          </Canvas>
        </div>
        <dl className="space-y-2 text-sm">
          <div className="flex justify-between"><dt>Severity</dt><dd><SevChip sev={drain.severity} /></dd></div>
          <div className="flex justify-between"><dt>Flow / capacity</dt><dd className="font-bold tabular-nums">{drain.flow_to_capacity.toFixed(2)}</dd></div>
          <div className="flex justify-between"><dt>Surface water depth</dt><dd className="font-bold tabular-nums">{drain.water_depth_m.toFixed(2)} m</dd></div>
          <div className="flex justify-between"><dt>Debris blockage</dt><dd className="font-bold tabular-nums">{pct(drain.blockage_fraction)}</dd></div>
          <div className="flex justify-between"><dt>P(severe+)</dt><dd className="font-bold tabular-nums">{pct(drain.p_severe)}</dd></div>
          <div className="flex justify-between"><dt>Sensor age / confidence</dt><dd className="tabular-nums">{Math.round(drain.sensor_age_sec)} s / {pct(drain.confidence)}</dd></div>
          <p className="pt-2 text-xs" style={{ color: "var(--muted)" }}>Schematic digital twin, not to scale. Culvert water level follows flow-to-capacity; the coloured layer on the road is surface ponding; brown blocks are debris at the inlet. Drag to rotate, scroll to zoom.</p>
        </dl>
      </div>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Modules                                                            */
/* ------------------------------------------------------------------ */
function Module1({ s, run, busy }: { s: CommandState; run: (b: object) => void; busy: boolean }) {
  const sc = s.scenario;
  const [pick, setPick] = useState("DR-01");
  const ids = Object.keys(s.predictions.drains);
  const counts = SEV_LABELS.map((l, i) => ({ l, i, n: s.predictions.severity_counts[l] ?? 0 }));
  const total = counts.reduce((a, c) => a + c.n, 0) || 1;
  return (
    <Module n={1} title="Basin Overview & Storm Simulator" icon={Gauge} right={busy ? <Chip c="#CA8A04">Recomputing...</Chip> : <Chip c="#16A34A">Ready</Chip>}>
      <div className="grid grid-cols-2 gap-2">
        {counts.map((c) => (
          <div key={c.l} className="rounded-lg p-2" style={{ background: "var(--panel2)", borderLeft: `4px solid ${SEV_HEX[c.i]}` }}>
            <div className="text-xs font-semibold" style={{ color: "var(--muted)" }}>{c.l} segments</div>
            <div className="text-2xl font-black tabular-nums">{c.n}</div>
            <Bar value={c.n} max={total} color={SEV_HEX[c.i]} label={`${c.l}: ${c.n} of ${total} segments`} />
          </div>
        ))}
      </div>
      <dl className="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
        <div className="rounded-lg p-2" style={{ background: "var(--panel2)" }}><dt style={{ color: "var(--muted)" }}>Blocked roads</dt><dd className="text-lg font-bold tabular-nums">{s.ambulance.closed_segments}</dd></div>
        <div className="rounded-lg p-2" style={{ background: "var(--panel2)" }}><dt style={{ color: "var(--muted)" }}>Ambulance delay</dt><dd className="text-lg font-bold tabular-nums">+{s.ambulance.mean_delay_min.toFixed(1)}m</dd></div>
        <div className="rounded-lg p-2" style={{ background: "var(--panel2)" }}><dt style={{ color: "var(--muted)" }}>Open orders</dt><dd className="text-lg font-bold tabular-nums">{s.work_orders.open.length}</dd></div>
      </dl>

      <h3 className="mt-4 mb-2 text-xs font-bold uppercase tracking-wider" style={{ color: "var(--gold-text)" }}>Storm presets</h3>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Storm presets">
        {(["calm", "moderate", "cloudburst"] as const).map((p) => (
          <button key={p} className={`cc-btn cc-focus ${sc.preset === p ? "cc-btn-primary" : ""}`} aria-pressed={sc.preset === p} onClick={() => run({ preset: p })}>{p[0].toUpperCase() + p.slice(1)}</button>
        ))}
        <button className="cc-btn cc-focus" onClick={() => run({ reset: true })}>Reset</button>
      </div>
      <div className="mt-3 space-y-3">
        <Slider id="rain" label="Rainfall" value={sc.rainfall_mm_hr} min={0} max={200} step={5} fmt={(n) => `${n} mm/hr`} onCommit={(n) => run({ rainfall_mm_hr: n })} />
        <Slider id="wet" label="Antecedent wetness" value={sc.antecedent_wetness} min={0} max={1} step={0.05} fmt={(n) => n.toFixed(2)} onCommit={(n) => run({ antecedent_wetness: n })} />
        <Slider id="blk" label="Basin-wide blockage added" value={sc.global_blockage} min={0} max={0.9} step={0.05} fmt={pct} onCommit={(n) => run({ global_blockage: n })} />
      </div>
      <h3 className="mt-4 mb-2 text-xs font-bold uppercase tracking-wider" style={{ color: "var(--gold-text)" }}>Choke one culvert</h3>
      <label htmlFor="pick" className="sr-only">Drain</label>
      <select id="pick" className="cc-input cc-focus mb-2" value={pick} onChange={(e) => setPick(e.target.value)}>
        {ids.map((d) => <option key={d} value={d}>{d}{s.predictions.drains[d].nfc_tagged ? " (NFC tag)" : ""}</option>)}
      </select>
      <Slider id="one" label={`Blockage at ${pick}`} value={sc.blockage_overrides[pick] ?? s.predictions.drains[pick]?.blockage_fraction ?? 0} min={0} max={0.95} step={0.05} fmt={pct} onCommit={(n) => run({ blockage: { [pick]: n } })} />
      <label className="mt-4 flex cursor-pointer items-center gap-2 text-sm font-medium">
        <input type="checkbox" className="size-4 cc-focus" checked={sc.stale_drains.length > 0} onChange={(e) => run({ stale_sensors: e.target.checked, sensor_age_sec: 1500 })} />
        Simulate stale sensor data (age 1500 s)
      </label>
    </Module>
  );
}

function Module2({ s, selected, onSelect, onTap, onCutaway, map, show, setShow }: {
  s: CommandState; selected: string | null; onSelect: (id: string) => void; onTap: (id: string) => void; onCutaway: () => void; map: ReactNode; show: MapShow; setShow: (m: MapShow) => void;
}) {
  const tagged = Object.values(s.predictions.drains).filter((d) => d.nfc_tagged).sort((a, b) => a.drain_id.localeCompare(b.drain_id));
  const sel = selected ? s.predictions.drains[selected] : null;
  return (
    <Module n={2} title="3D GIS Map & Asset Inspector" icon={Layers} className="min-h-[640px]">
      <div className="relative h-[430px] lg:h-[470px]">
        {map}
        <fieldset className="cc-panel absolute right-2 top-2 z-10 p-2 text-xs" style={{ borderTopWidth: 1 }}>
          <legend className="sr-only">Map layers</legend>
          {(["roads", "conduits", "water", "labels"] as const).map((k) => (
            <label key={k} className="flex cursor-pointer items-center gap-1.5 py-0.5 capitalize"><input type="checkbox" checked={show[k]} onChange={(e) => setShow({ ...show, [k]: e.target.checked })} className="cc-focus" />{k === "water" ? "Water depth bars" : k}</label>
          ))}
        </fieldset>
        <div className="cc-panel absolute bottom-2 left-2 z-10 p-2 text-xs" style={{ borderTopWidth: 1 }} aria-label="Legend">
          {[["#22C55E", "Accessible"], ["#F59E0B", "Degraded (x3 time)"], ["#DC2626", "Blocked"]].map(([c, l]) => <div key={l} className="flex items-center gap-1.5"><span className="inline-block h-1.5 w-5 rounded" style={{ background: c }} />{l}</div>)}
          <div className="mt-1 flex items-center gap-1.5"><span className="inline-block size-3 rounded-full" style={{ background: "#2563EB" }} />Hospital gateway (approx.)</div>
          <div className="mt-1" style={{ color: "var(--muted)" }}>Bar height = water depth (exaggerated)</div>
        </div>
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-[1fr_1fr]">
        <div>
          <h3 className="mb-1 text-xs font-bold uppercase tracking-wider" style={{ color: "var(--gold-text)" }}>NFC-tagged assets</h3>
          <ul className="space-y-1" aria-label="NFC tagged assets">
            {tagged.map((d) => (
              <li key={d.drain_id}>
                <button onClick={() => onSelect(d.drain_id)} aria-pressed={selected === d.drain_id} className="cc-focus flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left"
                  style={{ background: selected === d.drain_id ? "color-mix(in srgb,var(--accent) 18%,transparent)" : "var(--panel2)", border: "1px solid var(--line)" }}>
                  <span className="truncate"><b>{d.drain_id}</b> <span style={{ color: "var(--muted)" }}>{d.name}</span></span><SevChip sev={d.severity} />
                </button>
              </li>
            ))}
          </ul>
        </div>
        <div aria-live="polite">
          <h3 className="mb-1 text-xs font-bold uppercase tracking-wider" style={{ color: "var(--gold-text)" }}>Asset inspector</h3>
          {sel ? (
            <div className="rounded-lg p-3" style={{ background: "var(--panel2)" }}>
              <div className="font-bold">{sel.drain_id}: {sel.name}</div>
              <div className="mt-1 flex flex-wrap gap-1.5"><SevChip sev={sel.severity} /><Chip>P(severe+) {pct(sel.p_severe)}</Chip><Chip c="#64748B">Impact {sel.impact.toFixed(3)}</Chip></div>
              <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                <dt style={{ color: "var(--muted)" }}>Water depth</dt><dd className="tabular-nums">{sel.water_depth_m.toFixed(2)} m</dd>
                <dt style={{ color: "var(--muted)" }}>Blockage</dt><dd className="tabular-nums">{pct(sel.blockage_fraction)}</dd>
                <dt style={{ color: "var(--muted)" }}>Flow / capacity</dt><dd className="tabular-nums">{sel.flow_to_capacity.toFixed(2)}</dd>
                <dt style={{ color: "var(--muted)" }}>Sensor age</dt><dd className="tabular-nums">{Math.round(sel.sensor_age_sec)} s ({pct(sel.confidence)} conf.)</dd>
              </dl>
              <p className="mt-2 text-xs"><b>Recommended:</b> {sel.recommended_action}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {sel.nfc_tagged && <button className="cc-btn cc-btn-primary cc-focus" onClick={() => onTap(sel.drain_id)}><Radio className="size-4" aria-hidden /> Simulate NFC Tap</button>}
                <button className="cc-btn cc-focus" onClick={onCutaway}>Open 3D cutaway</button>
              </div>
            </div>
          ) : <p className="rounded-lg p-3 text-sm" style={{ background: "var(--panel2)", color: "var(--muted)" }}>Select a tagged asset, click a bar on the map, or tap a sticker on the printed map.</p>}
        </div>
      </div>
    </Module>
  );
}

function Module3({ s, selected }: { s: CommandState; selected: string | null }) {
  const ids = Object.keys(s.predictions.drains);
  const [pick, setPick] = useState<string | null>(null);
  const id = pick ?? selected ?? s.work_orders.open[0]?.drain_id ?? ids[0];
  const d = s.predictions.drains[id];
  const a = d?.ambulance;
  const CAP = 60;
  const rows = a ? [
    { k: "Free-flow (no flood)", v: a.free_flow_min, c: "#16A34A" },
    { k: "Now (flooded network)", v: a.current_min, c: "#CA8A04" },
    { k: "If this segment is lost", v: a.if_segment_closed_min, c: "#DC2626" },
  ] : [];
  return (
    <Module n={3} title="Road-Graph Consequence & 108 Hospital Detour" icon={AmbulanceIcon}>
      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <label htmlFor="d3" className="text-xs font-semibold">Asset</label>
          <select id="d3" className="cc-input cc-focus mb-3" value={id} onChange={(e) => setPick(e.target.value)}>
            {ids.map((x) => <option key={x} value={x}>{x} - {s.predictions.drains[x].name}</option>)}
          </select>
          {a ? (
            <div>
              <p className="mb-2 text-xs" style={{ color: "var(--muted)" }}>Ambulance trip from <b style={{ color: "var(--text)" }}>{a.origin_name}</b> to <b style={{ color: "var(--text)" }}>{a.nearest_hospital ?? "nearest hospital"}</b></p>
              {rows.map((r) => (
                <div key={r.k} className="mb-2">
                  <div className="flex justify-between text-xs"><span>{r.k}</span><b className="tabular-nums">{r.v >= CAP ? `${CAP}+ min` : `${r.v.toFixed(1)} min`}</b></div>
                  <Bar value={r.v} max={CAP} color={r.c} label={`${r.k}: ${r.v.toFixed(1)} minutes`} />
                </div>
              ))}
              <div className="mt-2 rounded-lg p-2 text-sm font-semibold" style={{ background: "var(--panel2)", border: `1px solid ${a.unreachable ? "#DC2626" : "var(--line)"}` }}>
                {a.unreachable ? "Hospital UNREACHABLE if this segment is lost (60 min cap shown)." : `Detour penalty: +${a.detour_delta_min.toFixed(1)} min`}
              </div>
            </div>
          ) : <p className="rounded-lg p-3 text-sm" style={{ background: "var(--panel2)", color: "var(--muted)" }}>No consequence computed: this asset's impact is below the work-order threshold in the current scenario. Raise rainfall or choke the culvert.</p>}
          <h3 className="mt-4 mb-1 text-xs font-bold uppercase tracking-wider" style={{ color: "var(--gold-text)" }}>Network summary</h3>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
            <dt style={{ color: "var(--muted)" }}>Mean trip, free-flow</dt><dd className="tabular-nums">{s.ambulance.mean_time_free_flow_min.toFixed(1)} min</dd>
            <dt style={{ color: "var(--muted)" }}>Mean trip, now</dt><dd className="tabular-nums">{s.ambulance.mean_time_current_min.toFixed(1)} min</dd>
            <dt style={{ color: "var(--muted)" }}>Cut-off origins</dt><dd className="tabular-nums">{s.ambulance.unreachable_origins}</dd>
            <dt style={{ color: "var(--muted)" }}>Blocked / degraded segments</dt><dd className="tabular-nums">{s.ambulance.closed_segments} / {s.ambulance.penalised_segments}</dd>
          </dl>
          <p className="mt-2 text-xs" style={{ color: "var(--muted)" }}>Rule: {s.ambulance.rule}. Hospital gateways are approximate boundary nodes, not surveyed hospital entrances.</p>
        </div>
        <div className="min-w-0">
          <h3 className="mb-1 text-xs font-bold uppercase tracking-wider" style={{ color: "var(--gold-text)" }}>Top road segments by consequence</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <caption className="sr-only">Top 10 segments by impact</caption>
              <thead><tr style={{ color: "var(--muted)" }}><th scope="col" className="py-1 text-left">Segment</th><th scope="col" className="text-left">Drain</th><th scope="col" className="text-right">P(severe+)</th><th scope="col" className="text-left pl-2">Class</th><th scope="col" className="text-right">Impact</th></tr></thead>
              <tbody>{s.predictions.top_segments.map((t) => (
                <tr key={t.edge_id} style={{ borderTop: "1px solid var(--line)" }}><th scope="row" className="py-1 text-left font-semibold">{t.edge_id}</th><td>{t.drain_id}</td><td className="text-right tabular-nums">{pct(t.p_severe)}</td><td className="pl-2">{t.severity}</td><td className="text-right font-bold tabular-nums">{t.impact.toFixed(3)}</td></tr>
              ))}</tbody>
            </table>
          </div>
          <code className="mt-3 block overflow-x-auto rounded-lg p-2 text-[11px]" style={{ background: "var(--panel2)" }}>{s.predictions.impact_formula}</code>
        </div>
      </div>
    </Module>
  );
}

const STATUS_COLOR: Record<string, string> = { Pending: "#D97706", Approved: "#16A34A", Overridden: "#7C3AED", Deferred: "#2563EB", Cleared: "#16A34A", "Stood Down": "#64748B" };

function WorkOrderCard({ w, operator, decide, onFocus }: { w: WorkOrder; operator: string; decide: (id: number, body: object) => Promise<string | null>; onFocus: (d: string) => void }) {
  const [form, setForm] = useState<null | "Override" | "MarkCleared">(null);
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [defer, setDefer] = useState(30);
  const ok = operator.trim().length >= 2;
  const send = async (action: string, extra: object = {}) => {
    setMsg(null);
    const e = await decide(w.id, { action, ...extra });
    if (e) {
      setMsg(e);
      if (action === "MarkCleared" && e.startsWith("409")) setForm("MarkCleared");
    } else { setForm(null); setReason(""); }
  };
  return (
    <motion.li layout initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ type: "spring", stiffness: 260, damping: 20 }}
      className="rounded-xl p-3" style={{ background: "var(--panel2)", border: "1px solid var(--line)" }}>
      <div className="flex items-start justify-between gap-2">
        <button onClick={() => onFocus(w.drain_id)} className="cc-focus text-left"><span className="text-xs font-bold" style={{ color: "var(--gold-text)" }}>#{w.rank} | WO-{w.id}</span><br /><b>{w.drain_id}</b> <span style={{ color: "var(--muted)" }}>{w.asset_name}</span></button>
        <Chip c={STATUS_COLOR[w.status] ?? "#64748B"}>{w.status}</Chip>
      </div>
      <div className="mt-2"><Bar value={w.priority_score} max={0.7} color="var(--gold)" label={`Priority ${w.priority_score.toFixed(3)}`} /></div>
      <div className="mt-1 flex flex-wrap gap-x-3 text-xs tabular-nums" style={{ color: "var(--muted)" }}><span>Impact {w.impact.toFixed(3)}</span><span>P(severe+) {pct(w.p_severe)}</span>{w.detour_delta_min != null && <span>Detour +{w.detour_delta_min.toFixed(1)} min</span>}</div>
      <p className="mt-1 text-xs"><b>AI recommends:</b> {w.recommended_action}</p>
      {w.last_decision && <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>Last: {w.last_decision} by {w.operator}{w.verification_source ? ` (verified: ${w.verification_source})` : ""}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <button className="cc-btn cc-btn-primary cc-focus" disabled={!ok || w.status === "Approved"} onClick={() => void send("Approve", { operator })}><Check className="size-4" aria-hidden /> Approve</button>
        <button className="cc-btn cc-focus" disabled={!ok} onClick={() => setForm(form === "Override" ? null : "Override")} aria-expanded={form === "Override"}>Override</button>
        <button className="cc-btn cc-focus" disabled={!ok} onClick={() => void send("Defer", { operator, defer_minutes: defer })}>Defer</button>
        <label className="sr-only" htmlFor={`df${w.id}`}>Defer minutes</label>
        <select id={`df${w.id}`} className="cc-input cc-focus !w-auto !min-h-[34px]" value={defer} onChange={(e) => setDefer(Number(e.target.value))}>{[15, 30, 60, 120].map((m) => <option key={m} value={m}>{m} min</option>)}</select>
        <button className="cc-btn cc-focus" disabled={!ok} onClick={() => void send("MarkCleared", { operator })}><ShieldCheck className="size-4" aria-hidden /> Mark Cleared</button>
      </div>
      {form && (
        <div className="mt-2">
          <label htmlFor={`rs${w.id}`} className="text-xs font-semibold">{form === "Override" ? "Reason for overriding the AI recommendation (required)" : "No NFC scan on record. Give a reason to clear without one (recorded in the audit log)"}</label>
          <textarea id={`rs${w.id}`} className="cc-input cc-focus mt-1" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
          <div className="mt-1 flex gap-2">
            <button className="cc-btn cc-btn-primary cc-focus" disabled={reason.trim().length < 3} onClick={() => void send(form, { operator, reason })}>Submit</button>
            <button className="cc-btn cc-focus" onClick={() => { setForm(null); setReason(""); }}>Cancel</button>
          </div>
        </div>
      )}
      {msg && <p role="alert" className="mt-2 text-xs font-semibold" style={{ color: "var(--bad)" }}>{msg}</p>}
    </motion.li>
  );
}

function Module4({ s, operator, setOperator, decide, onFocus }: { s: CommandState; operator: string; setOperator: (v: string) => void; decide: (id: number, body: object) => Promise<string | null>; onFocus: (d: string) => void }) {
  return (
    <Module n={4} title="Work-Order Dispatch Queue" icon={Zap} right={<Chip>Human in the loop</Chip>}>
      <label htmlFor="op" className="text-xs font-semibold">Duty officer (recorded in the audit log)</label>
      <input id="op" className="cc-input cc-focus mb-3 mt-1" value={operator} onChange={(e) => setOperator(e.target.value)} maxLength={64} autoComplete="name" />
      <ul className="max-h-[560px] space-y-2 overflow-y-auto pr-1" aria-label="Open work orders, highest priority first">
        <AnimatePresence initial={false}>
          {s.work_orders.open.map((w) => <WorkOrderCard key={w.id} w={w} operator={operator} decide={decide} onFocus={onFocus} />)}
        </AnimatePresence>
      </ul>
      {!s.work_orders.open.length && <p className="rounded-lg p-3 text-sm" style={{ background: "var(--panel2)", color: "var(--muted)" }}>No open work orders. Try the Cloudburst preset in Module 1.</p>}
      {s.work_orders.recent_closed.length > 0 && (
        <details className="mt-3 text-xs"><summary className="cc-focus cursor-pointer font-semibold">Recently closed ({s.work_orders.recent_closed.length})</summary>
          <ul className="mt-1 space-y-1">{s.work_orders.recent_closed.map((w) => <li key={w.id} className="flex justify-between gap-2"><span>WO-{w.id} {w.drain_id}</span><span style={{ color: "var(--muted)" }}>{w.status}{w.verification_source ? ` (${w.verification_source})` : ""}</span></li>)}</ul>
        </details>
      )}
    </Module>
  );
}

function Module5({ s, conn, unknownUid, onTap }: { s: CommandState; conn: string; unknownUid: string | null; onTap: (id: string) => void }) {
  const [pick, setPick] = useState("DR-01");
  const tagged = Object.values(s.predictions.drains).filter((d) => d.nfc_tagged).map((d) => d.drain_id).sort();
  return (
    <Module n={5} title="Live USB NFC Telemetry" icon={Radio} right={<Chip c={conn === "live" ? "#16A34A" : "#DC2626"}>{conn === "live" ? "Stream live" : conn === "connecting" ? "Connecting" : "Stream offline"}</Chip>}>
      <p className="mb-2 text-xs" style={{ color: "var(--muted)" }}>Hardware taps arrive from <code>python backend/nfc_bridge.py</code> with an HMAC signature. Fallback taps are flagged SIMULATED.</p>
      <div className="mb-3 flex items-end gap-2">
        <div className="flex-1"><label htmlFor="tap" className="text-xs font-semibold">Fallback tap</label>
          <select id="tap" className="cc-input cc-focus" value={pick} onChange={(e) => setPick(e.target.value)}>{tagged.map((t) => <option key={t}>{t}</option>)}</select></div>
        <button className="cc-btn cc-btn-primary cc-focus" onClick={() => onTap(pick)}>Simulate NFC Tap</button>
      </div>
      {unknownUid && <p role="alert" className="mb-2 rounded-lg p-2 text-xs font-semibold" style={{ background: "var(--panel2)", border: "1px solid #DC2626" }}>Unknown tag UID {unknownUid}. Enroll it: python backend/nfc_bridge.py --enroll DR-01</p>}
      <ul className="max-h-[330px] space-y-1.5 overflow-y-auto" aria-live="polite" aria-label="Recent NFC events">
        {s.nfc_recent.map((e) => (
          <li key={e.id} className="rounded-lg px-2 py-1.5 text-xs" style={{ background: "var(--panel2)" }}>
            <div className="flex items-center justify-between gap-2"><b>{e.asset_id ?? "unmatched"}</b>
              <Chip c={e.source === "HARDWARE" ? "#16A34A" : "#D97706"}>{e.source === "HARDWARE" ? "LIVE USB" : "SIMULATED"}</Chip></div>
            <div className="mt-0.5 flex justify-between gap-2" style={{ color: "var(--muted)" }}><span>{fmtIST(e.ts)}</span><span>{e.accepted ? "accepted" : `rejected: ${e.note ?? "-"}`}</span></div>
            {e.uid && <div className="tabular-nums" style={{ color: "var(--muted)" }}>UID {e.uid}</div>}
          </li>
        ))}
        {!s.nfc_recent.length && <li className="rounded-lg p-3 text-sm" style={{ background: "var(--panel2)", color: "var(--muted)" }}>No taps yet.</li>}
      </ul>
    </Module>
  );
}

function Module6({ s }: { s: CommandState }) {
  const b = s.benchmark;
  const [audit, setAudit] = useState<string>("");
  const verify = async () => { try { const r = await api<{ valid: boolean; entries: number }>("/api/audit/verify"); setAudit(`${r.entries} entries: chain ${r.valid ? "VALID" : "BROKEN"}`); } catch (e) { setAudit(errText(e)); } };
  const fi = Object.entries(b.feature_importance).slice(0, 5);
  const rows = [{ k: "Random Forest", v: b.random_forest.macro_f1, c: "var(--accent)" }, { k: "Rainfall-threshold baseline", v: b.rainfall_threshold_baseline.macro_f1, c: "var(--gold)" }];
  return (
    <Module n={6} title="AI vs Baseline & Data Quality" icon={Cpu}>
      <h3 className="mb-2 text-xs font-bold uppercase tracking-wider" style={{ color: "var(--gold-text)" }}>Macro-F1 on {b.dataset.test_scenarios} held-out scenarios</h3>
      {rows.map((r) => (
        <div key={r.k} className="mb-2"><div className="flex justify-between text-xs"><span>{r.k}</span><b className="tabular-nums">{r.v.toFixed(3)}</b></div><Bar value={r.v} color={r.c} label={`${r.k} macro F1 ${r.v.toFixed(3)}`} /></div>
      ))}
      <p className="text-xs" style={{ color: "var(--muted)" }}>5-fold GroupKFold: {b.group_kfold_macro_f1.mean.toFixed(3)} +/- {b.group_kfold_macro_f1.std.toFixed(3)}. Severe+ recall: RF {pct(b.random_forest.severe_or_critical_recall)} vs baseline {pct(b.rainfall_threshold_baseline.severe_or_critical_recall)}. Baseline cut-offs (mm/hr): {b.baseline_rule_mm_hr.watch_from} / {b.baseline_rule_mm_hr.severe_from} / {b.baseline_rule_mm_hr.critical_from}.</p>
      <div className="mt-2 rounded-lg p-2 text-xs" style={{ background: "var(--panel2)", border: "1px dashed var(--line)" }}>{b.provenance.warning}</div>
      <h3 className="mt-3 mb-1 text-xs font-bold uppercase tracking-wider" style={{ color: "var(--gold-text)" }}>Top features</h3>
      {fi.map(([k, v]) => <div key={k} className="mb-1 grid grid-cols-[1fr_90px] items-center gap-2 text-xs"><span className="truncate">{k}</span><Bar value={v} max={fi[0][1]} label={`${k} importance ${v}`} /></div>)}
      <h3 className="mt-4 mb-1 flex items-center gap-2 text-xs font-bold uppercase tracking-wider" style={{ color: "var(--gold-text)" }}>Data-quality monitor <Chip c={s.data_quality.stale_sensors ? "#DC2626" : "#16A34A"}>{s.data_quality.stale_sensors} stale</Chip><Chip c={s.data_quality.out_of_range ? "#DC2626" : "#16A34A"}>{s.data_quality.out_of_range} out of range</Chip></h3>
      <ul className="grid grid-cols-5 gap-1" aria-label="Per-sensor confidence">
        {s.data_quality.per_drain.map((p) => {
          const bad = p.flags.length > 0;
          return <li key={p.drain_id} title={`${p.drain_id}: age ${Math.round(p.sensor_age_sec)} s ${p.flags.join(", ")}`} className="rounded p-1 text-center text-[10px] leading-tight" style={{ background: "var(--panel2)", border: `1px solid ${bad ? "#DC2626" : "var(--line)"}` }}>
            <div className="font-bold">{p.drain_id.slice(3)}</div><div className="tabular-nums">{pct(p.confidence)}</div>{bad && <div style={{ color: "var(--bad)" }}>{p.flags[0]}</div>}</li>;
        })}
      </ul>
      <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>{s.data_quality.rule}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button className="cc-btn cc-focus" onClick={() => void verify()}><ShieldCheck className="size-4" aria-hidden /> Verify audit chain</button>
        <a className="cc-btn cc-focus" href={`${API}/api/logs/export-csv?table=audit_log`}>Audit CSV</a>
        <span role="status" className="text-xs font-semibold">{audit}</span>
      </div>
    </Module>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                               */
/* ------------------------------------------------------------------ */
export default function GovernmentCommandDashboard({ onBack }: { onBack?: () => void }) {
  const reduce = !!useReducedMotion();
  const { state, setState, conn, scan, pushScan, unknownUid, refresh } = useCommand();
  const [theme, setTheme] = useState<Theme>(() => {
    try { const t = localStorage.getItem("jd-theme"); if (t === "light" || t === "dark") return t; } catch { /* ignore */ }
    return "dark";
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [fly, setFly] = useState<FlyReq | null>(null);
  const [pulse, setPulse] = useState<PulseReq | null>(null);
  const [cutaway, setCutaway] = useState<string | null>(null);
  const [show, setShow] = useState<MapShow>({ roads: true, conduits: true, water: true, labels: true });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "error" | "info"; text: string } | null>(null);
  const [operator, setOperator] = useState(() => { try { return localStorage.getItem("jd-operator") ?? "Duty Officer"; } catch { return "Duty Officer"; } });
  const n = useRef(0);

  const toggleTheme = () => setTheme((t) => { const v: Theme = t === "dark" ? "light" : "dark"; try { localStorage.setItem("jd-theme", v); } catch { /* ignore */ } return v; });
  const setOp = (v: string) => { setOperator(v); try { localStorage.setItem("jd-operator", v); } catch { /* ignore */ } };

  const run = useCallback(async (body: object) => {
    setBusy(true);
    try { setState(await api<CommandState>("/api/scenario", { method: "POST", body: JSON.stringify({ ...body, operator }) })); setNotice(null); }
    catch (e) { setNotice({ kind: "error", text: `Scenario update failed - ${errText(e)}` }); }
    finally { setBusy(false); }
  }, [operator, setState]);

  const decide = useCallback(async (id: number, body: object): Promise<string | null> => {
    try { setState(await api<CommandState>(`/api/work-order/${id}/decision`, { method: "POST", body: JSON.stringify(body) })); return null; }
    catch (e) { return errText(e); }
  }, [setState]);

  const tap = useCallback(async (drainId: string) => {
    try {
      const r = await api<{ event: ScanMsg }>("/api/nfc-simulate", { method: "POST", body: JSON.stringify({ drain_id: drainId, operator }) });
      pushScan(r.event); void refresh();
    } catch (e) { setNotice({ kind: "error", text: `Simulated tap failed - ${errText(e)}` }); }
  }, [operator, pushScan, refresh]);

  // react to NFC scans: select asset, fly camera, radar pulse, open cutaway
  useEffect(() => {
    if (!scan) return;
    const f = scan.fly_to;
    setSelected(scan.drain.drain_id);
    setFly({ lat: f.latitude, lon: f.longitude, zoom: f.zoom, pitch: f.pitch, bearing: f.bearing, n: ++n.current });
    setPulse({ lat: f.latitude, lon: f.longitude, n: n.current });
    setCutaway(scan.drain.drain_id);
    setNotice({ kind: "info", text: `${scan.source === "HARDWARE" ? "NFC hardware tap" : "Simulated tap"}: ${scan.drain.drain_id} ${scan.drain.name}` });
  }, [scan]);

  const focusDrain = useCallback((id: string) => {
    setSelected(id);
    const d = state?.predictions.drains[id];
    if (d) setFly({ lat: d.lat, lon: d.lon, zoom: 16.5, pitch: 55, bearing: 20, n: ++n.current });
  }, [state]);

  const area = (state?.area ?? "bhubaneswar") as AreaKey;
  const hardwareSeen = !!state?.nfc_recent.some((e) => e.source === "HARDWARE" && e.accepted);
  const cutDrain = cutaway && state ? state.predictions.drains[cutaway] : null;
  const back = onBack ?? (() => window.location.assign("/"));

  return (
    <div className="cc-root min-h-screen" data-theme={theme}>
      <style>{STYLES}</style>
      <a href="#cc-main" className="cc-focus sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[100] focus:rounded-lg focus:px-4 focus:py-2" style={{ background: "var(--gold)", color: "#fff" }}>Skip to main content</a>

      {/* Government status bar */}
      <header className="cc-bar sticky top-0 z-50">
        <div style={{ height: 4, background: "linear-gradient(90deg,var(--gold),var(--accent))" }} aria-hidden />
        <div className="mx-auto flex max-w-[1800px] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2">
          <div className="flex items-center gap-3">
            <div className="grid size-10 place-items-center rounded-full" style={{ border: "2px solid var(--gold)" }} title="Official emblem placeholder (use the authorised emblem only with permission)"><Landmark className="size-5" style={{ color: "var(--gold-text)" }} aria-hidden /><span className="sr-only">Official emblem placeholder</span></div>
            <div className="leading-tight"><div className="text-[11px] font-bold uppercase tracking-widest" style={{ color: "var(--gold-text)" }}>Government of Odisha | Prototype</div><div className="text-base font-extrabold">{BRAND} Command Centre</div></div>
          </div>
          <div role="group" aria-label="Study area" className="flex overflow-hidden rounded-lg" style={{ border: "1px solid var(--line)" }}>
            {(Object.keys(AREAS) as AreaKey[]).map((k) => (
              <button key={k} aria-pressed={area === k} className="cc-focus px-3 py-1.5 text-xs font-semibold" style={{ background: area === k ? "var(--accent)" : "var(--panel2)", color: area === k ? (theme === "dark" ? "#04121f" : "#fff") : "var(--text)" }}
                onClick={() => { if (k !== area) setNotice({ kind: "info", text: `The backend is serving ${AREAS[area]}. To switch: run "python backend/simulate_and_train.py --area ${k}" and restart uvicorn.` }); }}>{AREAS[k]}</button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-1.5" aria-label="Data provenance">
            <Chip c="#D97706" title="Road and drain geometry is a synthetic grid; DR-01..05 and hospital gateways are pinned to landmark coordinates">SYNTHETIC GRID, REAL LANDMARKS</Chip>
            <Chip c="#D97706">SIMULATED TELEMETRY</Chip>
            <Chip c={hardwareSeen ? "#16A34A" : "#64748B"} title="Turns green once a signed hardware tap has been logged">{hardwareSeen ? "NFC HARDWARE: LIVE TAPS LOGGED" : "NFC HARDWARE: AWAITING TAP"}</Chip>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-3">
            <Clock />
            <Chip c={conn === "live" ? "#16A34A" : conn === "connecting" ? "#CA8A04" : "#DC2626"}>{conn === "live" ? "API LIVE" : conn === "connecting" ? "CONNECTING" : "API OFFLINE"}</Chip>
            <button onClick={toggleTheme} className="cc-btn cc-focus" aria-pressed={theme === "light"} aria-label={`Switch to ${theme === "dark" ? "GIGW daylight" : "night operations"} theme`}>{theme === "dark" ? <Sun className="size-4" aria-hidden /> : <Moon className="size-4" aria-hidden />}{theme === "dark" ? "GIGW Daylight" : "ICCC Night Ops"}</button>
            <button onClick={back} className="cc-btn cc-focus"><ArrowLeft className="size-4" aria-hidden /> Back to Showcase Homepage</button>
          </div>
        </div>
      </header>

      <main id="cc-main" className="mx-auto max-w-[1800px] p-3 sm:p-4">
        <div role="status" aria-live="polite" className="mb-3 min-h-0">
          <AnimatePresence>
            {notice && (
              <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="cc-panel flex items-center justify-between gap-3 px-4 py-2" style={{ borderTopColor: notice.kind === "error" ? "#DC2626" : "var(--accent)" }}>
                <span className="text-sm font-medium">{notice.text}</span>
                <button className="cc-btn cc-focus" onClick={() => setNotice(null)} aria-label="Dismiss message"><X className="size-4" aria-hidden /></button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {!state ? (
          <div className="cc-panel mx-auto mt-10 max-w-xl p-6 text-center">
            <Activity className="mx-auto mb-2 size-8" style={{ color: "var(--accent)" }} aria-hidden />
            <h1 className="text-lg font-bold">{conn === "offline" ? "Command API not reachable" : "Loading command data..."}</h1>
            <p className="mt-2 text-sm" style={{ color: "var(--muted)" }}>Start the backend: <code>python backend/simulate_and_train.py</code> once, then <code>uvicorn backend.main:app --port 8000</code>. Expected at {API}.</p>
            <button className="cc-btn cc-btn-primary cc-focus mt-4" onClick={() => void refresh()}>Retry</button>
          </div>
        ) : (
          <div className="grid gap-3 sm:gap-4 xl:grid-cols-12">
            <div className="space-y-3 sm:space-y-4 xl:col-span-3"><Module1 s={state} run={(b) => void run(b)} busy={busy} /><Module5 s={state} conn={conn} unknownUid={unknownUid} onTap={(id) => void tap(id)} /></div>
            <div className="space-y-3 sm:space-y-4 xl:col-span-6">
              <Module2 s={state} selected={selected} onSelect={focusDrain} onTap={(id) => void tap(id)} onCutaway={() => selected && setCutaway(selected)} show={show} setShow={setShow}
                map={<GisMap state={state} selected={selected} onSelect={focusDrain} fly={fly} pulse={pulse} theme={theme} show={show} reduce={reduce} />} />
              <Module3 s={state} selected={selected} />
            </div>
            <div className="space-y-3 sm:space-y-4 xl:col-span-3"><Module4 s={state} operator={operator} setOperator={setOp} decide={decide} onFocus={focusDrain} /><Module6 s={state} /></div>
          </div>
        )}
      </main>
      <footer className="px-4 py-6 text-center text-xs" style={{ color: "var(--muted)" }}><MapPin className="mr-1 inline size-3" aria-hidden />Prototype for demonstration. Telemetry is simulated; not an operational flood-warning system. Map tiles: OpenStreetMap contributors.</footer>
      <AnimatePresence>{cutDrain && <CutawayDialog key={cutDrain.drain_id} drain={cutDrain} onClose={() => setCutaway(null)} reduce={reduce} />}</AnimatePresence>
    </div>
  );
}
