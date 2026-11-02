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
    // V2 management audit events share the authenticated execution-report
    // transport without changing the legacy execution report payload.
    if (body.kind === "management_event") {
      const types = new Set([
        "breakeven_lock", "early_lock", "trailing_sl",
        "rolling_tp", "partial_close", "risk_block", "risk_fill",
      ]);
      const eventId = String(body.event_id ?? "").trim();
      const eventType = String(body.event_type ?? "").trim();
      const positionId = String(body.position_id ?? "").trim();
      const symbol = String(body.symbol ?? "").slice(0, 40);
      if (!types.has(eventType) || !eventId || eventId.length > 180 ||
          !/^[a-zA-Z0-9_.:\\-]+$/.test(eventId) ||
          (eventType !== "risk_block" && !positionId)) {
        return json({ ok: false, error: "Invalid management event" }, 400);
      }
      const url = Deno.env.get("SUPABASE_URL");
      const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
      if (!url || !key) return json({ ok: false, error: "Service not configured" }, 500);
      const supabase = createClient(url, key);
      const numberOrNull = (field: string) => {
        const raw = body[field];
        if (raw === null || raw === undefined || raw === "") return null;
        const value = Number(raw);
        return Number.isFinite(value) ? value : null;
      };
      let signalId: string | null = null;
      if (positionId) {
        const { data: signal, error: lookupError } = await supabase
          .from("signals").select("id")
          .eq("metaapi_position_id", positionId).maybeSingle();
        if (lookupError) return json({ ok: false, error: "Position lookup failed" }, 500);
        signalId = signal?.id ?? null;
      }
      const entry = {
        event_id: eventId,
        event_type: eventType,
        position_id: positionId || null,
        signal_id: signalId,
        deal_ticket: String(body.deal_ticket ?? "").slice(0, 40) || null,
        symbol: symbol || null,
        stage: String(body.stage ?? "").slice(0, 50) || null,
        old_sl: numberOrNull("old_sl"),
        new_sl: numberOrNull("new_sl"),
        old_tp: numberOrNull("old_tp"),
        new_tp: numberOrNull("new_tp"),
        closed_volume: numberOrNull("closed_volume"),
        realized_pnl: numberOrNull("realized_pnl"),
        account_equity: numberOrNull("account_equity"),
        account_balance: numberOrNull("account_balance"),
        daily_start_equity: numberOrNull("daily_start_equity"),
        daily_drawdown_pct: numberOrNull("daily_drawdown_pct"),
        projected_risk_pct: numberOrNull("projected_risk_pct"),
        broker_time_epoch: numberOrNull("broker_time_epoch"),
      };
      const { error: insertError } = await supabase
        .from("bridge_trade_events").upsert(entry, {
          onConflict: "event_id", ignoreDuplicates: true,
        });
      if (insertError) {
        console.error("bridge management event insert failed", insertError);
        return json({ ok: false, error: "Audit event not stored" }, 500);
      }
      if (signalId && (eventType === "breakeven_lock" || eventType === "partial_close")) {
        const patch = eventType === "breakeven_lock"
          ? { metaapi_breakeven_moved: true }
          : { metaapi_partial_closed: true };
        const { error: patchError } = await supabase
          .from("signals").update(patch).eq("id", signalId);
        if (patchError) {
          console.error("bridge management signal flag update failed", patchError);
          return json({ ok: false, error: "Audit flag not updated" }, 500);
        }
      }
      return json({ ok: true, audited: true, matched: !!signalId });
    }

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
