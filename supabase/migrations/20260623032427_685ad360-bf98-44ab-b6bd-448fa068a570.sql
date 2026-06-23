ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS veritas_sl_mult    numeric NOT NULL DEFAULT 1.5,
  ADD COLUMN IF NOT EXISTS veritas_tp_mult    numeric NOT NULL DEFAULT 2.5,
  ADD COLUMN IF NOT EXISTS veritas_min_hurst  numeric NOT NULL DEFAULT 0.55,
  ADD COLUMN IF NOT EXISTS veritas_min_snr    numeric NOT NULL DEFAULT 40,
  ADD COLUMN IF NOT EXISTS veritas_min_conf   numeric NOT NULL DEFAULT 72,
  ADD COLUMN IF NOT EXISTS veritas_min_rr     numeric NOT NULL DEFAULT 1.60;