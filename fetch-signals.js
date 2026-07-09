// PipSight Robot — signal engine (24/7 server-side)
// -----------------------------------------------------------------------
// This is a faithful port of the exact same decision engine used in
// pipsight.html (EMA stack, RSI/MACD confirmation, S/R, ATR-style stop,
// Risk:Reward >= 1:2). Running it here means BUY/SELL signals get
// generated and logged on a schedule — independent of whether anyone has
// the site open, and independent of any one device.
//
// Outputs:
//   data/signals.json     — current signal snapshot per pair+mode
//   data/signal-log.json  — persistent history of every signal ever
//                           issued, with real outcomes resolved against
//                           later prices (same "close crossed stop or
//                           TP1 first" rule the site already uses)
// -----------------------------------------------------------------------

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "data");
const GOLD_HISTORY_PATH = path.join(DATA_DIR, "xau-usd-history.json");
const NEWS_FEED_PATH = path.join(DATA_DIR, "news-feed.json");
const SIGNALS_OUT_PATH = path.join(DATA_DIR, "signals.json");
const LOG_OUT_PATH = path.join(DATA_DIR, "signal-log.json");

const PAIRS = [
  { type: "metal", symbol: "XAU", quote: "USD", label: "XAU/USD" },
  { type: "forex", base: "GBP", quote: "JPY", label: "GBP/JPY" },
];
const MODES = ["daily", "weekly"];

// ---------------------------------------------------------------- helpers
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function decimalsFor(pair) {
  if (pair.type === "metal") return 2;
  if (pair.quote === "JPY") return 3;
  return 4;
}

function emaSeries(values, period) {
  const k = 2 / (period + 1); const out = []; let prev = null;
  for (let i = 0; i < values.length; i++) {
    if (i === period - 1) { const seed = values.slice(0, period).reduce((a, b) => a + b, 0) / period; prev = seed; out.push(seed); }
    else if (i < period - 1) { out.push(null); }
    else { prev = values[i] * k + prev * (1 - k); out.push(prev); }
  }
  return out;
}

function rsiSeries(values, period = 14) {
  const out = new Array(values.length).fill(null);
  let gainSum = 0, lossSum = 0;
  for (let i = 1; i <= period; i++) { const d = values[i] - values[i - 1]; if (d >= 0) gainSum += d; else lossSum -= d; }
  let avgGain = gainSum / period, avgLoss = lossSum / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1]; const g = d > 0 ? d : 0; const l = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + g) / period; avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

function computeVolatility(rows) {
  const closes = rows.map(r => r.close);
  const n = closes.length;
  if (n < 3) return 0.004;
  let sum = 0, count = 0;
  for (let i = 1; i < n; i++) { sum += Math.abs(closes[i] - closes[i - 1]) / closes[i - 1]; count++; }
  return sum / count;
}

function computeSR(rows, lastClose) {
  const closes = rows.map(r => r.close);
  const n = closes.length;
  const radius = n > 40 ? 2 : 1;
  const highs = [], lows = [];
  for (let i = radius; i < n - radius; i++) {
    let isHigh = true, isLow = true;
    for (let k = 1; k <= radius; k++) {
      if (closes[i] < closes[i - k] || closes[i] < closes[i + k]) isHigh = false;
      if (closes[i] > closes[i - k] || closes[i] > closes[i + k]) isLow = false;
    }
    if (isHigh) highs.push(closes[i]);
    if (isLow) lows.push(closes[i]);
  }
  function dedupe(levels) {
    const sorted = [...levels].sort((a, b) => a - b);
    const out = [];
    for (const v of sorted) {
      if (!out.length || Math.abs(v - out[out.length - 1]) / v > 0.0015) out.push(v);
      else out[out.length - 1] = (out[out.length - 1] + v) / 2;
    }
    return out;
  }
  let resistances = dedupe(highs).filter(h => h > lastClose).sort((a, b) => a - b).slice(0, 2);
  let supports = dedupe(lows).filter(l => l < lastClose).sort((a, b) => b - a).slice(0, 2);
  if (resistances.length === 0 && n >= 3) {
    const maxClose = Math.max(...closes);
    if (maxClose > lastClose * 1.0005) resistances = [maxClose];
  }
  if (supports.length === 0 && n >= 3) {
    const minClose = Math.min(...closes);
    if (minClose < lastClose * 0.9995) supports = [minClose];
  }
  return { resistances, supports };
}

