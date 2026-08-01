"use strict";

/**
 * PipSight Pro — Learning Enrichment Engine
 *
 * Version: 1.0.0
 *
 * Phase 3A purpose:
 * - Read existing Automatic Learning outputs without modifying them.
 * - Build rolling-window, recency-weighted and calibration intelligence.
 * - Preserve all existing learner.js APIs and JSON schemas.
 * - Remain completely independent from live trading engines.
 *
 * Reads:
 *   data/learning-data.json
 *   data/confidence-data.json
 *
 * Writes:
 *   data/learning-enrichment.json
 *   data/learning-enrichment-state.json
 *
 * Safety:
 * - Does not modify learning-data.json.
 * - Does not modify confidence-data.json.
 * - Does not modify ai-memory.json.
 * - Does not change signals, confidence, direction or trade plans.
 * - Does not send Telegram notifications.
 * - Does not make external API requests.
 * - Missing or malformed source data causes a safe failed run.
 */

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

/* =====================================================================
   Engine Metadata
   ===================================================================== */

const ENGINE_NAME =
  "PipSight Pro Learning Enrichment Engine";

const ENGINE_VERSION =
  "1.0.0";

const ENRICHMENT_SCHEMA_VERSION =
  1;

const STATE_SCHEMA_VERSION =
  1;

const ENGINE_MODE =
  "advisory";

/* =====================================================================
   File Paths
   ===================================================================== */

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

const ENRICHMENT_OUTPUT_PATH =
  path.join(
    DATA_DIR,
    "learning-enrichment.json"
  );

const ENRICHMENT_STATE_PATH =
  path.join(
    DATA_DIR,
    "learning-enrichment-state.json"
  );

/* =====================================================================
   Verified Source Values
   ===================================================================== */

const SUPPORTED_PAIRS =
  Object.freeze([
    "XAUUSD",
    "GBPJPY"
  ]);

const SUPPORTED_STRATEGIES =
  Object.freeze([
    "scalp",
    "daily",
    "weekly"
  ]);

const SUPPORTED_TIMEFRAMES =
  Object.freeze([
    "5m",
    "15m",
    "30m",
    "1H",
    "4H",
    "D1"
  ]);

const SUPPORTED_DIRECTIONS =
  Object.freeze([
    "BUY",
    "SELL"
  ]);

const SUPPORTED_OUTCOMES =
  Object.freeze([
    "WIN",
    "LOSS",
    "BREAKEVEN"
  ]);

/* =====================================================================
   Enrichment Configuration
   ===================================================================== */

/*
 * Rolling windows are trade-count based.
 *
 * A window is emitted only when at least one valid trade is available.
 * The document clearly reports whether the complete requested window
 * was available.
 */
const ROLLING_WINDOWS =
  Object.freeze([
    20,
    50,
    100,
    200
  ]);

/*
 * Recency weighting uses deterministic exponential decay.
 *
 * Weight is based on trade order, not wall-clock execution time:
 *
 * newest trade:
 *   age index = 0
 *
 * older trade:
 *   age index increases by 1
 *
 * This avoids producing different results simply because the workflow
 * runs at a different clock time.
 */
const RECENCY_HALF_LIFE_TRADES =
  50;

/*
 * Confidence calibration buckets.
 *
 * Current production confidence is represented on a 0–100 scale.
 */
const CONFIDENCE_BUCKET_SIZE =
  5;

const MIN_CONFIDENCE =
  0;

const MAX_CONFIDENCE =
  100;

/*
 * Minimum samples required before a context is classified as stable,
 * improving or declining.
 *
 * Below this threshold the trend remains insufficient-data.
 */
const MIN_TREND_SAMPLE_SIZE =
  20;

/*
 * Two equally sized recent segments are compared for trend detection.
 */
const TREND_SEGMENT_SIZE =
  20;

/*
 * Difference thresholds are deliberately small but non-zero.
 * They are advisory only and never modify live behavior.
 */
const WIN_RATE_TREND_THRESHOLD =
  5;

const PROFIT_FACTOR_TREND_THRESHOLD =
  0.15;

/*
 * Output size and processing protections.
 */
const MAX_SOURCE_TRADES =
  100000;

const HASH_ALGORITHM =
  "sha256";

/* =====================================================================
   Safety Policy
   ===================================================================== */

const SAFETY_POLICY =
  Object.freeze({
    advisoryOnly:
      true,

    liveSignalModification:
      false,

    confidenceModification:
      false,

    decisionModification:
      false,

    tradePlanModification:
      false,

    telegramModification:
      false,

    sourceCodeModification:
      false,

    externalApiCalls:
      false,

    existingSchemaModification:
      false,

    existingLearningOutputModification:
      false,

    existingMemoryOutputModification:
      false
  });

/* =====================================================================
   Generic Type Helpers
   ===================================================================== */

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

