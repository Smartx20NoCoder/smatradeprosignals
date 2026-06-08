// Auto-resolves open signals against latest cached candle data.
// Uses candle_cache only (no API spend). For each pending signal, walks candles
// after the signal creation and marks SL / TP1 / TP2 hits.
//
// IMPORTANT: A tp1→tp2 upgrade based on candle wicks alone is NOT trusted.
// The runner (Order B) must have actually closed at/near TP2 profitably via
// MetaApi. If Order B closed at breakeven (~0 profit) or there is no MetaApi
// execution data for this signal, the final status stays at tp1.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { checkInternalAuth } from "../_shared/auth.ts";
import { getHistoryDealsByPosition } from "../_shared/metaapi.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-fn-secret",
};

type Candle = { t: number; o: number; h: number; l: number; c: number };

// Verify Order B (the runner) actually closed at/near TP2 with positive profit.
async function confirmRunnerHitTP2(opts: {
  region: string; accountId: string; token: string;
  positionIdB: string; tp2: number; isLong: boolean;
}): Promise<boolean> {
  const res = await getHistoryDealsByPosition({
    region: opts.region, accountId: opts.accountId, token: opts.token,
    positionId: opts.positionIdB,
  });
  if (!res.ok || !res.data) return false;
  // Identify the closing deal(s) for position B and sum profit.
  const deals = res.data as any[];
  // OUT-type deals close the position.
  const closes = deals.filter((d) =>
    String(d?.entryType ?? "").toUpperCase().includes("OUT") ||
    String(d?.type ?? "").toUpperCase().includes("DEAL_TYPE_SELL") ||
    String(d?.type ?? "").toUpperCase().includes("DEAL_TYPE_BUY"),
  );
  if (closes.length === 0) return false;
  // If position is still open (no OUT deal), bail out.
  const hasOut = deals.some((d) => String(d?.entryType ?? "").toUpperCase().includes("OUT"));
  if (!hasOut) return false;
  const totalProfit = deals.reduce((acc, d) => acc + Number(d?.profit ?? 0), 0);
  if (!(totalProfit > 0)) return false;
  // Closing price near TP2 — within 0.1% tolerance, on the correct side.
  const tol = Math.max(Math.abs(opts.tp2) * 0.001, 1e-6);
  const closePrice = Number(
    closes[closes.length - 1]?.price ?? closes[closes.length - 1]?.closePrice ?? NaN,
  );
  if (!Number.isFinite(closePrice)) return false;
  if (opts.isLong) {
    return closePrice >= opts.tp2 - tol;
  } else {
    return closePrice <= opts.tp2 + tol;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const unauth = checkInternalAuth(req);
  if (unauth) return unauth;
  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Resolve MetaApi connection (used only to confirm runner closes).
    const { data: cfg } = await supabase
      .from("app_settings").select("*").eq("id", "singleton").maybeSingle();
    const c: any = cfg ?? {};
    const isLive = ((c?.metaapi_active_mode as string | null) ?? "demo") === "live";
    const accountId = isLive
      ? ((c?.metaapi_account_id_live as string | null) ?? (c?.metaapi_account_id as string | null))
      : (c?.metaapi_account_id as string | null);
    const region = isLive
      ? ((c?.metaapi_region_live as string | null) ?? (c?.metaapi_region as string | null) ?? "new-york")
      : ((c?.metaapi_region as string | null) ?? "new-york");
    const token = isLive
      ? ((c?.metaapi_token_live as string | null) || (c?.metaapi_token as string | null) || Deno.env.get("METAAPI_TOKEN") || null)
      : ((c?.metaapi_token as string | null) || Deno.env.get("METAAPI_TOKEN") || null);

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
      let tp2TouchedByCandle = false;

      for (const c of after) {
        if (long) {
          if (c.l <= s.stop_loss) { status = "loss"; outcome_r = -1; break; }
          if (c.h >= s.tp2) {
            // Candle touched TP2 — do NOT upgrade automatically. Tag it for
            // verification against the broker's runner close.
            tp2TouchedByCandle = true;
            if (status !== "tp1") {
              // TP2 was reached before TP1 was registered: still record as a
              // candidate tp1 fill so the next block can verify the runner.
              status = "tp1";
              outcome_r = Math.abs(s.tp1 - s.entry) / risk;
            }
            break;
          }
          if (c.h >= s.tp1) { status = "tp1"; outcome_r = Math.abs(s.tp1 - s.entry) / risk; }
        } else {
          if (c.h >= s.stop_loss) { status = "loss"; outcome_r = -1; break; }
          if (c.l <= s.tp2) {
            tp2TouchedByCandle = true;
            if (status !== "tp1") {
              status = "tp1";
              outcome_r = Math.abs(s.tp1 - s.entry) / risk;
            }
            break;
          }
          if (c.l <= s.tp1) { status = "tp1"; outcome_r = Math.abs(s.tp1 - s.entry) / risk; }
        }
      }

      // If the candle suggested tp2, only honour that upgrade with broker
      // confirmation that Order B (the runner) closed near tp2 profitably.
      if (status === "tp1" && tp2TouchedByCandle) {
        const positionIdB = (s as any).metaapi_position_id_b;
        if (positionIdB && accountId && token) {
          const confirmed = await confirmRunnerHitTP2({
            region: region!, accountId, token,
            positionIdB: String(positionIdB),
            tp2: Number(s.tp2),
            isLong: long,
          });
          if (confirmed) {
            status = "tp2";
            outcome_r = Math.abs(s.tp2 - s.entry) / risk;
          }
          // else: runner closed at BE or below tp2 → keep tp1.
        }
        // No MetaApi execution data → keep tp1 (cannot trust candle wick).
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
    console.error("resolve-signals error", e);
    return new Response(JSON.stringify({ error: "internal resolve error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
