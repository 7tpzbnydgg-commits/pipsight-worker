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
   Optimization Scope Constants
   ===================================================================== */

const OPTIMIZATION_SCOPE_TYPES =
  Object.freeze([
    "overall",
    "pair",
    "engine",
    "direction",
    "timeframe",
    "pairEngine",
    "pairDirection",
    "engineDirection",
    "pairEngineDirection",
    "pairSession",
    "pairPattern",
    "pairMarketRegime"
  ]);

const OPTIMIZATION_STATUSES =
  Object.freeze({
    ELIGIBLE:
      "ELIGIBLE",

    INSUFFICIENT_DATA:
      "INSUFFICIENT_DATA",

    INVALID_METRIC:
      "INVALID_METRIC",

    MISSING_PROFITABILITY:
      "MISSING_PROFITABILITY",

    NEUTRAL:
      "NEUTRAL",

    SUPPORTIVE:
      "SUPPORTIVE",

    CAUTION:
      "CAUTION"
  });

/*
 * Conservative profitability zones.
 *
 * These thresholds create shadow recommendations only.
 * Existing engine confidence or decision logic is not changed.
 */
const PROFIT_FACTOR_STRONG =
  1.25;

const PROFIT_FACTOR_POSITIVE =
  1.05;

const PROFIT_FACTOR_CAUTION =
  0.90;

const WIN_RATE_STRONG =
  40;

const WIN_RATE_POSITIVE =
  30;

const WIN_RATE_CAUTION =
  20;

/*
 * A scope must have a usable confidence baseline before a confidence
 * recommendation can be produced.
 *
 * Preferred source:
 *   learningConfidence.confidence
 *
 * Fallback source:
 *   confidence.average
 *
 * If neither exists, the optimizer records the performance assessment
 * but produces no target confidence.
 */
const CONFIDENCE_BASELINE_SOURCES =
  Object.freeze([
    "learningConfidence.confidence",
    "confidence.average"
  ]);

/* =====================================================================
   Optimization Scope Helpers
   ===================================================================== */

function isSupportedScopeType(
  value
) {

  return (
    typeof value ===
      "string" &&
    OPTIMIZATION_SCOPE_TYPES.includes(
      value
    )
  );

}

function createScopeIdentity({
  type,
  key,
  pair = null,
  engine = null,
  direction = null,
  timeframe = null,
  session = null,
  pattern = null,
  marketRegime = null
}) {

  const normalizedType =
    isSupportedScopeType(
      type
    )
      ? type
      : null;

  const normalizedKey =
    toNonEmptyStringOrNull(
      key
    );

  if (
    normalizedType === null ||
    normalizedKey === null
  ) {

    return null;

  }

  return {
    type:
      normalizedType,

    key:
      normalizedKey,

    pair:
      pair === null
        ? null
        : normalizePair(
            pair
          ),

    engine:
      engine === null
        ? null
        : normalizeEngine(
            engine
          ),

    direction:
      direction === null
        ? null
        : normalizeDirection(
            direction
          ),

    timeframe:
      timeframe === null
        ? null
        : normalizeTimeframe(
            timeframe
          ),

    session:
      session === null
        ? null
        : normalizeOptionalDimension(
            session
          ),

    pattern:
      pattern === null
        ? null
        : normalizeOptionalDimension(
            pattern
          ),

    marketRegime:
      marketRegime === null
        ? null
        : normalizeOptionalDimension(
            marketRegime
          )
  };

}

/* =====================================================================
   Confidence Baseline Selection
   ===================================================================== */

function getConfidenceBaseline(
  metric
) {

  if (
    !isPlainObject(
      metric
    )
  ) {

    return {
      available: false,
      value: null,
      source: null
    };

  }

  const learningConfidence =
    metric.learningConfidence;

  if (
    isPlainObject(
      learningConfidence
    )
  ) {

    const value =
      clamp(
        learningConfidence.confidence,
        MIN_RECOMMENDED_CONFIDENCE,
        MAX_RECOMMENDED_CONFIDENCE
      );

    if (
      value !== null
    ) {

      return {
        available: true,

        value:
          round(
            value,
            4
          ),

        source:
          "learningConfidence.confidence"
      };

    }

  }

  const metricConfidence =
    metric.confidence;

  if (
    isPlainObject(
      metricConfidence
    )
  ) {

    const value =
      clamp(
        metricConfidence.average,
        MIN_RECOMMENDED_CONFIDENCE,
        MAX_RECOMMENDED_CONFIDENCE
      );

    if (
      value !== null
    ) {

      return {
        available: true,

        value:
          round(
            value,
            4
          ),

        source:
          "confidence.average"
      };

    }

  }

  return {
    available: false,
    value: null,
    source: null
  };

}

/* =====================================================================
   Exact-Scope Eligibility
   ===================================================================== */

function evaluateScopeEligibility(
  metric
) {

  const reasons =
    [];

  if (
    !isPlainObject(
      metric
    )
  ) {

    return {
      eligible: false,

      status:
        OPTIMIZATION_STATUSES
          .INVALID_METRIC,

      totalTrades: 0,

      requiredTrades:
        MIN_RESOLVED_TRADES,

      remainingTrades:
        MIN_RESOLVED_TRADES,

      reasons: [
        "Performance metric is unavailable or invalid."
      ]
    };

  }

  const totalTrades =
    toNonNegativeInteger(
      metric.totalTrades
    );

  if (
    totalTrades === null
  ) {

    return {
      eligible: false,

      status:
        OPTIMIZATION_STATUSES
          .INVALID_METRIC,

      totalTrades: 0,

      requiredTrades:
        MIN_RESOLVED_TRADES,

      remainingTrades:
        MIN_RESOLVED_TRADES,

      reasons: [
        "Resolved-trade count is invalid."
      ]
    };

  }

  const remainingTrades =
    Math.max(
      0,
      MIN_RESOLVED_TRADES -
        totalTrades
    );

  if (
    totalTrades <
      MIN_RESOLVED_TRADES
  ) {

    reasons.push(
      `Exact scope has ${totalTrades} resolved trades; ` +
      `${MIN_RESOLVED_TRADES} are required.`
    );

    return {
      eligible: false,

      status:
        OPTIMIZATION_STATUSES
          .INSUFFICIENT_DATA,

      totalTrades,

      requiredTrades:
        MIN_RESOLVED_TRADES,

      remainingTrades,

      reasons
    };

  }

  const profitFactor =
    toFiniteNumber(
      metric.profitFactor
    );

  const averageProfitPoints =
    toFiniteNumber(
      metric.averageProfitPoints
    );

  if (
    profitFactor === null ||
    averageProfitPoints === null
  ) {

    reasons.push(
      "Profitability evidence is incomplete."
    );

    return {
      eligible: false,

      status:
        OPTIMIZATION_STATUSES
          .MISSING_PROFITABILITY,

      totalTrades,

      requiredTrades:
        MIN_RESOLVED_TRADES,

      remainingTrades: 0,

      reasons
    };

  }

  return {
    eligible: true,

    status:
      OPTIMIZATION_STATUSES
        .ELIGIBLE,

    totalTrades,

    requiredTrades:
      MIN_RESOLVED_TRADES,

    remainingTrades: 0,

    reasons: [
      "Minimum exact-scope sample and profitability evidence are available."
    ]
  };

}

