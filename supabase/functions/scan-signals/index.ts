// ScalpEdge scan engine v3
// 7 pairs (XAU/USD + BTC/USD replace GBP/CHF + USD/CHF), 5 setups, 1H HTF bias filter,
// MFI confirmation, spread cushion. Every individual TwelveData call is serialized
// with an ~8s gap and pair+timeframe candle data is cached for at least 10 minutes.
// One signal per pair per direction (highest confidence wins).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { checkInternalAuth } from "../_shared/auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-fn-secret",
};

const PAIRS = [
  "XAU/USD", "BTC/USD", "ETH/USD", "XRP/USD", // crypto + gold — always scan first
  "GBP/USD", "GBP/JPY", // core FX
  "EUR/USD", "USD/JPY", // secondary FX
  "AUD/JPY", "AUD/USD" // secondary pairs
];
// Disabled setups — kept in code but filtered out of signal generation.
// Previously hard-disabled setups are now controlled via setup_auto_execute (default off).
const DISABLED_SETUPS = new Set<string>();
const TFS = [
  { label: "5m", td: "5min" },
  { label: "15m", td: "15min" },
  { label: "1h", td: "1h" },
];
const CACHE_TTL_MIN_BY_TF: Record<string, number> = { "5m": 10, "15m": 15, "1h": 60 };
const DEFAULT_CACHE_TTL_MIN = 15;
const DAILY_BUDGET = 800;
// Spacing between every individual TwelveData request: 8.2s → safely under 8/min.
const API_CALL_SPACING_MS = 4500;
const RATE_LIMIT_RETRY_MS = 60_000;
const MAX_429_RETRIES = 2;
let twelveDataQueue: Promise<void> = Promise.resolve();
let lastTwelveDataCallStartedAt = 0;

// Currencies relevant to each pair (used for the news blackout match)
function pairCurrencies(pair: string): string[] {
  if (pair === "XAU/USD") return ["USD", "XAU"];
  if (pair === "BTC/USD") return ["USD"];
  return [pair.slice(0, 3), pair.slice(4, 7)];
}

// Weekend / Friday-late filter: forex + gold pause from Fri 22:00 UTC to Sun 22:00 UTC.
// Only BTC/USD trades in that window.
function isPairAllowedNow(pair: string, d: Date): boolean {
  if (pair === "BTC/USD" || pair === "XRP/USD" || pair === "ETH/USD") return true;
  const day = d.getUTCDay(); // 0 Sun, 5 Fri, 6 Sat
  const h = d.getUTCHours();
  if (day === 6) return false;                  // Saturday: closed
  if (day === 0 && h < 22) return false;        // Sunday before 22:00 UTC
  if (day === 5 && h >= 22) return false;       // Friday 22:00 UTC onwards
  return true;
}

// Spread cushion: pips for FX, absolute $ for gold/BTC.
const SPREAD_PIPS: Record<string, number> = {
  "EUR/USD": 1.2, "GBP/USD": 1.2, "USD/JPY": 1.2,
  "GBP/JPY": 2.5, "EUR/JPY": 2.5,
  "EUR/GBP": 1.5, "AUD/JPY": 2.5, "AUD/USD": 1.2,
};
const XAU_SPREAD = 0.40; // USD
const BTC_SPREAD = 2.00; // USD
const ETH_SPREAD = 1.00; // USD
const XRP_SPREAD = 0.001; // USD

type Candle = { t: number; o: number; h: number; l: number; c: number; v?: number };
type ProgressStatus = "pending" | "waiting" | "fetching" | "cached" | "done" | "rate_limited" | "error";
type ProgressEvent = {
  type: "progress" | "pair_start" | "pair_done";
  pair: string;
  timeframe?: string;
  status?: ProgressStatus;
  message?: string;
  attempt?: number;
};
type ProgressEmitter = (event: ProgressEvent) => void;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isGold = (p: string) => p === "XAU/USD";
const isBTC = (p: string) => p === "BTC/USD";
const isETH = (p: string) => p === "ETH/USD";
const isXRP = (p: string) => p === "XRP/USD";
const isCryptoAlt = (p: string) => isETH(p) || isXRP(p);
function pipSize(pair: string): number {
  if (isGold(pair)) return 0.01;
  if (isBTC(pair)) return 1.0;
  if (isETH(pair)) return 0.1;
  if (isXRP(pair)) return 0.0001;
  return pair.includes("JPY") ? 0.01 : 0.0001;
}
function spreadPrice(pair: string): number {
  if (isGold(pair)) return XAU_SPREAD;
  if (isBTC(pair)) return BTC_SPREAD;
  if (isETH(pair)) return ETH_SPREAD;
  if (isXRP(pair)) return XRP_SPREAD;
  return (SPREAD_PIPS[pair] ?? 1.5) * pipSize(pair);
}
function spreadDisplay(pair: string): number {
  if (isGold(pair)) return 40;
  if (isBTC(pair)) return 200; // $2.00 = 200 cents
  if (isETH(pair)) return 100;
  if (isXRP(pair)) return 10;
  return SPREAD_PIPS[pair] ?? 1.5;
}

// ---------- Indicators ----------
function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [values[0]];
  for (let i = 1; i < values.length; i++) out.push(values[i] * k + out[i - 1] * (1 - k));
  return out;
}
function atr(c: Candle[], period = 14): number {
  if (c.length < period + 1) return 0;
  const trs: number[] = [];
  for (let i = 1; i < c.length; i++) {
    trs.push(Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c)));
  }
  const slice = trs.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}
function mfi(c: Candle[], period = 14): { value: number; series: number[] } {
  if (c.length < period + 2) return { value: 50, series: [] };
  const series: number[] = [];
  for (let end = period + 1; end <= c.length; end++) {
    let pos = 0, neg = 0;
    for (let i = end - period; i < end; i++) {
      const tp = (c[i].h + c[i].l + c[i].c) / 3;
      const tpPrev = (c[i - 1].h + c[i - 1].l + c[i - 1].c) / 3;
      const vol = c[i].v && c[i].v! > 0 ? c[i].v! : (c[i].h - c[i].l);
      const flow = tp * vol;
      if (tp > tpPrev) pos += flow;
      else if (tp < tpPrev) neg += flow;
    }
    const ratio = neg === 0 ? 100 : pos / neg;
    series.push(100 - 100 / (1 + ratio));
  }
  return { value: series.at(-1)!, series };
}

function htfBias(c1h: Candle[]): "bull" | "bear" | "neutral" {
  if (c1h.length < 50) return "neutral";
  const closes = c1h.map((x) => x.c);
  const e21 = ema(closes, 21).at(-1)!;
  const e50 = ema(closes, 50).at(-1)!;
  const last = closes.at(-1)!;
  if (e21 > e50 && last > e21) return "bull";
  if (e21 < e50 && last < e21) return "bear";
  return "neutral";
}

function sessionScore(pair: string, dUTC: Date): number {
  const h = dUTC.getUTCHours();
  const isOverlap = h >= 12 && h < 16;
  const isLondon = h >= 7 && h < 12;
  const isNY = h >= 16 && h < 21;
  const isAsian = h >= 0 && h < 7;
  if (isBTC(pair) || isCryptoAlt(pair)) return 70; // all crypto 24/7
  if (isOverlap) return 95;
  if (isGold(pair) && (isLondon || isNY)) return 90;
  if (isGold(pair) && isAsian) return 30;
  if (pair.includes("JPY") && isAsian) return 70;
  if (pair === "EUR/GBP" && isLondon) return 90;
  if (pair === "EUR/GBP" && isNY) return 60;
  if (pair === "EUR/GBP" && isAsian) return 20;
  if (pair.startsWith("AUD") && isAsian) return 85;
  if (pair.startsWith("AUD") && isLondon) return 70;
  if (pair.startsWith("AUD") && isNY) return 55;
  if (isLondon) return 85;
  if (isNY) return 80;
  if (isAsian) return 25;
  return 45;
}

function newsFlag(dUTC: Date, pair: string): boolean {
  const h = dUTC.getUTCHours(), m = dUTC.getUTCMinutes();
  const t = h * 60 + m;
  const windows = [
    { t: 12 * 60 + 30, ccy: ["USD", "XAU"] },
    { t: 13 * 60 + 30, ccy: ["USD", "XAU"] },
    { t: 18 * 60, ccy: ["USD", "XAU"] },
    { t: 11 * 60, ccy: ["GBP"] },
    { t: 12 * 60 + 15, ccy: ["EUR"] },
    { t: 23 * 60 + 50, ccy: ["JPY"] },
  ];
  for (const w of windows) if (Math.abs(t - w.t) <= 30 && w.ccy.some((c) => pair.includes(c))) return true;
  return false;
}

// ---------- Data fetch ----------
async function throttledTwelveDataFetch(url: string, emit?: ProgressEmitter, context?: { pair: string; timeframe: string }): Promise<Response> {
  const run = async () => {
    const waitMs = Math.max(0, API_CALL_SPACING_MS - (Date.now() - lastTwelveDataCallStartedAt));
    if (waitMs > 0) {
      emit?.({ type: "progress", pair: context?.pair ?? "", timeframe: context?.timeframe, status: "waiting", message: `Waiting ${Math.ceil(waitMs / 1000)}s for rate limit slot` });
      await delay(waitMs);
    }
    lastTwelveDataCallStartedAt = Date.now();
    emit?.({ type: "progress", pair: context?.pair ?? "", timeframe: context?.timeframe, status: "fetching", message: `Fetching ${context?.pair ?? "market"} ${context?.timeframe ?? "candles"}` });
    return fetch(url);
  };
  const next = twelveDataQueue.then(run, run);
  twelveDataQueue = next.then(() => undefined, () => undefined);
  return next;
}

type KeyIdx = 1 | 2 | 3;
type KeySet = Partial<Record<KeyIdx, string>>;
type KeyState = {
  active: KeyIdx;
  configured: KeyIdx[];   // ids of keys with a configured secret, sorted ascending
  exhausted: Set<KeyIdx>; // keys that hit a rate limit this cycle
};

function nextAvailableKey(state: KeyState): KeyIdx | null {
  // Find next non-exhausted configured key, starting after the current active one.
  const order = state.configured;
  if (order.length === 0) return null;
  const startIdx = order.indexOf(state.active);
  for (let i = 1; i <= order.length; i++) {
    const cand = order[(startIdx + i) % order.length];
    if (!state.exhausted.has(cand)) return cand;
  }
  return null;
}

async function fetchCandles(
  supabase: ReturnType<typeof createClient>,
  keys: KeySet,
  state: KeyState,
  pair: string,
  tf: { label: string; td: string },
  outputSize: number,
  emit?: ProgressEmitter,
  source: string = "manual",
): Promise<{ candles: Candle[]; usedApi: number; usedKey: KeyIdx; cached: boolean }> {
  const keyIdx: KeyIdx = state.active;
  const { data: cached } = await supabase
    .from("candle_cache").select("candles, fetched_at")
    .eq("pair", pair).eq("timeframe", tf.label).maybeSingle();
  const ttlMin = CACHE_TTL_MIN_BY_TF[tf.label] ?? DEFAULT_CACHE_TTL_MIN;
  if (cached) {
    const ageMin = (Date.now() - new Date(cached.fetched_at as string).getTime()) / 60000;
    if (ageMin < ttlMin) {
      emit?.({ type: "progress", pair, timeframe: tf.label, status: "cached", message: `Cached (${ageMin.toFixed(1)}m / ${ttlMin}m TTL)` });
      return { candles: cached.candles as Candle[], usedApi: 0, usedKey: keyIdx, cached: true };
    }
  }
  emit?.({ type: "progress", pair, timeframe: tf.label, status: "fetching", message: `Fetching fresh (TTL ${ttlMin}m, key #${state.active})` });

  // No retries within a single execution. On 429, mark key exhausted, rotate, and skip pair.
  const fetchKey: KeyIdx = state.active;
  const primaryKey = keys[fetchKey] ?? keys[state.configured[0]!] ?? "";
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(pair)}&interval=${tf.td}&outputsize=${outputSize}&apikey=${primaryKey}`;
  const r = await throttledTwelveDataFetch(url, emit, { pair, timeframe: tf.label });
  let usedApi = 1;

  if (r.status === 429) {
    // Mark current key as exhausted for this cycle and rotate to next available.
    state.exhausted.add(fetchKey);
    const nxt = nextAvailableKey(state);
    if (nxt && nxt !== fetchKey) {
      state.active = nxt;
      emit?.({ type: "progress", pair, timeframe: tf.label, status: "rate_limited", message: `Key ${fetchKey} 429 — rotating to Key ${nxt}` });
    } else {
      emit?.({ type: "progress", pair, timeframe: tf.label, status: "rate_limited", message: `Key ${fetchKey} 429 — no other keys available` });
    }
    const msg = `TwelveData 429 — using stale cache for ${pair}`;
    console.log(msg);
    if (cached) {
      // The HTTP request was sent (and counted by TwelveData), so count it locally too.
      return { candles: cached.candles as Candle[], usedApi: 1, usedKey: fetchKey, cached: true };
    }
    // No cache available — skip this pair this cycle. Still counts as an API call.
    const err = new Error(`429 no cache: ${pair}`);
    (err as any).usedApi = 1;
    (err as any).usedKey = fetchKey;
    throw err;
  }

  if (!r) {
    // No HTTP request was actually completed — do not count.
    const err = new Error(`Failed to fetch candles for ${pair} ${tf.label}`);
    (err as any).usedApi = 0;
    (err as any).usedKey = fetchKey;
    throw err;
  }
  const j = await r.json().catch(() => ({}));
  if (!j.values || !Array.isArray(j.values)) {
    console.error("TwelveData error", pair, tf.label, r.status, j);
    emit?.({ type: "progress", pair, timeframe: tf.label, status: "error", message: `Fetch failed (${r.status})` });
    // HTTP call was sent (non-429) — count it even though the body was unusable.
    const err = new Error(`Failed to fetch candles for ${pair} ${tf.label}`);
    (err as any).usedApi = 1;
    (err as any).usedKey = fetchKey;
    throw err;
  }
  let fresh: Candle[] = j.values.map((v: any) => ({
    t: new Date(v.datetime + "Z").getTime(),
    o: +v.open, h: +v.high, l: +v.low, c: +v.close,
    v: v.volume ? +v.volume : undefined,
  })).reverse();
  if (cached) {
    const prev = cached.candles as Candle[];
    const merged = [...prev];
    const seen = new Set(merged.map((x) => x.t));
    for (const f of fresh) {
      if (!seen.has(f.t)) merged.push(f);
      else {
        const idx = merged.findIndex((x) => x.t === f.t);
        if (idx >= 0) merged[idx] = f;
      }
    }
    merged.sort((a, b) => a.t - b.t);
    fresh = merged.slice(-200);
  }
  await supabase.from("candle_cache").upsert(
    { pair, timeframe: tf.label, candles: fresh, fetched_at: new Date().toISOString() },
    { onConflict: "pair,timeframe" },
  );
  emit?.({ type: "progress", pair, timeframe: tf.label, status: "done", message: `Fetched and cached (key #${state.active})` });
  return { candles: fresh, usedApi, usedKey: fetchKey, cached: false };
}

