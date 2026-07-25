// run-live-analysis.js
//
// PipSight Pro — Live Analysis Engine
//
// Production revision:
// • Atomic JSON writes
// • Safe JSON loading
// • Dedicated scalp engine priority
// • Legacy scalp fallback retained
// • Telegram deduplication
// • History persistence
// • Backward-compatible outputs
// • Existing JSON schema preserved

"use strict";

const fs = require("fs");
const path = require("path");

const ENGINE_VERSION = "1.3.0-pro";
const STRATEGY_VERSION = "legacy-compatible-1.1";

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

const PAIR_KEYS = [
  "XAUUSD",
  "GBPJPY",
];

const DECIMALS = {
  XAUUSD: 2,
  GBPJPY: 3,
};

const PAIR_ALIASES = {
  XAUUSD: [
    "XAUUSD",
    "XAU/USD",
    "XAU_USD",
    "XAU-USD",
  ],

  GBPJPY: [
    "GBPJPY",
    "GBP/JPY",
    "GBP_JPY",
    "GBP-JPY",
  ],
};

// ========================================================
// Safe JSON Helpers
// ========================================================

function readJSON(fileName) {
  const filePath = path.join(DATA_DIR, fileName);

  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    return JSON.parse(
      fs.readFileSync(filePath, "utf8")
    );
  } catch (err) {
    console.error(
      `Failed to parse ${fileName}:`,
      err.message
    );

    return null;
  }
}

function atomicWriteJSON(filePath, value) {
  fs.mkdirSync(
    path.dirname(filePath),
    {
      recursive: true,
    }
  );

  const tempFile =
    `${filePath}.${process.pid}.${Date.now()}.tmp`;

  fs.writeFileSync(
    tempFile,
    JSON.stringify(value, null, 2),
    "utf8"
  );

  fs.renameSync(
    tempFile,
    filePath
  );
}

// ========================================================
// Generic Helpers
// ========================================================

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

  const parsed =
    Date.parse(trimmed);

  return Number.isNaN(parsed)
    ? null
    : trimmed;
}

function normalizePairKey(value) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized =
    value
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

  const normalized =
    value
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

function roundPrice(
  value,
  decimals
) {
  if (!isFiniteNumber(value)) {
    return null;
  }

  return Number(
    value.toFixed(decimals)
  );
}

// ========================================================
// Candle Validation
// ========================================================

