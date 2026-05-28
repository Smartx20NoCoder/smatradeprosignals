// Shared auth helper for internal edge functions.
// Accepts EITHER:
//   x-fn-secret header matching INTERNAL_FN_SECRET (used by TanStack server fns / proxies)
//   Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY> (used by pg_cron + admin tooling)
export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-fn-secret",
};

export function checkInternalAuth(req: Request): Response | null {
  const fnSecret = Deno.env.get("INTERNAL_FN_SECRET");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const headerSecret = req.headers.get("x-fn-secret");
  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";

  const okSecret = !!fnSecret && headerSecret === fnSecret;
  const okBearer = !!serviceRole && bearer === serviceRole;

  if (okSecret || okBearer) return null;
  return new Response(JSON.stringify({ error: "Unauthorized" }), {
    status: 401,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Generic error helper — never leak raw exception details to the caller.
export function safeError(message: string, status = 500): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
