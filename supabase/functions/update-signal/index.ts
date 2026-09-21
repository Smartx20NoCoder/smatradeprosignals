import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-fn-secret",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const expected = Deno.env.get("INTERNAL_FN_SECRET");
  if (!expected || req.headers.get("x-fn-secret") !== expected) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  try {
    const { id, status, partial } = await req.json();
    if (!id || !status) throw new Error("id and status required");
    const allowed = ["pending", "executed", "win", "loss", "be", "tp1", "tp2", "expired"];
    if (!allowed.includes(status)) throw new Error("invalid status");

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { data: sig } = await supabase
      .from("signals").select("*").eq("id", id).maybeSingle();
    if (!sig) throw new Error("signal not found");

    const isPartial = status === "tp1" && !!partial;
    let outcome_r: number | null = null;
    const risk = Math.abs(sig.entry - sig.stop_loss);
    if (risk > 0) {
      if (status === "tp1") {
        const tp1R = Math.abs(sig.tp1 - sig.entry) / risk;
        outcome_r = isPartial ? +(tp1R / 2).toFixed(2) : tp1R;
      }
      else if (status === "tp2" || status === "win") outcome_r = Math.abs(sig.tp2 - sig.entry) / risk;
      else if (status === "loss") outcome_r = -1;
      else if (status === "be") outcome_r = 0;
      else if (status === "expired") outcome_r = 0;
    }

    const update: Record<string, unknown> = { status };
    if (status === "pending") {
      update.outcome_r = null; update.closed_at = null; update.executed_at = null; update.partial_close = false;
    } else if (status === "executed") {
      update.outcome_r = null; update.closed_at = null;
      update.executed_at = new Date().toISOString();
    } else {
      update.outcome_r = outcome_r;
      update.closed_at = new Date().toISOString();
      if (status === "tp1") update.partial_close = isPartial;
    }

    const { error } = await supabase.from("signals").update(update).eq("id", id);
    if (error) throw error;
    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("update-signal error", e);
    return new Response(JSON.stringify({ error: "invalid request" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
