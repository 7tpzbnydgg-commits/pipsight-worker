"use strict";

/**
 * PipSight Pro — Guarded Adaptive Execution Layer
 *
 * Version: 1.0.0
 *
 * Phase B1:
 * - Scalp-only dry-run resolution.
 * - Reads verified Phase A optimizer recommendations.
 * - Resolves one recommendation for each supported scalp context.
 * - Never stacks multiple confidence adjustments.
 * - Never edits an existing strategy file.
 * - Never changes a live BUY, SELL or WAIT decision.
 * - Never changes entry, stop-loss or take-profit values.
 * - Never sends Telegram notifications.
 * - Never modifies existing JSON schemas.
 *
 * Reads:
 *   data/adaptive-optimization.json
 *   data/adaptive-optimization-state.json
 *
 * Writes:
 *   data/adaptive-execution.json
 *   data/adaptive-execution-state.json
 *
 * Important:
 * - This file is not consumed by run-scalp-analysis.js during Phase B1.
 * - Every result remains dry-run only.
 * - liveApplied is permanently false in this phase.
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
  "PipSight Pro Guarded Adaptive Execution Layer";

const ENGINE_VERSION =
  "1.0.0";

const EXECUTION_SCHEMA_VERSION =
  1;

const STATE_SCHEMA_VERSION =
  1;

const EXECUTION_MODE =
  "dry-run";

const TARGET_ENGINE =
  "scalp";

/*
 * Phase B1 must never apply a live parameter.
 */
const LIVE_APPLICATION_ENABLED =
  false;

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

const OPTIMIZATION_PATH =
  path.join(
    DATA_DIR,
    "adaptive-optimization.json"
  );

const OPTIMIZATION_STATE_PATH =
  path.join(
    DATA_DIR,
    "adaptive-optimization-state.json"
  );

const EXECUTION_OUTPUT_PATH =
  path.join(
    DATA_DIR,
    "adaptive-execution.json"
  );

const EXECUTION_STATE_PATH =
  path.join(
    DATA_DIR,
    "adaptive-execution-state.json"
  );

/* =====================================================================
   Verified Scalp Context
   ===================================================================== */

/*
 * These pair keys match the current production Scalp engine.
 */
const SUPPORTED_PAIRS =
  Object.freeze([
    "XAUUSD",
    "GBPJPY"
  ]);

/*
 * These modes match the current production Scalp engine.
 */
const SUPPORTED_MODES =
  Object.freeze([
    "M5",
    "M15",
    "M30"
  ]);

const SUPPORTED_DIRECTIONS =
  Object.freeze([
    "BUY",
    "SELL"
  ]);

/*
 * Exact deterministic mapping between current Scalp modes and optimizer
 * timeframe keys.
 */
const MODE_TO_TIMEFRAME =
  Object.freeze({
    M5:
      "5m",

    M15:
      "15m",

    M30:
      "30m"
  });

/* =====================================================================
   Dry-Run Safety Limits
   ===================================================================== */

/*
 * The Phase A optimizer already limits one recommendation step to ±1.
 * Phase B1 repeats that protection independently.
 */
const MAX_FINAL_ADJUSTMENT =
  1;

const MIN_CONFIDENCE =
  0;

const MAX_CONFIDENCE =
  100;

const REQUIRED_OPTIMIZER_MODE =
  "shadow";

const REQUIRED_MINIMUM_TRADES =
  50;

const HASH_ALGORITHM =
  "sha256";

/*
 * Only these optimizer scope types may participate in Scalp resolution.
 *
 * No session, pattern or market-regime scope is accepted in Phase B1
 * because current source data does not provide reliable coverage for
 * those dimensions.
 */
const ALLOWED_SCOPE_TYPES =
  new Set([
    "pairEngineDirection",
    "pairEngine",
    "engineDirection",
    "pairDirection",
    "pair",
    "engine",
    "direction",
    "timeframe",
    "overall"
  ]);

/*
 * Deterministic most-specific-first precedence.
 *
 * Exactly one eligible recommendation may win.
 * Adjustments are never added together.
 *
 * This order is a Phase B1 safety policy:
 *
 * 1. Exact pair + scalp engine + direction
 * 2. Pair + scalp engine
 * 3. Scalp engine + direction
 * 4. Pair + direction
 * 5. Pair
 * 6. Scalp engine
 * 7. Direction
 * 8. Exact mode timeframe
 * 9. Overall
 *
 * If the selected recommendation is malformed or unavailable, resolution
 * returns adjustment 0. It does not silently move to a less specific
 * recommendation after selecting an invalid eligible candidate.
 */
const SCOPE_PRECEDENCE =
  Object.freeze([
    "pairEngineDirection",
    "pairEngine",
    "engineDirection",
    "pairDirection",
    "pair",
    "engine",
    "direction",
    "timeframe",
    "overall"
  ]);

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

  const factor =
    10 ** precision;

  return Math.round(
    (
      number +
      Number.EPSILON
    ) *
    factor
  ) / factor;

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
   Scalp Context Normalization
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

function normalizeDirection(
  value
) {

  const normalized =
    toTrimmedString(
      value
    ).toUpperCase();

  return SUPPORTED_DIRECTIONS.includes(
    normalized
  )
    ? normalized
    : null;

}

function normalizeMode(
  value
) {

  const normalized =
    toTrimmedString(
      value
    ).toUpperCase();

  return SUPPORTED_MODES.includes(
    normalized
  )
    ? normalized
    : null;

}

function normalizeTimeframe(
  value
) {

  const text =
    toTrimmedString(
      value
    ).toUpperCase();

  const mapping =
    {
      "5M":
        "5m",

      "15M":
        "15m",

      "30M":
        "30m"
    };

  return mapping[text] ||
    null;

}

function timeframeForMode(
  mode
) {

  const normalizedMode =
    normalizeMode(
      mode
    );

  if (
    normalizedMode === null
  ) {

    return null;

  }

  return MODE_TO_TIMEFRAME[
    normalizedMode
  ] || null;

}

function createScalpContext({
  pair,
  direction,
  mode
}) {

  const normalizedPair =
    normalizePair(
      pair
    );

  const normalizedDirection =
    normalizeDirection(
      direction
    );

  const normalizedMode =
    normalizeMode(
      mode
    );

  if (
    normalizedPair === null ||
    normalizedDirection === null ||
    normalizedMode === null
  ) {

    return null;

  }

  const timeframe =
    timeframeForMode(
      normalizedMode
    );

  if (
    timeframe === null
  ) {

    return null;

  }

  return {
    pair:
      normalizedPair,

    engine:
      TARGET_ENGINE,

    direction:
      normalizedDirection,

    mode:
      normalizedMode,

    timeframe
  };

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
          "[adaptive-execution] Unable to remove temporary file:",
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
      `[adaptive-execution] Unable to hash ${path.relative(
        ROOT_DIR,
        filePath
      )}: ${error.message}`
    );

    return null;

  }

}

/* =====================================================================
   Phase A Optimizer Document Validation
   ===================================================================== */

function validateOptimizationSafety(
  document
) {

  const errors =
    [];

  if (
    !isPlainObject(
      document
    )
  ) {

    return {
      valid: false,
      errors: [
        "Adaptive optimization document must be a JSON object."
      ]
    };

  }

  if (
    document.version !==
      1
  ) {

    errors.push(
      "Adaptive optimization schema version is unsupported."
    );

  }

  if (
    document.mode !==
      REQUIRED_OPTIMIZER_MODE
  ) {

    errors.push(
      `Adaptive optimization mode must be ${REQUIRED_OPTIMIZER_MODE}.`
    );

  }

  if (
    !toISOStringOrNull(
      document.generatedAt
    )
  ) {

    errors.push(
      "Adaptive optimization generatedAt is invalid."
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
      "Adaptive optimization sourceUpdatedAt is invalid."
    );

  }

  if (
    !isPlainObject(
      document.activeParameters
    )
  ) {

    errors.push(
      "Adaptive optimization activeParameters section is missing."
    );

  } else if (
    document.activeParameters.applied !==
      false
  ) {

    errors.push(
      "Phase B1 requires activeParameters.applied to remain false."
    );

  }

  if (
    !isPlainObject(
      document.safety
    )
  ) {

    errors.push(
      "Adaptive optimization safety section is missing."
    );

  } else {

    if (
      document.safety.shadowOnly !==
        true
    ) {

      errors.push(
        "Adaptive optimization safety.shadowOnly must be true."
      );

    }

    if (
      document.safety.sourceCodeModification !==
        false
    ) {

      errors.push(
        "Adaptive optimization must not allow source-code modification."
      );

    }

    if (
      document.safety.externalApiCalls !==
        false
    ) {

      errors.push(
        "Adaptive optimization must not allow external API calls."
      );

    }

    if (
      document.safety.signalGeneration !==
        false
    ) {

      errors.push(
        "Adaptive optimization must not generate signals."
      );

    }

    if (
      document.safety.decisionModification !==
        false
    ) {

      errors.push(
        "Adaptive optimization must not modify decisions."
      );

    }

    if (
      document.safety.tradePlanModification !==
        false
    ) {

      errors.push(
        "Adaptive optimization must not modify trade plans."
      );

    }

    if (
      document.safety.telegramModification !==
        false
    ) {

      errors.push(
        "Adaptive optimization must not modify Telegram behavior."
      );

    }

    if (
      document.safety.minimumResolvedTrades !==
        REQUIRED_MINIMUM_TRADES
    ) {

      errors.push(
        `Adaptive optimization minimumResolvedTrades must equal ${REQUIRED_MINIMUM_TRADES}.`
      );

    }

    const maximumSingleStepChange =
      toFiniteNumber(
        document.safety
          .maximumSingleStepChange
      );

    if (
      maximumSingleStepChange ===
        null ||
      Math.abs(
        maximumSingleStepChange
      ) >
        MAX_FINAL_ADJUSTMENT
    ) {

      errors.push(
        "Adaptive optimization maximumSingleStepChange exceeds Phase B1 limits."
      );

    }

    if (
      document.safety.exactScopeOnly !==
        true
    ) {

      errors.push(
        "Adaptive optimization exactScopeOnly must be true."
      );

    }

  }

  if (
    !isPlainObject(
      document.validation
    )
  ) {

    errors.push(
      "Adaptive optimization validation section is missing."
    );

  } else {

    if (
      document.validation.valid !==
        true
    ) {

      errors.push(
        "Adaptive optimization document is not internally valid."
      );

    }

    if (
      !Array.isArray(
        document.validation.errors
      )
    ) {

      errors.push(
        "Adaptive optimization validation.errors must be an array."
      );

    } else if (
      document.validation.errors.length >
        0
    ) {

      errors.push(
        "Adaptive optimization contains validation errors."
      );

    }

  }

  if (
    !Array.isArray(
      document.recommendations
    )
  ) {

    errors.push(
      "Adaptive optimization recommendations must be an array."
    );

  }

  return {
    valid:
      errors.length === 0,

    errors:
      uniqueSortedStrings(
        errors
      )
  };

}

