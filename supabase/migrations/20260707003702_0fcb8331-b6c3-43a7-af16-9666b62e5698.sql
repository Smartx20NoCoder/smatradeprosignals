ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS metaapi_key_rotation_threshold integer DEFAULT 700;

UPDATE public.app_settings
  SET metaapi_key_rotation_threshold = 700
  WHERE id = 'singleton' AND metaapi_key_rotation_threshold IS NULL;

ALTER TABLE public.signals
  ADD COLUMN IF NOT EXISTS paper_only boolean DEFAULT false;