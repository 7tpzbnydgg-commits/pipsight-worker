// PipSight Robot — signal engine with improved scalping
const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "data");
const GOLD_HISTORY_PATH = path.join(DATA_DIR, "xau-usd-history.json");
const SCALP_CANDLES_PATH = path.join(DATA_DIR, "scalp-candles.json");
const NEWS_FEED_PATH = path.join(DATA_DIR, "news-feed.json");
const SIGNALS_OUT_PATH = path.join(DATA_DIR, "signals.json");
const LOG_OUT_PATH = path.join(DATA_DIR, "signal-log.json");

const PAIRS = [
  { type: "metal", symbol: "XAU", quote: "USD", label: "XAU/USD" },
  { type: "forex", base: "GBP", quote: "JPY", label: "GBP/JPY" },
];

let LAST_SCALP_SIGNAL = {};

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
  return { resistances, supports };
}

function computeMarketStructure(rows) {
  const closes = rows.map(r => r.close);
  const n = closes.length;
  if (n < 10) return { label: "Building history", score: 0 };
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
  if (highs.length < 2 || lows.length < 2) return { label: "Not enough swing points", score: 0 };
  const h2 = highs.slice(-2), l2 = lows.slice(-2);
  if (h2[1] > h2[0] && l2[1] > l2[0]) return { label: "Bullish structure", score: 15 };
  if (h2[1] < h2[0] && l2[1] < l2[0]) return { label: "Bearish structure", score: -15 };
  return { label: "Mixed structure", score: 0 };
}

// ===== SCALPING ENGINE (IMPROVED) =====
function calculateRSI(candles, period = 14) {
  if (candles.length < period + 1) return [];
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = candles[candles.length - i].close - candles[candles.length - i - 1].close;
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  if (avgLoss === 0) return [100];
  const rs = avgGain / avgLoss;
  const rsi = 100 - (100 / (1 + rs));
  return [rsi];
}

function shouldSkipDueToRecency(pairKey, currentPrice, decimals) {
  const last = LAST_SCALP_SIGNAL[pairKey];
  if (!last) return false;
  const timeSinceLastSignal = Date.now() - last.time;
  const pipDistance = Math.abs(currentPrice - last.price) / Math.pow(10, -decimals);
  if (timeSinceLastSignal < 900000 && pipDistance < 15) return true;
  return false;
}

function calculateATR(candles, period = 14) {
  if (candles.length < period) return 0;
  let trSum = 0;
  const last20 = candles.slice(-period);
  for (const candle of last20) {
    const tr = Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - candle.close),
      Math.abs(candle.low - candle.close)
    );
    trSum += tr;
  }
  return trSum / period;
}

function computeScalpTradeSignal(candles5m, decimals) {
  if (!candles5m || candles5m.length < 30) {
    return { decision: "HOLD", strength: 0, reason: "insufficient_data", rsi: null };
  }
  
  const last20 = candles5m.slice(-20);
  const last5 = candles5m.slice(-5);
  
  let bullCount = 0, bearCount = 0, bullStrength = 0, bearStrength = 0;
  
  for (const candle of last5) {
    const bodySize = Math.abs(candle.close - candle.open);
    if (candle.close > candle.open) {
      bullCount++;
      bullStrength += bodySize;
    } else {
      bearCount++;
      bearStrength += bodySize;
    }
  }
  
  const rsi = calculateRSI(last20);
  const latestRSI = rsi[0] || 50;
  
  if (latestRSI < 20 || latestRSI > 80) {
    return { decision: "HOLD", strength: 0, reason: "extreme_rsi", rsi: latestRSI };
  }
  
  const avgCandle = last20.reduce((sum, c) => sum + Math.abs(c.close - c.open), 0) / 20;
  const significantBears = last5.filter(c => c.close < c.open && Math.abs(c.close - c.open) > avgCandle * 0.8).length;
  const significantBulls = last5.filter(c => c.close > c.open && Math.abs(c.close - c.open) > avgCandle * 0.8).length;
  
  if (bearCount >= 3 && bearStrength > bullStrength * 1.3 && significantBears >= 2 && latestRSI < 70 && latestRSI > 30) {
    return { decision: "SELL", strength: bearStrength / bullStrength, reason: "strong_bear_momentum", rsi: latestRSI };
  }
  
  if (bullCount >= 3 && bullStrength > bearStrength * 1.3 && significantBulls >= 2 && latestRSI < 70 && latestRSI > 30) {
    return { decision: "BUY", strength: bullStrength / bearStrength, reason: "strong_bull_momentum", rsi: latestRSI };
  }
  
  return { decision: "HOLD", strength: 0, reason: "insufficient_momentum", rsi: latestRSI };
}

