// resolve-analysis-history.js
//
// PipSight Pro — Analysis History Trade Resolver.
//
// Phase 9 goals:
// - Resolve existing open history records against verified market candles.
// - Preserve the existing analysis-history.json schema.
// - Preserve legacy open / closed collections.
// - Preserve current records / history / items aliases.
// - Never modify trading strategy decisions.
// - Never invent missing prices, timestamps or outcomes.
// - Use deterministic processing and atomic JSON writes.
// - Remain duplicate-safe across repeated runs.
//
// Reads:
//   data/analysis-history.json
//   data/scalp-candles.json
//   data/intraday-h1.json
//   data/daily-ohlc.json
//
// Writes:
//   data/analysis-history.json
//
// Compatibility:
// - CommonJS / Node.js 20.
// - Existing Swing, Intraday, Scalp and Master logic remains unchanged.
// - Existing Telegram logic remains unchanged.
// - Existing Learning and AI Memory schemas remain unchanged.
// - Existing legacy history records remain supported.

"use strict";

const fs =
  require("fs");

const path =
  require("path");

// ============================================================================
// Engine metadata
// ============================================================================

const ENGINE_NAME =
  "PipSight Pro Analysis History Resolver";

const ENGINE_VERSION =
  "1.0.0";

const HISTORY_VERSION =
  1;

const RECORD_CLOCK_SKEW_TOLERANCE_MS =
  5 * 60 * 1000;

const MARKET_SOURCE_INTERVAL_MINUTES =
  Object.freeze({
    scalp:
      5,

    intraday:
      60,

    swing:
      24 * 60
  });

// ============================================================================
// Paths
// ============================================================================

const ROOT_DIR =
  __dirname;

const DATA_DIR =
  path.join(
    ROOT_DIR,
    "data"
  );

const ANALYSIS_HISTORY_PATH =
  path.join(
    DATA_DIR,
    "analysis-history.json"
  );

const SCALP_CANDLES_PATH =
  path.join(
    DATA_DIR,
    "scalp-candles.json"
  );

const INTRADAY_CANDLES_PATH =
  path.join(
    DATA_DIR,
    "intraday-h1.json"
  );

const DAILY_CANDLES_PATH =
  path.join(
    DATA_DIR,
    "daily-ohlc.json"
  );

// ============================================================================
// Supported values
// ============================================================================

const SUPPORTED_PAIRS =
  new Set([
    "XAUUSD",
    "GBPJPY"
  ]);

const SUPPORTED_DIRECTIONS =
  new Set([
    "BUY",
    "SELL"
  ]);

const RESOLVED_OUTCOMES =
  new Set([
    "WIN",
    "LOSS",
    "BREAKEVEN"
  ]);

const OPEN_STATUSES =
  new Set([
    "open",
    "pending",
    "active"
  ]);

const CLOSED_STATUSES =
  new Set([
    "closed",
    "resolved",
    "complete",
    "completed"
  ]);

const ENGINE_ALIASES =
  Object.freeze({
    swing:
      "swing",

    weekly:
      "swing",

    intraday:
      "intraday",

    daily:
      "intraday",

    scalp:
      "scalp",

    "scalp-5m":
      "scalp",

    "scalp-15m":
      "scalp",

    "scalp-30m":
      "scalp",

    master:
      "master"
  });

// ============================================================================
// Generic validation helpers
// ============================================================================

function isPlainObject(
  value
) {

  return Boolean(
    value &&
    typeof value ===
      "object" &&
    !Array.isArray(
      value
    )
  );

}

function asArray(
  value
) {

  return Array.isArray(
    value
  )
    ? value
    : [];

}

function toFiniteNumber(
  value
) {

  if (
    value === null ||
    value === undefined ||
    (
      typeof value ===
        "string" &&
      value.trim() ===
        ""
    )
  ) {

    return null;

  }

  const number =
    Number(
      value
    );

  return Number.isFinite(
    number
  )
    ? number
    : null;

}

function toTrimmedString(
  value
) {

  if (
    value === null ||
    value === undefined
  ) {

    return "";

  }

  return String(
    value
  ).trim();

}

function normalizeUpperString(
  value
) {

  return toTrimmedString(
    value
  ).toUpperCase();

}

function normalizeLowerString(
  value
) {

  return toTrimmedString(
    value
  ).toLowerCase();

}

function toTimestamp(
  value
) {

  if (
    value === null ||
    value === undefined ||
    value ===
      ""
  ) {

    return null;

  }

  if (
    typeof value ===
      "number" &&
    Number.isFinite(
      value
    )
  ) {

    const milliseconds =
      value < 100000000000
        ? value * 1000
        : value;

    const date =
      new Date(
        milliseconds
      );

    return Number.isNaN(
      date.getTime()
    )
      ? null
      : date.getTime();

  }

  if (
    typeof value ===
      "string"
  ) {

    const trimmed =
      value.trim();

    if (!trimmed) {

      return null;

    }

    const numeric =
      Number(
        trimmed
      );

    if (
      Number.isFinite(
        numeric
      )
    ) {

      return toTimestamp(
        numeric
      );

    }

    let normalized =
      trimmed;

    /*
     * Market files use UTC timestamps but may omit an explicit timezone.
     * Normalize those exact date/time forms to UTC so resolution does not
     * depend on the host machine timezone.
     */
    if (
      /^\d{4}-\d{2}-\d{2}$/.test(
        normalized
      )
    ) {

      normalized +=
        "T00:00:00Z";

    } else {

      if (
        /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(
          normalized
        )
      ) {

        normalized =
          normalized.replace(
            " ",
            "T"
          );

      }

      if (
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(
          normalized
        )
      ) {

        normalized +=
          "Z";

      }

    }

    const parsed =
      Date.parse(
        normalized
      );

    return Number.isNaN(
      parsed
    )
      ? null
      : parsed;

  }

  const parsed =
    new Date(
      value
    ).getTime();

  return Number.isNaN(
    parsed
  )
    ? null
    : parsed;

}

function toISOStringOrNull(
  value
) {

  const timestamp =
    toTimestamp(
      value
    );

  if (
    timestamp === null
  ) {

    return null;

  }

  return new Date(
    timestamp
  ).toISOString();

}

function cloneJSONValue(
  value
) {

  if (
    value === undefined
  ) {

    return undefined;

  }

  return JSON.parse(
    JSON.stringify(
      value
    )
  );

}

function ensureDirectory(
  directoryPath
) {

  if (
    fs.existsSync(
      directoryPath
    )
  ) {

    return;

  }

  fs.mkdirSync(
    directoryPath,
    {
      recursive:
        true
    }
  );

}

// ============================================================================
// Safe JSON I/O
// ============================================================================

function readJSON(
  filePath,
  options = {}
) {

  const required =
    options.required ===
      true;

  const fallbackValue =
    options.fallbackValue ===
      undefined
      ? null
      : options.fallbackValue;

  if (
    !fs.existsSync(
      filePath
    )
  ) {

    if (required) {

      throw new Error(
        `Required file does not exist: ${path.relative(
          ROOT_DIR,
          filePath
        )}`
      );

    }

    return fallbackValue;

  }

  const raw =
    fs.readFileSync(
      filePath,
      "utf8"
    );

  if (
    !raw.trim()
  ) {

    if (required) {

      throw new Error(
        `Required file is empty: ${path.relative(
          ROOT_DIR,
          filePath
        )}`
      );

    }

    return fallbackValue;

  }

  try {

    return JSON.parse(
      raw
    );

  } catch (
    error
  ) {

    throw new Error(
      `Invalid JSON in ${path.relative(
        ROOT_DIR,
        filePath
      )}: ${error.message}`
    );

  }

}

function atomicWriteJSON(
  filePath,
  value
) {

  ensureDirectory(
    path.dirname(
      filePath
    )
  );

  const temporaryPath =
    `${filePath}.${process.pid}.${Date.now()}.tmp`;

  let temporaryCreated =
    false;

  try {

    fs.writeFileSync(
      temporaryPath,
      `${JSON.stringify(
        value,
        null,
        2
      )}\n`,
      "utf8"
    );

    temporaryCreated =
      true;

    fs.renameSync(
      temporaryPath,
      filePath
    );

    temporaryCreated =
      false;

  } finally {

    if (
      temporaryCreated &&
      fs.existsSync(
        temporaryPath
      )
    ) {

      try {

        fs.unlinkSync(
          temporaryPath
        );

      } catch (_) {

        // Cleanup failure must not hide the original write error.

      }

    }

  }

}

// ============================================================================
// Pair normalization
// ============================================================================

function normalizePairKey(
  value
) {

  const compact =
    normalizeUpperString(
      value
    ).replace(
      /[^A-Z0-9]/g,
      ""
    );

  if (
    compact ===
      "XAUUSD"
  ) {

    return "XAUUSD";

  }

  if (
    compact ===
      "GBPJPY"
  ) {

    return "GBPJPY";

  }

  return null;

}

function pairLabelFromKey(
  pairKey
) {

  if (
    pairKey ===
      "XAUUSD"
  ) {

    return "XAU/USD";

  }

  if (
    pairKey ===
      "GBPJPY"
  ) {

    return "GBP/JPY";

  }

  return null;

}

// ============================================================================
// Direction, engine and status normalization
// ============================================================================

function normalizeDirection(
  value
) {

  const direction =
    normalizeUpperString(
      value
    );

  return SUPPORTED_DIRECTIONS.has(
    direction
  )
    ? direction
    : null;

}

function normalizeEngine(
  value
) {

  const engine =
    normalizeLowerString(
      value
    );

  return ENGINE_ALIASES[
    engine
  ] || null;

}

function normalizeOutcome(
  value
) {

  const outcome =
    normalizeUpperString(
      value
    );

  return RESOLVED_OUTCOMES.has(
    outcome
  )
    ? outcome
    : null;

}

function normalizeStatus(
  value,
  outcome = null
) {

  if (
    normalizeOutcome(
      outcome
    )
  ) {

    return "closed";

  }

  const status =
    normalizeLowerString(
      value
    );

  if (
    CLOSED_STATUSES.has(
      status
    )
  ) {

    return "closed";

  }

  if (
    OPEN_STATUSES.has(
      status
    )
  ) {

    return "open";

  }

  if (
    status ===
      "hold"
  ) {

    return "hold";

  }

  return status ||
    null;

}

// ============================================================================
// History record field extraction
// ============================================================================

function getRecordPairKey(
  record
) {

  if (
    !isPlainObject(
      record
    )
  ) {

    return null;

  }

  return normalizePairKey(
    record.pair ??
    record.symbol ??
    record.pairLabel ??
    record.snapshot?.pair ??
    record.snapshot?.symbol
  );

}

function getRecordDirection(
  record
) {

  if (
    !isPlainObject(
      record
    )
  ) {

    return null;

  }

  return normalizeDirection(
    record.direction ??
    record.decision ??
    record.signal ??
    record.action ??
    record.tradePlan?.direction ??
    record.snapshot?.direction ??
    record.snapshot?.decision
  );

}

function getRecordEngine(
  record
) {

  if (
    !isPlainObject(
      record
    )
  ) {

    return null;

  }

  return normalizeEngine(
    record.engine ??
    record.engineName ??
    record.mode ??
    record.strategy ??
    record.snapshot?.engine ??
    record.snapshot?.mode
  );

}

function getRecordEntry(
  record
) {

  if (
    !isPlainObject(
      record
    )
  ) {

    return null;

  }

  return toFiniteNumber(
    record.entry ??
    record.entryPrice ??
    record.tradePlan?.entry ??
    record.tradePlan?.entryPrice ??
    record.plan?.entry ??
    record.snapshot?.entry ??
    record.snapshot?.entryPrice ??
    record.snapshot?.tradePlan?.entry
  );

}

function getRecordStop(
  record
) {

  if (
    !isPlainObject(
      record
    )
  ) {

    return null;

  }

  return toFiniteNumber(
    record.stop ??
    record.stopLoss ??
    record.sl ??
    record.tradePlan?.stop ??
    record.tradePlan?.stopLoss ??
    record.tradePlan?.sl ??
    record.plan?.stop ??
    record.snapshot?.stop ??
    record.snapshot?.stopLoss ??
    record.snapshot?.tradePlan?.stop
  );

}

function getRecordTargets(
  record
) {

  if (
    !isPlainObject(
      record
    )
  ) {

    return [];

  }

  const candidates = [
    record.target1,
    record.takeProfit1,
    record.tp1,
    record.target,
    record.takeProfit,
    record.tp,
    record.tradePlan?.target1,
    record.tradePlan?.takeProfit1,
    record.tradePlan?.tp1,
    record.tradePlan?.target,
    record.plan?.target1,
    record.snapshot?.target1,
    record.snapshot?.takeProfit1,
    record.snapshot?.tp1,
    record.snapshot?.tradePlan?.target1,

    record.target2,
    record.takeProfit2,
    record.tp2,
    record.tradePlan?.target2,
    record.tradePlan?.takeProfit2,
    record.tradePlan?.tp2,
    record.plan?.target2,
    record.snapshot?.target2,
    record.snapshot?.takeProfit2,
    record.snapshot?.tp2,
    record.snapshot?.tradePlan?.target2,

    record.target3,
    record.takeProfit3,
    record.tp3,
    record.tradePlan?.target3,
    record.tradePlan?.takeProfit3,
    record.tradePlan?.tp3,
    record.plan?.target3,
    record.snapshot?.target3,
    record.snapshot?.takeProfit3,
    record.snapshot?.tp3,
    record.snapshot?.tradePlan?.target3
  ];

  const targets = [];

  for (
    const candidate of
      candidates
  ) {

    const number =
      toFiniteNumber(
        candidate
      );

    if (
      number === null ||
      targets.includes(
        number
      )
    ) {

      continue;

    }

    targets.push(
      number
    );

  }

  return targets;

}

