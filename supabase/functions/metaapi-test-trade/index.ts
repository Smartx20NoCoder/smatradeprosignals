// Diagnostic end-to-end test: places a real 0.01 lot EUR/USD market BUY and
// immediately closes it. Returns a step-by-step trace.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  checkSecret,
  corsHeaders,
  getAccountInfo,
  getSymbolPrice,
  pairToSymbol,
  placeOrder,
} from "../_shared/metaapi.ts";

type Step = { label: string; detail: string; ok: boolean; error?: string };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const unauth = checkSecret(req);
  if (unauth) return unauth;

  const steps: Step[] = [];
  const push = (s: Step) => { steps.push(s); return s; };
  const finish = (ok: boolean, summary: string) =>
    new Response(JSON.stringify({ ok, steps, summary }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { data: cfg } = await supabase
      .from("app_settings").select("*").eq("id", "singleton").maybeSingle();

    const accountId = (cfg as any)?.metaapi_account_id as string | null;
    const fallbackRegion = ((cfg as any)?.metaapi_region as string | null) ?? "new-york";
    const suffix = ((cfg as any)?.metaapi_symbol_suffix as string | null) ?? "";
    const token = ((cfg as any)?.metaapi_token as string | null) || Deno.env.get("METAAPI_TOKEN") || null;

    // 1. Load config
    if (!accountId || !token) {
      push({
        label: "Load config", ok: false,
        detail: `accountId=${accountId ? "set" : "missing"} token=${token ? "set" : "missing"} suffix="${suffix}"`,
        error: "Account ID and MetaApi token are both required",
      });
      return finish(false, "Test failed: configuration incomplete");
    }
    push({
      label: "Load config", ok: true,
      detail: `accountId=${accountId.slice(0, 8)}… token=set suffix="${suffix}" fallbackRegion=${fallbackRegion}`,
    });

    // Step 2 — verify broker connectivity via client API directly
    const clientBase = `https://mt-client-api-v1.${fallbackRegion}.agiliumtrade.ai`;
    const health = await getAccountInfo({ region: fallbackRegion, accountId, token });
    if (!health.ok) {
      push({
        label: "Broker connection",
        ok: false,
        detail: `clientBase=${clientBase}`,
        error: health.error ?? "broker unreachable",
      });
      return finish(false, "Test failed: broker not reachable via client API");
    }
    push({
      label: "Broker connection",
      ok: true,
      detail: `clientBase=${clientBase} balance=${(health.data as any)?.balance ?? "?"} equity=${(health.data as any)?.equity ?? "?"}`,
    });
    const acctRegion = fallbackRegion;

    // Get EUR/USD price (with streaming warm-up retry)
    const symbol = pairToSymbol("EUR/USD", suffix);
    let price = await getSymbolPrice({ region: acctRegion, accountId, token, symbol });
    if (price.ok && (price.bid == null || price.ask == null)) {
      await new Promise((r) => setTimeout(r, 1500));
      price = await getSymbolPrice({ region: acctRegion, accountId, token, symbol });
    }
    if (!price.ok || !price.bid || !price.ask) {
      push({
        label: "Get EUR/USD price", ok: false,
        detail: `symbol=${symbol}`,
        error: price.error ?? "no price returned — check Broker Symbol Suffix in Settings",
      });
      return finish(false, `Test failed: could not fetch price for ${symbol}`);
    }
    push({
      label: "Get EUR/USD price", ok: true,
      detail: `symbol=${symbol} bid=${price.bid} ask=${price.ask}`,
    });

    // 5. Place BUY order — SL/TP derived from current spread.
    const bid = price.bid;
    const ask = price.ask;
    const spread = ask - bid;
    const sl = +(bid - spread * 20).toFixed(5);
    const tp = +(ask + spread * 40).toFixed(5);
    const order = await placeOrder({
      region: acctRegion, accountId, token,
      actionType: "ORDER_TYPE_BUY",
      symbol, volume: 0.01,
      stopLoss: sl, takeProfit: tp,
      comment: "scalpedge-test",
      clientId: `test-${Date.now()}`,
    });
    if (!order.ok || !order.data?.positionId) {
      push({
        label: "Place BUY order", ok: false,
        detail: `symbol=${symbol} volume=0.01 sl=${sl} tp=${tp}`,
        error: order.error ?? "no positionId returned",
      });
      return finish(false, "Test failed: broker rejected the order");
    }
    const positionId = String(order.data.positionId);
    push({
      label: "Place BUY order", ok: true,
      detail: `positionId=${positionId} orderId=${order.data.orderId ?? "—"} sl=${sl} tp=${tp}`,
    });

    // 6. Wait 2s, then close position via POSITION_CLOSE_ID
    await new Promise((r) => setTimeout(r, 2000));
    const closeUrl = `${clientBase}/users/current/accounts/${accountId}/trade`;
    let closeOk = false;
    let closeDetail = `positionId=${positionId}`;
    let closeErr: string | undefined;
    try {
      const res = await fetch(closeUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "auth-token": token },
        body: JSON.stringify({ actionType: "POSITION_CLOSE_ID", positionId }),
      });
      const text = await res.text();
      if (!res.ok) {
        closeErr = `close failed (${res.status}): ${text.slice(0, 200)}`;
      } else {
        closeOk = true;
        let parsed: any = null;
        try { parsed = JSON.parse(text); } catch { /* */ }
        closeDetail = `positionId=${positionId} ${parsed?.stringCode ?? "OK"}`;
      }
    } catch (e) {
      closeErr = `close request threw: ${String(e).slice(0, 200)}`;
    }
    push({ label: "Close position", ok: closeOk, detail: closeDetail, error: closeErr });

    if (!closeOk) {
      return finish(false, `Trade placed but failed to close — manually close positionId ${positionId}`);
    }
    return finish(true, "Test trade completed successfully — order placed and closed");
  } catch (e) {
    console.error("metaapi-test-trade error", e);
    push({ label: "Unhandled error", ok: false, detail: "", error: String(e).slice(0, 300) });
    return finish(false, "Test failed: unexpected error");
  }
});
