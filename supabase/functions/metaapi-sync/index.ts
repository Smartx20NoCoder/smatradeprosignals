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
      .select("id, pair, direction, order_type, entry, stop_loss, tp1, tp2, created_at, metaapi_position_id, metaapi_position_id_b, metaapi_filled_price, metaapi_execution_status, metaapi_partial_closed, metaapi_breakeven_moved, metaapi_executed_lot")
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

    for (const s of (openSignals ?? []) as any[]) {
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
            status: "tp1",
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
        let orderAClosePrice: number | null = null;
        for (const pid of [pidA, pidB]) {
          if (!pid) continue;
          try {
            const ph = await getHistoryDealsByPosition({ region, accountId, token, positionId: pid });
            if (ph.ok && ph.data) {
              let pidLastTime: string | null = null;
              let pidLastPrice: number | null = null;
              for (const d of (ph.data as any[])) {
                totalPnl += Number(d.profit ?? 0) + Number(d.swap ?? 0) + Number(d.commission ?? 0);
                const t = d.time as string | undefined;
                if (t && (!lastTime || new Date(t).getTime() > new Date(lastTime).getTime())) lastTime = t;
                // Track the last (closing) deal price for this position
                if (t && (!pidLastTime || new Date(t).getTime() >= new Date(pidLastTime).getTime())) {
                  pidLastTime = t;
                  const px = Number(d.price ?? d.closePrice ?? 0);
                  if (Number.isFinite(px) && px > 0) pidLastPrice = px;
                }
              }
              if (pid === pidA && pidLastPrice != null) orderAClosePrice = pidLastPrice;
            }
          } catch (e) {
            console.error("history-deals/position failed for", pid, e);
          }
        }

        let closedStatus = s.metaapi_partial_closed
          ? (totalPnl >= 0 ? "tp2" : "be")
          : "sl_hit";

        // Order A may have hit TP1 inside the sync window before B closed on the original SL.
        // If we never tagged the partial state but A's close price reached TP1, classify accordingly.
        const isLong = String(s.direction ?? "").toLowerCase().includes("long")
          || String(s.order_type ?? "").toLowerCase().includes("buy");
        const tp1Level = Number(s.tp1);
        const orderAHitTP1 = orderAClosePrice != null && Number.isFinite(tp1Level) && tp1Level > 0
          ? (isLong ? orderAClosePrice >= tp1Level * 0.999 : orderAClosePrice <= tp1Level * 1.001)
          : false;
        if (orderAHitTP1 && !s.metaapi_partial_closed) {
          closedStatus = totalPnl >= 0 ? "tp1_partial" : "be";
        }

        const risk = Math.abs(Number(s.entry) - Number(s.stop_loss));
        const statusMap: Record<string, string> = {
          tp2: "tp2",
          be: "be",
          sl_hit: "loss",
          tp1_partial: "tp1",
        };
        const outcomeMap: Record<string, number> = {
          tp2: risk > 0 ? Math.abs(Number(s.tp2) - Number(s.entry)) / risk : 0,
          be: 0,
          sl_hit: -1,
          tp1_partial: 0.5,
        };

        await supabase.from("signals").update({
          metaapi_execution_status: "closed",
          metaapi_pnl: totalPnl,
          status: statusMap[closedStatus] ?? "closed",
          outcome_r: outcomeMap[closedStatus] ?? null,
          closed_at: lastTime ?? new Date().toISOString(),
          notes: `MetaApi auto-close ${closedStatus} pnl=${totalPnl.toFixed(2)}`,
        }).eq("id", s.id);
        closes++;
        updated++;
      } catch (e) {
        console.error("reconcile failed for", s.id, e);
      }
    }

    // Pass 3: paper-tracking for non-executed signals (last 24h).
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
        .select("id, pair, direction, order_type, entry, stop_loss, tp1, tp2, paper_status")
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

    return new Response(JSON.stringify({
      ok: true, updated, checked: openSignals?.length ?? 0, partials, breakevens, closes, pendingPromoted,
      paperUpdated, paperExpired,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    console.error("metaapi-sync error", e);
    return safeError("internal error syncing positions", 500);
  }
});