// ---------- Setups ----------
type RawSignal = {
  pair: string; timeframe: string; setup: string;
  direction: "Long" | "Short";
  entry: number; stop_loss: number; tp1: number; tp2: number;
  rr: number; atr: number; candle_time: string;
};

function emaPullback(pair: string, c5: Candle[], c15: Candle[]): RawSignal | null {
  if (c5.length < 30 || c15.length < 30) return null;
  const ema9 = ema(c5.map(x => x.c), 9), ema21 = ema(c5.map(x => x.c), 21);
  const e21_15 = ema(c15.map(x => x.c), 21), e50_15 = ema(c15.map(x => x.c), 50);
  const last = c5.at(-1)!, prev = c5.at(-2)!;
  const e9 = ema9.at(-1)!, e21v = ema21.at(-1)!;
  const trendUp = e21_15.at(-1)! > e50_15.at(-1)!;
  const trendDown = e21_15.at(-1)! < e50_15.at(-1)!;
  const a = atr(c5);
  if (a === 0 || Math.abs(e9 - e21v) / a > 0.3) return null;
  const touched = last.l <= Math.max(e9, e21v) && last.h >= Math.min(e9, e21v);
  const ct = new Date(last.t).toISOString();
  if (trendUp && touched && last.c > last.o && last.c > prev.h) {
    const entry = (e9 + e21v) / 2, sl = Math.min(e21v, last.l) - a * 0.3;
    const risk = entry - sl; if (risk <= 0) return null;
    return { pair, timeframe: "5m", setup: "EMA Pullback", direction: "Long",
      entry, stop_loss: sl, tp1: entry + risk * 1.5, tp2: entry + risk * 3, rr: 3, atr: a, candle_time: ct };
  }
  if (trendDown && touched && last.c < last.o && last.c < prev.l) {
    const entry = (e9 + e21v) / 2, sl = Math.max(e21v, last.h) + a * 0.3;
    const risk = sl - entry; if (risk <= 0) return null;
    return { pair, timeframe: "5m", setup: "EMA Pullback", direction: "Short",
      entry, stop_loss: sl, tp1: entry - risk * 1.5, tp2: entry - risk * 3, rr: 3, atr: a, candle_time: ct };
  }
  return null;
}

function bos(pair: string, c5: Candle[], c15: Candle[]): RawSignal | null {
  if (c5.length < 30 || c15.length < 20) return null;
  const e21 = ema(c15.map(x => x.c), 21).at(-1)!;
  const e50 = ema(c15.map(x => x.c), 50).at(-1)!;
  const a = atr(c5); if (a === 0) return null;
  // Structure levels from last 20 closed 15m candles (~5h), excluding the current forming bar.
  const structure = c15.slice(-21, -1); if (structure.length < 20) return null;
  const sh = Math.max(...structure.map(x => x.h)), sl = Math.min(...structure.map(x => x.l));
  const recent = c5.slice(-3), last = c5.at(-1)!;
  const ct = new Date(last.t).toISOString();
  if (e21 > e50 && recent.some(x => x.c > sh)) {
    if (!(last.l <= sh + a * 0.2 && last.c > sh)) return null;
    const entry = sh, slp = sh - a * 0.8, risk = entry - slp;
    if (risk <= 0) return null;
    return { pair, timeframe: "5m", setup: "BOS Retest", direction: "Long",
      entry, stop_loss: slp, tp1: entry + risk * 1.5, tp2: entry + risk * 3, rr: 3, atr: a, candle_time: ct };
  }
  if (e21 < e50 && recent.some(x => x.c < sl)) {
    if (!(last.h >= sl - a * 0.2 && last.c < sl)) return null;
    const entry = sl, slp = sl + a * 0.8, risk = slp - entry;
    if (risk <= 0) return null;
    return { pair, timeframe: "5m", setup: "BOS Retest", direction: "Short",
      entry, stop_loss: slp, tp1: entry - risk * 1.5, tp2: entry - risk * 3, rr: 3, atr: a, candle_time: ct };
  }
  return null;
}

function sessionRangeBreak(pair: string, c5: Candle[]): RawSignal | null {
  if (c5.length < 30) return null;
  const a = atr(c5); if (a === 0) return null;
  const now = new Date(), hUTC = now.getUTCHours();
  // 30-minute session range windows: London 07:00–07:30 UTC, NY 13:30–14:00 UTC.
  let rStartMin: number | null = null;
  if (hUTC >= 8 && hUTC < 11) rStartMin = 7 * 60;            // London: 07:00–07:30
  else if (hUTC >= 14 && hUTC < 17) rStartMin = 13 * 60 + 30; // NY: 13:30–14:00
  if (rStartMin === null) return null;
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const rStart = today.getTime() + rStartMin * 60_000, rEnd = rStart + 30 * 60_000;
  const range = c5.filter(x => x.t >= rStart && x.t < rEnd);
  if (range.length < 4) return null;
  const rh = Math.max(...range.map(x => x.h)), rl = Math.min(...range.map(x => x.l));
  if (rh - rl > a * 3) return null;
  const after = c5.filter(x => x.t >= rEnd); if (!after.length) return null;
  const last = after.at(-1)!;
  const ct = new Date(last.t).toISOString();
  if (Math.abs(last.c - last.o) < a * 0.6) return null;
  if (last.c > rh) {
    const entry = rh, sl = rl, risk = entry - sl;
    if (risk <= 0 || risk > a * 4) return null;
    return { pair, timeframe: "5m", setup: "Session Range Break", direction: "Long",
      entry, stop_loss: sl, tp1: entry + risk * 1.5, tp2: entry + risk * 2.5, rr: 2.5, atr: a, candle_time: ct };
  }
  if (last.c < rl) {
    const entry = rl, sl = rh, risk = sl - entry;
    if (risk <= 0 || risk > a * 4) return null;
    return { pair, timeframe: "5m", setup: "Session Range Break", direction: "Short",
      entry, stop_loss: sl, tp1: entry - risk * 1.5, tp2: entry - risk * 2.5, rr: 2.5, atr: a, candle_time: ct };
  }
  return null;
}

function smcOrderBlock(pair: string, c5: Candle[], c15: Candle[]): RawSignal | null {
  if (c5.length < 40) return null;
  const a = atr(c5); if (a === 0) return null;
  const e21_15 = ema(c15.map(x => x.c), 21).at(-1)!;
  const e50_15 = ema(c15.map(x => x.c), 50).at(-1)!;
  const last = c5.at(-1)!;
  const ct = new Date(last.t).toISOString();
  for (let i = c5.length - 4; i >= c5.length - 20 && i >= 3; i--) {
    const seq = c5.slice(i - 2, i + 1);
    const bullSeq = seq.every(x => x.c > x.o && (x.c - x.o) > a * 0.5);
    const bearSeq = seq.every(x => x.c < x.o && (x.o - x.c) > a * 0.5);
    if (!bullSeq && !bearSeq) continue;
    let obIdx = i - 3;
    while (obIdx >= 0 && ((bullSeq && c5[obIdx].c > c5[obIdx].o) || (bearSeq && c5[obIdx].c < c5[obIdx].o))) obIdx--;
    if (obIdx < 0) continue;
    const ob = c5[obIdx];
    const fvgBull = bullSeq && obIdx + 3 < c5.length && c5[obIdx + 1].h < c5[obIdx + 3].l;
    const fvgBear = bearSeq && obIdx + 3 < c5.length && c5[obIdx + 1].l > c5[obIdx + 3].h;
    if (bullSeq && e21_15 > e50_15 && last.l <= ob.h && last.l >= ob.l && last.c > last.o) {
      const entry = ob.h, sl = ob.l - a * 0.3, risk = entry - sl;
      if (risk <= 0) return null;
      return { pair, timeframe: "5m", setup: fvgBull ? "OB+FVG" : "Order Block", direction: "Long",
        entry, stop_loss: sl, tp1: entry + risk * 1.5, tp2: entry + risk * 3, rr: 3, atr: a, candle_time: ct };
    }
    if (bearSeq && e21_15 < e50_15 && last.h >= ob.l && last.h <= ob.h && last.c < last.o) {
      const entry = ob.l, sl = ob.h + a * 0.3, risk = sl - entry;
      if (risk <= 0) return null;
      return { pair, timeframe: "5m", setup: fvgBear ? "OB+FVG" : "Order Block", direction: "Short",
        entry, stop_loss: sl, tp1: entry - risk * 1.5, tp2: entry - risk * 3, rr: 3, atr: a, candle_time: ct };
    }
  }
  return null;
}

