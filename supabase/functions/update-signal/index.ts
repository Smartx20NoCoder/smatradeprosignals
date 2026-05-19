import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const { id, status } = await req.json();
    if (!id || !status) throw new Error("id and status required");
    const allowed = ["pending", "win", "loss", "be", "tp1", "tp2"];
    if (!allowed.includes(status)) throw new Error("invalid status");

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { data: sig } = await supabase
      .from("signals")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (!sig) throw new Error("signal not found");

    let outcome_r: number | null = null;
    const risk = Math.abs(sig.entry - sig.stop_loss);
    if (risk > 0) {
      if (status === "tp1") outcome_r = Math.abs(sig.tp1 - sig.entry) / risk;
      else if (status === "tp2" || status === "win") outcome_r = Math.abs(sig.tp2 - sig.entry) / risk;
      else if (status === "loss") outcome_r = -1;
      else if (status === "be") outcome_r = 0;
    }

    const update: Record<string, unknown> = { status };
    if (status !== "pending") {
      update.outcome_r = outcome_r;
      update.closed_at = new Date().toISOString();
    } else {
      update.outcome_r = null;
      update.closed_at = null;
    }

    const { error } = await supabase.from("signals").update(update).eq("id", id);
    if (error) throw error;
    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