/* =====================================================================
   Profitability Assessment
   ===================================================================== */

function evaluateProfitabilityEvidence(
  metric
) {

  const profitFactor =
    toFiniteNumber(
      metric?.profitFactor
    );

  const winRate =
    clamp(
      metric?.winRate,
      0,
      100
    );

  const averageProfitPoints =
    toFiniteNumber(
      metric?.averageProfitPoints
    );

  const totalProfitPoints =
    toFiniteNumber(
      metric?.totalProfitPoints
    );

  if (
    profitFactor === null ||
    winRate === null ||
    averageProfitPoints === null ||
    totalProfitPoints === null
  ) {

    return {
      valid: false,

      classification:
        OPTIMIZATION_STATUSES
          .MISSING_PROFITABILITY,

      score: 0,

      signals: [],

      reasons: [
        "Required profitability fields are unavailable."
      ]
    };

  }

  const signals =
    [];

  let score =
    0;

  /*
   * Profit factor evidence.
   */
  if (
    profitFactor >=
      PROFIT_FACTOR_STRONG
  ) {

    score +=
      2;

    signals.push(
      "STRONG_PROFIT_FACTOR"
    );

  } else if (
    profitFactor >=
      PROFIT_FACTOR_POSITIVE
  ) {

    score +=
      1;

    signals.push(
      "POSITIVE_PROFIT_FACTOR"
    );

  } else if (
    profitFactor <
      PROFIT_FACTOR_CAUTION
  ) {

    score -=
      2;

    signals.push(
      "WEAK_PROFIT_FACTOR"
    );

  } else {

    signals.push(
      "NEUTRAL_PROFIT_FACTOR"
    );

  }

  /*
   * Average realized points evidence.
   */
  if (
    averageProfitPoints >
      0
  ) {

    score +=
      1;

    signals.push(
      "POSITIVE_AVERAGE_POINTS"
    );

  } else if (
    averageProfitPoints <
      0
  ) {

    score -=
      1;

    signals.push(
      "NEGATIVE_AVERAGE_POINTS"
    );

  } else {

    signals.push(
      "FLAT_AVERAGE_POINTS"
    );

  }

  /*
   * Cumulative realized points evidence.
   */
  if (
    totalProfitPoints >
      0
  ) {

    score +=
      1;

    signals.push(
      "POSITIVE_TOTAL_POINTS"
    );

  } else if (
    totalProfitPoints <
      0
  ) {

    score -=
      1;

    signals.push(
      "NEGATIVE_TOTAL_POINTS"
    );

  } else {

    signals.push(
      "FLAT_TOTAL_POINTS"
    );

  }

  /*
   * Win rate is supporting evidence only.
   *
   * A lower win rate can still be profitable when reward-to-risk is
   * strong, therefore win rate is not used alone to reject a scope.
   */
  if (
    winRate >=
      WIN_RATE_STRONG
  ) {

    score +=
      1;

    signals.push(
      "STRONG_WIN_RATE"
    );

  } else if (
    winRate >=
      WIN_RATE_POSITIVE
  ) {

    signals.push(
      "ACCEPTABLE_WIN_RATE"
    );

  } else if (
    winRate <
      WIN_RATE_CAUTION
  ) {

    score -=
      1;

    signals.push(
      "LOW_WIN_RATE"
    );

  } else {

    signals.push(
      "CAUTION_WIN_RATE"
    );

  }

  let classification =
    OPTIMIZATION_STATUSES
      .NEUTRAL;

  if (
    score >=
      2
  ) {

    classification =
      OPTIMIZATION_STATUSES
        .SUPPORTIVE;

  } else if (
    score <=
      -2
  ) {

    classification =
      OPTIMIZATION_STATUSES
        .CAUTION;

  }

  const reasons =
    [];

  if (
    classification ===
      OPTIMIZATION_STATUSES
        .SUPPORTIVE
  ) {

    reasons.push(
      "The exact scope has positive realized profitability evidence."
    );

  } else if (
    classification ===
      OPTIMIZATION_STATUSES
        .CAUTION
  ) {

    reasons.push(
      "The exact scope has weak or negative realized profitability evidence."
    );

  } else {

    reasons.push(
      "The exact scope does not have sufficiently strong positive or negative evidence."
    );

  }

  return {
    valid: true,

    classification,

    score,

    signals:
      uniqueSortedStrings(
        signals
      ),

    reasons,

    metrics: {
      profitFactor:
        round(
          profitFactor,
          4
        ),

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

      totalProfitPoints:
        round(
          totalProfitPoints,
          8
        )
    }
  };

}

/* =====================================================================
   Bounded Confidence Recommendation
   ===================================================================== */

function calculateConfidenceAdjustment(
  profitabilityAssessment
) {

  if (
    !isPlainObject(
      profitabilityAssessment
    ) ||
    profitabilityAssessment.valid !==
      true
  ) {

    return 0;

  }

  let requestedAdjustment =
    0;

  if (
    profitabilityAssessment.classification ===
      OPTIMIZATION_STATUSES
        .SUPPORTIVE
  ) {

    requestedAdjustment =
      1;

  } else if (
    profitabilityAssessment.classification ===
      OPTIMIZATION_STATUSES
        .CAUTION
  ) {

    requestedAdjustment =
      -1;

  }

  return clamp(
    requestedAdjustment,
    -MAX_SINGLE_STEP_CHANGE,
    MAX_SINGLE_STEP_CHANGE
  ) || 0;

}

function buildConfidenceRecommendation({
  metric,
  profitabilityAssessment
}) {

  const baseline =
    getConfidenceBaseline(
      metric
    );

  const adjustment =
    calculateConfidenceAdjustment(
      profitabilityAssessment
    );

  if (
    !baseline.available
  ) {

    return {
      available: false,

      baseline: null,

      baselineSource: null,

      requestedAdjustment:
        adjustment,

      boundedAdjustment: 0,

      recommendedConfidence: null,

      reasons: [
        "No supported confidence baseline is available for this scope."
      ]
    };

  }

  const globallyBoundedAdjustment =
    clamp(
      adjustment,
      -MAX_CONFIDENCE_RECOMMENDATION,
      MAX_CONFIDENCE_RECOMMENDATION
    ) || 0;

  const stepBoundedAdjustment =
    clamp(
      globallyBoundedAdjustment,
      -MAX_SINGLE_STEP_CHANGE,
      MAX_SINGLE_STEP_CHANGE
    ) || 0;

  const recommendedConfidence =
    clamp(
      baseline.value +
        stepBoundedAdjustment,
      MIN_RECOMMENDED_CONFIDENCE,
      MAX_RECOMMENDED_CONFIDENCE
    );

  return {
    available: true,

    baseline:
      baseline.value,

    baselineSource:
      baseline.source,

    requestedAdjustment:
      adjustment,

    boundedAdjustment:
      round(
        stepBoundedAdjustment,
        4
      ),

    recommendedConfidence:
      round(
        recommendedConfidence,
        4
      ),

    reasons: [
      (
        stepBoundedAdjustment === 0
          ? "No confidence change is recommended."
          : (
              `A bounded shadow confidence change of ` +
              `${stepBoundedAdjustment > 0 ? "+" : ""}` +
              `${stepBoundedAdjustment} is recommended.`
            )
      )
    ]
  };

}

