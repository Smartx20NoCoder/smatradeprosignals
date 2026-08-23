
ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS bridge_last_seen timestamptz,
  ADD COLUMN IF NOT EXISTS bridge_pairs jsonb NOT NULL DEFAULT '["GBP/USD","XAU/USD","BTC/USD"]'::jsonb,
  ADD COLUMN IF NOT EXISTS bridge_claim_expiry_min integer NOT NULL DEFAULT 20,
  ADD COLUMN IF NOT EXISTS bridge_claim_grace_sec integer NOT NULL DEFAULT 120;

ALTER TABLE public.signals
  ADD COLUMN IF NOT EXISTS metaapi_execution_channel text,
  ADD COLUMN IF NOT EXISTS bridge_claimed_at timestamptz;

CREATE TABLE IF NOT EXISTS public.bridge_poll_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  polled_at timestamptz NOT NULL DEFAULT now(),
  endpoint text NOT NULL,
  http_status integer NOT NULL,
  signals_returned integer NOT NULL DEFAULT 0,
  note text
);
CREATE INDEX IF NOT EXISTS bridge_poll_log_polled_at_idx ON public.bridge_poll_log (polled_at DESC);

GRANT SELECT ON public.bridge_poll_log TO anon;
GRANT SELECT ON public.bridge_poll_log TO authenticated;
GRANT ALL ON public.bridge_poll_log TO service_role;
ALTER TABLE public.bridge_poll_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public read bridge_poll_log" ON public.bridge_poll_log FOR SELECT USING (true);
