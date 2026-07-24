"use strict";

/* =====================================================================
   PipSight Pro AI — Server Signal Engine
   Version: 2.1.0

   Compatibility:
   - Existing EMA / RSI / MACD decision pipeline preserved.
   - Existing output files and primary output fields preserved.
   - Close-only sources remain supported.
   - OHLC features activate only when valid OHLC data is available.
   ===================================================================== */

const fs = require("fs");
const path = require("path");

const ENGINE_VERSION = "2.1.0";
const STRATEGY_VERSION = "legacy-lockstep-2.1";

const DATA_DIR = path.join(__dirname, "data");

const DAILY_OHLC_PATH = path.join(
  DATA_DIR,
  "daily-ohlc.json"
);

const GOLD_HISTORY_PATH = path.join(
  DATA_DIR,
  "xau-usd-history.json"
);

const NEWS_FEED_PATH = path.join(
  DATA_DIR,
  "news-feed.json"
);

const SIGNALS_OUT_PATH = path.join(
  DATA_DIR,
  "signals.json"
);

const LOG_OUT_PATH = path.join(
  DATA_DIR,
  "signal-log.json"
);

const FETCH_TIMEOUT_MS = 15000;
const MAX_SIGNAL_LOG = 5000;
const MIN_DAILY_ROWS = 10;
const MIN_WEEKLY_ROWS = 8;

const PAIRS = Object.freeze([
  {
    key: "XAUUSD",
    type: "metal",
    symbol: "XAU",
    quote: "USD",
    label: "XAU/USD"
  },
  {
    key: "GBPJPY",
    type: "forex",
    base: "GBP",
    quote: "JPY",
    label: "GBP/JPY"
  }
]);

const MODES = Object.freeze([
  "daily",
  "weekly"
]);

/* =====================================================================
   General Helpers
   ===================================================================== */

function clamp(value, minimum, maximum) {
  return Math.max(
    minimum,
    Math.min(maximum, value)
  );
}

function isFiniteNumber(value) {
  return (
    typeof value === "number" &&
    Number.isFinite(value)
  );
}

function round(value, decimals = 6) {
  if (!isFiniteNumber(value)) {
    return null;
  }

  const factor = 10 ** decimals;

  return (
    Math.round(value * factor) /
    factor
  );
}

function decimalsFor(pair) {
  if (pair.type === "metal") {
    return 2;
  }

  if (pair.quote === "JPY") {
    return 3;
  }

  return 4;
}

function safeIsoDate(value) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.slice(0, 10);

  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(
      normalized
    )
  ) {
    return null;
  }

  const parsed = new Date(
    normalized + "T00:00:00Z"
  );

  if (
    Number.isNaN(parsed.getTime())
  ) {
    return null;
  }

  return normalized;
}

function daysBetween(dateA, dateB) {
  const a = new Date(
    dateA + "T00:00:00Z"
  );

  const b = new Date(
    dateB + "T00:00:00Z"
  );

  return Math.floor(
    Math.abs(b - a) / 86400000
  );
}

/* =====================================================================
   Safe File Handling
   ===================================================================== */

function readJsonFile(
  filePath,
  fallback
) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }

  try {
    const text = fs.readFileSync(
      filePath,
      "utf8"
    );

    if (!text.trim()) {
      return fallback;
    }

    return JSON.parse(text);
  } catch (error) {
    console.warn(
      `Unable to read ${path.basename(
        filePath
      )}: ${error.message}`
    );

    return fallback;
  }
}

function atomicWriteJson(
  filePath,
  value
) {
  fs.mkdirSync(
    path.dirname(filePath),
    { recursive: true }
  );

  const tempPath =
    `${filePath}.${process.pid}.${Date.now()}.tmp`;

  const serialized =
    JSON.stringify(value, null, 2);

  fs.writeFileSync(
    tempPath,
    serialized,
    "utf8"
  );

  try {
    fs.renameSync(
      tempPath,
      filePath
    );
  } catch (error) {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }

      fs.renameSync(
        tempPath,
        filePath
      );
    } catch (renameError) {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }

      throw renameError;
    }
  }
}

/* =====================================================================
   Candle Validation and Normalization
   ===================================================================== */

function normalizeCandle(raw) {
  if (
    !raw ||
    typeof raw !== "object"
  ) {
    return null;
  }

  const date = safeIsoDate(
    raw.date ||
    raw.time ||
    raw.timestamp
  );

  const close = Number(raw.close);

  if (
    !date ||
    !Number.isFinite(close) ||
    close <= 0
  ) {
    return null;
  }

  const open = Number(raw.open);
  const high = Number(raw.high);
  const low = Number(raw.low);

  const hasValidOHLC =
    Number.isFinite(open) &&
    Number.isFinite(high) &&
    Number.isFinite(low) &&
    open > 0 &&
    high > 0 &&
    low > 0 &&
    high >= Math.max(
      open,
      close,
      low
    ) &&
    low <= Math.min(
      open,
      close,
      high
    );

  if (hasValidOHLC) {
    return {
      date,
      open,
      high,
      low,
      close,
      hasOHLC: true
    };
  }

  return {
    date,
    open: close,
    high: close,
    low: close,
    close,
    hasOHLC: false
  };
}

function normalizeRows(input) {
  if (!Array.isArray(input)) {
    return {
      rows: [],
      rejected: 0,
      duplicateDates: 0,
      hasOHLC: false
    };
  }

  const byDate = new Map();
  let rejected = 0;
  let duplicateDates = 0;

  for (const raw of input) {
    const candle =
      normalizeCandle(raw);

    if (!candle) {
      rejected++;
      continue;
    }

    if (byDate.has(candle.date)) {
      duplicateDates++;
    }

    byDate.set(
      candle.date,
      candle
    );
  }

  const rows = Array
    .from(byDate.values())
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date)
    );

  const hasOHLC =
    rows.length > 0 &&
    rows.every(row => row.hasOHLC);

  return {
    rows,
    rejected,
    duplicateDates,
    hasOHLC
  };
}

function candleDataQuality(
  normalized
) {
  const rows = normalized.rows;

  const firstDate =
    rows.length > 0
      ? rows[0].date
      : null;

  const lastDate =
    rows.length > 0
      ? rows[rows.length - 1].date
      : null;

  let ageDays = null;

  if (lastDate) {
    ageDays = daysBetween(
      lastDate,
      new Date()
        .toISOString()
        .slice(0, 10)
    );
  }

  return {
    validRows: rows.length,
    rejectedRows:
      normalized.rejected,

    duplicateDates:
      normalized.duplicateDates,

    firstDate,
    lastDate,
    ageDays,

    hasOHLC:
      normalized.hasOHLC,

    stale:
      ageDays !== null &&
      ageDays > 7
  };
}