function getRecordOpenedTimestamp(
  record
) {

  if (
    !isPlainObject(
      record
    )
  ) {

    return null;

  }

  /*
   * Market-candle timestamps have priority over record persistence times.
   * This keeps analyzedCandleAt authoritative when the upstream pipeline
   * provides it and prevents createdAt from silently replacing market time.
   */
  const candidates = [
    record.analyzedCandleAt,
    record.snapshot?.analyzedCandleAt,
    record.signalTimestamp,
    record.signalTime,
    record.openedAt,
    record.snapshot?.signalTimestamp,
    record.snapshot?.signalTime,
    record.timestamp,
    record.time,
    record.snapshot?.timestamp,
    record.snapshot?.time,
    record.generatedAt,
    record.snapshot?.generatedAt,
    record.createdAt,
    record.recordedAt
  ];

  for (
    const candidate of
      candidates
  ) {

    const timestamp =
      toTimestamp(
        candidate
      );

    if (
      timestamp !== null
    ) {

      return timestamp;

    }

  }

  return null;

}

function getRecordCreationTimestamp(
  record
) {

  if (
    !isPlainObject(
      record
    )
  ) {

    return null;

  }

  const candidates = [
    record.recordedAt,
    record.createdAt,
    record.generatedAt,
    record.snapshot?.generatedAt
  ];

  for (
    const candidate of
      candidates
  ) {

    const timestamp =
      toTimestamp(
        candidate
      );

    if (
      timestamp !== null
    ) {

      return timestamp;

    }

  }

  return null;

}

function validateRecordTimestampSafety(
  record,
  openedTimestamp,
  nowMs = Date.now()
) {

  const errors = [];

  const safeNowMs =
    Number.isFinite(
      nowMs
    )
      ? nowMs
      : Date.now();

  if (
    openedTimestamp === null
  ) {

    return errors;

  }

  if (
    openedTimestamp >
      safeNowMs
  ) {

    errors.push(
      "Open timestamp is in the future"
    );

  }

  const creationTimestamp =
    getRecordCreationTimestamp(
      record
    );

  if (
    creationTimestamp !== null &&
    openedTimestamp >
      creationTimestamp +
      RECORD_CLOCK_SKEW_TOLERANCE_MS
  ) {

    errors.push(
      "Open timestamp occurs after record creation time"
    );

  }

  return errors;

}

function getRecordOutcome(
  record
) {

  if (
    !isPlainObject(
      record
    )
  ) {

    return null;

  }

  return normalizeOutcome(
    record.outcome ??
    record.result ??
    record.resolution?.outcome
  );

}

function isRecordAlreadyResolved(
  record
) {

  if (
    !isPlainObject(
      record
    )
  ) {

    return false;

  }

  if (
    getRecordOutcome(
      record
    )
  ) {

    return true;

  }

  return normalizeStatus(
    record.status,
    record.outcome
  ) ===
    "closed";

}

function isRecordOpenCandidate(
  record
) {

  if (
    !isPlainObject(
      record
    ) ||
    isRecordAlreadyResolved(
      record
    )
  ) {

    return false;

  }

  const status =
    normalizeStatus(
      record.status,
      record.outcome
    );

  if (
    status ===
      "hold"
  ) {

    return false;

  }

  return Boolean(
    getRecordPairKey(
      record
    ) &&
    getRecordDirection(
      record
    ) &&
    getRecordEngine(
      record
    ) &&
    getRecordEntry(
      record
    ) !== null &&
    getRecordStop(
      record
    ) !== null &&
    getRecordTargets(
      record
    ).length > 0 &&
    getRecordOpenedTimestamp(
      record
    ) !== null
  );

}

// ============================================================================
// History normalization
// ============================================================================

function createEmptyHistory() {

  const records = [];

  return {
    version:
      HISTORY_VERSION,

    updatedAt:
      new Date().toISOString(),

    open:
      {},

    closed:
      [],

    records,

    history:
      records,

    items:
      records
  };

}

function normalizeAnalysisHistory(
  rawHistory
) {

  if (
    Array.isArray(
      rawHistory
    )
  ) {

    const records =
      rawHistory;

    return {
      version:
        HISTORY_VERSION,

      updatedAt:
        new Date().toISOString(),

      open:
        {},

      closed:
        [],

      records,

      history:
        records,

      items:
        records
    };

  }

  if (
    !isPlainObject(
      rawHistory
    )
  ) {

    return createEmptyHistory();

  }

  let records;

  if (
    Array.isArray(
      rawHistory.records
    )
  ) {

    records =
      rawHistory.records;

  } else if (
    Array.isArray(
      rawHistory.history
    )
  ) {

    records =
      rawHistory.history;

  } else if (
    Array.isArray(
      rawHistory.items
    )
  ) {

    records =
      rawHistory.items;

  } else if (
    Array.isArray(
      rawHistory.signals
    )
  ) {

    records =
      rawHistory.signals;

  } else {

    records =
      [];

  }

  const legacyOpen =
    isPlainObject(
      rawHistory.open
    )
      ? rawHistory.open
      : {};

  const legacyClosed =
    asArray(
      rawHistory.closed
    );

  return {
    ...rawHistory,

    version:
      toFiniteNumber(
        rawHistory.version
      ) ??
      HISTORY_VERSION,

    updatedAt:
      toISOStringOrNull(
        rawHistory.updatedAt
      ) ||
      new Date().toISOString(),

    open:
      legacyOpen,

    closed:
      legacyClosed,

    records,

    // Preserve aliases as references to the same records array.
    history:
      records,

    items:
      records
  };

}

function loadAnalysisHistory() {

  const rawHistory =
    readJSON(
      ANALYSIS_HISTORY_PATH,
      {
        required:
          true
      }
    );

  return normalizeAnalysisHistory(
    rawHistory
  );

}

// ============================================================================
// Candle field extraction
// ============================================================================

function getCandleTimestamp(
  row
) {

  if (
    !isPlainObject(
      row
    )
  ) {

    return null;

  }

  const candidates = [
    row.timestamp,
    row.time,
    row.datetime,
    row.date,
    row.openTime,
    row.open_time,
    row.startTime,
    row.start_time,
    row.createdAt,
    row.generatedAt
  ];

  for (
    const candidate of
      candidates
  ) {

    const timestamp =
      toTimestamp(
        candidate
      );

    if (
      timestamp !== null
    ) {

      return timestamp;

    }

  }

  return null;

}

function getCandleOpen(
  row
) {

  if (
    !isPlainObject(
      row
    )
  ) {

    return null;

  }

  return toFiniteNumber(
    row.open ??
    row.o ??
    row.openPrice ??
    row.open_price
  );

}

function getCandleHigh(
  row
) {

  if (
    !isPlainObject(
      row
    )
  ) {

    return null;

  }

  return toFiniteNumber(
    row.high ??
    row.h ??
    row.highPrice ??
    row.high_price
  );

}

function getCandleLow(
  row
) {

  if (
    !isPlainObject(
      row
    )
  ) {

    return null;

  }

  return toFiniteNumber(
    row.low ??
    row.l ??
    row.lowPrice ??
    row.low_price
  );

}

function getCandleClose(
  row
) {

  if (
    !isPlainObject(
      row
    )
  ) {

    return null;

  }

  return toFiniteNumber(
    row.close ??
    row.c ??
    row.closePrice ??
    row.close_price ??
    row.price
  );

}

function getCandleClosedState(
  row
) {

  if (
    !isPlainObject(
      row
    )
  ) {

    return null;

  }

  const explicitClosed =
    row.closed ??
    row.isClosed ??
    row.is_closed ??
    row.complete ??
    row.completed ??
    row.final;

  if (
    explicitClosed ===
      true
  ) {

    return true;

  }

  if (
    explicitClosed ===
      false
  ) {

    return false;

  }

  const status =
    normalizeLowerString(
      row.status ??
      row.state ??
      row.candleStatus
    );

  if (
    status ===
      "closed" ||
    status ===
      "complete" ||
    status ===
      "completed" ||
    status ===
      "final"
  ) {

    return true;

  }

  if (
    status ===
      "open" ||
    status ===
      "forming" ||
    status ===
      "active" ||
    status ===
      "incomplete"
  ) {

    return false;

  }

  return null;

}

// ============================================================================
// Candle normalization
// ============================================================================

function getCandleTimeSafety(
  rawCandle,
  options = {}
) {

  const timestamp =
    getCandleTimestamp(
      rawCandle
    );

  const explicitClosed =
    getCandleClosedState(
      rawCandle
    );

  const safeNowMs =
    Number.isFinite(
      options.nowMs
    )
      ? options.nowMs
      : Date.now();

  const intervalMinutes =
    toFiniteNumber(
      options.intervalMinutes
    );

  const intervalMs =
    intervalMinutes !== null &&
    intervalMinutes > 0
      ? intervalMinutes *
        60 *
        1000
      : null;

  if (
    timestamp === null
  ) {

    return {
      safe:
        false,

      reason:
        "invalid-time",

      timestamp:
        null,

      closeTimestamp:
        null,

      explicitClosed
    };

  }

  if (
    timestamp >
      safeNowMs
  ) {

    return {
      safe:
        false,

      reason:
        "future-candle",

      timestamp,

      closeTimestamp:
        intervalMs === null
          ? null
          : timestamp +
            intervalMs,

      explicitClosed
    };

  }

  if (
    options.closedOnly ===
      true &&
    explicitClosed ===
      false
  ) {

    return {
      safe:
        false,

      reason:
        "explicitly-open",

      timestamp,

      closeTimestamp:
        intervalMs === null
          ? null
          : timestamp +
            intervalMs,

      explicitClosed
    };

  }

  const closeTimestamp =
    intervalMs === null
      ? null
      : timestamp +
        intervalMs;

  if (
    options.closedOnly ===
      true &&
    closeTimestamp !== null &&
    closeTimestamp >
      safeNowMs
  ) {

    return {
      safe:
        false,

      reason:
        "incomplete-by-time",

      timestamp,
      closeTimestamp,
      explicitClosed
    };

  }

  return {
    safe:
      true,

    reason:
      null,

    timestamp,
    closeTimestamp,
    explicitClosed
  };

}

function normalizeCandle(
  rawCandle,
  options = {}
) {

  if (
    !isPlainObject(
      rawCandle
    )
  ) {

    return null;

  }

  const timeSafety =
    getCandleTimeSafety(
      rawCandle,
      options
    );

  if (
    timeSafety.safe !==
      true
  ) {

    return null;

  }

  const timestamp =
    timeSafety.timestamp;

  const open =
    getCandleOpen(
      rawCandle
    );

  const high =
    getCandleHigh(
      rawCandle
    );

  const low =
    getCandleLow(
      rawCandle
    );

  const close =
    getCandleClose(
      rawCandle
    );

  if (
    timestamp === null ||
    open === null ||
    high === null ||
    low === null ||
    close === null
  ) {

    return null;

  }

  if (
    open <= 0 ||
    high <= 0 ||
    low <= 0 ||
    close <= 0
  ) {

    return null;

  }

  if (
    high < low ||
    high < open ||
    high < close ||
    low > open ||
    low > close
  ) {

    return null;

  }

  return {
    timestamp,

    time:
      new Date(
        timestamp
      ).toISOString(),

    closeTimestamp:
      timeSafety.closeTimestamp,

    closeTime:
      timeSafety.closeTimestamp ===
        null
        ? null
        : new Date(
            timeSafety.closeTimestamp
          ).toISOString(),

    open,
    high,
    low,
    close,

    closed:
      timeSafety.explicitClosed,

    pair:
      options.pairKey ||
      normalizePairKey(
        rawCandle.pair ??
        rawCandle.symbol ??
        rawCandle.instrument
      ),

    source:
      options.source ||
      null,

    raw:
      rawCandle
  };

}

function normalizeCandles(
  rawRows,
  options = {}
) {

  const rows =
    asArray(
      rawRows
    );

  const candlesByTimestamp =
    new Map();

  const normalizedOptions = {
    ...options,

    nowMs:
      Number.isFinite(
        options.nowMs
      )
        ? options.nowMs
        : Date.now()
  };

  let invalidCount =
    0;

  let duplicateCount =
    0;

  let explicitlyOpenCount =
    0;

  let futureCandleCount =
    0;

  let incompleteByTimeCount =
    0;

  for (
    const rawRow of
      rows
  ) {

    const timeSafety =
      getCandleTimeSafety(
        rawRow,
        normalizedOptions
      );

    if (
      timeSafety.reason ===
        "explicitly-open"
    ) {

      explicitlyOpenCount +=
        1;

    }

    if (
      timeSafety.reason ===
        "future-candle"
    ) {

      futureCandleCount +=
        1;

    }

    if (
      timeSafety.reason ===
        "incomplete-by-time"
    ) {

      incompleteByTimeCount +=
        1;

    }

    const candle =
      normalizeCandle(
        rawRow,
        normalizedOptions
      );

    if (!candle) {

      invalidCount +=
        1;

      continue;

    }

    if (
      candlesByTimestamp.has(
        candle.timestamp
      )
    ) {

      duplicateCount +=
        1;

    }

    /*
     * Deterministic duplicate handling:
     * the later row in the source document replaces the earlier row.
     */
    candlesByTimestamp.set(
      candle.timestamp,
      candle
    );

  }

  const candles =
    Array.from(
      candlesByTimestamp.values()
    ).sort(
      (
        left,
        right
      ) =>
        left.timestamp -
        right.timestamp
    );

  return {
    candles,

    metadata: {
      sourceRowCount:
        rows.length,

      validCandleCount:
        candles.length,

      invalidCandleCount:
        invalidCount,

      duplicateCandleCount:
        duplicateCount,

      explicitlyOpenCandleCount:
        explicitlyOpenCount,

      futureCandleCount,

      incompleteByTimeCandleCount:
        incompleteByTimeCount,

      intervalMinutes:
        toFiniteNumber(
          normalizedOptions.intervalMinutes
        ),

      firstCandleTime:
        candles.length > 0
          ? candles[0].time
          : null,

      latestCandleTime:
        candles.length > 0
          ? candles[
              candles.length - 1
            ].time
          : null
    }
  };

}

// ============================================================================
// Pair-keyed document extraction
// ============================================================================

function getPairAliases(
  pairKey
) {

  if (
    pairKey ===
      "XAUUSD"
  ) {

    return [
      "XAUUSD",
      "XAU/USD",
      "XAU_USD",
      "XAU-USD",
      "xauusd",
      "xau/usd",
      "gold",
      "GOLD"
    ];

  }

  if (
    pairKey ===
      "GBPJPY"
  ) {

    return [
      "GBPJPY",
      "GBP/JPY",
      "GBP_JPY",
      "GBP-JPY",
      "gbpjpy",
      "gbp/jpy",
      "GJ",
      "gj"
    ];

  }

  return [];

}

