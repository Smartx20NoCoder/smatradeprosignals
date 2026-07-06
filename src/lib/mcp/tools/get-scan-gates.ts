import { defineTool } from "@lovable.dev/mcp-js";

export default defineTool({
  name: "get_scan_gates",
  title: "Get scan engine gates",
  description:
    "Return the current ScalpEdge scan engine filter gates: minimum confidence, minimum R:R, minimum ADX, trail lock-in, and VERITAS thresholds. These are the live values scan-signals reads at the start of every cycle.",
  inputSchema: {},
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async () => {
    const { createClient } = await import("@supabase/supabase-js");
    const supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_PUBLISHABLE_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const { data, error } = await supabase
      .from("app_settings")
      .select(
        "metaapi_min_confidence,metaapi_min_rr,metaapi_min_adx,metaapi_trail_lock_r,metaapi_key_rotation_threshold,metaapi_risk_per_trade_pct,metaapi_max_trades,metaapi_max_daily_loss_pct,veritas_min_conf,veritas_min_rr,veritas_min_hurst,veritas_min_snr",
      )
      .eq("id", "singleton")
      .maybeSingle();
    if (error) {
      return { content: [{ type: "text", text: `Failed to load gates: ${error.message}` }], isError: true };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(data ?? {}, null, 2) }],
      structuredContent: { gates: data ?? {} },
    };
  },
});
