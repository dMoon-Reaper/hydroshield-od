/**
 * src/pages/LandingShowcase.tsx  -  Tier-1 showcase homepage
 * ----------------------------------------------------------
 * Deps: react, framer-motion, three, @react-three/fiber, lucide-react, tailwindcss
 *
 * Usage with react-router:
 *   <Route path="/" element={<LandingShowcase onLaunch={() => navigate("/command-center")} />} />
 * Without a router it falls back to window.location.assign("/command-center").
 *
 * Optional assets:  public/media/hero-monsoon.mp4  (hero loop; the page works without it)
 *                   public/evidence/*.jpg          (add to EVIDENCE below)
 * Optional env:     VITE_API_BASE=http://127.0.0.1:8000
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as RPointerEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  AnimatePresence, animate, motion, useInView, useMotionTemplate, useMotionValue,
  useReducedMotion, useSpring, useTransform,
} from "framer-motion";
import { Canvas, useFrame } from "@react-three/fiber";
import type * as THREE from "three";
import {
  AlertTriangle, ArrowRight, Archive, Building2, CalendarCheck, Check, ChevronDown, ClipboardList,
  Download, FileText, FlaskConical, GraduationCap, Lightbulb, MessageSquare, Moon, Network, Package,
  Printer, Radio, Rocket, Sun, Volume2, VolumeX, X, Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

/* ------------------------------------------------------------------ */
/* Configuration - edit here                                          */
/* ------------------------------------------------------------------ */
export const BRAND_NAME = "HydroShield OD";
export const BRAND_SUBTITLE = "Predicting Impact. Protecting Lifelines. | Odisha Urban Flood Intelligence & Command Portal";
const API_BASE: string = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_API_BASE ?? "http://127.0.0.1:8000";
const HERO_VIDEO_SRC = "/media/hero-monsoon.mp4";

const TEAM = [ // replace with real names
  { name: "Member 1", role: "GIS extraction, storm simulator & Random Forest ML", files: "backend/simulate_and_train.py" },
  { name: "Member 2", role: "FastAPI backend, NetworkX graph engine & USB NFC bridge", files: "backend/main.py, backend/nfc_bridge.py" },
  { name: "Member 3", role: "Video homepage, 14-card showcase, 3D government dashboard & testing", files: "src/pages/*" },
];
const EVIDENCE: { src: string; caption: string }[] = []; // e.g. { src: "/evidence/build-day2.jpg", caption: "Day 2: model training" }

// Reference run (seed 42, Bhubaneswar) used only while the backend is offline. Live values replace it.
const FALLBACK_METRICS = { rf: 0.946, baseline: 0.411, testScenarios: 12 };

const TAGS = {
  bhubaneswar: [
    ["DR-01", "ISKCON Temple NH-16 Box Culvert", "20.2961, 85.8245"],
    ["DR-02", "CRP Square Main Junction Inlet", "20.2915, 85.8168"],
    ["DR-03", "Behera Sahi / VIP Colony Low-Point Drain", "20.2982, 85.8260"],
    ["DR-04", "Jayadev Vihar Hospital Connector Grate", "20.2998, 85.8285"],
    ["DR-05", "Drainage Channel No. 4 Outfall", "20.2930, 85.8305"],
  ],
  cuttack: [
    ["DR-01", "Badambadi Bus Terminal Main Culvert", "20.4625, 85.8792"],
    ["DR-02", "SCB Medical Road / Mangalabag Drain Inlet", "20.4710, 85.8865"],
    ["DR-03", "Pithapur / Dolamundai Junction Conduit", "20.4652, 85.8810"],
    ["DR-04", "Chhatra Bazar MSWC-1 Open Channel Bridge", "20.4605, 85.8895"],
    ["DR-05", "Matamath Sluice Gate & Pump House Forebay", "20.4535, 85.8760"],
  ],
} as const;

/* ------------------------------------------------------------------ */
/* Types + backend hook                                               */
/* ------------------------------------------------------------------ */
interface Synopsis {
  generated_at: string;
  area: string;
  graphs: { road_nodes: number; road_edges: number; drain_nodes: number; conduits: number };
  model: { macro_f1: number; baseline_macro_f1: number; group_kfold_macro_f1_mean: number; test_scenarios: number; split: string; caveat: string };
  log_counts: Record<string, number>;
  audit_chain: { valid: boolean; entries: number };
  nfc_tags_enrolled: number;
}
type Theme = "dark" | "light";

function useSynopsis() {
  const [data, setData] = useState<Synopsis | null>(null);
  const [status, setStatus] = useState<"loading" | "online" | "offline">("loading");
  const load = useCallback(() => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 3000);
    fetch(`${API_BASE}/api/synopsis/metadata`, { signal: ctl.signal })
      .then((r) => (r.ok ? (r.json() as Promise<Synopsis>) : Promise.reject(new Error(String(r.status)))))
      .then((j) => { setData(j); setStatus("online"); })
      .catch(() => { setData(null); setStatus("offline"); })
      .finally(() => clearTimeout(timer));
    return () => { clearTimeout(timer); ctl.abort(); };
  }, []);
  useEffect(() => load(), [load]);
  return { data, status, reload: load };
}

function downloadJson(name: string, obj: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}

/* ------------------------------------------------------------------ */
/* Styles (CSS variables = dual-tone theme, 400 ms switch)            */
/* ------------------------------------------------------------------ */
const STYLES = `
.jd-root{--bg:#050B14;--panel:#0F172A;--panel2:#16233B;--text:#E6EEF8;--muted:#9FB0C6;--accent:#38BDF8;--accent2:#F59E0B;--line:rgba(56,189,248,.35);--grid:#38BDF8;
  background:var(--bg);color:var(--text);transition:background-color .4s ease,color .4s ease}
.jd-root[data-theme="light"]{--bg:#F8FAFC;--panel:#FFFFFF;--panel2:#EEF2F7;--text:#0F172A;--muted:#475569;--accent:#1E3A8A;--accent2:#B45309;--line:#CBD5E1;--grid:#1E3A8A}
.jd-root *{transition-property:background-color,border-color,color,box-shadow;transition-duration:.4s}
.jd-glass{background:color-mix(in srgb,var(--panel) 72%,transparent);backdrop-filter:blur(16px) saturate(140%);-webkit-backdrop-filter:blur(16px) saturate(140%);border:1px solid var(--line)}
.jd-panel{background:var(--panel);border:1px solid var(--line)}
.jd-focus:focus-visible{outline:3px solid var(--accent2);outline-offset:2px}
.jd-cta{background:linear-gradient(135deg,var(--accent),color-mix(in srgb,var(--accent) 55%,#7c3aed));color:#fff;box-shadow:0 0 0 1px var(--line),0 10px 40px -8px var(--accent);animation:jd-glow 2.8s ease-in-out infinite}
.jd-root[data-theme="light"] .jd-cta{color:#fff}
@keyframes jd-glow{0%,100%{box-shadow:0 0 0 1px var(--line),0 10px 36px -10px var(--accent)}50%{box-shadow:0 0 0 1px var(--line),0 14px 60px -4px var(--accent)}}
.jd-fallback-grid{background-image:linear-gradient(var(--line) 1px,transparent 1px),linear-gradient(90deg,var(--line) 1px,transparent 1px);background-size:56px 56px;mask-image:radial-gradient(ellipse at 50% 60%,#000 20%,transparent 75%);-webkit-mask-image:radial-gradient(ellipse at 50% 60%,#000 20%,transparent 75%);animation:jd-pan 18s linear infinite}
@keyframes jd-pan{to{background-position:56px 56px,56px 56px}}
.jd-chip{background:color-mix(in srgb,var(--c) 16%,transparent);border:1px solid color-mix(in srgb,var(--c) 45%,transparent)}
.print-only{display:none;--text:#000;--muted:#333;--panel:#fff;--panel2:#f1f1f1;--line:#999;--accent:#000;--accent2:#000}
@media print{#root{display:none!important}.print-only{display:block!important;color:#000;background:#fff;padding:20px;font-family:system-ui,sans-serif}}
@media (prefers-reduced-motion:reduce){.jd-cta,.jd-fallback-grid{animation:none}.jd-root *{transition-duration:.01ms!important}}
`;