/* =====================================================================
   Flexible Daily OHLC Reader
   ===================================================================== */

function extractPairRows(
  source,
  pair
) {
  if (!source) {
    return [];
  }

  if (Array.isArray(source)) {
    return source.filter(row => {
      const rowPair =
        row &&
        (
          row.pair ||
          row.symbol ||
          row.key
        );

      if (!rowPair) {
        return pair.type === "metal";
      }

      const normalizedPair =
        String(rowPair)
          .replace("/", "")
          .replace("-", "")
          .replace("_", "")
          .toUpperCase();

      return (
        normalizedPair === pair.key
      );
    });
  }

  if (typeof source !== "object") {
    return [];
  }

  const possibleKeys = [
    pair.key,
    pair.label,
    pair.label.replace("/", "-"),
    pair.label.replace("/", "_"),
    pair.label.replace("/", ""),
    pair.key.toLowerCase()
  ];

  for (const key of possibleKeys) {
    if (
      Array.isArray(source[key])
    ) {
      return source[key];
    }
  }

  if (
    source.pairs &&
    typeof source.pairs === "object"
  ) {
    for (const key of possibleKeys) {
      const pairData =
        source.pairs[key];

      if (Array.isArray(pairData)) {
        return pairData;
      }

      if (
        pairData &&
        Array.isArray(pairData.rows)
      ) {
        return pairData.rows;
      }

      if (
        pairData &&
        Array.isArray(pairData.candles)
      ) {
        return pairData.candles;
      }
    }
  }

  if (Array.isArray(source.rows)) {
    return extractPairRows(
      source.rows,
      pair
    );
  }

  if (Array.isArray(source.candles)) {
    return extractPairRows(
      source.candles,
      pair
    );
  }

  return [];
}

function readDailyOHLC(pair) {
  const raw = readJsonFile(
    DAILY_OHLC_PATH,
    null
  );

  const extracted =
    extractPairRows(raw, pair);

  return normalizeRows(extracted);
}

function readGoldHistory() {
  const raw = readJsonFile(
    GOLD_HISTORY_PATH,
    []
  );

  return normalizeRows(raw);
}

/* =====================================================================
   Fetch Helpers
   ===================================================================== */

async function fetchJsonWithTimeout(
  url,
  timeoutMs = FETCH_TIMEOUT_MS
) {
  const controller =
    new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    timeoutMs
  );

  try {
    const response = await fetch(
      url,
      {
        signal: controller.signal,
        headers: {
          accept: "application/json",
          "user-agent":
            "PipSight-Pro-AI/2.1"
        }
      }
    );

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status}`
      );
    }

    return await response.json();
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(
        `Request timed out after ${timeoutMs}ms`
      );
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchForexRows(pair) {
  const end = new Date();
  const start = new Date();

  start.setUTCDate(
    start.getUTCDate() - 420
  );

  const formatDate = date =>
    date.toISOString().slice(0, 10);

  const url =
    `https://api.frankfurter.dev/v1/` +
    `${formatDate(start)}..${formatDate(end)}` +
    `?base=${encodeURIComponent(pair.base)}` +
    `&symbols=${encodeURIComponent(pair.quote)}`;

  const data =
    await fetchJsonWithTimeout(url);

  if (
    !data ||
    !data.rates ||
    typeof data.rates !== "object"
  ) {
    throw new Error(
      "Rate service returned invalid data"
    );
  }

  const rows = Object
    .keys(data.rates)
    .sort()
    .map(date => ({
      date,
      close:
        Number(
          data.rates[date]?.[pair.quote]
        )
    }));

  return normalizeRows(rows);
}

/* =====================================================================
   Technical Indicator Helpers
   ===================================================================== */

function emaSeries(values, period) {
  const output =
    new Array(values.length).fill(null);

  if (
    !Array.isArray(values) ||
    period < 1 ||
    values.length < period
  ) {
    return output;
  }

  const multiplier =
    2 / (period + 1);

  let seed = 0;

  for (
    let index = 0;
    index < period;
    index++
  ) {
    seed += values[index];
  }

  let previous = seed / period;

  output[period - 1] =
    previous;

  for (
    let index = period;
    index < values.length;
    index++
  ) {
    previous =
      values[index] * multiplier +
      previous * (1 - multiplier);

    output[index] =
      previous;
  }

  return output;
}

function rsiSeries(
  values,
  period = 14
) {
  const output =
    new Array(values.length).fill(null);

  if (
    !Array.isArray(values) ||
    period < 1 ||
    values.length <= period
  ) {
    return output;
  }

  let gainSum = 0;
  let lossSum = 0;

  for (
    let index = 1;
    index <= period;
    index++
  ) {
    const difference =
      values[index] -
      values[index - 1];

    if (difference >= 0) {
      gainSum += difference;
    } else {
      lossSum -= difference;
    }
  }

  let averageGain =
    gainSum / period;

  let averageLoss =
    lossSum / period;

  output[period] =
    averageLoss === 0
      ? 100
      : 100 -
        100 /
          (
            1 +
            averageGain /
              averageLoss
          );

  for (
    let index = period + 1;
    index < values.length;
    index++
  ) {
    const difference =
      values[index] -
      values[index - 1];

    const gain =
      difference > 0
        ? difference
        : 0;

    const loss =
      difference < 0
        ? -difference
        : 0;

    averageGain =
      (
        averageGain *
          (period - 1) +
        gain
      ) / period;

    averageLoss =
      (
        averageLoss *
          (period - 1) +
        loss
      ) / period;

    output[index] =
      averageLoss === 0
        ? 100
        : 100 -
          100 /
            (
              1 +
              averageGain /
                averageLoss
            );
  }

  return output;
}

/* =====================================================================
   ATR and Volatility
   ===================================================================== */

function computeCloseVolatility(rows) {
  if (
    !Array.isArray(rows) ||
    rows.length < 3
  ) {
    return 0.004;
  }

  let sum = 0;
  let count = 0;

  for (
    let index = 1;
    index < rows.length;
    index++
  ) {
    const currentClose =
      rows[index].close;

    const previousClose =
      rows[index - 1].close;

    if (
      !isFiniteNumber(currentClose) ||
      !isFiniteNumber(previousClose) ||
      previousClose <= 0
    ) {
      continue;
    }

    sum +=
      Math.abs(
        currentClose -
        previousClose
      ) / previousClose;

    count++;
  }

  return count > 0
    ? sum / count
    : 0.004;
}