function findPairProperty(
  object,
  pairKey
) {

  if (
    !isPlainObject(
      object
    )
  ) {

    return undefined;

  }

  for (
    const alias of
      getPairAliases(
        pairKey
      )
  ) {

    if (
      Object.prototype.hasOwnProperty.call(
        object,
        alias
      )
    ) {

      return object[
        alias
      ];

    }

  }

  for (
    const [
      key,
      value
    ] of Object.entries(
      object
    )
  ) {

    if (
      normalizePairKey(
        key
      ) ===
        pairKey
    ) {

      return value;

    }

  }

  return undefined;

}

function rowMatchesPair(
  row,
  pairKey
) {

  if (
    !isPlainObject(
      row
    )
  ) {

    return false;

  }

  const rowPair =
    normalizePairKey(
      row.pair ??
      row.symbol ??
      row.instrument ??
      row.market ??
      row.asset ??
      row.ticker
    );

  return rowPair ===
    pairKey;

}

function extractPairRowsFromArray(
  rows,
  pairKey
) {

  const sourceRows =
    asArray(
      rows
    );

  const taggedRows =
    sourceRows.filter(
      (
        row
      ) =>
        rowMatchesPair(
          row,
          pairKey
        )
    );

  /*
   * If rows contain pair tags, only the matching subset is safe.
   * If no rows contain pair tags, the array may already be pair-specific.
   */
  const containsAnyPairTags =
    sourceRows.some(
      (
        row
      ) =>
        Boolean(
          normalizePairKey(
            row?.pair ??
            row?.symbol ??
            row?.instrument ??
            row?.market ??
            row?.asset ??
            row?.ticker
          )
        )
    );

  if (
    containsAnyPairTags
  ) {

    return taggedRows;

  }

  return sourceRows;

}

function unwrapRowsContainer(
  value,
  pairKey
) {

  if (
    Array.isArray(
      value
    )
  ) {

    return extractPairRowsFromArray(
      value,
      pairKey
    );

  }

  if (
    !isPlainObject(
      value
    )
  ) {

    return [];

  }

  const pairValue =
    findPairProperty(
      value,
      pairKey
    );

  if (
    pairValue !==
      undefined &&
    pairValue !==
      value
  ) {

    const nestedPairRows =
      unwrapRowsContainer(
        pairValue,
        pairKey
      );

    if (
      nestedPairRows.length >
        0
    ) {

      return nestedPairRows;

    }

  }

  const containerKeys = [
    "candles",
    "rows",
    "data",
    "history",
    "prices",
    "ohlc",
    "results",
    "items",
    "values",
    "series"
  ];

  for (
    const key of
      containerKeys
  ) {

    if (
      value[
        key
      ] ===
        undefined
    ) {

      continue;

    }

    const nestedRows =
      unwrapRowsContainer(
        value[
          key
        ],
        pairKey
      );

    if (
      nestedRows.length >
        0
    ) {

      return nestedRows;

    }

  }

  return [];

}

function extractPairRows(
  document,
  pairKey
) {

  if (
    !SUPPORTED_PAIRS.has(
      pairKey
    )
  ) {

    return [];

  }

  if (
    Array.isArray(
      document
    )
  ) {

    return extractPairRowsFromArray(
      document,
      pairKey
    );

  }

  if (
    !isPlainObject(
      document
    )
  ) {

    return [];

  }

  const directPairValue =
    findPairProperty(
      document,
      pairKey
    );

  if (
    directPairValue !==
      undefined
  ) {

    const directRows =
      unwrapRowsContainer(
        directPairValue,
        pairKey
      );

    if (
      directRows.length >
        0
    ) {

      return directRows;

    }

  }

  const pairContainerKeys = [
  "pairs",
  "symbols",
  "markets",
  "instruments",
  "assets",
  "results",
  "data"
];

for (
  const key of
  pairContainerKeys
) {

  if (
    !isPlainObject(
      document[
        key
      ]
    )
  ) {

    continue;

  }

  const pairValue =
    findPairProperty(
      document[
        key
      ],
      pairKey
    );

  if (
    pairValue ===
    undefined
  ) {

    continue;

  }

  const nestedRows =
    unwrapRowsContainer(
      pairValue,
      pairKey
    );

  if (
    nestedRows.length >
    0
  ) {

    return nestedRows;

  }

}

return unwrapRowsContainer(
  document,
  pairKey
);

}

// ============================================================================
// Market source document loading
// ============================================================================

function loadMarketSourceDocument(
  filePath,
  sourceName
) {

  if (
    !fs.existsSync(
      filePath
    )
  ) {

    return {
      available:
        false,

      source:
        sourceName,

      filePath,

      document:
        null,

      error:
        `${sourceName} does not exist`
    };

  }

  try {

    const document =
      readJSON(
        filePath,
        {
          required:
            true
        }
      );

    return {
      available:
        true,

      source:
        sourceName,

      filePath,

      document,

      error:
        null
    };

  } catch (
    error
  ) {

    return {
      available:
        false,

      source:
        sourceName,

      filePath,

      document:
        null,

      error:
        error.message
    };

  }

}

function loadMarketDocuments() {

  return {
    scalp:
      loadMarketSourceDocument(
        SCALP_CANDLES_PATH,
        "data/scalp-candles.json"
      ),

    intraday:
      loadMarketSourceDocument(
        INTRADAY_CANDLES_PATH,
        "data/intraday-h1.json"
      ),

    swing:
      loadMarketSourceDocument(
        DAILY_CANDLES_PATH,
        "data/daily-ohlc.json"
      )
  };

}

// ============================================================================
// Normalized market data construction
// ============================================================================

function buildPairMarketSource(
  sourceDocument,
  pairKey,
  options = {}
) {

  const intervalMinutes =
    toFiniteNumber(
      options.intervalMinutes
    );

  const safeNowMs =
    Number.isFinite(
      options.nowMs
    )
      ? options.nowMs
      : Date.now();

  if (
    !sourceDocument ||
    sourceDocument.available !==
      true
  ) {

    return {
      available:
        false,

      source:
        sourceDocument?.source ||
        options.source ||
        null,

      pair:
        pairKey,

      candles:
        [],

      metadata: {
        sourceRowCount:
          0,

        validCandleCount:
          0,

        invalidCandleCount:
          0,

        duplicateCandleCount:
          0,

        explicitlyOpenCandleCount:
          0,

        futureCandleCount:
          0,

        incompleteByTimeCandleCount:
          0,

        intervalMinutes,

        firstCandleTime:
          null,

        latestCandleTime:
          null,

        error:
          sourceDocument?.error ||
          "Market source is unavailable"
      }
    };

  }

  const rawRows =
    extractPairRows(
      sourceDocument.document,
      pairKey
    );

  const normalized =
    normalizeCandles(
      rawRows,
      {
        pairKey,

        source:
          sourceDocument.source,

        closedOnly:
          true,

        intervalMinutes,

        nowMs:
          safeNowMs
      }
    );

  return {
    available:
      normalized.candles.length >
      0,

    source:
      sourceDocument.source,

    pair:
      pairKey,

    candles:
      normalized.candles,

    metadata: {
      ...normalized.metadata,

      error:
        normalized.candles.length >
          0
          ? null
          : `No valid ${pairKey} candles found in ${sourceDocument.source}`
    }
  };

}

function buildMarketDataIndex(
  marketDocuments
) {

  const index =
    {};

  /*
   * Use one fixed clock snapshot for every pair and source in this run.
   * This prevents boundary differences during the same resolver execution.
   */
  const normalizationNowMs =
    Date.now();

  for (
    const pairKey of
      SUPPORTED_PAIRS
  ) {

    index[
      pairKey
    ] = {
      scalp:
        buildPairMarketSource(
          marketDocuments.scalp,
          pairKey,
          {
            intervalMinutes:
              MARKET_SOURCE_INTERVAL_MINUTES
                .scalp,

            nowMs:
              normalizationNowMs
          }
        ),

      intraday:
        buildPairMarketSource(
          marketDocuments.intraday,
          pairKey,
          {
            intervalMinutes:
              MARKET_SOURCE_INTERVAL_MINUTES
                .intraday,

            nowMs:
              normalizationNowMs
          }
        ),

      swing:
        buildPairMarketSource(
          marketDocuments.swing,
          pairKey,
          {
            intervalMinutes:
              MARKET_SOURCE_INTERVAL_MINUTES
                .swing,

            nowMs:
              normalizationNowMs
          }
        )
    };

  }

  return index;

}

// ============================================================================
// Engine source selection
// ============================================================================

function getPrimaryMarketSourceName(
  engine
) {

  const normalizedEngine =
    normalizeEngine(
      engine
    );

  if (
    normalizedEngine ===
      "scalp"
  ) {

    return "scalp";

  }

  if (
    normalizedEngine ===
      "intraday"
  ) {

    return "intraday";

  }

  if (
    normalizedEngine ===
      "swing"
  ) {

    return "swing";

  }

  /*
   * Master is a consensus engine and does not own an independent candle file.
   * Its deterministic source policy is implemented in the resolution section.
   */
  if (
    normalizedEngine ===
      "master"
  ) {

    return "master";

  }

  return null;

}

function getPairMarketData(
  marketDataIndex,
  pairKey,
  sourceName
) {

  if (
    !isPlainObject(
      marketDataIndex
    ) ||
    !isPlainObject(
      marketDataIndex[
        pairKey
      ]
    )
  ) {

    return null;

  }

  const source =
    marketDataIndex[
      pairKey
    ][
      sourceName
    ];

  return isPlainObject(
    source
  )
    ? source
    : null;

}

function getCandlesAfterTimestamp(
  candles,
  openedTimestamp,
  nowMs = Date.now()
) {

  const timestamp =
    toTimestamp(
      openedTimestamp
    );

  const safeNowMs =
    Number.isFinite(
      nowMs
    )
      ? nowMs
      : Date.now();

  if (
    timestamp === null ||
    timestamp >
      safeNowMs
  ) {

    return [];

  }

  return asArray(
    candles
  ).filter(
    (
      candle
    ) => {

      if (
        !isPlainObject(
          candle
        )
      ) {

        return false;

      }

      const candleTimestamp =
        toFiniteNumber(
          candle.timestamp
        );

      const candleCloseTimestamp =
        toFiniteNumber(
          candle.closeTimestamp
        );

      /*
       * Preserve the existing entry-candle exclusion policy.
       * Only candles whose start timestamp is strictly newer than the
       * verified trade-open timestamp may be evaluated.
       */
      if (
        candleTimestamp ===
          null ||
        candleTimestamp <=
          timestamp ||
        candleTimestamp >
          safeNowMs
      ) {

        return false;

      }

      /*
       * Explicitly open candles can never resolve a trade.
       */
      if (
        candle.closed ===
          false
      ) {

        return false;

      }

      /*
       * A normalized resolver candle must have a valid close boundary.
       * The full interval must be completed before its high/low can be used.
       */
      if (
        candleCloseTimestamp ===
          null ||
        candleCloseTimestamp >
          safeNowMs ||
        candleCloseTimestamp <=
          candleTimestamp
      ) {

        return false;

      }

      return true;

    }
  );

}

// ============================================================================
// Deterministic resolution policy
// ============================================================================

const RESOLUTION_POLICY =
  Object.freeze({

    /*
     * A candle contains only OHLC data, not the exact intrabar price path.
     *
     * If Stop Loss and Take Profit are both touched inside the same candle,
     * the resolver cannot prove which price was touched first.
     *
     * Conservative deterministic policy:
     * treat the Stop Loss as having occurred first.
     */
    sameCandleConflict:
      "STOP_FIRST",

    /*
     * The trade is considered won when target1 is reached.
     *
     * target2 and target3 remain available for diagnostic progression, but
     * they do not change the existing WIN / LOSS / BREAKEVEN outcome schema.
     */
    winningTarget:
      1,

    /*
     * The entry candle is excluded. Only candles strictly newer than the
     * signal/open timestamp are evaluated.
     */
    includeEntryCandle:
      false,

    /*
     * Master has no independent candle file. Use the most granular available
     * source first, then fall back deterministically.
     */
    masterSourcePriority: [
      "scalp",
      "intraday",
      "swing"
    ]

  });

// ============================================================================
// Price comparison helpers
// ============================================================================

function approximatelyEqual(
  left,
  right,
  tolerance = 1e-10
) {

  const leftNumber =
    toFiniteNumber(
      left
    );

  const rightNumber =
    toFiniteNumber(
      right
    );

  if (
    leftNumber === null ||
    rightNumber === null
  ) {

    return false;

  }

  return Math.abs(
    leftNumber -
    rightNumber
  ) <= tolerance;

}

function calculateProfitPoints(
  direction,
  entry,
  exitPrice
) {

  const normalizedDirection =
    normalizeDirection(
      direction
    );

  const entryPrice =
    toFiniteNumber(
      entry
    );

  const finalExitPrice =
    toFiniteNumber(
      exitPrice
    );

  if (
    !normalizedDirection ||
    entryPrice === null ||
    finalExitPrice === null
  ) {

    return null;

  }

  if (
    normalizedDirection ===
      "BUY"
  ) {

    return finalExitPrice -
      entryPrice;

  }

  return entryPrice -
    finalExitPrice;

}

function calculateResultPercentage(
  direction,
  entry,
  exitPrice
) {

  const entryPrice =
    toFiniteNumber(
      entry
    );

  const profitPoints =
    calculateProfitPoints(
      direction,
      entry,
      exitPrice
    );

  if (
    entryPrice === null ||
    entryPrice <= 0 ||
    profitPoints === null
  ) {

    return null;

  }

  return (
    profitPoints /
    entryPrice
  ) * 100;

}

function calculateRiskPoints(
  entry,
  stop
) {

  const entryPrice =
    toFiniteNumber(
      entry
    );

  const stopPrice =
    toFiniteNumber(
      stop
    );

  if (
    entryPrice === null ||
    stopPrice === null
  ) {

    return null;

  }

  return Math.abs(
    entryPrice -
    stopPrice
  );

}

