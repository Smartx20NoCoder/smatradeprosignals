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
type ScanRun = {
  id: string;
  started_at: string;
  finished_at: string | null;
  mode: string;
  source: string;
  new_signals: number;
  api_calls_used: number;
  api_calls_today: number;
  errors: any;
  ok: boolean;
};
type CacheRow = { pair: string; timeframe: string; fetched_at: string };
type SessionWindow = { enabled: boolean; start: number; end: number };
type SessionConfig = {
  scan_active_sessions_only: boolean;
  sessions: { london: SessionWindow; ny: SessionWindow; tokyo: SessionWindow; sydney: SessionWindow };
  custom_overrides: Record<string, { start: number; end: number } | null>;
};
type AppSettings = {
  paused: boolean;
  trading_hours_start_utc: number;
  trading_hours_end_utc: number;
  active_td_key: number;
  session_config: SessionConfig;
};
type EconomicEvent = { id: string; event_time: string; currency: string; title: string; impact: string };

const DEFAULT_SESSION_CONFIG: SessionConfig = {
  scan_active_sessions_only: false,
  sessions: {
    london: { enabled: true, start: 7, end: 16 },
    ny:     { enabled: true, start: 12, end: 21 },
    tokyo:  { enabled: true, start: 0, end: 9 },
    sydney: { enabled: true, start: 22, end: 7 },
  },
  custom_overrides: {},
};

