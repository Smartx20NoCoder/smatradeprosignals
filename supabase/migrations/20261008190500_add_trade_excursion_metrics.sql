ALTER TABLE public.signals
  ADD COLUMN IF NOT EXISTS mfe_r numeric,
  ADD COLUMN IF NOT EXISTS mae_r numeric,
  ADD COLUMN IF NOT EXISTS mfe_price numeric,
  ADD COLUMN IF NOT EXISTS mae_price numeric,
  ADD COLUMN IF NOT EXISTS mfe_money numeric,
  ADD COLUMN IF NOT EXISTS mae_money numeric,
  ADD COLUMN IF NOT EXISTS hold_seconds integer,
  ADD COLUMN IF NOT EXISTS exit_reason text,
  ADD COLUMN IF NOT EXISTS profit_capture_pct numeric,
  ADD COLUMN IF NOT EXISTS excursion_tracking_complete boolean;
