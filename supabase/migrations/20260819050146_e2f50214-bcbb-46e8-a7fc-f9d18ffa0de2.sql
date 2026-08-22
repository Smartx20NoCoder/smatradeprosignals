-- ScalpEdge Bridge support: heartbeat + claim tracking so metaapi-execute
-- knows when to defer to the bridge EA vs fall back to MetaAPI execution.

ALTER TABLE app_settings
  ADD COLUMN IF NOT EXISTS bridge_last_seen TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS bridge_pairs TEXT[] DEFAULT ARRAY['GBP/USD','XAU/USD','BTC/USD'],
  ADD COLUMN IF NOT EXISTS bridge_claim_grace_sec INTEGER DEFAULT 90,
  ADD COLUMN IF NOT EXISTS bridge_claim_expiry_min INTEGER DEFAULT 20;

ALTER TABLE signals
  ADD COLUMN IF NOT EXISTS metaapi_execution_channel TEXT,
  ADD COLUMN IF NOT EXISTS bridge_claimed_at TIMESTAMPTZ;