function choch(pair: string, c5: Candle[]): RawSignal | null {
  if (c5.length < 30) return null;
  const a = atr(c5); if (a === 0) return null;
  const window = c5.slice(-25);
  const highs: { i: number; v: number }[] = [], lows: { i: number; v: number }[] = [];
  for (let i = 2; i < window.length - 2; i++) {
    if (window[i].h > window[i - 1].h && window[i].h > window[i - 2].h && window[i].h > window[i + 1].h && window[i].h > window[i + 2].h)
      highs.push({ i, v: window[i].h });
    if (window[i].l < window[i - 1].l && window[i].l < window[i - 2].l && window[i].l < window[i + 1].l && window[i].l < window[i + 2].l)
      lows.push({ i, v: window[i].l });
  }
  if (highs.length < 2 || lows.length < 2) return null;
  const last = window.at(-1)!;
  const ct = new Date(last.t).toISOString();
  const lh1 = highs.at(-1)!, lh2 = highs.at(-2)!;
  const ll1 = lows.at(-1)!, ll2 = lows.at(-2)!;
  const sweptLow = window.some((x, i) => i > ll1.i && x.l < ll1.v);
  const brokeHigh = last.c > lh1.v;
  if (lh1.v < lh2.v && ll1.v < ll2.v && sweptLow && brokeHigh) {
    const entry = lh1.v, sl = Math.min(...window.slice(ll1.i).map(x => x.l)) - a * 0.2;
    const risk = entry - sl; if (risk <= 0) return null;
    return { pair, timeframe: "5m", setup: "CHOCH", direction: "Long",
      entry, stop_loss: sl, tp1: entry + risk * 1.5, tp2: entry + risk * 3, rr: 3, atr: a, candle_time: ct };
  }
  const sweptHigh = window.some((x, i) => i > lh1.i && x.h > lh1.v);
  const brokeLow = last.c < ll1.v;
  if (lh1.v > lh2.v && ll1.v > ll2.v && sweptHigh && brokeLow) {
    const entry = ll1.v, sl = Math.max(...window.slice(lh1.i).map(x => x.h)) + a * 0.2;
    const risk = sl - entry; if (risk <= 0) return null;
    return { pair, timeframe: "5m", setup: "CHOCH", direction: "Short",
      entry, stop_loss: sl, tp1: entry - risk * 1.5, tp2: entry - risk * 3, rr: 3, atr: a, candle_time: ct };
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════
// V.E.R.I.T.A.S. — Volatility-Encoded Regime-Adaptive Trading
// ═══════════════════════════════════════════════════════════════

function veritasEMA(arr: number[], period: number): number[] {
  if (arr.length === 0) return [];
  const k = 2 / (period + 1);
  const result = [arr[0]];
  for (let i = 1; i < arr.length; i++) {
    result.push(arr[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

function calcHurst(closes: number[]): number {
  const prices = closes.slice(-100);
  if (prices.length < 20) return 0.5;
  const logReturns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    const lr = Math.log(prices[i] / prices[i - 1]);
    if (!isFinite(lr)) continue;
    logReturns.push(lr);
  }
  if (logReturns.length < 15) return 0.5;
  const mean = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
  let cumSum = 0;
  const profile = logReturns.map((r) => { cumSum += r - mean; return cumSum; });
  const windowSizes: number[] = [];
  const fluctuations: number[] = [];
  for (let w = 10; w <= Math.min(50, Math.floor(profile.length / 2)); w += 5) {
    const nw = Math.floor(profile.length / w);
    if (nw < 2) continue;
    let totalRms = 0;
    let validWindows = 0;
    for (let i = 0; i < nw; i++) {
      const seg = profile.slice(i * w, (i + 1) * w);
      const n = seg.length;
      const xMean = (n - 1) / 2;
      const yMean = seg.reduce((a, b) => a + b, 0) / n;
      let num = 0; let den = 0;
      for (let j = 0; j < n; j++) {
        num += (j - xMean) * (seg[j] - yMean);
        den += (j - xMean) ** 2;
      }
      const slope = den !== 0 ? num / den : 0;
      const intercept = yMean - slope * xMean;
      const rms = Math.sqrt(seg.reduce((a, v, j) => a + (v - (slope * j + intercept)) ** 2, 0) / n);
      if (isFinite(rms) && rms > 0) { totalRms += rms; validWindows++; }
    }
    if (validWindows > 0) {
      windowSizes.push(Math.log(w));
      fluctuations.push(Math.log(totalRms / validWindows));
    }
  }
  if (windowSizes.length < 3) return 0.5;
  const n = windowSizes.length;
  const sx = windowSizes.reduce((a, b) => a + b, 0);
  const sy = fluctuations.reduce((a, b) => a + b, 0);
  const sxy = windowSizes.reduce((a, x, i) => a + x * fluctuations[i], 0);
  const sxx = windowSizes.reduce((a, x) => a + x * x, 0);
  const denom = n * sxx - sx * sx;
  if (denom === 0) return 0.5;
  const hurst = (n * sxy - sx * sy) / denom;
  return Math.max(0.1, Math.min(0.9, hurst));
}

function calcTSI(closes: number[], longP = 25, shortP = 13, sigP = 13): {
  tsi: number; signal: number; prev: number;
} {
  if (closes.length < longP + shortP + sigP) return { tsi: 0, signal: 0, prev: 0 };
  const pc = closes.map((c, i) => i === 0 ? 0 : c - closes[i - 1]);
  const apc = pc.map(Math.abs);
  const ps1 = veritasEMA(pc, longP);
  const ps2 = veritasEMA(ps1, shortP);
  const ap1 = veritasEMA(apc, longP);
  const ap2 = veritasEMA(ap1, shortP);
  const tsiArr = ps2.map((v, i) => ap2[i] !== 0 ? 100 * v / ap2[i] : 0);
  const sigArr = veritasEMA(tsiArr, sigP);
  const last = tsiArr.length - 1;
  return {
    tsi: tsiArr[last] ?? 0,
    signal: sigArr[last] ?? 0,
    prev: tsiArr[last - 1] ?? 0,
  };
}

function calcSNR(closes: number[], fastP = 20, slowP = 50, volP = 20): number {
  if (closes.length < slowP + 5) return 0;
  const fastEma = veritasEMA(closes, fastP);
  const slowEma = veritasEMA(closes, slowP);
  const last = closes.length - 1;
  const signal = fastEma[last] - slowEma[last];
  const recent = closes.slice(-volP);
  const changes = recent.map((c, i) => i === 0 ? 0 : c - recent[i - 1]);
  const mean = changes.reduce((a, b) => a + b, 0) / changes.length;
  const variance = changes.reduce((a, c) => a + (c - mean) ** 2, 0) / changes.length;
  const noise = Math.sqrt(variance) + 1e-10;
  const snr = Math.abs(signal) / noise;
  return Math.min(100, 100 * (1 - Math.exp(-snr * 2)));
}

function calcVPT(candles: Candle[]): { vptRoc: number; bullish: boolean } {
  if (candles.length < 15) return { vptRoc: 0, bullish: false };
  let vpt = 0;
  const vptArr: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const prev = Number(candles[i - 1].c);
    const curr = Number(candles[i].c);
    // Prefer real volume when present; fall back to bar range as a proxy.
    const v = candles[i].v;
    const vol = (v != null && isFinite(Number(v)) && Number(v) > 0)
      ? Number(v)
      : Math.max(0, Number(candles[i].h) - Number(candles[i].l));
    const pctChange = prev !== 0 ? (curr - prev) / prev : 0;
    vpt += vol * pctChange;
    vptArr.push(vpt);
  }
  if (vptArr.length < 11) return { vptRoc: 0, bullish: false };
  const current = vptArr[vptArr.length - 1];
  const tenAgo = vptArr[vptArr.length - 11];
  const vptRoc = tenAgo !== 0 ? ((current - tenAgo) / Math.abs(tenAgo)) * 100 : 0;
  return { vptRoc, bullish: vptRoc > 0 };
}

function calcATR14(candles: Candle[]): number {
  const period = 14;
  if (candles.length < period + 1) return 0;
  const slice = candles.slice(-(period + 1));
  let atrSum = 0;
  for (let i = 1; i < slice.length; i++) {
    const h = Number(slice[i].h);
    const l = Number(slice[i].l);
    const pc = Number(slice[i - 1].c);
    atrSum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  return atrSum / period;
}

function veritasSetup(
  pair: string,
  c5: Candle[],
  c15: Candle[],
  c1m: Candle[] | null,
  ss: number,
): Signal | null {

  // ── Instrument guard ─────────────────────────────────────────
  if (!VERITAS_PAIRS.has(pair)) return null;
  if (c5.length < 65 || c15.length < 110) return null;

  const closes5  = c5.map((x) => Number(x.c));
  const closes15 = c15.map((x) => Number(x.c));

  // ── PILLAR I: Hurst Regime (15M, 100-bar) ────────────────────
  const hurst = calcHurst(closes15);
  const isTrending      = hurst > 0.55;
  const isMeanReverting = hurst < 0.45;
  if (!isTrending && !isMeanReverting) return null;

  const hRegime  = hurst > 0.60 || hurst < 0.40 ? "strong" : "moderate";
  const regScore = hRegime === "strong" ? 25 : 20;

  // ── PILLAR II: HTF Bias (15M close vs 15-period EMA) ─────────
  const htfEMA15 = veritasEMA(closes15, 15);
  const htfEMA   = htfEMA15[htfEMA15.length - 1];
  const htfLast  = closes15[closes15.length - 1];
  const htfBull  = htfLast > htfEMA;
  const htfBear  = htfLast < htfEMA;
  if (!htfBull && !htfBear) return null;

  // ── PILLAR III: TSI Momentum (5M) ────────────────────────────
  const { tsi, signal: tsiSig, prev: tsiPrev } = calcTSI(closes5);
  let tsiScore  = 0;
  let tsiAligned = false;

  if (isTrending) {
    if      (htfBull && tsi > tsiSig && tsi > 0)  { tsiAligned = true; tsiScore = 25; }
    else if (htfBear && tsi < tsiSig && tsi < 0)  { tsiAligned = true; tsiScore = 25; }
    else if (htfBull && tsi > tsiSig)              { tsiAligned = true; tsiScore = 15; }
    else if (htfBear && tsi < tsiSig)              { tsiAligned = true; tsiScore = 15; }
  } else {
    if      (htfBull && tsi < -20 && tsi > tsiPrev) { tsiAligned = true; tsiScore = 25; }
    else if (htfBear && tsi >  20 && tsi < tsiPrev) { tsiAligned = true; tsiScore = 25; }
    else if (htfBull && tsi < -20)                   { tsiAligned = true; tsiScore = 15; }
    else if (htfBear && tsi >  20)                   { tsiAligned = true; tsiScore = 15; }
  }
  if (!tsiAligned) return null;

  // ── PILLAR IV: SNR Directional Conviction (5M) ───────────────
  const snr = calcSNR(closes5);
  if (snr < 40) return null;
  const snrScore = snr > 60 ? 20 : snr > 40 ? 15 : 0;

  // ── PILLAR V: VPT Volume Confirmation (5M) ───────────────────
  const { vptRoc } = calcVPT(c5);
  const isLong = htfBull;
  const vptConfirmed = isLong ? vptRoc > 0.5 : vptRoc < -0.5;
  if (!vptConfirmed) return null;
  const vptScore = Math.abs(vptRoc) > 2 ? 15 : 10;

  // ── PILLAR VI: Session & Timing Filter ───────────────────────
  const h         = new Date().getUTCHours();
  const isOverlap = h >= 13 && h < 17;
  const isLondon  = h >= 8  && h < 13;
  const isNY      = h >= 17 && h < 22;
  const isAsian   = h >= 0  && h < 7;
  let sessScore = 0;

  if (pair === "XAU/USD") {
    if (isOverlap || isLondon) sessScore = 15;
    else if (isNY)             sessScore = 10;
    else if (isAsian)          sessScore = 5;
  } else if (pair === "BTC/USD" || pair === "ETH/USD") {
    if (isOverlap)                         sessScore = 15;
    else if (isLondon || isNY || isAsian)  sessScore = 10;
  } else {
    if (isOverlap)             sessScore = 15;
    else if (isLondon || isNY) sessScore = 10;
    else return null;
  }
  if (sessScore === 0) return null;

  // ── Spread & ATR Range Guards ─────────────────────────────────
  const last5     = c5[c5.length - 1];
  const spread5m  = last5.h - last5.l;
  const maxSpread = VERITAS_MAX_SPREAD[pair] ?? Infinity;
  if (spread5m > maxSpread) return null;

  const atrVal             = calcATR14(c5);
  if (atrVal <= 0) return null;
  const ps                 = pipSize(pair);
  const [atrMin, atrMax]   = VERITAS_ATR_RANGE[pair] ?? [0, Infinity];
  const atrPips            = atrVal / ps;
  if (atrPips < atrMin || atrPips > atrMax) return null;

  // ── 1-Minute Micro-Confirmation ───────────────────────────────
  if (!c1m || c1m.length < 10) return null;
  const closes1m  = c1m.map((x) => Number(x.c));
  const ema5_1m   = veritasEMA(closes1m, 5);
  const last1m    = c1m[c1m.length - 1];
  const prev1m    = c1m[c1m.length - 2];
  const ema5last  = ema5_1m[ema5_1m.length - 1];
  const ema5prev  = ema5_1m[ema5_1m.length - 2];

  const crossedAbove = Number(prev1m.c) <= ema5prev && Number(last1m.c) > ema5last;
  const crossedBelow = Number(prev1m.c) >= ema5prev && Number(last1m.c) < ema5last;
  const within2Pips  = Math.abs(Number(last1m.c) - Number(last5.c)) <= 2 * ps;

  if (isLong  && (!crossedAbove || !within2Pips)) return null;
  if (!isLong && (!crossedBelow || !within2Pips)) return null;

  // ── Confluence Score ──────────────────────────────────────────
  const confidence = regScore + snrScore + tsiScore + vptScore + sessScore;
  if (confidence < 72) return null;

  const signalGrade = confidence >= 80 ? "STRONG" : "MODERATE";

  // ── Entry / SL / TP (ATR-based) ───────────────────────────────
  const entry   = Number(last1m.c);
  const slDist  = 1.5 * atrVal;
  const tp2Dist = 2.5 * atrVal;
  const tp1Dist = tp2Dist * 0.4;
  const sl      = isLong ? entry - slDist  : entry + slDist;
  const tp1     = isLong ? entry + tp1Dist : entry - tp1Dist;
  const tp2     = isLong ? entry + tp2Dist : entry - tp2Dist;
  const rr      = +(tp2Dist / slDist).toFixed(2);

  const regimeLabel = isTrending ? "Trend" : "MeanRev";
  const snrLabel    = snr > 60 ? "SNR++" : "SNR+";
  const candleTime  = new Date(last5.t).toISOString();
  const direction: "Long" | "Short" = isLong ? "Long" : "Short";

  return {
    pair,
    timeframe:     "5m",
    setup:         `VERITAS (${signalGrade} H=${hurst.toFixed(2)} ${regimeLabel} ${snrLabel})`,
    direction,
    entry:         +entry.toFixed(5),
    stop_loss:     +sl.toFixed(5),
    tp1:           +tp1.toFixed(5),
    tp2:           +tp2.toFixed(5),
    rr,
    atr:           atrVal,
    candle_time:   candleTime,
    session_score: sessScore * 5,
    confidence,
    news_flag:     false,
    order_type:    isLong ? "Buy Market" : "Sell Market",
    spread_pips:   spreadDisplay(pair),
    htf_bias:      isLong ? "1H BULL" : "1H BEAR",
    mfi_score:     +snr.toFixed(1),
    mfi_divergence: false,
  };
}


// ═══════════════════════════════════════════════════════════════
// QUANTUM SCALPING SYSTEM (QSS) v1.0
// AVRD + LVIM + VWSA + DRAE
// ═══════════════════════════════════════════════════════════════
function qssATR(candles: Candle[], period = 14): number[] {
  const tr: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].h, l = candles[i].l, pc = candles[i - 1].c;
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const out: number[] = [];
  if (tr.length < period) return out;
  let sum = tr.slice(0, period).reduce((a, b) => a + b, 0);
  out.push(sum / period);
  for (let i = period; i < tr.length; i++) {
    out.push((out[out.length - 1] * (period - 1) + tr[i]) / period);
  }
  return out;
}

function qssPercentile(arr: number[], pct: number): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const idx = (pct / 100) * (s.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

type QSSRegime = "COMPRESSION" | "EXPANSION_BULL" | "EXPANSION_BEAR" | "TRANSITION";

function qssAVRD(c5: Candle[], cHtf: Candle[]): QSSRegime {
  const atr5 = qssATR(c5, 14);
  const atrHtf = qssATR(cHtf, 14);
  if (atr5.length < 3 || atrHtf.length < 10) return "TRANSITION";
  const currentAtr5 = atr5[atr5.length - 1];
  const p20 = qssPercentile(atrHtf, 20);
  const p60 = qssPercentile(atrHtf, 60);

  if (currentAtr5 < p20) {
    const last5 = c5.slice(-5);
    const last20 = c5.slice(-20);
    const maxRange5 = Math.max(...last5.map(c => c.h - c.l));
    const avgRange20 = last20.reduce((a, c) => a + (c.h - c.l), 0) / last20.length;
    if (maxRange5 < 1.2 * avgRange20) return "COMPRESSION";
  }

  if (currentAtr5 > p60) {
    const last5 = c5.slice(-5);
    const bullishCloses = last5.filter(c => c.c > c.o).length;
    const vwapSlice = c5.slice(-20);
    const totalVol = vwapSlice.reduce((a, c) => a + (c.v ?? (c.h - c.l)), 0);
    const vwap = vwapSlice.reduce((a, c) => {
      const tp = (c.h + c.l + c.c) / 3;
      const vol = c.v ?? (c.h - c.l);
      return a + tp * vol;
    }, 0) / (totalVol || 1);
    const lastClose = c5[c5.length - 1].c;
    if (bullishCloses >= 3 && lastClose > vwap) return "EXPANSION_BULL";
    if (bullishCloses <= 2 && lastClose < vwap) return "EXPANSION_BEAR";
  }

  return "TRANSITION";
}

interface QSSLiquidityVoid {
  top: number; bottom: number; ce: number; width: number;
  isLong: boolean; consolidationBars: number;
  displacementVolRatio: number; hasWickOverlap: boolean;
  avgConsolidationVol: number; displacementVol: number;
}

function qssLVIM(c5: Candle[], isCrypto: boolean): QSSLiquidityVoid | null {
  const minConsolBars = isCrypto ? 6 : 8;
  const minDisplBars = isCrypto ? 2 : 3;
  const n = c5.length;
  if (n < minConsolBars + minDisplBars + 5) return null;

  for (let startIdx = Math.max(0, n - 40); startIdx < n - minConsolBars - minDisplBars; startIdx++) {
    for (let consolLen = minConsolBars; consolLen <= minConsolBars + 6; consolLen++) {
      if (startIdx + consolLen + minDisplBars >= n) break;
      const consolSlice = c5.slice(startIdx, startIdx + consolLen);
      const consolRanges = consolSlice.map(c => c.h - c.l);
      const avgConsolRange = consolRanges.reduce((a, b) => a + b, 0) / consolRanges.length;
      const avgConsolVol = consolSlice.reduce((a, c) => a + (c.v ?? (c.h - c.l)), 0) / consolSlice.length;
      const isValidConsol = consolRanges.every(r => r < 1.5 * avgConsolRange);
      const consolHigh = Math.max(...consolSlice.map(c => c.h));
      const consolLow = Math.min(...consolSlice.map(c => c.l));
      const consolWidth = consolHigh - consolLow;
      const atrEst = avgConsolRange;
      if (!isValidConsol || consolWidth > 2.5 * atrEst * consolLen) continue;

      for (let displLen = minDisplBars; displLen <= minDisplBars + 2; displLen++) {
        const displStart = startIdx + consolLen;
        if (displStart + displLen > n) break;
        const displSlice = c5.slice(displStart, displStart + displLen);
        const displVol = displSlice.reduce((a, c) => a + (c.v ?? (c.h - c.l)), 0);
        const strongBars = displSlice.filter(c => {
          const body = Math.abs(c.c - c.o);
          const range = c.h - c.l;
          return range > 0 && body / range >= 0.7;
        }).length;
        const displHigh = Math.max(...displSlice.map(c => c.h));
        const displLow = Math.min(...displSlice.map(c => c.l));
        const displMove = displHigh - displLow;
        const volRatio = avgConsolVol > 0 ? displVol / (avgConsolVol * displLen) : 0;

        if (strongBars < Math.ceil(displLen * 0.67)) continue;
        if (displMove < 1.8 * consolWidth) continue;

        const lastDisplClose = displSlice[displSlice.length - 1].c;
        const bullishDispl = lastDisplClose > consolHigh;
        const bearishDispl = lastDisplClose < consolLow;
        if (!bullishDispl && !bearishDispl) continue;

        const isLong = bullishDispl;
        // For both long and short: void spans from min(highs) [lower] to max(lows) [upper]
        const voidLower = Math.min(...displSlice.map(c => c.h)); // lower boundary of void
        const voidUpper = Math.max(...displSlice.map(c => c.l)); // upper boundary of void
        if (voidUpper <= voidLower) continue; // no gap exists — skip

        const voidHigh = voidUpper; // upper boundary (always max of lows)
        const voidLow = voidLower;  // lower boundary (always min of highs)
        const voidWidth = Math.abs(voidHigh - voidLow);
        if (voidWidth <= 0) continue;
        const ce = (voidHigh + voidLow) / 2;

        let hasWickOverlap = false;
        for (let i = 1; i < displSlice.length; i++) {
          const prevLow = displSlice[i - 1].l;
          const prevHigh = displSlice[i - 1].h;
          const currLow = displSlice[i].l;
          const currHigh = displSlice[i].h;
          if (isLong && currLow <= prevHigh) { hasWickOverlap = true; break; }
          if (!isLong && currHigh >= prevLow) { hasWickOverlap = true; break; }
        }

        const currentPrice = c5[n - 1].c;
        // For long: price retraces DOWN into void — must be in top 30% (near upper boundary)
        // For short: price retraces UP into void — must be in bottom 30% (near lower boundary)
        const voidEntry30pct = isLong
          ? voidHigh - 0.3 * voidWidth  // top 30%: from (voidHigh - 0.3*width) to voidHigh
          : voidLow + 0.3 * voidWidth;  // bottom 30%: from voidLow to (voidLow + 0.3*width)
        const priceInVoid = isLong
          ? (currentPrice <= voidHigh && currentPrice >= voidEntry30pct)
          : (currentPrice >= voidLow && currentPrice <= voidEntry30pct);
        const ceNotBreached = isLong ? currentPrice >= ce : currentPrice <= ce;
        if (!priceInVoid || !ceNotBreached) continue;

        const confCandle = c5[n - 1];
        const confBody = confCandle.c - confCandle.o;
        const confRange = confCandle.h - confCandle.l;
        const confVol = confCandle.v ?? confRange;
        const isBullishConf = isLong && (confBody > 0 && confBody / confRange >= 0.6);
        const isBearishConf = !isLong && (confBody < 0 && Math.abs(confBody) / confRange >= 0.6);
        if (!isBullishConf && !isBearishConf) continue;
        if (confVol > 0.8 * (displVol / displLen)) continue;

        return {
          top: voidHigh, bottom: voidLow, ce, width: voidWidth,
          isLong, consolidationBars: consolLen,
          displacementVolRatio: volRatio, hasWickOverlap,
          avgConsolidationVol: avgConsolVol, displacementVol: displVol,
        };
      }
    }
  }
  return null;
}

function qssVWSA(c5: Candle[], lv: QSSLiquidityVoid): number {
  let score = 0;
  const pocWindow = c5.slice(-30);
  const priceBuckets = new Map<number, number>();
  for (const c of pocWindow) {
    const tp = Math.round(((c.h + c.l + c.c) / 3) * 100) / 100;
    const vol = c.v ?? (c.h - c.l);
    priceBuckets.set(tp, (priceBuckets.get(tp) ?? 0) + vol);
  }
  let pocPrice = 0, pocVol = 0;
  for (const [price, vol] of priceBuckets) {
    if (vol > pocVol) { pocVol = vol; pocPrice = price; }
  }
  if (pocPrice >= lv.bottom && pocPrice <= lv.top) score += 25;

  const sorted = [...priceBuckets.entries()].sort((a, b) => a[0] - b[0]);
  const totalVol = sorted.reduce((a, [, v]) => a + v, 0);
  let cumVol = 0, valPrice = 0, vahPrice = 0;
  for (const [price, vol] of sorted) {
    cumVol += vol;
    if (cumVol / totalVol >= 0.15 && valPrice === 0) valPrice = price;
    if (cumVol / totalVol >= 0.85 && vahPrice === 0) vahPrice = price;
  }
  const ceAlignTolerance = lv.width * 0.1;
  if (Math.abs(lv.ce - valPrice) < ceAlignTolerance || Math.abs(lv.ce - vahPrice) < ceAlignTolerance) score += 20;

  if (lv.displacementVolRatio > 2.5) score += 15;
  else if (lv.displacementVolRatio > 1.5) score += 8;

  if (!lv.hasWickOverlap) score += 15;

  if (lv.consolidationBars >= 12) score += 10;
  else if (lv.consolidationBars >= 8) score += 5;

  return Math.min(100, score);
}

function qssSetup(
  pair: string, c5: Candle[], c15: Candle[], c1h: Candle[], sessionScoreVal: number
): Signal | null {
  const isCrypto = pair.includes("BTC") || pair.includes("ETH") || pair.includes("XRP");
  const sym = pair.toUpperCase();
  const cHtf = isCrypto ? c15 : c1h;
  if (c5.length < 50 || cHtf.length < 20) return null;

  const regime = qssAVRD(c5, cHtf);
  if (regime === "COMPRESSION" || regime === "TRANSITION") return null;

  const lv = qssLVIM(c5, isCrypto);
  if (!lv) return null;

  if (regime === "EXPANSION_BULL" && !lv.isLong) return null;
  if (regime === "EXPANSION_BEAR" && lv.isLong) return null;

  const htfHighs = cHtf.slice(-10).map(c => c.h);
  const htfLows = cHtf.slice(-10).map(c => c.l);
  const htfBull = htfHighs[htfHighs.length - 1] > htfHighs[0] && htfLows[htfLows.length - 1] > htfLows[0];
  const htfBear = htfHighs[htfHighs.length - 1] < htfHighs[0] && htfLows[htfLows.length - 1] < htfLows[0];
  const htfAligns = lv.isLong ? htfBull : htfBear;
  if (!htfAligns) return null;

  if (!isCrypto && sessionScoreVal < 65) return null;

  let vwsaScore = qssVWSA(c5, lv);
  if (htfAligns) vwsaScore += 15;
  vwsaScore = Math.min(100, vwsaScore);
  if (vwsaScore < 60) return null;

  const atr5arr = qssATR(c5, 14);
  const atr5 = atr5arr[atr5arr.length - 1] ?? 0;
  if (atr5 <= 0) return null;

  const entry = lv.ce;
  const regimeMult = 1.5;
  const slFromAtr = atr5 * regimeMult;
  const slFromVoid = lv.width * 1.2;
  const slDist = Math.min(Math.max(slFromAtr, slFromVoid), atr5 * 3.0);
  const sl = lv.isLong ? entry - slDist : entry + slDist;

  const rrTarget = vwsaScore >= 90 ? 2.5
    : vwsaScore >= 80 ? 2.25
    : vwsaScore >= 70 ? 2.0
    : 1.85;

  const tpDist = slDist * rrTarget;
  const tp1Dist = tpDist * 0.4;
  const tp1 = lv.isLong ? entry + tp1Dist : entry - tp1Dist;
  const tp2 = lv.isLong ? entry + tpDist : entry - tpDist;

  const lastC = c5[c5.length - 1];
  const spread = lastC.h - lastC.l;
  if (sym.includes("XAU") && spread > 0.35) return null;
  if (!isCrypto && !sym.includes("XAU") && spread > 0.0020) return null;

  const regimeScore = regime === "EXPANSION_BULL" || regime === "EXPANSION_BEAR" ? 30 : 15;
  const vwsaNorm = Math.round((vwsaScore / 100) * 40);
  const sessBonus = sessionScoreVal > 80 ? 10 : sessionScoreVal > 65 ? 5 : 0;
  const volBonus = lv.displacementVolRatio > 2.5 ? 10 : lv.displacementVolRatio > 1.5 ? 5 : 0;
  const confidence = Math.min(99, regimeScore + vwsaNorm + sessBonus + volBonus);

  if (confidence < 65 || rrTarget < 1.85) return null;

  const orderType = lv.isLong ? "Buy Limit" : "Sell Limit";
  const regimeLabel = regime === "EXPANSION_BULL" ? "ExpBull" : "ExpBear";
  const candleTime = new Date(c5[c5.length - 1].t).toISOString();

  return {
    pair,
    timeframe: "5m",
    setup: `QSS (${regimeLabel} VWSA=${vwsaScore})`,
    direction: lv.isLong ? "Long" : "Short",
    entry: +entry.toFixed(5),
    stop_loss: +sl.toFixed(5),
    tp1: +tp1.toFixed(5),
    tp2: +tp2.toFixed(5),
    rr: +rrTarget.toFixed(2),
    atr: atr5,
    candle_time: candleTime,
    session_score: sessionScoreVal,
    confidence,
    news_flag: false,
    order_type: orderType,
    spread_pips: spreadDisplay(pair),
    htf_bias: lv.isLong ? "1H BULL" : "1H BEAR",
    mfi_score: +vwsaScore.toFixed(0),
    mfi_divergence: false,
  };
}


// ═══════════════════════════════════════════════════════════════
// P.R.I.S.M. — Pressure, Regime, Imbalance, Structure, Momentum
// Unique ScalpEdge proprietary setup — not a known public system.
// Five-layer mechanical filter: regime must confirm, pressure zone
// must qualify, structure must align, momentum must be igniting NOW.
// Designed for: FX, Gold, Crypto | 5m entry | 1H macro bias
// ═══════════════════════════════════════════════════════════════

// DI+/DI- calculation (Directional Index, 14-period)
function calcDI(candles: Candle[], period = 14): { diPlus: number; diMinus: number; adx: number } {
  if (candles.length < period + 2) return { diPlus: 0, diMinus: 0, adx: 0 };
  const trArr: number[] = [];
  const dpArr: number[] = [];
  const dmArr: number[] = [];

  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].h, l = candles[i].l;
    const ph = candles[i - 1].h, pl = candles[i - 1].l, pc = candles[i - 1].c;
    trArr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    const upMove = h - ph;
    const downMove = pl - l;
    dpArr.push(upMove > downMove && upMove > 0 ? upMove : 0);
    dmArr.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  function wilderSmooth(arr: number[], p: number): number[] {
    if (arr.length < p) return [];
    let sum = arr.slice(0, p).reduce((a, b) => a + b, 0);
    const out = [sum];
    for (let i = p; i < arr.length; i++) {
      sum = sum - sum / p + arr[i];
      out.push(sum);
    }
    return out;
  }

  const sTR = wilderSmooth(trArr, period);
  const sDP = wilderSmooth(dpArr, period);
  const sDM = wilderSmooth(dmArr, period);
  if (!sTR.length) return { diPlus: 0, diMinus: 0, adx: 0 };

  const diPlusArr = sDP.map((v, i) => sTR[i] !== 0 ? 100 * v / sTR[i] : 0);
  const diMinusArr = sDM.map((v, i) => sTR[i] !== 0 ? 100 * v / sTR[i] : 0);
  const dxArr = diPlusArr.map((dp, i) => {
    const dm = diMinusArr[i];
    const sum = dp + dm;
    return sum !== 0 ? 100 * Math.abs(dp - dm) / sum : 0;
  });
  const adxArr = wilderSmooth(dxArr, period);
  const last = adxArr.length - 1;
  return {
    diPlus: diPlusArr[diPlusArr.length - 1] ?? 0,
    diMinus: diMinusArr[diMinusArr.length - 1] ?? 0,
    adx: adxArr[last] ?? 0,
  };
}

interface PressureZone {
  high: number;
  low: number;
  mid: number;
  width: number;
  bars: number;
  avgBodyRatio: number;
  wickCleanliness: number;
  direction: "bullish" | "bearish" | "mixed";
}

function findPressureZone(c5: Candle[]): PressureZone | null {
  const n = c5.length;
  if (n < 30) return null;
  const atrVal = calcATR14(c5);
  if (atrVal <= 0) return null;
  const maxRange = atrVal * 0.80;

  for (let endIdx = n - 4; endIdx >= 20; endIdx--) {
    for (let len = 6; len <= 14; len++) {
      const startIdx = endIdx - len + 1;
      if (startIdx < 2) break;
      const slice = c5.slice(startIdx, endIdx + 1);
      const allNarrow = slice.every(c => (c.h - c.l) <= maxRange);
      if (!allNarrow) break;

      const zoneHigh = Math.max(...slice.map(c => c.h));
      const zoneLow = Math.min(...slice.map(c => c.l));
      const zoneWidth = zoneHigh - zoneLow;

      if (zoneWidth > atrVal * 2.0 || zoneWidth < atrVal * 0.1) continue;

      const bodyRatios = slice.map(c => {
        const range = c.h - c.l;
        return range > 0 ? Math.abs(c.c - c.o) / range : 0;
      });
      const avgBodyRatio = bodyRatios.reduce((a, b) => a + b, 0) / bodyRatios.length;

      const bullBodies = slice.filter(c => c.c > c.o).length;
      const bearBodies = slice.filter(c => c.c < c.o).length;
      const direction: "bullish" | "bearish" | "mixed" =
        bullBodies > bearBodies * 1.5 ? "bullish" :
        bearBodies > bullBodies * 1.5 ? "bearish" : "mixed";

      const wickRatios = slice.map(c => {
        const body = Math.abs(c.c - c.o);
        const totalWick = (c.h - c.l) - body;
        return body > 0 ? 1 - Math.min(1, totalWick / body) : 0;
      });
      const wickCleanliness = wickRatios.reduce((a, b) => a + b, 0) / wickRatios.length;

      return { high: zoneHigh, low: zoneLow, mid: (zoneHigh + zoneLow) / 2, width: zoneWidth, bars: len, avgBodyRatio, wickCleanliness, direction };
    }
  }
  return null;
}

function calcPrismTSI(closes: number[]): { tsi: number; signal: number; crossedWithin3: boolean; accelerating: boolean } {
  const longP = 25, shortP = 13, sigP = 13;
  if (closes.length < longP + shortP + sigP + 3) {
    return { tsi: 0, signal: 0, crossedWithin3: false, accelerating: false };
  }

  const pc = closes.map((c, i) => i === 0 ? 0 : c - closes[i - 1]);
  const apc = pc.map(Math.abs);

  function emaSmooth(arr: number[], p: number): number[] {
    const k = 2 / (p + 1);
    const out = [arr[0]];
    for (let i = 1; i < arr.length; i++) out.push(arr[i] * k + out[i - 1] * (1 - k));
    return out;
  }

  const ps1 = emaSmooth(pc, longP);
  const ps2 = emaSmooth(ps1, shortP);
  const ap1 = emaSmooth(apc, longP);
  const ap2 = emaSmooth(ap1, shortP);

  const tsiArr = ps2.map((v, i) => ap2[i] !== 0 ? 100 * v / ap2[i] : 0);
  const sigArr = emaSmooth(tsiArr, sigP);

  const last = tsiArr.length - 1;
  const tsi = tsiArr[last], signal = sigArr[last];

  let crossedWithin3 = false;
  for (let i = Math.max(1, last - 2); i <= last; i++) {
    const prevAbove = tsiArr[i - 1] > sigArr[i - 1];
    const currAbove = tsiArr[i] > sigArr[i];
    if (prevAbove !== currAbove) { crossedWithin3 = true; break; }
  }

  const slope1 = tsiArr[last] - tsiArr[last - 1];
  const slope2 = tsiArr[last - 1] - tsiArr[last - 2];
  const accelerating = Math.abs(slope1) > Math.abs(slope2) && Math.sign(slope1) === Math.sign(slope2);

  return { tsi, signal, crossedWithin3, accelerating };
}

function prismStructureAligned(c1h: Candle[], c15: Candle[], isLong: boolean): { htfAligned: boolean; swingAligned: boolean } {
  const htfAligned = (() => {
    if (c1h.length < 55) return false;
    const closes = c1h.map(c => c.c);
    const e21 = veritasEMA(closes, 21);
    const e50 = veritasEMA(closes, 50);
    const last = closes[closes.length - 1];
    const e21v = e21[e21.length - 1], e50v = e50[e50.length - 1];
    return isLong ? (last > e21v && e21v > e50v) : (last < e21v && e21v < e50v);
  })();

  const swingAligned = (() => {
    if (c15.length < 20) return false;
    const win = c15.slice(-20);
    const highs: number[] = [], lows: number[] = [];
    for (let i = 2; i < win.length - 2; i++) {
      if (win[i].h > win[i-1].h && win[i].h > win[i+1].h) highs.push(win[i].h);
      if (win[i].l < win[i-1].l && win[i].l < win[i+1].l) lows.push(win[i].l);
    }
    if (highs.length < 2 || lows.length < 2) return false;
    const [h1, h2] = [highs[highs.length - 2], highs[highs.length - 1]];
    const [l1, l2] = [lows[lows.length - 2], lows[lows.length - 1]];
    return isLong ? (h2 > h1 && l2 > l1) : (h2 < h1 && l2 < l1);
  })();

  return { htfAligned, swingAligned };
}

function prismSetup(
  pair: string,
  c5: Candle[],
  c15: Candle[],
  c1h: Candle[],
  sessionScoreVal: number,
): Signal | null {
  if (c5.length < 60 || c15.length < 70 || c1h.length < 55) return null;
  const atr5m = calcATR14(c5);
  if (atr5m <= 0) return null;

  const { diPlus, diMinus } = calcDI(c5, 14);
  const diDiff = Math.abs(diPlus - diMinus);
  const diRatio = diDiff / (atr5m + 1e-10);
  if (diRatio < 0.15) return null;

  const regimeIsStrong = diRatio >= 0.35;
  const regimeIsModerate = diRatio >= 0.20;
  const isLong = diPlus > diMinus;
  const rcScore = diRatio >= 0.40 ? 30 : diRatio >= 0.30 ? 22 : diRatio >= 0.20 ? 14 : 0;

  const pz = findPressureZone(c5);
  if (!pz) return null;
  if (isLong && pz.direction === "bearish") return null;
  if (!isLong && pz.direction === "bullish") return null;

  const currentPrice = c5[c5.length - 1].c;
  const zoneBuffer = atr5m * 0.3;
  const priceInZone = currentPrice >= pz.low - zoneBuffer && currentPrice <= pz.high + zoneBuffer;
  if (!priceInZone) return null;

  const bodyScore = Math.min(10, Math.round(pz.avgBodyRatio * 10));
  const wickScore = Math.round(pz.wickCleanliness * 5);
  const tightnessScore = pz.width < atr5m * 0.5 ? 10 : pz.width < atr5m * 1.0 ? 7 : 4;
  const pzScore = bodyScore + wickScore + tightnessScore;

  if (pz.avgBodyRatio < 0.45) return null;

  const { htfAligned, swingAligned } = prismStructureAligned(c1h, c15, isLong);
  if (!htfAligned) return null;
  const saScore = (htfAligned ? 10 : 0) + (swingAligned ? 10 : 0);

  const closes5 = c5.map(c => Number(c.c));
  const { tsi, signal: tsiSig, crossedWithin3, accelerating } = calcPrismTSI(closes5);
  const tsiDirectionCorrect = isLong ? tsi > tsiSig : tsi < tsiSig;
  if (!tsiDirectionCorrect) return null;
  const mpScore = (crossedWithin3 ? 8 : 4) + (accelerating ? 7 : 3);

  const sgScore = sessionScoreVal >= 90 ? 10 : sessionScoreVal >= 80 ? 8 : sessionScoreVal >= 65 ? 5 : 2;
  const isCrypto = pair.includes("BTC") || pair.includes("ETH") || pair.includes("XRP");
  if (!isCrypto && sessionScoreVal < 65) return null;

  const confidence = Math.min(99, rcScore + pzScore + saScore + mpScore + sgScore);
  if (confidence < 72) return null;

  const entry = pz.mid;
  const slMult = regimeIsStrong ? 1.2 : regimeIsModerate ? 1.5 : 1.8;
  const slRaw = isLong ? entry - atr5m * slMult : entry + atr5m * slMult;
  const spread = spreadPrice(pair);
  const entryAdj = isLong ? entry + spread : entry - spread;
  const slAdj = isLong ? slRaw - spread : slRaw + spread;
  const risk = Math.abs(entryAdj - slAdj);
  if (risk <= 0) return null;

  const tp2Mult = pzScore >= 22 ? 3.0 : pzScore >= 18 ? 2.5 : 2.0;
  const tp1Adj = isLong ? entryAdj + atr5m * 1.0 : entryAdj - atr5m * 1.0;
  const tp2Adj = isLong ? entryAdj + atr5m * tp2Mult : entryAdj - atr5m * tp2Mult;
  const rrActual = Math.abs(tp2Adj - entryAdj) / risk;
  if (rrActual < 1.8) return null;

  const brokerMinSL = isGold(pair) ? 1.5 : isBTC(pair) ? 150 : isCryptoAlt(pair) ? 0.05 : 0.0005;
  if (risk < brokerMinSL) return null;

  const regimeLabel = regimeIsStrong ? "STR" : "MOD";
  const pzLabel = pzScore >= 22 ? "PZ++" : pzScore >= 18 ? "PZ+" : "PZ~";
  const candleTime = new Date(c5[c5.length - 1].t).toISOString();
  const direction: "Long" | "Short" = isLong ? "Long" : "Short";

  return {
    pair,
    timeframe: "5m",
    setup: `PRISM (${regimeLabel} DI=${diRatio.toFixed(2)} ${pzLabel})`,
    direction,
    entry: +entryAdj.toFixed(5),
    stop_loss: +slAdj.toFixed(5),
    tp1: +tp1Adj.toFixed(5),
    tp2: +tp2Adj.toFixed(5),
    rr: +rrActual.toFixed(2),
    atr: atr5m,
    candle_time: candleTime,
    session_score: sessionScoreVal,
    confidence,
    news_flag: false,
    order_type: isLong ? "Buy Limit" : "Sell Limit",
    spread_pips: spreadDisplay(pair),
    htf_bias: isLong ? "1H BULL" : "1H BEAR",
    mfi_score: +(diRatio * 100).toFixed(1),
    mfi_divergence: swingAligned,
  };
}



function mfiBoost(c5: Candle[], dir: "Long" | "Short"): { value: number; div: boolean; boost: number } {
  const m = mfi(c5);
  const v = m.value;
  let div = false;
  if (m.series.length >= 10) {
    const ps = c5.slice(-10).map(x => x.c);
    const ms = m.series.slice(-10);
    const pStart = ps[0], pEnd = ps.at(-1)!;
    const mStart = ms[0], mEnd = ms.at(-1)!;
    if (dir === "Long" && pEnd < pStart && mEnd > mStart) div = true;
    if (dir === "Short" && pEnd > pStart && mEnd < mStart) div = true;
  }
  let boost = 0;
  if (dir === "Long") {
    if (v < 30) boost += 8; else if (v < 50) boost += 4;
    if (v > 80) boost -= 6;
  } else {
    if (v > 70) boost += 8; else if (v > 50) boost += 4;
    if (v < 20) boost -= 6;
  }
  if (div) boost += 7;
  return { value: +v.toFixed(1), div, boost };
}

// Stop vs Limit rule (using spread-adjusted entry):
// - If entry is BEYOND current price in the trade's direction (price must move
//   further to trigger), it's a STOP order.
// - If price has already PASSED the entry level, it's a LIMIT order
//   (we wait for retrace back to entry).
function orderTypeFor(dir: "Long" | "Short", entry: number, currentPrice: number, atrVal: number): string {
  // tiny tolerance so a near-zero gap doesn't flip the label
  const tol = atrVal * 0.05;
  if (dir === "Long") {
    if (entry > currentPrice + tol) return "Buy Stop";   // price needs to rise to entry
    if (entry < currentPrice - tol) return "Buy Limit";  // price already above entry, wait retrace
    return "Buy Market";
  }
  if (entry < currentPrice - tol) return "Sell Stop";    // price needs to fall to entry
  if (entry > currentPrice + tol) return "Sell Limit";   // price already below entry, wait retrace
  return "Sell Market";
}

type Signal = RawSignal & {
  session_score: number; confidence: number; news_flag: boolean;
  order_type: string; spread_pips: number;
  htf_bias: string; mfi_score: number; mfi_divergence: boolean;
};

function qualifyAndScore(
  raw: RawSignal, c5: Candle[], bias: "bull" | "bear" | "neutral", currentPrice: number,
): { signal: Signal | null; reason?: string } {
  const pair = raw.pair, ps = pipSize(pair), a = raw.atr;
  const atrPips = a / ps;
  const minAtrPips = isGold(pair) ? 80 : isBTC(pair) ? 20 : isCryptoAlt(pair) ? 50 : 4;
  if (atrPips < minAtrPips) return { signal: null, reason: `ATR too flat (${atrPips.toFixed(1)})` };

  if (bias === "bull" && raw.direction === "Short") return { signal: null, reason: "Against 1H bias (1H bull)" };
  if (bias === "bear" && raw.direction === "Long") return { signal: null, reason: "Against 1H bias (1H bear)" };

  const spread = spreadPrice(pair);
  const sDisp = spreadDisplay(pair);
  let entry = raw.entry, sl = raw.stop_loss, tp1 = raw.tp1, tp2 = raw.tp2;
  if (raw.direction === "Long") {
    entry += spread; sl -= spread; tp1 += spread; tp2 += spread;
  } else {
    entry -= spread; sl += spread; tp1 -= spread; tp2 -= spread;
  }
  const risk = Math.abs(entry - sl);
  if (risk <= 0) return { signal: null, reason: "Risk collapsed after spread" };
  const rr = Math.abs(tp2 - entry) / risk;
  if (rr < 1.2) return { signal: null, reason: `R:R too low after spread (${rr.toFixed(2)})` };

  // Broker minimum stop distance floor (RoboForex MT4 stop levels with safety buffer).
  const brokerMinSL = isGold(pair) ? 1.5
    : isBTC(pair) ? 150
    : isCryptoAlt(pair) ? 0.05
    : 0.0005;
  if (risk < brokerMinSL) return { signal: null, reason: `SL too tight for broker (${risk.toFixed(5)} < min ${brokerMinSL})` };

  const now = new Date();
  const ss = sessionScore(pair, now);
  const news = newsFlag(now, pair);
  const mb = mfiBoost(c5, raw.direction);
  let conf = 50 + Math.floor(ss / 3) + Math.floor(rr * 4) + mb.boost;
  if (news) conf -= 15;
  if (bias !== "neutral") conf += 5;
  conf = Math.max(0, Math.min(99, conf));
  if (conf < 55) return { signal: null, reason: `Confidence too low (${conf})` };

  return {
    signal: {
      ...raw, entry, stop_loss: sl, tp1, tp2, rr: +rr.toFixed(2),
      session_score: ss, confidence: conf, news_flag: news,
      order_type: orderTypeFor(raw.direction, entry, currentPrice, a),
      spread_pips: sDisp, htf_bias: bias, mfi_score: mb.value, mfi_divergence: mb.div,
    },
  };
}

function formatDistance(pair: string, entry: number, level: number, isAbove: boolean): string {
  const raw = Math.abs(level - entry);
  const sym = pair.toUpperCase();
  let display: string;
  if (sym.includes("XAU") || sym.includes("XAG")) {
    display = `${raw.toFixed(2)}pts`;
  } else if (sym.includes("BTC") || sym.includes("ETH")) {
    display = `${raw.toFixed(1)}`;
  } else if (sym.includes("JPY")) {
    display = `${(raw * 100).toFixed(1)}pips`;
  } else {
    display = `${(raw * 10000).toFixed(1)}pips`;
  }
  return `(${display})`;
}

function estimateLot(
  pair: string, entry: number, sl: number,
  balance: number, riskPct: number,
  minLot: number, maxLot: number,
  isLive: boolean, isCentLive: boolean
): string {
  if (!balance || balance <= 0) return "n/a";
  const sym = pair.toUpperCase();
  const isMetalOrCrypto = sym.includes("XAU") || sym.includes("XAG")
    || sym.includes("BTC") || sym.includes("ETH");
  const centMult = (isLive && isCentLive && !isMetalOrCrypto) ? 100 : 1;
  const pv = (sym.includes("XAU") || sym.includes("XAG") ? 1.0
    : isMetalOrCrypto ? 0.01
    : 0.10) * centMult;
  const slPts = Math.abs(entry - sl);
  if (slPts === 0) return `${minLot * 2}`;
  const halfRisk = (balance * (riskPct / 100)) / 2;
  let half = Math.round((halfRisk / (slPts * pv * 100)) * 100) / 100;
  half = Math.max(minLot, Math.min(maxLot / 2, half));
  return `~${(half * 2).toFixed(2)}`;
}

async function sendTelegramAlerts(signals: Signal[], cfg: any) {
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  const chatId = Deno.env.get("TELEGRAM_CHAT_ID");
  if (!token || !chatId || !signals.length) return;
  const balance = Number(cfg?.metaapi_last_balance ?? 0);
  const riskPct = Number(cfg?.metaapi_risk_per_trade_pct ?? 3);
  const minLot = Number(cfg?.metaapi_min_lot ?? 0.01);
  const maxLot = Number(cfg?.metaapi_max_lot ?? 1);
  const isLive = String(cfg?.metaapi_active_mode ?? "demo") === "live";
  const isCentLive = Boolean(cfg?.metaapi_is_cent_account_live);
  for (const s of signals) {
    const arrow = s.direction === "Long" ? "🟢 BUY" : "🔴 SELL";
    const session =
      s.session_score >= 90 ? "London/NY Overlap" :
      s.session_score >= 85 ? "London" :
      s.session_score >= 80 ? "New York" :
      s.session_score >= 70 ? "Asian/Crypto" : "Off-session";
    const fmt = (n: number) => {
      if (s.pair === "XAU/USD") return n.toFixed(2);
      if (s.pair === "BTC/USD") return n.toFixed(1);
      return n.toFixed(s.pair.includes("JPY") ? 3 : 5);
    };
    const isLong = s.direction === "Long";
    const slDist = formatDistance(s.pair, s.entry, s.stop_loss, !isLong);
    const tp1Dist = formatDistance(s.pair, s.entry, s.tp1, isLong);
    const tp2Dist = formatDistance(s.pair, s.entry, s.tp2, isLong);
    const lotStr = estimateLot(s.pair, s.entry, s.stop_loss, balance, riskPct, minLot, maxLot, isLive, isCentLive);
    const balStr = balance > 0 ? ` (bal: ${balance.toFixed(0)})` : "";
    const text =
      `${arrow}  *${s.pair}*  (${s.timeframe})\n` +
      `Order: *${s.order_type ?? ""}*\n` +
      `📍 Entry: \`${fmt(s.entry)}\`\n` +
      `🛑 SL: \`${fmt(s.stop_loss)}\` [${slDist}]\n` +
      `🎯 TP1: \`${fmt(s.tp1)}\` [${tp1Dist}]   🏆 TP2: \`${fmt(s.tp2)}\` [${tp2Dist}]\n` +
      `R:R 1:${s.rr.toFixed(2)}  ·  Conf *${s.confidence}%*\n` +
      `📦 Lots: ${lotStr}${balStr}\n` +
      `Setup: ${s.setup}\n` +
      `Session: ${session}` +
      (s.htf_bias && s.htf_bias !== "neutral" ? `  ·  1H ${s.htf_bias}` : "");
    try {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
      });
    } catch (_) { /* skip silently */ }
  }
}

type SessionWindow = { enabled: boolean; start: number; end: number };
type SessionConfig = {
  scan_active_sessions_only: boolean;
  sessions: { london: SessionWindow; ny: SessionWindow; tokyo: SessionWindow; sydney: SessionWindow };
  custom_overrides: Record<string, { start: number; end: number } | null>;
};
type ActiveSettings = {
  paused: boolean;
  trading_hours_start_utc: number;
  trading_hours_end_utc: number;
  active_td_key: KeyIdx;
  session_config: SessionConfig;
  key1_exhausted_at: string | null;
  key2_exhausted_at: string | null;
  key3_exhausted_at: string | null;
  pair_auto_execute: Record<string, boolean>;
  scan_interval_minutes: number;
};

// Core pairs always scanned regardless of pair_auto_execute setting.
const CORE_PAIRS = new Set(["XAU/USD", "BTC/USD", "ETH/USD", "XRP/USD", "GBP/USD", "GBP/JPY", "USD/JPY"]);
// Secondary pairs are always attempted but silently skipped on any fetch failure.
const SECONDARY_PAIRS = new Set(["AUD/JPY", "AUD/USD"]);

// ═══════════════════════════════════════════════════════════════
// V.E.R.I.T.A.S. PDF-Approved Instruments
// ═══════════════════════════════════════════════════════════════
const VERITAS_PAIRS = new Set([
  "EUR/USD", "GBP/USD", "USD/JPY",
  "XAU/USD", "BTC/USD", "ETH/USD",
]);

// Setup-specific minimum R:R — VERITAS ATR-based TP gives 1.67 by design
const SETUP_MIN_RR: Record<string, number> = {
  "VERITAS": 1.60,
  "QSS":     1.85,
  "PRISM":   1.85,
  "EMA":     1.85,
  "BOS":     1.85,
  "Session": 1.85,
  "SMC":     1.85,
  "CHOCH":   1.85,
};

// ATR validity ranges per pair (5M, in pips/points)
const VERITAS_ATR_RANGE: Record<string, [number, number]> = {
  "EUR/USD": [5,   25],
  "GBP/USD": [7,   30],
  "USD/JPY": [5,   25],
  "XAU/USD": [50,  300],
  "BTC/USD": [100, 800],
  "ETH/USD": [10,  80],
};

// Max spread per pair (in price terms, not pips)
const VERITAS_MAX_SPREAD: Record<string, number> = {
  "EUR/USD": 0.00015,
  "GBP/USD": 0.00025,
  "USD/JPY": 0.015,
  "XAU/USD": 0.35,
  "BTC/USD": 15.0,
  "ETH/USD": 1.5,
};

const DEFAULT_SESSION_CONFIG: SessionConfig = {
  scan_active_sessions_only: false,
  sessions: {
    london: { enabled: true, start: 7, end: 16 },
    ny:     { enabled: true, start: 12, end: 21 },
    tokyo:  { enabled: true, start: 0, end: 9 },
    sydney: { enabled: true, start: 22, end: 7 },
  },
  custom_overrides: {},
};

function isSameUtcDay(a: Date, b: Date): boolean {
  return a.getUTCFullYear() === b.getUTCFullYear()
    && a.getUTCMonth() === b.getUTCMonth()
    && a.getUTCDate() === b.getUTCDate();
}

async function loadSettings(supabase: ReturnType<typeof createClient>, configured: KeyIdx[]): Promise<ActiveSettings> {
  const { data } = await supabase.from("app_settings").select("*").eq("id", "singleton").maybeSingle();
  const rawActive = Number(data?.active_td_key ?? 1);
  const persistedKey: KeyIdx = (rawActive === 2 ? 2 : rawActive === 3 ? 3 : 1);
  const now = new Date();

  // Reset any exhausted_at from a prior UTC day.
  const raw: Record<KeyIdx, string | null> = {
    1: (data?.key1_exhausted_at as string | null) ?? null,
    2: (data?.key2_exhausted_at as string | null) ?? null,
    3: (data?.key3_exhausted_at as string | null) ?? null,
  };
  const stillExhausted: Record<KeyIdx, string | null> = { 1: null, 2: null, 3: null };
  const resetPatch: Record<string, unknown> = {};
  for (const k of [1, 2, 3] as KeyIdx[]) {
    if (raw[k] && isSameUtcDay(new Date(raw[k]!), now)) {
      stillExhausted[k] = raw[k];
    } else if (raw[k]) {
      resetPatch[`key${k}_exhausted_at`] = null;
    }
  }

  // Determine effective active key: prefer persisted, else first non-exhausted configured.
  const candidateOrder: KeyIdx[] = [persistedKey, ...configured.filter(k => k !== persistedKey)];
  let effectiveKey: KeyIdx = persistedKey;
  for (const k of candidateOrder) {
    if (configured.includes(k) && !stillExhausted[k]) { effectiveKey = k; break; }
  }

  if (Object.keys(resetPatch).length > 0 || effectiveKey !== persistedKey) {
    try {
      await supabase.from("app_settings").update({
        ...resetPatch,
        active_td_key: effectiveKey,
        updated_at: new Date().toISOString(),
      }).eq("id", "singleton");
    } catch (_) { /* ignore */ }
  }

  return {
    paused: !!data?.paused,
    trading_hours_start_utc: Number(data?.trading_hours_start_utc ?? 1),
    trading_hours_end_utc: Number(data?.trading_hours_end_utc ?? 20),
    active_td_key: effectiveKey,
    session_config: (data?.session_config as SessionConfig) ?? DEFAULT_SESSION_CONFIG,
    key1_exhausted_at: stillExhausted[1],
    key2_exhausted_at: stillExhausted[2],
    key3_exhausted_at: stillExhausted[3],
    pair_auto_execute: (data?.pair_auto_execute as Record<string, boolean>) ?? {},
    scan_interval_minutes: Number(data?.scan_interval_minutes ?? 15) === 30 ? 30 : 15,
  };
}

function hourInWindow(h: number, start: number, end: number): boolean {
  return start <= end ? (h >= start && h < end) : (h >= start || h < end);
}

function isWithinTradingHours(d: Date, settings: ActiveSettings): boolean {
  const h = d.getUTCHours();
  const dow = String(d.getUTCDay()); // 0=Sun..6=Sat
  const cfg = settings.session_config ?? DEFAULT_SESSION_CONFIG;
  const override = cfg.custom_overrides?.[dow];
  if (override && typeof override.start === "number" && typeof override.end === "number") {
    return hourInWindow(h, override.start, override.end);
  }
  if (cfg.scan_active_sessions_only) {
    const ss = cfg.sessions ?? DEFAULT_SESSION_CONFIG.sessions;
    return Object.values(ss).some((w) => w.enabled && hourInWindow(h, w.start, w.end));
  }
  // Fallback to legacy global window
  return hourInWindow(h, settings.trading_hours_start_utc, settings.trading_hours_end_utc);
}


// Returns titles of high-impact events within ±30min for any of the given currencies.
function blackoutHits(
  events: Array<{ event_time: string; currency: string; title: string }>,
  currencies: string[], now: Date,
): { title: string; ccy: string; minsTo: number }[] {
  const t = now.getTime();
  const hits: { title: string; ccy: string; minsTo: number }[] = [];
  for (const e of events) {
    if (!currencies.includes(e.currency)) continue;
    const dt = new Date(e.event_time).getTime();
    const diffMin = Math.abs(dt - t) / 60000;
    if (diffMin <= 30) hits.push({ title: e.title, ccy: e.currency, minsTo: Math.round((dt - t) / 60000) });
  }
  return hits;
}

async function runScanJob(
  supabase: ReturnType<typeof createClient>,
  keys: KeySet,
  settings: ActiveSettings,
  mode: "full" | "latest",
  emit?: ProgressEmitter,
  source: string = "manual",
) {
    const sizeFor = (tf: string) => mode === "latest" ? (tf === "1h" ? 30 : 8) : (tf === "1h" ? 60 : 80);
    const tfsToFetch = TFS;
    const configured: KeyIdx[] = ([1, 2, 3] as KeyIdx[]).filter(k => !!keys[k]);
    const initialExhausted = new Set<KeyIdx>();
    if (settings.key1_exhausted_at) initialExhausted.add(1);
    if (settings.key2_exhausted_at) initialExhausted.add(2);
    if (settings.key3_exhausted_at) initialExhausted.add(3);
    const keyState: KeyState = {
      active: settings.active_td_key,
      configured,
      exhausted: initialExhausted,
    };

    const nowDate = new Date();
    // Filter pair list for weekend / Friday-late: only BTC trades.
    // Filter to pairs enabled in auto-execute config (core pairs always scan).
    const autoCfg = settings.pair_auto_execute ?? {};
    // Scan ALL pairs regardless of pair_auto_execute — that flag only gates
    // whether metaapi-execute is called below. Signals are still generated
    // and paper-tracked for disabled pairs.
    const allowedPairs = PAIRS.filter((p) => isPairAllowedNow(p, nowDate));
    const skippedPairs = PAIRS.filter((p) => !allowedPairs.includes(p));

    // Load today's high-impact news once.
    const dayStart = new Date(Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), nowDate.getUTCDate())).toISOString();
    const dayEnd = new Date(Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), nowDate.getUTCDate() + 1)).toISOString();
    const { data: newsRows } = await supabase.from("economic_events")
      .select("event_time, currency, title")
      .gte("event_time", dayStart).lt("event_time", dayEnd);
    const events = (newsRows ?? []) as Array<{ event_time: string; currency: string; title: string }>;

    let apiCalls = 0;
    const apiCallsByKey: Record<KeyIdx, number> = { 1: 0, 2: 0, 3: 0 };
    const accumulateCall = (usedApi: number, usedKey: KeyIdx) => {
      if (usedApi <= 0) return;
      apiCalls += usedApi;
      apiCallsByKey[usedKey] = (apiCallsByKey[usedKey] ?? 0) + usedApi;
    };
    const signals: Signal[] = [];
    const errors: string[] = [];
    const report: Array<{
      pair: string; cached: boolean; candle_time?: string; htf_bias?: string;
      checks: Array<{ setup: string; status: "qualified" | "filtered" | "none"; reason?: string; direction?: string }>;
    }> = [];

    for (const p of skippedPairs) {
      report.push({ pair: p, cached: false, checks: [{ setup: "ALL", status: "filtered", reason: "Market closed (weekend / Fri 22:00+ UTC)" }] });
      emit?.({ type: "pair_done", pair: p, status: "done", message: "Skipped: market closed" });
    }

    type PD = { c5: Candle[]; c15: Candle[]; c1h: Candle[]; c1m?: Candle[] | null; cached: boolean };
    const pairData: Record<string, PD | null> = {};

    // Sequential pair loop; each pair+timeframe fetch is independently throttled.
    for (const pair of allowedPairs) {
      emit?.({ type: "pair_start", pair, status: "pending", message: `Analyzing ${pair}` });

      // Secondary pairs: silently skip on any fetch failure (429, 500, timeout)
      if (SECONDARY_PAIRS.has(pair)) {
        try {
          const fetches: { candles: Candle[]; usedApi: number; usedKey: KeyIdx; cached: boolean }[] = [];
          for (const tf of tfsToFetch) {
            const f = await fetchCandles(supabase, keys, keyState, pair, tf, sizeFor(tf.label), emit, source);
            fetches.push(f);
            accumulateCall(f.usedApi, f.usedKey);
          }
          pairData[pair] = { c5: fetches[0].candles, c15: fetches[1].candles, c1h: fetches[2].candles, cached: fetches.every(f => f.cached) };
          emit?.({ type: "pair_done", pair, status: "done", message: `${pair} candles ready` });
        } catch (e) {
          accumulateCall(((e as any)?.usedApi ?? 0), ((e as any)?.usedKey ?? keyState.active));
          console.log(`Secondary pair ${pair} skipped this cycle: ${(e as Error).message}`);
          pairData[pair] = null;
          emit?.({ type: "pair_done", pair, status: "done", message: `Secondary pair — skipped this cycle` });
        }
        continue;
      }

      try {
        const fetches: { candles: Candle[]; usedApi: number; usedKey: KeyIdx; cached: boolean }[] = [];
        for (const tf of tfsToFetch) {
          const f = await fetchCandles(supabase, keys, keyState, pair, tf, sizeFor(tf.label), emit, source);
          fetches.push(f);
          accumulateCall(f.usedApi, f.usedKey);
        }
        // tfsToFetch is always TFS (5m, 15m, 1h) — 1h is index 2.
        const c1h = fetches[2].candles;
        pairData[pair] = { c5: fetches[0].candles, c15: fetches[1].candles, c1h, cached: fetches.every(f => f.cached) };
        emit?.({ type: "pair_done", pair, status: "done", message: `${pair} candles ready` });
      } catch (e) {
        accumulateCall(((e as any)?.usedApi ?? 0), ((e as any)?.usedKey ?? keyState.active));
        errors.push(`${pair}: ${(e as Error).message}`);
        pairData[pair] = null;
        emit?.({ type: "pair_done", pair, status: "error", message: (e as Error).message });
      }
    }

    // Persist active key + any newly-exhausted keys (in case a failover happened).
    {
      const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
      let changed = false;
      if (keyState.active !== settings.active_td_key) {
        update.active_td_key = keyState.active;
        changed = true;
      }
      const wasExhausted: Record<KeyIdx, boolean> = {
        1: !!settings.key1_exhausted_at,
        2: !!settings.key2_exhausted_at,
        3: !!settings.key3_exhausted_at,
      };
      const nowIso = new Date().toISOString();
      for (const k of [1, 2, 3] as KeyIdx[]) {
        if (keyState.exhausted.has(k) && !wasExhausted[k]) {
          update[`key${k}_exhausted_at`] = nowIso;
          changed = true;
        }
      }
      if (changed) {
        try { await supabase.from("app_settings").update(update).eq("id", "singleton"); } catch (_) { /* ignore */ }
      }
    }

    // Build candidate signals (may contain multiple per pair+direction)
    const candidates: Signal[] = [];
    for (const pair of allowedPairs) {
      const d = pairData[pair];
      const pairReport = {
        pair, cached: d?.cached ?? false,
        candle_time: d?.c5.at(-1) ? new Date(d.c5.at(-1)!.t).toISOString() : undefined,
        htf_bias: d ? htfBias(d.c1h) : undefined,
        checks: [] as Array<{ setup: string; status: "qualified" | "filtered" | "none"; reason?: string; direction?: string }>,
      };
      if (!d) {
        pairReport.checks.push({ setup: "ALL", status: "filtered", reason: "Failed to fetch candles" });
        report.push(pairReport); continue;
      }
      const bias = htfBias(d.c1h);
      const currentPrice = d.c5.at(-1)!.c;
      const setups: Array<[string, RawSignal | null]> = [
        ["EMA Pullback", emaPullback(pair, d.c5, d.c15)],
        ["BOS Retest", bos(pair, d.c5, d.c15)],
        ["Session Range Break", sessionRangeBreak(pair, d.c5)],
        ["SMC OB/FVG", smcOrderBlock(pair, d.c5, d.c15)],
        ["CHOCH", choch(pair, d.c5)],
      ];
      const ccys = pairCurrencies(pair);
      const hits = blackoutHits(events, ccys, nowDate);
      for (const [name, raw] of setups) {
        if (!raw) { pairReport.checks.push({ setup: name, status: "none", reason: "No setup pattern" }); continue; }
        if (DISABLED_SETUPS.has(raw.setup)) {
          pairReport.checks.push({ setup: name, status: "filtered", direction: raw.direction, reason: `Setup disabled: ${raw.setup}` });
          continue;
        }
        if (hits.length > 0) {
          const h = hits[0];
          pairReport.checks.push({ setup: name, status: "filtered", direction: raw.direction,
            reason: `News blackout: ${h.title} (${h.ccy}) ${h.minsTo >= 0 ? `in ${h.minsTo}m` : `${-h.minsTo}m ago`}` });
          continue;
        }
        const q = qualifyAndScore(raw, d.c5, bias, currentPrice);
        if (!q.signal) {
          pairReport.checks.push({ setup: name, status: "filtered", reason: q.reason, direction: raw.direction });
        } else {
          pairReport.checks.push({ setup: name, status: "qualified", direction: q.signal.direction });
          candidates.push(q.signal);
        }
      }

      // VERITAS — scored internally, bypasses qualifyAndScore. Still respects news blackout.
      if (!DISABLED_SETUPS.has("VERITAS")) {
        const ssNow = sessionScore(pair, nowDate);
        const veritas = veritasSetup(pair, d.c5, d.c15, ssNow);
        if (!veritas) {
          pairReport.checks.push({ setup: "VERITAS", status: "none", reason: "No setup pattern" });
        } else if (hits.length > 0) {
          const h = hits[0];
          pairReport.checks.push({ setup: "VERITAS", status: "filtered", direction: veritas.direction,
            reason: `News blackout: ${h.title} (${h.ccy}) ${h.minsTo >= 0 ? `in ${h.minsTo}m` : `${-h.minsTo}m ago`}` });
        } else {
          pairReport.checks.push({ setup: "VERITAS", status: "qualified", direction: veritas.direction });
          candidates.push(veritas);
        }
      }

      // QSS — Quantum Scalping System; scored internally, bypasses qualifyAndScore.
      {
        const ssNow = sessionScore(pair, nowDate);
        const qss = qssSetup(pair, d.c5, d.c15, d.c1h, ssNow);
        if (!qss) {
          pairReport.checks.push({ setup: "QSS", status: "none", reason: "No qualifying void" });
        } else if (hits.length > 0) {
          pairReport.checks.push({ setup: "QSS", status: "filtered", direction: qss.direction, reason: `News blackout` });
        } else {
          pairReport.checks.push({ setup: "QSS", status: "qualified", direction: qss.direction });
          candidates.push(qss);
        }
      }

      // PRISM — Pressure, Regime, Imbalance, Structure, Momentum
      {
        const ssNow = sessionScore(pair, nowDate);
        const prism = prismSetup(pair, d.c5, d.c15, d.c1h, ssNow);
        if (!prism) {
          pairReport.checks.push({ setup: "PRISM", status: "none", reason: "No qualifying pressure zone + regime" });
        } else if (hits.length > 0) {
          const h = hits[0];
          pairReport.checks.push({ setup: "PRISM", status: "filtered", direction: prism.direction,
            reason: `News blackout: ${h.title} (${h.ccy}) ${h.minsTo >= 0 ? `in ${h.minsTo}m` : `${-h.minsTo}m ago`}` });
        } else {
          pairReport.checks.push({ setup: "PRISM", status: "qualified", direction: prism.direction });
          candidates.push(prism);
        }
      }

      report.push(pairReport);

    }


    // One signal per pair per direction → merge setup names.
    // Non-market setups (Buy/Sell Limit|Stop) always own the order_type + entry;
    // VERITAS market orders are treated as a confluence confirmation only.
    const isNonMarket = (ot?: string) => !!ot && /\b(Limit|Stop)\b/i.test(ot);
    const byKey = new Map<string, Signal>();
    for (const s of candidates) {
      const key = `${s.pair}|${s.direction}`;
      const existing = byKey.get(key);
      if (!existing) { byKey.set(key, s); continue; }

      // Pick which signal's order_type + entry to keep:
      // prefer non-market over market; otherwise keep higher confidence.
      const sNon = isNonMarket(s.order_type);
      const eNon = isNonMarket(existing.order_type);
      let base: Signal, other: Signal;
      if (sNon && !eNon)       { base = s;        other = existing; }
      else if (eNon && !sNon)  { base = existing; other = s;        }
      else                     { base = s.confidence > existing.confidence ? s : existing;
                                 other = base === s ? existing : s; }

      const merged: Signal = {
        ...base,
        setup: `${base.setup} + ${other.setup}`,
        confidence: Math.min(100, Math.max(base.confidence, other.confidence) + 5),
      };
      byKey.set(key, merged);
    }
    const merged = Array.from(byKey.values());
    signals.push(...merged);

    // Diagnostic: tally outcomes across all setups so we can confirm from logs
    // whether "no signals" is due to filters vs no qualifying setups.
    let cQualified = 0, cNone = 0, cNewsBlackout = 0, cFilteredOther = 0;
    for (const pr of report) {
      for (const chk of pr.checks) {
        if (chk.status === "qualified") cQualified++;
        else if (chk.status === "none") cNone++;
        else if (chk.status === "filtered" && chk.reason?.startsWith("News blackout")) cNewsBlackout++;
        else if (chk.status === "filtered") cFilteredOther++;
      }
    }
    console.log(JSON.stringify({
      scan_summary: {
        mode,
        pairs_scanned: allowedPairs.length,
        pairs_skipped_market_closed: skippedPairs.length,
        news_events_loaded: events.length,
        setup_checks: { qualified: cQualified, no_pattern: cNone, news_blackout: cNewsBlackout, filtered_other: cFilteredOther },
        candidates_after_merge: merged.length,
      },
    }));

    // Dedupe vs last 90min same pair+direction (any setup).
    // Include "tp1" in the active-signal filter: a partially-closed trade is still
    // in-flight (runner B is still open) and must block a re-fire of the same setup.
    // Also block by candle_time: if the exact same pair+direction+candle_time already
    // exists in the DB (any status), this is structurally the same signal and must not
    // be duplicated regardless of how the original resolved.
    const since = new Date(Date.now() - 90 * 60 * 1000).toISOString();
    const { data: recent } = await supabase.from("signals")
      .select("pair, direction, status, candle_time").gte("created_at", since);

    // Block same pair+direction if any signal is still active (pending, in-trade, or partial tp1)
    const seen = new Set((recent ?? [])
      .filter((r: any) => r.status === "pending" || r.status === "executed" || r.status === "tp1")
      .map((r: any) => `${r.pair}|${r.direction}`));

    // Also block by exact candle_time fingerprint — same candle = same structural signal
    const seenCandle = new Set((recent ?? [])
      .filter((r: any) => r.candle_time != null)
      .map((r: any) => `${r.pair}|${r.direction}|${r.candle_time}`));

    const dedupedInsert = merged.filter(s =>
      !seen.has(`${s.pair}|${s.direction}`) &&
      !seenCandle.has(`${s.pair}|${s.direction}|${s.candle_time}`)
    );
    // Apply manual-trading threshold gate: signals below min_confidence or min_rr
    // are NOT saved and NOT alerted (keeps signals tab + Telegram aligned with what
    // you'd trade manually). Only gates NEW signals; previously-saved paper-tracked
    // signals are unaffected.
    const { data: cfgRowPre } = await supabase.from("app_settings").select("*").eq("id", "singleton").maybeSingle();
    let cfg: any = cfgRowPre ?? null;
    const minConf = Number((cfg as any)?.metaapi_min_confidence ?? 70);
    const minRR = Number((cfg as any)?.metaapi_min_rr ?? 2.0);
    const toInsert = dedupedInsert.filter(s => s.confidence >= minConf && s.rr >= minRR);
    console.log(JSON.stringify({ scan_dedupe: { candidates: merged.length, deduped: merged.length - dedupedInsert.length, below_threshold: dedupedInsert.length - toInsert.length, to_insert: toInsert.length, minConf, minRR } }));
    let insertedRows: Array<{ id: string; pair: string; direction: string; confidence: number; rr: number }> = [];
    if (toInsert.length) {
      const { data: ins } = await supabase.from("signals").insert(toInsert).select("id, pair, direction, confidence, rr");
      insertedRows = (ins as any) ?? [];
      await sendTelegramAlerts(toInsert, cfg);

      // Fire-and-forget MetaApi auto-execution for signals meeting threshold.
      const autoTrade = !!(cfg as any)?.metaapi_auto_trade;

      if (autoTrade) {
        const fnSecret = Deno.env.get("INTERNAL_FN_SECRET") ?? "";
        const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
        const baseUrl = Deno.env.get("SUPABASE_URL")!;
        for (const row of insertedRows) {
          if (Number(row.confidence) < minConf || Number(row.rr) < minRR) continue;
          if (autoCfg[row.pair] === false) continue; // pair disabled for auto-execute
          // Fire-and-forget — don't block the scan.
          // Send both auth headers so checkInternalAuth passes regardless of which
          // it validates against (x-fn-secret OR Bearer service-role).
          fetch(`${baseUrl}/functions/v1/metaapi-execute`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-fn-secret": fnSecret,
              "Authorization": `Bearer ${serviceKey}`,
              "apikey": serviceKey,
            },
            body: JSON.stringify({ signal_id: row.id }),
          }).catch((e) => console.error("metaapi-execute trigger failed", row.id, e));
        }
      }
    }

    const day = new Date().toISOString().slice(0, 10);
    // Atomic per-key increments — safe under concurrent scan runs.
    let newCalls = 0;
    const perKey: Array<{ key: KeyIdx; delta: number }> = [
      { key: 1, delta: apiCallsByKey[1] },
      { key: 2, delta: apiCallsByKey[2] },
      { key: 3, delta: apiCallsByKey[3] },
    ];
    let rpcFailed = false;
    for (const { key, delta } of perKey) {
      if (delta <= 0) continue;
      const { data: incRes, error: incErr } = await supabase.rpc("increment_api_usage", {
        p_day: day, p_delta: delta, p_key: key,
      });
      if (incErr || typeof incRes !== "number") {
        rpcFailed = true;
        break;
      }
      newCalls = incRes;
    }
    if (rpcFailed) {
      // Fallback to read-modify-write if RPC unavailable.
      const { data: usage } = await supabase.from("api_usage")
        .select("calls, calls_key1, calls_key2, calls_key3").eq("day", day).maybeSingle();
      const prev = (usage as any) ?? { calls: 0, calls_key1: 0, calls_key2: 0, calls_key3: 0 };
      newCalls = (prev.calls ?? 0) + apiCalls;
      await supabase.from("api_usage").upsert({
        day,
        calls: newCalls,
        calls_key1: (prev.calls_key1 ?? 0) + apiCallsByKey[1],
        calls_key2: (prev.calls_key2 ?? 0) + apiCallsByKey[2],
        calls_key3: (prev.calls_key3 ?? 0) + apiCallsByKey[3],
        updated_at: new Date().toISOString(),
      }, { onConflict: "day" });
    } else if (newCalls === 0) {
      // No API calls made this run — read the current daily total.
      const { data: usage } = await supabase.from("api_usage").select("calls").eq("day", day).maybeSingle();
      newCalls = (usage?.calls as number) ?? 0;
    }

    return {
      signals, new_signals: toInsert.length,
      api_calls_used: apiCalls, api_calls_today: newCalls,
      budget_remaining: DAILY_BUDGET - newCalls, mode,
      errors, report, scanned_at: new Date().toISOString(),
      active_td_key: keyState.active, skipped_pairs: skippedPairs,
      news_events_loaded: events.length,
    };
}



Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const unauth = checkInternalAuth(req);
  if (unauth) return unauth;
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceKey);

  let body: { mode?: "full" | "latest" | "test_strategy"; stream?: boolean; source?: string; pairs?: string[]; setups?: string[] } = {};
  try { body = await req.json(); } catch { /* GET ok */ }
  const isTestMode = body?.mode === "test_strategy";
  const testPairs: string[]  = Array.isArray(body?.pairs)  ? body!.pairs!  : [];
  const testSetups: string[] = Array.isArray(body?.setups) ? body!.setups! : [];
  const mode: "full" | "latest" = body.mode === "full" ? "full" : "latest";
  const source = body.source ?? req.headers.get("x-scan-source") ?? "manual";

  // ─── TEST STRATEGY MODE ──────────────────────────────────────────
  // Runs strategy logic on live candle data without persisting signals,
  // placing orders, or sending alerts. Used by the Settings → Test Strategy panel.
  if (isTestMode) {
    try {
      const tdKey1 = Deno.env.get("TWELVE_DATA_API_KEY") ?? "";
      const tdKey2 = Deno.env.get("TWELVEDATA_API_KEY_2") ?? "";
      const tdKey3 = Deno.env.get("TWELVEDATA_API_KEY_3") ?? "";
      if (!tdKey1) throw new Error("TWELVE_DATA_API_KEY not configured");
      const keys: KeySet = {};
      if (tdKey1) keys[1] = tdKey1;
      if (tdKey2) keys[2] = tdKey2;
      if (tdKey3) keys[3] = tdKey3;
      const configured: KeyIdx[] = ([1, 2, 3] as KeyIdx[]).filter(k => !!keys[k]);
      const activeKeyRef: KeyState = { active: configured[0] ?? 1, configured, exhausted: new Set() };

      const results: Record<string, Record<string, any>> = {};
      for (const pair of testPairs) {
        results[pair] = {};
        let c5Arr: Candle[] = [], c15Arr: Candle[] = [], c1hArr: Candle[] = [];
        try {
          const c5  = await fetchCandles(supabase, keys, activeKeyRef, pair, { label: "5m",  td: "5min" },  100, undefined, "manual");
          const c15 = await fetchCandles(supabase, keys, activeKeyRef, pair, { label: "15m", td: "15min" }, 100, undefined, "manual");
          const c1h = await fetchCandles(supabase, keys, activeKeyRef, pair, { label: "1h",  td: "1h" },    100, undefined, "manual");
          c5Arr = c5.candles; c15Arr = c15.candles; c1hArr = c1h.candles;
        } catch (e) {
          for (const setup of testSetups) {
            results[pair][setup] = { setup, pair, qualified: false, reason: `Candle fetch failed: ${String((e as Error).message ?? e)}` };
          }
          continue;
        }
        const ss = sessionScore(pair, new Date());

        for (const setup of testSetups) {
          let result: any = { setup, pair, qualified: false, reason: "Unknown setup" };
          try {
            if (setup === "VERITAS") {
              const sig = veritasSetup(pair, c5Arr, c15Arr, ss);
              result = sig
                ? { setup, pair, qualified: true, signal: sig,
                    debug: `H=${sig.setup.match(/H=([\d.]+)/)?.[1] ?? "?"} SNR=${sig.mfi_score}` }
                : { setup, pair, qualified: false, reason: "No VERITAS signal — check Hurst/TSI/SNR/VPT alignment" };
            } else if (setup === "QSS") {
              const sig = qssSetup(pair, c5Arr, c15Arr, c1hArr, ss);
              result = sig
                ? { setup, pair, qualified: true, signal: sig,
                    debug: `Regime=${sig.setup.match(/\(([^)]+)\)/)?.[1] ?? "?"} VWSA=${sig.mfi_score}` }
                : { setup, pair, qualified: false, reason: "No QSS signal — regime not expansion, or no valid liquidity void found" };
            } else if (setup === "PRISM") {
              const sig = prismSetup(pair, c5Arr, c15Arr, c1hArr, ss);
              result = sig
                ? { setup, pair, qualified: true, signal: sig,
                    debug: `DI=${(sig.mfi_score / 100).toFixed(2)} PZ=${sig.setup.match(/PZ[+~\-]+/)?.[0] ?? "?"} Conf=${sig.confidence}` }
                : { setup, pair, qualified: false, reason: "No PRISM signal — check regime DI ratio, pressure zone, 1H structure, or TSI momentum" };
            } else if (setup === "EMA Pullback") {
              const sig = emaPullback(pair, c5Arr, c15Arr);
              result = sig
                ? { setup, pair, qualified: true, signal: sig }
                : { setup, pair, qualified: false, reason: "No EMA Pullback signal this cycle" };
            } else if (setup === "BOS Retest") {
              const sig = bos(pair, c5Arr, c15Arr);
              result = sig
                ? { setup, pair, qualified: true, signal: sig }
                : { setup, pair, qualified: false, reason: "No BOS Retest signal this cycle" };
            }
          } catch (e) {
            result = { setup, pair, qualified: false, reason: `Error: ${String((e as Error).message ?? e)}` };
          }
          results[pair][setup] = result;
        }
      }

      return new Response(JSON.stringify({ ok: true, results, scanned_at: new Date().toISOString() }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: (e as Error).message }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }
  // ─── END TEST STRATEGY MODE ──────────────────────────────────────

  // Sweep any prior stalled rows (started >5min ago with no finished_at) so the
  // Health tab does not display STALLED indefinitely after an edge-function timeout.
  try {
    const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    await supabase.from("scan_runs").update({
      finished_at: new Date().toISOString(),
      ok: false,
      errors: ["stalled — function timed out before finalize"],
    }).is("finished_at", null).lt("started_at", cutoff);
  } catch (_) { /* ignore */ }

  // Open a scan_runs row immediately so the health panel always reflects the latest attempt.
  let runId: string | null = null;
  try {
    const { data: runRow } = await supabase.from("scan_runs").insert({
      mode, source, started_at: new Date().toISOString(),
    }).select("id").maybeSingle();
    runId = (runRow?.id as string) ?? null;
  } catch (_) { /* ignore */ }

  const finalize = async (result: any, ok: boolean, errMsg?: string) => {
    if (!runId) return;
    try {
      await supabase.from("scan_runs").update({
        finished_at: new Date().toISOString(),
        new_signals: result?.new_signals ?? 0,
        api_calls_used: result?.api_calls_used ?? 0,
        api_calls_today: result?.api_calls_today ?? 0,
        errors: errMsg ? [errMsg, ...(result?.errors ?? [])] : (result?.errors ?? []),
        ok,
      }).eq("id", runId);
    } catch (_) { /* ignore */ }
  };

  try {
    const tdKey1 = Deno.env.get("TWELVE_DATA_API_KEY") ?? "";
    const tdKey2 = Deno.env.get("TWELVEDATA_API_KEY_2") ?? "";
    const tdKey3 = Deno.env.get("TWELVEDATA_API_KEY_3") ?? "";
    if (!tdKey1) throw new Error("TWELVE_DATA_API_KEY not configured");
    const keys: KeySet = {};
    if (tdKey1) keys[1] = tdKey1;
    if (tdKey2) keys[2] = tdKey2;
    if (tdKey3) keys[3] = tdKey3;
    const configuredKeys: KeyIdx[] = ([1, 2, 3] as KeyIdx[]).filter(k => !!keys[k]);

    const settings = await loadSettings(supabase, configuredKeys);

    // Pause + trading-hours short-circuit (cron only — manual scans always run).
    if (source === "cron") {
      if (settings.paused) {
        const skipResult = { skipped: true, reason: "paused", new_signals: 0, api_calls_used: 0, api_calls_today: 0, errors: [], report: [] };
        await finalize(skipResult, true);
        return new Response(JSON.stringify(skipResult), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      // 30-minute interval gate: cron fires every 15min at :02/:17/:32/:47.
      // When interval=30, skip the :17 and :47 runs (minute % 30 in [15,19]).
      if (settings.scan_interval_minutes === 30) {
        const m = new Date().getUTCMinutes();
        const modm = m % 30;
        if (modm >= 15 && modm <= 19) {
          const skipResult = { skipped: true, reason: "30min interval", new_signals: 0, api_calls_used: 0, api_calls_today: 0, errors: [], report: [] };
          await finalize(skipResult, true);
          return new Response(JSON.stringify({ ok: true, skipped: "30min interval" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
      }
      if (!isWithinTradingHours(new Date(), settings)) {
        const skipResult = { skipped: true, reason: `outside active trading window`, new_signals: 0, api_calls_used: 0, api_calls_today: 0, errors: [], report: [] };
        await finalize(skipResult, true);
        return new Response(JSON.stringify(skipResult), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
    }

    if (body.stream) {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          const send = (payload: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
          try {
            const result = await runScanJob(supabase, keys, settings, mode, (event) => send(event), source);
            send({ type: "complete", result });
            await finalize(result, true);
            controller.close();
          } catch (e) {
            send({ type: "error", error: (e as Error).message });
            await finalize(null, false, (e as Error).message);
            controller.close();
          }
        },
      });
      return new Response(stream, { headers: { ...corsHeaders, "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } });
    }

    const result = await runScanJob(supabase, keys, settings, mode, undefined, source);
    await finalize(result, true);
    return new Response(JSON.stringify(result), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    console.error("scan-signals error", e);
    await finalize(null, false, (e as Error).message);
    return new Response(JSON.stringify({ error: "Internal scan error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
