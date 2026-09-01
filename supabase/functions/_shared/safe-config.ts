// supabase/functions/_shared/safe-config.ts
export type ServerConfig = { url: string; serviceRole?: string; anon?: string; secret?: string } | { error: string };

export function getServerConfigSafe(): ServerConfig {
  const url = Deno.env.get("SUPABASE_URL") ?? Deno.env.get("VITE_SUPABASE_URL") ?? "";
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const anon = Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const secret = Deno.env.get("INTERNAL_FN_SECRET") ?? "";

  if (!url) {
    return { error: "Missing env: SUPABASE_URL" };
  }
  // serviceRole / anon / secret may be optional depending on auth flow, but warn if none present
  if (!serviceRole && !anon && !secret) {
    return { error: "Missing auth env: SUPABASE_SERVICE_ROLE_KEY or SUPABASE_PUBLISHABLE_KEY or INTERNAL_FN_SECRET" };
  }

  return { url, serviceRole: serviceRole || undefined, anon: anon || undefined, secret: secret || undefined };
}
