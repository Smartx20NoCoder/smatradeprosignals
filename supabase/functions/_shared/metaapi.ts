// Shared helpers for MetaApi Cloud REST integration.
// Docs: https://metaapi.cloud/docs/client/restApi/
import { checkInternalAuth, corsHeaders, safeError } from "./auth.ts";

export { corsHeaders, safeError };
// Re-export so existing imports keep working.
export const checkSecret = checkInternalAuth;

export function metaapiBase(region: string): string {
  return `https://mt-client-api-v1.${region}.agiliumtrade.ai`;
}

// Provisioning API is always hit at the global `new-york` host regardless of
// where the account itself is hosted — it's where account metadata lives.
export function metaapiProvisioningBase(_region?: string): string {
  return `https://mt-provisioning-api-v1.new-york.agiliumtrade.ai`;
}

// Resolve the correct client API base URL for a given accountId by asking the
// provisioning API. Cached per-invocation in this module-level Map so we only
// look it up once per cold start / function call.
const _clientBaseCache = new Map<string, string>();
export async function resolveClientBase(opts: {
  accountId: string; token: string; fallbackRegion: string;
}): Promise<string> {
  const cached = _clientBaseCache.get(opts.accountId);
  if (cached) return cached;
  try {
    const url = `${metaapiProvisioningBase()}/users/current/accounts/${opts.accountId}`;
    const res = await fetch(url, { headers: { "auth-token": opts.token } });
    if (res.ok) {
      const data = await res.json().catch(() => null) as any;
      // MetaApi returns `region` (e.g. "new-york") on the account record.
      // For accounts hosted on cloud-g2 the provisioning record exposes the
      // proper region to address its client API.
      const region = (data?.region as string | undefined) ?? opts.fallbackRegion;
      const base = metaapiBase(region);
      _clientBaseCache.set(opts.accountId, base);
      return base;
    }
    console.error("resolveClientBase: provisioning lookup failed", res.status);
  } catch (e) {
    console.error("resolveClientBase exception", e);
  }
  // Fall back to the user-configured region.
  return metaapiBase(opts.fallbackRegion);
}

async function clientBase(opts: { region: string; accountId: string; token: string }): Promise<string> {
  return resolveClientBase({ accountId: opts.accountId, token: opts.token, fallbackRegion: opts.region });
}

// Provisioning API: returns full account record including reliable `state`.
export async function getProvisioningAccountInfo(opts: {
  region: string; accountId: string; token: string;
}): Promise<{ ok: boolean; data?: any; error?: string; status?: number }> {
  const url = `${metaapiProvisioningBase(opts.region)}/users/current/accounts/${opts.accountId}`;
  try {
    const res = await fetch(url, { headers: { "auth-token": opts.token } });
    const text = await res.text();
    let data: any = null;
    try { data = JSON.parse(text); } catch { /* */ }
    if (!res.ok) return { ok: false, status: res.status, error: `provisioning ${res.status}: ${text.slice(0, 200)}` };
    return { ok: true, data };
  } catch (e) {
    console.error("getProvisioningAccountInfo exception", e);
    return { ok: false, error: "provisioning fetch failed" };
  }
}

// Trigger a deploy on the provisioning API, then poll for DEPLOYED state.
// Returns a log of attempts for diagnostics.
export async function deployAccount(opts: {
  region: string; accountId: string; token: string;
  maxPolls?: number; pollDelayMs?: number;
}): Promise<{ ok: boolean; state?: string; log: string[] }> {
  const log: string[] = [];
  const maxPolls = opts.maxPolls ?? 5;
  const delay = opts.pollDelayMs ?? 3000;
  const url = `${metaapiProvisioningBase(opts.region)}/users/current/accounts/${opts.accountId}/deploy`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "auth-token": opts.token, "Content-Type": "application/json" },
    });
    const t = await res.text().catch(() => "");
    log.push(`deploy POST -> ${res.status} ${t.slice(0, 120)}`);
    if (!res.ok && res.status !== 204) {
      return { ok: false, log };
    }
  } catch (e) {
    log.push(`deploy POST exception: ${String(e).slice(0, 120)}`);
    return { ok: false, log };
  }

  for (let i = 1; i <= maxPolls; i++) {
    await new Promise((r) => setTimeout(r, delay));
    const info = await getProvisioningAccountInfo(opts);
    const state = String(info.data?.state ?? "unknown");
    log.push(`poll ${i}/${maxPolls}: state=${state}${info.ok ? "" : ` err=${info.error}`}`);
    if (info.ok && state.toUpperCase() === "DEPLOYED") {
      return { ok: true, state, log };
    }
  }
  return { ok: false, log };
}

export function pairToSymbol(pair: string, suffix = ""): string {
  return pair.replace("/", "").toUpperCase() + (suffix ?? "");
}