/* ------------------------------------------------------------------ */
/* 3D hydro-grid (offline-safe WebGL)                                 */
/* ------------------------------------------------------------------ */
const NODE_POS: [number, number, number][] = [[-3.4, 0.25, -1.2], [-1.3, 0.25, 1.4], [1.5, 0.25, -0.6], [3.3, 0.25, 1.5], [0.1, 0.25, -2.8]];

function WaterGrid({ line, node, animateIt }: { line: string; node: string; animateIt: boolean }) {
  const geo = useRef<THREE.PlaneGeometry>(null);
  const dots = useRef<THREE.Group>(null);
  useFrame((state) => {
    if (!animateIt) return;
    const t = state.clock.elapsedTime;
    const g = geo.current;
    if (g) {
      const pos = g.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), y = pos.getY(i);
        pos.setZ(i, Math.sin(x * 0.9 + t * 1.1) * 0.18 + Math.cos(y * 0.7 + t * 0.8) * 0.18 + Math.sin((x + y) * 0.4 + t * 0.5) * 0.12);
      }
      pos.needsUpdate = true;
    }
    dots.current?.children.forEach((c, i) => c.scale.setScalar(1 + 0.35 * Math.sin(t * 2.2 + i * 1.3)));
    state.camera.position.x += (state.pointer.x * 1.2 - state.camera.position.x) * 0.04;
    state.camera.lookAt(0, 0, 0);
  });
  return (
    <group rotation={[-Math.PI / 2.35, 0, 0]} position={[0, -0.9, 0]}>
      <mesh>
        <planeGeometry ref={geo} args={[16, 12, 56, 42]} />
        <meshBasicMaterial wireframe color={line} transparent opacity={0.5} />
      </mesh>
      <group ref={dots}>
        {NODE_POS.map((p, i) => (
          <mesh key={i} position={[p[0], p[2], p[1]]}>
            <sphereGeometry args={[0.13, 16, 16]} />
            <meshBasicMaterial color={node} />
          </mesh>
        ))}
      </group>
    </group>
  );
}

function hasWebGL(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch { return false; }
}

/* ------------------------------------------------------------------ */
/* Small UI pieces                                                    */
/* ------------------------------------------------------------------ */
function Counter({ to, prefix = "", suffix = "", label, reduce }: { to: number; prefix?: string; suffix?: string; label: string; reduce: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true });
  const [v, setV] = useState(0);
  useEffect(() => {
    if (!inView) return;
    if (reduce) { setV(to); return; }
    const c = animate(0, to, { duration: 1.6, ease: "easeOut", onUpdate: (x) => setV(Math.round(x)) });
    return () => c.stop();
  }, [inView, to, reduce]);
  return (
    <div ref={ref} className="jd-glass rounded-2xl px-5 py-4 text-center min-w-[170px]">
      <div className="text-4xl font-bold tabular-nums" style={{ color: "var(--accent2)" }}>{prefix}{v}{suffix}</div>
      <div className="mt-1 text-sm font-medium" style={{ color: "var(--muted)" }}>{label}</div>
    </div>
  );
}

