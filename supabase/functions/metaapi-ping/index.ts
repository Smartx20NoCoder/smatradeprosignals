// Verifies MetaApi token + account and reports broker connection state.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { checkSecret, corsHeaders, getAccountInfo } from "../_shared/metaapi.ts";

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
    const accountId = (cfg as any)?.metaapi_account_id as string | null;
    const region = ((cfg as any)?.metaapi_region as string | null) ?? "new-york";
    const token = Deno.env.get("METAAPI_TOKEN");
    if (!token) {
      return new Response(JSON.stringify({ ok: false, reason: "METAAPI_TOKEN secret not configured" }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!accountId) {
      return new Response(JSON.stringify({ ok: false, reason: "MetaApi account ID not configured" }), {
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
    return new Response(JSON.stringify({ ok: true, account: info.data }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, reason: (e as Error).message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
