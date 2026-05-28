// Executes a MetaApi market order for a given signal id.
// Idempotent — refuses to re-execute a signal that already has a position id.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { checkSecret, corsHeaders, pairToSymbol, placeMarketOrder } from "../_shared/metaapi.ts";

async function markFailed(supabase: any, signalId: string, error: string) {
  await supabase.from("signals").update({
    metaapi_execution_status: "failed",
    metaapi_execution_error: error.slice(0, 500),
  }).eq("id", signalId);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const unauth = checkSecret(req);
  if (unauth) return unauth;

  try {
    const { signal_id } = await req.json().catch(() => ({}));
    if (!signal_id || typeof signal_id !== "string") {
      return new Response(JSON.stringify({ error: "signal_id required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const [{ data: signal }, { data: cfg }] = await Promise.all([
      supabase.from("signals").select("*").eq("id", signal_id).maybeSingle(),
      supabase.from("app_settings").select("*").eq("id", "singleton").maybeSingle(),
    ]);
    if (!signal) {
      return new Response(JSON.stringify({ ok: false, reason: "signal not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if ((signal as any).metaapi_position_id) {
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
    const token = Deno.env.get("METAAPI_TOKEN");

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

    const result = await placeMarketOrder({
      region, accountId, token,
      symbol: pairToSymbol(s.pair),
      side: s.direction === "Long" ? "BUY" : "SELL",
      volume: lot,
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
    await supabase.from("signals").update({
      metaapi_position_id: data.positionId ?? null,
      metaapi_order_id: data.orderId ?? null,
      metaapi_execution_status: data.positionId ? "filled" : "pending",
      metaapi_execution_error: null,
      executed_at: new Date().toISOString(),
      status: "executed",
    }).eq("id", signal_id);

    return new Response(JSON.stringify({ ok: true, positionId: data.positionId, orderId: data.orderId }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