function isFiniteNumber(
  value
) {

  return (
    typeof value ===
      "number" &&
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

function toNonNegativeInteger(
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

    return null;

  }

  return Math.floor(
    number
  );

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

  return text ||
    null;

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

/* =====================================================================
   Canonical Normalization
   ===================================================================== */

function normalizePair(
  value
) {

  const normalized =
    toTrimmedString(
      value
    )
      .toUpperCase()
      .replace(
        /[^A-Z0-9]/g,
        ""
      );

  if (
    normalized ===
      "GOLD"
  ) {

    return "XAUUSD";

  }

  return SUPPORTED_PAIRS.includes(
    normalized
  )
    ? normalized
    : null;

}

function normalizeStrategy(
  value
) {

  const normalized =
    toTrimmedString(
      value
    ).toLowerCase();

  return SUPPORTED_STRATEGIES.includes(
    normalized
  )
    ? normalized
    : null;

}

function normalizeDirection(
  value
) {

  const normalized =
    toTrimmedString(
      value
    ).toUpperCase();

  if (
    normalized ===
      "LONG" ||
    normalized ===
      "BULLISH"
  ) {

    return "BUY";

  }

  if (
    normalized ===
      "SHORT" ||
    normalized ===
      "BEARISH"
  ) {

    return "SELL";

  }

  return SUPPORTED_DIRECTIONS.includes(
    normalized
  )
    ? normalized
    : null;

}

function normalizeOutcome(
  value
) {

  const normalized =
    toTrimmedString(
      value
    )
      .toUpperCase()
      .replace(
        /[\s_-]+/g,
        ""
      );

  if (
    normalized ===
      "WIN"
  ) {

    return "WIN";

  }

  if (
    normalized ===
      "LOSS"
  ) {

    return "LOSS";

  }

  if (
    normalized ===
      "BREAKEVEN" ||
    normalized ===
      "BE"
  ) {

    return "BREAKEVEN";

  }

  return null;

}

function normalizeTimeframe(
  value
) {

  const text =
    toTrimmedString(
      value
    );

  const normalized =
    text.toUpperCase();

  const mapping =
    Object.freeze({
      "5M":
        "5m",

      "M5":
        "5m",

      "15M":
        "15m",

      "M15":
        "15m",

      "30M":
        "30m",

      "M30":
        "30m",

      "1H":
        "1H",

      "H1":
        "1H",

      "4H":
        "4H",

      "H4":
        "4H",

      "D1":
        "D1",

      "1D":
        "D1"
    });

  const mapped =
    mapping[normalized] ||
    null;

  return SUPPORTED_TIMEFRAMES.includes(
    mapped
  )
    ? mapped
    : null;

}

/* =====================================================================
   File-System Helpers
   ===================================================================== */

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

function readJSONFile(
  filePath,
  fallbackValue = null
) {

  try {

    if (
      !fs.existsSync(
        filePath
      )
    ) {

      return {
        ok: false,
        exists: false,
        value:
          cloneJSONCompatible(
            fallbackValue
          ),
        error:
          `File does not exist: ${path.relative(
            ROOT_DIR,
            filePath
          )}`
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

      return {
        ok: false,
        exists: true,
        value:
          cloneJSONCompatible(
            fallbackValue
          ),
        error:
          `File is empty: ${path.relative(
            ROOT_DIR,
            filePath
          )}`
      };

    }

    return {
      ok: true,
      exists: true,
      value:
        JSON.parse(
          raw
        ),
      error: null
    };

  } catch (
    error
  ) {

    return {
      ok: false,
      exists:
        fs.existsSync(
          filePath
        ),
      value:
        cloneJSONCompatible(
          fallbackValue
        ),
      error:
        `Unable to read ${path.relative(
          ROOT_DIR,
          filePath
        )}: ${
          error instanceof Error
            ? error.message
            : String(
                error
              )
        }`
    };

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

    if (
      fs.existsSync(
        temporaryPath
      )
    ) {

      try {

        fs.unlinkSync(
          temporaryPath
        );

      } catch (
        cleanupError
      ) {

        console.warn(
          "[learning-enrichment] Unable to remove temporary file:",
          cleanupError instanceof Error
            ? cleanupError.message
            : String(
                cleanupError
              )
        );

      }

    }

    throw error;

  }

}

/* =====================================================================
   Stable Serialization and Hashing
   ===================================================================== */

function sortForStableSerialization(
  value
) {

  if (
    Array.isArray(
      value
    )
  ) {

    return value.map(
      item =>
        sortForStableSerialization(
          item
        )
    );

  }

  if (
    isPlainObject(
      value
    )
  ) {

    const sorted =
      {};

    for (
      const key of Object.keys(
        value
      ).sort()
    ) {

      sorted[key] =
        sortForStableSerialization(
          value[key]
        );

    }

    return sorted;

  }

  return value;

}

function stableStringify(
  value
) {

  return JSON.stringify(
    sortForStableSerialization(
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

  try {

    return crypto
      .createHash(
        HASH_ALGORITHM
      )
      .update(
        fs.readFileSync(
          filePath
        )
      )
      .digest(
        "hex"
      );

  } catch (
    error
  ) {

    console.warn(
      `[learning-enrichment] Unable to hash ${path.relative(
        ROOT_DIR,
        filePath
      )}: ${
        error instanceof Error
          ? error.message
          : String(
              error
            )
      }`
    );

    return null;

  }

}

/* =====================================================================
   Learning Source Document Validation
   ===================================================================== */

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

  /*
   * Safe legacy fallback:
   * only accept the document itself when it contains a signals array.
   */
  if (
    Array.isArray(
      document.signals
    )
  ) {

    return document;

  }

  return null;

}

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

  /*
   * Safe legacy fallback:
   * accept the document itself only when it resembles the known
   * confidence export structure.
   */
  if (
    isPlainObject(
      document.strategies
    ) ||
    isPlainObject(
      document.pairs
    ) ||
    isPlainObject(
      document.timeframes
    ) ||
    isPlainObject(
      document.overall
    )
  ) {

    return document;

  }

  return null;

}

function validateLearningSourceDocument(
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

    return {
      valid: false,
      learningRoot: null,
      errors: [
        "Learning source document must be a JSON object."
      ],
      warnings
    };

  }

  if (
    document.version !==
      undefined &&
    document.version !==
      1
  ) {

    warnings.push(
      "Learning source document version is not the currently verified version 1."
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
      "Learning source does not contain a valid learning object."
    );

    return {
      valid: false,
      learningRoot: null,
      errors:
        uniqueSortedStrings(
          errors
        ),
      warnings:
        uniqueSortedStrings(
          warnings
        )
    };

  }

  if (
    !Array.isArray(
      learningRoot.signals
    )
  ) {

    errors.push(
      "Learning source learning.signals must be an array."
    );

  }

  if (
    Array.isArray(
      learningRoot.signals
    ) &&
    learningRoot.signals.length >
      MAX_SOURCE_TRADES
  ) {

    errors.push(
      `Learning source exceeds the maximum supported record count of ${MAX_SOURCE_TRADES}.`
    );

  }

  if (
    learningRoot.outcomes !==
      undefined &&
    !Array.isArray(
      learningRoot.outcomes
    )
  ) {

    errors.push(
      "Learning source learning.outcomes must be an array when present."
    );

  }

  if (
    learningRoot.stats !==
      undefined &&
    !isPlainObject(
      learningRoot.stats
    )
  ) {

    warnings.push(
      "Learning source learning.stats is malformed and will not be used."
    );

  }

  if (
    learningRoot.metadata !==
      undefined &&
    !isPlainObject(
      learningRoot.metadata
    )
  ) {

    warnings.push(
      "Learning source learning.metadata is malformed and will not be used."
    );

  }

  if (
    learningRoot.updatedAt !==
      undefined &&
    learningRoot.updatedAt !==
      null &&
    !toISOStringOrNull(
      learningRoot.updatedAt
    )
  ) {

    warnings.push(
      "Learning source learning.updatedAt is invalid."
    );

  }

  return {
    valid:
      errors.length ===
      0,

    learningRoot:
      errors.length ===
        0
        ? learningRoot
        : null,

    errors:
      uniqueSortedStrings(
        errors
      ),

    warnings:
      uniqueSortedStrings(
        warnings
      )
  };

}

function validateConfidenceSourceDocument(
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

    return {
      valid: false,
      confidenceRoot: null,
      errors: [
        "Confidence source document must be a JSON object."
      ],
      warnings
    };

  }

  if (
    document.version !==
      undefined &&
    document.version !==
      1
  ) {

    warnings.push(
      "Confidence source document version is not the currently verified version 1."
    );

  }

  const confidenceRoot =
    extractConfidenceRoot(
      document
    );

  if (
    !confidenceRoot
  ) {

    errors.push(
      "Confidence source does not contain a valid confidence object."
    );

  }

  const optionalSections =
    [
      "strategies",
      "pairs",
      "timeframes",
      "indicators"
    ];

  if (
    confidenceRoot
  ) {

    for (
      const section of
      optionalSections
    ) {

      if (
        confidenceRoot[section] !==
          undefined &&
        !isPlainObject(
          confidenceRoot[section]
        )
      ) {

        warnings.push(
          `Confidence source confidence.${section} is malformed and will not be used.`
        );

      }

    }

    if (
      confidenceRoot.overall !==
        undefined &&
      confidenceRoot.overall !==
        null &&
      !isPlainObject(
        confidenceRoot.overall
      )
    ) {

      warnings.push(
        "Confidence source confidence.overall is malformed and will not be used."
      );

    }

  }

  return {
    valid:
      errors.length ===
      0,

    confidenceRoot:
      errors.length ===
        0
        ? confidenceRoot
        : null,

    errors:
      uniqueSortedStrings(
        errors
      ),

    warnings:
      uniqueSortedStrings(
        warnings
      )
  };

}

/* =====================================================================
   Trade Identity and Duration Helpers
   ===================================================================== */

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
    normalizedOpenedAt ===
      null ||
    normalizedClosedAt ===
      null
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
    closedTime <
      openedTime
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

function createNormalizedTradeKey(
  trade
) {

  if (
    !isPlainObject(
      trade
    )
  ) {

    return null;

  }

  const identity = {
    pair:
      trade.pair,

    strategy:
      trade.strategy,

    timeframe:
      trade.timeframe,

    direction:
      trade.direction,

    outcome:
      trade.outcome,

    entry:
      trade.entry,

    stopLoss:
      trade.stopLoss,

    takeProfit:
      trade.takeProfit,

    openedAt:
      trade.openedAt,

    closedAt:
      trade.closedAt
  };

  return createHash(
    identity
  );

}

/* =====================================================================
   Learning Trade Normalization
   ===================================================================== */

function normalizeLearningTrade(
  source,
  sourceIndex
) {

  const errors =
    [];

  const warnings =
    [];

  const label =
    `learning.signals[${sourceIndex}]`;

  if (
    !isPlainObject(
      source
    )
  ) {

    return {
      valid: false,
      trade: null,
      errors: [
        `${label} must be a JSON object.`
      ],
      warnings
    };

  }

  const pair =
    normalizePair(
      source.pair ??
      source.symbol ??
      source.pairLabel
    );

  const strategy =
    normalizeStrategy(
      source.strategy ??
      source.engine
    );

  const timeframe =
    normalizeTimeframe(
      source.timeframe ??
      source.tf ??
      source.mode
    );

  const direction =
    normalizeDirection(
      source.direction ??
      source.signal ??
      source.decision ??
      source.action
    );

  const outcome =
    normalizeOutcome(
      source.outcome ??
      source.result
    );

  const entry =
    toFiniteNumber(
      source.entry ??
      source.entryPrice ??
      source.price
    );

  const stopLoss =
    toFiniteNumber(
      source.stopLoss ??
      source.stop ??
      source.sl
    );

  const takeProfit =
    toFiniteNumber(
      source.takeProfit ??
      source.target ??
      source.target1 ??
      source.tp ??
      source.tp1
    );

  const closePrice =
    toFiniteNumber(
      source.closePrice ??
      source.exitPrice ??
      source.resolvedPrice
    );

  const profitPoints =
    toFiniteNumber(
      source.profitPoints ??
      source.profit ??
      source.pnlPoints
    );

  const resultPercentage =
    toFiniteNumber(
      source.resultPercentage ??
      source.profitPercentage ??
      source.returnPercentage
    );

  const confidence =
    clamp(
      source.confidence ??
      source.finalAIConfidence ??
      source.legacyConfidence,
      MIN_CONFIDENCE,
      MAX_CONFIDENCE
    );

  const openedAt =
    toISOStringOrNull(
      source.openedAt ??
      source.timestamp ??
      source.createdAt
    );

  const closedAt =
    toISOStringOrNull(
      source.closedAt ??
      source.resolvedAt ??
      source.completedAt
    );

  const resolvedAt =
    toISOStringOrNull(
      source.resolvedAt ??
      source.closedAt ??
      source.completedAt
    );

  if (
    pair ===
      null
  ) {

    errors.push(
      `${label}.pair is unsupported or missing.`
    );

  }

  if (
    strategy ===
      null
  ) {

    errors.push(
      `${label}.strategy is unsupported or missing.`
    );

  }

  if (
    timeframe ===
      null
  ) {

    errors.push(
      `${label}.timeframe is unsupported or missing.`
    );

  }

  if (
    direction ===
      null
  ) {

    errors.push(
      `${label}.direction is unsupported or missing.`
    );

  }

  if (
    outcome ===
      null
  ) {

    errors.push(
      `${label}.outcome is unsupported or missing.`
    );

  }

  if (
    entry ===
      null
  ) {

    errors.push(
      `${label}.entry is invalid or missing.`
    );

  }

  if (
    openedAt ===
      null
  ) {

    errors.push(
      `${label}.openedAt/timestamp is invalid or missing.`
    );

  }

  if (
    closedAt ===
      null
  ) {

    errors.push(
      `${label}.closedAt/resolvedAt is invalid or missing.`
    );

  }

  if (
    openedAt !==
      null &&
    closedAt !==
      null &&
    new Date(
      closedAt
    ).getTime() <
      new Date(
        openedAt
      ).getTime()
  ) {

    errors.push(
      `${label}.closedAt occurs before openedAt.`
    );

  }

  if (
    profitPoints ===
      null
  ) {

    warnings.push(
      `${label}.profitPoints is unavailable.`
    );

  }

  if (
    resultPercentage ===
      null
  ) {

    warnings.push(
      `${label}.resultPercentage is unavailable.`
    );

  }

  if (
    confidence ===
      null
  ) {

    warnings.push(
      `${label}.confidence is unavailable.`
    );

  }

  if (
    stopLoss ===
      null
  ) {

    warnings.push(
      `${label}.stopLoss is unavailable.`
    );

  }

  if (
    takeProfit ===
      null
  ) {

    warnings.push(
      `${label}.takeProfit is unavailable.`
    );

  }

  if (
    errors.length >
      0
  ) {

    return {
      valid: false,
      trade: null,

      errors:
        uniqueSortedStrings(
          errors
        ),

      warnings:
        uniqueSortedStrings(
          warnings
        )
    };

  }

  const durationMinutes =
    calculateDurationMinutes(
      openedAt,
      closedAt
    );

  const normalizedTrade = {
    sourceIndex,

    sourceId:
      toNonEmptyStringOrNull(
        source.id
      ),

    pair,

    strategy,

    timeframe,

    direction,

    outcome,

    entry:
      round(
        entry,
        8
      ),

    stopLoss:
      stopLoss ===
        null
        ? null
        : round(
            stopLoss,
            8
          ),

    takeProfit:
      takeProfit ===
        null
        ? null
        : round(
            takeProfit,
            8
          ),

    closePrice:
      closePrice ===
        null
        ? null
        : round(
            closePrice,
            8
          ),

    profitPoints:
      profitPoints ===
        null
        ? null
        : round(
            profitPoints,
            8
          ),

    resultPercentage:
      resultPercentage ===
        null
        ? null
        : round(
            resultPercentage,
            8
          ),

    confidence:
      confidence ===
        null
        ? null
        : round(
            confidence,
            4
          ),

    openedAt,

    closedAt,

    resolvedAt,

    durationMinutes,

    status:
      toNonEmptyStringOrNull(
        source.status
      ),

    metadata: {
      indicators:
        Array.isArray(
          source.indicators
        )
          ? cloneJSONCompatible(
              source.indicators
            )
          : [],

      legacyConfidence:
        toFiniteNumber(
          source.legacyConfidence
        ),

      sourceTimestamp:
        toISOStringOrNull(
          source.timestamp
        )
    }
  };

  normalizedTrade.tradeKey =
    createNormalizedTradeKey(
      normalizedTrade
    );

  if (
    !normalizedTrade.tradeKey
  ) {

    return {
      valid: false,
      trade: null,
      errors: [
        `${label} trade identity could not be generated.`
      ],
      warnings:
        uniqueSortedStrings(
          warnings
        )
    };

  }

  return {
    valid: true,

    trade:
      normalizedTrade,

    errors: [],

    warnings:
      uniqueSortedStrings(
        warnings
      )
  };

}

/* =====================================================================
   Duplicate-Safe Trade Collection
   ===================================================================== */

function normalizeLearningTrades(
  learningRoot
) {

  const errors =
    [];

  const warnings =
    [];

  const rejected =
    [];

  const duplicates =
    [];

  const accepted =
    [];

  if (
    !isPlainObject(
      learningRoot
    ) ||
    !Array.isArray(
      learningRoot.signals
    )
  ) {

    return {
      valid: false,
      trades: [],
      acceptedCount: 0,
      rejectedCount: 0,
      duplicateCount: 0,
      rejected,
      duplicates,
      errors: [
        "A valid learning.signals array is required."
      ],
      warnings
    };

  }

  if (
    learningRoot.signals.length >
      MAX_SOURCE_TRADES
  ) {

    return {
      valid: false,
      trades: [],
      acceptedCount: 0,
      rejectedCount:
        learningRoot.signals.length,
      duplicateCount: 0,
      rejected,
      duplicates,
      errors: [
        `Learning source exceeds maximum record limit ${MAX_SOURCE_TRADES}.`
      ],
      warnings
    };

  }

  const seenTradeKeys =
    new Set();

  for (
    let sourceIndex = 0;
    sourceIndex <
      learningRoot.signals.length;
    sourceIndex++
  ) {

    const result =
      normalizeLearningTrade(
        learningRoot.signals[
          sourceIndex
        ],
        sourceIndex
      );

    warnings.push(
      ...result.warnings
    );

    if (
      !result.valid ||
      !result.trade
    ) {

      rejected.push({
        sourceIndex,

        errors:
          cloneJSONCompatible(
            result.errors
          )
      });

      continue;

    }

    if (
      seenTradeKeys.has(
        result.trade.tradeKey
      )
    ) {

      duplicates.push({
        sourceIndex,

        tradeKey:
          result.trade.tradeKey,

        sourceId:
          result.trade.sourceId
      });

      continue;

    }

    seenTradeKeys.add(
      result.trade.tradeKey
    );

    accepted.push(
      result.trade
    );

  }

  /*
   * Oldest-to-newest deterministic ordering.
   *
   * Closed time is the primary ordering source because enrichment is
   * outcome-based. Opened time and tradeKey provide stable tie-breakers.
   */
  accepted.sort(
    (
      left,
      right
    ) => {

      const closedDifference =
        new Date(
          left.closedAt
        ).getTime() -
        new Date(
          right.closedAt
        ).getTime();

      if (
        closedDifference !==
          0
      ) {

        return closedDifference;

      }

      const openedDifference =
        new Date(
          left.openedAt
        ).getTime() -
        new Date(
          right.openedAt
        ).getTime();

      if (
        openedDifference !==
          0
      ) {

        return openedDifference;

      }

      return left.tradeKey.localeCompare(
        right.tradeKey
      );

    }
  );

  return {
    valid:
      errors.length ===
      0,

    trades:
      accepted,

    acceptedCount:
      accepted.length,

    rejectedCount:
      rejected.length,

    duplicateCount:
      duplicates.length,

    rejected,

    duplicates,

    errors:
      uniqueSortedStrings(
        errors
      ),

    warnings:
      uniqueSortedStrings(
        warnings
      )
  };

}

/* =====================================================================
   Confidence Metric Normalization
   ===================================================================== */

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

  const total =
    toNonNegativeInteger(
      value.total ??
      value.totalSignals
    );

  const resolved =
    toNonNegativeInteger(
      value.resolved ??
      value.resolvedSignals ??
      value.total
    );

  const pending =
    toNonNegativeInteger(
      value.pending
    );

  const wins =
    toNonNegativeInteger(
      value.wins
    );

  const losses =
    toNonNegativeInteger(
      value.losses
    );

  const breakevens =
    toNonNegativeInteger(
      value.breakevens
    );

  const winRate =
    toFiniteNumber(
      value.winRate
    );

  const lossRate =
    toFiniteNumber(
      value.lossRate
    );

  const breakevenRate =
    toFiniteNumber(
      value.breakevenRate
    );

  const totalProfitPoints =
    toFiniteNumber(
      value.totalProfitPoints
    );

  const averageProfitPoints =
    toFiniteNumber(
      value.avgProfitPoints ??
      value.averageProfitPoints
    );

  const grossProfitPoints =
    toFiniteNumber(
      value.grossProfitPoints
    );

  const grossLossPoints =
    toFiniteNumber(
      value.grossLossPoints
    );

  const profitFactor =
    toFiniteNumber(
      value.profitFactor
    );

  const confidence =
    clamp(
      value.confidence ??
      value.score ??
      value.value,
      MIN_CONFIDENCE,
      MAX_CONFIDENCE
    );

  return {
    total,

    resolved,

    pending,

    wins,

    losses,

    breakevens,

    winRate:
      winRate ===
        null
        ? null
        : round(
            winRate,
            4
          ),

    lossRate:
      lossRate ===
        null
        ? null
        : round(
            lossRate,
            4
          ),

    breakevenRate:
      breakevenRate ===
        null
        ? null
        : round(
            breakevenRate,
            4
          ),

    totalProfitPoints:
      totalProfitPoints ===
        null
        ? null
        : round(
            totalProfitPoints,
            8
          ),

    averageProfitPoints:
      averageProfitPoints ===
        null
        ? null
        : round(
            averageProfitPoints,
            8
          ),

    grossProfitPoints:
      grossProfitPoints ===
        null
        ? null
        : round(
            grossProfitPoints,
            8
          ),

    grossLossPoints:
      grossLossPoints ===
        null
        ? null
        : round(
            grossLossPoints,
            8
          ),

    profitFactor:
      profitFactor ===
        null
        ? null
        : round(
            profitFactor,
            4
          ),

    confidence:
      confidence ===
        null
        ? null
        : round(
            confidence,
            4
          )
  };

}

function normalizeConfidenceMap(
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

  const result =
    {};

  for (
    const sourceKey of Object.keys(
      value
    ).sort()
  ) {

    const normalizedKey =
      typeof keyNormalizer ===
        "function"
        ? keyNormalizer(
            sourceKey
          )
        : toNonEmptyStringOrNull(
            sourceKey
          );

    if (
      !normalizedKey
    ) {

      continue;

    }

    const metric =
      normalizeConfidenceMetric(
        value[sourceKey]
      );

    if (
      metric
    ) {

      result[normalizedKey] =
        metric;

    }

  }

  return result;

}

