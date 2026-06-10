
ALTER TABLE public.api_usage ADD COLUMN IF NOT EXISTS calls_key1 int NOT NULL DEFAULT 0;
ALTER TABLE public.api_usage ADD COLUMN IF NOT EXISTS calls_key2 int NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.increment_api_usage(p_day date, p_delta integer, p_key smallint DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  new_total integer;
  d1 integer := CASE WHEN p_key = 1 THEN p_delta ELSE 0 END;
  d2 integer := CASE WHEN p_key = 2 THEN p_delta ELSE 0 END;
BEGIN
  INSERT INTO public.api_usage (day, calls, calls_key1, calls_key2, updated_at)
  VALUES (p_day, p_delta, d1, d2, now())
  ON CONFLICT (day) DO UPDATE
    SET calls = public.api_usage.calls + EXCLUDED.calls,
        calls_key1 = public.api_usage.calls_key1 + EXCLUDED.calls_key1,
        calls_key2 = public.api_usage.calls_key2 + EXCLUDED.calls_key2,
        updated_at = now()
  RETURNING calls INTO new_total;
  RETURN new_total;
END;
$function$;
