// Shared helpers for MetaApi Cloud REST integration.
// Docs: https://metaapi.cloud/docs/client/restApi/

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-fn-secret",
};

export function checkSecret(req: Request): Response | null {
  const expected = Deno.env.get("INTERNAL_FN_SECRET");
  if (!expected || req.headers.get("x-fn-secret") !== expected) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  return null;
}

export function metaapiBase(region: string): string {
  // Region must match the region the MetaApi account was provisioned in.
  // Common: new-york, london, singapore.
  return `https://mt-client-api-v1.${region}.agiliumtrade.ai`;
}

export function provisioningBase(region: string): string {
  return `https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai`;
  // (Provisioning API is single-region; not needed for trade execution.)
}

export function pairToSymbol(pair: string): string {
  // "EUR/USD" -> "EURUSD" — most brokers use this. Some brokers append "m" / ".raw" etc;
  // user can override in their MetaApi account settings if needed.
  return pair.replace("/", "").toUpperCase();
}

export type MetaApiTradeResponse = {
  numericCode?: number;
  stringCode?: string;
  message?: string;
  orderId?: string;
  positionId?: string;
};

export async function placeMarketOrder(opts: {
  region: string;
  accountId: string;
  token: string;
  symbol: string;
  side: "BUY" | "SELL";
  volume: number;
  stopLoss: number;
  takeProfit: number;
  comment?: string;
  clientId?: string;
}): Promise<{ ok: boolean; data?: MetaApiTradeResponse; error?: string; raw?: unknown }> {
  const url = `${metaapiBase(opts.region)}/users/current/accounts/${opts.accountId}/trade`;
  const payload = {
    actionType: opts.side === "BUY" ? "ORDER_TYPE_BUY" : "ORDER_TYPE_SELL",
    symbol: opts.symbol,
    volume: opts.volume,
    stopLoss: opts.stopLoss,
    takeProfit: opts.takeProfit,
    comment: (opts.comment ?? "scalpedge").slice(0, 27),
    clientId: opts.clientId,
  };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "auth-token": opts.token,
      },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    let data: any = null;
    try { data = JSON.parse(text); } catch { /* not json */ }
    if (!res.ok) {
      return { ok: false, error: `${res.status}: ${data?.message ?? text.slice(0, 200)}`, raw: data ?? text };
    }
    if (data && data.numericCode != null && data.numericCode !== 10009 && data.numericCode !== 10008 && data.numericCode !== 0) {
      return { ok: false, error: `MT error ${data.numericCode}: ${data.message ?? data.stringCode}`, raw: data };
    }
    return { ok: true, data: data as MetaApiTradeResponse, raw: data };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function getAccountInfo(opts: { region: string; accountId: string; token: string }) {
  const url = `${metaapiBase(opts.region)}/users/current/accounts/${opts.accountId}/account-information`;
  const res = await fetch(url, { headers: { "auth-token": opts.token } });
  const text = await res.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch { /* */ }
  if (!res.ok) return { ok: false as const, error: `${res.status}: ${text.slice(0, 200)}` };
  return { ok: true as const, data };
}

export async function getOpenPositions(opts: { region: string; accountId: string; token: string }) {
  const url = `${metaapiBase(opts.region)}/users/current/accounts/${opts.accountId}/positions`;
  const res = await fetch(url, { headers: { "auth-token": opts.token } });
  const text = await res.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch { /* */ }
  if (!res.ok) return { ok: false as const, error: `${res.status}: ${text.slice(0, 200)}` };
  return { ok: true as const, data: (data ?? []) as Array<any> };
}

export async function getHistoryDealsBySymbol(opts: {
  region: string;
  accountId: string;
  token: string;
  startTime: string; // ISO
}) {
  // Get all history deals since startTime
  const endTime = new Date(Date.now() + 60_000).toISOString();
  const url = `${metaapiBase(opts.region)}/users/current/accounts/${opts.accountId}/history-deals/time/${encodeURIComponent(opts.startTime)}/${encodeURIComponent(endTime)}`;
  const res = await fetch(url, { headers: { "auth-token": opts.token } });
  const text = await res.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch { /* */ }
  if (!res.ok) return { ok: false as const, error: `${res.status}: ${text.slice(0, 200)}` };
  return { ok: true as const, data: (data ?? []) as Array<any> };
}