function normalizeConfidenceSnapshot(
  confidenceRoot
) {

  if (
    !isPlainObject(
      confidenceRoot
    )
  ) {

    return {
      strategies: {},
      pairs: {},
      timeframes: {},
      indicators: {},
      overall: null
    };

  }

  return {
    strategies:
      normalizeConfidenceMap(
        confidenceRoot.strategies,
        normalizeStrategy
      ),

    pairs:
      normalizeConfidenceMap(
        confidenceRoot.pairs,
        normalizePair
      ),

    timeframes:
      normalizeConfidenceMap(
        confidenceRoot.timeframes,
        normalizeTimeframe
      ),

    indicators:
      normalizeConfidenceMap(
        confidenceRoot.indicators
      ),

    overall:
      normalizeConfidenceMetric(
        confidenceRoot.overall
      )
  };

}

/* =====================================================================
   Source Bundle Loading
   ===================================================================== */

function loadEnrichmentSources() {

  const errors =
    [];

  const warnings =
    [];

  const learningRead =
    readJSONFile(
      LEARNING_DATA_PATH,
      null
    );

  const confidenceRead =
    readJSONFile(
      CONFIDENCE_DATA_PATH,
      null
    );

  if (
    !learningRead.ok
  ) {

    errors.push(
      learningRead.error ||
      "Unable to read learning-data.json."
    );

  }

  if (
    !confidenceRead.ok
  ) {

    errors.push(
      confidenceRead.error ||
      "Unable to read confidence-data.json."
    );

  }

  if (
    errors.length >
      0
  ) {

    return {
      valid: false,
      trades: [],
      confidence: null,
      learningDocument: null,
      confidenceDocument: null,
      sourceHashes: {
        learningData:
          null,

        confidenceData:
          null
      },
      sourceUpdatedAt: {
        learningData:
          null,

        confidenceData:
          null
      },
      counts: {
        sourceTrades:
          0,

        acceptedTrades:
          0,

        rejectedTrades:
          0,

        duplicateTrades:
          0
      },
      rejected: [],
      duplicates: [],
      errors:
        uniqueSortedStrings(
          errors
        ),
      warnings:
        uniqueSortedStrings(
          warnings
        )
    };

  }

  const learningValidation =
    validateLearningSourceDocument(
      learningRead.value
    );

  const confidenceValidation =
    validateConfidenceSourceDocument(
      confidenceRead.value
    );

  errors.push(
    ...learningValidation.errors,
    ...confidenceValidation.errors
  );

  warnings.push(
    ...learningValidation.warnings,
    ...confidenceValidation.warnings
  );

  if (
    errors.length >
      0
  ) {

    return {
      valid: false,
      trades: [],
      confidence: null,
      learningDocument:
        learningRead.value,
      confidenceDocument:
        confidenceRead.value,
      sourceHashes: {
        learningData:
          createFileContentHash(
            LEARNING_DATA_PATH
          ),

        confidenceData:
          createFileContentHash(
            CONFIDENCE_DATA_PATH
          )
      },
      sourceUpdatedAt: {
        learningData:
          null,

        confidenceData:
          null
      },
      counts: {
        sourceTrades:
          0,

        acceptedTrades:
          0,

        rejectedTrades:
          0,

        duplicateTrades:
          0
      },
      rejected: [],
      duplicates: [],
      errors:
        uniqueSortedStrings(
          errors
        ),
      warnings:
        uniqueSortedStrings(
          warnings
        )
    };

  }

  const normalizedTrades =
    normalizeLearningTrades(
      learningValidation.learningRoot
    );

  errors.push(
    ...normalizedTrades.errors
  );

  warnings.push(
    ...normalizedTrades.warnings
  );

  const learningHash =
    createFileContentHash(
      LEARNING_DATA_PATH
    );

  const confidenceHash =
    createFileContentHash(
      CONFIDENCE_DATA_PATH
    );

  if (
    learningHash ===
      null
  ) {

    errors.push(
      "Unable to hash learning-data.json."
    );

  }

  if (
    confidenceHash ===
      null
  ) {

    errors.push(
      "Unable to hash confidence-data.json."
    );

  }

  const learningUpdatedAt =
    toISOStringOrNull(
      learningValidation
        .learningRoot
        ?.updatedAt ??
      learningRead.value?.exportedAt
    );

  const confidenceUpdatedAt =
    toISOStringOrNull(
      confidenceRead.value?.updatedAt ??
      confidenceRead.value?.exportedAt
    );

  return {
    valid:
      errors.length ===
      0,

    trades:
      errors.length ===
        0
        ? normalizedTrades.trades
        : [],

    confidence:
      errors.length ===
        0
        ? normalizeConfidenceSnapshot(
            confidenceValidation
              .confidenceRoot
          )
        : null,

    learningDocument:
      learningRead.value,

    confidenceDocument:
      confidenceRead.value,

    sourceHashes: {
      learningData:
        learningHash,

      confidenceData:
        confidenceHash
    },

    sourceUpdatedAt: {
      learningData:
        learningUpdatedAt,

      confidenceData:
        confidenceUpdatedAt
    },

    counts: {
      sourceTrades:
        Array.isArray(
          learningValidation
            .learningRoot
            ?.signals
        )
          ? learningValidation
              .learningRoot
              .signals
              .length
          : 0,

      acceptedTrades:
        normalizedTrades
          .acceptedCount,

      rejectedTrades:
        normalizedTrades
          .rejectedCount,

      duplicateTrades:
        normalizedTrades
          .duplicateCount
    },

    rejected:
      cloneJSONCompatible(
        normalizedTrades.rejected
      ),

    duplicates:
      cloneJSONCompatible(
        normalizedTrades.duplicates
      ),

    errors:
      uniqueSortedStrings(
        errors
      ),

    warnings:
      uniqueSortedStrings(
        warnings
      )
  };

}

/* =====================================================================
   Performance Accumulator
   ===================================================================== */

function createPerformanceAccumulator() {

  return {
    totalTrades:
      0,

    wins:
      0,

    losses:
      0,

    breakevens:
      0,

    totalProfitPoints:
      0,

    grossProfitPoints:
      0,

    grossLossPoints:
      0,

    profitPointSamples:
      0,

    totalResultPercentage:
      0,

    resultPercentageSamples:
      0,

    totalDurationMinutes:
      0,

    durationSamples:
      0,

    totalConfidence:
      0,

    confidenceSamples:
      0,

    confidenceMinimum:
      null,

    confidenceMaximum:
      null,

    firstTradeAt:
      null,

    lastTradeAt:
      null
  };

}

function addTradeToPerformanceAccumulator(
  accumulator,
  trade
) {

  if (
    !isPlainObject(
      accumulator
    ) ||
    !isPlainObject(
      trade
    )
  ) {

    return false;

  }

  accumulator.totalTrades +=
    1;

  if (
    trade.outcome ===
      "WIN"
  ) {

    accumulator.wins +=
      1;

  } else if (
    trade.outcome ===
      "LOSS"
  ) {

    accumulator.losses +=
      1;

  } else if (
    trade.outcome ===
      "BREAKEVEN"
  ) {

    accumulator.breakevens +=
      1;

  }

  if (
    isFiniteNumber(
      trade.profitPoints
    )
  ) {

    accumulator
      .totalProfitPoints +=
        trade.profitPoints;

    accumulator
      .profitPointSamples +=
        1;

    if (
      trade.profitPoints >
        0
    ) {

      accumulator
        .grossProfitPoints +=
          trade.profitPoints;

    } else if (
      trade.profitPoints <
        0
    ) {

      accumulator
        .grossLossPoints +=
          Math.abs(
            trade.profitPoints
          );

    }

  }

  if (
    isFiniteNumber(
      trade.resultPercentage
    )
  ) {

    accumulator
      .totalResultPercentage +=
        trade.resultPercentage;

    accumulator
      .resultPercentageSamples +=
        1;

  }

  if (
    isFiniteNumber(
      trade.durationMinutes
    )
  ) {

    accumulator
      .totalDurationMinutes +=
        trade.durationMinutes;

    accumulator
      .durationSamples +=
        1;

  }

  if (
    isFiniteNumber(
      trade.confidence
    )
  ) {

    accumulator
      .totalConfidence +=
        trade.confidence;

    accumulator
      .confidenceSamples +=
        1;

    accumulator.confidenceMinimum =
      accumulator.confidenceMinimum ===
        null
        ? trade.confidence
        : Math.min(
            accumulator.confidenceMinimum,
            trade.confidence
          );

    accumulator.confidenceMaximum =
      accumulator.confidenceMaximum ===
        null
        ? trade.confidence
        : Math.max(
            accumulator.confidenceMaximum,
            trade.confidence
          );

  }

  const tradeTime =
    trade.closedAt ||
    trade.resolvedAt ||
    trade.openedAt ||
    null;

  if (
    tradeTime
  ) {

    if (
      accumulator.firstTradeAt ===
        null ||
      new Date(
        tradeTime
      ).getTime() <
        new Date(
          accumulator.firstTradeAt
        ).getTime()
    ) {

      accumulator.firstTradeAt =
        tradeTime;

    }

    if (
      accumulator.lastTradeAt ===
        null ||
      new Date(
        tradeTime
      ).getTime() >
        new Date(
          accumulator.lastTradeAt
        ).getTime()
    ) {

      accumulator.lastTradeAt =
        tradeTime;

    }

  }

  return true;

}

/* =====================================================================
   Performance Metric Finalization
   ===================================================================== */

function calculateRate(
  count,
  total
) {

  const normalizedCount =
    toFiniteNumber(
      count
    );

  const normalizedTotal =
    toFiniteNumber(
      total
    );

  if (
    normalizedCount ===
      null ||
    normalizedTotal ===
      null ||
    normalizedTotal <=
      0
  ) {

    return 0;

  }

  return round(
    (
      normalizedCount /
      normalizedTotal
    ) *
      100,
    4
  );

}

function calculateProfitFactor(
  grossProfitPoints,
  grossLossPoints
) {

  const grossProfit =
    toFiniteNumber(
      grossProfitPoints
    );

  const grossLoss =
    toFiniteNumber(
      grossLossPoints
    );

  if (
    grossProfit ===
      null ||
    grossLoss ===
      null
  ) {

    return null;

  }

  if (
    grossLoss ===
      0
  ) {

    if (
      grossProfit >
        0
    ) {

      return null;

    }

    return 0;

  }

  return round(
    grossProfit /
      grossLoss,
    4
  );

}

function finalizePerformanceAccumulator(
  accumulator
) {

  if (
    !isPlainObject(
      accumulator
    )
  ) {

    return null;

  }

  const totalTrades =
    toNonNegativeInteger(
      accumulator.totalTrades
    ) ?? 0;

  const profitPointSamples =
    toNonNegativeInteger(
      accumulator.profitPointSamples
    ) ?? 0;

  const resultPercentageSamples =
    toNonNegativeInteger(
      accumulator.resultPercentageSamples
    ) ?? 0;

  const durationSamples =
    toNonNegativeInteger(
      accumulator.durationSamples
    ) ?? 0;

  const confidenceSamples =
    toNonNegativeInteger(
      accumulator.confidenceSamples
    ) ?? 0;

  const totalProfitPoints =
    round(
      accumulator.totalProfitPoints,
      8
    ) ?? 0;

  const grossProfitPoints =
    round(
      accumulator.grossProfitPoints,
      8
    ) ?? 0;

  const grossLossPoints =
    round(
      accumulator.grossLossPoints,
      8
    ) ?? 0;

  const totalResultPercentage =
    round(
      accumulator.totalResultPercentage,
      8
    ) ?? 0;

  const totalDurationMinutes =
    round(
      accumulator.totalDurationMinutes,
      4
    ) ?? 0;

  const totalConfidence =
    round(
      accumulator.totalConfidence,
      4
    ) ?? 0;

  return {
    totalTrades,

    wins:
      accumulator.wins,

    losses:
      accumulator.losses,

    breakevens:
      accumulator.breakevens,

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

    profitPoints: {
      samples:
        profitPointSamples,

      total:
        totalProfitPoints,

      average:
        profitPointSamples >
          0
          ? round(
              totalProfitPoints /
                profitPointSamples,
              8
            )
          : null,

      grossProfit:
        grossProfitPoints,

      grossLoss:
        grossLossPoints,

      profitFactor:
        calculateProfitFactor(
          grossProfitPoints,
          grossLossPoints
        )
    },

    resultPercentage: {
      samples:
        resultPercentageSamples,

      total:
        totalResultPercentage,

      average:
        resultPercentageSamples >
          0
          ? round(
              totalResultPercentage /
                resultPercentageSamples,
              8
            )
          : null
    },

    durationMinutes: {
      samples:
        durationSamples,

      total:
        totalDurationMinutes,

      average:
        durationSamples >
          0
          ? round(
              totalDurationMinutes /
                durationSamples,
              4
            )
          : null
    },

    confidence: {
      samples:
        confidenceSamples,

      total:
        totalConfidence,

      average:
        confidenceSamples >
          0
          ? round(
              totalConfidence /
                confidenceSamples,
              4
            )
          : null,

      minimum:
        confidenceSamples >
          0
          ? round(
              accumulator.confidenceMinimum,
              4
            )
          : null,

      maximum:
        confidenceSamples >
          0
          ? round(
              accumulator.confidenceMaximum,
              4
            )
          : null
    },

    firstTradeAt:
      accumulator.firstTradeAt,

    lastTradeAt:
      accumulator.lastTradeAt
  };

}

function calculatePerformanceMetrics(
  trades
) {

  const accumulator =
    createPerformanceAccumulator();

  if (
    !Array.isArray(
      trades
    )
  ) {

    return finalizePerformanceAccumulator(
      accumulator
    );

  }

  for (
    const trade of
    trades
  ) {

    addTradeToPerformanceAccumulator(
      accumulator,
      trade
    );

  }

  return finalizePerformanceAccumulator(
    accumulator
  );

}

