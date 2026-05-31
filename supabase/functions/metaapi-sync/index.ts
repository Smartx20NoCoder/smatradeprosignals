// Syncs MetaApi position state back to signals. Cheap polling endpoint, safe to call frequently.
// Also performs TP1 management: closes 50% of the position and moves SL to entry
// once price reaches TP1 (fires once per position via metaapi_partial_closed /
// metaapi_breakeven_moved flags).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  checkSecret,
  closePartialPosition,
  corsHeaders,
  getHistoryDealsByPosition,
  getHistoryDealsBySymbol,
  getHistoryOrderById,
  getOpenPositions,
  modifyPosition,
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
    const lot = Number((cfg as any)?.metaapi_fixed_lot ?? 0.01);
    const token = ((cfg as any)?.metaapi_token as string | null) || Deno.env.get("METAAPI_TOKEN") || null;
    if (!token || !accountId) {
      return new Response(JSON.stringify({ ok: false, reason: "not configured" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Pass 1: promote pending LIMIT/STOP orders to "filled" once the broker fills them.
    let pendingPromoted = 0;
    const { data: pendingOrders } = await supabase
      .from("signals")
      .select("id, pair, created_at, metaapi_order_id")
      .is("metaapi_position_id", null)
      .not("metaapi_order_id", "is", null)
      .eq("metaapi_execution_status", "order_pending");

    for (const po of (pendingOrders ?? []) as any[]) {
      const startTime = new Date(new Date(po.created_at).getTime() - 60_000).toISOString();
      const ord = await getHistoryOrderById({
        region, accountId, token, orderId: String(po.metaapi_order_id), startTime,
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
          metaapi_execution_error: `order ${state.toLowerCase() || "ended"} by broker`,
        }).eq("id", po.id);
      }
    }

    const { data: openSignals } = await supabase
      .from("signals")
      .select("id, pair, direction, entry, stop_loss, tp1, tp2, created_at, metaapi_position_id, metaapi_filled_price, metaapi_execution_status, metaapi_partial_closed, metaapi_breakeven_moved, metaapi_executed_lot")
      .not("metaapi_position_id", "is", null)
      .in("metaapi_execution_status", ["filled", "pending"]);

    if (!openSignals || openSignals.length === 0) {
      return new Response(JSON.stringify({ ok: true, updated: 0, checked: 0, pendingPromoted }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const positionsRes = await getOpenPositions({ region, accountId, token });
    if (!positionsRes.ok) {
      return new Response(JSON.stringify({ ok: false, reason: positionsRes.error }), {
        status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const openMap = new Map<string, any>();
    for (const p of positionsRes.data) openMap.set(String(p.id), p);

    const earliest = openSignals.reduce((min, s: any) => {
      const t = new Date(s.created_at).getTime();
      return Math.min(min, t);
    }, Date.now());
    const startTime = new Date(earliest - 60_000).toISOString();
    const historyRes = await getHistoryDealsBySymbol({ region, accountId, token, startTime });
    const dealsByPos = new Map<string, any[]>();
    if (historyRes.ok) {
      for (const d of historyRes.data) {
        const pid = String(d.positionId ?? "");
        if (!pid) continue;
        if (!dealsByPos.has(pid)) dealsByPos.set(pid, []);
        dealsByPos.get(pid)!.push(d);
      }
    }

    let updated = 0;
    let partials = 0;
    let breakevens = 0;

    for (const s of openSignals as any[]) {
      const pid = String(s.metaapi_position_id);
      const live = openMap.get(pid);
      if (live) {
        // Still open — refresh PnL and run TP1 management.
        const long = s.direction === "Long";
        const tp1 = Number(s.tp1);
        const entry = Number(s.entry);
        const currentPrice = Number(live.currentPrice ?? 0)
          || (long ? Number(live.currentBid ?? 0) : Number(live.currentAsk ?? 0));
        const tp1Hit = currentPrice > 0 && (long ? currentPrice >= tp1 : currentPrice <= tp1);

        // TP1 reached and not yet processed → close 0.01 lot, then move SL to BE.
        if (tp1Hit && !s.metaapi_partial_closed) {
          try {
            const pc = await closePartialPosition({
              region, accountId, token, positionId: pid, volume: 0.01,
            });
            if (pc.ok) {
              partials++;
              let beOk = false;
              try {
                const mod = await modifyPosition({
                  region, accountId, token, positionId: pid,
                  stopLoss: entry,
                  takeProfit: Number(s.tp2),
                });
                if (mod.ok) {
                  beOk = true;
                  breakevens++;
                } else {
                  console.error("breakeven move failed for", pid, mod.error);
                }
              } catch (e) {
                console.error("breakeven move exception", pid, e);
              }
              await supabase.from("signals").update({
                metaapi_partial_closed: true,
                metaapi_breakeven_moved: beOk,
                metaapi_execution_status: "partial",
                partial_close: true,
              }).eq("id", s.id);
            } else {
              console.error("partial close failed for", pid, pc.error);
            }
          } catch (e) {
            console.error("partial close exception", pid, e);
          }
        }

        try {
          await supabase.from("signals").update({
            metaapi_pnl: Number(live.unrealizedProfit ?? 0),
            metaapi_filled_price: s.metaapi_filled_price ?? Number(live.openPrice ?? 0),
          }).eq("id", s.id);
        } catch (e) {
          console.error("pnl refresh failed", pid, e);
        }
        updated++;
        continue;
      }

      // Position closed — reconcile from history
      try {
        const deals = (dealsByPos.get(pid) ?? []).sort((a, b) =>
          new Date(a.time).getTime() - new Date(b.time).getTime());
        const closingDeal = deals.find((d) => d.entryType === "DEAL_ENTRY_OUT") ?? deals[deals.length - 1];
        if (!closingDeal) continue;

        // Per-spec: final PnL = sum of profit fields from per-position history.
        let pnl = Number(closingDeal.profit ?? 0);
        try {
          const ph = await getHistoryDealsByPosition({ region, accountId, token, positionId: pid });
          if (ph.ok && ph.data && ph.data.length > 0) {
            pnl = ph.data.reduce((sum, d: any) => sum + Number(d.profit ?? 0) + Number(d.swap ?? 0) + Number(d.commission ?? 0), 0);
          }
        } catch (e) {
          console.error("history-deals/position lookup failed for", pid, e);
        }

        const closePrice = Number(closingDeal.price ?? 0);
        const reasonStr: string = String(closingDeal.reason ?? "").toUpperCase();
        const long = s.direction === "Long";
        const risk = Math.abs(Number(s.entry) - Number(s.stop_loss));
        let status: string = "manual";
        let outcomeR: number | null = null;

        const hitSL = long
          ? closePrice <= Number(s.stop_loss) * 1.0005
          : closePrice >= Number(s.stop_loss) * 0.9995;
        const hitTP2 = long
          ? closePrice >= Number(s.tp2) * 0.9995
          : closePrice <= Number(s.tp2) * 1.0005;
        const hitTP1 = long
          ? closePrice >= Number(s.tp1) * 0.9995
          : closePrice <= Number(s.tp1) * 1.0005;

        const nearEntry = Math.abs(closePrice - Number(s.entry)) <= Math.max(Number(s.entry) * 0.0002, 0.0001);
        if (s.metaapi_breakeven_moved && nearEntry) {
          status = s.metaapi_partial_closed ? "tp1" : "be";
          outcomeR = s.metaapi_partial_closed && risk > 0
            ? +((Math.abs(Number(s.tp1) - Number(s.entry)) / risk) / 2).toFixed(2)
            : 0;
        } else if (reasonStr.includes("SL") || hitSL) {
          status = "loss"; outcomeR = -1;
        } else if (reasonStr.includes("TP") || hitTP2) {
          status = "tp2"; outcomeR = risk > 0 ? Math.abs(Number(s.tp2) - Number(s.entry)) / risk : null;
        } else if (hitTP1) {
          status = "tp1"; outcomeR = risk > 0 ? Math.abs(Number(s.tp1) - Number(s.entry)) / risk : null;
        } else {
          status = pnl >= 0 ? "manual" : "loss";
          outcomeR = risk > 0 ? pnl / (risk * 10000) : null;
        }

        await supabase.from("signals").update({
          status,
          outcome_r: outcomeR,
          closed_at: new Date(closingDeal.time ?? Date.now()).toISOString(),
          metaapi_execution_status: "closed",
          metaapi_pnl: pnl,
          notes: `[MetaApi auto-close ${reasonStr || "?"} @ ${closePrice}]`,
        }).eq("id", s.id);
        updated++;
      } catch (e) {
        console.error("close reconcile failed for", pid, e);
      }
    }

    return new Response(JSON.stringify({
      ok: true, updated, checked: openSignals.length, partials, breakevens, pendingPromoted,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    console.error("metaapi-sync error", e);
    return safeError("internal error syncing positions", 500);
  }
});
