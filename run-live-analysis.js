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
