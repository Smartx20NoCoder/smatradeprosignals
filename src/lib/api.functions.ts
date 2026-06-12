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

// MetaApi health-check — reads provisioning state + connectionStatus,
// auto-redeploys when DEPLOYED+DISCONNECTED. Used by the Health tab and cron.
export const healthCheckMetaApiFn = createServerFn({ method: "POST" })
  .inputValidator((input: { force?: boolean } | undefined) =>
    z.object({ force: z.boolean().optional() }).parse(input ?? {}),
  )
  .handler(async ({ data }) => {
    const { status, data: resp } = await callEdge("metaapi-health-check", { force: !!data.force });
    const d = (resp ?? {}) as any;
    if (status >= 500) {
      return { status: "error" as "connected" | "reconnecting" | "error", reason: "health check failed" };
    }
    return {
      status: (d.status as "connected" | "reconnecting" | "error") ?? "error",
      state: typeof d.state === "string" ? d.state : undefined,
      connectionStatus: typeof d.connectionStatus === "string" ? d.connectionStatus : undefined,
      redeployed: !!d.redeployed,
      reason: typeof d.reason === "string" ? d.reason : undefined,
    };
  });

// MetaApi test trade — places & immediately closes a tiny order on the chosen pair.
export const testTradeMetaApiFn = createServerFn({ method: "POST" })
  .inputValidator((input: { pair?: string } | undefined) =>
    z.object({ pair: z.string().min(3).max(16).optional() }).parse(input ?? {}),
  )
  .handler(async ({ data }) => {
    const { status, data: resp } = await callEdge("metaapi-test-trade", { pair: data.pair ?? "BTC/USD" });
    const d = (resp ?? {}) as any;
    if (status >= 500 && !Array.isArray(d.steps)) {
      return { ok: false as boolean, steps: [] as Array<any>, summary: "Test failed: edge function error" };
    }
    return {
      ok: !!d.ok,
      steps: Array.isArray(d.steps) ? d.steps : [],
      summary: typeof d.summary === "string" ? d.summary : "",
    };
  });

// MetaApi symbols — list broker symbols and highlight matches for traded pairs.
export const checkSymbolsMetaApiFn = createServerFn({ method: "POST" })
  .handler(async () => {
    const { status, data: resp } = await callEdge("metaapi-symbols", {});
    const d = (resp ?? {}) as any;
    if (status >= 500) {
      return { ok: false as boolean, reason: "symbols check failed", all: [] as string[], found: [] as string[], notFound: [] as string[], matches: {} as Record<string, string[]>, count: 0 };
    }
    return {
      ok: !!d.ok,
      reason: typeof d.reason === "string" ? d.reason : undefined,
      mode: typeof d.mode === "string" ? d.mode : undefined,
      all: Array.isArray(d.all) ? (d.all as string[]) : [],
      found: Array.isArray(d.found) ? (d.found as string[]) : [],
      notFound: Array.isArray(d.notFound) ? (d.notFound as string[]) : [],
      matches: (d.matches ?? {}) as Record<string, string[]>,
      count: Number(d.count ?? 0),
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

