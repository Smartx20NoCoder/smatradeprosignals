// Syncs MetaApi state back to signals for the SINGLE-ORDER model.
// - While the position is open: run a continuous stepped R-multiple trail (never
//   loosens the stop, ratchets it forward one step behind live progress). Same
//   philosophy as the MT4 EA's trail — just no second "runner" order to manage.
// - When the position closes: reconcile final PnL and classify the outcome by the
//   R-multiple the close price actually reached (not a fixed TP1/TP2 split anymore).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  checkSecret,
  corsHeaders,
  getHistoryDealsByPosition,
  getHistoryOrderById,
  getOpenPositions,
  getSymbolPrice,
  modifyPosition,
  pairToSymbol,
  safeError,
} from "../_shared/metaapi.ts";

// Continuous single-order trailing stop — steps the SL forward every sync cycle.
// Mirrors the MT4 EA's stepped-ratchet trail: never loosens, locks in R progressively
// instead of jumping straight to a fixed floor. Returns true if the SL was moved.
async function applyTrail(params: {
  supabase: any; region: string; accountId: string; token: string; suffix: string;
  s: any; pid: string; livePos: any; trailStepR: number; trailActivateR: number;
}): Promise<boolean> {
  const { supabase, region, accountId, token, suffix, s, pid, livePos, trailStepR, trailActivateR } = params;
  const risk = Math.abs(Number(s.entry) - Number(s.stop_loss));
  if (risk <= 0 || trailStepR <= 0) return false;

  const isLong = String(s.direction ?? "").toLowerCase().includes("long")
    || String(s.order_type ?? "").toLowerCase().includes("buy");

  // Prefer the live position's own currentPrice; fall back to a fresh quote if absent.
  let currentPrice = Number(livePos?.currentPrice ?? 0);
  if (!currentPrice) {
    const symbol = pairToSymbol(String(s.pair), suffix);
    const pr = await getSymbolPrice({ region, accountId, token, symbol });
    if (!pr.ok) return false;
    currentPrice = isLong ? Number(pr.bid ?? 0) : Number(pr.ask ?? 0);
  }
  if (!currentPrice) return false;

  const progressR = isLong
    ? (currentPrice - Number(s.entry)) / risk
    : (Number(s.entry) - currentPrice) / risk;
  if (progressR < trailActivateR) return false;

  // Lock in one step BEHIND current progress — e.g. at 1.4R progress with a 0.5R step,
  // the floor sits at entry + 1.0R (the last fully-completed step), not 1.4R itself.
  const lockedSteps = Math.floor(progressR / trailStepR) * trailStepR;
  const laggedSteps = Math.max(lockedSteps - trailStepR, 0);
  const newSL = isLong
    ? Number(s.entry) + risk * laggedSteps
    : Number(s.entry) - risk * laggedSteps;

  const currentSL = Number(s.stop_loss);
  const improves = isLong ? newSL > currentSL + 1e-9 : newSL < currentSL - 1e-9;
  if (!improves) return false;

  const mod = await modifyPosition({
    region, accountId, token, positionId: pid,
    stopLoss: newSL, takeProfit: Number(s.tp2),
  });
  if (!mod.ok) {
    console.error("trail modify failed for", pid, mod.error);
    return false;
  }
  await supabase.from("signals").update({ stop_loss: newSL }).eq("id", s.id);
  return true;
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

    // Diagnostic: log MetaApi execution failure breakdown (last 48h).
    try {
      const since48h = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
      const { data: failedRows } = await supabase
        .from("signals")
        .select("metaapi_execution_error")
        .eq("metaapi_execution_status", "failed")
        .gte("created_at", since48h);
      const breakdown: Record<string, number> = {};
      for (const r of (failedRows ?? []) as any[]) {
        const key = String(r.metaapi_execution_error ?? "(null)").slice(0, 200);
        breakdown[key] = (breakdown[key] ?? 0) + 1;
      }
      const sorted = Object.entries(breakdown).sort((a, b) => b[1] - a[1]);
      console.log("[metaapi-sync] failed-execution breakdown (48h):", JSON.stringify(sorted));
    } catch (e) {
      console.error("[metaapi-sync] failure breakdown query error", e);
    }

    const { data: cfg } = await supabase
      .from("app_settings").select("*").eq("id", "singleton").maybeSingle();
    const c: any = cfg ?? {};
    const mode = (c?.metaapi_active_mode as string | null) ?? "demo";
    const isLive = mode === "live";
    const baseAccountId = c?.metaapi_account_id as string | null;
    const baseRegion = (c?.metaapi_region as string | null) ?? "new-york";
    const baseToken = (c?.metaapi_token as string | null) || Deno.env.get("METAAPI_TOKEN") || null;
    const baseSuffix = (c?.metaapi_symbol_suffix as string | null) ?? "";

    const accountId = isLive
      ? ((c?.metaapi_account_id_live as string | null) ?? baseAccountId)
      : baseAccountId;
    const region = isLive
      ? ((c?.metaapi_region_live as string | null) ?? baseRegion)
      : baseRegion;
    const token = isLive
      ? ((c?.metaapi_token_live as string | null) || baseToken)
      : baseToken;
    const effectiveSuffix = isLive
      ? ((c?.metaapi_symbol_suffix_live as string | null) ?? baseSuffix)
      : baseSuffix;
    if (!token || !accountId) {
      return new Response(JSON.stringify({ ok: false, reason: "not configured" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Pass 1: promote pending LIMIT/STOP orders to "filled" once broker fills them.
    let pendingPromoted = 0;
    const { data: pendingSignals } = await supabase
      .from("signals")
      .select("id, created_at, metaapi_order_id, metaapi_position_id")
      .eq("metaapi_execution_status", "order_pending");

    for (const po of (pendingSignals ?? []) as any[]) {
      if (po.metaapi_position_id) continue; // already filled
      const orderId = po.metaapi_order_id;
      if (!orderId) continue;
      const startTime = new Date(new Date(po.created_at).getTime() - 60_000).toISOString();
      const ord = await getHistoryOrderById({
        region, accountId, token, orderId: String(orderId), startTime,
      });
      if (!ord.ok || !ord.data) continue;
      const positionId = ord.data.positionId ? String(ord.data.positionId) : null;
      const state = String(ord.data.state ?? "").toUpperCase();
      if (positionId && (state.includes("FILLED") || state === "ORDER_STATE_FILLED" || state === "")) {
        await supabase.from("signals").update({
          metaapi_position_id: positionId,
          metaapi_execution_status: "filled",
          executed_at: new Date().toISOString(),
          status: "executed",
        }).eq("id", po.id);
        pendingPromoted++;
      } else if (state.includes("CANCEL") || state.includes("EXPIRED") || state.includes("REJECT")) {
        await supabase.from("signals").update({
          metaapi_execution_status: "canceled",
          metaapi_execution_error: "order canceled/expired/rejected by broker",
        }).eq("id", po.id);
        pendingPromoted++;
      }
    }

    // Pass 2: reconcile signals with active executions + run the continuous trail.
    const trailStepR = Number((c as any)?.metaapi_trail_lock_r ?? 0.5);
    const trailActivateR = Number((c as any)?.metaapi_trail_activate_r ?? 0.35);

    const { data: openSignals } = await supabase
      .from("signals")
      .select("id, pair, direction, order_type, entry, stop_loss, tp1, tp2, created_at, metaapi_position_id, metaapi_filled_price, metaapi_execution_status, metaapi_executed_lot")
      .eq("metaapi_execution_status", "filled");

    let updated = 0;
    let trailed = 0;
    let closes = 0;
    const openSet = new Set<string>();
    const openMap = new Map<string, any>();

    if (openSignals && openSignals.length > 0) {
      const positionsRes = await getOpenPositions({ region, accountId, token });
      if (!positionsRes.ok) {
        console.error("getOpenPositions failed", positionsRes.error);
      } else {
        for (const p of positionsRes.data) {
          const id = String(p.id);
          openSet.add(id);
          openMap.set(id, p);
        }
      }
    }

    for (const s of (openSignals ?? []) as any[]) {
      try {
        // Time exit: 2h for crypto, 4h for FX/Gold
        const isCryptoSignal = ["BTC/USD","ETH/USD","XRP/USD"].includes(s.pair ?? "");
        const maxAgeMs       = isCryptoSignal ? 2 * 60 * 60 * 1000 : 4 * 60 * 60 * 1000;
        const signalAgeMs    = Date.now() - new Date(s.created_at).getTime();

        if (signalAgeMs > maxAgeMs && s.metaapi_execution_status === "filled") {
          try {
            if (s.metaapi_position_id) {
              await fetch(
                `https://mt-client-api-v1.${region}.agiliumtrade.ai` +
                `/users/current/accounts/${accountId}/trade`,
                {
                  method: "POST",
                  headers: { "auth-token": token, "Content-Type": "application/json" },
                  body: JSON.stringify({ actionType: "POSITION_CLOSE_ID", positionId: s.metaapi_position_id }),
                }
              );
            }
          } catch (e) {
            console.log(`Time exit close failed for ${s.id}: ${e}`);
          }

          await supabase.from("signals").update({
            status:                    "expired",
            metaapi_execution_status:  "closed",
            closed_at:                 new Date().toISOString(),
            notes: `[Time exit: ${isCryptoSignal ? "2h" : "4h"} limit reached]`,
          }).eq("id", s.id);

          closes++;
          updated++;
          continue;
        }

        const pid = s.metaapi_position_id ? String(s.metaapi_position_id) : null;
        const isOpen = !!pid && openSet.has(pid);

        // Still open → run the trail, then refresh PnL.
        if (isOpen) {
          const livePos = openMap.get(pid!);
          const moved = await applyTrail({
            supabase, region, accountId, token, suffix: effectiveSuffix,
            s, pid: pid!, livePos, trailStepR, trailActivateR,
          });
          if (moved) trailed++;
          await supabase.from("signals").update({
            metaapi_pnl: Number(livePos?.unrealizedProfit ?? 0),
            metaapi_filled_price: s.metaapi_filled_price ?? Number(livePos?.openPrice ?? 0),
          }).eq("id", s.id);
          updated++;
          continue;
        }

        // Closed → reconcile final PnL and classify the outcome by R-multiple reached.
        let totalPnl = 0;
        let lastTime: string | null = null;
        let closePrice: number | null = null;
        if (pid) {
          try {
            const ph = await getHistoryDealsByPosition({ region, accountId, token, positionId: pid });
            if (ph.ok && ph.data) {
              for (const d of (ph.data as any[])) {
                totalPnl += Number(d.profit ?? 0) + Number(d.swap ?? 0) + Number(d.commission ?? 0);
                const t = d.time as string | undefined;
                if (t && (!lastTime || new Date(t).getTime() >= new Date(lastTime).getTime())) {
                  lastTime = t;
                  const px = Number(d.price ?? d.closePrice ?? 0);
                  if (Number.isFinite(px) && px > 0) closePrice = px;
                }
              }
            }
          } catch (e) {
            console.error("history-deals/position failed for", pid, e);
          }
        }

        const isLong = String(s.direction ?? "").toLowerCase().includes("long")
          || String(s.order_type ?? "").toLowerCase().includes("buy");
        const risk = Math.abs(Number(s.entry) - Number(s.stop_loss));
        const rMultiple = (risk > 0 && closePrice != null)
          ? (isLong ? (closePrice - Number(s.entry)) / risk : (Number(s.entry) - closePrice) / risk)
          : (totalPnl >= 0 ? 0 : -1);
        const tp2R = risk > 0
          ? (isLong ? (Number(s.tp2) - Number(s.entry)) / risk : (Number(s.entry) - Number(s.tp2)) / risk)
          : null;

        // Outcome buckets reuse the EXISTING status vocabulary so the frontend needs no
        // changes: "tp2" = reached the final target, "tp1" = closed in profit via the
        // trailing stop before reaching tp2 (repurposed from the old partial-take label —
        // rename later if you want a dedicated "trail exit" label), "be" = flat,
        // "sl_hit"/"loss" = stopped out for a loss.
        let closedStatus: string;
        if (tp2R != null && rMultiple >= tp2R * 0.999) closedStatus = "tp2";
        else if (rMultiple > 0.05) closedStatus = "tp1_partial";
        else if (rMultiple > -0.05) closedStatus = "be";
        else closedStatus = "sl_hit";

        const statusMap: Record<string, string> = {
          tp2: "tp2",
          tp1_partial: "tp1",
          be: "be",
          sl_hit: "loss",
        };

        await supabase.from("signals").update({
          metaapi_execution_status: "closed",
          metaapi_pnl: totalPnl,
          status: statusMap[closedStatus] ?? "closed",
          outcome_r: Number.isFinite(rMultiple) ? Number(rMultiple.toFixed(2)) : null,
          closed_at: lastTime ?? new Date().toISOString(),
          notes: `MetaApi auto-close ${closedStatus} pnl=${totalPnl.toFixed(2)} R=${rMultiple.toFixed(2)}`,
        }).eq("id", s.id);
        closes++;
        updated++;
      } catch (e) {
        console.error("reconcile failed for", s.id, e);
      }
    }

    // Pass 3: paper-tracking for non-executed signals (last 24h).
    // NOTE: this still simulates the OLD two-stage TP1→TP2 paper model. It's display/
    // analytics-only and doesn't touch real trades, but paper stats will now diverge
    // slightly from how live trades actually exit (continuous trail vs staged TP).
    // Left unchanged for this pass — flag if you want it updated to match too.
    let paperUpdated = 0;
    let paperExpired = 0;
    try {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const suffix = effectiveSuffix;

      // Expire stale watching/triggered signals (>24h old).
      const { data: stale } = await supabase
        .from("signals")
        .select("id")
        .in("paper_status", ["watching", "triggered"])
        .lt("created_at", since)
        .or("metaapi_execution_status.is.null,metaapi_execution_status.eq.none,metaapi_execution_status.eq.failed,metaapi_execution_status.eq.skipped,metaapi_execution_status.eq.canceled");
      if (stale && stale.length > 0) {
        await supabase.from("signals")
          .update({ paper_status: "expired", status: "expired" })
          .in("id", stale.map((r: any) => r.id));
        paperExpired = stale.length;
      }

      const { data: tracked } = await supabase
        .from("signals")
        .select("id, pair, direction, order_type, entry, stop_loss, tp1, tp2, paper_status, metaapi_execution_status")
        .in("paper_status", ["watching", "triggered", "tp1_hit"])
        .gte("created_at", since)
        .or("metaapi_execution_status.is.null,metaapi_execution_status.eq.none,metaapi_execution_status.eq.failed,metaapi_execution_status.eq.skipped,metaapi_execution_status.eq.canceled");

      for (const s of (tracked ?? []) as any[]) {
        try {
          const symbol = pairToSymbol(String(s.pair), suffix);
          const pr = await getSymbolPrice({ region, accountId, token, symbol });
          if (!pr.ok) continue;
          const bid = Number(pr.bid ?? 0);
          const ask = Number(pr.ask ?? 0);
          const ot = String(s.order_type ?? "").toLowerCase();
          const dir = String(s.direction ?? "").toLowerCase();
          const isLong = dir === "long" || dir === "buy" || ot.includes("buy");
          const entry = Number(s.entry);
          const tp1 = Number(s.tp1);
          const tp2 = Number(s.tp2);
          const sl = Number(s.stop_loss);
          const status = String(s.paper_status);

          let next: { paper_status: string; paper_hit?: string } | null = null;

          if (status === "watching") {
            // Stage 1: entry detection by order_type
            let triggered = false;
            if (ot.includes("buy stop")) triggered = ask >= entry;
            else if (ot.includes("sell stop")) triggered = bid <= entry;
            else if (ot.includes("buy")) triggered = ask <= entry; // buy limit/market
            else if (ot.includes("sell")) triggered = bid >= entry; // sell limit/market
            else triggered = isLong ? ask <= entry : bid >= entry;
            if (triggered) next = { paper_status: "triggered" };
          } else if (status === "triggered") {
            // Stage 2: TP1 / SL
            if (isLong) {
              if (bid >= tp1) next = { paper_status: "tp1_hit", paper_hit: new Date().toISOString() };
              else if (bid <= sl) next = { paper_status: "sl_hit", paper_hit: new Date().toISOString() };
            } else {
              if (ask <= tp1) next = { paper_status: "tp1_hit", paper_hit: new Date().toISOString() };
              else if (ask >= sl) next = { paper_status: "sl_hit", paper_hit: new Date().toISOString() };
            }
          } else if (status === "tp1_hit") {
            // Stage 3: TP2 or BE-stop
            if (isLong) {
              if (bid >= tp2) next = { paper_status: "tp2_hit", paper_hit: new Date().toISOString() };
              else if (bid <= entry) next = { paper_status: "sl_hit", paper_hit: new Date().toISOString() };
            } else {
              if (ask <= tp2) next = { paper_status: "tp2_hit", paper_hit: new Date().toISOString() };
              else if (ask >= entry) next = { paper_status: "sl_hit", paper_hit: new Date().toISOString() };
            }
          }

          if (next) {
            const statusMap: Record<string, string> = {
              triggered: "executed",
              tp1_hit: "tp1",
              tp2_hit: "tp2",
              sl_hit: "loss",
            };
            const mappedStatus = statusMap[next.paper_status];
            const payload: Record<string, unknown> = { ...next };
            if (mappedStatus) payload.status = mappedStatus;
            await supabase.from("signals").update(payload).eq("id", s.id);
            paperUpdated++;
          }
        } catch (e) {
          console.error("paper-track failed for", s.id, e);
        }
      }
    } catch (e) {
      console.error("paper-tracking pass failed", e);
    }

    // Pass 4: backfill paper_status for executed-then-closed signals older than 12h.
    let paperBackfilled = 0;
    try {
      const cutoff = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
      const { data: stuck } = await supabase
        .from("signals")
        .select("id, status")
        .eq("metaapi_execution_status", "closed")
        .in("paper_status", ["watching", "triggered", "tp1_hit"])
        .lt("created_at", cutoff);
      for (const r of (stuck ?? []) as any[]) {
        const st = String(r.status ?? "").toLowerCase();
        const next = st === "tp1" ? "tp1_hit"
          : st === "tp2" ? "tp2_hit"
          : st === "sl" ? "sl_hit"
          : "expired";
        await supabase.from("signals").update({ paper_status: next }).eq("id", r.id);
        paperBackfilled++;
      }
      console.log(`[metaapi-sync] paper_status backfill cleaned ${paperBackfilled} rows`);
    } catch (e) {
      console.error("paper-status backfill failed", e);
    }

    return new Response(JSON.stringify({
      ok: true, updated, checked: openSignals?.length ?? 0, trailed, closes, pendingPromoted,
      paperUpdated, paperExpired, paperBackfilled,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    console.error("metaapi-sync error", e);
    return safeError("internal error syncing positions", 500);
  }
});
