// ai-policy-engine.js
//
// PipSight Pro — Autonomous AI Policy Engine
//
// Purpose:
// - Read clean learning outputs, confidence summaries, AI Memory and the
//   autonomous control-plane configuration.
// - Build deterministic, versioned policy evidence for pair/timeframe/
//   engine/direction and optional market-context buckets.
// - Apply chronological out-of-sample validation, recency weighting,
//   Bayesian shrinkage, drawdown/stability analysis and strict authority
//   eligibility gates.
// - Produce policy only. This engine NEVER modifies a live signal, direction,
//   confidence, entry, stop or target. Live authority belongs to the separate
//   AI Decision Engine and immutable Safety Gate.
//
// Reads:
//   data/autonomous-config.json
//   data/learning-data.json
//   data/confidence-data.json
//   data/ai-memory.json
//   data/ai-policy.json              (optional existing output)
//   data/ai-policy-state.json        (optional existing state)
//
// Writes:
//   data/ai-policy.json
//   data/ai-policy-state.json
//
// Compatibility:
// - CommonJS / Node.js 20.
// - Existing learning, AI Memory and live-analysis schemas remain unchanged.
// - No external network calls.
// - No source-code modification.
// - Atomic writes, pending-transaction recovery and deterministic sorting.
// - Missing optional session/pattern/regime values are never invented.

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// -----------------------------------------------------------------------------
// Engine metadata
// -----------------------------------------------------------------------------

const ENGINE_NAME =
  "PipSight Pro Autonomous AI Policy Engine";

const ENGINE_VERSION =
  "1.4.0";

const POLICY_SCHEMA_VERSION =
  1;

const STATE_SCHEMA_VERSION =
  1;

const SUPPORTED_CONFIG_NAME =
  "PipSight Pro Autonomous Trading Control Plane";

const SUPPORTED_CONFIG_VERSION =
  "1.4.0";

const SUPPORTED_AI_MEMORY_ENGINE_NAME =
  "PipSight Pro Adaptive AI Memory Engine";

const SUPPORTED_AI_MEMORY_ENGINE_VERSION =
  "1.0.1";

const HASH_ALGORITHM =
  "sha256";

const MAX_SOURCE_TRADES =
  100000;

const MAX_POLICY_BUCKETS =
  250000;

const LN_2 =
  Math.log(2);

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

