CREATE OR REPLACE FUNCTION public.increment_api_usage(p_day date, p_delta integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_total integer;
BEGIN
  INSERT INTO public.api_usage (day, calls, updated_at)
  VALUES (p_day, p_delta, now())
  ON CONFLICT (day) DO UPDATE
    SET calls = public.api_usage.calls + EXCLUDED.calls,
        updated_at = now()
  RETURNING calls INTO new_total;
  RETURN new_total;
END;
$$;

GRANT EXECUTE ON FUNCTION public.increment_api_usage(date, integer) TO service_role;