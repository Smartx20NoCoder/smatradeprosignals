ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS metaapi_trail_lock_r     numeric  DEFAULT 0.5,
  ADD COLUMN IF NOT EXISTS metaapi_min_adx          numeric  DEFAULT 20,
  ADD COLUMN IF NOT EXISTS twelvedata_key_threshold integer  DEFAULT 750,
  ADD COLUMN IF NOT EXISTS twelvedata_key_1_used    integer  DEFAULT 0,
  ADD COLUMN IF NOT EXISTS twelvedata_key_2_used    integer  DEFAULT 0,
  ADD COLUMN IF NOT EXISTS twelvedata_key_3_used    integer  DEFAULT 0,
  ADD COLUMN IF NOT EXISTS twelvedata_key_reset_date text    DEFAULT '';