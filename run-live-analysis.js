// run-live-analysis.js
//
// PipSight Pro — live multi-engine analysis.
//
// Compatibility guarantees:
// - Existing Swing, Intraday, Scalp, Master, Telegram and history behavior retained.
// - data/scalp-signals.json is the primary Scalp source.
// - Legacy scalp candle analysis remains available as fallback.
// - WAIT and neutral-style decisions are normalized to HOLD.
// - XAU/USD and GBP/JPY pair aliases are normalized safely.
// - Existing output field names remain supported.
// - Reliability features are additive only.
//
// Reads:
//   data/scalp-signals.json
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

const ENGINE_VERSION = "1.2.0-pro-integrated";
const STRATEGY_VERSION = "legacy-compatible-1.0";
const TELEGRAM_TIMEOUT_MS = 15000;
const DAY_MS = 24 * 60 * 60 * 1000;

const DATA_DIR = path.join(__dirname, "data");

const HISTORY_PATH = path.join(
  DATA_DIR,
  "analysis-history.json"
);

const NOTIFY_STATE_PATH = path.join(
  DATA_DIR,
  "notify-state.json"
);

const LIVE_ANALYSIS_PATH = path.join(
  DATA_DIR,
  "live-analysis.json"
);

const PAIR_KEYS = ["XAUUSD", "GBPJPY"];

const DECIMALS = {
  XAUUSD: 2,
  GBPJPY: 3,
};

const PAIR_ALIASES = {
  XAUUSD: [
    "XAUUSD",
    "XAU/USD",
    "XAU-USD",
    "XAU_USD",
  ],
  GBPJPY: [
    "GBPJPY",
    "GBP/JPY",
    "GBP-JPY",
    "GBP_JPY",
  ],
};

// ===================== Safe file helpers =====================

function readJSON(fileName) {
  const filePath = path.join(DATA_DIR, fileName);

  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    return JSON.parse(
      fs.readFileSync(filePath, "utf8")
    );
  } catch (error) {
    console.error(
      `Could not parse data/${fileName}:`,
      error.message
    );

    return null;
  }
}

function atomicWriteJSON(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), {
    recursive: true,
  });

  const tempPath =
    `${filePath}.${process.pid}.${Date.now()}.tmp`;

  fs.writeFileSync(
    tempPath,
    JSON.stringify(value, null, 2),
    "utf8"
  );

  fs.renameSync(tempPath, filePath);
}

// ===================== Generic normalization helpers =====================

function isFiniteNumber(value) {
  return (
    typeof value === "number" &&
    Number.isFinite(value)
  );
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    if (
      value === null ||
      value === undefined ||
      value === ""
    ) {
      continue;
    }

    const numeric = Number(value);

    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }

  return null;
}

function firstString(...values) {
  for (const value of values) {
    if (
      typeof value === "string" &&
      value.trim()
    ) {
      return value.trim();
    }
  }

  return null;
}

function normalizeTime(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  const parsed = Date.parse(trimmed);

  return Number.isNaN(parsed)
    ? null
    : trimmed;
}

function normalizePairKey(value) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

  return PAIR_KEYS.includes(normalized)
    ? normalized
    : null;
}

function normalizeSignalDecision(value) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value
    .trim()
    .toUpperCase()
    .replace(/\s+/g, " ");

  if (
    normalized === "WAIT" ||
    normalized === "NEUTRAL" ||
    normalized === "NO TRADE" ||
    normalized === "NO_TRADE"
  ) {
    return "HOLD";
  }

  if (
    normalized === "BUY" ||
    normalized === "SELL" ||
    normalized === "HOLD"
  ) {
    return normalized;
  }

  return null;
}

function roundPrice(value, decimals) {
  if (!isFiniteNumber(value)) {
    return null;
  }

  return Number(value.toFixed(decimals));
}

// ===================== Candle validation =====================

function normalizeCandle(row, timeField) {
  if (!row || typeof row !== "object") {
    return null;
  }

  const timeValue = normalizeTime(row[timeField]);

  const open = Number(row.open);
  const high = Number(row.high);
  const low = Number(row.low);
  const close = Number(row.close);

  const prices = [open, high, low, close];

  if (
    !timeValue ||
    !prices.every(Number.isFinite) ||
    prices.some((value) => value <= 0) ||
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

  const rowsByTime = new Map();

  let invalidRows = 0;
  let duplicateRows = 0;

  for (const row of rows) {
    const normalized = normalizeCandle(
      row,
      timeField
    );

    if (!normalized) {
      invalidRows += 1;
      continue;
    }

    const key = normalized[timeField];

    if (rowsByTime.has(key)) {
      duplicateRows += 1;
    }

    rowsByTime.set(key, normalized);
  }

  const cleanRows = [...rowsByTime.values()]
    .sort((a, b) =>
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
      stale: latest
        ? Date.now() - Date.parse(latest) >
          7 * DAY_MS
        : true,
    },
  };
}

// ===================== Dedicated scalp signal helpers =====================

function findPairRecord(container, pairKey) {
  if (!container) {
    return null;
  }

  if (Array.isArray(container)) {
    return (
      container.find((item) => {
        if (
          !item ||
          typeof item !== "object"
        ) {
          return false;
        }

        const itemPair = firstString(
          item.pair,
          item.symbol,
          item.pairKey,
          item.instrument,
          item.market
        );

        return (
          normalizePairKey(itemPair) === pairKey
        );
      }) || null
    );
  }

  if (typeof container !== "object") {
    return null;
  }

  const aliases =
    PAIR_ALIASES[pairKey] || [pairKey];

  for (const alias of aliases) {
    if (
      Object.prototype.hasOwnProperty.call(
        container,
        alias
      )
    ) {
      return container[alias];
    }
  }

  for (
    const [rawKey, value] of
    Object.entries(container)
  ) {
    if (
      normalizePairKey(rawKey) === pairKey
    ) {
      return value;
    }
  }

  return null;
}

function extractDecisionFromRecord(record) {
  if (!record || typeof record !== "object") {
    return null;
  }

  return normalizeSignalDecision(
    firstString(
      record.decision,
      record.signal,
      record.verdict,
      record.action,
      record.recommendation,
      record.side
    )
  );
}

function unwrapScalpRecord(record) {
  if (!record || typeof record !== "object") {
    return null;
  }

  const candidates = [
    record.scalp,
    record.signalData,
    record.analysis,
    record.result,
    record.latest,
    record.current,
    record,
  ];

  for (const candidate of candidates) {
    if (
      candidate &&
      typeof candidate === "object" &&
      extractDecisionFromRecord(candidate)
    ) {
      return candidate;
    }
  }

  return record;
}

function findDedicatedScalpPairRecord(
  rawScalpSignals,
  pairKey
) {
  if (
    !rawScalpSignals ||
    typeof rawScalpSignals !== "object"
  ) {
    return null;
  }

  const containers = [
    rawScalpSignals.pairs,
    rawScalpSignals.signals,
    rawScalpSignals.results,
    rawScalpSignals.data,
    rawScalpSignals.latest,
    rawScalpSignals,
  ];

  for (const container of containers) {
    const record = findPairRecord(
      container,
      pairKey
    );

    if (record) {
      return record;
    }
  }

  return null;
}

