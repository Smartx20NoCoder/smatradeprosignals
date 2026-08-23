// Same-domain proxy for the bridge polling endpoint, so the MT4 EA can call
// every bridge endpoint on one host (https://smatradeprosignals.lovable.app/api/public/...).
// Auth: EA sends x-fn-secret; we verify it here and forward with the server-side secret.
import { createFileRoute } from "@tanstack/react-router";

const CORS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-fn-secret",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: CORS });

async function logPoll(
  endpoint: string,
  httpStatus: number,
  signalsReturned: number,
  note?: string,
) {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin.from("bridge_poll_log").insert({
      endpoint,
      http_status: httpStatus,
      signals_returned: signalsReturned,
      note: note ?? null,
    });
  } catch (e) {
    console.error("bridge poll log failed", e);
  }
}

async function proxy(request: Request, fn: string) {
  const expected = process.env["INTERNAL_FN_SECRET"] ?? "";
  if (!expected || request.headers.get("x-fn-secret") !== expected) {
    await logPoll(fn, 401, 0, "bad or missing x-fn-secret");
    return json({ error: "Unauthorized" }, 401);
  }
  const base = process.env["SUPABASE_URL"] ?? "";
  const anon =
    process.env["SUPABASE_PUBLISHABLE_KEY"] ?? process.env["SUPABASE_ANON_KEY"] ?? "";
  const body = await request.text();
  const res = await fetch(`${base}/functions/v1/${fn}`, {
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
  let count = 0;
  let note: string | undefined;
  try {
    const parsed = JSON.parse(text) as { signals?: unknown[]; scanning_active?: boolean; error?: string };
    count = Array.isArray(parsed.signals) ? parsed.signals.length : 0;
    note = parsed.error
      ? String(parsed.error).slice(0, 200)
      : `scanning_active=${parsed.scanning_active}`;
  } catch {
    note = text.slice(0, 200);
  }
  await logPoll(fn, res.status, count, note);
  return new Response(text, { status: res.status, headers: CORS });
}


export const Route = createFileRoute("/api/public/bridge-get-signals")({
  server: {
    handlers: {
      OPTIONS: async () => json({ ok: true }),
      GET: async ({ request }) => proxy(request, "bridge-get-signals"),
      POST: async ({ request }) => proxy(request, "bridge-get-signals"),
    },
  },
});
