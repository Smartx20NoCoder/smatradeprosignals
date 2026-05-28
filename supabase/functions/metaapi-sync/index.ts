// Syncs MetaApi position state back to signals. Cheap polling endpoint, safe to call frequently.
// Also performs TP1 management: closes 50% of the position and moves SL to entry
// once price reaches TP1 (fires once per position via metaapi_partial_closed /
// metaapi_breakeven_moved flags).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  checkSecret,
  closePartialPosition,
  corsHeaders,
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
    const token = Deno.env.get("METAAPI_TOKEN");
    if (!token || !accountId) {
      return new Response(JSON.stringify({ ok: false, reason: "not configured" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: openSignals } = await supabase
      .from("signals")
      .select("id, pair, direction, entry, stop_loss, tp1, tp2, created_at, metaapi_position_id, metaapi_filled_price, metaapi_execution_status, metaapi_partial_closed, metaapi_breakeven_moved")
      .not("metaapi_position_id", "is", null)
      .in("metaapi_execution_status", ["filled", "pending"]);

    if (!openSignals || openSignals.length === 0) {
      return new Response(JSON.stringify({ ok: true, updated: 0, checked: 0 }), {
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
        // Still open — refresh PnL
        const currentPrice = Number(live.currentPrice ?? live.currentTickValue ?? 0)
          || (s.direction === "Long" ? Number(live.currentBid ?? 0) : Number(live.currentAsk ?? 0));
        const tp1 = Number(s.tp1);
        const entry = Number(s.entry);
        const long = s.direction === "Long";

        // TP1 reached? Use live.currentPrice if present, otherwise infer from profit sign + bid/ask
        const refPrice = currentPrice
          || (long ? Number(live.currentBid ?? 0) : Number(live.currentAsk ?? 0));
        const tp1Hit = refPrice > 0 && (long ? refPrice >= tp1 : refPrice <= tp1);

        // Fire-once partial close at TP1 (50%)
        if (tp1Hit && !s.metaapi_partial_closed) {
          const halfVol = Math.max(0.01, +(lot / 2).toFixed(2));
          const pc = await closePartialPosition({ region, accountId, token, positionId: pid, volume: halfVol });
          if (pc.ok) {
            partials++;
            await supabase.from("signals").update({
              metaapi_partial_closed: true,
              partial_close: true,
            }).eq("id", s.id);
          } else {
            console.error("partial close failed for", pid, pc.error);
          }
        }

        // Fire-once SL → breakeven (entry) at TP1
        if (tp1Hit && !s.metaapi_breakeven_moved) {
          const mod = await modifyPosition({
            region, accountId, token, positionId: pid,
            stopLoss: entry,
            takeProfit: Number(s.tp2),
          });
          if (mod.ok) {
            breakevens++;
            await supabase.from("signals").update({
              metaapi_breakeven_moved: true,
            }).eq("id", s.id);
          } else {
            console.error("breakeven move failed for", pid, mod.error);
          }
        }

        await supabase.from("signals").update({
          metaapi_pnl: Number(live.unrealizedProfit ?? 0),
          metaapi_filled_price: s.metaapi_filled_price ?? Number(live.openPrice ?? 0),
        }).eq("id", s.id);
        updated++;
        continue;
      }

      // Position closed — reconcile from history
      const deals = (dealsByPos.get(pid) ?? []).sort((a, b) =>
        new Date(a.time).getTime() - new Date(b.time).getTime());
      const closingDeal = deals.find((d) => d.entryType === "DEAL_ENTRY_OUT") ?? deals[deals.length - 1];
      if (!closingDeal) continue;

      const pnl = Number(closingDeal.profit ?? 0);
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

      // If SL was moved to entry and price came back, treat as breakeven
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
    }

    return new Response(JSON.stringify({
      ok: true, updated, checked: openSignals.length, partials, breakevens,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    console.error("metaapi-sync error", e);
    return safeError("internal error syncing positions", 500);
  }
});