export type MetaApiTradeResponse = {
  numericCode?: number;
  stringCode?: string;
  message?: string;
  orderId?: string;
  positionId?: string;
};

// MetaApi pending order action types.
export type PendingOrderAction =
  | "ORDER_TYPE_BUY_LIMIT"
  | "ORDER_TYPE_SELL_LIMIT"
  | "ORDER_TYPE_BUY_STOP"
  | "ORDER_TYPE_SELL_STOP";

export type MarketOrderAction = "ORDER_TYPE_BUY" | "ORDER_TYPE_SELL";

export async function getSymbolPrice(opts: {
  region: string;
  accountId: string;
  token: string;
  symbol: string;
}): Promise<{ ok: boolean; bid?: number; ask?: number; error?: string }> {
  const url = `${await clientBase(opts)}/users/current/accounts/${opts.accountId}/symbols/${encodeURIComponent(opts.symbol)}/current-price?keepSubscription=true`;
  try {
    const res = await fetch(url, { headers: { "auth-token": opts.token } });
    const text = await res.text();
    let data: any = null;
    try { data = JSON.parse(text); } catch { /* */ }
    if (!res.ok) return { ok: false, error: `price: ${res.status}` };
    const bid = data?.bid != null ? Number(data.bid) : undefined;
    const ask = data?.ask != null ? Number(data.ask) : undefined;
    return { ok: true, bid, ask };
  } catch (e) {
    console.error("getSymbolPrice error", e);
    return { ok: false, error: "price fetch failed" };
  }
}

export async function placeOrder(opts: {
  region: string;
  accountId: string;
  token: string;
  actionType: MarketOrderAction | PendingOrderAction;
  symbol: string;
  volume: number;
  openPrice?: number; // required for pending orders
  stopLoss: number;
  takeProfit: number;
  comment?: string;
  clientId?: string;
}): Promise<{ ok: boolean; data?: MetaApiTradeResponse; error?: string }> {
  const url = `${await clientBase(opts)}/users/current/accounts/${opts.accountId}/trade`;
  const payload: Record<string, unknown> = {
    actionType: opts.actionType,
    symbol: opts.symbol,
    volume: opts.volume,
    stopLoss: opts.stopLoss,
    takeProfit: opts.takeProfit,
    comment: (opts.comment ?? "scalpedge").slice(0, 27),
    clientId: opts.clientId,
  };
  if (opts.openPrice != null && opts.actionType !== "ORDER_TYPE_BUY" && opts.actionType !== "ORDER_TYPE_SELL") {
    payload.openPrice = opts.openPrice;
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "auth-token": opts.token },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    let data: any = null;
    try { data = JSON.parse(text); } catch { /* */ }
    if (!res.ok) {
      console.error("MetaApi placeOrder failed", res.status, text.slice(0, 300));
      const detail = (text || "").trim().slice(0, 300);
      return { ok: false, error: `broker rejected order (${res.status}): ${detail || "no response body"}` };
    }
    if (data && data.numericCode != null && data.numericCode !== 10009 && data.numericCode !== 10008 && data.numericCode !== 0) {
      console.error("MetaApi numericCode error", data);
      return { ok: false, error: `broker error code ${data.numericCode}` };
    }
    return { ok: true, data: data as MetaApiTradeResponse };
  } catch (e) {
    console.error("placeOrder exception", e);
    return { ok: false, error: "order request failed" };
  }
}

// Backwards-compat wrapper used by metaapi-execute callers
export async function placeMarketOrder(opts: {
  region: string; accountId: string; token: string;
  symbol: string; side: "BUY" | "SELL"; volume: number;
  stopLoss: number; takeProfit: number;
  comment?: string; clientId?: string;
}) {
  return placeOrder({
    ...opts,
    actionType: opts.side === "BUY" ? "ORDER_TYPE_BUY" : "ORDER_TYPE_SELL",
  });
}

export async function closePartialPosition(opts: {
  region: string; accountId: string; token: string;
  positionId: string; volume: number;
}): Promise<{ ok: boolean; error?: string }> {
  const url = `${await clientBase(opts)}/users/current/accounts/${opts.accountId}/trade`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "auth-token": opts.token },
      body: JSON.stringify({
        actionType: "POSITION_CLOSE_PARTIAL",
        positionId: opts.positionId,
        volume: opts.volume,
      }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      console.error("partial close failed", res.status, t.slice(0, 200));
      return { ok: false, error: `partial close failed (${res.status})` };
    }
    return { ok: true };
  } catch (e) {
    console.error("partial close exception", e);
    return { ok: false, error: "partial close request failed" };
  }
}

