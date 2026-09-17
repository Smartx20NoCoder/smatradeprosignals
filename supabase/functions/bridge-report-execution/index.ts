import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

// Keep this bridge-facing function self-contained. The previous implementation
// imported shared auth helpers which caused BOOT_ERROR in production after the
// migration. The EA authenticates with x-fn-secret.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-fn-secret",
};

function authorized(req: Request): boolean {
  const secret = Deno.env.get("INTERNAL_FN_SECRET") ?? "";
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const suppliedSecret = req.headers.get("x-fn-secret") ?? "";
  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  return (!!secret && suppliedSecret === secret) || (!!service && bearer === service);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
  if (!authorized(req)) return json({ ok: false, error: "Unauthorized" }, 401);

  try {
    const body = await req.json().catch(() => ({}));
    const signalId = String(body.signal_id ?? "").trim();
    const ticket = Number(body.ticket ?? 0);
    const lot = Number(body.lot ?? 0);
    const success = body.success === true;
    const errorMsg = String(body.error ?? "").slice(0, 500);

    if (!signalId) return json({ ok: false, error: "signal_id required" }, 400);

    const url = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !serviceKey) return json({ ok: false, error: "Supabase service configuration missing" }, 500);

    const supabase = createClient(url, serviceKey);
    const update = success && ticket > 0
      ? {
          metaapi_order_id: String(ticket),
          metaapi_position_id: String(ticket),
          metaapi_executed_lot: lot,
          metaapi_execution_channel: "bridge",
          metaapi_execution_status: "filled",
          metaapi_execution_error: null,
          executed_at: new Date().toISOString(),
          status: "executed",
        }
      : {
          metaapi_execution_status: "failed",
          metaapi_execution_error: errorMsg || "bridge execution failed",
          paper_status: "watching",
        };

    const { error: dbError } = await supabase.from("signals").update(update).eq("id", signalId);
    if (dbError) {
      console.error("bridge-report-execution database update failed", dbError.message);
      return json({ ok: false, error: "Database update failed" }, 500);
    }
    return json({ ok: true });
  } catch (e) {
    console.error("bridge-report-execution error", e);
    return json({ ok: false, error: "Internal error reporting execution" }, 500);
  }
});
