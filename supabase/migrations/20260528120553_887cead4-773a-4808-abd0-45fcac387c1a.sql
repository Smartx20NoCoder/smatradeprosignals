-- Lock down direct table reads; only the view should be public
DROP POLICY IF EXISTS "public read singleton via view" ON public.app_settings;
REVOKE SELECT ON public.app_settings FROM anon, authenticated;

-- Switch the view to SECURITY DEFINER so it can read past RLS for anon callers,
-- but only exposes the safe columns we listed.
DROP VIEW IF EXISTS public.app_settings_public;
CREATE VIEW public.app_settings_public
WITH (security_invoker = false) AS
SELECT
  id,
  paused,
  trading_hours_start_utc,
  trading_hours_end_utc,
  session_config,
  active_td_key,
  key1_exhausted_at,
  metaapi_auto_trade,
  metaapi_min_confidence,
  metaapi_min_rr,
  metaapi_fixed_lot,
  metaapi_region,
  metaapi_connected_at,
  CASE WHEN metaapi_account_id IS NOT NULL THEN true ELSE false END AS metaapi_configured,
  updated_at
FROM public.app_settings;

GRANT SELECT ON public.app_settings_public TO anon, authenticated;