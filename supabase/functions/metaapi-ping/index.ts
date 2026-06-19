// Verifies MetaApi token + account and reports broker connection state.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { checkSecret, corsHeaders, getAccountInfo, getSymbolPrice, pairToSymbol } from "../_shared/metaapi.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const unauth = checkSecret(req);
  if (unauth) return unauth;

  const reqBody = await req.json().catch(() => ({}));
  const isConnectionOnly = reqBody?.mode === "connection";
  const isForceSubscribe = reqBody?.mode === "force_subscribe";

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { data: cfg } = await supabase
      .from("app_settings").select("*").eq("id", "singleton").maybeSingle();
    const c: any = cfg ?? {};
    const mode = (c?.metaapi_active_mode as string | null) ?? "demo";
    const isLive = mode === "live";
    const baseAccountId = c?.metaapi_account_id as string | null;
    const baseRegion = (c?.metaapi_region as string | null) ?? "new-york";
    const baseToken = (c?.metaapi_token as string | null) || Deno.env.get("METAAPI_TOKEN") || null;
    const accountId = isLive
      ? ((c?.metaapi_account_id_live as string | null) ?? baseAccountId)
      : baseAccountId;
    const region = isLive
      ? ((c?.metaapi_region_live as string | null) ?? baseRegion)
      : baseRegion;
    const token = isLive
      ? ((c?.metaapi_token_live as string | null) || baseToken)
      : baseToken;
    const baseSuffix = (c?.metaapi_symbol_suffix as string | null) ?? "";
    const effectiveSuffix = isLive
      ? ((c?.metaapi_symbol_suffix_live as string | null) ?? baseSuffix)
      : baseSuffix;
    if (!token) {
      return new Response(JSON.stringify({ ok: false, reason: "broker token not configured" }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!accountId) {
      return new Response(JSON.stringify({ ok: false, reason: "broker account not configured" }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const info = await getAccountInfo({ region, accountId, token });
    if (!info.ok) {
      return new Response(JSON.stringify({ ok: false, reason: info.error }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    await supabase.from("app_settings")
      .update({ metaapi_connected_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", "singleton");
    if (info.ok && (info as any).data?.balance != null) {
      await supabase.from("app_settings").update({
        metaapi_last_balance: Number((info as any).data.balance),
        metaapi_last_balance_at: new Date().toISOString(),
      }).eq("id", "singleton");
    }

    // Connection-only mode (Test Connection button): skip keepalive entirely.
    if (isConnectionOnly) {
      return new Response(JSON.stringify({ ok: true, account: info.data, keepalive: [], reconnect_triggered: false }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Keep symbol subscriptions alive for RoboForex and other MT4 brokers
    const pairConfig = (c?.pair_auto_execute ?? {}) as Record<string, boolean>;
    const activePairs = Object.entries(pairConfig)
      .filter(([, enabled]) => enabled)
      .map(([pair]) => pair);

    const keepalive: { pair: string; symbol: string; ok: boolean; bid?: number; attempt: number }[] = [];

    const effectiveRegion = region;
    const effectiveAccountId = accountId;
    const effectiveToken = token;

    // Force-subscribe mode (manual button): aggressive redeploy + reconnect + per-pair retries.
    if (isForceSubscribe) {
      const results: { pair: string; symbol: string; ok: boolean; bid?: number; recovered: boolean }[] = [];

      // Step A — Force full account redeploy (stronger than reconnect)
      try {
        const redeployUrl = `https://mt-client-api-v1.${effectiveRegion}.agiliumtrade.ai/users/current/accounts/${effectiveAccountId}/deploy`;
        await fetch(redeployUrl, {
          method: "POST",
          headers: { "auth-token": effectiveToken, "Content-Type": "application/json" },
        });
        console.log("Force deploy triggered");
      } catch (e) { console.log("Deploy failed:", e); }

      // Step B — Wait for terminal to re-establish
      await new Promise(r => setTimeout(r, 8000));

      // Step C — Try reconnect as well
      try {
        const reconnectUrl = `https://mt-client-api-v1.${effectiveRegion}.agiliumtrade.ai/users/current/accounts/${effectiveAccountId}/reconnect`;
        await fetch(reconnectUrl, {
          method: "POST",
          headers: { "auth-token": effectiveToken, "Content-Type": "application/json" },
        });
      } catch (e) { console.log("Reconnect failed:", e); }

      // Step D — Wait again after reconnect
      await new Promise(r => setTimeout(r, 5000));

      // Step E — Probe all pairs with up to 5 retries each, 3s apart
      for (const pair of activePairs) {
        const symbol = pairToSymbol(pair, effectiveSuffix);
        let ok = false; let bid: number | undefined; let recovered = false;

        for (let attempt = 1; attempt <= 5; attempt++) {
          try {
            const price = await getSymbolPrice({
              region: effectiveRegion,
              accountId: effectiveAccountId,
              token: effectiveToken,
              symbol,
            });
            if (price.ok && price.bid != null) {
              ok = true; bid = price.bid;
              recovered = attempt > 1;
              console.log(`${pair} OK on attempt ${attempt}: bid=${price.bid}`);
              break;
            }
          } catch (e) { console.log(`${pair} attempt ${attempt} error: ${e}`); }
          if (attempt < 5) await new Promise(r => setTimeout(r, 3000));
        }
        results.push({ pair, symbol, ok, bid, recovered });
        await new Promise(r => setTimeout(r, 500));
      }

      // Save results and return
      await supabase.from("app_settings").update({
        metaapi_keepalive_last: JSON.stringify(results),
      }).eq("id", "singleton");

      return new Response(JSON.stringify({
        ok: true,
        keepalive: results,
        force_subscribe: true,
        recovered: results.filter(r => r.ok).length,
        total: results.length,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }





    // Pass 1 — force fresh subscription for all pairs
    for (const pair of activePairs) {
      const symbol = pairToSymbol(pair, effectiveSuffix);
      let ok = false;
      let bid: number | undefined;
      let attempts = 1;

      try {
        // First attempt — no keepSubscription, forces fresh subscribe request
        const p1 = await getSymbolPrice({ region, accountId, token, symbol, keepSubscription: false });
        if (p1.ok && p1.bid != null) {
          ok = true; bid = p1.bid;
        } else {
          // 404 or empty — wait and retry once
          await new Promise(r => setTimeout(r, 2500));
          attempts = 2;
          const p2 = await getSymbolPrice({ region, accountId, token, symbol, keepSubscription: false });
          if (p2.ok && p2.bid != null) { ok = true; bid = p2.bid; }
        }
      } catch (e) {
        console.log(`Keepalive pass1 error ${pair}: ${e}`);
      }

      keepalive.push({ pair, symbol, ok, bid, attempt: attempts });
      await new Promise(r => setTimeout(r, 1000));
    }

    // Pass 2 — lock in subscriptions for all pairs that responded
    for (const entry of keepalive.filter(k => k.ok)) {
      try {
        await getSymbolPrice({ region, accountId, token, symbol: entry.symbol, keepSubscription: true });
      } catch { /* silent */ }
      await new Promise(r => setTimeout(r, 500));
    }

    // Auto-reconnect when more than half the symbols are dead

    const deadCount = keepalive.filter(k => !k.ok).length;
    const totalCount = keepalive.length;
    const reconnect_triggered = deadCount > 0 && deadCount >= Math.ceil(totalCount / 2);

    if (reconnect_triggered) {
      try {
        console.log(`Auto-reconnect triggered: ${deadCount}/${totalCount} symbols dead`);
        const reconnectUrl = `https://mt-client-api-v1.${effectiveRegion}.agiliumtrade.ai/users/current/accounts/${effectiveAccountId}/reconnect`;
        await fetch(reconnectUrl, {
          method: "POST",
          headers: {
            "auth-token": effectiveToken,
            "Content-Type": "application/json",
          },
        });

        // Wait for terminal to reconnect and refresh Market Watch
        await new Promise(r => setTimeout(r, 6000));

        // Re-ping dead symbols after reconnect
        for (const entry of keepalive.filter(k => !k.ok)) {
          try {
            const price = await getSymbolPrice({
              region: effectiveRegion,
              accountId: effectiveAccountId,
              token: effectiveToken,
              symbol: entry.symbol,
            });
            if (price.ok && price.bid != null) {
              entry.ok = true;
              entry.bid = price.bid;
              console.log(`Recovered after reconnect: ${entry.pair} bid=${price.bid}`);
            }
          } catch { /* silent */ }
          await new Promise(r => setTimeout(r, 800));
        }
      } catch (e) {
        console.log(`Auto-reconnect failed: ${e}`);
      }
    }

    // Extended retry for slow-to-initialise feeds (crypto + gold on MT4)
    for (const targetPair of ["BTC/USD", "ETH/USD", "XRP/USD", "XAU/USD"]) {
      const entry = keepalive.find(k => k.pair === targetPair && !k.ok);
      if (!entry) continue;
      console.log(`${targetPair} still dead after reconnect — starting extended retry (3 attempts × 4s)`);
      for (let attempt = 1; attempt <= 3; attempt++) {
        await new Promise(r => setTimeout(r, 4000));
        try {
          const price = await getSymbolPrice({
            region: effectiveRegion,
            accountId: effectiveAccountId,
            token: effectiveToken,
            symbol: entry.symbol,
          });
          if (price.ok && price.bid != null) {
            entry.ok = true;
            entry.bid = price.bid;
            console.log(`${targetPair} recovered on attempt ${attempt}: bid=${price.bid}`);
            break;
          }
          console.log(`${targetPair} attempt ${attempt} still failed`);
        } catch (e) {
          console.log(`${targetPair} attempt ${attempt} error: ${e}`);
        }
      }

      if (!entry.ok) {
        console.log(`${targetPair} unrecovered — triggering second reconnect`);
        try {
          const reconnectUrl = `https://mt-client-api-v1.${effectiveRegion}.agiliumtrade.ai/users/current/accounts/${effectiveAccountId}/reconnect`;
          await fetch(reconnectUrl, {
            method: "POST",
            headers: { "auth-token": effectiveToken, "Content-Type": "application/json" },
          });
          await new Promise(r => setTimeout(r, 8000));
          const finalPrice = await getSymbolPrice({
            region: effectiveRegion,
            accountId: effectiveAccountId,
            token: effectiveToken,
            symbol: entry.symbol,
          });
          if (finalPrice.ok && finalPrice.bid != null) {
            entry.ok = true;
            entry.bid = finalPrice.bid;
            console.log(`${targetPair} recovered after second reconnect: bid=${finalPrice.bid}`);
          }
        } catch (e) {
          console.log(`Second reconnect failed for ${targetPair}: ${e}`);
        }
      }
    }

    await supabase.from("app_settings").update({
      metaapi_keepalive_last: { checked_at: new Date().toISOString(), results: keepalive, reconnect_triggered },
    }).eq("id", "singleton");

    return new Response(JSON.stringify({ ok: true, account: info.data, keepalive, reconnect_triggered }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("metaapi-ping error", e);
    return new Response(JSON.stringify({ ok: false, reason: "broker check failed" }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