function computeMarketStructure(rows) {
  const closes = rows.map(r => r.close);
  const n = closes.length;
  if (n < 10) return { label: "Building history — not enough sessions yet", score: 0 };
  const radius = n > 60 ? 3 : (n > 30 ? 2 : 1);
  const highs = [], lows = [];
  for (let i = radius; i < n - radius; i++) {
    let isHigh = true, isLow = true;
    for (let k = 1; k <= radius; k++) {
      if (closes[i] < closes[i - k] || closes[i] < closes[i + k]) isHigh = false;
      if (closes[i] > closes[i - k] || closes[i] > closes[i + k]) isLow = false;
    }
    if (isHigh) highs.push(closes[i]);
    if (isLow) lows.push(closes[i]);
  }
  if (highs.length < 2 || lows.length < 2) return { label: "Not enough swing points yet", score: 0 };
  const h2 = highs.slice(-2), l2 = lows.slice(-2);
  const higherHigh = h2[1] > h2[0];
  const higherLow = l2[1] > l2[0];
  if (higherHigh && higherLow) return { label: "Bullish structure — higher highs & higher lows", score: 15 };
  if (!higherHigh && !higherLow) return { label: "Bearish structure — lower highs & lower lows", score: -15 };
  return { label: "Mixed structure — no clear HH/HL or LH/LL sequence", score: 0 };
}