/* =====================================================================
   Recommendation Validation
   ===================================================================== */

function validateScopeIdentity(
  scope,
  label
) {

  const errors =
    [];

  if (
    !isPlainObject(
      scope
    )
  ) {

    return {
      valid: false,
      errors: [
        `${label} must be a JSON object.`
      ]
    };

  }

  const type =
    toTrimmedString(
      scope.type
    );

  const key =
    toTrimmedString(
      scope.key
    );

  if (
    !ALLOWED_SCOPE_TYPES.has(
      type
    )
  ) {

    errors.push(
      `${label}.type is unsupported for scalp execution.`
    );

  }

  if (
    !key
  ) {

    errors.push(
      `${label}.key is invalid.`
    );

  }

  if (
    scope.pair !== null &&
    scope.pair !== undefined &&
    normalizePair(
      scope.pair
    ) ===
      null
  ) {

    errors.push(
      `${label}.pair is invalid.`
    );

  }

  if (
    scope.engine !== null &&
    scope.engine !== undefined &&
    toTrimmedString(
      scope.engine
    ).toLowerCase() !==
      TARGET_ENGINE
  ) {

    errors.push(
      `${label}.engine is not a scalp engine.`
    );

  }

  if (
    scope.direction !== null &&
    scope.direction !== undefined &&
    normalizeDirection(
      scope.direction
    ) ===
      null
  ) {

    errors.push(
      `${label}.direction is invalid.`
    );

  }

  if (
    scope.timeframe !== null &&
    scope.timeframe !== undefined &&
    normalizeTimeframe(
      scope.timeframe
    ) ===
      null
  ) {

    errors.push(
      `${label}.timeframe is unsupported for the current scalp modes.`
    );

  }

  return {
    valid:
      errors.length === 0,

    errors:
      uniqueSortedStrings(
        errors
      )
  };

}