function normalizeCandle(
  row,
  timeField
) {
  if (
    !row ||
    typeof row !== "object"
  ) {
    return null;
  }

  const timeValue =
    normalizeTime(
      row[timeField]
    );

  const open =
    Number(row.open);

  const high =
    Number(row.high);

  const low =
    Number(row.low);

  const close =
    Number(row.close);

  const prices = [
    open,
    high,
    low,
    close,
  ];

  if (
    !timeValue ||
    !prices.every(Number.isFinite) ||
    prices.some(
      (value) => value <= 0
    ) ||
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

function validateCandles(
  rows,
  timeField
) {
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

  const rowsByTime =
    new Map();

  let invalidRows = 0;
  let duplicateRows = 0;

  for (const row of rows) {
    const normalized =
      normalizeCandle(
        row,
        timeField
      );

    if (!normalized) {
      invalidRows += 1;
      continue;
    }

    const key =
      normalized[timeField];

    if (
      rowsByTime.has(key)
    ) {
      duplicateRows += 1;
    }

    rowsByTime.set(
      key,
      normalized
    );
  }

  const cleanRows =
    [...rowsByTime.values()]
      .sort(
        (a, b) =>
          a[timeField]
            .localeCompare(
              b[timeField]
            )
      );

  const latest =
    cleanRows.length
      ? cleanRows[
          cleanRows.length - 1
        ][timeField]
      : null;

  return {
    rows: cleanRows,
    meta: {
      sourceRows:
        rows.length,

      validRows:
        cleanRows.length,

      invalidRows,

      duplicateRows,

      latest,

      stale:
        latest
          ? Date.now() -
              Date.parse(latest) >
            7 * DAY_MS
          : true,
    },
  };
}

// ========================================================
// Dedicated Scalp Signal Helpers
// ========================================================

function extractDecisionFromRecord(
  record
) {
  if (
    !record ||
    typeof record !== "object"
  ) {
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

function unwrapScalpRecord(
  record
) {
  if (
    !record ||
    typeof record !== "object"
  ) {
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

  for (
    const candidate of candidates
  ) {
    if (
      candidate &&
      typeof candidate ===
        "object" &&
      extractDecisionFromRecord(
        candidate
      )
    ) {
      return candidate;
    }
  }

  return record;
}

function normalizeScalpMode(
  value
) {
  if (
    typeof value !== "string"
  ) {
    return null;
  }

  const normalized =
    value
      .trim()
      .toUpperCase()
      .replace(
        /[^A-Z0-9]/g,
        ""
      );

  if (
    normalized === "M5" ||
    normalized === "5M" ||
    normalized === "5MIN" ||
    normalized === "5MINUTE"
  ) {
    return "M5";
  }

  if (
    normalized === "M15" ||
    normalized === "15M" ||
    normalized === "15MIN" ||
    normalized === "15MINUTE"
  ) {
    return "M15";
  }

  if (
    normalized === "M30" ||
    normalized === "30M" ||
    normalized === "30MIN" ||
    normalized === "30MINUTE"
  ) {
    return "M30";
  }

  return null;
}

function collectDedicatedScalpPairRecords(
  rawScalpSignals,
  pairKey
) {
  if (
    !rawScalpSignals ||
    typeof rawScalpSignals !==
      "object"
  ) {
    return [];
  }

  const records = [];
  const seenRecords =
    new Set();

  function addRecord(
    candidate
  ) {
    if (
      !candidate ||
      typeof candidate !==
        "object" ||
      Array.isArray(candidate)
    ) {
      return;
    }

    if (
      seenRecords.has(candidate)
    ) {
      return;
    }

    const rawPair =
      firstString(
        candidate.pair,
        candidate.symbol,
        candidate.pairKey,
        candidate.instrument,
        candidate.market
      );

    if (
      rawPair &&
      normalizePairKey(rawPair) !==
        pairKey
    ) {
      return;
    }

    const unwrapped =
      unwrapScalpRecord(
        candidate
      );

    const decision =
      extractDecisionFromRecord(
        unwrapped
      );

    if (!decision) {
      return;
    }

    seenRecords.add(candidate);
    records.push(candidate);
  }

  function inspectPairValue(
    value
  ) {
    if (!value) {
      return;
    }

    if (Array.isArray(value)) {
      for (
        const candidate of value
      ) {
        addRecord(candidate);
      }

      return;
    }

    addRecord(value);
  }

  function inspectContainer(
    container
  ) {
    if (!container) {
      return;
    }

    if (
      Array.isArray(container)
    ) {
      for (
        const candidate of
        container
      ) {
        addRecord(candidate);
      }

      return;
    }

    if (
      typeof container !==
        "object"
    ) {
      return;
    }

    const aliases =
      PAIR_ALIASES[pairKey] ||
      [pairKey];

    for (
      const alias of aliases
    ) {
      if (
        Object.prototype
          .hasOwnProperty.call(
            container,
            alias
          )
      ) {
        inspectPairValue(
          container[alias]
        );
      }
    }

    for (
      const [rawKey, value] of
      Object.entries(container)
    ) {
      if (
        normalizePairKey(
          rawKey
        ) === pairKey
      ) {
        inspectPairValue(value);
      }
    }
  }

  inspectContainer(
    rawScalpSignals.signals
  );

  inspectContainer(
    rawScalpSignals.pairs
  );

  inspectContainer(
    rawScalpSignals.results
  );

  inspectContainer(
    rawScalpSignals.data
  );

  inspectContainer(
    rawScalpSignals.latest
  );

  inspectContainer(
    rawScalpSignals
  );

  return records;
}

function parseDedicatedScalpRecord(
  pairRecord,
  rawScalpSignals,
  decimals
) {
  const record =
    unwrapScalpRecord(
      pairRecord
    );

  if (!record) {
    return null;
  }

  const decision =
    extractDecisionFromRecord(
      record
    );

  if (!decision) {
    return null;
  }

  const tradePlan =
    record.tradePlan &&
    typeof record.tradePlan ===
      "object"
      ? record.tradePlan
      : {};

  const entry =
    firstFiniteNumber(
      record.entry,
      record.entryPrice,
      record.price,
      record.currentPrice,
      tradePlan.entry,
      tradePlan.entryPrice
    );

  const stopLoss =
    firstFiniteNumber(
      record.sl,
      record.stop,
      record.stopLoss,
      record.stop_loss,
      tradePlan.sl,
      tradePlan.stop,
      tradePlan.stopLoss
    );

  const takeProfit =
    firstFiniteNumber(
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

  let riskReward =
    firstFiniteNumber(
      record.rr,
      record.riskReward,
      record.risk_reward,
      tradePlan.rr,
      tradePlan.riskReward
    );

  if (
    riskReward == null &&
    entry != null &&
    stopLoss != null &&
    takeProfit != null
  ) {
    const risk =
      Math.abs(
        entry - stopLoss
      );

    const reward =
      Math.abs(
        takeProfit - entry
      );

    riskReward =
      risk > 0
        ? reward / risk
        : null;
  }

  const mode =
    normalizeScalpMode(
      firstString(
        record.mode,
        record.timeframe,
        record.tf,
        pairRecord.mode,
        pairRecord.timeframe,
        pairRecord.tf
      )
    );

  const updatedAt =
    normalizeTime(
      firstString(
        record.updatedAt,
        record.generatedAt,
        record.analyzedCandleAt,
        record.timestamp,
        record.time,

        pairRecord.updatedAt,
        pairRecord.generatedAt,
        pairRecord.analyzedCandleAt,

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
    );

  return {
    mode,
    decision,

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

    rr:
      riskReward == null
        ? null
        : Number(
            riskReward.toFixed(2)
          ),

    reason,
    updatedAt,
  };
}

function resolveDedicatedScalpSignal(
  rawScalpSignals,
  pairKey,
  decimals
) {
  if (
    !rawScalpSignals ||
    typeof rawScalpSignals !==
      "object"
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
        recordCount: 0,
        timeframeCount: 0,
      },
    };
  }

  const rawRecords =
    collectDedicatedScalpPairRecords(
      rawScalpSignals,
      pairKey
    );

  if (
    rawRecords.length === 0
  ) {
    const sourceUpdatedAt =
      normalizeTime(
        firstString(
          rawScalpSignals.updatedAt,
          rawScalpSignals.generatedAt,
          rawScalpSignals.timestamp,
          rawScalpSignals.time
        )
      );

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
          sourceUpdatedAt,
        stale:
          sourceUpdatedAt
            ? Date.now() -
                Date.parse(
                  sourceUpdatedAt
                ) >
              DAY_MS
            : null,
        recordCount: 0,
        timeframeCount: 0,
      },
    };
  }

  const parsedRecords =
    rawRecords
      .map(
        (record) =>
          parseDedicatedScalpRecord(
            record,
            rawScalpSignals,
            decimals
          )
      )
      .filter(Boolean);

  if (
    parsedRecords.length === 0
  ) {
    return {
      valid: false,

      reason:
        `Dedicated scalp records for ${pairKey} contain no valid decisions`,

      signal: null,

      meta: {
        available: true,
        pairFound: true,
        valid: false,
        decision: null,
        updatedAt: null,
        stale: null,
        recordCount: 0,
        timeframeCount: 0,
      },
    };
  }

  const recordsByMode =
    new Map();

  for (
    const record of
    parsedRecords
  ) {
    if (record.mode) {
      recordsByMode.set(
        record.mode,
        record
      );
    }
  }

  const record5m =
    recordsByMode.get("M5") ||
    null;

  const record15m =
    recordsByMode.get("M15") ||
    null;

  const record30m =
    recordsByMode.get("M30") ||
    null;

  let decision = "HOLD";
  let selectedRecord = null;
  let reason = null;

  if (record15m) {
    selectedRecord =
      record15m;

    if (
      record15m.decision ===
      "HOLD"
    ) {
      reason =
        record15m.reason ||
        "15-min anchor timeframe is not aligned";
    } else {
      const confirmations =
        (
          record5m &&
          record5m.decision ===
            record15m.decision
            ? 1
            : 0
        ) +
        (
          record30m &&
          record30m.decision ===
            record15m.decision
            ? 1
            : 0
        );

      if (
        confirmations >= 1
      ) {
        decision =
          record15m.decision;

        reason =
          "Dedicated scalp timeframes confirmed the 15-min anchor";
      } else {
        reason =
          "5-min and 30-min do not confirm the 15-min anchor";
      }
    }
  } else if (
    parsedRecords.length === 1
  ) {
    selectedRecord =
      parsedRecords[0];

    decision =
      selectedRecord.decision;

    reason =
      selectedRecord.reason ||
      "Single dedicated scalp record used for backward compatibility";
  } else {
    const buyRecords =
      parsedRecords.filter(
        (record) =>
          record.decision ===
          "BUY"
      );

    const sellRecords =
      parsedRecords.filter(
        (record) =>
          record.decision ===
          "SELL"
      );

    if (
      buyRecords.length >= 2 &&
      buyRecords.length >
        sellRecords.length
    ) {
      decision = "BUY";
      selectedRecord =
        buyRecords[0];
    } else if (
      sellRecords.length >= 2 &&
      sellRecords.length >
        buyRecords.length
    ) {
      decision = "SELL";
      selectedRecord =
        sellRecords[0];
    } else {
      decision = "HOLD";
      selectedRecord =
        parsedRecords[0];
    }

    reason =
      decision === "HOLD"
        ? "Dedicated scalp timeframes are mixed"
        : "Dedicated scalp decision selected by timeframe majority";
  }

  if (!selectedRecord) {
    selectedRecord =
      parsedRecords[0];
  }

  const timestamps =
    parsedRecords
      .map(
        (record) =>
          record.updatedAt
      )
      .filter(Boolean)
      .sort(
        (a, b) =>
          Date.parse(a) -
          Date.parse(b)
      );

  const updatedAt =
    timestamps.length
      ? timestamps[
          timestamps.length - 1
        ]
      : normalizeTime(
          firstString(
            rawScalpSignals.updatedAt,
            rawScalpSignals.generatedAt,
            rawScalpSignals.timestamp,
            rawScalpSignals.time
          )
        );

  const perTF = [
    {
      tf: "5m",
      signal:
        record5m
          ? record5m.decision
          : "HOLD",
    },
    {
      tf: "15m",
      signal:
        record15m
          ? record15m.decision
          : "HOLD",
    },
    {
      tf: "30m",
      signal:
        record30m
          ? record30m.decision
          : "HOLD",
    },
  ];

  return {
    valid: true,
    reason: null,

    signal: {
      decision,
      reason,
      perTF,

      entry:
        decision === "HOLD"
          ? null
          : selectedRecord.entry,

      sl:
        decision === "HOLD"
          ? null
          : selectedRecord.sl,

      tp:
        decision === "HOLD"
          ? null
          : selectedRecord.tp,

      rr:
        decision === "HOLD"
          ? null
          : selectedRecord.rr,

      source:
        "scalp-signals.json",

      sourceMode:
        "primary",

      updatedAt,
    },

    meta: {
      available: true,
      pairFound: true,
      valid: true,
      decision,
      updatedAt,

      stale:
        updatedAt
          ? Date.now() -
              Date.parse(
                updatedAt
              ) >
            DAY_MS
          : null,

      recordCount:
        parsedRecords.length,

      timeframeCount:
        recordsByMode.size,
    },
  };
}

// ========================================================
// Indicator Helpers
// ========================================================

function emaSeries(
  values,
  period
) {
  if (
    !Array.isArray(values) ||
    !Number.isInteger(period) ||
    period < 1
  ) {
    return [];
  }

  const output =
    new Array(
      values.length
    ).fill(null);

  if (
    values.length < period
  ) {
    return output;
  }

  const multiplier =
    2 / (period + 1);

  let previous =
    values
      .slice(0, period)
      .reduce(
        (sum, value) =>
          sum + value,
        0
      ) / period;

  output[
    period - 1
  ] = previous;

  for (
    let index = period;
    index < values.length;
    index += 1
  ) {
    previous =
      values[index] *
        multiplier +
      previous *
        (1 - multiplier);

    output[index] =
      previous;
  }

  return output;
}

function rsiSeries(
  values,
  period = 14
) {
  if (
    !Array.isArray(values)
  ) {
    return [];
  }

  const output =
    new Array(
      values.length
    ).fill(null);

  if (
    !Number.isInteger(period) ||
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
    index += 1
  ) {
    const difference =
      values[index] -
      values[index - 1];

    if (
      difference >= 0
    ) {
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
    let index =
      period + 1;
    index < values.length;
    index += 1
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

function computeVolatility(
  rows
) {
  if (
    !Array.isArray(rows) ||
    rows.length < 3
  ) {
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
      rows[index - 1]
        .close;

    const currentClose =
      rows[index].close;

    if (
      !isFiniteNumber(
        previousClose
      ) ||
      !isFiniteNumber(
        currentClose
      ) ||
      previousClose <= 0
    ) {
      continue;
    }

    totalMove +=
      Math.abs(
        currentClose -
          previousClose
      ) / previousClose;

    count += 1;
  }

  return count
    ? totalMove / count
    : 0.004;
}

function computeATR(
  ohlcRows,
  period = 14
) {
  if (
    !Array.isArray(
      ohlcRows
    ) ||
    !Number.isInteger(period) ||
    period < 1 ||
    ohlcRows.length <
      period + 1
  ) {
    return null;
  }

  const trueRanges = [];

  for (
    let index = 1;
    index <
      ohlcRows.length;
    index += 1
  ) {
    const current =
      ohlcRows[index];

    const previous =
      ohlcRows[
        index - 1
      ];

    trueRanges.push(
      Math.max(
        current.high -
          current.low,

        Math.abs(
          current.high -
            previous.close
        ),

        Math.abs(
          current.low -
            previous.close
        )
      )
    );
  }

  if (
    trueRanges.length <
    period
  ) {
    return null;
  }

  let atr =
    trueRanges
      .slice(0, period)
      .reduce(
        (sum, value) =>
          sum + value,
        0
      ) / period;

  for (
    let index = period;
    index <
      trueRanges.length;
    index += 1
  ) {
    atr =
      (
        atr *
          (period - 1) +
        trueRanges[index]
      ) / period;
  }

  return atr;
}

function computeADX(
  ohlcRows,
  period = 14
) {
  if (
    !Array.isArray(
      ohlcRows
    ) ||
    !Number.isInteger(period) ||
    period < 1 ||
    ohlcRows.length <
      period * 2 + 1
  ) {
    return null;
  }

  const trueRanges = [];
  const plusDM = [];
  const minusDM = [];

  for (
    let index = 1;
    index <
      ohlcRows.length;
    index += 1
  ) {
    const current =
      ohlcRows[index];

    const previous =
      ohlcRows[
        index - 1
      ];

    trueRanges.push(
      Math.max(
        current.high -
          current.low,

        Math.abs(
          current.high -
            previous.close
        ),

        Math.abs(
          current.low -
            previous.close
        )
      )
    );

    const upwardMove =
      current.high -
      previous.high;

    const downwardMove =
      previous.low -
      current.low;

    plusDM.push(
      upwardMove >
        downwardMove &&
      upwardMove > 0
        ? upwardMove
        : 0
    );

    minusDM.push(
      downwardMove >
        upwardMove &&
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
    smoothedTR +=
      trueRanges[index];

    smoothedPlusDM +=
      plusDM[index];

    smoothedMinusDM +=
      minusDM[index];
  }

  const dxSeries = [];

  for (
    let index = period;
    index <
      trueRanges.length;
    index += 1
  ) {
    smoothedTR =
      smoothedTR -
      smoothedTR /
        period +
      trueRanges[index];

    smoothedPlusDM =
      smoothedPlusDM -
      smoothedPlusDM /
        period +
      plusDM[index];

    smoothedMinusDM =
      smoothedMinusDM -
      smoothedMinusDM /
        period +
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
              plusDI -
                minusDI
            )
          ) /
          denominator;

    dxSeries.push(dx);
  }

  if (
    dxSeries.length <
    period
  ) {
    return null;
  }

  let adx =
    dxSeries
      .slice(0, period)
      .reduce(
        (sum, value) =>
          sum + value,
        0
      ) / period;

  for (
    let index = period;
    index <
      dxSeries.length;
    index += 1
  ) {
    adx =
      (
        adx *
          (period - 1) +
        dxSeries[index]
      ) / period;
  }

  return adx;
}

function computeSR(
  rows,
  lastClose
) {
  if (
    !Array.isArray(rows) ||
    rows.length === 0 ||
    !isFiniteNumber(
      lastClose
    )
  ) {
    return {
      resistances: [],
      supports: [],
    };
  }

  const closes =
    rows
      .map(
        (row) =>
          row.close
      )
      .filter(
        isFiniteNumber
      );

  const count =
    closes.length;

  if (count === 0) {
    return {
      resistances: [],
      supports: [],
    };
  }

  const radius =
    count > 40
      ? 2
      : 1;

  const swingHighs = [];
  const swingLows = [];

  for (
    let index = radius;
    index <
      count - radius;
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
          closes[
            index - offset
          ] ||
        closes[index] <
          closes[
            index + offset
          ]
      ) {
        isHigh = false;
      }

      if (
        closes[index] >
          closes[
            index - offset
          ] ||
        closes[index] >
          closes[
            index + offset
          ]
      ) {
        isLow = false;
      }
    }

    if (isHigh) {
      swingHighs.push(
        closes[index]
      );
    }

    if (isLow) {
      swingLows.push(
        closes[index]
      );
    }
  }

  function dedupeLevels(
    levels
  ) {
    const sorted =
      [...levels].sort(
        (a, b) =>
          a - b
      );

    const output = [];

    for (
      const level of sorted
    ) {
      const previous =
        output[
          output.length - 1
        ];

      if (
        previous == null ||
        Math.abs(
          level - previous
        ) / level >
          0.0015
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

  let resistances =
    dedupeLevels(
      swingHighs
    )
      .filter(
        (level) =>
          level >
          lastClose
      )
      .sort(
        (a, b) =>
          a - b
      )
      .slice(0, 2);

  let supports =
    dedupeLevels(
      swingLows
    )
      .filter(
        (level) =>
          level <
          lastClose
      )
      .sort(
        (a, b) =>
          b - a
      )
      .slice(0, 2);

  if (
    resistances.length ===
      0 &&
    count >= 3
  ) {
    const maximumClose =
      Math.max(
        ...closes
      );

    if (
      maximumClose >
      lastClose *
        1.0005
    ) {
      resistances = [
        maximumClose,
      ];
    }
  }

  if (
    supports.length ===
      0 &&
    count >= 3
  ) {
    const minimumClose =
      Math.min(
        ...closes
      );

    if (
      minimumClose <
      lastClose *
        0.9995
    ) {
      supports = [
        minimumClose,
      ];
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
    !Array.isArray(
      ohlcRows
    ) ||
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
    ohlcRows[
      ohlcRows.length - 1
    ];

  const previous =
    ohlcRows[
      ohlcRows.length - 2
    ];

  const range =
    last.high -
    last.low;

  const body =
    Math.abs(
      last.close -
      last.open
    );

  const bodyPercentage =
    range > 0
      ? body / range
      : 0;

  if (
    leanDirection ===
    "BUY"
  ) {
    const bullishEngulfing =
      previous.close <
        previous.open &&
      last.close >
        last.open &&
      last.open <=
        previous.close &&
      last.close >=
        previous.open;

    if (
      bullishEngulfing
    ) {
      return {
        ok: true,
        detail:
          "Bullish engulfing on the latest candle",
      };
    }

    if (
      last.close >
        last.open &&
      bodyPercentage > 0.6
    ) {
      return {
        ok: true,
        detail:
          `Strong bullish candle ` +
          `(body ${(
            bodyPercentage *
            100
          ).toFixed(
            0
          )}% of range)`,
      };
    }

    return {
      ok: false,
      detail:
        "Latest candle doesn't confirm a bullish pattern",
    };
  }

  const bearishEngulfing =
    previous.close >
      previous.open &&
    last.close <
      last.open &&
    last.open >=
      previous.close &&
    last.close <=
      previous.open;

  if (
    bearishEngulfing
  ) {
    return {
      ok: true,
      detail:
        "Bearish engulfing on the latest candle",
    };
  }

  if (
    last.close <
      last.open &&
    bodyPercentage > 0.6
  ) {
    return {
      ok: true,
      detail:
        `Strong bearish candle ` +
        `(body ${(
          bodyPercentage *
          100
        ).toFixed(
          0
        )}% of range)`,
    };
  }

  return {
    ok: false,
    detail:
      "Latest candle doesn't confirm a bearish pattern",
  };
}

// ========================================================
// Trend Helpers
// ========================================================

function adaptiveEmaPeriods(
  rowCount
) {
  if (
    !Number.isInteger(
      rowCount
    ) ||
    rowCount < 6
  ) {
    return null;
  }

  const cap =
    rowCount - 1;

  const p200 =
    Math.min(
      200,
      cap
    );

  const p100 =
    Math.min(
      100,
      Math.max(
        4,
        Math.floor(
          p200 * 0.5
        )
      )
    );

  const p50 =
    Math.min(
      50,
      Math.max(
        3,
        Math.floor(
          p100 * 0.6
        )
      )
    );

  const p20 =
    Math.min(
      20,
      Math.max(
        2,
        Math.floor(
          p50 * 0.5
        )
      )
    );

  return {
    p20,
    p50,
    p100,
    p200,
    fullStack:
      cap >= 200,
  };
}

function calculateTrendState(
  rows
) {
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

  const closes =
    rows
      .map(
        (row) =>
          row.close
      )
      .filter(
        isFiniteNumber
      );

  if (
    closes.length < 6
  ) {
    return {
      direction: null,

      label:
        "Building history — valid close history is not ready",

      values: null,
      periods: null,
    };
  }

  const periods =
    adaptiveEmaPeriods(
      closes.length
    );

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

  const ema20 =
    emaSeries(
      closes,
      p20
    );

  const ema50 =
    emaSeries(
      closes,
      p50
    );

  const ema100 =
    emaSeries(
      closes,
      p100
    );

  const ema200 =
    emaSeries(
      closes,
      p200
    );

  const lastIndex =
    closes.length - 1;

  const lastClose =
    closes[lastIndex];

  const values = {
    v20:
      ema20[lastIndex],

    v50:
      ema50[lastIndex],

    v100:
      ema100[lastIndex],

    v200:
      ema200[lastIndex],
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
    bullishChecks
      .filter(Boolean)
      .length;

  const bearishCount =
    bearishChecks
      .filter(Boolean)
      .length;

  const note =
    fullStack
      ? ""
      : " (adaptive periods — full EMA200 needs more history)";

  if (
    bullishCount === 4
  ) {
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

  if (
    bearishCount === 4
  ) {
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

  if (
    bullishCount >= 3
  ) {
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

  if (
    bearishCount >= 3
  ) {
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

function trendDirectionOf(
  rows
) {
  return calculateTrendState(
    rows
  ).direction;
}
