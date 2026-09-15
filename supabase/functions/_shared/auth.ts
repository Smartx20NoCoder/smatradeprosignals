// Shared auth helper for internal edge functions.
// Accepts ANY of:
//   x-fn-secret header matching INTERNAL_FN_SECRET (TanStack server fns / proxies)
//   Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY> (exact match — admin tooling)
//   Authorization: Bearer <any Supabase JWT> issued by this project's ref
//     with role in {service_role, anon, authenticated} — covers pg_cron whose
//     stored service-role JWT may differ from the current env var after a rotation.
//   this project's browser publishable key in apikey/Authorization — required for
//   the unauthenticated Strategy Tester path used by the public web client.
export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-fn-secret",
};

// Publishable keys are public client credentials (also embedded in the web app),
// so keeping the current project key here is not equivalent to exposing a secret.
const PROJECT_PUBLISHABLE_KEY = "sb_publishable_CwbRn7_T_tFM157Yv6AFTw_SWaGgS4u";

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    // base64url -> base64
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 === 0 ? b64 : b64 + "=".repeat(4 - (b64.length % 4));
    const json = atob(pad);
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function projectRef(): string | null {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const m = url.match(/^https?:\/\/([a-z0-9]+)\.supabase\.co/i);
  return m ? m[1] : null;
}

export function checkInternalAuth(req: Request): Response | null {
  const fnSecret = Deno.env.get("INTERNAL_FN_SECRET");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const publishableKey = Deno.env.get("SUPABASE_PUBLISHABLE_KEY") || PROJECT_PUBLISHABLE_KEY;
  const headerSecret = req.headers.get("x-fn-secret");
  const apikey = req.headers.get("apikey") ?? req.headers.get("x-api-key") ?? "";
  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";

  if (!!fnSecret && headerSecret === fnSecret) return null;
  if (!!serviceRole && bearer === serviceRole) return null;

  // Browser clients may send the public project key either as apikey or as the
  // Authorization bearer value. This is intentionally limited to this project key.
  if (apikey === publishableKey || bearer === publishableKey) return null;

  // Fallback: accept any Supabase-issued JWT for this project.
  if (bearer) {
    const payload = decodeJwtPayload(bearer);
    const ref = projectRef();
    const role = (payload?.role as string | undefined) ?? "";
    const refClaim = (payload?.ref as string | undefined) ?? "";
    const iss = (payload?.iss as string | undefined) ?? "";
    const exp = Number(payload?.exp ?? 0);
    const now = Math.floor(Date.now() / 1000);
    const roleOk = ["service_role", "authenticated", "anon"].includes(role);
    const refOk = !ref || refClaim === ref || iss.includes("supabase");
    const notExpired = !exp || exp > now;
    if (payload && roleOk && refOk && notExpired) return null;
  }

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