function validateRecommendationEligibility(
  eligibility,
  label
) {

  const errors =
    [];

  if (
    !isPlainObject(
      eligibility
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

  const totalTrades =
    toNonNegativeInteger(
      eligibility.totalTrades
    );

  const requiredTrades =
    toNonNegativeInteger(
      eligibility.requiredTrades
    );

  const remainingTrades =
    toNonNegativeInteger(
      eligibility.remainingTrades
    );

  if (
    typeof eligibility.eligible !==
      "boolean"
  ) {

    errors.push(
      `${label}.eligible must be boolean.`
    );

  }

  if (
    totalTrades === null
  ) {

    errors.push(
      `${label}.totalTrades is invalid.`
    );

  }

  if (
    requiredTrades !==
      REQUIRED_MINIMUM_TRADES
  ) {

    errors.push(
      `${label}.requiredTrades must equal ${REQUIRED_MINIMUM_TRADES}.`
    );

  }

  if (
    remainingTrades === null
  ) {

    errors.push(
      `${label}.remainingTrades is invalid.`
    );

  }

  if (
    eligibility.eligible ===
      true &&
    totalTrades !== null &&
    totalTrades <
      REQUIRED_MINIMUM_TRADES
  ) {

    errors.push(
      `${label} is eligible below the required sample size.`
    );

  }

  if (
    eligibility.eligible ===
      true &&
    remainingTrades !==
      null &&
    remainingTrades !==
      0
  ) {

    errors.push(
      `${label}.remainingTrades must be zero for an eligible scope.`
    );

  }

  if (
    eligibility.eligible ===
      false &&
    totalTrades !== null &&
    totalTrades <
      REQUIRED_MINIMUM_TRADES &&
    remainingTrades !==
      (
        REQUIRED_MINIMUM_TRADES -
        totalTrades
      )
  ) {

    errors.push(
      `${label}.remainingTrades is inconsistent.`
    );

  }

  return {
    valid:
      errors.length === 0,

    value:
      errors.length === 0
        ? {
            eligible:
              eligibility.eligible,

            status:
              toTrimmedString(
                eligibility.status
              ),

            totalTrades,

            requiredTrades,

            remainingTrades
          }
        : null,

    errors:
      uniqueSortedStrings(
        errors
      )
  };

}

function validateConfidenceRecommendation(
  recommendation,
  label
) {

  const errors =
    [];

  if (
    !isPlainObject(
      recommendation
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

  if (
    typeof recommendation.available !==
      "boolean"
  ) {

    errors.push(
      `${label}.available must be boolean.`
    );

  }

  const requestedAdjustment =
    toFiniteNumber(
      recommendation
        .requestedAdjustment
    );

  const boundedAdjustment =
    toFiniteNumber(
      recommendation
        .boundedAdjustment
    );

  if (
    requestedAdjustment ===
      null
  ) {

    errors.push(
      `${label}.requestedAdjustment is invalid.`
    );

  }

  if (
    boundedAdjustment ===
      null
  ) {

    errors.push(
      `${label}.boundedAdjustment is invalid.`
    );

  } else if (
    Math.abs(
      boundedAdjustment
    ) >
      MAX_FINAL_ADJUSTMENT
  ) {

    errors.push(
      `${label}.boundedAdjustment exceeds ±${MAX_FINAL_ADJUSTMENT}.`
    );

  }

  let baseline =
    null;

  let recommendedConfidence =
    null;

  if (
    recommendation.available ===
      true
  ) {

    baseline =
      clamp(
        recommendation.baseline,
        MIN_CONFIDENCE,
        MAX_CONFIDENCE
      );

    recommendedConfidence =
      clamp(
        recommendation
          .recommendedConfidence,
        MIN_CONFIDENCE,
        MAX_CONFIDENCE
      );

    if (
      baseline === null
    ) {

      errors.push(
        `${label}.baseline is invalid.`
      );

    }

    if (
      recommendedConfidence ===
        null
    ) {

      errors.push(
        `${label}.recommendedConfidence is invalid.`
      );

    }

    if (
      !toTrimmedString(
        recommendation
          .baselineSource
      )
    ) {

      errors.push(
        `${label}.baselineSource is missing.`
      );

    }

  } else {

    if (
      boundedAdjustment !==
        null &&
      boundedAdjustment !==
        0
    ) {

      errors.push(
        `${label} contains a non-zero adjustment while unavailable.`
      );

    }

  }

  return {
    valid:
      errors.length === 0,

    value:
      errors.length === 0
        ? {
            available:
              recommendation.available,

            baseline:
              baseline === null
                ? null
                : round(
                    baseline,
                    4
                  ),

            baselineSource:
              recommendation.available
                ? toTrimmedString(
                    recommendation
                      .baselineSource
                  )
                : null,

            requestedAdjustment:
              round(
                requestedAdjustment,
                4
              ),

            boundedAdjustment:
              round(
                boundedAdjustment,
                4
              ),

            recommendedConfidence:
              recommendedConfidence ===
                null
                ? null
                : round(
                    recommendedConfidence,
                    4
                  )
          }
        : null,

    errors:
      uniqueSortedStrings(
        errors
      )
  };

}

function normalizeOptimizationRecommendation(
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
      value: null,
      errors: [
        `${label} must be a JSON object.`
      ],
      warnings
    };

  }

  if (
    recommendation.valid !==
      true
  ) {

    errors.push(
      `${label}.valid must be true.`
    );

  }

  if (
    recommendation.shadowOnly !==
      true
  ) {

    errors.push(
      `${label}.shadowOnly must be true.`
    );

  }

  const scopeResult =
    validateScopeIdentity(
      recommendation.scope,
      `${label}.scope`
    );

  errors.push(
    ...scopeResult.errors
  );

  const eligibilityResult =
    validateRecommendationEligibility(
      recommendation.eligibility,
      `${label}.eligibility`
    );

  errors.push(
    ...eligibilityResult.errors
  );

  const confidenceResult =
    validateConfidenceRecommendation(
      recommendation
        .confidenceRecommendation,
      `${label}.confidenceRecommendation`
    );

  errors.push(
    ...confidenceResult.errors
  );

  if (
    Array.isArray(
      recommendation.errors
    ) &&
    recommendation.errors.length >
      0
  ) {

    errors.push(
      `${label} contains internal recommendation errors.`
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

  if (
    errors.length >
      0
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

  const scope =
    recommendation.scope;

  return {
    valid: true,

    value: {
      sourceIndex:
        index,

      scope: {
        type:
          toTrimmedString(
            scope.type
          ),

        key:
          toTrimmedString(
            scope.key
          ),

        pair:
          scope.pair === null ||
          scope.pair === undefined
            ? null
            : normalizePair(
                scope.pair
              ),

        engine:
          scope.engine === null ||
          scope.engine === undefined
            ? null
            : TARGET_ENGINE,

        direction:
          scope.direction === null ||
          scope.direction === undefined
            ? null
            : normalizeDirection(
                scope.direction
              ),

        timeframe:
          scope.timeframe === null ||
          scope.timeframe === undefined
            ? null
            : normalizeTimeframe(
                scope.timeframe
              )
      },

      eligibility:
        eligibilityResult.value,

      confidenceRecommendation:
        confidenceResult.value,

      profitability:
        isPlainObject(
          recommendation.profitability
        )
          ? cloneJSONCompatible(
              recommendation.profitability
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
   Scalp Relevance Filtering
   ===================================================================== */

/**
 * Phase A may contain recommendations for daily, weekly or future
 * engines. Phase B1 is scalp-only, so unrelated scopes are safely
 * ignored rather than treated as source corruption.
 */
function isRecommendationRelevantToScalp(
  recommendation
) {

  const scope =
    recommendation?.scope;

  if (
    !isPlainObject(
      scope
    )
  ) {

    return {
      relevant: false,
      reason:
        "Recommendation scope is missing."
    };

  }

  const scopeType =
    toTrimmedString(
      scope.type
    );

  if (
    !ALLOWED_SCOPE_TYPES.has(
      scopeType
    )
  ) {

    return {
      relevant: false,
      reason:
        `Scope type ${scopeType || "unknown"} is not used by scalp Phase B1.`
    };

  }

  if (
    scope.engine !== null &&
    scope.engine !== undefined
  ) {

    const engine =
      toTrimmedString(
        scope.engine
      ).toLowerCase();

    if (
      engine !==
        TARGET_ENGINE
    ) {

      return {
        relevant: false,
        reason:
          `Engine ${engine || "unknown"} is outside scalp Phase B1.`
      };

    }

  }

  return {
    relevant: true,
    reason: null
  };

}

/* =====================================================================
   Recommendation Indexing
   ===================================================================== */

function createRecommendationId(
  recommendation
) {

  if (
    !isPlainObject(
      recommendation?.scope
    )
  ) {

    return null;

  }

  const type =
    toTrimmedString(
      recommendation.scope.type
    );

  const key =
    toTrimmedString(
      recommendation.scope.key
    );

  if (
    !type ||
    !key
  ) {

    return null;

  }

  return `${type}::${key}`;

}

function buildRecommendationIndex(
  document
) {

  const errors =
    [];

  const warnings =
    [];

  const index =
    new Map();

  const safetyResult =
    validateOptimizationSafety(
      document
    );

  if (
    !safetyResult.valid
  ) {

    return {
      valid: false,
      index,
      recommendations: [],
      errors:
        safetyResult.errors,
      warnings
    };

  }

  const normalizedRecommendations =
    [];

  for (
    let recommendationIndex = 0;
    recommendationIndex <
      document.recommendations.length;
    recommendationIndex++
  ) {

    const sourceRecommendation =
      document.recommendations[
        recommendationIndex
      ];

    const relevance =
      isRecommendationRelevantToScalp(
        sourceRecommendation
      );

    if (
      !relevance.relevant
    ) {

      warnings.push(
        `Skipped recommendations[${recommendationIndex}]: ${relevance.reason}`
      );

      continue;

    }

    const result =
      normalizeOptimizationRecommendation(
        sourceRecommendation,
        recommendationIndex
      );

    warnings.push(
      ...result.warnings
    );

    if (
      !result.valid
    ) {

      errors.push(
        ...result.errors
      );

      continue;

    }

    const recommendationId =
      createRecommendationId(
        result.value
      );

    if (
      recommendationId ===
        null
    ) {

      errors.push(
        `Unable to create recommendation identity for source index ${recommendationIndex}.`
      );

      continue;

    }

    if (
      index.has(
        recommendationId
      )
    ) {

      errors.push(
        `Duplicate optimizer recommendation: ${recommendationId}.`
      );

      continue;

    }

    index.set(
      recommendationId,
      result.value
    );

    normalizedRecommendations.push(
      result.value
    );

  }

  return {
    valid:
      errors.length === 0,

    index,

    recommendations:
      normalizedRecommendations.sort(
        (
          left,
          right
        ) =>
          createRecommendationId(
            left
          ).localeCompare(
            createRecommendationId(
              right
            )
          )
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
   Optimizer State Validation
   ===================================================================== */

function validateOptimizationState(
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
        "Adaptive optimization state must be a JSON object."
      ]
    };

  }

  if (
    state.version !==
      1
  ) {

    errors.push(
      "Adaptive optimization state schema version is unsupported."
    );

  }

  if (
    state.mode !==
      REQUIRED_OPTIMIZER_MODE
  ) {

    errors.push(
      "Adaptive optimization state mode must remain shadow."
    );

  }

  if (
    !toISOStringOrNull(
      state.lastSuccessfulRunAt
    )
  ) {

    errors.push(
      "Adaptive optimization state lastSuccessfulRunAt is invalid."
    );

  }

  if (
    !isPlainObject(
      state.lastRun
    )
  ) {

    errors.push(
      "Adaptive optimization state lastRun section is missing."
    );

  } else {

    const acceptedStatuses =
      new Set([
        "UPDATED",
        "UNCHANGED"
      ]);

    if (
      !acceptedStatuses.has(
        toTrimmedString(
          state.lastRun.status
        )
      )
    ) {

      errors.push(
        "Adaptive optimization state last run was not successful."
      );

    }

    if (
      state.lastRun.stateWritten !==
        true
    ) {

      errors.push(
        "Adaptive optimization state was not persisted successfully."
      );

    }

    if (
      state.lastRun.error !==
        null
    ) {

      errors.push(
        "Adaptive optimization state contains a last-run error."
      );

    }

  }

  if (
    !toTrimmedString(
      state.outputHash
    )
  ) {

    errors.push(
      "Adaptive optimization state outputHash is missing."
    );

  }

  return {
    valid:
      errors.length === 0,

    errors:
      uniqueSortedStrings(
        errors
      )
  };

}

/* =====================================================================
   Source Bundle Loading
   ===================================================================== */

function loadOptimizationSources() {

  const errors =
    [];

  const warnings =
    [];

  const optimizationRead =
    readJSONFile(
      OPTIMIZATION_PATH,
      null
    );

  if (
    !optimizationRead.ok
  ) {

    errors.push(
      optimizationRead.error ||
      "Unable to read adaptive optimization output."
    );

  }

  const optimizationStateRead =
    readJSONFile(
      OPTIMIZATION_STATE_PATH,
      null
    );

  if (
    !optimizationStateRead.ok
  ) {

    errors.push(
      optimizationStateRead.error ||
      "Unable to read adaptive optimization state."
    );

  }

  if (
    errors.length >
      0
  ) {

    return {
      valid: false,
      document: null,
      state: null,
      recommendationIndex:
        new Map(),
      recommendations: [],
      sourceHashes: {
        optimization:
          null,
        optimizationState:
          null
      },
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

  const recommendationIndexResult =
    buildRecommendationIndex(
      optimizationRead.value
    );

  errors.push(
    ...recommendationIndexResult.errors
  );

  warnings.push(
    ...recommendationIndexResult.warnings
  );

  const stateValidation =
    validateOptimizationState(
      optimizationStateRead.value
    );

  errors.push(
    ...stateValidation.errors
  );

  const optimizationHash =
    createFileContentHash(
      OPTIMIZATION_PATH
    );

  const optimizationStateHash =
    createFileContentHash(
      OPTIMIZATION_STATE_PATH
    );

  if (
    optimizationHash ===
      null
  ) {

    errors.push(
      "Unable to hash adaptive optimization output."
    );

  }

  if (
    optimizationStateHash ===
      null
  ) {

    errors.push(
      "Unable to hash adaptive optimization state."
    );

  }

  const expectedOutputHash =
    toTrimmedString(
      optimizationStateRead
        .value
        ?.outputHash
    );

  if (
    optimizationHash !==
      null &&
    expectedOutputHash &&
    optimizationHash !==
      expectedOutputHash
  ) {

    errors.push(
      "Adaptive optimization output hash does not match optimizer state."
    );

  }

  return {
    valid:
      errors.length === 0,

    document:
      errors.length === 0
        ? optimizationRead.value
        : null,

    state:
      errors.length === 0
        ? optimizationStateRead.value
        : null,

    recommendationIndex:
      errors.length === 0
        ? recommendationIndexResult.index
        : new Map(),

    recommendations:
      errors.length === 0
        ? recommendationIndexResult
            .recommendations
        : [],

    sourceHashes: {
      optimization:
        optimizationHash,

      optimizationState:
        optimizationStateHash
    },

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
   Scalp Candidate Identity Construction
   ===================================================================== */

/**
 * Build exact optimizer recommendation identities for one verified
 * scalp context.
 *
 * The returned candidates follow SCOPE_PRECEDENCE exactly.
 * Recommendation adjustments are never summed.
 */
function buildScalpCandidateIds(
  context
) {

  if (
    !isPlainObject(
      context
    )
  ) {

    return [];
  }

  const pair =
    normalizePair(
      context.pair
    );

  const direction =
    normalizeDirection(
      context.direction
    );

  const mode =
    normalizeMode(
      context.mode
    );

  const timeframe =
    timeframeForMode(
      mode
    );

  if (
    pair === null ||
    direction === null ||
    mode === null ||
    timeframe === null
  ) {

    return [];

  }

  return [
    {
      precedence:
        1,

      scopeType:
        "pairEngineDirection",

      recommendationId:
        (
          "pairEngineDirection::" +
          `${pair}::${TARGET_ENGINE}::${direction}`
        )
    },

    {
      precedence:
        2,

      scopeType:
        "pairEngine",

      recommendationId:
        (
          "pairEngine::" +
          `${pair}::${TARGET_ENGINE}`
        )
    },

    {
      precedence:
        3,

      scopeType:
        "engineDirection",

      recommendationId:
        (
          "engineDirection::" +
          `${TARGET_ENGINE}::${direction}`
        )
    },

    {
      precedence:
        4,

      scopeType:
        "pairDirection",

      recommendationId:
        (
          "pairDirection::" +
          `${pair}::${direction}`
        )
    },

    {
      precedence:
        5,

      scopeType:
        "pair",

      recommendationId:
        `pair::${pair}`
    },

    {
      precedence:
        6,

      scopeType:
        "engine",

      recommendationId:
        `engine::${TARGET_ENGINE}`
    },

    {
      precedence:
        7,

      scopeType:
        "direction",

      recommendationId:
        `direction::${direction}`
    },

    {
      precedence:
        8,

      scopeType:
        "timeframe",

      recommendationId:
        `timeframe::${timeframe}`
    },

    {
      precedence:
        9,

      scopeType:
        "overall",

      recommendationId:
        "overall::overall"
    }
  ];

}

/* =====================================================================
   Candidate Eligibility Validation
   ===================================================================== */

function evaluateExecutionCandidate(
  recommendation,
  candidate
) {

  const reasons =
    [];

  if (
    !isPlainObject(
      recommendation
    )
  ) {

    return {
      usable: false,
      status:
        "MISSING",

      adjustment: 0,

      reasons: [
        "Recommendation is not present in the optimizer output."
      ]
    };

  }

  if (
    !isPlainObject(
      candidate
    )
  ) {

    return {
      usable: false,
      status:
        "INVALID_CANDIDATE",

      adjustment: 0,

      reasons: [
        "Candidate identity is invalid."
      ]
    };

  }

  if (
    recommendation
      ?.scope
      ?.type !==
      candidate.scopeType
  ) {

    reasons.push(
      "Recommendation scope type does not match candidate type."
    );

  }

  const eligibility =
    recommendation.eligibility;

  if (
    !isPlainObject(
      eligibility
    )
  ) {

    reasons.push(
      "Recommendation eligibility is unavailable."
    );

  } else {

    if (
      eligibility.eligible !==
        true
    ) {

      reasons.push(
        "Recommendation scope is not eligible."
      );

    }

    if (
      eligibility.totalTrades <
        REQUIRED_MINIMUM_TRADES
    ) {

      reasons.push(
        `Recommendation has fewer than ${REQUIRED_MINIMUM_TRADES} resolved trades.`
      );

    }

    if (
      eligibility.requiredTrades !==
        REQUIRED_MINIMUM_TRADES
    ) {

      reasons.push(
        "Recommendation sample requirement does not match Phase B1."
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

    reasons.push(
      "Confidence recommendation is unavailable."
    );

  } else {

    if (
      confidenceRecommendation.available !==
        true
    ) {

      reasons.push(
        "Confidence recommendation is not available."
      );

    }

  }

  const adjustment =
    toFiniteNumber(
      confidenceRecommendation
        ?.boundedAdjustment
    );

  if (
    adjustment === null
  ) {

    reasons.push(
      "Confidence adjustment is invalid."
    );

  } else if (
    Math.abs(
      adjustment
    ) >
      MAX_FINAL_ADJUSTMENT
  ) {

    reasons.push(
      `Confidence adjustment exceeds ±${MAX_FINAL_ADJUSTMENT}.`
    );

  }

  if (
    reasons.length >
      0
  ) {

    return {
      usable: false,

      status:
        eligibility?.eligible ===
          false
          ? "INELIGIBLE"
          : "INVALID",

      adjustment: 0,

      reasons:
        uniqueSortedStrings(
          reasons
        )
    };

  }

  return {
    usable: true,

    status:
      "USABLE",

    adjustment:
      round(
        clamp(
          adjustment,
          -MAX_FINAL_ADJUSTMENT,
          MAX_FINAL_ADJUSTMENT
        ),
        4
      ),

    reasons: [
      "Recommendation passed Phase B1 exact-scope safety checks."
    ]
  };

}

/* =====================================================================
   One-Winner Precedence Resolution
   ===================================================================== */

/**
 * Resolution rule:
 *
 * - Inspect candidates from most specific to least specific.
 * - The first present recommendation becomes the selected scope.
 * - If that first present recommendation is valid and eligible, use it.
 * - If that first present recommendation is invalid or ineligible,
 *   return adjustment 0.
 * - Do not bypass a more-specific present scope to use a broader scope.
 * - Do not stack multiple adjustments.
 *
 * This prevents broad positive evidence from overriding a more-specific
 * weak or insufficient scope.
 */
function resolveScalpContext({
  context,
  recommendationIndex
}) {

  const normalizedContext =
    createScalpContext(
      context
    );

  if (
    normalizedContext === null
  ) {

    return {
      valid: false,

      context: null,

      status:
        "INVALID_CONTEXT",

      selectedScope:
        null,

      proposedAdjustment: 0,

      liveApplied:
        false,

      candidates: [],

      reasons: [
        "Scalp context is invalid."
      ],

      errors: [
        "Unable to normalize scalp context."
      ],

      warnings: []
    };

  }

  if (
    !(recommendationIndex instanceof Map)
  ) {

    return {
      valid: false,

      context:
        normalizedContext,

      status:
        "INVALID_INDEX",

      selectedScope:
        null,

      proposedAdjustment: 0,

      liveApplied:
        false,

      candidates: [],

      reasons: [
        "Optimizer recommendation index is unavailable."
      ],

      errors: [
        "Recommendation index must be a Map."
      ],

      warnings: []
    };

  }

  const candidateDefinitions =
    buildScalpCandidateIds(
      normalizedContext
    );

  const inspectedCandidates =
    [];

  let firstPresentCandidate =
    null;

  let firstPresentRecommendation =
    null;

  for (
    const candidate of
    candidateDefinitions
  ) {

    const recommendation =
      recommendationIndex.get(
        candidate.recommendationId
      ) || null;

    const evaluation =
      recommendation === null
        ? {
            usable: false,
            status:
              "MISSING",
            adjustment: 0,
            reasons: [
              "Recommendation is absent."
            ]
          }
        : evaluateExecutionCandidate(
            recommendation,
            candidate
          );

    inspectedCandidates.push({
      precedence:
        candidate.precedence,

      scopeType:
        candidate.scopeType,

      recommendationId:
        candidate.recommendationId,

      present:
        recommendation !==
          null,

      usable:
        evaluation.usable,

      status:
        evaluation.status,

      adjustment:
        evaluation.adjustment,

      reasons:
        evaluation.reasons
    });

    if (
      recommendation !==
        null &&
      firstPresentCandidate ===
        null
    ) {

      firstPresentCandidate =
        candidate;

      firstPresentRecommendation =
        recommendation;

      break;

    }

  }

  if (
    firstPresentCandidate ===
      null ||
    firstPresentRecommendation ===
      null
  ) {

    return {
      valid: true,

      context:
        normalizedContext,

      status:
        "NO_RECOMMENDATION",

      selectedScope:
        null,

      proposedAdjustment: 0,

      liveApplied:
        false,

      candidates:
        inspectedCandidates,

      reasons: [
        "No optimizer recommendation exists for this scalp context."
      ],

      errors: [],

      warnings: []
    };

  }

  const selectedEvaluation =
    evaluateExecutionCandidate(
      firstPresentRecommendation,
      firstPresentCandidate
    );

  const selectedScope = {
    precedence:
      firstPresentCandidate
        .precedence,

    type:
      firstPresentCandidate
        .scopeType,

    key:
      firstPresentRecommendation
        .scope
        .key,

    recommendationId:
      firstPresentCandidate
        .recommendationId,

    totalTrades:
      firstPresentRecommendation
        .eligibility
        .totalTrades,

    classification:
      firstPresentRecommendation
        ?.profitability
        ?.classification ||
      null,

    baseline:
      firstPresentRecommendation
        .confidenceRecommendation
        .baseline,

    baselineSource:
      firstPresentRecommendation
        .confidenceRecommendation
        .baselineSource,

    optimizerAdjustment:
      firstPresentRecommendation
        .confidenceRecommendation
        .boundedAdjustment,

    optimizerRecommendedConfidence:
      firstPresentRecommendation
        .confidenceRecommendation
        .recommendedConfidence
  };

  if (
    !selectedEvaluation.usable
  ) {

    return {
      valid: true,

      context:
        normalizedContext,

      status:
        "BLOCKED_BY_MORE_SPECIFIC_SCOPE",

      selectedScope,

      proposedAdjustment: 0,

      liveApplied:
        false,

      candidates:
        inspectedCandidates,

      reasons: [
        (
          "The most-specific available recommendation is not usable; " +
          "broader scopes were not used."
        ),
        ...selectedEvaluation.reasons
      ],

      errors: [],

      warnings: []
    };

  }

  const boundedAdjustment =
    clamp(
      selectedEvaluation.adjustment,
      -MAX_FINAL_ADJUSTMENT,
      MAX_FINAL_ADJUSTMENT
    );

  if (
    boundedAdjustment ===
      null
  ) {

    return {
      valid: false,

      context:
        normalizedContext,

      status:
        "INVALID_ADJUSTMENT",

      selectedScope,

      proposedAdjustment: 0,

      liveApplied:
        false,

      candidates:
        inspectedCandidates,

      reasons: [
        "Selected adjustment could not be bounded safely."
      ],

      errors: [
        "Final proposed adjustment is invalid."
      ],

      warnings: []
    };

  }

  return {
    valid: true,

    context:
      normalizedContext,

    status:
      boundedAdjustment ===
        0
        ? "RESOLVED_NO_CHANGE"
        : "RESOLVED",

    selectedScope,

    proposedAdjustment:
      round(
        boundedAdjustment,
        4
      ),

    liveApplied:
      LIVE_APPLICATION_ENABLED,

    candidates:
      inspectedCandidates,

    reasons: [
      (
        `Selected the first available scope at precedence ` +
        `${firstPresentCandidate.precedence}.`
      ),
      "No recommendation adjustments were stacked.",
      "The result remains dry-run only."
    ],

    errors: [],

    warnings: []
  };

}

/* =====================================================================
   Full Scalp Context Matrix
   ===================================================================== */

/**
 * Build all supported Phase B1 test contexts:
 *
 * 2 pairs × 2 directions × 3 modes = 12 dry-run contexts.
 */
function buildSupportedScalpContexts() {

  const contexts =
    [];

  for (
    const pair of
    SUPPORTED_PAIRS
  ) {

    for (
      const direction of
      SUPPORTED_DIRECTIONS
    ) {

      for (
        const mode of
        SUPPORTED_MODES
      ) {

        const context =
          createScalpContext({
            pair,
            direction,
            mode
          });

        if (
          context !== null
        ) {

          contexts.push(
            context
          );

        }

      }

    }

  }

  return contexts.sort(
    (
      left,
      right
    ) => {

      const leftId =
        (
          `${left.pair}::` +
          `${left.direction}::` +
          `${left.mode}`
        );

      const rightId =
        (
          `${right.pair}::` +
          `${right.direction}::` +
          `${right.mode}`
        );

      return leftId.localeCompare(
        rightId
      );

    }
  );

}

/* =====================================================================
   Resolve All Supported Scalp Contexts
   ===================================================================== */

function resolveAllScalpContexts(
  recommendationIndex
) {

  const contexts =
    buildSupportedScalpContexts();

  const resolutions =
    [];

  const errors =
    [];

  const warnings =
    [];

  for (
    const context of
    contexts
  ) {

    const resolution =
      resolveScalpContext({
        context,
        recommendationIndex
      });

    resolutions.push(
      resolution
    );

    if (
      Array.isArray(
        resolution.errors
      )
    ) {

      errors.push(
        ...resolution.errors
      );

    }

    if (
      Array.isArray(
        resolution.warnings
      )
    ) {

      warnings.push(
        ...resolution.warnings
      );

    }

  }

  return {
    valid:
      errors.length ===
      0,

    resolutions,

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
   Resolution Summary
   ===================================================================== */

function summarizeScalpResolutions(
  resolutions
) {

  const summary = {
    totalContexts: 0,
    resolvedContexts: 0,
    noChangeContexts: 0,
    blockedContexts: 0,
    noRecommendationContexts: 0,
    invalidContexts: 0,
    positiveAdjustments: 0,
    negativeAdjustments: 0,
    zeroAdjustments: 0,
    liveAppliedContexts: 0
  };

  if (
    !Array.isArray(
      resolutions
    )
  ) {

    return summary;

  }

  for (
    const resolution of
    resolutions
  ) {

    if (
      !isPlainObject(
        resolution
      )
    ) {

      continue;

    }

    summary.totalContexts +=
      1;

    if (
      resolution.status ===
        "RESOLVED"
    ) {

      summary.resolvedContexts +=
        1;

    } else if (
      resolution.status ===
        "RESOLVED_NO_CHANGE"
    ) {

      summary.noChangeContexts +=
        1;

    } else if (
      resolution.status ===
        "BLOCKED_BY_MORE_SPECIFIC_SCOPE"
    ) {

      summary.blockedContexts +=
        1;

    } else if (
      resolution.status ===
        "NO_RECOMMENDATION"
    ) {

      summary.noRecommendationContexts +=
        1;

    } else {

      summary.invalidContexts +=
        1;

    }

    const adjustment =
      toFiniteNumber(
        resolution.proposedAdjustment
      ) || 0;

    if (
      adjustment >
        0
    ) {

      summary.positiveAdjustments +=
        1;

    } else if (
      adjustment <
        0
    ) {

      summary.negativeAdjustments +=
        1;

    } else {

      summary.zeroAdjustments +=
        1;

    }

    if (
      resolution.liveApplied ===
        true
    ) {

      summary.liveAppliedContexts +=
        1;

    }

  }

  return summary;

}

/* =====================================================================
   Dry-Run Output Summary
   ===================================================================== */

function createEmptyExecutionSummary() {

  return {
    totalContexts: 0,
    resolvedContexts: 0,
    noChangeContexts: 0,
    blockedContexts: 0,
    noRecommendationContexts: 0,
    invalidContexts: 0,
    positiveAdjustments: 0,
    negativeAdjustments: 0,
    zeroAdjustments: 0,
    liveAppliedContexts: 0
  };

}

/* =====================================================================
   Dry-Run Output Document
   ===================================================================== */

function createEmptyExecutionDocument(
  generatedAt =
    new Date().toISOString()
) {

  return {
    version:
      EXECUTION_SCHEMA_VERSION,

    engineName:
      ENGINE_NAME,

    engineVersion:
      ENGINE_VERSION,

    mode:
      EXECUTION_MODE,

    targetEngine:
      TARGET_ENGINE,

    generatedAt,

    sourceUpdatedAt:
      null,

    summary:
      createEmptyExecutionSummary(),

    resolutions:
      [],

    activeExecution: {
      enabled:
        false,

      liveApplied:
        false,

      reason:
        "Phase B1 is dry-run only and is not consumed by the production Scalp engine.",

      confidenceAdjustments:
        {}
    },

    precedencePolicy: {
      strategy:
        "FIRST_PRESENT_MOST_SPECIFIC_SCOPE",

      stackingAllowed:
        false,

      broaderFallbackAfterPresentScopeFailure:
        false,

      order:
        cloneJSONCompatible(
          SCOPE_PRECEDENCE
        )
    },

    source: {
      optimizationPath:
        path.relative(
          ROOT_DIR,
          OPTIMIZATION_PATH
        ),

      optimizationStatePath:
        path.relative(
          ROOT_DIR,
          OPTIMIZATION_STATE_PATH
        ),

      optimizationHash:
        null,

      optimizationStateHash:
        null,

      optimizationGeneratedAt:
        null,

      optimizationSourceUpdatedAt:
        null,

      optimizerLastSuccessfulRunAt:
        null
    },

    safety: {
      dryRunOnly:
        true,

      liveApplicationEnabled:
        LIVE_APPLICATION_ENABLED,

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

      existingSchemaModification:
        false,

      targetEngine:
        TARGET_ENGINE,

      minimumResolvedTrades:
        REQUIRED_MINIMUM_TRADES,

      maximumFinalAdjustment:
        MAX_FINAL_ADJUSTMENT,

      recommendationStacking:
        false,

      exactContextResolution:
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

      supportedPairs:
        cloneJSONCompatible(
          SUPPORTED_PAIRS
        ),

      supportedDirections:
        cloneJSONCompatible(
          SUPPORTED_DIRECTIONS
        ),

      supportedModes:
        cloneJSONCompatible(
          SUPPORTED_MODES
        ),

      totalSupportedContexts:
        (
          SUPPORTED_PAIRS.length *
          SUPPORTED_DIRECTIONS.length *
          SUPPORTED_MODES.length
        ),

      missingRecommendationPolicy:
        "Missing candidates are skipped until the first present recommendation is found.",

      ineligibleSpecificScopePolicy:
        "A present but unusable more-specific scope blocks broader fallback and produces adjustment 0.",

      applicationPolicy:
        "Results are advisory dry-run outputs and are not consumed by live strategy engines."
    }
  };

}

/* =====================================================================
   Resolution Entry Validation
   ===================================================================== */

function validateExecutionContext(
  context,
  label
) {

  const errors =
    [];

  if (
    !isPlainObject(
      context
    )
  ) {

    return {
      valid: false,

      errors: [
        `${label} must be a JSON object.`
      ]
    };

  }

  const normalized =
    createScalpContext({
      pair:
        context.pair,

      direction:
        context.direction,

      mode:
        context.mode
    });

  if (
    normalized === null
  ) {

    errors.push(
      `${label} is not a supported Scalp context.`
    );

  } else {

    if (
      context.engine !==
        TARGET_ENGINE
    ) {

      errors.push(
        `${label}.engine must equal ${TARGET_ENGINE}.`
      );

    }

    if (
      context.timeframe !==
        normalized.timeframe
    ) {

      errors.push(
        `${label}.timeframe does not match the Scalp mode.`
      );

    }

  }

  return {
    valid:
      errors.length === 0,

    errors:
      uniqueSortedStrings(
        errors
      )
  };

}

function validateSelectedScope(
  selectedScope,
  label
) {

  const errors =
    [];

  if (
    selectedScope === null
  ) {

    return {
      valid: true,
      errors
    };

  }

  if (
    !isPlainObject(
      selectedScope
    )
  ) {

    return {
      valid: false,

      errors: [
        `${label} must be null or a JSON object.`
      ]
    };

  }

  const precedence =
    toNonNegativeInteger(
      selectedScope.precedence
    );

  if (
    precedence === null ||
    precedence < 1 ||
    precedence >
      SCOPE_PRECEDENCE.length
  ) {

    errors.push(
      `${label}.precedence is invalid.`
    );

  }

  const type =
    toTrimmedString(
      selectedScope.type
    );

  if (
    !ALLOWED_SCOPE_TYPES.has(
      type
    )
  ) {

    errors.push(
      `${label}.type is unsupported.`
    );

  }

  if (
    precedence !== null &&
    precedence >= 1 &&
    precedence <=
      SCOPE_PRECEDENCE.length &&
    SCOPE_PRECEDENCE[
      precedence - 1
    ] !==
      type
  ) {

    errors.push(
      `${label}.precedence does not match the configured scope order.`
    );

  }

  if (
    !toTrimmedString(
      selectedScope.key
    )
  ) {

    errors.push(
      `${label}.key is invalid.`
    );

  }

  if (
    !toTrimmedString(
      selectedScope.recommendationId
    )
  ) {

    errors.push(
      `${label}.recommendationId is invalid.`
    );

  }

  const totalTrades =
    toNonNegativeInteger(
      selectedScope.totalTrades
    );

  if (
    totalTrades === null
  ) {

    errors.push(
      `${label}.totalTrades is invalid.`
    );

  }

  const optimizerAdjustment =
    toFiniteNumber(
      selectedScope.optimizerAdjustment
    );

  if (
    optimizerAdjustment === null ||
    Math.abs(
      optimizerAdjustment
    ) >
      MAX_FINAL_ADJUSTMENT
  ) {

    errors.push(
      `${label}.optimizerAdjustment exceeds Phase B1 limits.`
    );

  }

  return {
    valid:
      errors.length === 0,

    errors:
      uniqueSortedStrings(
        errors
      )
  };

}

function validateInspectedCandidate(
  candidate,
  label
) {

  const errors =
    [];

  if (
    !isPlainObject(
      candidate
    )
  ) {

    return {
      valid: false,

      errors: [
        `${label} must be a JSON object.`
      ]
    };

  }

  const precedence =
    toNonNegativeInteger(
      candidate.precedence
    );

  if (
    precedence === null ||
    precedence < 1 ||
    precedence >
      SCOPE_PRECEDENCE.length
  ) {

    errors.push(
      `${label}.precedence is invalid.`
    );

  }

  const scopeType =
    toTrimmedString(
      candidate.scopeType
    );

  if (
    !ALLOWED_SCOPE_TYPES.has(
      scopeType
    )
  ) {

    errors.push(
      `${label}.scopeType is unsupported.`
    );

  }

  if (
    precedence !== null &&
    precedence >= 1 &&
    precedence <=
      SCOPE_PRECEDENCE.length &&
    SCOPE_PRECEDENCE[
      precedence - 1
    ] !==
      scopeType
  ) {

    errors.push(
      `${label}.precedence does not match scopeType.`
    );

  }

  if (
    !toTrimmedString(
      candidate.recommendationId
    )
  ) {

    errors.push(
      `${label}.recommendationId is invalid.`
    );

  }

  if (
    typeof candidate.present !==
      "boolean"
  ) {

    errors.push(
      `${label}.present must be boolean.`
    );

  }

  if (
    typeof candidate.usable !==
      "boolean"
  ) {

    errors.push(
      `${label}.usable must be boolean.`
    );

  }

  const adjustment =
    toFiniteNumber(
      candidate.adjustment
    );

  if (
    adjustment === null ||
    Math.abs(
      adjustment
    ) >
      MAX_FINAL_ADJUSTMENT
  ) {

    errors.push(
      `${label}.adjustment exceeds Phase B1 limits.`
    );

  }

  if (
    candidate.present ===
      false &&
    candidate.usable ===
      true
  ) {

    errors.push(
      `${label} cannot be usable when recommendation is absent.`
    );

  }

  if (
    !Array.isArray(
      candidate.reasons
    )
  ) {

    errors.push(
      `${label}.reasons must be an array.`
    );

  }

  return {
    valid:
      errors.length === 0,

    errors:
      uniqueSortedStrings(
        errors
      )
  };

}

function validateExecutionResolution(
  resolution,
  index
) {

  const errors =
    [];

  const warnings =
    [];

  const label =
    `resolutions[${index}]`;

  if (
    !isPlainObject(
      resolution
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
    resolution.valid !==
      true
  ) {

    errors.push(
      `${label}.valid must be true.`
    );

  }

  const contextResult =
    validateExecutionContext(
      resolution.context,
      `${label}.context`
    );

  errors.push(
    ...contextResult.errors
  );

  const acceptedStatuses =
    new Set([
      "RESOLVED",
      "RESOLVED_NO_CHANGE",
      "BLOCKED_BY_MORE_SPECIFIC_SCOPE",
      "NO_RECOMMENDATION"
    ]);

  if (
    !acceptedStatuses.has(
      toTrimmedString(
        resolution.status
      )
    )
  ) {

    errors.push(
      `${label}.status is invalid.`
    );

  }

  const proposedAdjustment =
    toFiniteNumber(
      resolution.proposedAdjustment
    );

  if (
    proposedAdjustment ===
      null ||
    Math.abs(
      proposedAdjustment
    ) >
      MAX_FINAL_ADJUSTMENT
  ) {

    errors.push(
      `${label}.proposedAdjustment exceeds Phase B1 limits.`
    );

  }

  if (
    resolution.liveApplied !==
      false
  ) {

    errors.push(
      `${label}.liveApplied must remain false.`
    );

  }

  if (
    resolution.status ===
      "BLOCKED_BY_MORE_SPECIFIC_SCOPE" &&
    proposedAdjustment !==
      0
  ) {

    errors.push(
      `${label} blocked resolution must have adjustment 0.`
    );

  }

  if (
    resolution.status ===
      "NO_RECOMMENDATION" &&
    proposedAdjustment !==
      0
  ) {

    errors.push(
      `${label} no-recommendation resolution must have adjustment 0.`
    );

  }

  if (
    resolution.status ===
      "RESOLVED" &&
    proposedAdjustment ===
      0
  ) {

    errors.push(
      `${label} RESOLVED status requires a non-zero adjustment.`
    );

  }

  if (
    resolution.status ===
      "RESOLVED_NO_CHANGE" &&
    proposedAdjustment !==
      0
  ) {

    errors.push(
      `${label} RESOLVED_NO_CHANGE status requires adjustment 0.`
    );

  }

  const selectedScopeResult =
    validateSelectedScope(
      resolution.selectedScope,
      `${label}.selectedScope`
    );

  errors.push(
    ...selectedScopeResult.errors
  );

  if (
    (
      resolution.status ===
        "RESOLVED" ||
      resolution.status ===
        "RESOLVED_NO_CHANGE" ||
      resolution.status ===
        "BLOCKED_BY_MORE_SPECIFIC_SCOPE"
    ) &&
    resolution.selectedScope ===
      null
  ) {

    errors.push(
      `${label}.selectedScope is required for status ${resolution.status}.`
    );

  }

  if (
    resolution.status ===
      "NO_RECOMMENDATION" &&
    resolution.selectedScope !==
      null
  ) {

    errors.push(
      `${label}.selectedScope must be null when no recommendation exists.`
    );

  }

  if (
    !Array.isArray(
      resolution.candidates
    )
  ) {

    errors.push(
      `${label}.candidates must be an array.`
    );

  } else {

    for (
      let candidateIndex = 0;
      candidateIndex <
        resolution.candidates.length;
      candidateIndex++
    ) {

      const candidateResult =
        validateInspectedCandidate(
          resolution.candidates[
            candidateIndex
          ],
          (
            `${label}.candidates[` +
            `${candidateIndex}]`
          )
        );

      errors.push(
        ...candidateResult.errors
      );

    }

  }

  if (
    !Array.isArray(
      resolution.reasons
    )
  ) {

    errors.push(
      `${label}.reasons must be an array.`
    );

  }

  if (
    Array.isArray(
      resolution.errors
    ) &&
    resolution.errors.length >
      0
  ) {

    errors.push(
      `${label} contains internal resolution errors.`
    );

  }

  if (
    Array.isArray(
      resolution.warnings
    )
  ) {

    warnings.push(
      ...resolution.warnings
    );

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
   Execution Document Validation
   ===================================================================== */

function validateExecutionDocument(
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
        "Adaptive execution document must be a JSON object."
      ],

      warnings
    };

  }

  if (
    document.version !==
      EXECUTION_SCHEMA_VERSION
  ) {

    errors.push(
      "Adaptive execution schema version is invalid."
    );

  }

  if (
    document.engineName !==
      ENGINE_NAME
  ) {

    errors.push(
      "Adaptive execution engine name is invalid."
    );

  }

  if (
    document.engineVersion !==
      ENGINE_VERSION
  ) {

    errors.push(
      "Adaptive execution engine version is invalid."
    );

  }

  if (
    document.mode !==
      EXECUTION_MODE
  ) {

    errors.push(
      `Adaptive execution mode must remain ${EXECUTION_MODE}.`
    );

  }

  if (
    document.targetEngine !==
      TARGET_ENGINE
  ) {

    errors.push(
      `Adaptive execution targetEngine must equal ${TARGET_ENGINE}.`
    );

  }

  if (
    !toISOStringOrNull(
      document.generatedAt
    )
  ) {

    errors.push(
      "Adaptive execution generatedAt is invalid."
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
      "Adaptive execution sourceUpdatedAt is invalid."
    );

  }

  if (
    !Array.isArray(
      document.resolutions
    )
  ) {

    errors.push(
      "Adaptive execution resolutions must be an array."
    );

  } else {

    const expectedContextCount =
      (
        SUPPORTED_PAIRS.length *
        SUPPORTED_DIRECTIONS.length *
        SUPPORTED_MODES.length
      );

    if (
      document.resolutions.length !==
        expectedContextCount
    ) {

      errors.push(
        `Adaptive execution must contain exactly ${expectedContextCount} Scalp contexts.`
      );

    }

    const seenContexts =
      new Set();

    for (
      let index = 0;
      index <
        document.resolutions.length;
      index++
    ) {

      const result =
        validateExecutionResolution(
          document.resolutions[index],
          index
        );

      errors.push(
        ...result.errors
      );

      warnings.push(
        ...result.warnings
      );

      const context =
        document.resolutions[
          index
        ]?.context;

      if (
        isPlainObject(
          context
        )
      ) {

        const contextId =
          (
            `${context.pair}::` +
            `${context.direction}::` +
            `${context.mode}`
          );

        if (
          seenContexts.has(
            contextId
          )
        ) {

          errors.push(
            `Duplicate adaptive execution context: ${contextId}.`
          );

        } else {

          seenContexts.add(
            contextId
          );

        }

      }

    }

  }

  if (
    !isPlainObject(
      document.summary
    )
  ) {

    errors.push(
      "Adaptive execution summary must be a JSON object."
    );

  } else {

    const calculatedSummary =
      summarizeScalpResolutions(
        document.resolutions
      );

    const summaryFields =
      Object.keys(
        createEmptyExecutionSummary()
      );

    for (
      const field of
      summaryFields
    ) {

      if (
        toNonNegativeInteger(
          document.summary[field]
        ) ===
          null
      ) {

        errors.push(
          `Adaptive execution summary.${field} is invalid.`
        );

      } else if (
        document.summary[field] !==
          calculatedSummary[field]
      ) {

        errors.push(
          `Adaptive execution summary.${field} does not match resolutions.`
        );

      }

    }

  }

  if (
    !isPlainObject(
      document.activeExecution
    )
  ) {

    errors.push(
      "Adaptive execution activeExecution section is missing."
    );

  } else {

    if (
      document.activeExecution.enabled !==
        false
    ) {

      errors.push(
        "Adaptive execution activeExecution.enabled must remain false."
      );

    }

    if (
      document.activeExecution.liveApplied !==
        false
    ) {

      errors.push(
        "Adaptive execution activeExecution.liveApplied must remain false."
      );

    }

    if (
      !isPlainObject(
        document.activeExecution
          .confidenceAdjustments
      ) ||
      Object.keys(
        document.activeExecution
          .confidenceAdjustments
      ).length >
        0
    ) {

      errors.push(
        "Dry-run activeExecution.confidenceAdjustments must remain empty."
      );

    }

  }

  if (
    !isPlainObject(
      document.precedencePolicy
    )
  ) {

    errors.push(
      "Adaptive execution precedencePolicy section is missing."
    );

  } else {

    if (
      document.precedencePolicy
        .stackingAllowed !==
        false
    ) {

      errors.push(
        "Adaptive execution recommendation stacking must remain disabled."
      );

    }

    if (
      document.precedencePolicy
        .broaderFallbackAfterPresentScopeFailure !==
        false
    ) {

      errors.push(
        "Broader fallback after a present-scope failure must remain disabled."
      );

    }

    if (
      !Array.isArray(
        document.precedencePolicy.order
      ) ||
      createHash(
        document.precedencePolicy.order
      ) !==
        createHash(
          SCOPE_PRECEDENCE
        )
    ) {

      errors.push(
        "Adaptive execution precedence order is inconsistent."
      );

    }

  }

  if (
    !isPlainObject(
      document.safety
    )
  ) {

    errors.push(
      "Adaptive execution safety section is missing."
    );

  } else {

    if (
      document.safety.dryRunOnly !==
        true
    ) {

      errors.push(
        "Adaptive execution safety.dryRunOnly must be true."
      );

    }

    if (
      document.safety.liveApplicationEnabled !==
        false
    ) {

      errors.push(
        "Adaptive execution live application must remain disabled."
      );

    }

    const requiredFalseFlags =
      [
        "sourceCodeModification",
        "externalApiCalls",
        "signalGeneration",
        "decisionModification",
        "tradePlanModification",
        "telegramModification",
        "existingSchemaModification",
        "recommendationStacking"
      ];

    for (
      const flag of
      requiredFalseFlags
    ) {

      if (
        document.safety[flag] !==
          false
      ) {

        errors.push(
          `Adaptive execution safety.${flag} must be false.`
        );

      }

    }

    if (
      document.safety.targetEngine !==
        TARGET_ENGINE
    ) {

      errors.push(
        "Adaptive execution safety target engine is inconsistent."
      );

    }

    if (
      document.safety.minimumResolvedTrades !==
        REQUIRED_MINIMUM_TRADES
    ) {

      errors.push(
        "Adaptive execution minimum resolved-trade gate is inconsistent."
      );

    }

    if (
      document.safety.maximumFinalAdjustment !==
        MAX_FINAL_ADJUSTMENT
    ) {

      errors.push(
        "Adaptive execution maximum adjustment limit is inconsistent."
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
   Build Final Dry-Run Document
   ===================================================================== */

function buildExecutionDocument({
  sourceBundle,
  generatedAt =
    new Date().toISOString()
}) {

  const document =
    createEmptyExecutionDocument(
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
      valid: false,

      errors: [
        "Valid adaptive optimization source bundle is required."
      ],

      warnings:
        uniqueSortedStrings(
          sourceBundle?.warnings ||
          []
        )
    };

    return document;

  }

  const resolutionResult =
    resolveAllScalpContexts(
      sourceBundle
        .recommendationIndex
    );

  document.sourceUpdatedAt =
    (
      sourceBundle
        .document
        ?.sourceUpdatedAt ||
      sourceBundle
        .document
        ?.generatedAt ||
      null
    );

  document.resolutions =
    resolutionResult.resolutions;

  document.summary =
    summarizeScalpResolutions(
      document.resolutions
    );

  document.source = {
    optimizationPath:
      path.relative(
        ROOT_DIR,
        OPTIMIZATION_PATH
      ),

    optimizationStatePath:
      path.relative(
        ROOT_DIR,
        OPTIMIZATION_STATE_PATH
      ),

    optimizationHash:
      sourceBundle
        .sourceHashes
        .optimization,

    optimizationStateHash:
      sourceBundle
        .sourceHashes
        .optimizationState,

    optimizationGeneratedAt:
      sourceBundle
        .document
        ?.generatedAt ||
      null,

    optimizationSourceUpdatedAt:
      sourceBundle
        .document
        ?.sourceUpdatedAt ||
      null,

    optimizerLastSuccessfulRunAt:
      sourceBundle
        .state
        ?.lastSuccessfulRunAt ||
      null
  };

  document.validation = {
    valid:
      resolutionResult.valid,

    errors:
      uniqueSortedStrings(
        resolutionResult.errors
      ),

    warnings:
      uniqueSortedStrings([
        ...sourceBundle.warnings,
        ...resolutionResult.warnings
      ])
  };

  const validationResult =
    validateExecutionDocument(
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
   Execution State Structures
   ===================================================================== */

function createEmptyExecutionState(
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
      EXECUTION_MODE,

    targetEngine:
      TARGET_ENGINE,

    createdAt,

    updatedAt:
      createdAt,

    lastRunAt:
      null,

    lastSuccessfulRunAt:
      null,

    sourceHashes: {
      optimization:
        null,

      optimizationState:
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

      resolvedContextsObserved:
        0,

      noChangeContextsObserved:
        0,

      blockedContextsObserved:
        0,

      noRecommendationContextsObserved:
        0,

      positiveAdjustmentsObserved:
        0,

      negativeAdjustmentsObserved:
        0,

      zeroAdjustmentsObserved:
        0,

      liveAppliedContextsObserved:
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

      totalContexts:
        0,

      resolvedContexts:
        0,

      noChangeContexts:
        0,

      blockedContexts:
        0,

      noRecommendationContexts:
        0,

      invalidContexts:
        0,

      positiveAdjustments:
        0,

      negativeAdjustments:
        0,

      zeroAdjustments:
        0,

      liveAppliedContexts:
        0,

      warnings:
        [],

      error:
        null
    }
  };

}

/* =====================================================================
   Execution State Validation
   ===================================================================== */

function validateExecutionState(
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
        "Adaptive execution state must be a JSON object."
      ]
    };

  }

  if (
    state.version !==
      STATE_SCHEMA_VERSION
  ) {

    errors.push(
      "Adaptive execution state schema version is invalid."
    );

  }

  if (
    state.engineName !==
      ENGINE_NAME
  ) {

    errors.push(
      "Adaptive execution state engine name is invalid."
    );

  }

  if (
    state.engineVersion !==
      ENGINE_VERSION
  ) {

    errors.push(
      "Adaptive execution state engine version is invalid."
    );

  }

  if (
    state.mode !==
      EXECUTION_MODE
  ) {

    errors.push(
      "Adaptive execution state mode is invalid."
    );

  }

  if (
    state.targetEngine !==
      TARGET_ENGINE
  ) {

    errors.push(
      "Adaptive execution state target engine is invalid."
    );

  }

  if (
    !toISOStringOrNull(
      state.createdAt
    )
  ) {

    errors.push(
      "Adaptive execution state createdAt is invalid."
    );

  }

  if (
    !toISOStringOrNull(
      state.updatedAt
    )
  ) {

    errors.push(
      "Adaptive execution state updatedAt is invalid."
    );

  }

  if (
    state.lastRunAt !==
      null &&
    !toISOStringOrNull(
      state.lastRunAt
    )
  ) {

    errors.push(
      "Adaptive execution state lastRunAt is invalid."
    );

  }

  if (
    state.lastSuccessfulRunAt !==
      null &&
    !toISOStringOrNull(
      state.lastSuccessfulRunAt
    )
  ) {

    errors.push(
      "Adaptive execution state lastSuccessfulRunAt is invalid."
    );

  }

  if (
    !isPlainObject(
      state.sourceHashes
    )
  ) {

    errors.push(
      "Adaptive execution state sourceHashes must be a JSON object."
    );

  }

  if (
    !isPlainObject(
      state.counters
    )
  ) {

    errors.push(
      "Adaptive execution state counters must be a JSON object."
    );

  } else {

    const counterNames =
      [
        "runs",
        "successfulRuns",
        "failedRuns",
        "updatedRuns",
        "unchangedRuns",
        "resolvedContextsObserved",
        "noChangeContextsObserved",
        "blockedContextsObserved",
        "noRecommendationContextsObserved",
        "positiveAdjustmentsObserved",
        "negativeAdjustmentsObserved",
        "zeroAdjustmentsObserved",
        "liveAppliedContextsObserved"
      ];

    for (
      const counterName of
      counterNames
    ) {

      if (
        toNonNegativeInteger(
          state.counters[
            counterName
          ]
        ) ===
          null
      ) {

        errors.push(
          `Adaptive execution state counters.${counterName} is invalid.`
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
      "Adaptive execution state lastRun must be a JSON object."
    );

  }

  return {
    valid:
      errors.length === 0,

    errors:
      uniqueSortedStrings(
        errors
      )
  };

}

/* =====================================================================
   Execution State Loading
   ===================================================================== */

function loadExecutionState(
  runAt
) {

  const stateRead =
    readJSONFile(
      EXECUTION_STATE_PATH,
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
        createEmptyExecutionState(
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
    validateExecutionState(
      stateRead.value
    );

  if (
    !validation.valid
  ) {

    return {
      state:
        createEmptyExecutionState(
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
   Existing Output Loading
   ===================================================================== */

function readExistingExecutionOutput() {

  const outputRead =
    readJSONFile(
      EXECUTION_OUTPUT_PATH,
      null
    );

  if (
    !outputRead.ok ||
    !isPlainObject(
      outputRead.value
    )
  ) {

    return {
      exists:
        outputRead.exists,

      valid:
        false,

      value:
        null,

      error:
        outputRead.error
    };

  }

  const validation =
    validateExecutionDocument(
      outputRead.value
    );

  return {
    exists:
      true,

    valid:
      validation.valid,

    value:
      validation.valid
        ? outputRead.value
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

function haveExecutionSourcesChanged({
  state,
  optimizationHash,
  optimizationStateHash
}) {

  if (
    !isPlainObject(
      state?.sourceHashes
    )
  ) {

    return true;

  }

  return (
    state.sourceHashes.optimization !==
      optimizationHash ||
    state.sourceHashes.optimizationState !==
      optimizationStateHash
  );

}

function hasExecutionOutputChanged({
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
   * generatedAt changes on every execution and must not create a false
   * output change when all resolved recommendations remain identical.
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
   Execution Run Lifecycle
   ===================================================================== */

function beginExecutionRun({
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

    totalContexts:
      0,

    resolvedContexts:
      0,

    noChangeContexts:
      0,

    blockedContexts:
      0,

    noRecommendationContexts:
      0,

    invalidContexts:
      0,

    positiveAdjustments:
      0,

    negativeAdjustments:
      0,

    zeroAdjustments:
      0,

    liveAppliedContexts:
      0,

    warnings:
      [],

    error:
      null
  };

  return nextState;

}

function completeExecutionRun({
  state,
  runAt,
  status,
  sourceChanged,
  outputChanged,
  outputWritten,
  optimizationHash,
  optimizationStateHash,
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
    optimization:
      optimizationHash,

    optimizationState:
      optimizationStateHash
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

  } else {

    nextState.counters.unchangedRuns +=
      1;

  }

  nextState
    .counters
    .resolvedContextsObserved +=
      summary.resolvedContexts;

  nextState
    .counters
    .noChangeContextsObserved +=
      summary.noChangeContexts;

  nextState
    .counters
    .blockedContextsObserved +=
      summary.blockedContexts;

  nextState
    .counters
    .noRecommendationContextsObserved +=
      summary.noRecommendationContexts;

  nextState
    .counters
    .positiveAdjustmentsObserved +=
      summary.positiveAdjustments;

  nextState
    .counters
    .negativeAdjustmentsObserved +=
      summary.negativeAdjustments;

  nextState
    .counters
    .zeroAdjustmentsObserved +=
      summary.zeroAdjustments;

  nextState
    .counters
    .liveAppliedContextsObserved +=
      summary.liveAppliedContexts;

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

    outputChanged:
      outputChanged ===
        true,

    outputWritten:
      outputWritten ===
        true,

    stateWritten:
      true,

    totalContexts:
      summary.totalContexts,

    resolvedContexts:
      summary.resolvedContexts,

    noChangeContexts:
      summary.noChangeContexts,

    blockedContexts:
      summary.blockedContexts,

    noRecommendationContexts:
      summary.noRecommendationContexts,

    invalidContexts:
      summary.invalidContexts,

    positiveAdjustments:
      summary.positiveAdjustments,

    negativeAdjustments:
      summary.negativeAdjustments,

    zeroAdjustments:
      summary.zeroAdjustments,

    liveAppliedContexts:
      summary.liveAppliedContexts,

    warnings:
      uniqueSortedStrings(
        warnings
      ),

    error:
      null
  };

  return nextState;

}

function failExecutionRun({
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

    outputChanged:
      false,

    outputWritten:
      false,

    stateWritten:
      true,

    totalContexts:
      0,

    resolvedContexts:
      0,

    noChangeContexts:
      0,

    blockedContexts:
      0,

    noRecommendationContexts:
      0,

    invalidContexts:
      0,

    positiveAdjustments:
      0,

    negativeAdjustments:
      0,

    zeroAdjustments:
      0,

    liveAppliedContexts:
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
   Run Result
   ===================================================================== */

function createExecutionRunResult({
  status,
  runAt,
  sourceChanged,
  outputChanged,
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
      EXECUTION_MODE,

    targetEngine:
      TARGET_ENGINE,

    status,

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
      stateWritten ===
        true,

    liveApplicationEnabled:
      LIVE_APPLICATION_ENABLED,

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
   Main Adaptive Execution Worker
   ===================================================================== */

function runAdaptiveExecution() {

  const runAt =
    new Date().toISOString();

  const runtimeWarnings =
    [];

  let outputWritten =
    false;

  let stateWritten =
    false;

  const stateLoad =
    loadExecutionState(
      runAt
    );

  let state =
    beginExecutionRun({
      state:
        stateLoad.state,

      runAt
    });

  if (
    stateLoad.warning
  ) {

    runtimeWarnings.push(
      `Execution state recovery: ${stateLoad.warning}`
    );

  }

  try {

    if (
      LIVE_APPLICATION_ENABLED !==
        false
    ) {

      throw new Error(
        "Phase B1 live application safety lock is not disabled."
      );

    }

    const sourceBundle =
      loadOptimizationSources();

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
        "Adaptive optimization source validation failed."
      );

    }

    const generatedOutput =
      buildExecutionDocument({
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
        "Generated adaptive execution output failed validation."
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

    if (
      generatedOutput
        .summary
        .liveAppliedContexts !==
        0
    ) {

      throw new Error(
        "Dry-run output unexpectedly contains live-applied contexts."
      );

    }

    const existingOutput =
      readExistingExecutionOutput();

    if (
      existingOutput.exists &&
      !existingOutput.valid &&
      existingOutput.error
    ) {

      runtimeWarnings.push(
        `Existing execution output will be replaced: ${existingOutput.error}`
      );

    }

    const sourceChanged =
      haveExecutionSourcesChanged({
        state,
        optimizationHash:
          sourceBundle
            .sourceHashes
            .optimization,

        optimizationStateHash:
          sourceBundle
            .sourceHashes
            .optimizationState
      });

    const outputChanged =
      hasExecutionOutputChanged({
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
        EXECUTION_OUTPUT_PATH,
        generatedOutput
      );

      outputWritten =
        true;

      status =
        "UPDATED";

    }

    const outputHash =
      createFileContentHash(
        EXECUTION_OUTPUT_PATH
      );

    if (
      !outputHash
    ) {

      throw new Error(
        "Unable to calculate adaptive execution output hash."
      );

    }

    state =
      completeExecutionRun({
        state,
        runAt,
        status,
        sourceChanged,
        outputChanged,
        outputWritten,

        optimizationHash:
          sourceBundle
            .sourceHashes
            .optimization,

        optimizationStateHash:
          sourceBundle
            .sourceHashes
            .optimizationState,

        outputHash,

        summary:
          generatedOutput.summary,

        warnings:
          runtimeWarnings
      });

    const stateValidation =
      validateExecutionState(
        state
      );

    if (
      !stateValidation.valid
    ) {

      throw new Error(
        stateValidation.errors.join(
          " "
        ) ||
        "Generated adaptive execution state is invalid."
      );

    }

    atomicWriteJSON(
      EXECUTION_STATE_PATH,
      state
    );

    stateWritten =
      true;

    const result =
      createExecutionRunResult({
        status,
        runAt,
        sourceChanged,
        outputChanged,
        outputWritten,
        stateWritten,

        summary:
          generatedOutput.summary,

        warnings:
          runtimeWarnings
      });

    console.log(
      `[adaptive-execution] ${result.status}`
    );

    console.log(
      `[adaptive-execution] Mode: ${result.mode}`
    );

    console.log(
      `[adaptive-execution] Target engine: ${result.targetEngine}`
    );

    console.log(
      `[adaptive-execution] Total contexts: ${result.summary.totalContexts}`
    );

    console.log(
      `[adaptive-execution] Resolved contexts: ${result.summary.resolvedContexts}`
    );

    console.log(
      `[adaptive-execution] Blocked contexts: ${result.summary.blockedContexts}`
    );

    console.log(
      `[adaptive-execution] No-change contexts: ${result.summary.noChangeContexts}`
    );

    console.log(
      `[adaptive-execution] Positive adjustments: ${result.summary.positiveAdjustments}`
    );

    console.log(
      `[adaptive-execution] Negative adjustments: ${result.summary.negativeAdjustments}`
    );

    console.log(
      `[adaptive-execution] Zero adjustments: ${result.summary.zeroAdjustments}`
    );

    console.log(
      `[adaptive-execution] Live-applied contexts: ${result.summary.liveAppliedContexts}`
    );

    console.log(
      `[adaptive-execution] Output written: ${result.outputWritten}`
    );

    console.log(
      `[adaptive-execution] State written: ${result.stateWritten}`
    );

    if (
      result.warnings.length >
        0
    ) {

      console.warn(
        `[adaptive-execution] Completed with ${result.warnings.length} warning(s).`
      );

    }

    return result;

  } catch (
    error
  ) {

    state =
      failExecutionRun({
        state,
        runAt,
        error,
        warnings:
          runtimeWarnings
      });

    try {

      const failedStateValidation =
        validateExecutionState(
          state
        );

      if (
        !failedStateValidation.valid
      ) {

        throw new Error(
          failedStateValidation.errors.join(
            " "
          )
        );

      }

      atomicWriteJSON(
        EXECUTION_STATE_PATH,
        state
      );

      stateWritten =
        true;

    } catch (
      stateWriteError
    ) {

      console.error(
        "[adaptive-execution] Unable to persist failed-run state:",
        stateWriteError.message
      );

    }

    console.error(
      "[adaptive-execution] FAILED"
    );

    console.error(
      `[adaptive-execution] ${error.message}`
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

    runAdaptiveExecution();

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
  EXECUTION_MODE,
  TARGET_ENGINE,
  LIVE_APPLICATION_ENABLED,
  REQUIRED_MINIMUM_TRADES,
  MAX_FINAL_ADJUSTMENT,

  validateOptimizationSafety,
  buildRecommendationIndex,
  validateOptimizationState,
  loadOptimizationSources,

  buildScalpCandidateIds,
  evaluateExecutionCandidate,
  resolveScalpContext,
  buildSupportedScalpContexts,
  resolveAllScalpContexts,
  summarizeScalpResolutions,

  createEmptyExecutionDocument,
  validateExecutionDocument,
  buildExecutionDocument,

  createEmptyExecutionState,
  validateExecutionState,
  runAdaptiveExecution
};
