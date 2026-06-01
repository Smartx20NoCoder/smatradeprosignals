// Executes a MetaApi order for a given signal id as TWO half-lot orders:
//   - Order A: closes at TP1
//   - Order B: runner to TP2 (sync moves SL to BE once A closes)
// Adds risk gates: max concurrent trades, daily loss limit, pending-order expiry.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  checkSecret,
  corsHeaders,
  getAccountInfo,
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

    const c: any = cfg ?? {};
    const autoTrade = !!c.metaapi_auto_trade;
    const accountId = c.metaapi_account_id as string | null;
    const region = (c.metaapi_region as string | null) ?? "new-york";
    const minConf = Number(c.metaapi_min_confidence ?? 75);
    const minRR = Number(c.metaapi_min_rr ?? 2);
    const lot = Number(c.metaapi_fixed_lot ?? 0.01);
    const maxTrades = Number(c.metaapi_max_trades ?? 3);
    const expiryHours = Number(c.metaapi_expiry_hours ?? 24);
    const maxDailyLossPct = Number(c.metaapi_max_daily_loss_pct ?? 5);
    const symbolSuffix = (c.metaapi_symbol_suffix as string | null) ?? "";
    const token = (c.metaapi_token as string | null) || Deno.env.get("METAAPI_TOKEN") || null;

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

    // Concurrent trades gate — count active signals (rows in DB, not broker positions).
    const { count: activeCount } = await supabase
      .from("signals")
      .select("id", { count: "exact", head: true })
      .in("metaapi_execution_status", ["filled", "partial", "order_pending"]);
    if ((activeCount ?? 0) >= maxTrades) {
      const msg = `max concurrent trades reached (${activeCount}/${maxTrades})`;
      await markFailed(supabase, signal_id, msg);
      return new Response(JSON.stringify({ ok: false, reason: msg }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    await supabase.from("signals").update({
      metaapi_execution_status: "pending",
      metaapi_execution_error: null,
    }).eq("id", signal_id);

    const health = await getAccountInfo({ region, accountId, token });
    if (!health.ok) {
      const msg = `Broker not reachable: ${health.error ?? "unknown"}`;
      await markFailed(supabase, signal_id, msg);
      return new Response(JSON.stringify({ ok: false, reason: msg }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Daily loss gate — sum today's closed pnl; if loss exceeds threshold, pause auto-trade.
    try {
      const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
      const { data: closedToday } = await supabase
        .from("signals")
        .select("metaapi_pnl, closed_at")
        .eq("metaapi_execution_status", "closed")
        .gte("closed_at", dayStart.toISOString());
      const totalPnl = (closedToday ?? []).reduce(
        (sum: number, r: any) => sum + Number(r.metaapi_pnl ?? 0),
        0,
      );
      const balance = Number((health.data as any)?.balance ?? 0);
      const lossLimit = balance > 0 ? balance * (maxDailyLossPct / 100) : 0;
      if (totalPnl < 0 && lossLimit > 0 && Math.abs(totalPnl) >= lossLimit) {
        await supabase.from("app_settings")
          .update({ metaapi_auto_trade: false })
          .eq("id", "singleton");
        const msg = `daily loss limit reached (loss ${totalPnl.toFixed(2)} >= ${lossLimit.toFixed(2)}) — auto-trade paused`;
        await markFailed(supabase, signal_id, msg);
        return new Response(JSON.stringify({ ok: false, reason: msg }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    } catch (e) {
      console.error("daily loss check failed", e);
    }

    const symbol = pairToSymbol(s.pair, symbolSuffix);
    let priceRes = await getSymbolPrice({ region, accountId, token, symbol });
    if (priceRes.ok && (priceRes.bid == null || priceRes.ask == null)) {
      await new Promise((r) => setTimeout(r, 1500));
      priceRes = await getSymbolPrice({ region, accountId, token, symbol });
    }
    if (!priceRes.ok || !priceRes.bid || !priceRes.ask) {
      const raw = priceRes.error ?? "price unavailable";
      const friendly = raw.includes("404")
        ? `Symbol "${symbol}" not found (404) — set the correct broker symbol suffix in Settings (e.g. 'm' for Exness) and ensure the MetaApi account is in Deployed state.`
        : raw;
      await markFailed(supabase, signal_id, friendly);
      return new Response(JSON.stringify({ ok: false, reason: friendly }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const entry = Number(s.entry);
    const picked = pickAction(s.direction, entry, priceRes.bid, priceRes.ask);

    const mid = ((priceRes.bid ?? 0) + (priceRes.ask ?? 0)) / 2;
    const slDistance = Math.abs(mid - Number(s.stop_loss));
    const minDistance = mid * 0.0005;
    if (slDistance < minDistance) {
      const msg = `SL too close to market (${slDistance.toFixed(5)} < min ${minDistance.toFixed(5)}) — signal stale`;
      await markFailed(supabase, signal_id, msg);
      return new Response(JSON.stringify({ ok: false, reason: msg }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const halfLot = Math.round((lot / 2) * 100) / 100;
    const expiration = picked.kind !== "market" ? {
      type: "ORDER_TIME_SPECIFIED",
      time: new Date(Date.now() + expiryHours * 3600_000).toISOString(),
    } : undefined;

    // Order A — closes at TP1
    const orderA = await placeOrder({
      region, accountId, token,
      actionType: picked.action,
      symbol, volume: halfLot,
      openPrice: picked.openPrice,
      stopLoss: Number(s.stop_loss),
      takeProfit: Number(s.tp1),
      comment: `sig ${String(signal_id).slice(0, 8)} A`,
      expiration,
    });
    if (!orderA.ok) {
      await markFailed(supabase, signal_id, orderA.error ?? "order A failed");
      return safeError(orderA.error ?? "order A failed", 500);
    }

    // Order B — runner to TP2
    const orderB = await placeOrder({
      region, accountId, token,
      actionType: picked.action,
      symbol, volume: halfLot,
      openPrice: picked.openPrice,
      stopLoss: Number(s.stop_loss),
      takeProfit: Number(s.tp2),
      comment: `sig ${String(signal_id).slice(0, 8)} B`,
      expiration,
    });
    if (!orderB.ok) {
      await markFailed(supabase, signal_id, orderB.error ?? "order B failed");
      return safeError(orderB.error ?? "order B failed", 500);
    }

    const aFilled = !!orderA.data?.positionId;
    const bFilled = !!orderB.data?.positionId;
    const bothFilled = aFilled && bFilled;

    await supabase.from("signals").update({
      metaapi_order_id: orderA.data?.orderId ?? orderA.data?.positionId ?? null,
      metaapi_position_id: orderA.data?.positionId ?? null,
      metaapi_order_id_b: orderB.data?.orderId ?? orderB.data?.positionId ?? null,
      metaapi_position_id_b: orderB.data?.positionId ?? null,
      metaapi_executed_lot: lot,
      metaapi_order_type: picked.kind,
      metaapi_execution_status: bothFilled ? "filled" : "order_pending",
      metaapi_execution_error: null,
      executed_at: new Date().toISOString(),
      status: bothFilled ? "executed" : "pending",
    }).eq("id", signal_id);

    return new Response(JSON.stringify({
      ok: true, kind: picked.kind,
      a: { positionId: orderA.data?.positionId, orderId: orderA.data?.orderId },
      b: { positionId: orderB.data?.positionId, orderId: orderB.data?.orderId },
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    console.error("metaapi-execute error", e);
    return safeError("internal error executing order", 500);
  }
});
