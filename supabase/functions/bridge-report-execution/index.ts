// Report-back endpoint — called by the ScalpEdge Bridge MT4 EA immediately after
// it attempts to execute a claimed signal. Writes the MT4 ticket back onto the
// signal row as metaapi_position_id, so metaapi-sync's EXISTING trailing/close
// reconciliation picks it up exactly like a MetaAPI-executed trade — MetaAPI stays
// connected to this same broker account as the fallback channel, so it sees this
// position too. No separate bridge-side trailing logic needed or maintained here.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { checkSecret, corsHeaders, safeError } from "../_shared/metaapi.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const unauth = checkSecret(req);
  if (unauth) return unauth;

  try {
    const body = await req.json().catch(() => ({}));
    const signalId = String(body.signal_id ?? "");
    const ticket = Number(body.ticket ?? 0);
    const lot = Number(body.lot ?? 0);
    const success = !!body.success;
    const errorMsg = String(body.error ?? "");

    if (!signalId) return safeError("signal_id required", 400);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    if (success && ticket > 0) {
      await supabase.from("signals").update({
        metaapi_order_id: String(ticket),
        metaapi_position_id: String(ticket),
        metaapi_executed_lot: lot,
        metaapi_execution_channel: "bridge",
        metaapi_execution_status: "filled",
        metaapi_execution_error: null,
        executed_at: new Date().toISOString(),
        status: "executed",
      }).eq("id", signalId);
    } else {
      await supabase.from("signals").update({
        metaapi_execution_status: "failed",
        metaapi_execution_error: (errorMsg || "bridge execution failed").slice(0, 500),
        paper_status: "watching",
      }).eq("id", signalId);
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("bridge-report-execution error", e);
    return safeError("internal error reporting execution", 500);
  }
});
