// Server route that proxies manual signal-status updates to the privileged
// update-signal edge function so the INTERNAL_FN_SECRET stays server-side.
// The signals table's public UPDATE policy was removed for security
// (see migration 20260528120525), so the browser can no longer update
// signals directly with the anon key — this route is now the only path
// for the Signals tab's status tiles and the "TP1 + BE runner" button.
//
// Save this file as: src/routes/api/internal/update-signal.ts
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/internal/update-signal")({
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

        const upstream = await fetch(`${supabaseUrl}/functions/v1/update-signal`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-fn-secret": secret,
            apikey: anon,
            Authorization: `Bearer ${anon}`,
          },
          body: JSON.stringify(body ?? {}),
        });

        const text = await upstream.text();
        return new Response(text, {
          status: upstream.status,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      },
    },
  },
});