function computeDynamicTPSL(entryPrice, signal, candles5m) {
  const atr = calculateATR(candles5m);
  if (signal === "SELL") {
    return { stopLoss: entryPrice + (atr * 1.0), takeProfit: entryPrice - (atr * 1.5), riskReward: 1.5 };
  } else if (signal === "BUY") {
    return { stopLoss: entryPrice - (atr * 1.0), takeProfit: entryPrice + (atr * 1.5), riskReward: 1.5 };
  }
  return null;
}

function recordScalpSignal(pairKey, decision, entryPrice) {
  LAST_SCALP_SIGNAL[pairKey] = { signal: decision, price: entryPrice, time: Date.now() };
}

function computeScalpTradeSignalWithConfirmation(pairKey, decimals, candles5m) {
  if (!candles5m || candles5m.length < 30) {
    return { decision: "HOLD", available: false };
  }
  
  if (shouldSkipDueToRecency(pairKey, candles5m[candles5m.length - 1].close, decimals)) {
    return { decision: "HOLD", available: true, reason: "cooldown_active" };
  }
  
  const signal5m = computeScalpTradeSignal(candles5m, decimals);
  
  if (signal5m.decision !== "HOLD") {
    const tpsl = computeDynamicTPSL(candles5m[candles5m.length - 1].close, signal5m.decision, candles5m);
    recordScalpSignal(pairKey, signal5m.decision, candles5m[candles5m.length - 1].close);
    
    return {
      decision: signal5m.decision,
      available: true,
      strength: signal5m.strength,
      rsi: signal5m.rsi,
      tpsl: tpsl
    };
  }
  
  return { decision: "HOLD", available: true };
}

// ===== STANDARD LOGIC =====
function analyze(rows, pairLabel) {
  const closes = rows.map(r => r.close);
  const n = closes.length;
  const lastClose = closes[n - 1];
  
  let leanDirection = null;
  
  if (n >= 6) {
    const cap = n - 1;
    const p200 = Math.min(200, cap);
    const p100 = Math.min(100, Math.max(4, Math.floor(p200 * 0.5)));
    const p50 = Math.min(50, Math.max(3, Math.floor(p100 * 0.6)));
    const p20 = Math.min(20, Math.max(2, Math.floor(p50 * 0.5)));
    const e20 = emaSeries(closes, p20), e50 = emaSeries(closes, p50), e100 = emaSeries(closes, p100), e200 = emaSeries(closes, p200);
    const last = n - 1;
    const v20 = e20[last], v50 = e50[last], v100 = e100[last], v200 = e200[last];
    
    if (v20 != null && v50 != null && v100 != null && v200 != null) {
      const bullFull = v20 > v50 && v50 > v100 && v100 > v200 && lastClose > v20;
      const bearFull = v20 < v50 && v50 < v100 && v100 < v200 && lastClose < v20;
      if (bullFull) leanDirection = "BUY";
      else if (bearFull) leanDirection = "SELL";
    }
  }
  
  const rsiP = Math.min(14, Math.max(4, n - 2));
  const rsi = rsiSeries(closes, rsiP);
  const lastRsi = rsi[n - 1];
  
  let signal = "HOLD", tradePlan = null;
  
  if (leanDirection) {
    const rsiBuyOk = lastRsi != null && lastRsi >= 45 && lastRsi <= 65;
    const rsiSellOk = lastRsi != null && lastRsi >= 35 && lastRsi <= 55;
    const rsiOk = leanDirection === "BUY" ? rsiBuyOk : rsiSellOk;
    
    if (rsiOk) {
      const sr = computeSR(rows, lastClose);
      const vol = computeVolatility(rows);
      const buffer = Math.max(vol * 0.5, 0.0004) * lastClose;
      
      const sup = sr.supports[0], res = sr.resistances[0];
      let stop, target1, risk;
      
      if (leanDirection === "BUY") {
        stop = sup != null ? sup - buffer : lastClose - buffer * 3;
        risk = lastClose - stop;
        target1 = res != null ? res : lastClose + risk * 2;
      } else {
        stop = res != null ? res + buffer : lastClose + buffer * 3;
        risk = stop - lastClose;
        target1 = sup != null ? sup : lastClose - risk * 2;
      }
      
      risk = Math.abs(lastClose - stop);
      const reward1 = Math.abs(target1 - lastClose);
      const rr = risk > 0 ? reward1 / risk : 0;
      
      if (rr >= 2) {
        signal = leanDirection;
        tradePlan = { direction: leanDirection, entry: lastClose, stop, target1, risk, rr };
      }
    }
  }
  
  return { lastClose, signal, tradePlan };
}

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

