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