function calculateRealizedR(
  direction,
  entry,
  stop,
  exitPrice
) {

  const riskPoints =
    calculateRiskPoints(
      entry,
      stop
    );

  const profitPoints =
    calculateProfitPoints(
      direction,
      entry,
      exitPrice
    );

  if (
    riskPoints === null ||
    riskPoints <= 0 ||
    profitPoints === null
  ) {

    return null;

  }

  return profitPoints /
    riskPoints;

}

// ============================================================================
// Trade-plan validation
// ============================================================================

function validateTradeGeometry(
  direction,
  entry,
  stop,
  targets
) {

  const normalizedDirection =
    normalizeDirection(
      direction
    );

  const entryPrice =
    toFiniteNumber(
      entry
    );

  const stopPrice =
    toFiniteNumber(
      stop
    );

  const targetPrices =
    asArray(
      targets
    )
      .map(
        (
          value
        ) =>
          toFiniteNumber(
            value
          )
      )
      .filter(
        (
          value
        ) =>
          value !== null
      );

  const errors =
    [];

  if (
    !normalizedDirection
  ) {

    errors.push(
      "Direction must be BUY or SELL"
    );

  }

  if (
    entryPrice === null ||
    entryPrice <= 0
  ) {

    errors.push(
      "Entry price is missing or invalid"
    );

  }

  if (
    stopPrice === null ||
    stopPrice <= 0
  ) {

    errors.push(
      "Stop price is missing or invalid"
    );

  }

  if (
    targetPrices.length ===
      0
  ) {

    errors.push(
      "At least one target is required"
    );

  }

  if (
    normalizedDirection ===
      "BUY" &&
    entryPrice !== null &&
    stopPrice !== null
  ) {

    if (
      stopPrice >=
        entryPrice
    ) {

      errors.push(
        "BUY stop must be below entry"
      );

    }

    for (
      const target of
        targetPrices
    ) {

      if (
        target <=
          entryPrice
      ) {

        errors.push(
          "BUY targets must be above entry"
        );

        break;

      }

    }

  }

  if (
    normalizedDirection ===
      "SELL" &&
    entryPrice !== null &&
    stopPrice !== null
  ) {

    if (
      stopPrice <=
        entryPrice
    ) {

      errors.push(
        "SELL stop must be above entry"
      );

    }

    for (
      const target of
        targetPrices
    ) {

      if (
        target >=
          entryPrice
      ) {

        errors.push(
          "SELL targets must be below entry"
        );

        break;

      }

    }

  }

  return {
    valid:
      errors.length ===
      0,

    errors,

    direction:
      normalizedDirection,

    entry:
      entryPrice,

    stop:
      stopPrice,

    targets:
      targetPrices
  };

}

// ============================================================================
// Candle level-touch evaluation
// ============================================================================

function candleTouchesStop(
  direction,
  candle,
  stop
) {

  const normalizedDirection =
    normalizeDirection(
      direction
    );

  const stopPrice =
    toFiniteNumber(
      stop
    );

  if (
    !normalizedDirection ||
    !isPlainObject(
      candle
    ) ||
    stopPrice === null
  ) {

    return false;

  }

  if (
    normalizedDirection ===
      "BUY"
  ) {

    return candle.low <=
      stopPrice;

  }

  return candle.high >=
    stopPrice;

}

function candleTouchesTarget(
  direction,
  candle,
  target
) {

  const normalizedDirection =
    normalizeDirection(
      direction
    );

  const targetPrice =
    toFiniteNumber(
      target
    );

  if (
    !normalizedDirection ||
    !isPlainObject(
      candle
    ) ||
    targetPrice === null
  ) {

    return false;

  }

  if (
    normalizedDirection ===
      "BUY"
  ) {

    return candle.high >=
      targetPrice;

  }

  return candle.low <=
    targetPrice;

}

function getHighestTargetReached(
  direction,
  candle,
  targets
) {

  let highestTargetReached =
    0;

  const targetPrices =
    asArray(
      targets
    );

  for (
    let index =
      0;
    index <
      targetPrices.length;
    index +=
      1
  ) {

    if (
      candleTouchesTarget(
        direction,
        candle,
        targetPrices[
          index
        ]
      )
    ) {

      highestTargetReached =
        index +
        1;

    }

  }

  return highestTargetReached;

}

function evaluateCandleAgainstTrade(
  trade,
  candle
) {

  if (
    !isPlainObject(
      trade
    ) ||
    !isPlainObject(
      candle
    )
  ) {

    return {
      resolved:
        false,

      reason:
        "Trade or candle is invalid"
    };

  }

  const direction =
    trade.direction;

  const entry =
    trade.entry;

  const stop =
    trade.stop;

  const targets =
    trade.targets;

  const winningTargetIndex =
    Math.max(
      0,
      RESOLUTION_POLICY
        .winningTarget -
      1
    );

  const winningTarget =
    targets[
      winningTargetIndex
    ];

  const stopTouched =
    candleTouchesStop(
      direction,
      candle,
      stop
    );

  const targetTouched =
    candleTouchesTarget(
      direction,
      candle,
      winningTarget
    );

  const highestTargetReached =
    getHighestTargetReached(
      direction,
      candle,
      targets
    );

  if (
    stopTouched &&
    targetTouched
  ) {

    return {
      resolved:
        true,

      outcome:
        approximatelyEqual(
          stop,
          entry
        )
          ? "BREAKEVEN"
          : "LOSS",

      exitPrice:
        stop,

      exitReason:
        approximatelyEqual(
          stop,
          entry
        )
          ? "BREAKEVEN_STOP"
          : "STOP_LOSS",

      sameCandleConflict:
        true,

      conflictPolicy:
        RESOLUTION_POLICY
          .sameCandleConflict,

      stopTouched:
        true,

      targetTouched:
        true,

      highestTargetReached,

      resolvingCandle:
        candle
    };

  }

  if (
    stopTouched
  ) {

    return {
      resolved:
        true,

      outcome:
        approximatelyEqual(
          stop,
          entry
        )
          ? "BREAKEVEN"
          : "LOSS",

      exitPrice:
        stop,

      exitReason:
        approximatelyEqual(
          stop,
          entry
        )
          ? "BREAKEVEN_STOP"
          : "STOP_LOSS",

      sameCandleConflict:
        false,

      conflictPolicy:
        null,

      stopTouched:
        true,

      targetTouched:
        false,

      highestTargetReached,

      resolvingCandle:
        candle
    };

  }

  if (
    targetTouched
  ) {

    return {
      resolved:
        true,

      outcome:
        "WIN",

      exitPrice:
        winningTarget,

      exitReason:
        `TARGET_${
          RESOLUTION_POLICY
            .winningTarget
        }`,

      sameCandleConflict:
        false,

      conflictPolicy:
        null,

      stopTouched:
        false,

      targetTouched:
        true,

      highestTargetReached,

      resolvingCandle:
        candle
    };

  }

  return {
    resolved:
      false,

    outcome:
      null,

    exitPrice:
      null,

    exitReason:
      null,

    sameCandleConflict:
      false,

    conflictPolicy:
      null,

    stopTouched:
      false,

    targetTouched:
      false,

    highestTargetReached,

    resolvingCandle:
      null
  };

}

// ============================================================================
// Market excursion tracking
// ============================================================================

function calculateCandleExcursions(
  direction,
  entry,
  candle
) {

  const normalizedDirection =
    normalizeDirection(
      direction
    );

  const entryPrice =
    toFiniteNumber(
      entry
    );

  if (
    !normalizedDirection ||
    entryPrice === null ||
    !isPlainObject(
      candle
    )
  ) {

    return {
      favorablePoints:
        null,

      adversePoints:
        null
    };

  }

  if (
    normalizedDirection ===
      "BUY"
  ) {

    return {
      favorablePoints:
        candle.high -
        entryPrice,

      adversePoints:
        entryPrice -
        candle.low
    };

  }

  return {
    favorablePoints:
      entryPrice -
      candle.low,

    adversePoints:
      candle.high -
      entryPrice
  };

}

function updateTradePathMetrics(
  currentMetrics,
  trade,
  candle
) {

  const metrics =
    isPlainObject(
      currentMetrics
    )
      ? currentMetrics
      : {
          maximumFavorableExcursion:
            0,

          maximumAdverseExcursion:
            0,

          highestPrice:
            null,

          lowestPrice:
            null,

          highestTargetReached:
            0,

          candleCount:
            0
        };

  const excursions =
    calculateCandleExcursions(
      trade.direction,
      trade.entry,
      candle
    );

  const favorable =
    excursions
      .favorablePoints ===
      null
      ? 0
      : Math.max(
          0,
          excursions
            .favorablePoints
        );

  const adverse =
    excursions
      .adversePoints ===
      null
      ? 0
      : Math.max(
          0,
          excursions
            .adversePoints
        );

  return {
    maximumFavorableExcursion:
      Math.max(
        toFiniteNumber(
          metrics
            .maximumFavorableExcursion
        ) ??
        0,
        favorable
      ),

    maximumAdverseExcursion:
      Math.max(
        toFiniteNumber(
          metrics
            .maximumAdverseExcursion
        ) ??
        0,
        adverse
      ),

    highestPrice:
      metrics.highestPrice ===
        null ||
      metrics.highestPrice ===
        undefined
        ? candle.high
        : Math.max(
            metrics.highestPrice,
            candle.high
          ),

    lowestPrice:
      metrics.lowestPrice ===
        null ||
      metrics.lowestPrice ===
        undefined
        ? candle.low
        : Math.min(
            metrics.lowestPrice,
            candle.low
          ),

    highestTargetReached:
      Math.max(
        toFiniteNumber(
          metrics
            .highestTargetReached
        ) ??
        0,
        getHighestTargetReached(
          trade.direction,
          candle,
          trade.targets
        )
      ),

    candleCount:
      (
        toFiniteNumber(
          metrics.candleCount
        ) ??
        0
      ) +
      1
  };

}

// ============================================================================
// Source selection
// ============================================================================

function selectMasterMarketSource(
  marketDataIndex,
  pairKey,
  openedTimestamp
) {

  const attempts =
    [];

  for (
    const sourceName of
      RESOLUTION_POLICY
        .masterSourcePriority
  ) {

    const marketSource =
      getPairMarketData(
        marketDataIndex,
        pairKey,
        sourceName
      );

    if (
      !marketSource ||
      marketSource.available !==
        true
    ) {

      attempts.push({
        source:
          sourceName,

        available:
          false,

        candleCount:
          0
      });

      continue;

    }

    const candles =
      getCandlesAfterTimestamp(
        marketSource.candles,
        openedTimestamp
      );

    attempts.push({
      source:
        sourceName,

      available:
        true,

      candleCount:
        candles.length
    });

    if (
      candles.length >
        0
    ) {

      return {
        selected:
          marketSource,

        sourceName,

        candles,

        attempts
      };

    }

  }

  return {
    selected:
      null,

    sourceName:
      null,

    candles:
      [],

    attempts
  };

}

function selectResolutionMarketSource(
  marketDataIndex,
  pairKey,
  engine,
  openedTimestamp
) {

  const normalizedEngine =
    normalizeEngine(
      engine
    );

  if (
    normalizedEngine ===
      "master"
  ) {

    return selectMasterMarketSource(
      marketDataIndex,
      pairKey,
      openedTimestamp
    );

  }

  const sourceName =
    getPrimaryMarketSourceName(
      normalizedEngine
    );

  if (!sourceName) {

    return {
      selected:
        null,

      sourceName:
        null,

      candles:
        [],

      attempts: [
        {
          source:
            null,

          available:
            false,

          candleCount:
            0,

          reason:
            "Unsupported engine"
        }
      ]
    };

  }

  const marketSource =
    getPairMarketData(
      marketDataIndex,
      pairKey,
      sourceName
    );

  if (
    !marketSource ||
    marketSource.available !==
      true
  ) {

    return {
      selected:
        marketSource,

      sourceName,

      candles:
        [],

      attempts: [
        {
          source:
            sourceName,

          available:
            false,

          candleCount:
            0,

          reason:
            marketSource?.metadata
              ?.error ||
            "Market source unavailable"
        }
      ]
    };

  }

  const candles =
    getCandlesAfterTimestamp(
      marketSource.candles,
      openedTimestamp
    );

  return {
    selected:
      marketSource,

    sourceName,

    candles,

    attempts: [
      {
        source:
          sourceName,

        available:
          true,

        candleCount:
          candles.length
      }
    ]
  };

}

// ============================================================================
// Record evaluation preparation
// ============================================================================

function prepareRecordForResolution(
  record
) {

  if (
    !isPlainObject(
      record
    )
  ) {

    return {
      valid:
        false,

      errors: [
        "History record is invalid"
      ],

      trade:
        null
    };

  }

  const pairKey =
    getRecordPairKey(
      record
    );

  const direction =
    getRecordDirection(
      record
    );

  const engine =
    getRecordEngine(
      record
    );

  const entry =
    getRecordEntry(
      record
    );

  const stop =
    getRecordStop(
      record
    );

  const targets =
    getRecordTargets(
      record
    );

  const openedTimestamp =
    getRecordOpenedTimestamp(
      record
    );

  const geometry =
    validateTradeGeometry(
      direction,
      entry,
      stop,
      targets
    );

  const errors = [
    ...geometry.errors
  ];

  errors.push(
    ...validateRecordTimestampSafety(
      record,
      openedTimestamp
    )
  );

  if (!pairKey) {

    errors.push(
      "Pair is missing or unsupported"
    );

  }

  if (!engine) {

    errors.push(
      "Engine is missing or unsupported"
    );

  }

  if (
    openedTimestamp ===
      null
  ) {

    errors.push(
      "Open timestamp is missing or invalid"
    );

  }

  if (
    isRecordAlreadyResolved(
      record
    )
  ) {

    errors.push(
      "Record is already resolved"
    );

  }

  if (
    normalizeStatus(
      record.status,
      record.outcome
    ) ===
      "hold"
  ) {

    errors.push(
      "HOLD records cannot be resolved"
    );

  }

  return {
    valid:
      errors.length ===
      0,

    errors,

    trade: {
      pairKey,

      pairLabel:
        pairLabelFromKey(
          pairKey
        ),

      direction:
        geometry.direction,

      engine,

      entry:
        geometry.entry,

      stop:
        geometry.stop,

      targets:
        geometry.targets,

      openedTimestamp,

      openedAt:
        openedTimestamp ===
          null
          ? null
          : new Date(
              openedTimestamp
            ).toISOString(),

      record
    }
  };

}

