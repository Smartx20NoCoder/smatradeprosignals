// Auto-resolves open signals against latest cached candle data.
// Uses candle_cache only (no API spend). For each pending signal, walks candles
// after the signal creation and marks SL / TP1 / TP2 hits.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type Candle = { t: number; o: number; h: number; l: number; c: number };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const expected = Deno.env.get("INTERNAL_FN_SECRET");
  if (!expected || req.headers.get("x-fn-secret") !== expected) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { data: pending } = await supabase
      .from("signals")
      .select("*")
      .eq("status", "pending");
    if (!pending || pending.length === 0) {
      return new Response(JSON.stringify({ resolved: 0, checked: 0 }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // preload caches per pair (5m only — finer granularity)
    const pairs = Array.from(new Set(pending.map((s: any) => s.pair)));
    const cacheMap: Record<string, Candle[]> = {};
    for (const pair of pairs) {
      const { data: c } = await supabase
        .from("candle_cache")
        .select("candles")
        .eq("pair", pair)
        .eq("timeframe", "5m")
        .maybeSingle();
      if (c) cacheMap[pair] = c.candles as Candle[];
    }

    let resolved = 0;
    for (const s of pending) {
      const candles = cacheMap[s.pair];
      if (!candles) continue;
      const startT = new Date(s.created_at).getTime();
      const after = candles.filter((c) => c.t > startT);
      if (after.length === 0) continue;

      let status: string | null = null;
      const long = s.direction === "Long";
      const risk = Math.abs(s.entry - s.stop_loss);
      let outcome_r: number | null = null;

      for (const c of after) {
        if (long) {
          // SL first if both hit (conservative)
          if (c.l <= s.stop_loss) { status = "loss"; outcome_r = -1; break; }
          if (c.h >= s.tp2) { status = "tp2"; outcome_r = Math.abs(s.tp2 - s.entry) / risk; break; }
          if (c.h >= s.tp1) { status = "tp1"; outcome_r = Math.abs(s.tp1 - s.entry) / risk; }
        } else {
          if (c.h >= s.stop_loss) { status = "loss"; outcome_r = -1; break; }
          if (c.l <= s.tp2) { status = "tp2"; outcome_r = Math.abs(s.tp2 - s.entry) / risk; break; }
          if (c.l <= s.tp1) { status = "tp1"; outcome_r = Math.abs(s.tp1 - s.entry) / risk; }
        }
      }
      if (status) {
        await supabase
          .from("signals")
          .update({
            status,
            outcome_r,
            closed_at: new Date().toISOString(),
            notes: (s.notes ?? "") + " [auto-resolved]",
          })
          .eq("id", s.id);
        resolved++;
      }
    }

    return new Response(JSON.stringify({ resolved, checked: pending.length }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