/* =====================================================================
   Rolling Window Metrics
   ===================================================================== */

function getNewestTrades(
  trades,
  requestedSize
) {

  if (
    !Array.isArray(
      trades
    )
  ) {

    return [];

  }

  const size =
    toNonNegativeInteger(
      requestedSize
    );

  if (
    size ===
      null ||
    size ===
      0
  ) {

    return [];

  }

  return trades.slice(
    Math.max(
      0,
      trades.length -
        size
    )
  );

}

function buildRollingWindowMetric(
  trades,
  requestedSize
) {

  const normalizedSize =
    toNonNegativeInteger(
      requestedSize
    );

  if (
    normalizedSize ===
      null ||
    normalizedSize ===
      0
  ) {

    return null;

  }

  const windowTrades =
    getNewestTrades(
      trades,
      normalizedSize
    );

  const actualSize =
    windowTrades.length;

  return {
    requestedSize:
      normalizedSize,

    actualSize,

    complete:
      actualSize >=
        normalizedSize,

    available:
      actualSize >
        0,

    firstTradeAt:
      actualSize >
        0
        ? windowTrades[0]
            .closedAt
        : null,

    lastTradeAt:
      actualSize >
        0
        ? windowTrades[
            actualSize -
              1
          ].closedAt
        : null,

    metrics:
      calculatePerformanceMetrics(
        windowTrades
      )
  };

}

function buildRollingWindows(
  trades
) {

  const result =
    {};

  for (
    const windowSize of
    ROLLING_WINDOWS
  ) {

    result[
      String(
        windowSize
      )
    ] =
      buildRollingWindowMetric(
        trades,
        windowSize
      );

  }

  return result;

}

/* =====================================================================
   Recency Weighting
   ===================================================================== */

/*
 * Exponential half-life:
 *
 * weight(age) = 0.5 ^ (age / halfLife)
 *
 * age = 0 for newest trade.
 *
 * This weighting is deterministic because it depends only on trade
 * ordering and not the workflow's current clock time.
 */
function calculateRecencyWeight(
  ageIndex,
  halfLifeTrades =
    RECENCY_HALF_LIFE_TRADES
) {

  const age =
    toNonNegativeInteger(
      ageIndex
    );

  const halfLife =
    toFiniteNumber(
      halfLifeTrades
    );

  if (
    age ===
      null ||
    halfLife ===
      null ||
    halfLife <=
      0
  ) {

    return null;

  }

  return round(
    0.5 **
      (
        age /
        halfLife
      ),
    12
  );

}

function createWeightedAccumulator() {

  return {
    totalWeight:
      0,

    winWeight:
      0,

    lossWeight:
      0,

    breakevenWeight:
      0,

    weightedProfitPoints:
      0,

    profitWeight:
      0,

    weightedResultPercentage:
      0,

    resultPercentageWeight:
      0,

    weightedDurationMinutes:
      0,

    durationWeight:
      0,

    weightedConfidence:
      0,

    confidenceWeight:
      0,

    tradeCount:
      0
  };

}

function addWeightedTrade(
  accumulator,
  trade,
  weight
) {

  if (
    !isPlainObject(
      accumulator
    ) ||
    !isPlainObject(
      trade
    ) ||
    !isFiniteNumber(
      weight
    ) ||
    weight <=
      0
  ) {

    return false;

  }

  accumulator.tradeCount +=
    1;

  accumulator.totalWeight +=
    weight;

  if (
    trade.outcome ===
      "WIN"
  ) {

    accumulator.winWeight +=
      weight;

  } else if (
    trade.outcome ===
      "LOSS"
  ) {

    accumulator.lossWeight +=
      weight;

  } else if (
    trade.outcome ===
      "BREAKEVEN"
  ) {

    accumulator.breakevenWeight +=
      weight;

  }

  if (
    isFiniteNumber(
      trade.profitPoints
    )
  ) {

    accumulator
      .weightedProfitPoints +=
        trade.profitPoints *
        weight;

    accumulator
      .profitWeight +=
        weight;

  }

  if (
    isFiniteNumber(
      trade.resultPercentage
    )
  ) {

    accumulator
      .weightedResultPercentage +=
        trade.resultPercentage *
        weight;

    accumulator
      .resultPercentageWeight +=
        weight;

  }

  if (
    isFiniteNumber(
      trade.durationMinutes
    )
  ) {

    accumulator
      .weightedDurationMinutes +=
        trade.durationMinutes *
        weight;

    accumulator
      .durationWeight +=
        weight;

  }

  if (
    isFiniteNumber(
      trade.confidence
    )
  ) {

    accumulator
      .weightedConfidence +=
        trade.confidence *
        weight;

    accumulator
      .confidenceWeight +=
        weight;

  }

  return true;

}

function calculateWeightedPercentage(
  weightedValue,
  totalWeight
) {

  if (
    !isFiniteNumber(
      weightedValue
    ) ||
    !isFiniteNumber(
      totalWeight
    ) ||
    totalWeight <=
      0
  ) {

    return 0;

  }

  return round(
    (
      weightedValue /
      totalWeight
    ) *
      100,
    4
  );

}

function finalizeWeightedAccumulator(
  accumulator
) {

  if (
    !isPlainObject(
      accumulator
    )
  ) {

    return null;

  }

  const totalWeight =
    round(
      accumulator.totalWeight,
      12
    ) ?? 0;

  return {
    tradeCount:
      accumulator.tradeCount,

    halfLifeTrades:
      RECENCY_HALF_LIFE_TRADES,

    totalWeight,

    weightedWinRate:
      calculateWeightedPercentage(
        accumulator.winWeight,
        totalWeight
      ),

    weightedLossRate:
      calculateWeightedPercentage(
        accumulator.lossWeight,
        totalWeight
      ),

    weightedBreakevenRate:
      calculateWeightedPercentage(
        accumulator.breakevenWeight,
        totalWeight
      ),

    weightedAverageProfitPoints:
      accumulator.profitWeight >
        0
        ? round(
            accumulator
              .weightedProfitPoints /
              accumulator
                .profitWeight,
            8
          )
        : null,

    weightedAverageResultPercentage:
      accumulator
        .resultPercentageWeight >
        0
        ? round(
            accumulator
              .weightedResultPercentage /
              accumulator
                .resultPercentageWeight,
            8
          )
        : null,

    weightedAverageDurationMinutes:
      accumulator.durationWeight >
        0
        ? round(
            accumulator
              .weightedDurationMinutes /
              accumulator
                .durationWeight,
            4
          )
        : null,

    weightedAverageConfidence:
      accumulator.confidenceWeight >
        0
        ? round(
            accumulator
              .weightedConfidence /
              accumulator
                .confidenceWeight,
            4
          )
        : null
  };

}

function buildRecencyWeightedMetrics(
  trades
) {

  const accumulator =
    createWeightedAccumulator();

  if (
    !Array.isArray(
      trades
    ) ||
    trades.length ===
      0
  ) {

    return finalizeWeightedAccumulator(
      accumulator
    );

  }

  const newestIndex =
    trades.length -
      1;

  for (
    let index = 0;
    index <
      trades.length;
    index++
  ) {

    const ageIndex =
      newestIndex -
      index;

    const weight =
      calculateRecencyWeight(
        ageIndex
      );

    if (
      weight ===
        null
    ) {

      continue;

    }

    addWeightedTrade(
      accumulator,
      trades[index],
      weight
    );

  }

  return finalizeWeightedAccumulator(
    accumulator
  );

}

/* =====================================================================
   Trend Segment Construction
   ===================================================================== */

function buildTrendSegments(
  trades
) {

  if (
    !Array.isArray(
      trades
    )
  ) {

    return {
      available:
        false,

      requiredTrades:
        TREND_SEGMENT_SIZE *
        2,

      actualTrades:
        0,

      previous:
        null,

      recent:
        null
    };

  }

  const requiredTrades =
    TREND_SEGMENT_SIZE *
      2;

  if (
    trades.length <
      requiredTrades
  ) {

    return {
      available:
        false,

      requiredTrades,

      actualTrades:
        trades.length,

      previous:
        null,

      recent:
        null
    };

  }

  const recentStart =
    trades.length -
      TREND_SEGMENT_SIZE;

  const previousStart =
    recentStart -
      TREND_SEGMENT_SIZE;

  const previousTrades =
    trades.slice(
      previousStart,
      recentStart
    );

  const recentTrades =
    trades.slice(
      recentStart
    );

  return {
    available:
      true,

    requiredTrades,

    actualTrades:
      trades.length,

    previous: {
      size:
        previousTrades.length,

      firstTradeAt:
        previousTrades[0]
          ?.closedAt ||
        null,

      lastTradeAt:
        previousTrades[
          previousTrades.length -
            1
        ]?.closedAt ||
        null,

      metrics:
        calculatePerformanceMetrics(
          previousTrades
        )
    },

    recent: {
      size:
        recentTrades.length,

      firstTradeAt:
        recentTrades[0]
          ?.closedAt ||
        null,

      lastTradeAt:
        recentTrades[
          recentTrades.length -
            1
        ]?.closedAt ||
        null,

      metrics:
        calculatePerformanceMetrics(
          recentTrades
        )
    }
  };

}

/* =====================================================================
   Trend Classification
   ===================================================================== */

function compareNullableNumbers(
  recent,
  previous
) {

  const recentNumber =
    toFiniteNumber(
      recent
    );

  const previousNumber =
    toFiniteNumber(
      previous
    );

  if (
    recentNumber ===
      null ||
    previousNumber ===
      null
  ) {

    return null;

  }

  return round(
    recentNumber -
      previousNumber,
    8
  );

}

function classifyPerformanceTrend(
  trades
) {

  const segments =
    buildTrendSegments(
      trades
    );

  if (
    !segments.available
  ) {

    return {
      status:
        "insufficient-data",

      available:
        false,

      requiredTrades:
        segments.requiredTrades,

      actualTrades:
        segments.actualTrades,

      segmentSize:
        TREND_SEGMENT_SIZE,

      deltas: {
        winRate:
          null,

        averageProfitPoints:
          null,

        profitFactor:
          null
      },

      previous:
        null,

      recent:
        null,

      reasons: [
        (
          `At least ${segments.requiredTrades} trades are required ` +
          `for two ${TREND_SEGMENT_SIZE}-trade trend segments.`
        )
      ]
    };

  }

  const previousMetrics =
    segments.previous.metrics;

  const recentMetrics =
    segments.recent.metrics;

  const winRateDelta =
    compareNullableNumbers(
      recentMetrics.winRate,
      previousMetrics.winRate
    );

  const averageProfitPointsDelta =
    compareNullableNumbers(
      recentMetrics
        .profitPoints
        .average,
      previousMetrics
        .profitPoints
        .average
    );

  const profitFactorDelta =
    compareNullableNumbers(
      recentMetrics
        .profitPoints
        .profitFactor,
      previousMetrics
        .profitPoints
        .profitFactor
    );

  let improvingEvidence =
    0;

  let decliningEvidence =
    0;

  const reasons =
    [];

  if (
    winRateDelta !==
      null
  ) {

    if (
      winRateDelta >=
        WIN_RATE_TREND_THRESHOLD
    ) {

      improvingEvidence +=
        1;

      reasons.push(
        `Recent win rate increased by ${round(
          winRateDelta,
          4
        )} percentage points.`
      );

    } else if (
      winRateDelta <=
        -WIN_RATE_TREND_THRESHOLD
    ) {

      decliningEvidence +=
        1;

      reasons.push(
        `Recent win rate decreased by ${round(
          Math.abs(
            winRateDelta
          ),
          4
        )} percentage points.`
      );

    }

  }

  if (
    averageProfitPointsDelta !==
      null
  ) {

    if (
      averageProfitPointsDelta >
        0
    ) {

      improvingEvidence +=
        1;

      reasons.push(
        "Recent average profit points improved."
      );

    } else if (
      averageProfitPointsDelta <
        0
    ) {

      decliningEvidence +=
        1;

      reasons.push(
        "Recent average profit points declined."
      );

    }

  }

  if (
    profitFactorDelta !==
      null
  ) {

    if (
      profitFactorDelta >=
        PROFIT_FACTOR_TREND_THRESHOLD
    ) {

      improvingEvidence +=
        1;

      reasons.push(
        `Recent profit factor increased by ${round(
          profitFactorDelta,
          4
        )}.`
      );

    } else if (
      profitFactorDelta <=
        -PROFIT_FACTOR_TREND_THRESHOLD
    ) {

      decliningEvidence +=
        1;

      reasons.push(
        `Recent profit factor decreased by ${round(
          Math.abs(
            profitFactorDelta
          ),
          4
        )}.`
      );

    }

  }

  let status =
    "stable";

  if (
    improvingEvidence >
      decliningEvidence &&
    improvingEvidence >=
      2
  ) {

    status =
      "improving";

  } else if (
    decliningEvidence >
      improvingEvidence &&
    decliningEvidence >=
      2
  ) {

    status =
      "declining";

  }

  if (
    reasons.length ===
      0
  ) {

    reasons.push(
      "No material performance change crossed the configured thresholds."
    );

  }

  return {
    status,

    available:
      true,

    requiredTrades:
      segments.requiredTrades,

    actualTrades:
      segments.actualTrades,

    segmentSize:
      TREND_SEGMENT_SIZE,

    evidence: {
      improving:
        improvingEvidence,

      declining:
        decliningEvidence
    },

    thresholds: {
      winRatePercentagePoints:
        WIN_RATE_TREND_THRESHOLD,

      profitFactor:
        PROFIT_FACTOR_TREND_THRESHOLD
    },

    deltas: {
      winRate:
        winRateDelta,

      averageProfitPoints:
        averageProfitPointsDelta,

      profitFactor:
        profitFactorDelta
    },

    previous:
      segments.previous,

    recent:
      segments.recent,

    reasons:
      uniqueSortedStrings(
        reasons
      )
  };

}

/* =====================================================================
   Complete Performance Enrichment
   ===================================================================== */

