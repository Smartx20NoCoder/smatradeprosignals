
ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS metaapi_account_id text,
  ADD COLUMN IF NOT EXISTS metaapi_region text NOT NULL DEFAULT 'new-york',
  ADD COLUMN IF NOT EXISTS metaapi_auto_trade boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS metaapi_min_confidence integer NOT NULL DEFAULT 75,
  ADD COLUMN IF NOT EXISTS metaapi_min_rr numeric NOT NULL DEFAULT 2.0,
  ADD COLUMN IF NOT EXISTS metaapi_fixed_lot numeric NOT NULL DEFAULT 0.01,
  ADD COLUMN IF NOT EXISTS metaapi_connected_at timestamptz;

ALTER TABLE public.signals
  ADD COLUMN IF NOT EXISTS metaapi_position_id text,
  ADD COLUMN IF NOT EXISTS metaapi_order_id text,
  ADD COLUMN IF NOT EXISTS metaapi_execution_status text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS metaapi_execution_error text,
  ADD COLUMN IF NOT EXISTS metaapi_filled_price numeric,
  ADD COLUMN IF NOT EXISTS metaapi_pnl numeric;

-- Extend update-settings allow-list for the new fields via direct RLS already in place (public update app_settings).
