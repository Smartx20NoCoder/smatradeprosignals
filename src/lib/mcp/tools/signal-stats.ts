import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";

export default defineTool({
  name: "signal_stats",
  title: "Signal performance stats",
  description:
    "Aggregate performance stats for ScalpEdge signals over a rolling window: total signals, win rate (TP1+), average R multiple, and breakdown by setup.",
  inputSchema: {
    days: z.number().int().min(1).max(90).optional().describe("Look-back window in days (default 7)."),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ days }) => {
    const { createClient } = await import("@supabase/supabase-js");
    const supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_PUBLISHABLE_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const since = new Date(Date.now() - (days ?? 7) * 86400_000).toISOString();
    const { data, error } = await supabase
      .from("signals")
      .select("setup,status,outcome_r,rr,confidence,created_at")
      .gte("created_at", since);
    if (error) {
      return { content: [{ type: "text", text: `Failed to load stats: ${error.message}` }], isError: true };
    }
    const rows = data ?? [];
    const total = rows.length;
    const closed = rows.filter((r) => r.outcome_r != null);
    const wins = closed.filter((r) => Number(r.outcome_r) > 0).length;
    const avgR = closed.length
      ? closed.reduce((s, r) => s + Number(r.outcome_r ?? 0), 0) / closed.length
      : 0;
    const bySetup: Record<string, { count: number; wins: number; avgR: number }> = {};
    for (const r of rows) {
      const s = String(r.setup ?? "unknown");
      const b = (bySetup[s] ??= { count: 0, wins: 0, avgR: 0 });
      b.count += 1;
      if (Number(r.outcome_r ?? 0) > 0) b.wins += 1;
      b.avgR += Number(r.outcome_r ?? 0);
    }
    for (const s of Object.keys(bySetup)) {
      bySetup[s].avgR = bySetup[s].count ? +(bySetup[s].avgR / bySetup[s].count).toFixed(3) : 0;
    }
    const summary = {
      window_days: days ?? 7,
      total_signals: total,
      closed_signals: closed.length,
      win_rate: closed.length ? +(wins / closed.length).toFixed(3) : 0,
      avg_r: +avgR.toFixed(3),
      by_setup: bySetup,
    };
    return {
      content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
      structuredContent: summary,
    };
  },
});
