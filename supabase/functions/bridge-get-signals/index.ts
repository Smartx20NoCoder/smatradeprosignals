// Bridge polling endpoint — called by the ScalpEdge Bridge MT4 EA on a timer.
// Returns:
//   - scanning_active: mirrors scan-signals' own isWithinTradingHours()/paused check
//     (same session_config + trading_hours_start_utc/end_utc fields, same interpretation).
//     When false, the app has stopped scanning for new signals — the EA uses this to
//     force-close any open bridge positions, same "Hard EOD Stop" pattern already
//     proven in AdaptiveSupertrend.mq4's ForceCloseHour. Kept in sync manually with
//     scan-signals.ts's isWithinTradingHours() — if that logic changes there, mirror
//     the change here too.
//   - risk: the LIVE settings-page risk/lot config, sent every poll so the EA's
//     lot sizing always matches what's configured in Settings rather than a
//     static value baked into the EA's own inputs.
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

// ── Trading-hours check — mirrored from scan-signals.ts's isWithinTradingHours() ──
type SessionWindow = { enabled: boolean; start: number; end: number };
type SessionConfig = {
  scan_active_sessions_only: boolean;
  sessions: { london: SessionWindow; ny: SessionWindow; tokyo: SessionWindow; sydney: SessionWindow };
  custom_overrides: Record<string, { start: number; end: number } | null>;
};
const DEFAULT_SESSION_CONFIG: SessionConfig = {
  scan_active_sessions_only: false,
  sessions: {
    london: { enabled: true, start: 7, end: 16 },
    ny:     { enabled: true, start: 12, end: 21 },
    tokyo:  { enabled: true, start: 0, end: 9 },
    sydney: { enabled: true, start: 22, end: 7 },
  },
  custom_overrides: {},
};
function hourInWindow(h: number, start: number, end: number): boolean {
  return start <= end ? (h >= start && h < end) : (h >= start || h < end);
}
// Per-pair setup override: checks a pair-scoped key ("PAIR|component") first,
// falling back to the plain global component key so existing toggles keep
// working unchanged for any pair without an override.
function isComponentDisabledForPair(setupConfig: Record<string, boolean>, pair: string, component: string): boolean {
  const pairKey = `${pair}|${component}`;
  if (Object.prototype.hasOwnProperty.call(setupConfig, pairKey)) return setupConfig[pairKey] === false;
  return setupConfig[component] === false;
}

