// Executes a MetaApi order for a given signal id.
// - Auto-selects market / limit / stop based on entry vs current price
// - Idempotent: refuses to re-execute a signal that already has a position/order id.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  checkSecret,
  corsHeaders,
  deployAccount,
  getProvisioningAccountInfo,
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
    const token = ((cfg as any)?.metaapi_token as string | null) || Deno.env.get("METAAPI_TOKEN") || null;

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

    // Pre-flight: ensure the MetaApi account is DEPLOYED via the provisioning API.
    // The client trading API can report "unknown" for MT5 demo accounts — provisioning is authoritative.
    const deployLog: string[] = [];
    const acctRes = await getProvisioningAccountInfo({ region, accountId, token });
    if (!acctRes.ok) {
      const msg = `provisioning lookup failed: ${acctRes.error ?? "unknown"}`;
      await markFailed(supabase, signal_id, msg);
      return new Response(JSON.stringify({ ok: false, reason: msg }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    let acctState = String((acctRes.data as any)?.state ?? "unknown");
    deployLog.push(`initial state=${acctState}`);
    if (acctState.toUpperCase() !== "DEPLOYED") {
      const dep = await deployAccount({ region, accountId, token });
      deployLog.push(...dep.log);
      if (!dep.ok) {
        const msg = `MetaApi account not deployed after retries. Log: ${deployLog.join(" | ")}`.slice(0, 500);
        await markFailed(supabase, signal_id, msg);
        return new Response(JSON.stringify({ ok: false, reason: msg }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      acctState = dep.state ?? "DEPLOYED";
    }

    const symbol = pairToSymbol(s.pair, symbolSuffix);
    const priceRes = await getSymbolPrice({ region, accountId, token, symbol });
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

    // Stale-stop protection: refuse if SL is implausibly close to current price.
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
    const isPending = !filled && !!data.orderId; // LIMIT/STOP awaiting fill
    await supabase.from("signals").update({
      metaapi_position_id: data.positionId ?? null,
      metaapi_order_id: data.orderId ?? null,
      metaapi_order_type: picked.kind,
      metaapi_executed_lot: lot,
      metaapi_execution_status: filled ? "filled" : (isPending ? "order_pending" : "pending"),
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
