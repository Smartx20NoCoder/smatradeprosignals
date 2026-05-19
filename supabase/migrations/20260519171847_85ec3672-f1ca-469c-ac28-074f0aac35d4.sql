
CREATE TABLE public.candle_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pair TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  candles JSONB NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (pair, timeframe)
);
ALTER TABLE public.candle_cache ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public read candle_cache" ON public.candle_cache FOR SELECT USING (true);
CREATE POLICY "public write candle_cache" ON public.candle_cache FOR ALL USING (true) WITH CHECK (true);

CREATE TABLE public.signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pair TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  setup TEXT NOT NULL,
  direction TEXT NOT NULL,
  entry NUMERIC NOT NULL,
  stop_loss NUMERIC NOT NULL,
  tp1 NUMERIC NOT NULL,
  tp2 NUMERIC NOT NULL,
  rr NUMERIC NOT NULL,
  session_score INTEGER NOT NULL,
  confidence INTEGER NOT NULL,
  atr NUMERIC,
  news_flag BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'pending',
  outcome_r NUMERIC,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ
);
ALTER TABLE public.signals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public read signals" ON public.signals FOR SELECT USING (true);
CREATE POLICY "public write signals" ON public.signals FOR ALL USING (true) WITH CHECK (true);
CREATE INDEX idx_signals_created ON public.signals (created_at DESC);

CREATE TABLE public.api_usage (
  day DATE PRIMARY KEY,
  calls INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.api_usage ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public read api_usage" ON public.api_usage FOR SELECT USING (true);
CREATE POLICY "public write api_usage" ON public.api_usage FOR ALL USING (true) WITH CHECK (true);
