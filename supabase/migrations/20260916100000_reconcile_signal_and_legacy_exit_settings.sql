-- Keep the personal Supabase schema reproducible with the scanner's signal payload.
-- These signal fields already exist in production; IF NOT EXISTS makes this safe
-- for a database that has been manually repaired.
ALTER TABLE public.signals
  ADD COLUMN IF NOT EXISTS candle_time timestamptz,
  ADD COLUMN IF NOT EXISTS order_type text,
  ADD COLUMN IF NOT EXISTS spread_pips numeric;

-- Legacy 15m strategies (EMA Pullback / BOS Retest / SMC / CHOCH)
-- use these settings for optional post-calculation exit-distance scaling.
-- Defaults remain neutral so deployment does not change strategy behavior until
-- the scanner code explicitly consumes them.
ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS legacy_sl_mult numeric NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS legacy_tp_mult numeric NOT NULL DEFAULT 1;

COMMENT ON COLUMN public.app_settings.legacy_sl_mult IS
  'Legacy 15m exit-distance multiplier for SL; neutral default 1.0 until scanner wiring is enabled.';
COMMENT ON COLUMN public.app_settings.legacy_tp_mult IS
  'Legacy 15m exit-distance multiplier for TP1/TP2; neutral default 1.0 until scanner wiring is enabled.';

CREATE INDEX IF NOT EXISTS idx_signals_candle_fingerprint
  ON public.signals (pair, direction, candle_time);