function buildPerformanceEnrichment(
  trades
) {

  const normalizedTrades =
    Array.isArray(
      trades
    )
      ? trades
      : [];

  return {
    totalTrades:
      normalizedTrades.length,

    overall:
      calculatePerformanceMetrics(
        normalizedTrades
      ),

    rollingWindows:
      buildRollingWindows(
        normalizedTrades
      ),

    recencyWeighted:
      buildRecencyWeightedMetrics(
        normalizedTrades
      ),

    trend:
      normalizedTrades.length >=
        MIN_TREND_SAMPLE_SIZE
        ? classifyPerformanceTrend(
            normalizedTrades
          )
        : {
            status:
              "insufficient-data",

            available:
              false,

            requiredTrades:
              Math.max(
                MIN_TREND_SAMPLE_SIZE,
                TREND_SEGMENT_SIZE *
                  2
              ),

            actualTrades:
              normalizedTrades.length,

            segmentSize:
              TREND_SEGMENT_SIZE,

            deltas: {
              winRate:
                null,

              averageProfitPoints:
                null,

              profitFactor:
                null
            },

            previous:
              null,

            recent:
              null,

            reasons: [
              "Insufficient trades for reliable trend classification."
            ]
          }
  };

}

/* =====================================================================
   Deterministic Context Grouping
   ===================================================================== */

function ensureTradeGroup(
  groupMap,
  key
) {

  if (
    !(groupMap instanceof Map) ||
    !key
  ) {

    return null;

  }

  if (
    !groupMap.has(
      key
    )
  ) {

    groupMap.set(
      key,
      []
    );

  }

  return groupMap.get(
    key
  );

}

function addTradeToGroup(
  groupMap,
  key,
  trade
) {

  const group =
    ensureTradeGroup(
      groupMap,
      key
    );

  if (
    !group
  ) {

    return false;

  }

  group.push(
    trade
  );

  return true;

}

function finalizeTradeGroupMap(
  groupMap
) {

  const result =
    {};

  if (
    !(groupMap instanceof Map)
  ) {

    return result;

  }

  const sortedEntries =
    Array.from(
      groupMap.entries()
    ).sort(
      (
        [leftKey],
        [rightKey]
      ) =>
        leftKey.localeCompare(
          rightKey
        )
    );

  for (
    const [
      key,
      trades
    ] of
    sortedEntries
  ) {

    result[key] =
      buildPerformanceEnrichment(
        trades
      );

  }

  return result;

}

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
        value ===
          null
    )
  ) {

    return null;

  }

  return normalized.join(
    "::"
  );

}

/* =====================================================================
   Context Enrichment Construction
   ===================================================================== */

function buildContextEnrichment(
  trades
) {

  const normalizedTrades =
    Array.isArray(
      trades
    )
      ? trades
      : [];

  const pairs =
    new Map();

  const strategies =
    new Map();

  const directions =
    new Map();

  const timeframes =
    new Map();

  const pairStrategy =
    new Map();

  const pairDirection =
    new Map();

  const strategyDirection =
    new Map();

  const pairStrategyDirection =
    new Map();

  const pairTimeframe =
    new Map();

  const strategyTimeframe =
    new Map();

  for (
    const trade of
    normalizedTrades
  ) {

    addTradeToGroup(
      pairs,
      trade.pair,
      trade
    );

    addTradeToGroup(
      strategies,
      trade.strategy,
      trade
    );

    addTradeToGroup(
      directions,
      trade.direction,
      trade
    );

    addTradeToGroup(
      timeframes,
      trade.timeframe,
      trade
    );

    addTradeToGroup(
      pairStrategy,
      createCombinationKey([
        trade.pair,
        trade.strategy
      ]),
      trade
    );

    addTradeToGroup(
      pairDirection,
      createCombinationKey([
        trade.pair,
        trade.direction
      ]),
      trade
    );

    addTradeToGroup(
      strategyDirection,
      createCombinationKey([
        trade.strategy,
        trade.direction
      ]),
      trade
    );

    addTradeToGroup(
      pairStrategyDirection,
      createCombinationKey([
        trade.pair,
        trade.strategy,
        trade.direction
      ]),
      trade
    );

    addTradeToGroup(
      pairTimeframe,
      createCombinationKey([
        trade.pair,
        trade.timeframe
      ]),
      trade
    );

    addTradeToGroup(
      strategyTimeframe,
      createCombinationKey([
        trade.strategy,
        trade.timeframe
      ]),
      trade
    );

  }

  return {
    dimensions: {
      pairs:
        finalizeTradeGroupMap(
          pairs
        ),

      strategies:
        finalizeTradeGroupMap(
          strategies
        ),

      directions:
        finalizeTradeGroupMap(
          directions
        ),

      timeframes:
        finalizeTradeGroupMap(
          timeframes
        )
    },

    combinations: {
      pairStrategy:
        finalizeTradeGroupMap(
          pairStrategy
        ),

      pairDirection:
        finalizeTradeGroupMap(
          pairDirection
        ),

      strategyDirection:
        finalizeTradeGroupMap(
          strategyDirection
        ),

      pairStrategyDirection:
        finalizeTradeGroupMap(
          pairStrategyDirection
        ),

      pairTimeframe:
        finalizeTradeGroupMap(
          pairTimeframe
        ),

      strategyTimeframe:
        finalizeTradeGroupMap(
          strategyTimeframe
        )
    }
  };

}

/* =====================================================================
   Confidence Bucket Helpers
   ===================================================================== */

function getConfidenceBucketBounds(
  confidence
) {

  const normalizedConfidence =
    clamp(
      confidence,
      MIN_CONFIDENCE,
      MAX_CONFIDENCE
    );

  if (
    normalizedConfidence ===
      null
  ) {

    return null;

  }

  const lower =
    Math.floor(
      normalizedConfidence /
        CONFIDENCE_BUCKET_SIZE
    ) *
      CONFIDENCE_BUCKET_SIZE;

  const boundedLower =
    Math.min(
      lower,
      MAX_CONFIDENCE -
        CONFIDENCE_BUCKET_SIZE
    );

  const upper =
    Math.min(
      MAX_CONFIDENCE,
      boundedLower +
        CONFIDENCE_BUCKET_SIZE -
        1
    );

  return {
    lower:
      boundedLower,

    upper,

    key:
      `${boundedLower}-${upper}`
  };

}

function createCalibrationAccumulator(
  bucket
) {

  return {
    bucket:
      cloneJSONCompatible(
        bucket
      ),

    totalTrades:
      0,

    wins:
      0,

    losses:
      0,

    breakevens:
      0,

    confidenceTotal:
      0,

    confidenceSamples:
      0,

    profitPointsTotal:
      0,

    profitPointSamples:
      0,

    firstTradeAt:
      null,

    lastTradeAt:
      null
  };

}

function addTradeToCalibrationAccumulator(
  accumulator,
  trade
) {

  if (
    !isPlainObject(
      accumulator
    ) ||
    !isPlainObject(
      trade
    ) ||
    !isFiniteNumber(
      trade.confidence
    )
  ) {

    return false;

  }

  accumulator.totalTrades +=
    1;

  if (
    trade.outcome ===
      "WIN"
  ) {

    accumulator.wins +=
      1;

  } else if (
    trade.outcome ===
      "LOSS"
  ) {

    accumulator.losses +=
      1;

  } else if (
    trade.outcome ===
      "BREAKEVEN"
  ) {

    accumulator.breakevens +=
      1;

  }

  accumulator.confidenceTotal +=
    trade.confidence;

  accumulator.confidenceSamples +=
    1;

  if (
    isFiniteNumber(
      trade.profitPoints
    )
  ) {

    accumulator.profitPointsTotal +=
      trade.profitPoints;

    accumulator.profitPointSamples +=
      1;

  }

  const tradeTime =
    trade.closedAt ||
    trade.resolvedAt ||
    trade.openedAt ||
    null;

  if (
    tradeTime
  ) {

    if (
      accumulator.firstTradeAt ===
        null ||
      new Date(
        tradeTime
      ).getTime() <
        new Date(
          accumulator.firstTradeAt
        ).getTime()
    ) {

      accumulator.firstTradeAt =
        tradeTime;

    }

    if (
      accumulator.lastTradeAt ===
        null ||
      new Date(
        tradeTime
      ).getTime() >
        new Date(
          accumulator.lastTradeAt
        ).getTime()
    ) {

      accumulator.lastTradeAt =
        tradeTime;

    }

  }

  return true;

}

/* =====================================================================
   Calibration Finalization
   ===================================================================== */

function classifyCalibration(
  averageConfidence,
  observedWinRate,
  totalTrades
) {

  const confidence =
    toFiniteNumber(
      averageConfidence
    );

  const winRate =
    toFiniteNumber(
      observedWinRate
    );

  const samples =
    toNonNegativeInteger(
      totalTrades
    );

  if (
    confidence ===
      null ||
    winRate ===
      null ||
    samples ===
      null ||
    samples <
      MIN_TREND_SAMPLE_SIZE
  ) {

    return {
      status:
        "insufficient-data",

      gap:
        null,

      sampleSufficient:
        false
    };

  }

  const gap =
    round(
      winRate -
        confidence,
      4
    );

  let status =
    "well-calibrated";

  if (
    gap >=
      10
  ) {

    status =
      "under-confident";

  } else if (
    gap <=
      -10
  ) {

    status =
      "over-confident";

  }

  return {
    status,

    gap,

    sampleSufficient:
      true
  };

}

function finalizeCalibrationAccumulator(
  accumulator
) {

  if (
    !isPlainObject(
      accumulator
    )
  ) {

    return null;

  }

  const totalTrades =
    toNonNegativeInteger(
      accumulator.totalTrades
    ) ?? 0;

  const averageConfidence =
    accumulator.confidenceSamples >
      0
      ? round(
          accumulator.confidenceTotal /
            accumulator.confidenceSamples,
          4
        )
      : null;

  const observedWinRate =
    calculateRate(
      accumulator.wins,
      totalTrades
    );

  const calibration =
    classifyCalibration(
      averageConfidence,
      observedWinRate,
      totalTrades
    );

  return {
    bucket:
      cloneJSONCompatible(
        accumulator.bucket
      ),

    totalTrades,

    wins:
      accumulator.wins,

    losses:
      accumulator.losses,

    breakevens:
      accumulator.breakevens,

    observedWinRate,

    observedLossRate:
      calculateRate(
        accumulator.losses,
        totalTrades
      ),

    observedBreakevenRate:
      calculateRate(
        accumulator.breakevens,
        totalTrades
      ),

    averageConfidence,

    calibrationGap:
      calibration.gap,

    calibrationStatus:
      calibration.status,

    sampleSufficient:
      calibration.sampleSufficient,

    minimumRecommendedSamples:
      MIN_TREND_SAMPLE_SIZE,

    averageProfitPoints:
      accumulator.profitPointSamples >
        0
        ? round(
            accumulator.profitPointsTotal /
              accumulator.profitPointSamples,
            8
          )
        : null,

    firstTradeAt:
      accumulator.firstTradeAt,

    lastTradeAt:
      accumulator.lastTradeAt
  };

}

/* =====================================================================
   Confidence Calibration
   ===================================================================== */

function buildConfidenceCalibration(
  trades
) {

  const normalizedTrades =
    Array.isArray(
      trades
    )
      ? trades
      : [];

  const bucketMap =
    new Map();

  let missingConfidence =
    0;

  for (
    const trade of
    normalizedTrades
  ) {

    if (
      !isFiniteNumber(
        trade.confidence
      )
    ) {

      missingConfidence +=
        1;

      continue;

    }

    const bucket =
      getConfidenceBucketBounds(
        trade.confidence
      );

    if (
      !bucket
    ) {

      missingConfidence +=
        1;

      continue;

    }

    if (
      !bucketMap.has(
        bucket.key
      )
    ) {

      bucketMap.set(
        bucket.key,
        createCalibrationAccumulator(
          bucket
        )
      );

    }

    addTradeToCalibrationAccumulator(
      bucketMap.get(
        bucket.key
      ),
      trade
    );

  }

  const buckets =
    {};

  const sortedEntries =
    Array.from(
      bucketMap.entries()
    ).sort(
      (
        [leftKey],
        [rightKey]
      ) => {

        const leftLower =
          Number(
            leftKey.split(
              "-"
            )[0]
          );

        const rightLower =
          Number(
            rightKey.split(
              "-"
            )[0]
          );

        return leftLower -
          rightLower;

      }
    );

  for (
    const [
      key,
      accumulator
    ] of
    sortedEntries
  ) {

    buckets[key] =
      finalizeCalibrationAccumulator(
        accumulator
      );

  }

  const overallAccumulator =
    createPerformanceAccumulator();

  for (
    const trade of
    normalizedTrades
  ) {

    if (
      isFiniteNumber(
        trade.confidence
      )
    ) {

      addTradeToPerformanceAccumulator(
        overallAccumulator,
        trade
      );

    }

  }

  const overallMetrics =
    finalizePerformanceAccumulator(
      overallAccumulator
    );

  const overallCalibration =
    classifyCalibration(
      overallMetrics
        ?.confidence
        ?.average,
      overallMetrics
        ?.winRate,
      overallMetrics
        ?.totalTrades
    );

  return {
    bucketSize:
      CONFIDENCE_BUCKET_SIZE,

    totalTrades:
      normalizedTrades.length,

    calibratedTrades:
      normalizedTrades.length -
        missingConfidence,

    missingConfidence,

    overall: {
      totalTrades:
        overallMetrics
          ?.totalTrades ??
        0,

      averageConfidence:
        overallMetrics
          ?.confidence
          ?.average ??
        null,

      observedWinRate:
        overallMetrics
          ?.winRate ??
        0,

      calibrationGap:
        overallCalibration.gap,

      calibrationStatus:
        overallCalibration.status,

      sampleSufficient:
        overallCalibration
          .sampleSufficient,

      minimumRecommendedSamples:
        MIN_TREND_SAMPLE_SIZE
    },

    buckets
  };

}

/* =====================================================================
   Context-Level Calibration
   ===================================================================== */

