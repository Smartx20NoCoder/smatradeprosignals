// Lightweight per-pair subscription probe — used by the Health tab
// to progressively render symbol subscription status (no retries, no reconnect).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { checkSecret, corsHeaders, getSymbolPrice, pairToSymbol } from "../_shared/metaapi.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const unauth = checkSecret(req);
  if (unauth) return unauth;

  const started = Date.now();
  try {
    const body = await req.json().catch(() => ({}));
    const pair = typeof body?.pair === "string" ? body.pair : "";
    if (!pair) {
      return new Response(JSON.stringify({ ok: false, reason: "missing pair" }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

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

    if (!token || !accountId) {
      return new Response(JSON.stringify({ ok: false, pair, reason: "broker not configured" }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const symbol = pairToSymbol(pair, effectiveSuffix);

    // 3-second timeout to keep the panel snappy
    const result = await Promise.race([
      getSymbolPrice({ region, accountId, token, symbol, keepSubscription: true }),
      new Promise<{ ok: false; error: string }>((resolve) =>
        setTimeout(() => resolve({ ok: false, error: "timeout" }), 3000),
      ),
    ]);

    return new Response(JSON.stringify({
      pair,
      symbol,
      ok: !!result.ok && (result as any).bid != null,
      bid: (result as any).bid,
      elapsed_ms: Date.now() - started,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    console.error("metaapi-subscriptions error", e);
    return new Response(JSON.stringify({ ok: false, reason: "subscription check failed", elapsed_ms: Date.now() - started }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
