// run-live-analysis.js
//
// PipSight Pro Foundation — legacy-compatible upgrade.
//
// IMPORTANT:
// - Existing Swing, Intraday, Scalp, Master and Telegram decision logic is preserved.
// - No existing signal gate has been removed or made stricter.
// - New reliability features are additive: validation, metadata, proper weekly OHLC,
//   atomic writes, safer Telegram requests, and shadow ATR diagnostics.
//
// Reads:
//   data/scalp-candles.json
//   data/intraday-h1.json
//   data/daily-ohlc.json
//
// Writes:
//   data/live-analysis.json
//   data/analysis-history.json
//   data/notify-state.json

"use strict";

const fs = require("fs");
const path = require("path");

const ENGINE_VERSION = "1.1.0-pro-foundation";
const STRATEGY_VERSION = "legacy-compatible-1.0";
const TELEGRAM_TIMEOUT_MS = 15000;

const DATA_DIR = path.join(__dirname, "data");
const HISTORY_PATH = path.join(DATA_DIR, "analysis-history.json");
const NOTIFY_STATE_PATH = path.join(DATA_DIR, "notify-state.json");
const LIVE_ANALYSIS_PATH = path.join(DATA_DIR, "live-analysis.json");

const PAIR_KEYS = ["XAUUSD", "GBPJPY"];
const DECIMALS = { XAUUSD: 2, GBPJPY: 3 };

// ===================== Safe file helpers =====================

function readJSON(file) {
  const filePath = path.join(DATA_DIR, file);
  if (!fs.existsSync(filePath)) return null;

  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    console.error(`Could not parse data/${file}:`, error.message);
    return null;
  }
}

function atomicWriteJSON(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tempPath, filePath);
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizeTime(value) {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : value;
}

function normalizeCandle(row, timeField) {
  if (!row || typeof row !== "object") return null;

  const timeValue = normalizeTime(row[timeField]);
  const open = Number(row.open);
  const high = Number(row.high);
  const low = Number(row.low);
  const close = Number(row.close);

  if (
    !timeValue ||
    ![open, high, low, close].every(Number.isFinite) ||
    open <= 0 ||
    high <= 0 ||
    low <= 0 ||
    close <= 0 ||
    high < low ||
    high < open ||
    high < close ||
    low > open ||
    low > close
  ) {
    return null;
  }

  return {
    ...row,
    [timeField]: timeValue,
    open,
    high,
    low,
    close,
  };
}

function validateCandles(rows, timeField) {
  if (!Array.isArray(rows)) {
    return {
      rows: [],
      meta: {
        sourceRows: 0,
        validRows: 0,
        invalidRows: 0,
        duplicateRows: 0,
        latest: null,
        stale: true,
      },
    };
  }

  const byTime = new Map();
  let invalidRows = 0;
  let duplicateRows = 0;

  for (const row of rows) {
    const normalized = normalizeCandle(row, timeField);

    if (!normalized) {
      invalidRows += 1;
      continue;
    }

    const key = normalized[timeField];
    if (byTime.has(key)) duplicateRows += 1;
    byTime.set(key, normalized);
  }

  const cleanRows = [...byTime.values()].sort((a, b) =>
    a[timeField].localeCompare(b[timeField])
  );

  const latest = cleanRows.length
    ? cleanRows[cleanRows.length - 1][timeField]
    : null;

  return {
    rows: cleanRows,
    meta: {
      sourceRows: rows.length,
      validRows: cleanRows.length,
      invalidRows,
      duplicateRows,
      latest,
      stale: latest ? Date.now() - Date.parse(latest) > 7 * 86400000 : true,
    },
  };
}

// ===================== Indicator/helper functions =====================

function emaSeries(values, period) {
  const k = 2 / (period + 1);
  const out = [];
  let prev = null;

  for (let i = 0; i < values.length; i++) {
    if (i === period - 1) {
      const seed =
        values.slice(0, period).reduce((a, b) => a + b, 0) / period;
      prev = seed;
      out.push(seed);
    } else if (i < period - 1) {
      out.push(null);
    } else {
      prev = values[i] * k + prev * (1 - k);
      out.push(prev);
    }
  }

  return out;
}

function rsiSeries(values, period = 14) {
  const out = new Array(values.length).fill(null);

  if (values.length <= period) return out;

  let gainSum = 0;
  let lossSum = 0;

  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gainSum += d;
    else lossSum -= d;
  }

  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;

  out[period] =
    avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;

    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;

    out[i] =
      avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }

  return out;
}

function computeVolatility(rows) {
  const closes = rows.map((r) => r.close);
  const n = closes.length;

  if (n < 3) return 0.004;

  let sum = 0;
  let count = 0;

  for (let i = 1; i < n; i++) {
    sum += Math.abs(closes[i] - closes[i - 1]) / closes[i - 1];
    count += 1;
  }

  return count ? sum / count : 0.004;
}

