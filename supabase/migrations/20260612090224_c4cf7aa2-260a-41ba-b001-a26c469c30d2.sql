ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS metaapi_last_balance numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS metaapi_last_balance_at timestamptz;