// ============================================================================
// Complete trade evaluation
// ============================================================================

function evaluatePreparedTrade(
  preparedTrade,
  marketDataIndex
) {

  if (
    !isPlainObject(
      preparedTrade
    )
  ) {

    return {
      resolved:
        false,

      eligible:
        false,

      reason:
        "Prepared trade is invalid"
    };

  }

  const sourceSelection =
    selectResolutionMarketSource(
      marketDataIndex,
      preparedTrade.pairKey,
      preparedTrade.engine,
      preparedTrade.openedTimestamp
    );

  if (
    !sourceSelection.selected ||
    sourceSelection.candles.length ===
      0
  ) {

    return {
      resolved:
        false,

      eligible:
        true,

      reason:
        "No newer valid candles are available",

      sourceSelection,

      pathMetrics:
        null
    };

  }

  let pathMetrics =
    null;

  for (
    const candle of
      sourceSelection.candles
  ) {

    pathMetrics =
      updateTradePathMetrics(
        pathMetrics,
        preparedTrade,
        candle
      );

    const candleResult =
      evaluateCandleAgainstTrade(
        preparedTrade,
        candle
      );

    if (
      candleResult.resolved !==
        true
    ) {

      continue;

    }

    const resolvedAt =
      candle.time;

    const exitPrice =
      candleResult.exitPrice;

    const profitPoints =
      calculateProfitPoints(
        preparedTrade.direction,
        preparedTrade.entry,
        exitPrice
      );

    const resultPercentage =
      calculateResultPercentage(
        preparedTrade.direction,
        preparedTrade.entry,
        exitPrice
      );

    const realizedR =
      calculateRealizedR(
        preparedTrade.direction,
        preparedTrade.entry,
        preparedTrade.stop,
        exitPrice
      );

    const durationMinutes =
      Math.max(
        0,
        (
          candle.timestamp -
          preparedTrade.openedTimestamp
        ) /
        60000
      );

    const initialRisk =
      calculateRiskPoints(
        preparedTrade.entry,
        preparedTrade.stop
      );

    return {
      resolved:
        true,

      eligible:
        true,

      outcome:
        candleResult.outcome,

      exitPrice,

      exitReason:
        candleResult.exitReason,

      resolvedAt,

      closedAt:
        resolvedAt,

      profitPoints,

      resultPercentage,

      realizedR,

      initialRisk,

      durationMinutes,

      highestTargetReached:
        Math.max(
          pathMetrics
            ?.highestTargetReached ??
          0,
          candleResult
            .highestTargetReached ??
          0
        ),

      sameCandleConflict:
        candleResult
          .sameCandleConflict ===
        true,

      conflictPolicy:
        candleResult
          .conflictPolicy,

      resolvingCandle: {
        timestamp:
          candle.timestamp,

        time:
          candle.time,

        open:
          candle.open,

        high:
          candle.high,

        low:
          candle.low,

        close:
          candle.close
      },

      marketSource:
        sourceSelection.selected
          .source,

      marketSourceName:
        sourceSelection.sourceName,

      sourceSelection:
        sourceSelection.attempts,

      pathMetrics: {
        ...pathMetrics,

        initialRisk,

        maximumFavorableR:
          initialRisk !==
            null &&
          initialRisk >
            0
            ? (
                pathMetrics
                  .maximumFavorableExcursion /
                initialRisk
              )
            : null,

        maximumAdverseR:
          initialRisk !==
            null &&
          initialRisk >
            0
            ? (
                pathMetrics
                  .maximumAdverseExcursion /
                initialRisk
              )
            : null
      }
    };

  }

  return {
    resolved:
      false,

    eligible:
      true,

    reason:
      "Stop Loss and target1 have not been reached",

    marketSource:
      sourceSelection.selected
        .source,

    marketSourceName:
      sourceSelection.sourceName,

    sourceSelection:
      sourceSelection.attempts,

    evaluatedCandleCount:
      sourceSelection.candles
        .length,

    latestEvaluatedCandle:
      sourceSelection.candles[
        sourceSelection.candles
          .length -
        1
      ]?.time ||
      null,

    pathMetrics
  };

}

function evaluateHistoryRecord(
  record,
  marketDataIndex
) {

  const preparation =
    prepareRecordForResolution(
      record
    );

  if (
    preparation.valid !==
      true
  ) {

    return {
      resolved:
        false,

      eligible:
        false,

      reason:
        preparation.errors.join(
          "; "
        ),

      errors:
        preparation.errors,

      trade:
        preparation.trade
    };

  }

  return {
    ...evaluatePreparedTrade(
      preparation.trade,
      marketDataIndex
    ),

    trade:
      preparation.trade
  };

}

// ============================================================================
// Stable identity helpers
// ============================================================================

function normalizeIdentityNumber(
  value
) {

  const number =
    toFiniteNumber(
      value
    );

  if (
    number === null
  ) {

    return "";

  }

  return Number(
    number.toFixed(
      10
    )
  ).toString();

}

function getRecordFingerprint(
  record
) {

  if (
    !isPlainObject(
      record
    )
  ) {

    return null;

  }

  const existingFingerprint =
    toTrimmedString(
      record.fingerprint
    );

  if (
    existingFingerprint
  ) {

    return existingFingerprint;

  }

  const pairKey =
    getRecordPairKey(
      record
    ) ||
    "";

  const engine =
    getRecordEngine(
      record
    ) ||
    "";

  const direction =
    getRecordDirection(
      record
    ) ||
    "";

  const entry =
    normalizeIdentityNumber(
      getRecordEntry(
        record
      )
    );

  const stop =
    normalizeIdentityNumber(
      getRecordStop(
        record
      )
    );

  const targets =
    getRecordTargets(
      record
    );

  const firstTarget =
    normalizeIdentityNumber(
      targets[0]
    );

  if (
    !pairKey ||
    !engine ||
    !direction ||
    !entry
  ) {

    return null;

  }

  return [
    pairKey,
    engine,
    direction,
    entry,
    stop,
    firstTarget
  ].join(
    "|"
  );

}

function buildRecordMatchKey(
  record
) {

  if (
    !isPlainObject(
      record
    )
  ) {

    return null;

  }

  const pairKey =
    getRecordPairKey(
      record
    );

  const engine =
    getRecordEngine(
      record
    );

  const direction =
    getRecordDirection(
      record
    );

  const entry =
    getRecordEntry(
      record
    );

  const openedTimestamp =
    getRecordOpenedTimestamp(
      record
    );

  if (
    !pairKey ||
    !engine ||
    !direction ||
    entry === null ||
    openedTimestamp === null
  ) {

    return null;

  }

  return [
    pairKey,
    engine,
    direction,
    normalizeIdentityNumber(
      entry
    ),
    new Date(
      openedTimestamp
    ).toISOString()
  ].join(
    "|"
  );

}

function recordsReferToSameTrade(
  left,
  right
) {

  if (
    !isPlainObject(
      left
    ) ||
    !isPlainObject(
      right
    )
  ) {

    return false;

  }

  const leftId =
    toTrimmedString(
      left.id
    );

  const rightId =
    toTrimmedString(
      right.id
    );

  if (
    leftId &&
    rightId &&
    leftId ===
      rightId
  ) {

    return true;

  }

  const leftFingerprint =
    getRecordFingerprint(
      left
    );

  const rightFingerprint =
    getRecordFingerprint(
      right
    );

  if (
    leftFingerprint &&
    rightFingerprint &&
    leftFingerprint ===
      rightFingerprint
  ) {

    return true;

  }

  const leftMatchKey =
    buildRecordMatchKey(
      left
    );

  const rightMatchKey =
    buildRecordMatchKey(
      right
    );

  return Boolean(
    leftMatchKey &&
    rightMatchKey &&
    leftMatchKey ===
      rightMatchKey
  );

}

// ============================================================================
// Resolution value normalization
// ============================================================================

function roundMetric(
  value,
  decimals = 10
) {

  const number =
    toFiniteNumber(
      value
    );

  if (
    number === null
  ) {

    return null;

  }

  return Number(
    number.toFixed(
      decimals
    )
  );

}

function getResolutionExitPrice(
  resolution
) {

  return toFiniteNumber(
    resolution?.exitPrice
  );

}

function getResolutionClosedAt(
  resolution
) {

  return (
    toISOStringOrNull(
      resolution?.closedAt
    ) ||
    toISOStringOrNull(
      resolution?.resolvedAt
    )
  );

}

// ============================================================================
// Rich history record update
// ============================================================================

function applyResolutionToRichRecord(
  record,
  resolution
) {

  if (
    !isPlainObject(
      record
    )
  ) {

    throw new Error(
      "Cannot resolve an invalid history record"
    );

  }

  if (
    !isPlainObject(
      resolution
    ) ||
    resolution.resolved !==
      true
  ) {

    throw new Error(
      "Cannot apply an unresolved result"
    );

  }

  const outcome =
    normalizeOutcome(
      resolution.outcome
    );

  const closedAt =
    getResolutionClosedAt(
      resolution
    );

  const exitPrice =
    getResolutionExitPrice(
      resolution
    );

  if (
    !outcome ||
    !closedAt ||
    exitPrice === null
  ) {

    throw new Error(
      "Resolution is missing outcome, closed time or exit price"
    );

  }

  const existingResolvedAt =
    toISOStringOrNull(
      record.resolvedAt ??
      record.closedAt
    );

  /*
   * Idempotency:
   * An already resolved record is returned unchanged.
   */
  if (
    getRecordOutcome(
      record
    ) &&
    existingResolvedAt
  ) {

    return record;

  }

  const updatedRecord = {
    ...record,

    status:
      "closed",

    outcome,

    result:
      outcome,

    resolvedAt:
      closedAt,

    closedAt,

    updatedAt:
      closedAt,

    exitPrice,

    exit:
      exitPrice,

    exitReason:
      toTrimmedString(
        resolution.exitReason
      ) ||
      null,

    profitPoints:
      roundMetric(
        resolution.profitPoints
      ),

    resultPercentage:
      roundMetric(
        resolution.resultPercentage
      ),

    realizedR:
      roundMetric(
        resolution.realizedR
      ),

    durationMinutes:
      roundMetric(
        resolution.durationMinutes,
        2
      ),

    highestTargetReached:
      toFiniteNumber(
        resolution
          .highestTargetReached
      ) ??
      0
  };

  /*
   * Preserve established optional evaluation fields only when values exist.
   * No missing metadata is invented.
   */
  if (
    toFiniteNumber(
      resolution.initialRisk
    ) !==
      null
  ) {

    updatedRecord.initialRisk =
      roundMetric(
        resolution.initialRisk
      );

  }

  if (
    resolution.pathMetrics &&
    toFiniteNumber(
      resolution.pathMetrics
        .maximumFavorableExcursion
    ) !==
      null
  ) {

    updatedRecord.mfe =
      roundMetric(
        resolution.pathMetrics
          .maximumFavorableExcursion
      );

  }

  if (
    resolution.pathMetrics &&
    toFiniteNumber(
      resolution.pathMetrics
        .maximumAdverseExcursion
    ) !==
      null
  ) {

    updatedRecord.mae =
      roundMetric(
        resolution.pathMetrics
          .maximumAdverseExcursion
      );

  }

  if (
    resolution.pathMetrics &&
    toFiniteNumber(
      resolution.pathMetrics
        .maximumFavorableR
    ) !==
      null
  ) {

    updatedRecord.mfeR =
      roundMetric(
        resolution.pathMetrics
          .maximumFavorableR
      );

  }

  if (
    resolution.pathMetrics &&
    toFiniteNumber(
      resolution.pathMetrics
        .maximumAdverseR
    ) !==
      null
  ) {

    updatedRecord.maeR =
      roundMetric(
        resolution.pathMetrics
          .maximumAdverseR
      );

  }

  return updatedRecord;

}

// ============================================================================
// Legacy closed-trade construction
// ============================================================================

function mapEngineToLegacyStrategy(
  engine
) {

  const normalizedEngine =
    normalizeEngine(
      engine
    );

  if (
    normalizedEngine ===
      "scalp"
  ) {

    return "scalp";

  }

  if (
    normalizedEngine ===
      "intraday"
  ) {

    return "daily";

  }

  if (
    normalizedEngine ===
      "swing"
  ) {

    return "weekly";

  }

  /*
   * The existing learner has no independent Master strategy.
   * Preserve the engine name but do not invent a false strategy mapping.
   */
  return null;

}

function mapEngineToLegacyTimeframe(
  engine
) {

  const normalizedEngine =
    normalizeEngine(
      engine
    );

  if (
    normalizedEngine ===
      "scalp"
  ) {

    return "5m";

  }

  if (
    normalizedEngine ===
      "intraday"
  ) {

    return "1H";

  }

  if (
    normalizedEngine ===
      "swing"
  ) {

    return "D1";

  }

  return null;

}

