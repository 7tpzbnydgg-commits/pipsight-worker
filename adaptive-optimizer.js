"use strict";

/**
 * PipSight Pro — Professional Adaptive Optimization Engine
 *
 * Version: 1.0.0
 *
 * Phase A:
 * - Shadow-mode optimization only.
 * - Existing trading decisions are not modified.
 * - Existing engine files are not rewritten.
 * - Existing JSON schemas are not modified.
 * - Existing Telegram, Dashboard, Resolver, Tracker, Learning,
 *   AI Memory, Swing, Intraday, Scalp and Master behavior remains
 *   completely independent from this engine.
 *
 * Purpose:
 * - Read verified performance memory produced by AI Memory.
 * - Evaluate whether sufficient resolved-trade evidence exists.
 * - Produce deterministic and bounded optimization recommendations.
 * - Reject unsupported, malformed or insufficient evidence.
 * - Persist recommendations and optimizer state using atomic writes.
 *
 * Reads:
 *   data/ai-memory.json
 *   data/ai-memory-state.json
 *
 * Writes:
 *   data/adaptive-optimization.json
 *   data/adaptive-optimization-state.json
 *
 * Important:
 * - This engine does not edit source code.
 * - This engine does not call external APIs.
 * - This engine does not generate trading signals.
 * - This engine does not change BUY, SELL or HOLD decisions.
 * - This engine does not change entry, stop-loss or take-profit values.
 * - This engine does not send Telegram notifications.
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
  "PipSight Pro Professional Adaptive Optimization Engine";

const ENGINE_VERSION =
  "1.0.0";

const OPTIMIZATION_SCHEMA_VERSION =
  1;

const STATE_SCHEMA_VERSION =
  1;

/*
 * Shadow mode is intentionally locked for Phase A.
 *
 * Recommendations may be calculated and persisted, but no existing
 * signal or strategy engine consumes them during this phase.
 */
const OPTIMIZER_MODE =
  "shadow";

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

const OPTIMIZATION_OUTPUT_PATH =
  path.join(
    DATA_DIR,
    "adaptive-optimization.json"
  );

const OPTIMIZATION_STATE_PATH =
  path.join(
    DATA_DIR,
    "adaptive-optimization-state.json"
  );

/* =====================================================================
   Production Safety Configuration
   ===================================================================== */

/*
 * An optimization scope becomes eligible only when that exact scope
 * contains at least this many resolved trades.
 *
 * Examples:
 * - Overall scalp scope requires 50 scalp trades.
 * - XAUUSD scope requires 50 XAUUSD trades.
 * - BUY scope requires 50 BUY trades.
 * - XAUUSD::BUY requires 50 trades belonging to that exact combination.
 *
 * Counts from broader scopes are never borrowed for smaller scopes.
 */
const MIN_RESOLVED_TRADES =
  50;

/*
 * Recommendations are deliberately bounded.
 *
 * These values define the optimizer's own recommendation limits only.
 * They do not change any existing engine configuration in shadow mode.
 */
const MAX_CONFIDENCE_RECOMMENDATION =
  4;

const MAX_SINGLE_STEP_CHANGE =
  1;

const MIN_RECOMMENDED_CONFIDENCE =
  50;

const MAX_RECOMMENDED_CONFIDENCE =
  95;

/*
 * The optimizer will never use negative, infinite, NaN or malformed
 * sample counts.
 */
const MAX_REASONABLE_TRADE_COUNT =
  1000000;

/*
 * A recommendation must have usable profitability information.
 *
 * Null profit factor is preserved as unavailable and is never invented.
 */
const MIN_VALID_PROFIT_FACTOR =
  0;

const MAX_REASONABLE_PROFIT_FACTOR =
  1000;

/*
 * Only known production pairs, engines and directions are accepted.
 */
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

const SUPPORTED_TIMEFRAMES =
  new Set([
    "5m",
    "15m",
    "30m",
    "1H",
    "4H",
    "D1"
  ]);

/*
 * These dimensions are accepted only when explicitly present in
 * AI Memory. Missing values are never inferred.
 */
const OPTIONAL_DIMENSIONS =
  Object.freeze([
    "session",
    "pattern",
    "marketRegime"
  ]);

const HASH_ALGORITHM =
  "sha256";

/* =====================================================================
   Generic Type Helpers
   ===================================================================== */

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

