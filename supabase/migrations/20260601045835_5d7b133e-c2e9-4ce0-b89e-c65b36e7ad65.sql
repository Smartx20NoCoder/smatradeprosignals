ALTER TABLE signals
  ADD COLUMN IF NOT EXISTS metaapi_order_id_b text,
  ADD COLUMN IF NOT EXISTS metaapi_position_id_b text;

ALTER TABLE app_settings
  ADD COLUMN IF NOT EXISTS metaapi_max_trades integer DEFAULT 3,
  ADD COLUMN IF NOT EXISTS metaapi_expiry_hours integer DEFAULT 24,
  ADD COLUMN IF NOT EXISTS metaapi_max_daily_loss_pct numeric DEFAULT 5;