function resolveDedicatedScalpSignal(
  rawScalpSignals,
  pairKey,
  decimals
) {
  if (
    !rawScalpSignals ||
    typeof rawScalpSignals !== "object"
  ) {
    return {
      valid: false,
      reason:
        "data/scalp-signals.json is missing or unreadable",
      signal: null,
      meta: {
        available: false,
        pairFound: false,
        valid: false,
        decision: null,
        updatedAt: null,
        stale: null,
      },
    };
  }

  const pairRecord =
    findDedicatedScalpPairRecord(
      rawScalpSignals,
      pairKey
    );

  if (!pairRecord) {
    return {
      valid: false,
      reason:
        `No dedicated scalp record found for ${pairKey}`,
      signal: null,
      meta: {
        available: true,
        pairFound: false,
        valid: false,
        decision: null,
        updatedAt:
          normalizeTime(
            firstString(
              rawScalpSignals.updatedAt,
              rawScalpSignals.generatedAt,
              rawScalpSignals.timestamp,
              rawScalpSignals.time
            )
          ),
        stale: null,
      },
    };
  }

  const record = unwrapScalpRecord(pairRecord);

  const decision =
    extractDecisionFromRecord(record);

  if (!decision) {
    return {
      valid: false,
      reason:
        `Dedicated scalp record for ${pairKey} has no valid BUY, SELL, HOLD or WAIT decision`,
      signal: null,
      meta: {
        available: true,
        pairFound: true,
        valid: false,
        decision: null,
        updatedAt: null,
        stale: null,
      },
    };
  }

  const tradePlan =
    record.tradePlan &&
    typeof record.tradePlan === "object"
      ? record.tradePlan
      : {};

  const entry = firstFiniteNumber(
    record.entry,
    record.entryPrice,
    record.price,
    record.currentPrice,
    tradePlan.entry,
    tradePlan.entryPrice
  );

  const sl = firstFiniteNumber(
    record.sl,
    record.stop,
    record.stopLoss,
    record.stop_loss,
    tradePlan.sl,
    tradePlan.stop,
    tradePlan.stopLoss
  );

  const tp = firstFiniteNumber(
    record.tp,
    record.target,
    record.target1,
    record.takeProfit,
    record.take_profit,
    tradePlan.tp,
    tradePlan.target,
    tradePlan.target1,
    tradePlan.takeProfit
  );

  let rr = firstFiniteNumber(
    record.rr,
    record.riskReward,
    record.risk_reward,
    tradePlan.rr,
    tradePlan.riskReward
  );

  if (
    rr == null &&
    entry != null &&
    sl != null &&
    tp != null
  ) {
    const risk = Math.abs(entry - sl);
    const reward = Math.abs(tp - entry);

    rr = risk > 0
      ? reward / risk
      : null;
  }

  const updatedAt = normalizeTime(
    firstString(
      record.updatedAt,
      record.generatedAt,
      record.timestamp,
      record.time,
      pairRecord.updatedAt,
      rawScalpSignals.updatedAt,
      rawScalpSignals.generatedAt,
      rawScalpSignals.timestamp,
      rawScalpSignals.time
    )
  );

  const reason =
    firstString(
      record.reason,
      record.explanation,
      record.suppressionReason,
      record.message
    ) ||
    (
      decision === "HOLD"
        ? "Dedicated scalp engine returned HOLD"
        : "Dedicated scalp engine signal"
    );

  const perTF = Array.isArray(record.perTF)
    ? record.perTF
    : Array.isArray(record.timeframes)
      ? record.timeframes
      : [];

  return {
    valid: true,
    reason: null,
    signal: {
      decision,
      reason,
      perTF,
      entry: roundPrice(entry, decimals),
      sl: roundPrice(sl, decimals),
      tp: roundPrice(tp, decimals),
      rr:
        rr == null
          ? null
          : Number(rr.toFixed(2)),
      source: "scalp-signals.json",
      sourceMode: "primary",
      updatedAt,
    },
    meta: {
      available: true,
      pairFound: true,
      valid: true,
      decision,
      updatedAt,
      stale: updatedAt
        ? Date.now() - Date.parse(updatedAt) >
          DAY_MS
        : null,
    },
  };
}

// ===================== Indicator helpers =====================

function emaSeries(values, period) {
  if (
    !Array.isArray(values) ||
    !Number.isInteger(period) ||
    period < 1
  ) {
    return [];
  }

  const output = new Array(values.length).fill(null);

  if (values.length < period) {
    return output;
  }

  const multiplier = 2 / (period + 1);

  let previous =
    values
      .slice(0, period)
      .reduce((sum, value) => sum + value, 0) /
    period;

  output[period - 1] = previous;

  for (
    let index = period;
    index < values.length;
    index += 1
  ) {
    previous =
      values[index] * multiplier +
      previous * (1 - multiplier);

    output[index] = previous;
  }

  return output;
}

function rsiSeries(values, period = 14) {
  const output =
    new Array(values.length).fill(null);

  if (
    !Array.isArray(values) ||
    values.length <= period ||
    period < 1
  ) {
    return output;
  }

  let gainSum = 0;
  let lossSum = 0;

  for (
    let index = 1;
    index <= period;
    index += 1
  ) {
    const difference =
      values[index] - values[index - 1];

    if (difference >= 0) {
      gainSum += difference;
    } else {
      lossSum -= difference;
    }
  }

  let averageGain = gainSum / period;
  let averageLoss = lossSum / period;

  output[period] =
    averageLoss === 0
      ? 100
      : 100 -
        100 /
          (1 + averageGain / averageLoss);

  for (
    let index = period + 1;
    index < values.length;
    index += 1
  ) {
    const difference =
      values[index] - values[index - 1];

    const gain =
      difference > 0 ? difference : 0;

    const loss =
      difference < 0 ? -difference : 0;

    averageGain =
      (
        averageGain * (period - 1) +
        gain
      ) / period;

    averageLoss =
      (
        averageLoss * (period - 1) +
        loss
      ) / period;

    output[index] =
      averageLoss === 0
        ? 100
        : 100 -
          100 /
            (
              1 +
              averageGain / averageLoss
            );
  }

  return output;
}

function computeVolatility(rows) {
  if (!Array.isArray(rows) || rows.length < 3) {
    return 0.004;
  }

  let totalMove = 0;
  let count = 0;

  for (
    let index = 1;
    index < rows.length;
    index += 1
  ) {
    const previousClose =
      rows[index - 1].close;

    const currentClose =
      rows[index].close;

    if (
      !isFiniteNumber(previousClose) ||
      !isFiniteNumber(currentClose) ||
      previousClose <= 0
    ) {
      continue;
    }

    totalMove +=
      Math.abs(
        currentClose - previousClose
      ) / previousClose;

    count += 1;
  }

  return count
    ? totalMove / count
    : 0.004;
}

function computeATR(ohlcRows, period = 14) {
  if (
    !Array.isArray(ohlcRows) ||
    ohlcRows.length < period + 1
  ) {
    return null;
  }

  const trueRanges = [];

  for (
    let index = 1;
    index < ohlcRows.length;
    index += 1
  ) {
    const current = ohlcRows[index];
    const previous = ohlcRows[index - 1];

    trueRanges.push(
      Math.max(
        current.high - current.low,
        Math.abs(
          current.high - previous.close
        ),
        Math.abs(
          current.low - previous.close
        )
      )
    );
  }

  if (trueRanges.length < period) {
    return null;
  }

  let atr =
    trueRanges
      .slice(0, period)
      .reduce(
        (sum, value) => sum + value,
        0
      ) / period;

  for (
    let index = period;
    index < trueRanges.length;
    index += 1
  ) {
    atr =
      (
        atr * (period - 1) +
        trueRanges[index]
      ) / period;
  }

  return atr;
}

