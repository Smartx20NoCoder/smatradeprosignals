// Server route that proxies the NDJSON stream from scan-signals so the
// INTERNAL_FN_SECRET stays on the server. The browser POSTs here; this handler
// re-emits the upstream response body verbatim.
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/internal/scan")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const supabaseUrl =
          process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? "";
        const anon =
          process.env.SUPABASE_PUBLISHABLE_KEY ??
          process.env.SUPABASE_ANON_KEY ??
          process.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
          "";
        const secret = process.env.INTERNAL_FN_SECRET ?? "";

        let body: unknown = {};
        try { body = await request.json(); } catch { /* default */ }

        const upstream = await fetch(`${supabaseUrl}/functions/v1/scan-signals`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-fn-secret": secret,
            apikey: anon,
            Authorization: `Bearer ${anon}`,
          },
          body: JSON.stringify(body ?? {}),
        });

        const contentType =
          upstream.headers.get("Content-Type") ?? "application/json";

        return new Response(upstream.body, {
          status: upstream.status,
          headers: {
            "Content-Type": contentType,
            "Cache-Control": "no-store",
          },
        });
      },
    },
  },
});