function MagneticCTA({ onClick, reduce }: { onClick: () => void; reduce: boolean }) {
  const ref = useRef<HTMLButtonElement>(null);
  const x = useMotionValue(0), y = useMotionValue(0);
  const sx = useSpring(x, { stiffness: 260, damping: 20 }), sy = useSpring(y, { stiffness: 260, damping: 20 });
  const move = (e: RPointerEvent<HTMLButtonElement>) => {
    if (reduce || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    x.set((e.clientX - (r.left + r.width / 2)) * 0.25);
    y.set((e.clientY - (r.top + r.height / 2)) * 0.35);
  };
  const leave = () => { x.set(0); y.set(0); };
  return (
    <motion.button
      ref={ref} onPointerMove={move} onPointerLeave={leave} onClick={onClick}
      style={{ x: sx, y: sy }} whileHover={reduce ? undefined : { scale: 1.05 }} whileTap={{ scale: 0.97 }}
      className="jd-cta jd-focus inline-flex items-center gap-3 rounded-full px-8 py-4 text-base sm:text-lg font-bold tracking-wide"
    >
      LAUNCH GOVERNMENT COMMAND SYSTEM <ArrowRight className="size-5" aria-hidden />
    </motion.button>
  );
}

function TiltCard({ children, reduce }: { children: ReactNode; reduce: boolean }) {
  const px = useMotionValue(0), py = useMotionValue(0);
  const rx = useSpring(useTransform(py, [-0.5, 0.5], [8, -8]), { stiffness: 260, damping: 20 });
  const ry = useSpring(useTransform(px, [-0.5, 0.5], [-8, 8]), { stiffness: 260, damping: 20 });
  const gx = useTransform(px, [-0.5, 0.5], [0, 100]), gy = useTransform(py, [-0.5, 0.5], [0, 100]);
  const glare = useMotionTemplate`radial-gradient(circle at ${gx}% ${gy}%, color-mix(in srgb, var(--accent) 22%, transparent), transparent 55%)`;
  const onMove = (e: RPointerEvent<HTMLDivElement>) => {
    if (reduce || e.pointerType !== "mouse") return;
    const r = e.currentTarget.getBoundingClientRect();
    px.set((e.clientX - r.left) / r.width - 0.5);
    py.set((e.clientY - r.top) / r.height - 0.5);
  };
  const onLeave = () => { px.set(0); py.set(0); };
  return (
    <motion.div
      onPointerMove={onMove} onPointerLeave={onLeave}
      style={{ rotateX: rx, rotateY: ry, transformPerspective: 900, transformStyle: "preserve-3d" }}
      className="relative h-full rounded-3xl"
    >
      {children}
      {!reduce && <motion.div aria-hidden className="pointer-events-none absolute inset-0 rounded-3xl opacity-0 hover:opacity-100" style={{ background: glare }} />}
    </motion.div>
  );
}

const H = ({ children }: { children: ReactNode }) => (
  <h4 className="mt-6 mb-2 text-xs font-bold uppercase tracking-[0.14em]" style={{ color: "var(--accent2)" }}>{children}</h4>
);
const P = ({ children }: { children: ReactNode }) => <p className="leading-relaxed">{children}</p>;
const UL = ({ items }: { items: ReactNode[] }) => (
  <ul className="list-disc space-y-2 pl-5 leading-relaxed">{items.map((t, i) => <li key={i}>{t}</li>)}</ul>
);
const Chip = ({ children, c = "var(--accent)" }: { children: ReactNode; c?: string }) => (
  <span className="jd-chip inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold" style={{ ["--c" as string]: c }}>{children}</span>
);
const Note = ({ children }: { children: ReactNode }) => (
  <div className="mt-4 rounded-xl p-3 text-sm" style={{ background: "var(--panel2)", border: "1px dashed var(--line)", color: "var(--muted)" }}>{children}</div>
);

/* ------------------------------------------------------------------ */
/* Card detail content                                                */
/* ------------------------------------------------------------------ */
interface Ctx { synopsis: Synopsis | null; status: "loading" | "online" | "offline"; reload: () => void; onPrint: () => void }

function BomTable() {
  const rows = [
    ["13.56 MHz PC/SC USB NFC reader (ACS ACR1552U or compatible)", 3200],
    ["5 x NXP NTAG213 passive NFC stickers", 150],
    ["High-resolution laminated 2D GIS map board (A2)", 250],
    ["Laptop (i3, 16 GB RAM) and open-source software", 0],
  ] as const;
  const total = rows.reduce((s, r) => s + r[1], 0);
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">Bill of materials</caption>
        <thead><tr style={{ color: "var(--muted)" }}><th scope="col" className="py-2 text-left">Item</th><th scope="col" className="py-2 text-right">Cost</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r[0]} style={{ borderTop: "1px solid var(--line)" }}><td className="py-2 pr-4">{r[0]}</td><td className="py-2 text-right tabular-nums">{r[1] ? `₹${r[1].toLocaleString("en-IN")}` : "₹0"}</td></tr>
          ))}
          <tr style={{ borderTop: "2px solid var(--accent)" }} className="font-bold"><td className="py-2">Total</td><td className="py-2 text-right tabular-nums">₹{total.toLocaleString("en-IN")}</td></tr>
        </tbody>
      </table>
    </div>
  );
}

const ARCH = [
  { id: "ui", label: "React + TypeScript + Tailwind", sub: "Framer Motion, Deck.gl, R3F", text: "Tier-1 showcase and Tier-2 command centre. Receives live events over the WebSocket and flies the 3D camera to a scanned tag." },
  { id: "api", label: "FastAPI + Uvicorn", sub: "REST and WebSockets", text: "Single API for state, scenario controls, signed NFC scans, operator decisions and log exports." },
  { id: "ai", label: "scikit-learn + NetworkX", sub: "Severity model and consequence engine", text: "Random Forest gives P(severe or critical) per road segment. NetworkX closes or penalises flooded segments and measures the ambulance detour to hospitals." },
  { id: "db", label: "SQLite3", sub: "Append-only, hash-chained audit log", text: "Tables: assets, nfc_events, work_orders, audit_log. Triggers block UPDATE and DELETE on the logs, and a hash chain makes tampering detectable." },
  { id: "nfc", label: "nfc_bridge.py", sub: "PC/SC USB reader, HMAC-SHA256 signed", text: "Reads the tag UID from the USB reader and posts it with an X-Signature header, a timestamp and a one-time nonce." },
];

function ArchDiagram() {
  const [active, setActive] = useState("ui");
  const cur = ARCH.find((a) => a.id === active)!;
  return (
    <div>
      <div role="tablist" aria-label="Architecture layers" className="flex flex-wrap items-center gap-2">
        {ARCH.map((a, i) => (
          <div key={a.id} className="flex items-center gap-2">
            <button role="tab" aria-selected={active === a.id} onClick={() => setActive(a.id)}
              className="jd-focus rounded-xl px-3 py-2 text-left text-sm"
              style={{ background: active === a.id ? "var(--accent)" : "var(--panel2)", color: active === a.id ? "#fff" : "var(--text)", border: "1px solid var(--line)" }}>
              <span className="block font-semibold">{a.label}</span><span className="block text-xs opacity-80">{a.sub}</span>
            </button>
            {i < ARCH.length - 1 && <ArrowRight className="size-4 shrink-0" style={{ color: "var(--muted)" }} aria-hidden />}
          </div>
        ))}
      </div>
      <div role="tabpanel" className="mt-3 rounded-xl p-4 text-sm leading-relaxed" style={{ background: "var(--panel2)", border: "1px solid var(--line)" }}>{cur.text}</div>
      <H>Dual-graph coupling</H>
      <P>Drainage nodes (Gd) pass overflow to linked road segments (Gr) through an inspectable <code>link_table.csv</code>. A segment is closed when P(severe+) is at least 0.60 and slowed 3x when it is at least 0.30.</P>
      <H>Consequence score</H>
      <code className="block overflow-x-auto rounded-lg p-3 text-xs" style={{ background: "var(--panel2)" }}>
        Impact(e) = P(severe_or_critical) x (0.30 criticality + 0.30 detour_penalty + 0.25 critical_assets_affected + 0.15 exposure_proxy)
      </code>
    </div>
  );
}

function F1Bars({ rf, base, live, tests }: { rf: number; base: number; live: boolean; tests: number }) {
  const rows = [{ k: "Random Forest", v: rf, c: "var(--accent)" }, { k: "Rainfall-threshold baseline", v: base, c: "var(--accent2)" }];
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2"><Chip c={live ? "#047857" : "#B45309"}>{live ? "LIVE from backend" : "Reference run (backend offline)"}</Chip><Chip>{tests} held-out scenarios</Chip></div>
      {rows.map((r) => (
        <div key={r.k} className="mb-3">
          <div className="mb-1 flex justify-between text-sm"><span>{r.k}</span><span className="font-bold tabular-nums">{r.v.toFixed(3)}</span></div>
          <div className="h-4 w-full overflow-hidden rounded-full" style={{ background: "var(--panel2)" }} role="img" aria-label={`${r.k} macro F1 ${r.v.toFixed(3)}`}>
            <motion.div className="h-full rounded-full" style={{ background: r.c }} initial={{ width: 0 }} animate={{ width: `${Math.min(r.v, 1) * 100}%` }} transition={{ type: "spring", stiffness: 120, damping: 20 }} />
          </div>
        </div>
      ))}
      <div className="text-xs" style={{ color: "var(--muted)" }}>Metric: macro-F1 over Normal / Watch / Severe / Critical. Split strictly by scenario_id.</div>
    </div>
  );
}