function computeADX(ohlcRows, period = 14) {
  if (
    !Array.isArray(ohlcRows) ||
    ohlcRows.length < period * 2 + 1
  ) {
    return null;
  }

  const trueRanges = [];
  const plusDM = [];
  const minusDM = [];

  for (
    let index = 1;
    index < ohlcRows.length;
    index += 1
  ) {
    const current = ohlcRows[index];
    const previous = ohlcRows[index - 1];

    trueRanges.push(
      Math.max(
        current.high - current.low,
        Math.abs(
          current.high - previous.close
        ),
        Math.abs(
          current.low - previous.close
        )
      )
    );

    const upwardMove =
      current.high - previous.high;

    const downwardMove =
      previous.low - current.low;

    plusDM.push(
      upwardMove > downwardMove &&
      upwardMove > 0
        ? upwardMove
        : 0
    );

    minusDM.push(
      downwardMove > upwardMove &&
      downwardMove > 0
        ? downwardMove
        : 0
    );
  }

  let smoothedTR = 0;
  let smoothedPlusDM = 0;
  let smoothedMinusDM = 0;

  for (
    let index = 0;
    index < period;
    index += 1
  ) {
    smoothedTR += trueRanges[index];
    smoothedPlusDM += plusDM[index];
    smoothedMinusDM += minusDM[index];
  }

  const dxSeries = [];

  for (
    let index = period;
    index < trueRanges.length;
    index += 1
  ) {
    smoothedTR =
      smoothedTR -
      smoothedTR / period +
      trueRanges[index];

    smoothedPlusDM =
      smoothedPlusDM -
      smoothedPlusDM / period +
      plusDM[index];

    smoothedMinusDM =
      smoothedMinusDM -
      smoothedMinusDM / period +
      minusDM[index];

    const plusDI =
      smoothedTR === 0
        ? 0
        : 100 *
          (
            smoothedPlusDM /
            smoothedTR
          );

    const minusDI =
      smoothedTR === 0
        ? 0
        : 100 *
          (
            smoothedMinusDM /
            smoothedTR
          );

    const denominator =
      plusDI + minusDI;

    const dx =
      denominator === 0
        ? 0
        : (
            100 *
            Math.abs(
              plusDI - minusDI
            )
          ) / denominator;

    dxSeries.push(dx);
  }

  if (dxSeries.length < period) {
    return null;
  }

  let adx =
    dxSeries
      .slice(0, period)
      .reduce(
        (sum, value) => sum + value,
        0
      ) / period;

  for (
    let index = period;
    index < dxSeries.length;
    index += 1
  ) {
    adx =
      (
        adx * (period - 1) +
        dxSeries[index]
      ) / period;
  }

  return adx;
}

function computeSR(rows, lastClose) {
  const closes = rows.map(
    (row) => row.close
  );

  const count = closes.length;
  const radius = count > 40 ? 2 : 1;

  const swingHighs = [];
  const swingLows = [];

  for (
    let index = radius;
    index < count - radius;
    index += 1
  ) {
    let isHigh = true;
    let isLow = true;

    for (
      let offset = 1;
      offset <= radius;
      offset += 1
    ) {
      if (
        closes[index] <
          closes[index - offset] ||
        closes[index] <
          closes[index + offset]
      ) {
        isHigh = false;
      }

      if (
        closes[index] >
          closes[index - offset] ||
        closes[index] >
          closes[index + offset]
      ) {
        isLow = false;
      }
    }

    if (isHigh) {
      swingHighs.push(closes[index]);
    }

    if (isLow) {
      swingLows.push(closes[index]);
    }
  }

  function dedupeLevels(levels) {
    const sorted = [...levels].sort(
      (a, b) => a - b
    );

    const output = [];

    for (const level of sorted) {
      const previous =
        output[output.length - 1];

      if (
        previous == null ||
        Math.abs(level - previous) / level >
          0.0015
      ) {
        output.push(level);
      } else {
        output[output.length - 1] =
          (previous + level) / 2;
      }
    }

    return output;
  }

  let resistances =
    dedupeLevels(swingHighs)
      .filter(
        (level) => level > lastClose
      )
      .sort((a, b) => a - b)
      .slice(0, 2);

  let supports =
    dedupeLevels(swingLows)
      .filter(
        (level) => level < lastClose
      )
      .sort((a, b) => b - a)
      .slice(0, 2);

  if (
    resistances.length === 0 &&
    count >= 3
  ) {
    const maximumClose =
      Math.max(...closes);

    if (
      maximumClose >
      lastClose * 1.0005
    ) {
      resistances = [maximumClose];
    }
  }

  if (
    supports.length === 0 &&
    count >= 3
  ) {
    const minimumClose =
      Math.min(...closes);

    if (
      minimumClose <
      lastClose * 0.9995
    ) {
      supports = [minimumClose];
    }
  }

  return {
    resistances,
    supports,
  };
}

function detectCandlePattern(
  ohlcRows,
  leanDirection
) {
  if (
    !Array.isArray(ohlcRows) ||
    ohlcRows.length < 2 ||
    !leanDirection
  ) {
    return {
      ok: false,
      detail:
        "Not enough candle history",
    };
  }

  const last =
    ohlcRows[ohlcRows.length - 1];

  const previous =
    ohlcRows[ohlcRows.length - 2];

  const range = last.high - last.low;
  const body =
    Math.abs(last.close - last.open);

  const bodyPercentage =
    range > 0 ? body / range : 0;

  if (leanDirection === "BUY") {
    const bullishEngulfing =
      previous.close < previous.open &&
      last.close > last.open &&
      last.open <= previous.close &&
      last.close >= previous.open;

    if (bullishEngulfing) {
      return {
        ok: true,
        detail:
          "Bullish engulfing on the latest candle",
      };
    }

    if (
      last.close > last.open &&
      bodyPercentage > 0.6
    ) {
      return {
        ok: true,
        detail:
          `Strong bullish candle ` +
          `(body ${(
            bodyPercentage * 100
          ).toFixed(0)}% of range)`,
      };
    }

    return {
      ok: false,
      detail:
        "Latest candle doesn't confirm a bullish pattern",
    };
  }

  const bearishEngulfing =
    previous.close > previous.open &&
    last.close < last.open &&
    last.open >= previous.close &&
    last.close <= previous.open;

  if (bearishEngulfing) {
    return {
      ok: true,
      detail:
        "Bearish engulfing on the latest candle",
    };
  }

  if (
    last.close < last.open &&
    bodyPercentage > 0.6
  ) {
    return {
      ok: true,
      detail:
        `Strong bearish candle ` +
        `(body ${(
          bodyPercentage * 100
        ).toFixed(0)}% of range)`,
    };
  }

  return {
    ok: false,
    detail:
      "Latest candle doesn't confirm a bearish pattern",
  };
}

// ===================== Trend helpers =====================

function adaptiveEmaPeriods(rowCount) {
  if (rowCount < 6) {
    return null;
  }

  const cap = rowCount - 1;

  const p200 = Math.min(200, cap);

  const p100 = Math.min(
    100,
    Math.max(
      4,
      Math.floor(p200 * 0.5)
    )
  );

  const p50 = Math.min(
    50,
    Math.max(
      3,
      Math.floor(p100 * 0.6)
    )
  );

  const p20 = Math.min(
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
    fullStack: cap >= 200,
  };
}

