// run-learning-engine.js
//
// PipSight Pro — Autonomous Learning Pipeline Runner.
//
// Version: 1.4.0
//
// Purpose:
// - Read verified resolved trades from data/analysis-history.json.
// - Convert historical outcomes into learner.js-compatible payloads.
// - Preserve immutable opening identity while tracking resolution revisions.
// - Prevent duplicate learning across repeated GitHub Actions runs.
// - Support an explicit or safely detected fresh-learning cutoff.
// - Propagate clean pair/timeframe/engine/direction/context attribution.
// - Persist learning-data.json and confidence-data.json transactionally.
// - Orchestrate Learning Enrichment → AI Memory → AI Policy after commit.
// - Preserve all existing signal, analysis, Telegram and history behavior.
//
// Reads:
//   data/analysis-history.json
//   data/learning-engine-state.json
//   data/learning-data.json
//   data/confidence-data.json
//   data/autonomous-config.json                  (optional control source)
//   learning-enrichment.js                       (optional advisory stage)
//   ai-memory.js                                 (required autonomous stage)
//   ai-policy-engine.js                          (required autonomous stage)
//
// Writes:
//   data/learning-engine-state.json
//   data/learning-data.json
//   data/confidence-data.json
//   downstream enrichment, memory and policy outputs through their own APIs
//
// Compatibility and safety:
// - CommonJS / Node.js 20.
// - Existing learner.js public API retained.
// - Existing analysis-history.json schema retained.
// - Existing strategy and signal engines are not modified.
// - Open trades are never treated as completed learning outcomes.
// - Only verified WIN, LOSS and BREAKEVEN records are learned.
// - Mutable outcome fields never participate in immutable trade identity.
// - Historical corrections update one identity; they never create a new trade.
// - Future-dated or chronologically invalid outcomes fail validation.
// - Downstream failure never rolls back committed learning data, but the run
//   fails closed so stale/unvalidated policy cannot be promoted.

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
  "1.4.0";

const LEGACY_ENGINE_VERSION =
  "1.0.0";

const AUTONOMOUS_SCHEMA_VERSION =
  1;

const STATE_VERSION =
  1;

const MAX_PROCESSED_TRADE_KEYS =
  100000;

const MAX_RESOLUTION_VERSION_RECORDS =
  100000;

const FUTURE_TIMESTAMP_TOLERANCE_MS =
  5 * 60 * 1000;

const DOWNSTREAM_PIPELINE_ENV =
  "PIPSIGHT_RUN_DOWNSTREAM_PIPELINE";

const SKIP_DOWNSTREAM_PIPELINE_ENV =
  "PIPSIGHT_SKIP_DOWNSTREAM_PIPELINE";

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

const AUTONOMOUS_CONFIG_PATH =
  path.join(
    DATA_DIR,
    "autonomous-config.json"
  );

const LEARNING_ENRICHMENT_MODULE_PATH =
  path.join(
    ROOT_DIR,
    "learning-enrichment.js"
  );

const AI_MEMORY_MODULE_PATH =
  path.join(
    ROOT_DIR,
    "ai-memory.js"
  );

const AI_POLICY_MODULE_PATH =
  path.join(
    ROOT_DIR,
    "ai-policy-engine.js"
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

  try {

    fs.writeFileSync(
      temporaryPath,
      serialized,
      "utf8"
    );

    fs.renameSync(
      temporaryPath,
      filePath
    );

  } finally {

    if (
      fs.existsSync(
        temporaryPath
      )
    ) {

      try {

        fs.unlinkSync(
          temporaryPath
        );

      } catch (_) {

        // Cleanup failure must not hide the original filesystem error.

      }

    }

  }

}


// -----------------------------------------------------------------------------
// Production integrity utilities
// -----------------------------------------------------------------------------

function createHash(
  value
) {

  return crypto
    .createHash(
      "sha256"
    )
    .update(
      String(
        value ?? ""
      )
    )
    .digest(
      "hex"
    );

}

function createFileContentHash(
  filePath
) {

  if (
    !fs.existsSync(
      filePath
    )
  ) {

    return null;

  }

  return createHash(
    fs.readFileSync(
      filePath
    )
  );

}

function readJSONStrictIfExists(
  filePath
) {

  if (
    !fs.existsSync(
      filePath
    )
  ) {

    return {
      exists:
        false,

      value:
        null
    };

  }

  const raw =
    fs.readFileSync(
      filePath,
      "utf8"
    );

  if (
    !raw.trim()
  ) {

    throw new Error(
      `${path.relative(
        ROOT_DIR,
        filePath
      )} exists but is empty.`
    );

  }

  let value;

  try {

    value =
      JSON.parse(
        raw
      );

  } catch (
    error
  ) {

    throw new Error(
      `${path.relative(
        ROOT_DIR,
        filePath
      )} contains invalid JSON: ${error.message}`
    );

  }

  return {
    exists:
      true,

    value
  };

}

function toNonNegativeInteger(
  value,
  fallback = 0
) {

  const number =
    toFiniteNumber(
      value
    );

  if (
    number === null ||
    number < 0
  ) {

    return fallback;

  }

  return Math.trunc(
    number
  );

}

function uniqueSortedStrings(
  values
) {

  return [
    ...new Set(
      (
        Array.isArray(
          values
        )
          ? values
          : []
      )
        .map(
          value =>
            toTrimmedString(
              value
            )
        )
        .filter(
          Boolean
        )
    )
  ].sort();

}

function getNestedValue(
  object,
  pathParts
) {

  let current =
    object;

  for (
    const part of pathParts
  ) {

    if (
      !isPlainObject(
        current
      ) &&
      !Array.isArray(
        current
      )
    ) {

      return undefined;

    }

    current =
      current[part];

  }

  return current;

}

function firstFiniteNumber(
  ...values
) {

  for (
    const value of values
  ) {

    const number =
      toFiniteNumber(
        value
      );

    if (
      number !== null
    ) {

      return number;

    }

  }

  return null;

}

function firstNonEmptyString(
  ...values
) {

  for (
    const value of values
  ) {

    const normalized =
      toTrimmedString(
        value
      );

    if (
      normalized
    ) {

      return normalized;

    }

  }

  return null;

}

function parseBooleanEnvironment(
  value,
  fallback = null
) {

  const normalized =
    toTrimmedString(
      value
    ).toLowerCase();

  if (
    [
      "1",
      "true",
      "yes",
      "on"
    ].includes(
      normalized
    )
  ) {

    return true;

  }

  if (
    [
      "0",
      "false",
      "no",
      "off"
    ].includes(
      normalized
    )
  ) {

    return false;

  }

  return fallback;

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

  const explicitHistoryRecordId =
    firstNonEmptyString(
      trade?.historyRecordId,
      trade?.recordId
    );

  if (
    explicitHistoryRecordId
  ) {

    return JSON.stringify({
      historyRecordId:
        explicitHistoryRecordId
    });

  }

  const explicitSourceTradeKey =
    firstNonEmptyString(
      trade?.sourceTradeKey,
      trade?.tradeKey
    );

  if (
    explicitSourceTradeKey
  ) {

    return JSON.stringify({
      sourceTradeKey:
        explicitSourceTradeKey
    });

  }

  const {
    strategy,
    timeframe
  } =
    inferStrategyAndTimeframe(
      trade
    );

  return JSON.stringify({
    pair:
      normalizePair(
        trade?.pair ??
        trade?.symbol ??
        trade?.pairLabel
      ) || "",

    strategy:
      strategy || "",

    timeframe:
      timeframe || "",

    direction:
      normalizeDirection(
        trade?.direction ??
        trade?.decision ??
        trade?.signal ??
        trade?.action
      ) || "",

    entry:
      normalizeIdentityNumber(
        trade?.entry ??
        trade?.entryPrice ??
        trade?.price
      ),

    openedAt:
      toISOStringOrNull(
        trade?.openedAt ??
        trade?.signalTime ??
        trade?.createdAt ??
        trade?.recordedAt
      ) || ""
  });

}

function createTradeKey(
  trade
) {

  return createHash(
    buildTradeIdentitySource(
      trade
    )
  );

}