function computeATR(ohlcRows, period = 14) {
  if (!Array.isArray(ohlcRows) || ohlcRows.length < period + 1) return null;

  const trueRanges = [];

  for (let i = 1; i < ohlcRows.length; i++) {
    const current = ohlcRows[i];
    const previous = ohlcRows[i - 1];

    trueRanges.push(
      Math.max(
        current.high - current.low,
        Math.abs(current.high - previous.close),
        Math.abs(current.low - previous.close)
      )
    );
  }

  if (trueRanges.length < period) return null;

  let atr =
    trueRanges.slice(0, period).reduce((sum, value) => sum + value, 0) /
    period;

  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]) / period;
  }

  return atr;
}

function computeADX(ohlcRows, period = 14) {
  const n = ohlcRows.length;
  if (n < period * 2 + 1) return null;

  const tr = [];
  const plusDM = [];
  const minusDM = [];

  for (let i = 1; i < n; i++) {
    const cur = ohlcRows[i];
    const prev = ohlcRows[i - 1];

    tr.push(
      Math.max(
        cur.high - cur.low,
        Math.abs(cur.high - prev.close),
        Math.abs(cur.low - prev.close)
      )
    );

    const upMove = cur.high - prev.high;
    const downMove = prev.low - cur.low;

    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  let trSum = 0;
  let pdmSum = 0;
  let mdmSum = 0;

  for (let i = 0; i < period; i++) {
    trSum += tr[i];
    pdmSum += plusDM[i];
    mdmSum += minusDM[i];
  }

  const dxSeries = [];
  let trN = trSum;
  let pdmN = pdmSum;
  let mdmN = mdmSum;

  for (let i = period; i < tr.length; i++) {
    trN = trN - trN / period + tr[i];
    pdmN = pdmN - pdmN / period + plusDM[i];
    mdmN = mdmN - mdmN / period + minusDM[i];

    const plusDI = trN === 0 ? 0 : 100 * (pdmN / trN);
    const minusDI = trN === 0 ? 0 : 100 * (mdmN / trN);

    const dx =
      plusDI + minusDI === 0
        ? 0
        : (100 * Math.abs(plusDI - minusDI)) / (plusDI + minusDI);

    dxSeries.push(dx);
  }

  if (dxSeries.length < period) return null;

  let adx =
    dxSeries.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < dxSeries.length; i++) {
    adx = (adx * (period - 1) + dxSeries[i]) / period;
  }

  return adx;
}

function detectCandlePattern(ohlcRows, leanDirection) {
  const n = ohlcRows.length;

  if (n < 2 || !leanDirection) {
    return { ok: false, detail: "Not enough candle history" };
  }

  const last = ohlcRows[n - 1];
  const prev = ohlcRows[n - 2];
  const range = last.high - last.low;
  const body = Math.abs(last.close - last.open);
  const bodyPct = range > 0 ? body / range : 0;

  if (leanDirection === "BUY") {
    const bullishEngulfing =
      prev.close < prev.open &&
      last.close > last.open &&
      last.open <= prev.close &&
      last.close >= prev.open;

    if (bullishEngulfing) {
      return {
        ok: true,
        detail: "Bullish engulfing on the latest candle",
      };
    }

    if (last.close > last.open && bodyPct > 0.6) {
      return {
        ok: true,
        detail: `Strong bullish candle (body ${(bodyPct * 100).toFixed(
          0
        )}% of range)`,
      };
    }

    return {
      ok: false,
      detail: "Latest candle doesn't confirm a bullish pattern",
    };
  }

  const bearishEngulfing =
    prev.close > prev.open &&
    last.close < last.open &&
    last.open >= prev.close &&
    last.close <= prev.open;

  if (bearishEngulfing) {
    return {
      ok: true,
      detail: "Bearish engulfing on the latest candle",
    };
  }

  if (last.close < last.open && bodyPct > 0.6) {
    return {
      ok: true,
      detail: `Strong bearish candle (body ${(bodyPct * 100).toFixed(
        0
      )}% of range)`,
    };
  }

  return {
    ok: false,
    detail: "Latest candle doesn't confirm a bearish pattern",
  };
}

