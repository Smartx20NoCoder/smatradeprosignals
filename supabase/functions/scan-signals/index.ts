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

const PAIRS = ["EUR/USD", "GBP/USD", "USD/JPY", "GBP/JPY", "EUR/JPY", "XAU/USD", "BTC/USD", "EUR/GBP", "AUD/JPY", "AUD/USD"];
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
  if (pair === "BTC/USD") return true;
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
function pipSize(pair: string): number {
  if (isGold(pair)) return 0.01;
  if (isBTC(pair)) return 1.0;
  return pair.includes("JPY") ? 0.01 : 0.0001;
}
function spreadPrice(pair: string): number {
  if (isGold(pair)) return XAU_SPREAD;
  if (isBTC(pair)) return BTC_SPREAD;
  return (SPREAD_PIPS[pair] ?? 1.5) * pipSize(pair);
}
function spreadDisplay(pair: string): number {
  if (isGold(pair)) return 40;
  if (isBTC(pair)) return 200; // $2.00 = 200 cents
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
  if (isBTC(pair)) return 70; // crypto 24/7
  if (isOverlap) return 95;
  if (isGold(pair) && (isLondon || isNY)) return 90;
  if (isGold(pair) && isAsian) return 30;
  if (pair.includes("JPY") && isAsian) return 70;
  if (pair === "EUR/GBP" && isLondon) return 90;   // EUR/GBP is a London pair
  if (pair === "EUR/GBP" && isNY) return 60;
  if (pair === "EUR/GBP" && isAsian) return 20;
  if (pair.startsWith("AUD") && isAsian) return 85; // AUD pairs peak in Asian session
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

type KeySet = { primary: string; secondary?: string };

async function fetchCandles(
  supabase: ReturnType<typeof createClient>,
  keys: KeySet,
  activeKeyRef: { idx: 1 | 2 },
  pair: string,
  tf: { label: string; td: string },
  outputSize: number,
  emit?: ProgressEmitter,
): Promise<{ candles: Candle[]; usedApi: number; cached: boolean }> {
  const { data: cached } = await supabase
    .from("candle_cache").select("candles, fetched_at")
    .eq("pair", pair).eq("timeframe", tf.label).maybeSingle();
  const ttlMin = CACHE_TTL_MIN_BY_TF[tf.label] ?? DEFAULT_CACHE_TTL_MIN;
  if (cached) {
    const ageMin = (Date.now() - new Date(cached.fetched_at as string).getTime()) / 60000;
    if (ageMin < ttlMin) {
      emit?.({ type: "progress", pair, timeframe: tf.label, status: "cached", message: `Cached (${ageMin.toFixed(1)}m / ${ttlMin}m TTL)` });
      return { candles: cached.candles as Candle[], usedApi: 0, cached: true };
    }
  }
  emit?.({ type: "progress", pair, timeframe: tf.label, status: "fetching", message: `Fetching fresh (TTL ${ttlMin}m, key #${activeKeyRef.idx})` });

  const tryKey = async (key: string): Promise<{ resp: Response; calls: number }> => {
    const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(pair)}&interval=${tf.td}&outputsize=${outputSize}&apikey=${key}`;
    let resp: Response | null = null;
    let calls = 0;
    for (let attempt = 1; attempt <= MAX_429_RETRIES + 1; attempt++) {
      resp = await throttledTwelveDataFetch(url, emit, { pair, timeframe: tf.label });
      calls += 1;
      if (resp.status !== 429) break;
      if (attempt > MAX_429_RETRIES) break;
      emit?.({ type: "progress", pair, timeframe: tf.label, status: "rate_limited", attempt, message: `429 on key #${activeKeyRef.idx} — retrying in 60s` });
      await delay(RATE_LIMIT_RETRY_MS);
    }
    return { resp: resp!, calls };
  };

  // Active key first; if it 429s after retries, fail over to the other key.
  const primaryKey = activeKeyRef.idx === 1 ? keys.primary : (keys.secondary ?? keys.primary);
  let { resp: r, calls: usedApi } = await tryKey(primaryKey);
  if (r.status === 429 && keys.secondary && keys.secondary !== primaryKey) {
    const fallbackIdx: 1 | 2 = activeKeyRef.idx === 1 ? 2 : 1;
    emit?.({ type: "progress", pair, timeframe: tf.label, status: "rate_limited", message: `Failing over to key #${fallbackIdx}` });
    activeKeyRef.idx = fallbackIdx;
    const fallbackKey = fallbackIdx === 1 ? keys.primary : keys.secondary;
    const second = await tryKey(fallbackKey);
    r = second.resp;
    usedApi += second.calls;
  }

  if (!r) throw new Error(`Failed to fetch candles for ${pair} ${tf.label}`);
  const j = await r.json().catch(() => ({}));
  if (!j.values || !Array.isArray(j.values)) {
    console.error("TwelveData error", pair, tf.label, r.status, j);
    emit?.({ type: "progress", pair, timeframe: tf.label, status: "error", message: `Fetch failed (${r.status})` });
    throw new Error(`Failed to fetch candles for ${pair} ${tf.label}`);
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
  emit?.({ type: "progress", pair, timeframe: tf.label, status: "done", message: `Fetched and cached (key #${activeKeyRef.idx})` });
  return { candles: fresh, usedApi, cached: false };
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
  const lookback = c5.slice(-23, -3); if (lookback.length < 10) return null;
  const sh = Math.max(...lookback.map(x => x.h)), sl = Math.min(...lookback.map(x => x.l));
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
  let rs: number | null = null;
  if (hUTC >= 8 && hUTC < 11) rs = 7;
  else if (hUTC >= 14 && hUTC < 17) rs = 13;
  if (rs === null) return null;
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const rStart = today.getTime() + rs * 3600_000, rEnd = rStart + 3600_000;
  const range = c5.filter(x => x.t >= rStart && x.t < rEnd);
  if (range.length < 6) return null;
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
  const minAtrPips = isGold(pair) ? 80 : isBTC(pair) ? 20 : 4;
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

async function sendTelegramAlerts(signals: Signal[]) {
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  const chatId = Deno.env.get("TELEGRAM_CHAT_ID");
  if (!token || !chatId || !signals.length) return;
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
    const text =
      `${arrow}  *${s.pair}*  (${s.timeframe})\n` +
      `Order: *${s.order_type ?? ""}*\n` +
      `Entry: \`${fmt(s.entry)}\`\n` +
      `SL: \`${fmt(s.stop_loss)}\`\n` +
      `TP1: \`${fmt(s.tp1)}\`   TP2: \`${fmt(s.tp2)}\`\n` +
      `R:R 1:${s.rr.toFixed(2)}  ·  Conf *${s.confidence}%*\n` +
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
  active_td_key: 1 | 2;
  session_config: SessionConfig;
  key1_exhausted_at: string | null;
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

async function loadSettings(supabase: ReturnType<typeof createClient>): Promise<ActiveSettings> {
  const { data } = await supabase.from("app_settings").select("*").eq("id", "singleton").maybeSingle();
  const persistedKey: 1 | 2 = ((data?.active_td_key ?? 1) === 2 ? 2 : 1);
  const exhaustedRaw = (data?.key1_exhausted_at as string | null) ?? null;
  let key1ExhaustedAt: string | null = exhaustedRaw;
  let effectiveKey: 1 | 2 = persistedKey;

  if (exhaustedRaw) {
    const exhaustedDate = new Date(exhaustedRaw);
    if (isSameUtcDay(exhaustedDate, new Date())) {
      // Key 1 was rate-limited today — start directly on Key 2.
      effectiveKey = 2;
    } else {
      // Prior UTC day — clear the flag so Key 1 is tried again today.
      key1ExhaustedAt = null;
      try {
        await supabase.from("app_settings").update({
          key1_exhausted_at: null, updated_at: new Date().toISOString(),
        }).eq("id", "singleton");
      } catch (_) { /* ignore */ }
    }
  }

  return {
    paused: !!data?.paused,
    trading_hours_start_utc: Number(data?.trading_hours_start_utc ?? 1),
    trading_hours_end_utc: Number(data?.trading_hours_end_utc ?? 20),
    active_td_key: effectiveKey,
    session_config: (data?.session_config as SessionConfig) ?? DEFAULT_SESSION_CONFIG,
    key1_exhausted_at: key1ExhaustedAt,
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
) {
    const sizeFor = (tf: string) => mode === "latest" ? (tf === "1h" ? 30 : 8) : (tf === "1h" ? 60 : 80);
    const tfsToFetch = TFS;
    const activeKeyRef: { idx: 1 | 2 } = { idx: settings.active_td_key };

    const nowDate = new Date();
    // Filter pair list for weekend / Friday-late: only BTC trades.
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

    type PD = { c5: Candle[]; c15: Candle[]; c1h: Candle[]; cached: boolean };
    const pairData: Record<string, PD | null> = {};

    // Sequential pair loop; each pair+timeframe fetch is independently throttled.
    for (const pair of allowedPairs) {
      emit?.({ type: "pair_start", pair, status: "pending", message: `Analyzing ${pair}` });
      try {
        const fetches: { candles: Candle[]; usedApi: number; cached: boolean }[] = [];
        for (const tf of tfsToFetch) {
          const f = await fetchCandles(supabase, keys, activeKeyRef, pair, tf, sizeFor(tf.label), emit);
          fetches.push(f);
          apiCalls += f.usedApi;
        }
        // tfsToFetch is always TFS (5m, 15m, 1h) — 1h is index 2.
        const c1h = fetches[2].candles;
        pairData[pair] = { c5: fetches[0].candles, c15: fetches[1].candles, c1h, cached: fetches.every(f => f.cached) };
        emit?.({ type: "pair_done", pair, status: "done", message: `${pair} candles ready` });
      } catch (e) {
        errors.push(`${pair}: ${(e as Error).message}`);
        pairData[pair] = null;
        emit?.({ type: "pair_done", pair, status: "error", message: (e as Error).message });
      }
    }

    // Persist whichever key we ended on (in case a failover happened).
    if (activeKeyRef.idx !== settings.active_td_key) {
      try {
        const update: Record<string, unknown> = {
          active_td_key: activeKeyRef.idx, updated_at: new Date().toISOString(),
        };
        // If we failed over away from Key 1, mark Key 1 as exhausted for today
        // so the next scan starts directly on Key 2 (cleared at next UTC day).
        if (settings.active_td_key === 1 && activeKeyRef.idx === 2) {
          update.key1_exhausted_at = new Date().toISOString();
        }
        await supabase.from("app_settings").update(update).eq("id", "singleton");
      } catch (_) { /* ignore */ }
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
      report.push(pairReport);
    }

    // One signal per pair per direction → keep highest confidence; merge setup names
    const byKey = new Map<string, Signal>();
    for (const s of candidates) {
      const key = `${s.pair}|${s.direction}`;
      const existing = byKey.get(key);
      if (!existing) { byKey.set(key, s); continue; }
      if (s.confidence > existing.confidence) {
        s.setup = `${s.setup} + ${existing.setup}`;
        byKey.set(key, s);
      } else {
        existing.setup = `${existing.setup} + ${s.setup}`;
      }
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

    // Dedupe vs last 60min same pair+direction (any setup)
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { data: recent } = await supabase.from("signals")
      .select("pair, direction, status").gte("created_at", since);
    const seen = new Set((recent ?? [])
      .filter((r: any) => r.status === "pending" || r.status === "executed")
      .map((r: any) => `${r.pair}|${r.direction}`));
    const toInsert = merged.filter(s => !seen.has(`${s.pair}|${s.direction}`));
    console.log(JSON.stringify({ scan_dedupe: { candidates: merged.length, deduped: merged.length - toInsert.length, to_insert: toInsert.length } }));
    let insertedRows: Array<{ id: string; pair: string; direction: string; confidence: number; rr: number }> = [];
    if (toInsert.length) {
      const { data: ins } = await supabase.from("signals").insert(toInsert).select("id, pair, direction, confidence, rr");
      insertedRows = (ins as any) ?? [];
      await sendTelegramAlerts(toInsert);

      // Fire-and-forget MetaApi auto-execution for signals meeting threshold.
      const { data: cfg } = await supabase.from("app_settings").select("*").eq("id", "singleton").maybeSingle();
      const autoTrade = !!(cfg as any)?.metaapi_auto_trade;
      const minConf = Number((cfg as any)?.metaapi_min_confidence ?? 75);
      const minRR = Number((cfg as any)?.metaapi_min_rr ?? 2);
      if (autoTrade) {
        const fnSecret = Deno.env.get("INTERNAL_FN_SECRET") ?? "";
        const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
        const baseUrl = Deno.env.get("SUPABASE_URL")!;
        for (const row of insertedRows) {
          if (Number(row.confidence) < minConf || Number(row.rr) < minRR) continue;
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
    const { data: usage } = await supabase.from("api_usage").select("calls").eq("day", day).maybeSingle();
    const newCalls = (usage?.calls ?? 0) + apiCalls;
    await supabase.from("api_usage").upsert(
      { day, calls: newCalls, updated_at: new Date().toISOString() }, { onConflict: "day" });

    return {
      signals, new_signals: toInsert.length,
      api_calls_used: apiCalls, api_calls_today: newCalls,
      budget_remaining: DAILY_BUDGET - newCalls, mode,
      errors, report, scanned_at: new Date().toISOString(),
      active_td_key: activeKeyRef.idx, skipped_pairs: skippedPairs,
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

  let body: { mode?: "full" | "latest"; stream?: boolean; source?: string } = {};
  try { body = await req.json(); } catch { /* GET ok */ }
  const mode = body.mode === "full" ? "full" : "latest";
  const source = body.source ?? req.headers.get("x-scan-source") ?? "manual";

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
    const tdKey1 = Deno.env.get("TWELVE_DATA_API_KEY");
    const tdKey2 = Deno.env.get("TWELVEDATA_API_KEY_2") || undefined;
    if (!tdKey1) throw new Error("TWELVE_DATA_API_KEY not configured");
    const keys: KeySet = { primary: tdKey1, secondary: tdKey2 };

    const settings = await loadSettings(supabase);

    // Pause + trading-hours short-circuit (cron only — manual scans always run).
    if (source === "cron") {
      if (settings.paused) {
        const skipResult = { skipped: true, reason: "paused", new_signals: 0, api_calls_used: 0, api_calls_today: 0, errors: [], report: [] };
        await finalize(skipResult, true);
        return new Response(JSON.stringify(skipResult), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
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
            const result = await runScanJob(supabase, keys, settings, mode, (event) => send(event));
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

    const result = await runScanJob(supabase, keys, settings, mode);
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
