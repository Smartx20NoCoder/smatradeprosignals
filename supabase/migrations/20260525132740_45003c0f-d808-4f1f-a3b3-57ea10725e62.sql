
CREATE TABLE IF NOT EXISTS public.scan_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  mode text NOT NULL DEFAULT 'latest',
  source text NOT NULL DEFAULT 'cron',
  new_signals integer NOT NULL DEFAULT 0,
  api_calls_used integer NOT NULL DEFAULT 0,
  api_calls_today integer NOT NULL DEFAULT 0,
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  ok boolean NOT NULL DEFAULT true
);

CREATE INDEX IF NOT EXISTS idx_scan_runs_started_at ON public.scan_runs (started_at DESC);

ALTER TABLE public.scan_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "public read scan_runs"
ON public.scan_runs FOR SELECT
USING (true);
