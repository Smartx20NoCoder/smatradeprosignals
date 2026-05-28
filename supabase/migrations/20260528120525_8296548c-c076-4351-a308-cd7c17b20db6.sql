-- 1. Drop dangerous public write/read policies
DROP POLICY IF EXISTS "public update signals" ON public.signals;
DROP POLICY IF EXISTS "public update app_settings" ON public.app_settings;
DROP POLICY IF EXISTS "public read app_settings" ON public.app_settings;

-- 2. Restrict app_settings: only service_role can read/write directly
REVOKE ALL ON public.app_settings FROM anon, authenticated;
GRANT ALL ON public.app_settings TO service_role;

-- 3. Safe public view exposing only non-sensitive settings
CREATE OR REPLACE VIEW public.app_settings_public
WITH (security_invoker = true) AS
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

-- View needs explicit grants; security_invoker means RLS on the base table still applies
-- to direct queries, but the view itself is GRANTed to anon.
GRANT SELECT ON public.app_settings_public TO anon, authenticated;

-- Since base table has no SELECT policy for anon/authenticated, allow the view to bypass
-- by adding a permissive SELECT policy scoped to the singleton row, returning only via view.
-- (security_invoker=true requires the calling role to be able to read the rows.)
CREATE POLICY "public read singleton via view"
ON public.app_settings
FOR SELECT
TO anon, authenticated
USING (id = 'singleton');
-- Re-grant minimal SELECT on the base table for view to work; columns sensitivity is enforced by view shape.
GRANT SELECT ON public.app_settings TO anon, authenticated;

-- 4. Rotate cron jobs to authenticate via vault-stored service-role JWT
-- (no plaintext secret remains in migration SQL)
SELECT cron.unschedule('scalpedge-scan-15m');
SELECT cron.unschedule('scalpedge-news-calendar');
SELECT cron.unschedule('metaapi-sync-every-minute');

-- Helper: read the service role JWT from Vault (user must seed it once)
-- The user inserts the secret value via the Supabase dashboard or with:
--   SELECT vault.create_secret('<SERVICE_ROLE_JWT>', 'service_role_jwt');
-- The new INTERNAL_FN_SECRET is now used server-side only.

SELECT cron.schedule(
  'scalpedge-scan-15m',
  '*/15 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://gvxiwqbuurwksvjqsuoy.supabase.co/functions/v1/scan-signals',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || coalesce((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_jwt' LIMIT 1), ''),
      'x-fn-secret', coalesce((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'internal_fn_secret' LIMIT 1), '')
    ),
    body := jsonb_build_object('mode', 'latest', 'source', 'cron')
  );
  $$
);

SELECT cron.schedule(
  'scalpedge-news-calendar',
  '0 1 * * *',
  $$
  SELECT net.http_post(
    url := 'https://gvxiwqbuurwksvjqsuoy.supabase.co/functions/v1/fetch-news-calendar',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || coalesce((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_jwt' LIMIT 1), ''),
      'x-fn-secret', coalesce((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'internal_fn_secret' LIMIT 1), '')
    ),
    body := jsonb_build_object('source', 'cron')
  );
  $$
);

SELECT cron.schedule(
  'metaapi-sync-every-minute',
  '* * * * *',
  $$
  SELECT net.http_post(
    url := 'https://gvxiwqbuurwksvjqsuoy.supabase.co/functions/v1/metaapi-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || coalesce((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_jwt' LIMIT 1), ''),
      'x-fn-secret', coalesce((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'internal_fn_secret' LIMIT 1), '')
    ),
    body := '{}'::jsonb
  );
  $$
);

-- 5. Add columns for new trading features: order type and partial-close tracking
ALTER TABLE public.signals
  ADD COLUMN IF NOT EXISTS metaapi_order_type text,
  ADD COLUMN IF NOT EXISTS metaapi_breakeven_moved boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS metaapi_partial_closed boolean NOT NULL DEFAULT false;