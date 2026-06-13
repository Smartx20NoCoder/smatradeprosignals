// Verifies MetaApi token + account and reports broker connection state.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { checkSecret, corsHeaders, getAccountInfo, getSymbolPrice, pairToSymbol } from "../_shared/metaapi.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const unauth = checkSecret(req);
  if (unauth) return unauth;

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

    // Keep symbol subscriptions alive for RoboForex and other MT4 brokers
    const pairConfig = (c?.pair_auto_execute ?? {}) as Record<string, boolean>;
    const activePairs = Object.entries(pairConfig)
      .filter(([, enabled]) => enabled)
      .map(([pair]) => pair);

    const keepalive: { pair: string; symbol: string; ok: boolean; bid?: number }[] = [];
    for (const pair of activePairs) {
      const symbol = pairToSymbol(pair, effectiveSuffix);
      try {
        const price = await getSymbolPrice({ region, accountId, token, symbol });
        keepalive.push({ pair, symbol, ok: price.ok, bid: price.bid });
        if (!price.ok) console.log(`Keepalive ping failed for ${pair}: ${price.error}`);
      } catch (e) {
        keepalive.push({ pair, symbol, ok: false });
        console.log(`Keepalive ping failed for ${pair}: ${e}`);
      }
      await new Promise((r) => setTimeout(r, 800)); // space calls 800ms apart
    }

    await supabase.from("app_settings").update({
      metaapi_keepalive_last: { checked_at: new Date().toISOString(), results: keepalive },
    }).eq("id", "singleton");

    return new Response(JSON.stringify({ ok: true, account: info.data, keepalive }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("metaapi-ping error", e);
    return new Response(JSON.stringify({ ok: false, reason: "broker check failed" }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