function calculateResolvedClosePrice(
  normalizedTrade,
  richRecord = null
) {

  const raw =
    isPlainObject(
      normalizedTrade?.raw
    )
      ? normalizedTrade.raw
      : {};

  const snapshot =
    isPlainObject(
      richRecord?.snapshot
    )
      ? richRecord.snapshot
      : {};

  const explicit =
    firstFiniteNumber(
      raw.closePrice,
      raw.exitPrice,
      raw.close,
      richRecord?.closePrice,
      richRecord?.exitPrice,
      snapshot.closePrice,
      snapshot.exitPrice
    );

  if (
    explicit !== null &&
    explicit > 0
  ) {

    return explicit;

  }

  if (
    normalizedTrade?.outcome ===
      "WIN"
  ) {

    return normalizedTrade.takeProfit;

  }

  if (
    normalizedTrade?.outcome ===
      "LOSS"
  ) {

    return normalizedTrade.stopLoss;

  }

  return normalizedTrade?.entry ??
    null;

}

function calculateProfitPoints(
  normalizedTrade,
  closePrice
) {

  const entry =
    toFiniteNumber(
      normalizedTrade?.entry
    );

  const close =
    toFiniteNumber(
      closePrice
    );

  const direction =
    normalizeDirection(
      normalizedTrade?.direction
    );

  if (
    entry === null ||
    close === null ||
    !direction
  ) {

    return null;

  }

  const rawPoints =
    direction ===
      "SELL"
      ? entry - close
      : close - entry;

  if (
    normalizedTrade?.outcome ===
      "WIN"
  ) {

    return Number(
      Math.abs(
        rawPoints
      ).toFixed(
        8
      )
    );

  }

  if (
    normalizedTrade?.outcome ===
      "LOSS"
  ) {

    return Number(
      (
        -Math.abs(
          rawPoints
        )
      ).toFixed(
        8
      )
    );

  }

  return 0;

}

function buildTradeResolutionSource(
  normalizedTrade,
  richRecord = null
) {

  const closePrice =
    calculateResolvedClosePrice(
      normalizedTrade,
      richRecord
    );

  return JSON.stringify({
    outcome:
      normalizedTrade?.outcome ||
      null,

    closePrice:
      normalizeIdentityNumber(
        closePrice
      ),

    closedAt:
      normalizedTrade?.closedAt ||
      null,

    stopLoss:
      normalizeIdentityNumber(
        normalizedTrade?.stopLoss
      ),

    takeProfit:
      normalizeIdentityNumber(
        normalizedTrade?.takeProfit
      ),

    exitReason:
      firstNonEmptyString(
        normalizedTrade?.raw?.exitReason,
        normalizedTrade?.raw?.reason,
        richRecord?.exitReason,
        richRecord?.resolutionReason
      )
  });

}

function createTradeResolutionHash(
  normalizedTrade,
  richRecord = null
) {

  return createHash(
    buildTradeResolutionSource(
      normalizedTrade,
      richRecord
    )
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

    schemaVersion:
      AUTONOMOUS_SCHEMA_VERSION,

    engineName:
      ENGINE_NAME,

    engineVersion:
      ENGINE_VERSION,

    legacyEngineVersion:
      LEGACY_ENGINE_VERSION,

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

    learningStartAt:
      null,

    learningStartSource:
      null,

    processedTradeKeys:
      [],

    processedTradeVersions:
      {},

    sourceHashes: {
      analysisHistory:
        null,

      learningData:
        null,

      confidenceData:
        null
    },

    pendingTransaction:
      null,

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

      correctionRecords:
        0,

      migrationReplayRecords:
        0,

      duplicateRecords:
        0,

      cutoffSkippedRecords:
        0,

      skippedRecords:
        0,

      invalidRecords:
        0,

      failedRecords:
        0,

      downstreamRuns:
        0,

      downstreamFailures:
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

      correctionRecords:
        0,

      migrationReplayRecords:
        0,

      duplicateRecords:
        0,

      cutoffSkippedRecords:
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

      sourceHistoryHash:
        null,

      learningStartAt:
        null,

      learningStartSource:
        null,

      pendingRecovery:
        null,

      downstream:
        null,

      errors:
        []
    }
  };

}

function normalizeProcessedTradeVersions(
  value
) {

  if (
    !isPlainObject(
      value
    )
  ) {

    return {};

  }

  const entries =
    Object.entries(
      value
    )
      .filter(
        ([
          tradeKey,
          record
        ]) =>
          Boolean(
            toTrimmedString(
              tradeKey
            )
          ) &&
          isPlainObject(
            record
          )
      )
      .map(
        ([
          tradeKey,
          record
        ]) => [
          toTrimmedString(
            tradeKey
          ),
          {
            resolutionHash:
              toTrimmedString(
                record.resolutionHash
              ) || null,

            revision:
              Math.max(
                1,
                toNonNegativeInteger(
                  record.revision,
                  1
                )
              ),

            processedAt:
              toISOStringOrNull(
                record.processedAt
              ),

            closedAt:
              toISOStringOrNull(
                record.closedAt
              ),

            outcome:
              normalizeOutcome(
                record.outcome
              ),

            historyRecordId:
              firstNonEmptyString(
                record.historyRecordId
              )
          }
        ]
      )
      .sort(
        (
          left,
          right
        ) =>
          (
            left[1].processedAt ||
            ""
          ).localeCompare(
            right[1].processedAt ||
            ""
          )
      )
      .slice(
        -MAX_RESOLUTION_VERSION_RECORDS
      );

  return Object.fromEntries(
    entries
  );

}

