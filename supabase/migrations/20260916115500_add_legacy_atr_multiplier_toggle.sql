ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS legacy_atr_multipliers_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.app_settings.legacy_atr_multipliers_enabled
  IS 'When true, legacy 15m EMA/BOS/SMC/CHOCH exits are expanded by legacy_sl_mult and legacy_tp_mult. When false, legacy exit distances remain unchanged.';
