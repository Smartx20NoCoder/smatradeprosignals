import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from "recharts";

export const Route = createFileRoute("/")({ component: ScalpEdge });

type Signal = {
  id: string;
  pair: string;
  timeframe: string;
  setup: string;
  direction: "Long" | "Short";
  entry: number;
  stop_loss: number;
  tp1: number;
  tp2: number;
  rr: number;
  session_score: number;
  confidence: number;
  news_flag: boolean;
  status: string;
  outcome_r: number | null;
  created_at: string;
  executed_at: string | null;
  partial_close: boolean;
  order_type: string | null;
  candle_time: string | null;
  spread_pips: number | null;
  htf_bias: string | null;
  mfi_score: number | null;
  mfi_divergence: boolean;
  notes: string | null;
};

type ReportCheck = { setup: string; status: "qualified" | "filtered" | "none"; reason?: string; direction?: string };
type PairReport = { pair: string; cached: boolean; candle_time?: string; htf_bias?: string; checks: ReportCheck[] };
type ScanResult = { when: string; new: number; used: number; today: number; mode: string; errors: string[]; report: PairReport[] };
type ProgressStatus = "pending" | "waiting" | "fetching" | "cached" | "done" | "rate_limited" | "error";
type ProgressItem = { status: ProgressStatus; message?: string; updatedAt?: number };
type ProgressEvent = {
  type: "progress" | "pair_start" | "pair_done" | "complete" | "error";
  pair?: string;
  timeframe?: string;
  status?: ProgressStatus;
  message?: string;
  result?: any;
  error?: string;
};

const DAILY_BUDGET = 800;
const PAIRS = ["EUR/USD", "GBP/USD", "USD/JPY", "GBP/JPY", "EUR/JPY", "XAU/USD", "BTC/USD"];
const TFS = ["5m", "15m", "1h"] as const;
const MAX_CONCURRENT = 3;
const EXPIRE_HOURS = 24;

// Correlation pairs (same direction → blocked when one is In-Trade)
const CORRELATIONS: [string, string][] = [
  ["EUR/USD", "GBP/USD"],
  ["GBP/JPY", "EUR/JPY"],
];

function isGold(p: string) { return p === "XAU/USD"; }
function isBTC(p: string) { return p === "BTC/USD"; }
function fmtPrice(p: number, pair: string) {
  if (isGold(pair)) return p.toFixed(2);
  if (isBTC(pair)) return p.toFixed(1);
  return p.toFixed(pair.includes("JPY") ? 3 : 5);
}
function fmtCandle(iso: string | null, tf: string) {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${tf} candle · ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
}
function timeAgo(iso: string) {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// Loud multi-tone WebAudio alert for new signals
function playBeep() {
  try {
    const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
    const ctx = new Ctx();
    // Three ascending tones, each loud and sustained
    const tones = [
      { f: 880, start: 0.00, dur: 0.30 },
      { f: 1320, start: 0.35, dur: 0.30 },
      { f: 1760, start: 0.70, dur: 0.55 },
    ];
    const master = ctx.createGain();
    master.gain.value = 0.9; // near-max
    master.connect(ctx.destination);
    for (const t of tones) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "square"; // square wave = more cut-through than sine
      o.frequency.value = t.f;
      o.connect(g); g.connect(master);
      const s = ctx.currentTime + t.start;
      g.gain.setValueAtTime(0.0001, s);
      g.gain.exponentialRampToValueAtTime(0.8, s + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, s + t.dur);
      o.start(s); o.stop(s + t.dur + 0.02);
    }
    setTimeout(() => ctx.close(), 1600);
  } catch { /* ignore */ }
}

// Stage helpers
const CLOSED_STATUSES = ["tp1", "tp2", "be", "loss", "win", "expired"];
function stageOf(s: Signal): 1 | 2 | 3 {
  if (CLOSED_STATUSES.includes(s.status)) return 3;
  if (s.status === "executed") return 2;
  return 1;
}