function normalizePendingTransaction(
  value
) {

  if (
    !isPlainObject(
      value
    )
  ) {

    return null;

  }

  const tradeKeys =
    uniqueSortedStrings(
      value.tradeKeys
    );

  const tradeVersions =
    Array.isArray(
      value.tradeVersions
    )
      ? value.tradeVersions
          .filter(
            isPlainObject
          )
          .map(
            item => ({
              tradeKey:
                toTrimmedString(
                  item.tradeKey
                ),

              resolutionHash:
                toTrimmedString(
                  item.resolutionHash
                ) || null,

              revision:
                Math.max(
                  1,
                  toNonNegativeInteger(
                    item.revision,
                    1
                  )
                ),

              processedAt:
                toISOStringOrNull(
                  item.processedAt
                ),

              closedAt:
                toISOStringOrNull(
                  item.closedAt
                ),

              outcome:
                normalizeOutcome(
                  item.outcome
                ),

              historyRecordId:
                firstNonEmptyString(
                  item.historyRecordId
                )
            }))
          .filter(
            item =>
              Boolean(
                item.tradeKey
              )
          )
      : tradeKeys.map(
          tradeKey => ({
            tradeKey,
            resolutionHash:
              null,
            revision:
              1,
            processedAt:
              null,
            closedAt:
              null,
            outcome:
              null,
            historyRecordId:
              null
          })
        );

  return {
    version:
      AUTONOMOUS_SCHEMA_VERSION,

    createdAt:
      toISOStringOrNull(
        value.createdAt
      ),

    exportHash:
      toTrimmedString(
        value.exportHash
      ) || null,

    tradeKeys,

    tradeVersions
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
    uniqueSortedStrings(
      value.processedTradeKeys
    )
      .slice(
        -MAX_PROCESSED_TRADE_KEYS
      );

  const learningStartAt =
    toISOStringOrNull(
      value.learningStartAt
    );

  return {
    ...fallback,
    ...value,

    version:
      STATE_VERSION,

    schemaVersion:
      AUTONOMOUS_SCHEMA_VERSION,

    engineName:
      ENGINE_NAME,

    engineVersion:
      ENGINE_VERSION,

    legacyEngineVersion:
      LEGACY_ENGINE_VERSION,

    createdAt:
      toISOStringOrNull(
        value.createdAt
      ) ||
      fallback.createdAt,

    learningStartAt,

    learningStartSource:
      learningStartAt
        ? (
            firstNonEmptyString(
              value.learningStartSource
            ) ||
            "state"
          )
        : null,

    processedTradeKeys,

    processedTradeVersions:
      normalizeProcessedTradeVersions(
        value.processedTradeVersions
      ),

    sourceHashes: {
      ...fallback.sourceHashes,
      ...(
        isPlainObject(
          value.sourceHashes
        )
          ? value.sourceHashes
          : {}
      )
    },

    pendingTransaction:
      normalizePendingTransaction(
        value.pendingTransaction
      ),

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

  const source =
    readJSONStrictIfExists(
      LEARNING_STATE_PATH
    );

  if (
    !source.exists
  ) {

    return createEmptyState();

  }

  return normalizeState(
    source.value
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

  const learningSource =
    readJSONStrictIfExists(
      LEARNING_DATA_PATH
    );

  const confidenceSource =
    readJSONStrictIfExists(
      CONFIDENCE_DATA_PATH
    );

  if (
    !learningSource.exists &&
    !confidenceSource.exists
  ) {

    return null;

  }

  const learningData =
    learningSource.value;

  const confidenceData =
    confidenceSource.value;

  if (
    learningSource.exists &&
    !isPlainObject(
      learningData
    )
  ) {

    throw new Error(
      "data/learning-data.json must contain a JSON object."
    );

  }

  if (
    confidenceSource.exists &&
    !isPlainObject(
      confidenceData
    )
  ) {

    throw new Error(
      "data/confidence-data.json must contain a JSON object."
    );

  }

  if (
    isPlainObject(
      learningData
    ) &&
    isPlainObject(
      learningData.learning
    )
  ) {

    return {
      ...learningData,

      confidence:
        isPlainObject(
          learningData.confidence
        )
          ? learningData.confidence
          : (
              isPlainObject(
                confidenceData?.confidence
              )
                ? confidenceData.confidence
                : {}
            )
    };

  }

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
      toISOStringOrNull(
        learningData?.exportedAt ??
        confidenceData?.exportedAt
      ) ||
      new Date().toISOString(),

    metadata: {
      ...(
        isPlainObject(
          learningData?.metadata
        )
          ? learningData.metadata
          : {}
      ),

      importedFromLegacyFiles:
        true
    }
  };

}

function countExistingLearningSignals(
  existingExport
) {

  const signals =
    getNestedValue(
      existingExport,
      [
        "learning",
        "signals"
      ]
    );

  return Array.isArray(
    signals
  )
    ? signals.length
    : 0;

}

function loadAutonomousConfig() {

  const source =
    readJSONStrictIfExists(
      AUTONOMOUS_CONFIG_PATH
    );

  if (
    !source.exists
  ) {

    return null;

  }

  if (
    !isPlainObject(
      source.value
    )
  ) {

    throw new Error(
      "data/autonomous-config.json must contain a JSON object."
    );

  }

  return source.value;

}

function resolveLearningStartAt({
  state,
  existingExport,
  history,
  autonomousConfig
}) {

  const environmentValue =
    firstNonEmptyString(
      process.env
        .PIPSIGHT_LEARNING_START_AT
    );

  const configuredValue =
    firstNonEmptyString(
      autonomousConfig
        ?.learningEligibility
        ?.learningStartAt,
      autonomousConfig
        ?.learningEligibility
        ?.freshDataStartAt
    );

  const stateValue =
    firstNonEmptyString(
      state?.learningStartAt
    );

  const explicitValue =
    environmentValue ||
    configuredValue ||
    stateValue;

  if (
    explicitValue
  ) {

    const normalized =
      toISOStringOrNull(
        explicitValue
      );

    if (
      !normalized
    ) {

      throw new Error(
        "Configured learningStartAt is not a valid timestamp."
      );

    }

    return {
      learningStartAt:
        normalized,

      source:
        environmentValue
          ? "environment"
          : configuredValue
            ? "autonomous-config"
            : "state",

      detectedFreshReset:
        false
    };

  }

  /*
   * Safe fresh-reset detection:
   * - both generated output files already exist,
   * - the export contains zero signals,
   * - state contains no processed identities,
   * - history still contains older closed records.
   *
   * A first installation with no generated files does NOT activate this rule,
   * so historical imports remain backward compatible.
   */
  const generatedEmptyExport =
    Boolean(
      existingExport &&
      fs.existsSync(
        LEARNING_DATA_PATH
      ) &&
      fs.existsSync(
        CONFIDENCE_DATA_PATH
      ) &&
      countExistingLearningSignals(
        existingExport
      ) === 0 &&
      (
        state?.processedTradeKeys
          ?.length || 0
      ) === 0 &&
      Object.keys(
        state?.processedTradeVersions ||
        {}
      ).length === 0 &&
      (
        history?.closed?.length || 0
      ) > 0
    );

  if (
    generatedEmptyExport
  ) {

    const detected =
      toISOStringOrNull(
        existingExport.exportedAt
      ) ||
      toISOStringOrNull(
        state?.createdAt
      );

    if (
      detected
    ) {

      return {
        learningStartAt:
          detected,

        source:
          "detected-generated-empty-reset",

        detectedFreshReset:
          true
      };

    }

  }

  return {
    learningStartAt:
      null,

    source:
      null,

    detectedFreshReset:
      false
  };

}

// -----------------------------------------------------------------------------
// Cross-file transaction recovery
// -----------------------------------------------------------------------------

function createLearnerExportHash(
  learnerExport
) {

  const learning =
    isPlainObject(
      learnerExport?.learning
    )
      ? JSON.parse(
          JSON.stringify(
            learnerExport.learning
          )
        )
      : {};

  const confidence =
    isPlainObject(
      learnerExport?.confidence
    )
      ? JSON.parse(
          JSON.stringify(
            learnerExport.confidence
          )
        )
      : {};

  /*
   * MemoryManager refreshes operational timestamps during import/export and
   * may mark legacy signals as repaired. These fields do not change learned
   * evidence, so they must not force a full output/policy rewrite.
   */
  delete learning.updatedAt;

  if (
    isPlainObject(
      learning.stats
    )
  ) {

    delete learning.stats.updatedAt;

  }

  delete confidence.updatedAt;

  if (
    Array.isArray(
      learning.signals
    )
  ) {

    for (
      const signal of learning.signals
    ) {

      if (
        isPlainObject(
          signal?.autonomousLearning
        )
      ) {

        delete signal
          .autonomousLearning
          .repaired;

      }

    }

  }

  const payload = {
    learning,
    confidence
  };

  return createHash(
    JSON.stringify(
      payload
    )
  );

}

function createPendingTransaction(
  learnerExport,
  successfulResults
) {

  const tradeVersions =
    (
      Array.isArray(
        successfulResults
      )
        ? successfulResults
        : []
    )
      .filter(
        result =>
          Boolean(
            toTrimmedString(
              result?.tradeKey
            )
          )
      )
      .map(
        result => ({
          tradeKey:
            toTrimmedString(
              result.tradeKey
            ),

          resolutionHash:
            toTrimmedString(
              result.resolutionHash
            ) || null,

          revision:
            Math.max(
              1,
              toNonNegativeInteger(
                result.revision,
                1
              )
            ),

          processedAt:
            toISOStringOrNull(
              result.processedAt
            ) ||
            new Date().toISOString(),

          closedAt:
            toISOStringOrNull(
              result.closedAt
            ),

          outcome:
            normalizeOutcome(
              result.outcome
            ),

          historyRecordId:
            firstNonEmptyString(
              result.historyRecordId
            )
        }));

  return {
    version:
      AUTONOMOUS_SCHEMA_VERSION,

    createdAt:
      new Date().toISOString(),

    exportHash:
      createLearnerExportHash(
        learnerExport
      ),

    tradeKeys:
      uniqueSortedStrings(
        tradeVersions.map(
          item =>
            item.tradeKey
        )
      ),

    tradeVersions
  };

}

function recoverPendingTransaction(
  state,
  existingExport
) {

  const pending =
    normalizePendingTransaction(
      state?.pendingTransaction
    );

  if (
    !pending
  ) {

    return {
      recovered:
        false,

      matched:
        false,

      committedKeys:
        0,

      committedVersions:
        0
    };

  }

  const expectedHash =
    toTrimmedString(
      pending.exportHash
    );

  const currentHash =
    existingExport
      ? createLearnerExportHash(
          existingExport
        )
      : null;

  let committedKeys =
    0;

  let committedVersions =
    0;

  if (
    expectedHash &&
    currentHash ===
      expectedHash
  ) {

    saveLearnerExport(
      existingExport
    );

    const commitResult =
      commitProcessedTradeKeys(
        state,
        pending.tradeVersions
      );

    committedKeys =
      commitResult.addedKeys;

    committedVersions =
      commitResult.updatedVersions;

  }

  state.pendingTransaction =
    null;

  return {
    recovered:
      true,

    matched:
      Boolean(
        expectedHash &&
        currentHash ===
          expectedHash
      ),

    committedKeys,

    committedVersions
  };

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

  const nowTimestamp =
    Date.now();

  if (
    openedAt &&
    new Date(
      openedAt
    ).getTime() >
      nowTimestamp +
      FUTURE_TIMESTAMP_TOLERANCE_MS
  ) {

    errors.push(
      "openedAt timestamp is in the future."
    );

  }

  if (
    closedAt &&
    new Date(
      closedAt
    ).getTime() >
      nowTimestamp +
      FUTURE_TIMESTAMP_TOLERANCE_MS
  ) {

    errors.push(
      "closedAt timestamp is in the future."
    );

  }

  if (
    entry !== null &&
    entry <= 0
  ) {

    errors.push(
      "Entry price must be greater than zero."
    );

  }

  if (
    stopLoss !== null &&
    stopLoss <= 0
  ) {

    errors.push(
      "Stop-loss price must be greater than zero."
    );

  }

  if (
    takeProfit !== null &&
    takeProfit <= 0
  ) {

    errors.push(
      "Take-profit price must be greater than zero."
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


function extractTradeContext(
  normalizedTrade,
  richRecord = null
) {

  const raw =
    isPlainObject(
      normalizedTrade?.raw
    )
      ? normalizedTrade.raw
      : {};

  const snapshot =
    isPlainObject(
      richRecord?.snapshot
    )
      ? richRecord.snapshot
      : {};

  const tradePlan =
    isPlainObject(
      snapshot.tradePlan
    )
      ? snapshot.tradePlan
      : (
          isPlainObject(
            snapshot.plan
          )
            ? snapshot.plan
            : {}
        );

  return {
    historyRecordId:
      firstNonEmptyString(
        raw.historyRecordId,
        raw.recordId,
        richRecord?.id
      ),

    fingerprint:
      firstNonEmptyString(
        raw.fingerprint,
        richRecord?.fingerprint
      ),

    source:
      firstNonEmptyString(
        raw.source,
        richRecord?.source,
        snapshot.source,
        "analysis-history.closed"
      ),

    reason:
      firstNonEmptyString(
        raw.reason,
        richRecord?.reason,
        snapshot.reason
      ),

    correctionReason:
      firstNonEmptyString(
        raw.correctionReason,
        raw.revisionReason,
        richRecord?.correctionReason,
        richRecord?.revisionReason
      ),

    session:
      firstNonEmptyString(
        raw.session,
        raw.marketSession,
        richRecord?.session,
        richRecord?.marketSession,
        snapshot.session,
        snapshot.marketSession
      ),

    pattern:
      firstNonEmptyString(
        raw.pattern,
        raw.patternName,
        richRecord?.pattern,
        richRecord?.patternName,
        snapshot.pattern,
        snapshot.patternName
      ),

    marketRegime:
      firstNonEmptyString(
        raw.marketRegime,
        raw.regime,
        richRecord?.marketRegime,
        richRecord?.regime,
        snapshot.marketRegime,
        snapshot.regime
      ),

    marketState:
      firstNonEmptyString(
        raw.marketState,
        richRecord?.marketState,
        snapshot.marketState
      ),

    exitReason:
      firstNonEmptyString(
        raw.exitReason,
        raw.resolutionReason,
        richRecord?.exitReason,
        richRecord?.resolutionReason
      ),

    qualityGrade:
      firstNonEmptyString(
        raw.qualityGrade,
        richRecord?.qualityGrade,
        snapshot.qualityGrade
      ),

    highestTargetReached:
      firstFiniteNumber(
        raw.highestTargetReached,
        richRecord?.highestTargetReached,
        snapshot.highestTargetReached
      ),

    mfeR:
      firstFiniteNumber(
        raw.mfeR,
        richRecord?.mfeR,
        snapshot.mfeR
      ),

    maeR:
      firstFiniteNumber(
        raw.maeR,
        richRecord?.maeR,
        snapshot.maeR
      ),

    atr:
      firstFiniteNumber(
        raw.atr,
        richRecord?.atr,
        snapshot.atr,
        tradePlan.atr
      )
  };

}

// -----------------------------------------------------------------------------
// Learner payload mapping
// -----------------------------------------------------------------------------

function buildLearnerOutcomePayload(
  normalizedTrade,
  richRecord = null,
  options = {}
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

  const indicatorSnapshot =
    extractIndicators(
      richRecord
    );

  const context =
    extractTradeContext(
      normalizedTrade,
      richRecord
    );

  const closePrice =
    calculateResolvedClosePrice(
      normalizedTrade,
      richRecord
    );

  const profitPoints =
    calculateProfitPoints(
      normalizedTrade,
      closePrice
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

    closePrice,

    profitPoints,

    engine:
      normalizedTrade.engine,

    source:
      context.source,

    sourceTradeKey:
      firstNonEmptyString(
        options.tradeKey
      ),

    sourceResolutionHash:
      firstNonEmptyString(
        options.resolutionHash
      ),

    correction:
      options.correction === true,

    corrected:
      options.correction === true,

    revision:
      Math.max(
        1,
        toNonNegativeInteger(
          options.revision,
          1
        )
      ),

    correctionReason:
      firstNonEmptyString(
        options.correctionReason,
        context.correctionReason,
        options.correction === true
          ? "Historical resolution changed for the same immutable trade identity."
          : null
      ),

    autonomousLearning: {
      schemaVersion:
        AUTONOMOUS_SCHEMA_VERSION,

      runnerVersion:
        ENGINE_VERSION,

      immutableIdentity:
        firstNonEmptyString(
          options.tradeKey
        ),

      resolutionHash:
        firstNonEmptyString(
          options.resolutionHash
        ),

      revision:
        Math.max(
          1,
          toNonNegativeInteger(
            options.revision,
            1
          )
        ),

      correction:
        options.correction === true,

      migrationReplay:
        options.migrationReplay === true,

      chronological:
        true,

      futureLeakageProtected:
        true,

      advisoryOnly:
        true,

      liveAuthorityPermitted:
        false
    }
  };

  if (
    context.historyRecordId
  ) {

    payload.historyRecordId =
      context.historyRecordId;

  }

  if (
    context.fingerprint
  ) {

    payload.fingerprint =
      context.fingerprint;

  }

  for (
    const field of [
      "reason",
      "session",
      "pattern",
      "marketRegime",
      "marketState",
      "exitReason",
      "qualityGrade"
    ]
  ) {

    if (
      context[field]
    ) {

      payload[field] =
        context[field];

    }

  }

  for (
    const field of [
      "highestTargetReached",
      "mfeR",
      "maeR",
      "atr"
    ]
  ) {

    if (
      context[field] !== null
    ) {

      payload[field] =
        context[field];

    }

  }

  if (
    risk !== null
  ) {

    payload.risk =
      risk;

    payload.initialRisk =
      risk;

    payload.initialRiskPoints =
      risk;

  }

  if (
    reward !== null
  ) {

    payload.reward =
      reward;

    payload.plannedReward =
      reward;

    payload.plannedRewardPoints =
      reward;

  }

  if (
    riskReward !== null
  ) {

    payload.riskReward =
      riskReward;

    payload.rr =
      riskReward;

    payload.plannedRiskReward =
      riskReward;

  }

  if (
    risk !== null &&
    profitPoints !== null &&
    risk > 0
  ) {

    payload.realizedR =
      Number(
        (
          profitPoints /
          risk
        ).toFixed(
          8
        )
      );

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

  const indicatorNames =
    uniqueSortedStrings([
      (
        indicatorSnapshot.rsi !==
          undefined
          ? "RSI"
          : null
      ),
      (
        indicatorSnapshot.macd !==
          undefined ||
        indicatorSnapshot.macdSignal !==
          undefined ||
        indicatorSnapshot.macdHistogram !==
          undefined
          ? "MACD"
          : null
      )
    ]);

  if (
    Object.keys(
      indicatorSnapshot
    ).length >
      0
  ) {

    payload.indicators =
      indicatorNames;

    payload.indicatorSnapshot =
      indicatorSnapshot;

    for (
      const [
        key,
        value
      ] of Object.entries(
        indicatorSnapshot
      )
    ) {

      if (
        toFiniteNumber(
          value
        ) !== null
      ) {

        payload[key] =
          value;

      }

    }

  }

  return payload;

}

// -----------------------------------------------------------------------------
// Closed history preparation
// -----------------------------------------------------------------------------

function prepareClosedHistory(
  history,
  state,
  options = {}
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

  const processedVersions =
    isPlainObject(
      state?.processedTradeVersions
    )
      ? state.processedTradeVersions
      : {};

  const learningStartAt =
    toISOStringOrNull(
      options.learningStartAt ??
      state?.learningStartAt
    );

  const learningStartTimestamp =
    learningStartAt
      ? new Date(
          learningStartAt
        ).getTime()
      : null;

  const richRecordIndex =
    buildRichRecordIndex(
      history
    );

  const accepted =
    [];

  const duplicates =
    [];

  const cutoffSkipped =
    [];

  const invalid =
    [];

  const seenThisRun =
    new Map();

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

    if (
      learningStartTimestamp !== null &&
      new Date(
        normalizedTrade.openedAt
      ).getTime() <
        learningStartTimestamp
    ) {

      cutoffSkipped.push({
        index,

        pair:
          normalizedTrade.pair,

        strategy:
          normalizedTrade.strategy,

        timeframe:
          normalizedTrade.timeframe,

        direction:
          normalizedTrade.direction,

        openedAt:
          normalizedTrade.openedAt,

        closedAt:
          normalizedTrade.closedAt,

        learningStartAt
      });

      continue;

    }

    const richRecord =
      findMatchingRichRecord(
        normalizedTrade,
        richRecordIndex
      );

    const tradeKey =
      createTradeKey({
        ...normalizedTrade.raw,

        strategy:
          normalizedTrade.strategy,

        timeframe:
          normalizedTrade.timeframe,

        openedAt:
          normalizedTrade.openedAt
      });

    const resolutionHash =
      createTradeResolutionHash(
        normalizedTrade,
        richRecord
      );

    const withinRunVersion =
      seenThisRun.get(
        tradeKey
      );

    if (
      withinRunVersion
    ) {

      if (
        withinRunVersion ===
          resolutionHash
      ) {

        duplicates.push({
          index,
          tradeKey,
          resolutionHash,
          reason:
            "DUPLICATE_WITHIN_CURRENT_HISTORY",
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

      } else {

        invalid.push({
          index,
          pair:
            normalizedTrade.pair,
          engine:
            normalizedTrade.engine,
          openedAt:
            normalizedTrade.openedAt,
          closedAt:
            normalizedTrade.closedAt,
          errors: [
            "Conflicting resolutions share the same immutable trade identity within analysis history."
          ]
        });

      }

      continue;

    }

    seenThisRun.set(
      tradeKey,
      resolutionHash
    );

    const previousVersion =
      isPlainObject(
        processedVersions[
          tradeKey
        ]
      )
        ? processedVersions[
            tradeKey
          ]
        : null;

    if (
      previousVersion &&
      previousVersion.resolutionHash ===
        resolutionHash
    ) {

      duplicates.push({
        index,
        tradeKey,
        resolutionHash,
        reason:
          "UNCHANGED_RESOLUTION",
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

    const correction =
      Boolean(
        previousVersion &&
        previousVersion.resolutionHash &&
        previousVersion.resolutionHash !==
          resolutionHash
      );

    const migrationReplay =
      Boolean(
        !previousVersion &&
        processedKeys.has(
          tradeKey
        )
      );

    const revision =
      correction
        ? Math.max(
            2,
            toNonNegativeInteger(
              previousVersion.revision,
              1
            ) + 1
          )
        : 1;

    const learnerPayload =
      buildLearnerOutcomePayload(
        normalizedTrade,
        richRecord,
        {
          tradeKey,
          resolutionHash,
          correction,
          revision,
          migrationReplay,
          correctionReason:
            firstNonEmptyString(
              normalizedTrade.raw
                ?.correctionReason,
              richRecord
                ?.correctionReason,
              correction
                ? "Resolution hash changed for the same immutable opening identity."
                : null
            )
        }
      );

    accepted.push({
      index,
      tradeKey,
      resolutionHash,
      revision,
      correction,
      migrationReplay,
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

  accepted.sort(
    (
      left,
      right
    ) =>
      (
        left.normalizedTrade.closedAt ||
        ""
      ).localeCompare(
        right.normalizedTrade.closedAt ||
        ""
      ) ||
      (
        left.normalizedTrade.openedAt ||
        ""
      ).localeCompare(
        right.normalizedTrade.openedAt ||
        ""
      ) ||
      left.tradeKey.localeCompare(
        right.tradeKey
      )
  );

  return {
    historyRecordsSeen:
      closedRecords.length,

    accepted,

    duplicates,

    cutoffSkipped,

    invalid,

    richRecordCount:
      richRecordIndex.records.length,

    learningStartAt
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

      resolutionHash:
        preparedTrade.resolutionHash,

      revision:
        preparedTrade.revision,

      correction:
        preparedTrade.correction ===
          true,

      migrationReplay:
        preparedTrade.migrationReplay ===
          true,

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

      resolutionHash:
        preparedTrade?.resolutionHash ?? null,

      revision:
        preparedTrade?.revision ?? null,

      correction:
        preparedTrade?.correction ===
          true,

      migrationReplay:
        preparedTrade?.migrationReplay ===
          true,

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

  const versions =
    normalizeProcessedTradeVersions(
      state?.processedTradeVersions
    );

  let addedKeys =
    0;

  let updatedVersions =
    0;

  for (
    const result of (
      Array.isArray(
        successfulResults
      )
        ? successfulResults
        : []
    )
  ) {

    const tradeKey =
      toTrimmedString(
        result?.tradeKey
      );

    if (
      !tradeKey
    ) {

      continue;

    }

    if (
      !existing.has(
        tradeKey
      )
    ) {

      existing.add(
        tradeKey
      );

      addedKeys +=
        1;

    }

    const resolutionHash =
      toTrimmedString(
        result?.resolutionHash
      ) || null;

    const previous =
      versions[
        tradeKey
      ];

    if (
      !previous ||
      previous.resolutionHash !==
        resolutionHash ||
      previous.revision !==
        Math.max(
          1,
          toNonNegativeInteger(
            result?.revision,
            1
          )
        )
    ) {

      versions[
        tradeKey
      ] = {
        resolutionHash,

        revision:
          Math.max(
            1,
            toNonNegativeInteger(
              result?.revision,
              1
            )
          ),

        processedAt:
          toISOStringOrNull(
            result?.processedAt
          ) ||
          new Date().toISOString(),

        closedAt:
          toISOStringOrNull(
            result?.closedAt
          ),

        outcome:
          normalizeOutcome(
            result?.outcome
          ),

        historyRecordId:
          firstNonEmptyString(
            result?.richRecordId,
            result?.historyRecordId
          )
      };

      updatedVersions +=
        1;

    }

  }

  state.processedTradeKeys =
    Array.from(
      existing
    )
      .slice(
        -MAX_PROCESSED_TRADE_KEYS
      );

  state.processedTradeVersions =
    normalizeProcessedTradeVersions(
      versions
    );

  return {
    addedKeys,
    updatedVersions
  };

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

    correctionRecords:
      0,

    migrationReplayRecords:
      0,

    duplicateRecords:
      0,

    cutoffSkippedRecords:
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

    sourceHistoryHash:
      null,

    learningStartAt:
      state.learningStartAt ||
      null,

    learningStartSource:
      state.learningStartSource ||
      null,

    pendingRecovery:
      null,

    downstream:
      null,

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

  const accepted =
    Array.isArray(
      prepared?.accepted
    )
      ? prepared.accepted
      : [];

  const duplicateRecords =
    Array.isArray(
      prepared?.duplicates
    )
      ? prepared.duplicates.length
      : 0;

  const cutoffSkippedRecords =
    Array.isArray(
      prepared?.cutoffSkipped
    )
      ? prepared.cutoffSkipped.length
      : 0;

  const invalidRecords =
    Array.isArray(
      prepared?.invalid
    )
      ? prepared.invalid.length
      : 0;

  const correctionRecords =
    accepted.filter(
      item =>
        item.correction ===
          true
    ).length;

  const migrationReplayRecords =
    accepted.filter(
      item =>
        item.migrationReplay ===
          true
    ).length;

  const richRecordCount =
    toFiniteNumber(
      prepared?.richRecordCount
    ) || 0;

  const richRecordsMatched =
    accepted.filter(
      item =>
        item.richRecordMatched
    ).length;

  state.lastRun.historyRecordsSeen =
    historyRecordsSeen;

  state.lastRun.acceptedRecords =
    accepted.length;

  state.lastRun.correctionRecords =
    correctionRecords;

  state.lastRun.migrationReplayRecords =
    migrationReplayRecords;

  state.lastRun.duplicateRecords =
    duplicateRecords;

  state.lastRun.cutoffSkippedRecords =
    cutoffSkippedRecords;

  state.lastRun.invalidRecords =
    invalidRecords;

  state.lastRun.skippedRecords =
    duplicateRecords +
    cutoffSkippedRecords +
    invalidRecords;

  state.lastRun.richRecordCount =
    richRecordCount;

  state.lastRun.richRecordsMatched =
    richRecordsMatched;

  state.lastRun.learningStartAt =
    prepared?.learningStartAt ||
    state.learningStartAt ||
    null;

  addNumericCounter(
    state.totals,
    "historyRecordsSeen",
    historyRecordsSeen
  );

  addNumericCounter(
    state.totals,
    "acceptedRecords",
    accepted.length
  );

  addNumericCounter(
    state.totals,
    "correctionRecords",
    correctionRecords
  );

  addNumericCounter(
    state.totals,
    "migrationReplayRecords",
    migrationReplayRecords
  );

  addNumericCounter(
    state.totals,
    "duplicateRecords",
    duplicateRecords
  );

  addNumericCounter(
    state.totals,
    "cutoffSkippedRecords",
    cutoffSkippedRecords
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
    cutoffSkippedRecords +
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

  const cutoffSkipped =
    Array.isArray(
      prepared?.cutoffSkipped
    )
      ? prepared.cutoffSkipped
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

    legacyEngineVersion:
      LEGACY_ENGINE_VERSION,

    autonomousSchemaVersion:
      AUTONOMOUS_SCHEMA_VERSION,

    success:
      state?.lastRun?.success ===
        true,

    startedAt:
      state?.lastRun?.startedAt ??
      null,

    completedAt:
      state?.lastRun?.completedAt ??
      null,

    historyRecordsSeen:
      prepared?.historyRecordsSeen ??
      0,

    acceptedRecords:
      prepared?.accepted?.length ??
      0,

    learnedRecords:
      successful.length,

    correctionRecords:
      successful.filter(
        item =>
          item.correction ===
            true
      ).length,

    migrationReplayRecords:
      successful.filter(
        item =>
          item.migrationReplay ===
            true
      ).length,

    duplicateRecords:
      duplicates.length,

    cutoffSkippedRecords:
      cutoffSkipped.length,

    invalidRecords:
      invalid.length,

    failedRecords:
      failed.length,

    learningStartAt:
      state?.learningStartAt ??
      null,

    learningStartSource:
      state?.learningStartSource ??
      null,

    sourceHistoryHash:
      state?.lastRun
        ?.sourceHistoryHash ??
      null,

    richRecordCount:
      prepared?.richRecordCount ??
      0,

    richRecordsMatched:
      prepared?.accepted?.filter(
        item =>
          item.richRecordMatched
      ).length ??
      0,

    processedTradeKeyCount:
      Array.isArray(
        state?.processedTradeKeys
      )
        ? state.processedTradeKeys.length
        : 0,

    processedTradeVersionCount:
      Object.keys(
        state?.processedTradeVersions ||
        {}
      ).length,

    persisted:
      Boolean(
        persistenceResult
      ),

    downstream:
      state?.lastRun
        ?.downstream ??
      null,

    output:
      persistenceResult
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

          resolutionHash:
            item.resolutionHash,

          revision:
            item.revision,

          correction:
            item.correction,

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

// -----------------------------------------------------------------------------
// Console output helpers
// -----------------------------------------------------------------------------

function logRunHeader() {

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

}

function logRunSummary(
  summary
) {

  console.log(
    ""
  );

  console.log(
    "[learning-engine] Run summary"
  );

  console.log(
    `  Success: ${summary.success ? "YES" : "NO"}`
  );

  console.log(
    `  History records: ${summary.historyRecordsSeen}`
  );

  console.log(
    `  Accepted records: ${summary.acceptedRecords}`
  );

  console.log(
    `  Learned records: ${summary.learnedRecords}`
  );

  console.log(
    `  Corrected records: ${summary.correctionRecords}`
  );

  console.log(
    `  Migration replays: ${summary.migrationReplayRecords}`
  );

  console.log(
    `  Duplicate records: ${summary.duplicateRecords}`
  );

  console.log(
    `  Pre-cutoff records: ${summary.cutoffSkippedRecords}`
  );

  console.log(
    `  Invalid records: ${summary.invalidRecords}`
  );

  console.log(
    `  Failed records: ${summary.failedRecords}`
  );

  console.log(
    `  Rich records available: ${summary.richRecordCount}`
  );

  console.log(
    `  Rich records matched: ${summary.richRecordsMatched}`
  );

  console.log(
    `  Total processed keys: ${summary.processedTradeKeyCount}`
  );

  console.log(
    `  Resolution versions: ${summary.processedTradeVersionCount}`
  );

  if (
    summary.learningStartAt
  ) {

    console.log(
      `  Learning cutoff: ${summary.learningStartAt} (${summary.learningStartSource || "unknown"})`
    );

  }

  if (
    summary.downstream
  ) {

    console.log(
      `  Downstream pipeline: ${summary.downstream.success === false ? "FAILED" : summary.downstream.enabled === false ? "DISABLED" : "PASS"}`
    );

  }

  if (
    summary.output
  ) {

    console.log(
      `  Learning data: ${summary.output.learningData}`
    );

    console.log(
      `  Confidence data: ${summary.output.confidenceData}`
    );

    console.log(
      `  Runner state: ${summary.output.state}`
    );

  }

  if (
    Array.isArray(
      summary.invalid
    ) &&
    summary.invalid.length > 0
  ) {

    console.warn(
      ""
    );

    console.warn(
      "[learning-engine] Invalid history records:"
    );

    for (
      const item of summary.invalid
    ) {

      console.warn(
        `  - Index ${item.index}: ${item.errors.join(
          "; "
        )}`
      );

    }

  }

  if (
    Array.isArray(
      summary.failures
    ) &&
    summary.failures.length > 0
  ) {

    console.warn(
      ""
    );

    console.warn(
      "[learning-engine] Learner failures:"
    );

    for (
      const failure of summary.failures
    ) {

      console.warn(
        `  - Index ${failure.index}, ${failure.pair || "unknown pair"}: ${failure.error}`
      );

    }

  }

  console.log(
    ""
  );

  console.log(
    `Completed: ${summary.completedAt || new Date().toISOString()}`
  );

  console.log(
    "============================================================"
  );

  console.log(
    ""
  );

}

// -----------------------------------------------------------------------------
// Safe state persistence
// -----------------------------------------------------------------------------

function trySaveLearningState(
  state
) {

  try {

    return {
      success:
        true,

      state:
        saveLearningState(
          state
        ),

      error:
        null
    };

  } catch (
    error
  ) {

    console.error(
      "[learning-engine] Failed to save learning-engine state."
    );

    console.error(
      `[learning-engine] ${
        error instanceof Error
          ? error.message
          : String(
              error
            )
      }`
    );

    return {
      success:
        false,

      state,

      error
    };

  }

}


// -----------------------------------------------------------------------------
// Autonomous downstream pipeline
// -----------------------------------------------------------------------------

function shouldRunDownstreamPipeline(
  options = {}
) {

  if (
    options.runDownstream ===
      false
  ) {

    return false;

  }

  const explicitSkip =
    parseBooleanEnvironment(
      process.env[
        SKIP_DOWNSTREAM_PIPELINE_ENV
      ],
      false
    );

  if (
    explicitSkip ===
      true
  ) {

    return false;

  }

  const explicitRun =
    parseBooleanEnvironment(
      process.env[
        DOWNSTREAM_PIPELINE_ENV
      ],
      null
    );

  if (
    explicitRun !==
      null
  ) {

    return explicitRun;

  }

  return true;

}

function invokePipelineModule({
  label,
  modulePath,
  exportName,
  required
}) {

  if (
    !fs.existsSync(
      modulePath
    )
  ) {

    if (
      required
    ) {

      throw new Error(
        `${label} module is missing: ${path.relative(
          ROOT_DIR,
          modulePath
        )}`
      );

    }

    return {
      label,
      status:
        "SKIPPED_MISSING_MODULE",
      required:
        false,
      result:
        null
    };

  }

  delete require.cache[
    require.resolve(
      modulePath
    )
  ];

  const moduleApi =
    require(
      modulePath
    );

  const runner =
    moduleApi?.[
      exportName
    ];

  if (
    typeof runner !==
      "function"
  ) {

    throw new Error(
      `${label} does not export ${exportName}().`
    );

  }

  const result =
    runner();

  const status =
    firstNonEmptyString(
      result?.status,
      result?.success ===
        false
        ? "FAILED"
        : null,
      "COMPLETED"
    );

  if (
    status ===
      "FAILED" ||
    result?.success ===
      false
  ) {

    throw new Error(
      `${label} failed: ${
        firstNonEmptyString(
          result?.error,
          result?.message
        ) ||
        "unknown downstream error"
      }`
    );

  }

  return {
    label,
    status,
    required:
      Boolean(
        required
      ),
    result:
      result ?? null
  };

}

function runAdaptiveDownstreamPipeline(
  options = {}
) {

  const startedAt =
    new Date().toISOString();

  if (
    !shouldRunDownstreamPipeline(
      options
    )
  ) {

    return {
      enabled:
        false,

      success:
        true,

      startedAt,

      completedAt:
        new Date().toISOString(),

      stages:
        [],

      warnings: [
        "Autonomous downstream pipeline was explicitly disabled."
      ]
    };

  }

  const stages =
    [];

  const warnings =
    [];

  const enrichmentStage =
    invokePipelineModule({
      label:
        "Learning Enrichment",
      modulePath:
        LEARNING_ENRICHMENT_MODULE_PATH,
      exportName:
        "runLearningEnrichment",
      required:
        false
    });

  stages.push(
    enrichmentStage
  );

  if (
    enrichmentStage.status ===
      "SKIPPED_MISSING_MODULE"
  ) {

    warnings.push(
      "learning-enrichment.js is unavailable; AI Memory will run without optional enrichment."
    );

  }

  stages.push(
    invokePipelineModule({
      label:
        "AI Memory",
      modulePath:
        AI_MEMORY_MODULE_PATH,
      exportName:
        "runAIMemory",
      required:
        true
    })
  );

  stages.push(
    invokePipelineModule({
      label:
        "AI Policy Engine",
      modulePath:
        AI_POLICY_MODULE_PATH,
      exportName:
        "runAIPolicyEngine",
      required:
        true
    })
  );

  return {
    enabled:
      true,

    success:
      true,

    startedAt,

    completedAt:
      new Date().toISOString(),

    stages,

    warnings:
      uniqueSortedStrings(
        warnings
      )
  };

}

// -----------------------------------------------------------------------------
// Full learning engine orchestration
// -----------------------------------------------------------------------------

function runLearningEngine(
  options = {}
) {

  logRunHeader();

  ensureDirectory(
    DATA_DIR
  );

  let state =
    loadLearningState();

  state =
    beginLearningRun(
      state
    );

  let history =
    null;

  let prepared = {
    historyRecordsSeen:
      0,

    accepted:
      [],

    duplicates:
      [],

    cutoffSkipped:
      [],

    invalid:
      [],

    richRecordCount:
      0,

    learningStartAt:
      state.learningStartAt ||
      null
  };

  let processing = {
    attempted:
      0,

    successful:
      [],

    failed:
      []
  };

  let persistenceResult =
    null;

  let learner =
    null;

  let fatalError =
    null;

  try {

    history =
      loadAnalysisHistory();

    state.lastHistoryUpdatedAt =
      history.updatedAt ||
      state.lastHistoryUpdatedAt ||
      null;

    const historyHash =
      createFileContentHash(
        ANALYSIS_HISTORY_PATH
      );

    if (
      !historyHash
    ) {

      throw new Error(
        "Unable to calculate analysis-history.json source hash."
      );

    }

    state.sourceHashes.analysisHistory =
      historyHash;

    state.lastRun.sourceHistoryHash =
      historyHash;

    console.log(
      `[learning-engine] Loaded ${history.closed.length} closed history records.`
    );

    const existingExport =
      loadExistingLearningExport();

    const recovery =
      recoverPendingTransaction(
        state,
        existingExport
      );

    state.lastRun.pendingRecovery =
      recovery;

    if (
      recovery.recovered
    ) {

      console.warn(
        recovery.matched
          ? `[learning-engine] Recovered a completed learning transaction and committed ${recovery.committedKeys} trade keys / ${recovery.committedVersions} resolution versions.`
          : "[learning-engine] Cleared an incomplete learning transaction; affected trades will be retried."
      );

      const recoveryStateSave =
        trySaveLearningState(
          state
        );

      if (
        !recoveryStateSave.success
      ) {

        throw recoveryStateSave.error;

      }

      state =
        recoveryStateSave.state;

    }

    const autonomousConfig =
      loadAutonomousConfig();

    const cutoff =
      resolveLearningStartAt({
        state,
        existingExport,
        history:
          history.raw,
        autonomousConfig
      });

    if (
      cutoff.learningStartAt
    ) {

      state.learningStartAt =
        cutoff.learningStartAt;

      state.learningStartSource =
        cutoff.source;

      state.lastRun.learningStartAt =
        cutoff.learningStartAt;

      state.lastRun.learningStartSource =
        cutoff.source;

      if (
        cutoff.detectedFreshReset
      ) {

        console.warn(
          `[learning-engine] Fresh empty learning outputs detected. Learning cutoff locked at ${cutoff.learningStartAt}.`
        );

      } else {

        console.log(
          `[learning-engine] Learning cutoff: ${cutoff.learningStartAt} (${cutoff.source}).`
        );

      }

    } else {

      console.log(
        "[learning-engine] No learning cutoff configured; eligible historical records remain importable."
      );

    }

    learner =
      createLearner();

    if (
      existingExport
    ) {

      const importResult =
        importExistingLearningData(
          learner,
          existingExport
        );

      state.lastRun.importedExistingData =
        importResult.imported ===
          true;

      console.log(
        "[learning-engine] Existing learner data imported."
      );

    } else {

      state.lastRun.importedExistingData =
        false;

      console.log(
        "[learning-engine] No existing learner export found; starting from current learner state."
      );

    }

    prepared =
      prepareClosedHistory(
        history.raw,
        state,
        {
          learningStartAt:
            state.learningStartAt
        }
      );

    applyPreparationStats(
      state,
      prepared
    );

    console.log(
      `[learning-engine] Prepared ${prepared.accepted.length} new/revised records.`
    );

    console.log(
      `[learning-engine] Skipped ${prepared.duplicates.length} unchanged duplicate records.`
    );

    console.log(
      `[learning-engine] Skipped ${prepared.cutoffSkipped.length} pre-cutoff records.`
    );

    console.log(
      `[learning-engine] Rejected ${prepared.invalid.length} invalid records.`
    );

    processing =
      processPreparedTrades(
        learner,
        prepared
      );

    applyProcessingStats(
      state,
      processing
    );

    console.log(
      `[learning-engine] Successfully learned ${processing.successful.length} records.`
    );

    if (
      processing.failed.length >
        0
    ) {

      console.warn(
        `[learning-engine] ${processing.failed.length} records failed during learner processing.`
      );

    }

    const learnerExport =
      exportLearnerData(
        learner
      );

    learnerExport.metadata = {
      ...(
        isPlainObject(
          learnerExport.metadata
        )
          ? learnerExport.metadata
          : {}
      ),

      runner:
        ENGINE_NAME,

      runnerVersion:
        ENGINE_VERSION,

      legacyRunnerVersion:
        LEGACY_ENGINE_VERSION,

      autonomousSchemaVersion:
        AUTONOMOUS_SCHEMA_VERSION,

      immutableIdentity:
        true,

      correctionAware:
        true,

      chronologicalProcessing:
        true,

      futureLeakageProtected:
        true,

      learningStartAt:
        state.learningStartAt ||
        null,

      learningStartSource:
        state.learningStartSource ||
        null,

      sourceHistoryHash:
        historyHash
    };

    const existingExportHash =
      existingExport
        ? createLearnerExportHash(
            existingExport
          )
        : null;

    const learnerExportHash =
      createLearnerExportHash(
        learnerExport
      );

    const learningOutputChanged =
      !existingExport ||
      existingExportHash !==
        learnerExportHash;

    state.lastRun.outputChanged =
      learningOutputChanged;

    if (
      learningOutputChanged
    ) {

      state.pendingTransaction =
        createPendingTransaction(
          learnerExport,
          processing.successful
        );

      const pendingStateSave =
        trySaveLearningState(
          state
        );

      if (
        !pendingStateSave.success
      ) {

        throw pendingStateSave.error;

      }

      state =
        pendingStateSave.state;

      persistenceResult =
        {
          ...saveLearnerExport(
            learnerExport
          ),

          changed:
            true,

          semanticHash:
            learnerExportHash
        };

    } else {

      persistenceResult = {
        learningPath:
          LEARNING_DATA_PATH,

        confidencePath:
          CONFIDENCE_DATA_PATH,

        exportedAt:
          toISOStringOrNull(
            existingExport?.exportedAt
          ),

        changed:
          false,

        semanticHash:
          learnerExportHash
      };

      console.log(
        "[learning-engine] Learning and confidence payloads are semantically unchanged; output rewrite skipped."
      );

    }

    const commitResult =
      commitProcessedTradeKeys(
        state,
        processing.successful
      );

    state.pendingTransaction =
      null;

    state.lastRun.persistedLearningData =
      Boolean(
        fs.existsSync(
          LEARNING_DATA_PATH
        ) &&
        fs.existsSync(
          CONFIDENCE_DATA_PATH
        )
      );

    state.sourceHashes.learningData =
      createFileContentHash(
        LEARNING_DATA_PATH
      );

    state.sourceHashes.confidenceData =
      createFileContentHash(
        CONFIDENCE_DATA_PATH
      );

    console.log(
      `[learning-engine] Committed ${commitResult.addedKeys} trade keys and ${commitResult.updatedVersions} resolution versions.`
    );

    /*
     * Commit the learning transaction before any downstream stage. A later
     * enrichment/memory/policy error must never make successfully persisted
     * learning appear uncommitted.
     */
    const committedStateSave =
      trySaveLearningState(
        state
      );

    if (
      !committedStateSave.success
    ) {

      throw committedStateSave.error;

    }

    state =
      committedStateSave.state;

    let downstream;

    try {

      downstream =
        runAdaptiveDownstreamPipeline(
          options
        );

      state.lastRun.downstream =
        downstream;

      if (
        downstream.enabled
      ) {

        addNumericCounter(
          state.totals,
          "downstreamRuns",
          1
        );

      }

    } catch (
      downstreamError
    ) {

      addNumericCounter(
        state.totals,
        "downstreamRuns",
        1
      );

      addNumericCounter(
        state.totals,
        "downstreamFailures",
        1
      );

      state.lastRun.downstream = {
        enabled:
          true,

        success:
          false,

        completedAt:
          new Date().toISOString(),

        error:
          downstreamError instanceof
            Error
            ? downstreamError.message
            : String(
                downstreamError
              )
      };

      throw downstreamError;

    }

    const runErrors =
      collectRunErrors(
        prepared,
        processing
      );

    const runSuccess =
      processing.failed.length ===
        0 &&
      prepared.invalid.length ===
        0 &&
      state.lastRun.downstream
        ?.success !==
        false;

    completeLearningRun(
      state,
      {
        success:
          runSuccess,

        historyUpdatedAt:
          history.updatedAt,

        errors:
          runErrors
      }
    );

    const stateSaveResult =
      trySaveLearningState(
        state
      );

    if (
      !stateSaveResult.success
    ) {

      throw stateSaveResult.error;

    }

    state =
      stateSaveResult.state;

  } catch (
    error
  ) {

    fatalError =
      error;

    state.lastRun.persistedLearningData =
      Boolean(
        persistenceResult
      ) ||
      state.lastRun.persistedLearningData ===
        true;

    const fatalSerialized =
      serializeError(
        error,
        "runLearningEngine"
      );

    const existingErrors =
      Array.isArray(
        state?.lastRun?.errors
      )
        ? state.lastRun.errors
        : [];

    completeLearningRun(
      state,
      {
        success:
          false,

        historyUpdatedAt:
          history?.updatedAt ??
          state.lastHistoryUpdatedAt ??
          null,

        errors: [
          ...existingErrors,
          {
            type:
              "fatal",

            ...fatalSerialized
          }
        ]
      }
    );

    trySaveLearningState(
      state
    );

  }

  const summary =
    buildRunSummary(
      state,
      prepared,
      processing,
      persistenceResult
    );

  if (
    fatalError
  ) {

    summary.success =
      false;

    summary.fatalError =
      serializeError(
        fatalError
      );

    console.error(
      ""
    );

    console.error(
      "[learning-engine] Fatal error:"
    );

    console.error(
      `[learning-engine] ${
        fatalError instanceof Error
          ? fatalError.message
          : String(
              fatalError
            )
      }`
    );

  }

  logRunSummary(
    summary
  );

  return summary;

}

// -----------------------------------------------------------------------------
// Process execution
// -----------------------------------------------------------------------------

function executeMain() {

  try {

    const summary =
      runLearningEngine();

    if (
      !summary.success
    ) {

      process.exitCode =
        1;

    }

  } catch (
    error
  ) {

    console.error(
      "[learning-engine] Unhandled execution error."
    );

    console.error(
      error instanceof Error
        ? error.stack || error.message
        : String(
            error
          )
    );

    process.exitCode =
      1;

  }

}

if (
  require.main === module
) {

  executeMain();

}

// -----------------------------------------------------------------------------
// CommonJS exports
// -----------------------------------------------------------------------------

module.exports = {
  ENGINE_NAME,
  ENGINE_VERSION,
  LEGACY_ENGINE_VERSION,
  AUTONOMOUS_SCHEMA_VERSION,
  STATE_VERSION,

  paths: {
    ROOT_DIR,
    DATA_DIR,
    ANALYSIS_HISTORY_PATH,
    LEARNING_DATA_PATH,
    CONFIDENCE_DATA_PATH,
    LEARNING_STATE_PATH,
    AUTONOMOUS_CONFIG_PATH,
    LEARNING_ENRICHMENT_MODULE_PATH,
    AI_MEMORY_MODULE_PATH,
    AI_POLICY_MODULE_PATH
  },

  runLearningEngine,
  executeMain,
  runAdaptiveDownstreamPipeline,
  shouldRunDownstreamPipeline,
  invokePipelineModule,

  readJSON,
  readJSONStrictIfExists,
  atomicWriteJSON,
  createHash,
  createFileContentHash,

  normalizePair,
  normalizeDirection,
  normalizeOutcome,
  normalizeEngineName,
  normalizeTimeframe,
  inferStrategyAndTimeframe,

  validateClosedTrade,
  buildLearnerOutcomePayload,
  prepareClosedHistory,
  extractTradeContext,

  buildTradeIdentitySource,
  createTradeKey,
  buildTradeResolutionSource,
  createTradeResolutionHash,
  calculateResolvedClosePrice,
  calculateProfitPoints,

  loadLearningState,
  saveLearningState,
  loadAnalysisHistory,
  loadExistingLearningExport,
  loadAutonomousConfig,
  resolveLearningStartAt,
  countExistingLearningSignals,

  createLearnerExportHash,
  createPendingTransaction,
  recoverPendingTransaction,

  createLearner,
  importExistingLearningData,
  exportLearnerData,
  saveLearnerExport,

  processAcceptedTrade,
  processPreparedTrades,
  commitProcessedTradeKeys,

  createEmptyState,
  normalizeState,
  normalizeProcessedTradeVersions,
  normalizePendingTransaction,
  beginLearningRun,
  completeLearningRun,

  buildRunSummary
};

