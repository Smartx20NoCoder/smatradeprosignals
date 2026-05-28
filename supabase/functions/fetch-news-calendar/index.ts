// Fetches high-impact economic events from the free ForexFactory weekly JSON
// mirror and stores them in economic_events for the news blackout / News tab.
// Accepts an optional `{ date: "YYYY-MM-DD" }` body to target a specific UTC day
// (defaults to today). All `High` impact events for whitelisted currencies are
// stored — the previous strict regex (NFP/CPI/FOMC/GDP only) was filtering out
// most events and leaving the table empty.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { checkInternalAuth } from "../_shared/auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-fn-secret",
};

const FF_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";

// Major currencies we care about. ForexFactory uses ISO codes in `country`.
const CCY_WHITELIST = new Set([
  "USD", "EUR", "GBP", "JPY", "CHF", "AUD", "CAD", "NZD",
]);

function isHighImpact(impact: string): boolean {
  return (impact ?? "").toLowerCase() === "high";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const unauth = checkInternalAuth(req);
  if (unauth) return unauth;
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  try {
    // Optional date param — defaults to today (UTC). Format: YYYY-MM-DD.
    let target = new Date().toISOString().slice(0, 10);
    try {
      const body = await req.json().catch(() => ({}));
      if (body && typeof body.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
        target = body.date;
      }
    } catch { /* no body */ }

    const r = await fetch(FF_URL, { headers: { "User-Agent": "scalpedge/1.0" } });
    if (!r.ok) throw new Error(`Calendar source HTTP ${r.status}`);
    const list = await r.json() as Array<{
      title: string; country: string; date: string; impact: string;
    }>;

    // Group by UTC day so we can wipe+reinsert each affected day idempotently.
    const byDay = new Map<string, Array<{ event_time: string; currency: string; title: string; impact: string; source: string }>>();
    for (const e of list) {
      if (!e?.date || !e?.country || !e?.title) continue;
      if (!CCY_WHITELIST.has(e.country)) continue;
      if (!isHighImpact(e.impact)) continue;
      const d = new Date(e.date);
      if (Number.isNaN(d.getTime())) continue;
      const day = d.toISOString().slice(0, 10);
      const row = {
        event_time: d.toISOString(),
        currency: e.country,
        title: e.title,
        impact: "high",
        source: "forexfactory",
      };
      const arr = byDay.get(day) ?? [];
      arr.push(row);
      byDay.set(day, arr);
    }

    // Always refresh the target day (even if empty, so callers see a clean slate).
    // Also refresh any other day present in the feed for this week so a single
    // refresh keeps the whole week up-to-date.
    const daysToRefresh = new Set<string>([target, ...byDay.keys()]);
    let totalInserted = 0;
    for (const day of daysToRefresh) {
      const dayStart = `${day}T00:00:00Z`;
      const dayEnd = `${day}T23:59:59Z`;
      await supabase.from("economic_events")
        .delete().gte("event_time", dayStart).lte("event_time", dayEnd);
      const rows = byDay.get(day) ?? [];
      if (rows.length) {
        await supabase.from("economic_events").upsert(rows, {
          onConflict: "event_time,currency,title",
        });
        totalInserted += rows.length;
      }
    }

    const sample = (byDay.get(target) ?? []).slice(0, 5);
    return new Response(JSON.stringify({
      ok: true,
      target_day: target,
      days_refreshed: daysToRefresh.size,
      inserted: totalInserted,
      inserted_for_target: (byDay.get(target) ?? []).length,
      sample,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    console.error("fetch-news-calendar error", e);
    return new Response(JSON.stringify({ ok: false, error: "Failed to fetch calendar" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
