
ALTER TABLE public.app_settings
ADD COLUMN IF NOT EXISTS session_config jsonb NOT NULL DEFAULT '{
  "scan_active_sessions_only": false,
  "sessions": {
    "london":  {"enabled": true, "start": 7,  "end": 16},
    "ny":      {"enabled": true, "start": 12, "end": 21},
    "tokyo":   {"enabled": true, "start": 0,  "end": 9},
    "sydney":  {"enabled": true, "start": 22, "end": 7}
  },
  "custom_overrides": {}
}'::jsonb;