const AUTONOMOUS_CONFIG_PATH =
  path.join(
    DATA_DIR,
    "autonomous-config.json"
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

const AI_MEMORY_PATH =
  path.join(
    DATA_DIR,
    "ai-memory.json"
  );

const AI_POLICY_PATH =
  path.join(
    DATA_DIR,
    "ai-policy.json"
  );

const AI_POLICY_STATE_PATH =
  path.join(
    DATA_DIR,
    "ai-policy-state.json"
  );

// -----------------------------------------------------------------------------
// Canonical values
// -----------------------------------------------------------------------------

const SUPPORTED_PAIRS =
  new Set([
    "XAUUSD",
    "GBPJPY"
  ]);

const SUPPORTED_ENGINES =
  new Set([
    "scalp",
    "daily",
    "weekly"
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

const SUPPORTED_TIMEFRAMES =
  new Set([
    "5m",
    "15m",
    "30m",
    "1H",
    "4H",
    "D1",
    "W1"
  ]);

const TIMEFRAME_MINUTES =
  Object.freeze({
    "5m": 5,
    "15m": 15,
    "30m": 30,
    "1H": 60,
    "4H": 240,
    "D1": 1440,
    "W1": 10080
  });

const AUTHORITY_LEVELS =
  Object.freeze({
    SHADOW_ONLY: 0,
    FILTER_ONLY: 1,
    TRADE_PLAN: 2,
    DIRECTION_SELECTION: 3
  });

const BUCKET_DEFINITIONS =
  Object.freeze([
    {
      scope: "pairTimeframeEngineDirectionRegime",
      fields: [
        "pair",
        "timeframe",
        "engine",
        "direction",
        "marketRegime"
      ]
    },
    {
      scope: "pairTimeframeEngineDirectionSession",
      fields: [
        "pair",
        "timeframe",
        "engine",
        "direction",
        "session"
      ]
    },
    {
      scope: "pairTimeframeEngineDirectionPattern",
      fields: [
        "pair",
        "timeframe",
        "engine",
        "direction",
        "pattern"
      ]
    },
    {
      scope: "pairTimeframeEngineDirection",
      fields: [
        "pair",
        "timeframe",
        "engine",
        "direction"
      ]
    },
    {
      scope: "pairEngineDirection",
      fields: [
        "pair",
        "engine",
        "direction"
      ]
    },
    {
      scope: "pairTimeframeDirection",
      fields: [
        "pair",
        "timeframe",
        "direction"
      ]
    },
    {
      scope: "pairDirection",
      fields: [
        "pair",
        "direction"
      ]
    },
    {
      scope: "engineDirection",
      fields: [
        "engine",
        "direction"
      ]
    },
    {
      scope: "pair",
      fields: [
        "pair"
      ]
    },
    {
      scope: "engine",
      fields: [
        "engine"
      ]
    },
    {
      scope: "direction",
      fields: [
        "direction"
      ]
    }
  ]);

// -----------------------------------------------------------------------------
// Generic helpers
// -----------------------------------------------------------------------------

function isPlainObject(
  value
) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function isFiniteNumber(
  value
) {
  return (
    typeof value === "number" &&
    Number.isFinite(value)
  );
}

function toFiniteNumber(
  value
) {
  if (isFiniteNumber(value)) {
    return value;
  }

  if (
    typeof value === "string" &&
    value.trim()
  ) {
    const parsed =
      Number(value);

    return Number.isFinite(parsed)
      ? parsed
      : null;
  }

  return null;
}

function toTrimmedString(
  value
) {
  return typeof value === "string"
    ? value.trim()
    : "";
}

function toNonEmptyStringOrNull(
  value
) {
  const normalized =
    toTrimmedString(value);

  return normalized || null;
}

function toISOStringOrNull(
  value
) {
  if (
    typeof value === "number" &&
    Number.isFinite(value)
  ) {
    const date =
      new Date(value);

    return Number.isNaN(date.getTime())
      ? null
      : date.toISOString();
  }

  if (
    typeof value !== "string" ||
    !value.trim()
  ) {
    return null;
  }

  const date =
    new Date(value);

  return Number.isNaN(date.getTime())
    ? null
    : date.toISOString();
}

function clamp(
  value,
  minimum,
  maximum
) {
  if (!Number.isFinite(value)) {
    return minimum;
  }

  return Math.min(
    maximum,
    Math.max(
      minimum,
      value
    )
  );
}

function round(
  value,
  decimals = 8
) {
  if (!Number.isFinite(value)) {
    return null;
  }

  const factor =
    10 ** decimals;

  return Math.round(
    (value + Number.EPSILON) *
    factor
  ) / factor;
}

function safeDivide(
  numerator,
  denominator,
  fallback = 0
) {
  return (
    Number.isFinite(numerator) &&
    Number.isFinite(denominator) &&
    denominator !== 0
  )
    ? numerator / denominator
    : fallback;
}

function mean(
  values
) {
  if (!Array.isArray(values) || values.length === 0) {
    return 0;
  }

  let total = 0;

  for (const value of values) {
    total += value;
  }

  return total / values.length;
}

function standardDeviation(
  values,
  average = mean(values)
) {
  if (!Array.isArray(values) || values.length < 2) {
    return 0;
  }

  let squaredTotal = 0;

  for (const value of values) {
    const difference =
      value - average;

    squaredTotal +=
      difference * difference;
  }

  return Math.sqrt(
    squaredTotal /
    values.length
  );
}

function uniqueSortedStrings(
  values
) {
  return Array.from(
    new Set(
      values
        .filter(
          (value) =>
            typeof value === "string" &&
            value
        )
    )
  ).sort();
}

function getNestedValue(
  source,
  keys
) {
  let current =
    source;

  for (const key of keys) {
    if (
      !current ||
      typeof current !== "object" ||
      !Object.prototype.hasOwnProperty.call(
        current,
        key
      )
    ) {
      return undefined;
    }

    current =
      current[key];
  }

  return current;
}

function firstDefined(
  ...values
) {
  for (const value of values) {
    if (
      value !== undefined &&
      value !== null
    ) {
      return value;
    }
  }

  return undefined;
}

function sortObjectKeysDeep(
  value
) {
  if (Array.isArray(value)) {
    return value.map(
      sortObjectKeysDeep
    );
  }

  if (!isPlainObject(value)) {
    return value;
  }

  const output = {};

  for (
    const key of
    Object.keys(value).sort()
  ) {
    output[key] =
      sortObjectKeysDeep(
        value[key]
      );
  }

  return output;
}

function stableStringify(
  value
) {
  return JSON.stringify(
    sortObjectKeysDeep(value)
  );
}

function createHash(
  value
) {
  const input =
    Buffer.isBuffer(value)
      ? value
      : (
          typeof value === "string"
            ? value
            : stableStringify(value)
        );

  return crypto
    .createHash(HASH_ALGORITHM)
    .update(input)
    .digest("hex");
}

function hashFileContents(
  filePath
) {
  return createHash(
    fs.readFileSync(
      filePath
    )
  );
}

function ensureDirectory(
  directoryPath
) {
  fs.mkdirSync(
    directoryPath,
    {
      recursive: true
    }
  );
}

function fileExists(
  filePath
) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function getFileModifiedAt(
  filePath
) {
  try {
    return fs.statSync(filePath).mtime.toISOString();
  } catch {
    return null;
  }
}

function readJSON(
  filePath,
  options = {}
) {
  const {
    required = true,
    defaultValue = null
  } = options;

  if (!fileExists(filePath)) {
    if (required) {
      throw new Error(
        `Required JSON file is missing: ${path.relative(ROOT_DIR, filePath)}`
      );
    }

    return defaultValue;
  }

  const raw =
    fs.readFileSync(
      filePath,
      "utf8"
    ).trim();

  if (!raw) {
    if (required) {
      throw new Error(
        `Required JSON file is empty: ${path.relative(ROOT_DIR, filePath)}`
      );
    }

    return defaultValue;
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${path.relative(ROOT_DIR, filePath)} contains invalid JSON: ${error.message}`
    );
  }
}

function atomicWriteJSON(
  filePath,
  value
) {
  ensureDirectory(
    path.dirname(filePath)
  );

  const temporaryPath =
    `${filePath}.${process.pid}.${Date.now()}.tmp`;

  const serialized =
    JSON.stringify(
      value,
      null,
      2
    ) + "\n";

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
  } catch (error) {
    try {
      if (fileExists(temporaryPath)) {
        fs.unlinkSync(temporaryPath);
      }
    } catch {
      // Best-effort cleanup only.
    }

    throw error;
  }
}

// -----------------------------------------------------------------------------
// Canonical normalization
// -----------------------------------------------------------------------------

function normalizePair(
  value
) {
  const normalized =
    toTrimmedString(value)
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");

  return SUPPORTED_PAIRS.has(normalized)
    ? normalized
    : null;
}

function normalizeEngine(
  value
) {
  const normalized =
    toTrimmedString(value)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");

  const aliases = {
    scalp: "scalp",
    scalping: "scalp",
    intraday: "daily",
    daily: "daily",
    day: "daily",
    swing: "weekly",
    weekly: "weekly",
    week: "weekly"
  };

  const engine =
    aliases[normalized] || null;

  return SUPPORTED_ENGINES.has(engine)
    ? engine
    : null;
}

function normalizeDirection(
  value
) {
  const normalized =
    toTrimmedString(value)
      .toUpperCase();

  return SUPPORTED_DIRECTIONS.has(normalized)
    ? normalized
    : null;
}

function normalizeOutcome(
  value
) {
  const normalized =
    toTrimmedString(value)
      .toUpperCase()
      .replace(/[\s-]+/g, "_");

  const aliases = {
    WIN: "WIN",
    WON: "WIN",
    TP: "WIN",
    TAKE_PROFIT: "WIN",
    LOSS: "LOSS",
    LOST: "LOSS",
    SL: "LOSS",
    STOP_LOSS: "LOSS",
    BREAK_EVEN: "BREAKEVEN",
    BREAKEVEN: "BREAKEVEN",
    BE: "BREAKEVEN"
  };

  const outcome =
    aliases[normalized] || null;

  return SUPPORTED_OUTCOMES.has(outcome)
    ? outcome
    : null;
}

function normalizeTimeframe(
  value
) {
  const normalized =
    toTrimmedString(value)
      .toUpperCase()
      .replace(/\s+/g, "");

  const aliases = {
    "5M": "5m",
    M5: "5m",
    "5MIN": "5m",
    "15M": "15m",
    M15: "15m",
    "15MIN": "15m",
    "30M": "30m",
    M30: "30m",
    "30MIN": "30m",
    "1H": "1H",
    H1: "1H",
    "60M": "1H",
    "4H": "4H",
    H4: "4H",
    "1D": "D1",
    D1: "D1",
    DAILY: "D1",
    "1W": "W1",
    W1: "W1",
    WEEKLY: "W1"
  };

  const timeframe =
    aliases[normalized] || null;

  return SUPPORTED_TIMEFRAMES.has(timeframe)
    ? timeframe
    : null;
}

function normalizeOptionalDimension(
  value
) {
  const normalized =
    toTrimmedString(value)
      .replace(/\s+/g, " ");

  if (
    !normalized ||
    normalized.length > 120
  ) {
    return null;
  }

  return normalized;
}

// -----------------------------------------------------------------------------
// Source validation
// -----------------------------------------------------------------------------

function createValidationResult() {
  return {
    valid: true,
    errors: [],
    warnings: []
  };
}

function addValidationError(
  validation,
  message
) {
  validation.valid =
    false;

  validation.errors.push(
    message
  );
}

function addValidationWarning(
  validation,
  message
) {
  validation.warnings.push(
    message
  );
}

function validateAutonomousConfig(
  config
) {
  const validation =
    createValidationResult();

  if (!isPlainObject(config)) {
    addValidationError(
      validation,
      "Autonomous config root must be an object."
    );

    return validation;
  }

  if (
    config.schemaVersion !==
    1
  ) {
    addValidationError(
      validation,
      "Autonomous config schemaVersion must be 1."
    );
  }

  if (
    config.configName !==
    SUPPORTED_CONFIG_NAME
  ) {
    addValidationError(
      validation,
      "Autonomous config name is unsupported."
    );
  }

  if (
    config.configVersion !==
    SUPPORTED_CONFIG_VERSION
  ) {
    addValidationError(
      validation,
      `Autonomous config version must be ${SUPPORTED_CONFIG_VERSION}.`
    );
  }

  const allowedModes =
    getNestedValue(
      config,
      [
        "deployment",
        "allowedModes"
      ]
    );

  const mode =
    getNestedValue(
      config,
      [
        "deployment",
        "mode"
      ]
    );

  if (
    !Array.isArray(allowedModes) ||
    !allowedModes.includes(mode)
  ) {
    addValidationError(
      validation,
      "Autonomous deployment mode is invalid."
    );
  }

  const rolloutPercent =
    toFiniteNumber(
      getNestedValue(
        config,
        [
          "deployment",
          "autonomousRolloutPercent"
        ]
      )
    );

  if (
    rolloutPercent === null ||
    rolloutPercent < 0 ||
    rolloutPercent > 100
  ) {
    addValidationError(
      validation,
      "autonomousRolloutPercent must be between 0 and 100."
    );
  }

  if (
    getNestedValue(
      config,
      [
        "riskSafetyGate",
        "immutable"
      ]
    ) !== true ||
    getNestedValue(
      config,
      [
        "riskSafetyGate",
        "policyMayOverride"
      ]
    ) !== false
  ) {
    addValidationError(
      validation,
      "The autonomous risk safety gate must remain immutable and non-overridable."
    );
  }

  if (
    getNestedValue(
      config,
      [
        "governance",
        "policyEngineMayModifySourceCode"
      ]
    ) !== false ||
    getNestedValue(
      config,
      [
        "governance",
        "externalNetworkCallsDuringDecision"
      ]
    ) !== false
  ) {
    addValidationError(
      validation,
      "Policy source-code modification and decision-time network calls must remain disabled."
    );
  }

  const minimumBucketSamples =
    toFiniteNumber(
      getNestedValue(
        config,
        [
          "learningEligibility",
          "minimumBucketDecisiveSamples"
        ]
      )
    );

  const strongBucketSamples =
    toFiniteNumber(
      getNestedValue(
        config,
        [
          "learningEligibility",
          "strongBucketDecisiveSamples"
        ]
      )
    );

  if (
    minimumBucketSamples === null ||
    minimumBucketSamples < 1 ||
    strongBucketSamples === null ||
    strongBucketSamples < minimumBucketSamples
  ) {
    addValidationError(
      validation,
      "Learning sample thresholds are invalid."
    );
  }

  const outOfSampleFraction =
    toFiniteNumber(
      getNestedValue(
        config,
        [
          "policyValidation",
          "minimumOutOfSampleFraction"
        ]
      )
    );

  if (
    outOfSampleFraction === null ||
    outOfSampleFraction <= 0 ||
    outOfSampleFraction >= 0.5
  ) {
    addValidationError(
      validation,
      "minimumOutOfSampleFraction must be greater than 0 and below 0.5."
    );
  }

  if (
    mode === "AUTONOMOUS" &&
    rolloutPercent > 0 &&
    getNestedValue(
      config,
      [
        "deployment",
        "requireExplicitModePromotion"
      ]
    ) !== true
  ) {
    addValidationError(
      validation,
      "Autonomous rollout requires explicit mode promotion."
    );
  }

  return validation;
}

function validateLearningDocument(
  document
) {
  const validation =
    createValidationResult();

  if (!isPlainObject(document)) {
    addValidationError(
      validation,
      "Learning data root must be an object."
    );

    return validation;
  }

  const signals =
    getNestedValue(
      document,
      [
        "learning",
        "signals"
      ]
    );

  if (!Array.isArray(signals)) {
    addValidationError(
      validation,
      "learning-data.json learning.signals must be an array."
    );
  } else if (
    signals.length >
    MAX_SOURCE_TRADES
  ) {
    addValidationError(
      validation,
      `Learning data exceeds the ${MAX_SOURCE_TRADES} trade safety limit.`
    );
  }

  return validation;
}

function validateConfidenceDocument(
  document
) {
  const validation =
    createValidationResult();

  if (!isPlainObject(document)) {
    addValidationError(
      validation,
      "Confidence data root must be an object."
    );

    return validation;
  }

  if (
    !isPlainObject(
      document.confidence
    )
  ) {
    addValidationError(
      validation,
      "confidence-data.json confidence section must be an object."
    );
  }

  return validation;
}

function validateAIMemoryDocument(
  document
) {
  const validation =
    createValidationResult();

  if (!isPlainObject(document)) {
    addValidationError(
      validation,
      "AI Memory root must be an object."
    );

    return validation;
  }

  if (
    document.engineName !==
    SUPPORTED_AI_MEMORY_ENGINE_NAME
  ) {
    addValidationError(
      validation,
      "AI Memory engine name is unsupported."
    );
  }

  if (
    document.engineVersion !==
    SUPPORTED_AI_MEMORY_ENGINE_VERSION
  ) {
    addValidationError(
      validation,
      `AI Memory engine version must be ${SUPPORTED_AI_MEMORY_ENGINE_VERSION}.`
    );
  }

  if (
    document.validation?.valid !==
    true
  ) {
    addValidationError(
      validation,
      "AI Memory internal validation has not passed."
    );
  }

  if (
    !isPlainObject(document.memory) ||
    !isPlainObject(document.combinations) ||
    !isPlainObject(document.summary)
  ) {
    addValidationError(
      validation,
      "AI Memory core sections are incomplete."
    );
  }

  return validation;
}

function throwOnInvalidSource(
  name,
  validation
) {
  if (validation.valid) {
    return;
  }

  throw new Error(
    `${name} validation failed: ${validation.errors.join(" ")}`
  );
}

// -----------------------------------------------------------------------------
// Trade normalization
// -----------------------------------------------------------------------------

function extractLearningSignals(
  document
) {
  const signals =
    getNestedValue(
      document,
      [
        "learning",
        "signals"
      ]
    );

  return Array.isArray(signals)
    ? signals
    : [];
}

function extractOptionalContext(
  record,
  key
) {
  return normalizeOptionalDimension(
    firstDefined(
      record[key],
      record.metadata?.[key],
      record.context?.[key],
      record.marketContext?.[key]
    )
  );
}

function calculateProfitPoints(
  direction,
  entry,
  closePrice
) {
  if (
    !direction ||
    entry === null ||
    closePrice === null
  ) {
    return null;
  }

  return direction === "BUY"
    ? closePrice - entry
    : entry - closePrice;
}

function normalizeLearningTrade(
  record,
  nowMs,
  config
) {
  const rejection = {
    accepted: false,
    reason: null,
    trade: null
  };

  if (!isPlainObject(record)) {
    rejection.reason =
      "NOT_OBJECT";

    return rejection;
  }

  const pair =
    normalizePair(
      firstDefined(
        record.pair,
        record.symbol,
        record.pairLabel
      )
    );

  const engine =
    normalizeEngine(
      firstDefined(
        record.strategy,
        record.engine,
        record.engineName,
        record.mode
      )
    );

  const direction =
    normalizeDirection(
      firstDefined(
        record.direction,
        record.decision,
        record.signal,
        record.action
      )
    );

  const timeframe =
    normalizeTimeframe(
      firstDefined(
        record.timeframe,
        record.sourceTimeframe,
        record.tf,
        record.interval
      )
    );

  const outcome =
    normalizeOutcome(
      firstDefined(
        record.outcome,
        record.result
      )
    );

  if (!pair) {
    rejection.reason =
      "UNSUPPORTED_PAIR";

    return rejection;
  }

  if (!engine) {
    rejection.reason =
      "UNSUPPORTED_ENGINE";

    return rejection;
  }

  if (!direction) {
    rejection.reason =
      "UNSUPPORTED_DIRECTION";

    return rejection;
  }

  if (!timeframe) {
    rejection.reason =
      "UNSUPPORTED_OR_MISSING_TIMEFRAME";

    return rejection;
  }

  if (!outcome) {
    rejection.reason =
      "UNSUPPORTED_OR_UNRESOLVED_OUTCOME";

    return rejection;
  }

  const status =
    toTrimmedString(record.status)
      .toLowerCase();

  if (
    [
      "open",
      "pending",
      "invalid",
      "rejected",
      "error"
    ].includes(status)
  ) {
    rejection.reason =
      `EXCLUDED_STATUS_${status.toUpperCase()}`;

    return rejection;
  }

  const openedAt =
    toISOStringOrNull(
      firstDefined(
        record.openedAt,
        record.signalTime,
        record.timestamp,
        record.createdAt
      )
    );

  const closedAt =
    toISOStringOrNull(
      firstDefined(
        record.closedAt,
        record.resolvedAt,
        record.updatedAt
      )
    );

  if (!openedAt || !closedAt) {
    rejection.reason =
      "MISSING_TRADE_TIMESTAMPS";

    return rejection;
  }

  const openedAtMs =
    Date.parse(openedAt);

  const closedAtMs =
    Date.parse(closedAt);

  if (
    closedAtMs < openedAtMs
  ) {
    rejection.reason =
      "CLOSED_BEFORE_OPENED";

    return rejection;
  }

  if (
    openedAtMs > nowMs + 60000 ||
    closedAtMs > nowMs + 60000
  ) {
    rejection.reason =
      "FUTURE_DATED_TRADE";

    return rejection;
  }

  const maximumAgeDays =
    toFiniteNumber(
      config.learningEligibility
        ?.maximumLearningRecordAgeDays
    );

  if (
    maximumAgeDays !== null &&
    maximumAgeDays > 0 &&
    nowMs - closedAtMs >
      maximumAgeDays * 86400000
  ) {
    rejection.reason =
      "TRADE_EXCEEDS_MAXIMUM_AGE";

    return rejection;
  }

  const entry =
    toFiniteNumber(
      firstDefined(
        record.entry,
        record.entryPrice,
        record.price
      )
    );

  const stopLoss =
    toFiniteNumber(
      firstDefined(
        record.stopLoss,
        record.stop,
        record.sl
      )
    );

  const takeProfit =
    toFiniteNumber(
      firstDefined(
        record.takeProfit,
        record.takeProfit1,
        record.target,
        record.target1,
        record.tp1
      )
    );

  const closePrice =
    toFiniteNumber(
      firstDefined(
        record.closePrice,
        record.exitPrice,
        record.exit
      )
    );

  const suppliedProfitPoints =
    toFiniteNumber(
      record.profitPoints
    );

  const calculatedProfitPoints =
    calculateProfitPoints(
      direction,
      entry,
      closePrice
    );

  const profitPoints =
    suppliedProfitPoints !== null
      ? suppliedProfitPoints
      : calculatedProfitPoints;

  if (profitPoints === null) {
    rejection.reason =
      "MISSING_PROFIT_POINTS";

    return rejection;
  }

  const initialRisk =
    (
      entry !== null &&
      stopLoss !== null
    )
      ? Math.abs(entry - stopLoss)
      : null;

  if (
    initialRisk === null ||
    initialRisk <= 0
  ) {
    rejection.reason =
      "ZERO_OR_MISSING_INITIAL_RISK";

    return rejection;
  }

  const realizedR =
    profitPoints /
    initialRisk;

  if (!Number.isFinite(realizedR)) {
    rejection.reason =
      "NON_FINITE_REALIZED_R";

    return rejection;
  }

  const plannedReward =
    (
      entry !== null &&
      takeProfit !== null
    )
      ? Math.abs(takeProfit - entry)
      : null;

  const plannedRiskReward =
    (
      plannedReward !== null &&
      initialRisk > 0
    )
      ? plannedReward / initialRisk
      : null;

  const id =
    toNonEmptyStringOrNull(
      firstDefined(
        record.id,
        record.signalId
      )
    );

  const confidence =
    toFiniteNumber(
      firstDefined(
        record.aiMemoryAdjustedConfidence,
        record.confidence,
        record.confidencePct
      )
    );

  const setupIdentity =
    toNonEmptyStringOrNull(
      firstDefined(
        record.setupIdentity,
        record.setupId
      )
    );

  const trade = {
    id,
    setupIdentity,
    pair,
    engine,
    direction,
    timeframe,
    outcome,
    openedAt,
    closedAt,
    openedAtMs,
    closedAtMs,
    entry: round(entry, 10),
    stopLoss: round(stopLoss, 10),
    takeProfit: round(takeProfit, 10),
    closePrice: round(closePrice, 10),
    profitPoints: round(profitPoints, 10),
    initialRisk: round(initialRisk, 10),
    realizedR: round(realizedR, 10),
    plannedRiskReward: round(plannedRiskReward, 10),
    confidence:
      confidence === null
        ? null
        : round(
            clamp(confidence, 0, 100),
            4
          ),
    session:
      extractOptionalContext(
        record,
        "session"
      ),
    pattern:
      extractOptionalContext(
        record,
        "pattern"
      ),
    marketRegime:
      extractOptionalContext(
        record,
        "marketRegime"
      )
  };

  trade.canonicalKey =
    createTradeCanonicalKey(
      trade
    );

  rejection.accepted =
    true;

  rejection.trade =
    trade;

  return rejection;
}

function createTradeCanonicalKey(
  trade
) {
  return createHash({
    pair: trade.pair,
    engine: trade.engine,
    direction: trade.direction,
    timeframe: trade.timeframe,
    openedAt: trade.openedAt,
    closedAt: trade.closedAt,
    entry: trade.entry,
    stopLoss: trade.stopLoss,
    takeProfit: trade.takeProfit,
    outcome: trade.outcome
  });
}

function createTradeSetupKey(
  trade
) {
  const setupIdentity =
    toNonEmptyStringOrNull(
      trade?.setupIdentity
    );

  if (setupIdentity) {
    return createHash({
      setupIdentity
    });
  }

  return createHash({
    pair: trade?.pair || null,
    engine: trade?.engine || null,
    direction: trade?.direction || null,
    timeframe: trade?.timeframe || null,
    openedAt: trade?.openedAt || null
  });
}

function normalizeLearningTrades(
  learningDocument,
  config,
  runAt
) {
  const nowMs =
    Date.parse(runAt);

  const sourceSignals =
    extractLearningSignals(
      learningDocument
    );

  const canonicalByKey =
    new Map();

  const seenSetupKeys =
    new Set();

  const rejectionCounts = {};

  let duplicateTrades = 0;

  for (
    const record of
    sourceSignals
  ) {
    const result =
      normalizeLearningTrade(
        record,
        nowMs,
        config
      );

    if (!result.accepted) {
      const reason =
        result.reason ||
        "UNKNOWN_REJECTION";

      rejectionCounts[reason] =
        (rejectionCounts[reason] || 0) + 1;

      continue;
    }

    const setupKey =
      createTradeSetupKey(
        result.trade
      );

    if (
      seenSetupKeys.has(
        setupKey
      )
    ) {
      duplicateTrades += 1;
      continue;
    }

    seenSetupKeys.add(
      setupKey
    );

    if (
      canonicalByKey.has(
        result.trade.canonicalKey
      )
    ) {
      duplicateTrades += 1;
      continue;
    }

    canonicalByKey.set(
      result.trade.canonicalKey,
      result.trade
    );
  }

  const trades =
    Array.from(
      canonicalByKey.values()
    ).sort(
      (left, right) =>
        left.closedAtMs - right.closedAtMs ||
        left.openedAtMs - right.openedAtMs ||
        left.canonicalKey.localeCompare(
          right.canonicalKey
        )
    );

  return {
    sourceSignals:
      sourceSignals.length,

    acceptedTrades:
      trades.length,

    rejectedTrades:
      sourceSignals.length -
      trades.length -
      duplicateTrades,

    duplicateTrades,

    rejectionCounts:
      sortObjectKeysDeep(
        rejectionCounts
      ),

    trades
  };
}

// -----------------------------------------------------------------------------
// Performance metrics
// -----------------------------------------------------------------------------

function calculateMaximumDrawdownR(
  trades
) {
  let equity = 0;
  let peak = 0;
  let maximumDrawdown = 0;

  for (const trade of trades) {
    equity +=
      trade.realizedR;

    if (equity > peak) {
      peak = equity;
    }

    maximumDrawdown =
      Math.max(
        maximumDrawdown,
        peak - equity
      );
  }

  return maximumDrawdown;
}

function calculateMaximumConsecutiveLosses(
  trades
) {
  let maximum = 0;
  let current = 0;

  for (const trade of trades) {
    if (trade.outcome === "LOSS") {
      current += 1;
      maximum =
        Math.max(
          maximum,
          current
        );
    } else {
      current = 0;
    }
  }

  return maximum;
}

function calculateRecencyWeight(
  trade,
  referenceMs,
  halfLifeDays
) {
  if (
    !Number.isFinite(halfLifeDays) ||
    halfLifeDays <= 0
  ) {
    return 1;
  }

  const ageDays =
    Math.max(
      0,
      (referenceMs - trade.closedAtMs) /
      86400000
    );

  return Math.exp(
    -LN_2 *
    ageDays /
    halfLifeDays
  );
}

function calculatePerformanceMetrics(
  trades,
  options = {}
) {
  const {
    referenceMs = Date.now(),
    recencyHalfLifeDays = 45
  } = options;

  const totalTrades =
    trades.length;

  let wins = 0;
  let losses = 0;
  let breakevens = 0;
  let grossProfitR = 0;
  let grossLossR = 0;
  let totalR = 0;
  let totalProfitPoints = 0;
  let weightedR = 0;
  let totalWeight = 0;
  let weightedWins = 0;
  let weightedLosses = 0;
  let plannedRiskRewardTotal = 0;
  let plannedRiskRewardSamples = 0;
  let confidenceTotal = 0;
  let confidenceSamples = 0;

  const realizedRs = [];
  const negativeRs = [];

  for (const trade of trades) {
    const realizedR =
      trade.realizedR;

    realizedRs.push(
      realizedR
    );

    totalR +=
      realizedR;

    totalProfitPoints +=
      trade.profitPoints;

    if (realizedR > 0) {
      grossProfitR +=
        realizedR;
    } else if (realizedR < 0) {
      grossLossR +=
        Math.abs(realizedR);

      negativeRs.push(
        realizedR
      );
    }

    if (trade.outcome === "WIN") {
      wins += 1;
    } else if (trade.outcome === "LOSS") {
      losses += 1;
    } else {
      breakevens += 1;
    }

    const weight =
      calculateRecencyWeight(
        trade,
        referenceMs,
        recencyHalfLifeDays
      );

    totalWeight +=
      weight;

    weightedR +=
      realizedR * weight;

    if (trade.outcome === "WIN") {
      weightedWins +=
        weight;
    } else if (trade.outcome === "LOSS") {
      weightedLosses +=
        weight;
    }

    if (
      trade.plannedRiskReward !== null &&
      Number.isFinite(
        trade.plannedRiskReward
      )
    ) {
      plannedRiskRewardTotal +=
        trade.plannedRiskReward;

      plannedRiskRewardSamples += 1;
    }

    if (
      trade.confidence !== null &&
      Number.isFinite(trade.confidence)
    ) {
      confidenceTotal +=
        trade.confidence;

      confidenceSamples += 1;
    }
  }

  const expectancyR =
    safeDivide(
      totalR,
      totalTrades,
      0
    );

  const weightedExpectancyR =
    safeDivide(
      weightedR,
      totalWeight,
      0
    );

  const averageR =
    expectancyR;

  const standardDeviationR =
    standardDeviation(
      realizedRs,
      averageR
    );

  const downsideDeviationR =
    standardDeviation(
      negativeRs,
      mean(negativeRs)
    );

  const profitFactor =
    grossLossR > 0
      ? grossProfitR / grossLossR
      : (
          grossProfitR > 0
            ? null
            : 0
        );

  const profitFactorInfinite =
    grossLossR === 0 &&
    grossProfitR > 0;

  const lastTradeAt =
    totalTrades > 0
      ? trades[totalTrades - 1].closedAt
      : null;

  const firstTradeAt =
    totalTrades > 0
      ? trades[0].closedAt
      : null;

  return {
    totalTrades,
    decisiveTrades:
      wins + losses,
    wins,
    losses,
    breakevens,
    winRate:
      round(
        safeDivide(
          wins,
          wins + losses,
          0
        ) * 100,
        4
      ),
    lossRate:
      round(
        safeDivide(
          losses,
          wins + losses,
          0
        ) * 100,
        4
      ),
    breakevenRate:
      round(
        safeDivide(
          breakevens,
          totalTrades,
          0
        ) * 100,
        4
      ),
    expectancyR:
      round(expectancyR, 8),
    weightedExpectancyR:
      round(weightedExpectancyR, 8),
    totalR:
      round(totalR, 8),
    grossProfitR:
      round(grossProfitR, 8),
    grossLossR:
      round(grossLossR, 8),
    profitFactor:
      profitFactor === null
        ? null
        : round(profitFactor, 6),
    profitFactorInfinite,
    maximumDrawdownR:
      round(
        calculateMaximumDrawdownR(
          trades
        ),
        8
      ),
    maximumConsecutiveLosses:
      calculateMaximumConsecutiveLosses(
        trades
      ),
    standardDeviationR:
      round(standardDeviationR, 8),
    downsideDeviationR:
      round(downsideDeviationR, 8),
    totalProfitPoints:
      round(totalProfitPoints, 10),
    averageProfitPoints:
      round(
        safeDivide(
          totalProfitPoints,
          totalTrades,
          0
        ),
        10
      ),
    recencyWeightTotal:
      round(totalWeight, 8),
    weightedWinRate:
      round(
        safeDivide(
          weightedWins,
          weightedWins + weightedLosses,
          0
        ) * 100,
        4
      ),
    averagePlannedRiskReward:
      plannedRiskRewardSamples > 0
        ? round(
            plannedRiskRewardTotal /
            plannedRiskRewardSamples,
            6
          )
        : null,
    averageConfidence:
      confidenceSamples > 0
        ? round(
            confidenceTotal /
            confidenceSamples,
            4
          )
        : null,
    firstTradeAt,
    lastTradeAt
  };
}

function calculateStabilityScore(
  metrics
) {
  if (
    !metrics ||
    metrics.decisiveTrades < 2
  ) {
    return 0;
  }

  const volatilityPenalty =
    clamp(
      metrics.standardDeviationR /
      3,
      0,
      1
    );

  const drawdownPenalty =
    clamp(
      metrics.maximumDrawdownR /
      Math.max(
        1,
        metrics.decisiveTrades * 0.25
      ),
      0,
      1
    );

  const lossStreakPenalty =
    clamp(
      metrics.maximumConsecutiveLosses /
      10,
      0,
      1
    );

  return round(
    clamp(
      1 -
      (
        volatilityPenalty * 0.45 +
        drawdownPenalty * 0.35 +
        lossStreakPenalty * 0.20
      ),
      0,
      1
    ),
    6
  );
}

function calculateSampleScore(
  decisiveTrades,
  strongSamples
) {
  if (
    decisiveTrades <= 0 ||
    strongSamples <= 0
  ) {
    return 0;
  }

  return round(
    clamp(
      Math.sqrt(
        decisiveTrades /
        strongSamples
      ),
      0,
      1
    ),
    6
  );
}

function calculateRecencyScore(
  lastTradeAt,
  referenceMs,
  halfLifeDays
) {
  if (!lastTradeAt) {
    return 0;
  }

  const lastTradeMs =
    Date.parse(lastTradeAt);

  if (!Number.isFinite(lastTradeMs)) {
    return 0;
  }

  const ageDays =
    Math.max(
      0,
      (referenceMs - lastTradeMs) /
      86400000
    );

  if (
    !Number.isFinite(halfLifeDays) ||
    halfLifeDays <= 0
  ) {
    return 1;
  }

  return round(
    clamp(
      Math.exp(
        -LN_2 *
        ageDays /
        halfLifeDays
      ),
      0,
      1
    ),
    6
  );
}

// -----------------------------------------------------------------------------
// Chronological out-of-sample validation
// -----------------------------------------------------------------------------

function resolveCommonTimeframe(
  trades
) {
  const timeframes =
    uniqueSortedStrings(
      trades.map(
        (trade) =>
          trade.timeframe
      )
    );

  return timeframes.length === 1
    ? timeframes[0]
    : null;
}

function calculateOutOfSampleValidation(
  trades,
  config,
  referenceMs
) {
  const validationConfig =
    config.policyValidation;

  const fraction =
    toFiniteNumber(
      validationConfig
        ?.minimumOutOfSampleFraction
    ) || 0.30;

  const minimumOutOfSampleTrades =
    Math.max(
      1,
      Math.trunc(
        toFiniteNumber(
          validationConfig
            ?.minimumOutOfSampleDecisiveTrades
        ) || 30
      )
    );

  const embargoBars =
    Math.max(
      0,
      Math.trunc(
        toFiniteNumber(
          validationConfig
            ?.embargoBars
        ) || 0
      )
    );

  const minimumTrainingTrades =
    Math.max(
      10,
      Math.trunc(
        minimumOutOfSampleTrades *
        1.5
      )
    );

  if (
    trades.length <
    minimumTrainingTrades +
    minimumOutOfSampleTrades
  ) {
    return {
      status: "INSUFFICIENT_DATA",
      passed: false,
      negativeEdgeConfirmed: false,
      reason:
        `At least ${minimumTrainingTrades + minimumOutOfSampleTrades} decisive trades are required for chronological validation.`,
      splitFraction: fraction,
      trainingTrades: 0,
      embargoedTrades: 0,
      outOfSampleTrades: 0,
      commonTimeframe: null,
      embargoBars,
      embargoMinutes: null,
      training: null,
      outOfSample: null,
      degradation: null,
      pbo: {
        status: "NOT_APPLICABLE_FIXED_POLICY",
        value: null,
        parameterTrials: 1,
        reason:
          "The policy engine evaluates one fixed scoring specification and does not search multiple parameter configurations."
      }
    };
  }

  const rawSplitIndex =
    Math.floor(
      trades.length *
      (1 - fraction)
    );

  const splitIndex =
    clamp(
      rawSplitIndex,
      minimumTrainingTrades,
      trades.length -
      minimumOutOfSampleTrades
    );

  const trainingTrades =
    trades.slice(
      0,
      splitIndex
    );

  const candidateOutOfSampleTrades =
    trades.slice(
      splitIndex
    );

  const commonTimeframe =
    resolveCommonTimeframe(
      trades
    );

  const timeframeMinutes =
    commonTimeframe
      ? TIMEFRAME_MINUTES[commonTimeframe]
      : null;

  if (
    validationConfig
      ?.purgeOverlapRequired === true &&
    embargoBars > 0 &&
    !timeframeMinutes
  ) {
    return {
      status: "MIXED_TIMEFRAME_EMBARGO_UNAVAILABLE",
      passed: false,
      negativeEdgeConfirmed: false,
      reason:
        "A common explicit timeframe is required to apply the configured embargo without inventing bar duration.",
      splitFraction: fraction,
      trainingTrades:
        trainingTrades.length,
      embargoedTrades: 0,
      outOfSampleTrades: 0,
      commonTimeframe: null,
      embargoBars,
      embargoMinutes: null,
      training:
        calculatePerformanceMetrics(
          trainingTrades,
          {
            referenceMs,
            recencyHalfLifeDays:
              config.learningEligibility
                ?.recencyHalfLifeDays
          }
        ),
      outOfSample: null,
      degradation: null,
      pbo: {
        status: "NOT_APPLICABLE_FIXED_POLICY",
        value: null,
        parameterTrials: 1,
        reason:
          "The policy engine evaluates one fixed scoring specification and does not search multiple parameter configurations."
      }
    };
  }

  const trainingEndMs =
    trainingTrades.length > 0
      ? trainingTrades[
          trainingTrades.length - 1
        ].closedAtMs
      : 0;

  const embargoMinutes =
    timeframeMinutes
      ? timeframeMinutes * embargoBars
      : 0;

  const embargoEndMs =
    trainingEndMs +
    embargoMinutes * 60000;

  const outOfSampleTrades =
    candidateOutOfSampleTrades.filter(
      (trade) =>
        trade.openedAtMs >
        embargoEndMs
    );

  const embargoedTrades =
    candidateOutOfSampleTrades.length -
    outOfSampleTrades.length;

  if (
    outOfSampleTrades.length <
    minimumOutOfSampleTrades
  ) {
    return {
      status: "INSUFFICIENT_DATA_AFTER_EMBARGO",
      passed: false,
      negativeEdgeConfirmed: false,
      reason:
        `Only ${outOfSampleTrades.length} out-of-sample trades remain after embargo; ${minimumOutOfSampleTrades} are required.`,
      splitFraction: fraction,
      trainingTrades:
        trainingTrades.length,
      embargoedTrades,
      outOfSampleTrades:
        outOfSampleTrades.length,
      commonTimeframe,
      embargoBars,
      embargoMinutes,
      training:
        calculatePerformanceMetrics(
          trainingTrades,
          {
            referenceMs,
            recencyHalfLifeDays:
              config.learningEligibility
                ?.recencyHalfLifeDays
          }
        ),
      outOfSample:
        calculatePerformanceMetrics(
          outOfSampleTrades,
          {
            referenceMs,
            recencyHalfLifeDays:
              config.learningEligibility
                ?.recencyHalfLifeDays
          }
        ),
      degradation: null,
      pbo: {
        status: "NOT_APPLICABLE_FIXED_POLICY",
        value: null,
        parameterTrials: 1,
        reason:
          "The policy engine evaluates one fixed scoring specification and does not search multiple parameter configurations."
      }
    };
  }

  const training =
    calculatePerformanceMetrics(
      trainingTrades,
      {
        referenceMs,
        recencyHalfLifeDays:
          config.learningEligibility
            ?.recencyHalfLifeDays
      }
    );

  const outOfSample =
    calculatePerformanceMetrics(
      outOfSampleTrades,
      {
        referenceMs,
        recencyHalfLifeDays:
          config.learningEligibility
            ?.recencyHalfLifeDays
      }
    );

  const minimumProfitFactor =
    toFiniteNumber(
      validationConfig
        ?.minimumOutOfSampleProfitFactor
    ) || 1.10;

  const minimumExpectancyR =
    toFiniteNumber(
      validationConfig
        ?.minimumOutOfSampleExpectancyR
    ) || 0.05;

  const maximumDrawdownR =
    toFiniteNumber(
      validationConfig
        ?.maximumOutOfSampleDrawdownR
    ) || 10;

  const outOfSampleProfitFactor =
    outOfSample.profitFactorInfinite
      ? Number.POSITIVE_INFINITY
      : outOfSample.profitFactor;

  const positivePass =
    outOfSample.expectancyR >=
      minimumExpectancyR &&
    outOfSampleProfitFactor !== null &&
    outOfSampleProfitFactor >=
      minimumProfitFactor &&
    outOfSample.maximumDrawdownR <=
      maximumDrawdownR;

  const negativeEdgeConfirmed =
    outOfSample.expectancyR <=
      -Math.max(
        0.05,
        minimumExpectancyR
      ) &&
    outOfSampleProfitFactor !== null &&
    outOfSampleProfitFactor < 0.90;

  const expectancyDegradation =
    training.expectancyR -
    outOfSample.expectancyR;

  const weightedExpectancyDegradation =
    training.weightedExpectancyR -
    outOfSample.weightedExpectancyR;

  return {
    status:
      positivePass
        ? "PASSED_POSITIVE_EDGE"
        : (
            negativeEdgeConfirmed
              ? "PASSED_NEGATIVE_EDGE"
              : "FAILED_NO_STABLE_EDGE"
          ),
    passed:
      positivePass,
    negativeEdgeConfirmed,
    reason:
      positivePass
        ? "Out-of-sample expectancy, profit factor and drawdown gates passed."
        : (
            negativeEdgeConfirmed
              ? "Out-of-sample evidence confirms a materially negative edge."
              : "Out-of-sample evidence did not confirm a stable positive or negative edge."
          ),
    splitFraction: fraction,
    trainingTrades:
      trainingTrades.length,
    embargoedTrades,
    outOfSampleTrades:
      outOfSampleTrades.length,
    commonTimeframe,
    embargoBars,
    embargoMinutes,
    training,
    outOfSample,
    degradation: {
      expectancyR:
        round(
          expectancyDegradation,
          8
        ),
      weightedExpectancyR:
        round(
          weightedExpectancyDegradation,
          8
        ),
      profitFactor:
        (
          training.profitFactor !== null &&
          outOfSample.profitFactor !== null
        )
          ? round(
              training.profitFactor -
              outOfSample.profitFactor,
              6
            )
          : null
    },
    pbo: {
      status: "NOT_APPLICABLE_FIXED_POLICY",
      value: null,
      parameterTrials: 1,
      reason:
        "The policy engine evaluates one fixed scoring specification and does not search multiple parameter configurations."
    }
  };
}

// -----------------------------------------------------------------------------
// Policy bucket construction
// -----------------------------------------------------------------------------

function createBucketKey(
  definition,
  trade
) {
  const values = {};
  const keyParts = [];

  for (const field of definition.fields) {
    const value =
      trade[field];

    if (
      value === null ||
      value === undefined ||
      value === ""
    ) {
      return null;
    }

    values[field] =
      value;

    keyParts.push(
      String(value)
        .replace(/\|/g, "_")
    );
  }

  return {
    key:
      `${definition.scope}|${keyParts.join("|")}`,
    scope:
      definition.scope,
    dimensions:
      values
  };
}

function buildTradeBuckets(
  trades
) {
  const buckets =
    new Map();

  for (const trade of trades) {
    for (
      const definition of
      BUCKET_DEFINITIONS
    ) {
      const identity =
        createBucketKey(
          definition,
          trade
        );

      if (!identity) {
        continue;
      }

      if (!buckets.has(identity.key)) {
        if (
          buckets.size >=
          MAX_POLICY_BUCKETS
        ) {
          throw new Error(
            `Policy bucket count exceeded the ${MAX_POLICY_BUCKETS} safety limit.`
          );
        }

        buckets.set(
          identity.key,
          {
            key:
              identity.key,
            scope:
              identity.scope,
            dimensions:
              identity.dimensions,
            trades: []
          }
        );
      }

      buckets
        .get(identity.key)
        .trades.push(trade);
    }
  }

  return Array.from(
    buckets.values()
  ).sort(
    (left, right) =>
      left.key.localeCompare(
        right.key
      )
  );
}

function calculateBayesianShrunkExpectancy(
  metrics,
  globalMetrics,
  priorStrength
) {
  const decisiveTrades =
    metrics.decisiveTrades;

  if (decisiveTrades <= 0) {
    return 0;
  }

  const globalExpectancy =
    globalMetrics?.expectancyR || 0;

  return (
    metrics.expectancyR *
      decisiveTrades +
    globalExpectancy *
      priorStrength
  ) /
  (
    decisiveTrades +
    priorStrength
  );
}

function normalizeProfitFactorForScore(
  metrics
) {
  if (metrics.profitFactorInfinite) {
    return 3;
  }

  if (
    metrics.profitFactor === null ||
    !Number.isFinite(metrics.profitFactor)
  ) {
    return 0;
  }

  return clamp(
    metrics.profitFactor,
    0,
    3
  );
}

function calculateEdgeScore(
  shrunkExpectancyR,
  metrics
) {
  const profitFactor =
    normalizeProfitFactorForScore(
      metrics
    );

  const expectancyComponent =
    Math.tanh(
      shrunkExpectancyR /
      0.50
    );

  const profitFactorComponent =
    Math.tanh(
      (profitFactor - 1) /
      0.60
    );

  const winRateComponent =
    Math.tanh(
      (metrics.winRate - 50) /
      30
    );

  const recencyComponent =
    Math.tanh(
      metrics.weightedExpectancyR /
      0.50
    );

  return round(
    clamp(
      expectancyComponent * 0.50 +
      profitFactorComponent * 0.20 +
      winRateComponent * 0.10 +
      recencyComponent * 0.20,
      -1,
      1
    ),
    6
  );
}

function calculateReliability(
  metrics,
  outOfSample,
  config,
  referenceMs
) {
  const strongSamples =
    Math.max(
      1,
      Math.trunc(
        toFiniteNumber(
          config.learningEligibility
            ?.strongBucketDecisiveSamples
        ) || 50
      )
    );

  const sampleScore =
    calculateSampleScore(
      metrics.decisiveTrades,
      strongSamples
    );

  const stabilityScore =
    calculateStabilityScore(
      metrics
    );

  const recencyScore =
    calculateRecencyScore(
      metrics.lastTradeAt,
      referenceMs,
      toFiniteNumber(
        config.learningEligibility
          ?.recencyHalfLifeDays
      ) || 45
    );

  let validationScore = 0;

  if (outOfSample.passed) {
    validationScore = 1;
  } else if (outOfSample.negativeEdgeConfirmed) {
    validationScore = 0.90;
  } else if (
    outOfSample.status ===
    "FAILED_NO_STABLE_EDGE"
  ) {
    validationScore = 0.35;
  }

  const reliability =
    sampleScore * 0.40 +
    validationScore * 0.35 +
    stabilityScore * 0.15 +
    recencyScore * 0.10;

  return {
    value:
      round(
        clamp(
          reliability,
          0,
          1
        ),
        6
      ),
    components: {
      sample:
        sampleScore,
      validation:
        round(validationScore, 6),
      stability:
        stabilityScore,
      recency:
        recencyScore
    }
  };
}

function determinePolicyAction(
  metrics,
  shrunkExpectancyR,
  outOfSample,
  config
) {
  const minimumSamples =
    Math.max(
      1,
      Math.trunc(
        toFiniteNumber(
          config.learningEligibility
            ?.minimumBucketDecisiveSamples
        ) || 30
      )
    );

  if (
    metrics.decisiveTrades <
    minimumSamples
  ) {
    return {
      action: "OBSERVE",
      reason:
        `Only ${metrics.decisiveTrades} decisive trades are available; ${minimumSamples} are required.`
    };
  }

  const profitFactor =
    metrics.profitFactorInfinite
      ? Number.POSITIVE_INFINITY
      : metrics.profitFactor;

  if (
    outOfSample.negativeEdgeConfirmed &&
    shrunkExpectancyR < 0 &&
    profitFactor !== null &&
    profitFactor < 0.90
  ) {
    return {
      action: "SUPPRESS",
      reason:
        "Chronological out-of-sample evidence confirms a negative expected edge."
    };
  }

  if (
    outOfSample.passed &&
    shrunkExpectancyR > 0 &&
    profitFactor !== null &&
    profitFactor >= 1.10
  ) {
    return {
      action: "SUPPORT",
      reason:
        "Chronological out-of-sample evidence confirms a positive expected edge."
    };
  }

  return {
    action: "NEUTRAL",
    reason:
      "Available evidence does not justify positive or negative live authority."
  };
}

function determineAuthorityEligibility(
  metrics,
  reliability,
  edgeScore,
  action,
  outOfSample,
  config
) {
  const filterConfig =
    config.authority
      ?.signalFiltering || {};

  const directionConfig =
    config.authority
      ?.directionSelection || {};

  const planConfig =
    config.authority
      ?.tradePlanOptimization || {};

  const filterEligible =
    action === "SUPPRESS" &&
    outOfSample.negativeEdgeConfirmed &&
    metrics.decisiveTrades >=
      (toFiniteNumber(
        filterConfig.minimumDecisiveSamples
      ) || 30) &&
    reliability >=
      (toFiniteNumber(
        filterConfig.minimumReliability
      ) || 0.70);

  const planEligible =
    action === "SUPPORT" &&
    outOfSample.passed &&
    metrics.decisiveTrades >=
      (toFiniteNumber(
        planConfig.minimumDecisiveSamples
      ) || 50) &&
    reliability >=
      (toFiniteNumber(
        planConfig.minimumReliability
      ) || 0.80);

  const directionEligible =
    action === "SUPPORT" &&
    outOfSample.passed &&
    metrics.decisiveTrades >=
      (toFiniteNumber(
        directionConfig.minimumDecisiveSamples
      ) || 75) &&
    reliability >=
      (toFiniteNumber(
        directionConfig.minimumReliability
      ) || 0.85) &&
    edgeScore >=
      (toFiniteNumber(
        directionConfig.minimumPolicyEdgeR
      ) || 0.15);

  let level =
    "SHADOW_ONLY";

  if (directionEligible) {
    level =
      "DIRECTION_SELECTION";
  } else if (planEligible) {
    level =
      "TRADE_PLAN";
  } else if (filterEligible) {
    level =
      "FILTER_ONLY";
  }

  return {
    level,
    levelRank:
      AUTHORITY_LEVELS[level],
    filterEligible,
    tradePlanEligible:
      planEligible,
    directionEligible,
    liveAuthorityPermitted:
      false,
    liveAuthorityReason:
      "Policy Engine produces evidence only; live authority is evaluated later by the Decision Engine and immutable Safety Gate."
  };
}

function buildPolicyBucket(
  bucket,
  globalMetrics,
  config,
  referenceMs
) {
  const halfLifeDays =
    toFiniteNumber(
      config.learningEligibility
        ?.recencyHalfLifeDays
    ) || 45;

  const metrics =
    calculatePerformanceMetrics(
      bucket.trades,
      {
        referenceMs,
        recencyHalfLifeDays:
          halfLifeDays
      }
    );

  const outOfSample =
    calculateOutOfSampleValidation(
      bucket.trades,
      config,
      referenceMs
    );

  const priorStrength =
    Math.max(
      5,
      Math.trunc(
        toFiniteNumber(
          config.learningEligibility
            ?.minimumBucketDecisiveSamples
        ) || 30
      )
    );

  const shrunkExpectancyR =
    calculateBayesianShrunkExpectancy(
      metrics,
      globalMetrics,
      priorStrength
    );

  const edgeScore =
    calculateEdgeScore(
      shrunkExpectancyR,
      metrics
    );

  const reliability =
    calculateReliability(
      metrics,
      outOfSample,
      config,
      referenceMs
    );

  const action =
    determinePolicyAction(
      metrics,
      shrunkExpectancyR,
      outOfSample,
      config
    );

  const authority =
    determineAuthorityEligibility(
      metrics,
      reliability.value,
      edgeScore,
      action.action,
      outOfSample,
      config
    );

  return {
    key:
      bucket.key,
    scope:
      bucket.scope,
    dimensions:
      bucket.dimensions,
    action:
      action.action,
    actionReason:
      action.reason,
    edgeScore,
    shrunkExpectancyR:
      round(
        shrunkExpectancyR,
        8
      ),
    reliability,
    authority,
    metrics,
    validation:
      outOfSample,
    provenance: {
      canonicalTradeKeys:
        bucket.trades.map(
          (trade) =>
            trade.canonicalKey
        ),
      firstTradeAt:
        metrics.firstTradeAt,
      lastTradeAt:
        metrics.lastTradeAt
    }
  };
}

function buildPolicyIndex(
  policies,
  fallbackOrder = []
) {
  const byScope = {};

  for (const policy of policies) {
    if (!Array.isArray(byScope[policy.scope])) {
      byScope[policy.scope] = [];
    }

    byScope[policy.scope].push(
      policy.key
    );
  }

  for (
    const scope of
    Object.keys(byScope)
  ) {
    byScope[scope].sort();
  }

  return {
    byScope:
      sortObjectKeysDeep(byScope),
    fallbackOrder:
      Array.isArray(fallbackOrder)
        ? [...fallbackOrder]
        : []
  };
}

// -----------------------------------------------------------------------------
// Cross-source consistency
// -----------------------------------------------------------------------------

function extractConfidenceResolvedSignals(
  confidenceDocument
) {
  return toFiniteNumber(
    getNestedValue(
      confidenceDocument,
      [
        "confidence",
        "overall",
        "resolvedSignals"
      ]
    )
  );
}

function extractAIMemoryAcceptedTrades(
  aiMemoryDocument
) {
  return toFiniteNumber(
    firstDefined(
      aiMemoryDocument.source
        ?.acceptedTradeCount,
      aiMemoryDocument.summary
        ?.totalTrades
    )
  );
}

function buildCrossSourceValidation(
  normalized,
  confidenceDocument,
  aiMemoryDocument
) {
  const validation =
    createValidationResult();

  const learningAccepted =
    normalized.acceptedTrades;

  const confidenceResolved =
    extractConfidenceResolvedSignals(
      confidenceDocument
    );

  const aiMemoryAccepted =
    extractAIMemoryAcceptedTrades(
      aiMemoryDocument
    );

  if (
    confidenceResolved !== null &&
    confidenceResolved !==
      learningAccepted
  ) {
    addValidationWarning(
      validation,
      `Confidence resolvedSignals (${confidenceResolved}) differs from normalized learning trades (${learningAccepted}).`
    );
  }

  if (
    aiMemoryAccepted !== null &&
    aiMemoryAccepted !==
      learningAccepted
  ) {
    addValidationError(
      validation,
      `AI Memory acceptedTradeCount (${aiMemoryAccepted}) differs from normalized learning trades (${learningAccepted}).`
    );
  }

  return {
    ...validation,
    counts: {
      learningAccepted,
      confidenceResolved,
      aiMemoryAccepted
    }
  };
}

// -----------------------------------------------------------------------------
// Policy document
// -----------------------------------------------------------------------------

function createSourceDescriptor(
  filePath,
  document
) {
  return {
    path:
      path.relative(
        ROOT_DIR,
        filePath
      ).replace(/\\/g, "/"),
    hash:
      hashFileContents(
        filePath
      ),
    modifiedAt:
      getFileModifiedAt(
        filePath
      ),
    declaredUpdatedAt:
      toISOStringOrNull(
        firstDefined(
          document.updatedAt,
          document.generatedAt,
          document.exportedAt,
          document.sourceUpdatedAt,
          document.learning?.updatedAt,
          document.confidence?.updatedAt
        )
      )
  };
}

function buildAuthoritySummary(
  policies
) {
  const summary = {
    SHADOW_ONLY: 0,
    FILTER_ONLY: 0,
    TRADE_PLAN: 0,
    DIRECTION_SELECTION: 0
  };

  for (const policy of policies) {
    summary[
      policy.authority.level
    ] += 1;
  }

  return summary;
}

function buildActionSummary(
  policies
) {
  const summary = {
    OBSERVE: 0,
    NEUTRAL: 0,
    SUPPORT: 0,
    SUPPRESS: 0
  };

  for (const policy of policies) {
    summary[policy.action] += 1;
  }

  return summary;
}

function buildPolicyContentCore({
  configVersion,
  deploymentMode,
  autonomousRolloutPercent,
  sourceHashes,
  globalMetrics,
  policies
}) {
  return {
    configVersion:
      configVersion ?? null,
    deploymentMode:
      deploymentMode ?? null,
    autonomousRolloutPercent:
      autonomousRolloutPercent ?? null,
    sourceHashes:
      isPlainObject(sourceHashes)
        ? sourceHashes
        : {},
    globalMetrics:
      globalMetrics ?? null,
    policies:
      (
        Array.isArray(policies)
          ? policies
          : []
      ).map(
        (policy) => ({
          key:
            policy?.key,
          scope:
            policy?.scope,
          dimensions:
            policy?.dimensions,
          action:
            policy?.action,
          edgeScore:
            policy?.edgeScore,
          shrunkExpectancyR:
            policy?.shrunkExpectancyR,
          reliability:
            policy?.reliability,
          authority:
            policy?.authority,
          metrics:
            policy?.metrics,
          validation:
            policy?.validation
        })
      )
  };
}

function createPolicyContentHashFromDocument(
  policyDocument
) {
  if (!isPlainObject(policyDocument)) {
    return null;
  }

  const sourceHashes =
    Object.fromEntries(
      [
        "autonomousConfig",
        "learningData",
        "confidenceData",
        "aiMemory"
      ].map(
        (key) => [
          key,
          toNonEmptyStringOrNull(
            policyDocument.source
              ?.[key]
              ?.hash
          )
        ]
      )
    );

  return createHash(
    buildPolicyContentCore({
      configVersion:
        policyDocument.config?.version,
      deploymentMode:
        policyDocument.mode,
      autonomousRolloutPercent:
        policyDocument
          .autonomousRolloutPercent,
      sourceHashes,
      globalMetrics:
        policyDocument.globalBaseline,
      policies:
        policyDocument.policies
    })
  );
}

function validatePolicyDocument(
  policyDocument
) {
  const validation =
    createValidationResult();

  if (!isPlainObject(policyDocument)) {
    addValidationError(
      validation,
      "Policy document root must be an object."
    );

    return validation;
  }

  if (
    policyDocument.version !==
    POLICY_SCHEMA_VERSION
  ) {
    addValidationError(
      validation,
      "Policy schema version is invalid."
    );
  }

  if (
    policyDocument.engineName !==
    ENGINE_NAME ||
    policyDocument.engineVersion !==
    ENGINE_VERSION
  ) {
    addValidationError(
      validation,
      "Policy engine metadata is invalid."
    );
  }

  if (!Array.isArray(policyDocument.policies)) {
    addValidationError(
      validation,
      "Policy policies field must be an array."
    );

    return validation;
  }

  const keys =
    policyDocument.policies.map(
      (policy) =>
        policy.key
    );

  if (
    new Set(keys).size !==
    keys.length
  ) {
    addValidationError(
      validation,
      "Policy keys must be unique."
    );
  }

  const sortedKeys =
    [...keys].sort(
      (left, right) =>
        left.localeCompare(right)
    );

  if (
    stableStringify(keys) !==
    stableStringify(sortedKeys)
  ) {
    addValidationError(
      validation,
      "Policy keys must be deterministically sorted."
    );
  }

  for (const policy of policyDocument.policies) {
    if (
      !isPlainObject(policy) ||
      !toNonEmptyStringOrNull(policy.key) ||
      !toNonEmptyStringOrNull(policy.scope) ||
      !isPlainObject(policy.dimensions) ||
      !Object.prototype.hasOwnProperty.call(
        AUTHORITY_LEVELS,
        policy.authority?.level
      )
    ) {
      addValidationError(
        validation,
        `Policy entry is malformed: ${policy?.key || "unknown"}`
      );

      continue;
    }

    if (
      policy.authority
        ?.liveAuthorityPermitted !==
      false
    ) {
      addValidationError(
        validation,
        `Policy Engine must not grant live authority: ${policy.key}`
      );
    }
  }

  if (
    policyDocument.summary
      ?.policyCount !==
    policyDocument.policies.length
  ) {
    addValidationError(
      validation,
      "Policy summary count is inconsistent."
    );
  }

  const embeddedPolicyContentHash =
    toNonEmptyStringOrNull(
      policyDocument.metadata
        ?.policyContentHash
    );

  if (!embeddedPolicyContentHash) {
    addValidationError(
      validation,
      "Policy content hash is missing."
    );
  } else {
    const actualPolicyContentHash =
      createPolicyContentHashFromDocument(
        policyDocument
      );

    if (
      !actualPolicyContentHash ||
      actualPolicyContentHash !==
        embeddedPolicyContentHash
    ) {
      addValidationError(
        validation,
        "Policy content hash does not match the policy body."
      );
    }
  }

  return validation;
}

function buildPolicyDocument({
  runAt,
  config,
  learningDocument,
  confidenceDocument,
  aiMemoryDocument,
  normalized,
  sourceDescriptors,
  crossSourceValidation
}) {
  const runAtMs =
    Date.parse(runAt);

  const referenceCandidates = [
    aiMemoryDocument.generatedAt,
    aiMemoryDocument.sourceUpdatedAt,
    learningDocument.learning?.updatedAt,
    learningDocument.exportedAt,
    confidenceDocument.confidence?.updatedAt,
    confidenceDocument.exportedAt,
    normalized.trades.length > 0
      ? normalized.trades[
          normalized.trades.length - 1
        ].closedAt
      : null
  ]
    .map(
      (value) =>
        toISOStringOrNull(value)
    )
    .filter(Boolean)
    .map(
      (value) =>
        Date.parse(value)
    )
    .filter(
      (value) =>
        Number.isFinite(value) &&
        value <= runAtMs + 60000
    );

  const referenceMs =
    referenceCandidates.length > 0
      ? Math.max(...referenceCandidates)
      : runAtMs;

  const evaluationReferenceAt =
    new Date(referenceMs).toISOString();

  const globalMetrics =
    calculatePerformanceMetrics(
      normalized.trades,
      {
        referenceMs,
        recencyHalfLifeDays:
          toFiniteNumber(
            config.learningEligibility
              ?.recencyHalfLifeDays
          ) || 45
      }
    );

  const buckets =
    buildTradeBuckets(
      normalized.trades
    );

  const policies =
    buckets.map(
      (bucket) =>
        buildPolicyBucket(
          bucket,
          globalMetrics,
          config,
          referenceMs
        )
    );

  const fallbackOrder =
    Array.isArray(
      config.policyIsolation
        ?.fallbackOrder
    )
      ? [
          ...config.policyIsolation
            .fallbackOrder
        ]
      : [];

  const coreContent =
    buildPolicyContentCore({
      configVersion:
        config.configVersion,
      deploymentMode:
        config.deployment.mode,
      autonomousRolloutPercent:
        config.deployment
          .autonomousRolloutPercent,
      sourceHashes:
        Object.fromEntries(
          Object.entries(
            sourceDescriptors
          ).map(
            ([key, descriptor]) =>
              [
                key,
                descriptor.hash
              ]
          )
        ),
      globalMetrics,
      policies
    });

  const policyContentHash =
    createHash(
      coreContent
    );

  const document = {
    version:
      POLICY_SCHEMA_VERSION,
    engineName:
      ENGINE_NAME,
    engineVersion:
      ENGINE_VERSION,
    generatedAt:
      runAt,
    mode:
      config.deployment.mode,
    autonomousRolloutPercent:
      config.deployment
        .autonomousRolloutPercent,
    config: {
      name:
        config.configName,
      version:
        config.configVersion,
      hash:
        sourceDescriptors
          .autonomousConfig.hash
    },
    source: {
      autonomousConfig:
        sourceDescriptors
          .autonomousConfig,
      learningData:
        sourceDescriptors
          .learningData,
      confidenceData:
        sourceDescriptors
          .confidenceData,
      aiMemory:
        sourceDescriptors
          .aiMemory
    },
    summary: {
      sourceSignals:
        normalized.sourceSignals,
      acceptedTrades:
        normalized.acceptedTrades,
      rejectedTrades:
        normalized.rejectedTrades,
      duplicateTrades:
        normalized.duplicateTrades,
      policyCount:
        policies.length,
      actionCounts:
        buildActionSummary(
          policies
        ),
      authorityCounts:
        buildAuthoritySummary(
          policies
        ),
      optionalContextCoverage: {
        sessions:
          normalized.trades.filter(
            (trade) =>
              Boolean(trade.session)
          ).length,
        patterns:
          normalized.trades.filter(
            (trade) =>
              Boolean(trade.pattern)
          ).length,
        marketRegimes:
          normalized.trades.filter(
            (trade) =>
              Boolean(
                trade.marketRegime
              )
          ).length
      }
    },
    globalBaseline:
      globalMetrics,
    policies,
    index:
      buildPolicyIndex(
        policies,
        fallbackOrder
      ),
    rejectionCounts:
      normalized.rejectionCounts,
    crossSourceValidation,
    safety: {
      policyOnly: true,
      liveSignalModification: false,
      confidenceModification: false,
      directionModification: false,
      tradePlanModification: false,
      riskLimitModification: false,
      externalNetworkCalls: false,
      sourceCodeModification: false,
      deterministicFallbackRequired:
        config.deployment
          .deterministicFallbackRequired ===
        true,
      immutableSafetyGateRequired:
        config.riskSafetyGate
          .immutable === true
    },
    methodology: {
      deterministic: true,
      evaluationReferenceAt,
      parameterTrialsPerPolicy: 1,
      bayesianShrinkage: true,
      recencyWeighted: true,
      chronologicalOutOfSample: true,
      purgeOverlapRequired:
        config.policyValidation
          .purgeOverlapRequired === true,
      embargoBars:
        config.policyValidation
          .embargoBars,
      pboStatus:
        "NOT_APPLICABLE_FIXED_POLICY",
      pboReason:
        "No parameter search is performed; one fixed policy specification is evaluated with chronological out-of-sample controls.",
      optimizeFor: [
        "expectancyR",
        "profitFactor",
        "maximumDrawdownR",
        "stability",
        "recency",
        "sampleReliability"
      ],
      doesNotOptimizeFor: [
        "winRateAlone",
        "inSamplePerformanceAlone"
      ]
    },
    validation: {
      valid: true,
      errors: [],
      warnings: [
        ...crossSourceValidation
          .warnings
      ]
    },
    metadata: {
      policyContentHash,
      sourceHash:
        createHash(
          Object.fromEntries(
            Object.entries(
              sourceDescriptors
            ).map(
              ([key, descriptor]) =>
                [
                  key,
                  descriptor.hash
                ]
            )
          )
        ),
      deterministic: true,
      duplicateSafe: true,
      atomicWrite: true,
      pendingTransactionRecovery: true,
      liveConsumerEnabled: false,
      nextConsumer:
        "PipSight Pro AI Decision Engine"
    }
  };

  const validation =
    validatePolicyDocument(
      document
    );

  document.validation = {
    valid:
      validation.valid &&
      crossSourceValidation.valid,
    errors: [
      ...validation.errors,
      ...crossSourceValidation.errors
    ],
    warnings:
      uniqueSortedStrings([
        ...document.validation.warnings,
        ...validation.warnings
      ])
  };

  return document;
}

// -----------------------------------------------------------------------------
// State and transaction recovery
// -----------------------------------------------------------------------------

function createEmptyPolicyState(
  runAt
) {
  return {
    version:
      STATE_SCHEMA_VERSION,
    engineName:
      ENGINE_NAME,
    engineVersion:
      ENGINE_VERSION,
    createdAt:
      runAt,
    updatedAt:
      runAt,
    lastRunAt: null,
    lastSuccessfulRunAt: null,
    sourceHashes: {},
    policyHash: null,
    lastKnownGoodPolicyHash: null,
    lastKnownGoodPolicySnapshot: null,
    pendingTransaction: null,
    counters: {
      runs: 0,
      successfulRuns: 0,
      failedRuns: 0,
      policyWrites: 0,
      unchangedRuns: 0,
      recoveredTransactions: 0
    },
    lastRun: null
  };
}

function normalizeNonNegativeInteger(
  value
) {
  const number =
    toFiniteNumber(value);

  return number === null
    ? 0
    : Math.max(
        0,
        Math.trunc(number)
      );
}

function normalizePolicyState(
  state,
  runAt
) {
  if (!isPlainObject(state)) {
    return createEmptyPolicyState(
      runAt
    );
  }

  const normalized =
    createEmptyPolicyState(
      toISOStringOrNull(
        state.createdAt
      ) || runAt
    );

  normalized.updatedAt =
    toISOStringOrNull(
      state.updatedAt
    ) || runAt;

  normalized.lastRunAt =
    toISOStringOrNull(
      state.lastRunAt
    );

  normalized.lastSuccessfulRunAt =
    toISOStringOrNull(
      state.lastSuccessfulRunAt
    );

  normalized.sourceHashes =
    isPlainObject(state.sourceHashes)
      ? state.sourceHashes
      : {};

  normalized.policyHash =
    toNonEmptyStringOrNull(
      state.policyHash
    );

  normalized.lastKnownGoodPolicyHash =
    toNonEmptyStringOrNull(
      state.lastKnownGoodPolicyHash
    );

  normalized.lastKnownGoodPolicySnapshot =
    isPlainObject(
      state.lastKnownGoodPolicySnapshot
    )
      ? state.lastKnownGoodPolicySnapshot
      : null;

  normalized.pendingTransaction =
    isPlainObject(
      state.pendingTransaction
    )
      ? state.pendingTransaction
      : null;

  normalized.counters = {
    runs:
      normalizeNonNegativeInteger(
        state.counters?.runs
      ),
    successfulRuns:
      normalizeNonNegativeInteger(
        state.counters
          ?.successfulRuns
      ),
    failedRuns:
      normalizeNonNegativeInteger(
        state.counters
          ?.failedRuns
      ),
    policyWrites:
      normalizeNonNegativeInteger(
        state.counters
          ?.policyWrites
      ),
    unchangedRuns:
      normalizeNonNegativeInteger(
        state.counters
          ?.unchangedRuns
      ),
    recoveredTransactions:
      normalizeNonNegativeInteger(
        state.counters
          ?.recoveredTransactions
      )
  };

  normalized.lastRun =
    isPlainObject(state.lastRun)
      ? state.lastRun
      : null;

  return normalized;
}


function createPolicySnapshot(
  policyDocument,
  capturedAt
) {
  const policyValidation =
    validatePolicyDocument(
      policyDocument
    );

  if (!policyValidation.valid) {
    throw new Error(
      `Cannot snapshot an invalid policy document: ${policyValidation.errors.join(" ")}`
    );
  }

  const policyHash =
    createPolicyContentHashFromDocument(
      policyDocument
    );

  if (!policyHash) {
    throw new Error(
      "Cannot snapshot a policy without a valid content hash."
    );
  }

  const capturedAtIso =
    toISOStringOrNull(
      capturedAt
    ) ||
    new Date().toISOString();

  const policy =
    structuredClone(
      policyDocument
    );

  const snapshotCore = {
    version: 1,
    capturedAt:
      capturedAtIso,
    policyHash,
    policy
  };

  return {
    ...snapshotCore,
    snapshotHash:
      createHash(
        snapshotCore
      )
  };
}

function validatePolicySnapshot(
  snapshot
) {
  const validation =
    createValidationResult();

  if (!isPlainObject(snapshot)) {
    addValidationError(
      validation,
      "Last-known-good policy snapshot must be an object."
    );

    return validation;
  }

  if (snapshot.version !== 1) {
    addValidationError(
      validation,
      "Last-known-good policy snapshot version must be 1."
    );
  }

  const capturedAt =
    toISOStringOrNull(
      snapshot.capturedAt
    );

  if (!capturedAt) {
    addValidationError(
      validation,
      "Last-known-good policy snapshot capturedAt is invalid."
    );
  }

  const policyHash =
    toNonEmptyStringOrNull(
      snapshot.policyHash
    );

  const snapshotHash =
    toNonEmptyStringOrNull(
      snapshot.snapshotHash
    );

  if (!policyHash) {
    addValidationError(
      validation,
      "Last-known-good policy snapshot policyHash is missing."
    );
  }

  if (!snapshotHash) {
    addValidationError(
      validation,
      "Last-known-good policy snapshot snapshotHash is missing."
    );
  }

  const policyValidation =
    validatePolicyDocument(
      snapshot.policy
    );

  if (!policyValidation.valid) {
    addValidationError(
      validation,
      `Last-known-good policy snapshot policy is invalid: ${policyValidation.errors.join(" ")}`
    );

    return validation;
  }

  const actualPolicyHash =
    createPolicyContentHashFromDocument(
      snapshot.policy
    );

  if (
    !policyHash ||
    actualPolicyHash !==
      policyHash
  ) {
    addValidationError(
      validation,
      "Last-known-good policy snapshot policyHash does not match the embedded policy."
    );
  }

  if (
    capturedAt &&
    policyHash &&
    snapshotHash
  ) {
    const actualSnapshotHash =
      createHash({
        version: 1,
        capturedAt,
        policyHash,
        policy:
          snapshot.policy
      });

    if (
      actualSnapshotHash !==
      snapshotHash
    ) {
      addValidationError(
        validation,
        "Last-known-good policy snapshot hash does not match the snapshot body."
      );
    }
  }

  return validation;
}

function ensureLastKnownGoodPolicySnapshot({
  state,
  policyDocument,
  policyHash,
  runAt
}) {
  const existingSnapshot =
    state.lastKnownGoodPolicySnapshot;

  if (isPlainObject(existingSnapshot)) {
    const validation =
      validatePolicySnapshot(
        existingSnapshot
      );

    const existingGeneratedAt =
      toISOStringOrNull(
        existingSnapshot.policy
          ?.generatedAt
      );

    const activeGeneratedAt =
      toISOStringOrNull(
        policyDocument?.generatedAt
      );

    if (
      validation.valid &&
      existingSnapshot.policyHash ===
        policyHash &&
      existingGeneratedAt ===
        activeGeneratedAt
    ) {
      return state;
    }
  }

  state.lastKnownGoodPolicySnapshot =
    createPolicySnapshot(
      policyDocument,
      runAt
    );

  return state;
}

function restoreAuthoritativePolicyFromSnapshot(
  state,
  runAt
) {
  if (!state.lastKnownGoodPolicySnapshot) {
    return {
      state,
      restored: false,
      warning: null
    };
  }

  const snapshotValidation =
    validatePolicySnapshot(
      state.lastKnownGoodPolicySnapshot
    );

  if (!snapshotValidation.valid) {
    throw new Error(
      `Last-known-good policy snapshot validation failed: ${snapshotValidation.errors.join(" ")}`
    );
  }

  const snapshot =
    state.lastKnownGoodPolicySnapshot;

  let currentPolicyHash =
    null;

  if (fileExists(AI_POLICY_PATH)) {
    try {
      const currentPolicy =
        readJSON(
          AI_POLICY_PATH,
          {
            required: false,
            defaultValue: null
          }
        );

      const currentValidation =
        validatePolicyDocument(
          currentPolicy
        );

      currentPolicyHash =
        currentValidation.valid
          ? createPolicyContentHashFromDocument(
              currentPolicy
            )
          : null;
    } catch {
      currentPolicyHash =
        null;
    }
  }

  const expectedCurrentHash =
    toNonEmptyStringOrNull(
      state.policyHash
    );

  if (
    currentPolicyHash &&
    (
      !expectedCurrentHash ||
      currentPolicyHash ===
        expectedCurrentHash
    )
  ) {
    return {
      state,
      restored: false,
      warning: null
    };
  }

  atomicWriteJSON(
    AI_POLICY_PATH,
    snapshot.policy
  );

  state.policyHash =
    snapshot.policyHash;

  state.lastKnownGoodPolicyHash =
    snapshot.policyHash;

  state.updatedAt =
    runAt;

  return {
    state,
    restored: true,
    warning:
      "Restored the authoritative policy from the validated last-known-good snapshot before policy evaluation."
  };
}

function recoverPendingTransaction(
  state,
  runAt
) {
  if (!state.pendingTransaction) {
    return {
      state,
      recovered: false,
      warning: null
    };
  }

  const expectedPolicyHash =
    toNonEmptyStringOrNull(
      state.pendingTransaction
        .expectedPolicyHash
    );

  const previousPolicyHash =
    toNonEmptyStringOrNull(
      state.pendingTransaction
        .previousPolicyHash
    );

  let actualPolicy =
    null;

  let actualPolicyHash =
    null;

  if (fileExists(AI_POLICY_PATH)) {
    try {
      actualPolicy =
        readJSON(
          AI_POLICY_PATH,
          {
            required: false,
            defaultValue: null
          }
        );

      const policyValidation =
        validatePolicyDocument(
          actualPolicy
        );

      actualPolicyHash =
        policyValidation.valid
          ? createPolicyContentHashFromDocument(
              actualPolicy
            )
          : null;
    } catch {
      actualPolicy =
        null;

      actualPolicyHash =
        null;
    }
  }

  const committed =
    Boolean(
      expectedPolicyHash &&
      actualPolicyHash ===
        expectedPolicyHash
    );

  let restoredPreviousPolicy =
    false;

  if (committed) {
    state.policyHash =
      actualPolicyHash;

    state.lastKnownGoodPolicyHash =
      actualPolicyHash;

    state =
      ensureLastKnownGoodPolicySnapshot({
        state,
        policyDocument:
          actualPolicy,
        policyHash:
          actualPolicyHash,
        runAt
      });

    state.lastSuccessfulRunAt =
      runAt;
  } else if (
    state.lastKnownGoodPolicySnapshot
  ) {
    const snapshotValidation =
      validatePolicySnapshot(
        state.lastKnownGoodPolicySnapshot
      );

    if (!snapshotValidation.valid) {
      throw new Error(
        `Pending policy recovery cannot use the last-known-good snapshot: ${snapshotValidation.errors.join(" ")}`
      );
    }

    const snapshot =
      state.lastKnownGoodPolicySnapshot;

    if (
      previousPolicyHash &&
      snapshot.policyHash !==
        previousPolicyHash
    ) {
      throw new Error(
        "Pending policy recovery snapshot does not match the transaction previousPolicyHash."
      );
    }

    atomicWriteJSON(
      AI_POLICY_PATH,
      snapshot.policy
    );

    state.policyHash =
      snapshot.policyHash;

    state.lastKnownGoodPolicyHash =
      snapshot.policyHash;

    restoredPreviousPolicy =
      true;
  }

  state.pendingTransaction =
    null;

  state.updatedAt =
    runAt;

  state.counters
    .recoveredTransactions += 1;

  return {
    state,
    recovered: true,
    warning:
      committed
        ? "Recovered a policy write that completed before final state commit."
        : (
            restoredPreviousPolicy
              ? "Restored the previous policy from the validated last-known-good snapshot after an incomplete policy transaction."
              : "Cleared an incomplete pending policy transaction; no validated rollback snapshot was available."
          )
  };
}

function createSourceHashMap(
  descriptors
) {
  return Object.fromEntries(
    Object.entries(descriptors)
      .map(
        ([key, descriptor]) =>
          [
            key,
            descriptor.hash
          ]
      )
  );
}

function beginPolicyTransaction({
  state,
  runAt,
  sourceHashes,
  expectedPolicyHash,
  policyCount,
  acceptedTrades
}) {
  state.updatedAt =
    runAt;

  state.lastRunAt =
    runAt;

  state.counters.runs += 1;

  state.pendingTransaction = {
    version: 1,
    startedAt:
      runAt,
    expectedPolicyHash,
    previousPolicyHash:
      state.policyHash,
    sourceHashes,
    policyCount,
    acceptedTrades
  };

  state.lastRun = {
    status: "PREPARED",
    runAt,
    policyWritten: false,
    stateWritten: true,
    policyCount,
    acceptedTrades,
    error: null
  };

  return state;
}

function completePolicyRun({
  state,
  runAt,
  status,
  sourceHashes,
  policyHash,
  policyDocument,
  policyWritten,
  policyCount,
  acceptedTrades,
  warnings
}) {
  state.updatedAt =
    runAt;

  state.lastRunAt =
    runAt;

  state.lastSuccessfulRunAt =
    runAt;

  state.sourceHashes =
    sourceHashes;

  state.policyHash =
    policyHash;

  state.lastKnownGoodPolicyHash =
    policyHash;

  state =
    ensureLastKnownGoodPolicySnapshot({
      state,
      policyDocument,
      policyHash,
      runAt
    });

  state.pendingTransaction =
    null;

  state.counters.successfulRuns += 1;

  if (policyWritten) {
    state.counters.policyWrites += 1;
  } else {
    state.counters.unchangedRuns += 1;
  }

  state.lastRun = {
    status,
    runAt,
    policyWritten,
    stateWritten: true,
    policyCount,
    acceptedTrades,
    warnings,
    error: null
  };

  return state;
}

function failPolicyRun({
  state,
  runAt,
  error,
  policyWritten,
  stateWritten
}) {
  state.updatedAt =
    runAt;

  state.lastRunAt =
    runAt;

  state.counters.runs +=
    state.lastRun?.status === "PREPARED"
      ? 0
      : 1;

  state.counters.failedRuns += 1;

  state.lastRun = {
    status: "FAILED",
    runAt,
    policyWritten:
      Boolean(policyWritten),
    stateWritten:
      Boolean(stateWritten),
    policyCount: 0,
    acceptedTrades: 0,
    warnings: [],
    error:
      error instanceof Error
        ? error.message
        : String(error)
  };

  return state;
}

// -----------------------------------------------------------------------------
// Runner
// -----------------------------------------------------------------------------

function createRunResult({
  status,
  runAt,
  policyWritten,
  stateWritten,
  policyCount,
  acceptedTrades,
  rejectedTrades,
  duplicateTrades,
  policyHash,
  warnings,
  error
}) {
  return {
    status,
    runAt,
    policyWritten,
    stateWritten,
    policyCount,
    acceptedTrades,
    rejectedTrades,
    duplicateTrades,
    policyHash,
    warnings,
    error
  };
}


function getPolicyFreshnessLimitMinutes(
  config
) {
  const environmentLimit =
    toFiniteNumber(
      process.env
        .PIPSIGHT_POLICY_REFRESH_MINUTES
    );

  if (
    environmentLimit !== null &&
    environmentLimit >= 1
  ) {
    return Math.max(
      1,
      environmentLimit
    );
  }

  const configuredLimit =
    toFiniteNumber(
      config?.policyValidation
        ?.maximumPolicyAgeMinutes
    );

  return Math.max(
    1,
    configuredLimit !== null
      ? configuredLimit
      : 180
  );
}

function policyMetadataRequiresRefresh({
  existingPolicy,
  runAt,
  config
}) {
  if (!isPlainObject(existingPolicy)) {
    return false;
  }

  const runAtMs =
    Date.parse(runAt);

  const generatedAtMs =
    Date.parse(
      existingPolicy.generatedAt ||
      ""
    );

  if (!Number.isFinite(runAtMs)) {
    throw new Error(
      "AI Policy runAt timestamp is invalid."
    );
  }

  if (!Number.isFinite(generatedAtMs)) {
    return true;
  }

  const ageMs =
    runAtMs - generatedAtMs;

  if (ageMs < -60 * 1000) {
    return true;
  }

  const maximumAgeMs =
    getPolicyFreshnessLimitMinutes(
      config
    ) * 60 * 1000;

  return ageMs > maximumAgeMs;
}

function runAIPolicyEngine() {
  const runAt =
    new Date().toISOString();

  let state =
    normalizePolicyState(
      readJSON(
        AI_POLICY_STATE_PATH,
        {
          required: false,
          defaultValue: null
        }
      ),
      runAt
    );

  let policyWritten =
    false;

  let stateWritten =
    false;

  try {
    const recovery =
      recoverPendingTransaction(
        state,
        runAt
      );

    state =
      recovery.state;

    const warnings = [];

    if (recovery.warning) {
      warnings.push(
        recovery.warning
      );
    }

    const snapshotRecovery =
      restoreAuthoritativePolicyFromSnapshot(
        state,
        runAt
      );

    state =
      snapshotRecovery.state;

    if (snapshotRecovery.warning) {
      warnings.push(
        snapshotRecovery.warning
      );
    }

    const config =
      readJSON(
        AUTONOMOUS_CONFIG_PATH
      );

    const learningDocument =
      readJSON(
        LEARNING_DATA_PATH
      );

    const confidenceDocument =
      readJSON(
        CONFIDENCE_DATA_PATH
      );

    const aiMemoryDocument =
      readJSON(
        AI_MEMORY_PATH
      );

    throwOnInvalidSource(
      "Autonomous config",
      validateAutonomousConfig(
        config
      )
    );

    throwOnInvalidSource(
      "Learning data",
      validateLearningDocument(
        learningDocument
      )
    );

    throwOnInvalidSource(
      "Confidence data",
      validateConfidenceDocument(
        confidenceDocument
      )
    );

    throwOnInvalidSource(
      "AI Memory",
      validateAIMemoryDocument(
        aiMemoryDocument
      )
    );

    const normalized =
      normalizeLearningTrades(
        learningDocument,
        config,
        runAt
      );

    const crossSourceValidation =
      buildCrossSourceValidation(
        normalized,
        confidenceDocument,
        aiMemoryDocument
      );

    if (!crossSourceValidation.valid) {
      throw new Error(
        `Cross-source validation failed: ${crossSourceValidation.errors.join(" ")}`
      );
    }

    warnings.push(
      ...crossSourceValidation.warnings
    );

    const sourceDescriptors = {
      autonomousConfig:
        createSourceDescriptor(
          AUTONOMOUS_CONFIG_PATH,
          config
        ),
      learningData:
        createSourceDescriptor(
          LEARNING_DATA_PATH,
          learningDocument
        ),
      confidenceData:
        createSourceDescriptor(
          CONFIDENCE_DATA_PATH,
          confidenceDocument
        ),
      aiMemory:
        createSourceDescriptor(
          AI_MEMORY_PATH,
          aiMemoryDocument
        )
    };

    const policyDocument =
      buildPolicyDocument({
        runAt,
        config,
        learningDocument,
        confidenceDocument,
        aiMemoryDocument,
        normalized,
        sourceDescriptors,
        crossSourceValidation
      });

    if (
      policyDocument.validation.valid !==
      true
    ) {
      throw new Error(
        `Generated policy validation failed: ${policyDocument.validation.errors.join(" ")}`
      );
    }

    warnings.push(
      ...policyDocument
        .validation.warnings
    );

    const policyHash =
      policyDocument.metadata
        .policyContentHash;

    const sourceHashes =
      createSourceHashMap(
        sourceDescriptors
      );

    let existingPolicy =
      null;

    let existingPolicyHash =
      null;

    if (fileExists(AI_POLICY_PATH)) {
      existingPolicy =
        readJSON(
          AI_POLICY_PATH,
          {
            required: false,
            defaultValue: null
          }
        );

      const existingPolicyValidation =
        validatePolicyDocument(
          existingPolicy
        );

      existingPolicyHash =
        existingPolicyValidation.valid
          ? createPolicyContentHashFromDocument(
              existingPolicy
            )
          : null;
    }

    const contentUnchanged =
      existingPolicyHash ===
      policyHash;

    const metadataRefreshRequired =
      contentUnchanged &&
      policyMetadataRequiresRefresh({
        existingPolicy,
        runAt,
        config
      });

    if (metadataRefreshRequired) {
      warnings.push(
        "Refreshed unchanged AI Policy metadata to preserve the configured freshness contract."
      );
    }

    const unchanged =
      contentUnchanged &&
      !metadataRefreshRequired;

    if (!unchanged) {
      state =
        beginPolicyTransaction({
          state,
          runAt,
          sourceHashes,
          expectedPolicyHash:
            policyHash,
          policyCount:
            policyDocument
              .summary.policyCount,
          acceptedTrades:
            normalized.acceptedTrades
        });

      atomicWriteJSON(
        AI_POLICY_STATE_PATH,
        state
      );

      stateWritten =
        true;

      atomicWriteJSON(
        AI_POLICY_PATH,
        policyDocument
      );

      policyWritten =
        true;
    } else {
      state.updatedAt =
        runAt;

      state.lastRunAt =
        runAt;

      state.counters.runs += 1;
    }

    state =
      completePolicyRun({
        state,
        runAt,
        status:
          unchanged
            ? "UNCHANGED"
            : "UPDATED",
        sourceHashes,
        policyHash,
        policyDocument:
          policyWritten
            ? policyDocument
            : (
                existingPolicy ||
                policyDocument
              ),
        policyWritten,
        policyCount:
          policyDocument
            .summary.policyCount,
        acceptedTrades:
          normalized.acceptedTrades,
        warnings:
          uniqueSortedStrings(
            warnings
          )
      });

    atomicWriteJSON(
      AI_POLICY_STATE_PATH,
      state
    );

    stateWritten =
      true;

    const result =
      createRunResult({
        status:
          unchanged
            ? "UNCHANGED"
            : "UPDATED",
        runAt,
        policyWritten,
        stateWritten,
        policyCount:
          policyDocument
            .summary.policyCount,
        acceptedTrades:
          normalized.acceptedTrades,
        rejectedTrades:
          normalized.rejectedTrades,
        duplicateTrades:
          normalized.duplicateTrades,
        policyHash,
        warnings:
          uniqueSortedStrings(
            warnings
          ),
        error: null
      });

    console.log(
      `[ai-policy] ${result.status}: ${result.policyCount} policy bucket(s), ` +
      `${result.acceptedTrades} accepted trade(s), ` +
      `${result.rejectedTrades} rejected trade(s).`
    );

    console.log(
      `[ai-policy] Policy hash: ${result.policyHash}`
    );

    if (
      result.warnings.length >
      0
    ) {
      console.warn(
        `[ai-policy] Completed with ${result.warnings.length} warning(s).`
      );
    }

    return result;
  } catch (error) {
    state =
      failPolicyRun({
        state,
        runAt,
        error,
        policyWritten,
        stateWritten
      });

    try {
      atomicWriteJSON(
        AI_POLICY_STATE_PATH,
        state
      );

      stateWritten =
        true;
    } catch (stateWriteError) {
      console.error(
        `[ai-policy] Unable to write failure state: ${stateWriteError.message}`
      );
    }

    const errorMessage =
      error instanceof Error
        ? error.message
        : String(error);

    console.error(
      `[ai-policy] FAILED: ${errorMessage}`
    );

    return createRunResult({
      status: "FAILED",
      runAt,
      policyWritten,
      stateWritten,
      policyCount: 0,
      acceptedTrades: 0,
      rejectedTrades: 0,
      duplicateTrades: 0,
      policyHash: null,
      warnings: [],
      error:
        errorMessage
    });
  }
}

// -----------------------------------------------------------------------------
// Direct execution
// -----------------------------------------------------------------------------

if (
  require.main ===
  module
) {
  const result =
    runAIPolicyEngine();

  if (
    result.status ===
    "FAILED"
  ) {
    process.exitCode =
      1;
  }
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

module.exports = {
  ENGINE_NAME,
  ENGINE_VERSION,
  POLICY_SCHEMA_VERSION,
  STATE_SCHEMA_VERSION,

  paths: {
    data:
      DATA_DIR,
    autonomousConfig:
      AUTONOMOUS_CONFIG_PATH,
    learningData:
      LEARNING_DATA_PATH,
    confidenceData:
      CONFIDENCE_DATA_PATH,
    aiMemory:
      AI_MEMORY_PATH,
    aiPolicy:
      AI_POLICY_PATH,
    aiPolicyState:
      AI_POLICY_STATE_PATH
  },

  runAIPolicyEngine,
  buildPolicyDocument,
  buildTradeBuckets,
  buildPolicyBucket,
  calculatePerformanceMetrics,
  calculateOutOfSampleValidation,
  calculateReliability,
  calculateEdgeScore,
  normalizeLearningTrades,
  normalizeLearningTrade,
  createTradeCanonicalKey,
  validateAutonomousConfig,
  validateLearningDocument,
  validateConfidenceDocument,
  validateAIMemoryDocument,
  validatePolicyDocument,
  createPolicySnapshot,
  validatePolicySnapshot,
  restoreAuthoritativePolicyFromSnapshot,
  normalizePair,
  normalizeEngine,
  normalizeDirection,
  normalizeOutcome,
  normalizeTimeframe,
  createHash
};
