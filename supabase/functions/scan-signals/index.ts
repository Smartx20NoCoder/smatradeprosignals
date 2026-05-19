// ScalpEdge scan engine
// Fetches candles (with caching), runs 3 mechanical setups, AI quality filter, persists signals.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const PAIRS = ["EUR/USD", "GBP/USD", "USD/JPY", "GBP/JPY", "EUR/JPY", "GBP/CHF", "USD/CHF"];
const TFS = [
  { label: "5m", td: "5min" },
  { label: "15m", td: "15min" },
];
const CACHE_TTL_MIN = 10;
const DAILY_BUDGET = 800;
const OUTPUT_SIZE = 80;

type Candle = { t: number; o: number; h: number; l: number; c: number };

function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev = values[0];
  out.push(prev);
  for (let i = 1; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

function atr(c: Candle[], period = 14): number {
  if (c.length < period + 1) return 0;
  const trs: number[] = [];
  for (let i = 1; i < c.length; i++) {
    const tr = Math.max(
      c[i].h - c[i].l,
      Math.abs(c[i].h - c[i - 1].c),
      Math.abs(c[i].l - c[i - 1].c),
    );
    trs.push(tr);
  }
  const slice = trs.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function pipSize(pair: string): number {
  return pair.includes("JPY") ? 0.01 : 0.0001;
}

// Session score 0-100 based on UTC hour and pair
function sessionScore(pair: string, dUTC: Date): number {
  const h = dUTC.getUTCHours();
  // London 7-16, NY 12-21, overlap 12-16
  const isLondonNYOverlap = h >= 12 && h < 16;
  const isLondon = h >= 7 && h < 12;
  const isNY = h >= 16 && h < 21;
  const isAsian = h >= 0 && h < 7;
  if (isLondonNYOverlap) return 95;
  if (pair.includes("JPY") && isAsian) return 70;
  if (isLondon) return 85;
  if (isNY) return 80;
  if (isAsian) return 25; // dead for USD/GBP
  return 45;
}

// Static high-impact news windows (UTC HH:MM). Tradable economic events typically.
// Approximation: NFP first Friday 12:30, FOMC 18:00, BoE 11:00 Thu, ECB 12:15 Thu, CPI 12:30
function newsFlag(dUTC: Date, pair: string): boolean {
  const h = dUTC.getUTCHours();
  const m = dUTC.getUTCMinutes();
  const t = h * 60 + m;
  const windows = [
    { t: 12 * 60 + 30, ccy: ["USD"] }, // US data release window
    { t: 13 * 60 + 30, ccy: ["USD"] },
    { t: 18 * 60, ccy: ["USD"] }, // FOMC
    { t: 11 * 60, ccy: ["GBP"] }, // BoE
    { t: 12 * 60 + 15, ccy: ["EUR"] }, // ECB
    { t: 23 * 60 + 50, ccy: ["JPY"] }, // BoJ stats
  ];
  for (const w of windows) {
    if (Math.abs(t - w.t) <= 30 && w.ccy.some((c) => pair.includes(c))) return true;
  }
  return false;
}

async function fetchCandles(
  supabase: ReturnType<typeof createClient>,
  apiKey: string,
  pair: string,
  tf: { label: string; td: string },
): Promise<{ candles: Candle[]; usedApi: number }> {
  // cache check
  const { data: cached } = await supabase
    .from("candle_cache")
    .select("candles, fetched_at")
    .eq("pair", pair)
    .eq("timeframe", tf.label)
    .maybeSingle();
  if (cached) {
    const ageMin = (Date.now() - new Date(cached.fetched_at as string).getTime()) / 60000;
    if (ageMin < CACHE_TTL_MIN) {
      return { candles: cached.candles as Candle[], usedApi: 0 };
    }
  }
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(pair)}&interval=${tf.td}&outputsize=${OUTPUT_SIZE}&apikey=${apiKey}`;
  const r = await fetch(url);
  const j = await r.json();
  if (!j.values || !Array.isArray(j.values)) {
    throw new Error(`TwelveData error for ${pair} ${tf.label}: ${JSON.stringify(j).slice(0, 200)}`);
  }
  const candles: Candle[] = j.values
    .map((v: any) => ({
      t: new Date(v.datetime + "Z").getTime(),
      o: parseFloat(v.open),
      h: parseFloat(v.high),
      l: parseFloat(v.low),
      c: parseFloat(v.close),
    }))
    .reverse(); // ascending
  await supabase.from("candle_cache").upsert(
    { pair, timeframe: tf.label, candles, fetched_at: new Date().toISOString() },
    { onConflict: "pair,timeframe" },
  );
  return { candles, usedApi: 1 };
}

type Signal = {
  pair: string;
  timeframe: string;
  setup: string;
  direction: "Long" | "Short";
  entry: number;
  stop_loss: number;
  tp1: number;
  tp2: number;
  rr: number;
  session_score: number;
  confidence: number;
  atr: number;
  news_flag: boolean;
};

// Setup 1: EMA Pullback on 5m, aligned with 15m trend
function emaPullback(pair: string, c5: Candle[], c15: Candle[]): Signal | null {
  if (c5.length < 30 || c15.length < 30) return null;
  const closes5 = c5.map((x) => x.c);
  const closes15 = c15.map((x) => x.c);
  const ema9_5 = ema(closes5, 9);
  const ema21_5 = ema(closes5, 21);
  const ema21_15 = ema(closes15, 21);
  const ema50_15 = ema(closes15, 50);

  const last = c5[c5.length - 1];
  const prev = c5[c5.length - 2];
  const e9 = ema9_5.at(-1)!;
  const e21 = ema21_5.at(-1)!;
  const trendUp15 = ema21_15.at(-1)! > ema50_15.at(-1)!;
  const trendDown15 = ema21_15.at(-1)! < ema50_15.at(-1)!;
  const a = atr(c5);
  if (a === 0) return null;

  // confluence: |ema9-ema21|/atr < 0.3
  if (Math.abs(e9 - e21) / a > 0.3) return null;

  const touched = last.l <= Math.max(e9, e21) && last.h >= Math.min(e9, e21);
  const bullishCandle = last.c > last.o && last.c > prev.h;
  const bearishCandle = last.c < last.o && last.c < prev.l;

  if (trendUp15 && touched && bullishCandle) {
    const entry = last.c;
    const sl = Math.min(e21, last.l) - a * 0.3;
    const risk = entry - sl;
    if (risk <= 0) return null;
    const tp1 = entry + risk * 1.5;
    const tp2 = entry + risk * 3;
    return {
      pair,
      timeframe: "5m",
      setup: "EMA Pullback",
      direction: "Long",
      entry,
      stop_loss: sl,
      tp1,
      tp2,
      rr: 3,
      session_score: 0,
      confidence: 0,
      atr: a,
      news_flag: false,
    };
  }
  if (trendDown15 && touched && bearishCandle) {
    const entry = last.c;
    const sl = Math.max(e21, last.h) + a * 0.3;
    const risk = sl - entry;
    if (risk <= 0) return null;
    const tp1 = entry - risk * 1.5;
    const tp2 = entry - risk * 3;
    return {
      pair,
      timeframe: "5m",
      setup: "EMA Pullback",
      direction: "Short",
      entry,
      stop_loss: sl,
      tp1,
      tp2,
      rr: 3,
      session_score: 0,
      confidence: 0,
      atr: a,
      news_flag: false,
    };
  }
  return null;
}

// Setup 2: Break of Structure on 5m, aligned with 15m bias
function bos(pair: string, c5: Candle[], c15: Candle[]): Signal | null {
  if (c5.length < 30 || c15.length < 20) return null;
  const closes15 = c15.map((x) => x.c);
  const ema21_15 = ema(closes15, 21);
  const ema50_15 = ema(closes15, 50);
  const biasUp = ema21_15.at(-1)! > ema50_15.at(-1)!;
  const biasDown = ema21_15.at(-1)! < ema50_15.at(-1)!;
  const a = atr(c5);
  if (a === 0) return null;

  // Find swing high/low in last 20 candles (excl. last 3)
  const lookback = c5.slice(-23, -3);
  if (lookback.length < 10) return null;
  const swingHigh = Math.max(...lookback.map((x) => x.h));
  const swingLow = Math.min(...lookback.map((x) => x.l));

  const recent = c5.slice(-3);
  const last = c5.at(-1)!;
  const brokeHigh = recent.some((x) => x.c > swingHigh);
  const brokeLow = recent.some((x) => x.c < swingLow);

  // Retest: current candle wicks back near broken level
  if (biasUp && brokeHigh) {
    const retest = last.l <= swingHigh + a * 0.2 && last.c > swingHigh;
    if (!retest) return null;
    const entry = last.c;
    const sl = swingHigh - a * 0.8;
    const risk = entry - sl;
    if (risk <= 0) return null;
    return {
      pair, timeframe: "5m", setup: "BOS Retest", direction: "Long",
      entry, stop_loss: sl, tp1: entry + risk * 1.5, tp2: entry + risk * 3,
      rr: 3, session_score: 0, confidence: 0, atr: a, news_flag: false,
    };
  }
  if (biasDown && brokeLow) {
    const retest = last.h >= swingLow - a * 0.2 && last.c < swingLow;
    if (!retest) return null;
    const entry = last.c;
    const sl = swingLow + a * 0.8;
    const risk = sl - entry;
    if (risk <= 0) return null;
    return {
      pair, timeframe: "5m", setup: "BOS Retest", direction: "Short",
      entry, stop_loss: sl, tp1: entry - risk * 1.5, tp2: entry - risk * 3,
      rr: 3, session_score: 0, confidence: 0, atr: a, news_flag: false,
    };
  }
  return null;
}

// Setup 3: Session Range Break (London 7-8 UTC range, NY 13-14 UTC range)
function sessionRangeBreak(pair: string, c5: Candle[]): Signal | null {
  if (c5.length < 30) return null;
  const a = atr(c5);
  if (a === 0) return null;
  const now = new Date();
  const hUTC = now.getUTCHours();
  // Determine active session opening range
  let rangeStartH: number | null = null;
  if (hUTC >= 8 && hUTC < 11) rangeStartH = 7; // London open range
  else if (hUTC >= 14 && hUTC < 17) rangeStartH = 13; // NY open range
  if (rangeStartH === null) return null;

  // Take candles from rangeStartH to rangeStartH+1 UTC today
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const rStart = today.getTime() + rangeStartH * 3600_000;
  const rEnd = rStart + 3600_000;
  const rangeCandles = c5.filter((x) => x.t >= rStart && x.t < rEnd);
  if (rangeCandles.length < 6) return null;
  const rh = Math.max(...rangeCandles.map((x) => x.h));
  const rl = Math.min(...rangeCandles.map((x) => x.l));
  const rangeSize = rh - rl;
  if (rangeSize > a * 3) return null; // range too wide already

  const after = c5.filter((x) => x.t >= rEnd);
  if (after.length === 0) return null;
  const last = after.at(-1)!;
  // expansion: candle body > 0.6*ATR and closes beyond level
  const body = Math.abs(last.c - last.o);
  if (body < a * 0.6) return null;

  if (last.c > rh) {
    const entry = last.c;
    const sl = rl;
    const risk = entry - sl;
    if (risk <= 0 || risk > a * 4) return null;
    return {
      pair, timeframe: "5m", setup: "Session Range Break", direction: "Long",
      entry, stop_loss: sl, tp1: entry + risk * 1.5, tp2: entry + risk * 2.5,
      rr: 2.5, session_score: 0, confidence: 0, atr: a, news_flag: false,
    };
  }
  if (last.c < rl) {
    const entry = last.c;
    const sl = rh;
    const risk = sl - entry;
    if (risk <= 0 || risk > a * 4) return null;
    return {
      pair, timeframe: "5m", setup: "Session Range Break", direction: "Short",
      entry, stop_loss: sl, tp1: entry - risk * 1.5, tp2: entry - risk * 2.5,
      rr: 2.5, session_score: 0, confidence: 0, atr: a, news_flag: false,
    };
  }
  return null;
}

function qualifyAndScore(s: Signal, pair: string, c5: Candle[]): Signal | null {
  const now = new Date();
  const ss = sessionScore(pair, now);
  const news = newsFlag(now, pair);
  const a = atr(c5);
  // ATR volatility filter: skip if ATR too low (chop)
  const ps = pipSize(pair);
  const atrPips = a / ps;
  const minAtr = pair.includes("JPY") ? 4 : 4; // pips
  if (atrPips < minAtr) return null;

  // Confidence: base 50, +session/2, -news 15, +rr*5
  let conf = 50 + Math.floor(ss / 3) + Math.floor(s.rr * 4);
  if (news) conf -= 15;
  conf = Math.max(0, Math.min(99, conf));

  return { ...s, session_score: ss, news_flag: news, confidence: conf };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const tdKey = Deno.env.get("TWELVE_DATA_API_KEY");
    if (!tdKey) throw new Error("TWELVE_DATA_API_KEY not configured");
    const supabase = createClient(supabaseUrl, serviceKey);

    let apiCalls = 0;
    const signals: Signal[] = [];
    const errors: string[] = [];

    for (const pair of PAIRS) {
      try {
        const [r5, r15] = await Promise.all([
          fetchCandles(supabase, tdKey, pair, TFS[0]),
          fetchCandles(supabase, tdKey, pair, TFS[1]),
        ]);
        apiCalls += r5.usedApi + r15.usedApi;
        const c5 = r5.candles;
        const c15 = r15.candles;
        const raw = [
          emaPullback(pair, c5, c15),
          bos(pair, c5, c15),
          sessionRangeBreak(pair, c5),
        ].filter(Boolean) as Signal[];
        for (const r of raw) {
          const q = qualifyAndScore(r, pair, c5);
          if (q && q.confidence >= 55) signals.push(q);
        }
      } catch (e) {
        errors.push(`${pair}: ${(e as Error).message}`);
      }
    }

    // Persist signals (dedupe vs last 60min same pair+setup+direction)
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { data: recent } = await supabase
      .from("signals")
      .select("pair, setup, direction")
      .gte("created_at", since);
    const seen = new Set((recent ?? []).map((r: any) => `${r.pair}|${r.setup}|${r.direction}`));
    const toInsert = signals.filter((s) => !seen.has(`${s.pair}|${s.setup}|${s.direction}`));
    if (toInsert.length) {
      await supabase.from("signals").insert(toInsert);
    }

    // Update api_usage
    const day = new Date().toISOString().slice(0, 10);
    const { data: usage } = await supabase
      .from("api_usage")
      .select("calls")
      .eq("day", day)
      .maybeSingle();
    const newCalls = (usage?.calls ?? 0) + apiCalls;
    await supabase
      .from("api_usage")
      .upsert({ day, calls: newCalls, updated_at: new Date().toISOString() }, { onConflict: "day" });

    return new Response(
      JSON.stringify({
        signals,
        new_signals: toInsert.length,
        api_calls_used: apiCalls,
        api_calls_today: newCalls,
        budget_remaining: DAILY_BUDGET - newCalls,
        errors,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
