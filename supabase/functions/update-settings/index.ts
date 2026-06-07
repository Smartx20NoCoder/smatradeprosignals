// Privileged updater for app_settings (singleton row).
// Required because the table's public INSERT/UPDATE policies were removed
// for security. Browser callers must send x-fn-secret.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-fn-secret",
};

const ALLOWED_KEYS = new Set([
  "paused", "trading_hours_start_utc", "trading_hours_end_utc",
  "active_td_key", "session_config",
  "metaapi_account_id", "metaapi_region", "metaapi_auto_trade",
  "metaapi_min_confidence", "metaapi_min_rr", "metaapi_fixed_lot",
  "metaapi_symbol_suffix", "metaapi_token",
  "metaapi_max_trades", "metaapi_expiry_hours", "metaapi_max_daily_loss_pct",
  "metaapi_risk_per_trade_pct", "metaapi_min_lot", "metaapi_max_lot",
  "metaapi_is_cent_account",
  "pair_auto_execute",
  "metaapi_active_mode",
  "metaapi_account_id_live", "metaapi_token_live",
  "metaapi_region_live", "metaapi_symbol_suffix_live",
]);

function sanitize(patch: Record<string, unknown>): Record<string, unknown> {
  // Coerce string numbers to actual numbers for numeric fields
  const numericFields = ["metaapi_max_trades","metaapi_expiry_hours","metaapi_max_daily_loss_pct","metaapi_min_confidence","metaapi_min_rr","metaapi_fixed_lot","metaapi_risk_per_trade_pct","metaapi_min_lot","metaapi_max_lot","trading_hours_start_utc","trading_hours_end_utc","active_td_key"];
  for (const f of numericFields) {
    if (f in patch && typeof patch[f] === "string" && patch[f] !== "") {
      const n = Number(patch[f]);
      if (!isNaN(n)) patch[f] = n;
    }
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (!ALLOWED_KEYS.has(k)) continue;
    if (k === "paused" && typeof v !== "boolean") continue;
    if ((k === "trading_hours_start_utc" || k === "trading_hours_end_utc") &&
        (typeof v !== "number" || v < 0 || v > 23 || !Number.isInteger(v))) continue;
    if (k === "active_td_key" && (typeof v !== "number" || ![1, 2].includes(v))) continue;
    if (k === "session_config" && (typeof v !== "object" || v === null)) continue;
    if (k === "metaapi_account_id" && v !== null && (typeof v !== "string" || v.length > 200)) continue;
    if (k === "metaapi_region" && (typeof v !== "string" || !["new-york", "london", "singapore"].includes(v))) continue;
    if (k === "metaapi_auto_trade" && typeof v !== "boolean") continue;
    if (k === "metaapi_min_confidence" && (typeof v !== "number" || v < 50 || v > 99)) continue;
    if (k === "metaapi_min_rr" && (typeof v !== "number" || v < 1 || v > 10)) continue;
    if (k === "metaapi_fixed_lot" && (typeof v !== "number" || v < 0.01 || v > 100)) continue;
    if (k === "metaapi_symbol_suffix" && (typeof v !== "string" || v.length > 16 || !/^[A-Za-z0-9._-]*$/.test(v))) continue;
    if (k === "metaapi_token") {
      if (v === null) { out[k] = null; continue; }
      if (typeof v !== "string" || v.length < 20 || v.length > 4096) continue;
    }
    if (k === "metaapi_max_trades" && (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 50)) continue;
    if (k === "metaapi_expiry_hours" && (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 720)) continue;
    if (k === "metaapi_max_daily_loss_pct" && (typeof v !== "number" || v < 0 || v > 100)) continue;
    if (k === "metaapi_risk_per_trade_pct" && (typeof v !== "number" || v < 0.1 || v > 10)) continue;
    if (k === "metaapi_min_lot" && (typeof v !== "number" || v < 0.01 || v > 1)) continue;
    if (k === "metaapi_max_lot" && (typeof v !== "number" || v < 0.01 || v > 10)) continue;
    if (k === "metaapi_is_cent_account" && typeof v !== "boolean") continue;
    if (k === "pair_auto_execute") {
      if (typeof v !== "object" || v === null || Array.isArray(v)) continue;
      const clean: Record<string, boolean> = {};
      let bad = false;
      for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) {
        if (typeof pk !== "string" || pk.length > 16 || !/^[A-Z]{3}\/[A-Z]{3}$/.test(pk)) { bad = true; break; }
        if (typeof pv !== "boolean") { bad = true; break; }
        clean[pk] = pv;
      }
      if (bad) continue;
      out[k] = clean;
      continue;
    }
    if (k === "metaapi_active_mode" && (typeof v !== "string" || !["demo", "live"].includes(v))) continue;
    if (k === "metaapi_account_id_live" && v !== null && (typeof v !== "string" || v.length > 200)) continue;
    if (k === "metaapi_token_live") {
      if (v === null) { out[k] = null; continue; }
      if (typeof v !== "string" || v.length < 20 || v.length > 4096) continue;
    }
    if (k === "metaapi_region_live" && (typeof v !== "string" || !["new-york", "london", "singapore"].includes(v))) continue;
    if (k === "metaapi_symbol_suffix_live" && (typeof v !== "string" || v.length > 16 || !/^[A-Za-z0-9._-]*$/.test(v))) continue;
    out[k] = v;
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const expected = Deno.env.get("INTERNAL_FN_SECRET");
  if (!expected || req.headers.get("x-fn-secret") !== expected) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  try {
    const raw = await req.json().catch(() => ({}));
    const patch = sanitize(raw ?? {});
    if (Object.keys(patch).length === 0) {
      return new Response(JSON.stringify({ error: "No valid fields" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { error } = await supabase
      .from("app_settings")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", "singleton");
    if (error) throw error;
    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("update-settings error", e);
    return new Response(JSON.stringify({ error: "Failed to update settings" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
