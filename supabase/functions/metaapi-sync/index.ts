// Syncs MetaApi state back to signals for the two-order (A=TP1, B=TP2) model.
// - When Order A closes (TP1 hit) → mark partial, move B's SL to entry (breakeven).
// - When Order B also closes → reconcile final PnL (sum of both positions' deals).
// - If both are gone before TP1 was tagged → SL hit on both.
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
    const token = ((cfg as any)?.metaapi_token as string | null) || Deno.env.get("METAAPI_TOKEN") || null;
    if (!token || !accountId) {
      return new Response(JSON.stringify({ ok: false, reason: "not configured" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Pass 1: promote pending LIMIT/STOP A-orders to "filled" once broker fills them.
    let pendingPromoted = 0;
    const { data: pendingSignals } = await supabase
      .from("signals")
      .select("id, created_at, metaapi_order_id, metaapi_order_id_b, metaapi_position_id, metaapi_position_id_b")
      .eq("metaapi_execution_status", "order_pending");

    for (const po of (pendingSignals ?? []) as any[]) {
      const startTime = new Date(new Date(po.created_at).getTime() - 60_000).toISOString();
      const patch: Record<string, unknown> = {};
      let anyCanceled = false;
      let bothFilledOrKnown = true;

      for (const slot of [
        { idField: "metaapi_order_id", posField: "metaapi_position_id" },
        { idField: "metaapi_order_id_b", posField: "metaapi_position_id_b" },
      ]) {
        const existingPos = po[slot.posField];
        if (existingPos) continue; // already filled
        const orderId = po[slot.idField];
        if (!orderId) continue;
        const ord = await getHistoryOrderById({
          region, accountId, token, orderId: String(orderId), startTime,
        });
        if (!ord.ok || !ord.data) { bothFilledOrKnown = false; continue; }
        const positionId = ord.data.positionId ? String(ord.data.positionId) : null;
        const state = String(ord.data.state ?? "").toUpperCase();
        if (positionId && (state.includes("FILLED") || state === "ORDER_STATE_FILLED" || state === "")) {
          patch[slot.posField] = positionId;
        } else if (state.includes("CANCEL") || state.includes("EXPIRED") || state.includes("REJECT")) {
          anyCanceled = true;
        } else {
          bothFilledOrKnown = false;
        }
      }

      if (anyCanceled) {
        await supabase.from("signals").update({
          ...patch,
          metaapi_execution_status: "canceled",
          metaapi_execution_error: "order canceled/expired/rejected by broker",
        }).eq("id", po.id);
        pendingPromoted++;
      } else if (Object.keys(patch).length > 0) {
        // Did both legs end up with a position id (existing + just-resolved)?
        const aPos = po.metaapi_position_id ?? patch["metaapi_position_id"];
        const bPos = po.metaapi_position_id_b ?? patch["metaapi_position_id_b"];
        const promote = !!aPos && !!bPos && bothFilledOrKnown;
        await supabase.from("signals").update({
          ...patch,
          ...(promote
            ? { metaapi_execution_status: "filled", executed_at: new Date().toISOString(), status: "executed" }
            : {}),
        }).eq("id", po.id);
        if (promote) pendingPromoted++;
      }
    }

    // Pass 2: reconcile signals with active executions.
    const { data: openSignals } = await supabase
      .from("signals")
      .select("id, pair, direction, entry, stop_loss, tp1, tp2, created_at, metaapi_position_id, metaapi_position_id_b, metaapi_filled_price, metaapi_execution_status, metaapi_partial_closed, metaapi_breakeven_moved, metaapi_executed_lot")
      .in("metaapi_execution_status", ["filled", "partial"]);

    let updated = 0;
    let partials = 0;
    let breakevens = 0;
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

    for (const s of openSignals as any[]) {
      try {
        const pidA = s.metaapi_position_id ? String(s.metaapi_position_id) : null;
        const pidB = s.metaapi_position_id_b ? String(s.metaapi_position_id_b) : null;
        const aOpen = !!pidA && openSet.has(pidA);
        const bOpen = !!pidB && openSet.has(pidB);

        // TP1 hit branch: A closed, B still open, partial not yet tagged.
        if (!aOpen && bOpen && !s.metaapi_partial_closed) {
          let beOk = false;
          try {
            const mod = await modifyPosition({
              region, accountId, token, positionId: pidB!,
              stopLoss: Number(s.entry),
              takeProfit: Number(s.tp2),
            });
            if (mod.ok) { beOk = true; breakevens++; }
            else console.error("breakeven move failed for B", pidB, mod.error);
          } catch (e) {
            console.error("breakeven move exception", pidB, e);
          }
          await supabase.from("signals").update({
            metaapi_partial_closed: true,
            metaapi_breakeven_moved: beOk,
            metaapi_execution_status: "partial",
            partial_close: true,
          }).eq("id", s.id);
          partials++;
          updated++;

          // Refresh runner PnL too
          const livePos = openMap.get(pidB!);
          if (livePos) {
            await supabase.from("signals").update({
              metaapi_pnl: Number(livePos.unrealizedProfit ?? 0),
            }).eq("id", s.id);
          }
          continue;
        }

        // Both still open → just refresh aggregated PnL.
        if (aOpen || bOpen) {
          let pnl = 0;
          if (aOpen) pnl += Number(openMap.get(pidA!)?.unrealizedProfit ?? 0);
          if (bOpen) pnl += Number(openMap.get(pidB!)?.unrealizedProfit ?? 0);
          await supabase.from("signals").update({
            metaapi_pnl: pnl,
            metaapi_filled_price: s.metaapi_filled_price
              ?? Number(openMap.get(pidA!)?.openPrice ?? openMap.get(pidB!)?.openPrice ?? 0),
          }).eq("id", s.id);
          updated++;
          continue;
        }

        // Both closed → reconcile.
        let totalPnl = 0;
        let lastTime: string | null = null;
        for (const pid of [pidA, pidB]) {
          if (!pid) continue;
          try {
            const ph = await getHistoryDealsByPosition({ region, accountId, token, positionId: pid });
            if (ph.ok && ph.data) {
              for (const d of ph.data as any[]) {
                totalPnl += Number(d.profit ?? 0) + Number(d.swap ?? 0) + Number(d.commission ?? 0);
                const t = d.time as string | undefined;
                if (t && (!lastTime || new Date(t).getTime() > new Date(lastTime).getTime())) lastTime = t;
              }
            }
          } catch (e) {
            console.error("history-deals/position failed for", pid, e);
          }
        }

        const closedStatus = s.metaapi_partial_closed
          ? (totalPnl >= 0 ? "tp2" : "be")
          : "sl_hit";

        await supabase.from("signals").update({
          metaapi_execution_status: "closed",
          metaapi_pnl: totalPnl,
          status: "closed",
          closed_at: lastTime ?? new Date().toISOString(),
          notes: `[MetaApi auto-close ${closedStatus} pnl=${totalPnl.toFixed(2)}]`,
        }).eq("id", s.id);
        closes++;
        updated++;
      } catch (e) {
        console.error("reconcile failed for", s.id, e);
      }
    }

    // Pass 3: paper-tracking for non-executed signals (last 24h, watching).
    let paperUpdated = 0;
    let paperExpired = 0;
    try {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const suffix = ((cfg as any)?.metaapi_symbol_suffix as string | null) ?? "";

      // Expire stale watching signals (>24h old).
      const { data: stale } = await supabase
        .from("signals")
        .select("id")
        .eq("paper_status", "watching")
        .lt("created_at", since)
        .or("metaapi_execution_status.is.null,metaapi_execution_status.eq.none");
      if (stale && stale.length > 0) {
        await supabase.from("signals")
          .update({ paper_status: "expired" })
          .in("id", stale.map((r: any) => r.id));
        paperExpired = stale.length;
      }

      const { data: watching } = await supabase
        .from("signals")
        .select("id, pair, direction, entry, stop_loss, tp1, tp2, paper_status")
        .eq("paper_status", "watching")
        .gte("created_at", since)
        .or("metaapi_execution_status.is.null,metaapi_execution_status.eq.none");

      for (const s of (watching ?? []) as any[]) {
        try {
          const symbol = pairToSymbol(String(s.pair), suffix);
          const pr = await getSymbolPrice({ region, accountId, token, symbol });
          if (!pr.ok) continue;
          const bid = Number(pr.bid ?? 0);
          const ask = Number(pr.ask ?? 0);
          const dir = String(s.direction ?? "").toLowerCase();
          const isLong = dir === "long" || dir === "buy";
          let hit: "tp2_hit" | "tp1_hit" | "sl_hit" | null = null;
          if (isLong) {
            if (bid >= Number(s.tp2)) hit = "tp2_hit";
            else if (bid >= Number(s.tp1)) hit = "tp1_hit";
            else if (bid <= Number(s.stop_loss)) hit = "sl_hit";
          } else {
            if (ask <= Number(s.tp2)) hit = "tp2_hit";
            else if (ask <= Number(s.tp1)) hit = "tp1_hit";
            else if (ask >= Number(s.stop_loss)) hit = "sl_hit";
          }
          if (hit) {
            await supabase.from("signals").update({
              paper_status: hit,
              paper_hit: new Date().toISOString(),
            }).eq("id", s.id);
            paperUpdated++;
          }
        } catch (e) {
          console.error("paper-track failed for", s.id, e);
        }
      }
    } catch (e) {
      console.error("paper-tracking pass failed", e);
    }

    return new Response(JSON.stringify({
      ok: true, updated, checked: openSignals.length, partials, breakevens, closes, pendingPromoted,
      paperUpdated, paperExpired,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    console.error("metaapi-sync error", e);
    return safeError("internal error syncing positions", 500);
  }
});