function isWithinTradingHours(d: Date, c: any): boolean {
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return false; // hard weekend guard for the scalping engine
  const h = d.getUTCHours();
  const dow = String(day);
  const cfg: SessionConfig = (c?.session_config as SessionConfig) ?? DEFAULT_SESSION_CONFIG;
  const override = cfg.custom_overrides?.[dow];
  if (override && typeof override.start === "number" && typeof override.end === "number") {
    return hourInWindow(h, override.start, override.end);
  }
  if (cfg.scan_active_sessions_only) {
    const ss = cfg.sessions ?? DEFAULT_SESSION_CONFIG.sessions;
    return Object.values(ss).some((w) => w.enabled && hourInWindow(h, w.start, w.end));
  }
  const start = Number(c?.trading_hours_start_utc ?? 1);
  const end = Number(c?.trading_hours_end_utc ?? 20);
  return hourInWindow(h, start, end);
}

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

    // Scanning-active flag — paused toggle OR outside trading hours both mean
    // "the app has stopped looking for new signals right now."
    const scanningActive = !c.paused && isWithinTradingHours(new Date(), c);

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
      return new Response(JSON.stringify({ ok: true, scanning_active: scanningActive, risk, signals: [] }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const bridgePairs: string[] = Array.isArray(c.bridge_pairs) && c.bridge_pairs.length > 0
      ? c.bridge_pairs
      : ["GBP/USD", "XAU/USD", "BTC/USD"];
    const minConf = Number(c.metaapi_min_confidence ?? 75);
    const minRR = Number(c.metaapi_min_rr ?? 2);
    const maxTrades = Number(c.metaapi_max_trades ?? 3);
    // ─── DYNAMIC VALUE LINKED TO YOUR FRONTEND SETTINGS BOX ───
    const claimExpiryMin = Number(c.bridge_claim_expiry_min ?? 45);
    const pairConfig = (c.pair_auto_execute ?? {}) as Record<string, boolean>;
    const setupConfig = (c.setup_auto_execute ?? {}) as Record<string, boolean>;

    // Expire stale claims first — anything the bridge grabbed but never filled
    // within the expiry window. Marked failed so a fresh signal generates
    // naturally rather than the EA chasing a stale entry price forever.
    const claimExpiryCutoff = new Date(Date.now() - claimExpiryMin * 60_000).toISOString();
    const signalValidityCutoff = new Date(Date.now() - 6 * 3600_000).toISOString();
    const { data: staleClaims } = await supabase
      .from("signals")
      .select("id")
      .eq("metaapi_execution_status", "bridge_claimed")
      .lt("bridge_claimed_at", claimExpiryCutoff);
    if (staleClaims && staleClaims.length > 0) {
      await supabase.from("signals").update({
        metaapi_execution_status: "failed",
        metaapi_execution_error: `Bridge claim expired after ${claimExpiryMin}min — price never reached entry zone.`,
        status: "expired",
        paper_status: "watching",
      }).in("id", staleClaims.map((r: any) => r.id));
    }

    // Re-open pair-guarded signals when their blocking live trade has since closed.
    // These signals remain strategy-valid for up to 6h; the EA still applies its
    // normal entry-tolerance checks before any actual order can fill.
    const { data: deferredRows } = await supabase
      .from("signals")
      .select("id,pair,status,paper_status,metaapi_execution_error,notes,created_at")
      .eq("metaapi_execution_status", "skipped")
      .eq("paper_only", true)
      .eq("status", "pending")
      .in("paper_status", ["watching", "triggered"])
      .gte("created_at", signalValidityCutoff)
      .like("metaapi_execution_error", "Pair already active%");

    for (const s of (deferredRows ?? []) as any[]) {
      const pair = String(s.pair);
      // If any filled/claimed row still occupies the pair, keep it deferred.
      const { count: activePairCount } = await supabase
        .from("signals")
        .select("id", { count: "exact", head: true })
        .eq("pair", pair)
        .in("metaapi_execution_status", ["filled", "bridge_claimed"]);
      if ((activePairCount ?? 0) > 0) continue;

      await supabase.from("signals").update({
        metaapi_execution_status: "none",
        metaapi_execution_error: null,
        paper_only: false,
      }).eq("id", s.id)
        .eq("metaapi_execution_status", "skipped")
        .eq("status", "pending");
    }

    // Don't hand out NEW claims once scanning has stopped — only keep tracking
    // claims already in flight so they can still fill or expire cleanly.
    const { data: claimedRows } = await supabase
      .from("signals")
      .select("id,pair,direction,order_type,entry,stop_loss,tp2,bridge_claimed_at")
      .eq("metaapi_execution_status", "bridge_claimed")
      .in("pair", bridgePairs)
      .order("bridge_claimed_at", { ascending: true });

    // One active execution slot per pair. Filled positions are time-bounded so a
    // dropped close report cannot wedge a pair forever; claimed rows self-expire.
    const filledCutoff = new Date(Date.now() - 48 * 3600_000).toISOString();
    const { data: filledRows } = await supabase
      .from("signals")
      .select("id,pair,direction")
      .eq("metaapi_execution_status", "filled")
      .gte("executed_at", filledCutoff);

    const occupied = new Map<string, { id: string; direction: string }>();
    for (const r of (filledRows ?? []) as any[]) {
      occupied.set(String(r.pair), { id: String(r.id), direction: String(r.direction) });
    }

    // Preserve only the first still-claimed signal per pair. Any extra claim is
    // converted to paper-only before it can become a second live position.
    const alreadyClaimed: any[] = [];
    for (const r of (claimedRows ?? []) as any[]) {
      const pair = String(r.pair);
      if (occupied.has(pair)) {
        const active = occupied.get(pair)!;
        const relation = String(active.direction).toLowerCase() === String(r.direction).toLowerCase()
          ? "confirmation" : "contradiction";
        await supabase.from("signals").update({
          metaapi_execution_status: "skipped",
          metaapi_execution_error: `Pair already active — paper tracked only (${relation})`,
          paper_only: true,
          paper_status: "watching",
        }).eq("id", r.id).eq("metaapi_execution_status", "bridge_claimed");
        continue;
      }
      occupied.set(pair, { id: String(r.id), direction: String(r.direction) });
      alreadyClaimed.push(r);
    }

    const activeExecutionCount = (filledRows ?? []).length + alreadyClaimed.length;
    let remainingSlots = Math.max(0, maxTrades - activeExecutionCount);
    const freshClaimed: any[] = [];

    if (scanningActive) {
      const { data: candidates } = await supabase
        .from("signals")
        .select("id,pair,direction,order_type,entry,stop_loss,tp2,confidence,rr,setup,notes")
        .in("pair", bridgePairs)
        .eq("metaapi_execution_status", "none")
        .gte("created_at", signalValidityCutoff)
.order("created_at", { ascending: false })
        .limit(20);

      for (const s of (candidates ?? []) as any[]) {
        if (Number(s.confidence) < minConf || Number(s.rr) < minRR) continue;
        if (pairConfig[String(s.pair)] === false) continue;
        const setupComponents = String(s.setup ?? "")
          .split("+").map((x: string) => x.split("(")[0].trim()).filter(Boolean);
        if (!setupComponents.every((comp: string) => !isComponentDisabledForPair(setupConfig, String(s.pair), comp))) continue;

        const pair = String(s.pair);
        const active = occupied.get(pair);
        if (active) {
          const relation = String(active.direction).toLowerCase() === String(s.direction).toLowerCase()
            ? "confirmation" : "contradiction";
          const guardNote = `PAIR_GUARD_V1|blocked_by=${active.id}|relation=${relation}`;
          await supabase.from("signals").update({
            metaapi_execution_status: "skipped",
            metaapi_execution_error: `Pair already active — paper tracked only (${relation})`,
            paper_only: true,
            paper_status: "watching",
            notes: s.notes ? `${s.notes}|${guardNote}` : guardNote,
          }).eq("id", s.id).eq("metaapi_execution_status", "none");
          continue;
        }

        if (remainingSlots <= 0) {
          await supabase.from("signals").update({
            metaapi_execution_status: "skipped",
            metaapi_execution_error: "Account active-trade limit reached — paper tracked only",
            paper_only: true,
            paper_status: "watching",
          }).eq("id", s.id).eq("metaapi_execution_status", "none");
          continue;
        }

        // Optimistic-lock claim: only succeeds if still unclaimed at write time.
        const { data: claimedRow, error } = await supabase
          .from("signals")
          .update({
            metaapi_execution_status: "bridge_claimed",
            metaapi_execution_channel: "bridge",
            bridge_claimed_at: new Date().toISOString(),
          })
          .eq("id", s.id)
          .eq("metaapi_execution_status", "none")
          .select("id,pair,direction,order_type,entry,stop_loss,tp2")
          .maybeSingle();

        if (!error && claimedRow) {
          freshClaimed.push(claimedRow);
          occupied.set(pair, { id: String(claimedRow.id), direction: String(claimedRow.direction) });
          remainingSlots--;
        }
      }
    }

    const signals = [...alreadyClaimed, ...freshClaimed];
    return new Response(JSON.stringify({ ok: true, scanning_active: scanningActive, risk, signals }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("bridge-get-signals error", e);
    return safeError("internal error fetching bridge signals", 500);
  }
});
