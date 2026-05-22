ALTER TABLE public.signals
  ADD COLUMN IF NOT EXISTS executed_at timestamptz,
  ADD COLUMN IF NOT EXISTS partial_close boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS htf_bias text,
  ADD COLUMN IF NOT EXISTS mfi_score numeric,
  ADD COLUMN IF NOT EXISTS mfi_divergence boolean NOT NULL DEFAULT false;