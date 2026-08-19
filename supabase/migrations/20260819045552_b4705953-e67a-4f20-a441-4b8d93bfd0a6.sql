ALTER TABLE app_settings 
ADD COLUMN IF NOT EXISTS metaapi_trail_activate_r NUMERIC DEFAULT 0.35;
