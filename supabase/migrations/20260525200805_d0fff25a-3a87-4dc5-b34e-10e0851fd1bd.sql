
-- App-wide settings (singleton)
CREATE TABLE IF NOT EXISTS public.app_settings (
  id text PRIMARY KEY DEFAULT 'singleton',
  paused boolean NOT NULL DEFAULT false,
  trading_hours_start_utc integer NOT NULL DEFAULT 1,
  trading_hours_end_utc integer NOT NULL DEFAULT 20,
  active_td_key integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.app_settings (id) VALUES ('singleton')
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "public read app_settings" ON public.app_settings FOR SELECT USING (true);
CREATE POLICY "public update app_settings" ON public.app_settings FOR UPDATE USING (true) WITH CHECK (true);
CREATE POLICY "public insert app_settings" ON public.app_settings FOR INSERT WITH CHECK (true);

-- High-impact economic events cache
CREATE TABLE IF NOT EXISTS public.economic_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_time timestamptz NOT NULL,
  currency text NOT NULL,
  title text NOT NULL,
  impact text NOT NULL,
  source text,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_time, currency, title)
);

CREATE INDEX IF NOT EXISTS idx_econ_event_time ON public.economic_events(event_time);
CREATE INDEX IF NOT EXISTS idx_econ_currency ON public.economic_events(currency);

ALTER TABLE public.economic_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "public read economic_events" ON public.economic_events FOR SELECT USING (true);

-- Schedule daily news fetch at 01:00 UTC
SELECT cron.schedule(
  'scalpedge-news-calendar',
  '0 1 * * *',
  $$
  SELECT net.http_post(
    url := 'https://gvxiwqbuurwksvjqsuoy.supabase.co/functions/v1/fetch-news-calendar',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd2eGl3cWJ1dXJ3a3N2anFzdW95Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkyMDMyNDIsImV4cCI6MjA5NDc3OTI0Mn0.XazR4Te9STYeIYe-9sHbSWnn6jZX229QbIEvm1-9UU4"}'::jsonb,
    body := '{"source":"cron"}'::jsonb
  ) AS request_id;
  $$
);