function trueRange(
  current,
  previousClose
) {
  if (
    !current ||
    !isFiniteNumber(current.high) ||
    !isFiniteNumber(current.low)
  ) {
    return null;
  }

  if (!isFiniteNumber(previousClose)) {
    return current.high - current.low;
  }

  return Math.max(
    current.high - current.low,
    Math.abs(
      current.high -
      previousClose
    ),
    Math.abs(
      current.low -
      previousClose
    )
  );
}

function atrSeries(
  rows,
  period = 14
) {
  const output =
    new Array(rows.length).fill(null);

  if (
    !Array.isArray(rows) ||
    rows.length <= period
  ) {
    return output;
  }

  const ranges =
    new Array(rows.length).fill(null);

  for (
    let index = 0;
    index < rows.length;
    index++
  ) {
    ranges[index] = trueRange(
      rows[index],
      index > 0
        ? rows[index - 1].close
        : null
    );
  }

  let seed = 0;
  let validSeed = true;

  for (
    let index = 1;
    index <= period;
    index++
  ) {
    if (!isFiniteNumber(ranges[index])) {
      validSeed = false;
      break;
    }

    seed += ranges[index];
  }

  if (!validSeed) {
    return output;
  }

  let previousATR =
    seed / period;

  output[period] =
    previousATR;

  for (
    let index = period + 1;
    index < rows.length;
    index++
  ) {
    const range =
      ranges[index];

    if (!isFiniteNumber(range)) {
      continue;
    }

    previousATR =
      (
        previousATR *
          (period - 1) +
        range
      ) / period;

    output[index] =
      previousATR;
  }

  return output;
}

function getVolatilityMetrics(rows) {
  const lastRow =
    rows[rows.length - 1];

  const lastClose =
    lastRow?.close;

  const hasOHLC =
    rows.length > 0 &&
    rows.every(
      row => row.hasOHLC
    );

  if (hasOHLC) {
    const period =
      Math.min(
        14,
        Math.max(
          2,
          rows.length - 1
        )
      );

    const series =
      atrSeries(rows, period);

    const atr =
      series[series.length - 1];

    if (
      isFiniteNumber(atr) &&
      atr > 0 &&
      isFiniteNumber(lastClose) &&
      lastClose > 0
    ) {
      return {
        type: "ATR",
        period,
        atr,
        percent:
          atr / lastClose,
        buffer:
          Math.max(
            atr * 0.5,
            lastClose * 0.0004
          )
      };
    }
  }

  const volatility =
    computeCloseVolatility(rows);

  return {
    type: "close-volatility",
    period: null,
    atr: null,
    percent: volatility,
    buffer:
      Math.max(
        volatility * 0.5,
        0.0004
      ) * lastClose
  };
}

/* =====================================================================
   Adaptive EMA Periods
   ===================================================================== */

function getAdaptivePeriods(length) {
  const cap =
    length - 1;

  const p200 =
    Math.min(200, cap);

  const p100 =
    Math.min(
      100,
      Math.max(
        4,
        Math.floor(p200 * 0.5)
      )
    );

  const p50 =
    Math.min(
      50,
      Math.max(
        3,
        Math.floor(p100 * 0.6)
      )
    );

  const p20 =
    Math.min(
      20,
      Math.max(
        2,
        Math.floor(p50 * 0.5)
      )
    );

  return {
    p20,
    p50,
    p100,
    p200,
    fullStack: cap >= 200
  };
}

function getEMAState(rows) {
  const closes =
    rows.map(row => row.close);

  const length =
    closes.length;

  if (length < 6) {
    return {
      direction: null,
      label:
        "Building history — not enough sessions yet",
      values: null,
      periods: null,
      bullCount: 0,
      bearCount: 0
    };
  }

  const periods =
    getAdaptivePeriods(length);

  const ema20 =
    emaSeries(
      closes,
      periods.p20
    );

  const ema50 =
    emaSeries(
      closes,
      periods.p50
    );

  const ema100 =
    emaSeries(
      closes,
      periods.p100
    );

  const ema200 =
    emaSeries(
      closes,
      periods.p200
    );

  const lastIndex =
    length - 1;

  const values = {
    ema20:
      ema20[lastIndex],

    ema50:
      ema50[lastIndex],

    ema100:
      ema100[lastIndex],

    ema200:
      ema200[lastIndex],

    close:
      closes[lastIndex]
  };

  if (
    Object.values(values)
      .some(value =>
        value == null
      )
  ) {
    return {
      direction: null,
      label:
        "Building EMA history — values not ready yet",
      values,
      periods,
      bullCount: 0,
      bearCount: 0
    };
  }

  const bullRules = [
    values.ema20 >
      values.ema50,

    values.ema50 >
      values.ema100,

    values.ema100 >
      values.ema200,

    values.close >
      values.ema20
  ];

  const bearRules = [
    values.ema20 <
      values.ema50,

    values.ema50 <
      values.ema100,

    values.ema100 <
      values.ema200,

    values.close <
      values.ema20
  ];

  const bullCount =
    bullRules.filter(Boolean).length;

  const bearCount =
    bearRules.filter(Boolean).length;

  const bullFull =
    bullCount === 4;

  const bearFull =
    bearCount === 4;

  const note =
    periods.fullStack
      ? ""
      : " (adaptive periods — full EMA200 needs more history)";

  let direction = null;
  let label;

  if (bullFull) {
    direction = "BUY";

    label =
      `Bullish — full EMA stack ` +
      `${periods.p20}>${periods.p50}>` +
      `${periods.p100}>${periods.p200}` +
      note;
  } else if (bearFull) {
    direction = "SELL";

    label =
      `Bearish — full EMA stack ` +
      `${periods.p20}<${periods.p50}<` +
      `${periods.p100}<${periods.p200}` +
      note;
  } else if (bullCount >= 3) {
    label =
      `Partial bullish lean only ` +
      `(${bullCount}/4) — not enough to qualify` +
      note;
  } else if (bearCount >= 3) {
    label =
      `Partial bearish lean only ` +
      `(${bearCount}/4) — not enough to qualify` +
      note;
  } else {
    label =
      "Mixed EMA alignment — no clear trend" +
      note;
  }

  return {
    direction,
    label,
    values,
    periods,
    bullCount,
    bearCount
  };
}