function buildCalibrationGroupMap(
  trades,
  keySelector
) {

  const grouped =
    new Map();

  if (
    !Array.isArray(
      trades
    ) ||
    typeof keySelector !==
      "function"
  ) {

    return {};

  }

  for (
    const trade of
    trades
  ) {

    const key =
      toNonEmptyStringOrNull(
        keySelector(
          trade
        )
      );

    if (
      !key
    ) {

      continue;

    }

    addTradeToGroup(
      grouped,
      key,
      trade
    );

  }

  const result =
    {};

  for (
    const [
      key,
      groupedTrades
    ] of
    Array.from(
      grouped.entries()
    ).sort(
      (
        [leftKey],
        [rightKey]
      ) =>
        leftKey.localeCompare(
          rightKey
        )
    )
  ) {

    result[key] =
      buildConfidenceCalibration(
        groupedTrades
      );

  }

  return result;

}

function buildContextCalibration(
  trades
) {

  const normalizedTrades =
    Array.isArray(
      trades
    )
      ? trades
      : [];

  return {
    overall:
      buildConfidenceCalibration(
        normalizedTrades
      ),

    dimensions: {
      pairs:
        buildCalibrationGroupMap(
          normalizedTrades,
          trade =>
            trade.pair
        ),

      strategies:
        buildCalibrationGroupMap(
          normalizedTrades,
          trade =>
            trade.strategy
        ),

      directions:
        buildCalibrationGroupMap(
          normalizedTrades,
          trade =>
            trade.direction
        ),

      timeframes:
        buildCalibrationGroupMap(
          normalizedTrades,
          trade =>
            trade.timeframe
        )
    },

    combinations: {
      pairStrategy:
        buildCalibrationGroupMap(
          normalizedTrades,
          trade =>
            createCombinationKey([
              trade.pair,
              trade.strategy
            ])
        ),

      pairDirection:
        buildCalibrationGroupMap(
          normalizedTrades,
          trade =>
            createCombinationKey([
              trade.pair,
              trade.direction
            ])
        ),

      strategyDirection:
        buildCalibrationGroupMap(
          normalizedTrades,
          trade =>
            createCombinationKey([
              trade.strategy,
              trade.direction
            ])
        ),

      pairStrategyDirection:
        buildCalibrationGroupMap(
          normalizedTrades,
          trade =>
            createCombinationKey([
              trade.pair,
              trade.strategy,
              trade.direction
            ])
        )
    }
  };

}

/* =====================================================================
   Sample Sufficiency
   ===================================================================== */

function classifySampleSize(
  totalTrades
) {

  const total =
    toNonNegativeInteger(
      totalTrades
    ) ?? 0;

  if (
    total >=
      100
  ) {

    return "strong";

  }

  if (
    total >=
      50
  ) {

    return "moderate";

  }

  if (
    total >=
      20
  ) {

    return "limited";

  }

  return "insufficient";

}

function buildSampleSufficiencyMetric(
  enrichment
) {

  const totalTrades =
    toNonNegativeInteger(
      enrichment?.totalTrades
    ) ?? 0;

  return {
    totalTrades,

    classification:
      classifySampleSize(
        totalTrades
      ),

    gates: {
      minimum:
        20,

      moderate:
        50,

      strong:
        100
    },

    trendEligible:
      totalTrades >=
        (
          TREND_SEGMENT_SIZE *
          2
        ),

    calibrationEligible:
      totalTrades >=
        MIN_TREND_SAMPLE_SIZE,

    rollingWindowCoverage:
      Object.fromEntries(
        ROLLING_WINDOWS.map(
          windowSize => [
            String(
              windowSize
            ),
            {
              requested:
                windowSize,

              available:
                Math.min(
                  totalTrades,
                  windowSize
                ),

              complete:
                totalTrades >=
                  windowSize
            }
          ]
        )
      )
  };

}

function attachSampleSufficiencyToMap(
  enrichmentMap
) {

  const result =
    {};

  if (
    !isPlainObject(
      enrichmentMap
    )
  ) {

    return result;

  }

  for (
    const key of Object.keys(
      enrichmentMap
    ).sort()
  ) {

    result[key] = {
      ...cloneJSONCompatible(
        enrichmentMap[key]
      ),

      sampleSufficiency:
        buildSampleSufficiencyMetric(
          enrichmentMap[key]
        )
    };

  }

  return result;

}

function attachContextSampleSufficiency(
  contextEnrichment
) {

  if (
    !isPlainObject(
      contextEnrichment
    )
  ) {

    return {
      dimensions: {},
      combinations: {}
    };

  }

  const dimensions =
    contextEnrichment.dimensions ||
    {};

  const combinations =
    contextEnrichment.combinations ||
    {};

  return {
    dimensions: {
      pairs:
        attachSampleSufficiencyToMap(
          dimensions.pairs
        ),

      strategies:
        attachSampleSufficiencyToMap(
          dimensions.strategies
        ),

      directions:
        attachSampleSufficiencyToMap(
          dimensions.directions
        ),

      timeframes:
        attachSampleSufficiencyToMap(
          dimensions.timeframes
        )
    },

    combinations: {
      pairStrategy:
        attachSampleSufficiencyToMap(
          combinations.pairStrategy
        ),

      pairDirection:
        attachSampleSufficiencyToMap(
          combinations.pairDirection
        ),

      strategyDirection:
        attachSampleSufficiencyToMap(
          combinations.strategyDirection
        ),

      pairStrategyDirection:
        attachSampleSufficiencyToMap(
          combinations
            .pairStrategyDirection
        ),

      pairTimeframe:
        attachSampleSufficiencyToMap(
          combinations.pairTimeframe
        ),

      strategyTimeframe:
        attachSampleSufficiencyToMap(
          combinations
            .strategyTimeframe
        )
    }
  };

}

/* =====================================================================
   Complete Context Intelligence
   ===================================================================== */

function buildContextIntelligence(
  trades
) {

  const contextEnrichment =
    buildContextEnrichment(
      trades
    );

  return {
    performance:
      attachContextSampleSufficiency(
        contextEnrichment
      ),

    calibration:
      buildContextCalibration(
        trades
      )
  };

}

/* =====================================================================
   Empty Output Structures
   ===================================================================== */

function createEmptyEnrichmentDocument(
  generatedAt =
    new Date().toISOString()
) {

  return {
    version:
      ENRICHMENT_SCHEMA_VERSION,

    engineName:
      ENGINE_NAME,

    engineVersion:
      ENGINE_VERSION,

    mode:
      ENGINE_MODE,

    generatedAt,

    sourceUpdatedAt: {
      learningData:
        null,

      confidenceData:
        null
    },

    summary: {
      sourceTrades:
        0,

      acceptedTrades:
        0,

      rejectedTrades:
        0,

      duplicateTrades:
        0,

      pairs:
        0,

      strategies:
        0,

      directions:
        0,

      timeframes:
        0
    },

    intelligence: {
      overall:
        buildPerformanceEnrichment(
          []
        ),

      contexts:
        buildContextIntelligence(
          []
        ),

      sourceConfidenceSnapshot: {
        strategies: {},
        pairs: {},
        timeframes: {},
        indicators: {},
        overall:
          null
      }
    },

    source: {
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

      learningDataHash:
        null,

      confidenceDataHash:
        null
    },

    rejectedRecords:
      [],

    duplicateRecords:
      [],

    safety:
      cloneJSONCompatible(
        SAFETY_POLICY
      ),

    configuration: {
      rollingWindows:
        cloneJSONCompatible(
          ROLLING_WINDOWS
        ),

      recencyHalfLifeTrades:
        RECENCY_HALF_LIFE_TRADES,

      confidenceBucketSize:
        CONFIDENCE_BUCKET_SIZE,

      minimumTrendSampleSize:
        MIN_TREND_SAMPLE_SIZE,

      trendSegmentSize:
        TREND_SEGMENT_SIZE,

      winRateTrendThreshold:
        WIN_RATE_TREND_THRESHOLD,

      profitFactorTrendThreshold:
        PROFIT_FACTOR_TREND_THRESHOLD,

      maximumSourceTrades:
        MAX_SOURCE_TRADES
    },

    validation: {
      valid:
        true,

      errors:
        [],

      warnings:
        []
    },

    metadata: {
      deterministic:
        true,

      duplicateSafe:
        true,

      atomicWrites:
        true,

      localProcessingOnly:
        true,

      externalApiCalls:
        false,

      packageInstallRequired:
        false,

      productionConsumerEnabled:
        false,

      existingOutputsModified:
        false
    }
  };

}

function createEmptyEnrichmentState(
  createdAt =
    new Date().toISOString()
) {

  return {
    version:
      STATE_SCHEMA_VERSION,

    engineName:
      ENGINE_NAME,

    engineVersion:
      ENGINE_VERSION,

    mode:
      ENGINE_MODE,

    createdAt,

    updatedAt:
      createdAt,

    lastRunAt:
      null,

    lastSuccessfulRunAt:
      null,

    sourceHashes: {
      learningData:
        null,

      confidenceData:
        null
    },

    outputHash:
      null,

    counters: {
      runs:
        0,

      successfulRuns:
        0,

      failedRuns:
        0,

      updatedRuns:
        0,

      unchangedRuns:
        0,

      sourceTradesObserved:
        0,

      acceptedTradesObserved:
        0,

      rejectedTradesObserved:
        0,

      duplicateTradesObserved:
        0
    },

    lastRun: {
      status:
        "NEVER_RUN",

      startedAt:
        null,

      completedAt:
        null,

      sourceChanged:
        false,

      outputChanged:
        false,

      outputWritten:
        false,

      stateWritten:
        false,

      sourceTrades:
        0,

      acceptedTrades:
        0,

      rejectedTrades:
        0,

      duplicateTrades:
        0,

      warnings:
        [],

      error:
        null
    }
  };

}

/* =====================================================================
   Output Validation Helpers
   ===================================================================== */

function validatePerformanceMetric(
  metric,
  label
) {

  const errors =
    [];

  if (
    !isPlainObject(
      metric
    )
  ) {

    return {
      valid: false,

      errors: [
        `${label} must be a JSON object.`
      ]
    };

  }

  const requiredCounts =
    [
      "totalTrades",
      "wins",
      "losses",
      "breakevens"
    ];

  for (
    const field of
    requiredCounts
  ) {

    if (
      toNonNegativeInteger(
        metric[field]
      ) ===
        null
    ) {

      errors.push(
        `${label}.${field} is invalid.`
      );

    }

  }

  const totalTrades =
    toNonNegativeInteger(
      metric.totalTrades
    );

  const wins =
    toNonNegativeInteger(
      metric.wins
    );

  const losses =
    toNonNegativeInteger(
      metric.losses
    );

  const breakevens =
    toNonNegativeInteger(
      metric.breakevens
    );

  if (
    totalTrades !==
      null &&
    wins !==
      null &&
    losses !==
      null &&
    breakevens !==
      null &&
    wins +
      losses +
      breakevens !==
      totalTrades
  ) {

    errors.push(
      `${label} outcome counts do not equal totalTrades.`
    );

  }

  const rateFields =
    [
      "winRate",
      "lossRate",
      "breakevenRate"
    ];

  for (
    const field of
    rateFields
  ) {

    const value =
      toFiniteNumber(
        metric[field]
      );

    if (
      value ===
        null ||
      value <
        0 ||
      value >
        100
    ) {

      errors.push(
        `${label}.${field} is outside 0–100.`
      );

    }

  }

  if (
    !isPlainObject(
      metric.profitPoints
    )
  ) {

    errors.push(
      `${label}.profitPoints must be a JSON object.`
    );

  }

  if (
    !isPlainObject(
      metric.resultPercentage
    )
  ) {

    errors.push(
      `${label}.resultPercentage must be a JSON object.`
    );

  }

  if (
    !isPlainObject(
      metric.durationMinutes
    )
  ) {

    errors.push(
      `${label}.durationMinutes must be a JSON object.`
    );

  }

  if (
    !isPlainObject(
      metric.confidence
    )
  ) {

    errors.push(
      `${label}.confidence must be a JSON object.`
    );

  }

  return {
    valid:
      errors.length ===
      0,

    errors:
      uniqueSortedStrings(
        errors
      )
  };

}

function validateRollingWindows(
  rollingWindows,
  label
) {

  const errors =
    [];

  if (
    !isPlainObject(
      rollingWindows
    )
  ) {

    return {
      valid: false,

      errors: [
        `${label} must be a JSON object.`
      ]
    };

  }

  for (
    const windowSize of
    ROLLING_WINDOWS
  ) {

    const key =
      String(
        windowSize
      );

    const window =
      rollingWindows[key];

    if (
      !isPlainObject(
        window
      )
    ) {

      errors.push(
        `${label}.${key} is missing.`
      );

      continue;

    }

    if (
      window.requestedSize !==
        windowSize
    ) {

      errors.push(
        `${label}.${key}.requestedSize is inconsistent.`
      );

    }

    const actualSize =
      toNonNegativeInteger(
        window.actualSize
      );

    if (
      actualSize ===
        null ||
      actualSize >
        windowSize
    ) {

      errors.push(
        `${label}.${key}.actualSize is invalid.`
      );

    }

    if (
      typeof window.complete !==
        "boolean" ||
      typeof window.available !==
        "boolean"
    ) {

      errors.push(
        `${label}.${key} availability flags are invalid.`
      );

    }

    const metricValidation =
      validatePerformanceMetric(
        window.metrics,
        `${label}.${key}.metrics`
      );

    errors.push(
      ...metricValidation.errors
    );

  }

  return {
    valid:
      errors.length ===
      0,

    errors:
      uniqueSortedStrings(
        errors
      )
  };

}