// Same decision engine as pipsight.html's analyze() — kept in lockstep.
function analyze(rows, pairLabel, newsScoreRaw) {
  const closes = rows.map(r => r.close);
  const n = closes.length;
  const lastClose = closes[n - 1];
  const pipeline = [];
  let alive = true;

  function pass(name, ok, detail) {
    if (!alive) { pipeline.push({ name, status: "skip", detail: "Not reached — an earlier required step failed" }); return false; }
    pipeline.push({ name, status: ok ? "pass" : "fail", detail });
    if (!ok) alive = false;
    return ok;
  }
  function na(name, detail) { pipeline.push({ name, status: "na", detail }); }

  let emaInfo = null, leanDirection = null, trendLabel = "Building history — not enough sessions yet";
  if (n >= 6) {
    const cap = n - 1;
    const p200 = Math.min(200, cap);
    const p100 = Math.min(100, Math.max(4, Math.floor(p200 * 0.5)));
    const p50 = Math.min(50, Math.max(3, Math.floor(p100 * 0.6)));
    const p20 = Math.min(20, Math.max(2, Math.floor(p50 * 0.5)));
    const e20 = emaSeries(closes, p20), e50 = emaSeries(closes, p50), e100 = emaSeries(closes, p100), e200 = emaSeries(closes, p200);
    const last = n - 1;
    const v20 = e20[last], v50 = e50[last], v100 = e100[last], v200 = e200[last];
    const fullStack = cap >= 200;
    const note = fullStack ? "" : " (adaptive periods — full EMA200 needs more history)";
    emaInfo = { p20, p50, p100, p200, fullStack };
    if (v20 != null && v50 != null && v100 != null && v200 != null) {
      const bullFull = v20 > v50 && v50 > v100 && v100 > v200 && lastClose > v20;
      const bearFull = v20 < v50 && v50 < v100 && v100 < v200 && lastClose < v20;
      const bullCount = [v20 > v50, v50 > v100, v100 > v200, lastClose > v20].filter(Boolean).length;
      const bearCount = [v20 < v50, v50 < v100, v100 < v200, lastClose < v20].filter(Boolean).length;
      if (bullFull) { leanDirection = "BUY"; trendLabel = `Bullish — full EMA stack ${p20}>${p50}>${p100}>${p200}${note}`; }
      else if (bearFull) { leanDirection = "SELL"; trendLabel = `Bearish — full EMA stack ${p20}<${p50}<${p100}<${p200}${note}`; }
      else if (bullCount >= 3) { trendLabel = `Partial bullish lean only (${bullCount}/4) — not enough to qualify${note}`; }
      else if (bearCount >= 3) { trendLabel = `Partial bearish lean only (${bearCount}/4) — not enough to qualify${note}`; }
      else { trendLabel = `Mixed EMA alignment — no clear trend${note}`; }
    }
  }
  pass("Trend", !!leanDirection, trendLabel);
  pass("EMA Alignment", !!leanDirection,
    leanDirection ? `Full EMA stack confirms ${leanDirection === "BUY" ? "bullish" : "bearish"} alignment` : "Stack is not fully aligned in order");
  na("ADX > 25?", "Not available — true ADX needs high/low candle data, which this close-price-only source doesn't provide");
  na("Volume Confirmed?", "Not available — spot FX/gold has no centralized exchange volume feed");

  const macdOk = n >= 35;
  let lastMacd = null, lastMacdSignal = null;
  if (macdOk) {
    const ema12 = emaSeries(closes, 12), ema26 = emaSeries(closes, 26);
    const macdLine = closes.map((_, i) => (ema12[i] != null && ema26[i] != null) ? ema12[i] - ema26[i] : null);
    const macdVals = macdLine.filter(v => v != null);
    const sig = emaSeries(macdVals, 9);
    lastMacd = macdLine[n - 1];
    lastMacdSignal = sig[sig.length - 1];
  }
  let macdDetail, macdPassVal = false;
  if (!leanDirection) { macdDetail = "No confirmed trend direction to test against"; }
  else if (!macdOk) { macdDetail = `Needs ${35 - n} more session${35 - n === 1 ? "" : "s"} of history for MACD`; }
  else {
    macdPassVal = leanDirection === "BUY" ? lastMacd > lastMacdSignal : lastMacd < lastMacdSignal;
    macdDetail = `MACD ${lastMacd.toFixed(4)} vs signal ${lastMacdSignal.toFixed(4)} — ${macdPassVal ? "confirms" : "does not confirm"} ${leanDirection}`;
  }
  pass("MACD Confirmation", leanDirection ? (macdOk && macdPassVal) : false, macdDetail);

  const rsiP = Math.min(14, Math.max(4, n - 2));
  const rsi = rsiSeries(closes, rsiP);
  const lastRsi = rsi[n - 1];
  const rsiBuyOk = lastRsi != null && lastRsi >= 45 && lastRsi <= 65;
  const rsiSellOk = lastRsi != null && lastRsi >= 35 && lastRsi <= 55;
  let rsiDetail, rsiPassVal = false;
  if (!leanDirection) { rsiDetail = "No confirmed trend direction to test against"; }
  else if (lastRsi == null) { rsiDetail = "Not enough history for RSI yet"; }
  else {
    rsiPassVal = leanDirection === "BUY" ? rsiBuyOk : rsiSellOk;
    rsiDetail = `RSI(${rsiP}) = ${lastRsi.toFixed(1)} — ${rsiPassVal ? "inside" : "outside"} the ${leanDirection === "BUY" ? "45–65" : "35–55"} confirmation band`;
  }
  pass("RSI Confirmation", leanDirection ? (lastRsi != null && rsiPassVal) : false, rsiDetail);
  na("Candle Pattern", "Not available — only daily close prices here, no open/high/low candle data");

  const sr = computeSR(rows, lastClose);
  let srDetail, srPassVal = false;
  if (!leanDirection) { srDetail = "No confirmed trend direction to test against"; }
  else if (leanDirection === "BUY") {
    const res = sr.resistances[0];
    if (res == null) { srPassVal = true; srDetail = "No resistance detected nearby"; }
    else {
      const d = (res - lastClose) / lastClose;
      srPassVal = d >= 0.003;
      srDetail = srPassVal ? `Resistance ${(d * 100).toFixed(2)}% away — clear room to run` : `Resistance only ${(d * 100).toFixed(2)}% above spot — too close to buy into`;
    }
  } else {
    const sup = sr.supports[0];
    if (sup == null) { srPassVal = true; srDetail = "No support detected nearby"; }
    else {
      const d = (lastClose - sup) / lastClose;
      srPassVal = d >= 0.003;
      srDetail = srPassVal ? `Support ${(d * 100).toFixed(2)}% away — clear room to run` : `Support only ${(d * 100).toFixed(2)}% below spot — too close to sell into`;
    }
  }
  pass("Support/Resistance", leanDirection ? srPassVal : false, srDetail);

  const vol = computeVolatility(rows);
  const buffer = Math.max(vol * 0.5, 0.0004) * lastClose;
  if (leanDirection && alive) {
    pipeline.push({ name: "ATR-style Stop Loss", status: "pass", detail: `Volatility-based buffer ≈ ${buffer.toFixed(lastClose > 100 ? 2 : 5)} (avg daily move ${(vol * 100).toFixed(2)}%)` });
  } else if (leanDirection) {
    pipeline.push({ name: "ATR-style Stop Loss", status: "skip", detail: "Not reached — an earlier required step failed" });
  } else {
    pipeline.push({ name: "ATR-style Stop Loss", status: "skip", detail: "No confirmed trend direction yet" });
  }

  let tradePlan = null, rrDetail = "No confirmed trend direction yet";
  if (leanDirection && alive) {
    const sup = sr.supports[0], res = sr.resistances[0];
    let stop, target1, target2, target3, risk;
    if (leanDirection === "BUY") {
      stop = sup != null ? sup - buffer : lastClose - buffer * 3;
      risk = lastClose - stop;
      target1 = res != null ? res : lastClose + risk * 2;
      target2 = Math.max(target1, lastClose + risk * 3);
      target3 = Math.max(target2, lastClose + risk * 4);
    } else {
      stop = res != null ? res + buffer : lastClose + buffer * 3;
      risk = stop - lastClose;
      target1 = sup != null ? sup : lastClose - risk * 2;
      target2 = Math.min(target1, lastClose - risk * 3);
      target3 = Math.min(target2, lastClose - risk * 4);
    }
    risk = Math.abs(lastClose - stop);
    const reward1 = Math.abs(target1 - lastClose);
    const rr = risk > 0 ? reward1 / risk : 0;
    const rrOk = pass("Risk:Reward ≥ 1:2", rr >= 2, `Risk:Reward to TP1 = 1:${rr.toFixed(1)} — ${rr >= 2 ? "meets" : "below"} the 1:2 minimum`);
    if (rrOk) { tradePlan = { direction: leanDirection, entry: lastClose, stop, target1, target2, target3, risk, rr }; }
  } else {
    pass("Risk:Reward ≥ 1:2", false, rrDetail);
  }

  const signal = tradePlan ? tradePlan.direction : "HOLD";
  const failedStep = pipeline.find(p => p.status === "fail");
  const suppressionReason = signal === "HOLD"
    ? (leanDirection ? `NO TRADE — stopped at "${failedStep ? failedStep.name : "an earlier step"}"` : "NO TRADE — no confirmed trend direction yet")
    : null;

  const structure = computeMarketStructure(rows);
  const newsScore = clamp(newsScoreRaw || 0, -10, 10);
  const gatedSteps = pipeline.filter(p => p.status === "pass" || p.status === "fail");
  const passCount = gatedSteps.filter(p => p.status === "pass").length;

  return { lastClose, n, pipeline, trendLabel, leanDirection, structure, sr, newsScore, signal, suppressionReason, tradePlan, passCount, gatedCount: gatedSteps.length };
}

