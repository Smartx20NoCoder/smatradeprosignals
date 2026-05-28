DROP VIEW IF EXISTS public.app_settings_public;

CREATE OR REPLACE FUNCTION public.get_app_settings_public()
RETURNS TABLE (
  id text,
  paused boolean,
  trading_hours_start_utc integer,
  trading_hours_end_utc integer,
  session_config jsonb,
  active_td_key integer,
  key1_exhausted_at timestamptz,
  metaapi_auto_trade boolean,
  metaapi_min_confidence integer,
  metaapi_min_rr numeric,
  metaapi_fixed_lot numeric,
  metaapi_region text,
  metaapi_connected_at timestamptz,
  metaapi_configured boolean,
  updated_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    s.id,
    s.paused,
    s.trading_hours_start_utc,
    s.trading_hours_end_utc,
    s.session_config,
    s.active_td_key,
    s.key1_exhausted_at,
    s.metaapi_auto_trade,
    s.metaapi_min_confidence,
    s.metaapi_min_rr,
    s.metaapi_fixed_lot,
    s.metaapi_region,
    s.metaapi_connected_at,
    (s.metaapi_account_id IS NOT NULL) AS metaapi_configured,
    s.updated_at
  FROM public.app_settings s
  WHERE s.id = 'singleton';
$$;

GRANT EXECUTE ON FUNCTION public.get_app_settings_public() TO anon, authenticated;