function validatePerformanceEnrichment(
  enrichment,
  label
) {

  const errors =
    [];

  if (
    !isPlainObject(
      enrichment
    )
  ) {

    return {
      valid: false,

      errors: [
        `${label} must be a JSON object.`
      ]
    };

  }

  if (
    toNonNegativeInteger(
      enrichment.totalTrades
    ) ===
      null
  ) {

    errors.push(
      `${label}.totalTrades is invalid.`
    );

  }

  const overallValidation =
    validatePerformanceMetric(
      enrichment.overall,
      `${label}.overall`
    );

  errors.push(
    ...overallValidation.errors
  );

  const rollingValidation =
    validateRollingWindows(
      enrichment.rollingWindows,
      `${label}.rollingWindows`
    );

  errors.push(
    ...rollingValidation.errors
  );

  if (
    !isPlainObject(
      enrichment.recencyWeighted
    )
  ) {

    errors.push(
      `${label}.recencyWeighted must be a JSON object.`
    );

  } else {

    if (
      enrichment
        .recencyWeighted
        .halfLifeTrades !==
        RECENCY_HALF_LIFE_TRADES
    ) {

      errors.push(
        `${label}.recencyWeighted half-life is inconsistent.`
      );

    }

    const weightedRates =
      [
        "weightedWinRate",
        "weightedLossRate",
        "weightedBreakevenRate"
      ];

    for (
      const field of
      weightedRates
    ) {

      const value =
        toFiniteNumber(
          enrichment
            .recencyWeighted[
              field
            ]
        );

      if (
        value ===
          null ||
        value <
          0 ||
        value >
          100
      ) {

        errors.push(
          `${label}.recencyWeighted.${field} is invalid.`
        );

      }

    }

  }

  if (
    !isPlainObject(
      enrichment.trend
    )
  ) {

    errors.push(
      `${label}.trend must be a JSON object.`
    );

  } else {

    const acceptedTrendStatuses =
      new Set([
        "improving",
        "stable",
        "declining",
        "insufficient-data"
      ]);

    if (
      !acceptedTrendStatuses.has(
        enrichment.trend.status
      )
    ) {

      errors.push(
        `${label}.trend.status is invalid.`
      );

    }

  }

  return {
    valid:
      errors.length ===
      0,

    errors:
      uniqueSortedStrings(
        errors
      )
  };

}

function validateEnrichmentMap(
  map,
  label
) {

  const errors =
    [];

  if (
    !isPlainObject(
      map
    )
  ) {

    return {
      valid: false,

      errors: [
        `${label} must be a JSON object.`
      ]
    };

  }

  for (
    const key of Object.keys(
      map
    )
  ) {

    const entry =
      map[key];

    const enrichmentValidation =
      validatePerformanceEnrichment(
        entry,
        `${label}.${key}`
      );

    errors.push(
      ...enrichmentValidation.errors
    );

    if (
      !isPlainObject(
        entry?.sampleSufficiency
      )
    ) {

      errors.push(
        `${label}.${key}.sampleSufficiency is missing.`
      );

    }

  }

  return {
    valid:
      errors.length ===
      0,

    errors:
      uniqueSortedStrings(
        errors
      )
  };

}

/* =====================================================================
   Final Document Validation
   ===================================================================== */

function validateEnrichmentDocument(
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

    return {
      valid: false,

      errors: [
        "Learning enrichment document must be a JSON object."
      ],

      warnings
    };

  }

  if (
    document.version !==
      ENRICHMENT_SCHEMA_VERSION
  ) {

    errors.push(
      "Learning enrichment schema version is invalid."
    );

  }

  if (
    document.engineName !==
      ENGINE_NAME
  ) {

    errors.push(
      "Learning enrichment engine name is invalid."
    );

  }

  if (
    document.engineVersion !==
      ENGINE_VERSION
  ) {

    errors.push(
      "Learning enrichment engine version is invalid."
    );

  }

  if (
    document.mode !==
      ENGINE_MODE
  ) {

    errors.push(
      "Learning enrichment mode must remain advisory."
    );

  }

  if (
    !toISOStringOrNull(
      document.generatedAt
    )
  ) {

    errors.push(
      "Learning enrichment generatedAt is invalid."
    );

  }

  if (
    !isPlainObject(
      document.summary
    )
  ) {

    errors.push(
      "Learning enrichment summary is missing."
    );

  } else {

    const countFields =
      [
        "sourceTrades",
        "acceptedTrades",
        "rejectedTrades",
        "duplicateTrades",
        "pairs",
        "strategies",
        "directions",
        "timeframes"
      ];

    for (
      const field of
      countFields
    ) {

      if (
        toNonNegativeInteger(
          document.summary[
            field
          ]
        ) ===
          null
      ) {

        errors.push(
          `Learning enrichment summary.${field} is invalid.`
        );

      }

    }

    if (
      document.summary
        .acceptedTrades +
        document.summary
          .rejectedTrades +
        document.summary
          .duplicateTrades !==
        document.summary
          .sourceTrades
    ) {

      errors.push(
        "Learning enrichment source trade counts are inconsistent."
      );

    }

  }

  if (
    !isPlainObject(
      document.intelligence
    )
  ) {

    errors.push(
      "Learning enrichment intelligence section is missing."
    );

  } else {

    const overallValidation =
      validatePerformanceEnrichment(
        document.intelligence.overall,
        "intelligence.overall"
      );

    errors.push(
      ...overallValidation.errors
    );

    const performance =
      document.intelligence
        ?.contexts
        ?.performance;

    const dimensionNames =
      [
        "pairs",
        "strategies",
        "directions",
        "timeframes"
      ];

    for (
      const dimensionName of
      dimensionNames
    ) {

      const result =
        validateEnrichmentMap(
          performance
            ?.dimensions
            ?.[dimensionName],
          (
            "intelligence.contexts.performance." +
            `dimensions.${dimensionName}`
          )
        );

      errors.push(
        ...result.errors
      );

    }

    const combinationNames =
      [
        "pairStrategy",
        "pairDirection",
        "strategyDirection",
        "pairStrategyDirection",
        "pairTimeframe",
        "strategyTimeframe"
      ];

    for (
      const combinationName of
      combinationNames
    ) {

      const result =
        validateEnrichmentMap(
          performance
            ?.combinations
            ?.[combinationName],
          (
            "intelligence.contexts.performance." +
            `combinations.${combinationName}`
          )
        );

      errors.push(
        ...result.errors
      );

    }

    if (
      !isPlainObject(
        document.intelligence
          ?.contexts
          ?.calibration
      )
    ) {

      errors.push(
        "Learning enrichment context calibration is missing."
      );

    }

  }

  if (
    !isPlainObject(
      document.source
    )
  ) {

    errors.push(
      "Learning enrichment source section is missing."
    );

  } else {

    if (
      !toTrimmedString(
        document.source
          .learningDataHash
      )
    ) {

      errors.push(
        "Learning enrichment learningDataHash is missing."
      );

    }

    if (
      !toTrimmedString(
        document.source
          .confidenceDataHash
      )
    ) {

      errors.push(
        "Learning enrichment confidenceDataHash is missing."
      );

    }

  }

  if (
    !isPlainObject(
      document.safety
    )
  ) {

    errors.push(
      "Learning enrichment safety section is missing."
    );

  } else {

    const requiredTrueFlags =
      [
        "advisoryOnly"
      ];

    for (
      const flag of
      requiredTrueFlags
    ) {

      if (
        document.safety[
          flag
        ] !==
          true
      ) {

        errors.push(
          `Learning enrichment safety.${flag} must be true.`
        );

      }

    }

    const requiredFalseFlags =
      [
        "liveSignalModification",
        "confidenceModification",
        "decisionModification",
        "tradePlanModification",
        "telegramModification",
        "sourceCodeModification",
        "externalApiCalls",
        "existingSchemaModification",
        "existingLearningOutputModification",
        "existingMemoryOutputModification"
      ];

    for (
      const flag of
      requiredFalseFlags
    ) {

      if (
        document.safety[
          flag
        ] !==
          false
      ) {

        errors.push(
          `Learning enrichment safety.${flag} must be false.`
        );

      }

    }

  }

  if (
    !isPlainObject(
      document.configuration
    )
  ) {

    errors.push(
      "Learning enrichment configuration section is missing."
    );

  } else {

    if (
      createHash(
        document.configuration
          .rollingWindows
      ) !==
      createHash(
        ROLLING_WINDOWS
      )
    ) {

      errors.push(
        "Learning enrichment rolling-window configuration is inconsistent."
      );

    }

    if (
      document.configuration
        .recencyHalfLifeTrades !==
        RECENCY_HALF_LIFE_TRADES
    ) {

      errors.push(
        "Learning enrichment recency half-life is inconsistent."
      );

    }

    if (
      document.configuration
        .maximumSourceTrades !==
        MAX_SOURCE_TRADES
    ) {

      errors.push(
        "Learning enrichment maximum source-trade limit is inconsistent."
      );

    }

  }

  if (
    !Array.isArray(
      document.rejectedRecords
    )
  ) {

    errors.push(
      "Learning enrichment rejectedRecords must be an array."
    );

  }

  if (
    !Array.isArray(
      document.duplicateRecords
    )
  ) {

    errors.push(
      "Learning enrichment duplicateRecords must be an array."
    );

  }

  return {
    valid:
      errors.length ===
      0,

    errors:
      uniqueSortedStrings(
        errors
      ),

    warnings:
      uniqueSortedStrings(
        warnings
      )
  };

}

/* =====================================================================
   Final Document Construction
   ===================================================================== */

function buildEnrichmentDocument({
  sourceBundle,
  generatedAt =
    new Date().toISOString()
}) {

  const document =
    createEmptyEnrichmentDocument(
      generatedAt
    );

  if (
    !isPlainObject(
      sourceBundle
    ) ||
    sourceBundle.valid !==
      true
  ) {

    document.validation = {
      valid:
        false,

      errors:
        uniqueSortedStrings(
          sourceBundle?.errors || [
            "Valid enrichment source bundle is required."
          ]
        ),

      warnings:
        uniqueSortedStrings(
          sourceBundle?.warnings ||
          []
        )
    };

    return document;

  }

  const trades =
    sourceBundle.trades;

  const contexts =
    buildContextIntelligence(
      trades
    );

  document.sourceUpdatedAt =
    cloneJSONCompatible(
      sourceBundle.sourceUpdatedAt
    );

  document.summary = {
    sourceTrades:
      sourceBundle.counts
        .sourceTrades,

    acceptedTrades:
      sourceBundle.counts
        .acceptedTrades,

    rejectedTrades:
      sourceBundle.counts
        .rejectedTrades,

    duplicateTrades:
      sourceBundle.counts
        .duplicateTrades,

    pairs:
      Object.keys(
        contexts
          .performance
          .dimensions
          .pairs
      ).length,

    strategies:
      Object.keys(
        contexts
          .performance
          .dimensions
          .strategies
      ).length,

    directions:
      Object.keys(
        contexts
          .performance
          .dimensions
          .directions
      ).length,

    timeframes:
      Object.keys(
        contexts
          .performance
          .dimensions
          .timeframes
      ).length
  };

  document.intelligence = {
    overall:
      buildPerformanceEnrichment(
        trades
      ),

    contexts,

    sourceConfidenceSnapshot:
      cloneJSONCompatible(
        sourceBundle.confidence
      )
  };

  document.source = {
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

    learningDataHash:
      sourceBundle
        .sourceHashes
        .learningData,

    confidenceDataHash:
      sourceBundle
        .sourceHashes
        .confidenceData
  };

  /*
   * Bound diagnostic detail to avoid uncontrolled output growth.
   */
  document.rejectedRecords =
    cloneJSONCompatible(
      sourceBundle.rejected.slice(
        0,
        1000
      )
    );

  document.duplicateRecords =
    cloneJSONCompatible(
      sourceBundle.duplicates.slice(
        0,
        1000
      )
    );

  if (
    sourceBundle.rejected.length >
      1000
  ) {

    document.validation.warnings.push(
      "Rejected-record diagnostics were truncated to 1000 entries."
    );

  }

  if (
    sourceBundle.duplicates.length >
      1000
  ) {

    document.validation.warnings.push(
      "Duplicate-record diagnostics were truncated to 1000 entries."
    );

  }

  document.validation = {
    valid:
      true,

    errors:
      [],

    warnings:
      uniqueSortedStrings([
        ...document.validation.warnings,
        ...sourceBundle.warnings
      ])
  };

  const validation =
    validateEnrichmentDocument(
      document
    );

  document.validation = {
    valid:
      validation.valid,

    errors:
      validation.errors,

    warnings:
      uniqueSortedStrings([
        ...document.validation.warnings,
        ...validation.warnings
      ])
  };

  return document;

}

/* =====================================================================
   State Validation
   ===================================================================== */

function validateEnrichmentState(
  state
) {

  const errors =
    [];

  if (
    !isPlainObject(
      state
    )
  ) {

    return {
      valid: false,

      errors: [
        "Learning enrichment state must be a JSON object."
      ]
    };

  }

  if (
    state.version !==
      STATE_SCHEMA_VERSION
  ) {

    errors.push(
      "Learning enrichment state schema version is invalid."
    );

  }

  if (
    state.engineName !==
      ENGINE_NAME
  ) {

    errors.push(
      "Learning enrichment state engine name is invalid."
    );

  }

  if (
    state.engineVersion !==
      ENGINE_VERSION
  ) {

    errors.push(
      "Learning enrichment state engine version is invalid."
    );

  }

  if (
    state.mode !==
      ENGINE_MODE
  ) {

    errors.push(
      "Learning enrichment state mode is invalid."
    );

  }

  if (
    !toISOStringOrNull(
      state.createdAt
    )
  ) {

    errors.push(
      "Learning enrichment state createdAt is invalid."
    );

  }

  if (
    !toISOStringOrNull(
      state.updatedAt
    )
  ) {

    errors.push(
      "Learning enrichment state updatedAt is invalid."
    );

  }

  if (
    !isPlainObject(
      state.sourceHashes
    )
  ) {

    errors.push(
      "Learning enrichment state sourceHashes is invalid."
    );

  }

  if (
    !isPlainObject(
      state.counters
    )
  ) {

    errors.push(
      "Learning enrichment state counters is invalid."
    );

  } else {

    const counterFields =
      [
        "runs",
        "successfulRuns",
        "failedRuns",
        "updatedRuns",
        "unchangedRuns",
        "sourceTradesObserved",
        "acceptedTradesObserved",
        "rejectedTradesObserved",
        "duplicateTradesObserved"
      ];

    for (
      const field of
      counterFields
    ) {

      if (
        toNonNegativeInteger(
          state.counters[
            field
          ]
        ) ===
          null
      ) {

        errors.push(
          `Learning enrichment state counters.${field} is invalid.`
        );

      }

    }

  }

  if (
    !isPlainObject(
      state.lastRun
    )
  ) {

    errors.push(
      "Learning enrichment state lastRun is invalid."
    );

  }

  return {
    valid:
      errors.length ===
      0,

    errors:
      uniqueSortedStrings(
        errors
      )
  };

}

