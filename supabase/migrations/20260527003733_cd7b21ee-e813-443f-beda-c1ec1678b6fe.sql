ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS key1_exhausted_at TIMESTAMPTZ;

GRANT UPDATE ON public.app_settings TO anon, authenticated;
GRANT ALL ON public.app_settings TO service_role;

DROP POLICY IF EXISTS "public update app_settings" ON public.app_settings;
CREATE POLICY "public update app_settings"
ON public.app_settings
FOR UPDATE
USING (true)
WITH CHECK (true);