/* =====================================================================
   Single-Scope Recommendation Builder
   ===================================================================== */

function buildScopeRecommendation({
  scope,
  metric
}) {

  const normalizedScope =
    createScopeIdentity(
      scope
    );

  if (
    normalizedScope === null
  ) {

    return {
      valid: false,

      scope: null,

      eligibility: {
        eligible: false,

        status:
          OPTIMIZATION_STATUSES
            .INVALID_METRIC,

        totalTrades: 0,

        requiredTrades:
          MIN_RESOLVED_TRADES,

        remainingTrades:
          MIN_RESOLVED_TRADES,

        reasons: [
          "Optimization scope identity is invalid."
        ]
      },

      profitability: null,

      confidenceRecommendation: null,

      shadowOnly: true,

      errors: [
        "Optimization scope identity is invalid."
      ],

      warnings: []
    };

  }

  const eligibility =
    evaluateScopeEligibility(
      metric
    );

  if (
    !eligibility.eligible
  ) {

    return {
      valid: true,

      scope:
        normalizedScope,

      eligibility,

      profitability: null,

      confidenceRecommendation: {
        available: false,

        baseline: null,

        baselineSource: null,

        requestedAdjustment: 0,

        boundedAdjustment: 0,

        recommendedConfidence: null,

        reasons: [
          "No optimization recommendation is produced for an ineligible scope."
        ]
      },

      shadowOnly: true,

      errors: [],

      warnings: []
    };

  }

  const profitability =
    evaluateProfitabilityEvidence(
      metric
    );

  if (
    !profitability.valid
  ) {

    return {
      valid: true,

      scope:
        normalizedScope,

      eligibility,

      profitability,

      confidenceRecommendation: {
        available: false,

        baseline: null,

        baselineSource: null,

        requestedAdjustment: 0,

        boundedAdjustment: 0,

        recommendedConfidence: null,

        reasons: [
          "Profitability evidence is incomplete."
        ]
      },

      shadowOnly: true,

      errors: [],

      warnings:
        profitability.reasons
    };

  }

  const confidenceRecommendation =
    buildConfidenceRecommendation({
      metric,
      profitabilityAssessment:
        profitability
    });

  return {
    valid: true,

    scope:
      normalizedScope,

    eligibility,

    profitability,

    confidenceRecommendation,

    shadowOnly: true,

    errors: [],

    warnings: []
  };

}

/* =====================================================================
   Recommendation Sorting and Summary Helpers
   ===================================================================== */

function compareScopeRecommendations(
  left,
  right
) {

  const leftType =
    toTrimmedString(
      left?.scope?.type
    );

  const rightType =
    toTrimmedString(
      right?.scope?.type
    );

  const typeComparison =
    leftType.localeCompare(
      rightType
    );

  if (
    typeComparison !== 0
  ) {

    return typeComparison;

  }

  const leftKey =
    toTrimmedString(
      left?.scope?.key
    );

  const rightKey =
    toTrimmedString(
      right?.scope?.key
    );

  return leftKey.localeCompare(
    rightKey
  );

}

function sortScopeRecommendations(
  recommendations
) {

  if (
    !Array.isArray(
      recommendations
    )
  ) {

    return [];

  }

  return recommendations
    .filter(
      isPlainObject
    )
    .sort(
      compareScopeRecommendations
    );

}

function summarizeRecommendations(
  recommendations
) {

  const normalized =
    Array.isArray(
      recommendations
    )
      ? recommendations.filter(
          isPlainObject
        )
      : [];

  const summary =
    {
      totalScopes:
        normalized.length,

      eligibleScopes: 0,

      insufficientDataScopes: 0,

      invalidScopes: 0,

      supportiveScopes: 0,

      cautionScopes: 0,

      neutralScopes: 0,

      confidenceIncreaseRecommendations: 0,

      confidenceDecreaseRecommendations: 0,

      unchangedConfidenceRecommendations: 0
    };

  for (
    const recommendation of
    normalized
  ) {

    const eligibility =
      recommendation.eligibility;

    if (
      eligibility?.eligible ===
      true
    ) {

      summary.eligibleScopes +=
        1;

    } else if (
      eligibility?.status ===
        OPTIMIZATION_STATUSES
          .INSUFFICIENT_DATA
    ) {

      summary.insufficientDataScopes +=
        1;

    } else {

      summary.invalidScopes +=
        1;

    }

    const classification =
      recommendation
        ?.profitability
        ?.classification;

    if (
      classification ===
        OPTIMIZATION_STATUSES
          .SUPPORTIVE
    ) {

      summary.supportiveScopes +=
        1;

    } else if (
      classification ===
        OPTIMIZATION_STATUSES
          .CAUTION
    ) {

      summary.cautionScopes +=
        1;

    } else if (
      classification ===
        OPTIMIZATION_STATUSES
          .NEUTRAL
    ) {

      summary.neutralScopes +=
        1;

    }

    const adjustment =
      toFiniteNumber(
        recommendation
          ?.confidenceRecommendation
          ?.boundedAdjustment
      ) || 0;

    if (
      adjustment >
        0
    ) {

      summary
        .confidenceIncreaseRecommendations +=
        1;

    } else if (
      adjustment <
        0
    ) {

      summary
        .confidenceDecreaseRecommendations +=
        1;

    } else {

      summary
        .unchangedConfidenceRecommendations +=
        1;

    }

  }

  return summary;

}

/* =====================================================================
   Recommendation Collection Helpers
   ===================================================================== */

function addScopeRecommendation({
  recommendations,
  seenScopeIds,
  scope,
  metric
}) {

  if (
    !Array.isArray(
      recommendations
    ) ||
    !(seenScopeIds instanceof Set)
  ) {

    return;

  }

  const recommendation =
    buildScopeRecommendation({
      scope,
      metric
    });

  const scopeType =
    toTrimmedString(
      recommendation?.scope?.type
    );

  const scopeKey =
    toTrimmedString(
      recommendation?.scope?.key
    );

  if (
    !scopeType ||
    !scopeKey
  ) {

    recommendations.push(
      recommendation
    );

    return;

  }

  const scopeId =
    `${scopeType}::${scopeKey}`;

  if (
    seenScopeIds.has(
      scopeId
    )
  ) {

    return;

  }

  seenScopeIds.add(
    scopeId
  );

  recommendations.push(
    recommendation
  );

}