function computeSR(rows, lastClose) {
  const closes = rows.map((r) => r.close);
  const n = closes.length;
  const radius = n > 40 ? 2 : 1;
  const highs = [];
  const lows = [];

  for (let i = radius; i < n - radius; i++) {
    let isHigh = true;
    let isLow = true;

    for (let k = 1; k <= radius; k++) {
      if (
        closes[i] < closes[i - k] ||
        closes[i] < closes[i + k]
      ) {
        isHigh = false;
      }

      if (
        closes[i] > closes[i - k] ||
        closes[i] > closes[i + k]
      ) {
        isLow = false;
      }
    }

    if (isHigh) highs.push(closes[i]);
    if (isLow) lows.push(closes[i]);
  }

  function dedupe(levels) {
    const sorted = [...levels].sort((a, b) => a - b);
    const out = [];

    for (const v of sorted) {
      if (
        !out.length ||
        Math.abs(v - out[out.length - 1]) / v > 0.0015
      ) {
        out.push(v);
      } else {
        out[out.length - 1] = (out[out.length - 1] + v) / 2;
      }
    }

    return out;
  }

  let resistances = dedupe(highs)
    .filter((h) => h > lastClose)
    .sort((a, b) => a - b)
    .slice(0, 2);

  let supports = dedupe(lows)
    .filter((l) => l < lastClose)
    .sort((a, b) => b - a)
    .slice(0, 2);

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

function trendDirectionOf(rows) {
  const closes = rows.map((r) => r.close);
  const n = closes.length;

  if (n < 6) return null;

  const lastClose = closes[n - 1];
  const cap = n - 1;
  const p200 = Math.min(200, cap);
  const p100 = Math.min(100, Math.max(4, Math.floor(p200 * 0.5)));
  const p50 = Math.min(50, Math.max(3, Math.floor(p100 * 0.6)));
  const p20 = Math.min(20, Math.max(2, Math.floor(p50 * 0.5)));

  const e20 = emaSeries(closes, p20);
  const e50 = emaSeries(closes, p50);
  const e100 = emaSeries(closes, p100);
  const e200 = emaSeries(closes, p200);

  const last = n - 1;
  const v20 = e20[last];
  const v50 = e50[last];
  const v100 = e100[last];
  const v200 = e200[last];

  if (v20 == null || v50 == null || v100 == null || v200 == null) {
    return null;
  }

  const bullFull =
    v20 > v50 && v50 > v100 && v100 > v200 && lastClose > v20;

  const bearFull =
    v20 < v50 && v50 < v100 && v100 < v200 && lastClose < v20;

  if (bullFull) return "BUY";
  if (bearFull) return "SELL";
  return null;
}

// ===================== Weekly aggregation =====================

function isoWeekKey(dateStr) {
  const d = new Date(`${dateStr.slice(0, 10)}T00:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7;

  d.setUTCDate(d.getUTCDate() - day + 3);

  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const fdDay = (firstThursday.getUTCDay() + 6) % 7;

  const week =
    1 +
    Math.round(
      ((d - firstThursday) / 86400000 - 3 + fdDay) / 7
    );

  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function resampleWeekly(rows) {
  const weeks = new Map();

  for (const row of rows) {
    const key = isoWeekKey(row.date);
    const existing = weeks.get(key);

    if (!existing) {
      weeks.set(key, {
        date: row.date,
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
      });
      continue;
    }

    existing.high = Math.max(existing.high, row.high);
    existing.low = Math.min(existing.low, row.low);
    existing.close = row.close;
    existing.date = row.date;
  }

  return [...weeks.values()];
}

// ===================== Strict legacy pipeline =====================

function analyze(rows, pairLabel, htfRows, ohlcRows) {
  const closes = rows.map((r) => r.close);
  const n = closes.length;
  const lastClose = closes[n - 1];
  const pipeline = [];
  let alive = true;

  function pass(name, ok, detail) {
    if (!alive) {
      pipeline.push({
        name,
        status: "skip",
        detail: "Not reached — an earlier required step failed",
      });
      return false;
    }

    pipeline.push({
      name,
      status: ok ? "pass" : "fail",
      detail,
    });

    if (!ok) alive = false;
    return ok;
  }

  function na(name, detail) {
    pipeline.push({ name, status: "na", detail });
  }

  let leanDirection = null;
  let trendLabel = "Building history — not enough sessions yet";

  if (n >= 6) {
    const cap = n - 1;
    const p200 = Math.min(200, cap);
    const p100 = Math.min(100, Math.max(4, Math.floor(p200 * 0.5)));
    const p50 = Math.min(50, Math.max(3, Math.floor(p100 * 0.6)));
    const p20 = Math.min(20, Math.max(2, Math.floor(p50 * 0.5)));

    const e20 = emaSeries(closes, p20);
    const e50 = emaSeries(closes, p50);
    const e100 = emaSeries(closes, p100);
    const e200 = emaSeries(closes, p200);

    const last = n - 1;
    const v20 = e20[last];
    const v50 = e50[last];
    const v100 = e100[last];
    const v200 = e200[last];

    const fullStack = cap >= 200;
    const note = fullStack
      ? ""
      : " (adaptive periods — full EMA200 needs more history)";

    if (v20 != null && v50 != null && v100 != null && v200 != null) {
      const bullFull =
        v20 > v50 &&
        v50 > v100 &&
        v100 > v200 &&
        lastClose > v20;

      const bearFull =
        v20 < v50 &&
        v50 < v100 &&
        v100 < v200 &&
        lastClose < v20;

      const bullCount = [
        v20 > v50,
        v50 > v100,
        v100 > v200,
        lastClose > v20,
      ].filter(Boolean).length;

      const bearCount = [
        v20 < v50,
        v50 < v100,
        v100 < v200,
        lastClose < v20,
      ].filter(Boolean).length;

      if (bullFull) {
        leanDirection = "BUY";
        trendLabel = `Bullish — full EMA stack ${p20}>${p50}>${p100}>${p200}${note}`;
      } else if (bearFull) {
        leanDirection = "SELL";
        trendLabel = `Bearish — full EMA stack ${p20}<${p50}<${p100}<${p200}${note}`;
      } else if (bullCount >= 3) {
        trendLabel = `Partial bullish lean only (${bullCount}/4) — not enough to qualify${note}`;
      } else if (bearCount >= 3) {
        trendLabel = `Partial bearish lean only (${bearCount}/4) — not enough to qualify${note}`;
      } else {
        trendLabel = `Mixed EMA alignment — no clear trend${note}`;
      }
    }
  }

  pass("Trend", !!leanDirection, trendLabel);

  pass(
    "EMA Alignment",
    !!leanDirection,
    leanDirection
      ? `Full EMA stack confirms ${
          leanDirection === "BUY" ? "bullish" : "bearish"
        } alignment`
      : "Stack is not fully aligned in order"
  );

  const adxVal = ohlcRows ? computeADX(ohlcRows, 14) : null;

  na(
    "ADX > 25?",
    adxVal != null
      ? `Informational — ADX(14) = ${adxVal.toFixed(1)}`
      : "Not available"
  );

  na(
    "Volume Confirmed?",
    "Not available — spot FX/gold has no centralized exchange volume feed"
  );

  const macdOk = n >= 35;
  let lastMacd = null;
  let lastMacdSignal = null;

  if (macdOk) {
    const ema12 = emaSeries(closes, 12);
    const ema26 = emaSeries(closes, 26);

    const macdLine = closes.map((_, i) =>
      ema12[i] != null && ema26[i] != null
        ? ema12[i] - ema26[i]
        : null
    );

    const macdVals = macdLine.filter((v) => v != null);
    const sig = emaSeries(macdVals, 9);

    lastMacd = macdLine[n - 1];
    lastMacdSignal = sig[sig.length - 1];
  }

  let macdDetail;
  let macdPassVal = false;

  if (!leanDirection) {
    macdDetail = "No confirmed trend direction to test against";
  } else if (!macdOk) {
    macdDetail = `Needs ${35 - n} more session(s) of history for MACD`;
  } else {
    macdPassVal =
      leanDirection === "BUY"
        ? lastMacd > lastMacdSignal
        : lastMacd < lastMacdSignal;

    macdDetail = `MACD ${lastMacd.toFixed(
      4
    )} vs signal ${lastMacdSignal.toFixed(4)} — ${
      macdPassVal ? "confirms" : "does not confirm"
    } ${leanDirection}`;
  }

  pass(
    "MACD Confirmation",
    leanDirection ? macdOk && macdPassVal : false,
    macdDetail
  );

  const rsiP = Math.min(14, Math.max(4, n - 2));
  const rsi = rsiSeries(closes, rsiP);
  const lastRsi = rsi[n - 1];

  const rsiBuyOk =
    lastRsi != null && lastRsi >= 45 && lastRsi <= 65;

  const rsiSellOk =
    lastRsi != null && lastRsi >= 35 && lastRsi <= 55;

  let rsiDetail;
  let rsiPassVal = false;

  if (!leanDirection) {
    rsiDetail = "No confirmed trend direction to test against";
  } else if (lastRsi == null) {
    rsiDetail = "Not enough history for RSI yet";
  } else {
    rsiPassVal =
      leanDirection === "BUY" ? rsiBuyOk : rsiSellOk;

    rsiDetail = `RSI(${rsiP}) = ${lastRsi.toFixed(1)}`;
  }

  pass(
    "RSI Confirmation",
    leanDirection ? lastRsi != null && rsiPassVal : false,
    rsiDetail
  );

  let htfDetail;
  let htfPassVal = false;
  let htfDirection = null;

  if (!leanDirection) {
    htfDetail = "No confirmed trend direction to test against";
  } else if (htfRows === null || htfRows === undefined) {
    htfPassVal = true;
    htfDetail = "Already viewing the highest timeframe available";
  } else {
    htfDirection = trendDirectionOf(htfRows);

    if (htfDirection == null) {
      htfDetail =
        "Higher-timeframe trend isn't clearly aligned yet";
    } else {
      htfPassVal = htfDirection === leanDirection;
      htfDetail = `Higher-timeframe trend is ${htfDirection} — ${
        htfPassVal ? "agrees" : "conflicts"
      }`;
    }
  }

  pass(
    "Multi-Timeframe Confirmation",
    leanDirection ? htfPassVal : false,
    htfDetail
  );

  if (ohlcRows && leanDirection) {
    const cp = detectCandlePattern(ohlcRows, leanDirection);
    pass("Candle Pattern", cp.ok, cp.detail);
  } else {
    na("Candle Pattern", "Not available");
  }

  na(
    "High-Impact News Filter",
    "Informational — no server-side news feed here; shown for context only, doesn't block the signal"
  );

  const sr = computeSR(rows, lastClose);
  let srDetail;
  let srPassVal = false;

  if (!leanDirection) {
    srDetail = "No confirmed trend direction to test against";
  } else if (leanDirection === "BUY") {
    const res = sr.resistances[0];

    if (res == null) {
      srPassVal = true;
      srDetail = "No resistance detected nearby";
    } else {
      const d = (res - lastClose) / lastClose;
      srPassVal = d >= 0.003;

      srDetail = srPassVal
        ? `Resistance ${(d * 100).toFixed(2)}% away`
        : `Resistance only ${(d * 100).toFixed(2)}% above spot`;
    }
  } else {
    const sup = sr.supports[0];

    if (sup == null) {
      srPassVal = true;
      srDetail = "No support detected nearby";
    } else {
      const d = (lastClose - sup) / lastClose;
      srPassVal = d >= 0.003;

      srDetail = srPassVal
        ? `Support ${(d * 100).toFixed(2)}% away`
        : `Support only ${(d * 100).toFixed(2)}% below spot`;
    }
  }

  pass(
    "Support/Resistance",
    leanDirection ? srPassVal : false,
    srDetail
  );

  // Legacy stop calculation remains unchanged.
  const vol = computeVolatility(rows);
  const buffer = Math.max(vol * 0.5, 0.0004) * lastClose;

  // True ATR is calculated in shadow mode for audit/display only.
  const trueAtr = ohlcRows ? computeATR(ohlcRows, 14) : null;

  if (leanDirection && alive) {
    pipeline.push({
      name: "ATR-style Stop Loss",
      status: "pass",
      detail: `Volatility-based buffer ≈ ${buffer.toFixed(
        lastClose > 100 ? 2 : 5
      )}${
        trueAtr != null
          ? ` · True ATR(14) shadow = ${trueAtr.toFixed(
              lastClose > 100 ? 2 : 5
            )}`
          : ""
      }`,
    });
  } else {
    pipeline.push({
      name: "ATR-style Stop Loss",
      status: "skip",
      detail: "Not reached",
    });
  }

  let tradePlan = null;

  if (leanDirection && alive) {
    const sup = sr.supports[0];
    const res = sr.resistances[0];

    let stop;
    let target1;
    let target2;
    let target3;
    let risk;

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

    const rrOk = pass(
      "Risk:Reward ≥ 1:2",
      rr >= 2,
      `Risk:Reward to TP1 = 1:${rr.toFixed(1)}`
    );

    if (rrOk) {
      tradePlan = {
        direction: leanDirection,
        entry: lastClose,
        stop,
        target1,
        target2,
        target3,
        risk,
        rr,
      };
    }
  } else {
    pass(
      "Risk:Reward ≥ 1:2",
      false,
      "No confirmed trend direction yet"
    );
  }

  const signal = tradePlan ? tradePlan.direction : "HOLD";
  const failedStep = pipeline.find((p) => p.status === "fail");

  const suppressionReason =
    signal === "HOLD"
      ? leanDirection
        ? `NO TRADE — stopped at "${
            failedStep ? failedStep.name : "an earlier step"
          }"`
        : "NO TRADE — no confirmed trend direction yet"
      : null;

  const gatedSteps = pipeline.filter(
    (p) => p.status === "pass" || p.status === "fail"
  );

  const passCount = gatedSteps.filter(
    (p) => p.status === "pass"
  ).length;

  return {
    signal,
    suppressionReason,
    tradePlan,
    lastClose,
    passCount,
    gatedCount: gatedSteps.length,
    diagnostics: {
      adx14: adxVal,
      atr14: trueAtr,
      trendLabel,
      pipeline,
    },
  };
}

// ===================== Scalp engine =====================

function aggregateCandles(candles5m, groupSize) {
  if (groupSize === 1) return candles5m;

  const out = [];

  for (
    let i = 0;
    i + groupSize <= candles5m.length;
    i += groupSize
  ) {
    const chunk = candles5m.slice(i, i + groupSize);

    out.push({
      time: chunk[0].time,
      open: chunk[0].open,
      high: Math.max(...chunk.map((c) => c.high)),
      low: Math.min(...chunk.map((c) => c.low)),
      close: chunk[chunk.length - 1].close,
    });
  }

  return out;
}

function analyzeScalp(candles) {
  const n = candles.length;

  if (n < 30) {
    return { signal: "HOLD", bull: 0, bear: 0 };
  }

  const closes = candles.map((c) => c.close);
  const last = candles[n - 1];

  const ema9 = emaSeries(closes, 9);
  const ema21 = emaSeries(closes, 21);
  const rsi14 = rsiSeries(closes, 14);

  const ema12 = emaSeries(closes, 12);
  const ema26 = emaSeries(closes, 26);

  const macdLine = closes.map((_, i) =>
    ema12[i] != null && ema26[i] != null
      ? ema12[i] - ema26[i]
      : null
  );

  const macdVals = macdLine.filter((v) => v != null);
  const macdSignalSeries = emaSeries(macdVals, 9);

  const lastMacd = macdLine[n - 1];
  const lastMacdSignal =
    macdSignalSeries[macdSignalSeries.length - 1];

  const lastRsi = rsi14[n - 1];
  const lastEma9 = ema9[n - 1];
  const lastEma21 = ema21[n - 1];

  let bull = 0;
  let bear = 0;

  if (lastEma9 != null && lastEma21 != null) {
    lastEma9 > lastEma21 ? bull++ : bear++;
  }

  if (lastRsi != null) {
    lastRsi > 50 ? bull++ : bear++;
  }

  if (lastMacd != null && lastMacdSignal != null) {
    lastMacd > lastMacdSignal ? bull++ : bear++;
  }

  if (lastEma21 != null) {
    last.close > lastEma21 ? bull++ : bear++;
  }

  last.close > last.open ? bull++ : bear++;

  let signal = "HOLD";

  if (bull >= 4 && bull > bear) signal = "BUY";
  else if (bear >= 4 && bear > bull) signal = "SELL";

  return { signal, bull, bear };
}

function computeScalpTradeSignal(candles5m, decimals) {
  const c5 = candles5m;
  const c15 = aggregateCandles(candles5m, 3);
  const c30 = aggregateCandles(candles5m, 6);

  const a5 = analyzeScalp(c5);
  const a15 = analyzeScalp(c15);
  const a30 = analyzeScalp(c30);

  const perTF = [
    { tf: "5m", signal: a5.signal },
    { tf: "15m", signal: a15.signal },
    { tf: "30m", signal: a30.signal },
  ];

  let decision = "HOLD";
  let reason = "";

  if (a15.signal === "HOLD") {
    reason = "15-min anchor timeframe is not aligned";
  } else {
    const agrees =
      (a5.signal === a15.signal ? 1 : 0) +
      (a30.signal === a15.signal ? 1 : 0);

    if (agrees >= 1) {
      decision = a15.signal;
    } else {
      reason =
        "5-min and 30-min both disagree with the 15-min lean";
    }
  }

  const entry = c5[c5.length - 1].close;
  const recent15 = c15.slice(-10);

  const avgRange = recent15.length
    ? recent15.reduce(
        (sum, candle) => sum + (candle.high - candle.low),
        0
      ) / recent15.length
    : entry * 0.001;

  let sl = null;
  let tp = null;
  const rr = 2;

  if (decision === "BUY") {
    sl = entry - avgRange;
    tp = entry + avgRange * rr;
  } else if (decision === "SELL") {
    sl = entry + avgRange;
    tp = entry - avgRange * rr;
  }

  const fmt = (value) =>
    value == null ? null : Number(value.toFixed(decimals));

  return {
    decision,
    reason,
    perTF,
    entry: fmt(entry),
    sl: fmt(sl),
    tp: fmt(tp),
    rr,
  };
}

// ===================== Persistent history =====================

function loadHistory() {
  if (!fs.existsSync(HISTORY_PATH)) {
    return { open: {}, closed: [] };
  }

  try {
    const parsed = JSON.parse(
      fs.readFileSync(HISTORY_PATH, "utf8")
    );

    return {
      open:
        parsed && parsed.open && typeof parsed.open === "object"
          ? parsed.open
          : {},
      closed:
        parsed && Array.isArray(parsed.closed)
          ? parsed.closed
          : [],
      ...parsed,
    };
  } catch (error) {
    console.error(
      "Could not parse analysis-history.json:",
      error.message
    );

    return { open: {}, closed: [] };
  }
}

function updateHistoryForEngine(
  history,
  pairKey,
  engine,
  decision,
  entry,
  stop,
  target,
  currentPrice
) {
  const key = `${pairKey}:${engine}`;
  const existing = history.open[key];

  if (existing) {
    let outcome = null;

    if (existing.direction === "BUY") {
      if (currentPrice >= existing.target) outcome = "WIN";
      else if (currentPrice <= existing.stop) outcome = "LOSS";
    } else {
      if (currentPrice <= existing.target) outcome = "WIN";
      else if (currentPrice >= existing.stop) outcome = "LOSS";
    }

    if (outcome) {
      history.closed.push({
        pair: pairKey,
        engine,
        direction: existing.direction,
        entry: existing.entry,
        stop: existing.stop,
        target: existing.target,
        outcome,
        openedAt: existing.openedAt,
        closedAt: new Date().toISOString(),
      });

      delete history.open[key];
    }
  } else if (
    (decision === "BUY" || decision === "SELL") &&
    stop != null &&
    target != null
  ) {
    history.open[key] = {
      direction: decision,
      entry,
      stop,
      target,
      openedAt: new Date().toISOString(),
    };
  }
}

function historyStatsSummary(history) {
  const wins = history.closed.filter(
    (h) => h.outcome === "WIN"
  ).length;

  const losses = history.closed.filter(
    (h) => h.outcome === "LOSS"
  ).length;

  const total = wins + losses;

  return {
    totalClosed: total,
    wins,
    losses,
    winRate: total
      ? Math.round((wins / total) * 100)
      : null,
    openCount: Object.keys(history.open).length,
  };
}

// ===================== Telegram notifications =====================

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

function loadNotifyState() {
  if (!fs.existsSync(NOTIFY_STATE_PATH)) return {};

  try {
    return JSON.parse(
      fs.readFileSync(NOTIFY_STATE_PATH, "utf8")
    );
  } catch (error) {
    console.error(
      "Could not parse notify-state.json:",
      error.message
    );

    return {};
  }
}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log(
      "Telegram not configured (missing secrets) — skipping notification:",
      text.split("\n")[0]
    );
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    TELEGRAM_TIMEOUT_MS
  );

  try {
    const res = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text,
        }),
        signal: controller.signal,
      }
    );

    if (!res.ok) {
      console.error(
        "Telegram send failed:",
        res.status,
        await res.text()
      );
    } else {
      console.log(
        "Telegram notification sent:",
        text.split("\n")[0]
      );
    }
  } catch (error) {
    console.error(
      "Telegram send error:",
      error.name === "AbortError"
        ? `Timed out after ${TELEGRAM_TIMEOUT_MS}ms`
        : error.message
    );
  } finally {
    clearTimeout(timer);
  }
}

