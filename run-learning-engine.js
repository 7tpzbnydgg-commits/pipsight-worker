// run-learning-engine.js
//
// PipSight Pro — Automatic Learning Engine Runner.
//
// Purpose:
// - Read verified resolved trades from data/analysis-history.json.
// - Convert historical outcomes into learner.js-compatible payloads.
// - Prevent duplicate learning across repeated GitHub Actions runs.
// - Reuse PipSightLearner public APIs instead of duplicating learning logic.
// - Preserve all existing signal, analysis, Telegram and history behavior.
//
// Reads:
//   data/analysis-history.json
//   data/learning-engine-state.json
//   data/learning-data.json
//   data/confidence-data.json
//
// Writes:
//   data/learning-engine-state.json
//   data/learning-data.json
//   data/confidence-data.json
//
// Compatibility:
// - CommonJS / Node.js 20.
// - Existing learner.js API retained.
// - Existing analysis-history.json schema retained.
// - Existing strategy and signal engines are not modified.
// - Open trades are never treated as completed learning outcomes.
// - Only verified WIN, LOSS and BREAKEVEN records are learned.

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const {
  PipSightLearner
} = require("./learner.js");

// -----------------------------------------------------------------------------
// Engine metadata
// -----------------------------------------------------------------------------

const ENGINE_NAME =
  "PipSight Pro Automatic Learning Engine";

const ENGINE_VERSION =
  "1.0.0";

const STATE_VERSION =
  1;

// -----------------------------------------------------------------------------
// Paths
// -----------------------------------------------------------------------------

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

const LEARNING_DATA_PATH =
  path.join(
    DATA_DIR,
    "learning-data.json"
  );

const CONFIDENCE_DATA_PATH =
  path.join(
    DATA_DIR,
    "confidence-data.json"
  );

const LEARNING_STATE_PATH =
  path.join(
    DATA_DIR,
    "learning-engine-state.json"
  );

// -----------------------------------------------------------------------------
// Supported values
// -----------------------------------------------------------------------------

const SUPPORTED_PAIRS =
  new Set([
    "XAUUSD",
    "GBPJPY"
  ]);

const SUPPORTED_STRATEGIES =
  new Set([
    "scalp",
    "daily",
    "weekly"
  ]);

const SUPPORTED_TIMEFRAMES =
  new Set([
    "5m",
    "15m",
    "30m",
    "1H",
    "4H",
    "D1"
  ]);

const SUPPORTED_DIRECTIONS =
  new Set([
    "BUY",
    "SELL"
  ]);

const SUPPORTED_OUTCOMES =
  new Set([
    "WIN",
    "LOSS",
    "BREAKEVEN"
  ]);

// -----------------------------------------------------------------------------
// Generic utilities
// -----------------------------------------------------------------------------

function isPlainObject(
  value
) {

  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(
      value
    )
  );

}

function toFiniteNumber(
  value
) {

  if (
    value === null ||
    value === undefined ||
    (
      typeof value === "string" &&
      value.trim() === ""
    )
  ) {

    return null;

  }

  const number =
    Number(
      value
    );

  if (
    !Number.isFinite(
      number
    )
  ) {

    return null;

  }

  return number;

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

function toISOStringOrNull(
  value
) {

  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {

    return null;

  }

  const date =
    new Date(
      value
    );

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {

    return null;

  }

  return date.toISOString();

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
      recursive: true
    }
  );

}

// -----------------------------------------------------------------------------
// JSON I/O
// -----------------------------------------------------------------------------