function calculateTrendState(rows) {
  if (
    !Array.isArray(rows) ||
    rows.length < 6
  ) {
    return {
      direction: null,
      label:
        "Building history — not enough sessions yet",
      values: null,
      periods: null,
    };
  }

  const closes = rows.map(
    (row) => row.close
  );

  const periods =
    adaptiveEmaPeriods(closes.length);

  if (!periods) {
    return {
      direction: null,
      label:
        "Building history — not enough sessions yet",
      values: null,
      periods: null,
    };
  }

  const {
    p20,
    p50,
    p100,
    p200,
    fullStack,
  } = periods;

  const ema20 = emaSeries(closes, p20);
  const ema50 = emaSeries(closes, p50);
  const ema100 = emaSeries(closes, p100);
  const ema200 = emaSeries(closes, p200);

  const lastIndex = closes.length - 1;
  const lastClose = closes[lastIndex];

  const values = {
    v20: ema20[lastIndex],
    v50: ema50[lastIndex],
    v100: ema100[lastIndex],
    v200: ema200[lastIndex],
  };

  const {
    v20,
    v50,
    v100,
    v200,
  } = values;

  if (
    v20 == null ||
    v50 == null ||
    v100 == null ||
    v200 == null
  ) {
    return {
      direction: null,
      label:
        "Building history — EMA values are not ready",
      values,
      periods,
    };
  }

  const bullishChecks = [
    v20 > v50,
    v50 > v100,
    v100 > v200,
    lastClose > v20,
  ];

  const bearishChecks = [
    v20 < v50,
    v50 < v100,
    v100 < v200,
    lastClose < v20,
  ];

  const bullishCount =
    bullishChecks.filter(Boolean).length;

  const bearishCount =
    bearishChecks.filter(Boolean).length;

  const bullishFull =
    bullishCount === 4;

  const bearishFull =
    bearishCount === 4;

  const note = fullStack
    ? ""
    : " (adaptive periods — full EMA200 needs more history)";

  if (bullishFull) {
    return {
      direction: "BUY",
      label:
        `Bullish — full EMA stack ` +
        `${p20}>${p50}>${p100}>${p200}` +
        note,
      values,
      periods,
    };
  }

  if (bearishFull) {
    return {
      direction: "SELL",
      label:
        `Bearish — full EMA stack ` +
        `${p20}<${p50}<${p100}<${p200}` +
        note,
      values,
      periods,
    };
  }

  if (bullishCount >= 3) {
    return {
      direction: null,
      label:
        `Partial bullish lean only ` +
        `(${bullishCount}/4) — not enough to qualify` +
        note,
      values,
      periods,
    };
  }

  if (bearishCount >= 3) {
    return {
      direction: null,
      label:
        `Partial bearish lean only ` +
        `(${bearishCount}/4) — not enough to qualify` +
        note,
      values,
      periods,
    };
  }

  return {
    direction: null,
    label:
      `Mixed EMA alignment — no clear trend` +
      note,
    values,
    periods,
  };
}

function trendDirectionOf(rows) {
  return calculateTrendState(rows).direction;
}

// ===================== Candle aggregation =====================

function aggregateCandles(
  candles,
  groupSize
) {
  if (!Array.isArray(candles)) {
    return [];
  }

  if (
    !Number.isInteger(groupSize) ||
    groupSize <= 1
  ) {
    return [...candles];
  }

  const output = [];

  for (
    let index = 0;
    index + groupSize <= candles.length;
    index += groupSize
  ) {
    const chunk = candles.slice(
      index,
      index + groupSize
    );

    const first = chunk[0];
    const last = chunk[chunk.length - 1];

    const timeField =
      Object.prototype.hasOwnProperty.call(
        first,
        "time"
      )
        ? "time"
        : "date";

    output.push({
      [timeField]: first[timeField],
      open: first.open,
      high: Math.max(
        ...chunk.map(
          (candle) => candle.high
        )
      ),
      low: Math.min(
        ...chunk.map(
          (candle) => candle.low
        )
      ),
      close: last.close,
    });
  }

  return output;
}

// ===================== Weekly aggregation =====================

function isoWeekKey(dateValue) {
  const date = new Date(
    `${dateValue.slice(0, 10)}T00:00:00Z`
  );

  const day =
    (date.getUTCDay() + 6) % 7;

  date.setUTCDate(
    date.getUTCDate() - day + 3
  );

  const firstThursday = new Date(
    Date.UTC(
      date.getUTCFullYear(),
      0,
      4
    )
  );

  const firstDay =
    (
      firstThursday.getUTCDay() + 6
    ) % 7;

  const week =
    1 +
    Math.round(
      (
        (
          date - firstThursday
        ) /
          DAY_MS -
        3 +
        firstDay
      ) / 7
    );

  return (
    `${date.getUTCFullYear()}-W` +
    String(week).padStart(2, "0")
  );
}

function resampleWeekly(rows) {
  const weeks = new Map();

  for (const row of rows) {
    const weekKey =
      isoWeekKey(row.date);

    const existing =
      weeks.get(weekKey);

    if (!existing) {
      weeks.set(weekKey, {
        date: row.date,
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
      });

      continue;
    }

    existing.high = Math.max(
      existing.high,
      row.high
    );

    existing.low = Math.min(
      existing.low,
      row.low
    );

    existing.close = row.close;
    existing.date = row.date;
  }

  return [...weeks.values()];
}

// ===================== Legacy-compatible analysis pipeline =====================

