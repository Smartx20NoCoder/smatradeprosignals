// Executes a MetaApi order for a given signal id.
// - Auto-selects market / limit / stop based on entry vs current price
// - Idempotent: refuses to re-execute a signal that already has a position/order id.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  checkSecret,
  corsHeaders,
  getSymbolPrice,
  pairToSymbol,
  placeOrder,
  safeError,
  type MarketOrderAction,
  type PendingOrderAction,
} from "../_shared/metaapi.ts";

async function markFailed(supabase: any, signalId: string, error: string) {
  await supabase.from("signals").update({
    metaapi_execution_status: "failed",
    metaapi_execution_error: error.slice(0, 500),
  }).eq("id", signalId);
}

function pickAction(
  direction: "Long" | "Short",
  entry: number,
  bid: number,
  ask: number,
): { action: MarketOrderAction | PendingOrderAction; openPrice?: number; kind: "market" | "limit" | "stop" } {
  // Tolerance ~0.03% of mid — accounts for normal spread; tighter than that is "market".
  const mid = (bid + ask) / 2 || entry;
  const tol = Math.max(mid * 0.0003, 0.0001);

  if (direction === "Long") {
    if (entry > ask + tol) return { action: "ORDER_TYPE_BUY_STOP", openPrice: entry, kind: "stop" };
    if (entry < bid - tol) return { action: "ORDER_TYPE_BUY_LIMIT", openPrice: entry, kind: "limit" };
    return { action: "ORDER_TYPE_BUY", kind: "market" };
  } else {
    if (entry < bid - tol) return { action: "ORDER_TYPE_SELL_STOP", openPrice: entry, kind: "stop" };
    if (entry > ask + tol) return { action: "ORDER_TYPE_SELL_LIMIT", openPrice: entry, kind: "limit" };
    return { action: "ORDER_TYPE_SELL", kind: "market" };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const unauth = checkSecret(req);
  if (unauth) return unauth;

  try {
    const { signal_id } = await req.json().catch(() => ({}));
    if (!signal_id || typeof signal_id !== "string") {
      return safeError("signal_id required", 400);
    }
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const [{ data: signal }, { data: cfg }] = await Promise.all([
      supabase.from("signals").select("*").eq("id", signal_id).maybeSingle(),
      supabase.from("app_settings").select("*").eq("id", "singleton").maybeSingle(),
    ]);
    if (!signal) return safeError("signal not found", 404);
    if ((signal as any).metaapi_position_id || (signal as any).metaapi_order_id) {
      return new Response(JSON.stringify({ ok: true, skipped: "already executed" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const autoTrade = !!(cfg as any)?.metaapi_auto_trade;
    const accountId = (cfg as any)?.metaapi_account_id as string | null;
    const region = ((cfg as any)?.metaapi_region as string | null) ?? "new-york";
    const minConf = Number((cfg as any)?.metaapi_min_confidence ?? 75);
    const minRR = Number((cfg as any)?.metaapi_min_rr ?? 2);
    const lot = Number((cfg as any)?.metaapi_fixed_lot ?? 0.01);
    const symbolSuffix = ((cfg as any)?.metaapi_symbol_suffix as string | null) ?? "";
    const token = Deno.env.get("METAAPI_TOKEN");

    if (!autoTrade) {
      return new Response(JSON.stringify({ ok: false, reason: "auto-trade disabled" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!token || !accountId) {
      await markFailed(supabase, signal_id, "MetaApi not configured (token or account ID missing)");
      return new Response(JSON.stringify({ ok: false, reason: "missing config" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const s: any = signal;
    if (Number(s.confidence) < minConf || Number(s.rr) < minRR) {
      return new Response(JSON.stringify({ ok: false, reason: "below threshold" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    await supabase.from("signals").update({
      metaapi_execution_status: "pending",
      metaapi_execution_error: null,
    }).eq("id", signal_id);

    const symbol = pairToSymbol(s.pair);
    const priceRes = await getSymbolPrice({ region, accountId, token, symbol });
    if (!priceRes.ok || !priceRes.bid || !priceRes.ask) {
      await markFailed(supabase, signal_id, priceRes.error ?? "price unavailable");
      return new Response(JSON.stringify({ ok: false, reason: priceRes.error ?? "price unavailable" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const entry = Number(s.entry);
    const picked = pickAction(s.direction, entry, priceRes.bid, priceRes.ask);

    const result = await placeOrder({
      region, accountId, token,
      actionType: picked.action,
      symbol,
      volume: lot,
      openPrice: picked.openPrice,
      stopLoss: Number(s.stop_loss),
      takeProfit: Number(s.tp2),
      comment: `sig ${String(signal_id).slice(0, 8)}`,
      clientId: String(signal_id).slice(0, 32),
    });

    if (!result.ok) {
      await markFailed(supabase, signal_id, result.error ?? "unknown error");
      return new Response(JSON.stringify({ ok: false, reason: result.error }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const data = result.data ?? {};
    const filled = !!data.positionId;
    await supabase.from("signals").update({
      metaapi_position_id: data.positionId ?? null,
      metaapi_order_id: data.orderId ?? null,
      metaapi_order_type: picked.kind,
      metaapi_execution_status: filled ? "filled" : "pending",
      metaapi_execution_error: null,
      executed_at: filled ? new Date().toISOString() : null,
      status: filled ? "executed" : "pending",
    }).eq("id", signal_id);

    return new Response(JSON.stringify({
      ok: true, kind: picked.kind, positionId: data.positionId, orderId: data.orderId,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    console.error("metaapi-execute error", e);
    return safeError("internal error executing order", 500);
  }
});
