// Close-report endpoint — called by the ScalpEdge Bridge MT4 EA when it detects
// (via order history) that a position it opened has closed. This replaces
// metaapi-sync reconciliation for bridge-filled trades, since MetaApi may not be
// subscribed and that sync never runs for them.
//
// Auth: same shared secret as the bridge edge functions (x-fn-secret header).
// Classification reuses metaapi-sync's EXACT outcome buckets so bridge and
// MetaApi trades are scored identically.
import { createFileRoute } from "@tanstack/react-router";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-fn-secret",
    },
  });

export const Route = createFileRoute("/api/public/bridge-report-close")({
  server: {
    handlers: {
      OPTIONS: async () => json({ ok: true }),
      POST: async ({ request }) => {
        const expected = process.env["INTERNAL_FN_SECRET"] ?? "";
        if (!expected || request.headers.get("x-fn-secret") !== expected) {
          return json({ error: "Unauthorized" }, 401);
        }

        try {
          const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
          const ticket = Number(body["ticket"] ?? 0);
          const closePrice = Number(body["close_price"] ?? 0);
          const pnl = Number(body["pnl"] ?? 0);
          const closedAtEpoch = Number(body["closed_at_epoch"] ?? 0);

          if (!ticket) return json({ error: "ticket required" }, 400);

          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

          const { data: s } = await supabaseAdmin
            .from("signals")
            .select("id, direction, order_type, entry, stop_loss, tp1, tp2")
            .eq("metaapi_position_id", String(ticket))
            .maybeSingle();

          // Unknown ticket — nothing to reconcile; ack so the EA stops retrying.
          if (!s) return json({ ok: true, matched: false });

          const isLong =
            String(s.direction ?? "").toLowerCase().includes("long") ||
            String(s.order_type ?? "").toLowerCase().includes("buy");
          const risk = Math.abs(Number(s.entry) - Number(s.stop_loss));
          const rMultiple =
            risk > 0 && Number.isFinite(closePrice) && closePrice > 0
              ? isLong
                ? (closePrice - Number(s.entry)) / risk
                : (Number(s.entry) - closePrice) / risk
              : pnl >= 0
                ? 0
                : -1;
          const tp2R =
            risk > 0
              ? isLong
                ? (Number(s.tp2) - Number(s.entry)) / risk
                : (Number(s.entry) - Number(s.tp2)) / risk
              : null;

          // Same thresholds as metaapi-sync.
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
          const mapped = statusMap[closedStatus] ?? "closed";

          const closedAt =
            closedAtEpoch > 0 ? new Date(closedAtEpoch * 1000).toISOString() : new Date().toISOString();

          const { error } = await supabaseAdmin
            .from("signals")
            .update({
              metaapi_execution_status: "closed",
              metaapi_pnl: pnl,
              status: mapped,
              outcome_r: Number.isFinite(rMultiple) ? Number(rMultiple.toFixed(2)) : null,
              closed_at: closedAt,
              notes: `Bridge close ${closedStatus} pnl=${pnl.toFixed(2)} R=${rMultiple.toFixed(2)}`,
            })
            .eq("id", s.id);
          if (error) throw error;

          return json({
            ok: true,
            matched: true,
            status: mapped,
            outcome_r: Number(rMultiple.toFixed(2)),
          });
        } catch (e) {
          console.error("bridge-report-close error", e);
          return json({ error: "internal error reporting close" }, 500);
        }
      },
    },
  },
});
