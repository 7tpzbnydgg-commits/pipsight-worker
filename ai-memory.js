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

const ENGINE_VERSION =
  "1.0.0";

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

  const durationMinutes =
    calculateDurationMinutes(
      openedAt,
      closedAt
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

  return {
    id:
      trade.id || null,

    pair:
      trade.pair || null,

    engine:
      trade.engine || null,

    direction:
      trade.direction || null,

    timeframe:
      trade.timeframe || null,

    outcome:
      trade.outcome || null,

    entry:
      trade.entry ?? null,

    stopLoss:
      trade.stopLoss ?? null,

    takeProfit:
      trade.takeProfit ?? null,

    closePrice:
      trade.closePrice ?? null,

    openedAt:
      trade.openedAt || null,

    closedAt:
      trade.closedAt || null
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

    if (
      seenTradeKeys.has(
        tradeKey
      )
    ) {

      duplicateTradeKeys +=
        1;

      continue;

    }

    seenTradeKeys.add(
      tradeKey
    );

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

  return {
    totalTrades,

    wins:
      normalizeNonNegativeInteger(
        accumulator.wins
      ),

    losses:
      normalizeNonNegativeInteger(
        accumulator.losses
      ),

    breakevens:
      normalizeNonNegativeInteger(
        accumulator.breakevens
      ),

    winRate:
      calculateRate(
        accumulator.wins,
        totalTrades
      ),

    lossRate:
      calculateRate(
        accumulator.losses,
        totalTrades
      ),

    breakevenRate:
      calculateRate(
        accumulator.breakevens,
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

  const total =
    normalizeNonNegativeInteger(
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
    normalizeNonNegativeInteger(
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
    normalizeNonNegativeInteger(
      value.wins
    );

  const losses =
    normalizeNonNegativeInteger(
      value.losses
    );

  const breakevens =
    normalizeNonNegativeInteger(
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

  for (
    const sourceKey of Object.keys(
      value
    )
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

  const rateTotal =
    (
      toFiniteNumber(
        stats.winRate
      ) || 0
    ) +
    (
      toFiniteNumber(
        stats.lossRate
      ) || 0
    ) +
    (
      toFiniteNumber(
        stats.breakevenRate
      ) || 0
    );

  if (
    totalTrades > 0 &&
    Math.abs(
      rateTotal -
      100
    ) > 0.1
  ) {

    warnings.push(
      `${label} outcome rates do not total approximately 100%.`
    );

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

function haveSourceModifiedTimesChanged(
  state,
  learningModifiedAt,
  confidenceModifiedAt,
  enrichmentModifiedAt
) {

  const previousLearningModifiedAt =
    getNestedValue(
      state,
      [
        "sourceModifiedAt",
        "learningData"
      ]
    ) || null;

  const previousConfidenceModifiedAt =
    getNestedValue(
      state,
      [
        "sourceModifiedAt",
        "confidenceData"
      ]
    ) || null;

  const previousEnrichmentModifiedAt =
    getNestedValue(
      state,
      [
        "sourceModifiedAt",
        "learningEnrichment"
      ]
    ) || null;

  return (
    previousLearningModifiedAt !==
      learningModifiedAt ||
    previousConfidenceModifiedAt !==
      confidenceModifiedAt ||
    previousEnrichmentModifiedAt !==
      enrichmentModifiedAt
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
  error
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

  let state =
    beginMemoryRun(
      previousStateDocument,
      runAt
    );

  let stateWritten =
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

    const sourceModifiedTimesChanged =
      haveSourceModifiedTimesChanged(
        state,
        learningModifiedAt,
        confidenceModifiedAt,
        enrichmentModifiedAt
      );

    const existingMemory =
      readExistingMemoryDocument();

    const mustWriteMemory =
      (
        sourceHashesChanged ||
        sourceModifiedTimesChanged ||
        !existingMemory.exists ||
        !existingMemory.valid
      );

    let memoryWritten =
      false;

    let status =
      "UNCHANGED";

    if (
      mustWriteMemory
    ) {

      atomicWriteJSON(
        AI_MEMORY_PATH,
        memoryDocument
      );

      memoryWritten =
        true;

      status =
        "UPDATED";

    }

    state =
      completeMemoryRun({
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
      });

    atomicWriteJSON(
      AI_MEMORY_STATE_PATH,
      state
    );

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
        error
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

      memoryWritten:
        false,

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