function addDimensionRecommendations({
  recommendations,
  seenScopeIds,
  dimensionMap,
  scopeType,
  identityBuilder
}) {

  if (
    !isPlainObject(
      dimensionMap
    ) ||
    typeof identityBuilder !==
      "function"
  ) {

    return;

  }

  for (
    const key of Object.keys(
      dimensionMap
    ).sort()
  ) {

    const scope =
      identityBuilder(
        key
      );

    if (
      !isPlainObject(
        scope
      )
    ) {

      continue;

    }

    addScopeRecommendation({
      recommendations,
      seenScopeIds,

      scope: {
        type:
          scopeType,

        key,

        ...scope
      },

      metric:
        dimensionMap[key]
    });

  }

}

/* =====================================================================
   Combination Identity Parsers
   ===================================================================== */

function buildPairEngineIdentity(
  key
) {

  const parts =
    splitCombinationKey(
      key,
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

  return {
    pair,
    engine
  };

}

function buildPairDirectionIdentity(
  key
) {

  const parts =
    splitCombinationKey(
      key,
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

  return {
    pair,
    direction
  };

}

function buildEngineDirectionIdentity(
  key
) {

  const parts =
    splitCombinationKey(
      key,
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

  return {
    engine,
    direction
  };

}

function buildPairEngineDirectionIdentity(
  key
) {

  const parts =
    splitCombinationKey(
      key,
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

  return {
    pair,
    engine,
    direction
  };

}

function buildPairOptionalIdentity(
  key,
  fieldName
) {

  const parts =
    splitCombinationKey(
      key,
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

  return {
    pair,
    [fieldName]:
      optionalValue
  };

}

/* =====================================================================
   Full Recommendation Builder
   ===================================================================== */

function buildAllRecommendations(
  aiMemory
) {

  if (
    !isPlainObject(
      aiMemory
    )
  ) {

    return {
      recommendations: [],
      summary:
        summarizeRecommendations(
          []
        ),
      errors: [
        "Normalized AI Memory is unavailable."
      ],
      warnings: []
    };

  }

  const recommendations =
    [];

  const seenScopeIds =
    new Set();

  const errors =
    [];

  const warnings =
    [];

  /*
   * Overall scope.
   */
  addScopeRecommendation({
    recommendations,
    seenScopeIds,

    scope: {
      type:
        "overall",

      key:
        "overall"
    },

    metric:
      aiMemory.summary
  });

  /*
   * Single dimensions.
   */
  addDimensionRecommendations({
    recommendations,
    seenScopeIds,

    dimensionMap:
      aiMemory.memory?.pairs,

    scopeType:
      "pair",

    identityBuilder:
      key => {
        const pair =
          normalizePair(
            key
          );

        return pair
          ? {
              pair
            }
          : null;
      }
  });

  addDimensionRecommendations({
    recommendations,
    seenScopeIds,

    dimensionMap:
      aiMemory.memory?.engines,

    scopeType:
      "engine",

    identityBuilder:
      key => {
        const engine =
          normalizeEngine(
            key
          );

        return engine
          ? {
              engine
            }
          : null;
      }
  });

  addDimensionRecommendations({
    recommendations,
    seenScopeIds,

    dimensionMap:
      aiMemory.memory?.directions,

    scopeType:
      "direction",

    identityBuilder:
      key => {
        const direction =
          normalizeDirection(
            key
          );

        return direction
          ? {
              direction
            }
          : null;
      }
  });

  addDimensionRecommendations({
    recommendations,
    seenScopeIds,

    dimensionMap:
      aiMemory.memory?.timeframes,

    scopeType:
      "timeframe",

    identityBuilder:
      key => {
        const timeframe =
          normalizeTimeframe(
            key
          );

        return timeframe
          ? {
              timeframe
            }
          : null;
      }
  });

  /*
   * Optional dimensions are included only when explicitly present.
   */
  addDimensionRecommendations({
    recommendations,
    seenScopeIds,

    dimensionMap:
      aiMemory.memory?.sessions,

    scopeType:
      "pairSession",

    identityBuilder:
      key => {
        const session =
          normalizeOptionalDimension(
            key
          );

        return session
          ? {
              session
            }
          : null;
      }
  });

  addDimensionRecommendations({
    recommendations,
    seenScopeIds,

    dimensionMap:
      aiMemory.memory?.patterns,

    scopeType:
      "pairPattern",

    identityBuilder:
      key => {
        const pattern =
          normalizeOptionalDimension(
            key
          );

        return pattern
          ? {
              pattern
            }
          : null;
      }
  });

  addDimensionRecommendations({
    recommendations,
    seenScopeIds,

    dimensionMap:
      aiMemory.memory
        ?.marketRegimes,

    scopeType:
      "pairMarketRegime",

    identityBuilder:
      key => {
        const marketRegime =
          normalizeOptionalDimension(
            key
          );

        return marketRegime
          ? {
              marketRegime
            }
          : null;
      }
  });

  /*
   * Exact combinations.
   */
  addDimensionRecommendations({
    recommendations,
    seenScopeIds,

    dimensionMap:
      aiMemory.combinations
        ?.pairEngine,

    scopeType:
      "pairEngine",

    identityBuilder:
      buildPairEngineIdentity
  });

  addDimensionRecommendations({
    recommendations,
    seenScopeIds,

    dimensionMap:
      aiMemory.combinations
        ?.pairDirection,

    scopeType:
      "pairDirection",

    identityBuilder:
      buildPairDirectionIdentity
  });

  addDimensionRecommendations({
    recommendations,
    seenScopeIds,

    dimensionMap:
      aiMemory.combinations
        ?.engineDirection,

    scopeType:
      "engineDirection",

    identityBuilder:
      buildEngineDirectionIdentity
  });

  addDimensionRecommendations({
    recommendations,
    seenScopeIds,

    dimensionMap:
      aiMemory.combinations
        ?.pairEngineDirection,

    scopeType:
      "pairEngineDirection",

    identityBuilder:
      buildPairEngineDirectionIdentity
  });

  addDimensionRecommendations({
    recommendations,
    seenScopeIds,

    dimensionMap:
      aiMemory.combinations
        ?.pairSession,

    scopeType:
      "pairSession",

    identityBuilder:
      key =>
        buildPairOptionalIdentity(
          key,
          "session"
        )
  });

  addDimensionRecommendations({
    recommendations,
    seenScopeIds,

    dimensionMap:
      aiMemory.combinations
        ?.pairPattern,

    scopeType:
      "pairPattern",

    identityBuilder:
      key =>
        buildPairOptionalIdentity(
          key,
          "pattern"
        )
  });

  addDimensionRecommendations({
    recommendations,
    seenScopeIds,

    dimensionMap:
      aiMemory.combinations
        ?.pairMarketRegime,

    scopeType:
      "pairMarketRegime",

    identityBuilder:
      key =>
        buildPairOptionalIdentity(
          key,
          "marketRegime"
        )
  });

  const sortedRecommendations =
    sortScopeRecommendations(
      recommendations
    );

  for (
    const recommendation of
    sortedRecommendations
  ) {

    if (
      Array.isArray(
        recommendation.errors
      )
    ) {

      errors.push(
        ...recommendation.errors
      );

    }

    if (
      Array.isArray(
        recommendation.warnings
      )
    ) {

      warnings.push(
        ...recommendation.warnings
      );

    }

  }

  return {
    recommendations:
      sortedRecommendations,

    summary:
      summarizeRecommendations(
        sortedRecommendations
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
   Output Document Structures
   ===================================================================== */

function createEmptyOptimizationSummary() {

  return {
    totalScopes: 0,
    eligibleScopes: 0,
    insufficientDataScopes: 0,
    invalidScopes: 0,
    supportiveScopes: 0,
    cautionScopes: 0,
    neutralScopes: 0,
    confidenceIncreaseRecommendations: 0,
    confidenceDecreaseRecommendations: 0,
    unchangedConfidenceRecommendations: 0
  };

}

function createEmptyOptimizationDocument(
  generatedAt =
    new Date().toISOString()
) {

  return {
    version:
      OPTIMIZATION_SCHEMA_VERSION,

    engineName:
      ENGINE_NAME,

    engineVersion:
      ENGINE_VERSION,

    mode:
      OPTIMIZER_MODE,

    generatedAt,

    sourceUpdatedAt:
      null,

    summary:
      createEmptyOptimizationSummary(),

    recommendations:
      [],

    activeParameters: {
      applied:
        false,

      reason:
        "Shadow mode does not apply optimization recommendations.",

      confidenceAdjustments:
        {}
    },

    source: {
      aiMemoryPath:
        path.relative(
          ROOT_DIR,
          AI_MEMORY_PATH
        ),

      aiMemoryStatePath:
        path.relative(
          ROOT_DIR,
          AI_MEMORY_STATE_PATH
        ),

      aiMemoryHash:
        null,

      aiMemoryStateHash:
        null,

      aiMemoryGeneratedAt:
        null,

      aiMemorySourceUpdatedAt:
        null
    },

    safety: {
      shadowOnly:
        true,

      sourceCodeModification:
        false,

      externalApiCalls:
        false,

      signalGeneration:
        false,

      decisionModification:
        false,

      tradePlanModification:
        false,

      telegramModification:
        false,

      minimumResolvedTrades:
        MIN_RESOLVED_TRADES,

      maximumSingleStepChange:
        MAX_SINGLE_STEP_CHANGE,

      maximumConfidenceRecommendation:
        MAX_CONFIDENCE_RECOMMENDATION,

      minimumRecommendedConfidence:
        MIN_RECOMMENDED_CONFIDENCE,

      maximumRecommendedConfidence:
        MAX_RECOMMENDED_CONFIDENCE,

      exactScopeOnly:
        true
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

      atomicWrites:
        true,

      sourceHashing:
        true,

      missingMetadataPolicy:
        "Missing values are preserved as unavailable and are never inferred.",

      samplePolicy:
        "Every scope must independently satisfy the minimum resolved-trade requirement.",

      recommendationPolicy:
        "Recommendations are advisory and are not consumed by production engines in shadow mode."
    }
  };

}

/* =====================================================================
   Optimization Output Validation
   ===================================================================== */

function validateRecommendationDocumentEntry(
  recommendation,
  index
) {

  const errors =
    [];

  const warnings =
    [];

  const label =
    `recommendations[${index}]`;

  if (
    !isPlainObject(
      recommendation
    )
  ) {

    return {
      valid: false,
      errors: [
        `${label} must be a JSON object.`
      ],
      warnings
    };

  }

  if (
    recommendation.shadowOnly !==
      true
  ) {

    errors.push(
      `${label}.shadowOnly must be true.`
    );

  }

  if (
    !isPlainObject(
      recommendation.scope
    )
  ) {

    errors.push(
      `${label}.scope must be a JSON object.`
    );

  } else {

    if (
      !isSupportedScopeType(
        recommendation.scope.type
      )
    ) {

      errors.push(
        `${label}.scope.type is invalid.`
      );

    }

    if (
      !toNonEmptyStringOrNull(
        recommendation.scope.key
      )
    ) {

      errors.push(
        `${label}.scope.key is invalid.`
      );

    }

  }

  if (
    !isPlainObject(
      recommendation.eligibility
    )
  ) {

    errors.push(
      `${label}.eligibility must be a JSON object.`
    );

  } else {

    const totalTrades =
      toNonNegativeInteger(
        recommendation
          .eligibility
          .totalTrades
      );

    const requiredTrades =
      toNonNegativeInteger(
        recommendation
          .eligibility
          .requiredTrades
      );

    const remainingTrades =
      toNonNegativeInteger(
        recommendation
          .eligibility
          .remainingTrades
      );

    if (
      totalTrades === null
    ) {

      errors.push(
        `${label}.eligibility.totalTrades is invalid.`
      );

    }

    if (
      requiredTrades !==
        MIN_RESOLVED_TRADES
    ) {

      errors.push(
        `${label}.eligibility.requiredTrades does not match the configured safety gate.`
      );

    }

    if (
      remainingTrades === null
    ) {

      errors.push(
        `${label}.eligibility.remainingTrades is invalid.`
      );

    }

    if (
      recommendation
        .eligibility
        .eligible ===
        true &&
      totalTrades !== null &&
      totalTrades <
        MIN_RESOLVED_TRADES
    ) {

      errors.push(
        `${label} is marked eligible below the required sample size.`
      );

    }

  }

  const confidenceRecommendation =
    recommendation
      .confidenceRecommendation;

  if (
    !isPlainObject(
      confidenceRecommendation
    )
  ) {

    errors.push(
      `${label}.confidenceRecommendation must be a JSON object.`
    );

  } else {

    const boundedAdjustment =
      toFiniteNumber(
        confidenceRecommendation
          .boundedAdjustment
      );

    if (
      boundedAdjustment === null
    ) {

      errors.push(
        `${label}.confidenceRecommendation.boundedAdjustment is invalid.`
      );

    } else if (
      Math.abs(
        boundedAdjustment
      ) >
        MAX_SINGLE_STEP_CHANGE
    ) {

      errors.push(
        `${label}.confidenceRecommendation.boundedAdjustment exceeds the maximum step.`
      );

    }

    if (
      confidenceRecommendation.available ===
        true
    ) {

      const baseline =
        clamp(
          confidenceRecommendation
            .baseline,
          MIN_RECOMMENDED_CONFIDENCE,
          MAX_RECOMMENDED_CONFIDENCE
        );

      const recommendedConfidence =
        clamp(
          confidenceRecommendation
            .recommendedConfidence,
          MIN_RECOMMENDED_CONFIDENCE,
          MAX_RECOMMENDED_CONFIDENCE
        );

      if (
        baseline === null
      ) {

        errors.push(
          `${label}.confidenceRecommendation.baseline is invalid.`
        );

      }

      if (
        recommendedConfidence ===
          null
      ) {

        errors.push(
          `${label}.confidenceRecommendation.recommendedConfidence is invalid.`
        );

      }

    }

  }

  return {
    valid:
      errors.length === 0,

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

function validateOptimizationDocument(
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
        "Optimization document must be a JSON object."
      ],
      warnings
    };

  }

  if (
    document.version !==
      OPTIMIZATION_SCHEMA_VERSION
  ) {

    errors.push(
      "Optimization schema version is invalid."
    );

  }

  if (
    document.engineName !==
      ENGINE_NAME
  ) {

    errors.push(
      "Optimization engine name is invalid."
    );

  }

  if (
    document.engineVersion !==
      ENGINE_VERSION
  ) {

    errors.push(
      "Optimization engine version is invalid."
    );

  }

  if (
    document.mode !==
      "shadow"
  ) {

    errors.push(
      "Optimization mode must remain shadow during Phase A."
    );

  }

  if (
    !toISOStringOrNull(
      document.generatedAt
    )
  ) {

    errors.push(
      "Optimization generatedAt timestamp is invalid."
    );

  }

  if (
    document.sourceUpdatedAt !==
      null &&
    !toISOStringOrNull(
      document.sourceUpdatedAt
    )
  ) {

    errors.push(
      "Optimization sourceUpdatedAt timestamp is invalid."
    );

  }

  if (
    !Array.isArray(
      document.recommendations
    )
  ) {

    errors.push(
      "Optimization recommendations must be an array."
    );

  } else {

    for (
      let index = 0;
      index <
        document.recommendations.length;
      index++
    ) {

      const result =
        validateRecommendationDocumentEntry(
          document.recommendations[index],
          index
        );

      errors.push(
        ...result.errors
      );

      warnings.push(
        ...result.warnings
      );

    }

  }

  if (
    !isPlainObject(
      document.activeParameters
    ) ||
    document.activeParameters.applied !==
      false
  ) {

    errors.push(
      "Shadow optimization must not contain applied active parameters."
    );

  }

  if (
    !isPlainObject(
      document.safety
    )
  ) {

    errors.push(
      "Optimization safety section must be a JSON object."
    );

  } else {

    const requiredFalseFlags =
      [
        "sourceCodeModification",
        "externalApiCalls",
        "signalGeneration",
        "decisionModification",
        "tradePlanModification",
        "telegramModification"
      ];

    for (
      const flagName of
      requiredFalseFlags
    ) {

      if (
        document.safety[flagName] !==
          false
      ) {

        errors.push(
          `Optimization safety.${flagName} must be false.`
        );

      }

    }

    if (
      document.safety.shadowOnly !==
        true
    ) {

      errors.push(
        "Optimization safety.shadowOnly must be true."
      );

    }

    if (
      document
        .safety
        .minimumResolvedTrades !==
        MIN_RESOLVED_TRADES
    ) {

      errors.push(
        "Optimization minimum resolved-trade gate is inconsistent."
      );

    }

  }

  return {
    valid:
      errors.length === 0,

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
   Build Final Shadow Optimization Document
   ===================================================================== */

function buildOptimizationDocument({
  aiMemory,
  aiMemoryHash,
  aiMemoryStateHash,
  generatedAt =
    new Date().toISOString()
}) {

  const document =
    createEmptyOptimizationDocument(
      generatedAt
    );

  const recommendationResult =
    buildAllRecommendations(
      aiMemory
    );

  document.generatedAt =
    generatedAt;

  document.sourceUpdatedAt =
    aiMemory.sourceUpdatedAt ||
    aiMemory.generatedAt ||
    null;

  document.summary =
    recommendationResult.summary;

  document.recommendations =
    recommendationResult
      .recommendations;

  document.source = {
    aiMemoryPath:
      path.relative(
        ROOT_DIR,
        AI_MEMORY_PATH
      ),

    aiMemoryStatePath:
      path.relative(
        ROOT_DIR,
        AI_MEMORY_STATE_PATH
      ),

    aiMemoryHash:
      aiMemoryHash ||
      null,

    aiMemoryStateHash:
      aiMemoryStateHash ||
      null,

    aiMemoryGeneratedAt:
      aiMemory.generatedAt ||
      null,

    aiMemorySourceUpdatedAt:
      aiMemory.sourceUpdatedAt ||
      null
  };

  document.validation = {
    valid:
      recommendationResult
        .errors
        .length ===
        0,

    errors:
      recommendationResult.errors,

    warnings:
      recommendationResult.warnings
  };

  const validationResult =
    validateOptimizationDocument(
      document
    );

  document.validation = {
    valid:
      (
        document.validation.valid &&
        validationResult.valid
      ),

    errors:
      uniqueSortedStrings([
        ...document.validation.errors,
        ...validationResult.errors
      ]),

    warnings:
      uniqueSortedStrings([
        ...document.validation.warnings,
        ...validationResult.warnings
      ])
  };

  return document;

}

/* =====================================================================
   Optimizer State Structures
   ===================================================================== */

function createEmptyOptimizerState(
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
      OPTIMIZER_MODE,

    createdAt,

    updatedAt:
      createdAt,

    lastRunAt:
      null,

    lastSuccessfulRunAt:
      null,

    sourceHashes: {
      aiMemory:
        null,

      aiMemoryState:
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

      eligibleScopesObserved:
        0,

      insufficientDataScopesObserved:
        0,

      supportiveScopesObserved:
        0,

      cautionScopesObserved:
        0,

      neutralScopesObserved:
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

      outputWritten:
        false,

      stateWritten:
        false,

      totalScopes:
        0,

      eligibleScopes:
        0,

      insufficientDataScopes:
        0,

      supportiveScopes:
        0,

      cautionScopes:
        0,

      neutralScopes:
        0,

      warnings:
        [],

      error:
        null
    }
  };

}

/* =====================================================================
   Optimizer State Validation
   ===================================================================== */

function validateOptimizerState(
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

      errors: [
        "Optimizer state must be a JSON object."
      ]
    };

  }

  if (
    value.version !==
      STATE_SCHEMA_VERSION
  ) {

    errors.push(
      "Optimizer state schema version is invalid."
    );

  }

  if (
    value.engineName !==
      ENGINE_NAME
  ) {

    errors.push(
      "Optimizer state engine name is invalid."
    );

  }

  if (
    value.engineVersion !==
      ENGINE_VERSION
  ) {

    errors.push(
      "Optimizer state engine version is invalid."
    );

  }

  if (
    value.mode !==
      OPTIMIZER_MODE
  ) {

    errors.push(
      "Optimizer state mode is invalid."
    );

  }

  if (
    !toISOStringOrNull(
      value.createdAt
    )
  ) {

    errors.push(
      "Optimizer state createdAt is invalid."
    );

  }

  if (
    !toISOStringOrNull(
      value.updatedAt
    )
  ) {

    errors.push(
      "Optimizer state updatedAt is invalid."
    );

  }

  if (
    value.lastRunAt !==
      null &&
    !toISOStringOrNull(
      value.lastRunAt
    )
  ) {

    errors.push(
      "Optimizer state lastRunAt is invalid."
    );

  }

  if (
    value.lastSuccessfulRunAt !==
      null &&
    !toISOStringOrNull(
      value.lastSuccessfulRunAt
    )
  ) {

    errors.push(
      "Optimizer state lastSuccessfulRunAt is invalid."
    );

  }

  if (
    !isPlainObject(
      value.sourceHashes
    )
  ) {

    errors.push(
      "Optimizer state sourceHashes must be a JSON object."
    );

  }

  if (
    !isPlainObject(
      value.counters
    )
  ) {

    errors.push(
      "Optimizer state counters must be a JSON object."
    );

  } else {

    const counterNames =
      [
        "runs",
        "successfulRuns",
        "failedRuns",
        "updatedRuns",
        "unchangedRuns",
        "eligibleScopesObserved",
        "insufficientDataScopesObserved",
        "supportiveScopesObserved",
        "cautionScopesObserved",
        "neutralScopesObserved"
      ];

    for (
      const counterName of
      counterNames
    ) {

      if (
        toNonNegativeInteger(
          value.counters[counterName]
        ) ===
        null
      ) {

        errors.push(
          `Optimizer state counters.${counterName} is invalid.`
        );

      }

    }

  }

  if (
    !isPlainObject(
      value.lastRun
    )
  ) {

    errors.push(
      "Optimizer state lastRun must be a JSON object."
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
   Optimizer State Loading
   ===================================================================== */

function loadOptimizerState(
  runAt
) {

  const stateRead =
    readJSONFile(
      OPTIMIZATION_STATE_PATH,
      null
    );

  if (
    !stateRead.ok ||
    !isPlainObject(
      stateRead.value
    )
  ) {

    return {
      state:
        createEmptyOptimizerState(
          runAt
        ),

      recovered:
        stateRead.exists ===
        true,

      warning:
        stateRead.error
    };

  }

  const validation =
    validateOptimizerState(
      stateRead.value
    );

  if (
    !validation.valid
  ) {

    return {
      state:
        createEmptyOptimizerState(
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
        stateRead.value
      ),

    recovered:
      false,

    warning:
      null
  };

}

/* =====================================================================
   Existing Output Validation
   ===================================================================== */

function readExistingOptimizationOutput() {

  const result =
    readJSONFile(
      OPTIMIZATION_OUTPUT_PATH,
      null
    );

  if (
    !result.ok ||
    !isPlainObject(
      result.value
    )
  ) {

    return {
      exists:
        result.exists,

      valid:
        false,

      value:
        null,

      error:
        result.error
    };

  }

  const validation =
    validateOptimizationDocument(
      result.value
    );

  return {
    exists:
      true,

    valid:
      validation.valid,

    value:
      validation.valid
        ? result.value
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
   Source Change Detection
   ===================================================================== */

function haveSourceHashesChanged({
  state,
  aiMemoryHash,
  aiMemoryStateHash
}) {

  if (
    !isPlainObject(
      state?.sourceHashes
    )
  ) {

    return true;

  }

  return (
    state.sourceHashes.aiMemory !==
      aiMemoryHash ||
    state.sourceHashes.aiMemoryState !==
      aiMemoryStateHash
  );

}

function hasGeneratedOutputChanged({
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
   * generatedAt changes on every execution and must not force an
   * unnecessary write when the actual optimization result is unchanged.
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
   State Run Lifecycle
   ===================================================================== */

function beginOptimizerRun({
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

    outputWritten:
      false,

    stateWritten:
      false,

    totalScopes:
      0,

    eligibleScopes:
      0,

    insufficientDataScopes:
      0,

    supportiveScopes:
      0,

    cautionScopes:
      0,

    neutralScopes:
      0,

    warnings:
      [],

    error:
      null
  };

  return nextState;

}

function completeOptimizerRun({
  state,
  runAt,
  status,
  sourceChanged,
  outputWritten,
  aiMemoryHash,
  aiMemoryStateHash,
  outputHash,
  summary,
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
    aiMemory:
      aiMemoryHash,

    aiMemoryState:
      aiMemoryStateHash
  };

  nextState.outputHash =
    outputHash;

  nextState.counters.successfulRuns +=
    1;

  if (
    status ===
      "UPDATED"
  ) {

    nextState.counters.updatedRuns +=
      1;

  } else if (
    status ===
      "UNCHANGED"
  ) {

    nextState.counters.unchangedRuns +=
      1;

  }

  nextState.counters.eligibleScopesObserved +=
    summary.eligibleScopes;

  nextState.counters.insufficientDataScopesObserved +=
    summary.insufficientDataScopes;

  nextState.counters.supportiveScopesObserved +=
    summary.supportiveScopes;

  nextState.counters.cautionScopesObserved +=
    summary.cautionScopes;

  nextState.counters.neutralScopesObserved +=
    summary.neutralScopes;

  nextState.lastRun = {
    status,

    startedAt:
      state.lastRun?.startedAt ||
      runAt,

    completedAt:
      runAt,

    sourceChanged:
      sourceChanged ===
      true,

    outputWritten:
      outputWritten ===
      true,

    stateWritten:
      true,

    totalScopes:
      summary.totalScopes,

    eligibleScopes:
      summary.eligibleScopes,

    insufficientDataScopes:
      summary.insufficientDataScopes,

    supportiveScopes:
      summary.supportiveScopes,

    cautionScopes:
      summary.cautionScopes,

    neutralScopes:
      summary.neutralScopes,

    warnings:
      uniqueSortedStrings(
        warnings
      ),

    error:
      null
  };

  return nextState;

}

function failOptimizerRun({
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

  nextState.counters.failedRuns +=
    1;

  nextState.lastRun = {
    status:
      "FAILED",

    startedAt:
      state.lastRun?.startedAt ||
      runAt,

    completedAt:
      runAt,

    sourceChanged:
      false,

    outputWritten:
      false,

    stateWritten:
      true,

    totalScopes:
      0,

    eligibleScopes:
      0,

    insufficientDataScopes:
      0,

    supportiveScopes:
      0,

    cautionScopes:
      0,

    neutralScopes:
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
   Run Result Builder
   ===================================================================== */

function createOptimizerRunResult({
  status,
  runAt,
  sourceChanged,
  outputWritten,
  stateWritten,
  summary,
  warnings
}) {

  return {
    engineName:
      ENGINE_NAME,

    engineVersion:
      ENGINE_VERSION,

    mode:
      OPTIMIZER_MODE,

    status,

    runAt,

    sourceChanged:
      sourceChanged ===
      true,

    outputWritten:
      outputWritten ===
      true,

    stateWritten:
      stateWritten ===
      true,

    summary:
      cloneJSONCompatible(
        summary
      ),

    warnings:
      uniqueSortedStrings(
        warnings
      )
  };

}

/* =====================================================================
   Main Adaptive Optimizer Worker
   ===================================================================== */

function runAdaptiveOptimizer() {

  const runAt =
    new Date().toISOString();

  let stateWritten =
    false;

  let outputWritten =
    false;

  const runtimeWarnings =
    [];

  const stateLoad =
    loadOptimizerState(
      runAt
    );

  let state =
    beginOptimizerRun({
      state:
        stateLoad.state,

      runAt
    });

  if (
    stateLoad.warning
  ) {

    runtimeWarnings.push(
      `Optimizer state recovery: ${stateLoad.warning}`
    );

  }

  try {

    const aiMemoryRead =
      readJSONFile(
        AI_MEMORY_PATH,
        null
      );

    if (
      !aiMemoryRead.ok
    ) {

      throw new Error(
        aiMemoryRead.error ||
        "Unable to read AI Memory."
      );

    }

    const normalizedMemory =
      normalizeAIMemoryDocument(
        aiMemoryRead.value
      );

    runtimeWarnings.push(
      ...normalizedMemory.warnings
    );

    if (
      !normalizedMemory.valid
    ) {

      throw new Error(
        normalizedMemory.errors.join(
          " "
        ) ||
        "AI Memory validation failed."
      );

    }

    const aiMemoryStateRead =
      readJSONFile(
        AI_MEMORY_STATE_PATH,
        null
      );

    if (
      !aiMemoryStateRead.ok
    ) {

      runtimeWarnings.push(
        aiMemoryStateRead.error ||
        "AI Memory state is unavailable."
      );

    }

    const aiMemoryHash =
      createFileContentHash(
        AI_MEMORY_PATH
      );

    const aiMemoryStateHash =
      createFileContentHash(
        AI_MEMORY_STATE_PATH
      );

    if (
      !aiMemoryHash
    ) {

      throw new Error(
        "Unable to calculate AI Memory source hash."
      );

    }

    const sourceChanged =
      haveSourceHashesChanged({
        state,
        aiMemoryHash,
        aiMemoryStateHash
      });

    const generatedOutput =
      buildOptimizationDocument({
        aiMemory:
          normalizedMemory.value,

        aiMemoryHash,

        aiMemoryStateHash,

        generatedAt:
          runAt
      });

    if (
      !generatedOutput
        .validation
        .valid
    ) {

      throw new Error(
        generatedOutput
          .validation
          .errors
          .join(
            " "
          ) ||
        "Generated optimization output failed validation."
      );

    }

    runtimeWarnings.push(
      ...generatedOutput
        .validation
        .warnings
    );

    const existingOutput =
      readExistingOptimizationOutput();

    if (
      existingOutput.exists &&
      !existingOutput.valid &&
      existingOutput.error
    ) {

      runtimeWarnings.push(
        `Existing optimization output will be replaced: ${existingOutput.error}`
      );

    }

    const outputChanged =
      hasGeneratedOutputChanged({
        existingOutput,
        generatedOutput
      });

    const mustWriteOutput =
      (
        sourceChanged ||
        outputChanged ||
        !existingOutput.exists ||
        !existingOutput.valid
      );

    let status =
      "UNCHANGED";

    if (
      mustWriteOutput
    ) {

      atomicWriteJSON(
        OPTIMIZATION_OUTPUT_PATH,
        generatedOutput
      );

      outputWritten =
        true;

      status =
        "UPDATED";

    }

    const outputHash =
      createFileContentHash(
        OPTIMIZATION_OUTPUT_PATH
      );

    if (
      !outputHash
    ) {

      throw new Error(
        "Unable to calculate optimization output hash."
      );

    }

    state =
      completeOptimizerRun({
        state,
        runAt,
        status,
        sourceChanged,
        outputWritten,
        aiMemoryHash,
        aiMemoryStateHash,
        outputHash,

        summary:
          generatedOutput.summary,

        warnings:
          runtimeWarnings
      });

    const stateValidation =
      validateOptimizerState(
        state
      );

    if (
      !stateValidation.valid
    ) {

      throw new Error(
        stateValidation.errors.join(
          " "
        ) ||
        "Generated optimizer state is invalid."
      );

    }

    atomicWriteJSON(
      OPTIMIZATION_STATE_PATH,
      state
    );

    stateWritten =
      true;

    const result =
      createOptimizerRunResult({
        status,
        runAt,
        sourceChanged,
        outputWritten,
        stateWritten,

        summary:
          generatedOutput.summary,

        warnings:
          runtimeWarnings
      });

    console.log(
      `[adaptive-optimizer] ${status}`
    );

    console.log(
      `[adaptive-optimizer] Mode: ${OPTIMIZER_MODE}`
    );

    console.log(
      `[adaptive-optimizer] Total scopes: ${result.summary.totalScopes}`
    );

    console.log(
      `[adaptive-optimizer] Eligible scopes: ${result.summary.eligibleScopes}`
    );

    console.log(
      `[adaptive-optimizer] Insufficient-data scopes: ` +
      `${result.summary.insufficientDataScopes}`
    );

    console.log(
      `[adaptive-optimizer] Supportive scopes: ${result.summary.supportiveScopes}`
    );

    console.log(
      `[adaptive-optimizer] Caution scopes: ${result.summary.cautionScopes}`
    );

    console.log(
      `[adaptive-optimizer] Neutral scopes: ${result.summary.neutralScopes}`
    );

    console.log(
      `[adaptive-optimizer] Output written: ${result.outputWritten}`
    );

    console.log(
      `[adaptive-optimizer] State written: ${result.stateWritten}`
    );

    if (
      result.warnings.length >
      0
    ) {

      console.warn(
        `[adaptive-optimizer] Completed with ` +
        `${result.warnings.length} warning(s).`
      );

    }

    return result;

  } catch (
    error
  ) {

    state =
      failOptimizerRun({
        state,
        runAt,
        error,
        warnings:
          runtimeWarnings
      });

    try {

      atomicWriteJSON(
        OPTIMIZATION_STATE_PATH,
        state
      );

      stateWritten =
        true;

    } catch (
      stateWriteError
    ) {

      console.error(
        "[adaptive-optimizer] Unable to persist failed-run state:",
        stateWriteError.message
      );

    }

    console.error(
      "[adaptive-optimizer] FAILED"
    );

    console.error(
      `[adaptive-optimizer] ${error.message}`
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

    runAdaptiveOptimizer();

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
  OPTIMIZER_MODE,
  MIN_RESOLVED_TRADES,

  normalizeAIMemoryDocument,
  evaluateScopeEligibility,
  evaluateProfitabilityEvidence,
  buildConfidenceRecommendation,
  buildScopeRecommendation,
  buildAllRecommendations,
  buildOptimizationDocument,
  validateOptimizationDocument,
  validateOptimizerState,
  runAdaptiveOptimizer
};

/* =====================================================================
   End of PipSight Pro Professional Adaptive Optimization Engine
   ===================================================================== */