function createLegacyClosedTrade(
  richRecord,
  resolution
) {

  if (
    !isPlainObject(
      richRecord
    ) ||
    !isPlainObject(
      resolution
    ) ||
    resolution.resolved !==
      true
  ) {

    return null;

  }

  const pairKey =
    getRecordPairKey(
      richRecord
    );

  const pairLabel =
    pairLabelFromKey(
      pairKey
    );

  const engine =
    getRecordEngine(
      richRecord
    );

  const direction =
    getRecordDirection(
      richRecord
    );

  const entry =
    getRecordEntry(
      richRecord
    );

  const stop =
    getRecordStop(
      richRecord
    );

  const targets =
    getRecordTargets(
      richRecord
    );

  const openedTimestamp =
    getRecordOpenedTimestamp(
      richRecord
    );

  const closedAt =
    getResolutionClosedAt(
      resolution
    );

  const exitPrice =
    getResolutionExitPrice(
      resolution
    );

  const outcome =
    normalizeOutcome(
      resolution.outcome
    );

  if (
    !pairKey ||
    !pairLabel ||
    !engine ||
    !direction ||
    entry === null ||
    stop === null ||
    targets.length ===
      0 ||
    openedTimestamp ===
      null ||
    !closedAt ||
    exitPrice ===
      null ||
    !outcome
  ) {

    return null;

  }

  const openedAt =
    new Date(
      openedTimestamp
    ).toISOString();

  const strategy =
    mapEngineToLegacyStrategy(
      engine
    );

  const timeframe =
    mapEngineToLegacyTimeframe(
      engine
    );

  const legacyTrade = {
    id:
      richRecord.id ||
      null,

    fingerprint:
      getRecordFingerprint(
        richRecord
      ),

    pair:
      pairLabel,

    symbol:
      pairLabel,

    engine,

    engineName:
      engine,

    mode:
      engine,

    direction,

    decision:
      direction,

    signal:
      direction,

    entry,

    entryPrice:
      entry,

    stop,

    stopLoss:
      stop,

    sl:
      stop,

    target:
      targets[0],

    target1:
      targets[0],

    takeProfit:
      targets[0],

    takeProfit1:
      targets[0],

    tp1:
      targets[0],

    outcome,

    result:
      outcome,

    status:
      "closed",

    openedAt,

    signalTime:
      openedAt,

    createdAt:
      toISOStringOrNull(
        richRecord.createdAt
      ) ||
      openedAt,

    closedAt,

    resolvedAt:
      closedAt,

    updatedAt:
      closedAt,

    exitPrice,

    exit:
      exitPrice,

    exitReason:
      toTrimmedString(
        resolution.exitReason
      ) ||
      null,

    profitPoints:
      roundMetric(
        resolution.profitPoints
      ),

    resultPercentage:
      roundMetric(
        resolution.resultPercentage
      ),

    realizedR:
      roundMetric(
        resolution.realizedR
      ),

    durationMinutes:
      roundMetric(
        resolution.durationMinutes,
        2
      ),

    highestTargetReached:
      toFiniteNumber(
        resolution
          .highestTargetReached
      ) ??
      0,

    confidence:
      toFiniteNumber(
        richRecord.confidence
      ),

    originalConfidence:
      toFiniteNumber(
        richRecord
          .originalConfidence
      ),

    aiMemoryAdjustedConfidence:
      toFiniteNumber(
        richRecord
          .aiMemoryAdjustedConfidence
      ),

    appliedConfidenceAdjustment:
      toFiniteNumber(
        richRecord
          .appliedConfidenceAdjustment
      ),

    aiMemoryApplied:
      richRecord
        .aiMemoryApplied ===
      true
  };

  if (
    targets[1] !==
      undefined
  ) {

    legacyTrade.target2 =
      targets[1];

    legacyTrade.takeProfit2 =
      targets[1];

    legacyTrade.tp2 =
      targets[1];

  }

  if (
    targets[2] !==
      undefined
  ) {

    legacyTrade.target3 =
      targets[2];

    legacyTrade.takeProfit3 =
      targets[2];

    legacyTrade.tp3 =
      targets[2];

  }

  if (strategy) {

    legacyTrade.strategy =
      strategy;

  }

  if (timeframe) {

    legacyTrade.timeframe =
      timeframe;

  }

  const optionalStringFields = [
    "pattern",
    "session",
    "marketRegime",
    "marketState",
    "qualityGrade",
    "source",
    "reason"
  ];

  for (
    const field of
      optionalStringFields
  ) {

    const value =
      toTrimmedString(
        richRecord[
          field
        ] ??
        richRecord.snapshot?.[
          field
        ]
      );

    if (value) {

      legacyTrade[
        field
      ] = value;

    }

  }

  const optionalNumberFields = [
    "score",
    "aiScore",
    "adaptiveConfidence",
    "patternWeight",
    "riskReward",
    "rr"
  ];

  for (
    const field of
      optionalNumberFields
  ) {

    const value =
      toFiniteNumber(
        richRecord[
          field
        ] ??
        richRecord.snapshot?.[
          field
        ]
      );

    if (
      value !==
        null
    ) {

      legacyTrade[
        field
      ] = value;

    }

  }

  if (
    richRecord.aiMemory !==
      undefined
  ) {

    legacyTrade.aiMemory =
      cloneJSONValue(
        richRecord.aiMemory
      );

  }

  return legacyTrade;

}

// ============================================================================
// Legacy closed collection duplicate protection
// ============================================================================

function closedCollectionContainsTrade(
  closedTrades,
  candidate
) {

  if (
    !isPlainObject(
      candidate
    )
  ) {

    return false;

  }

  return asArray(
    closedTrades
  ).some(
    (
      existing
    ) =>
      recordsReferToSameTrade(
        existing,
        candidate
      )
  );

}

function appendLegacyClosedTrade(
  closedTrades,
  candidate
) {

  const normalizedClosed =
    asArray(
      closedTrades
    );

  if (
    !isPlainObject(
      candidate
    ) ||
    closedCollectionContainsTrade(
      normalizedClosed,
      candidate
    )
  ) {

    return {
      closed:
        normalizedClosed,

      appended:
        false
    };

  }

  return {
    closed: [
      ...normalizedClosed,
      candidate
    ],

    appended:
      true
  };

}

// ============================================================================
// Legacy open collection traversal
// ============================================================================

function valueContainsMatchingTrade(
  value,
  targetRecord
) {

  if (
    isPlainObject(
      value
    ) &&
    recordsReferToSameTrade(
      value,
      targetRecord
    )
  ) {

    return true;

  }

  if (
    Array.isArray(
      value
    )
  ) {

    return value.some(
      (
        item
      ) =>
        valueContainsMatchingTrade(
          item,
          targetRecord
        )
    );

  }

  if (
    isPlainObject(
      value
    )
  ) {

    return Object.values(
      value
    ).some(
      (
        item
      ) =>
        valueContainsMatchingTrade(
          item,
          targetRecord
        )
    );

  }

  return false;

}

function removeTradeFromOpenValue(
  value,
  targetRecord
) {

  if (
    Array.isArray(
      value
    )
  ) {

    const updatedArray =
      [];

    let removedCount =
      0;

    for (
      const item of
        value
    ) {

      if (
        isPlainObject(
          item
        ) &&
        recordsReferToSameTrade(
          item,
          targetRecord
        )
      ) {

        removedCount +=
          1;

        continue;

      }

      const nested =
        removeTradeFromOpenValue(
          item,
          targetRecord
        );

      removedCount +=
        nested.removedCount;

      if (
        nested.removeValue !==
          true
      ) {

        updatedArray.push(
          nested.value
        );

      }

    }

    return {
      value:
        updatedArray,

      removedCount,

      removeValue:
        false
    };

  }

  if (
    !isPlainObject(
      value
    )
  ) {

    return {
      value,

      removedCount:
        0,

      removeValue:
        false
    };

  }

  if (
    recordsReferToSameTrade(
      value,
      targetRecord
    )
  ) {

    return {
      value:
        null,

      removedCount:
        1,

      removeValue:
        true
    };

  }

  const updatedObject =
    {};

  let removedCount =
    0;

  for (
    const [
      key,
      childValue
    ] of Object.entries(
      value
    )
  ) {

    const nested =
      removeTradeFromOpenValue(
        childValue,
        targetRecord
      );

    removedCount +=
      nested.removedCount;

    if (
      nested.removeValue ===
        true
    ) {

      continue;

    }

    updatedObject[
      key
    ] = nested.value;

  }

  return {
    value:
      updatedObject,

    removedCount,

    removeValue:
      false
  };

}

function removeLegacyOpenTrade(
  openCollection,
  targetRecord
) {

  const normalizedOpen =
    isPlainObject(
      openCollection
    )
      ? openCollection
      : {};

  if (
    !valueContainsMatchingTrade(
      normalizedOpen,
      targetRecord
    )
  ) {

    return {
      open:
        normalizedOpen,

      removedCount:
        0
    };

  }

  const removal =
    removeTradeFromOpenValue(
      normalizedOpen,
      targetRecord
    );

  return {
    open:
      isPlainObject(
        removal.value
      )
        ? removal.value
        : {},

    removedCount:
      removal.removedCount
  };

}

// ============================================================================
// Rich records collection update
// ============================================================================

function replaceRichHistoryRecord(
  records,
  originalRecord,
  resolvedRecord
) {

  const sourceRecords =
    asArray(
      records
    );

  let replaced =
    false;

  const updatedRecords =
    sourceRecords.map(
      (
        record
      ) => {

        if (
          !replaced &&
          (
            record ===
              originalRecord ||
            recordsReferToSameTrade(
              record,
              originalRecord
            )
          )
        ) {

          replaced =
            true;

          return resolvedRecord;

        }

        return record;

      }
    );

  return {
    records:
      updatedRecords,

    replaced
  };

}

// ============================================================================
// Legacy open integrity and statistics
// ============================================================================

function deriveLegacyOpenContext(
  context,
  key
) {
  const nextContext = {
    ...(
      isPlainObject(context)
        ? context
        : {}
    )
  };

  const tokens =
    toTrimmedString(key)
      .split(/[:|]/)
      .map(token => token.trim())
      .filter(Boolean);

  for (const token of tokens) {
    const pairKey =
      normalizePairKey(token);

    if (pairKey) {
      nextContext.pairKey =
        pairKey;
    }

    const engine =
      normalizeEngine(token);

    if (engine) {
      nextContext.engine =
        engine;

      nextContext.engineAlias =
        token;
    }

    const timeframeMetadata =
      getRecordTimeframeMetadata({
        engine: token,
        mode: token
      });

    if (timeframeMetadata.timeframe) {
      nextContext.timeframe =
        timeframeMetadata.timeframe;

      nextContext.timeframeSource =
        "legacy-open-key";
    }
  }

  return nextContext;
}

function looksLikeLegacyOpenTrade(
  value
) {
  if (!isPlainObject(value)) {
    return false;
  }

  const tradeFields = [
    "direction",
    "decision",
    "signal",
    "action",
    "entry",
    "entryPrice",
    "stop",
    "stopLoss",
    "sl",
    "target",
    "target1",
    "takeProfit",
    "tp",
    "openedAt",
    "signalTime",
    "signalTimestamp"
  ];

  return tradeFields.some(
    field =>
      Object.prototype.hasOwnProperty.call(
        value,
        field
      )
  );
}

function applyLegacyOpenContext(
  value,
  context
) {
  const record = {
    ...value
  };

  if (
    !getRecordPairKey(record) &&
    context?.pairKey
  ) {
    record.pair =
      context.pairKey;
  }

  if (
    !getRecordEngine(record) &&
    context?.engine
  ) {
    record.engine =
      context.engineAlias ||
      context.engine;
  }

  if (
    !getRecordTimeframe(record) &&
    context?.timeframe
  ) {
    record.sourceTimeframe =
      context.timeframe;

    record.timeframeSource =
      context.timeframeSource ||
      "legacy-open-key";
  }

  return record;
}

function buildLegacyOpenDescriptor(
  value,
  context,
  pathParts,
  richRecords
) {
  const record =
    applyLegacyOpenContext(
      value,
      context
    );

  const pairKey =
    getRecordPairKey(record);

  const engine =
    getRecordEngine(record);

  const direction =
    getRecordDirection(record);

  const entry =
    getRecordEntry(record);

  const stop =
    getRecordStop(record);

  const targets =
    getRecordTargets(record);

  const openedTimestamp =
    getRecordOpenedTimestamp(record);

  const errors = [];

  if (!pairKey) {
    errors.push(
      "Pair is missing or unsupported"
    );
  }

  if (!engine) {
    errors.push(
      "Engine is missing or unsupported"
    );
  }

  if (!direction) {
    errors.push(
      "Direction is missing or unsupported"
    );
  }

  if (entry === null) {
    errors.push(
      "Entry price is missing or invalid"
    );
  }

  if (stop === null) {
    errors.push(
      "Stop price is missing or invalid"
    );
  }

  if (targets.length === 0) {
    errors.push(
      "Target is missing or invalid"
    );
  }

  if (openedTimestamp === null) {
    errors.push(
      "Open timestamp is missing or invalid"
    );
  }

  const geometry =
    validateTradeGeometry(
      direction,
      entry,
      stop,
      targets
    );

  for (const error of geometry.errors) {
    if (!errors.includes(error)) {
      errors.push(error);
    }
  }

  const matchingRichRecord =
    asArray(richRecords).find(
      candidate =>
        recordsReferToSameTrade(
          candidate,
          record
        )
    ) ||
    null;

  let classification;

  if (errors.length > 0) {
    classification =
      "malformed";
  } else if (!matchingRichRecord) {
    classification =
      "orphan";
  } else if (
    isRecordAlreadyResolved(
      matchingRichRecord
    )
  ) {
    classification =
      "matched-resolved";
  } else {
    classification =
      "matched-open";
  }

  return {
    path:
      pathParts.join("."),

    record,

    pairKey,
    engine,

    timeframe:
      getRecordTimeframe(record),

    timeframeSource:
      toTrimmedString(
        record.timeframeSource
      ) ||
      getRecordTimeframeMetadata(
        record
      ).source,

    openedAt:
      openedTimestamp === null
        ? null
        : new Date(
            openedTimestamp
          ).toISOString(),

    setupIdentity:
      buildStableSetupIdentity(
        record
      ),

    classification,
    errors,
    matchingRichRecord
  };
}

function collectLegacyOpenTradeDescriptors(
  openCollection,
  richRecords = []
) {
  const descriptors = [];

  function visit(
    value,
    context,
    pathParts
  ) {
    if (Array.isArray(value)) {
      value.forEach(
        (item, index) =>
          visit(
            item,
            context,
            [
              ...pathParts,
              String(index)
            ]
          )
      );

      return;
    }

    if (!isPlainObject(value)) {
      return;
    }

    if (looksLikeLegacyOpenTrade(value)) {
      descriptors.push(
        buildLegacyOpenDescriptor(
          value,
          context,
          pathParts,
          richRecords
        )
      );

      return;
    }

    for (
      const [
        key,
        childValue
      ] of Object.entries(value)
    ) {
      visit(
        childValue,
        deriveLegacyOpenContext(
          context,
          key
        ),
        [
          ...pathParts,
          key
        ]
      );
    }
  }

  visit(
    isPlainObject(openCollection)
      ? openCollection
      : {},
    {},
    []
  );

  return descriptors;
}