const DAILY_BUDGET = 800;
const PAIRS = ["EUR/USD", "GBP/USD", "USD/JPY", "GBP/JPY", "EUR/JPY", "XAU/USD", "BTC/USD"];
const TFS = ["5m", "15m", "1h"] as const;
const MAX_CONCURRENT = 3;
const EXPIRE_HOURS = 24;
const CRON_INTERVAL_MIN = 15;
// Notional account size used by risk meter (1% per trade assumed)
const NOTIONAL_ACCOUNT = 10000;
const RISK_PER_TRADE_PCT = 1.0;

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
  const [scanTimeframes, setScanTimeframes] = useState<string[]>([...TFS]);
  const [lastScan, setLastScan] = useState<ScanResult | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [budgetToday, setBudgetToday] = useState(0);
  const [tab, setTab] = useState<"signals" | "edge" | "history" | "health" | "settings">("signals");
  const [now, setNow] = useState(Date.now());

  // Settings
  // (Auto-scan is server-side cron now; no client toggle state needed.)
  const [soundOn, setSoundOn] = useState(true);
  const [scanRuns, setScanRuns] = useState<ScanRun[]>([]);
  const [cacheRows, setCacheRows] = useState<CacheRow[]>([]);

  const lastSignalCountRef = useRef(0);
  const lastSeenSignalIdsRef = useRef<Set<string>>(new Set());

  const [appSettings, setAppSettings] = useState<AppSettings>({
    paused: false, trading_hours_start_utc: 1, trading_hours_end_utc: 20, active_td_key: 1,
    session_config: DEFAULT_SESSION_CONFIG,
  });
  const [todaysEvents, setTodaysEvents] = useState<EconomicEvent[]>([]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);

  // Persist settings (sound only — auto-scan is server-side). SSR-safe.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const raw = window.localStorage.getItem("scalpedge-settings");
    if (raw) {
      try {
        const s = JSON.parse(raw);
        if (typeof s.soundOn === "boolean") setSoundOn(s.soundOn);
      } catch { /* ignore */ }
    }
  }, []);
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem("scalpedge-settings", JSON.stringify({ soundOn }));
  }, [soundOn]);

  async function loadSignals() {
    const { data } = await supabase
      .from("signals").select("*")
      .order("created_at", { ascending: false }).limit(200);
    const next = (data as Signal[]) ?? [];
    // Detect new signal IDs from server-side cron and beep
    const incoming = next.map((s) => s.id);
    const prev = lastSeenSignalIdsRef.current;
    if (prev.size > 0 && soundOn) {
      const fresh = incoming.filter((id) => !prev.has(id));
      if (fresh.length > 0) playBeep();
    }
    lastSeenSignalIdsRef.current = new Set(incoming);
    setSignals(next);
    const today = new Date().toISOString().slice(0, 10);
    const { data: u } = await supabase.from("api_usage").select("calls").eq("day", today).maybeSingle();
    setBudgetToday((u?.calls as number) ?? 0);
  }

  async function loadHealth() {
    const { data: runs } = await supabase.from("scan_runs")
      .select("*").order("started_at", { ascending: false }).limit(20);
    setScanRuns((runs as ScanRun[]) ?? []);
    const { data: cache } = await supabase.from("candle_cache")
      .select("pair, timeframe, fetched_at");
    setCacheRows((cache as CacheRow[]) ?? []);
    const { data: cfg } = await (supabase as any).from("app_settings").select("*").eq("id", "singleton").maybeSingle();
    if (cfg) setAppSettings({
      paused: !!cfg.paused,
      trading_hours_start_utc: Number(cfg.trading_hours_start_utc ?? 1),
      trading_hours_end_utc: Number(cfg.trading_hours_end_utc ?? 20),
      active_td_key: Number(cfg.active_td_key ?? 1),
      session_config: (cfg.session_config as SessionConfig) ?? DEFAULT_SESSION_CONFIG,
    });
    const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart.getTime() + 24 * 3600_000);
    const { data: ev } = await (supabase as any).from("economic_events")
      .select("*").gte("event_time", dayStart.toISOString()).lt("event_time", dayEnd.toISOString())
      .order("event_time", { ascending: true });
    setTodaysEvents((ev as EconomicEvent[]) ?? []);
  }

  async function saveAppSettings(patch: Partial<AppSettings>) {
    const next = { ...appSettings, ...patch };
    setAppSettings(next);
    await (supabase as any).from("app_settings")
      .update({ ...patch, updated_at: new Date().toISOString() }).eq("id", "singleton");
  }

  async function refreshNewsCalendar() {
    const projectUrl = import.meta.env.VITE_SUPABASE_URL;
    const anonKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
    await fetch(`${projectUrl}/functions/v1/fetch-news-calendar`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: anonKey, Authorization: `Bearer ${anonKey}` },
      body: JSON.stringify({ source: "manual" }),
    });
    await loadHealth();
  }

  useEffect(() => {
    loadSignals();
    loadHealth();
    // Poll the database every 30s for cron-created signals and health stats
    const t = setInterval(() => { loadSignals(); loadHealth(); }, 30000);
    return () => clearInterval(t);
  }, []);

  async function runScan(mode: "full" | "latest" = "full") {
    setScanning(true);
    const activeTfs = mode === "latest" ? ["5m", "15m"] : [...TFS];
    setScanTimeframes(activeTfs);
    const init: Record<string, ProgressItem> = {};
    PAIRS.forEach((p) => activeTfs.forEach((tf) => (init[`${p}|${tf}`] = { status: "pending" })));
    setScanProgress(init);
    setCurrentFetch(null);
    try {
      const projectUrl = import.meta.env.VITE_SUPABASE_URL;
      const anonKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
      const res = await fetch(`${projectUrl}/functions/v1/scan-signals`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: anonKey, Authorization: `Bearer ${anonKey}` },
        body: JSON.stringify({ mode, stream: true }),
      });
      if (!res.ok) throw new Error(`Scan failed (${res.status})`);
      if (!res.body) throw new Error("Live scan stream unavailable");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let data: any = null;
      const handleEvent = (evt: ProgressEvent) => {
        if (evt.type === "complete") { data = evt.result; return; }
        if (evt.type === "error") throw new Error(evt.error ?? "Scan failed");
        if (!evt.pair || !evt.timeframe || !evt.status) return;
        const label = `${evt.pair} ${evt.timeframe}`;
        setCurrentFetch(evt.status === "fetching" || evt.status === "waiting" || evt.status === "rate_limited" ? label : null);
        setScanProgress((s) => ({ ...s, [`${evt.pair}|${evt.timeframe}`]: { status: evt.status!, message: evt.message, updatedAt: Date.now() } }));
      };
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) if (line.trim()) handleEvent(JSON.parse(line));
        if (done) break;
      }
      if (buffer.trim()) handleEvent(JSON.parse(buffer));
      if (!data) throw new Error("Scan completed without a result");

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
      if (mode === "latest" && soundOn && (data.new_signals ?? 0) > 0) playBeep();
      lastSignalCountRef.current = (data.new_signals ?? 0);
    } catch (e) {
      setLastScan({
        when: new Date().toISOString(), new: 0, used: 0, today: budgetToday,
        mode, errors: [(e as Error).message], report: [],
      });
    } finally {
      setCurrentFetch(null);
      setScanning(false);
    }
  }

  // Server-side cron handles auto-scans every 15 min; no client interval needed.

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

  // Live news-risk check: any high-impact event within ±30min for a relevant currency.
  function newsRiskCheck(s: Signal): string | null {
    const ccys = s.pair === "XAU/USD" ? ["USD", "XAU"]
      : s.pair === "BTC/USD" ? ["USD"]
      : [s.pair.slice(0, 3), s.pair.slice(4, 7)];
    const t = Date.now();
    for (const e of todaysEvents) {
      if (!ccys.includes(e.currency)) continue;
      const dt = new Date(e.event_time).getTime();
      const diff = Math.round((dt - t) / 60000);
      if (Math.abs(diff) <= 30) {
        return `${e.title} (${e.currency}) ${diff >= 0 ? `in ${diff}m` : `${-diff}m ago`}`;
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

  // Server cron projected budget (every 15 min, ~14 calls per latest-mode scan)
  const autoCallsPerScan = 14;
  const scansPerDay = Math.floor((24 * 60) / CRON_INTERVAL_MIN);
  const projectedDaily = scansPerDay * autoCallsPerScan;

  // Risk exposure (open / In-Trade signals)
  const openOnly = signals.filter((s) => stageOf(s) === 2);
  const openRiskPct = openOnly.length * RISK_PER_TRADE_PCT;
  const correlationWarnings: string[] = [];
  for (const [a, b] of CORRELATIONS) {
    const sameDirOpen = openOnly.filter((s) => (s.pair === a || s.pair === b));
    const longs = sameDirOpen.filter((s) => s.direction === "Long");
    const shorts = sameDirOpen.filter((s) => s.direction === "Short");
    if (longs.length >= 2) correlationWarnings.push(`${a} + ${b} both LONG — correlated exposure`);
    if (shorts.length >= 2) correlationWarnings.push(`${a} + ${b} both SHORT — correlated exposure`);
  }
  const lastCron = scanRuns.find((r) => r.source === "cron" && r.finished_at) ?? scanRuns.find((r) => r.source === "cron");
  const nextCronAt = lastCron
    ? new Date(new Date(lastCron.started_at).getTime() + CRON_INTERVAL_MIN * 60_000)
    : null;

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

        {/* Server-side cron status pill */}
        <div className="mt-3 text-[10px] uppercase tracking-wider text-primary flex items-center gap-2 flex-wrap">
          {appSettings.paused ? (
            <>
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-bear" />
              <span className="text-bear font-bold">CRON PAUSED</span>
              <span className="text-muted-foreground normal-case">· toggle in Settings to resume</span>
            </>
          ) : (
            <>
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
              SERVER CRON · every {CRON_INTERVAL_MIN}m · {appSettings.trading_hours_start_utc}–{appSettings.trading_hours_end_utc} UTC · key #{appSettings.active_td_key} · ~{projectedDaily} calls/day · sound {soundOn ? "on" : "off"}
              {lastCron && (
                <span className="text-muted-foreground normal-case">
                  · last cron {timeAgo(lastCron.started_at)} ago
                  {nextCronAt && nextCronAt.getTime() > Date.now() && (
                    <> · next in ~{Math.max(0, Math.ceil((nextCronAt.getTime() - Date.now()) / 60000))}m</>
                  )}
                </span>
              )}
            </>
          )}
        </div>

        {scanning && (
          <div className="mt-4 border border-border rounded bg-card p-3 animate-fade-in">
            <div className="flex items-center justify-between gap-3 mb-2">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Live Scan</div>
              {currentFetch && <div className="text-[10px] uppercase tracking-wider text-primary animate-pulse">Now: {currentFetch}</div>}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1.5 text-xs font-mono">
              {PAIRS.flatMap((p) => scanTimeframes.map((tf) => {
                const item = scanProgress[`${p}|${tf}`] ?? { status: "pending" as ProgressStatus };
                const st = item.status;
                const active = st === "fetching" || st === "waiting" || st === "rate_limited";
                return (
                  <div key={`${p}|${tf}`} className="flex items-center gap-2 min-w-0" title={item.message}>
                    <span className={st === "done" || st === "cached" ? "text-bull" : st === "error" || st === "rate_limited" ? "text-chart-4" : active ? "text-primary animate-pulse" : "text-muted-foreground/50"}>
                      {st === "done" ? "✓" : st === "cached" ? "↺" : st === "error" ? "!" : active ? "◌" : "·"}
                    </span>
                    <span className={st === "pending" ? "text-muted-foreground/60 truncate" : "truncate"}>{p} {tf}</span>
                    {st === "cached" && <span className="text-[9px] text-bull uppercase">cached</span>}
                    {st === "fetching" && <span className="text-[9px] text-primary uppercase">fetching</span>}
                    {st === "waiting" && <span className="text-[9px] text-primary uppercase">queued</span>}
                    {st === "done" && <span className="text-[9px] text-bull uppercase">fresh</span>}
                    {st === "rate_limited" && <span className="text-[9px] text-chart-4 uppercase">429 retry</span>}
                  </div>
                );
              }))}
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

        <nav className="mt-6 flex gap-1 border-b border-border overflow-x-auto">
          {([
            ["signals", `SIGNALS (${pendingSignals.length}/${openSignals.length})`],
            ["edge", "EDGE"],
            ["history", "HISTORY"],
            ["health", "HEALTH"],
            ["settings", "SETTINGS"],
          ] as const).map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)}
              className={`px-4 py-2 text-xs uppercase tracking-wider font-semibold border-b-2 transition-colors whitespace-nowrap ${
                tab === k ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"
              }`}>
              {label}
            </button>
          ))}
        </nav>

        {tab === "signals" && (
          <>
            <RiskExposureWidget
              openSignals={openOnly}
              openRiskPct={openRiskPct}
              correlationWarnings={correlationWarnings}
            />
            <SignalList signals={signals} onStatus={setStatus} onPartial={markPartialTp1Be}
              exposureCheck={exposureCheck} newsRiskCheck={newsRiskCheck} />
          </>
        )}
        {tab === "edge" && <EdgePanel stats={stats} />}
        {tab === "history" && <HistoryPanel signals={signals} />}
        {tab === "health" && (
          <HealthPanel
            scanRuns={scanRuns}
            cacheRows={cacheRows}
            budgetToday={budgetToday}
            lastCron={lastCron ?? null}
            nextCronAt={nextCronAt}
            appSettings={appSettings}
            todaysEvents={todaysEvents}
          />
        )}
        {tab === "settings" && (
          <SettingsPanel
            soundOn={soundOn} setSoundOn={setSoundOn}
            projectedDaily={projectedDaily}
            appSettings={appSettings}
            saveAppSettings={saveAppSettings}
            refreshNewsCalendar={refreshNewsCalendar}
            todaysEvents={todaysEvents}
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
  signals, onStatus, onPartial, exposureCheck, newsRiskCheck,
}: {
  signals: Signal[];
  onStatus: (s: Signal, status: StatusKey) => void;
  onPartial: (s: Signal) => void;
  exposureCheck: (s: Signal) => string | null;
  newsRiskCheck: (s: Signal) => string | null;
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
          warning={s.status === "pending" || s.status === "executed" ? exposureCheck(s) : null}
          newsRisk={s.status === "pending" || s.status === "executed" ? newsRiskCheck(s) : null} />
      ))}
    </div>
  );
}