/* =====================================================================
   State Loading and Existing Output
   ===================================================================== */

function loadEnrichmentState(
  runAt
) {

  const read =
    readJSONFile(
      ENRICHMENT_STATE_PATH,
      null
    );

  if (
    !read.ok ||
    !isPlainObject(
      read.value
    )
  ) {

    return {
      state:
        createEmptyEnrichmentState(
          runAt
        ),

      recovered:
        read.exists ===
          true,

      warning:
        read.error
    };

  }

  const validation =
    validateEnrichmentState(
      read.value
    );

  if (
    !validation.valid
  ) {

    return {
      state:
        createEmptyEnrichmentState(
          runAt
        ),

      recovered:
        true,

      warning:
        validation.errors.join(
          " "
        )
    };

  }

  return {
    state:
      cloneJSONCompatible(
        read.value
      ),

    recovered:
      false,

    warning:
      null
  };

}

function readExistingEnrichmentOutput() {

  const read =
    readJSONFile(
      ENRICHMENT_OUTPUT_PATH,
      null
    );

  if (
    !read.ok ||
    !isPlainObject(
      read.value
    )
  ) {

    return {
      exists:
        read.exists,

      valid:
        false,

      value:
        null,

      error:
        read.error
    };

  }

  const validation =
    validateEnrichmentDocument(
      read.value
    );

  return {
    exists:
      true,

    valid:
      validation.valid,

    value:
      validation.valid
        ? read.value
        : null,

    error:
      validation.valid
        ? null
        : validation.errors.join(
            " "
          )
  };

}

/* =====================================================================
   Deterministic Change Detection
   ===================================================================== */

function haveEnrichmentSourcesChanged({
  state,
  learningDataHash,
  confidenceDataHash
}) {

  if (
    !isPlainObject(
      state?.sourceHashes
    )
  ) {

    return true;

  }

  return (
    state.sourceHashes
      .learningData !==
        learningDataHash ||
    state.sourceHashes
      .confidenceData !==
        confidenceDataHash
  );

}

function hasEnrichmentOutputChanged({
  existingOutput,
  generatedOutput
}) {

  if (
    !existingOutput.exists ||
    !existingOutput.valid ||
    !isPlainObject(
      existingOutput.value
    )
  ) {

    return true;

  }

  const existingComparable =
    cloneJSONCompatible(
      existingOutput.value
    );

  const generatedComparable =
    cloneJSONCompatible(
      generatedOutput
    );

  /*
   * generatedAt is operational metadata and must not cause a false
   * semantic output change.
   */
  existingComparable.generatedAt =
    null;

  generatedComparable.generatedAt =
    null;

  return (
    createHash(
      existingComparable
    ) !==
    createHash(
      generatedComparable
    )
  );

}

/* =====================================================================
   Run State Lifecycle
   ===================================================================== */

function beginEnrichmentRun({
  state,
  runAt
}) {

  const nextState =
    cloneJSONCompatible(
      state
    );

  nextState.updatedAt =
    runAt;

  nextState.lastRunAt =
    runAt;

  nextState.counters.runs +=
    1;

  nextState.lastRun = {
    status:
      "RUNNING",

    startedAt:
      runAt,

    completedAt:
      null,

    sourceChanged:
      false,

    outputChanged:
      false,

    outputWritten:
      false,

    stateWritten:
      false,

    sourceTrades:
      0,

    acceptedTrades:
      0,

    rejectedTrades:
      0,

    duplicateTrades:
      0,

    warnings:
      [],

    error:
      null
  };

  return nextState;

}

function completeEnrichmentRun({
  state,
  runAt,
  status,
  sourceChanged,
  outputChanged,
  outputWritten,
  sourceBundle,
  outputHash,
  warnings
}) {

  const nextState =
    cloneJSONCompatible(
      state
    );

  nextState.updatedAt =
    runAt;

  nextState.lastRunAt =
    runAt;

  nextState.lastSuccessfulRunAt =
    runAt;

  nextState.sourceHashes = {
    learningData:
      sourceBundle
        .sourceHashes
        .learningData,

    confidenceData:
      sourceBundle
        .sourceHashes
        .confidenceData
  };

  nextState.outputHash =
    outputHash;

  nextState.counters
    .successfulRuns +=
      1;

  if (
    status ===
      "UPDATED"
  ) {

    nextState.counters
      .updatedRuns +=
        1;

  } else {

    nextState.counters
      .unchangedRuns +=
        1;

  }

  nextState.counters
    .sourceTradesObserved +=
      sourceBundle.counts
        .sourceTrades;

  nextState.counters
    .acceptedTradesObserved +=
      sourceBundle.counts
        .acceptedTrades;

  nextState.counters
    .rejectedTradesObserved +=
      sourceBundle.counts
        .rejectedTrades;

  nextState.counters
    .duplicateTradesObserved +=
      sourceBundle.counts
        .duplicateTrades;

  nextState.lastRun = {
    status,

    startedAt:
      state.lastRun
        ?.startedAt ||
      runAt,

    completedAt:
      runAt,

    sourceChanged:
      sourceChanged ===
        true,

    outputChanged:
      outputChanged ===
        true,

    outputWritten:
      outputWritten ===
        true,

    stateWritten:
      true,

    sourceTrades:
      sourceBundle.counts
        .sourceTrades,

    acceptedTrades:
      sourceBundle.counts
        .acceptedTrades,

    rejectedTrades:
      sourceBundle.counts
        .rejectedTrades,

    duplicateTrades:
      sourceBundle.counts
        .duplicateTrades,

    warnings:
      uniqueSortedStrings(
        warnings
      ),

    error:
      null
  };

  return nextState;

}

function failEnrichmentRun({
  state,
  runAt,
  error,
  warnings = []
}) {

  const nextState =
    cloneJSONCompatible(
      state
    );

  nextState.updatedAt =
    runAt;

  nextState.lastRunAt =
    runAt;

  nextState.counters
    .failedRuns +=
      1;

  nextState.lastRun = {
    status:
      "FAILED",

    startedAt:
      state.lastRun
        ?.startedAt ||
      runAt,

    completedAt:
      runAt,

    sourceChanged:
      false,

    outputChanged:
      false,

    outputWritten:
      false,

    stateWritten:
      true,

    sourceTrades:
      0,

    acceptedTrades:
      0,

    rejectedTrades:
      0,

    duplicateTrades:
      0,

    warnings:
      uniqueSortedStrings(
        warnings
      ),

    error:
      error instanceof
        Error
        ? error.message
        : String(
            error
          )
  };

  return nextState;

}

/* =====================================================================
   Main Learning Enrichment Worker
   ===================================================================== */

function runLearningEnrichment() {

  const runAt =
    new Date().toISOString();

  const runtimeWarnings =
    [];

  let outputWritten =
    false;

  let stateWritten =
    false;

  const stateLoad =
    loadEnrichmentState(
      runAt
    );

  let state =
    beginEnrichmentRun({
      state:
        stateLoad.state,

      runAt
    });

  if (
    stateLoad.warning
  ) {

    runtimeWarnings.push(
      `Enrichment state recovery: ${stateLoad.warning}`
    );

  }

  try {

    const sourceBundle =
      loadEnrichmentSources();

    runtimeWarnings.push(
      ...sourceBundle.warnings
    );

    if (
      !sourceBundle.valid
    ) {

      throw new Error(
        sourceBundle.errors.join(
          " "
        ) ||
        "Learning enrichment source validation failed."
      );

    }

    const generatedOutput =
      buildEnrichmentDocument({
        sourceBundle,
        generatedAt:
          runAt
      });

    if (
      generatedOutput
        ?.validation
        ?.valid !==
        true
    ) {

      throw new Error(
        generatedOutput
          ?.validation
          ?.errors
          ?.join(
            " "
          ) ||
        "Generated learning enrichment output failed validation."
      );

    }

    runtimeWarnings.push(
      ...(
        generatedOutput
          .validation
          .warnings ||
        []
      )
    );

    const existingOutput =
      readExistingEnrichmentOutput();

    if (
      existingOutput.exists &&
      !existingOutput.valid &&
      existingOutput.error
    ) {

      runtimeWarnings.push(
        (
          "Existing enrichment output will be replaced: " +
          existingOutput.error
        )
      );

    }

    const sourceChanged =
      haveEnrichmentSourcesChanged({
        state,

        learningDataHash:
          sourceBundle
            .sourceHashes
            .learningData,

        confidenceDataHash:
          sourceBundle
            .sourceHashes
            .confidenceData
      });

    const outputChanged =
      hasEnrichmentOutputChanged({
        existingOutput,
        generatedOutput
      });

    const mustWriteOutput =
      (
        !existingOutput.exists ||
        !existingOutput.valid ||
        outputChanged
      );

    let status =
      "UNCHANGED";

    if (
      mustWriteOutput
    ) {

      atomicWriteJSON(
        ENRICHMENT_OUTPUT_PATH,
        generatedOutput
      );

      outputWritten =
        true;

      status =
        "UPDATED";

    }

    const outputHash =
      createFileContentHash(
        ENRICHMENT_OUTPUT_PATH
      );

    if (
      !outputHash
    ) {

      throw new Error(
        "Unable to calculate learning enrichment output hash."
      );

    }

    state =
      completeEnrichmentRun({
        state,
        runAt,
        status,
        sourceChanged,
        outputChanged,
        outputWritten,
        sourceBundle,
        outputHash,
        warnings:
          runtimeWarnings
      });

    const stateValidation =
      validateEnrichmentState(
        state
      );

    if (
      !stateValidation.valid
    ) {

      throw new Error(
        stateValidation.errors.join(
          " "
        ) ||
        "Generated learning enrichment state is invalid."
      );

    }

    atomicWriteJSON(
      ENRICHMENT_STATE_PATH,
      state
    );

    stateWritten =
      true;

    const result = {
      engineName:
        ENGINE_NAME,

      engineVersion:
        ENGINE_VERSION,

      mode:
        ENGINE_MODE,

      status,

      runAt,

      sourceChanged,

      outputChanged,

      outputWritten,

      stateWritten,

      summary:
        cloneJSONCompatible(
          generatedOutput.summary
        ),

      warnings:
        uniqueSortedStrings(
          runtimeWarnings
        )
    };

    console.log(
      `[learning-enrichment] ${result.status}`
    );

    console.log(
      `[learning-enrichment] Mode: ${result.mode}`
    );

    console.log(
      `[learning-enrichment] Source trades: ${result.summary.sourceTrades}`
    );

    console.log(
      `[learning-enrichment] Accepted trades: ${result.summary.acceptedTrades}`
    );

    console.log(
      `[learning-enrichment] Rejected trades: ${result.summary.rejectedTrades}`
    );

    console.log(
      `[learning-enrichment] Duplicate trades: ${result.summary.duplicateTrades}`
    );

    console.log(
      `[learning-enrichment] Output written: ${result.outputWritten}`
    );

    console.log(
      `[learning-enrichment] State written: ${result.stateWritten}`
    );

    if (
      result.warnings.length >
        0
    ) {

      console.warn(
        `[learning-enrichment] Completed with ${result.warnings.length} warning(s).`
      );

    }

    return result;

  } catch (
    error
  ) {

    state =
      failEnrichmentRun({
        state,
        runAt,
        error,
        warnings:
          runtimeWarnings
      });

    try {

      const failedStateValidation =
        validateEnrichmentState(
          state
        );

      if (
        !failedStateValidation.valid
      ) {

        throw new Error(
          failedStateValidation
            .errors
            .join(
              " "
            )
        );

      }

      atomicWriteJSON(
        ENRICHMENT_STATE_PATH,
        state
      );

      stateWritten =
        true;

    } catch (
      stateError
    ) {

      console.error(
        "[learning-enrichment] Unable to persist failed-run state:",
        stateError instanceof
          Error
          ? stateError.message
          : String(
              stateError
            )
      );

    }

    console.error(
      "[learning-enrichment] FAILED"
    );

    console.error(
      `[learning-enrichment] ${
        error instanceof
          Error
          ? error.message
          : String(
              error
            )
      }`
    );

    throw error;

  }

}

/* =====================================================================
   Command-Line Execution
   ===================================================================== */

if (
  require.main ===
    module
) {

  try {

    runLearningEnrichment();

  } catch (
    error
  ) {

    process.exitCode =
      1;

  }

}

/* =====================================================================
   Public Exports
   ===================================================================== */

module.exports = {
  ENGINE_NAME,
  ENGINE_VERSION,
  ENGINE_MODE,

  ROLLING_WINDOWS,
  RECENCY_HALF_LIFE_TRADES,
  CONFIDENCE_BUCKET_SIZE,
  MIN_TREND_SAMPLE_SIZE,
  TREND_SEGMENT_SIZE,
  MAX_SOURCE_TRADES,

  validateLearningSourceDocument,
  validateConfidenceSourceDocument,
  normalizeLearningTrade,
  normalizeLearningTrades,
  normalizeConfidenceSnapshot,
  loadEnrichmentSources,

  calculatePerformanceMetrics,
  buildRollingWindows,
  buildRecencyWeightedMetrics,
  classifyPerformanceTrend,
  buildPerformanceEnrichment,

  buildContextEnrichment,
  buildConfidenceCalibration,
  buildContextCalibration,
  buildContextIntelligence,

  createEmptyEnrichmentDocument,
  validateEnrichmentDocument,
  buildEnrichmentDocument,

  createEmptyEnrichmentState,
  validateEnrichmentState,
  runLearningEnrichment
};