function toNonNegativeInteger(
  value
) {

  const number =
    toFiniteNumber(
      value
    );

  if (
    number === null ||
    number < 0 ||
    number >
      MAX_REASONABLE_TRADE_COUNT
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

    const parsed =
      JSON.parse(
        raw
      );

    return {
      ok: true,
      exists: true,
      value: parsed,
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
        )}: ${error.message}`
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
          "[adaptive-optimizer] Unable to remove temporary file:",
          cleanupError.message
        );

      }

    }

    throw error;

  }

}

/* =====================================================================
   Deterministic Serialization and Hashing
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

    const content =
      fs.readFileSync(
        filePath
      );

    return crypto
      .createHash(
        HASH_ALGORITHM
      )
      .update(
        content
      )
      .digest(
        "hex"
      );

  } catch (
    error
  ) {

    console.warn(
      `[adaptive-optimizer] Unable to hash ${path.relative(
        ROOT_DIR,
        filePath
      )}: ${error.message}`
    );

    return null;

  }

}

/* =====================================================================
   Normalization Helpers
   ===================================================================== */

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
    compact === "GOLD"
  ) {

    return "XAUUSD";

  }

  if (
    SUPPORTED_PAIRS.has(
      compact
    )
  ) {

    return compact;

  }

  return null;

}

function normalizeEngine(
  value
) {

  const normalized =
    toTrimmedString(
      value
    ).toLowerCase();

  if (
    SUPPORTED_ENGINES.has(
      normalized
    )
  ) {

    return normalized;

  }

  return null;

}

function normalizeDirection(
  value
) {

  const normalized =
    toTrimmedString(
      value
    ).toUpperCase();

  if (
    SUPPORTED_DIRECTIONS.has(
      normalized
    )
  ) {

    return normalized;

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

  const normalizedMap =
    new Map([
      [
        "5M",
        "5m"
      ],
      [
        "15M",
        "15m"
      ],
      [
        "30M",
        "30m"
      ],
      [
        "1H",
        "1H"
      ],
      [
        "4H",
        "4H"
      ],
      [
        "D1",
        "D1"
      ],
      [
        "1D",
        "D1"
      ]
    ]);

  const normalized =
    normalizedMap.get(
      text.toUpperCase()
    ) || null;

  if (
    normalized &&
    SUPPORTED_TIMEFRAMES.has(
      normalized
    )
  ) {

    return normalized;

  }

  return null;

}

function normalizeOptionalDimension(
  value
) {

  const normalized =
    toNonEmptyStringOrNull(
      value
    );

  if (
    normalized === null
  ) {

    return null;

  }

  return normalized;

}

/
/**
 * Convert one AI Memory performance metric into a strict canonical form.
 *
 * No missing value is invented:
 * - Missing profitFactor remains null.
 * - Missing confidence remains null.
 * - Invalid outcome totals cause rejection.
 * - Rates are accepted only when finite and within 0–100.
 */
function normalizePerformanceMetric(
  value,
  label
) {

  const errors =
    [];

  const warnings =
    [];

  if (
    !isPlainObject(
      value
    )
  ) {

    return {
      valid: false,
      label,
      metric: null,
      errors: [
        `${label} must be a JSON object.`
      ],
      warnings
    };

  }

  const totalTrades =
    toNonNegativeInteger(
      value.totalTrades
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

  if (
    totalTrades === null
  ) {

    errors.push(
      `${label}.totalTrades is invalid.`
    );

  }

  if (
    wins === null
  ) {

    errors.push(
      `${label}.wins is invalid.`
    );

  }

  if (
    losses === null
  ) {

    errors.push(
      `${label}.losses is invalid.`
    );

  }

  if (
    breakevens === null
  ) {

    errors.push(
      `${label}.breakevens is invalid.`
    );

  }

  if (
    errors.length > 0
  ) {

    return {
      valid: false,
      label,
      metric: null,
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

  const outcomeTotal =
    wins +
    losses +
    breakevens;

  if (
    outcomeTotal !==
    totalTrades
  ) {

    errors.push(
      `${label} outcome counts do not equal totalTrades.`
    );

  }

  const winRate =
    clamp(
      value.winRate,
      0,
      100
    );

  const lossRate =
    clamp(
      value.lossRate,
      0,
      100
    );

  const breakevenRate =
    clamp(
      value.breakevenRate,
      0,
      100
    );

  if (
    winRate === null
  ) {

    errors.push(
      `${label}.winRate is invalid.`
    );

  }

  if (
    lossRate === null
  ) {

    errors.push(
      `${label}.lossRate is invalid.`
    );

  }

  if (
    breakevenRate === null
  ) {

    errors.push(
      `${label}.breakevenRate is invalid.`
    );

  }

  if (
    winRate !== null &&
    lossRate !== null &&
    breakevenRate !== null &&
    totalTrades > 0
  ) {

    const rateTotal =
      winRate +
      lossRate +
      breakevenRate;

    if (
      Math.abs(
        rateTotal -
        100
      ) > 0.1
    ) {

      warnings.push(
        `${label} outcome rates do not total approximately 100%.`
      );

    }

  }

  const totalProfitPoints =
    toFiniteNumber(
      value.totalProfitPoints
    );

  const averageProfitPoints =
    toFiniteNumber(
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

  if (
    totalProfitPoints === null
  ) {

    errors.push(
      `${label}.totalProfitPoints is invalid.`
    );

  }

  if (
    averageProfitPoints === null
  ) {

    errors.push(
      `${label}.averageProfitPoints is invalid.`
    );

  }

  if (
    grossProfitPoints === null ||
    grossProfitPoints < 0
  ) {

    errors.push(
      `${label}.grossProfitPoints is invalid.`
    );

  }

  if (
    grossLossPoints === null ||
    grossLossPoints < 0
  ) {

    errors.push(
      `${label}.grossLossPoints is invalid.`
    );

  }

  let profitFactor =
    null;

  if (
    value.profitFactor !== null &&
    value.profitFactor !== undefined
  ) {

    profitFactor =
      clamp(
        value.profitFactor,
        MIN_VALID_PROFIT_FACTOR,
        MAX_REASONABLE_PROFIT_FACTOR
      );

    if (
      profitFactor === null
    ) {

      errors.push(
        `${label}.profitFactor is invalid.`
      );

    }

  }

  const totalResultPercentage =
    toFiniteNumber(
      value.totalResultPercentage
    );

  const averageResultPercentage =
    toFiniteNumber(
      value.averageResultPercentage
    );

  const totalDurationMinutes =
    toFiniteNumber(
      value.totalDurationMinutes
    );

  let averageDurationMinutes =
    null;

  if (
    value.averageDurationMinutes !== null &&
    value.averageDurationMinutes !== undefined
  ) {

    averageDurationMinutes =
      toFiniteNumber(
        value.averageDurationMinutes
      );

    if (
      averageDurationMinutes === null ||
      averageDurationMinutes < 0
    ) {

      errors.push(
        `${label}.averageDurationMinutes is invalid.`
      );

    }

  }

  if (
    totalResultPercentage === null
  ) {

    errors.push(
      `${label}.totalResultPercentage is invalid.`
    );

  }

  if (
    averageResultPercentage === null
  ) {

    errors.push(
      `${label}.averageResultPercentage is invalid.`
    );

  }

  if (
    totalDurationMinutes === null ||
    totalDurationMinutes < 0
  ) {

    errors.push(
      `${label}.totalDurationMinutes is invalid.`
    );

  }

  const firstTradeAt =
    value.firstTradeAt === null
      ? null
      : toISOStringOrNull(
          value.firstTradeAt
        );

  const lastTradeAt =
    value.lastTradeAt === null
      ? null
      : toISOStringOrNull(
          value.lastTradeAt
        );

  if (
    value.firstTradeAt !== null &&
    firstTradeAt === null
  ) {

    errors.push(
      `${label}.firstTradeAt is invalid.`
    );

  }

  if (
    value.lastTradeAt !== null &&
    lastTradeAt === null
  ) {

    errors.push(
      `${label}.lastTradeAt is invalid.`
    );

  }

  if (
    firstTradeAt !== null &&
    lastTradeAt !== null &&
    Date.parse(
      firstTradeAt
    ) >
      Date.parse(
        lastTradeAt
      )
  ) {

    errors.push(
      `${label}.firstTradeAt is later than lastTradeAt.`
    );

  }

  const confidenceResult =
    normalizeMetricConfidence(
      value.confidence,
      `${label}.confidence`
    );

  errors.push(
    ...confidenceResult.errors
  );

  warnings.push(
    ...confidenceResult.warnings
  );

  const learningConfidence =
    normalizeLearningConfidence(
      value.learningConfidence,
      `${label}.learningConfidence`
    );

  errors.push(
    ...learningConfidence.errors
  );

  warnings.push(
    ...learningConfidence.warnings
  );

  if (
    errors.length > 0
  ) {

    return {
      valid: false,
      label,
      metric: null,
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

  return {
    valid: true,
    label,

    metric: {
      totalTrades,
      wins,
      losses,
      breakevens,

      winRate:
        round(
          winRate,
          4
        ),

      lossRate:
        round(
          lossRate,
          4
        ),

      breakevenRate:
        round(
          breakevenRate,
          4
        ),

      totalProfitPoints:
        round(
          totalProfitPoints,
          8
        ),

      averageProfitPoints:
        round(
          averageProfitPoints,
          8
        ),

      grossProfitPoints:
        round(
          grossProfitPoints,
          8
        ),

      grossLossPoints:
        round(
          grossLossPoints,
          8
        ),

      profitFactor:
        profitFactor === null
          ? null
          : round(
              profitFactor,
              4
            ),

      totalResultPercentage:
        round(
          totalResultPercentage,
          8
        ),

      averageResultPercentage:
        round(
          averageResultPercentage,
          8
        ),

      totalDurationMinutes:
        round(
          totalDurationMinutes,
          4
        ),

      averageDurationMinutes:
        averageDurationMinutes === null
          ? null
          : round(
              averageDurationMinutes,
              4
            ),

      firstTradeAt,
      lastTradeAt,

      confidence:
        confidenceResult.value,

      learningConfidence:
        learningConfidence.value
    },

    errors: [],

    warnings:
      uniqueSortedStrings(
        warnings
      )
  };

}

/* =====================================================================
   Confidence Normalization
   ===================================================================== */

function normalizeMetricConfidence(
  value,
  label
) {

  const errors =
    [];

  const warnings =
    [];

  if (
    !isPlainObject(
      value
    )
  ) {

    return {
      valid: false,
      value: null,
      errors: [
        `${label} must be a JSON object.`
      ],
      warnings
    };

  }

  const samples =
    toNonNegativeInteger(
      value.samples
    );

  const total =
    toFiniteNumber(
      value.total
    );

  let average =
    null;

  let minimum =
    null;

  let maximum =
    null;

  if (
    samples === null
  ) {

    errors.push(
      `${label}.samples is invalid.`
    );

  }

  if (
    total === null ||
    total < 0
  ) {

    errors.push(
      `${label}.total is invalid.`
    );

  }

  if (
    value.average !== null &&
    value.average !== undefined
  ) {

    average =
      clamp(
        value.average,
        0,
        100
      );

    if (
      average === null
    ) {

      errors.push(
        `${label}.average is invalid.`
      );

    }

  }

  if (
    value.minimum !== null &&
    value.minimum !== undefined
  ) {

    minimum =
      clamp(
        value.minimum,
        0,
        100
      );

    if (
      minimum === null
    ) {

      errors.push(
        `${label}.minimum is invalid.`
      );

    }

  }

  if (
    value.maximum !== null &&
    value.maximum !== undefined
  ) {

    maximum =
      clamp(
        value.maximum,
        0,
        100
      );

    if (
      maximum === null
    ) {

      errors.push(
        `${label}.maximum is invalid.`
      );

    }

  }

  if (
    samples === 0
  ) {

    if (
      average !== null ||
      minimum !== null ||
      maximum !== null
    ) {

      warnings.push(
        `${label} contains confidence values with zero samples.`
      );

    }

  } else {

    if (
      average === null ||
      minimum === null ||
      maximum === null
    ) {

      errors.push(
        `${label} is incomplete for a non-zero sample count.`
      );

    }

  }

  if (
    minimum !== null &&
    maximum !== null &&
    minimum >
      maximum
  ) {

    errors.push(
      `${label}.minimum exceeds maximum.`
    );

  }

  if (
    average !== null &&
    minimum !== null &&
    average <
      minimum
  ) {

    errors.push(
      `${label}.average is below minimum.`
    );

  }

  if (
    average !== null &&
    maximum !== null &&
    average >
      maximum
  ) {

    errors.push(
      `${label}.average exceeds maximum.`
    );

  }

  if (
    errors.length > 0
  ) {

    return {
      valid: false,
      value: null,
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

  return {
    valid: true,

    value: {
      samples,

      total:
        round(
          total,
          4
        ),

      average:
        average === null
          ? null
          : round(
              average,
              4
            ),

      minimum:
        minimum === null
          ? null
          : round(
              minimum,
              4
            ),

      maximum:
        maximum === null
          ? null
          : round(
              maximum,
              4
            )
    },

    errors: [],

    warnings:
      uniqueSortedStrings(
        warnings
      )
  };

}

/**
 * AI Memory attaches learningConfidence only where confidence-data.json
 * supports that dimension.
 *
 * Therefore:
 * - null is valid;
 * - a present object must strictly match the confirmed overlay fields;
 * - missing values are never inferred.
 */
function normalizeLearningConfidence(
  value,
  label
) {

  const errors =
    [];

  const warnings =
    [];

  if (
    value === null ||
    value === undefined
  ) {

    return {
      valid: true,
      value: null,
      errors,
      warnings
    };

  }

  if (
    !isPlainObject(
      value
    )
  ) {

    return {
      valid: false,
      value: null,
      errors: [
        `${label} must be null or a JSON object.`
      ],
      warnings
    };

  }

  const confidence =
    clamp(
      value.confidence,
      0,
      100
    );

  const total =
    toNonNegativeInteger(
      value.total
    );

  const resolved =
    toNonNegativeInteger(
      value.resolved
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
    clamp(
      value.winRate,
      0,
      100
    );

  const averageProfitPoints =
    toFiniteNumber(
      value.averageProfitPoints
    );

  let profitFactor =
    null;

  if (
    value.profitFactor !== null &&
    value.profitFactor !== undefined
  ) {

    profitFactor =
      clamp(
        value.profitFactor,
        MIN_VALID_PROFIT_FACTOR,
        MAX_REASONABLE_PROFIT_FACTOR
      );

  }

  if (
    confidence === null
  ) {

    errors.push(
      `${label}.confidence is invalid.`
    );

  }

  if (
    total === null
  ) {

    errors.push(
      `${label}.total is invalid.`
    );

  }

  if (
    resolved === null
  ) {

    errors.push(
      `${label}.resolved is invalid.`
    );

  }

  if (
    wins === null
  ) {

    errors.push(
      `${label}.wins is invalid.`
    );

  }

  if (
    losses === null
  ) {

    errors.push(
      `${label}.losses is invalid.`
    );

  }

  if (
    breakevens === null
  ) {

    errors.push(
      `${label}.breakevens is invalid.`
    );

  }

  if (
    winRate === null
  ) {

    errors.push(
      `${label}.winRate is invalid.`
    );

  }

  if (
    averageProfitPoints === null
  ) {

    errors.push(
      `${label}.averageProfitPoints is invalid.`
    );

  }

  if (
    value.profitFactor !== null &&
    value.profitFactor !== undefined &&
    profitFactor === null
  ) {

    errors.push(
      `${label}.profitFactor is invalid.`
    );

  }

  if (
    resolved !== null &&
    wins !== null &&
    losses !== null &&
    breakevens !== null &&
    (
      wins +
      losses +
      breakevens
    ) !==
      resolved
  ) {

    errors.push(
      `${label} outcome counts do not equal resolved.`
    );

  }

  if (
    total !== null &&
    resolved !== null &&
    resolved >
      total
  ) {

    errors.push(
      `${label}.resolved exceeds total.`
    );

  }

  if (
    errors.length > 0
  ) {

    return {
      valid: false,
      value: null,
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

  return {
    valid: true,

    value: {
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
        profitFactor === null
          ? null
          : round(
              profitFactor,
              4
            )
    },

    errors: [],

    warnings:
      uniqueSortedStrings(
        warnings
      )
  };

}

/* =====================================================================
   Dimension Map Validation
   ===================================================================== */

function normalizeDimensionMap(
  value,
  label,
  keyNormalizer = null
) {

  const normalized =
    {};

  const errors =
    [];

  const warnings =
    [];

  if (
    !isPlainObject(
      value
    )
  ) {

    return {
      valid: false,
      value: {},
      accepted: 0,
      rejected: 0,
      errors: [
        `${label} must be a JSON object.`
      ],
      warnings
    };

  }

  let accepted =
    0;

  let rejected =
    0;

  for (
    const sourceKey of Object.keys(
      value
    ).sort()
  ) {

    const targetKey =
      typeof keyNormalizer ===
      "function"
        ? keyNormalizer(
            sourceKey
          )
        : toNonEmptyStringOrNull(
            sourceKey
          );

    if (
      targetKey === null
    ) {

      rejected +=
        1;

      warnings.push(
        `${label}.${sourceKey} has an unsupported key.`
      );

      continue;

    }

    const metricResult =
      normalizePerformanceMetric(
        value[sourceKey],
        `${label}.${targetKey}`
      );

    warnings.push(
      ...metricResult.warnings
    );

    if (
      !metricResult.valid
    ) {

      rejected +=
        1;

      errors.push(
        ...metricResult.errors
      );

      continue;

    }

    if (
      Object.prototype.hasOwnProperty.call(
        normalized,
        targetKey
      )
    ) {

      rejected +=
        1;

      errors.push(
        `${label} contains duplicate normalized key: ${targetKey}.`
      );

      continue;

    }

    normalized[targetKey] =
      metricResult.metric;

    accepted +=
      1;

  }

  return {
    valid:
      errors.length === 0,

    value:
      sortForStableSerialization(
        normalized
      ),

    accepted,
    rejected,

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
   Combination-Key Normalization
   ===================================================================== */

function splitCombinationKey(
  value,
  expectedParts
) {

  const text =
    toTrimmedString(
      value
    );

  if (
    !text
  ) {

    return null;

  }

  const parts =
    text
      .split(
        "::"
      )
      .map(
        part =>
          toTrimmedString(
            part
          )
      );

  if (
    parts.length !==
      expectedParts ||
    parts.some(
      part =>
        !part
    )
  ) {

    return null;

  }

  return parts;

}

function normalizePairEngineKey(
  value
) {

  const parts =
    splitCombinationKey(
      value,
      2
    );

  if (
    !parts
  ) {

    return null;

  }

  const pair =
    normalizePair(
      parts[0]
    );

  const engine =
    normalizeEngine(
      parts[1]
    );

  if (
    !pair ||
    !engine
  ) {

    return null;

  }

  return `${pair}::${engine}`;

}

function normalizePairDirectionKey(
  value
) {

  const parts =
    splitCombinationKey(
      value,
      2
    );

  if (
    !parts
  ) {

    return null;

  }

  const pair =
    normalizePair(
      parts[0]
    );

  const direction =
    normalizeDirection(
      parts[1]
    );

  if (
    !pair ||
    !direction
  ) {

    return null;

  }

  return `${pair}::${direction}`;

}

function normalizeEngineDirectionKey(
  value
) {

  const parts =
    splitCombinationKey(
      value,
      2
    );

  if (
    !parts
  ) {

    return null;

  }

  const engine =
    normalizeEngine(
      parts[0]
    );

  const direction =
    normalizeDirection(
      parts[1]
    );

  if (
    !engine ||
    !direction
  ) {

    return null;

  }

  return `${engine}::${direction}`;

}

function normalizePairEngineDirectionKey(
  value
) {

  const parts =
    splitCombinationKey(
      value,
      3
    );

  if (
    !parts
  ) {

    return null;

  }

  const pair =
    normalizePair(
      parts[0]
    );

  const engine =
    normalizeEngine(
      parts[1]
    );

  const direction =
    normalizeDirection(
      parts[2]
    );

  if (
    !pair ||
    !engine ||
    !direction
  ) {

    return null;

  }

  return (
    `${pair}::` +
    `${engine}::` +
    `${direction}`
  );

}

function normalizePairOptionalKey(
  value
) {

  const parts =
    splitCombinationKey(
      value,
      2
    );

  if (
    !parts
  ) {

    return null;

  }

  const pair =
    normalizePair(
      parts[0]
    );

  const optionalValue =
    normalizeOptionalDimension(
      parts[1]
    );

  if (
    !pair ||
    !optionalValue
  ) {

    return null;

  }

  return `${pair}::${optionalValue}`;

}

/* =====================================================================
   Coverage Normalization
   ===================================================================== */

function normalizeCoverageCounter(
  value,
  label
) {

  if (
    !isPlainObject(
      value
    )
  ) {

    return {
      valid: false,
      value: null,
      errors: [
        `${label} must be a JSON object.`
      ]
    };

  }

  const available =
    toNonNegativeInteger(
      value.available
    );

  const missing =
    toNonNegativeInteger(
      value.missing
    );

  const errors =
    [];

  if (
    available === null
  ) {

    errors.push(
      `${label}.available is invalid.`
    );

  }

  if (
    missing === null
  ) {

    errors.push(
      `${label}.missing is invalid.`
    );

  }

  if (
    errors.length > 0
  ) {

    return {
      valid: false,
      value: null,
      errors:
        uniqueSortedStrings(
          errors
        )
    };

  }

  return {
    valid: true,
    value: {
      available,
      missing
    },
    errors: []
  };

}

function normalizeCoverage(
  value
) {

  const errors =
    [];

  if (
    !isPlainObject(
      value
    )
  ) {

    return {
      valid: false,
      value: null,
      errors: [
        "AI Memory coverage must be a JSON object."
      ]
    };

  }

  const totalAcceptedTrades =
    toNonNegativeInteger(
      value.totalAcceptedTrades
    );

  if (
    totalAcceptedTrades === null
  ) {

    errors.push(
      "AI Memory coverage.totalAcceptedTrades is invalid."
    );

  }

  const dimensionNames =
    [
      "pairs",
      "engines",
      "directions",
      "timeframes",
      "sessions",
      "patterns",
      "marketRegimes"
    ];

  const normalized =
    {
      totalAcceptedTrades:
        totalAcceptedTrades === null
          ? 0
          : totalAcceptedTrades
    };

  for (
    const dimensionName of
    dimensionNames
  ) {

    const counterResult =
      normalizeCoverageCounter(
        value[dimensionName],
        `AI Memory coverage.${dimensionName}`
      );

    errors.push(
      ...counterResult.errors
    );

    normalized[dimensionName] =
      counterResult.value || {
        available: 0,
        missing: 0
      };

    if (
      counterResult.valid &&
      totalAcceptedTrades !== null &&
      (
        counterResult.value.available +
        counterResult.value.missing
      ) !==
        totalAcceptedTrades
    ) {

      errors.push(
        `AI Memory coverage.${dimensionName} total does not equal totalAcceptedTrades.`
      );

    }

  }

  return {
    valid:
      errors.length === 0,

    value:
      errors.length === 0
        ? normalized
        : null,

    errors:
      uniqueSortedStrings(
        errors
      )
  };

}

/* =====================================================================
   AI Memory Document Validation
   ===================================================================== */

function normalizeAIMemoryDocument(
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
      value: null,
      errors: [
        "AI Memory document must be a JSON object."
      ],
      warnings
    };

  }

  if (
    document.version !==
      1
  ) {

    errors.push(
      "AI Memory schema version is unsupported."
    );

  }

  const generatedAt =
    toISOStringOrNull(
      document.generatedAt
    );

  const sourceUpdatedAt =
    document.sourceUpdatedAt === null
      ? null
      : toISOStringOrNull(
          document.sourceUpdatedAt
        );

  if (
    generatedAt === null
  ) {

    errors.push(
      "AI Memory generatedAt is invalid."
    );

  }

  if (
    document.sourceUpdatedAt !== null &&
    sourceUpdatedAt === null
  ) {

    errors.push(
      "AI Memory sourceUpdatedAt is invalid."
    );

  }

  const summaryResult =
    normalizePerformanceMetric(
      document.summary,
      "AI Memory summary"
    );

  errors.push(
    ...summaryResult.errors
  );

  warnings.push(
    ...summaryResult.warnings
  );

  const memoryRoot =
    isPlainObject(
      document.memory
    )
      ? document.memory
      : null;

  if (
    memoryRoot === null
  ) {

    errors.push(
      "AI Memory memory section must be a JSON object."
    );

  }

  const pairResult =
    normalizeDimensionMap(
      memoryRoot?.pairs,
      "AI Memory memory.pairs",
      normalizePair
    );

  const engineResult =
    normalizeDimensionMap(
      memoryRoot?.engines,
      "AI Memory memory.engines",
      normalizeEngine
    );

  const directionResult =
    normalizeDimensionMap(
      memoryRoot?.directions,
      "AI Memory memory.directions",
      normalizeDirection
    );

  const timeframeResult =
    normalizeDimensionMap(
      memoryRoot?.timeframes,
      "AI Memory memory.timeframes",
      normalizeTimeframe
    );

  const sessionResult =
    normalizeDimensionMap(
      memoryRoot?.sessions,
      "AI Memory memory.sessions",
      normalizeOptionalDimension
    );

  const patternResult =
    normalizeDimensionMap(
      memoryRoot?.patterns,
      "AI Memory memory.patterns",
      normalizeOptionalDimension
    );

  const marketRegimeResult =
    normalizeDimensionMap(
      memoryRoot?.marketRegimes,
      "AI Memory memory.marketRegimes",
      normalizeOptionalDimension
    );

  const dimensionResults =
    [
      pairResult,
      engineResult,
      directionResult,
      timeframeResult,
      sessionResult,
      patternResult,
      marketRegimeResult
    ];

  for (
    const result of
    dimensionResults
  ) {

    errors.push(
      ...result.errors
    );

    warnings.push(
      ...result.warnings
    );

  }

  const combinationsRoot =
    isPlainObject(
      document.combinations
    )
      ? document.combinations
      : null;

  if (
    combinationsRoot === null
  ) {

    errors.push(
      "AI Memory combinations section must be a JSON object."
    );

  }

  const pairEngineResult =
    normalizeDimensionMap(
      combinationsRoot?.pairEngine,
      "AI Memory combinations.pairEngine",
      normalizePairEngineKey
    );

  const pairDirectionResult =
    normalizeDimensionMap(
      combinationsRoot?.pairDirection,
      "AI Memory combinations.pairDirection",
      normalizePairDirectionKey
    );

  const engineDirectionResult =
    normalizeDimensionMap(
      combinationsRoot?.engineDirection,
      "AI Memory combinations.engineDirection",
      normalizeEngineDirectionKey
    );

  const pairEngineDirectionResult =
    normalizeDimensionMap(
      combinationsRoot?.pairEngineDirection,
      "AI Memory combinations.pairEngineDirection",
      normalizePairEngineDirectionKey
    );

  const pairSessionResult =
    normalizeDimensionMap(
      combinationsRoot?.pairSession,
      "AI Memory combinations.pairSession",
      normalizePairOptionalKey
    );

  const pairPatternResult =
    normalizeDimensionMap(
      combinationsRoot?.pairPattern,
      "AI Memory combinations.pairPattern",
      normalizePairOptionalKey
    );

  const pairMarketRegimeResult =
    normalizeDimensionMap(
      combinationsRoot?.pairMarketRegime,
      "AI Memory combinations.pairMarketRegime",
      normalizePairOptionalKey
    );

  const combinationResults =
    [
      pairEngineResult,
      pairDirectionResult,
      engineDirectionResult,
      pairEngineDirectionResult,
      pairSessionResult,
      pairPatternResult,
      pairMarketRegimeResult
    ];

  for (
    const result of
    combinationResults
  ) {

    errors.push(
      ...result.errors
    );

    warnings.push(
      ...result.warnings
    );

  }

  const coverageResult =
    normalizeCoverage(
      document.coverage
    );

  errors.push(
    ...coverageResult.errors
  );

  if (
    errors.length > 0
  ) {

    return {
      valid: false,
      value: null,

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

  return {
    valid: true,

    value: {
      version:
        document.version,

      engineName:
        toNonEmptyStringOrNull(
          document.engineName
        ),

      engineVersion:
        toNonEmptyStringOrNull(
          document.engineVersion
        ),

      generatedAt,
      sourceUpdatedAt,

      summary:
        summaryResult.metric,

      memory: {
        pairs:
          pairResult.value,

        engines:
          engineResult.value,

        directions:
          directionResult.value,

        timeframes:
          timeframeResult.value,

        sessions:
          sessionResult.value,

        patterns:
          patternResult.value,

        marketRegimes:
          marketRegimeResult.value
      },

      combinations: {
        pairEngine:
          pairEngineResult.value,

        pairDirection:
          pairDirectionResult.value,

        engineDirection:
          engineDirectionResult.value,

        pairEngineDirection:
          pairEngineDirectionResult.value,

        pairSession:
          pairSessionResult.value,

        pairPattern:
          pairPatternResult.value,

        pairMarketRegime:
          pairMarketRegimeResult.value
      },

      coverage:
        coverageResult.value,

      source:
        isPlainObject(
          document.source
        )
          ? cloneJSONCompatible(
              document.source
            )
          : null,

      validation:
        isPlainObject(
          document.validation
        )
          ? cloneJSONCompatible(
              document.validation
            )
          : null,

      metadata:
        isPlainObject(
          document.metadata
        )
          ? cloneJSONCompatible(
              document.metadata
            )
          : null
    },

    errors: [],

    warnings:
      uniqueSortedStrings(
        warnings
      )
  };

}

/* =====================================================================
   Part 2 Complete
   ===================================================================== */