// ---------------------------------------------------------- weekly resample
function isoWeekKey(dateStr) {
  const d = new Date(dateStr + "T00:00:00Z");
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const fdDay = (firstThursday.getUTCDay() + 6) % 7;
  const week = 1 + Math.round(((d - firstThursday) / 86400000 - 3 + fdDay) / 7);
  return d.getUTCFullYear() + "-W" + String(week).padStart(2, "0");
}
function resampleWeekly(rows) {
  const map = new Map();
  for (const r of rows) { map.set(isoWeekKey(r.date), r); }
  return Array.from(map.values());
}
function rowsForMode(rows, mode) { return mode === "weekly" ? resampleWeekly(rows) : rows; }

// -------------------------------------------------------------- data fetch
async function fetchForexRows(pair) {
  const end = new Date();
  const start = new Date(); start.setDate(start.getDate() - 420);
  const fmt = d => d.toISOString().slice(0, 10);
  const url = `https://api.frankfurter.dev/v1/${fmt(start)}..${fmt(end)}?base=${pair.base}&symbols=${pair.quote}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Rate service unavailable (" + res.status + ")");
  const data = await res.json();
  const dates = Object.keys(data.rates).sort();
  return dates.map(d => ({ date: d, close: data.rates[d][pair.quote] }));
}

function readGoldHistory() {
  if (!fs.existsSync(GOLD_HISTORY_PATH)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(GOLD_HISTORY_PATH, "utf8"));
    return Array.isArray(raw) ? raw.filter(r => r && typeof r.date === "string" && typeof r.close === "number") : [];
  } catch (e) { return []; }
}

function readNewsSentiment() {
  if (!fs.existsSync(NEWS_FEED_PATH)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(NEWS_FEED_PATH, "utf8"));
    const items = Array.isArray(raw.items) ? raw.items : [];
    return items.reduce((acc, n) => { acc[n.pair] = (acc[n.pair] || 0) + n.sentiment; return acc; }, {});
  } catch (e) { return {}; }
}

// --------------------------------------------------------------- log logic
function loadJson(p, fallback) {
  if (!fs.existsSync(p)) return fallback;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { return fallback; }
}

function logSignalIfNew(log, pairLabel, mode, a) {
  if (!a.tradePlan) return log;
  const last = [...log].reverse().find(e => e.pair === pairLabel && e.mode === mode);
  if (last && !last.status && last.signal === a.tradePlan.direction) return log; // unchanged open call
  log.push({
    ts: new Date().toISOString(),
    pair: pairLabel, mode,
    signal: a.tradePlan.direction,
    entry: a.tradePlan.entry, stop: a.tradePlan.stop, tp1: a.tradePlan.target1, rr: a.tradePlan.rr,
    status: null, closedAt: null, closePrice: null,
  });
  return log.length > 500 ? log.slice(log.length - 500) : log;
}

function resolveLogOutcomes(log, pairLabel, mode, rows) {
  return log.map(e => {
    if (e.pair !== pairLabel || e.mode !== mode || e.status) return e;
    const entryDate = e.ts.slice(0, 10);
    const future = rows.filter(r => r.date > entryDate);
    for (const r of future) {
      if (e.signal === "BUY") {
        if (r.close <= e.stop) { e.status = "LOSS"; e.closedAt = r.date; e.closePrice = r.close; break; }
        if (r.close >= e.tp1) { e.status = "WIN"; e.closedAt = r.date; e.closePrice = r.close; break; }
      } else {
        if (r.close >= e.stop) { e.status = "LOSS"; e.closedAt = r.date; e.closePrice = r.close; break; }
        if (r.close <= e.tp1) { e.status = "WIN"; e.closedAt = r.date; e.closePrice = r.close; break; }
      }
    }
    return e;
  });
}

// ------------------------------------------------------------------- main
async function main() {
  const newsSentiment = readNewsSentiment();
  let log = loadJson(LOG_OUT_PATH, []);
  const snapshot = [];

  for (const pair of PAIRS) {
    let rawRows;
    try {
      rawRows = pair.type === "metal" ? readGoldHistory() : await fetchForexRows(pair);
    } catch (e) {
      console.error(`Fetch failed for ${pair.label}:`, e.message);
      continue;
    }
    if (!rawRows.length || rawRows.length < 10) {
      console.log(`Skipping ${pair.label} — not enough history yet (${rawRows.length} rows)`);
      continue;
    }

    for (const mode of MODES) {
      const rows = rowsForMode(rawRows, mode);
      if (mode === "weekly" && rows.length < 8) continue;
      const a = analyze(rows, pair.label, newsSentiment[pair.label]);

      log = logSignalIfNew(log, pair.label, mode, a);
      log = resolveLogOutcomes(log, pair.label, mode, rows);

      snapshot.push({
        pair: pair.label, mode,
        decimals: decimalsFor(pair),
        lastClose: a.lastClose,
        signal: a.signal,
        suppressionReason: a.suppressionReason,
        tradePlan: a.tradePlan,
        passCount: a.passCount, gatedCount: a.gatedCount,
        trendLabel: a.trendLabel,
        structure: a.structure.label,
        sr: a.sr,
      });
    }
  }

  const out = { updatedAt: new Date().toISOString(), signals: snapshot };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SIGNALS_OUT_PATH, JSON.stringify(out, null, 2));
  fs.writeFileSync(LOG_OUT_PATH, JSON.stringify(log, null, 2));
  console.log(`Wrote ${snapshot.length} signal snapshots and ${log.length} log entries.`);
}

main().catch(e => { console.error(e); process.exit(1); });