function countOpenTradesInValue(
  value
) {
  return collectLegacyOpenTradeDescriptors(
    value
  ).length;
}

function buildOpenTradeInventory(
  history
) {
  const richRecords =
    asArray(
      history?.records
    );

  const richOpenRecords =
    richRecords.filter(
      record =>
        isRecordOpenCandidate(record)
    );

  const legacyDescriptors =
    collectLegacyOpenTradeDescriptors(
      history?.open,
      richRecords
    );

  const uniqueOpenRecords = [
    ...richOpenRecords
  ];

  for (const descriptor of legacyDescriptors) {
    /*
     * A legacy entry matching an already resolved rich record is stale
     * legacy state, not a genuinely open position.
     */
    if (
      descriptor.classification ===
      "matched-resolved"
    ) {
      continue;
    }

    const alreadyIncluded =
      uniqueOpenRecords.some(
        record =>
          recordsReferToSameTrade(
            record,
            descriptor.record
          )
      );

    if (!alreadyIncluded) {
      uniqueOpenRecords.push(
        descriptor.record
      );
    }
  }

  return {
    richOpenRecords,
    legacyDescriptors,
    uniqueOpenRecords,

    richOpenCount:
      richOpenRecords.length,

    legacyOpenCount:
      legacyDescriptors.length,

    legacyMatchedOpenCount:
      legacyDescriptors.filter(
        descriptor =>
          descriptor.classification ===
          "matched-open"
      ).length,

    legacyMatchedResolvedCount:
      legacyDescriptors.filter(
        descriptor =>
          descriptor.classification ===
          "matched-resolved"
      ).length,

    legacyOrphanCount:
      legacyDescriptors.filter(
        descriptor =>
          descriptor.classification ===
          "orphan"
      ).length,

    legacyMalformedCount:
      legacyDescriptors.filter(
        descriptor =>
          descriptor.classification ===
          "malformed"
      ).length,

    uniqueOpenCount:
      uniqueOpenRecords.length
  };
}

function buildClosedStatistics(
  closedTrades,
  openCount
) {
  const wins =
    closedTrades.filter(
      trade =>
        getRecordOutcome(trade) ===
        "WIN"
    ).length;

  const losses =
    closedTrades.filter(
      trade =>
        getRecordOutcome(trade) ===
        "LOSS"
    ).length;

  const breakevens =
    closedTrades.filter(
      trade =>
        getRecordOutcome(trade) ===
        "BREAKEVEN"
    ).length;

  const decisiveTrades =
    wins +
    losses;

  return {
    totalClosed:
      closedTrades.length,

    wins,
    losses,
    breakevens,

    winRate:
      decisiveTrades > 0
        ? Number(
            (
              wins /
              decisiveTrades *
              100
            ).toFixed(2)
          )
        : 0,

    openCount
  };
}

function buildEngineStatistics(
  history,
  engine,
  openInventory = null
) {
  const normalizedEngine =
    normalizeEngine(engine);

  const inventory =
    openInventory ||
    buildOpenTradeInventory(
      history
    );

  const closedTrades =
    asArray(
      history.closed
    ).filter(
      trade =>
        getRecordEngine(trade) ===
          normalizedEngine &&
        getRecordOutcome(trade)
    );

  const openCount =
    inventory.uniqueOpenRecords.filter(
      record =>
        getRecordEngine(record) ===
          normalizedEngine &&
        !isRecordAlreadyResolved(record)
    ).length;

  return buildClosedStatistics(
    closedTrades,
    openCount
  );
}

function buildOverallStatistics(
  history,
  openInventory = null
) {
  const inventory =
    openInventory ||
    buildOpenTradeInventory(
      history
    );

  const closedTrades =
    asArray(
      history.closed
    ).filter(
      trade =>
        getRecordOutcome(trade)
    );

  return buildClosedStatistics(
    closedTrades,
    inventory.uniqueOpenCount
  );
}

function rebuildStatisticsContainer(
  history,
  sourceStatistics,
  openInventory
) {
  const statistics = {
    ...sourceStatistics
  };

  if (
    isPlainObject(
      statistics.overall
    )
  ) {
    statistics.overall = {
      ...statistics.overall,
      ...buildOverallStatistics(
        history,
        openInventory
      )
    };
  }

  const engines = [
    "scalp",
    "intraday",
    "swing",
    "master"
  ];

  for (const engine of engines) {
    /*
     * Update only sections that already exist.
     */
    if (
      !isPlainObject(
        statistics[engine]
      )
    ) {
      continue;
    }

    statistics[engine] = {
      ...statistics[engine],
      ...buildEngineStatistics(
        history,
        engine,
        openInventory
      )
    };
  }

  return statistics;
}

function rebuildExistingStatistics(
  history
) {
  const openInventory =
    buildOpenTradeInventory(
      history
    );

  let updatedHistory =
    history;

  /*
   * Production data uses `stats`; older compatibility data may use
   * `statistics`. Update whichever roots already exist.
   */
  if (
    isPlainObject(
      history.stats
    )
  ) {
    updatedHistory = {
      ...updatedHistory,

      stats:
        rebuildStatisticsContainer(
          history,
          history.stats,
          openInventory
        )
    };
  }

  if (
    isPlainObject(
      history.statistics
    )
  ) {
    updatedHistory = {
      ...updatedHistory,

      statistics:
        rebuildStatisticsContainer(
          history,
          history.statistics,
          openInventory
        )
    };
  }

  return updatedHistory;
}

function statisticsContainersChanged(
  beforeHistory,
  afterHistory
) {
  const before = {
    stats:
      isPlainObject(
        beforeHistory?.stats
      )
        ? beforeHistory.stats
        : null,

    statistics:
      isPlainObject(
        beforeHistory?.statistics
      )
        ? beforeHistory.statistics
        : null
  };

  const after = {
    stats:
      isPlainObject(
        afterHistory?.stats
      )
        ? afterHistory.stats
        : null,

    statistics:
      isPlainObject(
        afterHistory?.statistics
      )
        ? afterHistory.statistics
        : null
  };

  return (
    JSON.stringify(before) !==
    JSON.stringify(after)
  );
}

function summarizeLegacyOpenIntegrity(
  inventory
) {
  return {
    total:
      inventory.legacyOpenCount,

    matchedOpen:
      inventory.legacyMatchedOpenCount,

    matchedResolved:
      inventory.legacyMatchedResolvedCount,

    orphan:
      inventory.legacyOrphanCount,

    malformed:
      inventory.legacyMalformedCount,

    uniqueOpenTrades:
      inventory.uniqueOpenCount,

    entries:
      inventory.legacyDescriptors.map(
        descriptor => ({
          path:
            descriptor.path ||
            null,

          pair:
            descriptor.pairKey,

          engine:
            descriptor.engine,

          timeframe:
            descriptor.timeframe,

          timeframeSource:
            descriptor.timeframeSource ||
            null,

          openedAt:
            descriptor.openedAt,

          setupIdentity:
            descriptor.setupIdentity,

          classification:
            descriptor.classification,

          errors: [
            ...descriptor.errors
          ]
        })
      )
  };
}

// ============================================================================
// Single-resolution history mutation
// ============================================================================

function applyResolvedTradeToHistory(
  rawHistory,
  originalRecord,
  resolution
) {

  const history =
    normalizeAnalysisHistory(
      rawHistory
    );

  if (
    !isPlainObject(
      originalRecord
    ) ||
    !isPlainObject(
      resolution
    ) ||
    resolution.resolved !==
      true
  ) {

    return {
      history,

      changed:
        false,

      richRecordUpdated:
        false,

      legacyOpenRemoved:
        0,

      legacyClosedAppended:
        false,

      resolvedRecord:
        null,

      closedTrade:
        null
    };

  }

  if (
    isRecordAlreadyResolved(
      originalRecord
    )
  ) {

    return {
      history,

      changed:
        false,

      richRecordUpdated:
        false,

      legacyOpenRemoved:
        0,

      legacyClosedAppended:
        false,

      resolvedRecord:
        originalRecord,

      closedTrade:
        null
    };

  }

  const resolvedRecord =
    applyResolutionToRichRecord(
      originalRecord,
      resolution
    );

  const richReplacement =
    replaceRichHistoryRecord(
      history.records,
      originalRecord,
      resolvedRecord
    );

  if (
    !richReplacement.replaced
  ) {

    return {
      history,

      changed:
        false,

      richRecordUpdated:
        false,

      legacyOpenRemoved:
        0,

      legacyClosedAppended:
        false,

      resolvedRecord:
        null,

      closedTrade:
        null
    };

  }

  const openRemoval =
    removeLegacyOpenTrade(
      history.open,
      originalRecord
    );

  const closedTrade =
    createLegacyClosedTrade(
      resolvedRecord,
      resolution
    );

  const closedAppend =
    appendLegacyClosedTrade(
      history.closed,
      closedTrade
    );

  const now =
    new Date().toISOString();

  let updatedHistory = {
    ...history,

    updatedAt:
      now,

    open:
      openRemoval.open,

    closed:
      closedAppend.closed,

    records:
      richReplacement.records,

    history:
      richReplacement.records,

    items:
      richReplacement.records
  };

  updatedHistory =
    rebuildExistingStatistics(
      updatedHistory
    );

  return {
    history:
      updatedHistory,

    changed:
      true,

    richRecordUpdated:
      true,

    legacyOpenRemoved:
      openRemoval.removedCount,

    legacyClosedAppended:
      closedAppend.appended,

    resolvedRecord,

    closedTrade
  };

}

// ============================================================================
// Full history resolution pass
// ============================================================================

function resolveAnalysisHistory(
  rawHistory,
  marketDataIndex
) {

  let workingHistory =
    normalizeAnalysisHistory(
      rawHistory
    );

  const originalRecords = [
    ...workingHistory.records
  ];
  const initialOpenInventory =
    buildOpenTradeInventory(
      workingHistory
    );
  const results =
    [];

  let candidateCount =
    0;

  let resolvedCount =
    0;

  let unresolvedCount =
    0;

  let ineligibleCount =
    0;

  let legacyOpenRemovedCount =
    0;

  let legacyClosedAppendedCount =
    0;

  for (
    let index =
      0;
    index <
      originalRecords.length;
    index +=
      1
  ) {

    const originalRecord =
      originalRecords[
        index
      ];

    if (
      !isRecordOpenCandidate(
        originalRecord
      )
    ) {

      continue;

    }

    candidateCount +=
      1;

    const evaluation =
      evaluateHistoryRecord(
        originalRecord,
        marketDataIndex
      );

    if (
      evaluation.eligible !==
        true
    ) {

      ineligibleCount +=
        1;

      results.push({
        index,

        id:
          originalRecord.id ||
          null,

        fingerprint:
          getRecordFingerprint(
            originalRecord
          ),

        pair:
          getRecordPairKey(
            originalRecord
          ),

        engine:
          getRecordEngine(
            originalRecord
          ),

        resolved:
          false,

        eligible:
          false,

        reason:
          evaluation.reason ||
          "Record is not eligible"
      });

      continue;

    }

    if (
      evaluation.resolved !==
        true
    ) {

      unresolvedCount +=
        1;

      results.push({
        index,

        id:
          originalRecord.id ||
          null,

        fingerprint:
          getRecordFingerprint(
            originalRecord
          ),

        pair:
          getRecordPairKey(
            originalRecord
          ),

        engine:
          getRecordEngine(
            originalRecord
          ),

        resolved:
          false,

        eligible:
          true,

        reason:
          evaluation.reason ||
          "Trade remains open",

        latestEvaluatedCandle:
          evaluation
            .latestEvaluatedCandle ||
          null
      });

      continue;

    }

    const mutation =
      applyResolvedTradeToHistory(
        workingHistory,
        originalRecord,
        evaluation
      );

    if (
      mutation.changed !==
        true
    ) {

      results.push({
        index,

        id:
          originalRecord.id ||
          null,

        fingerprint:
          getRecordFingerprint(
            originalRecord
          ),

        pair:
          getRecordPairKey(
            originalRecord
          ),

        engine:
          getRecordEngine(
            originalRecord
          ),

        resolved:
          false,

        eligible:
          true,

        reason:
          "Resolution was detected but history mutation was not applied"
      });

      continue;

    }

    workingHistory =
      mutation.history;

    resolvedCount +=
      1;

    legacyOpenRemovedCount +=
      mutation
        .legacyOpenRemoved;

    if (
      mutation
        .legacyClosedAppended
    ) {

      legacyClosedAppendedCount +=
        1;

    }

    results.push({
      index,

      id:
        originalRecord.id ||
        null,

      fingerprint:
        getRecordFingerprint(
          originalRecord
        ),

      pair:
        getRecordPairKey(
          originalRecord
        ),

      engine:
        getRecordEngine(
          originalRecord
        ),

      direction:
        getRecordDirection(
          originalRecord
        ),

      resolved:
        true,

      eligible:
        true,

      outcome:
        evaluation.outcome,

      exitPrice:
        evaluation.exitPrice,

      exitReason:
        evaluation.exitReason,

      resolvedAt:
        evaluation.resolvedAt,

      marketSource:
        evaluation.marketSource,

      sameCandleConflict:
        evaluation
          .sameCandleConflict ===
        true,

      legacyOpenRemoved:
        mutation
          .legacyOpenRemoved,

      legacyClosedAppended:
        mutation
          .legacyClosedAppended
    });

  }

  /*
   * Ensure aliases remain synchronized even when no trades resolve.
   */
  workingHistory = {
    ...workingHistory,

    records:
      asArray(
        workingHistory.records
      ),

    history:
      asArray(
        workingHistory.records
      ),

    items:
      asArray(
        workingHistory.records
      )
  };

  const historyBeforeStatistics =
    workingHistory;

  const historyWithStatistics =
    rebuildExistingStatistics(
      workingHistory
    );

  const statisticsChanged =
    statisticsContainersChanged(
      historyBeforeStatistics,
      historyWithStatistics
    );

  workingHistory =
    statisticsChanged
      ? {
          ...historyWithStatistics,
          updatedAt:
            new Date().toISOString()
        }
      : historyWithStatistics;

  const finalOpenInventory =
    buildOpenTradeInventory(
      workingHistory
    );

  const legacyOpenIntegrity =
    summarizeLegacyOpenIntegrity(
      finalOpenInventory
    );

  return {
    history:
      workingHistory,

    changed:
      resolvedCount > 0 ||
      statisticsChanged,

    summary: {
      totalRichRecords:
        workingHistory.records
          .length,

      candidateCount,

      resolvedCount,

      unresolvedCount,

      ineligibleCount,

      legacyOpenRemovedCount,

      legacyClosedAppendedCount,

      initialLegacyOpenCount:
        initialOpenInventory
          .legacyOpenCount,

      finalLegacyOpenCount:
        finalOpenInventory
          .legacyOpenCount,

      legacyMatchedOpenCount:
        finalOpenInventory
          .legacyMatchedOpenCount,

      legacyMatchedResolvedCount:
        finalOpenInventory
          .legacyMatchedResolvedCount,

      legacyOrphanCount:
        finalOpenInventory
          .legacyOrphanCount,

      legacyMalformedCount:
        finalOpenInventory
          .legacyMalformedCount,

      uniqueOpenTradeCount:
        finalOpenInventory
          .uniqueOpenCount,

      statisticsChanged,

      finalLegacyClosedCount:
        workingHistory.closed
          .length
    },

    legacyOpenIntegrity,

    results
  };

}