function analyze(
  rows,
  pairLabel,
  htfRows,
  ohlcRows
) {
  const closes = rows.map(
    (row) => row.close
  );

  const rowCount = closes.length;
  const lastClose =
    closes[rowCount - 1];

  const pipeline = [];
  let alive = true;

  function requiredStep(
    name,
    ok,
    detail
  ) {
    if (!alive) {
      pipeline.push({
        name,
        status: "skip",
        detail:
          "Not reached — an earlier required step failed",
      });

      return false;
    }

    pipeline.push({
      name,
      status: ok ? "pass" : "fail",
      detail,
    });

    if (!ok) {
      alive = false;
    }

    return ok;
  }

  function informationalStep(
    name,
    detail
  ) {
    pipeline.push({
      name,
      status: "na",
      detail,
    });
  }

  const trendState =
    calculateTrendState(rows);

  const leanDirection =
    trendState.direction;

  requiredStep(
    "Trend",
    Boolean(leanDirection),
    trendState.label
  );

  requiredStep(
    "EMA Alignment",
    Boolean(leanDirection),
    leanDirection
      ? `Full EMA stack confirms ${
          leanDirection === "BUY"
            ? "bullish"
            : "bearish"
        } alignment`
      : "Stack is not fully aligned in order"
  );

  const adx14 =
    Array.isArray(ohlcRows)
      ? computeADX(ohlcRows, 14)
      : null;

  informationalStep(
    "ADX > 25?",
    adx14 != null
      ? `Informational — ADX(14) = ${adx14.toFixed(
          1
        )}`
      : "Not available"
  );

  informationalStep(
    "Volume Confirmed?",
    "Not available — spot FX/gold has no centralized exchange volume feed"
  );

  let lastMacd = null;
  let lastMacdSignal = null;

  if (rowCount >= 35) {
    const ema12 = emaSeries(
      closes,
      12
    );

    const ema26 = emaSeries(
      closes,
      26
    );

    const macdLine = closes.map(
      (_, index) =>
        ema12[index] != null &&
        ema26[index] != null
          ? ema12[index] -
            ema26[index]
          : null
    );

    const macdValues =
      macdLine.filter(
        (value) => value != null
      );

    const signalSeries =
      emaSeries(macdValues, 9);

    lastMacd =
      macdLine[rowCount - 1];

    lastMacdSignal =
      signalSeries[
        signalSeries.length - 1
      ];
  }

  let macdPass = false;
  let macdDetail;

  if (!leanDirection) {
    macdDetail =
      "No confirmed trend direction to test against";
  } else if (rowCount < 35) {
    macdDetail =
      `Needs ${35 - rowCount} more session(s) of history for MACD`;
  } else if (
    lastMacd == null ||
    lastMacdSignal == null
  ) {
    macdDetail =
      "MACD values are not ready";
  } else {
    macdPass =
      leanDirection === "BUY"
        ? lastMacd > lastMacdSignal
        : lastMacd < lastMacdSignal;

    macdDetail =
      `MACD ${lastMacd.toFixed(4)} ` +
      `vs signal ${lastMacdSignal.toFixed(
        4
      )} — ` +
      `${
        macdPass
          ? "confirms"
          : "does not confirm"
      } ${leanDirection}`;
  }

  requiredStep(
    "MACD Confirmation",
    Boolean(
      leanDirection &&
      rowCount >= 35 &&
      macdPass
    ),
    macdDetail
  );

  const rsiPeriod = Math.min(
    14,
    Math.max(4, rowCount - 2)
  );

  const rsi = rsiSeries(
    closes,
    rsiPeriod
  );

  const lastRsi =
    rsi[rowCount - 1];

  const rsiBuyOk =
    lastRsi != null &&
    lastRsi >= 45 &&
    lastRsi <= 65;

  const rsiSellOk =
    lastRsi != null &&
    lastRsi >= 35 &&
    lastRsi <= 55;

  let rsiPass = false;
  let rsiDetail;

  if (!leanDirection) {
    rsiDetail =
      "No confirmed trend direction to test against";
  } else if (lastRsi == null) {
    rsiDetail =
      "Not enough history for RSI yet";
  } else {
    rsiPass =
      leanDirection === "BUY"
        ? rsiBuyOk
        : rsiSellOk;

    rsiDetail =
      `RSI(${rsiPeriod}) = ` +
      lastRsi.toFixed(1);
  }

  requiredStep(
    "RSI Confirmation",
    Boolean(
      leanDirection &&
      lastRsi != null &&
      rsiPass
    ),
    rsiDetail
  );

  let htfDirection = null;
  let htfPass = false;
  let htfDetail;

  if (!leanDirection) {
    htfDetail =
      "No confirmed trend direction to test against";
  } else if (
    htfRows === null ||
    htfRows === undefined
  ) {
    htfPass = true;
    htfDetail =
      "Already viewing the highest timeframe available";
  } else {
    htfDirection =
      trendDirectionOf(htfRows);

    if (!htfDirection) {
      htfDetail =
        "Higher-timeframe trend isn't clearly aligned yet";
    } else {
      htfPass =
        htfDirection === leanDirection;

      htfDetail =
        `Higher-timeframe trend is ` +
        `${htfDirection} — ` +
        `${
          htfPass
            ? "agrees"
            : "conflicts"
        }`;
    }
  }

  requiredStep(
    "Multi-Timeframe Confirmation",
    Boolean(
      leanDirection &&
      htfPass
    ),
    htfDetail
  );

  if (
    Array.isArray(ohlcRows) &&
    leanDirection
  ) {
    const candlePattern =
      detectCandlePattern(
        ohlcRows,
        leanDirection
      );

    requiredStep(
      "Candle Pattern",
      candlePattern.ok,
      candlePattern.detail
    );
  } else {
    informationalStep(
      "Candle Pattern",
      "Not available"
    );
  }

  informationalStep(
    "High-Impact News Filter",
    "Informational — no server-side news feed here; shown for context only, doesn't block the signal"
  );

  const supportResistance =
    computeSR(rows, lastClose);

  let srPass = false;
  let srDetail;

  if (!leanDirection) {
    srDetail =
      "No confirmed trend direction to test against";
  } else if (
    leanDirection === "BUY"
  ) {
    const resistance =
      supportResistance.resistances[0];

    if (resistance == null) {
      srPass = true;
      srDetail =
        "No resistance detected nearby";
    } else {
      const distance =
        (
          resistance - lastClose
        ) / lastClose;

      srPass = distance >= 0.003;

      srDetail = srPass
        ? `Resistance ${(
            distance * 100
          ).toFixed(2)}% away`
        : `Resistance only ${(
            distance * 100
          ).toFixed(2)}% above spot`;
    }
  } else {
    const support =
      supportResistance.supports[0];

    if (support == null) {
      srPass = true;
      srDetail =
        "No support detected nearby";
    } else {
      const distance =
        (
          lastClose - support
        ) / lastClose;

      srPass = distance >= 0.003;

      srDetail = srPass
        ? `Support ${(
            distance * 100
          ).toFixed(2)}% away`
        : `Support only ${(
            distance * 100
          ).toFixed(2)}% below spot`;
    }
  }

  requiredStep(
    "Support/Resistance",
    Boolean(
      leanDirection &&
      srPass
    ),
    srDetail
  );

  const volatility =
    computeVolatility(rows);

  const buffer =
    Math.max(
      volatility * 0.5,
      0.0004
    ) * lastClose;

  const atr14 =
    Array.isArray(ohlcRows)
      ? computeATR(ohlcRows, 14)
      : null;

  if (
    leanDirection &&
    alive
  ) {
    pipeline.push({
      name:
        "ATR-style Stop Loss",
      status: "pass",
      detail:
        `Volatility-based buffer ≈ ` +
        `${buffer.toFixed(
          lastClose > 100 ? 2 : 5
        )}` +
        (
          atr14 != null
            ? ` · True ATR(14) shadow = ` +
              atr14.toFixed(
                lastClose > 100
                  ? 2
                  : 5
              )
            : ""
        ),
    });
  } else {
    pipeline.push({
      name:
        "ATR-style Stop Loss",
      status: "skip",
      detail: "Not reached",
    });
  }

  let tradePlan = null;

  if (
    leanDirection &&
    alive
  ) {
    const support =
      supportResistance.supports[0];

    const resistance =
      supportResistance.resistances[0];

    let stop;
    let target1;
    let target2;
    let target3;

    if (leanDirection === "BUY") {
      stop =
        support != null
          ? support - buffer
          : lastClose - buffer * 3;

      const initialRisk =
        lastClose - stop;

      target1 =
        resistance != null
          ? resistance
          : lastClose +
            initialRisk * 2;

      target2 = Math.max(
        target1,
        lastClose +
          initialRisk * 3
      );

      target3 = Math.max(
        target2,
        lastClose +
          initialRisk * 4
      );
    } else {
      stop =
        resistance != null
          ? resistance + buffer
          : lastClose + buffer * 3;

      const initialRisk =
        stop - lastClose;

      target1 =
        support != null
          ? support
          : lastClose -
            initialRisk * 2;

      target2 = Math.min(
        target1,
        lastClose -
          initialRisk * 3
      );

      target3 = Math.min(
        target2,
        lastClose -
          initialRisk * 4
      );
    }

    const risk =
      Math.abs(lastClose - stop);

    const rewardToTarget1 =
      Math.abs(
        target1 - lastClose
      );

    const riskReward =
      risk > 0
        ? rewardToTarget1 / risk
        : 0;

    const riskRewardPassed =
      requiredStep(
        "Risk:Reward ≥ 1:2",
        riskReward >= 2,
        `Risk:Reward to TP1 = 1:${riskReward.toFixed(
          1
        )}`
      );

    if (riskRewardPassed) {
      tradePlan = {
        direction: leanDirection,
        entry: lastClose,
        stop,
        target1,
        target2,
        target3,
        risk,
        rr: riskReward,
      };
    }
  } else {
    requiredStep(
      "Risk:Reward ≥ 1:2",
      false,
      "No confirmed trend direction yet"
    );
  }

  const signal = tradePlan
    ? tradePlan.direction
    : "HOLD";

  const failedStep =
    pipeline.find(
      (step) =>
        step.status === "fail"
    );

  const suppressionReason =
    signal === "HOLD"
      ? leanDirection
        ? `NO TRADE — stopped at "${
            failedStep
              ? failedStep.name
              : "an earlier step"
          }"`
        : "NO TRADE — no confirmed trend direction yet"
      : null;

  const gatedSteps =
    pipeline.filter(
      (step) =>
        step.status === "pass" ||
        step.status === "fail"
    );

  const passCount =
    gatedSteps.filter(
      (step) =>
        step.status === "pass"
    ).length;

  return {
    signal,
    suppressionReason,
    tradePlan,
    lastClose,
    passCount,
    gatedCount: gatedSteps.length,
    diagnostics: {
      pair: pairLabel,
      adx14,
      atr14,
      trendLabel:
        trendState.label,
      pipeline,
    },
  };
}

