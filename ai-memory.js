// ai-memory.js
//
// PipSight Pro — Adaptive AI Memory Engine.
//
// Phase 2 purpose:
// - Read the persisted outputs produced by the Automatic Learning Engine.
// - Convert learned trade history into deterministic performance memory.
// - Maintain pair-wise, engine-wise, direction-wise, timeframe-wise,
//   session-wise, pattern-wise and market-regime-wise memory where
//   the source data actually supports those dimensions.
// - Handle missing optional metadata safely without inventing values.
// - Keep AI Memory completely independent from existing trading engines.
// - Build an advisory-only Autonomous Memory Extension with recency-weighted,
//   Bayesian-shrunk, R-normalized and drift-aware evidence for the separate
//   AI Policy Engine. The extension never receives live execution authority.
//
// Reads:
//   data/learning-data.json
//   data/confidence-data.json
//   data/learning-enrichment.json
//   data/learning-enrichment-state.json
//   data/ai-memory.json
//   data/ai-memory-state.json
//
// Writes:
//   data/ai-memory.json
//   data/ai-memory-state.json
//
// Compatibility:
// - CommonJS / Node.js 20.
// - Existing learner.js APIs and schemas remain unchanged.
// - Existing run-learning-engine.js behavior remains unchanged.
// - Existing Swing, Intraday, Scalp, Master, Telegram and history
//   integrations remain unchanged.
// - Existing learning-data.json and confidence-data.json are read-only.
// - Missing session, pattern or market-regime metadata is never inferred.
// - Repeated executions are deterministic and duplicate-safe.

"use strict";

const fs =
  require(
    "fs"
  );

const path =
  require(
    "path"
  );

const crypto =
  require(
    "crypto"
  );

// -----------------------------------------------------------------------------
// Engine metadata
// -----------------------------------------------------------------------------

const ENGINE_NAME =
  "PipSight Pro Adaptive AI Memory Engine";

/*
 * Compatibility identity.
 *
 * Existing Live Analysis, hourly workflow validation and the already deployed
 * AI Policy Engine currently hard-lock this value. It intentionally remains
 * 1.0.1 until those consumers are upgraded in the final integration phase.
 */
const ENGINE_VERSION =
  "1.0.1";

/*
 * Autonomous intelligence revision.
 *
 * This version identifies the new advisory memory layer without breaking the
 * established AI Memory document and workflow compatibility contract.
 */
const AUTONOMOUS_MEMORY_ENGINE_NAME =
  "PipSight Pro Autonomous Memory Extension";

const AUTONOMOUS_MEMORY_VERSION =
  "1.4.0";

const AUTONOMOUS_MEMORY_SCHEMA_VERSION =
  1;

const MEMORY_SCHEMA_VERSION =
  1;

const STATE_SCHEMA_VERSION =
  1;

/*
 * Phase 3B enrichment compatibility lock.
 *
 * These constants validate only the optional advisory source.
 * They do not change the existing AI Memory or state schema versions.
 */
const SUPPORTED_ENRICHMENT_SCHEMA_VERSION =
  1;

const SUPPORTED_ENRICHMENT_ENGINE_NAME =
  "PipSight Pro Learning Enrichment Engine";

const SUPPORTED_ENRICHMENT_ENGINE_VERSION =
  "1.0.0";

const SUPPORTED_ENRICHMENT_MODE =
  "advisory";

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

const LEARNING_ENRICHMENT_PATH =
  path.join(
    DATA_DIR,
    "learning-enrichment.json"
  );

const LEARNING_ENRICHMENT_STATE_PATH =
  path.join(
    DATA_DIR,
    "learning-enrichment-state.json"
  );

const AI_MEMORY_PATH =
  path.join(
    DATA_DIR,
    "ai-memory.json"
  );

const AI_MEMORY_STATE_PATH =
  path.join(
    DATA_DIR,
    "ai-memory-state.json"
  );

// -----------------------------------------------------------------------------
// Supported canonical values
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
    "D1"
  ]);

// Optional dimensions are deliberately not restricted to a hard-coded list.
// Their source values may evolve in future engine versions, but only valid,
// explicitly supplied metadata will be accepted.

const OPTIONAL_DIMENSIONS =
  Object.freeze([
    "session",
    "pattern",
    "marketRegime"
  ]);

const DIMENSION_NAMES =
  Object.freeze([
    "pairs",
    "engines",
    "directions",
    "timeframes",
    "sessions",
    "patterns",
    "marketRegimes"
  ]);

// -----------------------------------------------------------------------------
// Processing limits
// -----------------------------------------------------------------------------

const MAX_PROCESSED_KEYS =
  100000;

const HASH_ALGORITHM =
  "sha256";

const DAY_MS =
  24 * 60 * 60 * 1000;

const LN_2 =
  Math.log(
    2
  );

const AUTONOMOUS_MEMORY_CONFIG =
  Object.freeze({
    recencyHalfLifeDays: 45,
    minimumRecencyWeight: 0.01,
    bayesianPriorStrength: 20,
    maximumAbsoluteRealizedR: 20,
    recentWindowSize: 20,
    driftMinimumWindowSamples: 10,
    driftThresholdR: 0.25,
    supportiveExpectancyR: 0.05,
    suppressiveExpectancyR: -0.05,
    filterMinimumSamples: 30,
    filterMinimumReliability: 0.70,
    tradePlanMinimumSamples: 50,
    tradePlanMinimumReliability: 0.80,
    directionMinimumSamples: 75,
    directionMinimumReliability: 0.85
  });

const AUTONOMOUS_SCOPE_DEFINITIONS =
  Object.freeze({
    pair: [
      "pair"
    ],
    engine: [
      "engine"
    ],
    direction: [
      "direction"
    ],
    pairDirection: [
      "pair",
      "direction"
    ],
    pairTimeframeDirection: [
      "pair",
      "timeframe",
      "direction"
    ],
    pairEngineDirection: [
      "pair",
      "engine",
      "direction"
    ],
    pairTimeframeEngineDirection: [
      "pair",
      "timeframe",
      "engine",
      "direction"
    ],
    pairTimeframeEngineDirectionRegime: [
      "pair",
      "timeframe",
      "engine",
      "direction",
      "marketRegime"
    ],
    pairTimeframeEngineDirectionRegimeSession: [
      "pair",
      "timeframe",
      "engine",
      "direction",
      "marketRegime",
      "session"
    ],
    pairTimeframeEngineDirectionPattern: [
      "pair",
      "timeframe",
      "engine",
      "direction",
      "pattern"
    ]
  });

// -----------------------------------------------------------------------------
// Generic type helpers
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

