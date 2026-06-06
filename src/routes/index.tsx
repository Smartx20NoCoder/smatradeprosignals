import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { TablesUpdate } from "@/integrations/supabase/types";
import {
  pingMetaApiFn,
  refreshNewsCalendarFn,
  testTradeMetaApiFn,
  updateAppSettingsFn,
} from "@/lib/api.functions";
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
  metaapi_position_id?: string | null;
  metaapi_order_id?: string | null;
  metaapi_execution_status?: string | null;
  metaapi_execution_error?: string | null;
  metaapi_filled_price?: number | null;
  metaapi_pnl?: number | null;
  paper_status?: string | null;
  paper_hit?: string | null;
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
  metaapi_account_id: string | null;
  metaapi_region: string;
  metaapi_auto_trade: boolean;
  metaapi_min_confidence: number;
  metaapi_min_rr: number;
  metaapi_fixed_lot: number;
  metaapi_risk_per_trade_pct: number;
  metaapi_min_lot: number;
  metaapi_max_lot: number;
  metaapi_is_cent_account: boolean;
  metaapi_max_trades: number;
  metaapi_expiry_hours: number;
  metaapi_max_daily_loss_pct: number;
  metaapi_symbol_suffix: string;
  metaapi_connected_at: string | null;
  metaapi_token_configured: boolean;
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
  const [tab, setTab] = useState<"signals" | "edge" | "history" | "news" | "health" | "settings">("signals");
  const [newsDate, setNewsDate] = useState<string>(() => new Date().toISOString().slice(0, 10));
  const [newsEvents, setNewsEvents] = useState<EconomicEvent[]>([]);
  const [newsLoading, setNewsLoading] = useState(false);
  const [newsError, setNewsError] = useState<string | null>(null);
  const [newsRefreshing, setNewsRefreshing] = useState(false);
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
    metaapi_account_id: null, metaapi_region: "new-york", metaapi_auto_trade: false,
    metaapi_min_confidence: 75, metaapi_min_rr: 2, metaapi_fixed_lot: 0.01,
    metaapi_risk_per_trade_pct: 2, metaapi_min_lot: 0.01, metaapi_max_lot: 0.10,
    metaapi_max_trades: 3, metaapi_expiry_hours: 24, metaapi_max_daily_loss_pct: 5,
    metaapi_symbol_suffix: "",
    metaapi_connected_at: null,
    metaapi_token_configured: false,
    metaapi_is_cent_account: false,
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
      .order("created_at", { ascending: false }).limit(1000);
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
    // Reads now go through a safe security-definer RPC that hides metaapi_account_id.
    const { data: cfgRows } = await (supabase as any).rpc("get_app_settings_public");
    const cfg = Array.isArray(cfgRows) ? cfgRows[0] : cfgRows;
    if (cfg) setAppSettings({
      paused: !!cfg.paused,
      trading_hours_start_utc: Number(cfg.trading_hours_start_utc ?? 1),
      trading_hours_end_utc: Number(cfg.trading_hours_end_utc ?? 20),
      active_td_key: Number(cfg.active_td_key ?? 1),
      session_config: (cfg.session_config as SessionConfig) ?? DEFAULT_SESSION_CONFIG,
      // metaapi_account_id is never sent to the browser; show only "configured" boolean via panel
      metaapi_account_id: cfg.metaapi_configured ? "(configured)" : null,
      metaapi_region: (cfg.metaapi_region as string) ?? "new-york",
      metaapi_auto_trade: !!cfg.metaapi_auto_trade,
      metaapi_min_confidence: Number(cfg.metaapi_min_confidence ?? 75),
      metaapi_min_rr: Number(cfg.metaapi_min_rr ?? 2),
      metaapi_fixed_lot: Number(cfg.metaapi_fixed_lot ?? 0.01),
      metaapi_risk_per_trade_pct: Number(cfg.metaapi_risk_per_trade_pct ?? 2),
      metaapi_min_lot: Number(cfg.metaapi_min_lot ?? 0.01),
      metaapi_max_lot: Number(cfg.metaapi_max_lot ?? 0.10),
      metaapi_max_trades: Number(cfg.metaapi_max_trades ?? 3),
      metaapi_expiry_hours: Number(cfg.metaapi_expiry_hours ?? 24),
      metaapi_max_daily_loss_pct: Number(cfg.metaapi_max_daily_loss_pct ?? 5),
      metaapi_symbol_suffix: (cfg.metaapi_symbol_suffix as string | null) ?? "",
      metaapi_connected_at: (cfg.metaapi_connected_at as string | null) ?? null,
      metaapi_token_configured: !!cfg.metaapi_token_configured,
    });
    const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart.getTime() + 24 * 3600_000);
    const { data: ev } = await (supabase as any).from("economic_events")
      .select("*").gte("event_time", dayStart.toISOString()).lt("event_time", dayEnd.toISOString())
      .order("event_time", { ascending: true });
    setTodaysEvents((ev as EconomicEvent[]) ?? []);
  }

  async function saveAppSettings(patch: Partial<AppSettings>) {
    const prev = appSettings;
    const next = { ...appSettings, ...patch };
    setAppSettings(next);
    try {
      await updateAppSettingsFn({ data: patch as Record<string, unknown> });
    } catch (err) {
      console.error("saveAppSettings failed", err);
      setAppSettings(prev);
      alert(err instanceof Error ? err.message : "Failed to save settings");
    }
  }

  async function refreshNewsCalendar() {
    setNewsRefreshing(true);
    setNewsError(null);
    try {
      await refreshNewsCalendarFn({ data: { source: "manual", date: newsDate } });
      // Re-load events for current date after refresh
      await loadNewsEvents(newsDate);
      await loadHealth();
    } catch (err) {
      console.error("refreshNewsCalendar error", err);
      setNewsError(err instanceof Error ? err.message : "Failed to refresh calendar");
    } finally {
      setNewsRefreshing(false);
    }
  }

  async function loadNewsEvents(day: string) {
    setNewsLoading(true);
    try {
      const dayStart = new Date(`${day}T00:00:00Z`);
      const dayEnd = new Date(dayStart.getTime() + 24 * 3600_000);
      const { data, error } = await (supabase as any).from("economic_events")
        .select("*")
        .gte("event_time", dayStart.toISOString())
        .lt("event_time", dayEnd.toISOString())
        .order("event_time", { ascending: true });
      if (error) throw error;
      setNewsEvents((data as EconomicEvent[]) ?? []);
    } catch (err) {
      console.error("loadNewsEvents error", err);
      setNewsEvents([]);
      setNewsError(err instanceof Error ? err.message : "Failed to load events");
    } finally {
      setNewsLoading(false);
    }
  }

  useEffect(() => {
    loadSignals();
    loadHealth();
    // Poll the database every 30s for cron-created signals and health stats
    const t = setInterval(() => { loadSignals(); loadHealth(); }, 30000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await loadNewsEvents(newsDate);
      if (cancelled) return;
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newsDate]);

  async function runScan(mode: "full" | "latest" = "full") {
    setScanning(true);
    // Server always fetches all 3 timeframes now (1h cache is TTL-protected),
    // so progress UI must match — otherwise 1h progress events become orphans.
    const activeTfs = [...TFS];
    setScanTimeframes(activeTfs);
    const init: Record<string, ProgressItem> = {};
    PAIRS.forEach((p) => activeTfs.forEach((tf) => (init[`${p}|${tf}`] = { status: "pending" })));
    setScanProgress(init);
    setCurrentFetch(null);
    try {
      // Proxied through TanStack server route — INTERNAL_FN_SECRET stays server-side.
      const res = await fetch(`/api/internal/scan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
    const risk = Math.abs(s.entry - s.stop_loss);
    let outcome_r: number | null = null;
    if (risk > 0) {
      if (status === "tp1") outcome_r = Math.abs(s.tp1 - s.entry) / risk;
      else if (status === "tp2") outcome_r = Math.abs(s.tp2 - s.entry) / risk;
      else if (status === "loss") outcome_r = -1;
      else if (status === "be" || status === "expired") outcome_r = 0;
    }
    const update: TablesUpdate<"signals"> = { status };
    if (status === "pending") {
      update.outcome_r = null; update.closed_at = null; update.executed_at = null; update.partial_close = false;
    } else if (status === "executed") {
      update.outcome_r = null; update.closed_at = null;
      update.executed_at = new Date().toISOString();
    } else {
      update.outcome_r = outcome_r;
      update.closed_at = new Date().toISOString();
    }
    const { error } = await supabase.from("signals").update(update).eq("id", s.id);
    if (error) { console.error("setStatus failed", error); alert(`Failed to update status: ${error.message}`); return; }
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
    if (open.length >= (appSettings.metaapi_max_trades ?? 3)) {
      return `Hard cap: ${appSettings.metaapi_max_trades ?? 3} concurrent open trades already`;
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
  }, [signals]);

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
            ["news", "NEWS"],
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
              maxTrades={appSettings.metaapi_max_trades ?? 3}
            />
            <SignalList signals={signals} onStatus={setStatus} onPartial={markPartialTp1Be}
              exposureCheck={exposureCheck} newsRiskCheck={newsRiskCheck} />
          </>
        )}
        {tab === "edge" && <EdgePanel stats={stats} />}
        {tab === "history" && <HistoryPanel signals={signals} />}
        {tab === "news" && (
          <NewsPanel
            events={newsEvents}
            date={newsDate}
            setDate={setNewsDate}
            pairs={PAIRS}
            onRefresh={refreshNewsCalendar}
            loading={newsLoading}
            refreshing={newsRefreshing}
            error={newsError}
          />
        )}
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
  const PAGE = 50;
  const [page, setPage] = useState(0);
  const totalPages = Math.max(1, Math.ceil(signals.length / PAGE));
  const cur = Math.min(page, totalPages - 1);
  const slice = signals.slice(cur * PAGE, cur * PAGE + PAGE);
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
      {slice.map((s) => (
        <SignalRow key={s.id} s={s} onStatus={onStatus} onPartial={onPartial}
          warning={s.status === "pending" || s.status === "executed" ? exposureCheck(s) : null}
          newsRisk={s.status === "pending" || s.status === "executed" ? newsRiskCheck(s) : null} />
      ))}
      {signals.length > PAGE && (
        <div className="flex items-center justify-between gap-3 pt-3 text-xs">
          <button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={cur === 0}
            className="px-3 py-1.5 border border-border rounded uppercase tracking-wider disabled:opacity-40 hover:border-primary/40">
            ← Prev
          </button>
          <span className="text-muted-foreground uppercase tracking-wider">
            Page {cur + 1} / {totalPages} · {signals.length} signals
          </span>
          <button onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))} disabled={cur >= totalPages - 1}
            className="px-3 py-1.5 border border-border rounded uppercase tracking-wider disabled:opacity-40 hover:border-primary/40">
            Next →
          </button>
        </div>
      )}
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
          {s.metaapi_position_id && (
            <span className="px-1.5 py-0.5 text-[9px] uppercase rounded bg-primary/20 text-primary font-bold"
              title={`Position ${s.metaapi_position_id}${s.metaapi_filled_price ? ` @ ${s.metaapi_filled_price}` : ""}`}>
              ⚡ MT {s.metaapi_pnl != null ? `${s.metaapi_pnl >= 0 ? "+" : ""}${s.metaapi_pnl.toFixed(2)}` : "live"}
            </span>
          )}
          {s.metaapi_execution_status === "failed" && (
            <span className="px-1.5 py-0.5 text-[9px] uppercase rounded bg-destructive/20 text-destructive font-bold">
              MT FAILED
            </span>
          )}
          {s.metaapi_execution_status === "failed" && s.metaapi_execution_error && (
            <span className="text-[10px] text-destructive block mt-0.5 truncate max-w-[240px]" title={s.metaapi_execution_error}>
              ↳ {s.metaapi_execution_error}
            </span>
          )}
          {s.paper_status === "triggered" && (!s.metaapi_execution_status || s.metaapi_execution_status === "none") && (
            <span className="px-1.5 py-0.5 text-[9px] uppercase rounded bg-muted text-muted-foreground font-bold">TRIGGERED</span>
          )}
          {(!s.metaapi_execution_status || s.metaapi_execution_status === "none") && s.paper_status && (() => {
            const ps = s.paper_status;
            const cls =
              ps === "tp1_hit" ? "bg-bull/20 text-bull" :
              ps === "tp2_hit" ? "bg-bull/30 text-bull" :
              ps === "sl_hit" ? "bg-destructive/20 text-destructive" :
              "bg-muted text-muted-foreground";
            const label =
              ps === "tp1_hit" ? "TP1 ✓" :
              ps === "tp2_hit" ? "TP2 ✓" :
              ps === "sl_hit" ? "SL ✗" :
              ps === "expired" ? "EXPIRED" : "TRACKING";
            return (
              <span className={`px-1.5 py-0.5 text-[9px] uppercase rounded font-bold ${cls}`}
                title={s.paper_hit ? `Hit at ${new Date(s.paper_hit).toLocaleString()}` : "Paper-tracked"}>
                {label}
              </span>
            );
          })()}
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

      <TradingHoursPanel appSettings={appSettings} saveAppSettings={saveAppSettings} />

      <div className="border border-border rounded bg-card p-4">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-3">TwelveData API Key</div>
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold">
              Active: Key #{appSettings.active_td_key}
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">
              Manually switch which TwelveData API key the scanner uses for all data fetches.
            </div>
          </div>
          <div className="flex gap-1 border border-border rounded overflow-hidden">
            {[1, 2].map((k) => {
              const active = appSettings.active_td_key === k;
              return (
                <button
                  key={k}
                  onClick={() => {
                    try { localStorage.setItem("active_td_key", String(k)); } catch { /* ignore */ }
                    saveAppSettings({ active_td_key: k });
                  }}
                  className={`px-3 py-1.5 text-xs font-bold uppercase tracking-wider transition-colors ${
                    active
                      ? "bg-primary text-primary-foreground"
                      : "bg-transparent text-muted-foreground hover:bg-muted"
                  }`}
                >
                  Key {k}{active ? " ●" : ""}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <MetaApiPanel appSettings={appSettings} saveAppSettings={saveAppSettings} />



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
        <div>• Max {appSettings.metaapi_max_trades} concurrent open trades</div>
        <div>• EUR/USD ↔ GBP/USD: max 1 same-direction</div>
        <div>• GBP/JPY ↔ EUR/JPY: max 1 same-direction</div>
        <div>• XAU/USD: independent</div>
        <div>• Spreads: USD majors 1.2p · crosses 2.5p · XAU/USD $0.40 · BTC/USD $2.00</div>
      </div>
    </div>
  );
}

function TokenField({ configured, onSave }: { configured: boolean; onSave: (value: string) => Promise<void> }) {
  const [editing, setEditing] = useState(!configured);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (!configured) setEditing(true); }, [configured]);

  async function save() {
    if (value.trim().length < 20) {
      alert("Token looks too short — paste the full MetaApi token.");
      return;
    }
    setSaving(true);
    try {
      await onSave(value.trim());
      setValue("");
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="border border-border rounded bg-background/40 px-3 py-2">
      <div className="flex items-center justify-between gap-2 mb-1">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">MetaApi Token</div>
        {configured && !editing && (
          <div className="flex items-center gap-2">
            <span className="px-1.5 py-0.5 text-[9px] uppercase rounded bg-bull/20 text-bull font-bold">Configured ✓</span>
            <button onClick={() => setEditing(true)}
              className="text-[10px] uppercase tracking-wider px-2 py-0.5 border border-border rounded hover:bg-muted/50">
              Change
            </button>
          </div>
        )}
      </div>
      {editing ? (
        <div className="flex items-center gap-2">
          <input type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)}
            placeholder="Paste MetaApi token (JWT)"
            className="flex-1 bg-background border border-border rounded px-2 py-1.5 text-xs font-mono" />
          <button onClick={save} disabled={saving}
            className="text-[10px] uppercase tracking-wider px-3 py-1.5 border border-border rounded bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50">
            {saving ? "Saving..." : "Save"}
          </button>
          {configured && (
            <button onClick={() => { setEditing(false); setValue(""); }}
              className="text-[10px] uppercase tracking-wider px-2 py-1.5 border border-border rounded hover:bg-muted/50">
              Cancel
            </button>
          )}
        </div>
      ) : null}
      <div className="text-[10px] text-muted-foreground mt-1">
        Stored privately in app settings. Falls back to the <code className="text-foreground">METAAPI_TOKEN</code> env secret if unset.
      </div>
    </div>
  );
}

function MetaApiPanel({
  appSettings, saveAppSettings,
}: {
  appSettings: AppSettings;
  saveAppSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const [accountId, setAccountId] = useState(appSettings.metaapi_account_id ?? "");
  const [region, setRegion] = useState(appSettings.metaapi_region);
  const [status, setStatus] = useState<{ ok: boolean; reason?: string; account?: any } | null>(null);
  const [testing, setTesting] = useState(false);
  const [testTrading, setTestTrading] = useState(false);
  const [testTradeResult, setTestTradeResult] = useState<{
    ok: boolean;
    steps: Array<{ label: string; detail: string; ok: boolean; error?: string }>;
    summary: string;
  } | null>(null);

  useEffect(() => { setAccountId(appSettings.metaapi_account_id ?? ""); }, [appSettings.metaapi_account_id]);
  useEffect(() => { setRegion(appSettings.metaapi_region); }, [appSettings.metaapi_region]);

  async function ping() {
    setTesting(true);
    try {
      const j = await pingMetaApiFn({});
      setStatus(j as any);
    } catch (e) {
      setStatus({ ok: false, reason: (e as Error).message });
    } finally {
      setTesting(false);
    }
  }

  // Poll connection status every 30s
  useEffect(() => {
    if (!appSettings.metaapi_account_id) return;
    ping();
    const t = setInterval(ping, 30000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appSettings.metaapi_account_id, appSettings.metaapi_region]);

  const connected = !!status?.ok;
  const acct = status?.account;
  const isDemo = acct?.type ? /demo/i.test(String(acct.type)) : true;

  return (
    <div className="border border-border rounded bg-card p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">MetaApi Auto-Trading</div>
        <div className="flex items-center gap-2">
          {isDemo && connected && (
            <span className="px-1.5 py-0.5 text-[9px] uppercase rounded bg-chart-4/20 text-chart-4 font-bold">DEMO</span>
          )}
          <span className={`px-2 py-0.5 text-[10px] uppercase tracking-wider rounded font-bold ${
            connected ? "bg-bull/20 text-bull" : "bg-bear/20 text-bear"
          }`}>
            {connected ? "● CONNECTED" : "○ DISCONNECTED"}
          </span>
        </div>
      </div>

      {!connected && status?.reason && (
        <div className="text-[11px] text-bear bg-bear/10 border border-bear/30 rounded px-2 py-1">{status.reason}</div>
      )}
      {connected && acct && (
        <div className="text-[11px] text-muted-foreground grid grid-cols-3 gap-2">
          <div>Broker: <span className="text-foreground">{acct.broker ?? "—"}</span></div>
          <div>Balance: <span className="text-foreground">{Number(acct.balance ?? 0).toFixed(2)} {acct.currency ?? ""}</span></div>
          <div>Equity: <span className="text-foreground">{Number(acct.equity ?? 0).toFixed(2)}</span></div>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <label className="text-xs">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Account ID</div>
          <input value={accountId} onChange={(e) => setAccountId(e.target.value)}
            onBlur={() => { if (accountId !== (appSettings.metaapi_account_id ?? "")) saveAppSettings({ metaapi_account_id: accountId || null }); }}
            placeholder="e.g. 12abc34d-5678-..." className="w-full bg-background border border-border rounded px-2 py-1.5 text-xs font-mono" />
        </label>
        <label className="text-xs">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Region</div>
          <select value={region} onChange={(e) => { setRegion(e.target.value); saveAppSettings({ metaapi_region: e.target.value }); }}
            className="w-full bg-background border border-border rounded px-2 py-1.5 text-xs">
            <option value="new-york">new-york</option>
            <option value="london">london</option>
            <option value="singapore">singapore</option>
          </select>
        </label>
      </div>

      <label className="text-xs block">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Broker Symbol Suffix</div>
        <input
          value={appSettings.metaapi_symbol_suffix}
          onChange={(e) => {
            const cleaned = e.target.value.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 16);
            saveAppSettings({ metaapi_symbol_suffix: cleaned });
          }}
          placeholder="e.g. 'm' for Exness (leave blank for none)"
          className="w-full bg-background border border-border rounded px-2 py-1.5 text-xs font-mono"
        />
        <div className="text-[10px] text-muted-foreground mt-1">
          Appended to every symbol sent to MetaApi (e.g. <code>EURUSD</code> → <code>EURUSD{appSettings.metaapi_symbol_suffix || "m"}</code>). Required for brokers that suffix symbols.
        </div>
      </label>

      <TokenField
        configured={appSettings.metaapi_token_configured}
        onSave={async (value) => {
          await saveAppSettings({ metaapi_token: value } as any);
          // Refresh status after token change so connected badge updates.
          setTimeout(() => { ping(); }, 250);
        }}
      />


      <div className="flex items-center justify-between border-t border-border pt-3">
        <div>
          <div className="text-sm font-semibold">Auto-execute new signals</div>
          <div className="text-xs text-muted-foreground">Only signals meeting the thresholds below will be fired automatically.</div>
        </div>
        <Toggle on={appSettings.metaapi_auto_trade} onChange={(v) => saveAppSettings({ metaapi_auto_trade: v })} />
      </div>

      <div className="grid grid-cols-3 gap-2">
        <label className="text-xs">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Min Confidence (%)</div>
          <input type="number" min={50} max={99} step={1} value={appSettings.metaapi_min_confidence}
            onChange={(e) => saveAppSettings({ metaapi_min_confidence: Math.max(50, Math.min(99, Number(e.target.value) || 75)) })}
            className="w-full bg-background border border-border rounded px-2 py-1.5 text-xs font-mono" />
        </label>
        <label className="text-xs">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Min R:R</div>
          <input type="number" min={1} max={10} step={0.1} value={appSettings.metaapi_min_rr}
            onChange={(e) => saveAppSettings({ metaapi_min_rr: Math.max(1, Math.min(10, Number(e.target.value) || 2)) })}
            className="w-full bg-background border border-border rounded px-2 py-1.5 text-xs font-mono" />
        </label>
        <label className="text-xs">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Risk Per Trade (%)</div>
          <input type="number" min={0.1} max={10} step={0.1} value={appSettings.metaapi_risk_per_trade_pct}
            onChange={(e) => saveAppSettings({ metaapi_risk_per_trade_pct: Math.max(0.1, Math.min(10, Number(e.target.value) || 2)) })}
            className="w-full bg-background border border-border rounded px-2 py-1.5 text-xs font-mono" />
        </label>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <label className="text-xs">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Min Lot</div>
          <input type="number" min={0.01} max={1} step={0.01} value={appSettings.metaapi_min_lot}
            onChange={(e) => saveAppSettings({ metaapi_min_lot: Math.max(0.01, Math.min(1, Number(e.target.value) || 0.01)) })}
            className="w-full bg-background border border-border rounded px-2 py-1.5 text-xs font-mono" />
        </label>
        <label className="text-xs">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Max Lot</div>
          <input type="number" min={0.01} max={10} step={0.01} value={appSettings.metaapi_max_lot}
            onChange={(e) => saveAppSettings({ metaapi_max_lot: Math.max(0.01, Math.min(10, Number(e.target.value) || 0.10)) })}
            className="w-full bg-background border border-border rounded px-2 py-1.5 text-xs font-mono" />
        </label>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <label className="text-xs">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Max Open Trades</div>
          <input type="number" min={1} max={50} step={1} value={appSettings.metaapi_max_trades}
            onChange={(e) => saveAppSettings({ metaapi_max_trades: Math.max(1, Math.min(50, Number(e.target.value) || 3)) })}
            className="w-full bg-background border border-border rounded px-2 py-1.5 text-xs font-mono" />
        </label>
        <label className="text-xs">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Pending Expiry (hours)</div>
          <input type="number" min={1} max={168} step={1} value={appSettings.metaapi_expiry_hours}
            onChange={(e) => saveAppSettings({ metaapi_expiry_hours: Math.max(1, Math.min(168, Number(e.target.value) || 24)) })}
            className="w-full bg-background border border-border rounded px-2 py-1.5 text-xs font-mono" />
        </label>
        <label className="text-xs">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Max Daily Loss (%)</div>
          <input type="number" min={0.1} max={100} step={0.1} value={appSettings.metaapi_max_daily_loss_pct}
            onChange={(e) => saveAppSettings({ metaapi_max_daily_loss_pct: Math.max(0.1, Math.min(100, Number(e.target.value) || 5)) })}
            className="w-full bg-background border border-border rounded px-2 py-1.5 text-xs font-mono" />
        </label>
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={ping} disabled={testing || !accountId}
            className="px-3 py-1.5 text-xs uppercase tracking-wider font-bold rounded border border-primary/60 text-primary hover:bg-primary/10 disabled:opacity-50">
            {testing ? "Testing…" : "Test Connection"}
          </button>
          <button
            onClick={async () => {
              setTestTrading(true);
              setTestTradeResult(null);
              try {
                const r = await testTradeMetaApiFn({});
                setTestTradeResult(r as any);
              } catch (e) {
                setTestTradeResult({
                  ok: false, steps: [],
                  summary: `Test failed: ${(e as Error).message}`,
                });
              } finally {
                setTestTrading(false);
              }
            }}
            disabled={testTrading || !accountId}
            className="px-3 py-1.5 text-xs uppercase tracking-wider font-bold rounded border border-chart-4/60 text-chart-4 hover:bg-chart-4/10 disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            {testTrading && (
              <span className="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
            )}
            {testTrading ? "Running…" : "Run Test Trade"}
          </button>
          {appSettings.metaapi_connected_at && (
            <span className="text-[10px] text-muted-foreground">last ping: {timeAgo(appSettings.metaapi_connected_at)}</span>
          )}
        </div>
        <div className="text-[10px] text-muted-foreground">
          Places a real 0.01 lot BTC/USD market order on your broker and immediately closes it. Uses live account — confirm demo mode before running.
        </div>

        {testTradeResult && (
          <div className="mt-2 border border-border rounded bg-background/50 p-3 space-y-1.5">
            {testTradeResult.steps.map((s, i) => (
              <div key={i} className="text-xs">
                <div className="flex items-start gap-2">
                  <span className={s.ok ? "text-bull" : "text-bear"}>{s.ok ? "✅" : "❌"}</span>
                  <div className="flex-1 min-w-0">
                    <div className="font-bold">{s.label}</div>
                    {s.detail && (
                      <div className="font-mono text-[10px] text-muted-foreground break-all">{s.detail}</div>
                    )}
                    {s.error && (
                      <div className="text-[11px] text-bear mt-0.5">{s.error}</div>
                    )}
                  </div>
                </div>
              </div>
            ))}
            <div className={`pt-2 border-t border-border text-xs font-bold ${testTradeResult.ok ? "text-bull" : "text-bear"}`}>
              {testTradeResult.summary}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}



function RiskExposureWidget({
  openSignals, openRiskPct, correlationWarnings, maxTrades,
}: {
  openSignals: Signal[];
  openRiskPct: number;
  correlationWarnings: string[];
  maxTrades: number;
}) {
  const overCap = openSignals.length >= maxTrades;
  const meterPct = Math.min(100, (openSignals.length / maxTrades) * 100);
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
            {openSignals.length} / {maxTrades}
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

// ---------- Trading Hours / Sessions ----------
const SESSION_LABELS: { key: keyof SessionConfig["sessions"]; label: string }[] = [
  { key: "sydney", label: "Sydney" },
  { key: "tokyo",  label: "Tokyo" },
  { key: "london", label: "London" },
  { key: "ny",     label: "New York" },
];
const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function hhmm(h: number) { return `${String(h).padStart(2, "0")}:00`; }
function parseHour(v: string): number {
  const n = parseInt(v.split(":")[0] ?? "0", 10);
  return isNaN(n) ? 0 : Math.max(0, Math.min(23, n));
}

function TradingHoursPanel({
  appSettings, saveAppSettings,
}: {
  appSettings: AppSettings;
  saveAppSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const cfg = appSettings.session_config ?? DEFAULT_SESSION_CONFIG;
  const updateCfg = (next: SessionConfig) => saveAppSettings({ session_config: next });
  const setSession = (k: keyof SessionConfig["sessions"], patch: Partial<SessionWindow>) => {
    updateCfg({ ...cfg, sessions: { ...cfg.sessions, [k]: { ...cfg.sessions[k], ...patch } } });
  };
  const setOverride = (dow: string, patch: { start: number; end: number } | null) => {
    const overrides = { ...(cfg.custom_overrides ?? {}) };
    if (patch === null) delete overrides[dow]; else overrides[dow] = patch;
    updateCfg({ ...cfg, custom_overrides: overrides });
  };

  return (
    <div className="border border-border rounded bg-card p-4">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Trading Hours</div>
          <div className="text-xs text-muted-foreground mt-1">
            All times UTC. Day overrides take priority over session windows.
          </div>
        </div>
        <label className="flex items-center gap-2 text-xs">
          <span className="uppercase tracking-wider">Scan only during active sessions</span>
          <Toggle on={cfg.scan_active_sessions_only} onChange={(v) => updateCfg({ ...cfg, scan_active_sessions_only: v })} />
        </label>
      </div>

      <div className="space-y-1.5">
        {SESSION_LABELS.map(({ key, label }) => {
          const w = cfg.sessions[key];
          return (
            <div key={key} className="flex items-center gap-3 flex-wrap border-b border-border/40 pb-1.5 last:border-b-0">
              <label className="flex items-center gap-2 min-w-32">
                <Toggle on={w.enabled} onChange={(v) => setSession(key, { enabled: v })} />
                <span className="text-sm font-semibold">{label}</span>
              </label>
              <div className="flex items-center gap-2 text-xs">
                <input type="time" step={3600} value={hhmm(w.start)}
                  onChange={(e) => setSession(key, { start: parseHour(e.target.value) })}
                  className="bg-secondary border border-border rounded px-2 py-1" />
                <span className="text-muted-foreground">to</span>
                <input type="time" step={3600} value={hhmm(w.end)}
                  onChange={(e) => setSession(key, { end: parseHour(e.target.value) })}
                  className="bg-secondary border border-border rounded px-2 py-1" />
                <span className="text-muted-foreground">UTC</span>
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-4">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">Custom Day Overrides</div>
        <div className="space-y-1">
          {DOW_LABELS.map((label, i) => {
            const dow = String(i);
            const ov = cfg.custom_overrides?.[dow] ?? null;
            return (
              <div key={dow} className="flex items-center gap-3 flex-wrap text-xs">
                <span className="w-10 font-semibold">{label}</span>
                <Toggle on={!!ov} onChange={(v) => setOverride(dow, v ? { start: 7, end: 20 } : null)} />
                {ov ? (
                  <>
                    <input type="time" step={3600} value={hhmm(ov.start)}
                      onChange={(e) => setOverride(dow, { ...ov, start: parseHour(e.target.value) })}
                      className="bg-secondary border border-border rounded px-2 py-1" />
                    <span className="text-muted-foreground">to</span>
                    <input type="time" step={3600} value={hhmm(ov.end)}
                      onChange={(e) => setOverride(dow, { ...ov, end: parseHour(e.target.value) })}
                      className="bg-secondary border border-border rounded px-2 py-1" />
                    <span className="text-muted-foreground">UTC (replaces sessions)</span>
                  </>
                ) : (
                  <span className="text-muted-foreground">Use session windows</span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ---------- History Panel ----------
function sessionOf(s: Signal): "London" | "New York" | "Asian" | "Off" {
  const h = new Date(s.created_at).getUTCHours();
  if (h >= 12 && h < 16) return "London"; // overlap counts as either; pick LDN by default
  if (h >= 7  && h < 12) return "London";
  if (h >= 16 && h < 21) return "New York";
  if (h >= 0  && h < 9)  return "Asian";
  if (h >= 22)           return "Asian";
  return "Off";
}

function HistoryPanel({ signals }: { signals: Signal[] }) {
  const closed = useMemo(
    () => signals.filter((s) => stageOf(s) === 3 && s.outcome_r !== null),
    [signals]
  );

  const [pairFilter, setPairFilter] = useState<string>("all");
  const [setupFilter, setSetupFilter] = useState<string>("all");
  const [sessionFilter, setSessionFilter] = useState<string>("all");
  const [minConfidence, setMinConfidence] = useState<string>("");
  const [openMonths, setOpenMonths] = useState<Record<string, boolean>>({});

  const pairs = useMemo(() => Array.from(new Set(closed.map((s) => s.pair))).sort(), [closed]);
  const setups = useMemo(() => Array.from(new Set(closed.map((s) => s.setup))).sort(), [closed]);
  const sessions = ["London", "New York", "Asian", "Off"];

  const filtered = useMemo(() => {
    const minC = minConfidence.trim() === "" ? null : Number(minConfidence);
    return closed.filter((s) =>
      (pairFilter === "all" || s.pair === pairFilter) &&
      (setupFilter === "all" || s.setup === setupFilter) &&
      (sessionFilter === "all" || sessionOf(s) === sessionFilter) &&
      (minC == null || Number.isNaN(minC) || s.confidence >= minC)
    );
  }, [closed, pairFilter, setupFilter, sessionFilter, minConfidence]);

  // Group by Month-Year (most recent first)
  type MonthGroup = { key: string; label: string; items: Signal[] };
  const groups: MonthGroup[] = useMemo(() => {
    const map = new Map<string, MonthGroup>();
    for (const s of filtered) {
      const d = new Date(s.created_at);
      // Use 1-indexed month so the key matches strategyTrends ("YYYY-MM").
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      const label = d.toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
      if (!map.has(key)) map.set(key, { key, label, items: [] });
      map.get(key)!.items.push(s);
    }
    return Array.from(map.values()).sort((a, b) => (a.key < b.key ? 1 : -1));
  }, [filtered]);

  // Equity curve (chronological)
  const curve = useMemo(() => {
    let cum = 0;
    return [...filtered]
      .sort((a, b) => +new Date(a.created_at) - +new Date(b.created_at))
      .map((s, i) => { cum += s.outcome_r ?? 0; return { i: i + 1, r: +cum.toFixed(2) }; });
  }, [filtered]);

  // Per-strategy win rate over time (per month)
  const strategyTrends = useMemo(() => {
    const m: Record<string, Record<string, { n: number; wins: number }>> = {};
    for (const s of filtered) {
      const d = new Date(s.created_at);
      const mo = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      m[s.setup] ??= {};
      m[s.setup][mo] ??= { n: 0, wins: 0 };
      m[s.setup][mo].n++;
      if ((s.outcome_r ?? 0) > 0) m[s.setup][mo].wins++;
    }
    const months = Array.from(new Set(Object.values(m).flatMap(Object.keys))).sort();
    const setupsList = Object.keys(m).sort();
    return { months, setups: setupsList, data: m };
  }, [filtered]);

  function exportCSV() {
    const headers = ["created_at", "pair", "timeframe", "setup", "direction", "entry", "stop_loss", "tp1", "tp2", "rr", "status", "outcome_r", "session"];
    const rows = filtered.map((s) => [
      s.created_at, s.pair, s.timeframe, s.setup, s.direction, s.entry, s.stop_loss, s.tp1, s.tp2, s.rr, s.status, s.outcome_r ?? "", sessionOf(s),
    ]);
    const csv = [headers, ...rows].map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `scalpedge-history-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click(); URL.revokeObjectURL(url);
  }

  if (closed.length === 0) {
    return (
      <div className="mt-10 text-center text-muted-foreground py-16 border border-dashed border-border rounded">
        <div className="text-sm">NO CLOSED SIGNALS YET</div>
        <div className="text-xs mt-1">Close out signals (TP/SL/BE) to build your history.</div>
      </div>
    );
  }

  return (
    <div className="mt-4 space-y-4">
      {/* Filters + export */}
      <div className="border border-border rounded bg-card p-3 flex items-center gap-2 flex-wrap text-xs">
        <span className="uppercase tracking-wider text-muted-foreground">Filters</span>
        <select value={pairFilter} onChange={(e) => setPairFilter(e.target.value)}
          className="bg-secondary border border-border rounded px-2 py-1">
          <option value="all">All pairs</option>
          {pairs.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <select value={setupFilter} onChange={(e) => setSetupFilter(e.target.value)}
          className="bg-secondary border border-border rounded px-2 py-1">
          <option value="all">All strategies</option>
          {setups.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={sessionFilter} onChange={(e) => setSessionFilter(e.target.value)}
          className="bg-secondary border border-border rounded px-2 py-1">
          <option value="all">All sessions</option>
          {sessions.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <label className="flex items-center gap-1 text-muted-foreground uppercase tracking-wider">
          <span>Conf %</span>
          <input
            type="number" min={0} max={100} placeholder="—"
            value={minConfidence}
            onChange={(e) => setMinConfidence(e.target.value)}
            className="w-16 bg-secondary border border-border rounded px-2 py-1 text-foreground"
          />
        </label>
        <button onClick={exportCSV}
          className="ml-auto px-3 py-1 border border-primary/40 text-primary rounded uppercase tracking-wider hover:bg-primary/10">
          ⬇ Export CSV
        </button>
      </div>

      {/* Equity curve */}
      <div className="bg-card border border-border rounded p-3">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">Equity Curve · {filtered.length} closed</div>
        <div className="h-56">
          {curve.length === 0 ? (
            <div className="h-full flex items-center justify-center text-muted-foreground text-xs">No data for these filters</div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={curve}>
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

      {/* Per-strategy trends */}
      <div className="bg-card border border-border rounded p-3">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">Strategy Win Rate by Month</div>
        {strategyTrends.setups.length === 0 ? (
          <div className="text-xs text-muted-foreground py-6 text-center">No data</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs font-mono">
              <thead>
                <tr className="border-b border-border text-muted-foreground text-[10px] uppercase tracking-wider">
                  <th className="text-left py-2 pr-3">Strategy</th>
                  {strategyTrends.months.map((m) => <th key={m} className="text-right px-2">{m}</th>)}
                </tr>
              </thead>
              <tbody>
                {strategyTrends.setups.map((setup) => (
                  <tr key={setup} className="border-b border-border/40">
                    <td className="py-1.5 pr-3 text-foreground">{setup}</td>
                    {strategyTrends.months.map((m) => {
                      const v = strategyTrends.data[setup][m];
                      if (!v) return <td key={m} className="text-right text-muted-foreground/50 px-2">—</td>;
                      const wr = (v.wins / v.n) * 100;
                      const color = wr >= 50 ? "var(--bull)" : "var(--bear)";
                      return <td key={m} className="text-right px-2" style={{ color }}>{wr.toFixed(0)}% <span className="text-muted-foreground">({v.n})</span></td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Month groups */}
      <div className="space-y-2">
        {groups.map((g) => {
          const wins = g.items.filter((s) => (s.outcome_r ?? 0) > 0).length;
          const wr = (wins / g.items.length) * 100;
          const avgR = g.items.reduce((a, s) => a + (s.outcome_r ?? 0), 0) / g.items.length;
          const pairTally: Record<string, number> = {};
          g.items.forEach((s) => { pairTally[s.pair] = (pairTally[s.pair] ?? 0) + 1; });
          const bestPair = Object.entries(pairTally).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "—";
          const open = !!openMonths[g.key];
          return (
            <div key={g.key} className="border border-border rounded bg-card">
              <button onClick={() => setOpenMonths((m) => ({ ...m, [g.key]: !m[g.key] }))}
                className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-secondary/30 flex-wrap">
                <span className="text-primary">{open ? "▾" : "▸"}</span>
                <span className="font-bold">{g.label}</span>
                <span className="text-xs text-muted-foreground">·</span>
                <span className="text-xs">{g.items.length} signals</span>
                <span className="text-xs text-muted-foreground">·</span>
                <span className="text-xs" style={{ color: wr >= 50 ? "var(--bull)" : "var(--bear)" }}>{wr.toFixed(0)}% win</span>
                <span className="text-xs text-muted-foreground">·</span>
                <span className="text-xs" style={{ color: avgR >= 0 ? "var(--bull)" : "var(--bear)" }}>
                  {avgR >= 0 ? "+" : ""}{avgR.toFixed(2)}R avg
                </span>
                <span className="text-xs text-muted-foreground">·</span>
                <span className="text-xs">best: {bestPair}</span>
              </button>
              {open && (
                <div className="border-t border-border px-3 py-2 space-y-1 text-xs font-mono">
                  {g.items.map((s) => (
                    <div key={s.id} className="flex items-center gap-2 flex-wrap py-1 border-b border-border/30 last:border-b-0">
                      <span className="text-muted-foreground w-32">{new Date(s.created_at).toISOString().slice(0, 16).replace("T", " ")} UTC</span>
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${s.direction === "Long" ? "bg-bull/15 text-bull" : "bg-bear/15 text-bear"}`}>
                        {s.direction === "Long" ? "▲" : "▼"} {s.pair}
                      </span>
                      <span className="text-muted-foreground">{s.timeframe}</span>
                      <span>{s.setup}</span>
                      <span className="text-muted-foreground uppercase text-[10px]">{s.status}</span>
                      <span className="ml-auto font-bold" style={{
                        color: (s.outcome_r ?? 0) > 0 ? "var(--bull)" : (s.outcome_r ?? 0) < 0 ? "var(--bear)" : "var(--muted-foreground)"
                      }}>
                        {(s.outcome_r ?? 0) > 0 ? "+" : ""}{(s.outcome_r ?? 0).toFixed(2)}R
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Currencies affected by a given pair (mirrors newsRiskCheck logic)
function pairCurrencies(pair: string): string[] {
  if (pair === "XAU/USD") return ["USD", "XAU"];
  if (pair === "BTC/USD") return ["USD"];
  return [pair.slice(0, 3), pair.slice(4, 7)];
}

function NewsPanel({
  events, date, setDate, pairs, onRefresh, loading, refreshing, error,
}: {
  events: EconomicEvent[];
  date: string;
  setDate: (d: string) => void;
  pairs: string[];
  onRefresh: () => Promise<void>;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const now = Date.now();

  // Blackout: any high-impact event within -30..+30 min of now (active),
  // or +0..+30 min upcoming. Map back to affected pairs.
  const blackouts = events
    .filter((e) => (e.impact ?? "").toLowerCase() === "high")
    .map((e) => {
      const diff = Math.round((new Date(e.event_time).getTime() - now) / 60000);
      const affected = pairs.filter((p) => pairCurrencies(p).includes(e.currency));
      return { e, diff, affected };
    })
    .filter((x) => x.diff >= -30 && x.diff <= 30 && x.affected.length > 0);

  const grouped = events.reduce<Record<string, EconomicEvent[]>>((acc, e) => {
    (acc[e.currency] = acc[e.currency] ?? []).push(e);
    return acc;
  }, {});
  const currencies = Object.keys(grouped).sort();

  return (
    <div className="mt-6 space-y-4 animate-fade-in">
      {blackouts.length > 0 && (
        <div className="border-2 border-bear bg-bear/10 rounded p-3">
          <div className="text-[10px] uppercase tracking-wider text-bear font-bold mb-2">
            ⚠ News Blackout {blackouts.some((b) => b.diff <= 0 && b.diff >= -30) ? "Active" : "Imminent"}
          </div>
          <ul className="space-y-1 text-xs">
            {blackouts.map((b, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-bear text-background">HIGH</span>
                <span className="font-semibold">{b.e.currency}</span>
                <span>{b.e.title}</span>
                <span className="text-muted-foreground">
                  {b.diff >= 0 ? `in ${b.diff}m` : `${-b.diff}m ago`}
                </span>
                <span className="ml-auto text-muted-foreground text-[10px]">
                  affects: {b.affected.join(", ")}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 border border-border rounded p-3 bg-card/60">
        <label className="text-[10px] uppercase tracking-wider text-muted-foreground">Date (UTC)</label>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="bg-background border border-border rounded px-2 py-1 text-xs"
        />
        <button
          onClick={() => setDate(today)}
          className="text-[10px] uppercase tracking-wider px-2 py-1 border border-border rounded hover:bg-muted"
        >
          Today
        </button>
        <button
          onClick={() => { void onRefresh(); }}
          disabled={refreshing}
          className="ml-auto text-[10px] uppercase tracking-wider px-3 py-1 border border-border rounded hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {refreshing ? "Refreshing…" : "Refresh Calendar"}
        </button>
        <span className="text-[10px] text-muted-foreground">
          {events.length} event{events.length === 1 ? "" : "s"}
        </span>
      </div>

      {error && (
        <div className="border border-bear bg-bear/10 rounded p-3 text-xs text-bear">
          {error}
        </div>
      )}

      {loading ? (
        <div className="border border-border rounded p-6 text-center text-sm text-muted-foreground bg-card/40">
          Loading events…
        </div>
      ) : currencies.length === 0 ? (
        <div className="border border-border rounded p-6 text-center text-sm text-muted-foreground bg-card/40 space-y-2">
          <div>No high-impact economic events for {date}.</div>
          <div className="text-[10px] text-muted-foreground/70">
            Try refreshing the calendar, or pick another date — bank holidays and weekends often have no scheduled releases.
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {currencies.map((ccy) => (
            <div key={ccy} className="border border-border rounded bg-card/60">
              <div className="px-3 py-2 border-b border-border flex items-center gap-2">
                <span className="font-mono text-sm font-bold">{ccy}</span>
                <span className="text-[10px] text-muted-foreground uppercase tracking-wider">
                  {grouped[ccy].length} event{grouped[ccy].length === 1 ? "" : "s"} ·
                  affects {pairs.filter((p) => pairCurrencies(p).includes(ccy)).join(", ") || "—"}
                </span>
              </div>
              <ul className="divide-y divide-border">
                {grouped[ccy].map((e) => {
                  const d = new Date(e.event_time);
                  const hh = String(d.getUTCHours()).padStart(2, "0");
                  const mm = String(d.getUTCMinutes()).padStart(2, "0");
                  const impact = (e.impact ?? "").toLowerCase();
                  const isHigh = impact === "high";
                  const badgeCls = isHigh
                    ? "bg-bear text-background"
                    : impact === "medium"
                      ? "bg-amber-500/80 text-background"
                      : "bg-muted text-muted-foreground";
                  return (
                    <li key={e.id} className="px-3 py-2 flex items-center gap-3 text-xs">
                      <span className="font-mono text-muted-foreground w-14">{hh}:{mm}</span>
                      <span className={`font-mono text-[10px] uppercase px-1.5 py-0.5 rounded ${badgeCls}`}>
                        {e.impact ?? "—"}
                      </span>
                      <span className="flex-1">{e.title}</span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}