function fmtPlan(plan, decimals) {
  if (!plan) return "";

  const f = (value) => value.toFixed(decimals);

  return `Entry: ${f(plan.entry)}
Stop: ${f(plan.stop)}
Target: ${f(plan.target1)}`;
}

// ===================== Main =====================

async function main() {
  const rawScalpData = readJSON("scalp-candles.json");
  const rawIntradayData = readJSON("intraday-h1.json");
  const rawDailyData = readJSON("daily-ohlc.json");

  const history = loadHistory();
  const notifyState = loadNotifyState();

  const out = {
    updatedAt: new Date().toISOString(),
    engineVersion: ENGINE_VERSION,
    strategyVersion: STRATEGY_VERSION,
    compatibilityMode: "legacy",
    pairs: {},
    dataQuality: {},
  };

  for (const key of PAIR_KEYS) {
    const decimals = DECIMALS[key];

    const dailyValidation = validateCandles(
      rawDailyData ? rawDailyData[key] : null,
      "date"
    );

    const intradayValidation = validateCandles(
      rawIntradayData ? rawIntradayData[key] : null,
      "time"
    );

    const scalpValidation = validateCandles(
      rawScalpData ? rawScalpData[key] : null,
      "time"
    );

    const daily = dailyValidation.rows;
    const h1 = intradayValidation.rows;
    const c5 = scalpValidation.rows;

    out.dataQuality[key] = {
      daily: dailyValidation.meta,
      intraday: intradayValidation.meta,
      scalp: scalpValidation.meta,
    };

    const result = {
      swing: null,
      intraday: null,
      scalp: null,
      master: null,
    };

    if (daily.length >= 8) {
      const htf = resampleWeekly(daily);

      if (htf.length >= 8) {
        const analysis = analyze(daily, key, htf, daily);

        result.swing = {
          signal: analysis.signal,
          suppressionReason: analysis.suppressionReason,
          tradePlan: analysis.tradePlan,
          passCount: analysis.passCount,
          gatedCount: analysis.gatedCount,
          diagnostics: analysis.diagnostics,
        };

        const tradePlan = analysis.tradePlan;

        updateHistoryForEngine(
          history,
          key,
          "swing",
          analysis.signal,
          tradePlan ? tradePlan.entry : null,
          tradePlan ? tradePlan.stop : null,
          tradePlan ? tradePlan.target1 : null,
          daily[daily.length - 1].close
        );

        const swingStateKey = `${key}:swing`;

        if (
          analysis.signal !== "HOLD" &&
          notifyState[swingStateKey] !== analysis.signal
        ) {
          await sendTelegram(
            `🔔 PipSight — Swing
${key} · D1+W1
${analysis.signal === "BUY" ? "🟢" : "🔴"} ${analysis.signal}
${fmtPlan(tradePlan, decimals)}
Hold: 2–7 days`
          );
        }

        notifyState[swingStateKey] = analysis.signal;
      }
    }

    if (h1.length >= 210) {
      const h4 = aggregateCandles(h1, 4);
      const analysis = analyze(h1, key, h4, h1);

      result.intraday = {
        signal: analysis.signal,
        suppressionReason: analysis.suppressionReason,
        tradePlan: analysis.tradePlan,
        passCount: analysis.passCount,
        gatedCount: analysis.gatedCount,
        diagnostics: analysis.diagnostics,
      };

      const tradePlan = analysis.tradePlan;

      updateHistoryForEngine(
        history,
        key,
        "intraday",
        analysis.signal,
        tradePlan ? tradePlan.entry : null,
        tradePlan ? tradePlan.stop : null,
        tradePlan ? tradePlan.target1 : null,
        h1[h1.length - 1].close
      );

      const stateKey = `${key}:intraday`;

      if (
        analysis.signal !== "HOLD" &&
        notifyState[stateKey] !== analysis.signal
      ) {
        await sendTelegram(
          `🔔 PipSight — Intraday
${key} · H1+H4
${analysis.signal === "BUY" ? "🟢" : "🔴"} ${analysis.signal}
${fmtPlan(tradePlan, decimals)}
Hold: 2–12 hours`
        );
      }

      notifyState[stateKey] = analysis.signal;
    }

    if (c5.length >= 30) {
      result.scalp = computeScalpTradeSignal(c5, decimals);

      const scalp = result.scalp;

      updateHistoryForEngine(
        history,
        key,
        "scalp",
        scalp.decision,
        scalp.entry,
        scalp.sl,
        scalp.tp,
        c5[c5.length - 1].close
      );

      const scalpStateKey = `${key}:scalp`;

      if (
        scalp.decision !== "HOLD" &&
        notifyState[scalpStateKey] !== scalp.decision
      ) {
        await sendTelegram(
          `🔔 PipSight — Scalp
${key} · 5/15/30m
${scalp.decision === "BUY" ? "🟢" : "🔴"} ${scalp.decision}
Entry: ${scalp.entry}
SL: ${scalp.sl}
TP: ${scalp.tp}`
        );
      }

      notifyState[scalpStateKey] = scalp.decision;
    }

    const votes = [
      {
        engine: "Scalp",
        signal: result.scalp
          ? result.scalp.decision
          : "HOLD",
      },
      {
        engine: "Intraday",
        signal: result.intraday
          ? result.intraday.signal
          : "HOLD",
      },
      {
        engine: "Swing",
        signal: result.swing
          ? result.swing.signal
          : "HOLD",
      },
    ];

    const buyCount = votes.filter(
      (vote) => vote.signal === "BUY"
    ).length;

    const sellCount = votes.filter(
      (vote) => vote.signal === "SELL"
    ).length;

    let verdict = "MIXED";

    if (buyCount >= 2 && buyCount > sellCount) {
      verdict = "BUY";
    } else if (sellCount >= 2 && sellCount > buyCount) {
      verdict = "SELL";
    } else if (buyCount === 0 && sellCount === 0) {
      verdict = "HOLD";
    }

    result.master = { verdict, votes };

    const masterKey = `${key}:master`;

    if (
      (verdict === "BUY" || verdict === "SELL") &&
      notifyState[masterKey] !== verdict
    ) {
      const voteLines = votes
        .map((vote) => `${vote.engine}: ${vote.signal}`)
        .join(" · ");

      await sendTelegram(
        `⭐ PipSight — Master Signal
${key}
${verdict === "BUY" ? "🟢" : "🔴"} ${verdict} (2+ engines agree)
${voteLines}`
      );
    }

    notifyState[masterKey] = verdict;
    out.pairs[key] = result;

    console.log(
      `${key}: swing=${
        result.swing ? result.swing.signal : "n/a"
      } intraday=${
        result.intraday ? result.intraday.signal : "n/a"
      } scalp=${
        result.scalp ? result.scalp.decision : "n/a"
      } master=${verdict}`
    );
  }

  atomicWriteJSON(LIVE_ANALYSIS_PATH, out);
  console.log("Wrote data/live-analysis.json");

  atomicWriteJSON(NOTIFY_STATE_PATH, notifyState);

  history.updatedAt = new Date().toISOString();
  history.engineVersion = ENGINE_VERSION;
  history.strategyVersion = STRATEGY_VERSION;
  history.stats = {
    overall: historyStatsSummary(history),
  };

  for (const engine of ["scalp", "intraday", "swing"]) {
    const filtered = {
      open: {},
      closed: history.closed.filter(
        (item) => item.engine === engine
      ),
    };

    history.stats[engine] =
      historyStatsSummary(filtered);
  }

  atomicWriteJSON(HISTORY_PATH, history);

  console.log(
    `History: ${history.stats.overall.totalClosed} closed (${history.stats.overall.winRate}% win rate), ${history.stats.overall.openCount} open`
  );
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
