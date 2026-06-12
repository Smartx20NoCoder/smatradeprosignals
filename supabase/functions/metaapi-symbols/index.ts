// Lists available broker symbols and highlights which traded pairs match.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { checkSecret, corsHeaders, getAvailableSymbols } from "../_shared/metaapi.ts";

const TRADED_BASE = [
  "XAUUSD", "BTCUSD", "ETHUSD",
  "EURUSD", "GBPUSD", "USDJPY",
  "GBPJPY", "EURJPY", "AUDUSD",
  "AUDJPY", "EURGBP",
];

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

    if (!token || !accountId) {
      return new Response(JSON.stringify({ ok: false, reason: "broker not configured" }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const result = await getAvailableSymbols({ region, accountId, token });
    if (!result.ok || !result.symbols) {
      return new Response(JSON.stringify({ ok: false, reason: result.error ?? "symbols fetch failed" }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const all = [...result.symbols].sort((a, b) => a.localeCompare(b));
    const allUpper = all.map((s) => s.toUpperCase());

    // For each traded base, find matching broker symbols (exact or with suffix).
    const matches: Record<string, string[]> = {};
    const found: string[] = [];
    const notFound: string[] = [];
    for (const base of TRADED_BASE) {
      const hits = all.filter((s) => {
        const u = s.toUpperCase();
        return u === base || (u.startsWith(base) && /^[A-Z._-]{0,5}$/.test(u.slice(base.length)));
      });
      matches[base] = hits;
      if (hits.length > 0) {
        found.push(...hits);
      } else {
        notFound.push(base);
      }
    }

    return new Response(JSON.stringify({
      ok: true,
      mode,
      all,
      found,
      notFound,
      matches,
      count: all.length,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    console.error("metaapi-symbols error", e);
    return new Response(JSON.stringify({ ok: false, reason: "symbols check failed" }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