function TagTable() {
  const [area, setArea] = useState<"bhubaneswar" | "cuttack">("bhubaneswar");
  return (
    <div>
      <div className="mb-3 flex gap-2" role="tablist" aria-label="Study area">
        {(["bhubaneswar", "cuttack"] as const).map((a) => (
          <button key={a} role="tab" aria-selected={area === a} onClick={() => setArea(a)} className="jd-focus rounded-full px-4 py-1.5 text-sm font-semibold capitalize"
            style={{ background: area === a ? "var(--accent)" : "var(--panel2)", color: area === a ? "#fff" : "var(--text)", border: "1px solid var(--line)" }}>{a}</button>
        ))}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">NTAG213 sticker positions</caption>
          <thead><tr style={{ color: "var(--muted)" }}><th scope="col" className="py-1 text-left">Tag</th><th scope="col" className="py-1 text-left">Asset</th><th scope="col" className="py-1 text-left">Lat, Lon</th></tr></thead>
          <tbody>{TAGS[area].map((t) => (
            <tr key={t[0]} style={{ borderTop: "1px solid var(--line)" }}><th scope="row" className="py-2 pr-3 text-left font-bold">{t[0]}</th><td className="py-2 pr-3">{t[1]}</td><td className="py-2 tabular-nums whitespace-nowrap">{t[2]}</td></tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}

function Stages() {
  const stages = [
    ["Stage 1 (current MVP)", "Synthetic grid anchored to real landmarks, simulated telemetry, ML and graph ranking, passive NFC verification."],
    ["Stage 2", "Calibrate with historical Bhuvan inundation layers and CMC / BMC drainage invert surveys."],
    ["Stage 3", "Ultrasonic or pressure water-level sensor bench pilot with solar energy harvesting."],
    ["Stage 4", "True battery-free ambient RF backscatter water-level tags."],
    ["Stage 5", "Shadow pilot with BMC / OSDMA alongside existing operations."],
    ["Stage 6", "Multi-tenant municipal SaaS."],
  ];
  return (
    <ol className="space-y-3">
      {stages.map((s, i) => (
        <li key={s[0]} className="flex gap-3">
          <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full text-xs font-bold text-white" style={{ background: i === 0 ? "#047857" : "var(--accent)" }}>{i === 0 ? <Check className="size-4" aria-hidden /> : i + 1}</span>
          <div><div className="font-semibold">{s[0]}</div><div style={{ color: "var(--muted)" }}>{s[1]}</div></div>
        </li>
      ))}
    </ol>
  );
}

function SynopsisBody({ synopsis }: { synopsis: Synopsis | null }) {
  const m = synopsis?.model;
  return (
    <div style={{ color: "var(--text)" }}>
      <h2 className="text-2xl font-bold">{BRAND_NAME} - Project Synopsis</h2>
      <div className="text-sm" style={{ color: "var(--muted)" }}>{BRAND_SUBTITLE}</div>
      <H>Purpose</H>
      <P>Turn fragmented rainfall, drainage and traffic data into an explainable, human-approved response queue that minimises emergency route disruption during urban floods.</P>
      <H>System</H>
      <UL items={[
        "Road graph Gr and drainage graph Gd (synthetic geometry anchored to real landmark coordinates), coupled by an inspectable link table.",
        "Seeded storm simulator and a Random Forest severity classifier, benchmarked against a rainfall-threshold rule.",
        "NetworkX consequence engine: ambulance detour time to the nearest hospital with flooded segments closed or penalised.",
        "Passive NTAG213 tags on a 2D printed map, read by a USB NFC reader with HMAC-signed events and an append-only audit log.",
      ]} />
      <H>Benchmark (simulation only)</H>
      {m ? (
        <UL items={[
          `Random Forest macro-F1 ${m.macro_f1.toFixed(3)} vs rainfall baseline ${m.baseline_macro_f1.toFixed(3)} on ${m.test_scenarios} held-out scenarios; 5-fold GroupKFold mean ${m.group_kfold_macro_f1_mean.toFixed(3)}.`,
          m.caveat,
        ]} />
      ) : (
        <P>Backend offline: start the API to include live benchmark figures. Reference run: RF {FALLBACK_METRICS.rf.toFixed(3)} vs baseline {FALLBACK_METRICS.baseline.toFixed(3)}.</P>
      )}
      <H>Audit trail</H>
      <P>{synopsis ? `${synopsis.audit_chain.entries} audit entries, hash chain ${synopsis.audit_chain.valid ? "valid" : "BROKEN"}; ${synopsis.nfc_tags_enrolled} of 5 tags enrolled.` : "Not available while the backend is offline."}</P>
      <H>Team</H>
      <UL items={TEAM.map((t) => `${t.name}: ${t.role}`)} />
      <p className="mt-6 text-xs" style={{ color: "var(--muted)" }}>Prototype. Telemetry is simulated; not an operational warning system. Generated {synopsis?.generated_at ?? new Date().toISOString()}.</p>
    </div>
  );
}

function DocsHub({ synopsis, status, reload, onPrint }: Ctx) {
  const btn = "jd-focus inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold";
  const style = { background: "var(--accent)", color: "#fff" } as const;
  const csv = (t: string) => `${API_BASE}/api/logs/export-csv?table=${t}`;
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <Chip c={status === "online" ? "#047857" : status === "loading" ? "#B45309" : "#BE123C"}>{status === "online" ? "Backend online" : status === "loading" ? "Connecting..." : "Backend offline"}</Chip>
        {status === "offline" && <button onClick={reload} className="jd-focus text-sm underline">Retry</button>}
      </div>
      <H>Project synopsis</H>
      <div className="flex flex-wrap gap-2">
        <button className={btn} style={style} onClick={onPrint}><Printer className="size-4" aria-hidden /> View / print synopsis (PDF)</button>
        <button className={btn} style={style} onClick={() => synopsis && downloadJson("model_card.json", { brand: BRAND_NAME, generated_at: synopsis.generated_at, area: synopsis.area, graphs: synopsis.graphs, model: synopsis.model })} disabled={!synopsis} aria-disabled={!synopsis}>
          <FileText className="size-4" aria-hidden /> Model card JSON
        </button>
      </div>
      <H>Live SQLite log reports</H>
      <div className="flex flex-wrap gap-2">
        {([["audit_log", "Audit log"], ["nfc_events", "NFC events"], ["work_orders", "Work orders / approvals"]] as const).map(([t, l]) => (
          <a key={t} href={csv(t)} className={btn} style={style}><Download className="size-4" aria-hidden /> {l} CSV{synopsis ? ` (${synopsis.log_counts[t] ?? 0})` : ""}</a>
        ))}
      </div>
      <H>Evidence gallery</H>
      {EVIDENCE.length ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">{EVIDENCE.map((e) => (
          <figure key={e.src}><img src={e.src} alt={e.caption} loading="lazy" className="aspect-video w-full rounded-lg object-cover" /><figcaption className="mt-1 text-xs" style={{ color: "var(--muted)" }}>{e.caption}</figcaption></figure>
        ))}</div>
      ) : <Note>Add team photos and build-log screenshots to public/evidence and list them in the EVIDENCE array at the top of this file.</Note>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The 14 cards                                                       */
/* ------------------------------------------------------------------ */
interface CardDef {
  n: number; title: string; ref: string; icon: LucideIcon; color: string; span: string;
  summary: string; chips: string[]; detail: (c: Ctx) => ReactNode;
}

const CARDS: CardDef[] = [
  {
    n: 1, title: "The Problem Statement", ref: "Framework A.1", icon: AlertTriangle, color: "#BE123C", span: "lg:col-span-2",
    summary: "Cloudbursts flood Bhubaneswar and Cuttack within 30-45 minutes, yet dashboards cannot say which culvert, which road or which crew matters most.",
    chips: ["NH-16 Channel No. 4", "Cuttack saucer basin"],
    detail: () => (<>
      <H>Bhubaneswar: Nayapalli / ISKCON NH-16 and Drainage Channel No. 4</H>
      <P>The ground falls from the Chandaka / Baramunda ridge (about 45 m) to the Nayapalli valley floor (about 18 m) before draining to the Gangua Nallah through BMC Channels No. 4 and No. 10. Concrete has replaced natural retention ponds, and the raised NH-16 corridor acts as an artificial dam. When rain exceeds 60 mm/hr and silt or waste blocks the box culverts near ISKCON Temple and CRP Square, water can reach 1.2-1.8 m on the service road, cutting ambulance access towards the KIMS, AIIMS and Capital Hospital corridors.</P>
      <H>Cuttack: Badambadi / Matamath / MSWC-1</H>
      <P>The city sits between the Mahanadi and Kathajodi inside ring embankments, a saucer lower than flood-stage river levels. Stormwater must reach Main Storm Water Channel No. 1 and be pumped out at the Matamath and Khanannagar stations. Plastic debris at Badambadi or Meria Bazar, or sluice gates closed against a high Kathajodi, send backwater onto the roads to SCB Medical College & Hospital.</P>
      <H>Three questions existing dashboards cannot answer</H>
      <UL items={["Which specific choked culvert is causing the backwater?", "Which downstream road closure will cut ambulance access to critical hospitals?", "How do we verify a crew physically inspected and cleared a drain without theft-prone active sensors at every manhole?"]} />
      <Note>Site facts above come from the project report; cite a source (BMC / CMC / Bhuvan) next to them before the exhibition.</Note>
    </>),
  },
  {
    n: 2, title: "The Solution", ref: "Hybrid ML + dual graph + NFC", icon: Lightbulb, color: "#B45309", span: "lg:col-span-2",
    summary: "An energy-aware decision-support portal that ranks drains by consequence and proves field work with battery-free NFC tags.",
    chips: ["Random Forest", "Dual graph", "Passive NFC"],
    detail: () => (<>
      <P>The portal couples five pieces into one human-approved response queue:</P>
      <UL items={[
        "Road network and terrain context (the prototype uses a synthetic street grid anchored to real landmark coordinates; real OSM roads and Copernicus 30 m DEM are the planned upgrade).",
        "Simulated storm and blockage telemetry.",
        "A trained Random Forest severity classifier (Normal / Watch / Severe / Critical).",
        "A NetworkX dual-graph consequence engine that computes hospital detour penalties.",
        "Battery-free NTAG213 tags on a 2D basin map for tamper-evident asset identification and closed-loop work-order verification.",
      ]} />
    </>),
  },
  {
    n: 3, title: "Project Title and Purpose", ref: "Framework A.1 | Layout B.1/B.2", icon: FileText, color: "#1D4ED8", span: "lg:col-span-2",
    summary: `${BRAND_NAME}: Energy-Aware Urban Flood Intelligence & Infrastructure Response System.`,
    chips: ["Explainable", "Human-approved"],
    detail: () => (<>
      <H>Title</H><P>{BRAND_NAME}: Energy-Aware Urban Flood Intelligence & Infrastructure Response System.</P>
      <H>Purpose</H><P>To transform fragmented rainfall, drainage and traffic data into an explainable, human-approved response queue that minimises emergency route disruption during urban floods.</P>
    </>),
  },
  {
    n: 4, title: "Skills Developed", ref: "Framework A.2 | Layout B.3", icon: GraduationCap, color: "#6D28D9", span: "lg:col-span-1",
    summary: "AI, graph theory, 3D WebGL and hardware IoT.", chips: ["4 skill areas"],
    detail: () => (<UL items={[
      <><b>AI and data science:</b> supervised tabular ML (scikit-learn), scenario-split validation to prevent leakage, macro-F1 benchmarking.</>,
      <><b>Graph theory and operations research:</b> dual-graph topology (Gd drainage, Gr roads), shortest-path detour optimisation (NetworkX), crew prioritisation.</>,
      <><b>Government UI/UX and 3D WebGL:</b> high-contrast dual-tone accessible design, 3D GIS (Deck.gl), micro-interactions (Framer Motion).</>,
      <><b>Hardware IoT and security:</b> 13.56 MHz PC/SC USB NFC interfacing, passive RF energy-harvesting principles, HMAC-SHA256 request signing.</>,
    ]} />),
  },
  {
    n: 5, title: "Planning and Design", ref: "Framework A.3 | Layout B.4", icon: ClipboardList, color: "#047857", span: "lg:col-span-1",
    summary: "Materials, roles and a total build cost of about ₹3,600.", chips: ["₹3,600 BOM", "3 roles"],
    detail: () => (<><H>Materials and cost</H><BomTable /><H>Division of responsibilities</H>
      <UL items={TEAM.map((t) => <><b>{t.name}:</b> {t.role}</>)} /></>),
  },
  {
    n: 6, title: "Software and Tech Design", ref: "Architecture blueprint", icon: Network, color: "#0369A1", span: "lg:col-span-2",
    summary: "Decoupled full stack: React, FastAPI, scikit-learn and NetworkX, SQLite audit log, USB NFC bridge.", chips: ["Interactive diagram"],
    detail: () => <ArchDiagram />,
  },
  {
    n: 7, title: "Process of Creation", ref: "Framework A.4 | Layout B.5", icon: CalendarCheck, color: "#BE123C", span: "lg:col-span-2",
    summary: "A five-day sprint from simulator to NFC-triggered command centre.", chips: ["5-day sprint", "3 contributors"],
    detail: () => (<>
      <ol className="space-y-3">{[
        ["Day 1", "Built the road and drainage graphs and the seeded storm / blockage simulator."],
        ["Day 2", "Trained the Random Forest (split by scenario_id) and built the NetworkX hospital-detour consequence ranker in FastAPI."],
        ["Day 3", "Built the video-hero homepage with 14 interactive cards and the dual-tone 3D command dashboard."],
        ["Day 4", "Integrated the 2D printed map with 5 NTAG213 tags and the HMAC-signed USB NFC bridge."],
        ["Day 5", "Ran ML vs rule-baseline testing and prepared the exhibition layout."],
      ].map((d) => (<li key={d[0]} className="flex gap-3"><span className="w-14 shrink-0 font-bold" style={{ color: "var(--accent2)" }}>{d[0]}</span><span>{d[1]}</span></li>))}</ol>
      <H>Individual contributions</H><UL items={TEAM.map((t) => <><b>{t.name}:</b> {t.role} <span style={{ color: "var(--muted)" }}>({t.files})</span></>)} />
    </>),
  },
  {
    n: 8, title: "Final Product and Demonstration", ref: "Framework A.5 | Layout B.6", icon: Package, color: "#B45309", span: "lg:col-span-2",
    summary: "A printed 2D basin map with 5 NTAG213 stickers. Tap one and the command centre flies to it, scores severity and shows the hospital detour.", chips: ["2D map", "5 NTAG213", "USB reader"],
    detail: () => (<>
      <P>A two-tier web portal (this showcase plus the government command centre) synchronised with a physical 2D printed map. Tapping a tag triggers a 3D camera flight, AI severity inference, an ambulance-detour alert and the crew-dispatch workflow. A "Simulate NFC Tap" button is the fallback and is recorded as SIMULATED in the log.</P>
      <H>Tag positions</H><TagTable />
    </>),
  },
  {
    n: 9, title: "Testing and Improvement", ref: "Framework A.6", icon: FlaskConical, color: "#047857", span: "lg:col-span-1",
    summary: "Held-out scenario test: ML vs rainfall-threshold baseline.", chips: ["Macro-F1", "Live metrics"],
    detail: ({ synopsis }) => (<>
      <F1Bars rf={synopsis?.model.macro_f1 ?? FALLBACK_METRICS.rf} base={synopsis?.model.baseline_macro_f1 ?? FALLBACK_METRICS.baseline} live={!!synopsis} tests={synopsis?.model.test_scenarios ?? FALLBACK_METRICS.testScenarios} />
      <Note>These scores come from the simulator, which also generates the labels. They show the model recovers the simulated rule, not real-world forecast skill. The baseline cut-offs are tuned on the training scenarios so the comparison is fair.</Note>
      <H>Hardware improvement</H><P>A 3-second UID debounce (in both the bridge and the server) and a "Simulate NFC Tap" fallback keep demos reliable.</P>
      <H>Still to measure</H><P>Share of hospital-access disruptions captured in the top-3 work orders, graph-consequence ranking vs severity-only ranking. This evaluation has not been run yet.</P>
    </>),
  },
  {
    n: 10, title: "Real-World Application", ref: "Framework A.7", icon: Building2, color: "#1D4ED8", span: "lg:col-span-1",
    summary: "BMC, CMC, OSDMA and 108 ambulance routing.", chips: ["Municipal", "Emergency"],
    detail: () => (<UL items={[
      <><b>Municipal corporations (BMC Bhubaneswar, CMC Cuttack, Smart City ICCC):</b> prioritise JCB desilting teams and mobile dewatering pumps during monsoon warnings.</>,
      <><b>Emergency traffic and ambulance routing (108 grid):</b> reroute around submerged NH-16 underpasses and SCB Medical approach roads.</>,
      <><b>Auditable civic maintenance:</b> low-cost passive tags confirm contractors physically visited each culvert before a ticket closes.</>,
    ]} />),
  },
  {
    n: 11, title: "Learning Outcomes", ref: "Layout B.7", icon: GraduationCap, color: "#6D28D9", span: "lg:col-span-2",
    summary: "Scientific honesty in AI, hardware physics and systems thinking.", chips: ["3 outcomes"],
    detail: () => (<ol className="list-decimal space-y-3 pl-5 leading-relaxed">
      <li><b>Scientific honesty in AI:</b> telling simulation-trained models from field-calibrated hydrology, and preventing leakage with scenario-based train/test splits.</li>
      <li><b>Hardware physics:</b> the boundary between passive inductive NFC coupling (NTAG213, 13.56 MHz, about 5 cm range) and future ambient RF backscatter.</li>
      <li><b>Systems thinking:</b> infrastructure criticality depends on network topology (who gets cut off), not only local water depth.</li>
    </ol>),
  },
  {
    n: 12, title: "Feedback and Improvements", ref: "Layout B.8", icon: MessageSquare, color: "#0369A1", span: "lg:col-span-2",
    summary: "Three rounds of feedback, each turned into a concrete change.", chips: ["3 changes"],
    detail: () => (<ul className="space-y-4">{[
      ["A 3D physical model is bulky; use a clean 2D GIS map print.", "Built a high-resolution A2 2D map with embedded NTAG213 stickers."],
      ["Make the project self-explanatory on screen for visitors.", "Created this video-hero homepage with 14 interactive cards before the command centre."],
      ["What if a sensor sends corrupt or old data?", "Added a data-quality monitor that flags stale or out-of-range telemetry and lowers confidence scores."],
    ].map((f) => (<li key={f[0]} className="rounded-xl p-3" style={{ background: "var(--panel2)" }}><div style={{ color: "var(--muted)" }}>Feedback: {f[0]}</div><div className="mt-1 font-medium">Change: {f[1]}</div></li>))}</ul>),
  },
  {
    n: 13, title: "Scope for Further Development", ref: "Layout B.9", icon: Rocket, color: "#BE123C", span: "lg:col-span-2",
    summary: "Six stages from today's MVP towards ambient RF backscatter tags and a municipal pilot.", chips: ["6-stage roadmap"],
    detail: () => <Stages />,
  },
  {
    n: 14, title: "Documentation Hub", ref: "Framework A.8 | Layout B.10", icon: Archive, color: "#047857", span: "lg:col-span-2",
    summary: "Print the project synopsis and download live SQLite audit and NFC logs.", chips: ["Synopsis PDF", "Live CSV logs"],
    detail: (c) => <DocsHub {...c} />,
  },
];

function ShowcaseCard({ def, index, reduce, onOpen }: { def: CardDef; index: number; reduce: boolean; onOpen: () => void }) {
  const Icon = def.icon;
  return (
    <motion.div
      id={`card-${def.n}`} className={`${def.span} scroll-mt-24`}
      initial={reduce ? false : { opacity: 0, y: 36 }} whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.2 }} transition={{ type: "spring", stiffness: 260, damping: 20, delay: (index % 4) * 0.07 }}
    >
      <TiltCard reduce={reduce}>
        <article className="jd-panel flex h-full min-h-[250px] flex-col rounded-3xl p-6" aria-labelledby={`t-${def.n}`}>
          <div className="flex items-start justify-between gap-3">
            <motion.div layoutId={`tile-${def.n}`} className="grid size-12 place-items-center rounded-2xl text-white" style={{ background: def.color }}><Icon className="size-6" aria-hidden /></motion.div>
            <span className="text-right text-xs font-semibold" style={{ color: "var(--muted)" }}>{String(def.n).padStart(2, "0")} / 14<br />{def.ref}</span>
          </div>
          <h3 id={`t-${def.n}`} className="mt-4 text-xl font-bold">{def.title}</h3>
          <p className="mt-2 flex-1 leading-relaxed" style={{ color: "var(--muted)" }}>{def.summary}</p>
          <div className="mt-4 flex flex-wrap gap-2">{def.chips.map((c) => <Chip key={c} c={def.color === "#B45309" ? "#B45309" : def.color}>{c}</Chip>)}</div>
          <button onClick={onOpen} className="jd-focus mt-5 inline-flex w-fit items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold" style={{ background: "var(--panel2)", border: "1px solid var(--line)" }}>
            View Full Details <ArrowRight className="size-4" aria-hidden />
          </button>
        </article>
      </TiltCard>
    </motion.div>
  );
}

