// Fetches today's high-impact economic events from the free ForexFactory
// weekly JSON mirror and stores them in economic_events for the news blackout.
// High-impact filter: NFP, CPI, FOMC / rate decisions (Fed/BOE/ECB/BOJ), GDP.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-fn-secret",
};

const FF_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";

const HIGH_IMPACT_PATTERNS: RegExp[] = [
  /non[- ]?farm/i, /\bNFP\b/i,
  /\bCPI\b/i, /consumer price/i,
  /\bFOMC\b/i, /fed (?:funds|interest|rate)/i, /federal funds/i,
  /interest rate decision/i, /rate decision/i, /rate statement/i, /bank rate/i,
  /\bBOE\b/i, /\bBOJ\b/i, /\bECB\b/i,
  /\bGDP\b/i, /gross domestic/i,
];

const CCY_WHITELIST = new Set(["USD", "EUR", "GBP", "JPY", "XAU"]);

function isHighImpact(title: string, impact: string): boolean {
  if (impact?.toLowerCase() !== "high") return false;
  return HIGH_IMPACT_PATTERNS.some((re) => re.test(title));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const expected = Deno.env.get("INTERNAL_FN_SECRET");
  if (!expected || req.headers.get("x-fn-secret") !== expected) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  try {
    const r = await fetch(FF_URL, { headers: { "User-Agent": "scalpedge/1.0" } });
    if (!r.ok) throw new Error(`Calendar source HTTP ${r.status}`);
    const list = await r.json() as Array<{
      title: string; country: string; date: string; impact: string;
    }>;
    const today = new Date().toISOString().slice(0, 10);
    const todays = list.filter((e) => {
      if (!e.date) return false;
      const d = new Date(e.date);
      return d.toISOString().slice(0, 10) === today;
    });
    const rows = todays
      .filter((e) => CCY_WHITELIST.has(e.country) && isHighImpact(e.title, e.impact))
      .map((e) => ({
        event_time: new Date(e.date).toISOString(),
        currency: e.country,
        title: e.title,
        impact: "high",
        source: "forexfactory",
      }));
    // Wipe today + reinsert (idempotent)
    const dayStart = `${today}T00:00:00Z`;
    const dayEnd = `${today}T23:59:59Z`;
    await supabase.from("economic_events")
      .delete().gte("event_time", dayStart).lte("event_time", dayEnd);
    if (rows.length) {
      await supabase.from("economic_events").upsert(rows, {
        onConflict: "event_time,currency,title",
      });
    }
    return new Response(JSON.stringify({ ok: true, inserted: rows.length, sample: rows.slice(0, 5) }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: (e as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