function trendDirectionOf(rows) {
  return getEMAState(rows).direction;
}

/* =====================================================================
   MACD
   ===================================================================== */

function computeMACD(rows) {
  const closes =
    rows.map(row => row.close);

  if (closes.length < 35) {
    return {
      ready: false,
      macd: null,
      signal: null,
      histogram: null
    };
  }

  const ema12 =
    emaSeries(closes, 12);

  const ema26 =
    emaSeries(closes, 26);

  const macdLine =
    closes.map((_, index) => {
      if (
        ema12[index] == null ||
        ema26[index] == null
      ) {
        return null;
      }

      return (
        ema12[index] -
        ema26[index]
      );
    });

  const validMACD =
    macdLine.filter(
      value => value != null
    );

  const signalSeries =
    emaSeries(validMACD, 9);

  const macd =
    macdLine[
      macdLine.length - 1
    ];

  const signal =
    signalSeries[
      signalSeries.length - 1
    ];

  if (
    !isFiniteNumber(macd) ||
    !isFiniteNumber(signal)
  ) {
    return {
      ready: false,
      macd,
      signal,
      histogram: null
    };
  }

  return {
    ready: true,
    macd,
    signal,
    histogram:
      macd - signal
  };
}

/* =====================================================================
   Support and Resistance
   ===================================================================== */

function dedupeLevels(
  levels,
  threshold = 0.0015
) {
  const sorted = levels
    .filter(isFiniteNumber)
    .sort((a, b) => a - b);

  const output = [];

  for (const level of sorted) {
    if (output.length === 0) {
      output.push(level);
      continue;
    }

    const previous =
      output[output.length - 1];

    const denominator =
      Math.max(
        Math.abs(level),
        Number.EPSILON
      );

    if (
      Math.abs(level - previous) /
        denominator >
      threshold
    ) {
      output.push(level);
    } else {
      output[
        output.length - 1
      ] =
        (
          previous +
          level
        ) / 2;
    }
  }

  return output;
}

function computeSR(rows, lastClose) {
  const length =
    rows.length;

  const radius =
    length > 40
      ? 2
      : 1;

  const useOHLC =
    rows.length > 0 &&
    rows.every(
      row => row.hasOHLC
    );

  const highs = [];
  const lows = [];

  for (
    let index = radius;
    index < length - radius;
    index++
  ) {
    const currentHigh =
      useOHLC
        ? rows[index].high
        : rows[index].close;

    const currentLow =
      useOHLC
        ? rows[index].low
        : rows[index].close;

    let isHigh = true;
    let isLow = true;

    for (
      let offset = 1;
      offset <= radius;
      offset++
    ) {
      const leftHigh =
        useOHLC
          ? rows[index - offset].high
          : rows[index - offset].close;

      const rightHigh =
        useOHLC
          ? rows[index + offset].high
          : rows[index + offset].close;

      const leftLow =
        useOHLC
          ? rows[index - offset].low
          : rows[index - offset].close;

      const rightLow =
        useOHLC
          ? rows[index + offset].low
          : rows[index + offset].close;

      if (
        currentHigh < leftHigh ||
        currentHigh < rightHigh
      ) {
        isHigh = false;
      }

      if (
        currentLow > leftLow ||
        currentLow > rightLow
      ) {
        isLow = false;
      }
    }

    if (isHigh) {
      highs.push(currentHigh);
    }

    if (isLow) {
      lows.push(currentLow);
    }
  }

  let resistances =
    dedupeLevels(highs)
      .filter(
        level => level > lastClose
      )
      .sort((a, b) => a - b)
      .slice(0, 2);

  let supports =
    dedupeLevels(lows)
      .filter(
        level => level < lastClose
      )
      .sort((a, b) => b - a)
      .slice(0, 2);

  if (
    resistances.length === 0 &&
    length >= 3
  ) {
    const maximum =
      Math.max(
        ...rows.map(row =>
          useOHLC
            ? row.high
            : row.close
        )
      );

    if (
      maximum >
      lastClose * 1.0005
    ) {
      resistances = [maximum];
    }
  }

  if (
    supports.length === 0 &&
    length >= 3
  ) {
    const minimum =
      Math.min(
        ...rows.map(row =>
          useOHLC
            ? row.low
            : row.close
        )
      );

    if (
      minimum <
      lastClose * 0.9995
    ) {
      supports = [minimum];
    }
  }

  return {
    resistances,
    supports,
    source:
      useOHLC
        ? "OHLC swing levels"
        : "close-price swing levels"
  };
}

/* =====================================================================
   Market Structure
   ===================================================================== */

function computeMarketStructure(rows) {
  const length =
    rows.length;

  if (length < 10) {
    return {
      label:
        "Building history — not enough sessions yet",
      score: 0,
      source: "insufficient-data"
    };
  }

  const useOHLC =
    rows.every(
      row => row.hasOHLC
    );

  const radius =
    length > 60
      ? 3
      : length > 30
        ? 2
        : 1;

  const highs = [];
  const lows = [];

  for (
    let index = radius;
    index < length - radius;
    index++
  ) {
    const currentHigh =
      useOHLC
        ? rows[index].high
        : rows[index].close;

    const currentLow =
      useOHLC
        ? rows[index].low
        : rows[index].close;

    let isHigh = true;
    let isLow = true;

    for (
      let offset = 1;
      offset <= radius;
      offset++
    ) {
      const leftHigh =
        useOHLC
          ? rows[index - offset].high
          : rows[index - offset].close;

      const rightHigh =
        useOHLC
          ? rows[index + offset].high
          : rows[index + offset].close;

      const leftLow =
        useOHLC
          ? rows[index - offset].low
          : rows[index - offset].close;

      const rightLow =
        useOHLC
          ? rows[index + offset].low
          : rows[index + offset].close;

      if (
        currentHigh < leftHigh ||
        currentHigh < rightHigh
      ) {
        isHigh = false;
      }

      if (
        currentLow > leftLow ||
        currentLow > rightLow
      ) {
        isLow = false;
      }
    }

    if (isHigh) {
      highs.push(currentHigh);
    }

    if (isLow) {
      lows.push(currentLow);
    }
  }

  if (
    highs.length < 2 ||
    lows.length < 2
  ) {
    return {
      label:
        "Not enough swing points yet",
      score: 0,
      source:
        useOHLC
          ? "OHLC"
          : "close"
    };
  }

  const recentHighs =
    highs.slice(-2);

  const recentLows =
    lows.slice(-2);

  const higherHigh =
    recentHighs[1] >
    recentHighs[0];

  const higherLow =
    recentLows[1] >
    recentLows[0];

  if (
    higherHigh &&
    higherLow
  ) {
    return {
      label:
        "Bullish structure — higher highs & higher lows",
      score: 15,
      source:
        useOHLC
          ? "OHLC"
          : "close"
    };
  }

  if (
    !higherHigh &&
    !higherLow
  ) {
    return {
      label:
        "Bearish structure — lower highs & lower lows",
      score: -15,
      source:
        useOHLC
          ? "OHLC"
          : "close"
    };
  }

  return {
    label:
      "Mixed structure — no clear HH/HL or LH/LL sequence",
    score: 0,
    source:
      useOHLC
        ? "OHLC"
        : "close"
  };
}