function readJSON(
  filePath,
  fallbackValue = null
) {

  try {

    if (
      !fs.existsSync(
        filePath
      )
    ) {

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

      return fallbackValue;

    }

    return JSON.parse(
      raw
    );

  } catch (
    error
  ) {

    console.warn(
      `[learning-engine] Unable to read JSON: ${path.relative(
        ROOT_DIR,
        filePath
      )}`
    );

    console.warn(
      `[learning-engine] ${error.message}`
    );

    return fallbackValue;

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

  const serialized =
    `${JSON.stringify(
      value,
      null,
      2
    )}\n`;

  fs.writeFileSync(
    temporaryPath,
    serialized,
    "utf8"
  );

  fs.renameSync(
    temporaryPath,
    filePath
  );

}

// -----------------------------------------------------------------------------
// Pair normalization
// -----------------------------------------------------------------------------

function normalizePair(
  value
) {

  const compact =
    toTrimmedString(
      value
    )
      .toUpperCase()
      .replace(
        /[^A-Z0-9]/g,
        ""
      );

  if (
    compact === "XAUUSD" ||
    compact === "GOLD"
  ) {

    return "XAUUSD";

  }

  if (
    compact === "GBPJPY"
  ) {

    return "GBPJPY";

  }

  return compact || null;

}

// -----------------------------------------------------------------------------
// Direction normalization
// -----------------------------------------------------------------------------

function normalizeDirection(
  value
) {

  const direction =
    toTrimmedString(
      value
    ).toUpperCase();

  if (
    direction === "LONG"
  ) {

    return "BUY";

  }

  if (
    direction === "SHORT"
  ) {

    return "SELL";

  }

  if (
    SUPPORTED_DIRECTIONS.has(
      direction
    )
  ) {

    return direction;

  }

  return null;

}

// -----------------------------------------------------------------------------
// Outcome normalization
// -----------------------------------------------------------------------------

function normalizeOutcome(
  value
) {

  const outcome =
    toTrimmedString(
      value
    )
      .toUpperCase()
      .replace(
        /[\s-]+/g,
        "_"
      );

  if (
    outcome === "WIN" ||
    outcome === "WON" ||
    outcome === "PROFIT" ||
    outcome === "TP" ||
    outcome === "TAKE_PROFIT"
  ) {

    return "WIN";

  }

  if (
    outcome === "LOSS" ||
    outcome === "LOST" ||
    outcome === "SL" ||
    outcome === "STOP" ||
    outcome === "STOP_LOSS"
  ) {

    return "LOSS";

  }

  if (
    outcome === "BREAKEVEN" ||
    outcome === "BREAK_EVEN" ||
    outcome === "BE" ||
    outcome === "DRAW"
  ) {

    return "BREAKEVEN";

  }

  return null;

}

// -----------------------------------------------------------------------------
// Strategy and timeframe normalization
// -----------------------------------------------------------------------------

function normalizeEngineName(
  value
) {

  return toTrimmedString(
    value
  )
    .toLowerCase()
    .replace(
      /_/g,
      "-"
    )
    .replace(
      /\s+/g,
      "-"
    );

}

function normalizeTimeframe(
  value
) {

  const raw =
    toTrimmedString(
      value
    );

  if (
    !raw
  ) {

    return null;

  }

  const compact =
    raw
      .replace(
        /\s+/g,
        ""
      )
      .toLowerCase();

  const aliases = {
    "5m": "5m",
    "m5": "5m",
    "5min": "5m",
    "5mins": "5m",
    "5minute": "5m",
    "5minutes": "5m",

    "15m": "15m",
    "m15": "15m",
    "15min": "15m",
    "15mins": "15m",
    "15minute": "15m",
    "15minutes": "15m",

    "30m": "30m",
    "m30": "30m",
    "30min": "30m",
    "30mins": "30m",
    "30minute": "30m",
    "30minutes": "30m",

    "1h": "1H",
    "h1": "1H",
    "60m": "1H",
    "60min": "1H",
    "hourly": "1H",

    "4h": "4H",
    "h4": "4H",
    "240m": "4H",
    "240min": "4H",

    "d1": "D1",
    "1d": "D1",
    "daily": "D1",
    "day": "D1"
  };

  return aliases[
    compact
  ] || null;

}

function inferStrategyAndTimeframe(
  record
) {

  const engine =
    normalizeEngineName(
      record?.engine ??
      record?.engineName ??
      record?.mode ??
      record?.strategy
    );

  const explicitTimeframe =
    normalizeTimeframe(
      record?.timeframe ??
      record?.interval ??
      record?.period
    );

  let strategy =
    null;

  let timeframe =
    explicitTimeframe;

  if (
    engine === "scalp" ||
    engine.startsWith(
      "scalp-"
    )
  ) {

    strategy =
      "scalp";

    if (
      !timeframe
    ) {

      const suffix =
        engine
          .slice(
            "scalp".length
          )
          .replace(
            /^-/,
            ""
          );

      timeframe =
        normalizeTimeframe(
          suffix
        ) || "15m";

    }

  } else if (
    engine === "intraday" ||
    engine === "daily"
  ) {

    strategy =
      "daily";

    timeframe =
      timeframe || "1H";

  } else if (
    engine === "swing" ||
    engine === "weekly"
  ) {

    strategy =
      "weekly";

    timeframe =
      timeframe || "D1";

  }

  if (
    strategy &&
    !SUPPORTED_STRATEGIES.has(
      strategy
    )
  ) {

    strategy =
      null;

  }

  if (
    timeframe &&
    !SUPPORTED_TIMEFRAMES.has(
      timeframe
    )
  ) {

    timeframe =
      null;

  }

  return {
    engine:
      engine || null,

    strategy,

    timeframe
  };

}

// -----------------------------------------------------------------------------
// Trade identity and idempotency
// -----------------------------------------------------------------------------

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

function buildTradeIdentitySource(
  trade
) {

  return [
    normalizePair(
      trade?.pair ??
      trade?.symbol
    ) || "",

    normalizeEngineName(
      trade?.engine ??
      trade?.engineName ??
      trade?.mode ??
      trade?.strategy
    ),

    normalizeDirection(
      trade?.direction ??
      trade?.decision ??
      trade?.signal ??
      trade?.action
    ) || "",

    normalizeIdentityNumber(
      trade?.entry ??
      trade?.entryPrice
    ),

    normalizeIdentityNumber(
      trade?.stop ??
      trade?.stopLoss ??
      trade?.sl
    ),

    normalizeIdentityNumber(
      trade?.target ??
      trade?.target1 ??
      trade?.takeProfit ??
      trade?.takeProfit1 ??
      trade?.tp1
    ),

    normalizeOutcome(
      trade?.outcome ??
      trade?.result
    ) || "",

    toISOStringOrNull(
      trade?.openedAt ??
      trade?.signalTime ??
      trade?.createdAt
    ) || "",

    toISOStringOrNull(
      trade?.closedAt ??
      trade?.resolvedAt ??
      trade?.updatedAt
    ) || ""

  ].join(
    "|"
  );

}

function createTradeKey(
  trade
) {

  const identitySource =
    buildTradeIdentitySource(
      trade
    );

  return crypto
    .createHash(
      "sha256"
    )
    .update(
      identitySource
    )
    .digest(
      "hex"
    );

}

// -----------------------------------------------------------------------------
// State management
// -----------------------------------------------------------------------------

function createEmptyState() {

  const now =
    new Date().toISOString();

  return {
    version:
      STATE_VERSION,

    engineName:
      ENGINE_NAME,

    engineVersion:
      ENGINE_VERSION,

    createdAt:
      now,

    updatedAt:
      now,

    lastRunAt:
      null,

    lastSuccessfulRunAt:
      null,

    lastHistoryUpdatedAt:
      null,

    processedTradeKeys:
      [],

    totals: {
      runs:
        0,

      successfulRuns:
        0,

      failedRuns:
        0,

      historyRecordsSeen:
        0,

      acceptedRecords:
        0,

      learnedRecords:
        0,

      duplicateRecords:
        0,

      skippedRecords:
        0,

      invalidRecords:
        0
    },

    lastRun: {
      startedAt:
        null,

      completedAt:
        null,

      success:
        null,

      historyRecordsSeen:
        0,

      acceptedRecords:
        0,

      learnedRecords:
        0,

      duplicateRecords:
        0,

      skippedRecords:
        0,

      invalidRecords:
        0,

      errors:
        []
    }
  };

}

function normalizeState(
  value
) {

  const fallback =
    createEmptyState();

  if (
    !isPlainObject(
      value
    )
  ) {

    return fallback;

  }

  const totals =
    isPlainObject(
      value.totals
    )
      ? value.totals
      : {};

  const lastRun =
    isPlainObject(
      value.lastRun
    )
      ? value.lastRun
      : {};

  const processedTradeKeys =
    Array.isArray(
      value.processedTradeKeys
    )
      ? [
          ...new Set(
            value.processedTradeKeys
              .map(
                item =>
                  toTrimmedString(
                    item
                  )
              )
              .filter(
                Boolean
              )
          )
        ]
      : [];

  return {
    ...fallback,
    ...value,

    version:
      STATE_VERSION,

    engineName:
      ENGINE_NAME,

    engineVersion:
      ENGINE_VERSION,

    processedTradeKeys,

    totals: {
      ...fallback.totals,
      ...totals
    },

    lastRun: {
      ...fallback.lastRun,
      ...lastRun,

      errors:
        Array.isArray(
          lastRun.errors
        )
          ? lastRun.errors
          : []
    }
  };

}

function loadLearningState() {

  return normalizeState(
    readJSON(
      LEARNING_STATE_PATH,
      null
    )
  );

}

function saveLearningState(
  state
) {

  const normalized =
    normalizeState(
      state
    );

  normalized.updatedAt =
    new Date().toISOString();

  atomicWriteJSON(
    LEARNING_STATE_PATH,
    normalized
  );

  return normalized;

}

// -----------------------------------------------------------------------------
// Analysis history access
// -----------------------------------------------------------------------------

function loadAnalysisHistory() {

  const history =
    readJSON(
      ANALYSIS_HISTORY_PATH,
      null
    );

  if (
    !isPlainObject(
      history
    )
  ) {

    throw new Error(
      "analysis-history.json is missing or does not contain a valid JSON object."
    );

  }

  const closed =
    Array.isArray(
      history.closed
    )
      ? history.closed
      : [];

  return {
    raw:
      history,

    closed,

    updatedAt:
      toISOStringOrNull(
        history.updatedAt
      )
  };

}

// -----------------------------------------------------------------------------
// Learning data access
// -----------------------------------------------------------------------------

function loadExistingLearningExport() {

  const learningData =
    readJSON(
      LEARNING_DATA_PATH,
      null
    );

  const confidenceData =
    readJSON(
      CONFIDENCE_DATA_PATH,
      null
    );

  if (
    isPlainObject(
      learningData
    ) &&
    isPlainObject(
      learningData.learning
    )
  ) {

    return learningData;

  }

  if (
    isPlainObject(
      learningData
    ) ||
    isPlainObject(
      confidenceData
    )
  ) {

    return {
      learning:
        isPlainObject(
          learningData?.learning
        )
          ? learningData.learning
          : (
              isPlainObject(
                learningData
              )
                ? learningData
                : {}
            ),

      confidence:
        isPlainObject(
          confidenceData?.confidence
        )
          ? confidenceData.confidence
          : (
              isPlainObject(
                confidenceData
              )
                ? confidenceData
                : {}
            ),

      exportedAt:
        new Date().toISOString(),

      metadata: {
        importedFromLegacyFiles:
          true
      }
    };

  }

  return null;

}

// -----------------------------------------------------------------------------
// Learner initialization
// -----------------------------------------------------------------------------

function createLearner() {

  return new PipSightLearner({
    dataPath:
      LEARNING_DATA_PATH,

    confidencePath:
      CONFIDENCE_DATA_PATH
  });

}

// -----------------------------------------------------------------------------
// Closed trade validation
// -----------------------------------------------------------------------------

function validateClosedTrade(
  record,
  index
) {

  const errors =
    [];

  if (
    !isPlainObject(
      record
    )
  ) {

    return {
      valid:
        false,

      index,

      errors: [
        "Closed trade record is not a valid object."
      ],

      normalized:
        null
    };

  }

  const pair =
    normalizePair(
      record.pair ??
      record.symbol ??
      record.pairLabel
    );

  const direction =
    normalizeDirection(
      record.direction ??
      record.decision ??
      record.signal ??
      record.action
    );

  const outcome =
    normalizeOutcome(
      record.outcome ??
      record.result
    );

  const {
    engine,
    strategy,
    timeframe
  } =
    inferStrategyAndTimeframe(
      record
    );

  const entry =
    toFiniteNumber(
      record.entry ??
      record.entryPrice ??
      record.price
    );

  const stopLoss =
    toFiniteNumber(
      record.stop ??
      record.stopLoss ??
      record.sl
    );

  const takeProfit =
    toFiniteNumber(
      record.target ??
      record.target1 ??
      record.takeProfit ??
      record.takeProfit1 ??
      record.tp1
    );

  const openedAt =
    toISOStringOrNull(
      record.openedAt ??
      record.signalTime ??
      record.createdAt
    );

  const closedAt =
    toISOStringOrNull(
      record.closedAt ??
      record.resolvedAt ??
      record.updatedAt
    );

  if (
    !pair
  ) {

    errors.push(
      "Missing or invalid pair."
    );

  } else if (
    !SUPPORTED_PAIRS.has(
      pair
    )
  ) {

    errors.push(
      `Unsupported pair: ${pair}.`
    );

  }

  if (
    !engine
  ) {

    errors.push(
      "Missing engine or strategy identifier."
    );

  }

  if (
    !strategy
  ) {

    errors.push(
      `Unsupported engine or strategy: ${engine || "unknown"}.`
    );

  }

  if (
    !timeframe
  ) {

    errors.push(
      `Unable to determine supported timeframe for engine: ${engine || "unknown"}.`
    );

  }

  if (
    !direction
  ) {

    errors.push(
      "Missing or invalid BUY/SELL direction."
    );

  }

  if (
    !outcome
  ) {

    errors.push(
      "Missing or invalid resolved outcome."
    );

  }

  if (
    entry === null
  ) {

    errors.push(
      "Missing or invalid entry price."
    );

  }

  if (
    stopLoss === null
  ) {

    errors.push(
      "Missing or invalid stop-loss price."
    );

  }

  if (
    takeProfit === null
  ) {

    errors.push(
      "Missing or invalid take-profit price."
    );

  }

  if (
    !openedAt
  ) {

    errors.push(
      "Missing or invalid openedAt timestamp."
    );

  }

  if (
    !closedAt
  ) {

    errors.push(
      "Missing or invalid closedAt timestamp."
    );

  }

  if (
    openedAt &&
    closedAt
  ) {

    const openedTimestamp =
      new Date(
        openedAt
      ).getTime();

    const closedTimestamp =
      new Date(
        closedAt
      ).getTime();

    if (
      closedTimestamp <
      openedTimestamp
    ) {

      errors.push(
        "closedAt timestamp is earlier than openedAt timestamp."
      );

    }

  }

  if (
    direction === "BUY" &&
    entry !== null &&
    stopLoss !== null &&
    stopLoss >= entry
  ) {

    errors.push(
      "BUY trade stop loss must be below entry."
    );

  }

  if (
    direction === "BUY" &&
    entry !== null &&
    takeProfit !== null &&
    takeProfit <= entry
  ) {

    errors.push(
      "BUY trade take profit must be above entry."
    );

  }

  if (
    direction === "SELL" &&
    entry !== null &&
    stopLoss !== null &&
    stopLoss <= entry
  ) {

    errors.push(
      "SELL trade stop loss must be above entry."
    );

  }

  if (
    direction === "SELL" &&
    entry !== null &&
    takeProfit !== null &&
    takeProfit >= entry
  ) {

    errors.push(
      "SELL trade take profit must be below entry."
    );

  }

  const normalized = {
    index,

    source:
      "analysis-history.closed",

    pair,

    engine,

    strategy,

    timeframe,

    direction,

    entry,

    stopLoss,

    takeProfit,

    outcome,

    openedAt,

    closedAt,

    raw:
      record
  };

  return {
    valid:
      errors.length === 0,

    index,

    errors,

    normalized
  };

}

// -----------------------------------------------------------------------------
// Trade metrics
// -----------------------------------------------------------------------------

function calculateInitialRisk(
  trade
) {

  const entry =
    toFiniteNumber(
      trade?.entry
    );

  const stopLoss =
    toFiniteNumber(
      trade?.stopLoss
    );

  if (
    entry === null ||
    stopLoss === null
  ) {

    return null;

  }

  const risk =
    Math.abs(
      entry -
      stopLoss
    );

  return risk > 0
    ? risk
    : null;

}

function calculatePlannedReward(
  trade
) {

  const entry =
    toFiniteNumber(
      trade?.entry
    );

  const takeProfit =
    toFiniteNumber(
      trade?.takeProfit
    );

  if (
    entry === null ||
    takeProfit === null
  ) {

    return null;

  }

  const reward =
    Math.abs(
      takeProfit -
      entry
    );

  return reward > 0
    ? reward
    : null;

}

function calculateRiskReward(
  trade
) {

  const risk =
    calculateInitialRisk(
      trade
    );

  const reward =
    calculatePlannedReward(
      trade
    );

  if (
    risk === null ||
    reward === null ||
    risk === 0
  ) {

    return null;

  }

  return Number(
    (
      reward /
      risk
    ).toFixed(
      6
    )
  );

}

function calculateDurationMinutes(
  trade
) {

  const openedAt =
    toISOStringOrNull(
      trade?.openedAt
    );

  const closedAt =
    toISOStringOrNull(
      trade?.closedAt
    );

  if (
    !openedAt ||
    !closedAt
  ) {

    return null;

  }

  const durationMs =
    new Date(
      closedAt
    ).getTime() -
    new Date(
      openedAt
    ).getTime();

  if (
    durationMs < 0
  ) {

    return null;

  }

  return Number(
    (
      durationMs /
      60000
    ).toFixed(
      2
    )
  );

}

// -----------------------------------------------------------------------------
// Rich history-record indexing
// -----------------------------------------------------------------------------

function normalizeFingerprint(
  value
) {

  const fingerprint =
    toTrimmedString(
      value
    );

  return fingerprint || null;

}

function buildRecordMatchKey(
  record
) {

  const pair =
    normalizePair(
      record?.pair ??
      record?.symbol ??
      record?.pairLabel
    ) || "";

  const engine =
    normalizeEngineName(
      record?.engine ??
      record?.engineName ??
      record?.mode ??
      record?.strategy
    );

  const direction =
    normalizeDirection(
      record?.direction ??
      record?.decision ??
      record?.signal ??
      record?.action
    ) || "";

  const entry =
    normalizeIdentityNumber(
      record?.entry ??
      record?.entryPrice ??
      record?.price
    );

  const openedAt =
    toISOStringOrNull(
      record?.openedAt ??
      record?.signalTime ??
      record?.createdAt ??
      record?.recordedAt
    ) || "";

  return [
    pair,
    engine,
    direction,
    entry,
    openedAt
  ].join(
    "|"
  );

}

function buildRichRecordIndex(
  history
) {

  const records =
    Array.isArray(
      history?.records
    )
      ? history.records
      : [];

  const byMatchKey =
    new Map();

  const byFingerprint =
    new Map();

  for (
    const record of records
  ) {

    if (
      !isPlainObject(
        record
      )
    ) {

      continue;

    }

    const matchKey =
      buildRecordMatchKey(
        record
      );

    if (
      matchKey &&
      !byMatchKey.has(
        matchKey
      )
    ) {

      byMatchKey.set(
        matchKey,
        record
      );

    }

    const fingerprint =
      normalizeFingerprint(
        record.fingerprint
      );

    if (
      fingerprint &&
      !byFingerprint.has(
        fingerprint
      )
    ) {

      byFingerprint.set(
        fingerprint,
        record
      );

    }

  }

  return {
    records,
    byMatchKey,
    byFingerprint
  };

}

function findMatchingRichRecord(
  normalizedTrade,
  richRecordIndex
) {

  if (
    !normalizedTrade ||
    !richRecordIndex
  ) {

    return null;

  }

  const matchKey =
    buildRecordMatchKey({
      pair:
        normalizedTrade.pair,

      engine:
        normalizedTrade.engine,

      direction:
        normalizedTrade.direction,

      entry:
        normalizedTrade.entry,

      openedAt:
        normalizedTrade.openedAt
    });

  if (
    richRecordIndex.byMatchKey.has(
      matchKey
    )
  ) {

    return richRecordIndex.byMatchKey.get(
      matchKey
    );

  }

  const candidateFingerprint =
    [
      normalizedTrade.pair,
      normalizedTrade.engine,
      normalizedTrade.direction,
      normalizeIdentityNumber(
        normalizedTrade.entry
      ),
      normalizeIdentityNumber(
        normalizedTrade.stopLoss
      ),
      normalizeIdentityNumber(
        normalizedTrade.takeProfit
      )
    ].join(
      "|"
    );

  if (
    richRecordIndex.byFingerprint.has(
      candidateFingerprint
    )
  ) {

    return richRecordIndex.byFingerprint.get(
      candidateFingerprint
    );

  }

  return null;

}

// -----------------------------------------------------------------------------
// Rich metadata extraction
// -----------------------------------------------------------------------------

function extractPipelineSteps(
  richRecord
) {

  const snapshot =
    isPlainObject(
      richRecord?.snapshot
    )
      ? richRecord.snapshot
      : {};

  const candidates = [
    richRecord?.pipeline,
    richRecord?.steps,
    snapshot.pipeline,
    snapshot.steps
  ];

  for (
    const candidate of candidates
  ) {

    if (
      Array.isArray(
        candidate
      )
    ) {

      return candidate;

    }

  }

  return [];

}

function findPipelineStep(
  richRecord,
  names
) {

  const normalizedNames =
    names.map(
      name =>
        toTrimmedString(
          name
        ).toLowerCase()
    );

  const steps =
    extractPipelineSteps(
      richRecord
    );

  for (
    const step of steps
  ) {

    if (
      !isPlainObject(
        step
      )
    ) {

      continue;

    }

    const stepName =
      toTrimmedString(
        step.name
      ).toLowerCase();

    if (
      normalizedNames.includes(
        stepName
      )
    ) {

      return step;

    }

  }

  return null;

}

function extractIndicatorValue(
  richRecord,
  options
) {

  const {
    directFields = [],
    stepNames = [],
    stepFields = []
  } =
    options;

  const snapshot =
    isPlainObject(
      richRecord?.snapshot
    )
      ? richRecord.snapshot
      : {};

  for (
    const field of directFields
  ) {

    const directValue =
      toFiniteNumber(
        richRecord?.[field]
      );

    if (
      directValue !== null
    ) {

      return directValue;

    }

    const snapshotValue =
      toFiniteNumber(
        snapshot?.[field]
      );

    if (
      snapshotValue !== null
    ) {

      return snapshotValue;

    }

  }

  const step =
    findPipelineStep(
      richRecord,
      stepNames
    );

  if (
    !step
  ) {

    return null;

  }

  for (
    const field of stepFields
  ) {

    const value =
      toFiniteNumber(
        step[field]
      );

    if (
      value !== null
    ) {

      return value;

    }

  }

  return null;

}

function extractIndicators(
  richRecord
) {

  if (
    !isPlainObject(
      richRecord
    )
  ) {

    return {};
  }

  const indicators =
    {};

  const rsi =
    extractIndicatorValue(
      richRecord,
      {
        directFields: [
          "rsi"
        ],

        stepNames: [
          "RSI Confirmation",
          "RSI"
        ],

        stepFields: [
          "rsi",
          "value"
        ]
      }
    );

  const macd =
    extractIndicatorValue(
      richRecord,
      {
        directFields: [
          "macd"
        ],

        stepNames: [
          "MACD Confirmation",
          "MACD"
        ],

        stepFields: [
          "macd",
          "value"
        ]
      }
    );

  const macdSignal =
    extractIndicatorValue(
      richRecord,
      {
        directFields: [
          "macdSignal",
          "signalLine"
        ],

        stepNames: [
          "MACD Confirmation",
          "MACD"
        ],

        stepFields: [
          "signal",
          "signalLine"
        ]
      }
    );

  const macdHistogram =
    extractIndicatorValue(
      richRecord,
      {
        directFields: [
          "macdHistogram",
          "histogram"
        ],

        stepNames: [
          "MACD Confirmation",
          "MACD"
        ],

        stepFields: [
          "histogram"
        ]
      }
    );

  const atr =
    extractIndicatorValue(
      richRecord,
      {
        directFields: [
          "atr"
        ],

        stepNames: [
          "ATR-style Stop Loss",
          "ATR"
        ],

        stepFields: [
          "atr",
          "value"
        ]
      }
    );

  const adx =
    extractIndicatorValue(
      richRecord,
      {
        directFields: [
          "adx"
        ],

        stepNames: [
          "ADX > 25?",
          "ADX"
        ],

        stepFields: [
          "adx",
          "value"
        ]
      }
    );

  if (
    rsi !== null
  ) {

    indicators.rsi =
      rsi;

  }

  if (
    macd !== null
  ) {

    indicators.macd =
      macd;

  }

  if (
    macdSignal !== null
  ) {

    indicators.macdSignal =
      macdSignal;

  }

  if (
    macdHistogram !== null
  ) {

    indicators.macdHistogram =
      macdHistogram;

  }

  if (
    atr !== null
  ) {

    indicators.atr =
      atr;

  }

  if (
    adx !== null
  ) {

    indicators.adx =
      adx;

  }

  return indicators;

}

function extractConfidence(
  richRecord
) {

  const snapshot =
    isPlainObject(
      richRecord?.snapshot
    )
      ? richRecord.snapshot
      : {};

  const candidates = [
    richRecord?.confidence,
    richRecord?.confidencePct,
    snapshot.confidence,
    snapshot.confidencePct
  ];

  for (
    const candidate of candidates
  ) {

    const number =
      toFiniteNumber(
        candidate
      );

    if (
      number !== null
    ) {

      return Math.max(
        0,
        Math.min(
          100,
          number
        )
      );

    }

  }

  return null;

}

function extractScore(
  richRecord
) {

  const snapshot =
    isPlainObject(
      richRecord?.snapshot
    )
      ? richRecord.snapshot
      : {};

  const candidates = [
    richRecord?.score,
    richRecord?.aiScore,
    snapshot.score,
    snapshot.aiScore
  ];

  for (
    const candidate of candidates
  ) {

    const number =
      toFiniteNumber(
        candidate
      );

    if (
      number !== null
    ) {

      return number;

    }

  }

  return null;

}

// -----------------------------------------------------------------------------
// Learner payload mapping
// -----------------------------------------------------------------------------

function buildLearnerOutcomePayload(
  normalizedTrade,
  richRecord = null
) {

  const risk =
    calculateInitialRisk(
      normalizedTrade
    );

  const reward =
    calculatePlannedReward(
      normalizedTrade
    );

  const riskReward =
    calculateRiskReward(
      normalizedTrade
    );

  const durationMinutes =
    calculateDurationMinutes(
      normalizedTrade
    );

  const confidence =
    extractConfidence(
      richRecord
    );

  const score =
    extractScore(
      richRecord
    );

  const indicators =
    extractIndicators(
      richRecord
    );

  const payload = {
    pair:
      normalizedTrade.pair,

    strategy:
      normalizedTrade.strategy,

    timeframe:
      normalizedTrade.timeframe,

    direction:
      normalizedTrade.direction,

    entry:
      normalizedTrade.entry,

    entryPrice:
      normalizedTrade.entry,

    stopLoss:
      normalizedTrade.stopLoss,

    stop:
      normalizedTrade.stopLoss,

    takeProfit:
      normalizedTrade.takeProfit,

    takeProfit1:
      normalizedTrade.takeProfit,

    target:
      normalizedTrade.takeProfit,

    result:
      normalizedTrade.outcome,

    outcome:
      normalizedTrade.outcome,

    openedAt:
      normalizedTrade.openedAt,

    closedAt:
      normalizedTrade.closedAt,

    signalTime:
      normalizedTrade.openedAt,

    resolvedAt:
      normalizedTrade.closedAt,

    engine:
      normalizedTrade.engine,

    source:
      "analysis-history.closed"
  };

  if (
    risk !== null
  ) {

    payload.risk =
      risk;

    payload.initialRisk =
      risk;

  }

  if (
    reward !== null
  ) {

    payload.reward =
      reward;

    payload.plannedReward =
      reward;

  }

  if (
    riskReward !== null
  ) {

    payload.riskReward =
      riskReward;

    payload.rr =
      riskReward;

  }

  if (
    durationMinutes !== null
  ) {

    payload.durationMinutes =
      durationMinutes;

    payload.tradeDurationMinutes =
      durationMinutes;

  }

  if (
    confidence !== null
  ) {

    payload.confidence =
      confidence;

    payload.originalConfidence =
      confidence;

  }

  if (
    score !== null
  ) {

    payload.score =
      score;

    payload.aiScore =
      score;

  }

  if (
    Object.keys(
      indicators
    ).length > 0
  ) {

    payload.indicators =
      indicators;

  }

  if (
    isPlainObject(
      richRecord
    )
  ) {

    const richRecordId =
      toTrimmedString(
        richRecord.id
      );

    const fingerprint =
      normalizeFingerprint(
        richRecord.fingerprint
      );

    const reason =
      toTrimmedString(
        richRecord.reason ??
        richRecord.snapshot?.reason
      );

    if (
      richRecordId
    ) {

      payload.historyRecordId =
        richRecordId;

    }

    if (
      fingerprint
    ) {

      payload.fingerprint =
        fingerprint;

    }

    if (
      reason
    ) {

      payload.reason =
        reason;

    }

  }

  return payload;

}

// -----------------------------------------------------------------------------
// Closed history preparation
// -----------------------------------------------------------------------------

function prepareClosedHistory(
  history,
  state
) {

  const closedRecords =
    Array.isArray(
      history?.closed
    )
      ? history.closed
      : [];

  const processedKeys =
    new Set(
      Array.isArray(
        state?.processedTradeKeys
      )
        ? state.processedTradeKeys
        : []
    );

  const richRecordIndex =
    buildRichRecordIndex(
      history
    );

  const accepted =
    [];

  const duplicates =
    [];

  const invalid =
    [];

  for (
    let index = 0;
    index < closedRecords.length;
    index += 1
  ) {

    const rawRecord =
      closedRecords[index];

    const validation =
      validateClosedTrade(
        rawRecord,
        index
      );

    if (
      !validation.valid
    ) {

      invalid.push({
        index,

        pair:
          normalizePair(
            rawRecord?.pair ??
            rawRecord?.symbol
          ),

        engine:
          normalizeEngineName(
            rawRecord?.engine ??
            rawRecord?.mode
          ) || null,

        openedAt:
          toISOStringOrNull(
            rawRecord?.openedAt
          ),

        closedAt:
          toISOStringOrNull(
            rawRecord?.closedAt
          ),

        errors:
          validation.errors
      });

      continue;

    }

    const normalizedTrade =
      validation.normalized;

    const tradeKey =
      createTradeKey(
        normalizedTrade.raw
      );

    if (
      processedKeys.has(
        tradeKey
      )
    ) {

      duplicates.push({
        index,

        tradeKey,

        pair:
          normalizedTrade.pair,

        strategy:
          normalizedTrade.strategy,

        timeframe:
          normalizedTrade.timeframe,

        direction:
          normalizedTrade.direction,

        outcome:
          normalizedTrade.outcome,

        openedAt:
          normalizedTrade.openedAt,

        closedAt:
          normalizedTrade.closedAt
      });

      continue;

    }

    const richRecord =
      findMatchingRichRecord(
        normalizedTrade,
        richRecordIndex
      );

    const learnerPayload =
      buildLearnerOutcomePayload(
        normalizedTrade,
        richRecord
      );

    accepted.push({
      index,

      tradeKey,

      normalizedTrade,

      learnerPayload,

      richRecordMatched:
        Boolean(
          richRecord
        ),

      richRecordId:
        richRecord?.id
          ? String(
              richRecord.id
            )
          : null
    });

  }

  return {
    historyRecordsSeen:
      closedRecords.length,

    accepted,

    duplicates,

    invalid,

    richRecordCount:
      richRecordIndex.records.length
  };

}

// -----------------------------------------------------------------------------
// Safe learner method invocation
// -----------------------------------------------------------------------------

function callLearnerRecordOutcome(
  learner,
  payload
) {

  if (
    !learner ||
    typeof learner.recordOutcome !== "function"
  ) {

    throw new Error(
      "PipSightLearner.recordOutcome() is unavailable."
    );

  }

  return learner.recordOutcome(
    payload
  );

}

// -----------------------------------------------------------------------------
// Learner import lifecycle
// -----------------------------------------------------------------------------

function importExistingLearningData(
  learner,
  existingExport
) {

  if (
    !existingExport
  ) {

    return {
      imported:
        false,

      reason:
        "No existing learning export found."
    };

  }

  if (
    !learner ||
    typeof learner.importData !== "function"
  ) {

    throw new Error(
      "PipSightLearner.importData() is unavailable."
    );

  }

  const result =
    learner.importData(
      existingExport
    );

  return {
    imported:
      true,

    result:
      result ?? null
  };

}

// -----------------------------------------------------------------------------
// Learner export lifecycle
// -----------------------------------------------------------------------------

function exportLearnerData(
  learner
) {

  if (
    !learner ||
    typeof learner.exportData !== "function"
  ) {

    throw new Error(
      "PipSightLearner.exportData() is unavailable."
    );

  }

  const exported =
    learner.exportData();

  if (
    !isPlainObject(
      exported
    )
  ) {

    throw new Error(
      "PipSightLearner.exportData() did not return a valid object."
    );

  }

  const learning =
    isPlainObject(
      exported.learning
    )
      ? exported.learning
      : {};

  const confidence =
    isPlainObject(
      exported.confidence
    )
      ? exported.confidence
      : {};

  const exportedAt =
    toISOStringOrNull(
      exported.exportedAt
    ) ||
    new Date().toISOString();

  const metadata =
    isPlainObject(
      exported.metadata
    )
      ? exported.metadata
      : {};

  return {
    learning,
    confidence,
    exportedAt,

    metadata: {
      ...metadata,

      runner:
        ENGINE_NAME,

      runnerVersion:
        ENGINE_VERSION
    }
  };

}

// -----------------------------------------------------------------------------
// Learning data persistence
// -----------------------------------------------------------------------------

function saveLearnerExport(
  learnerExport
) {

  if (
    !isPlainObject(
      learnerExport
    )
  ) {

    throw new Error(
      "Cannot persist an invalid learner export."
    );

  }

  const exportedAt =
    toISOStringOrNull(
      learnerExport.exportedAt
    ) ||
    new Date().toISOString();

  const learningFile = {
    version:
      STATE_VERSION,

    learning:
      isPlainObject(
        learnerExport.learning
      )
        ? learnerExport.learning
        : {},

    confidence:
      isPlainObject(
        learnerExport.confidence
      )
        ? learnerExport.confidence
        : {},

    exportedAt,

    metadata: {
      ...(
        isPlainObject(
          learnerExport.metadata
        )
          ? learnerExport.metadata
          : {}
      ),

      engineName:
        ENGINE_NAME,

      engineVersion:
        ENGINE_VERSION,

      savedAt:
        new Date().toISOString()
    }
  };

  const confidenceFile = {
    version:
      STATE_VERSION,

    confidence:
      isPlainObject(
        learnerExport.confidence
      )
        ? learnerExport.confidence
        : {},

    exportedAt,

    metadata: {
      ...(
        isPlainObject(
          learnerExport.metadata
        )
          ? learnerExport.metadata
          : {}
      ),

      engineName:
        ENGINE_NAME,

      engineVersion:
        ENGINE_VERSION,

      savedAt:
        new Date().toISOString()
    }
  };

  atomicWriteJSON(
    LEARNING_DATA_PATH,
    learningFile
  );

  atomicWriteJSON(
    CONFIDENCE_DATA_PATH,
    confidenceFile
  );

  return {
    learningPath:
      LEARNING_DATA_PATH,

    confidencePath:
      CONFIDENCE_DATA_PATH,

    exportedAt
  };

}

// -----------------------------------------------------------------------------
// Learner result inspection
// -----------------------------------------------------------------------------

function resultIndicatesFailure(
  result
) {

  if (
    result === false ||
    result === null
  ) {

    return true;

  }

  if (
    isPlainObject(
      result
    )
  ) {

    if (
      result.success === false ||
      result.ok === false ||
      result.valid === false
    ) {

      return true;

    }

    const status =
      toTrimmedString(
        result.status
      ).toLowerCase();

    if (
      status === "error" ||
      status === "failed" ||
      status === "rejected"
    ) {

      return true;

    }

  }

  return false;

}

function extractLearnerErrorMessage(
  result
) {

  if (
    !isPlainObject(
      result
    )
  ) {

    return null;

  }

  const candidates = [
    result.error,
    result.message,
    result.reason,
    result.validationError
  ];

  for (
    const candidate of candidates
  ) {

    const message =
      toTrimmedString(
        candidate
      );

    if (
      message
    ) {

      return message;

    }

  }

  if (
    Array.isArray(
      result.errors
    ) &&
    result.errors.length > 0
  ) {

    return result.errors
      .map(
        item =>
          toTrimmedString(
            item
          )
      )
      .filter(
        Boolean
      )
      .join(
        "; "
      ) || null;

  }

  return null;

}

// -----------------------------------------------------------------------------
// Per-trade processing
// -----------------------------------------------------------------------------

function processAcceptedTrade(
  learner,
  preparedTrade
) {

  const startedAt =
    new Date().toISOString();

  try {

    if (
      !isPlainObject(
        preparedTrade
      )
    ) {

      throw new Error(
        "Prepared trade is not a valid object."
      );

    }

    if (
      !isPlainObject(
        preparedTrade.learnerPayload
      )
    ) {

      throw new Error(
        "Prepared trade learner payload is missing."
      );

    }

    const result =
      callLearnerRecordOutcome(
        learner,
        preparedTrade.learnerPayload
      );

    if (
      resultIndicatesFailure(
        result
      )
    ) {

      throw new Error(
        extractLearnerErrorMessage(
          result
        ) ||
        "Learner rejected the resolved trade."
      );

    }

    return {
      success:
        true,

      index:
        preparedTrade.index,

      tradeKey:
        preparedTrade.tradeKey,

      pair:
        preparedTrade.normalizedTrade.pair,

      strategy:
        preparedTrade.normalizedTrade.strategy,

      timeframe:
        preparedTrade.normalizedTrade.timeframe,

      direction:
        preparedTrade.normalizedTrade.direction,

      outcome:
        preparedTrade.normalizedTrade.outcome,

      openedAt:
        preparedTrade.normalizedTrade.openedAt,

      closedAt:
        preparedTrade.normalizedTrade.closedAt,

      richRecordMatched:
        preparedTrade.richRecordMatched,

      richRecordId:
        preparedTrade.richRecordId,

      processedAt:
        new Date().toISOString(),

      result:
        result ?? null,

      startedAt
    };

  } catch (
    error
  ) {

    return {
      success:
        false,

      index:
        preparedTrade?.index ?? null,

      tradeKey:
        preparedTrade?.tradeKey ?? null,

      pair:
        preparedTrade?.normalizedTrade?.pair ?? null,

      strategy:
        preparedTrade?.normalizedTrade?.strategy ?? null,

      timeframe:
        preparedTrade?.normalizedTrade?.timeframe ?? null,

      direction:
        preparedTrade?.normalizedTrade?.direction ?? null,

      outcome:
        preparedTrade?.normalizedTrade?.outcome ?? null,

      openedAt:
        preparedTrade?.normalizedTrade?.openedAt ?? null,

      closedAt:
        preparedTrade?.normalizedTrade?.closedAt ?? null,

      richRecordMatched:
        Boolean(
          preparedTrade?.richRecordMatched
        ),

      richRecordId:
        preparedTrade?.richRecordId ?? null,

      processedAt:
        new Date().toISOString(),

      startedAt,

      error:
        error instanceof Error
          ? error.message
          : String(
              error
            )
    };

  }

}

// -----------------------------------------------------------------------------
// Sequential learning execution
// -----------------------------------------------------------------------------

function processPreparedTrades(
  learner,
  prepared
) {

  const accepted =
    Array.isArray(
      prepared?.accepted
    )
      ? prepared.accepted
      : [];

  const successful =
    [];

  const failed =
    [];

  for (
    const preparedTrade of accepted
  ) {

    const result =
      processAcceptedTrade(
        learner,
        preparedTrade
      );

    if (
      result.success
    ) {

      successful.push(
        result
      );

    } else {

      failed.push(
        result
      );

    }

  }

  return {
    attempted:
      accepted.length,

    successful,

    failed
  };

}

// -----------------------------------------------------------------------------
// Processed-key commit
// -----------------------------------------------------------------------------

function commitProcessedTradeKeys(
  state,
  successfulResults
) {

  const existing =
    new Set(
      Array.isArray(
        state?.processedTradeKeys
      )
        ? state.processedTradeKeys
        : []
    );

  let added =
    0;

  for (
    const result of successfulResults
  ) {

    const tradeKey =
      toTrimmedString(
        result?.tradeKey
      );

    if (
      !tradeKey ||
      existing.has(
        tradeKey
      )
    ) {

      continue;

    }

    existing.add(
      tradeKey
    );

    added +=
      1;

  }

  state.processedTradeKeys =
    Array.from(
      existing
    );

  return added;

}

// -----------------------------------------------------------------------------
// Run state initialization
// -----------------------------------------------------------------------------

function beginLearningRun(
  state
) {

  const startedAt =
    new Date().toISOString();

  state.lastRunAt =
    startedAt;

  state.totals.runs =
    (
      toFiniteNumber(
        state.totals.runs
      ) || 0
    ) + 1;

  state.lastRun = {
    startedAt,

    completedAt:
      null,

    success:
      null,

    historyRecordsSeen:
      0,

    acceptedRecords:
      0,

    learnedRecords:
      0,

    duplicateRecords:
      0,

    skippedRecords:
      0,

    invalidRecords:
      0,

    failedRecords:
      0,

    richRecordCount:
      0,

    richRecordsMatched:
      0,

    importedExistingData:
      false,

    persistedLearningData:
      false,

    errors:
      []
  };

  return state;

}

// -----------------------------------------------------------------------------
// State counters
// -----------------------------------------------------------------------------

function addNumericCounter(
  object,
  key,
  amount
) {

  const current =
    toFiniteNumber(
      object?.[key]
    ) || 0;

  const increment =
    toFiniteNumber(
      amount
    ) || 0;

  object[key] =
    current +
    increment;

}

function applyPreparationStats(
  state,
  prepared
) {

  const historyRecordsSeen =
    toFiniteNumber(
      prepared?.historyRecordsSeen
    ) || 0;

  const acceptedRecords =
    Array.isArray(
      prepared?.accepted
    )
      ? prepared.accepted.length
      : 0;

  const duplicateRecords =
    Array.isArray(
      prepared?.duplicates
    )
      ? prepared.duplicates.length
      : 0;

  const invalidRecords =
    Array.isArray(
      prepared?.invalid
    )
      ? prepared.invalid.length
      : 0;

  const richRecordCount =
    toFiniteNumber(
      prepared?.richRecordCount
    ) || 0;

  const richRecordsMatched =
    Array.isArray(
      prepared?.accepted
    )
      ? prepared.accepted.filter(
          item =>
            item.richRecordMatched
        ).length
      : 0;

  state.lastRun.historyRecordsSeen =
    historyRecordsSeen;

  state.lastRun.acceptedRecords =
    acceptedRecords;

  state.lastRun.duplicateRecords =
    duplicateRecords;

  state.lastRun.invalidRecords =
    invalidRecords;

  state.lastRun.skippedRecords =
    duplicateRecords +
    invalidRecords;

  state.lastRun.richRecordCount =
    richRecordCount;

  state.lastRun.richRecordsMatched =
    richRecordsMatched;

  addNumericCounter(
    state.totals,
    "historyRecordsSeen",
    historyRecordsSeen
  );

  addNumericCounter(
    state.totals,
    "acceptedRecords",
    acceptedRecords
  );

  addNumericCounter(
    state.totals,
    "duplicateRecords",
    duplicateRecords
  );

  addNumericCounter(
    state.totals,
    "invalidRecords",
    invalidRecords
  );

  addNumericCounter(
    state.totals,
    "skippedRecords",
    duplicateRecords +
    invalidRecords
  );

  return state;

}

function applyProcessingStats(
  state,
  processing
) {

  const learnedRecords =
    Array.isArray(
      processing?.successful
    )
      ? processing.successful.length
      : 0;

  const failedRecords =
    Array.isArray(
      processing?.failed
    )
      ? processing.failed.length
      : 0;

  state.lastRun.learnedRecords =
    learnedRecords;

  state.lastRun.failedRecords =
    failedRecords;

  state.lastRun.skippedRecords =
    (
      toFiniteNumber(
        state.lastRun.skippedRecords
      ) || 0
    ) +
    failedRecords;

  addNumericCounter(
    state.totals,
    "learnedRecords",
    learnedRecords
  );

  addNumericCounter(
    state.totals,
    "failedRecords",
    failedRecords
  );

  addNumericCounter(
    state.totals,
    "skippedRecords",
    failedRecords
  );

  return state;

}

// -----------------------------------------------------------------------------
// Error serialization
// -----------------------------------------------------------------------------

function serializeError(
  error,
  context = null
) {

  const serialized = {
    message:
      error instanceof Error
        ? error.message
        : String(
            error
          ),

    recordedAt:
      new Date().toISOString()
  };

  if (
    error instanceof Error &&
    error.name
  ) {

    serialized.name =
      error.name;

  }

  if (
    context
  ) {

    serialized.context =
      context;

  }

  return serialized;

}

function collectRunErrors(
  prepared,
  processing
) {

  const errors =
    [];

  const invalidRecords =
    Array.isArray(
      prepared?.invalid
    )
      ? prepared.invalid
      : [];

  const failedRecords =
    Array.isArray(
      processing?.failed
    )
      ? processing.failed
      : [];

  for (
    const invalid of invalidRecords
  ) {

    errors.push({
      type:
        "validation",

      index:
        invalid.index,

      pair:
        invalid.pair,

      engine:
        invalid.engine,

      openedAt:
        invalid.openedAt,

      closedAt:
        invalid.closedAt,

      messages:
        Array.isArray(
          invalid.errors
        )
          ? invalid.errors
          : []
    });

  }

  for (
    const failed of failedRecords
  ) {

    errors.push({
      type:
        "learner",

      index:
        failed.index,

      tradeKey:
        failed.tradeKey,

      pair:
        failed.pair,

      strategy:
        failed.strategy,

      timeframe:
        failed.timeframe,

      direction:
        failed.direction,

      outcome:
        failed.outcome,

      openedAt:
        failed.openedAt,

      closedAt:
        failed.closedAt,

      message:
        failed.error
    });

  }

  return errors;

}

// -----------------------------------------------------------------------------
// Run completion
// -----------------------------------------------------------------------------

function completeLearningRun(
  state,
  options
) {

  const completedAt =
    new Date().toISOString();

  const {
    success,
    historyUpdatedAt = null,
    errors = []
  } =
    options;

  state.lastRun.completedAt =
    completedAt;

  state.lastRun.success =
    Boolean(
      success
    );

  state.lastRun.errors =
    Array.isArray(
      errors
    )
      ? errors
      : [];

  state.lastHistoryUpdatedAt =
    historyUpdatedAt ||
    state.lastHistoryUpdatedAt ||
    null;

  if (
    success
  ) {

    state.lastSuccessfulRunAt =
      completedAt;

    addNumericCounter(
      state.totals,
      "successfulRuns",
      1
    );

  } else {

    addNumericCounter(
      state.totals,
      "failedRuns",
      1
    );

  }

  return state;

}

// -----------------------------------------------------------------------------
// Run summary
// -----------------------------------------------------------------------------

function buildRunSummary(
  state,
  prepared,
  processing,
  persistenceResult
) {

  const successful =
    Array.isArray(
      processing?.successful
    )
      ? processing.successful
      : [];

  const failed =
    Array.isArray(
      processing?.failed
    )
      ? processing.failed
      : [];

  const duplicates =
    Array.isArray(
      prepared?.duplicates
    )
      ? prepared.duplicates
      : [];

  const invalid =
    Array.isArray(
      prepared?.invalid
    )
      ? prepared.invalid
      : [];

  return {
    engineName:
      ENGINE_NAME,

    engineVersion:
      ENGINE_VERSION,

    success:
      state?.lastRun?.success === true,

    startedAt:
      state?.lastRun?.startedAt ?? null,

    completedAt:
      state?.lastRun?.completedAt ?? null,

    historyRecordsSeen:
      prepared?.historyRecordsSeen ?? 0,

    acceptedRecords:
      prepared?.accepted?.length ?? 0,

    learnedRecords:
      successful.length,

    duplicateRecords:
      duplicates.length,

    invalidRecords:
      invalid.length,

    failedRecords:
      failed.length,

    richRecordCount:
      prepared?.richRecordCount ?? 0,

    richRecordsMatched:
      prepared?.accepted?.filter(
        item =>
          item.richRecordMatched
      ).length ?? 0,

    processedTradeKeyCount:
      Array.isArray(
        state?.processedTradeKeys
      )
        ? state.processedTradeKeys.length
        : 0,

    persisted:
      Boolean(
        persistenceResult
      ),

    output: persistenceResult
      ? {
          learningData:
            path.relative(
              ROOT_DIR,
              persistenceResult.learningPath
            ),

          confidenceData:
            path.relative(
              ROOT_DIR,
              persistenceResult.confidencePath
            ),

          state:
            path.relative(
              ROOT_DIR,
              LEARNING_STATE_PATH
            ),

          exportedAt:
            persistenceResult.exportedAt
        }
      : null,

    failures:
      failed.map(
        item => ({
          index:
            item.index,

          tradeKey:
            item.tradeKey,

          pair:
            item.pair,

          strategy:
            item.strategy,

          timeframe:
            item.timeframe,

          error:
            item.error
        })
      ),

    invalid:
      invalid.map(
        item => ({
          index:
            item.index,

          pair:
            item.pair,

          engine:
            item.engine,

          errors:
            item.errors
        })
      )
  };

}