// ===================== Legacy scalp engine =====================

function analyzeScalp(candles) {
  if (
    !Array.isArray(candles) ||
    candles.length < 30
  ) {
    return {
      signal: "HOLD",
      bull: 0,
      bear: 0,
    };
  }

  const closes = candles.map(
    (candle) => candle.close
  );

  const last =
    candles[candles.length - 1];

  const ema9 =
    emaSeries(closes, 9);

  const ema21 =
    emaSeries(closes, 21);

  const rsi14 =
    rsiSeries(closes, 14);

  const ema12 =
    emaSeries(closes, 12);

  const ema26 =
    emaSeries(closes, 26);

  const macdLine = closes.map(
    (_, index) =>
      ema12[index] != null &&
      ema26[index] != null
        ? ema12[index] -
          ema26[index]
        : null
  );

  const macdValues =
    macdLine.filter(
      (value) => value != null
    );

  const macdSignalSeries =
    emaSeries(macdValues, 9);

  const lastIndex =
    closes.length - 1;

  const lastMacd =
    macdLine[lastIndex];

  const lastMacdSignal =
    macdSignalSeries[
      macdSignalSeries.length - 1
    ];

  const lastRsi =
    rsi14[lastIndex];

  const lastEma9 =
    ema9[lastIndex];

  const lastEma21 =
    ema21[lastIndex];

  let bull = 0;
  let bear = 0;

  if (
    lastEma9 != null &&
    lastEma21 != null
  ) {
    if (lastEma9 > lastEma21) {
      bull += 1;
    } else {
      bear += 1;
    }
  }

  if (lastRsi != null) {
    if (lastRsi > 50) {
      bull += 1;
    } else {
      bear += 1;
    }
  }

  if (
    lastMacd != null &&
    lastMacdSignal != null
  ) {
    if (
      lastMacd >
      lastMacdSignal
    ) {
      bull += 1;
    } else {
      bear += 1;
    }
  }

  if (lastEma21 != null) {
    if (
      last.close >
      lastEma21
    ) {
      bull += 1;
    } else {
      bear += 1;
    }
  }

  if (
    last.close >
    last.open
  ) {
    bull += 1;
  } else {
    bear += 1;
  }

  let signal = "HOLD";

  if (
    bull >= 4 &&
    bull > bear
  ) {
    signal = "BUY";
  } else if (
    bear >= 4 &&
    bear > bull
  ) {
    signal = "SELL";
  }

  return {
    signal,
    bull,
    bear,
  };
}

function computeScalpTradeSignal(
  candles5m,
  decimals
) {
  const candles15m =
    aggregateCandles(
      candles5m,
      3
    );

  const candles30m =
    aggregateCandles(
      candles5m,
      6
    );

  const analysis5m =
    analyzeScalp(candles5m);

  const analysis15m =
    analyzeScalp(candles15m);

  const analysis30m =
    analyzeScalp(candles30m);

  const perTF = [
    {
      tf: "5m",
      signal:
        analysis5m.signal,
    },
    {
      tf: "15m",
      signal:
        analysis15m.signal,
    },
    {
      tf: "30m",
      signal:
        analysis30m.signal,
    },
  ];

  let decision = "HOLD";
  let reason = "";

  if (
    analysis15m.signal ===
    "HOLD"
  ) {
    reason =
      "15-min anchor timeframe is not aligned";
  } else {
    const agreements =
      (
        analysis5m.signal ===
        analysis15m.signal
          ? 1
          : 0
      ) +
      (
        analysis30m.signal ===
        analysis15m.signal
          ? 1
          : 0
      );

    if (agreements >= 1) {
      decision =
        analysis15m.signal;
    } else {
      reason =
        "5-min and 30-min both disagree with the 15-min lean";
    }
  }

  const entry =
    candles5m[
      candles5m.length - 1
    ].close;

  const recent15m =
    candles15m.slice(-10);

  const averageRange =
    recent15m.length
      ? recent15m.reduce(
          (sum, candle) =>
            sum +
            (
              candle.high -
              candle.low
            ),
          0
        ) / recent15m.length
      : entry * 0.001;

  const riskReward = 2;

  let stopLoss = null;
  let takeProfit = null;

  if (decision === "BUY") {
    stopLoss =
      entry - averageRange;

    takeProfit =
      entry +
      averageRange *
        riskReward;
  } else if (
    decision === "SELL"
  ) {
    stopLoss =
      entry + averageRange;

    takeProfit =
      entry -
      averageRange *
        riskReward;
  }

  return {
    decision,
    reason,
    perTF,
    entry:
      roundPrice(
        entry,
        decimals
      ),
    sl:
      roundPrice(
        stopLoss,
        decimals
      ),
    tp:
      roundPrice(
        takeProfit,
        decimals
      ),
    rr: riskReward,
  };
}

function buildLegacyScalpFallback(
  candles5m,
  decimals,
  fallbackReason
) {
  const legacySignal =
    computeScalpTradeSignal(
      candles5m,
      decimals
    );

  return {
    ...legacySignal,
    source:
      "scalp-candles.json",
    sourceMode:
      "legacy-fallback",
    fallbackReason:
      fallbackReason || null,
    updatedAt:
      candles5m.length
        ? candles5m[
            candles5m.length - 1
          ].time
        : null,
  };
}

// ===================== Persistent history =====================