/* =====================================================================
   Candle Pattern Detection
   ===================================================================== */

function detectCandlePattern(rows) {
  if (
    !Array.isArray(rows) ||
    rows.length < 2 ||
    !rows.slice(-2).every(
      row => row.hasOHLC
    )
  ) {
    return {
      available: false,
      direction: null,
      pattern: null,
      detail:
        "Not available — valid OHLC candle data is required"
    };
  }

  const previous =
    rows[rows.length - 2];

  const current =
    rows[rows.length - 1];

  const previousBullish =
    previous.close >
    previous.open;

  const previousBearish =
    previous.close <
    previous.open;

  const currentBullish =
    current.close >
    current.open;

  const currentBearish =
    current.close <
    current.open;

  const currentBody =
    Math.abs(
      current.close -
      current.open
    );

  const fullRange =
    current.high -
    current.low;

  const upperWick =
    current.high -
    Math.max(
      current.open,
      current.close
    );

  const lowerWick =
    Math.min(
      current.open,
      current.close
    ) -
    current.low;

  if (
    previousBearish &&
    currentBullish &&
    current.open <= previous.close &&
    current.close >= previous.open
  ) {
    return {
      available: true,
      direction: "BUY",
      pattern:
        "Bullish Engulfing",
      detail:
        "Bullish engulfing candle confirms buying pressure"
    };
  }

  if (
    previousBullish &&
    currentBearish &&
    current.open >= previous.close &&
    current.close <= previous.open
  ) {
    return {
      available: true,
      direction: "SELL",
      pattern:
        "Bearish Engulfing",
      detail:
        "Bearish engulfing candle confirms selling pressure"
    };
  }

  if (
    fullRange > 0 &&
    lowerWick >= currentBody * 2 &&
    upperWick <= currentBody &&
    currentBullish
  ) {
    return {
      available: true,
      direction: "BUY",
      pattern: "Bullish Pin Bar",
      detail:
        "Long lower wick indicates rejection of lower prices"
    };
  }

  if (
    fullRange > 0 &&
    upperWick >= currentBody * 2 &&
    lowerWick <= currentBody &&
    currentBearish
  ) {
    return {
      available: true,
      direction: "SELL",
      pattern: "Bearish Pin Bar",
      detail:
        "Long upper wick indicates rejection of higher prices"
    };
  }

  if (
    fullRange > 0 &&
    currentBody /
      fullRange <=
      0.1
  ) {
    return {
      available: true,
      direction: null,
      pattern: "Doji",
      detail:
        "Doji shows indecision and does not confirm either direction"
    };
  }

  return {
    available: true,
    direction: null,
    pattern: "No strong pattern",
    detail:
      "No qualifying engulfing, pin-bar or doji confirmation"
  };
}

/* =====================================================================
   Weekly OHLC Resampling
   ===================================================================== */

function isoWeekKey(dateString) {
  const date =
    new Date(
      dateString +
      "T00:00:00Z"
    );

  const day =
    (
      date.getUTCDay() +
      6
    ) % 7;

  date.setUTCDate(
    date.getUTCDate() -
    day +
    3
  );

  const firstThursday =
    new Date(
      Date.UTC(
        date.getUTCFullYear(),
        0,
        4
      )
    );

  const firstDay =
    (
      firstThursday.getUTCDay() +
      6
    ) % 7;

  const week =
    1 +
    Math.round(
      (
        (
          date -
          firstThursday
        ) /
          86400000 -
        3 +
        firstDay
      ) / 7
    );

  return (
    date.getUTCFullYear() +
    "-W" +
    String(week).padStart(2, "0")
  );
}

function resampleWeekly(rows) {
  const weeks =
    new Map();

  for (const row of rows) {
    const key =
      isoWeekKey(row.date);

    if (!weeks.has(key)) {
      weeks.set(key, {
        date: row.date,
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        hasOHLC: row.hasOHLC,
        firstDate: row.date,
        lastDate: row.date
      });

      continue;
    }

    const week =
      weeks.get(key);

    week.high =
      Math.max(
        week.high,
        row.high
      );

    week.low =
      Math.min(
        week.low,
        row.low
      );

    week.close =
      row.close;

    week.date =
      row.date;

    week.lastDate =
      row.date;

    week.hasOHLC =
      week.hasOHLC &&
      row.hasOHLC;
  }

  return Array.from(
    weeks.values()
  ).map(week => ({
    date: week.date,
    open: week.open,
    high: week.high,
    low: week.low,
    close: week.close,
    hasOHLC: week.hasOHLC,
    firstDate: week.firstDate,
    lastDate: week.lastDate
  }));
}

function rowsForMode(rows, mode) {
  return mode === "weekly"
    ? resampleWeekly(rows)
    : rows;
}

/* =====================================================================
   News Feed
   ===================================================================== */

function readNewsFeed() {
  const raw =
    readJsonFile(
      NEWS_FEED_PATH,
      {}
    );

  const items =
    Array.isArray(raw)
      ? raw
      : Array.isArray(raw.items)
        ? raw.items
        : [];

  const normalizedItems =
    items
      .filter(
        item =>
          item &&
          typeof item === "object"
      )
      .map(item => {
        const sentiment =
          Number(item.sentiment);

        return {
          pair:
            typeof item.pair === "string"
              ? item.pair
              : null,

          impact:
            typeof item.impact === "string"
              ? item.impact.toLowerCase()
              : "unknown",

          sentiment:
            Number.isFinite(sentiment)
              ? sentiment
              : 0,

          text:
            typeof item.text === "string"
              ? item.text
              : typeof item.title === "string"
                ? item.title
                : "Untitled news item",

          source:
            typeof item.source === "string"
              ? item.source
              : "Unknown source",

          publishedAt:
            typeof item.publishedAt === "string"
              ? item.publishedAt
              : typeof item.timestamp === "string"
                ? item.timestamp
                : null
        };
      });

  const sentimentByPair = {};

  for (const item of normalizedItems) {
    if (!item.pair) {
      continue;
    }

    sentimentByPair[item.pair] =
      (
        sentimentByPair[item.pair] ||
        0
      ) + item.sentiment;
  }

  return {
    items: normalizedItems,
    sentimentByPair
  };
}

