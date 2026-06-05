ALTER TABLE app_settings
  ADD COLUMN IF NOT EXISTS metaapi_risk_per_trade_pct numeric DEFAULT 2,
  ADD COLUMN IF NOT EXISTS metaapi_min_lot numeric DEFAULT 0.01,
  ADD COLUMN IF NOT EXISTS metaapi_max_lot numeric DEFAULT 0.10;