ALTER TABLE public.signals
  ADD COLUMN IF NOT EXISTS order_type text,
  ADD COLUMN IF NOT EXISTS candle_time timestamptz,
  ADD COLUMN IF NOT EXISTS spread_pips numeric;