function isFiniteNumber(
  value
) {

  return (
    typeof value === "number" &&
    Number.isFinite(
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

function toNonEmptyStringOrNull(
  value
) {

  const text =
    toTrimmedString(
      value
    );

  return text || null;

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

function round(
  value,
  decimals = 4
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

  const precision =
    Number.isInteger(
      decimals
    )
      ? Math.max(
          0,
          Math.min(
            decimals,
            12
          )
        )
      : 4;

  const multiplier =
    10 ** precision;

  return Math.round(
    (
      number +
      Number.EPSILON
    ) *
    multiplier
  ) / multiplier;

}

function clamp(
  value,
  minimum,
  maximum
) {

  const number =
    toFiniteNumber(
      value
    );

  const lower =
    toFiniteNumber(
      minimum
    );

  const upper =
    toFiniteNumber(
      maximum
    );

  if (
    number === null ||
    lower === null ||
    upper === null ||
    lower > upper
  ) {

    return null;

  }

  return Math.max(
    lower,
    Math.min(
      upper,
      number
    )
  );

}

function uniqueSortedStrings(
  values
) {

  if (
    !Array.isArray(
      values
    )
  ) {

    return [];

  }

  return Array.from(
    new Set(
      values
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
  ).sort(
    (
      left,
      right
    ) =>
      left.localeCompare(
        right
      )
  );

}

function cloneJSONCompatible(
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

// -----------------------------------------------------------------------------
// File-system helpers
// -----------------------------------------------------------------------------

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

function fileExists(
  filePath
) {

  try {

    return fs.existsSync(
      filePath
    );

  } catch (
    error
  ) {

    return false;

  }

}

function getFileModifiedAt(
  filePath
) {

  try {

    if (
      !fileExists(
        filePath
      )
    ) {

      return null;

    }

    const stats =
      fs.statSync(
        filePath
      );

    if (
      !stats ||
      !isFiniteNumber(
        stats.mtimeMs
      )
    ) {

      return null;

    }

    return new Date(
      stats.mtimeMs
    ).toISOString();

  } catch (
    error
  ) {

    return null;

  }

}

// -----------------------------------------------------------------------------
// Safe JSON I/O
// -----------------------------------------------------------------------------

function readJSON(
  filePath,
  fallbackValue = null
) {

  try {

    if (
      !fileExists(
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
      `[ai-memory] Unable to read JSON: ${path.relative(
        ROOT_DIR,
        filePath
      )}`
    );

    console.warn(
      `[ai-memory] ${error.message}`
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

  } catch (
    error
  ) {

    try {

      if (
        fileExists(
          temporaryPath
        )
      ) {

        fs.unlinkSync(
          temporaryPath
        );

      }

    } catch (
      cleanupError
    ) {

      // Preserve the original write error.
    }

    throw error;

  }

}

// -----------------------------------------------------------------------------
// Deterministic serialization and hashing
// -----------------------------------------------------------------------------

function sortObjectKeysDeep(
  value
) {

  if (
    Array.isArray(
      value
    )
  ) {

    return value.map(
      item =>
        sortObjectKeysDeep(
          item
        )
    );

  }

  if (
    !isPlainObject(
      value
    )
  ) {

    return value;

  }

  const sorted =
    {};

  for (
    const key of Object.keys(
      value
    ).sort(
      (
        left,
        right
      ) =>
        left.localeCompare(
          right
        )
    )
  ) {

    sorted[key] =
      sortObjectKeysDeep(
        value[key]
      );

  }

  return sorted;

}

function stableStringify(
  value
) {

  return JSON.stringify(
    sortObjectKeysDeep(
      value
    )
  );

}

function createHash(
  value
) {

  return crypto
    .createHash(
      HASH_ALGORITHM
    )
    .update(
      stableStringify(
        value
      ),
      "utf8"
    )
    .digest(
      "hex"
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
// Engine / strategy normalization
// -----------------------------------------------------------------------------

function normalizeEngine(
  value
) {

  const compact =
    toTrimmedString(
      value
    )
      .toLowerCase()
      .replace(
        /[_\s]+/g,
        "-"
      );

  if (
    !compact
  ) {

    return null;

  }

  if (
    compact === "scalp" ||
    compact.startsWith(
      "scalp-"
    ) ||
    compact === "scalping"
  ) {

    return "scalp";

  }

  if (
    compact === "daily" ||
    compact === "intraday" ||
    compact === "day"
  ) {

    return "daily";

  }

  if (
    compact === "weekly" ||
    compact === "swing" ||
    compact === "week"
  ) {

    return "weekly";

  }

  return compact;

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
    direction === "BUY" ||
    direction === "LONG" ||
    direction === "BULLISH"
  ) {

    return "BUY";

  }

  if (
    direction === "SELL" ||
    direction === "SHORT" ||
    direction === "BEARISH"
  ) {

    return "SELL";

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
        /[\s_-]+/g,
        ""
      );

  if (
    outcome === "WIN" ||
    outcome === "WON" ||
    outcome === "PROFIT" ||
    outcome === "TP" ||
    outcome === "TAKEPROFIT"
  ) {

    return "WIN";

  }

  if (
    outcome === "LOSS" ||
    outcome === "LOST" ||
    outcome === "STOP" ||
    outcome === "SL" ||
    outcome === "STOPLOSS"
  ) {

    return "LOSS";

  }

  if (
    outcome === "BREAKEVEN" ||
    outcome === "BE" ||
    outcome === "DRAW" ||
    outcome === "FLAT"
  ) {

    return "BREAKEVEN";

  }

  return null;

}

// -----------------------------------------------------------------------------
// Timeframe normalization
// -----------------------------------------------------------------------------

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

  const aliases =
    {
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
      "1hour": "1H",

      "4h": "4H",
      "h4": "4H",
      "240m": "4H",
      "240min": "4H",
      "4hour": "4H",
      "4hours": "4H",

      "1d": "D1",
      "d1": "D1",
      "daily": "D1",
      "day": "D1"
    };

  return aliases[compact] || raw;

}

// -----------------------------------------------------------------------------
// Optional metadata normalization
// -----------------------------------------------------------------------------

function normalizeMetadataLabel(
  value,
  options = {}
) {

  const {
    uppercase = false,
    lowercase = false,
    maximumLength = 120
  } = options;

  let text =
    toTrimmedString(
      value
    )
      .replace(
        /\s+/g,
        " "
      );

  if (
    !text
  ) {

    return null;

  }

  if (
    uppercase
  ) {

    text =
      text.toUpperCase();

  } else if (
    lowercase
  ) {

    text =
      text.toLowerCase();

  }

  if (
    text.length >
    maximumLength
  ) {

    text =
      text.slice(
        0,
        maximumLength
      );

  }

  return text || null;

}

function normalizeSession(
  value
) {

  return normalizeMetadataLabel(
    value,
    {
      lowercase: true,
      maximumLength: 80
    }
  );

}

function normalizePattern(
  value
) {

  return normalizeMetadataLabel(
    value,
    {
      maximumLength: 120
    }
  );

}

function normalizeMarketRegime(
  value
) {

  return normalizeMetadataLabel(
    value,
    {
      lowercase: true,
      maximumLength: 120
    }
  );

}

// -----------------------------------------------------------------------------
// Nested property helpers
// -----------------------------------------------------------------------------

function getNestedValue(
  source,
  propertyPath
) {

  if (
    !source ||
    !Array.isArray(
      propertyPath
    ) ||
    propertyPath.length === 0
  ) {

    return undefined;

  }

  let current =
    source;

  for (
    const propertyName of propertyPath
  ) {

    if (
      current === null ||
      current === undefined ||
      (
        typeof current !== "object" &&
        typeof current !== "function"
      )
    ) {

      return undefined;

    }

    if (
      !Object.prototype.hasOwnProperty.call(
        current,
        propertyName
      )
    ) {

      return undefined;

    }

    current =
      current[propertyName];

  }

  return current;

}

function getFirstDefinedValue(
  source,
  candidatePaths
) {

  if (
    !Array.isArray(
      candidatePaths
    )
  ) {

    return undefined;

  }

  for (
    const propertyPath of candidatePaths
  ) {

    const value =
      getNestedValue(
        source,
        propertyPath
      );

    if (
      value !== undefined &&
      value !== null &&
      value !== ""
    ) {

      return value;

    }

  }

  return undefined;

}

// -----------------------------------------------------------------------------
// Source metadata extraction
// -----------------------------------------------------------------------------

function extractSession(
  record
) {

  const sourceValue =
    getFirstDefinedValue(
      record,
      [
        ["session"],
        ["marketSession"],
        ["tradingSession"],
        ["metadata", "session"],
        ["metadata", "marketSession"],
        ["context", "session"],
        ["context", "marketSession"]
      ]
    );

  return normalizeSession(
    sourceValue
  );

}

function extractPattern(
  record
) {

  const sourceValue =
    getFirstDefinedValue(
      record,
      [
        ["pattern"],
        ["patternName"],
        ["candlePattern"],
        ["setupPattern"],
        ["metadata", "pattern"],
        ["metadata", "patternName"],
        ["context", "pattern"],
        ["context", "patternName"]
      ]
    );

  return normalizePattern(
    sourceValue
  );

}

function extractMarketRegime(
  record
) {

  const sourceValue =
    getFirstDefinedValue(
      record,
      [
        ["marketRegime"],
        ["regime"],
        ["marketState"],
        ["metadata", "marketRegime"],
        ["metadata", "regime"],
        ["metadata", "marketState"],
        ["context", "marketRegime"],
        ["context", "regime"],
        ["context", "marketState"]
      ]
    );

  return normalizeMarketRegime(
    sourceValue
  );

}

// -----------------------------------------------------------------------------
// Validation result helpers
// -----------------------------------------------------------------------------

function createValidationResult(
  valid,
  errors = [],
  warnings = []
) {

  return {
    valid: Boolean(
      valid
    ),
    errors: uniqueSortedStrings(
      errors
    ),
    warnings: uniqueSortedStrings(
      warnings
    )
  };

}

function mergeValidationResults(
  results
) {

  const normalizedResults =
    Array.isArray(
      results
    )
      ? results.filter(
          isPlainObject
        )
      : [];

  const errors =
    [];

  const warnings =
    [];

  for (
    const result of normalizedResults
  ) {

    if (
      Array.isArray(
        result.errors
      )
    ) {

      errors.push(
        ...result.errors
      );

    }

    if (
      Array.isArray(
        result.warnings
      )
    ) {

      warnings.push(
        ...result.warnings
      );

    }

  }

  return createValidationResult(
    errors.length === 0,
    errors,
    warnings
  );

}

// -----------------------------------------------------------------------------
// Optional Learning Enrichment integration
// -----------------------------------------------------------------------------

function createUnavailableEnrichmentMemory(
  reason = "Learning Enrichment is unavailable."
) {

  return {
    available: false,
    advisoryOnly: true,
    compatible: false,
    reason:
      toNonEmptyStringOrNull(
        reason
      ) ||
      "Learning Enrichment is unavailable.",
    generatedAt: null,
    sourceUpdatedAt: null,
    summary: null,
    intelligence: null,
    configuration: null,
    source: null
  };

}

function validateLearningEnrichmentDocument(
  document
) {

  const errors =
    [];

  const warnings =
    [];

  if (
    document === null ||
    document === undefined
  ) {

    warnings.push(
      "learning-enrichment.json is missing; AI Memory will continue with its existing behavior."
    );

    return createValidationResult(
      true,
      errors,
      warnings
    );

  }

  if (
    !isPlainObject(
      document
    )
  ) {

    warnings.push(
      "learning-enrichment.json root is invalid; enrichment will be ignored."
    );

    return createValidationResult(
      true,
      errors,
      warnings
    );

  }

  const compatible =
    document.version ===
      SUPPORTED_ENRICHMENT_SCHEMA_VERSION &&
    document.engineName ===
      SUPPORTED_ENRICHMENT_ENGINE_NAME &&
    document.engineVersion ===
      SUPPORTED_ENRICHMENT_ENGINE_VERSION &&
    document.mode ===
      SUPPORTED_ENRICHMENT_MODE &&
    document.validation?.valid ===
      true &&
    document.safety?.advisoryOnly ===
      true &&
    document.metadata?.productionConsumerEnabled ===
      false &&
    isPlainObject(
      document.summary
    ) &&
    isPlainObject(
      document.intelligence
    );

  if (
    !compatible
  ) {

    warnings.push(
      "learning-enrichment.json is incompatible or failed its advisory safety contract; enrichment will be ignored."
    );

  }

  return createValidationResult(
    true,
    errors,
    warnings
  );

}

function buildEnrichmentMemory(
  enrichmentDocument
) {

  const validation =
    validateLearningEnrichmentDocument(
      enrichmentDocument
    );

  const compatible =
    isPlainObject(
      enrichmentDocument
    ) &&
    validation.warnings.length ===
      0;

  if (
    !compatible
  ) {

    return {
      memory:
        createUnavailableEnrichmentMemory(
          validation.warnings[0]
        ),
      validation
    };

  }

  return {
    memory: {
      available: true,
      advisoryOnly: true,
      compatible: true,
      reason: null,
      generatedAt:
        toISOStringOrNull(
          enrichmentDocument.generatedAt
        ),
      sourceUpdatedAt:
        cloneJSONCompatible(
          enrichmentDocument.sourceUpdatedAt ||
          null
        ),
      summary:
        cloneJSONCompatible(
          enrichmentDocument.summary
        ),
      intelligence:
        cloneJSONCompatible(
          enrichmentDocument.intelligence
        ),
      configuration:
        cloneJSONCompatible(
          enrichmentDocument.configuration ||
          null
        ),
      source:
        cloneJSONCompatible(
          enrichmentDocument.source ||
          null
        )
    },
    validation
  };

}

function loadOptionalLearningEnrichment() {

  const document =
    readJSON(
      LEARNING_ENRICHMENT_PATH,
      null
    );

  const stateDocument =
    readJSON(
      LEARNING_ENRICHMENT_STATE_PATH,
      null
    );

  const built =
    buildEnrichmentMemory(
      document
    );

  const stateHealthy =
    isPlainObject(
      stateDocument
    ) &&
    stateDocument.engineName ===
      SUPPORTED_ENRICHMENT_ENGINE_NAME &&
    stateDocument.engineVersion ===
      SUPPORTED_ENRICHMENT_ENGINE_VERSION &&
    stateDocument.mode ===
      SUPPORTED_ENRICHMENT_MODE &&
    [
      "UPDATED",
      "UNCHANGED"
    ].includes(
      stateDocument.lastRun?.status
    ) &&
    stateDocument.lastRun?.error ===
      null;

  if (
    built.memory.available &&
    !stateHealthy
  ) {

    built.memory =
      createUnavailableEnrichmentMemory(
        "learning-enrichment-state.json is missing or unhealthy; enrichment was ignored."
      );

    built.validation =
      createValidationResult(
        true,
        [],
        [
          "learning-enrichment-state.json is missing or unhealthy; enrichment was ignored."
        ]
      );

  }

  return {
    document,
    stateDocument,
    memory:
      built.memory,
    validation:
      built.validation,
    hash:
      document &&
      built.memory.available
        ? createHash(
            document
          )
        : null,
    modifiedAt:
      built.memory.available
        ? getFileModifiedAt(
            LEARNING_ENRICHMENT_PATH
          )
        : null
  };

}


// -----------------------------------------------------------------------------
// Autonomous Memory Extension 1.4.0
// -----------------------------------------------------------------------------

function createEmptyAutonomousMetric() {

  return {
    totalTrades: 0,
    decisiveTrades: 0,
    wins: 0,
    losses: 0,
    breakevens: 0,

    realizedRSamples: 0,
    invalidRSamples: 0,
    futureDatedSamples: 0,

    winRate: 0,
    bayesianWinRate: 50,

    winRateInterval95: {
      lower: 0,
      upper: 100,
      width: 100
    },

    expectancyR: null,
    recencyWeightedExpectancyR: null,
    profitFactorR: null,

    averageWinR: null,
    averageLossR: null,
    standardDeviationR: null,

    maximumDrawdownR: null,
    currentDrawdownR: null,
    maximumConsecutiveLosses: 0,

    recency: {
      halfLifeDays:
        AUTONOMOUS_MEMORY_CONFIG
          .recencyHalfLifeDays,
      weightSum: 0,
      effectiveSampleSize: 0,
      latestClosedAt: null
    },

    drift: {
      status: "INSUFFICIENT_DATA",
      recentSamples: 0,
      priorSamples: 0,
      recentExpectancyR: null,
      priorExpectancyR: null,
      expectancyChangeR: null
    },

    quality: {
      rCoverage: 0,
      sampleScore: 0,
      recencyScore: 0,
      intervalScore: 0,
      stabilityScore: 0,
      reliability: 0
    },

    evidence: {
      action: "OBSERVE",
      reason:
        "Insufficient decisive, risk-normalized evidence.",
      filterEvidenceReady: false,
      tradePlanEvidenceReady: false,
      directionEvidenceReady: false,
      policyAuthorityEligible: false
    },

    firstTradeAt: null,
    lastTradeAt: null
  };

}

function createEmptyAutonomousMemory(
  generatedAt =
    new Date().toISOString()
) {

  const scopes =
    {};

  for (
    const scopeName of
    Object.keys(
      AUTONOMOUS_SCOPE_DEFINITIONS
    ).sort()
  ) {

    scopes[scopeName] =
      {};

  }

  return {
    version:
      AUTONOMOUS_MEMORY_SCHEMA_VERSION,

    engineName:
      AUTONOMOUS_MEMORY_ENGINE_NAME,

    engineVersion:
      AUTONOMOUS_MEMORY_VERSION,

    generatedAt:
      toISOStringOrNull(
        generatedAt
      ) ||
      new Date().toISOString(),

    advisoryOnly: true,
    liveAuthorityPermitted: false,

    methodology: {
      chronological: true,
      duplicateSafe: true,
      futureDatedEvidenceExcluded: true,
      breakevenCountsTowardMaturity: false,
      realizedRRequiredForExpectancy: true,
      bayesianShrinkage: true,
      wilsonInterval95: true,
      exponentialRecencyWeighting: true,
      conceptDriftMonitoring: true,
      outOfSampleAuthorityValidationRequiredElsewhere: true,
      noParameterSearch: true
    },

    configuration:
      cloneJSONCompatible(
        AUTONOMOUS_MEMORY_CONFIG
      ),

    source: {
      acceptedCanonicalTrades: 0,
      normalizedTradeSetHash: null,
      realizedRTrades: 0,
      invalidRTrades: 0,
      futureDatedTrades: 0
    },

    global:
      createEmptyAutonomousMetric(),

    scopes,

    summary: {
      scopeCount:
        Object.keys(
          AUTONOMOUS_SCOPE_DEFINITIONS
        ).length,
      bucketCount: 0,
      supportiveBuckets: 0,
      suppressiveBuckets: 0,
      observeBuckets: 0,
      filterEvidenceReadyBuckets: 0,
      tradePlanEvidenceReadyBuckets: 0,
      directionEvidenceReadyBuckets: 0
    },

    validation: {
      valid: true,
      errors: [],
      warnings: []
    }
  };

}

function calculateTradeRealizedR(
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

  const initialRisk =
    Math.abs(
      entry -
      stopLoss
    );

  if (
    !Number.isFinite(
      initialRisk
    ) ||
    initialRisk <= 0
  ) {

    return null;

  }

  let profitPoints =
    toFiniteNumber(
      trade?.profitPoints
    );

  if (
    profitPoints === null
  ) {

    if (
      trade?.outcome ===
      "LOSS"
    ) {

      profitPoints =
        -initialRisk;

    } else if (
      trade?.outcome ===
      "BREAKEVEN"
    ) {

      profitPoints =
        0;

    } else if (
      trade?.outcome ===
      "WIN"
    ) {

      const takeProfit =
        toFiniteNumber(
          trade?.takeProfit
        );

      if (
        takeProfit !== null
      ) {

        profitPoints =
          Math.abs(
            takeProfit -
            entry
          );

      }

    }

  }

  if (
    profitPoints === null
  ) {

    return null;

  }

  const realizedR =
    profitPoints /
    initialRisk;

  if (
    !Number.isFinite(
      realizedR
    ) ||
    Math.abs(
      realizedR
    ) >
    AUTONOMOUS_MEMORY_CONFIG
      .maximumAbsoluteRealizedR
  ) {

    return null;

  }

  return round(
    realizedR,
    8
  );

}

function calculateRecencyWeight(
  closedAt,
  generatedAt
) {

  const normalizedClosedAt =
    toISOStringOrNull(
      closedAt
    );

  const normalizedGeneratedAt =
    toISOStringOrNull(
      generatedAt
    );

  if (
    !normalizedClosedAt ||
    !normalizedGeneratedAt
  ) {

    return {
      weight: 0,
      futureDated: false
    };

  }

  const closedTime =
    new Date(
      normalizedClosedAt
    ).getTime();

  const generatedTime =
    new Date(
      normalizedGeneratedAt
    ).getTime();

  if (
    !Number.isFinite(
      closedTime
    ) ||
    !Number.isFinite(
      generatedTime
    )
  ) {

    return {
      weight: 0,
      futureDated: false
    };

  }

  if (
    closedTime >
    generatedTime +
    5 * 60 * 1000
  ) {

    return {
      weight: 0,
      futureDated: true
    };

  }

  const ageDays =
    Math.max(
      0,
      (
        generatedTime -
        closedTime
      ) /
      DAY_MS
    );

  const rawWeight =
    Math.exp(
      -
      LN_2 *
      ageDays /
      AUTONOMOUS_MEMORY_CONFIG
        .recencyHalfLifeDays
    );

  return {
    weight:
      round(
        Math.max(
          AUTONOMOUS_MEMORY_CONFIG
            .minimumRecencyWeight,
          Math.min(
            1,
            rawWeight
          )
        ),
        10
      ),
    futureDated: false
  };

}

function calculateWilsonInterval95(
  wins,
  decisiveTrades
) {

  if (
    decisiveTrades <= 0
  ) {

    return {
      lower: 0,
      upper: 100,
      width: 100
    };

  }

  const z =
    1.959963984540054;

  const probability =
    wins /
    decisiveTrades;

  const denominator =
    1 +
    (
      z *
      z
    ) /
    decisiveTrades;

  const centre =
    probability +
    (
      z *
      z
    ) /
    (
      2 *
      decisiveTrades
    );

  const margin =
    z *
    Math.sqrt(
      (
        probability *
        (
          1 -
          probability
        ) +
        (
          z *
          z
        ) /
        (
          4 *
          decisiveTrades
        )
      ) /
      decisiveTrades
    );

  const lower =
    Math.max(
      0,
      (
        centre -
        margin
      ) /
      denominator
    ) *
    100;

  const upper =
    Math.min(
      1,
      (
        centre +
        margin
      ) /
      denominator
    ) *
    100;

  return {
    lower:
      round(
        lower,
        4
      ),
    upper:
      round(
        upper,
        4
      ),
    width:
      round(
        upper -
        lower,
        4
      )
  };

}

function calculateStandardDeviation(
  values,
  average
) {

  if (
    !Array.isArray(
      values
    ) ||
    values.length < 2 ||
    !Number.isFinite(
      average
    )
  ) {

    return null;

  }

  const variance =
    values.reduce(
      (
        total,
        value
      ) =>
        total +
        (
          value -
          average
        ) **
        2,
      0
    ) /
    (
      values.length -
      1
    );

  return round(
    Math.sqrt(
      Math.max(
        0,
        variance
      )
    ),
    8
  );

}

function calculateEffectiveSampleSize(
  weights
) {

  if (
    !Array.isArray(
      weights
    ) ||
    weights.length === 0
  ) {

    return 0;

  }

  const weightSum =
    weights.reduce(
      (
        total,
        value
      ) =>
        total +
        value,
      0
    );

  const squaredWeightSum =
    weights.reduce(
      (
        total,
        value
      ) =>
        total +
        value *
        value,
      0
    );

  if (
    squaredWeightSum <= 0
  ) {

    return 0;

  }

  return round(
    (
      weightSum *
      weightSum
    ) /
    squaredWeightSum,
    4
  );

}

function calculateDrawdownStats(
  realizedRValues
) {

  if (
    !Array.isArray(
      realizedRValues
    ) ||
    realizedRValues.length === 0
  ) {

    return {
      maximumDrawdownR: null,
      currentDrawdownR: null
    };

  }

  let equity =
    0;

  let peak =
    0;

  let maximumDrawdown =
    0;

  for (
    const realizedR of
    realizedRValues
  ) {

    equity +=
      realizedR;

    if (
      equity >
      peak
    ) {

      peak =
        equity;

    }

    maximumDrawdown =
      Math.max(
        maximumDrawdown,
        peak -
        equity
      );

  }

  return {
    maximumDrawdownR:
      round(
        maximumDrawdown,
        8
      ),
    currentDrawdownR:
      round(
        peak -
        equity,
        8
      )
  };

}

function calculateMaximumConsecutiveLosses(
  trades
) {

  let current =
    0;

  let maximum =
    0;

  for (
    const trade of
    trades
  ) {

    if (
      trade.outcome ===
      "LOSS"
    ) {

      current +=
        1;

      maximum =
        Math.max(
          maximum,
          current
        );

    } else if (
      trade.outcome ===
      "WIN"
    ) {

      current =
        0;

    }

  }

  return maximum;

}

function calculateDrift(
  realizedRSamples
) {

  const windowSize =
    AUTONOMOUS_MEMORY_CONFIG
      .recentWindowSize;

  const minimumWindow =
    AUTONOMOUS_MEMORY_CONFIG
      .driftMinimumWindowSamples;

  if (
    !Array.isArray(
      realizedRSamples
    ) ||
    realizedRSamples.length <
      minimumWindow * 2
  ) {

    return {
      status: "INSUFFICIENT_DATA",
      recentSamples:
        Math.min(
          realizedRSamples?.length ||
          0,
          windowSize
        ),
      priorSamples: 0,
      recentExpectancyR: null,
      priorExpectancyR: null,
      expectancyChangeR: null
    };

  }

  const recent =
    realizedRSamples.slice(
      -windowSize
    );

  const prior =
    realizedRSamples.slice(
      -
      (
        windowSize * 2
      ),
      -windowSize
    );

  if (
    recent.length <
      minimumWindow ||
    prior.length <
      minimumWindow
  ) {

    return {
      status: "INSUFFICIENT_DATA",
      recentSamples:
        recent.length,
      priorSamples:
        prior.length,
      recentExpectancyR: null,
      priorExpectancyR: null,
      expectancyChangeR: null
    };

  }

  const average =
    values =>
      values.reduce(
        (
          total,
          value
        ) =>
          total +
          value,
        0
      ) /
      values.length;

  const recentExpectancy =
    average(
      recent
    );

  const priorExpectancy =
    average(
      prior
    );

  const change =
    recentExpectancy -
    priorExpectancy;

  let status =
    "STABLE";

  if (
    change >=
    AUTONOMOUS_MEMORY_CONFIG
      .driftThresholdR
  ) {

    status =
      "IMPROVING";

  } else if (
    change <=
    -
    AUTONOMOUS_MEMORY_CONFIG
      .driftThresholdR
  ) {

    status =
      "DETERIORATING";

  }

  return {
    status,
    recentSamples:
      recent.length,
    priorSamples:
      prior.length,
    recentExpectancyR:
      round(
        recentExpectancy,
        8
      ),
    priorExpectancyR:
      round(
        priorExpectancy,
        8
      ),
    expectancyChangeR:
      round(
        change,
        8
      )
  };

}

function createAutonomousAccumulator() {

  return {
    trades: [],
    totalTrades: 0,
    decisiveTrades: 0,
    wins: 0,
    losses: 0,
    breakevens: 0,
    invalidRSamples: 0,
    futureDatedSamples: 0,
    realizedRSamples: [],
    recencyWeights: [],
    weightedRValues: [],
    firstTradeAt: null,
    lastTradeAt: null
  };

}

function addTradeToAutonomousAccumulator(
  accumulator,
  trade,
  generatedAt
) {

  accumulator.totalTrades +=
    1;

  accumulator.trades.push(
    trade
  );

  if (
    trade.outcome ===
    "WIN"
  ) {

    accumulator.wins +=
      1;

    accumulator.decisiveTrades +=
      1;

  } else if (
    trade.outcome ===
    "LOSS"
  ) {

    accumulator.losses +=
      1;

    accumulator.decisiveTrades +=
      1;

  } else if (
    trade.outcome ===
    "BREAKEVEN"
  ) {

    accumulator.breakevens +=
      1;

  }

  if (
    !accumulator.firstTradeAt ||
    new Date(
      trade.openedAt
    ).getTime() <
    new Date(
      accumulator.firstTradeAt
    ).getTime()
  ) {

    accumulator.firstTradeAt =
      trade.openedAt;

  }

  if (
    !accumulator.lastTradeAt ||
    new Date(
      trade.closedAt
    ).getTime() >
    new Date(
      accumulator.lastTradeAt
    ).getTime()
  ) {

    accumulator.lastTradeAt =
      trade.closedAt;

  }

  const recency =
    calculateRecencyWeight(
      trade.closedAt,
      generatedAt
    );

  if (
    recency.futureDated
  ) {

    accumulator.futureDatedSamples +=
      1;

    return;

  }

  const realizedR =
    calculateTradeRealizedR(
      trade
    );

  if (
    realizedR === null
  ) {

    accumulator.invalidRSamples +=
      1;

    return;

  }

  accumulator.realizedRSamples.push(
    realizedR
  );

  accumulator.recencyWeights.push(
    recency.weight
  );

  accumulator.weightedRValues.push(
    realizedR *
    recency.weight
  );

}

function finalizeAutonomousAccumulator(
  accumulator,
  globalPriorWinRate
) {

  const metric =
    createEmptyAutonomousMetric();

  metric.totalTrades =
    accumulator.totalTrades;

  metric.decisiveTrades =
    accumulator.decisiveTrades;

  metric.wins =
    accumulator.wins;

  metric.losses =
    accumulator.losses;

  metric.breakevens =
    accumulator.breakevens;

  metric.realizedRSamples =
    accumulator.realizedRSamples.length;

  metric.invalidRSamples =
    accumulator.invalidRSamples;

  metric.futureDatedSamples =
    accumulator.futureDatedSamples;

  metric.firstTradeAt =
    accumulator.firstTradeAt;

  metric.lastTradeAt =
    accumulator.lastTradeAt;

  metric.winRate =
    calculateRate(
      accumulator.wins,
      accumulator.decisiveTrades
    );

  const priorProbability =
    Math.max(
      0,
      Math.min(
        1,
        toFiniteNumber(
          globalPriorWinRate
        ) ??
        0.5
      )
    );

  const priorStrength =
    AUTONOMOUS_MEMORY_CONFIG
      .bayesianPriorStrength;

  metric.bayesianWinRate =
    round(
      (
        accumulator.wins +
        priorProbability *
        priorStrength
      ) /
      (
        accumulator.decisiveTrades +
        priorStrength
      ) *
      100,
      4
    );

  metric.winRateInterval95 =
    calculateWilsonInterval95(
      accumulator.wins,
      accumulator.decisiveTrades
    );

  const rValues =
    accumulator.realizedRSamples;

  const rCount =
    rValues.length;

  const rSum =
    rValues.reduce(
      (
        total,
        value
      ) =>
        total +
        value,
      0
    );

  metric.expectancyR =
    rCount > 0
      ? round(
          rSum /
          rCount,
          8
        )
      : null;

  const weightSum =
    accumulator.recencyWeights
      .reduce(
        (
          total,
          value
        ) =>
          total +
          value,
        0
      );

  const weightedRSum =
    accumulator.weightedRValues
      .reduce(
        (
          total,
          value
        ) =>
          total +
          value,
        0
      );

  metric.recencyWeightedExpectancyR =
    weightSum > 0
      ? round(
          weightedRSum /
          weightSum,
          8
        )
      : null;

  const winsR =
    rValues.filter(
      value =>
        value >
        0
    );

  const lossesR =
    rValues.filter(
      value =>
        value <
        0
    );

  const grossProfitR =
    winsR.reduce(
      (
        total,
        value
      ) =>
        total +
        value,
      0
    );

  const grossLossR =
    Math.abs(
      lossesR.reduce(
        (
          total,
          value
        ) =>
          total +
          value,
        0
      )
    );

  metric.profitFactorR =
    grossLossR > 0
      ? round(
          grossProfitR /
          grossLossR,
          8
        )
      : (
          grossProfitR > 0
            ? null
            : 0
        );

  metric.averageWinR =
    winsR.length > 0
      ? round(
          grossProfitR /
          winsR.length,
          8
        )
      : null;

  metric.averageLossR =
    lossesR.length > 0
      ? round(
          lossesR.reduce(
            (
              total,
              value
            ) =>
              total +
              value,
            0
          ) /
          lossesR.length,
          8
        )
      : null;

  metric.standardDeviationR =
    calculateStandardDeviation(
      rValues,
      metric.expectancyR
    );

  const drawdown =
    calculateDrawdownStats(
      rValues
    );

  metric.maximumDrawdownR =
    drawdown.maximumDrawdownR;

  metric.currentDrawdownR =
    drawdown.currentDrawdownR;

  metric.maximumConsecutiveLosses =
    calculateMaximumConsecutiveLosses(
      accumulator.trades
    );

  metric.recency = {
    halfLifeDays:
      AUTONOMOUS_MEMORY_CONFIG
        .recencyHalfLifeDays,
    weightSum:
      round(
        weightSum,
        8
      ) ||
      0,
    effectiveSampleSize:
      calculateEffectiveSampleSize(
        accumulator.recencyWeights
      ),
    latestClosedAt:
      accumulator.lastTradeAt
  };

  metric.drift =
    calculateDrift(
      rValues
    );

  const rCoverage =
    metric.totalTrades > 0
      ? metric.realizedRSamples /
        metric.totalTrades
      : 0;

  const sampleScore =
    Math.min(
      1,
      metric.decisiveTrades /
      AUTONOMOUS_MEMORY_CONFIG
        .directionMinimumSamples
    );

  const recencyScore =
    metric.decisiveTrades > 0
      ? Math.min(
          1,
          metric.recency
            .effectiveSampleSize /
          metric.decisiveTrades
        )
      : 0;

  const intervalScore =
    Math.max(
      0,
      1 -
      metric.winRateInterval95
        .width /
      100
    );

  const stabilityScore =
    metric.standardDeviationR ===
      null
      ? 0
      : 1 /
        (
          1 +
          metric.standardDeviationR
        );

  const reliability =
    0.35 *
      sampleScore +
    0.20 *
      rCoverage +
    0.15 *
      recencyScore +
    0.15 *
      intervalScore +
    0.15 *
      stabilityScore;

  metric.quality = {
    rCoverage:
      round(
        rCoverage,
        4
      ),
    sampleScore:
      round(
        sampleScore,
        4
      ),
    recencyScore:
      round(
        recencyScore,
        4
      ),
    intervalScore:
      round(
        intervalScore,
        4
      ),
    stabilityScore:
      round(
        stabilityScore,
        4
      ),
    reliability:
      round(
        Math.max(
          0,
          Math.min(
            1,
            reliability
          )
        ),
        4
      )
  };

  const weightedExpectancy =
    metric.recencyWeightedExpectancyR;

  const deteriorating =
    metric.drift.status ===
    "DETERIORATING";

  let action =
    "OBSERVE";

  let reason =
    "Evidence is not mature enough for a directional recommendation.";

  if (
    metric.decisiveTrades >=
      AUTONOMOUS_MEMORY_CONFIG
        .filterMinimumSamples &&
    metric.quality.reliability >=
      AUTONOMOUS_MEMORY_CONFIG
        .filterMinimumReliability &&
    weightedExpectancy !== null
  ) {

    if (
      weightedExpectancy <=
        AUTONOMOUS_MEMORY_CONFIG
          .suppressiveExpectancyR ||
      metric.winRateInterval95
        .upper <
        50
    ) {

      action =
        "SUPPRESS";

      reason =
        "Mature evidence indicates negative or statistically weak recent edge.";

    } else if (
      weightedExpectancy >=
        AUTONOMOUS_MEMORY_CONFIG
          .supportiveExpectancyR &&
      !deteriorating
    ) {

      action =
        "SUPPORT";

      reason =
        "Mature evidence indicates positive recent risk-normalized edge.";

    }

  }

  metric.evidence = {
    action,
    reason,

    filterEvidenceReady:
      metric.decisiveTrades >=
        AUTONOMOUS_MEMORY_CONFIG
          .filterMinimumSamples &&
      metric.quality.reliability >=
        AUTONOMOUS_MEMORY_CONFIG
          .filterMinimumReliability,

    tradePlanEvidenceReady:
      metric.decisiveTrades >=
        AUTONOMOUS_MEMORY_CONFIG
          .tradePlanMinimumSamples &&
      metric.quality.reliability >=
        AUTONOMOUS_MEMORY_CONFIG
          .tradePlanMinimumReliability,

    directionEvidenceReady:
      metric.decisiveTrades >=
        AUTONOMOUS_MEMORY_CONFIG
          .directionMinimumSamples &&
      metric.quality.reliability >=
        AUTONOMOUS_MEMORY_CONFIG
          .directionMinimumReliability,

    /*
     * Memory evidence alone can never grant authority. The Policy Engine must
     * still pass chronological out-of-sample, embargo, source-hash and rollout
     * validation before the Decision Engine receives any live permission.
     */
    policyAuthorityEligible: false
  };

  return metric;

}

function createAutonomousScopeKey(
  trade,
  dimensions
) {

  const values =
    [];

  for (
    const dimension of
    dimensions
  ) {

    const value =
      toNonEmptyStringOrNull(
        trade?.[dimension]
      );

    if (
      !value
    ) {

      return null;

    }

    values.push(
      value
    );

  }

  return values.join(
    "::"
  );

}

function buildAutonomousMemory(
  canonicalTrades,
  generatedAt
) {

  const document =
    createEmptyAutonomousMemory(
      generatedAt
    );

  const orderedTrades =
    Array.isArray(
      canonicalTrades
    )
      ? canonicalTrades
          .slice()
          .sort(
            (
              left,
              right
            ) => {

              const leftTime =
                new Date(
                  left.closedAt
                ).getTime();

              const rightTime =
                new Date(
                  right.closedAt
                ).getTime();

              if (
                leftTime !==
                rightTime
              ) {

                return (
                  leftTime -
                  rightTime
                );

              }

              return String(
                left.tradeKey ||
                ""
              ).localeCompare(
                String(
                  right.tradeKey ||
                  ""
                )
              );

            }
          )
      : [];

  const globalAccumulator =
    createAutonomousAccumulator();

  const scopeAccumulators =
    {};

  for (
    const scopeName of
    Object.keys(
      AUTONOMOUS_SCOPE_DEFINITIONS
    )
  ) {

    scopeAccumulators[scopeName] =
      {};

  }

  for (
    const trade of
    orderedTrades
  ) {

    addTradeToAutonomousAccumulator(
      globalAccumulator,
      trade,
      generatedAt
    );

    for (
      const [
        scopeName,
        dimensions
      ] of
      Object.entries(
        AUTONOMOUS_SCOPE_DEFINITIONS
      )
    ) {

      const key =
        createAutonomousScopeKey(
          trade,
          dimensions
        );

      if (
        !key
      ) {

        continue;

      }

      if (
        !scopeAccumulators[
          scopeName
        ][key]
      ) {

        scopeAccumulators[
          scopeName
        ][key] =
          createAutonomousAccumulator();

      }

      addTradeToAutonomousAccumulator(
        scopeAccumulators[
          scopeName
        ][key],
        trade,
        generatedAt
      );

    }

  }

  const globalPriorWinRate =
    globalAccumulator
      .decisiveTrades > 0
      ? globalAccumulator.wins /
        globalAccumulator.decisiveTrades
      : 0.5;

  document.global =
    finalizeAutonomousAccumulator(
      globalAccumulator,
      globalPriorWinRate
    );

  let bucketCount =
    0;

  let supportiveBuckets =
    0;

  let suppressiveBuckets =
    0;

  let observeBuckets =
    0;

  let filterReady =
    0;

  let tradePlanReady =
    0;

  let directionReady =
    0;

  for (
    const scopeName of
    Object.keys(
      AUTONOMOUS_SCOPE_DEFINITIONS
    ).sort()
  ) {

    const finalizedScope =
      {};

    for (
      const key of
      Object.keys(
        scopeAccumulators[
          scopeName
        ]
      ).sort()
    ) {

      const metric =
        finalizeAutonomousAccumulator(
          scopeAccumulators[
            scopeName
          ][key],
          globalPriorWinRate
        );

      finalizedScope[key] =
        metric;

      bucketCount +=
        1;

      if (
        metric.evidence.action ===
        "SUPPORT"
      ) {

        supportiveBuckets +=
          1;

      } else if (
        metric.evidence.action ===
        "SUPPRESS"
      ) {

        suppressiveBuckets +=
          1;

      } else {

        observeBuckets +=
          1;

      }

      if (
        metric.evidence
          .filterEvidenceReady
      ) {

        filterReady +=
          1;

      }

      if (
        metric.evidence
          .tradePlanEvidenceReady
      ) {

        tradePlanReady +=
          1;

      }

      if (
        metric.evidence
          .directionEvidenceReady
      ) {

        directionReady +=
          1;

      }

    }

    document.scopes[
      scopeName
    ] =
      finalizedScope;

  }

  document.source = {
    acceptedCanonicalTrades:
      orderedTrades.length,

    normalizedTradeSetHash:
      createHash(
        orderedTrades.map(
          trade => ({
            tradeKey:
              trade.tradeKey,
            outcome:
              trade.outcome,
            closedAt:
              trade.closedAt,
            profitPoints:
              trade.profitPoints,
            stopLoss:
              trade.stopLoss,
            takeProfit:
              trade.takeProfit,
            session:
              trade.session,
            pattern:
              trade.pattern,
            marketRegime:
              trade.marketRegime
          })
        )
      ),

    realizedRTrades:
      globalAccumulator
        .realizedRSamples
        .length,

    invalidRTrades:
      globalAccumulator
        .invalidRSamples,

    futureDatedTrades:
      globalAccumulator
        .futureDatedSamples
  };

  document.summary = {
    scopeCount:
      Object.keys(
        AUTONOMOUS_SCOPE_DEFINITIONS
      ).length,

    bucketCount,
    supportiveBuckets,
    suppressiveBuckets,
    observeBuckets,

    filterEvidenceReadyBuckets:
      filterReady,

    tradePlanEvidenceReadyBuckets:
      tradePlanReady,

    directionEvidenceReadyBuckets:
      directionReady
  };

  const validation =
    validateAutonomousMemorySection(
      document
    );

  document.validation = {
    valid:
      validation.valid,
    errors:
      uniqueSortedStrings(
        validation.errors
      ),
    warnings:
      uniqueSortedStrings(
        validation.warnings
      )
  };

  return sortObjectKeysDeep(
    document
  );

}

function validateAutonomousMetric(
  metric,
  label
) {

  const errors =
    [];

  const warnings =
    [];

  if (
    !isPlainObject(
      metric
    )
  ) {

    return createValidationResult(
      false,
      [
        `${label} must be a JSON object.`
      ],
      []
    );

  }

  const countFields =
    [
      "totalTrades",
      "decisiveTrades",
      "wins",
      "losses",
      "breakevens",
      "realizedRSamples",
      "invalidRSamples",
      "futureDatedSamples",
      "maximumConsecutiveLosses"
    ];

  for (
    const field of
    countFields
  ) {

    const value =
      toFiniteNumber(
        metric[field]
      );

    if (
      value === null ||
      value < 0 ||
      !Number.isInteger(
        value
      )
    ) {

      errors.push(
        `${label}.${field} must be a non-negative integer.`
      );

    }

  }

  if (
    metric.decisiveTrades !==
    metric.wins +
    metric.losses
  ) {

    errors.push(
      `${label}.decisiveTrades must equal wins plus losses.`
    );

  }

  const reliability =
    toFiniteNumber(
      metric.quality
        ?.reliability
    );

  if (
    reliability === null ||
    reliability < 0 ||
    reliability > 1
  ) {

    errors.push(
      `${label}.quality.reliability must be between 0 and 1.`
    );

  }

  if (
    ![
      "OBSERVE",
      "SUPPORT",
      "SUPPRESS"
    ].includes(
      metric.evidence?.action
    )
  ) {

    errors.push(
      `${label}.evidence.action is invalid.`
    );

  }

  if (
    metric.evidence
      ?.policyAuthorityEligible !==
    false
  ) {

    errors.push(
      `${label} must not grant policy authority.`
    );

  }

  if (
    metric.futureDatedSamples >
    0
  ) {

    warnings.push(
      `${label} excluded ${metric.futureDatedSamples} future-dated sample(s).`
    );

  }

  return createValidationResult(
    errors.length === 0,
    errors,
    warnings
  );

}

function validateAutonomousMemorySection(
  section
) {

  const results =
    [];

  const errors =
    [];

  const warnings =
    [];

  if (
    !isPlainObject(
      section
    )
  ) {

    return createValidationResult(
      false,
      [
        "AI memory autonomousMemory section must be a JSON object."
      ],
      []
    );

  }

  if (
    section.version !==
    AUTONOMOUS_MEMORY_SCHEMA_VERSION
  ) {

    errors.push(
      "AI memory autonomousMemory schema version is invalid."
    );

  }

  if (
    section.engineName !==
    AUTONOMOUS_MEMORY_ENGINE_NAME
  ) {

    errors.push(
      "AI memory autonomousMemory engine name is invalid."
    );

  }

  if (
    section.engineVersion !==
    AUTONOMOUS_MEMORY_VERSION
  ) {

    errors.push(
      "AI memory autonomousMemory engine version is invalid."
    );

  }

  if (
    section.advisoryOnly !==
      true ||
    section.liveAuthorityPermitted !==
      false
  ) {

    errors.push(
      "AI memory autonomousMemory must remain advisory-only without live authority."
    );

  }

  results.push(
    validateAutonomousMetric(
      section.global,
      "autonomousMemory.global"
    )
  );

  if (
    !isPlainObject(
      section.scopes
    )
  ) {

    errors.push(
      "AI memory autonomousMemory.scopes must be a JSON object."
    );

  } else {

    for (
      const scopeName of
      Object.keys(
        AUTONOMOUS_SCOPE_DEFINITIONS
      )
    ) {

      const scope =
        section.scopes[
          scopeName
        ];

      if (
        !isPlainObject(
          scope
        )
      ) {

        errors.push(
          `AI memory autonomousMemory.scopes.${scopeName} must be a JSON object.`
        );

        continue;

      }

      for (
        const key of
        Object.keys(
          scope
        )
      ) {

        results.push(
          validateAutonomousMetric(
            scope[key],
            `autonomousMemory.scopes.${scopeName}.${key}`
          )
        );

      }

    }

  }

  const merged =
    mergeValidationResults(
      results
    );

  errors.push(
    ...merged.errors
  );

  warnings.push(
    ...merged.warnings
  );

  return createValidationResult(
    errors.length === 0,
    errors,
    warnings
  );

}

// -----------------------------------------------------------------------------
// Empty memory structures
// -----------------------------------------------------------------------------

function createEmptyPerformanceStats() {

  return {
    totalTrades: 0,
    wins: 0,
    losses: 0,
    breakevens: 0,

    winRate: 0,
    lossRate: 0,
    breakevenRate: 0,

    totalProfitPoints: 0,
    averageProfitPoints: 0,
    grossProfitPoints: 0,
    grossLossPoints: 0,
    profitFactor: null,

    totalResultPercentage: 0,
    averageResultPercentage: 0,

    totalDurationMinutes: 0,
    averageDurationMinutes: null,

    firstTradeAt: null,
    lastTradeAt: null,

    confidence: {
      samples: 0,
      total: 0,
      average: null,
      minimum: null,
      maximum: null
    }
  };

}

function createEmptyDimensionMemory() {

  return {};

}

function createEmptyCoverage() {

  return {
    totalAcceptedTrades: 0,

    pairs: {
      available: 0,
      missing: 0
    },

    engines: {
      available: 0,
      missing: 0
    },

    directions: {
      available: 0,
      missing: 0
    },

    timeframes: {
      available: 0,
      missing: 0
    },

    sessions: {
      available: 0,
      missing: 0
    },

    patterns: {
      available: 0,
      missing: 0
    },

    marketRegimes: {
      available: 0,
      missing: 0
    }
  };

}

function createEmptyMemoryDocument(
  generatedAt = new Date().toISOString()
) {

  return {
    version: MEMORY_SCHEMA_VERSION,

    engineName: ENGINE_NAME,
    engineVersion: ENGINE_VERSION,

    generatedAt,
    sourceUpdatedAt: null,

    summary: createEmptyPerformanceStats(),

    memory: {
      pairs: createEmptyDimensionMemory(),
      engines: createEmptyDimensionMemory(),
      directions: createEmptyDimensionMemory(),
      timeframes: createEmptyDimensionMemory(),
      sessions: createEmptyDimensionMemory(),
      patterns: createEmptyDimensionMemory(),
      marketRegimes: createEmptyDimensionMemory()
    },

    combinations: {
      pairEngine: {},
      pairDirection: {},
      engineDirection: {},
      pairEngineDirection: {},
      pairSession: {},
      pairPattern: {},
      pairMarketRegime: {}
    },

    enrichment:
      createUnavailableEnrichmentMemory(),

    autonomousMemory:
      createEmptyAutonomousMemory(
        generatedAt
      ),

    coverage: createEmptyCoverage(),

    source: {
      learningDataPath: path.relative(
        ROOT_DIR,
        LEARNING_DATA_PATH
      ),
      confidenceDataPath: path.relative(
        ROOT_DIR,
        CONFIDENCE_DATA_PATH
      ),
      learningEnrichmentPath: path.relative(
        ROOT_DIR,
        LEARNING_ENRICHMENT_PATH
      ),
      learningEnrichmentStatePath: path.relative(
        ROOT_DIR,
        LEARNING_ENRICHMENT_STATE_PATH
      ),
      learningDataModifiedAt: null,
      confidenceDataModifiedAt: null,
      learningEnrichmentModifiedAt: null,
      learningDataHash: null,
      confidenceDataHash: null,
      learningEnrichmentHash: null,
      acceptedTradeCount: 0,
      rejectedTradeCount: 0
    },

    validation: {
      valid: true,
      errors: [],
      warnings: []
    },

    metadata: {
      deterministic: true,
      duplicateSafe: true,
      incrementalState: true,
      optionalEnrichment: true,
      enrichmentAdvisoryOnly: true,
      autonomousMemoryAvailable: true,
      autonomousMemoryVersion:
        AUTONOMOUS_MEMORY_VERSION,
      autonomousMemoryAdvisoryOnly: true,
      liveAuthorityPermitted: false,
      optionalMetadataPolicy:
        "Only explicitly supplied source metadata is aggregated.",
      supportedPairs: Array.from(
        SUPPORTED_PAIRS
      ).sort(),
      supportedEngines: Array.from(
        SUPPORTED_ENGINES
      ).sort(),
      supportedDirections: Array.from(
        SUPPORTED_DIRECTIONS
      ).sort(),
      supportedOutcomes: Array.from(
        SUPPORTED_OUTCOMES
      ).sort(),
      supportedTimeframes: Array.from(
        SUPPORTED_TIMEFRAMES
      ).sort(),
      optionalDimensions: [
        ...OPTIONAL_DIMENSIONS
      ]
    }
  };

}

function createEmptyMemoryState(
  createdAt = new Date().toISOString()
) {

  return {
    version: STATE_SCHEMA_VERSION,

    engineName: ENGINE_NAME,
    engineVersion: ENGINE_VERSION,

    createdAt,
    updatedAt: createdAt,

    lastRunAt: null,
    lastSuccessfulRunAt: null,

    sourceHashes: {
      learningData: null,
      confidenceData: null,
      learningEnrichment: null
    },

    sourceModifiedAt: {
      learningData: null,
      confidenceData: null,
      learningEnrichment: null
    },

    processedTradeKeys: [],

    /*
     * Crash-recovery marker for the two-file AI Memory commit.
     * This field is null after every fully completed run.
     */
    pendingTransaction: null,

    counters: {
      runs: 0,
      successfulRuns: 0,
      unchangedRuns: 0,

      sourceSignals: 0,
      acceptedTrades: 0,
      rejectedTrades: 0,

      newTradeKeys: 0,
      duplicateTradeKeys: 0
    },

    lastRun: {
      status: null,
      sourceSignals: 0,
      acceptedTrades: 0,
      rejectedTrades: 0,
      newTradeKeys: 0,
      duplicateTradeKeys: 0,
      memoryWritten: false,
      stateWritten: false,
      error: null
    }
  };

}

// -----------------------------------------------------------------------------
// Existing document normalization
// -----------------------------------------------------------------------------
function normalizeExistingMemoryState(
  value
) {

  const now =
    new Date().toISOString();

  const fallback =
    createEmptyMemoryState(
      now
    );

  if (
    !isPlainObject(
      value
    )
  ) {

    return fallback;

  }

  const normalized =
    {
      ...fallback,
      ...value
    };

  normalized.version =
    STATE_SCHEMA_VERSION;

  normalized.engineName =
    ENGINE_NAME;

  normalized.engineVersion =
    ENGINE_VERSION;

  normalized.createdAt =
    toISOStringOrNull(
      value.createdAt
    ) ||
    fallback.createdAt;

  normalized.updatedAt =
    toISOStringOrNull(
      value.updatedAt
    ) ||
    normalized.createdAt;

  normalized.lastRunAt =
    toISOStringOrNull(
      value.lastRunAt
    );

  normalized.lastSuccessfulRunAt =
    toISOStringOrNull(
      value.lastSuccessfulRunAt
    );

  normalized.sourceHashes =
    {
      learningData:
        toNonEmptyStringOrNull(
          getNestedValue(
            value,
            [
              "sourceHashes",
              "learningData"
            ]
          )
        ),

      confidenceData:
        toNonEmptyStringOrNull(
          getNestedValue(
            value,
            [
              "sourceHashes",
              "confidenceData"
            ]
          )
        ),

      learningEnrichment:
        toNonEmptyStringOrNull(
          getNestedValue(
            value,
            [
              "sourceHashes",
              "learningEnrichment"
            ]
          )
        )
    };

  normalized.sourceModifiedAt =
    {
      learningData:
        toISOStringOrNull(
          getNestedValue(
            value,
            [
              "sourceModifiedAt",
              "learningData"
            ]
          )
        ),

      confidenceData:
        toISOStringOrNull(
          getNestedValue(
            value,
            [
              "sourceModifiedAt",
              "confidenceData"
            ]
          )
        ),

      learningEnrichment:
        toISOStringOrNull(
          getNestedValue(
            value,
            [
              "sourceModifiedAt",
              "learningEnrichment"
            ]
          )
        )
    };

  normalized.processedTradeKeys =
    uniqueSortedStrings(
      Array.isArray(
        value.processedTradeKeys
      )
        ? value.processedTradeKeys
        : []
    ).slice(
      -MAX_PROCESSED_KEYS
    );

  normalized.pendingTransaction =
    normalizePendingMemoryTransaction(
      value.pendingTransaction
    );

  normalized.counters =
    normalizeStateCounters(
      value.counters
    );

  normalized.lastRun =
    normalizeLastRunState(
      value.lastRun
    );

  return normalized;

}

function normalizePendingMemoryTransaction(
  value
) {

  if (
    !isPlainObject(
      value
    )
  ) {

    return null;

  }

  const memoryHash =
    toNonEmptyStringOrNull(
      value.memoryHash
    );

  const runAt =
    toISOStringOrNull(
      value.runAt
    );

  const status =
    toNonEmptyStringOrNull(
      value.status
    );

  if (
    !memoryHash ||
    !runAt ||
    (
      status !== "UPDATED" &&
      status !== "UNCHANGED"
    )
  ) {

    return null;

  }

  return {
    version:
      1,

    createdAt:
      toISOStringOrNull(
        value.createdAt
      ) ||
      runAt,

    runAt,

    status,

    memoryHash,

    sourceHashes: {
      learningData:
        toNonEmptyStringOrNull(
          getNestedValue(
            value,
            [
              "sourceHashes",
              "learningData"
            ]
          )
        ),

      confidenceData:
        toNonEmptyStringOrNull(
          getNestedValue(
            value,
            [
              "sourceHashes",
              "confidenceData"
            ]
          )
        ),

      learningEnrichment:
        toNonEmptyStringOrNull(
          getNestedValue(
            value,
            [
              "sourceHashes",
              "learningEnrichment"
            ]
          )
        )
    },

    sourceModifiedAt: {
      learningData:
        toISOStringOrNull(
          getNestedValue(
            value,
            [
              "sourceModifiedAt",
              "learningData"
            ]
          )
        ),

      confidenceData:
        toISOStringOrNull(
          getNestedValue(
            value,
            [
              "sourceModifiedAt",
              "confidenceData"
            ]
          )
        ),

      learningEnrichment:
        toISOStringOrNull(
          getNestedValue(
            value,
            [
              "sourceModifiedAt",
              "learningEnrichment"
            ]
          )
        )
    },

    counts: {
      sourceSignals:
        normalizeNonNegativeInteger(
          getNestedValue(
            value,
            [
              "counts",
              "sourceSignals"
            ]
          )
        ),

      acceptedTrades:
        normalizeNonNegativeInteger(
          getNestedValue(
            value,
            [
              "counts",
              "acceptedTrades"
            ]
          )
        ),

      rejectedTrades:
        normalizeNonNegativeInteger(
          getNestedValue(
            value,
            [
              "counts",
              "rejectedTrades"
            ]
          )
        ),

      normalizedDuplicateTradeKeys:
        normalizeNonNegativeInteger(
          getNestedValue(
            value,
            [
              "counts",
              "normalizedDuplicateTradeKeys"
            ]
          )
        ),

      newTradeKeys:
        normalizeNonNegativeInteger(
          getNestedValue(
            value,
            [
              "counts",
              "newTradeKeys"
            ]
          )
        ),

      reconciledDuplicateTradeKeys:
        normalizeNonNegativeInteger(
          getNestedValue(
            value,
            [
              "counts",
              "reconciledDuplicateTradeKeys"
            ]
          )
        )
    }
  };

}

function createPendingMemoryTransaction({
  runAt,
  status,
  memoryDocument,
  learningHash,
  confidenceHash,
  enrichmentHash,
  learningModifiedAt,
  confidenceModifiedAt,
  enrichmentModifiedAt,
  normalizedTrades,
  canonicalTrades,
  keyReconciliation
}) {

  return normalizePendingMemoryTransaction({
    version:
      1,

    createdAt:
      new Date().toISOString(),

    runAt,
    status,

    memoryHash:
      createHash(
        memoryDocument
      ),

    sourceHashes: {
      learningData:
        learningHash,

      confidenceData:
        confidenceHash,

      learningEnrichment:
        enrichmentHash ||
        null
    },

    sourceModifiedAt: {
      learningData:
        learningModifiedAt,

      confidenceData:
        confidenceModifiedAt,

      learningEnrichment:
        enrichmentModifiedAt ||
        null
    },

    counts: {
      sourceSignals:
        normalizedTrades.sourceSignals,

      acceptedTrades:
        canonicalTrades.length,

      rejectedTrades:
        normalizedTrades.rejectedTrades.length,

      normalizedDuplicateTradeKeys:
        normalizedTrades.duplicateTradeKeys,

      newTradeKeys:
        keyReconciliation.newTradeKeys,

      reconciledDuplicateTradeKeys:
        keyReconciliation.duplicateTradeKeys
    }
  });

}

function recoverPendingMemoryTransaction(
  previousStateDocument
) {

  const state =
    normalizeExistingMemoryState(
      previousStateDocument
    );

  const pending =
    state.pendingTransaction;

  if (!pending) {

    return {
      state,
      recovered:
        false,

      matched:
        false
    };

  }

  const existingMemory =
    readExistingMemoryDocument();

  const memoryHash =
    existingMemory.valid
      ? createHash(
          existingMemory.document
        )
      : null;

  if (
    memoryHash !==
      pending.memoryHash
  ) {

    /*
     * The intended memory document did not reach disk. Clear only the
     * recovery marker; the normal run will rebuild from the source files.
     */
    state.pendingTransaction =
      null;

    atomicWriteJSON(
      AI_MEMORY_STATE_PATH,
      state
    );

    return {
      state,
      recovered:
        true,

      matched:
        false
    };

  }

  const canonicalTradeKeys =
    uniqueSortedStrings(
      getNestedValue(
        existingMemory.document,
        [
          "metadata",
          "canonicalTradeKeys"
        ]
      )
    );

  const recoveredKeyReconciliation = {
    processedTradeKeys:
      uniqueSortedStrings([
        ...state.processedTradeKeys,
        ...canonicalTradeKeys
      ]).slice(
        -MAX_PROCESSED_KEYS
      ),

    newTradeKeys:
      pending.counts.newTradeKeys,

    duplicateTradeKeys:
      pending.counts
        .reconciledDuplicateTradeKeys
  };

  state.pendingTransaction =
    null;

  const recoveredState =
    completeMemoryRun({
      state,

      runAt:
        pending.runAt,

      status:
        pending.status,

      learningHash:
        pending.sourceHashes
          .learningData,

      confidenceHash:
        pending.sourceHashes
          .confidenceData,

      enrichmentHash:
        pending.sourceHashes
          .learningEnrichment,

      learningModifiedAt:
        pending.sourceModifiedAt
          .learningData,

      confidenceModifiedAt:
        pending.sourceModifiedAt
          .confidenceData,

      enrichmentModifiedAt:
        pending.sourceModifiedAt
          .learningEnrichment,

      normalizedTrades: {
        sourceSignals:
          pending.counts
            .sourceSignals,

        duplicateTradeKeys:
          pending.counts
            .normalizedDuplicateTradeKeys,

        rejectedTrades:
          new Array(
            pending.counts
              .rejectedTrades
          )
      },

      canonicalTrades:
        new Array(
          pending.counts
            .acceptedTrades
        ),

      keyReconciliation:
        recoveredKeyReconciliation,

      memoryWritten:
        true
    });

  recoveredState.pendingTransaction =
    null;

  atomicWriteJSON(
    AI_MEMORY_STATE_PATH,
    recoveredState
  );

  return {
    state:
      recoveredState,

    recovered:
      true,

    matched:
      true
  };

}

function normalizeStateCounters(
  value
) {

  const source =
    isPlainObject(
      value
    )
      ? value
      : {};

  return {
    runs:
      normalizeNonNegativeInteger(
        source.runs
      ),

    successfulRuns:
      normalizeNonNegativeInteger(
        source.successfulRuns
      ),

    unchangedRuns:
      normalizeNonNegativeInteger(
        source.unchangedRuns
      ),

    sourceSignals:
      normalizeNonNegativeInteger(
        source.sourceSignals
      ),

    acceptedTrades:
      normalizeNonNegativeInteger(
        source.acceptedTrades
      ),

    rejectedTrades:
      normalizeNonNegativeInteger(
        source.rejectedTrades
      ),

    newTradeKeys:
      normalizeNonNegativeInteger(
        source.newTradeKeys
      ),

    duplicateTradeKeys:
      normalizeNonNegativeInteger(
        source.duplicateTradeKeys
      )
  };

}

function normalizeLastRunState(
  value
) {

  const source =
    isPlainObject(
      value
    )
      ? value
      : {};

  return {
    status:
      toNonEmptyStringOrNull(
        source.status
      ),

    sourceSignals:
      normalizeNonNegativeInteger(
        source.sourceSignals
      ),

    acceptedTrades:
      normalizeNonNegativeInteger(
        source.acceptedTrades
      ),

    rejectedTrades:
      normalizeNonNegativeInteger(
        source.rejectedTrades
      ),

    newTradeKeys:
      normalizeNonNegativeInteger(
        source.newTradeKeys
      ),

    duplicateTradeKeys:
      normalizeNonNegativeInteger(
        source.duplicateTradeKeys
      ),

    memoryWritten:
      Boolean(
        source.memoryWritten
      ),

    stateWritten:
      Boolean(
        source.stateWritten
      ),

    error:
      toNonEmptyStringOrNull(
        source.error
      )
  };

}

function normalizeNonNegativeInteger(
  value
) {

  const number =
    toFiniteNumber(
      value
    );

  if (
    number === null ||
    number < 0
  ) {

    return 0;

  }

  return Math.floor(
    number
  );

}

// -----------------------------------------------------------------------------
// Learning-data schema extraction
// -----------------------------------------------------------------------------

function extractLearningRoot(
  document
) {

  if (
    !isPlainObject(
      document
    )
  ) {

    return null;

  }

  if (
    isPlainObject(
      document.learning
    )
  ) {

    return document.learning;

  }

  if (
    Array.isArray(
      document.signals
    ) ||
    Array.isArray(
      document.outcomes
    )
  ) {

    return document;

  }

  return null;

}

function extractLearningSignals(
  document
) {

  const learningRoot =
    extractLearningRoot(
      document
    );

  if (
    !learningRoot
  ) {

    return [];

  }

  if (
    Array.isArray(
      learningRoot.signals
    )
  ) {

    return learningRoot.signals;

  }

  return [];

}

function extractLearningOutcomes(
  document
) {

  const learningRoot =
    extractLearningRoot(
      document
    );

  if (
    !learningRoot
  ) {

    return [];

  }

  if (
    Array.isArray(
      learningRoot.outcomes
    )
  ) {

    return learningRoot.outcomes;

  }

  return [];

}

function extractLearningUpdatedAt(
  document
) {

  const candidate =
    getFirstDefinedValue(
      document,
      [
        ["updatedAt"],
        ["learning", "updatedAt"],
        ["metadata", "updatedAt"],
        ["learning", "metadata", "updatedAt"]
      ]
    );

  return toISOStringOrNull(
    candidate
  );

}

// -----------------------------------------------------------------------------
// Confidence-data schema extraction
// -----------------------------------------------------------------------------

function extractConfidenceRoot(
  document
) {

  if (
    !isPlainObject(
      document
    )
  ) {

    return null;

  }

  if (
    isPlainObject(
      document.confidence
    )
  ) {

    return document.confidence;

  }

  if (
    isPlainObject(
      document.strategies
    ) ||
    isPlainObject(
      document.pairs
    ) ||
    isPlainObject(
      document.timeframes
    )
  ) {

    return document;

  }

  return null;

}

function extractConfidenceUpdatedAt(
  document
) {

  const candidate =
    getFirstDefinedValue(
      document,
      [
        ["updatedAt"],
        ["confidence", "updatedAt"],
        ["metadata", "updatedAt"],
        ["confidence", "metadata", "updatedAt"]
      ]
    );

  return toISOStringOrNull(
    candidate
  );

}

// -----------------------------------------------------------------------------
// Source document validation
// -----------------------------------------------------------------------------

function validateLearningDocument(
  document
) {

  const errors =
    [];

  const warnings =
    [];

  if (
    !isPlainObject(
      document
    )
  ) {

    errors.push(
      "learning-data.json root must be a JSON object."
    );

    return createValidationResult(
      false,
      errors,
      warnings
    );

  }

  const learningRoot =
    extractLearningRoot(
      document
    );

  if (
    !learningRoot
  ) {

    errors.push(
      "learning-data.json does not contain a supported learning root."
    );

    return createValidationResult(
      false,
      errors,
      warnings
    );

  }

  if (
    !Array.isArray(
      learningRoot.signals
    )
  ) {

    errors.push(
      "learning-data.json learning.signals must be an array."
    );

  }

  if (
    learningRoot.outcomes !== undefined &&
    !Array.isArray(
      learningRoot.outcomes
    )
  ) {

    warnings.push(
      "learning-data.json learning.outcomes is present but is not an array."
    );

  }

  if (
    Array.isArray(
      learningRoot.signals
    ) &&
    learningRoot.signals.length === 0
  ) {

    warnings.push(
      "learning-data.json currently contains no learned signals."
    );

  }

  return createValidationResult(
    errors.length === 0,
    errors,
    warnings
  );

}

function validateConfidenceDocument(
  document
) {

  const errors =
    [];

  const warnings =
    [];

  if (
    document === null ||
    document === undefined
  ) {

    warnings.push(
      "confidence-data.json is missing; memory will continue without confidence overlays."
    );

    return createValidationResult(
      true,
      errors,
      warnings
    );

  }

  if (
    !isPlainObject(
      document
    )
  ) {

    warnings.push(
      "confidence-data.json root is invalid; confidence overlays will be skipped."
    );

    return createValidationResult(
      true,
      errors,
      warnings
    );

  }

  const confidenceRoot =
    extractConfidenceRoot(
      document
    );

  if (
    !confidenceRoot
  ) {

    warnings.push(
      "confidence-data.json does not contain a supported confidence root."
    );

    return createValidationResult(
      true,
      errors,
      warnings
    );

  }

  const knownSections =
    [
      "strategies",
      "indicators",
      "pairs",
      "timeframes",
      "overall"
    ];

  const availableSections =
    knownSections.filter(
      sectionName =>
        Object.prototype.hasOwnProperty.call(
          confidenceRoot,
          sectionName
        )
    );

  if (
    availableSections.length === 0
  ) {

    warnings.push(
      "confidence-data.json contains no recognized confidence sections."
    );

  }

  return createValidationResult(
    true,
    errors,
    warnings
  );

}

// -----------------------------------------------------------------------------
// Learned trade field extraction
// -----------------------------------------------------------------------------
function extractTradeId(
  record
) {

  return toNonEmptyStringOrNull(
    getFirstDefinedValue(
      record,
      [
        ["id"],
        ["signalId"],
        ["tradeId"],
        ["evaluationId"],
        ["metadata", "id"],
        ["metadata", "signalId"],
        ["metadata", "tradeId"]
      ]
    )
  );

}

function extractTradeSetupIdentity(
  record
) {

  return toNonEmptyStringOrNull(
    getFirstDefinedValue(
      record,
      [
        ["setupIdentity"],
        ["setupId"],
        ["metadata", "setupIdentity"],
        ["metadata", "setupId"]
      ]
    )
  );

}

function extractTradePair(
  record
) {

  const value =
    getFirstDefinedValue(
      record,
      [
        ["pair"],
        ["symbol"],
        ["instrument"],
        ["metadata", "pair"],
        ["metadata", "symbol"]
      ]
    );

  return normalizePair(
    value
  );

}

function extractTradeEngine(
  record
) {

  const value =
    getFirstDefinedValue(
      record,
      [
        ["strategy"],
        ["engine"],
        ["mode"],
        ["sourceEngine"],
        ["metadata", "strategy"],
        ["metadata", "engine"],
        ["metadata", "mode"]
      ]
    );

  return normalizeEngine(
    value
  );

}

function extractTradeDirection(
  record
) {

  const value =
    getFirstDefinedValue(
      record,
      [
        ["direction"],
        ["side"],
        ["signal"],
        ["action"],
        ["metadata", "direction"],
        ["metadata", "side"]
      ]
    );

  return normalizeDirection(
    value
  );

}

function extractTradeTimeframe(
  record
) {

  const value =
    getFirstDefinedValue(
      record,
      [
        ["timeframe"],
        ["interval"],
        ["period"],
        ["metadata", "timeframe"],
        ["metadata", "interval"]
      ]
    );

  return normalizeTimeframe(
    value
  );

}

function extractTradeOutcome(
  record
) {

  const value =
    getFirstDefinedValue(
      record,
      [
        ["outcome"],
        ["result"],
        ["status"],
        ["resolution"],
        ["metadata", "outcome"],
        ["metadata", "result"]
      ]
    );

  return normalizeOutcome(
    value
  );

}

function extractTradeEntry(
  record
) {

  return toFiniteNumber(
    getFirstDefinedValue(
      record,
      [
        ["entry"],
        ["entryPrice"],
        ["price"],
        ["metadata", "entry"],
        ["metadata", "entryPrice"]
      ]
    )
  );

}

function extractTradeStopLoss(
  record
) {

  return toFiniteNumber(
    getFirstDefinedValue(
      record,
      [
        ["stopLoss"],
        ["stop"],
        ["initialStopLoss"],
        ["metadata", "stopLoss"],
        ["metadata", "stop"]
      ]
    )
  );

}

function extractTradeTakeProfit(
  record
) {

  return toFiniteNumber(
    getFirstDefinedValue(
      record,
      [
        ["takeProfit"],
        ["target"],
        ["takeProfit1"],
        ["metadata", "takeProfit"],
        ["metadata", "target"]
      ]
    )
  );

}

function extractTradeClosePrice(
  record
) {

  return toFiniteNumber(
    getFirstDefinedValue(
      record,
      [
        ["closePrice"],
        ["exitPrice"],
        ["resolvedPrice"],
        ["metadata", "closePrice"],
        ["metadata", "exitPrice"]
      ]
    )
  );

}

function extractTradeProfitPoints(
  record
) {

  return toFiniteNumber(
    getFirstDefinedValue(
      record,
      [
        ["profitPoints"],
        ["points"],
        ["pips"],
        ["profit"],
        ["metadata", "profitPoints"],
        ["metrics", "profitPoints"]
      ]
    )
  );

}

function extractTradeResultPercentage(
  record
) {

  return toFiniteNumber(
    getFirstDefinedValue(
      record,
      [
        ["resultPercentage"],
        ["returnPercentage"],
        ["profitPercentage"],
        ["percentage"],
        ["metadata", "resultPercentage"],
        ["metrics", "resultPercentage"]
      ]
    )
  );

}

function extractTradeConfidence(
  record
) {

  const value =
    toFiniteNumber(
      getFirstDefinedValue(
        record,
        [
          ["confidence"],
          ["adaptiveConfidence"],
          ["legacyConfidence"],
          ["metadata", "confidence"],
          ["metadata", "adaptiveConfidence"]
        ]
      )
    );

  if (
    value === null
  ) {

    return null;

  }

  return clamp(
    value,
    0,
    100
  );

}

function extractTradeOpenedAt(
  record
) {

  const value =
    getFirstDefinedValue(
      record,
      [
        ["openedAt"],
        ["timestamp"],
        ["createdAt"],
        ["signalTime"],
        ["metadata", "openedAt"],
        ["metadata", "timestamp"]
      ]
    );

  return toISOStringOrNull(
    value
  );

}

function extractTradeClosedAt(
  record
) {

  const value =
    getFirstDefinedValue(
      record,
      [
        ["closedAt"],
        ["resolvedAt"],
        ["completedAt"],
        ["exitTime"],
        ["metadata", "closedAt"],
        ["metadata", "resolvedAt"]
      ]
    );

  return toISOStringOrNull(
    value
  );

}

// -----------------------------------------------------------------------------
// Trade calculations
// -----------------------------------------------------------------------------

function calculateDurationMinutes(
  openedAt,
  closedAt
) {

  const normalizedOpenedAt =
    toISOStringOrNull(
      openedAt
    );

  const normalizedClosedAt =
    toISOStringOrNull(
      closedAt
    );

  if (
    !normalizedOpenedAt ||
    !normalizedClosedAt
  ) {

    return null;

  }

  const openedTime =
    new Date(
      normalizedOpenedAt
    ).getTime();

  const closedTime =
    new Date(
      normalizedClosedAt
    ).getTime();

  if (
    !Number.isFinite(
      openedTime
    ) ||
    !Number.isFinite(
      closedTime
    ) ||
    closedTime < openedTime
  ) {

    return null;

  }

  return round(
    (
      closedTime -
      openedTime
    ) /
    60000,
    4
  );

}

function calculateProfitPoints(
  {
    direction,
    outcome,
    entry,
    stopLoss,
    takeProfit,
    closePrice
  }
) {

  if (
    direction !== "BUY" &&
    direction !== "SELL"
  ) {

    return null;

  }

  if (
    entry === null
  ) {

    return null;

  }

  let resolvedPrice =
    closePrice;

  if (
    resolvedPrice === null
  ) {

    if (
      outcome === "WIN"
    ) {

      resolvedPrice =
        takeProfit;

    } else if (
      outcome === "LOSS"
    ) {

      resolvedPrice =
        stopLoss;

    } else if (
      outcome === "BREAKEVEN"
    ) {

      resolvedPrice =
        entry;

    }

  }

  if (
    resolvedPrice === null
  ) {

    return null;

  }

  const difference =
    direction === "BUY"
      ? resolvedPrice - entry
      : entry - resolvedPrice;

  return round(
    difference,
    8
  );

}

function calculateResultPercentage(
  entry,
  profitPoints
) {

  if (
    entry === null ||
    profitPoints === null ||
    entry === 0
  ) {

    return null;

  }

  return round(
    (
      profitPoints /
      entry
    ) *
    100,
    8
  );

}

// -----------------------------------------------------------------------------
// Learned trade normalization
// -----------------------------------------------------------------------------

function normalizeLearnedTrade(
  record,
  sourceIndex
) {

  if (
    !isPlainObject(
      record
    )
  ) {

    return {
      valid: false,
      trade: null,
      errors: [
        `Signal at index ${sourceIndex} is not a JSON object.`
      ],
      warnings: []
    };

  }

  const errors =
    [];

  const warnings =
    [];

  const pair =
    extractTradePair(
      record
    );

  const engine =
    extractTradeEngine(
      record
    );

  const direction =
    extractTradeDirection(
      record
    );

  const timeframe =
    extractTradeTimeframe(
      record
    );

  const outcome =
    extractTradeOutcome(
      record
    );

  const entry =
    extractTradeEntry(
      record
    );

  const stopLoss =
    extractTradeStopLoss(
      record
    );

  const takeProfit =
    extractTradeTakeProfit(
      record
    );

  const closePrice =
    extractTradeClosePrice(
      record
    );

  const openedAt =
    extractTradeOpenedAt(
      record
    );

  const closedAt =
    extractTradeClosedAt(
      record
    );

  const confidence =
    extractTradeConfidence(
      record
    );

  const session =
    extractSession(
      record
    );

  const pattern =
    extractPattern(
      record
    );

  const marketRegime =
    extractMarketRegime(
      record
    );

  if (
    !pair
  ) {

    errors.push(
      `Signal at index ${sourceIndex} is missing a valid pair.`
    );

  }

  if (
    !engine
  ) {

    errors.push(
      `Signal at index ${sourceIndex} is missing a valid strategy or engine.`
    );

  }

  if (
    !direction
  ) {

    errors.push(
      `Signal at index ${sourceIndex} is missing a supported direction.`
    );

  }

  if (
    !outcome
  ) {

    errors.push(
      `Signal at index ${sourceIndex} is missing a verified outcome.`
    );

  }

  if (
    entry === null ||
    entry <= 0
  ) {

    errors.push(
      `Signal at index ${sourceIndex} has an invalid entry price.`
    );

  }

  if (
    !openedAt
  ) {

    errors.push(
      `Signal at index ${sourceIndex} is missing a valid opened timestamp.`
    );

  }

  if (
    !closedAt
  ) {

    errors.push(
      `Signal at index ${sourceIndex} is missing a valid closed timestamp.`
    );

  }

  if (
    pair &&
    !SUPPORTED_PAIRS.has(
      pair
    )
  ) {

    warnings.push(
      `Signal at index ${sourceIndex} uses unsupported pair ${pair}; it will be preserved as source metadata but excluded from canonical memory.`
    );

  }

  if (
    engine &&
    !SUPPORTED_ENGINES.has(
      engine
    )
  ) {

    warnings.push(
      `Signal at index ${sourceIndex} uses unsupported engine ${engine}; it will be preserved as source metadata but excluded from canonical memory.`
    );

  }

  if (
    timeframe &&
    !SUPPORTED_TIMEFRAMES.has(
      timeframe
    )
  ) {

    warnings.push(
      `Signal at index ${sourceIndex} uses unrecognized timeframe ${timeframe}.`
    );

  }

  if (
    openedAt &&
    closedAt &&
    new Date(
      closedAt
    ).getTime() <
    new Date(
      openedAt
    ).getTime()
  ) {

    errors.push(
      `Signal at index ${sourceIndex} closes before it opens.`
    );

  }

  if (
    errors.length > 0
  ) {

    return {
      valid: false,
      trade: null,
      errors,
      warnings
    };

  }

  let profitPoints =
    extractTradeProfitPoints(
      record
    );

  if (
    profitPoints === null
  ) {

    profitPoints =
      calculateProfitPoints({
        direction,
        outcome,
        entry,
        stopLoss,
        takeProfit,
        closePrice
      });

  }

  let resultPercentage =
    extractTradeResultPercentage(
      record
    );

  if (
    resultPercentage === null
  ) {

    resultPercentage =
      calculateResultPercentage(
        entry,
        profitPoints
      );

  }

  if (
    outcome === "WIN" &&
    profitPoints !== null &&
    profitPoints < 0
  ) {

    errors.push(
      `Signal at index ${sourceIndex} has WIN outcome with negative profit points.`
    );

  }

  if (
    outcome === "LOSS" &&
    profitPoints !== null &&
    profitPoints > 0
  ) {

    errors.push(
      `Signal at index ${sourceIndex} has LOSS outcome with positive profit points.`
    );

  }

  if (
    outcome === "WIN" &&
    resultPercentage !== null &&
    resultPercentage < 0
  ) {

    errors.push(
      `Signal at index ${sourceIndex} has WIN outcome with negative result percentage.`
    );

  }

  if (
    outcome === "LOSS" &&
    resultPercentage !== null &&
    resultPercentage > 0
  ) {

    errors.push(
      `Signal at index ${sourceIndex} has LOSS outcome with positive result percentage.`
    );

  }

  if (
    errors.length > 0
  ) {

    return {
      valid: false,
      trade: null,
      errors,
      warnings
    };

  }

  const durationMinutes =
    calculateDurationMinutes(
      openedAt,
      closedAt
    );

  const setupIdentity =
    extractTradeSetupIdentity(
      record
    );

  const trade =
    {
      sourceIndex,

      id:
        extractTradeId(
          record
        ),

      pair,
      engine,
      direction,
      timeframe,
      outcome,

      entry:
        round(
          entry,
          8
        ),

      stopLoss:
        round(
          stopLoss,
          8
        ),

      takeProfit:
        round(
          takeProfit,
          8
        ),

      closePrice:
        round(
          closePrice,
          8
        ),

      profitPoints:
        round(
          profitPoints,
          8
        ),

      resultPercentage:
        round(
          resultPercentage,
          8
        ),

      confidence:
        round(
          confidence,
          4
        ),

      openedAt,
      closedAt,
      durationMinutes,

      session,
      pattern,
      marketRegime
    };

  if (
    setupIdentity
  ) {

    trade.setupIdentity =
      setupIdentity;

  }

  return {
    valid: true,
    trade,
    errors,
    warnings
  };

}

// -----------------------------------------------------------------------------
// Trade-key generation
// -----------------------------------------------------------------------------

function createTradeIdentityPayload(
  trade
) {

  const stableId =
    toNonEmptyStringOrNull(
      trade?.id
    );

  /*
   * A persisted learner signal id is the canonical identity when available.
   * Outcome, exit, SL/TP and closed timestamps are mutable resolution data and
   * must not create a second identity when a historical result is corrected.
   */
  if (
    stableId
  ) {

    return {
      id:
        stableId
    };

  }

  /*
   * Legacy records may not have an id. Fall back only to immutable opening
   * fields that are required by normalizeLearnedTrade().
   */
  return {
    pair:
      trade?.pair || null,

    engine:
      trade?.engine || null,

    direction:
      trade?.direction || null,

    timeframe:
      trade?.timeframe || null,

    entry:
      trade?.entry ?? null,

    openedAt:
      trade?.openedAt || null
  };

}

function createTradeKey(
  trade
) {

  return createHash(
    createTradeIdentityPayload(
      trade
    )
  );

}

function createSetupIdentityKey(
  trade
) {

  const pair =
    normalizePair(
      trade?.pair
    );

  const engine =
    normalizeEngine(
      trade?.engine
    );

  const direction =
    normalizeDirection(
      trade?.direction
    );

  const timeframe =
    normalizeTimeframe(
      trade?.timeframe
    );

  const openedAt =
    toISOStringOrNull(
      trade?.openedAt
    );

  if (
    pair &&
    engine &&
    direction &&
    timeframe &&
    openedAt
  ) {

    return createHash({
      pair,
      engine,
      direction,
      timeframe,
      openedAt
    });

  }

  const explicitSetupIdentity =
    toNonEmptyStringOrNull(
      trade?.setupIdentity
    );

  return explicitSetupIdentity
    ? createHash({
        setupIdentity:
          explicitSetupIdentity
      })
    : null;

}

// -----------------------------------------------------------------------------
// Trade collection normalization
// -----------------------------------------------------------------------------
function normalizeLearningTrades(
  learningDocument
) {

  const sourceSignals =
    extractLearningSignals(
      learningDocument
    );

  const acceptedTrades =
    [];

  const rejectedTrades =
    [];

  const warnings =
    [];

  const seenTradeKeys =
    new Set();

  const seenSetupKeys =
    new Set();

  let duplicateTradeKeys =
    0;

  for (
    let index = 0;
    index < sourceSignals.length;
    index += 1
  ) {

    const result =
      normalizeLearnedTrade(
        sourceSignals[index],
        index
      );

    if (
      Array.isArray(
        result.warnings
      )
    ) {

      warnings.push(
        ...result.warnings
      );

    }

    if (
      !result.valid ||
      !result.trade
    ) {

      rejectedTrades.push({
        sourceIndex: index,
        errors:
          uniqueSortedStrings(
            result.errors
          )
      });

      continue;

    }

    const tradeKey =
      createTradeKey(
        result.trade
      );

    const setupIdentityKey =
      createSetupIdentityKey(
        result.trade
      );

    if (
      seenTradeKeys.has(
        tradeKey
      ) ||
      (
        setupIdentityKey &&
        seenSetupKeys.has(
          setupIdentityKey
        )
      )
    ) {

      duplicateTradeKeys +=
        1;

      continue;

    }

    seenTradeKeys.add(
      tradeKey
    );

    if (
      setupIdentityKey
    ) {

      seenSetupKeys.add(
        setupIdentityKey
      );

    }

    acceptedTrades.push({
      ...result.trade,
      tradeKey
    });

  }

  acceptedTrades.sort(
    (
      left,
      right
    ) => {

      const leftOpenedTime =
        new Date(
          left.openedAt
        ).getTime();

      const rightOpenedTime =
        new Date(
          right.openedAt
        ).getTime();

      if (
        leftOpenedTime !==
        rightOpenedTime
      ) {

        return (
          leftOpenedTime -
          rightOpenedTime
        );

      }

      const leftClosedTime =
        new Date(
          left.closedAt
        ).getTime();

      const rightClosedTime =
        new Date(
          right.closedAt
        ).getTime();

      if (
        leftClosedTime !==
        rightClosedTime
      ) {

        return (
          leftClosedTime -
          rightClosedTime
        );

      }

      return left.tradeKey.localeCompare(
        right.tradeKey
      );

    }
  );

  return {
    sourceSignals:
      sourceSignals.length,

    acceptedTrades,

    rejectedTrades,

    duplicateTradeKeys,

    warnings:
      uniqueSortedStrings(
        warnings
      )
  };

}

// -----------------------------------------------------------------------------
// Internal aggregation accumulator
// -----------------------------------------------------------------------------

function createPerformanceAccumulator() {

  return {
    totalTrades: 0,
    wins: 0,
    losses: 0,
    breakevens: 0,

    totalProfitPoints: 0,
    profitPointSamples: 0,
    grossProfitPoints: 0,
    grossLossPoints: 0,

    totalResultPercentage: 0,
    resultPercentageSamples: 0,

    totalDurationMinutes: 0,
    durationSamples: 0,

    firstTradeAt: null,
    lastTradeAt: null,

    confidenceSamples: 0,
    confidenceTotal: 0,
    confidenceMinimum: null,
    confidenceMaximum: null
  };

}

function updateTimestampRange(
  accumulator,
  trade
) {

  const candidateFirst =
    trade.openedAt ||
    trade.closedAt ||
    null;

  const candidateLast =
    trade.closedAt ||
    trade.openedAt ||
    null;

  if (
    candidateFirst
  ) {

    if (
      !accumulator.firstTradeAt ||
      new Date(
        candidateFirst
      ).getTime() <
      new Date(
        accumulator.firstTradeAt
      ).getTime()
    ) {

      accumulator.firstTradeAt =
        candidateFirst;

    }

  }

  if (
    candidateLast
  ) {

    if (
      !accumulator.lastTradeAt ||
      new Date(
        candidateLast
      ).getTime() >
      new Date(
        accumulator.lastTradeAt
      ).getTime()
    ) {

      accumulator.lastTradeAt =
        candidateLast;

    }

  }

}

function addTradeToAccumulator(
  accumulator,
  trade
) {

  accumulator.totalTrades +=
    1;

  if (
    trade.outcome === "WIN"
  ) {

    accumulator.wins +=
      1;

  } else if (
    trade.outcome === "LOSS"
  ) {

    accumulator.losses +=
      1;

  } else if (
    trade.outcome === "BREAKEVEN"
  ) {

    accumulator.breakevens +=
      1;

  }

  if (
    trade.profitPoints !== null
  ) {

    accumulator.totalProfitPoints +=
      trade.profitPoints;

    accumulator.profitPointSamples +=
      1;

    if (
      trade.profitPoints > 0
    ) {

      accumulator.grossProfitPoints +=
        trade.profitPoints;

    } else if (
      trade.profitPoints < 0
    ) {

      accumulator.grossLossPoints +=
        Math.abs(
          trade.profitPoints
        );

    }

  }

  if (
    trade.resultPercentage !== null
  ) {

    accumulator.totalResultPercentage +=
      trade.resultPercentage;

    accumulator.resultPercentageSamples +=
      1;

  }

  if (
    trade.durationMinutes !== null
  ) {

    accumulator.totalDurationMinutes +=
      trade.durationMinutes;

    accumulator.durationSamples +=
      1;

  }

  if (
    trade.confidence !== null
  ) {

    accumulator.confidenceSamples +=
      1;

    accumulator.confidenceTotal +=
      trade.confidence;

    if (
      accumulator.confidenceMinimum === null ||
      trade.confidence <
      accumulator.confidenceMinimum
    ) {

      accumulator.confidenceMinimum =
        trade.confidence;

    }

    if (
      accumulator.confidenceMaximum === null ||
      trade.confidence >
      accumulator.confidenceMaximum
    ) {

      accumulator.confidenceMaximum =
        trade.confidence;

    }

  }

  updateTimestampRange(
    accumulator,
    trade
  );

}

// -----------------------------------------------------------------------------
// Performance-stat finalization
// -----------------------------------------------------------------------------

function calculateRate(
  count,
  total
) {

  if (
    total <= 0
  ) {

    return 0;

  }

  return round(
    (
      count /
      total
    ) *
    100,
    2
  );

}

function finalizePerformanceAccumulator(
  accumulator
) {

  const totalTrades =
    normalizeNonNegativeInteger(
      accumulator.totalTrades
    );

  const totalProfitPoints =
    round(
      accumulator.totalProfitPoints,
      8
    ) || 0;

  const grossProfitPoints =
    round(
      accumulator.grossProfitPoints,
      8
    ) || 0;

  const grossLossPoints =
    round(
      accumulator.grossLossPoints,
      8
    ) || 0;

  let profitFactor =
    null;

  if (
    grossLossPoints > 0
  ) {

    profitFactor =
      round(
        grossProfitPoints /
        grossLossPoints,
        4
      );

  } else if (
    grossProfitPoints > 0
  ) {

    profitFactor =
      null;

  } else if (
    totalTrades > 0
  ) {

    profitFactor =
      0;

  }

  const averageProfitPoints =
    accumulator.profitPointSamples > 0
      ? round(
          accumulator.totalProfitPoints /
          accumulator.profitPointSamples,
          8
        )
      : 0;

  const totalResultPercentage =
    round(
      accumulator.totalResultPercentage,
      8
    ) || 0;

  const averageResultPercentage =
    accumulator.resultPercentageSamples > 0
      ? round(
          accumulator.totalResultPercentage /
          accumulator.resultPercentageSamples,
          8
        )
      : 0;

  const totalDurationMinutes =
    round(
      accumulator.totalDurationMinutes,
      4
    ) || 0;

  const averageDurationMinutes =
    accumulator.durationSamples > 0
      ? round(
          accumulator.totalDurationMinutes /
          accumulator.durationSamples,
          4
        )
      : null;

  const confidenceAverage =
    accumulator.confidenceSamples > 0
      ? round(
          accumulator.confidenceTotal /
          accumulator.confidenceSamples,
          4
        )
      : null;

  const wins =
    normalizeNonNegativeInteger(
      accumulator.wins
    );

  const losses =
    normalizeNonNegativeInteger(
      accumulator.losses
    );

  const breakevens =
    normalizeNonNegativeInteger(
      accumulator.breakevens
    );

  const decisiveTrades =
    wins + losses;

  return {
    totalTrades,

    wins,
    losses,
    breakevens,

    /*
     * Keep AI Memory aligned with learner.js: WIN/LOSS rates are based only
     * on decisive outcomes, while BREAKEVEN rate remains total-trade based.
     */
    winRate:
      calculateRate(
        wins,
        decisiveTrades
      ),

    lossRate:
      calculateRate(
        losses,
        decisiveTrades
      ),

    breakevenRate:
      calculateRate(
        breakevens,
        totalTrades
      ),

    totalProfitPoints,
    averageProfitPoints,
    grossProfitPoints,
    grossLossPoints,
    profitFactor,

    totalResultPercentage,
    averageResultPercentage,

    totalDurationMinutes,
    averageDurationMinutes,

    firstTradeAt:
      accumulator.firstTradeAt,

    lastTradeAt:
      accumulator.lastTradeAt,

    confidence: {
      samples:
        normalizeNonNegativeInteger(
          accumulator.confidenceSamples
        ),

      total:
        round(
          accumulator.confidenceTotal,
          4
        ) || 0,

      average:
        confidenceAverage,

      minimum:
        round(
          accumulator.confidenceMinimum,
          4
        ),

      maximum:
        round(
          accumulator.confidenceMaximum,
          4
        )
    }
  };

}

// -----------------------------------------------------------------------------
// Dimension-map aggregation
// -----------------------------------------------------------------------------

function ensureAccumulator(
  accumulatorMap,
  key
) {

  if (
    !key
  ) {

    return null;

  }

  if (
    !Object.prototype.hasOwnProperty.call(
      accumulatorMap,
      key
    )
  ) {

    accumulatorMap[key] =
      createPerformanceAccumulator();

  }

  return accumulatorMap[key];

}

function addTradeToDimension(
  accumulatorMap,
  key,
  trade
) {

  const accumulator =
    ensureAccumulator(
      accumulatorMap,
      key
    );

  if (
    !accumulator
  ) {

    return false;

  }

  addTradeToAccumulator(
    accumulator,
    trade
  );

  return true;

}

function finalizeDimensionMap(
  accumulatorMap
) {

  const finalized =
    {};

  for (
    const key of Object.keys(
      accumulatorMap
    ).sort(
      (
        left,
        right
      ) =>
        left.localeCompare(
          right
        )
    )
  ) {

    finalized[key] =
      finalizePerformanceAccumulator(
        accumulatorMap[key]
      );

  }

  return finalized;

}

// -----------------------------------------------------------------------------
// Combination-key helpers
// -----------------------------------------------------------------------------

function createCombinationKey(
  values
) {

  if (
    !Array.isArray(
      values
    )
  ) {

    return null;

  }

  const normalized =
    values.map(
      value =>
        toNonEmptyStringOrNull(
          value
        )
    );

  if (
    normalized.some(
      value =>
        value === null
    )
  ) {

    return null;

  }

  return normalized.join(
    "::"
  );

}

// -----------------------------------------------------------------------------
// Coverage tracking
// -----------------------------------------------------------------------------

function updateCoverageDimension(
  coverage,
  dimensionName,
  value
) {

  if (
    !isPlainObject(
      coverage[dimensionName]
    )
  ) {

    return;

  }

  if (
    value !== null &&
    value !== undefined &&
    value !== ""
  ) {

    coverage[dimensionName].available +=
      1;

  } else {

    coverage[dimensionName].missing +=
      1;

  }

}

function updateCoverage(
  coverage,
  trade
) {

  coverage.totalAcceptedTrades +=
    1;

  updateCoverageDimension(
    coverage,
    "pairs",
    trade.pair
  );

  updateCoverageDimension(
    coverage,
    "engines",
    trade.engine
  );

  updateCoverageDimension(
    coverage,
    "directions",
    trade.direction
  );

  updateCoverageDimension(
    coverage,
    "timeframes",
    trade.timeframe
  );

  updateCoverageDimension(
    coverage,
    "sessions",
    trade.session
  );

  updateCoverageDimension(
    coverage,
    "patterns",
    trade.pattern
  );

  updateCoverageDimension(
    coverage,
    "marketRegimes",
    trade.marketRegime
  );

}

// -----------------------------------------------------------------------------
// Confidence overlay normalization
// -----------------------------------------------------------------------------

function normalizeConfidenceMetric(
  value
) {

  if (
    !isPlainObject(
      value
    )
  ) {

    return null;

  }

  const confidence =
    clamp(
      getFirstDefinedValue(
        value,
        [
          ["confidence"],
          ["score"],
          ["value"]
        ]
      ),
      0,
      100
    );

  const normalizeOptionalCount =
    candidate => {

      if (
        candidate === undefined ||
        candidate === null ||
        candidate === ""
      ) {

        return null;

      }

      const number =
        toFiniteNumber(
          candidate
        );

      if (
        number === null ||
        number < 0
      ) {

        return null;

      }

      return Math.floor(
        number
      );

    };

  const total =
    normalizeOptionalCount(
      getFirstDefinedValue(
        value,
        [
          ["total"],
          ["totalSignals"],
          ["resolved"]
        ]
      )
    );

  const resolved =
    normalizeOptionalCount(
      getFirstDefinedValue(
        value,
        [
          ["resolved"],
          ["resolvedSignals"],
          ["total"]
        ]
      )
    );

  const wins =
    normalizeOptionalCount(
      value.wins
    );

  const losses =
    normalizeOptionalCount(
      value.losses
    );

  const breakevens =
    normalizeOptionalCount(
      value.breakevens
    );

  const winRate =
    toFiniteNumber(
      value.winRate
    );

  const averageProfitPoints =
    toFiniteNumber(
      getFirstDefinedValue(
        value,
        [
          ["avgProfitPoints"],
          ["averageProfitPoints"]
        ]
      )
    );

  const profitFactor =
    toFiniteNumber(
      value.profitFactor
    );

  return {
    confidence:
      round(
        confidence,
        4
      ),

    total,
    resolved,
    wins,
    losses,
    breakevens,

    winRate:
      round(
        winRate,
        4
      ),

    averageProfitPoints:
      round(
        averageProfitPoints,
        8
      ),

    profitFactor:
      round(
        profitFactor,
        4
      )
  };

}

function normalizeConfidenceSection(
  value,
  keyNormalizer = null
) {

  if (
    !isPlainObject(
      value
    )
  ) {

    return {};

  }

  const normalized =
    {};

  const selectedSources =
    {};

  const sourceKeys =
    Object.keys(
      value
    ).sort(
      (
        left,
        right
      ) =>
        left.localeCompare(
          right
        )
    );

  for (
    const sourceKey of sourceKeys
  ) {

    const targetKey =
      typeof keyNormalizer === "function"
        ? keyNormalizer(
            sourceKey
          )
        : toNonEmptyStringOrNull(
            sourceKey
          );

    if (
      !targetKey
    ) {

      continue;

    }

    const metric =
      normalizeConfidenceMetric(
        value[sourceKey]
      );

    if (
      !metric
    ) {

      continue;

    }

    const exactCanonicalKey =
      toTrimmedString(
        sourceKey
      ) ===
      targetKey;

    const existingSelection =
      selectedSources[targetKey];

    if (
      existingSelection &&
      !(
        exactCanonicalKey &&
        !existingSelection
          .exactCanonicalKey
      )
    ) {

      continue;

    }

    selectedSources[targetKey] = {
      sourceKey,
      exactCanonicalKey
    };

    normalized[targetKey] =
      metric;

  }

  return sortObjectKeysDeep(
    normalized
  );

}

function buildConfidenceOverlay(
  confidenceDocument
) {

  const confidenceRoot =
    extractConfidenceRoot(
      confidenceDocument
    );

  if (
    !confidenceRoot
  ) {

    return {
      strategies: {},
      pairs: {},
      timeframes: {},
      overall: null
    };

  }

  return {
    strategies:
      normalizeConfidenceSection(
        confidenceRoot.strategies,
        normalizeEngine
      ),

    pairs:
      normalizeConfidenceSection(
        confidenceRoot.pairs,
        normalizePair
      ),

    timeframes:
      normalizeConfidenceSection(
        confidenceRoot.timeframes,
        normalizeTimeframe
      ),

    overall:
      normalizeConfidenceMetric(
        confidenceRoot.overall
      )
  };

}

// -----------------------------------------------------------------------------
// Memory aggregation context
// -----------------------------------------------------------------------------
function createAggregationContext() {

  return {
    summary:
      createPerformanceAccumulator(),

    memory: {
      pairs: {},
      engines: {},
      directions: {},
      timeframes: {},
      sessions: {},
      patterns: {},
      marketRegimes: {}
    },

    combinations: {
      pairEngine: {},
      pairDirection: {},
      engineDirection: {},
      pairEngineDirection: {},
      pairSession: {},
      pairPattern: {},
      pairMarketRegime: {}
    },

    coverage:
      createEmptyCoverage()
  };

}

// -----------------------------------------------------------------------------
// Canonical trade eligibility
// -----------------------------------------------------------------------------

function isCanonicalPair(
  pair
) {

  return (
    typeof pair === "string" &&
    SUPPORTED_PAIRS.has(
      pair
    )
  );

}

function isCanonicalEngine(
  engine
) {

  return (
    typeof engine === "string" &&
    SUPPORTED_ENGINES.has(
      engine
    )
  );

}

function isCanonicalDirection(
  direction
) {

  return (
    typeof direction === "string" &&
    SUPPORTED_DIRECTIONS.has(
      direction
    )
  );

}

function isCanonicalOutcome(
  outcome
) {

  return (
    typeof outcome === "string" &&
    SUPPORTED_OUTCOMES.has(
      outcome
    )
  );

}

function isCanonicalTrade(
  trade
) {

  if (
    !isPlainObject(
      trade
    )
  ) {

    return false;

  }

  return (
    isCanonicalPair(
      trade.pair
    ) &&
    isCanonicalEngine(
      trade.engine
    ) &&
    isCanonicalDirection(
      trade.direction
    ) &&
    isCanonicalOutcome(
      trade.outcome
    )
  );

}

// -----------------------------------------------------------------------------
// Single-trade memory aggregation
// -----------------------------------------------------------------------------

function addTradeToPrimaryDimensions(
  context,
  trade
) {

  addTradeToDimension(
    context.memory.pairs,
    trade.pair,
    trade
  );

  addTradeToDimension(
    context.memory.engines,
    trade.engine,
    trade
  );

  addTradeToDimension(
    context.memory.directions,
    trade.direction,
    trade
  );

  if (
    trade.timeframe
  ) {

    addTradeToDimension(
      context.memory.timeframes,
      trade.timeframe,
      trade
    );

  }

  if (
    trade.session
  ) {

    addTradeToDimension(
      context.memory.sessions,
      trade.session,
      trade
    );

  }

  if (
    trade.pattern
  ) {

    addTradeToDimension(
      context.memory.patterns,
      trade.pattern,
      trade
    );

  }

  if (
    trade.marketRegime
  ) {

    addTradeToDimension(
      context.memory.marketRegimes,
      trade.marketRegime,
      trade
    );

  }

}

function addTradeToCombinationDimensions(
  context,
  trade
) {

  const pairEngineKey =
    createCombinationKey([
      trade.pair,
      trade.engine
    ]);

  const pairDirectionKey =
    createCombinationKey([
      trade.pair,
      trade.direction
    ]);

  const engineDirectionKey =
    createCombinationKey([
      trade.engine,
      trade.direction
    ]);

  const pairEngineDirectionKey =
    createCombinationKey([
      trade.pair,
      trade.engine,
      trade.direction
    ]);

  const pairSessionKey =
    createCombinationKey([
      trade.pair,
      trade.session
    ]);

  const pairPatternKey =
    createCombinationKey([
      trade.pair,
      trade.pattern
    ]);

  const pairMarketRegimeKey =
    createCombinationKey([
      trade.pair,
      trade.marketRegime
    ]);

  if (
    pairEngineKey
  ) {

    addTradeToDimension(
      context.combinations.pairEngine,
      pairEngineKey,
      trade
    );

  }

  if (
    pairDirectionKey
  ) {

    addTradeToDimension(
      context.combinations.pairDirection,
      pairDirectionKey,
      trade
    );

  }

  if (
    engineDirectionKey
  ) {

    addTradeToDimension(
      context.combinations.engineDirection,
      engineDirectionKey,
      trade
    );

  }

  if (
    pairEngineDirectionKey
  ) {

    addTradeToDimension(
      context.combinations.pairEngineDirection,
      pairEngineDirectionKey,
      trade
    );

  }

  if (
    pairSessionKey
  ) {

    addTradeToDimension(
      context.combinations.pairSession,
      pairSessionKey,
      trade
    );

  }

  if (
    pairPatternKey
  ) {

    addTradeToDimension(
      context.combinations.pairPattern,
      pairPatternKey,
      trade
    );

  }

  if (
    pairMarketRegimeKey
  ) {

    addTradeToDimension(
      context.combinations.pairMarketRegime,
      pairMarketRegimeKey,
      trade
    );

  }

}

function addTradeToMemoryContext(
  context,
  trade
) {

  if (
    !isCanonicalTrade(
      trade
    )
  ) {

    return false;

  }

  addTradeToAccumulator(
    context.summary,
    trade
  );

  addTradeToPrimaryDimensions(
    context,
    trade
  );

  addTradeToCombinationDimensions(
    context,
    trade
  );

  updateCoverage(
    context.coverage,
    trade
  );

  return true;

}

// -----------------------------------------------------------------------------
// Aggregation finalization
// -----------------------------------------------------------------------------

function finalizeMemoryContext(
  context
) {

  return {
    summary:
      finalizePerformanceAccumulator(
        context.summary
      ),

    memory: {
      pairs:
        finalizeDimensionMap(
          context.memory.pairs
        ),

      engines:
        finalizeDimensionMap(
          context.memory.engines
        ),

      directions:
        finalizeDimensionMap(
          context.memory.directions
        ),

      timeframes:
        finalizeDimensionMap(
          context.memory.timeframes
        ),

      sessions:
        finalizeDimensionMap(
          context.memory.sessions
        ),

      patterns:
        finalizeDimensionMap(
          context.memory.patterns
        ),

      marketRegimes:
        finalizeDimensionMap(
          context.memory.marketRegimes
        )
    },

    combinations: {
      pairEngine:
        finalizeDimensionMap(
          context.combinations.pairEngine
        ),

      pairDirection:
        finalizeDimensionMap(
          context.combinations.pairDirection
        ),

      engineDirection:
        finalizeDimensionMap(
          context.combinations.engineDirection
        ),

      pairEngineDirection:
        finalizeDimensionMap(
          context.combinations.pairEngineDirection
        ),

      pairSession:
        finalizeDimensionMap(
          context.combinations.pairSession
        ),

      pairPattern:
        finalizeDimensionMap(
          context.combinations.pairPattern
        ),

      pairMarketRegime:
        finalizeDimensionMap(
          context.combinations.pairMarketRegime
        )
    },

    coverage:
      cloneJSONCompatible(
        context.coverage
      )
  };

}

// -----------------------------------------------------------------------------
// Confidence overlay attachment
// -----------------------------------------------------------------------------

function attachConfidenceToMetric(
  metric,
  confidenceMetric
) {

  if (
    !isPlainObject(
      metric
    )
  ) {

    return metric;

  }

  const result =
    {
      ...metric
    };

  if (
    isPlainObject(
      confidenceMetric
    )
  ) {

    result.learningConfidence =
      cloneJSONCompatible(
        confidenceMetric
      );

  } else {

    result.learningConfidence =
      null;

  }

  return result;

}

function attachConfidenceToDimensionMap(
  dimensionMap,
  confidenceMap
) {

  const result =
    {};

  const sourceDimensions =
    isPlainObject(
      dimensionMap
    )
      ? dimensionMap
      : {};

  const sourceConfidence =
    isPlainObject(
      confidenceMap
    )
      ? confidenceMap
      : {};

  for (
    const key of Object.keys(
      sourceDimensions
    ).sort(
      (
        left,
        right
      ) =>
        left.localeCompare(
          right
        )
    )
  ) {

    result[key] =
      attachConfidenceToMetric(
        sourceDimensions[key],
        sourceConfidence[key]
      );

  }

  return result;

}

function applyConfidenceOverlay(
  aggregatedMemory,
  confidenceOverlay
) {

  const memory =
    cloneJSONCompatible(
      aggregatedMemory
    );

  const overlay =
    isPlainObject(
      confidenceOverlay
    )
      ? confidenceOverlay
      : {
          strategies: {},
          pairs: {},
          timeframes: {},
          overall: null
        };

  memory.summary =
    attachConfidenceToMetric(
      memory.summary,
      overlay.overall
    );

  memory.memory.pairs =
    attachConfidenceToDimensionMap(
      memory.memory.pairs,
      overlay.pairs
    );

  memory.memory.engines =
    attachConfidenceToDimensionMap(
      memory.memory.engines,
      overlay.strategies
    );

  memory.memory.timeframes =
    attachConfidenceToDimensionMap(
      memory.memory.timeframes,
      overlay.timeframes
    );

  return memory;

}

// -----------------------------------------------------------------------------
// Memory document validation
// -----------------------------------------------------------------------------

function validatePerformanceStats(
  stats,
  label
) {

  const errors =
    [];

  const warnings =
    [];

  if (
    !isPlainObject(
      stats
    )
  ) {

    errors.push(
      `${label} must be a JSON object.`
    );

    return createValidationResult(
      false,
      errors,
      warnings
    );

  }

  const totalTrades =
    normalizeNonNegativeInteger(
      stats.totalTrades
    );

  const wins =
    normalizeNonNegativeInteger(
      stats.wins
    );

  const losses =
    normalizeNonNegativeInteger(
      stats.losses
    );

  const breakevens =
    normalizeNonNegativeInteger(
      stats.breakevens
    );

  const outcomeTotal =
    wins +
    losses +
    breakevens;

  if (
    outcomeTotal !== totalTrades
  ) {

    errors.push(
      `${label} outcome counts do not equal totalTrades.`
    );

  }

  const winRate =
    toFiniteNumber(
      stats.winRate
    );

  const lossRate =
    toFiniteNumber(
      stats.lossRate
    );

  const breakevenRate =
    toFiniteNumber(
      stats.breakevenRate
    );

  const decisiveTrades =
    wins + losses;

  if (
    winRate === null ||
    winRate < 0 ||
    winRate > 100 ||
    lossRate === null ||
    lossRate < 0 ||
    lossRate > 100 ||
    breakevenRate === null ||
    breakevenRate < 0 ||
    breakevenRate > 100
  ) {

    errors.push(
      `${label} outcome rates must be finite percentages between 0 and 100.`
    );

  } else {

    const decisiveRateTotal =
      winRate +
      lossRate;

    if (
      decisiveTrades > 0 &&
      Math.abs(
        decisiveRateTotal -
        100
      ) > 0.1
    ) {

      warnings.push(
        `${label} WIN and LOSS rates do not total approximately 100%.`
      );

    }

    if (
      decisiveTrades === 0 &&
      decisiveRateTotal !== 0
    ) {

      warnings.push(
        `${label} has WIN or LOSS rate without a decisive trade.`
      );

    }

    const expectedBreakevenRate =
      calculateRate(
        breakevens,
        totalTrades
      );

    if (
      Math.abs(
        breakevenRate -
        expectedBreakevenRate
      ) > 0.1
    ) {

      warnings.push(
        `${label} BREAKEVEN rate does not match total trades.`
      );

    }

  }

  if (
    !isPlainObject(
      stats.confidence
    )
  ) {

    errors.push(
      `${label}.confidence must be a JSON object.`
    );

  }

  return createValidationResult(
    errors.length === 0,
    errors,
    warnings
  );

}

function validateDimensionMap(
  dimensionMap,
  label
) {

  const results =
    [];

  if (
    !isPlainObject(
      dimensionMap
    )
  ) {

    return createValidationResult(
      false,
      [
        `${label} must be a JSON object.`
      ],
      []
    );

  }

  for (
    const key of Object.keys(
      dimensionMap
    )
  ) {

    results.push(
      validatePerformanceStats(
        dimensionMap[key],
        `${label}.${key}`
      )
    );

  }

  return mergeValidationResults(
    results
  );

}

function validateMemoryEnrichmentSection(
  enrichment
) {

  const errors =
    [];

  const warnings =
    [];

  if (
    !isPlainObject(
      enrichment
    )
  ) {

    errors.push(
      "AI memory enrichment section must be a JSON object."
    );

    return createValidationResult(
      false,
      errors,
      warnings
    );

  }

  if (
    typeof enrichment.available !==
      "boolean"
  ) {

    errors.push(
      "AI memory enrichment.available must be a boolean."
    );

  }

  if (
    enrichment.advisoryOnly !==
      true
  ) {

    errors.push(
      "AI memory enrichment must remain advisory-only."
    );

  }

  if (
    typeof enrichment.compatible !==
      "boolean"
  ) {

    errors.push(
      "AI memory enrichment.compatible must be a boolean."
    );

  }

  if (
    enrichment.available ===
      true
  ) {

    if (
      enrichment.compatible !==
        true
    ) {

      errors.push(
        "Available AI memory enrichment must be compatible."
      );

    }

    if (
      !toISOStringOrNull(
        enrichment.generatedAt
      )
    ) {

      errors.push(
        "Available AI memory enrichment generatedAt is invalid."
      );

    }

    if (
      !isPlainObject(
        enrichment.summary
      )
    ) {

      errors.push(
        "Available AI memory enrichment summary is missing."
      );

    }

    if (
      !isPlainObject(
        enrichment.intelligence
      )
    ) {

      errors.push(
        "Available AI memory enrichment intelligence is missing."
      );

    }

  } else {

    if (
      enrichment.compatible !==
        false
    ) {

      errors.push(
        "Unavailable AI memory enrichment must not be marked compatible."
      );

    }

    if (
      !toNonEmptyStringOrNull(
        enrichment.reason
      )
    ) {

      warnings.push(
        "Unavailable AI memory enrichment does not contain a reason."
      );

    }

  }

  return createValidationResult(
    errors.length === 0,
    errors,
    warnings
  );

}

function validateMemoryDocument(
  document
) {

  const results =
    [];

  const errors =
    [];

  const warnings =
    [];

  if (
    !isPlainObject(
      document
    )
  ) {

    return createValidationResult(
      false,
      [
        "AI memory document must be a JSON object."
      ],
      []
    );

  }

  if (
    document.version !==
      MEMORY_SCHEMA_VERSION
  ) {

    errors.push(
      "AI memory document schema version is invalid."
    );

  }

  if (
    document.engineName !==
      ENGINE_NAME
  ) {

    errors.push(
      "AI memory document engine name is invalid."
    );

  }

  if (
    document.engineVersion !==
      ENGINE_VERSION
  ) {

    errors.push(
      "AI memory document engine version is invalid."
    );

  }

  if (
    !toISOStringOrNull(
      document.generatedAt
    )
  ) {

    errors.push(
      "AI memory document generatedAt timestamp is invalid."
    );

  }

  results.push(
    validatePerformanceStats(
      document.summary,
      "summary"
    )
  );

  if (
    !isPlainObject(
      document.memory
    )
  ) {

    errors.push(
      "AI memory document memory section must be a JSON object."
    );

  } else {

    for (
      const dimensionName of DIMENSION_NAMES
    ) {

      results.push(
        validateDimensionMap(
          document.memory[dimensionName],
          `memory.${dimensionName}`
        )
      );

    }

  }

  if (
    !isPlainObject(
      document.combinations
    )
  ) {

    errors.push(
      "AI memory document combinations section must be a JSON object."
    );

  } else {

    const combinationNames =
      [
        "pairEngine",
        "pairDirection",
        "engineDirection",
        "pairEngineDirection",
        "pairSession",
        "pairPattern",
        "pairMarketRegime"
      ];

    for (
      const combinationName of
      combinationNames
    ) {

      results.push(
        validateDimensionMap(
          document.combinations[
            combinationName
          ],
          `combinations.${combinationName}`
        )
      );

    }

  }

  results.push(
    validateMemoryEnrichmentSection(
      document.enrichment
    )
  );

  results.push(
    validateAutonomousMemorySection(
      document.autonomousMemory
    )
  );

  if (
    !isPlainObject(
      document.coverage
    )
  ) {

    errors.push(
      "AI memory document coverage section must be a JSON object."
    );

  }

  if (
    !isPlainObject(
      document.source
    )
  ) {

    errors.push(
      "AI memory document source section must be a JSON object."
    );

  } else {

    if (
      !toNonEmptyStringOrNull(
        document.source
          .learningDataPath
      )
    ) {

      errors.push(
        "AI memory learningDataPath is missing."
      );

    }

    if (
      !toNonEmptyStringOrNull(
        document.source
          .confidenceDataPath
      )
    ) {

      errors.push(
        "AI memory confidenceDataPath is missing."
      );

    }

    if (
      !toNonEmptyStringOrNull(
        document.source
          .learningEnrichmentPath
      )
    ) {

      errors.push(
        "AI memory learningEnrichmentPath is missing."
      );

    }

  }

  const combined =
    mergeValidationResults(
      results
    );

  errors.push(
    ...combined.errors
  );

  warnings.push(
    ...combined.warnings
  );

  return createValidationResult(
    errors.length === 0,
    errors,
    warnings
  );

}

// -----------------------------------------------------------------------------
// Memory document builder
// -----------------------------------------------------------------------------
function buildMemoryDocument({
  learningDocument,
  confidenceDocument,
  normalizedTrades,
  enrichmentMemory,
  enrichmentHash,
  enrichmentModifiedAt,
  generatedAt
}) {

  const memoryDocument =
    createEmptyMemoryDocument(
      generatedAt
    );

  const aggregationContext =
    createAggregationContext();

  const canonicalTrades =
    [];

  const skippedNonCanonicalTrades =
    [];

  for (
    const trade of
    normalizedTrades.acceptedTrades
  ) {

    if (
      addTradeToMemoryContext(
        aggregationContext,
        trade
      )
    ) {

      canonicalTrades.push(
        trade
      );

    } else {

      skippedNonCanonicalTrades.push(
        trade.tradeKey
      );

    }

  }

  const finalizedAggregation =
    finalizeMemoryContext(
      aggregationContext
    );

  const confidenceOverlay =
    buildConfidenceOverlay(
      confidenceDocument
    );

  const memoryWithConfidence =
    applyConfidenceOverlay(
      finalizedAggregation,
      confidenceOverlay
    );

  memoryDocument.summary =
    memoryWithConfidence.summary;

  memoryDocument.memory =
    memoryWithConfidence.memory;

  memoryDocument.combinations =
    memoryWithConfidence.combinations;

  memoryDocument.coverage =
    memoryWithConfidence.coverage;

  memoryDocument.enrichment =
    isPlainObject(
      enrichmentMemory
    )
      ? cloneJSONCompatible(
          enrichmentMemory
        )
      : createUnavailableEnrichmentMemory();

  memoryDocument.autonomousMemory =
    buildAutonomousMemory(
      canonicalTrades,
      generatedAt
    );

  const learningModifiedAt =
    getFileModifiedAt(
      LEARNING_DATA_PATH
    );

  const confidenceModifiedAt =
    getFileModifiedAt(
      CONFIDENCE_DATA_PATH
    );

  const learningUpdatedAt =
    extractLearningUpdatedAt(
      learningDocument
    );

  const confidenceUpdatedAt =
    extractConfidenceUpdatedAt(
      confidenceDocument
    );

  memoryDocument.sourceUpdatedAt =
    learningUpdatedAt ||
    learningModifiedAt ||
    null;

  memoryDocument.source = {
    learningDataPath:
      path.relative(
        ROOT_DIR,
        LEARNING_DATA_PATH
      ),

    confidenceDataPath:
      path.relative(
        ROOT_DIR,
        CONFIDENCE_DATA_PATH
      ),

    learningEnrichmentPath:
      path.relative(
        ROOT_DIR,
        LEARNING_ENRICHMENT_PATH
      ),

    learningEnrichmentStatePath:
      path.relative(
        ROOT_DIR,
        LEARNING_ENRICHMENT_STATE_PATH
      ),

    learningDataModifiedAt:
      learningModifiedAt,

    confidenceDataModifiedAt:
      confidenceModifiedAt,

    learningEnrichmentModifiedAt:
      enrichmentModifiedAt ||
      null,

    learningDataUpdatedAt:
      learningUpdatedAt,

    confidenceDataUpdatedAt:
      confidenceUpdatedAt,

    learningEnrichmentUpdatedAt:
      memoryDocument.enrichment
        .available
        ? memoryDocument.enrichment
            .generatedAt
        : null,

    learningDataHash:
      createHash(
        learningDocument
      ),

    confidenceDataHash:
      confidenceDocument
        ? createHash(
            confidenceDocument
          )
        : null,

    learningEnrichmentHash:
      enrichmentHash ||
      null,

    sourceSignalCount:
      normalizedTrades.sourceSignals,

    acceptedTradeCount:
      canonicalTrades.length,

    normalizedTradeCount:
      normalizedTrades.acceptedTrades.length,

    rejectedTradeCount:
      normalizedTrades.rejectedTrades.length,

    duplicateTradeCount:
      normalizedTrades.duplicateTradeKeys,

    skippedNonCanonicalTradeCount:
      skippedNonCanonicalTrades.length
  };

  const validationWarnings =
    [
      ...normalizedTrades.warnings
    ];

  if (
    normalizedTrades.duplicateTradeKeys >
    0
  ) {

    validationWarnings.push(
      `${normalizedTrades.duplicateTradeKeys} duplicate learned trade record(s) were skipped.`
    );

  }

  if (
    skippedNonCanonicalTrades.length >
    0
  ) {

    validationWarnings.push(
      `${skippedNonCanonicalTrades.length} normalized trade record(s) were excluded because their pair, engine, direction or outcome was not canonical.`
    );

  }

  if (
    memoryDocument.coverage.sessions.available ===
    0
  ) {

    validationWarnings.push(
      "No explicit session metadata was available; session memory remains empty."
    );

  }

  if (
    memoryDocument.coverage.patterns.available ===
    0
  ) {

    validationWarnings.push(
      "No explicit pattern metadata was available; pattern memory remains empty."
    );

  }

  if (
    memoryDocument.coverage.marketRegimes.available ===
    0
  ) {

    validationWarnings.push(
      "No explicit market-regime metadata was available; market-regime memory remains empty."
    );

  }

  if (
    memoryDocument.enrichment.available !==
    true
  ) {

    validationWarnings.push(
      memoryDocument.enrichment.reason ||
      "Optional Learning Enrichment was unavailable."
    );

  }

  const documentValidation =
    validateMemoryDocument(
      memoryDocument
    );

  memoryDocument.validation = {
    valid:
      documentValidation.valid,

    errors:
      uniqueSortedStrings(
        documentValidation.errors
      ),

    warnings:
      uniqueSortedStrings([
        ...documentValidation.warnings,
        ...validationWarnings
      ])
  };

  memoryDocument.metadata = {
    ...memoryDocument.metadata,

    enrichmentAvailable:
      memoryDocument.enrichment
        .available ===
      true,

    autonomousMemoryVersion:
      AUTONOMOUS_MEMORY_VERSION,

    autonomousMemoryValid:
      memoryDocument.autonomousMemory
        .validation
        .valid ===
      true,

    autonomousMemoryBucketCount:
      memoryDocument.autonomousMemory
        .summary
        .bucketCount,

    liveAuthorityPermitted:
      false,

    canonicalTradeKeys:
      canonicalTrades
        .map(
          trade =>
            trade.tradeKey
        )
        .sort(
          (
            left,
            right
          ) =>
            left.localeCompare(
              right
            )
        ),

    skippedNonCanonicalTradeKeys:
      uniqueSortedStrings(
        skippedNonCanonicalTrades
      )
  };

  return {
    memoryDocument:
      sortObjectKeysDeep(
        memoryDocument
      ),

    canonicalTrades,

    skippedNonCanonicalTrades
  };

}

// -----------------------------------------------------------------------------
// Source-change detection
// -----------------------------------------------------------------------------

function haveSourceHashesChanged(
  state,
  learningHash,
  confidenceHash,
  enrichmentHash
) {

  const previousLearningHash =
    getNestedValue(
      state,
      [
        "sourceHashes",
        "learningData"
      ]
    ) || null;

  const previousConfidenceHash =
    getNestedValue(
      state,
      [
        "sourceHashes",
        "confidenceData"
      ]
    ) || null;

  const previousEnrichmentHash =
    getNestedValue(
      state,
      [
        "sourceHashes",
        "learningEnrichment"
      ]
    ) || null;

  return (
    previousLearningHash !==
      learningHash ||
    previousConfidenceHash !==
      confidenceHash ||
    previousEnrichmentHash !==
      enrichmentHash
  );

}

// -----------------------------------------------------------------------------
// Processed trade-key reconciliation
// -----------------------------------------------------------------------------

function reconcileProcessedTradeKeys(
  previousKeys,
  canonicalTrades
) {

  const previousKeySet =
    new Set(
      uniqueSortedStrings(
        previousKeys
      )
    );

  const currentKeys =
    canonicalTrades
      .map(
        trade =>
          trade.tradeKey
      )
      .filter(
        Boolean
      );

  let newTradeKeys =
    0;

  let duplicateTradeKeys =
    0;

  for (
    const tradeKey of currentKeys
  ) {

    if (
      previousKeySet.has(
        tradeKey
      )
    ) {

      duplicateTradeKeys +=
        1;

    } else {

      newTradeKeys +=
        1;

    }

  }

  const processedTradeKeys =
    uniqueSortedStrings([
      ...previousKeySet,
      ...currentKeys
    ]).slice(
      -MAX_PROCESSED_KEYS
    );

  return {
    processedTradeKeys,
    newTradeKeys,
    duplicateTradeKeys
  };

}

// -----------------------------------------------------------------------------
// State mutation helpers
// -----------------------------------------------------------------------------

function beginMemoryRun(
  previousState,
  runAt
) {

  const state =
    normalizeExistingMemoryState(
      previousState
    );

  state.updatedAt =
    runAt;

  state.lastRunAt =
    runAt;

  state.counters.runs +=
    1;

  state.lastRun = {
    status:
      "RUNNING",

    sourceSignals:
      0,

    acceptedTrades:
      0,

    rejectedTrades:
      0,

    newTradeKeys:
      0,

    duplicateTradeKeys:
      0,

    memoryWritten:
      false,

    stateWritten:
      false,

    error:
      null
  };

  return state;

}

function completeMemoryRun({
  state,
  runAt,
  status,
  learningHash,
  confidenceHash,
  enrichmentHash,
  learningModifiedAt,
  confidenceModifiedAt,
  enrichmentModifiedAt,
  normalizedTrades,
  canonicalTrades,
  keyReconciliation,
  memoryWritten
}) {

  state.updatedAt =
    runAt;

  state.lastRunAt =
    runAt;

  state.lastSuccessfulRunAt =
    runAt;

  state.sourceHashes = {
    learningData:
      learningHash,

    confidenceData:
      confidenceHash,

    learningEnrichment:
      enrichmentHash ||
      null
  };

  state.sourceModifiedAt = {
    learningData:
      learningModifiedAt,

    confidenceData:
      confidenceModifiedAt,

    learningEnrichment:
      enrichmentModifiedAt ||
      null
  };

  state.processedTradeKeys =
    keyReconciliation.processedTradeKeys;

  state.counters.successfulRuns +=
    1;

  if (
    status === "UNCHANGED"
  ) {

    state.counters.unchangedRuns +=
      1;

  }

  state.counters.sourceSignals +=
    normalizedTrades.sourceSignals;

  state.counters.acceptedTrades +=
    canonicalTrades.length;

  state.counters.rejectedTrades +=
    normalizedTrades.rejectedTrades.length;

  state.counters.newTradeKeys +=
    keyReconciliation.newTradeKeys;

  state.counters.duplicateTradeKeys +=
    (
      normalizedTrades.duplicateTradeKeys +
      keyReconciliation.duplicateTradeKeys
    );

  state.lastRun = {
    status,

    sourceSignals:
      normalizedTrades.sourceSignals,

    acceptedTrades:
      canonicalTrades.length,

    rejectedTrades:
      normalizedTrades.rejectedTrades.length,

    newTradeKeys:
      keyReconciliation.newTradeKeys,

    duplicateTradeKeys:
      (
        normalizedTrades.duplicateTradeKeys +
        keyReconciliation.duplicateTradeKeys
      ),

    memoryWritten:
      Boolean(
        memoryWritten
      ),

    stateWritten:
      true,

    error:
      null
  };

  return state;

}

function failMemoryRun(
  state,
  runAt,
  error,
  options = {}
) {

  const message =
    error instanceof Error
      ? error.message
      : toTrimmedString(
          error
        ) || "Unknown AI Memory error.";

  state.updatedAt =
    runAt;

  state.lastRunAt =
    runAt;

  state.lastRun = {
    ...normalizeLastRunState(
      state.lastRun
    ),

    status:
      "FAILED",

    memoryWritten:
      Boolean(
        options.memoryWritten ||
        state.lastRun?.memoryWritten
      ),

    stateWritten:
      true,

    error:
      message
  };

  return state;

}

// -----------------------------------------------------------------------------
// Existing memory validation
// -----------------------------------------------------------------------------
function readExistingMemoryDocument() {

  const document =
    readJSON(
      AI_MEMORY_PATH,
      null
    );

  if (
    document === null
  ) {

    return {
      exists: false,
      valid: false,
      document: null,
      validation:
        createValidationResult(
          false,
          [
            "Existing ai-memory.json is unavailable."
          ],
          []
        )
    };

  }

  const validation =
    validateMemoryDocument(
      document
    );

  return {
    exists: true,
    valid:
      validation.valid,
    document,
    validation
  };

}

// -----------------------------------------------------------------------------
// Run-result formatting
// -----------------------------------------------------------------------------

function createRunResult({
  status,
  runAt,
  memoryWritten,
  stateWritten,
  sourceSignals,
  normalizedTrades,
  canonicalTrades,
  rejectedTrades,
  newTradeKeys,
  duplicateTradeKeys,
  enrichmentAvailable = false,
  warnings,
  error = null
}) {

  return {
    engineName:
      ENGINE_NAME,

    engineVersion:
      ENGINE_VERSION,

    status,

    runAt,

    memoryPath:
      path.relative(
        ROOT_DIR,
        AI_MEMORY_PATH
      ),

    statePath:
      path.relative(
        ROOT_DIR,
        AI_MEMORY_STATE_PATH
      ),

    memoryWritten:
      Boolean(
        memoryWritten
      ),

    stateWritten:
      Boolean(
        stateWritten
      ),

    enrichmentAvailable:
      Boolean(
        enrichmentAvailable
      ),

    counts: {
      sourceSignals:
        normalizeNonNegativeInteger(
          sourceSignals
        ),

      normalizedTrades:
        normalizeNonNegativeInteger(
          normalizedTrades
        ),

      canonicalTrades:
        normalizeNonNegativeInteger(
          canonicalTrades
        ),

      rejectedTrades:
        normalizeNonNegativeInteger(
          rejectedTrades
        ),

      newTradeKeys:
        normalizeNonNegativeInteger(
          newTradeKeys
        ),

      duplicateTradeKeys:
        normalizeNonNegativeInteger(
          duplicateTradeKeys
        )
    },

    warnings:
      uniqueSortedStrings(
        warnings
      ),

    error:
      error
        ? toTrimmedString(
            error
          )
        : null
  };

}

// -----------------------------------------------------------------------------
// Main AI Memory runner
// -----------------------------------------------------------------------------

function runAIMemory() {

  const runAt =
    new Date().toISOString();

  ensureDirectory(
    DATA_DIR
  );

  const previousStateDocument =
    readJSON(
      AI_MEMORY_STATE_PATH,
      null
    );

  const recovery =
    recoverPendingMemoryTransaction(
      previousStateDocument
    );

  if (
    recovery.recovered
  ) {

    console.warn(
      recovery.matched
        ? "[ai-memory] Recovered a completed AI Memory transaction."
        : "[ai-memory] Cleared an incomplete AI Memory transaction; memory will be rebuilt."
    );

  }

  let state =
    beginMemoryRun(
      recovery.state,
      runAt
    );

  let stateWritten =
    false;

  let memoryWritten =
    false;

  try {

    if (
      !fileExists(
        LEARNING_DATA_PATH
      )
    ) {

      throw new Error(
        `Required source file is missing: ${path.relative(
          ROOT_DIR,
          LEARNING_DATA_PATH
        )}`
      );

    }

    const learningDocument =
      readJSON(
        LEARNING_DATA_PATH,
        null
      );

    const confidenceDocument =
      readJSON(
        CONFIDENCE_DATA_PATH,
        null
      );

    /*
     * Optional source:
     *
     * Missing, malformed, incompatible or unhealthy enrichment does not
     * fail the AI Memory run. In those cases, exact existing memory
     * aggregation continues and the enrichment section reports unavailable.
     */
    const optionalEnrichment =
      loadOptionalLearningEnrichment();

    const learningValidation =
      validateLearningDocument(
        learningDocument
      );

    const confidenceValidation =
      validateConfidenceDocument(
        confidenceDocument
      );

    const sourceValidation =
      mergeValidationResults([
        learningValidation,
        confidenceValidation,
        optionalEnrichment.validation
      ]);

    if (
      !learningValidation.valid
    ) {

      throw new Error(
        learningValidation.errors.join(
          " "
        ) ||
        "learning-data.json validation failed."
      );

    }

    const learningHash =
      createHash(
        learningDocument
      );

    const confidenceHash =
      confidenceDocument
        ? createHash(
            confidenceDocument
          )
        : null;

    const enrichmentHash =
      optionalEnrichment.hash ||
      null;

    const learningModifiedAt =
      getFileModifiedAt(
        LEARNING_DATA_PATH
      );

    const confidenceModifiedAt =
      getFileModifiedAt(
        CONFIDENCE_DATA_PATH
      );

    const enrichmentModifiedAt =
      optionalEnrichment.modifiedAt ||
      null;

    const normalizedTrades =
      normalizeLearningTrades(
        learningDocument
      );

    const buildResult =
      buildMemoryDocument({
        learningDocument,
        confidenceDocument,
        normalizedTrades,

        enrichmentMemory:
          optionalEnrichment.memory,

        enrichmentHash,
        enrichmentModifiedAt,

        generatedAt:
          runAt
      });

    const {
      memoryDocument,
      canonicalTrades
    } =
      buildResult;

    if (
      !memoryDocument.validation.valid
    ) {

      throw new Error(
        memoryDocument.validation.errors.join(
          " "
        ) ||
        "Generated AI memory document validation failed."
      );

    }

    const keyReconciliation =
      reconcileProcessedTradeKeys(
        state.processedTradeKeys,
        canonicalTrades
      );

    const sourceHashesChanged =
      haveSourceHashesChanged(
        state,
        learningHash,
        confidenceHash,
        enrichmentHash
      );

    const existingMemory =
      readExistingMemoryDocument();

    const mustWriteMemory =
      (
        sourceHashesChanged ||
        !existingMemory.exists ||
        !existingMemory.valid
      );

    let status =
      "UNCHANGED";

    if (
      mustWriteMemory
    ) {

      status =
        "UPDATED";

      /*
       * Save a recovery marker before the external memory document write.
       * The marker records the exact expected memory hash and the state
       * deltas needed to finish the commit after an interrupted run.
       */
      state.pendingTransaction =
        createPendingMemoryTransaction({
          runAt,
          status,
          memoryDocument,

          learningHash,
          confidenceHash,
          enrichmentHash,

          learningModifiedAt,
          confidenceModifiedAt,
          enrichmentModifiedAt,

          normalizedTrades,
          canonicalTrades,
          keyReconciliation
        });

      atomicWriteJSON(
        AI_MEMORY_STATE_PATH,
        state
      );

      stateWritten =
        true;

      atomicWriteJSON(
        AI_MEMORY_PATH,
        memoryDocument
      );

      memoryWritten =
        true;

    }

    const completedState =
      completeMemoryRun({
        state:
          cloneJSONCompatible(
            state
          ),

        runAt,
        status,

        learningHash,
        confidenceHash,
        enrichmentHash,

        learningModifiedAt,
        confidenceModifiedAt,
        enrichmentModifiedAt,

        normalizedTrades,
        canonicalTrades,
        keyReconciliation,
        memoryWritten
      });

    completedState.pendingTransaction =
      null;

    /*
     * Do not mutate the in-memory recovery state until the final state commit
     * succeeds. If this write fails after ai-memory.json was written, the
     * pending transaction remains available for the next-run recovery path.
     */
    atomicWriteJSON(
      AI_MEMORY_STATE_PATH,
      completedState
    );

    state =
      completedState;

    stateWritten =
      true;

    const warnings =
      uniqueSortedStrings([
        ...sourceValidation.warnings,
        ...normalizedTrades.warnings,
        ...memoryDocument.validation.warnings
      ]);

    const result =
      createRunResult({
        status,
        runAt,
        memoryWritten,
        stateWritten,

        sourceSignals:
          normalizedTrades.sourceSignals,

        normalizedTrades:
          normalizedTrades
            .acceptedTrades
            .length,

        canonicalTrades:
          canonicalTrades.length,

        rejectedTrades:
          normalizedTrades
            .rejectedTrades
            .length,

        newTradeKeys:
          keyReconciliation
            .newTradeKeys,

        duplicateTradeKeys:
          (
            normalizedTrades
              .duplicateTradeKeys +
            keyReconciliation
              .duplicateTradeKeys
          ),

        enrichmentAvailable:
          optionalEnrichment
            .memory
            .available ===
          true,

        warnings
      });

    console.log(
      `[ai-memory] ${status}`
    );

    console.log(
      `[ai-memory] Source signals: ${result.counts.sourceSignals}`
    );

    console.log(
      `[ai-memory] Canonical trades: ${result.counts.canonicalTrades}`
    );

    console.log(
      `[ai-memory] Rejected trades: ${result.counts.rejectedTrades}`
    );

    console.log(
      `[ai-memory] New trade keys: ${result.counts.newTradeKeys}`
    );

    console.log(
      `[ai-memory] Duplicate trade keys: ${result.counts.duplicateTradeKeys}`
    );

    console.log(
      `[ai-memory] Enrichment available: ${result.enrichmentAvailable}`
    );

    console.log(
      `[ai-memory] Memory written: ${result.memoryWritten}`
    );

    if (
      result.warnings.length >
      0
    ) {

      console.warn(
        `[ai-memory] Completed with ${result.warnings.length} warning(s).`
      );

    }

    return result;

  } catch (
    error
  ) {

    state =
      failMemoryRun(
        state,
        runAt,
        error,
        {
          memoryWritten,
          stateWritten
        }
      );

    try {

      atomicWriteJSON(
        AI_MEMORY_STATE_PATH,
        state
      );

      stateWritten =
        true;

    } catch (
      stateWriteError
    ) {

      console.error(
        `[ai-memory] Unable to write failure state: ${stateWriteError.message}`
      );

    }

    const errorMessage =
      error instanceof Error
        ? error.message
        : toTrimmedString(
            error
          ) ||
          "Unknown AI Memory error.";

    console.error(
      `[ai-memory] FAILED: ${errorMessage}`
    );

    return createRunResult({
      status:
        "FAILED",

      runAt,

      memoryWritten,

      stateWritten,

      sourceSignals:
        getNestedValue(
          state,
          [
            "lastRun",
            "sourceSignals"
          ]
        ) || 0,

      normalizedTrades:
        0,

      canonicalTrades:
        getNestedValue(
          state,
          [
            "lastRun",
            "acceptedTrades"
          ]
        ) || 0,

      rejectedTrades:
        getNestedValue(
          state,
          [
            "lastRun",
            "rejectedTrades"
          ]
        ) || 0,

      newTradeKeys:
        getNestedValue(
          state,
          [
            "lastRun",
            "newTradeKeys"
          ]
        ) || 0,

      duplicateTradeKeys:
        getNestedValue(
          state,
          [
            "lastRun",
            "duplicateTradeKeys"
          ]
        ) || 0,

      enrichmentAvailable:
        false,

      warnings:
        [],

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
    runAIMemory();

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
  MEMORY_SCHEMA_VERSION,
  STATE_SCHEMA_VERSION,

  AUTONOMOUS_MEMORY_ENGINE_NAME,
  AUTONOMOUS_MEMORY_VERSION,
  AUTONOMOUS_MEMORY_SCHEMA_VERSION,
  AUTONOMOUS_MEMORY_CONFIG,
  AUTONOMOUS_SCOPE_DEFINITIONS,

  SUPPORTED_ENRICHMENT_SCHEMA_VERSION,
  SUPPORTED_ENRICHMENT_ENGINE_NAME,
  SUPPORTED_ENRICHMENT_ENGINE_VERSION,
  SUPPORTED_ENRICHMENT_MODE,

  paths: {
    data:
      DATA_DIR,

    learningData:
      LEARNING_DATA_PATH,

    confidenceData:
      CONFIDENCE_DATA_PATH,

    learningEnrichment:
      LEARNING_ENRICHMENT_PATH,

    learningEnrichmentState:
      LEARNING_ENRICHMENT_STATE_PATH,

    aiMemory:
      AI_MEMORY_PATH,

    aiMemoryState:
      AI_MEMORY_STATE_PATH
  },

  runAIMemory,

  buildMemoryDocument,
  normalizeLearningTrades,
  normalizeLearnedTrade,
  buildConfidenceOverlay,

  buildAutonomousMemory,
  validateAutonomousMemorySection,
  calculateTradeRealizedR,
  calculateRecencyWeight,
  calculateWilsonInterval95,

  buildEnrichmentMemory,
  loadOptionalLearningEnrichment,
  validateLearningEnrichmentDocument,

  validateMemoryDocument,
  validateLearningDocument,
  validateConfidenceDocument,

  normalizePair,
  normalizeEngine,
  normalizeDirection,
  normalizeOutcome,
  normalizeTimeframe,

  createTradeKey,
  createHash
};
