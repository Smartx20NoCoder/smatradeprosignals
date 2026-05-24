// ScalpEdge scan engine v3
// 7 pairs (XAU/USD + BTC/USD replace GBP/CHF + USD/CHF), 5 setups, 1H HTF bias filter,
// MFI confirmation, spread cushion. Every individual TwelveData call is serialized
// with an ~8s gap and pair+timeframe candle data is cached for at least 10 minutes.
// One signal per pair per direction (highest confidence wins).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const PAIRS = ["EUR/USD", "GBP/USD", "USD/JPY", "GBP/JPY", "EUR/JPY", "XAU/USD", "BTC/USD"];
const TFS = [
  { label: "5m", td: "5min" },
  { label: "15m", td: "15min" },
  { label: "1h", td: "1h" },
];
const CACHE_TTL_MIN = 10;
const DAILY_BUDGET = 800;
// Spacing between every individual TwelveData request: 8.2s → safely under 8/min.
const API_CALL_SPACING_MS = 8200;
const RATE_LIMIT_RETRY_MS = 60_000;
const MAX_429_RETRIES = 2;
let twelveDataQueue: Promise<void> = Promise.resolve();
let lastTwelveDataCallStartedAt = 0;

// Spread cushion: pips for FX, absolute $ for gold/BTC.
const SPREAD_PIPS: Record<string, number> = {
  "EUR/USD": 1.2, "GBP/USD": 1.2, "USD/JPY": 1.2,
  "GBP/JPY": 2.5, "EUR/JPY": 2.5,
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
async function fetchCandles(
  supabase: ReturnType<typeof createClient>,
  apiKey: string,
  pair: string,
  tf: { label: string; td: string },
  outputSize: number,
): Promise<{ candles: Candle[]; usedApi: number; cached: boolean }> {
  const { data: cached } = await supabase
    .from("candle_cache").select("candles, fetched_at")
    .eq("pair", pair).eq("timeframe", tf.label).maybeSingle();
  if (cached) {
    const ageMin = (Date.now() - new Date(cached.fetched_at as string).getTime()) / 60000;
    if (ageMin < CACHE_TTL_MIN) return { candles: cached.candles as Candle[], usedApi: 0, cached: true };
  }
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(pair)}&interval=${tf.td}&outputsize=${outputSize}&apikey=${apiKey}`;
  const r = await fetch(url);
  const j = await r.json();
  if (!j.values || !Array.isArray(j.values)) {
    throw new Error(`TwelveData ${pair} ${tf.label}: ${JSON.stringify(j).slice(0, 180)}`);
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
  return { candles: fresh, usedApi: 1, cached: false };
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const tdKey = Deno.env.get("TWELVE_DATA_API_KEY");
    if (!tdKey) throw new Error("TWELVE_DATA_API_KEY not configured");
    const supabase = createClient(supabaseUrl, serviceKey);

    let body: { mode?: "full" | "latest" } = {};
    try { body = await req.json(); } catch { /* GET ok */ }
    const mode = body.mode === "latest" ? "latest" : "full";
    const sizeFor = (tf: string) => mode === "latest" ? (tf === "1h" ? 30 : 8) : (tf === "1h" ? 60 : 80);
    const tfsToFetch = mode === "latest" ? TFS.slice(0, 2) : TFS;

    let apiCalls = 0;
    const signals: Signal[] = [];
    const errors: string[] = [];
    const report: Array<{
      pair: string; cached: boolean; candle_time?: string; htf_bias?: string;
      checks: Array<{ setup: string; status: "qualified" | "filtered" | "none"; reason?: string; direction?: string }>;
    }> = [];

    type PD = { c5: Candle[]; c15: Candle[]; c1h: Candle[]; cached: boolean };
    const pairData: Record<string, PD | null> = {};

    // Sequential per-pair fetch with rate-limit spacing.
    for (let pi = 0; pi < PAIRS.length; pi++) {
      const pair = PAIRS[pi];
      let hitNetwork = false;
      try {
        const fetches: { candles: Candle[]; usedApi: number; cached: boolean }[] = [];
        for (const tf of tfsToFetch) {
          const f = await fetchCandles(supabase, tdKey, pair, tf, sizeFor(tf.label));
          fetches.push(f);
          apiCalls += f.usedApi;
          if (!f.cached) hitNetwork = true;
        }
        let c1h: Candle[] = [];
        if (tfsToFetch.length < 3) {
          const { data } = await supabase.from("candle_cache").select("candles")
            .eq("pair", pair).eq("timeframe", "1h").maybeSingle();
          c1h = (data?.candles as Candle[]) ?? [];
        } else c1h = fetches[2].candles;
        pairData[pair] = { c5: fetches[0].candles, c15: fetches[1].candles, c1h, cached: fetches.every(f => f.cached) };
      } catch (e) {
        errors.push(`${pair}: ${(e as Error).message}`);
        pairData[pair] = null;
      }
      // Space out only if we actually hit the network AND more pairs remain
      if (hitNetwork && pi < PAIRS.length - 1) {
        await new Promise((res) => setTimeout(res, PAIR_SPACING_MS));
      }
    }

    // Build candidate signals (may contain multiple per pair+direction)
    const candidates: Signal[] = [];
    for (const pair of PAIRS) {
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
      for (const [name, raw] of setups) {
        if (!raw) { pairReport.checks.push({ setup: name, status: "none", reason: "No setup pattern" }); continue; }
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

    // Dedupe vs last 60min same pair+direction (any setup)
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { data: recent } = await supabase.from("signals")
      .select("pair, direction, status").gte("created_at", since);
    const seen = new Set((recent ?? [])
      .filter((r: any) => r.status === "pending" || r.status === "executed")
      .map((r: any) => `${r.pair}|${r.direction}`));
    const toInsert = merged.filter(s => !seen.has(`${s.pair}|${s.direction}`));
    if (toInsert.length) await supabase.from("signals").insert(toInsert);

    const day = new Date().toISOString().slice(0, 10);
    const { data: usage } = await supabase.from("api_usage").select("calls").eq("day", day).maybeSingle();
    const newCalls = (usage?.calls ?? 0) + apiCalls;
    await supabase.from("api_usage").upsert(
      { day, calls: newCalls, updated_at: new Date().toISOString() }, { onConflict: "day" });

    return new Response(JSON.stringify({
      signals, new_signals: toInsert.length,
      api_calls_used: apiCalls, api_calls_today: newCalls,
      budget_remaining: DAILY_BUDGET - newCalls, mode,
      errors, report, scanned_at: new Date().toISOString(),
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
