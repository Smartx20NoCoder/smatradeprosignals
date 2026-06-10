ALTER TABLE app_settings
  ALTER COLUMN pair_auto_execute SET DEFAULT '{
    "XAU/USD": true, "BTC/USD": true, "GBP/USD": true,
    "GBP/JPY": true, "EUR/USD": false, "EUR/JPY": false,
    "USD/JPY": true, "EUR/GBP": false, "AUD/JPY": false, "AUD/USD": false
  }'::jsonb;

UPDATE app_settings
SET pair_auto_execute = COALESCE(pair_auto_execute, '{}'::jsonb)
  || '{"EUR/GBP": false, "AUD/JPY": false, "AUD/USD": false}'::jsonb
WHERE id = 'singleton';