/* =====================================================================
   Main Legacy-Compatible Analysis Pipeline
   ===================================================================== */

function analyze(
  rows,
  pairLabel,
  newsScoreRaw,
  htfRows,
  newsItems
) {
  const closes =
    rows.map(row => row.close);

  const length =
    closes.length;

  const lastClose =
    closes[length - 1];

  const lastRow =
    rows[length - 1];

  const pipeline = [];

  let alive = true;

  function addRequiredStep(
    name,
    passed,
    detail
  ) {
    if (!alive) {
      pipeline.push({
        name,
        status: "skip",
        detail:
          "Not reached — an earlier required step failed"
      });

      return false;
    }

    pipeline.push({
      name,
      status:
        passed
          ? "pass"
          : "fail",
      detail
    });

    if (!passed) {
      alive = false;
    }

    return passed;
  }

  function addNA(
    name,
    detail
  ) {
    pipeline.push({
      name,
      status: "na",
      detail
    });
  }

  function addInfo(
    name,
    detail
  ) {
    pipeline.push({
      name,
      status: "info",
      detail
    });
  }

  /* -----------------------------------------------------------------
     1. Trend
     ----------------------------------------------------------------- */

  const emaState =
    getEMAState(rows);

  const leanDirection =
    emaState.direction;

  const trendLabel =
    emaState.label;

  addRequiredStep(
    "Trend",
    Boolean(leanDirection),
    trendLabel
  );

  /* -----------------------------------------------------------------
     2. EMA Alignment
     ----------------------------------------------------------------- */

  addRequiredStep(
    "EMA Alignment",
    Boolean(leanDirection),
    leanDirection
      ? (
          "Full EMA stack confirms " +
          (
            leanDirection === "BUY"
              ? "bullish"
              : "bearish"
          ) +
          " alignment"
        )
      : "Stack is not fully aligned in order"
  );

  /* -----------------------------------------------------------------
     3. ADX
     Existing legacy behavior remains non-gating.
     ----------------------------------------------------------------- */

  addNA(
    "ADX > 25?",
    rows.every(row => row.hasOHLC)
      ? (
          "OHLC data is available, but ADX remains informationally " +
          "disabled here to preserve the existing decision engine"
        )
      : (
          "Not available — true ADX needs high/low candle data"
        )
  );

  /* -----------------------------------------------------------------
     4. Volume
     ----------------------------------------------------------------- */

  addNA(
    "Volume Confirmed?",
    "Not available — spot FX/gold has no centralized exchange volume feed"
  );

  /* -----------------------------------------------------------------
     5. MACD Confirmation
     ----------------------------------------------------------------- */

  const macdState =
    computeMACD(rows);

  let macdPassed = false;
  let macdDetail;

  if (!leanDirection) {
    macdDetail =
      "No confirmed trend direction to test against";
  } else if (!macdState.ready) {
    const remaining =
      Math.max(
        0,
        35 - length
      );

    macdDetail =
      remaining > 0
        ? (
            `Needs ${remaining} more session` +
            `${remaining === 1 ? "" : "s"} of history for MACD`
          )
        : "MACD values are not ready yet";
  } else {
    macdPassed =
      leanDirection === "BUY"
        ? (
            macdState.macd >
            macdState.signal
          )
        : (
            macdState.macd <
            macdState.signal
          );

    macdDetail =
      `MACD ${macdState.macd.toFixed(4)} ` +
      `vs signal ${macdState.signal.toFixed(4)} — ` +
      `${macdPassed ? "confirms" : "does not confirm"} ` +
      leanDirection;
  }

  addRequiredStep(
    "MACD Confirmation",
    leanDirection
      ? (
          macdState.ready &&
          macdPassed
        )
      : false,
    macdDetail
  );

  /* -----------------------------------------------------------------
     6. RSI Confirmation
     ----------------------------------------------------------------- */

  const rsiPeriod =
    Math.min(
      14,
      Math.max(
        4,
        length - 2
      )
    );

  const rsi =
    rsiSeries(
      closes,
      rsiPeriod
    );

  const lastRSI =
    rsi[rsi.length - 1];

  const rsiBuyPassed =
    lastRSI != null &&
    lastRSI >= 45 &&
    lastRSI <= 65;

  const rsiSellPassed =
    lastRSI != null &&
    lastRSI >= 35 &&
    lastRSI <= 55;

  let rsiPassed = false;
  let rsiDetail;

  if (!leanDirection) {
    rsiDetail =
      "No confirmed trend direction to test against";
  } else if (lastRSI == null) {
    rsiDetail =
      "Not enough history for RSI yet";
  } else {
    rsiPassed =
      leanDirection === "BUY"
        ? rsiBuyPassed
        : rsiSellPassed;

    rsiDetail =
      `RSI(${rsiPeriod}) = ${lastRSI.toFixed(1)} — ` +
      `${rsiPassed ? "inside" : "outside"} the ` +
      `${leanDirection === "BUY" ? "45–65" : "35–55"} ` +
      "confirmation band";
  }

  addRequiredStep(
    "RSI Confirmation",
    leanDirection
      ? (
          lastRSI != null &&
          rsiPassed
        )
      : false,
    rsiDetail
  );

  /* -----------------------------------------------------------------
     7. Multi-Timeframe Confirmation
     ----------------------------------------------------------------- */

  let htfDirection = null;
  let htfPassed = false;
  let htfDetail;

  if (!leanDirection) {
    htfDetail =
      "No confirmed trend direction to test against";
  } else if (
    htfRows === null ||
    htfRows === undefined
  ) {
    htfPassed = true;

    htfDetail =
      "Already viewing the highest timeframe available for this pair — " +
      "no higher chart to confirm against";
  } else {
    htfDirection =
      trendDirectionOf(htfRows);

    if (htfDirection == null) {
      htfDetail =
        "Higher-timeframe weekly trend is not clearly aligned yet";
    } else {
      htfPassed =
        htfDirection ===
        leanDirection;

      htfDetail =
        `Weekly trend is ${htfDirection} — ` +
        `${htfPassed ? "agrees with" : "conflicts with"} ` +
        `this ${leanDirection} lean`;
    }
  }

  addRequiredStep(
    "Multi-Timeframe Confirmation",
    leanDirection
      ? htfPassed
      : false,
    htfDetail
  );

  /* -----------------------------------------------------------------
     8. Candle Pattern

     Legacy compatibility:
     - When no OHLC exists: informational N/A.
     - When OHLC exists: pattern is reported but does not gate the trade.
     ----------------------------------------------------------------- */

  const candlePattern =
    detectCandlePattern(rows);

  if (!candlePattern.available) {
    addNA(
      "Candle Pattern",
      candlePattern.detail
    );
  } else {
    let candleDetail =
      `${candlePattern.pattern}: ${candlePattern.detail}`;

    if (
      candlePattern.direction &&
      leanDirection
    ) {
      candleDetail +=
        candlePattern.direction ===
        leanDirection
          ? ` — agrees with ${leanDirection}`
          : ` — conflicts with ${leanDirection}`;
    }

    addInfo(
      "Candle Pattern",
      candleDetail
    );
  }

  /* -----------------------------------------------------------------
     9. High-Impact News Filter
     ----------------------------------------------------------------- */

  const recentNews =
    Array.isArray(newsItems)
      ? newsItems.filter(
          item =>
            item.pair === pairLabel
        )
      : [];

  let newsFilterPassed = false;
  let newsFilterDetail;

  if (!leanDirection) {
    newsFilterDetail =
      "No confirmed trend direction to test against";
  } else {
    const conflicting =
      recentNews.find(item => {
        if (
          item.impact !== "high"
        ) {
          return false;
        }

        return (
          (
            leanDirection === "BUY" &&
            item.sentiment <= -10
          ) ||
          (
            leanDirection === "SELL" &&
            item.sentiment >= 10
          )
        );
      });

    if (conflicting) {
      newsFilterPassed = false;

      const snippet =
        conflicting.text.length > 80
          ? (
              conflicting.text.slice(
                0,
                80
              ) + "…"
            )
          : conflicting.text;

      newsFilterDetail =
        `Conflicting high-impact headline: "${snippet}" ` +
        `(${conflicting.source})`;
    } else {
      const highImpactCount =
        recentNews.filter(
          item =>
            item.impact === "high"
        ).length;

      newsFilterPassed = true;

      newsFilterDetail =
        highImpactCount > 0
          ? (
              `${highImpactCount} high-impact headline` +
              `${highImpactCount === 1 ? "" : "s"} tracked, ` +
              `none conflict with this ${leanDirection}`
            )
          : (
              "No high-impact catalysts currently flagged for this pair"
            );
    }
  }

  addRequiredStep(
    "High-Impact News Filter",
    leanDirection
      ? newsFilterPassed
      : false,
    newsFilterDetail
  );

  /* -----------------------------------------------------------------
     10. Support and Resistance
     ----------------------------------------------------------------- */

  const supportResistance =
    computeSR(
      rows,
      lastClose
    );

  let srPassed = false;
  let srDetail;

  if (!leanDirection) {
    srDetail =
      "No confirmed trend direction to test against";
  } else if (
    leanDirection === "BUY"
  ) {
    const resistance =
      supportResistance
        .resistances[0];

    if (resistance == null) {
      srPassed = true;

      srDetail =
        `No resistance detected nearby using ` +
        supportResistance.source;
    } else {
      const distance =
        (
          resistance -
          lastClose
        ) / lastClose;

      srPassed =
        distance >= 0.003;

      srDetail =
        srPassed
          ? (
              `Resistance ${(distance * 100).toFixed(2)}% away — ` +
              `clear room to run (${supportResistance.source})`
            )
          : (
              `Resistance only ${(distance * 100).toFixed(2)}% above spot — ` +
              `too close to buy into (${supportResistance.source})`
            );
    }
  } else {
    const support =
      supportResistance
        .supports[0];

    if (support == null) {
      srPassed = true;

      srDetail =
        `No support detected nearby using ` +
        supportResistance.source;
    } else {
      const distance =
        (
          lastClose -
          support
        ) / lastClose;

      srPassed =
        distance >= 0.003;

      srDetail =
        srPassed
          ? (
              `Support ${(distance * 100).toFixed(2)}% away — ` +
              `clear room to run (${supportResistance.source})`
            )
          : (
              `Support only ${(distance * 100).toFixed(2)}% below spot — ` +
              `too close to sell into (${supportResistance.source})`
            );
    }
  }

  addRequiredStep(
    "Support/Resistance",
    leanDirection
      ? srPassed
      : false,
    srDetail
  );

  /* -----------------------------------------------------------------
     11. ATR / Volatility Stop
     ----------------------------------------------------------------- */

  const volatility =
    getVolatilityMetrics(rows);

  const buffer =
    volatility.buffer;

  if (
    leanDirection &&
    alive
  ) {
    const detail =
      volatility.type === "ATR"
        ? (
            `ATR(${volatility.period}) = ` +
            `${volatility.atr.toFixed(
              lastClose > 100
                ? 2
                : 5
            )}, stop buffer ≈ ` +
            `${buffer.toFixed(
              lastClose > 100
                ? 2
                : 5
            )}`
          )
        : (
            `Volatility-based buffer ≈ ` +
            `${buffer.toFixed(
              lastClose > 100
                ? 2
                : 5
            )} ` +
            `(average close move ` +
            `${(volatility.percent * 100).toFixed(2)}%)`
          );

    pipeline.push({
      name:
        volatility.type === "ATR"
          ? "ATR Stop Loss"
          : "ATR-style Stop Loss",

      status: "pass",
      detail
    });
  } else if (leanDirection) {
    pipeline.push({
      name:
        volatility.type === "ATR"
          ? "ATR Stop Loss"
          : "ATR-style Stop Loss",

      status: "skip",
      detail:
        "Not reached — an earlier required step failed"
    });
  } else {
    pipeline.push({
      name:
        volatility.type === "ATR"
          ? "ATR Stop Loss"
          : "ATR-style Stop Loss",

      status: "skip",
      detail:
        "No confirmed trend direction yet"
    });
  }

  /* -----------------------------------------------------------------
     12. Trade Plan and Risk:Reward
     ----------------------------------------------------------------- */

  let tradePlan = null;

  if (
    leanDirection &&
    alive
  ) {
    const support =
      supportResistance
        .supports[0];

    const resistance =
      supportResistance
        .resistances[0];

    let stop;
    let target1;
    let target2;
    let target3;

    if (leanDirection === "BUY") {
      stop =
        support != null
          ? support - buffer
          : lastClose -
            buffer * 3;

      let risk =
        lastClose - stop;

      if (
        !isFiniteNumber(risk) ||
        risk <= 0
      ) {
        stop =
          lastClose -
          buffer * 3;

        risk =
          lastClose - stop;
      }

      target1 =
        resistance != null
          ? resistance
          : lastClose +
            risk * 2;

      target2 =
        Math.max(
          target1,
          lastClose +
            risk * 3
        );

      target3 =
        Math.max(
          target2,
          lastClose +
            risk * 4
        );
    } else {
      stop =
        resistance != null
          ? resistance + buffer
          : lastClose +
            buffer * 3;

      let risk =
        stop - lastClose;

      if (
        !isFiniteNumber(risk) ||
        risk <= 0
      ) {
        stop =
          lastClose +
          buffer * 3;

        risk =
          stop - lastClose;
      }

      target1 =
        support != null
          ? support
          : lastClose -
            risk * 2;

      target2 =
        Math.min(
          target1,
          lastClose -
            risk * 3
        );

      target3 =
        Math.min(
          target2,
          lastClose -
            risk * 4
        );
    }

    const risk =
      Math.abs(
        lastClose -
        stop
      );

    const reward1 =
      Math.abs(
        target1 -
        lastClose
      );

    const riskReward =
      risk > 0
        ? reward1 / risk
        : 0;

    const riskRewardPassed =
      addRequiredStep(
        "Risk:Reward ≥ 1:2",
        riskReward >= 2,
        `Risk:Reward to TP1 = 1:${riskReward.toFixed(1)} — ` +
        `${riskReward >= 2 ? "meets" : "below"} the 1:2 minimum`
      );

    if (riskRewardPassed) {
      tradePlan = {
        direction:
          leanDirection,

        entry:
          lastClose,

        stop,
        target1,
        target2,
        target3,

        risk,
        rr:
          riskReward,

        stopMethod:
          volatility.type,

        volatilityPercent:
          volatility.percent,

        atr:
          volatility.atr,

        atrPeriod:
          volatility.period
      };
    }
  } else {
    addRequiredStep(
      "Risk:Reward ≥ 1:2",
      false,
      "No confirmed trade setup reached this step"
    );
  }

  /* -----------------------------------------------------------------
     Final Signal
     ----------------------------------------------------------------- */

  const signal =
    tradePlan
      ? tradePlan.direction
      : "HOLD";

  const failedStep =
    pipeline.find(
      step =>
        step.status === "fail"
    );

  const suppressionReason =
    signal === "HOLD"
      ? (
          leanDirection
            ? (
                `NO TRADE — stopped at "` +
                `${failedStep ? failedStep.name : "an earlier step"}"`
              )
            : (
                "NO TRADE — no confirmed trend direction yet"
              )
        )
      : null;

  /* -----------------------------------------------------------------
     Informational Confidence
     ----------------------------------------------------------------- */

  const structure =
    computeMarketStructure(rows);

  const newsScore =
    clamp(
      Number(newsScoreRaw) || 0,
      -10,
      10
    );

  const gatedSteps =
    pipeline.filter(
      step =>
        step.status === "pass" ||
        step.status === "fail"
    );

  const passCount =
    gatedSteps.filter(
      step =>
        step.status === "pass"
    ).length;

  let confidence = null;

  if (leanDirection) {
    let score =
      gatedSteps.length > 0
        ? (
            passCount /
            gatedSteps.length
          ) * 70
        : 0;

    if (
      structure.score > 0 &&
      leanDirection === "BUY"
    ) {
      score += 12;
    } else if (
      structure.score < 0 &&
      leanDirection === "SELL"
    ) {
      score += 12;
    } else if (
      structure.score !== 0
    ) {
      score -= 8;
    }

    if (
      newsScore >= 3 &&
      leanDirection === "BUY"
    ) {
      score += 9;
    } else if (
      newsScore <= -3 &&
      leanDirection === "SELL"
    ) {
      score += 9;
    } else if (
      Math.abs(newsScore) >= 3
    ) {
      score -= 9;
    }

    if (
      htfDirection &&
      htfDirection ===
        leanDirection
    ) {
      score += 9;
    }

    if (
      candlePattern.direction &&
      candlePattern.direction ===
        leanDirection
    ) {
      score += 4;
    } else if (
      candlePattern.direction &&
      candlePattern.direction !==
        leanDirection
    ) {
      score -= 4;
    }

    confidence =
      clamp(
        Math.round(score),
        5,
        97
      );
  }

  addInfo(
    "Confidence Score",
    confidence != null
      ? (
          `${confidence}% — composite of pipeline pass-rate, ` +
          "market structure, news alignment, candle context and " +
          "multi-timeframe agreement. It does not override the legacy gate."
        )
      : (
          "No confirmed trend direction yet to score"
        )
  );

  return {
    lastClose,
    n: length,

    lastDate:
      lastRow?.date || null,

    pipeline,
    trendLabel,
    leanDirection,

    ema: {
      periods:
        emaState.periods,

      values:
        emaState.values,

      bullCount:
        emaState.bullCount,

      bearCount:
        emaState.bearCount
    },

    macd:
      macdState,

    rsi: {
      period:
        rsiPeriod,

      value:
        lastRSI
    },

    structure,

    sr:
      supportResistance,

    candlePattern,

    volatility,

    newsScore,

    confidence,

    signal,
    suppressionReason,
    tradePlan,

    passCount,

    gatedCount:
      gatedSteps.length,

    diagnostics: {
      hasOHLC:
        rows.every(
          row => row.hasOHLC
        ),

      htfDirection,

      engineVersion:
        ENGINE_VERSION,

      strategyVersion:
        STRATEGY_VERSION
    }
  };
}

/* =====================================================================
   Source Selection
   ===================================================================== */

async function loadPairRows(pair) {
  const dailyOHLC =
    readDailyOHLC(pair);

  if (
    dailyOHLC.rows.length >=
    MIN_DAILY_ROWS
  ) {
    return {
      ...dailyOHLC,
      source:
        "daily-ohlc.json"
    };
  }

  if (pair.type === "metal") {
    const goldHistory =
      readGoldHistory();

    return {
      ...goldHistory,
      source:
        "xau-usd-history.json"
    };
  }

  const forexRows =
    await fetchForexRows(pair);

  return {
    ...forexRows,
    source:
      "frankfurter.dev"
  };
}