// ============================================================================
// Run logging
// ============================================================================

function logResolverHeader() {

  console.log(
    ""
  );

  console.log(
    "============================================================"
  );

  console.log(
    ENGINE_NAME
  );

  console.log(
    `Version: ${ENGINE_VERSION}`
  );

  console.log(
    `Started: ${new Date().toISOString()}`
  );

  console.log(
    "============================================================"
  );

  console.log(
    ""
  );

}

function logMarketDataSummary(
  marketDocuments,
  marketDataIndex
) {

  console.log(
    "[trade-resolver] Market data sources"
  );

  const documents =
    isPlainObject(
      marketDocuments
    )
      ? marketDocuments
      : {};

  for (
    const [
      sourceName,
      document
    ] of Object.entries(
      documents
    )
  ) {

    const available =
      document?.available ===
      true;

    const sourcePath =
      document?.path ||
      document?.source ||
      "unknown";

    console.log(
      `  ${sourceName}: ${
        available
          ? "available"
          : "unavailable"
      } (${sourcePath})`
    );

    if (
      document?.error
    ) {

      console.warn(
        `    Reason: ${document.error}`
      );

    }

  }

  const pairKeys = [
    "XAUUSD",
    "GBPJPY"
  ];

  for (
    const pairKey of
      pairKeys
  ) {

    console.log(
      `  ${pairKey}:`
    );

    for (
      const sourceName of [
        "scalp",
        "intraday",
        "swing"
      ]
    ) {

      const source =
        getPairMarketData(
          marketDataIndex,
          pairKey,
          sourceName
        );

      const candleCount =
        Array.isArray(
          source?.candles
        )
          ? source.candles.length
          : 0;

      console.log(
        `    ${sourceName}: ${candleCount} valid candles`
      );

    }

  }

  console.log(
    ""
  );

}

function logResolutionResult(
  result
) {

  if (
    !isPlainObject(
      result
    )
  ) {

    return;

  }

  const identity = [
    result.pair ||
      "unknown-pair",
    result.engine ||
      "unknown-engine",
    result.direction ||
      ""
  ]
    .filter(
      Boolean
    )
    .join(
      " / "
    );

  if (
    result.resolved ===
      true
  ) {

    console.log(
      `[trade-resolver] RESOLVED ${identity}: ${result.outcome}`
    );

    console.log(
      `  Exit: ${result.exitPrice}`
    );

    console.log(
      `  Reason: ${result.exitReason}`
    );

    console.log(
      `  Resolved at: ${result.resolvedAt}`
    );

    console.log(
      `  Market source: ${result.marketSource || "unknown"}`
    );

    if (
      result.sameCandleConflict ===
        true
    ) {

      console.warn(
        "  Same-candle TP/SL conflict resolved using STOP_FIRST policy."
      );

    }

    return;

  }

  if (
    result.eligible ===
      false
  ) {

    console.warn(
      `[trade-resolver] INELIGIBLE ${identity}: ${result.reason}`
    );

    return;

  }

  console.log(
    `[trade-resolver] OPEN ${identity}: ${result.reason}`
  );

}

function logLegacyOpenIntegrity(
  integrity
) {
  if (!isPlainObject(integrity)) {
    return;
  }
  console.log("");
  console.log(
    "[trade-resolver] Legacy open integrity"
  );
  console.log(
    `  Total legacy open entries: ${integrity.total ?? 0}`
  );
  console.log(
    `  Matched rich open: ${integrity.matchedOpen ?? 0}`
  );
  console.log(
    `  Matched resolved rich: ${integrity.matchedResolved ?? 0}`
  );
  console.log(
    `  Orphan legacy open: ${integrity.orphan ?? 0}`
  );
  console.log(
    `  Malformed legacy open: ${integrity.malformed ?? 0}`
  );
  for (
    const entry of
      asArray(integrity.entries)
  ) {
    if (
      entry.classification !==
        "orphan" &&
      entry.classification !==
        "malformed" &&
      entry.classification !==
        "matched-resolved"
    ) {
      continue;
    }
    const identity = [
      entry.pair ||
        "unknown-pair",
      entry.engine ||
        "unknown-engine",
      entry.timeframe ||
        "unknown-timeframe"
    ].join(" / ");
    console.warn(
      `  ${String(
        entry.classification
      ).toUpperCase()} ` +
      `${entry.path || "unknown-path"}: ` +
      identity
    );
    if (
      Array.isArray(entry.errors) &&
      entry.errors.length > 0
    ) {
      console.warn(
        `    ${entry.errors.join("; ")}`
      );
    }
  }
}

function logRunSummary(
  summary,
  options = {}
) {

  const changed =
    options.changed ===
    true;

  const written =
    options.written ===
    true;

  console.log(
    ""
  );

  console.log(
    "[trade-resolver] Run summary"
  );

  console.log(
    `  History records: ${summary.totalRichRecords}`
  );

  console.log(
    `  Open candidates: ${summary.candidateCount}`
  );

  console.log(
    `  Resolved now: ${summary.resolvedCount}`
  );

  console.log(
    `  Still open: ${summary.unresolvedCount}`
  );

  console.log(
    `  Ineligible: ${summary.ineligibleCount}`
  );

  console.log(
    `  Legacy open removed: ${summary.legacyOpenRemovedCount}`
  );

  console.log(
    `  Legacy closed appended: ${summary.legacyClosedAppendedCount}`
  );

  console.log(
    `  Final legacy open: ${summary.finalLegacyOpenCount}`
  );

  console.log(
    `  Orphan legacy open: ${summary.legacyOrphanCount}`
  );

  console.log(
    `  Malformed legacy open: ${summary.legacyMalformedCount}`
  );

  console.log(
    `  Unique open trades: ${summary.uniqueOpenTradeCount}`
  );

  console.log(
    `  Statistics refreshed: ${
      summary.statisticsChanged
        ? "YES"
        : "NO"
    }`
  );

  console.log(
    `  Final legacy closed: ${summary.finalLegacyClosedCount}`
  );

  console.log(
    `  History changed: ${changed ? "YES" : "NO"}`
  );

  console.log(
    `  History written: ${written ? "YES" : "NO"}`
  );

  console.log(
    ""
  );

  console.log(
    `Completed: ${new Date().toISOString()}`
  );

  console.log(
    "============================================================"
  );

  console.log(
    ""
  );

}

// ============================================================================
// Final history validation
// ============================================================================

function validateResolvedHistory(
  history
) {

  const errors =
    [];

  if (
    !isPlainObject(
      history
    )
  ) {

    return {
      valid:
        false,

      errors: [
        "Resolved history must be an object"
      ]
    };

  }

  if (
    !Array.isArray(
      history.records
    )
  ) {

    errors.push(
      "history.records must be an array"
    );

  }

  if (
    !Array.isArray(
      history.history
    )
  ) {

    errors.push(
      "history.history must be an array"
    );

  }

  if (
    !Array.isArray(
      history.items
    )
  ) {

    errors.push(
      "history.items must be an array"
    );

  }

  if (
    !Array.isArray(
      history.closed
    )
  ) {

    errors.push(
      "history.closed must be an array"
    );

  }

  if (
    !isPlainObject(
      history.open
    )
  ) {

    errors.push(
      "history.open must be an object"
    );

  }

  if (
    Array.isArray(
      history.records
    ) &&
    Array.isArray(
      history.history
    ) &&
    history.records.length !==
      history.history.length
  ) {

    errors.push(
      "records and history aliases are not synchronized"
    );

  }

  if (
    Array.isArray(
      history.records
    ) &&
    Array.isArray(
      history.items
    ) &&
    history.records.length !==
      history.items.length
  ) {

    errors.push(
      "records and items aliases are not synchronized"
    );

  }

  const records =
    Array.isArray(
      history.records
    )
      ? history.records
      : [];

  for (
    let index =
      0;
    index <
      records.length;
    index +=
      1
  ) {

    const record =
      records[
        index
      ];

    if (
      !isPlainObject(
        record
      )
    ) {

      errors.push(
        `records[${index}] is not an object`
      );

      continue;

    }

    const outcome =
      getRecordOutcome(
        record
      );

    if (!outcome) {

      continue;

    }

    const status =
      normalizeStatus(
        record.status,
        outcome
      );

    const resolvedAt =
      toISOStringOrNull(
        record.resolvedAt ??
        record.closedAt
      );

    if (
      status !==
        "closed"
    ) {

      errors.push(
        `records[${index}] has an outcome but is not closed`
      );

    }

    if (!resolvedAt) {

      errors.push(
        `records[${index}] has an outcome but no resolvedAt/closedAt`
      );

    }

  }

  return {
    valid:
      errors.length ===
      0,

    errors
  };

}

// ============================================================================
// Safe persistence
// ============================================================================

function saveResolvedHistory(
  history
) {

  const validation =
    validateResolvedHistory(
      history
    );

  if (
    validation.valid !==
      true
  ) {

    throw new Error(
      [
        "Resolved history validation failed",
        ...validation.errors
      ].join(
        "; "
      )
    );

  }

  atomicWriteJSON(
    ANALYSIS_HISTORY_PATH,
    history
  );

  return {
    path:
      ANALYSIS_HISTORY_PATH,

    recordCount:
      history.records.length,

    closedCount:
      history.closed.length,

    updatedAt:
      history.updatedAt ||
      null
  };

}

// ============================================================================
// Resolver orchestration
// ============================================================================

function runTradeResolution() {

  logResolverHeader();

  const loadedHistory =
    loadAnalysisHistory();

  console.log(
    `[trade-resolver] Loaded ${loadedHistory.records.length} rich history records.`
  );

  console.log(
    `[trade-resolver] Loaded ${loadedHistory.closed.length} legacy closed trades.`
  );

  const loadedOpenInventory =
    buildOpenTradeInventory(
      loadedHistory
    );

  console.log(
    `[trade-resolver] Current legacy open count: ${
      loadedOpenInventory
        .legacyOpenCount
    }`
  );

  console.log(
    ""
  );

  const marketDocuments =
    loadMarketDocuments();

  const marketDataIndex =
    buildMarketDataIndex(
      marketDocuments
    );

  logMarketDataSummary(
    marketDocuments,
    marketDataIndex
  );

  const resolutionRun =
  resolveAnalysisHistory(
    loadedHistory,
    marketDataIndex
  );

  for (
    const result of
      resolutionRun.results
  ) {

    logResolutionResult(
      result
    );

  }

  logLegacyOpenIntegrity(
    resolutionRun
      .legacyOpenIntegrity
  );

  let persistence =
    null;

  if (
    resolutionRun.changed ===
      true
  ) {

    persistence =
      saveResolvedHistory(
        resolutionRun.history
      );

    console.log(
      ""
    );

    console.log(
      `[trade-resolver] Updated history written atomically to ${persistence.path}.`
    );

  } else {

    console.log(
      ""
    );

    console.log(
      "[trade-resolver] No trades resolved; analysis-history.json was not rewritten."
    );

  }

  logRunSummary(
    resolutionRun.summary,
    {
      changed:
        resolutionRun.changed,

      written:
        Boolean(
          persistence
        )
    }
  );

  return {
    success:
      true,

    changed:
      resolutionRun.changed,

    written:
      Boolean(
        persistence
      ),

    output:
      persistence,

    summary:
      resolutionRun.summary,

    legacyOpenIntegrity:
      resolutionRun
        .legacyOpenIntegrity,

    results:
      resolutionRun.results
  };

}

// ============================================================================
// Command-line execution
// ============================================================================

function main() {

  try {

    const result =
      runTradeResolution();

    if (
      result.success !==
        true
    ) {

      process.exitCode =
        1;

    }

    return result;

  } catch (
    error
  ) {

    console.error(
      ""
    );

    console.error(
      "============================================================"
    );

    console.error(
      "[trade-resolver] FATAL ERROR"
    );

    console.error(
      error instanceof Error
        ? error.stack ||
          error.message
        : String(
            error
          )
    );

    console.error(
      "============================================================"
    );

    console.error(
      ""
    );

    process.exitCode =
      1;

    return {
      success:
        false,

      changed:
        false,

      written:
        false,

      error:
        error instanceof Error
          ? error.message
          : String(
              error
            )
    };

  }

}

if (
  require.main ===
    module
) {

  main();

}

// ============================================================================
// Public exports
// ============================================================================

module.exports = {
  ENGINE_NAME,
  ENGINE_VERSION,
  RESOLUTION_POLICY,

  loadAnalysisHistory,
  loadMarketDocuments,
  buildMarketDataIndex,

  normalizeCandle,
  normalizeCandles,

  validateTradeGeometry,
  candleTouchesStop,
  candleTouchesTarget,
  getHighestTargetReached,
  evaluateCandleAgainstTrade,

  prepareRecordForResolution,
  evaluatePreparedTrade,
  evaluateHistoryRecord,

  applyResolutionToRichRecord,
  createLegacyClosedTrade,
  applyResolvedTradeToHistory,
  resolveAnalysisHistory,

  validateResolvedHistory,
  saveResolvedHistory,
  runTradeResolution,
  main
};