function loadHistory() {
  if (
    !fs.existsSync(
      HISTORY_PATH
    )
  ) {
    return {
      open: {},
      closed: [],
    };
  }

  try {
    const parsed =
      JSON.parse(
        fs.readFileSync(
          HISTORY_PATH,
          "utf8"
        )
      );

    return {
      ...parsed,
      open:
        parsed &&
        parsed.open &&
        typeof parsed.open ===
          "object"
          ? parsed.open
          : {},
      closed:
        parsed &&
        Array.isArray(
          parsed.closed
        )
          ? parsed.closed
          : [],
    };
  } catch (error) {
    console.error(
      "Could not parse analysis-history.json:",
      error.message
    );

    return {
      open: {},
      closed: [],
    };
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
  if (
    !isFiniteNumber(
      currentPrice
    )
  ) {
    return;
  }

  const historyKey =
    `${pairKey}:${engine}`;

  const existing =
    history.open[
      historyKey
    ];

  if (existing) {
    let outcome = null;

    if (
      existing.direction ===
      "BUY"
    ) {
      if (
        currentPrice >=
        existing.target
      ) {
        outcome = "WIN";
      } else if (
        currentPrice <=
        existing.stop
      ) {
        outcome = "LOSS";
      }
    } else if (
      existing.direction ===
      "SELL"
    ) {
      if (
        currentPrice <=
        existing.target
      ) {
        outcome = "WIN";
      } else if (
        currentPrice >=
        existing.stop
      ) {
        outcome = "LOSS";
      }
    }

    if (outcome) {
      history.closed.push({
        pair: pairKey,
        engine,
        direction:
          existing.direction,
        entry:
          existing.entry,
        stop:
          existing.stop,
        target:
          existing.target,
        outcome,
        openedAt:
          existing.openedAt,
        closedAt:
          new Date().toISOString(),
      });

      delete history.open[
        historyKey
      ];
    }

    return;
  }

  const validTrade =
    (
      decision === "BUY" ||
      decision === "SELL"
    ) &&
    isFiniteNumber(entry) &&
    isFiniteNumber(stop) &&
    isFiniteNumber(target);

  if (!validTrade) {
    return;
  }

  history.open[
    historyKey
  ] = {
    direction: decision,
    entry,
    stop,
    target,
    openedAt:
      new Date().toISOString(),
  };
}

function historyStatsSummary(
  history
) {
  const wins =
    history.closed.filter(
      (item) =>
        item.outcome ===
        "WIN"
    ).length;

  const losses =
    history.closed.filter(
      (item) =>
        item.outcome ===
        "LOSS"
    ).length;

  const totalClosed =
    wins + losses;

  return {
    totalClosed,
    wins,
    losses,
    winRate:
      totalClosed
        ? Math.round(
            (
              wins /
              totalClosed
            ) *
              100
          )
        : null,
    openCount:
      Object.keys(
        history.open
      ).length,
  };
}

function buildHistoryStats(
  history
) {
  const stats = {
    overall:
      historyStatsSummary(
        history
      ),
  };

  for (const engine of [
    "scalp",
    "intraday",
    "swing",
  ]) {
    const engineHistory = {
      open: Object.fromEntries(
        Object.entries(
          history.open
        ).filter(
          ([historyKey]) =>
            historyKey.endsWith(
              `:${engine}`
            )
        )
      ),
      closed:
        history.closed.filter(
          (item) =>
            item.engine ===
            engine
        ),
    };

    stats[engine] =
      historyStatsSummary(
        engineHistory
      );
  }

  return stats;
}

// ===================== Telegram notifications =====================

const TELEGRAM_BOT_TOKEN =
  process.env
    .TELEGRAM_BOT_TOKEN;

const TELEGRAM_CHAT_ID =
  process.env
    .TELEGRAM_CHAT_ID;

function loadNotifyState() {
  if (
    !fs.existsSync(
      NOTIFY_STATE_PATH
    )
  ) {
    return {};
  }

  try {
    const parsed =
      JSON.parse(
        fs.readFileSync(
          NOTIFY_STATE_PATH,
          "utf8"
        )
      );

    return (
      parsed &&
      typeof parsed === "object"
        ? parsed
        : {}
    );
  } catch (error) {
    console.error(
      "Could not parse notify-state.json:",
      error.message
    );

    return {};
  }
}

async function sendTelegram(
  text
) {
  if (
    !TELEGRAM_BOT_TOKEN ||
    !TELEGRAM_CHAT_ID
  ) {
    console.log(
      "Telegram not configured — skipping notification:",
      text.split("\n")[0]
    );

    return;
  }

  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () =>
        controller.abort(),
      TELEGRAM_TIMEOUT_MS
    );

  try {
    const response =
      await fetch(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          method: "POST",
          headers: {
            "Content-Type":
              "application/json",
          },
          body:
            JSON.stringify({
              chat_id:
                TELEGRAM_CHAT_ID,
              text,
            }),
          signal:
            controller.signal,
        }
      );

    if (!response.ok) {
      console.error(
        "Telegram send failed:",
        response.status,
        await response.text()
      );

      return;
    }

    console.log(
      "Telegram notification sent:",
      text.split("\n")[0]
    );
  } catch (error) {
    console.error(
      "Telegram send error:",
      error.name ===
        "AbortError"
        ? `Timed out after ${TELEGRAM_TIMEOUT_MS}ms`
        : error.message
    );
  } finally {
    clearTimeout(timeout);
  }
}

function formatTradePlan(
  tradePlan,
  decimals
) {
  if (!tradePlan) {
    return "";
  }

  return `Entry: ${tradePlan.entry.toFixed(
    decimals
  )}
Stop: ${tradePlan.stop.toFixed(
    decimals
  )}
Target: ${tradePlan.target1.toFixed(
    decimals
  )}`;
}

function formatScalpValue(
  value
) {
  return value == null
    ? "n/a"
    : String(value);
}

// ===================== Main =====================