async function fetchForexRows(pair) {
  const end = new Date();
  const start = new Date(); start.setDate(start.getDate() - 420);
  const fmt = d => d.toISOString().slice(0, 10);
  const url = `https://api.frankfurter.dev/v1/${fmt(start)}..${fmt(end)}?base=${pair.base}&symbols=${pair.quote}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Rate service unavailable");
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

function readScalpCandles() {
  if (!fs.existsSync(SCALP_CANDLES_PATH)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(SCALP_CANDLES_PATH, "utf8"));
    return raw || {};
  } catch (e) { return {}; }
}

function loadJson(p, fallback) {
  if (!fs.existsSync(p)) return fallback;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { return fallback; }
}

async function main() {
  const scalpCandles = readScalpCandles();
  let snapshot = [];

  for (const pair of PAIRS) {
    const decimals = decimalsFor(pair);
    let rawRows;
    
    try {
      rawRows = pair.type === "metal" ? readGoldHistory() : await fetchForexRows(pair);
    } catch (e) {
      console.error(`Fetch failed for ${pair.label}:`, e.message);
      continue;
    }
    
    if (!rawRows.length || rawRows.length < 10) continue;

    // Daily
    const dailyA = analyze(rawRows, pair.label);
    snapshot.push({
      pair: pair.label, mode: "daily", decimals,
      lastClose: dailyA.lastClose,
      signal: dailyA.signal,
      tradePlan: dailyA.tradePlan,
    });

    // Weekly
    const weeklyRows = resampleWeekly(rawRows);
    if (weeklyRows.length >= 8) {
      const weeklyA = analyze(weeklyRows, pair.label);
      snapshot.push({
        pair: pair.label, mode: "weekly", decimals,
        lastClose: weeklyA.lastClose,
        signal: weeklyA.signal,
        tradePlan: weeklyA.tradePlan,
      });
    }

    // Scalp
    const ohlcKey = pair.label === "XAU/USD" ? "XAUUSD" : pair.label === "GBP/JPY" ? "GBPJPY" : null;
    if (ohlcKey && scalpCandles[ohlcKey]) {
      const candles5m = scalpCandles[ohlcKey];
      if (candles5m && candles5m.length >= 30) {
        const scalpResult = computeScalpTradeSignalWithConfirmation(ohlcKey, decimals, candles5m);
        if (scalpResult.available) {
          snapshot.push({
            pair: pair.label, mode: "scalp", decimals,
            lastClose: candles5m[candles5m.length - 1].close,
            signal: scalpResult.decision,
            rsi: scalpResult.rsi,
            tpsl: scalpResult.tpsl,
          });
        }
      }
    }
  }

  const out = { updatedAt: new Date().toISOString(), signals: snapshot };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SIGNALS_OUT_PATH, JSON.stringify(out, null, 2));
  console.log(`✅ ${snapshot.length} signals updated`);
}

main().catch(e => console.error("Fatal:", e));