function ScalpEdge() {
  const [signals, setSignals] = useState<Signal[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState<Record<string, ProgressItem>>({});
  const [currentFetch, setCurrentFetch] = useState<string | null>(null);
  const [lastScan, setLastScan] = useState<ScanResult | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [budgetToday, setBudgetToday] = useState(0);
  const [tab, setTab] = useState<"signals" | "edge" | "settings">("signals");
  const [now, setNow] = useState(Date.now());

  // Settings
  const [autoScan, setAutoScan] = useState(false);
  const [autoInterval, setAutoInterval] = useState<15 | 30>(30);
  const [soundOn, setSoundOn] = useState(true);

  // (auto-resolve removed — statuses are manual)
  const autoTimerRef = useRef<number | null>(null);
  const lastSignalCountRef = useRef(0);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);

  // Persist settings
  useEffect(() => {
    const raw = localStorage.getItem("scalpedge-settings");
    if (raw) {
      try {
        const s = JSON.parse(raw);
        if (typeof s.autoScan === "boolean") setAutoScan(s.autoScan);
        if (s.autoInterval === 15 || s.autoInterval === 30) setAutoInterval(s.autoInterval);
        if (typeof s.soundOn === "boolean") setSoundOn(s.soundOn);
      } catch { /* ignore */ }
    }
  }, []);
  useEffect(() => {
    localStorage.setItem("scalpedge-settings", JSON.stringify({ autoScan, autoInterval, soundOn }));
  }, [autoScan, autoInterval, soundOn]);

  async function loadSignals() {
    const { data } = await supabase
      .from("signals").select("*")
      .order("created_at", { ascending: false }).limit(200);
    setSignals((data as Signal[]) ?? []);
    const today = new Date().toISOString().slice(0, 10);
    const { data: u } = await supabase.from("api_usage").select("calls").eq("day", today).maybeSingle();
    setBudgetToday((u?.calls as number) ?? 0);
  }

  useEffect(() => {
    loadSignals();
  }, []);

  async function runScan(mode: "full" | "latest" = "full") {
    setScanning(true);
    const init: Record<string, "pending" | "checking" | "done"> = {};
    PAIRS.forEach((p) => (init[p] = "pending"));
    setScanProgress(init);
    let cancelled = false;
    (async () => {
      for (const p of PAIRS) {
        if (cancelled) return;
        setScanProgress((s) => ({ ...s, [p]: "checking" }));
        await new Promise((r) => setTimeout(r, 240));
      }
    })();
    try {
      const { data, error } = await supabase.functions.invoke("scan-signals", { body: { mode } });
      if (error) throw error;
      cancelled = true;
      const done: Record<string, "pending" | "checking" | "done"> = {};
      PAIRS.forEach((p) => (done[p] = "done"));
      setScanProgress(done);
      const result: ScanResult = {
        when: new Date().toISOString(),
        new: data.new_signals ?? 0,
        used: data.api_calls_used ?? 0,
        today: data.api_calls_today ?? 0,
        mode: data.mode ?? mode,
        errors: data.errors ?? [],
        report: data.report ?? [],
      };
      setLastScan(result);
      setReportOpen(true);
      setBudgetToday(data.api_calls_today ?? 0);
      await loadSignals();
      // Notification beep on new qualifying signals (auto-scan only)
      if (mode === "latest" && soundOn && (data.new_signals ?? 0) > 0) playBeep();
      lastSignalCountRef.current = (data.new_signals ?? 0);
    } catch (e) {
      cancelled = true;
      setLastScan({
        when: new Date().toISOString(), new: 0, used: 0, today: budgetToday,
        mode, errors: [(e as Error).message], report: [],
      });
    } finally {
      setScanning(false);
    }
  }

  // Auto-scan loop
  useEffect(() => {
    if (autoTimerRef.current) {
      clearInterval(autoTimerRef.current);
      autoTimerRef.current = null;
    }
    if (autoScan) {
      autoTimerRef.current = window.setInterval(() => {
        if (!scanning) runScan("latest");
      }, autoInterval * 60 * 1000);
    }
    return () => {
      if (autoTimerRef.current) clearInterval(autoTimerRef.current);
    };
  }, [autoScan, autoInterval]);

  // Manual status setter — user can click any tile at any time to correct outcome.
  async function setStatus(s: Signal, status: "pending" | "executed" | "tp1" | "tp2" | "be" | "loss" | "expired") {
    await supabase.functions.invoke("update-signal", { body: { id: s.id, status } });
    await loadSignals();
  }
  async function markPartialTp1Be(s: Signal) {
    const risk = Math.abs(s.entry - s.stop_loss);
    const tp1R = risk > 0 ? Math.abs(s.tp1 - s.entry) / risk : 0;
    const blended = +(tp1R / 2).toFixed(2);
    await supabase.from("signals")
      .update({ status: "tp1", partial_close: true, outcome_r: blended, closed_at: new Date().toISOString() })
      .eq("id", s.id);
    await loadSignals();
  }

  // Correlation / exposure check
  function exposureCheck(s: Signal): string | null {
    const open = signals.filter(x => stageOf(x) === 2);
    if (open.length >= MAX_CONCURRENT) {
      return `Hard cap: ${MAX_CONCURRENT} concurrent open trades already`;
    }
    for (const [a, b] of CORRELATIONS) {
      if (s.pair === a || s.pair === b) {
        const conflict = open.find(x => (x.pair === a || x.pair === b) && x.direction === s.direction && x.id !== s.id);
        if (conflict) return `Correlation conflict: ${conflict.pair} ${conflict.direction} already open`;
      }
    }
    return null;
  }

  const stats = useMemo(() => {
    const closed = signals.filter((s) => stageOf(s) === 3 && s.outcome_r !== null);
    const bySetup: Record<string, { n: number; wins: number; rSum: number }> = {};
    for (const s of closed) {
      if (!bySetup[s.setup]) bySetup[s.setup] = { n: 0, wins: 0, rSum: 0 };
      bySetup[s.setup].n++;
      bySetup[s.setup].rSum += s.outcome_r ?? 0;
      if ((s.outcome_r ?? 0) > 0) bySetup[s.setup].wins++;
    }
    const summary = Object.entries(bySetup).map(([setup, v]) => ({
      setup, n: v.n,
      winRate: v.n ? (v.wins / v.n) * 100 : 0,
      avgR: v.n ? v.rSum / v.n : 0,
      expectancy: v.n ? v.rSum / v.n : 0,
    }));
    let cum = 0;
    const curve = [...closed]
      .sort((a, b) => +new Date(a.created_at) - +new Date(b.created_at))
      .map((s, i) => { cum += s.outcome_r ?? 0; return { i: i + 1, r: +cum.toFixed(2) }; });
    const wins = closed.filter((s) => (s.outcome_r ?? 0) > 0).length;
    return { summary, curve, totalR: cum, totalN: closed.length, winRate: closed.length ? (wins / closed.length) * 100 : 0 };
  }, [signals, now]);

  const pendingSignals = signals.filter((s) => stageOf(s) === 1);
  const openSignals = signals.filter((s) => stageOf(s) === 2);
  const budgetPct = Math.min(100, (budgetToday / DAILY_BUDGET) * 100);

  // Auto-scan budget projection (calls/day)
  const autoCallsPerScan = 14; // 7 pairs * 2 TFs (5m + 15m). 1H pulled from cache.
  const scansPerDay = autoScan ? Math.floor((24 * 60) / autoInterval) : 0;
  const projectedDaily = scansPerDay * autoCallsPerScan;

  return (
    <div className="min-h-screen scanline">
      <div className="mx-auto max-w-6xl px-4 py-6">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between border-b border-border pb-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">
              <span className="text-primary">▲</span> SCALPEDGE
            </h1>
            <p className="text-xs text-muted-foreground mt-1">
              FX + GOLD SCALPING TERMINAL · 5M/15M · 1H BIAS · SMC + MFI
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-right">
              <div className="text-[10px] uppercase text-muted-foreground tracking-wider">API Budget</div>
              <div className="text-sm font-semibold">{budgetToday} / {DAILY_BUDGET}</div>
              <div className="w-32 h-1 mt-1 bg-secondary rounded overflow-hidden">
                <div className="h-full transition-all" style={{
                  width: `${budgetPct}%`,
                  backgroundColor: budgetPct > 85 ? "var(--bear)" : budgetPct > 60 ? "var(--chart-4)" : "var(--bull)",
                }}/>
              </div>
            </div>
            <button onClick={() => runScan("full")} disabled={scanning}
              className="px-5 py-3 bg-primary text-primary-foreground font-bold text-sm uppercase tracking-wider rounded hover:opacity-90 disabled:opacity-50 transition-opacity">
              {scanning ? "SCANNING…" : "▶ SCAN"}
            </button>
          </div>
        </header>

        {/* Auto-scan status pill */}
        {autoScan && (
          <div className="mt-3 text-[10px] uppercase tracking-wider text-primary flex items-center gap-2">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
            AUTO-SCAN ON · every {autoInterval}m · ~{projectedDaily} calls/day · sound {soundOn ? "on" : "off"}
          </div>
        )}

        {scanning && (
          <div className="mt-4 border border-border rounded bg-card p-3 animate-fade-in">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">Live Scan</div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 text-xs font-mono">
              {PAIRS.map((p) => {
                const st = scanProgress[p] ?? "pending";
                return (
                  <div key={p} className="flex items-center gap-2">
                    <span className={st === "done" ? "text-bull" : st === "checking" ? "text-primary animate-pulse" : "text-muted-foreground/50"}>
                      {st === "done" ? "✓" : st === "checking" ? "◌" : "·"}
                    </span>
                    <span className={st === "pending" ? "text-muted-foreground/60" : ""}>{p}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {lastScan && !scanning && (
          <div className="mt-3 text-xs flex flex-wrap items-center gap-x-4 gap-y-1 text-muted-foreground">
            <span>LAST SCAN <span className="text-foreground">{timeAgo(lastScan.when)} ago</span></span>
            <span>MODE <span className="text-foreground uppercase">{lastScan.mode}</span></span>
            <span>NEW <span className="text-primary font-semibold">{lastScan.new}</span></span>
            <span>USED <span className="text-foreground">{lastScan.used}</span> credits</span>
            {lastScan.errors.length > 0 && (
              <span className="text-bear">{lastScan.errors.length} error(s): {lastScan.errors[0]}</span>
            )}
            {lastScan.report.length > 0 && (
              <button onClick={() => setReportOpen((o) => !o)}
                className="ml-auto px-2 py-1 text-[10px] uppercase tracking-wider border border-border rounded hover:border-primary/40 hover:text-foreground">
                {reportOpen ? "▾ Hide" : "▸ Show"} Scan Report
              </button>
            )}
          </div>
        )}

        {lastScan && reportOpen && lastScan.report.length > 0 && <ScanReport report={lastScan.report} />}

        <nav className="mt-6 flex gap-1 border-b border-border">
          {([
            ["signals", `SIGNALS (${pendingSignals.length}/${openSignals.length})`],
            ["edge", "EDGE"],
            ["settings", "SETTINGS"],
          ] as const).map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)}
              className={`px-4 py-2 text-xs uppercase tracking-wider font-semibold border-b-2 transition-colors ${
                tab === k ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"
              }`}>
              {label}
            </button>
          ))}
        </nav>

        {tab === "signals" && (
          <SignalList signals={signals} onStatus={setStatus} onPartial={markPartialTp1Be} exposureCheck={exposureCheck} />
        )}
        {tab === "edge" && <EdgePanel stats={stats} />}
        {tab === "settings" && (
          <SettingsPanel
            autoScan={autoScan} setAutoScan={setAutoScan}
            autoInterval={autoInterval} setAutoInterval={setAutoInterval}
            soundOn={soundOn} setSoundOn={setSoundOn}
            projectedDaily={projectedDaily}
          />
        )}

        <footer className="mt-12 text-center text-[10px] text-muted-foreground uppercase tracking-widest">
          Not financial advice · Mechanical edge tracking · Spread-adjusted prices · 1H HTF aligned
        </footer>
      </div>
    </div>
  );
}

function ScanReport({ report }: { report: PairReport[] }) {
  return (
    <div className="mt-3 border border-border rounded bg-card/60 p-3 animate-fade-in">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
        Scan Report · {report.length} pairs
      </div>
      <div className="space-y-2 text-xs">
        {report.map((p) => (
          <div key={p.pair} className="border-b border-border/40 pb-2 last:border-b-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-bold">{p.pair}</span>
              {p.cached && <span className="px-1.5 py-0.5 text-[9px] uppercase rounded bg-secondary/60 text-muted-foreground">cached</span>}
              {p.htf_bias && (
                <span className={`px-1.5 py-0.5 text-[9px] uppercase rounded ${
                  p.htf_bias === "bull" ? "bg-bull/20 text-bull" :
                  p.htf_bias === "bear" ? "bg-bear/20 text-bear" : "bg-secondary/60 text-muted-foreground"
                }`}>
                  1H {p.htf_bias}
                </span>
              )}
              {p.candle_time && (
                <span className="text-[10px] text-muted-foreground">
                  last 5m: {new Date(p.candle_time).toISOString().slice(11, 16)} UTC
                </span>
              )}
            </div>
            <div className="mt-1 space-y-0.5 pl-2">
              {p.checks.map((c, i) => (
                <div key={i} className="flex items-start gap-2">
                  <span className={c.status === "qualified" ? "text-bull" : c.status === "filtered" ? "text-chart-4" : "text-muted-foreground/60"}>
                    {c.status === "qualified" ? "✓" : c.status === "filtered" ? "⊘" : "—"}
                  </span>
                  <span className="text-foreground/80">{c.setup}</span>
                  {c.direction && <span className="text-muted-foreground">({c.direction})</span>}
                  {c.reason && <span className="text-muted-foreground italic">— {c.reason}</span>}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

type StatusKey = "pending" | "executed" | "tp1" | "tp2" | "be" | "loss" | "expired";

function SignalList({
  signals, onStatus, onPartial, exposureCheck,
}: {
  signals: Signal[];
  onStatus: (s: Signal, status: StatusKey) => void;
  onPartial: (s: Signal) => void;
  exposureCheck: (s: Signal) => string | null;
}) {
  if (signals.length === 0) {
    return (
      <div className="mt-10 text-center text-muted-foreground py-16 border border-dashed border-border rounded">
        <div className="text-sm">NO SIGNALS YET</div>
        <div className="text-xs mt-1">Hit ▶ SCAN to scan all 7 pairs on 5m + 15m + 1H bias</div>
      </div>
    );
  }
  return (
    <div className="mt-4 space-y-2">
      {signals.map((s) => (
        <SignalRow key={s.id} s={s} onStatus={onStatus} onPartial={onPartial}
          warning={s.status === "pending" || s.status === "executed" ? exposureCheck(s) : null} />
      ))}
    </div>
  );
}

function SignalRow({
  s, onStatus, onPartial, warning,
}: {
  s: Signal;
  onStatus: (s: Signal, status: StatusKey) => void;
  onPartial: (s: Signal) => void;
  warning: string | null;
}) {
  const long = s.direction === "Long";
  const stage = stageOf(s);
  const orderType = s.order_type ?? (long ? "Buy Limit" : "Sell Limit");
  const spreadLabel = s.spread_pips != null
    ? (isGold(s.pair) ? `$0.40 spread` : isBTC(s.pair) ? `$2.00 spread` : `${s.spread_pips}p spread`)
    : null;

  // Correlation blocks moving to In-Trade
  const blockedExecute = warning && s.status === "pending";

  return (
    <div className={`border rounded p-3 transition-colors ${
      stage === 3 ? "bg-card/40 border-border/60 opacity-75"
      : stage === 2 ? "bg-card border-primary/40"
      : "bg-card border-border hover:border-primary/40"
    }`}>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`px-2 py-0.5 text-xs font-bold rounded ${long ? "bg-bull/15 text-bull" : "bg-bear/15 text-bear"}`}>
            {long ? "▲ LONG" : "▼ SHORT"}
          </span>
          <span className="font-bold text-base">{s.pair}</span>
          <span className="text-xs text-muted-foreground">{s.timeframe}</span>
          <span className="text-xs text-muted-foreground">·</span>
          <span className="text-xs text-foreground/80">{s.setup}</span>
          <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-primary/15 text-primary uppercase tracking-wider">
            {orderType}
          </span>
          {s.htf_bias && s.htf_bias !== "neutral" && (
            <span className={`px-1.5 py-0.5 text-[9px] uppercase rounded ${
              s.htf_bias === "bull" ? "bg-bull/15 text-bull" : "bg-bear/15 text-bear"
            }`}>1H {s.htf_bias}</span>
          )}
          {s.mfi_divergence && (
            <span className="px-1.5 py-0.5 text-[9px] uppercase rounded bg-primary/20 text-primary">MFI div</span>
          )}
          {s.news_flag && (
            <span className="px-1.5 py-0.5 text-[10px] font-bold rounded bg-destructive/20 text-destructive">NEWS</span>
          )}
          {s.partial_close && (
            <span className="px-1.5 py-0.5 text-[9px] uppercase rounded bg-chart-4/20 text-chart-4">partial</span>
          )}
        </div>
        <div className="flex items-center gap-3 text-xs">
          {s.mfi_score != null && (<><span className="text-muted-foreground">MFI</span><span className="font-semibold">{s.mfi_score}</span></>)}
          <span className="text-muted-foreground">SCORE</span>
          <span className="font-semibold">{s.session_score}</span>
          <span className="text-muted-foreground">CONF</span>
          <span className="font-semibold" style={{
            color: s.confidence >= 75 ? "var(--bull)" : s.confidence >= 60 ? "var(--chart-4)" : "var(--muted-foreground)"
          }}>{s.confidence}%</span>
          <span className="text-muted-foreground">{timeAgo(s.created_at)}</span>
        </div>
      </div>

      <div className="mt-1.5 flex items-center gap-3 text-[10px] text-muted-foreground uppercase tracking-wider flex-wrap">
        <span>{fmtCandle(s.candle_time, s.timeframe)}</span>
        {spreadLabel && <span>· {spreadLabel} applied</span>}
      </div>

      <div className="mt-2 grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs">
        <Cell label="ENTRY" value={fmtPrice(s.entry, s.pair)} />
        <Cell label="SL" value={fmtPrice(s.stop_loss, s.pair)} color="bear" />
        <Cell label="TP1" value={fmtPrice(s.tp1, s.pair)} color="bull" />
        <Cell label="TP2" value={fmtPrice(s.tp2, s.pair)} color="bull" />
        <Cell label="R:R" value={`1 : ${s.rr.toFixed(1)}`} />
      </div>

      {warning && (
        <div className="mt-2 text-[11px] text-chart-4 bg-chart-4/10 border border-chart-4/30 rounded px-2 py-1">
          ⚠ {warning}
        </div>
      )}

      {/* Manual status tiles — clickable at any time */}
      <div className="mt-3">
        <div className="text-[9px] uppercase tracking-wider text-muted-foreground mb-1.5">Status — click to set</div>
        <div className="grid grid-cols-4 sm:grid-cols-7 gap-1.5">
          <StatusTile label="Pending"  active={s.status === "pending"}  onClick={() => onStatus(s, "pending")} />
          <StatusTile label="In-Trade" active={s.status === "executed"} onClick={() => onStatus(s, "executed")}
            disabled={!!blockedExecute && s.status !== "executed"} tone="primary" />
          <StatusTile label="TP 1"     active={s.status === "tp1" && !s.partial_close} onClick={() => onStatus(s, "tp1")} tone="bull" />
          <StatusTile label="TP 2"     active={s.status === "tp2"}     onClick={() => onStatus(s, "tp2")} tone="bull" />
          <StatusTile label="BE"       active={s.status === "be"}      onClick={() => onStatus(s, "be")} />
          <StatusTile label="SL"       active={s.status === "loss"}    onClick={() => onStatus(s, "loss")} tone="bear" />
          <StatusTile label="Expired"  active={s.status === "expired"} onClick={() => onStatus(s, "expired")} />
        </div>
        <div className="mt-1.5 flex items-center gap-2 flex-wrap">
          <button onClick={() => onPartial(s)}
            className="px-2 py-1 text-[10px] uppercase tracking-wider rounded border border-chart-4/60 text-chart-4 hover:bg-chart-4/15">
            TP1 + BE runner (partial)
          </button>
          {stage === 3 && s.outcome_r !== null && (
            <span className="text-xs font-bold" style={{
              color: s.outcome_r > 0 ? "var(--bull)" : s.outcome_r < 0 ? "var(--bear)" : "var(--muted-foreground)"
            }}>
              {s.outcome_r > 0 ? "+" : ""}{s.outcome_r.toFixed(2)}R
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function StatusTile({
  label, active, onClick, tone, disabled,
}: {
  label: string; active: boolean; onClick: () => void;
  tone?: "primary" | "bull" | "bear"; disabled?: boolean;
}) {
  const toneColor = tone === "bull" ? "bull" : tone === "bear" ? "bear" : tone === "primary" ? "primary" : "foreground";
  const activeCls =
    tone === "bull" ? "bg-bull/20 border-bull text-bull"
    : tone === "bear" ? "bg-bear/20 border-bear text-bear"
    : tone === "primary" ? "bg-primary/20 border-primary text-primary"
    : "bg-secondary border-foreground text-foreground";
  const idleCls =
    tone === "bull" ? "border-border text-muted-foreground hover:border-bull hover:text-bull"
    : tone === "bear" ? "border-border text-muted-foreground hover:border-bear hover:text-bear"
    : tone === "primary" ? "border-border text-muted-foreground hover:border-primary hover:text-primary"
    : "border-border text-muted-foreground hover:text-foreground";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={disabled ? "Blocked by correlation rule" : `Set status to ${label}`}
      data-tone={toneColor}
      className={`px-2 py-1.5 text-[10px] uppercase tracking-wider font-semibold rounded border transition-colors ${
        active ? activeCls : idleCls
      } ${disabled ? "opacity-40 cursor-not-allowed" : ""}`}
    >
      {label}
    </button>
  );
}


function Cell({ label, value, color }: { label: string; value: string; color?: "bull" | "bear" }) {
  return (
    <div className="flex flex-col bg-secondary/40 px-2 py-1 rounded">
      <span className="text-[9px] uppercase text-muted-foreground tracking-wider">{label}</span>
      <span className={`font-semibold ${color === "bull" ? "text-bull" : color === "bear" ? "text-bear" : ""}`}>{value}</span>
    </div>
  );
}

function SettingsPanel({
  autoScan, setAutoScan, autoInterval, setAutoInterval, soundOn, setSoundOn, projectedDaily,
}: {
  autoScan: boolean; setAutoScan: (v: boolean) => void;
  autoInterval: 15 | 30; setAutoInterval: (v: 15 | 30) => void;
  soundOn: boolean; setSoundOn: (v: boolean) => void;
  projectedDaily: number;
}) {
  return (
    <div className="mt-4 space-y-3">
      <div className="border border-border rounded bg-card p-4">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-3">Auto-Scan</div>
        <div className="flex items-center justify-between">
          <span className="text-sm">Run scans automatically</span>
          <Toggle on={autoScan} onChange={setAutoScan} />
        </div>
        <div className="mt-3 flex items-center justify-between">
          <span className="text-sm">Interval</span>
          <div className="flex gap-1">
            {([15, 30] as const).map((m) => (
              <button key={m} onClick={() => setAutoInterval(m)} disabled={!autoScan}
                className={`px-3 py-1 text-xs rounded border ${
                  autoInterval === m ? "border-primary text-primary bg-primary/10" : "border-border text-muted-foreground"
                } disabled:opacity-40`}>
                {m}m
              </button>
            ))}
          </div>
        </div>
        <div className="mt-3 text-xs text-muted-foreground">
          Each auto-scan = ~14 API calls (5m + 15m only; 1H from cache).
          {autoScan ? <> Estimated <span className="text-foreground font-semibold">{projectedDaily}</span> calls/day.</> : null}
        </div>
      </div>

      <div className="border border-border rounded bg-card p-4">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-3">Notifications</div>
        <div className="flex items-center justify-between">
          <span className="text-sm">Sound on new signal</span>
          <Toggle on={soundOn} onChange={setSoundOn} />
        </div>
      </div>

      <div className="border border-border rounded bg-card p-4 text-xs text-muted-foreground space-y-1">
        <div className="text-[10px] uppercase tracking-wider mb-2">Risk Rules</div>
        <div>• Max 3 concurrent open trades</div>
        <div>• EUR/USD ↔ GBP/USD: max 1 same-direction</div>
        <div>• GBP/JPY ↔ EUR/JPY: max 1 same-direction</div>
        <div>• XAU/USD: independent</div>
        <div>• Spreads: USD majors 1.2p · crosses 2.5p · XAU/USD $0.40</div>
      </div>
    </div>
  );
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button onClick={() => onChange(!on)}
      className={`relative w-11 h-6 rounded-full transition-colors ${on ? "bg-primary" : "bg-secondary"}`}>
      <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-background transition-transform ${on ? "translate-x-5" : ""}`} />
    </button>
  );
}

function EdgePanel({
  stats,
}: {
  stats: {
    summary: { setup: string; n: number; winRate: number; avgR: number; expectancy: number }[];
    curve: { i: number; r: number }[];
    totalR: number; totalN: number; winRate: number;
  };
}) {
  return (
    <div className="mt-4 space-y-4">
      <div className="grid grid-cols-3 gap-2">
        <KPI label="CLOSED" value={stats.totalN.toString()} />
        <KPI label="WIN RATE" value={`${stats.winRate.toFixed(1)}%`} color={stats.winRate >= 50 ? "bull" : "bear"} />
        <KPI label="TOTAL R" value={`${stats.totalR >= 0 ? "+" : ""}${stats.totalR.toFixed(2)}R`} color={stats.totalR >= 0 ? "bull" : "bear"} />
      </div>

      <div className="bg-card border border-border rounded p-3">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">P&L CURVE (R, cumulative)</div>
        <div className="h-56">
          {stats.curve.length === 0 ? (
            <div className="h-full flex items-center justify-center text-muted-foreground text-xs">
              Close out signals to build your edge curve
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={stats.curve}>
                <CartesianGrid stroke="var(--grid)" strokeDasharray="2 2" />
                <XAxis dataKey="i" stroke="var(--muted-foreground)" fontSize={10} />
                <YAxis stroke="var(--muted-foreground)" fontSize={10} />
                <Tooltip contentStyle={{ backgroundColor: "var(--card)", border: "1px solid var(--border)", fontSize: 11 }} />
                <Line type="monotone" dataKey="r" stroke="var(--primary)" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      <div className="bg-card border border-border rounded p-3">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-3">BY SETUP</div>
        {stats.summary.length === 0 ? (
          <div className="text-xs text-muted-foreground py-6 text-center">No closed trades yet</div>
        ) : (
          <table className="w-full text-xs">
            <thead className="text-[10px] uppercase text-muted-foreground tracking-wider">
              <tr className="border-b border-border">
                <th className="text-left py-2">Setup</th>
                <th className="text-right">N</th>
                <th className="text-right">Win%</th>
                <th className="text-right">Avg R</th>
                <th className="text-right">Expectancy</th>
              </tr>
            </thead>
            <tbody>
              {stats.summary.map((r) => (
                <tr key={r.setup} className="border-b border-border/40">
                  <td className="py-2">{r.setup}</td>
                  <td className="text-right">{r.n}</td>
                  <td className="text-right">{r.winRate.toFixed(1)}%</td>
                  <td className="text-right font-semibold" style={{ color: r.avgR >= 0 ? "var(--bull)" : "var(--bear)" }}>
                    {r.avgR >= 0 ? "+" : ""}{r.avgR.toFixed(2)}R
                  </td>
                  <td className="text-right" style={{ color: r.expectancy >= 0 ? "var(--bull)" : "var(--bear)" }}>
                    {r.expectancy >= 0 ? "+" : ""}{r.expectancy.toFixed(2)}R
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function KPI({ label, value, color }: { label: string; value: string; color?: "bull" | "bear" }) {
  return (
    <div className="bg-card border border-border rounded p-3">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="text-xl font-bold mt-1" style={{
        color: color === "bull" ? "var(--bull)" : color === "bear" ? "var(--bear)" : undefined
      }}>{value}</div>
    </div>
  );
}
