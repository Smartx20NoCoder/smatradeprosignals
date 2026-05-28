// Server fns that proxy to privileged Supabase Edge Functions.
// The INTERNAL_FN_SECRET stays server-side; the browser never sees it.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const SUPABASE_URL = () =>
  process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? "";
const ANON_KEY = () =>
  process.env.SUPABASE_PUBLISHABLE_KEY ??
  process.env.SUPABASE_ANON_KEY ??
  process.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
  "";

function privilegedHeaders(): Record<string, string> {
  const secret = process.env.INTERNAL_FN_SECRET ?? "";
  const anon = ANON_KEY();
  return {
    "Content-Type": "application/json",
    "x-fn-secret": secret,
    apikey: anon,
    Authorization: `Bearer ${anon}`,
  };
}

async function callEdge(path: string, body: unknown): Promise<{ status: number; data: unknown }> {
  const url = `${SUPABASE_URL()}/functions/v1/${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: privilegedHeaders(),
    body: JSON.stringify(body ?? {}),
  });
  let data: unknown = null;
  const text = await res.text();
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 300) }; }
  return { status: res.status, data };
}

// Settings update — payload validated server-side by update-settings as well.
const SettingsPatchSchema = z.record(z.string(), z.unknown());

export const updateAppSettingsFn = createServerFn({ method: "POST" })
  .inputValidator((input) => SettingsPatchSchema.parse(input))
  .handler(async ({ data }) => {
    const { status, data: body } = await callEdge("update-settings", data);
    if (status >= 400) {
      const msg = (body as any)?.error ?? `Failed to save settings (${status})`;
      throw new Error(String(msg).slice(0, 200));
    }
    return { ok: true };
  });

// MetaApi ping — read-only status check.
export const pingMetaApiFn = createServerFn({ method: "POST" })
  .handler(async () => {
    const { status, data } = await callEdge("metaapi-ping", {});
    if (status >= 500) return { ok: false as boolean, reason: "broker check failed", account: null as any };
    const d = (data ?? {}) as any;
    return {
      ok: !!d.ok,
      reason: typeof d.reason === "string" ? d.reason : undefined,
      account: d.account ?? null,
    };
  });

const NewsSchema = z.object({
  source: z.string().min(1).max(32).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export const refreshNewsCalendarFn = createServerFn({ method: "POST" })
  .inputValidator((input) => NewsSchema.parse(input))
  .handler(async ({ data }) => {
    const { status, data: body } = await callEdge("fetch-news-calendar", data);
    if (status >= 400) {
      const msg = (body as any)?.error ?? `Calendar refresh failed (${status})`;
      throw new Error(String(msg).slice(0, 200));
    }
    const b = (body ?? {}) as any;
    return { ok: true, inserted: Number(b.inserted ?? 0), date: String(b.date ?? "") };
  });

