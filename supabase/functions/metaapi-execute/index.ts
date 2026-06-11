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

function mapBrokerError(err: string): string {
  if (err && err.includes("10016")) {
    return "Signal skipped — price moved too far before execution, stops now invalid. Wait for next signal.";
  }
  return err;
}

async function markFailed(supabase: any, signalId: string, error: string) {
  await supabase.from("signals").update({
    metaapi_execution_status: "failed",
    metaapi_execution_error: mapBrokerError(error).slice(0, 500),
    paper_status: "watching",
  }).eq("id", signalId);
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
    const mode = (c?.metaapi_active_mode as string | null) ?? "demo";
    const isLive = mode === "live";

    const accountId = c.metaapi_account_id as string | null;
    const region = (c.metaapi_region as string | null) ?? "new-york";
    const minConf = Number(c.metaapi_min_confidence ?? 75);
    const minRR = Number(c.metaapi_min_rr ?? 2);
    // Lot is computed below using % risk sizing once we have account balance + symbol.
    const maxTrades = Number(c.metaapi_max_trades ?? 3);
    const expiryHours = Number(c.metaapi_expiry_hours ?? 24);
    const maxDailyLossPct = Number(c.metaapi_max_daily_loss_pct ?? 5);
    const symbolSuffix = (c.metaapi_symbol_suffix as string | null) ?? "";
    const token = (c.metaapi_token as string | null) || Deno.env.get("METAAPI_TOKEN") || null;

    // Mode-aware connection params: live overrides demo when active mode is live.
    const effectiveAccountId = isLive
      ? ((c?.metaapi_account_id_live as string | null) ?? accountId)
      : accountId;
    const effectiveToken = isLive
      ? ((c?.metaapi_token_live as string | null) || token)
      : token;
    const effectiveRegion = isLive
      ? ((c?.metaapi_region_live as string | null) ?? region)
      : region;
    const effectiveSuffix = isLive
      ? ((c?.metaapi_symbol_suffix_live as string | null) ?? symbolSuffix)
      : symbolSuffix;

    if (!autoTrade) {
      return new Response(JSON.stringify({ ok: false, reason: "auto-trade disabled" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!effectiveToken || !effectiveAccountId) {
      await markFailed(supabase, signal_id, `MetaApi not configured for ${mode.toUpperCase()} mode (token or account ID missing)`);
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

    // Per-pair auto-execute filter — disabled pairs still paper-track.
    const pairConfig = (c?.pair_auto_execute ?? {}) as Record<string, boolean>;
    const pairNorm = String(s.pair ?? "");
    // default true if pair not in config (future new pairs auto-enabled)
    const pairEnabled = pairConfig[pairNorm] !== false;
    if (!pairEnabled) {
      await supabase.from("signals").update({
        metaapi_execution_status: "skipped",
        metaapi_execution_error: `${pairNorm} auto-execution is disabled in Settings. Paper-tracked only.`,
        paper_status: "watching",
      }).eq("id", signal_id);
      return new Response(JSON.stringify({ ok: false, reason: "pair_disabled" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }



    // Concurrent trades gate — count active open positions only (pending orders have no risk yet).
    const { count: activeCount } = await supabase
      .from("signals")
      .select("id", { count: "exact", head: true })
      .in("metaapi_execution_status", ["filled", "partial"]);
    if ((activeCount ?? 0) >= maxTrades) {
      const msg = `max concurrent trades reached (${activeCount}/${maxTrades})`;
      await markFailed(supabase, signal_id, msg);
      return new Response(JSON.stringify({ ok: false, reason: msg }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }


    const health = await getAccountInfo({ region: effectiveRegion, accountId: effectiveAccountId, token: effectiveToken });
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

    const symbol = pairToSymbol(s.pair, effectiveSuffix);
    let priceRes = await getSymbolPrice({ region: effectiveRegion, accountId: effectiveAccountId, token: effectiveToken, symbol });
    // Retry on 500 (transient MetaAPI server error) or empty price (stream warm-up)
    if ((priceRes.ok === false && priceRes.error?.includes("500")) ||
        (priceRes.ok && (priceRes.bid == null || priceRes.ask == null))) {
      await new Promise((r) => setTimeout(r, 2000));
      priceRes = await getSymbolPrice({ region: effectiveRegion, accountId: effectiveAccountId, token: effectiveToken, symbol });
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

    const spreadBuffer = Math.abs(Number(priceRes.ask) - Number(priceRes.bid)) * 2;
    const isMarket = picked.kind === "market";
    const orderBStopLoss = isMarket
      ? (picked.action === "ORDER_TYPE_SELL"
          ? Number(s.entry) + spreadBuffer
          : Number(s.entry) - spreadBuffer)
      : Number(s.stop_loss);

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

    // % risk-based lot sizing
    const accountBalance = (health.data as any)?.balance ?? 100;
    const riskPct = Number(c?.metaapi_risk_per_trade_pct ?? 2) / 100;
    const minLot = Number(c?.metaapi_min_lot ?? 0.01);
    const maxLot = Number(c?.metaapi_max_lot ?? 0.10);
    const fallbackLot = Number(c?.metaapi_fixed_lot ?? 0.02);

    // Point value per 0.01 lot in account currency.
    // FX pairs (EUR/USD, GBP/USD, GBP/JPY etc): $0.10 per pip per 0.01 lot on standard.
    //   On cent accounts balance is USC, so pip value is 100× larger in USC terms → centMultiplier.
    // XAU/USD & BTC/USD: price moves in USD directly. Even on cent accounts the raw
    //   slPoints are already in dollar units (e.g. XAU SL of 9.37 = $9.37/point/lot).
    //   Applying centMultiplier here would inflate the risk calc 100× and wrongly block trades.
    const sym = symbol.toUpperCase();
    const isCentAccount = isLive
      ? Boolean(c?.metaapi_is_cent_account_live)
      : Boolean(c?.metaapi_is_cent_account);
    const isMetalOrCrypto = sym.includes("XAU") || sym.includes("XAG")
      || sym.includes("BTC") || sym.includes("ETH");
    // Only FX pairs scale with the cent multiplier — metals/crypto are USD-quoted at broker level.
    const centMultiplier = (isCentAccount && !isMetalOrCrypto) ? 100 : 1;
    const pointValuePer001Lot = (isMetalOrCrypto && (sym.includes("XAU") || sym.includes("XAG")) ? 1.0
      : isMetalOrCrypto ? 0.01
      : 0.10) * centMultiplier;

    const slPoints = Math.abs(Number(s.entry) - Number(s.stop_loss));
    const targetRiskDollars = accountBalance * riskPct; // total risk across both half-lots
    const halfRiskDollars = targetRiskDollars / 2; // per order

    let rawLot = slPoints > 0
      ? halfRiskDollars / (slPoints * pointValuePer001Lot * 100)
      : fallbackLot / 2;

    // Round to 2 decimal places, clamp between min and max
    let halfLot = Math.round(rawLot * 100) / 100;
    halfLot = Math.max(minLot, Math.min(maxLot / 2, halfLot));

    const lot = halfLot * 2; // total for reference only — orders use halfLot each

    // Safety gate: if even minimum lot risks more than 2× target, block the trade
    const minLotRisk = (slPoints * pointValuePer001Lot * 100) * minLot * 2;
    const maxAllowedRisk = targetRiskDollars * 2; // allow 2× tolerance before blocking
    if (minLotRisk > maxAllowedRisk) {
      const msg = `Min lot risk $${minLotRisk.toFixed(2)} exceeds max allowed $${maxAllowedRisk.toFixed(2)} for this SL width — trade skipped`;
      await markFailed(supabase, signal_id, msg);
      return new Response(JSON.stringify({ ok: false, reason: msg }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const expiration = picked.kind !== "market" ? {
      type: "ORDER_TIME_SPECIFIED",
      time: new Date(Date.now() + expiryHours * 3600_000).toISOString(),
    } : undefined;

    await supabase.from("signals").update({
      metaapi_execution_status: "pending",
      metaapi_execution_error: null,
    }).eq("id", signal_id);

    // Order A — closes at TP1
    const orderA = await placeOrder({
      region: effectiveRegion, accountId: effectiveAccountId, token: effectiveToken,
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
      region: effectiveRegion, accountId: effectiveAccountId, token: effectiveToken,
      actionType: picked.action,
      symbol, volume: halfLot,
      openPrice: picked.openPrice,
      stopLoss: orderBStopLoss,
      takeProfit: Number(s.tp2),
      comment: `sig ${String(signal_id).slice(0, 8)} B`,
      expiration,
    });
    if (!orderB.ok) {
      try {
        const tradeUrl = `https://mt-client-api-v1.${effectiveRegion}.agiliumtrade.ai/users/current/accounts/${effectiveAccountId}/trade`;
        const headers = { "Content-Type": "application/json", "auth-token": effectiveToken! };
        if (orderA.data?.positionId) {
          await fetch(tradeUrl, { method: "POST", headers,
            body: JSON.stringify({ actionType: "POSITION_CLOSE_ID", positionId: orderA.data.positionId }) });
        } else if (orderA.data?.orderId) {
          await fetch(tradeUrl, { method: "POST", headers,
            body: JSON.stringify({ actionType: "ORDER_CANCEL", orderId: orderA.data.orderId }) });
        }
      } catch (e) { console.error("Order A cleanup failed", e); }
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
