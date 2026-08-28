-- ─── 1. DATABASE SCHEMA FOOTPRINT EXTENSIONS ───
ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS setup_auto_execute jsonb NOT NULL DEFAULT '{
    "EMA Pullback": true,
    "BOS Retest": true,
    "Session Range Break": false,
    "VERITAS": true
  }'::jsonb;

-- ─── 2. UNIFIED DATABASE OVERRIDE STATEMENT ───
-- Session Break is set to false globally.
-- Global EMA Pullback remains true so Gold/BTC can still trade it.
UPDATE public.app_settings
SET setup_auto_execute = '{
  "EMA Pullback": true,
  "BOS Retest": true,
  "Session Range Break": false,
  "VERITAS": true
}'::jsonb
WHERE id = 'singleton';

-- ─── 3. PUBLIC SECURITY VIEW INTERFACE FUNCTIONS ───
DROP FUNCTION IF EXISTS public.get_app_settings_public();

CREATE OR REPLACE FUNCTION public.get_app_settings_public()
 RETURNS TABLE(id text, paused boolean, trading_hours_start_utc integer, trading_hours_end_utc integer, session_config jsonb, active_td_key integer, key1_exhausted_at timestamp with time zone, metaapi_auto_trade boolean, metaapi_min_confidence integer, metaapi_min_rr numeric, metaapi_fixed_lot numeric, metaapi_region text, metaapi_symbol_suffix text, metaapi_connected_at timestamp with time zone, metaapi_configured boolean, metaapi_token_configured boolean, metaapi_max_trades integer, metaapi_expiry_hours integer, metaapi_max_daily_loss_pct numeric, metaapi_risk_per_trade_pct numeric, metaapi_min_lot numeric, metaapi_max_lot numeric, metaapi_is_cent_account boolean, pair_auto_execute jsonb, setup_auto_execute jsonb, metaapi_active_mode text, metaapi_region_live text, metaapi_symbol_suffix_live text, metaapi_live_configured boolean, metaapi_live_token_configured boolean, metaapi_is_cent_account_live boolean, scan_interval_minutes integer, updated_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    s.id, s.paused, s.trading_hours_start_utc, s.trading_hours_end_utc,
    s.session_config, s.active_td_key, s.key1_exhausted_at,
    s.metaapi_auto_trade, s.metaapi_min_confidence, s.metaapi_min_rr,
    s.metaapi_fixed_lot, s.metaapi_region, s.metaapi_symbol_suffix,
    s.metaapi_connected_at,
    (s.metaapi_account_id IS NOT NULL) AS metaapi_configured,
    (s.metaapi_token IS NOT NULL AND length(s.metaapi_token) > 0) AS metaapi_token_configured,
    s.metaapi_max_trades, s.metaapi_expiry_hours, s.metaapi_max_daily_loss_pct,
    s.metaapi_risk_per_trade_pct, s.metaapi_min_lot, s.metaapi_max_lot,
    COALESCE(s.metaapi_is_cent_account, false) AS metaapi_is_cent_account,
    COALESCE(s.pair_auto_execute, '{}'::jsonb) AS pair_auto_execute,
       -- Perfectly cleaned fallback map with no lingering pair overrides
    COALESCE(s.setup_auto_execute, '{
      "EMA Pullback": true,
      "BOS Retest": true,
      "Session Range Break": false,
      "VERITAS": true
    }'::jsonb) AS setup_auto_execute,
    COALESCE(s.metaapi_active_mode, 'demo') AS metaapi_active_mode,
    COALESCE(s.metaapi_region_live, 'london') AS metaapi_region_live,
    COALESCE(s.metaapi_symbol_suffix_live, '') AS metaapi_symbol_suffix_live,
    (s.metaapi_account_id_live IS NOT NULL) AS metaapi_live_configured,
    (s.metaapi_token_live IS NOT NULL AND length(s.metaapi_token_live) > 0) AS metaapi_live_token_configured,
    COALESCE(s.metaapi_is_cent_account_live, false) AS metaapi_is_cent_account_live,
    COALESCE(s.scan_interval_minutes, 15) AS scan_interval_minutes,
    s.updated_at
  FROM public.app_settings s
  WHERE s.id = 'singleton';
$function$;
