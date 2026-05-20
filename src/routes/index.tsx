import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";

export const Route = createFileRoute("/")({
  component: ScalpEdge,
});

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
  order_type: string | null;
  candle_time: string | null;
  spread_pips: number | null;
  notes: string | null;
};

type ReportCheck = {
  setup: string;
  status: "qualified" | "filtered" | "none";
  reason?: string;
  direction?: string;
};
type PairReport = {
  pair: string;
  cached: boolean;
  candle_time?: string;
  checks: ReportCheck[];
};
type ScanResult = {
  when: string;
  new: number;
  used: number;
  today: number;
  errors: string[];
  report: PairReport[];
};

const STATUSES = ["pending", "tp1", "tp2", "be", "loss"] as const;
const DAILY_BUDGET = 800;
const PAIRS = ["EUR/USD", "GBP/USD", "USD/JPY", "GBP/JPY", "EUR/JPY", "GBP/CHF", "USD/CHF"];

function fmtPrice(p: number, pair: string) {
  const decimals = pair.includes("JPY") ? 3 : 5;
  return p.toFixed(decimals);
}
function fmtCandle(iso: string | null, tf: string) {
  if (!iso) return "—";
  const d = new Date(iso);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${tf} candle · ${hh}:${mm} UTC`;
}
function timeAgo(iso: string) {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function ScalpEdge() {
  const [signals, setSignals] = useState<Signal[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState<Record<string, "pending" | "checking" | "done">>({});
  const [lastScan, setLastScan] = useState<ScanResult | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [budgetToday, setBudgetToday] = useState(0);
  const [tab, setTab] = useState<"signals" | "edge">("signals");
  const [now, setNow] = useState(Date.now());
  const autoResolvedRef = useRef(false);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);

  async function loadSignals() {
    const { data } = await supabase
      .from("signals")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(200);
    setSignals((data as Signal[]) ?? []);
    const today = new Date().toISOString().slice(0, 10);
    const { data: u } = await supabase
      .from("api_usage")
      .select("calls")
      .eq("day", today)
      .maybeSingle();
    setBudgetToday((u?.calls as number) ?? 0);
  }

  // Auto-resolve open signals on app open
  useEffect(() => {
    (async () => {
      await loadSignals();
      if (autoResolvedRef.current) return;
      autoResolvedRef.current = true;
      try {
        await supabase.functions.invoke("resolve-signals");
        await loadSignals();
      } catch {
        /* silent */
      }
    })();
  }, []);

  async function runScan() {
    setScanning(true);
    // Init progress
    const init: Record<string, "pending" | "checking" | "done"> = {};
    PAIRS.forEach((p) => (init[p] = "pending"));
    setScanProgress(init);

    // Animate sequential "checking" indicator while server crunches
    let cancelled = false;
    (async () => {
      for (const p of PAIRS) {
        if (cancelled) return;
        setScanProgress((s) => ({ ...s, [p]: "checking" }));
        await new Promise((r) => setTimeout(r, 280));
      }
    })();

    try {
      const { data, error } = await supabase.functions.invoke("scan-signals");
      if (error) throw error;
      cancelled = true;
      // Mark all done from report
      const done: Record<string, "pending" | "checking" | "done"> = {};
      PAIRS.forEach((p) => (done[p] = "done"));
      setScanProgress(done);
      const result: ScanResult = {
        when: new Date().toISOString(),
        new: data.new_signals ?? 0,
        used: data.api_calls_used ?? 0,
        today: data.api_calls_today ?? 0,
        errors: data.errors ?? [],
        report: data.report ?? [],
      };
      setLastScan(result);
      setReportOpen(true);
      setBudgetToday(data.api_calls_today ?? 0);
      await loadSignals();
    } catch (e) {
      cancelled = true;
      setLastScan({
        when: new Date().toISOString(),
        new: 0,
        used: 0,
        today: budgetToday,
        errors: [(e as Error).message],
        report: [],
      });
    } finally {
      setScanning(false);
    }
  }

  async function setOutcome(id: string, status: string) {
    await supabase.functions.invoke("update-signal", { body: { id, status } });
    await loadSignals();
  }

  const stats = useMemo(() => {
    const closed = signals.filter((s) => s.status !== "pending" && s.outcome_r !== null);
    const bySetup: Record<string, { n: number; wins: number; rSum: number }> = {};
    for (const s of closed) {
      const k = s.setup;
      if (!bySetup[k]) bySetup[k] = { n: 0, wins: 0, rSum: 0 };
      bySetup[k].n++;
      bySetup[k].rSum += s.outcome_r ?? 0;
      if ((s.outcome_r ?? 0) > 0) bySetup[k].wins++;
    }
    const summary = Object.entries(bySetup).map(([setup, v]) => ({
      setup,
      n: v.n,
      winRate: v.n ? (v.wins / v.n) * 100 : 0,
      avgR: v.n ? v.rSum / v.n : 0,
      expectancy: v.n ? v.rSum / v.n : 0,
    }));
    let cum = 0;
    const curve = [...closed]
      .sort((a, b) => +new Date(a.created_at) - +new Date(b.created_at))
      .map((s, i) => {
        cum += s.outcome_r ?? 0;
        return { i: i + 1, r: +cum.toFixed(2), date: s.created_at };
      });
    const totalR = cum;
    const totalN = closed.length;
    const wins = closed.filter((s) => (s.outcome_r ?? 0) > 0).length;
    return { summary, curve, totalR, totalN, winRate: totalN ? (wins / totalN) * 100 : 0 };
  }, [signals, now]);

  const pendingSignals = signals.filter((s) => s.status === "pending");
  const budgetPct = Math.min(100, (budgetToday / DAILY_BUDGET) * 100);

  return (
    <div className="min-h-screen scanline">
      <div className="mx-auto max-w-6xl px-4 py-6">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between border-b border-border pb-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">
              <span className="text-primary">▲</span> SCALPEDGE
            </h1>
            <p className="text-xs text-muted-foreground mt-1">
              FOREX SCALPING TERMINAL · 5M / 15M · 7 MAJORS
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-right">
              <div className="text-[10px] uppercase text-muted-foreground tracking-wider">
                API Budget
              </div>
              <div className="text-sm font-semibold">
                {budgetToday} / {DAILY_BUDGET}
              </div>
              <div className="w-32 h-1 mt-1 bg-secondary rounded overflow-hidden">
                <div
                  className="h-full transition-all"
                  style={{
                    width: `${budgetPct}%`,
                    backgroundColor:
                      budgetPct > 85 ? "var(--bear)" : budgetPct > 60 ? "var(--chart-4)" : "var(--bull)",
                  }}
                />
              </div>
            </div>
            <button
              onClick={runScan}
              disabled={scanning}
              className="px-5 py-3 bg-primary text-primary-foreground font-bold text-sm uppercase tracking-wider rounded hover:opacity-90 disabled:opacity-50 transition-opacity"
            >
              {scanning ? "SCANNING…" : "▶ SCAN"}
            </button>
          </div>
        </header>

        {/* Live progress while scanning */}
        {scanning && (
          <div className="mt-4 border border-border rounded bg-card p-3 animate-fade-in">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
              Live Scan
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 text-xs font-mono">
              {PAIRS.map((p) => {
                const st = scanProgress[p] ?? "pending";
                return (
                  <div key={p} className="flex items-center gap-2">
                    <span
                      className={
                        st === "done"
                          ? "text-bull"
                          : st === "checking"
                          ? "text-primary animate-pulse"
                          : "text-muted-foreground/50"
                      }
                    >
                      {st === "done" ? "✓" : st === "checking" ? "◌" : "·"}
                    </span>
                    <span className={st === "pending" ? "text-muted-foreground/60" : ""}>
                      {p}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Last scan banner */}
        {lastScan && !scanning && (
          <div className="mt-3 text-xs flex flex-wrap items-center gap-x-4 gap-y-1 text-muted-foreground">
            <span>
              LAST SCAN <span className="text-foreground">{timeAgo(lastScan.when)} ago</span>
            </span>
            <span>
              NEW <span className="text-primary font-semibold">{lastScan.new}</span>
            </span>
            <span>
              USED <span className="text-foreground">{lastScan.used}</span> credits
            </span>
            {lastScan.errors.length > 0 && (
              <span className="text-bear">
                {lastScan.errors.length} error(s): {lastScan.errors[0]}
              </span>
            )}
            {lastScan.report.length > 0 && (
              <button
                onClick={() => setReportOpen((o) => !o)}
                className="ml-auto px-2 py-1 text-[10px] uppercase tracking-wider border border-border rounded hover:border-primary/40 hover:text-foreground"
              >
                {reportOpen ? "▾ Hide" : "▸ Show"} Scan Report
              </button>
            )}
          </div>
        )}

        {/* Collapsible scan report */}
        {lastScan && reportOpen && lastScan.report.length > 0 && (
          <ScanReport report={lastScan.report} />
        )}

        <nav className="mt-6 flex gap-1 border-b border-border">
          {(
            [
              ["signals", `SIGNALS (${pendingSignals.length})`],
              ["edge", "EDGE"],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={`px-4 py-2 text-xs uppercase tracking-wider font-semibold border-b-2 transition-colors ${
                tab === k
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {label}
            </button>
          ))}
        </nav>

        {tab === "signals" && <SignalList signals={signals} onOutcome={setOutcome} />}
        {tab === "edge" && <EdgePanel stats={stats} />}

        <footer className="mt-12 text-center text-[10px] text-muted-foreground uppercase tracking-widest">
          Not financial advice · Mechanical edge tracking only · Prices spread-adjusted
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
              {p.cached && (
                <span className="px-1.5 py-0.5 text-[9px] uppercase rounded bg-secondary/60 text-muted-foreground">
                  cached
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
                  <span
                    className={
                      c.status === "qualified"
                        ? "text-bull"
                        : c.status === "filtered"
                        ? "text-chart-4"
                        : "text-muted-foreground/60"
                    }
                  >
                    {c.status === "qualified" ? "✓" : c.status === "filtered" ? "⊘" : "—"}
                  </span>
                  <span className="text-foreground/80">{c.setup}</span>
                  {c.direction && (
                    <span className="text-muted-foreground">({c.direction})</span>
                  )}
                  {c.reason && (
                    <span className="text-muted-foreground italic">— {c.reason}</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SignalList({
  signals,
  onOutcome,
}: {
  signals: Signal[];
  onOutcome: (id: string, status: string) => void;
}) {
  if (signals.length === 0) {
    return (
      <div className="mt-10 text-center text-muted-foreground py-16 border border-dashed border-border rounded">
        <div className="text-sm">NO SIGNALS YET</div>
        <div className="text-xs mt-1">Hit ▶ SCAN to scan all 7 pairs on 5m + 15m</div>
      </div>
    );
  }
  return (
    <div className="mt-4 space-y-2">
      {signals.map((s) => (
        <SignalRow key={s.id} s={s} onOutcome={onOutcome} />
      ))}
    </div>
  );
}

function SignalRow({
  s,
  onOutcome,
}: {
  s: Signal;
  onOutcome: (id: string, status: string) => void;
}) {
  const long = s.direction === "Long";
  const closed = s.status !== "pending";
  const orderType = s.order_type ?? (long ? "Buy Limit" : "Sell Limit");
  return (
    <div
      className={`border rounded p-3 transition-colors ${
        closed ? "bg-card/40 border-border/60 opacity-70" : "bg-card border-border hover:border-primary/40"
      }`}
    >
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <span
            className={`px-2 py-0.5 text-xs font-bold rounded ${
              long ? "bg-bull/15 text-bull" : "bg-bear/15 text-bear"
            }`}
          >
            {long ? "▲ LONG" : "▼ SHORT"}
          </span>
          <span className="font-bold text-base">{s.pair}</span>
          <span className="text-xs text-muted-foreground">{s.timeframe}</span>
          <span className="text-xs text-muted-foreground">·</span>
          <span className="text-xs text-foreground/80">{s.setup}</span>
          <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-primary/15 text-primary uppercase tracking-wider">
            {orderType}
          </span>
          {s.news_flag && (
            <span className="px-1.5 py-0.5 text-[10px] font-bold rounded bg-destructive/20 text-destructive">
              NEWS
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 text-xs">
          <span className="text-muted-foreground">SCORE</span>
          <span className="font-semibold">{s.session_score}</span>
          <span className="text-muted-foreground">CONF</span>
          <span
            className="font-semibold"
            style={{ color: s.confidence >= 75 ? "var(--bull)" : s.confidence >= 60 ? "var(--chart-4)" : "var(--muted-foreground)" }}
          >
            {s.confidence}%
          </span>
          <span className="text-muted-foreground">{timeAgo(s.created_at)}</span>
        </div>
      </div>

      <div className="mt-1.5 flex items-center gap-3 text-[10px] text-muted-foreground uppercase tracking-wider">
        <span>{fmtCandle(s.candle_time, s.timeframe)}</span>
        {s.spread_pips != null && <span>· spread {s.spread_pips}p applied</span>}
        {s.notes?.includes("auto-resolved") && (
          <span className="text-primary">· auto-resolved</span>
        )}
      </div>

      <div className="mt-2 grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs">
        <Cell label="ENTRY" value={fmtPrice(s.entry, s.pair)} />
        <Cell label="SL" value={fmtPrice(s.stop_loss, s.pair)} color="bear" />
        <Cell label="TP1" value={fmtPrice(s.tp1, s.pair)} color="bull" />
        <Cell label="TP2" value={fmtPrice(s.tp2, s.pair)} color="bull" />
        <Cell label="R:R" value={`1 : ${s.rr.toFixed(1)}`} />
      </div>

      <div className="mt-3 flex items-center gap-1.5 flex-wrap">
        {STATUSES.map((st) => (
          <button
            key={st}
            onClick={() => onOutcome(s.id, st)}
            className={`px-2 py-1 text-[10px] uppercase tracking-wider rounded border transition-colors ${
              s.status === st
                ? st === "tp1" || st === "tp2"
                  ? "bg-bull/20 border-bull text-bull"
                  : st === "loss"
                  ? "bg-bear/20 border-bear text-bear"
                  : "bg-primary/20 border-primary text-primary"
                : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/40"
            }`}
          >
            {st}
          </button>
        ))}
        {s.outcome_r !== null && (
          <span
            className="ml-auto text-xs font-bold"
            style={{ color: s.outcome_r > 0 ? "var(--bull)" : s.outcome_r < 0 ? "var(--bear)" : "var(--muted-foreground)" }}
          >
            {s.outcome_r > 0 ? "+" : ""}
            {s.outcome_r.toFixed(2)}R
          </span>
        )}
      </div>
    </div>
  );
}

function Cell({ label, value, color }: { label: string; value: string; color?: "bull" | "bear" }) {
  return (
    <div className="flex flex-col bg-secondary/40 px-2 py-1 rounded">
      <span className="text-[9px] uppercase text-muted-foreground tracking-wider">{label}</span>
      <span className={`font-semibold ${color === "bull" ? "text-bull" : color === "bear" ? "text-bear" : ""}`}>
        {value}
      </span>
    </div>
  );
}

function EdgePanel({
  stats,
}: {
  stats: {
    summary: { setup: string; n: number; winRate: number; avgR: number; expectancy: number }[];
    curve: { i: number; r: number }[];
    totalR: number;
    totalN: number;
    winRate: number;
  };
}) {
  return (
    <div className="mt-4 space-y-4">
      <div className="grid grid-cols-3 gap-2">
        <KPI label="CLOSED" value={stats.totalN.toString()} />
        <KPI
          label="WIN RATE"
          value={`${stats.winRate.toFixed(1)}%`}
          color={stats.winRate >= 50 ? "bull" : "bear"}
        />
        <KPI
          label="TOTAL R"
          value={`${stats.totalR >= 0 ? "+" : ""}${stats.totalR.toFixed(2)}R`}
          color={stats.totalR >= 0 ? "bull" : "bear"}
        />
      </div>

      <div className="bg-card border border-border rounded p-3">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
          P&L CURVE (R, cumulative)
        </div>
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
                <Tooltip
                  contentStyle={{
                    backgroundColor: "var(--card)",
                    border: "1px solid var(--border)",
                    fontSize: 11,
                  }}
                />
                <Line type="monotone" dataKey="r" stroke="var(--primary)" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      <div className="bg-card border border-border rounded p-3">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-3">
          BY SETUP
        </div>
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
                  <td
                    className="text-right font-semibold"
                    style={{ color: r.avgR >= 0 ? "var(--bull)" : "var(--bear)" }}
                  >
                    {r.avgR >= 0 ? "+" : ""}
                    {r.avgR.toFixed(2)}R
                  </td>
                  <td
                    className="text-right"
                    style={{ color: r.expectancy >= 0 ? "var(--bull)" : "var(--bear)" }}
                  >
                    {r.expectancy >= 0 ? "+" : ""}
                    {r.expectancy.toFixed(2)}R
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
      <div
        className="text-xl font-bold mt-1"
        style={{ color: color === "bull" ? "var(--bull)" : color === "bear" ? "var(--bear)" : undefined }}
      >
        {value}
      </div>
    </div>
  );
}
