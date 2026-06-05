DROP FUNCTION IF EXISTS public.get_app_settings_public();

CREATE OR REPLACE FUNCTION public.get_app_settings_public()
 RETURNS TABLE(id text, paused boolean, trading_hours_start_utc integer, trading_hours_end_utc integer, session_config jsonb, active_td_key integer, key1_exhausted_at timestamp with time zone, metaapi_auto_trade boolean, metaapi_min_confidence integer, metaapi_min_rr numeric, metaapi_fixed_lot numeric, metaapi_region text, metaapi_symbol_suffix text, metaapi_connected_at timestamp with time zone, metaapi_configured boolean, metaapi_token_configured boolean, metaapi_max_trades integer, metaapi_expiry_hours integer, metaapi_max_daily_loss_pct numeric, metaapi_risk_per_trade_pct numeric, metaapi_min_lot numeric, metaapi_max_lot numeric, updated_at timestamp with time zone)
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
    s.updated_at
  FROM public.app_settings s
  WHERE s.id = 'singleton';
$function$;