function Modal({ def, ctx, onClose }: { def: CardDef; ctx: Ctx; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const Icon = def.icon;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const lock = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { onClose(); return; }
      if (e.key !== "Tab" || !ref.current) return;
      const f = ref.current.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),[tabindex]:not([tabindex="-1"])');
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("keydown", key); document.body.style.overflow = lock; prev?.focus(); };
  }, [onClose]);
  return (
    <motion.div className="fixed inset-0 z-[80] grid place-items-center p-4" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} aria-hidden />
      <motion.div ref={ref} role="dialog" aria-modal="true" aria-labelledby="modal-title"
        className="jd-panel relative max-h-[88vh] w-full max-w-3xl overflow-y-auto rounded-3xl p-6 sm:p-8 shadow-2xl"
        initial={{ opacity: 0, y: 40, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 24, scale: 0.97 }}
        transition={{ type: "spring", stiffness: 260, damping: 20 }}>
        <div className="flex items-start gap-4">
          <motion.div layoutId={`tile-${def.n}`} className="grid size-12 shrink-0 place-items-center rounded-2xl text-white" style={{ background: def.color }}><Icon className="size-6" aria-hidden /></motion.div>
          <div className="flex-1"><div className="text-xs font-semibold" style={{ color: "var(--muted)" }}>{String(def.n).padStart(2, "0")} / 14 | {def.ref}</div><h2 id="modal-title" className="text-2xl font-bold">{def.title}</h2></div>
          <button ref={closeRef} onClick={onClose} aria-label="Close details" className="jd-focus rounded-full p-2" style={{ background: "var(--panel2)" }}><X className="size-5" aria-hidden /></button>
        </div>
        <div className="mt-4">{def.detail(ctx)}</div>
      </motion.div>
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                               */
/* ------------------------------------------------------------------ */
export default function LandingShowcase({ onLaunch }: { onLaunch?: () => void }) {
  const reduce = !!useReducedMotion();
  const [theme, setTheme] = useState<Theme>(() => {
    try { const s = localStorage.getItem("jd-theme"); if (s === "light" || s === "dark") return s; } catch { /* ignore */ }
    return "dark";
  });
  const [openId, setOpenId] = useState<number | null>(null);
  const [launching, setLaunching] = useState(false);
  const [videoOk, setVideoOk] = useState(true);
  const [videoMuted, setVideoMuted] = useState(true);
  const webgl = useMemo(() => hasWebGL(), []);
  const { data, status, reload } = useSynopsis();

  const toggleTheme = () => setTheme((t) => {
    const n: Theme = t === "dark" ? "light" : "dark";
    try { localStorage.setItem("jd-theme", n); } catch { /* ignore */ }
    return n;
  });
  const go = useCallback(() => (onLaunch ? onLaunch() : window.location.assign("/command-center")), [onLaunch]);
  const launch = () => { if (reduce) go(); else setLaunching(true); };
  const close = useCallback(() => setOpenId(null), []);
  const ctx: Ctx = { synopsis: data, status, reload, onPrint: () => window.print() };
  const open = CARDS.find((c) => c.n === openId) ?? null;
  const gridLine = theme === "dark" ? "#38BDF8" : "#1E3A8A";
  const nodeColor = theme === "dark" ? "#F59E0B" : "#B45309";

  return (
    <div className="jd-root min-h-screen" data-theme={theme}>
      <style>{STYLES}</style>
      <a href="#showcase" className="jd-focus sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[100] focus:rounded-lg focus:px-4 focus:py-2" style={{ background: "var(--accent2)", color: "#fff" }}>Skip to main content</a>

      {/* Navbar */}
      <header className="jd-glass fixed inset-x-0 top-0 z-50">
        <nav className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6" aria-label="Primary">
          <a href="#overview" className="jd-focus flex items-baseline gap-3 rounded-lg">
            <span className="text-xl font-extrabold tracking-wide">{BRAND_NAME}</span>
            <span className="hidden text-xs lg:inline" style={{ color: "var(--muted)" }}>{BRAND_SUBTITLE}</span>
          </a>
          <div className="flex items-center gap-2 sm:gap-4">
            <a href="#showcase" className="jd-focus hidden rounded-lg px-2 py-1 text-sm font-medium md:inline">Showcase</a>
            <a href="#card-14" className="jd-focus hidden rounded-lg px-2 py-1 text-sm font-medium md:inline">Documentation</a>
            {videoOk && (
              <button
                onClick={() => setVideoMuted((m) => !m)}
                aria-label={videoMuted ? "Unmute hero video audio" : "Mute hero video audio"}
                aria-pressed={!videoMuted}
                className="jd-focus inline-flex items-center gap-2 rounded-full px-3 py-2 text-sm font-semibold"
                style={{ background: "var(--panel2)", border: "1px solid var(--line)" }}
              >
                {videoMuted ? <VolumeX className="size-4" aria-hidden /> : <Volume2 className="size-4" aria-hidden />}
                <span className="hidden sm:inline">{videoMuted ? "Unmute Audio" : "Audio On"}</span>
              </button>
            )}
            <button onClick={toggleTheme} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`} aria-pressed={theme === "light"}
              className="jd-focus inline-flex items-center gap-2 rounded-full px-3 py-2 text-sm font-semibold" style={{ background: "var(--panel2)", border: "1px solid var(--line)" }}>
              {theme === "dark" ? <Sun className="size-4" aria-hidden /> : <Moon className="size-4" aria-hidden />}
              <span className="hidden sm:inline">{theme === "dark" ? "Daylight" : "Night Ops"}</span>
            </button>
          </div>
        </nav>
      </header>

      <main id="main">
        {/* Hero */}
        <section id="overview" className="relative isolate flex min-h-screen items-center justify-center overflow-hidden pt-16">
          <div className="jd-fallback-grid absolute inset-0 -z-30" aria-hidden />
          {videoOk && (
            <video
              className="absolute inset-0 -z-20 size-full object-cover opacity-55"
              src={HERO_VIDEO_SRC}
              autoPlay
              loop
              muted={videoMuted}
              playsInline
              preload="auto"
              aria-hidden
              onError={() => setVideoOk(false)}
            />
          )}
          {webgl && (
            <div className="absolute inset-0 -z-10" aria-hidden>
              <Canvas dpr={[1, 1.5]} camera={{ position: [0, 2.6, 7.5], fov: 55 }} frameloop={reduce ? "demand" : "always"} gl={{ alpha: true, antialias: true }}>
                <WaterGrid line={gridLine} node={nodeColor} animateIt={!reduce} />
              </Canvas>
            </div>
          )}
          <div className="absolute inset-0 -z-[5]" style={{ background: "radial-gradient(ellipse at 50% 45%, color-mix(in srgb,var(--bg) 78%,transparent) 0%, color-mix(in srgb,var(--bg) 25%,transparent) 70%)" }} aria-hidden />

          <div className="mx-auto max-w-5xl px-4 text-center sm:px-6">
            <motion.div initial={reduce ? false : { opacity: 0, y: -12 }} animate={{ opacity: 1, y: 0 }} transition={{ type: "spring", stiffness: 260, damping: 20 }}
              className="jd-glass mx-auto inline-flex items-center gap-2 rounded-full px-4 py-2 text-xs font-bold uppercase tracking-[0.16em] sm:text-sm">
              <Zap className="size-4" style={{ color: "var(--accent2)" }} aria-hidden /> Government of Odisha - Smart Infrastructure Prototype
            </motion.div>
            <motion.h1 initial={reduce ? false : { opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ type: "spring", stiffness: 200, damping: 20, delay: 0.1 }}
              className="mt-6 text-5xl font-black tracking-tight sm:text-7xl">{BRAND_NAME}</motion.h1>
            <motion.p initial={reduce ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.25 }} className="mt-3 text-base font-medium sm:text-lg" style={{ color: "var(--muted)" }}>{BRAND_SUBTITLE}</motion.p>
            <motion.p initial={reduce ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.35 }} className="mx-auto mt-5 max-w-2xl text-lg leading-relaxed">
              Find the choked culvert, see which hospital route it cuts, and prove the crew cleared it with a tap of a battery-free tag.
            </motion.p>

            <div className="mt-8 flex flex-wrap items-stretch justify-center gap-4">
              <Counter to={25} label="Monitored culverts (simulated)" reduce={reduce} />
              <Counter to={5} label="Passive NFC stations" reduce={reduce} />
              <Counter to={120} prefix="<" suffix="ms" label="AI inference target" reduce={reduce} />
            </div>

            <motion.div className="mt-10" initial={reduce ? false : { opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} transition={{ type: "spring", stiffness: 260, damping: 20, delay: 0.5 }}>
              <MagneticCTA onClick={launch} reduce={reduce} />
            </motion.div>
            <a href="#showcase" className="jd-focus mt-10 inline-flex flex-col items-center gap-1 rounded-lg text-sm font-medium" style={{ color: "var(--muted)" }}>
              Explore the 14 project sections <ChevronDown className={`size-5 ${reduce ? "" : "animate-bounce"}`} aria-hidden />
            </a>
          </div>
        </section>

        {/* Showcase */}
        <section id="showcase" className="mx-auto max-w-7xl scroll-mt-16 px-4 py-24 sm:px-6" aria-labelledby="showcase-h">
          <div className="mb-12 max-w-3xl">
            <div className="text-xs font-bold uppercase tracking-[0.16em]" style={{ color: "var(--accent2)" }}><Radio className="mr-2 inline size-4" aria-hidden />Project showcase</div>
            <h2 id="showcase-h" className="mt-2 text-3xl font-extrabold sm:text-4xl">Fourteen sections, one flood-response story</h2>
            <p className="mt-3 text-lg" style={{ color: "var(--muted)" }}>From the problem on the ground to the audit log, every mandatory framework and display-layout item is a card. Open any card for the full detail.</p>
          </div>
          <div className="grid grid-flow-dense grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {CARDS.map((c, i) => <ShowcaseCard key={c.n} def={c} index={i} reduce={reduce} onOpen={() => setOpenId(c.n)} />)}
          </div>
        </section>
      </main>

      <footer className="px-4 py-10 text-center text-sm" style={{ borderTop: "1px solid var(--line)", color: "var(--muted)" }}>
        <div className="font-semibold" style={{ color: "var(--text)" }}>{BRAND_NAME} | {BRAND_SUBTITLE}</div>
        <div className="mt-1">Prototype for demonstration. Telemetry is simulated; this is not an operational flood-warning system.</div>
      </footer>

      <AnimatePresence>{open && <Modal key={open.n} def={open} ctx={ctx} onClose={close} />}</AnimatePresence>

      <AnimatePresence>
        {launching && (
          <motion.div className="fixed inset-0 z-[100] grid place-items-center" style={{ background: "var(--bg)" }} role="status" aria-live="polite"
            initial={{ clipPath: "circle(0% at 50% 62%)" }} animate={{ clipPath: "circle(150% at 50% 62%)" }} transition={{ duration: 0.7, ease: [0.7, 0, 0.3, 1] }} onAnimationComplete={go}>
            <div className="text-center"><div className="text-3xl font-black">{BRAND_NAME}</div><div style={{ color: "var(--muted)" }}>Opening command system...</div></div>
          </motion.div>
        )}
      </AnimatePresence>

      {createPortal(<div className="print-only" aria-hidden><SynopsisBody synopsis={data} /></div>, document.body)}
    </div>
  );
}