export async function modifyPosition(opts: {
  region: string; accountId: string; token: string;
  positionId: string; stopLoss?: number; takeProfit?: number;
}): Promise<{ ok: boolean; error?: string }> {
  const url = `${await clientBase(opts)}/users/current/accounts/${opts.accountId}/trade`;
  const payload: Record<string, unknown> = {
    actionType: "POSITION_MODIFY",
    positionId: opts.positionId,
  };
  if (opts.stopLoss != null) payload.stopLoss = opts.stopLoss;
  if (opts.takeProfit != null) payload.takeProfit = opts.takeProfit;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "auth-token": opts.token },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      console.error("modify position failed", res.status, t.slice(0, 200));
      return { ok: false, error: `modify position failed (${res.status})` };
    }
    return { ok: true };
  } catch (e) {
    console.error("modify position exception", e);
    return { ok: false, error: "modify position request failed" };
  }
}

export async function getAccountInfo(opts: { region: string; accountId: string; token: string }) {
  const url = `${await clientBase(opts)}/users/current/accounts/${opts.accountId}/account-information`;
  try {
    const res = await fetch(url, { headers: { "auth-token": opts.token } });
    if (!res.ok) {
      console.error("account info", res.status);
      return { ok: false as const, error: `broker unreachable (${res.status})` };
    }
    const data = await res.json();
    return { ok: true as const, data };
  } catch (e) {
    console.error("account info exception", e);
    return { ok: false as const, error: "broker unreachable" };
  }
}

export async function getOpenPositions(opts: { region: string; accountId: string; token: string }) {
  const url = `${await clientBase(opts)}/users/current/accounts/${opts.accountId}/positions`;
  try {
    const res = await fetch(url, { headers: { "auth-token": opts.token } });
    if (!res.ok) {
      console.error("positions", res.status);
      return { ok: false as const, error: `positions fetch failed (${res.status})` };
    }
    const data = await res.json();
    return { ok: true as const, data: (data ?? []) as Array<any> };
  } catch (e) {
    console.error("positions exception", e);
    return { ok: false as const, error: "positions fetch failed" };
  }
}

export async function getHistoryDealsBySymbol(opts: {
  region: string; accountId: string; token: string; startTime: string;
}) {
  const endTime = new Date(Date.now() + 60_000).toISOString();
  const url = `${await clientBase(opts)}/users/current/accounts/${opts.accountId}/history-deals/time/${encodeURIComponent(opts.startTime)}/${encodeURIComponent(endTime)}`;
  try {
    const res = await fetch(url, { headers: { "auth-token": opts.token } });
    if (!res.ok) {
      console.error("history", res.status);
      return { ok: false as const, error: `history fetch failed (${res.status})` };
    }
    const data = await res.json();
    return { ok: true as const, data: (data ?? []) as Array<any> };
  } catch (e) {
    console.error("history exception", e);
    return { ok: false as const, error: "history fetch failed" };
  }
}

// Look up an order (pending or already executed) by id from history.
// Returns the order object if found — when the order has been filled,
// MetaApi populates `positionId` on the matching history-orders row.
export async function getHistoryOrderById(opts: {
  region: string; accountId: string; token: string; orderId: string; startTime: string;
}): Promise<{ ok: boolean; data?: any; error?: string }> {
  const endTime = new Date(Date.now() + 60_000).toISOString();
  const url = `${await clientBase(opts)}/users/current/accounts/${opts.accountId}/history-orders/time/${encodeURIComponent(opts.startTime)}/${encodeURIComponent(endTime)}`;
  try {
    const res = await fetch(url, { headers: { "auth-token": opts.token } });
    if (!res.ok) {
      console.error("history-orders", res.status);
      return { ok: false, error: `history-orders fetch failed (${res.status})` };
    }
    const data = await res.json();
    const arr = (data ?? []) as Array<any>;
    const match = arr.find((o) => String(o.id) === String(opts.orderId));
    return { ok: true, data: match };
  } catch (e) {
    console.error("history-orders exception", e);
    return { ok: false, error: "history-orders fetch failed" };
  }
}

// Fetch all deals for a closed position to compute final PnL.
export async function getHistoryDealsByPosition(opts: {
  region: string; accountId: string; token: string; positionId: string;
}): Promise<{ ok: boolean; data?: any[]; error?: string }> {
  const url = `${await clientBase(opts)}/users/current/accounts/${opts.accountId}/history-deals/position/${encodeURIComponent(opts.positionId)}`;
  try {
    const res = await fetch(url, { headers: { "auth-token": opts.token } });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      console.error("history-deals/position", res.status, t.slice(0, 200));
      return { ok: false, error: `history-deals/position failed (${res.status})` };
    }
    const data = await res.json();
    return { ok: true, data: (data ?? []) as any[] };
  } catch (e) {
    console.error("history-deals/position exception", e);
    return { ok: false, error: "history-deals/position fetch failed" };
  }
}