async function main() {
  const rawScalpSignals =
    readJSON(
      "scalp-signals.json"
    );

  const rawScalpCandles =
    readJSON(
      "scalp-candles.json"
    );

  const rawIntradayData =
    readJSON(
      "intraday-h1.json"
    );

  const rawDailyData =
    readJSON(
      "daily-ohlc.json"
    );

  const history =
    loadHistory();

  const notifyState =
    loadNotifyState();

  const output = {
    updatedAt:
      new Date().toISOString(),
    engineVersion:
      ENGINE_VERSION,
    strategyVersion:
      STRATEGY_VERSION,
    compatibilityMode:
      "legacy",
    pairs: {},
    dataQuality: {},
  };

  for (const pairKey of PAIR_KEYS) {
    const decimals =
      DECIMALS[pairKey];

    const dailyValidation =
      validateCandles(
        rawDailyData
          ? rawDailyData[
              pairKey
            ]
          : null,
        "date"
      );

    const intradayValidation =
      validateCandles(
        rawIntradayData
          ? rawIntradayData[
              pairKey
            ]
          : null,
        "time"
      );

    const scalpValidation =
      validateCandles(
        rawScalpCandles
          ? rawScalpCandles[
              pairKey
            ]
          : null,
        "time"
      );

    const daily =
      dailyValidation.rows;

    const hourly =
      intradayValidation.rows;

    const candles5m =
      scalpValidation.rows;

    const dedicatedScalp =
      resolveDedicatedScalpSignal(
        rawScalpSignals,
        pairKey,
        decimals
      );

    output.dataQuality[
      pairKey
    ] = {
      daily:
        dailyValidation.meta,
      intraday:
        intradayValidation.meta,
      scalp:
        scalpValidation.meta,
      dedicatedScalp:
        dedicatedScalp.meta,
    };

    const result = {
      swing: null,
      intraday: null,
      scalp: null,
      master: null,
    };

    // ===================== Swing =====================

    if (daily.length >= 8) {
      const weekly =
        resampleWeekly(daily);

      if (
        weekly.length >= 8
      ) {
        const analysis =
          analyze(
            daily,
            pairKey,
            weekly,
            daily
          );

        result.swing = {
          signal:
            analysis.signal,
          suppressionReason:
            analysis.suppressionReason,
          tradePlan:
            analysis.tradePlan,
          passCount:
            analysis.passCount,
          gatedCount:
            analysis.gatedCount,
          diagnostics:
            analysis.diagnostics,
        };

        const tradePlan =
          analysis.tradePlan;

        updateHistoryForEngine(
          history,
          pairKey,
          "swing",
          analysis.signal,
          tradePlan
            ? tradePlan.entry
            : null,
          tradePlan
            ? tradePlan.stop
            : null,
          tradePlan
            ? tradePlan.target1
            : null,
          daily[
            daily.length - 1
          ].close
        );

        const notifyKey =
          `${pairKey}:swing`;

        if (
          analysis.signal !==
            "HOLD" &&
          notifyState[
            notifyKey
          ] !== analysis.signal
        ) {
          await sendTelegram(
            `🔔 PipSight — Swing
${pairKey} · D1+W1
${
  analysis.signal ===
  "BUY"
    ? "🟢"
    : "🔴"
} ${analysis.signal}
${formatTradePlan(
  tradePlan,
  decimals
)}
Hold: 2–7 days`
          );
        }

        notifyState[
          notifyKey
        ] = analysis.signal;
      }
    }

    // ===================== Intraday =====================

    if (
      hourly.length >= 210
    ) {
      const hourly4 =
        aggregateCandles(
          hourly,
          4
        );

      const analysis =
        analyze(
          hourly,
          pairKey,
          hourly4,
          hourly
        );

      result.intraday = {
        signal:
          analysis.signal,
        suppressionReason:
          analysis.suppressionReason,
        tradePlan:
          analysis.tradePlan,
        passCount:
          analysis.passCount,
        gatedCount:
          analysis.gatedCount,
        diagnostics:
          analysis.diagnostics,
      };

      const tradePlan =
        analysis.tradePlan;

      updateHistoryForEngine(
        history,
        pairKey,
        "intraday",
        analysis.signal,
        tradePlan
          ? tradePlan.entry
          : null,
        tradePlan
          ? tradePlan.stop
          : null,
        tradePlan
          ? tradePlan.target1
          : null,
        hourly[
          hourly.length - 1
        ].close
      );

      const notifyKey =
        `${pairKey}:intraday`;

      if (
        analysis.signal !==
          "HOLD" &&
        notifyState[
          notifyKey
        ] !== analysis.signal
      ) {
        await sendTelegram(
          `🔔 PipSight — Intraday
${pairKey} · H1+H4
${
  analysis.signal ===
  "BUY"
    ? "🟢"
    : "🔴"
} ${analysis.signal}
${formatTradePlan(
  tradePlan,
  decimals
)}
Hold: 2–12 hours`
        );
      }

      notifyState[
        notifyKey
      ] = analysis.signal;
    }

    // ===================== Scalp =====================

    if (
      dedicatedScalp.valid
    ) {
      result.scalp =
        dedicatedScalp.signal;
    } else if (
      candles5m.length >= 30
    ) {
      result.scalp =
        buildLegacyScalpFallback(
          candles5m,
          decimals,
          dedicatedScalp.reason
        );
    }

    if (result.scalp) {
      const scalp =
        result.scalp;

      const currentPrice =
        candles5m.length
          ? candles5m[
              candles5m.length - 1
            ].close
          : scalp.entry;

      updateHistoryForEngine(
        history,
        pairKey,
        "scalp",
        scalp.decision,
        scalp.entry,
        scalp.sl,
        scalp.tp,
        currentPrice
      );

      const notifyKey =
        `${pairKey}:scalp`;

      if (
        scalp.decision !==
          "HOLD" &&
        notifyState[
          notifyKey
        ] !== scalp.decision
      ) {
        await sendTelegram(
          `🔔 PipSight — Scalp
${pairKey} · 5/15/30m
${
  scalp.decision ===
  "BUY"
    ? "🟢"
    : "🔴"
} ${scalp.decision}
Entry: ${formatScalpValue(
  scalp.entry
)}
SL: ${formatScalpValue(
  scalp.sl
)}
TP: ${formatScalpValue(
  scalp.tp
)}`
        );
      }

      notifyState[
        notifyKey
      ] = scalp.decision;
    }

    // ===================== Master =====================

    const votes = [
      {
        engine: "Scalp",
        signal:
          result.scalp
            ? result.scalp
                .decision
            : "HOLD",
      },
      {
        engine:
          "Intraday",
        signal:
          result.intraday
            ? result.intraday
                .signal
            : "HOLD",
      },
      {
        engine: "Swing",
        signal:
          result.swing
            ? result.swing
                .signal
            : "HOLD",
      },
    ];

    const buyCount =
      votes.filter(
        (vote) =>
          vote.signal ===
          "BUY"
      ).length;

    const sellCount =
      votes.filter(
        (vote) =>
          vote.signal ===
          "SELL"
      ).length;

    let verdict = "MIXED";

    if (
      buyCount >= 2 &&
      buyCount > sellCount
    ) {
      verdict = "BUY";
    } else if (
      sellCount >= 2 &&
      sellCount > buyCount
    ) {
      verdict = "SELL";
    } else if (
      buyCount === 0 &&
      sellCount === 0
    ) {
      verdict = "HOLD";
    }

    result.master = {
      verdict,
      votes,
    };

    const masterNotifyKey =
      `${pairKey}:master`;

    if (
      (
        verdict === "BUY" ||
        verdict === "SELL"
      ) &&
      notifyState[
        masterNotifyKey
      ] !== verdict
    ) {
      const voteSummary =
        votes
          .map(
            (vote) =>
              `${vote.engine}: ${vote.signal}`
          )
          .join(" · ");

      await sendTelegram(
        `⭐ PipSight — Master Signal
${pairKey}
${
  verdict === "BUY"
    ? "🟢"
    : "🔴"
} ${verdict} (2+ engines agree)
${voteSummary}`
      );
    }

    notifyState[
      masterNotifyKey
    ] = verdict;

    output.pairs[
      pairKey
    ] = result;

    console.log(
      `${pairKey}: ` +
      `swing=${
        result.swing
          ? result.swing.signal
          : "n/a"
      } ` +
      `intraday=${
        result.intraday
          ? result.intraday.signal
          : "n/a"
      } ` +
      `scalp=${
        result.scalp
          ? result.scalp.decision
          : "n/a"
      } ` +
      `master=${verdict}`
    );
  }

  atomicWriteJSON(
    LIVE_ANALYSIS_PATH,
    output
  );

  console.log(
    "Wrote data/live-analysis.json"
  );

  atomicWriteJSON(
    NOTIFY_STATE_PATH,
    notifyState
  );

  history.updatedAt =
    new Date().toISOString();

  history.engineVersion =
    ENGINE_VERSION;

  history.strategyVersion =
    STRATEGY_VERSION;

  history.stats =
    buildHistoryStats(
      history
    );

  atomicWriteJSON(
    HISTORY_PATH,
    history
  );

  const overallStats =
    history.stats.overall;

  console.log(
    `History: ${overallStats.totalClosed} closed ` +
    `(${
      overallStats.winRate == null
        ? "n/a"
        : overallStats.winRate
    }% win rate), ` +
    `${overallStats.openCount} open`
  );
}

main().catch(
  (error) => {
    console.error(
      "Fatal error:",
      error
    );

    process.exit(1);
  }
);
