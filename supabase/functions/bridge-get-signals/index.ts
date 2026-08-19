// Bridge polling endpoint — called by the ScalpEdge Bridge MT4 EA on a timer.
// Returns:
//   - risk: the LIVE settings-page risk/lot config, sent every poll so the EA's
//     lot sizing always matches what's configured in Settings rather than a
//     static value baked into the EA's own inputs (same "single source of truth"
//     principle already used for SL/TP/trail sizing on the MT4 side).
//   - signals: qualifying, not-yet-executed signals for the bridge-handled pairs
//     (GBP/USD, XAU/USD by default — configurable via app_settings.bridge_pairs).
// Also records a heartbeat (bridge_last_seen) so metaapi-execute knows whether
// to defer to the bridge or fall back to MetaAPI execution.
//
// Claim semantics: a brand-new qualifying signal is atomically flipped to
// metaapi_execution_status="bridge_claimed" the FIRST time it's returned here.
// From then on it keeps being returned (still "bridge_claimed", still unfilled)
// on every subsequent poll so the EA can keep re-checking price against it,
// until it either fills (EA calls bridge-report-execution) or expires (this
// endpoint marks it "failed" and stops returning it once bridge_claim_expiry_min
// has elapsed since it was claimed).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { checkSecret, corsHeaders, safeError } from "../_shared/metaapi.ts";

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

    // Heartbeat — record that the bridge is alive and polling, regardless of
    // whether there happen to be any signals to hand back this cycle.
    await supabase.from("app_settings")
      .update({ bridge_last_seen: new Date().toISOString() })
      .eq("id", "singleton");

    // Live risk/lot config — sent every poll so the EA never trades on a stale
    // local copy of these values if Settings gets changed.
    const mode = (c?.metaapi_active_mode as string | null) ?? "demo";
    const isLive = mode === "live";
    const isCentAccount = isLive
      ? Boolean(c?.metaapi_is_cent_account_live)
      : Boolean(c?.metaapi_is_cent_account);
    const risk = {
      risk_pct: Number(c?.metaapi_risk_per_trade_pct ?? 2),
      min_lot: Number(c?.metaapi_min_lot ?? 0.10),
      max_lot: Number(c?.metaapi_max_lot ?? 0.50),
      is_cent_account: isCentAccount,
    };

    if (!c.metaapi_auto_trade) {
      return new Response(JSON.stringify({ ok: true, risk, signals: [] }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const bridgePairs: string[] = Array.isArray(c.bridge_pairs) && c.bridge_pairs.length > 0
      ? c.bridge_pairs
      : ["GBP/USD", "XAU/USD"];
    const minConf = Number(c.metaapi_min_confidence ?? 75);
    const minRR = Number(c.metaapi_min_rr ?? 2);
    const maxTrades = Number(c.metaapi_max_trades ?? 3);
    const claimExpiryMin = Number(c.bridge_claim_expiry_min ?? 20);
    const pairConfig = (c.pair_auto_execute ?? {}) as Record<string, boolean>;
    const setupConfig = (c.setup_auto_execute ?? {}) as Record<string, boolean>;

    // Expire stale claims first — anything the bridge grabbed but never filled
    // within the expiry window. Marked failed so a fresh signal generates
    // naturally rather than the EA chasing a stale entry price forever.
    const expiryCutoff = new Date(Date.now() - claimExpiryMin * 60_000).toISOString();
    const { data: staleClaims } = await supabase
      .from("signals")
      .select("id")
      .eq("metaapi_execution_status", "bridge_claimed")
      .lt("bridge_claimed_at", expiryCutoff);
    if (staleClaims && staleClaims.length > 0) {
      await supabase.from("signals").update({
        metaapi_execution_status: "failed",
        metaapi_execution_error: `Bridge claim expired after ${claimExpiryMin}min — price never reached entry zone.`,
        paper_status: "watching",
      }).in("id", staleClaims.map((r: any) => r.id));
    }

    // Already-claimed, still-open signals — keep returning these every poll
    // until they fill or expire, so the EA can keep re-checking price.
    const { data: alreadyClaimed } = await supabase
      .from("signals")
      .select("id, pair, direction, order_type, entry, stop_loss, tp2")
      .eq("metaapi_execution_status", "bridge_claimed")
      .in("pair", bridgePairs);

    // Fresh, qualifying, unclaimed signals — same gates as metaapi-execute
    // (confidence, RR, pair/setup toggles). Broker-specific checks (SL distance,
    // live price proximity) are the EA's job once it has a live quote.
    const { count: activeCount } = await supabase
      .from("signals")
      .select("id", { count: "exact", head: true })
      .in("metaapi_execution_status", ["filled", "bridge_claimed"]);
    const roomForMore = (activeCount ?? 0) < maxTrades;

    const freshClaimed: any[] = [];
    if (roomForMore) {
      const { data: candidates } = await supabase
        .from("signals")
        .select("id, pair, direction, order_type, entry, stop_loss, tp2, confidence, rr, setup")
        .in("pair", bridgePairs)
        .is("metaapi_execution_status", null)
        .order("created_at", { ascending: true })
        .limit(10);

      for (const s of (candidates ?? []) as any[]) {
        if (Number(s.confidence) < minConf || Number(s.rr) < minRR) continue;
        if (pairConfig[String(s.pair)] === false) continue;
        const setupComponents = String(s.setup ?? "")
          .split("+").map((x: string) => x.split("(")[0].trim()).filter(Boolean);
        if (!setupComponents.every((comp: string) => setupConfig[comp] !== false)) continue;

        // Optimistic-lock claim: only succeeds if still unclaimed at write time.
        const { data: claimedRow, error } = await supabase
          .from("signals")
          .update({
            metaapi_execution_status: "bridge_claimed",
            metaapi_execution_channel: "bridge",
            bridge_claimed_at: new Date().toISOString(),
          })
          .eq("id", s.id)
          .is("metaapi_execution_status", null)
          .select("id, pair, direction, order_type, entry, stop_loss, tp2")
          .maybeSingle();
        if (!error && claimedRow) freshClaimed.push(claimedRow);
      }
    }

    const signals = [...(alreadyClaimed ?? []), ...freshClaimed];
    return new Response(JSON.stringify({ ok: true, risk, signals }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("bridge-get-signals error", e);
    return safeError("internal error fetching bridge signals", 500);
  }
});
