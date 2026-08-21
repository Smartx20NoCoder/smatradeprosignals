// Same-domain proxy for the bridge execution-report endpoint (see bridge-get-signals.ts).
import { createFileRoute } from "@tanstack/react-router";

const CORS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-fn-secret",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: CORS });

export const Route = createFileRoute("/api/public/bridge-report-execution")({
  server: {
    handlers: {
      OPTIONS: async () => json({ ok: true }),
      POST: async ({ request }) => {
        const expected = process.env["INTERNAL_FN_SECRET"] ?? "";
        if (!expected || request.headers.get("x-fn-secret") !== expected) {
          return json({ error: "Unauthorized" }, 401);
        }
        const base = process.env["SUPABASE_URL"] ?? "";
        const anon =
          process.env["SUPABASE_PUBLISHABLE_KEY"] ?? process.env["SUPABASE_ANON_KEY"] ?? "";
        const body = await request.text();
        const res = await fetch(`${base}/functions/v1/bridge-report-execution`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-fn-secret": expected,
            apikey: anon,
            Authorization: `Bearer ${anon}`,
          },
          body: body || "{}",
        });
        const text = await res.text();
        return new Response(text, { status: res.status, headers: CORS });
      },
    },
  },
});