function SignalRow({
  s, onStatus, onPartial, warning, newsRisk,
}: {
  s: Signal;
  onStatus: (s: Signal, status: StatusKey) => void;
  onPartial: (s: Signal) => void;
  warning: string | null;
  newsRisk: string | null;
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
      {newsRisk && (
        <div className="mt-2 text-[11px] text-destructive bg-destructive/10 border border-destructive/30 rounded px-2 py-1">
          ⚠ News Risk · {newsRisk} — signal suppressed by 30-min blackout
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
  soundOn, setSoundOn, projectedDaily,
  appSettings, saveAppSettings, refreshNewsCalendar, todaysEvents,
}: {
  soundOn: boolean; setSoundOn: (v: boolean) => void;
  projectedDaily: number;
  appSettings: AppSettings;
  saveAppSettings: (patch: Partial<AppSettings>) => Promise<void>;
  refreshNewsCalendar: () => Promise<void>;
  todaysEvents: EconomicEvent[];
}) {
  void refreshNewsCalendar; void todaysEvents;
  return (
    <div className="mt-4 space-y-3">
      <div className="border border-border rounded bg-card p-4">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-3">Server-Side Scan Engine</div>
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold">
              {appSettings.paused ? "Scanner Paused" : "Scanner Running"}
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">
              {appSettings.paused
                ? "Cron job exits immediately. No API calls are made."
                : `Auto-scans every ${CRON_INTERVAL_MIN} minutes server-side.`}
            </div>
          </div>
          <button
            onClick={() => saveAppSettings({ paused: !appSettings.paused })}
            className={`px-3 py-1.5 rounded text-xs font-bold uppercase tracking-wider border transition-colors ${
              appSettings.paused
                ? "bg-bull/15 text-bull border-bull/40 hover:bg-bull/25"
                : "bg-bear/15 text-bear border-bear/40 hover:bg-bear/25"
            }`}
          >
            {appSettings.paused ? "▶ Resume Scanner" : "⏸ Pause Scanner"}
          </button>
        </div>
        <div className="mt-2 text-xs text-muted-foreground">
          Browser tab does not need to be open. Estimated{" "}
          <span className="text-foreground font-semibold">{projectedDaily}</span> API calls/day.
          Use ▶ SCAN at the top for an on-demand full scan.
        </div>
      </div>


      <div className="border border-border rounded bg-card p-4">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-3">Notifications</div>
        <div className="flex items-center justify-between">
          <span className="text-sm">Sound on new signal (browser)</span>
          <Toggle on={soundOn} onChange={setSoundOn} />
        </div>
        <div className="mt-2 text-xs text-muted-foreground">
          Telegram alerts are sent server-side whenever a new signal is saved (if bot token + chat ID are configured).
        </div>
      </div>

      <div className="border border-border rounded bg-card p-4 text-xs text-muted-foreground space-y-1">
        <div className="text-[10px] uppercase tracking-wider mb-2">Risk Rules</div>
        <div>• Max {MAX_CONCURRENT} concurrent open trades</div>
        <div>• EUR/USD ↔ GBP/USD: max 1 same-direction</div>
        <div>• GBP/JPY ↔ EUR/JPY: max 1 same-direction</div>
        <div>• XAU/USD: independent</div>
        <div>• Spreads: USD majors 1.2p · crosses 2.5p · XAU/USD $0.40 · BTC/USD $2.00</div>
      </div>
    </div>
  );
}

function RiskExposureWidget({
  openSignals, openRiskPct, correlationWarnings,
}: {
  openSignals: Signal[];
  openRiskPct: number;
  correlationWarnings: string[];
}) {
  const overCap = openSignals.length >= MAX_CONCURRENT;
  const meterPct = Math.min(100, (openSignals.length / MAX_CONCURRENT) * 100);
  const meterColor = overCap ? "var(--bear)" : openSignals.length >= 2 ? "var(--chart-4)" : "var(--bull)";
  return (
    <div className="mt-4 border border-border rounded bg-card p-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Open Risk Exposure</div>
        <div className="text-xs text-muted-foreground">
          Notional <span className="text-foreground">${NOTIONAL_ACCOUNT.toLocaleString()}</span>
          {" · "}{RISK_PER_TRADE_PCT}% per trade
        </div>
      </div>
      <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
        <div className="bg-secondary/40 px-2 py-1.5 rounded">
          <div className="text-[9px] uppercase text-muted-foreground tracking-wider">Open Trades</div>
          <div className="font-semibold text-base" style={{ color: overCap ? "var(--bear)" : "var(--foreground)" }}>
            {openSignals.length} / {MAX_CONCURRENT}
          </div>
        </div>
        <div className="bg-secondary/40 px-2 py-1.5 rounded">
          <div className="text-[9px] uppercase text-muted-foreground tracking-wider">Total Risk</div>
          <div className="font-semibold text-base">{openRiskPct.toFixed(1)}%</div>
        </div>
        <div className="bg-secondary/40 px-2 py-1.5 rounded">
          <div className="text-[9px] uppercase text-muted-foreground tracking-wider">$ At Risk</div>
          <div className="font-semibold text-base">
            ${((openRiskPct / 100) * NOTIONAL_ACCOUNT).toFixed(0)}
          </div>
        </div>
      </div>
      <div className="mt-2 w-full h-1 bg-secondary rounded overflow-hidden">
        <div className="h-full transition-all" style={{ width: `${meterPct}%`, backgroundColor: meterColor }} />
      </div>
      {correlationWarnings.length > 0 && (
        <div className="mt-2 space-y-1">
          {correlationWarnings.map((w, i) => (
            <div key={i} className="text-[11px] text-chart-4 bg-chart-4/10 border border-chart-4/30 rounded px-2 py-1">
              ⚠ {w}
            </div>
          ))}
        </div>
      )}
      {openSignals.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {openSignals.map((s) => (
            <span key={s.id} className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${
              s.direction === "Long" ? "bg-bull/15 text-bull" : "bg-bear/15 text-bear"
            }`}>
              {s.direction === "Long" ? "▲" : "▼"} {s.pair}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function HealthPanel({
  scanRuns, cacheRows, budgetToday, lastCron, nextCronAt,
  appSettings, todaysEvents,
}: {
  scanRuns: ScanRun[];
  cacheRows: CacheRow[];
  budgetToday: number;
  lastCron: ScanRun | null;
  nextCronAt: Date | null;
  appSettings: AppSettings;
  todaysEvents: EconomicEvent[];
}) {
  void appSettings; void todaysEvents;
  // Status: green if last cron < 20min ago & ok; amber if < 40min; red otherwise
  const lastCronAgeMin = lastCron ? (Date.now() - new Date(lastCron.started_at).getTime()) / 60000 : Infinity;
  const lastOk = lastCron?.ok ?? false;
  const status: "green" | "amber" | "red" =
    lastCron && lastOk && lastCronAgeMin < 20 ? "green"
    : lastCron && lastCronAgeMin < 40 ? "amber"
    : "red";
  const statusColor = status === "green" ? "var(--bull)" : status === "amber" ? "var(--chart-4)" : "var(--bear)";
  const statusLabel = status === "green" ? "HEALTHY" : status === "amber" ? "DEGRADED" : "STALLED";
  const budgetPct = Math.min(100, (budgetToday / DAILY_BUDGET) * 100);

  // Group cache rows by pair
  const cacheByPair: Record<string, Record<string, string>> = {};
  for (const c of cacheRows) {
    if (!cacheByPair[c.pair]) cacheByPair[c.pair] = {};
    cacheByPair[c.pair][c.timeframe] = c.fetched_at;
  }

  return (
    <div className="mt-4 space-y-3">
      <div className="border border-border rounded bg-card p-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Scan Engine Status</div>
          <div className="flex items-center gap-2">
            <span className="inline-block w-2 h-2 rounded-full animate-pulse" style={{ backgroundColor: statusColor }} />
            <span className="text-xs font-bold tracking-wider" style={{ color: statusColor }}>{statusLabel}</span>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
          <div className="bg-secondary/40 px-2 py-1.5 rounded">
            <div className="text-[9px] uppercase text-muted-foreground tracking-wider">Last Cron</div>
            <div className="font-semibold">{lastCron ? `${timeAgo(lastCron.started_at)} ago` : "—"}</div>
          </div>
          <div className="bg-secondary/40 px-2 py-1.5 rounded">
            <div className="text-[9px] uppercase text-muted-foreground tracking-wider">Next Cron</div>
            <div className="font-semibold">
              {nextCronAt
                ? (nextCronAt.getTime() > Date.now()
                    ? `~${Math.max(0, Math.ceil((nextCronAt.getTime() - Date.now()) / 60000))}m`
                    : "due now")
                : "—"}
            </div>
          </div>
          <div className="bg-secondary/40 px-2 py-1.5 rounded">
            <div className="text-[9px] uppercase text-muted-foreground tracking-wider">API Today</div>
            <div className="font-semibold">{budgetToday} / {DAILY_BUDGET}</div>
            <div className="w-full h-1 mt-1 bg-secondary rounded overflow-hidden">
              <div className="h-full" style={{
                width: `${budgetPct}%`,
                backgroundColor: budgetPct > 85 ? "var(--bear)" : budgetPct > 60 ? "var(--chart-4)" : "var(--bull)",
              }}/>
            </div>
          </div>
          <div className="bg-secondary/40 px-2 py-1.5 rounded">
            <div className="text-[9px] uppercase text-muted-foreground tracking-wider">Interval</div>
            <div className="font-semibold">{CRON_INTERVAL_MIN}m</div>
          </div>
        </div>
      </div>

      <div className="border border-border rounded bg-card p-4">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">Per-Pair Cache Freshness</div>
        <div className="space-y-1 text-xs font-mono">
          {PAIRS.map((p) => (
            <div key={p} className="flex items-center gap-3 flex-wrap border-b border-border/40 py-1 last:border-b-0">
              <span className="font-bold w-20">{p}</span>
              {(["5m", "15m", "1h"] as const).map((tf) => {
                const at = cacheByPair[p]?.[tf];
                const ageMin = at ? (Date.now() - new Date(at).getTime()) / 60000 : null;
                const ttl = tf === "5m" ? 10 : tf === "15m" ? 15 : 60;
                const fresh = ageMin !== null && ageMin < ttl;
                return (
                  <span key={tf} className="flex items-center gap-1">
                    <span className="text-muted-foreground text-[10px] uppercase">{tf}</span>
                    <span className={ageMin === null ? "text-muted-foreground/60" : fresh ? "text-bull" : "text-chart-4"}>
                      {ageMin === null ? "—" : `${ageMin.toFixed(1)}m`}
                    </span>
                  </span>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      <div className="border border-border rounded bg-card p-4">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">Recent Scan Runs (last 20)</div>
        <div className="space-y-1 text-xs font-mono">
          {scanRuns.length === 0 && <div className="text-muted-foreground">No scan runs recorded yet.</div>}
          {scanRuns.map((r) => (
            <div key={r.id} className="flex items-center gap-3 flex-wrap border-b border-border/40 py-1 last:border-b-0">
              <span className={r.ok ? "text-bull" : "text-bear"}>{r.ok ? "✓" : "✗"}</span>
              <span className="text-foreground">{new Date(r.started_at).toISOString().slice(11, 19)} UTC</span>
              <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-secondary/60 text-muted-foreground">{r.source}</span>
              <span className="text-[10px] uppercase text-muted-foreground">{r.mode}</span>
              <span>new <span className="text-primary font-semibold">{r.new_signals}</span></span>
              <span>used <span className="text-foreground">{r.api_calls_used}</span></span>
              {Array.isArray(r.errors) && r.errors.length > 0 && (
                <span className="text-bear truncate max-w-md">⚠ {String(r.errors[0]).slice(0, 80)}</span>
              )}
            </div>
          ))}
        </div>
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
