"use strict";

/**
 * PipSight Pro — Autonomous AI Decision Engine
 *
 * Version: 1.4.0
 *
 * Purpose:
 * - Evaluate deterministic Rule Engine output against validated AI policies.
 * - Produce a fully explainable pre-safety decision candidate.
 * - Apply only the authority allowed by autonomous-config.json.
 * - Preserve deterministic behavior in OFF/SHADOW/fallback conditions.
 * - Never place orders and never bypass ai-safety-gate.js.
 *
 * Reads:
 *   data/autonomous-config.json
 *   data/ai-policy.json
 *   data/ai-policy-state.json
 *
 * Optional CLI input:
 *   data/ai-decision-input.json
 *
 * Optional persisted outputs:
 *   data/ai-decision-preview.json
 *   data/ai-decision-log.json
 *   data/ai-decision-state.json
 *
 * CommonJS / Node.js 20
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// -----------------------------------------------------------------------------
// Engine metadata
// -----------------------------------------------------------------------------

const ENGINE_NAME =
  "PipSight Pro Autonomous AI Decision Engine";

const ENGINE_VERSION =
  "1.4.0";

const DECISION_SCHEMA_VERSION =
  1;

const STATE_SCHEMA_VERSION =
  1;

const LOG_SCHEMA_VERSION =
  1;

const SUPPORTED_CONFIG_NAME =
  "PipSight Pro Autonomous Trading Control Plane";

const SUPPORTED_CONFIG_VERSION =
  "1.4.0";

const SUPPORTED_POLICY_ENGINE_NAME =
  "PipSight Pro Autonomous AI Policy Engine";

const SUPPORTED_POLICY_ENGINE_VERSION =
  "1.4.0";

const SUPPORTED_POLICY_SCHEMA_VERSION =
  1;

const HASH_ALGORITHM =
  "sha256";

const MAX_POLICY_BUCKETS =
  250000;

const MAX_DECISION_LOG_ENTRIES =
  5000;

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

const DECISION_INPUT_PATH =
  path.join(
    DATA_DIR,
    "ai-decision-input.json"
  );

const DECISION_PREVIEW_PATH =
  path.join(
    DATA_DIR,
    "ai-decision-preview.json"
  );

const DECISION_LOG_PATH =
  path.join(
    DATA_DIR,
    "ai-decision-log.json"
  );

const DECISION_STATE_PATH =
  path.join(
    DATA_DIR,
    "ai-decision-state.json"
  );

// -----------------------------------------------------------------------------
// Canonical values
// -----------------------------------------------------------------------------

const ALLOWED_MODES =
  new Set([
    "OFF",
    "SHADOW",
    "CONTROLLED",
    "AUTONOMOUS",
    "EMERGENCY_STOP"
  ]);

const ALLOWED_DECISIONS =
  new Set([
    "BUY",
    "SELL",
    "HOLD"
  ]);

const ALLOWED_POLICY_ACTIONS =
  new Set([
    "OBSERVE",
    "NEUTRAL",
    "SUPPORT",
    "SUPPRESS"
  ]);

const AUTHORITY_RANK =
  Object.freeze({
    SHADOW_ONLY: 0,
    FILTER_ONLY: 1,
    TRADE_PLAN: 2,
    DIRECTION_SELECTION: 3
  });

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

const SCOPE_FIELDS =
  Object.freeze({
    pairTimeframeEngineDirectionRegime: [
      "pair",
      "timeframe",
      "engine",
      "direction",
      "marketRegime"
    ],
    pairTimeframeEngineDirectionSession: [
      "pair",
      "timeframe",
      "engine",
      "direction",
      "session"
    ],
    pairTimeframeEngineDirectionPattern: [
      "pair",
      "timeframe",
      "engine",
      "direction",
      "pattern"
    ],
    pairTimeframeEngineDirection: [
      "pair",
      "timeframe",
      "engine",
      "direction"
    ],
    pairEngineDirection: [
      "pair",
      "engine",
      "direction"
    ],
    pairTimeframeDirection: [
      "pair",
      "timeframe",
      "direction"
    ],
    pairDirection: [
      "pair",
      "direction"
    ],
    engineDirection: [
      "engine",
      "direction"
    ],
    pair: [
      "pair"
    ],
    engine: [
      "engine"
    ],
    direction: [
      "direction"
    ]
  });

// -----------------------------------------------------------------------------
// Generic utilities
// -----------------------------------------------------------------------------

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function deepClone(value) {
  if (
    typeof structuredClone ===
    "function"
  ) {
    return structuredClone(value);
  }

  return JSON.parse(
    JSON.stringify(value)
  );
}

function firstDefined(...values) {
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

function toTrimmedString(value) {
  return typeof value === "string"
    ? value.trim()
    : "";
}

function toNonEmptyStringOrNull(value) {
  const normalized =
    toTrimmedString(value);

  return normalized || null;
}

function toFiniteNumber(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const numeric =
    Number(value);

  return Number.isFinite(numeric)
    ? numeric
    : null;
}

function toNonNegativeInteger(value, fallback = 0) {
  const numeric =
    toFiniteNumber(value);

  return numeric === null
    ? fallback
    : Math.max(
        0,
        Math.trunc(numeric)
      );
}

function clamp(value, minimum, maximum) {
  return Math.min(
    maximum,
    Math.max(minimum, value)
  );
}

function round(value, decimals = 6) {
  if (!Number.isFinite(value)) {
    return null;
  }

  const factor =
    10 ** decimals;

  return Math.round(
    (value + Number.EPSILON) * factor
  ) / factor;
}

function uniqueStrings(values) {
  return Array.from(
    new Set(
      values.filter(
        (value) =>
          typeof value === "string" &&
          value.trim()
      )
    )
  );
}

function sortObjectKeysDeep(value) {
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

function stableStringify(value) {
  return JSON.stringify(
    sortObjectKeysDeep(value)
  );
}

function createHash(value) {
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

function hashFileContents(filePath) {
  return createHash(
    fs.readFileSync(filePath)
  );
}

function fileExists(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function ensureDirectory(directoryPath) {
  fs.mkdirSync(
    directoryPath,
    {
      recursive: true
    }
  );
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
        `Required JSON file is missing: ${filePath}`
      );
    }

    return deepClone(defaultValue);
  }

  const raw =
    fs.readFileSync(
      filePath,
      "utf8"
    );

  if (!raw.trim()) {
    if (required) {
      throw new Error(
        `Required JSON file is empty: ${filePath}`
      );
    }

    return deepClone(defaultValue);
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid JSON in ${filePath}: ${error.message}`
    );
  }
}

function atomicWriteJSON(filePath, value) {
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

function toISOStringOrNull(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const parsed =
    Date.parse(value);

  return Number.isFinite(parsed)
    ? new Date(parsed).toISOString()
    : null;
}

// -----------------------------------------------------------------------------
// Canonical normalization
// -----------------------------------------------------------------------------

function normalizePair(value) {
  const normalized =
    toTrimmedString(value)
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");

  return SUPPORTED_PAIRS.has(normalized)
    ? normalized
    : null;
}

function normalizeEngine(value) {
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

function normalizeTimeframe(value) {
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

function normalizeDecision(value) {
  const normalized =
    toTrimmedString(value)
      .toUpperCase()
      .replace(/[\s-]+/g, "_");

  const aliases = {
    BUY: "BUY",
    LONG: "BUY",
    SELL: "SELL",
    SHORT: "SELL",
    HOLD: "HOLD",
    WAIT: "HOLD",
    NEUTRAL: "HOLD",
    NO_TRADE: "HOLD",
    NOTRADE: "HOLD"
  };

  const decision =
    aliases[normalized] || null;

  return ALLOWED_DECISIONS.has(decision)
    ? decision
    : null;
}

function normalizeOptionalDimension(value) {
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

function canonicalDimensionValue(
  field,
  value
) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  if (field === "pair") {
    return normalizePair(value);
  }

  if (field === "engine") {
    return normalizeEngine(value);
  }

  if (field === "timeframe") {
    return normalizeTimeframe(value);
  }

  if (field === "direction") {
    return normalizeDecision(value);
  }

  const optional =
    normalizeOptionalDimension(value);

  return optional
    ? optional.toLowerCase()
    : null;
}

// -----------------------------------------------------------------------------
// Validation helpers
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

  validation.errors.push(message);
}

function addValidationWarning(
  validation,
  message
) {
  validation.warnings.push(message);
}

function validateAutonomousConfig(config) {
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

  if (!isPlainObject(config.deployment)) {
    addValidationError(
      validation,
      "Autonomous config deployment section is missing."
    );
  } else {
    if (
      !ALLOWED_MODES.has(
        config.deployment.mode
      )
    ) {
      addValidationError(
        validation,
        "Autonomous deployment mode is unsupported."
      );
    }

    const rolloutPercent =
      toFiniteNumber(
        config.deployment
          .autonomousRolloutPercent
      );

    if (
      rolloutPercent === null ||
      rolloutPercent < 0 ||
      rolloutPercent > 100
    ) {
      addValidationError(
        validation,
        "Autonomous rollout percentage must be between 0 and 100."
      );
    }

    if (
      config.deployment
        .deterministicFallbackRequired !==
      true
    ) {
      addValidationError(
        validation,
        "Deterministic fallback must remain enabled."
      );
    }

    if (
      config.deployment
        .allowRuntimeSelfPromotion !==
      false
    ) {
      addValidationError(
        validation,
        "Runtime self-promotion must remain disabled."
      );
    }
  }

  if (
    config.riskSafetyGate
      ?.immutable !== true ||
    config.riskSafetyGate
      ?.policyMayOverride !== false
  ) {
    addValidationError(
      validation,
      "Immutable independent Safety Gate is required."
    );
  }

  if (
    config.governance
      ?.policyEngineMayModifySourceCode !== false ||
    config.governance
      ?.decisionEngineMayModifySourceCode !== false ||
    config.governance
      ?.externalNetworkCallsDuringDecision !== false
  ) {
    addValidationError(
      validation,
      "Decision governance restrictions are invalid."
    );
  }

  return validation;
}

function validatePolicyDocument(
  policy,
  config,
  policyState,
  sourceHashes,
  nowMs
) {
  const validation =
    createValidationResult();

  if (!isPlainObject(policy)) {
    addValidationError(
      validation,
      "AI policy root must be an object."
    );

    return validation;
  }

  if (
    policy.version !==
    SUPPORTED_POLICY_SCHEMA_VERSION
  ) {
    addValidationError(
      validation,
      `AI policy schema version must be ${SUPPORTED_POLICY_SCHEMA_VERSION}.`
    );
  }

  if (
    policy.engineName !==
    SUPPORTED_POLICY_ENGINE_NAME ||
    policy.engineVersion !==
    SUPPORTED_POLICY_ENGINE_VERSION
  ) {
    addValidationError(
      validation,
      "AI policy engine identity/version is unsupported."
    );
  }

  if (
    policy.validation?.valid !== true
  ) {
    addValidationError(
      validation,
      "AI policy internal validation has not passed."
    );
  }

  if (
    policy.config?.name !==
      SUPPORTED_CONFIG_NAME ||
    policy.config?.version !==
      SUPPORTED_CONFIG_VERSION
  ) {
    addValidationError(
      validation,
      "AI policy config identity/version does not match the Decision Engine."
    );
  }

  if (
    policy.config?.hash !==
    sourceHashes.autonomousConfig
  ) {
    addValidationError(
      validation,
      "AI policy was not generated from the current autonomous config file."
    );
  }

  if (
    policy.mode !==
    config.deployment.mode
  ) {
    addValidationError(
      validation,
      "AI policy deployment mode is stale relative to autonomous config."
    );
  }

  if (
    toFiniteNumber(
      policy.autonomousRolloutPercent
    ) !==
    toFiniteNumber(
      config.deployment
        .autonomousRolloutPercent
    )
  ) {
    addValidationError(
      validation,
      "AI policy rollout percentage is stale relative to autonomous config."
    );
  }

  if (!Array.isArray(policy.policies)) {
    addValidationError(
      validation,
      "AI policy policies section must be an array."
    );
  } else if (
    policy.policies.length >
    MAX_POLICY_BUCKETS
  ) {
    addValidationError(
      validation,
      `AI policy exceeds the ${MAX_POLICY_BUCKETS} bucket safety limit.`
    );
  }

  if (
    !toNonEmptyStringOrNull(
      policy.metadata
        ?.policyContentHash
    )
  ) {
    addValidationError(
      validation,
      "AI policy content hash is missing."
    );
  }

  if (
    policy.safety?.policyOnly !== true ||
    policy.safety?.liveSignalModification !== false ||
    policy.safety?.riskLimitModification !== false ||
    policy.safety?.immutableSafetyGateRequired !== true
  ) {
    addValidationError(
      validation,
      "AI policy safety declaration is invalid."
    );
  }

  const generatedAt =
    toISOStringOrNull(
      policy.generatedAt
    );

  if (!generatedAt) {
    addValidationError(
      validation,
      "AI policy generatedAt is invalid."
    );
  } else {
    const maximumAgeMinutes =
      Math.max(
        1,
        toFiniteNumber(
          config.policyValidation
            ?.maximumPolicyAgeMinutes
        ) || 180
      );

    const ageMs =
      nowMs - Date.parse(generatedAt);

    if (ageMs < -60000) {
      addValidationError(
        validation,
        "AI policy is future-dated."
      );
    }

    if (
      ageMs >
      maximumAgeMinutes * 60000
    ) {
      addValidationError(
        validation,
        `AI policy is stale by more than ${maximumAgeMinutes} minutes.`
      );
    }
  }

  if (!isPlainObject(policyState)) {
    addValidationError(
      validation,
      "AI policy state is missing or invalid."
    );
  } else {
    if (
      policyState.engineName !==
        SUPPORTED_POLICY_ENGINE_NAME ||
      policyState.engineVersion !==
        SUPPORTED_POLICY_ENGINE_VERSION
    ) {
      addValidationError(
        validation,
        "AI policy state engine identity/version is unsupported."
      );
    }

    if (
      policyState.pendingTransaction !==
      null
    ) {
      addValidationError(
        validation,
        "AI policy state contains an incomplete pending transaction."
      );
    }

    const expectedHash =
      policy.metadata
        ?.policyContentHash;

    if (
      policyState.policyHash !==
        expectedHash ||
      policyState.lastKnownGoodPolicyHash !==
        expectedHash
    ) {
      addValidationError(
        validation,
        "AI policy hash does not match committed policy state."
      );
    }
  }

  return validation;
}

function validatePolicyRecord(policy) {
  const validation =
    createValidationResult();

  if (!isPlainObject(policy)) {
    addValidationError(
      validation,
      "Policy bucket must be an object."
    );

    return validation;
  }

  if (
    !toNonEmptyStringOrNull(policy.key) ||
    !toNonEmptyStringOrNull(policy.scope) ||
    !isPlainObject(policy.dimensions)
  ) {
    addValidationError(
      validation,
      "Policy bucket identity is incomplete."
    );
  }

  if (
    !ALLOWED_POLICY_ACTIONS.has(
      policy.action
    )
  ) {
    addValidationError(
      validation,
      "Policy action is unsupported."
    );
  }

  if (
    !Object.prototype.hasOwnProperty.call(
      AUTHORITY_RANK,
      policy.authority?.level
    )
  ) {
    addValidationError(
      validation,
      "Policy authority level is unsupported."
    );
  }

  const reliability =
    toFiniteNumber(
      policy.reliability?.value
    );

  if (
    reliability === null ||
    reliability < 0 ||
    reliability > 1
  ) {
    addValidationError(
      validation,
      "Policy reliability must be between 0 and 1."
    );
  }

  if (
    !isPlainObject(policy.metrics) ||
    !isPlainObject(policy.validation)
  ) {
    addValidationError(
      validation,
      "Policy metrics/validation sections are incomplete."
    );
  }

  return validation;
}

// -----------------------------------------------------------------------------
// Input normalization
// -----------------------------------------------------------------------------

function normalizeTradePlan(
  source,
  direction = null
) {
  if (!isPlainObject(source)) {
    return null;
  }

  const normalizedDirection =
    normalizeDecision(
      firstDefined(
        direction,
        source.direction,
        source.decision,
        source.signal
      )
    );

  if (
    normalizedDirection !== "BUY" &&
    normalizedDirection !== "SELL"
  ) {
    return null;
  }

  const entry =
    toFiniteNumber(
      firstDefined(
        source.entry,
        source.entryPrice,
        source.price
      )
    );

  const stopLoss =
    toFiniteNumber(
      firstDefined(
        source.stopLoss,
        source.stop,
        source.sl
      )
    );

  const target1 =
    toFiniteNumber(
      firstDefined(
        source.target1,
        source.takeProfit,
        source.takeProfit1,
        source.target,
        source.tp,
        source.tp1
      )
    );

  const target2 =
    toFiniteNumber(
      firstDefined(
        source.target2,
        source.takeProfit2,
        source.tp2
      )
    );

  const target3 =
    toFiniteNumber(
      firstDefined(
        source.target3,
        source.takeProfit3,
        source.tp3
      )
    );

  if (
    entry === null ||
    stopLoss === null ||
    target1 === null
  ) {
    return null;
  }

  const risk =
    Math.abs(entry - stopLoss);

  if (
    !Number.isFinite(risk) ||
    risk <= 0
  ) {
    return null;
  }

  const reward =
    Math.abs(target1 - entry);

  const riskReward =
    reward / risk;

  return {
    direction:
      normalizedDirection,
    entry:
      round(entry, 10),
    stopLoss:
      round(stopLoss, 10),
    target1:
      round(target1, 10),
    target2:
      target2 === null
        ? null
        : round(target2, 10),
    target3:
      target3 === null
        ? null
        : round(target3, 10),
    risk:
      round(risk, 10),
    riskReward:
      round(riskReward, 8)
  };
}

function validateTradePlanGeometry(plan) {
  if (!isPlainObject(plan)) {
    return {
      valid: false,
      reason: "TRADE_PLAN_MISSING"
    };
  }

  const {
    direction,
    entry,
    stopLoss,
    target1,
    target2,
    target3
  } = plan;

  const prices = [
    entry,
    stopLoss,
    target1,
    target2,
    target3
  ].filter(
    (value) =>
      value !== null &&
      value !== undefined
  );

  if (
    prices.some(
      (value) =>
        !Number.isFinite(value)
    )
  ) {
    return {
      valid: false,
      reason: "NON_FINITE_TRADE_PLAN_PRICE"
    };
  }

  if (direction === "BUY") {
    if (!(stopLoss < entry && target1 > entry)) {
      return {
        valid: false,
        reason: "INVALID_BUY_GEOMETRY"
      };
    }

    if (
      target2 !== null &&
      target2 !== undefined &&
      target2 <= target1
    ) {
      return {
        valid: false,
        reason: "BUY_TARGET2_NOT_ABOVE_TARGET1"
      };
    }

    if (
      target3 !== null &&
      target3 !== undefined &&
      target3 <= (target2 ?? target1)
    ) {
      return {
        valid: false,
        reason: "BUY_TARGET3_NOT_ABOVE_PREVIOUS_TARGET"
      };
    }
  } else if (direction === "SELL") {
    if (!(stopLoss > entry && target1 < entry)) {
      return {
        valid: false,
        reason: "INVALID_SELL_GEOMETRY"
      };
    }

    if (
      target2 !== null &&
      target2 !== undefined &&
      target2 >= target1
    ) {
      return {
        valid: false,
        reason: "SELL_TARGET2_NOT_BELOW_TARGET1"
      };
    }

    if (
      target3 !== null &&
      target3 !== undefined &&
      target3 >= (target2 ?? target1)
    ) {
      return {
        valid: false,
        reason: "SELL_TARGET3_NOT_BELOW_PREVIOUS_TARGET"
      };
    }
  } else {
    return {
      valid: false,
      reason: "TRADE_PLAN_DIRECTION_UNSUPPORTED"
    };
  }

  return {
    valid: true,
    reason: null
  };
}

function normalizeEngineEvidence(input) {
  const candidates = [
    input.engineSignals,
    input.engineDecisions,
    input.directionalEvidence,
    input.consensus?.engines,
    input.evidence?.engines
  ];

  const source =
    candidates.find(Array.isArray) || [];

  const normalized = [];

  for (const item of source) {
    if (!isPlainObject(item)) {
      continue;
    }

    const engine =
      normalizeEngine(
        firstDefined(
          item.engine,
          item.strategy,
          item.name
        )
      );

    const decision =
      normalizeDecision(
        firstDefined(
          item.decision,
          item.signal,
          item.direction,
          item.action
        )
      );

    if (
      !engine ||
      !decision
    ) {
      continue;
    }

    const confidence =
      clamp(
        toFiniteNumber(
          item.confidence
        ) ?? 50,
        0,
        100
      );

    const active =
      item.active !== false &&
      item.enabled !== false;

    const tradePlan =
      normalizeTradePlan(
        firstDefined(
          item.tradePlan,
          item.plan
        ),
        decision
      );

    normalized.push({
      engine,
      decision,
      confidence:
        round(confidence, 4),
      active,
      tradePlan,
      source:
        toNonEmptyStringOrNull(
          item.source
        ) || engine
    });
  }

  normalized.sort(
    (left, right) =>
      left.engine.localeCompare(
        right.engine
      ) ||
      left.decision.localeCompare(
        right.decision
      ) ||
      right.confidence -
        left.confidence
  );

  return normalized;
}

function normalizeCandidateTradePlans(
  input,
  baseline
) {
  const candidates = [];

  function pushCandidate(
    source,
    sourceName,
    quality = null
  ) {
    const plan =
      normalizeTradePlan(
        source,
        source?.direction
      );

    if (!plan) {
      return;
    }

    candidates.push({
      id:
        createHash({
          sourceName,
          plan
        }).slice(0, 24),
      source:
        sourceName,
      quality:
        quality === null
          ? null
          : round(
              clamp(quality, 0, 1),
              6
            ),
      plan
    });
  }

  if (baseline.tradePlan) {
    pushCandidate(
      baseline.tradePlan,
      "DETERMINISTIC_BASELINE",
      1
    );
  }

  const directArrays = [
    input.candidateTradePlans,
    input.tradePlanCandidates,
    input.plans
  ];

  for (const array of directArrays) {
    if (!Array.isArray(array)) {
      continue;
    }

    for (const item of array) {
      if (!isPlainObject(item)) {
        continue;
      }

      pushCandidate(
        firstDefined(
          item.tradePlan,
          item.plan,
          item
        ),
        toNonEmptyStringOrNull(
          firstDefined(
            item.source,
            item.engine,
            item.name
          )
        ) || "CANDIDATE",
        toFiniteNumber(
          firstDefined(
            item.quality,
            item.score,
            item.reliability
          )
        )
      );
    }
  }

  const byDirection =
    firstDefined(
      input.tradePlansByDirection,
      input.candidateTradePlansByDirection
    );

  if (isPlainObject(byDirection)) {
    for (const direction of ["BUY", "SELL"]) {
      const value =
        firstDefined(
          byDirection[direction],
          byDirection[direction.toLowerCase()]
        );

      if (Array.isArray(value)) {
        for (const item of value) {
          pushCandidate(
            firstDefined(
              item?.tradePlan,
              item?.plan,
              item
            ),
            `${direction}_DIRECTION_CANDIDATE`,
            toFiniteNumber(
              item?.quality
            )
          );
        }
      } else if (isPlainObject(value)) {
        pushCandidate(
          firstDefined(
            value.tradePlan,
            value.plan,
            value
          ),
          `${direction}_DIRECTION_CANDIDATE`,
          toFiniteNumber(
            value.quality
          )
        );
      }
    }
  }

  for (
    const evidence of
    normalizeEngineEvidence(input)
  ) {
    if (evidence.tradePlan) {
      pushCandidate(
        evidence.tradePlan,
        `ENGINE_${evidence.engine}`,
        evidence.confidence / 100
      );
    }
  }

  const unique =
    new Map();

  for (const candidate of candidates) {
    const key =
      createHash(candidate.plan);

    const existing =
      unique.get(key);

    if (
      !existing ||
      (candidate.quality ?? 0) >
        (existing.quality ?? 0)
    ) {
      unique.set(key, candidate);
    }
  }

  return Array.from(
    unique.values()
  ).sort(
    (left, right) =>
      left.plan.direction.localeCompare(
        right.plan.direction
      ) ||
      (right.quality ?? 0) -
        (left.quality ?? 0) ||
      left.id.localeCompare(right.id)
  );
}

function normalizeDecisionInput(
  input,
  evaluatedAt
) {
  const validation =
    createValidationResult();

  if (!isPlainObject(input)) {
    addValidationError(
      validation,
      "Decision input root must be an object."
    );

    return {
      validation,
      normalized: null
    };
  }

  const baselineSource =
    isPlainObject(input.baseline)
      ? input.baseline
      : input;

  const pair =
    normalizePair(
      firstDefined(
        input.pair,
        input.symbol,
        input.pairLabel,
        baselineSource.pair
      )
    );

  const timeframe =
    normalizeTimeframe(
      firstDefined(
        input.timeframe,
        input.tf,
        input.interval,
        baselineSource.timeframe
      )
    );

  const engine =
    normalizeEngine(
      firstDefined(
        input.engine,
        input.strategy,
        input.engineName,
        baselineSource.engine,
        baselineSource.strategy
      )
    );

  const baselineDecision =
    normalizeDecision(
      firstDefined(
        baselineSource.decision,
        baselineSource.signal,
        baselineSource.direction,
        input.decision,
        input.signal,
        input.direction
      )
    );

  if (!pair) {
    addValidationError(
      validation,
      "Decision input pair is unsupported or missing."
    );
  }

  if (!timeframe) {
    addValidationError(
      validation,
      "Decision input timeframe is unsupported or missing."
    );
  }

  if (!engine) {
    addValidationError(
      validation,
      "Decision input engine is unsupported or missing."
    );
  }

  if (!baselineDecision) {
    addValidationError(
      validation,
      "Deterministic baseline decision is unsupported or missing."
    );
  }

  const baselineConfidence =
    clamp(
      toFiniteNumber(
        firstDefined(
          baselineSource.confidence,
          input.confidence
        )
      ) ?? 0,
      0,
      100
    );

  const baselineTradePlan =
    normalizeTradePlan(
      firstDefined(
        baselineSource.tradePlan,
        baselineSource.plan,
        input.tradePlan,
        input.plan
      ),
      baselineDecision
    );

  if (
    baselineDecision !== "HOLD" &&
    !baselineTradePlan
  ) {
    addValidationWarning(
      validation,
      "Deterministic BUY/SELL baseline does not contain a complete trade plan; the Safety Gate must reject execution unless another valid plan is selected."
    );
  }

  const marketDataAt =
    toISOStringOrNull(
      firstDefined(
        input.marketDataAt,
        input.candleClosedAt,
        input.sourceUpdatedAt,
        input.timestamp,
        input.createdAt
      )
    );

  const decisionId =
    toNonEmptyStringOrNull(
      firstDefined(
        input.decisionId,
        input.signalId,
        input.id
      )
    );

  if (
    !decisionId &&
    !marketDataAt
  ) {
    addValidationWarning(
      validation,
      "Decision input has neither decisionId nor marketDataAt; deterministic autonomous rollout selection will be disabled."
    );
  }

  const reasonsSource =
    firstDefined(
      baselineSource.reasons,
      input.reasons
    );

  const reasons =
    Array.isArray(reasonsSource)
      ? reasonsSource
          .map(toNonEmptyStringOrNull)
          .filter(Boolean)
      : [];

  const normalized = {
    decisionId:
      decisionId ||
      createHash({
        pair,
        timeframe,
        engine,
        baselineDecision,
        marketDataAt
      }).slice(0, 32),
    decisionIdentityStable:
      Boolean(decisionId || marketDataAt),
    evaluatedAt,
    marketDataAt,
    pair,
    timeframe,
    engine,
    marketRegime:
      normalizeOptionalDimension(
        firstDefined(
          input.marketRegime,
          input.regime,
          input.marketContext?.marketRegime,
          input.context?.marketRegime
        )
      ),
    session:
      normalizeOptionalDimension(
        firstDefined(
          input.session,
          input.marketSession,
          input.marketContext?.session,
          input.context?.session
        )
      ),
    pattern:
      normalizeOptionalDimension(
        firstDefined(
          input.pattern,
          input.candlePattern,
          input.context?.pattern
        )
      ),
    atr:
      toFiniteNumber(
        firstDefined(
          input.atr,
          input.volatility?.atr,
          input.indicators?.atr
        )
      ),
    baseline: {
      decision:
        baselineDecision || "HOLD",
      confidence:
        round(
          baselineConfidence,
          4
        ),
      tradePlan:
        baselineTradePlan,
      reasons
    },
    engineEvidence:
      normalizeEngineEvidence(input)
  };

  normalized.candidateTradePlans =
    normalizeCandidateTradePlans(
      input,
      normalized.baseline
    );

  return {
    validation,
    normalized
  };
}

// -----------------------------------------------------------------------------
// Policy indexing and matching
// -----------------------------------------------------------------------------

function buildScopeOrder(
  config,
  context
) {
  const order = [];

  if (context.marketRegime) {
    order.push(
      "pairTimeframeEngineDirectionRegime"
    );
  }

  if (context.session) {
    order.push(
      "pairTimeframeEngineDirectionSession"
    );
  }

  if (context.pattern) {
    order.push(
      "pairTimeframeEngineDirectionPattern"
    );
  }

  const configuredFallback =
    Array.isArray(
      config.policyIsolation
        ?.fallbackOrder
    )
      ? config.policyIsolation
          .fallbackOrder
      : [];

  for (
    const scope of
    configuredFallback
  ) {
    if (
      Object.prototype.hasOwnProperty.call(
        SCOPE_FIELDS,
        scope
      )
    ) {
      order.push(scope);
    }
  }

  const unique =
    uniqueStrings(order);

  const maximumFallbackLevels =
    Math.max(
      0,
      toNonNegativeInteger(
        config.policyIsolation
          ?.maximumFallbackLevels,
        3
      )
    );

  return unique.slice(
    0,
    Math.max(
      1,
      maximumFallbackLevels + 1
    )
  );
}

function createPolicyIndex(policyDocument) {
  const index =
    new Map();

  const invalidPolicies = [];

  for (
    const policy of
    policyDocument.policies || []
  ) {
    const validation =
      validatePolicyRecord(policy);

    if (!validation.valid) {
      invalidPolicies.push({
        key:
          policy?.key || null,
        errors:
          validation.errors
      });

      continue;
    }

    const fields =
      SCOPE_FIELDS[policy.scope];

    if (!fields) {
      continue;
    }

    const canonicalValues = [];
    let complete = true;

    for (const field of fields) {
      const canonical =
        canonicalDimensionValue(
          field,
          policy.dimensions[field]
        );

      if (!canonical) {
        complete = false;
        break;
      }

      canonicalValues.push(canonical);
    }

    if (!complete) {
      invalidPolicies.push({
        key: policy.key,
        errors: [
          "Policy dimensions do not satisfy its declared scope."
        ]
      });

      continue;
    }

    const signature =
      `${policy.scope}|${canonicalValues.join("|")}`;

    const existing =
      index.get(signature);

    if (!existing) {
      index.set(signature, policy);
      continue;
    }

    const existingReliability =
      toFiniteNumber(
        existing.reliability?.value
      ) || 0;

    const candidateReliability =
      toFiniteNumber(
        policy.reliability?.value
      ) || 0;

    if (
      candidateReliability >
        existingReliability ||
      (
        candidateReliability ===
          existingReliability &&
        policy.key.localeCompare(
          existing.key
        ) < 0
      )
    ) {
      index.set(signature, policy);
    }
  }

  return {
    index,
    invalidPolicies
  };
}

function createContextSignature(
  scope,
  context,
  direction
) {
  const fields =
    SCOPE_FIELDS[scope];

  if (!fields) {
    return null;
  }

  const source = {
    ...context,
    direction
  };

  const values = [];

  for (const field of fields) {
    const canonical =
      canonicalDimensionValue(
        field,
        source[field]
      );

    if (!canonical) {
      return null;
    }

    values.push(canonical);
  }

  return `${scope}|${values.join("|")}`;
}

function findPolicyForDirection({
  direction,
  context,
  config,
  policyIndex
}) {
  const scopeOrder =
    buildScopeOrder(
      config,
      context
    );

  const attempts = [];

  for (const scope of scopeOrder) {
    const signature =
      createContextSignature(
        scope,
        context,
        direction
      );

    if (!signature) {
      attempts.push({
        scope,
        signature: null,
        matched: false,
        reason:
          "Required context dimension is unavailable."
      });

      continue;
    }

    const policy =
      policyIndex.get(signature) || null;

    attempts.push({
      scope,
      signature,
      matched:
        Boolean(policy),
      reason:
        policy
          ? null
          : "No policy bucket matched."
    });

    if (policy) {
      return {
        policy,
        attempts,
        fallbackDepth:
          attempts.length - 1
      };
    }
  }

  return {
    policy: null,
    attempts,
    fallbackDepth: null
  };
}

function summarizePolicy(policy) {
  if (!policy) {
    return null;
  }

  return {
    key:
      policy.key,
    scope:
      policy.scope,
    dimensions:
      deepClone(
        policy.dimensions
      ),
    action:
      policy.action,
    actionReason:
      policy.actionReason || null,
    authorityLevel:
      policy.authority?.level || null,
    decisiveTrades:
      toNonNegativeInteger(
        policy.metrics?.decisiveTrades
      ),
    reliability:
      round(
        toFiniteNumber(
          policy.reliability?.value
        ) || 0,
        6
      ),
    edgeScore:
      round(
        toFiniteNumber(
          policy.edgeScore
        ) || 0,
        6
      ),
    shrunkExpectancyR:
      round(
        toFiniteNumber(
          policy.shrunkExpectancyR
        ) || 0,
        8
      ),
    outOfSamplePassed:
      policy.validation?.passed === true,
    negativeEdgeConfirmed:
      policy.validation
        ?.negativeEdgeConfirmed === true,
    averagePlannedRiskReward:
      toFiniteNumber(
        policy.metrics
          ?.averagePlannedRiskReward
      )
  };
}

// -----------------------------------------------------------------------------
// Rollout, consensus and authority
// -----------------------------------------------------------------------------

function calculateRolloutSelection(
  input,
  config
) {
  const percent =
    clamp(
      toFiniteNumber(
        config.deployment
          ?.autonomousRolloutPercent
      ) || 0,
      0,
      100
    );

  const salt =
    toNonEmptyStringOrNull(
      config.deployment
        ?.rolloutHashSalt
    ) ||
    "pipsight-autonomous";

  if (
    !input.decisionIdentityStable
  ) {
    return {
      percent,
      selected: false,
      bucket: null,
      identityStable: false,
      reason:
        "Stable decision identity is required for deterministic rollout assignment."
    };
  }

  const digest =
    createHash(
      `${salt}|${input.decisionId}`
    );

  const bucket =
    parseInt(
      digest.slice(0, 12),
      16
    ) % 10000;

  const selected =
    bucket <
    Math.round(percent * 100);

  return {
    percent,
    selected,
    bucket:
      round(bucket / 100, 2),
    identityStable: true,
    reason:
      selected
        ? "Decision is inside the deterministic autonomous rollout cohort."
        : "Decision is outside the deterministic autonomous rollout cohort."
  };
}

function calculateDirectionalConsensus(
  engineEvidence,
  direction,
  config
) {
  const active =
    engineEvidence.filter(
      (item) =>
        item.active &&
        item.decision !== "HOLD"
    );

  const supporting =
    active.filter(
      (item) =>
        item.decision === direction
    );

  const totalWeight =
    active.reduce(
      (sum, item) =>
        sum +
        Math.max(
          1,
          item.confidence
        ),
      0
    );

  const supportingWeight =
    supporting.reduce(
      (sum, item) =>
        sum +
        Math.max(
          1,
          item.confidence
        ),
      0
    );

  const score =
    totalWeight > 0
      ? supportingWeight /
        totalWeight
      : 0;

  const minimumActiveEngines =
    Math.max(
      1,
      toNonNegativeInteger(
        config.authority
          ?.masterConsensus
          ?.minimumActiveEngines,
        2
      )
    );

  const minimumConsensusScore =
    clamp(
      toFiniteNumber(
        config.authority
          ?.masterConsensus
          ?.minimumConsensusScore
      ) || 0.65,
      0,
      1
    );

  const allowSingle =
    config.authority
      ?.masterConsensus
      ?.allowSingleEngineDecision ===
    true;

  const enoughEngines =
    allowSingle
      ? supporting.length >= 1
      : (
          active.length >=
            minimumActiveEngines &&
          supporting.length >=
            minimumActiveEngines
        );

  return {
    direction,
    activeEngines:
      active.length,
    supportingEngines:
      supporting.length,
    supportingEngineNames:
      supporting.map(
        (item) =>
          item.engine
      ),
    score:
      round(score, 6),
    passed:
      enoughEngines &&
      score >=
        minimumConsensusScore,
    requiredActiveEngines:
      minimumActiveEngines,
    requiredScore:
      minimumConsensusScore
  };
}

function policyMeetsAuthority(
  policy,
  minimumLevel,
  authorityConfig
) {
  if (!policy) {
    return false;
  }

  const policyRank =
    AUTHORITY_RANK[
      policy.authority?.level
    ] ?? 0;

  const requiredRank =
    AUTHORITY_RANK[minimumLevel] ?? 0;

  const decisiveTrades =
    toNonNegativeInteger(
      policy.metrics?.decisiveTrades
    );

  const reliability =
    toFiniteNumber(
      policy.reliability?.value
    ) || 0;

  const minimumSamples =
    Math.max(
      0,
      toNonNegativeInteger(
        authorityConfig
          ?.minimumDecisiveSamples,
        0
      )
    );

  const minimumReliability =
    clamp(
      toFiniteNumber(
        authorityConfig
          ?.minimumReliability
      ) || 0,
      0,
      1
    );

  return (
    policyRank >= requiredRank &&
    decisiveTrades >= minimumSamples &&
    reliability >= minimumReliability
  );
}

function calculateConfidenceAdjustment(
  policy,
  config
) {
  if (
    !policy ||
    config.authority
      ?.confidenceAdjustment
      ?.enabled !== true
  ) {
    return 0;
  }

  const maximum =
    Math.max(
      0,
      toFiniteNumber(
        config.authority
          ?.confidenceAdjustment
          ?.maximumAbsolutePoints
      ) || 0
    );

  const reliability =
    clamp(
      toFiniteNumber(
        policy.reliability?.value
      ) || 0,
      0,
      1
    );

  const edgeMagnitude =
    clamp(
      Math.abs(
        toFiniteNumber(
          policy.edgeScore
        ) || 0
      ),
      0,
      1
    );

  if (
    policy.action !== "SUPPORT" &&
    policy.action !== "SUPPRESS"
  ) {
    return 0;
  }

  const sign =
    policy.action === "SUPPORT"
      ? 1
      : -1;

  return round(
    clamp(
      sign *
      maximum *
      reliability *
      edgeMagnitude,
      -maximum,
      maximum
    ),
    4
  );
}

// -----------------------------------------------------------------------------
// Trade-plan candidate scoring
// -----------------------------------------------------------------------------

function isCandidatePlanAllowed({
  candidate,
  baselinePlan,
  direction,
  input,
  config,
  requireBaselineComparison
}) {
  const plan =
    candidate.plan;

  const geometry =
    validateTradePlanGeometry(plan);

  if (!geometry.valid) {
    return {
      allowed: false,
      reason:
        geometry.reason
    };
  }

  if (plan.direction !== direction) {
    return {
      allowed: false,
      reason:
        "CANDIDATE_DIRECTION_MISMATCH"
    };
  }

  const planConfig =
    config.authority
      ?.tradePlanOptimization || {};

  const minimumRiskReward =
    Math.max(
      toFiniteNumber(
        planConfig.minimumRiskReward
      ) || 1.5,
      toFiniteNumber(
        config.riskSafetyGate
          ?.minimumRiskReward
      ) || 1.5
    );

  const maximumRiskReward =
    Math.max(
      minimumRiskReward,
      toFiniteNumber(
        planConfig.maximumRiskReward
      ) || 4
    );

  if (
    plan.riskReward <
      minimumRiskReward ||
    plan.riskReward >
      maximumRiskReward
  ) {
    return {
      allowed: false,
      reason:
        "CANDIDATE_RISK_REWARD_OUTSIDE_ALLOWED_RANGE"
    };
  }

  if (
    requireBaselineComparison &&
    baselinePlan
  ) {
    const maximumEntryDisplacementAtr =
      Math.max(
        0,
        toFiniteNumber(
          planConfig
            .maximumEntryDisplacementAtr
        ) || 0
      );

    const entryDisplacement =
      Math.abs(
        plan.entry -
        baselinePlan.entry
      );

    if (
      entryDisplacement > 0
    ) {
      if (
        planConfig.allowEntryRefinement !==
        true
      ) {
        return {
          allowed: false,
          reason:
            "ENTRY_REFINEMENT_DISABLED"
        };
      }

      if (
        input.atr === null ||
        input.atr === undefined ||
        input.atr <= 0
      ) {
        return {
          allowed: false,
          reason:
            "ATR_REQUIRED_FOR_ENTRY_REFINEMENT"
        };
      }

      if (
        entryDisplacement >
        input.atr *
          maximumEntryDisplacementAtr
      ) {
        return {
          allowed: false,
          reason:
            "ENTRY_DISPLACEMENT_EXCEEDS_ATR_LIMIT"
        };
      }
    }

    const baselineRisk =
      baselinePlan.risk;

    if (
      plan.risk >
      baselineRisk +
        Number.EPSILON
    ) {
      if (
        planConfig.allowStopWidening !==
        true
      ) {
        return {
          allowed: false,
          reason:
            "STOP_WIDENING_DISABLED"
        };
      }
    }

    if (
      plan.risk <
      baselineRisk -
        Number.EPSILON
    ) {
      if (
        planConfig.allowStopTightening !==
        true
      ) {
        return {
          allowed: false,
          reason:
            "STOP_TIGHTENING_DISABLED"
        };
      }

      const tighteningPercent =
        (
          1 -
          plan.risk /
            baselineRisk
        ) * 100;

      const maximumTightening =
        Math.max(
          0,
          toFiniteNumber(
            planConfig
              .maximumStopTighteningPercent
          ) || 0
        );

      if (
        tighteningPercent >
        maximumTightening
      ) {
        return {
          allowed: false,
          reason:
            "STOP_TIGHTENING_EXCEEDS_LIMIT"
        };
      }
    }
  }

  return {
    allowed: true,
    reason: null
  };
}

function selectTradePlanCandidate({
  direction,
  policy,
  input,
  config,
  requireBaselineComparison
}) {
  const baselinePlan =
    input.baseline.tradePlan;

  const targetRiskReward =
    clamp(
      toFiniteNumber(
        policy?.metrics
          ?.averagePlannedRiskReward
      ) ||
      toFiniteNumber(
        baselinePlan?.riskReward
      ) ||
      toFiniteNumber(
        config.authority
          ?.tradePlanOptimization
          ?.minimumRiskReward
      ) ||
      1.5,
      toFiniteNumber(
        config.authority
          ?.tradePlanOptimization
          ?.minimumRiskReward
      ) || 1.5,
      toFiniteNumber(
        config.authority
          ?.tradePlanOptimization
          ?.maximumRiskReward
      ) || 4
    );

  const evaluated = [];

  for (
    const candidate of
    input.candidateTradePlans
  ) {
    const allowed =
      isCandidatePlanAllowed({
        candidate,
        baselinePlan,
        direction,
        input,
        config,
        requireBaselineComparison
      });

    let score = null;

    if (allowed.allowed) {
      const rrDistance =
        Math.abs(
          candidate.plan.riskReward -
          targetRiskReward
        );

      const rrScore =
        1 /
        (1 + rrDistance);

      const quality =
        candidate.quality ?? 0.5;

      const baselineBonus =
        candidate.source ===
        "DETERMINISTIC_BASELINE"
          ? 0.05
          : 0;

      score =
        round(
          clamp(
            rrScore * 0.70 +
            quality * 0.25 +
            baselineBonus,
            0,
            1
          ),
          8
        );
    }

    evaluated.push({
      id:
        candidate.id,
      source:
        candidate.source,
      direction:
        candidate.plan.direction,
      riskReward:
        candidate.plan.riskReward,
      allowed:
        allowed.allowed,
      rejectionReason:
        allowed.reason,
      score
    });
  }

  const ranked =
    input.candidateTradePlans
      .map(
        (candidate) => {
          const evaluation =
            evaluated.find(
              (item) =>
                item.id ===
                candidate.id
            );

          return {
            candidate,
            evaluation
          };
        }
      )
      .filter(
        (item) =>
          item.evaluation?.allowed
      )
      .sort(
        (left, right) =>
          right.evaluation.score -
            left.evaluation.score ||
          left.candidate.id.localeCompare(
            right.candidate.id
          )
      );

  return {
    selected:
      ranked.length > 0
        ? deepClone(
            ranked[0].candidate.plan
          )
        : null,
    selectedSource:
      ranked.length > 0
        ? ranked[0].candidate.source
        : null,
    selectedScore:
      ranked.length > 0
        ? ranked[0].evaluation.score
        : null,
    targetRiskReward:
      round(targetRiskReward, 8),
    evaluated
  };
}

// -----------------------------------------------------------------------------
// Decision evaluation
// -----------------------------------------------------------------------------

function createBaselineCandidate(input) {
  return {
    decision:
      input.baseline.decision,
    confidence:
      input.baseline.confidence,
    tradePlan:
      deepClone(
        input.baseline.tradePlan
      ),
    reasons:
      [...input.baseline.reasons]
  };
}

function determineBestDirectionalPolicy(
  buyMatch,
  sellMatch
) {
  const candidates = [
    {
      direction: "BUY",
      policy: buyMatch.policy
    },
    {
      direction: "SELL",
      policy: sellMatch.policy
    }
  ].filter(
    (item) =>
      item.policy &&
      item.policy.action ===
        "SUPPORT"
  );

  candidates.sort(
    (left, right) => {
      const leftRank =
        AUTHORITY_RANK[
          left.policy.authority?.level
        ] || 0;

      const rightRank =
        AUTHORITY_RANK[
          right.policy.authority?.level
        ] || 0;

      return (
        rightRank - leftRank ||
        (
          toFiniteNumber(
            right.policy.reliability?.value
          ) || 0
        ) -
          (
            toFiniteNumber(
              left.policy.reliability?.value
            ) || 0
          ) ||
        (
          toFiniteNumber(
            right.policy.edgeScore
          ) || 0
        ) -
          (
            toFiniteNumber(
              left.policy.edgeScore
            ) || 0
          ) ||
        left.direction.localeCompare(
          right.direction
        )
      );
    }
  );

  if (candidates.length === 0) {
    return null;
  }

  if (candidates.length === 1) {
    return candidates[0];
  }

  const firstEdge =
    toFiniteNumber(
      candidates[0].policy.edgeScore
    ) || 0;

  const secondEdge =
    toFiniteNumber(
      candidates[1].policy.edgeScore
    ) || 0;

  if (
    Math.abs(
      firstEdge - secondEdge
    ) < 0.05
  ) {
    return null;
  }

  return candidates[0];
}

function evaluateDecisionWithSources({
  input,
  config,
  policyDocument,
  policyState,
  configHash = null,
  evaluatedAt = new Date().toISOString()
}) {
  const evaluatedAtIso =
    toISOStringOrNull(evaluatedAt) ||
    new Date().toISOString();

  const evaluatedAtMs =
    Date.parse(evaluatedAtIso);

  const inputResult =
    normalizeDecisionInput(
      input,
      evaluatedAtIso
    );

  const configValidation =
    validateAutonomousConfig(config);

  const sourceHashes = {
    autonomousConfig:
      configHash ||
      (
        policyDocument?.config?.hash &&
        config.configName ===
          SUPPORTED_CONFIG_NAME &&
        config.configVersion ===
          SUPPORTED_CONFIG_VERSION
          ? policyDocument.config.hash
          : createHash(
              Buffer.from(
                JSON.stringify(
                  config,
                  null,
                  2
                ) + "\n",
                "utf8"
              )
            )
      )
  };

  const policyValidation =
    validatePolicyDocument(
      policyDocument,
      config,
      policyState,
      sourceHashes,
      evaluatedAtMs
    );

  const combinedValidation = {
    valid:
      inputResult.validation.valid &&
      configValidation.valid &&
      policyValidation.valid,
    errors: [
      ...inputResult.validation.errors,
      ...configValidation.errors,
      ...policyValidation.errors
    ],
    warnings:
      uniqueStrings([
        ...inputResult.validation.warnings,
        ...configValidation.warnings,
        ...policyValidation.warnings
      ])
  };

  const normalizedInput =
    inputResult.normalized || {
      decisionId:
        createHash({
          evaluatedAt: evaluatedAtIso,
          invalid: true
        }).slice(0, 32),
      decisionIdentityStable: false,
      evaluatedAt:
        evaluatedAtIso,
      marketDataAt: null,
      pair: null,
      timeframe: null,
      engine: null,
      marketRegime: null,
      session: null,
      pattern: null,
      atr: null,
      baseline: {
        decision: "HOLD",
        confidence: 0,
        tradePlan: null,
        reasons: []
      },
      engineEvidence: [],
      candidateTradePlans: []
    };

  const baseline =
    createBaselineCandidate(
      normalizedInput
    );

  const mode =
    ALLOWED_MODES.has(
      config?.deployment?.mode
    )
      ? config.deployment.mode
      : "OFF";

  const rollout =
    calculateRolloutSelection(
      normalizedInput,
      config
    );

  const policyIndexResult =
    policyValidation.valid
      ? createPolicyIndex(
          policyDocument
        )
      : {
          index: new Map(),
          invalidPolicies: []
        };

  if (
    policyIndexResult
      .invalidPolicies.length > 0
  ) {
    combinedValidation.warnings.push(
      `${policyIndexResult.invalidPolicies.length} malformed policy bucket(s) were ignored.`
    );
  }

  const context = {
    pair:
      normalizedInput.pair,
    timeframe:
      normalizedInput.timeframe,
    engine:
      normalizedInput.engine,
    marketRegime:
      normalizedInput.marketRegime,
    session:
      normalizedInput.session,
    pattern:
      normalizedInput.pattern
  };

  const buyMatch =
    findPolicyForDirection({
      direction: "BUY",
      context,
      config,
      policyIndex:
        policyIndexResult.index
    });

  const sellMatch =
    findPolicyForDirection({
      direction: "SELL",
      context,
      config,
      policyIndex:
        policyIndexResult.index
    });

  const baselineMatch =
    baseline.decision === "BUY"
      ? buyMatch
      : (
          baseline.decision === "SELL"
            ? sellMatch
            : {
                policy: null,
                attempts: [],
                fallbackDepth: null
              }
        );

  const shadowCandidate =
    deepClone(baseline);

  const liveCandidate =
    deepClone(baseline);

  const changes = [];
  const blockedChanges = [];
  const evidenceReasons = [];

  const policyReady =
    combinedValidation.valid;

  const emergencyStop =
    mode === "EMERGENCY_STOP" ||
    config.deployment
      ?.emergencyStop === true;

  if (emergencyStop) {
    shadowCandidate.decision =
      "HOLD";
    shadowCandidate.tradePlan =
      null;
    shadowCandidate.confidence =
      0;
    shadowCandidate.reasons.push(
      "Autonomous emergency stop is active."
    );

    liveCandidate.decision =
      "HOLD";
    liveCandidate.tradePlan =
      null;
    liveCandidate.confidence =
      0;
    liveCandidate.reasons.push(
      "Autonomous emergency stop is active."
    );

    changes.push({
      type: "EMERGENCY_STOP",
      from: baseline.decision,
      to: "HOLD",
      live: true
    });
  }

  const controlledAuthorityAvailable =
    policyReady &&
    !emergencyStop &&
    config.deployment?.enabled === true &&
    [
      "CONTROLLED",
      "AUTONOMOUS"
    ].includes(mode);

  const autonomousAuthorityAvailable =
    controlledAuthorityAvailable &&
    mode === "AUTONOMOUS" &&
    rollout.selected;

  // Confidence evidence is calculated in all non-OFF modes for shadow audit.
  if (
    policyReady &&
    mode !== "OFF" &&
    !emergencyStop &&
    baselineMatch.policy
  ) {
    const adjustment =
      calculateConfidenceAdjustment(
        baselineMatch.policy,
        config
      );

    shadowCandidate.confidence =
      round(
        clamp(
          baseline.confidence +
          adjustment,
          0,
          100
        ),
        4
      );

    if (adjustment !== 0) {
      evidenceReasons.push(
        `Policy ${baselineMatch.policy.key} produced a ${adjustment > 0 ? "+" : ""}${adjustment}-point confidence adjustment.`
      );
    }

    const confidenceLiveAllowed =
      controlledAuthorityAvailable &&
      config.authority
        ?.confidenceAdjustment
        ?.enabled === true;

    if (confidenceLiveAllowed) {
      liveCandidate.confidence =
        shadowCandidate.confidence;

      if (adjustment !== 0) {
        changes.push({
          type:
            "CONFIDENCE_ADJUSTMENT",
          from:
            baseline.confidence,
          to:
            liveCandidate.confidence,
          amount:
            adjustment,
          policyKey:
            baselineMatch.policy.key,
          live: true
        });
      }
    } else if (adjustment !== 0) {
      blockedChanges.push({
        type:
          "CONFIDENCE_ADJUSTMENT",
        reason:
          "Current deployment mode does not permit live confidence authority.",
        amount:
          adjustment,
        policyKey:
          baselineMatch.policy.key
      });
    }
  }

  // Low-risk suppression: BUY/SELL -> HOLD only.
  if (
    policyReady &&
    !emergencyStop &&
    baseline.decision !== "HOLD" &&
    baselineMatch.policy?.action ===
      "SUPPRESS"
  ) {
    const filterConfig =
      config.authority
        ?.signalFiltering || {};

    const filterEligible =
      filterConfig.enabled === true &&
      filterConfig
        .mayConvertBuySellToHold ===
        true &&
      policyMeetsAuthority(
        baselineMatch.policy,
        "FILTER_ONLY",
        filterConfig
      ) &&
      baselineMatch.policy.validation
        ?.negativeEdgeConfirmed === true;

    if (filterEligible) {
      shadowCandidate.decision =
        "HOLD";
      shadowCandidate.tradePlan =
        null;
      shadowCandidate.reasons.push(
        "AI policy suppressed a historically negative setup."
      );

      if (
        controlledAuthorityAvailable &&
        Array.isArray(
          filterConfig.liveAuthorityModes
        ) &&
        filterConfig.liveAuthorityModes
          .includes(mode)
      ) {
        liveCandidate.decision =
          "HOLD";
        liveCandidate.tradePlan =
          null;
        liveCandidate.reasons.push(
          "AI policy suppressed a historically negative setup."
        );

        changes.push({
          type:
            "SIGNAL_SUPPRESSION",
          from:
            baseline.decision,
          to:
            "HOLD",
          policyKey:
            baselineMatch.policy.key,
          live: true
        });
      } else {
        blockedChanges.push({
          type:
            "SIGNAL_SUPPRESSION",
          reason:
            "Current deployment mode does not permit live filtering authority.",
          policyKey:
            baselineMatch.policy.key
        });
      }
    }
  }

  // Direction selection/reversal requires autonomous cohort + consensus + plan.
  if (
    policyReady &&
    !emergencyStop
  ) {
    const bestDirectional =
      determineBestDirectionalPolicy(
        buyMatch,
        sellMatch
      );

    const directionConfig =
      config.authority
        ?.directionSelection || {};

    if (
      bestDirectional &&
      directionConfig.enabled === true &&
      policyMeetsAuthority(
        bestDirectional.policy,
        "DIRECTION_SELECTION",
        directionConfig
      ) &&
      bestDirectional.policy.validation
        ?.passed === true &&
      (
        toFiniteNumber(
          bestDirectional.policy
            .edgeScore
        ) || 0
      ) >=
        (
          toFiniteNumber(
            directionConfig
              .minimumPolicyEdgeR
          ) || 0.15
        )
    ) {
      const desiredDirection =
        bestDirectional.direction;

      const isReversal =
        baseline.decision !== "HOLD" &&
        baseline.decision !==
          desiredDirection;

      const isHoldActivation =
        baseline.decision === "HOLD";

      const directionChangeRequested =
        isReversal ||
        isHoldActivation;

      if (directionChangeRequested) {
        const consensus =
          calculateDirectionalConsensus(
            normalizedInput
              .engineEvidence,
            desiredDirection,
            config
          );

        let eligible =
          consensus.passed;

        let blockReason =
          consensus.passed
            ? null
            : "Master consensus requirements were not met.";

        if (
          isReversal &&
          directionConfig
            .mayReverseDeterministicDirection !==
            true
        ) {
          eligible = false;
          blockReason =
            "Direction reversal is disabled.";
        }

        if (
          isHoldActivation &&
          directionConfig
            .maySelectBuySellHold !== true
        ) {
          eligible = false;
          blockReason =
            "HOLD-to-direction selection is disabled.";
        }

        if (
          isReversal &&
          directionConfig
            .requireMultiEngineSupportForReversal ===
            true &&
          consensus.supportingEngines <
            Math.max(
              1,
              toNonNegativeInteger(
                directionConfig
                  .minimumSupportingDirectionalEngines,
                2
              )
            )
        ) {
          eligible = false;
          blockReason =
            "Direction reversal lacks the required independent engine support.";
        }

        const planSelection =
          selectTradePlanCandidate({
            direction:
              desiredDirection,
            policy:
              bestDirectional.policy,
            input:
              normalizedInput,
            config,
            requireBaselineComparison:
              false
          });

        if (!planSelection.selected) {
          eligible = false;
          blockReason =
            "No independently generated valid trade plan exists for the requested direction.";
        }

        if (eligible) {
          shadowCandidate.decision =
            desiredDirection;
          shadowCandidate.tradePlan =
            planSelection.selected;
          shadowCandidate.confidence =
            round(
              clamp(
                Math.max(
                  baseline.confidence,
                  (
                    toFiniteNumber(
                      bestDirectional.policy
                        .reliability?.value
                    ) || 0
                  ) * 100
                ),
                0,
                100
              ),
              4
            );
          shadowCandidate.reasons.push(
            `AI direction policy selected ${desiredDirection} with validated multi-engine consensus.`
          );

          if (
            autonomousAuthorityAvailable &&
            Array.isArray(
              directionConfig
                .liveAuthorityModes
            ) &&
            directionConfig
              .liveAuthorityModes
              .includes(mode)
          ) {
            liveCandidate.decision =
              desiredDirection;
            liveCandidate.tradePlan =
              planSelection.selected;
            liveCandidate.confidence =
              shadowCandidate.confidence;
            liveCandidate.reasons.push(
              `AI direction policy selected ${desiredDirection} with validated multi-engine consensus.`
            );

            changes.push({
              type:
                isReversal
                  ? "DIRECTION_REVERSAL"
                  : "DIRECTION_SELECTION",
              from:
                baseline.decision,
              to:
                desiredDirection,
              policyKey:
                bestDirectional.policy.key,
              consensus,
              tradePlanSource:
                planSelection.selectedSource,
              live: true
            });
          } else {
            blockedChanges.push({
              type:
                isReversal
                  ? "DIRECTION_REVERSAL"
                  : "DIRECTION_SELECTION",
              reason:
                mode !== "AUTONOMOUS"
                  ? "Current deployment mode is not AUTONOMOUS."
                  : rollout.reason,
              policyKey:
                bestDirectional.policy.key,
              consensus
            });
          }
        } else {
          blockedChanges.push({
            type:
              isReversal
                ? "DIRECTION_REVERSAL"
                : "DIRECTION_SELECTION",
            reason:
              blockReason,
            policyKey:
              bestDirectional.policy.key,
            consensus,
            planEvaluation:
              planSelection.evaluated
          });
        }
      }
    }
  }

  // Trade-plan optimization selects only from independently supplied plans.
  if (
    policyReady &&
    !emergencyStop &&
    liveCandidate.decision !== "HOLD"
  ) {
    const directionMatch =
      liveCandidate.decision === "BUY"
        ? buyMatch
        : sellMatch;

    const planConfig =
      config.authority
        ?.tradePlanOptimization || {};

    const planEligible =
      planConfig.enabled === true &&
      directionMatch.policy?.action ===
        "SUPPORT" &&
      directionMatch.policy.validation
        ?.passed === true &&
      policyMeetsAuthority(
        directionMatch.policy,
        "TRADE_PLAN",
        planConfig
      );

    if (planEligible) {
      const planSelection =
        selectTradePlanCandidate({
          direction:
            liveCandidate.decision,
          policy:
            directionMatch.policy,
          input:
            normalizedInput,
          config,
          requireBaselineComparison:
            baseline.decision ===
              liveCandidate.decision
        });

      const shadowPlanSelection =
        planSelection.selected;

      if (shadowPlanSelection) {
        shadowCandidate.tradePlan =
          shadowPlanSelection;

        const planChanged =
          createHash(
            shadowPlanSelection
          ) !==
          createHash(
            baseline.tradePlan
          );

        if (planChanged) {
          shadowCandidate.reasons.push(
            "AI selected a bounded trade plan from independently generated candidates."
          );
        }

        const livePlanAllowed =
          autonomousAuthorityAvailable &&
          Array.isArray(
            planConfig.liveAuthorityModes
          ) &&
          planConfig.liveAuthorityModes
            .includes(mode);

        if (
          planChanged &&
          livePlanAllowed
        ) {
          liveCandidate.tradePlan =
            shadowPlanSelection;
          liveCandidate.reasons.push(
            "AI selected a bounded trade plan from independently generated candidates."
          );

          changes.push({
            type:
              "TRADE_PLAN_SELECTION",
            policyKey:
              directionMatch.policy.key,
            selectedSource:
              planSelection.selectedSource,
            selectedScore:
              planSelection.selectedScore,
            targetRiskReward:
              planSelection.targetRiskReward,
            live: true
          });
        } else if (planChanged) {
          blockedChanges.push({
            type:
              "TRADE_PLAN_SELECTION",
            reason:
              mode !== "AUTONOMOUS"
                ? "Current deployment mode is not AUTONOMOUS."
                : rollout.reason,
            policyKey:
              directionMatch.policy.key,
            selectedSource:
              planSelection.selectedSource
          });
        }
      }
    }
  }

  // In SHADOW/OFF or any invalid-policy condition, deterministic output remains.
  let proposed =
    deepClone(liveCandidate);

  let authorityMode =
    "DETERMINISTIC_FALLBACK";

  if (emergencyStop) {
    authorityMode =
      "EMERGENCY_STOP";
  } else if (!policyReady) {
    proposed =
      deepClone(baseline);

    authorityMode =
      "DETERMINISTIC_FALLBACK";
  } else if (mode === "OFF") {
    proposed =
      deepClone(baseline);

    authorityMode =
      "OFF";
  } else if (mode === "SHADOW") {
    proposed =
      deepClone(baseline);

    authorityMode =
      "SHADOW";
  } else if (mode === "CONTROLLED") {
    authorityMode =
      "CONTROLLED";
  } else if (mode === "AUTONOMOUS") {
    authorityMode =
      autonomousAuthorityAvailable
        ? "AUTONOMOUS"
        : "CONTROLLED_FALLBACK";
  }

  const decisionHash =
    createHash({
      inputId:
        normalizedInput.decisionId,
      evaluatedAt:
        evaluatedAtIso,
      policyHash:
        policyDocument?.metadata
          ?.policyContentHash || null,
      baseline,
      shadowCandidate,
      proposed
    });

  return {
    version:
      DECISION_SCHEMA_VERSION,
    engineName:
      ENGINE_NAME,
    engineVersion:
      ENGINE_VERSION,
    evaluatedAt:
      evaluatedAtIso,
    decisionId:
      normalizedInput.decisionId,
    decisionHash,
    context: {
      pair:
        normalizedInput.pair,
      timeframe:
        normalizedInput.timeframe,
      engine:
        normalizedInput.engine,
      marketRegime:
        normalizedInput.marketRegime,
      session:
        normalizedInput.session,
      pattern:
        normalizedInput.pattern,
      marketDataAt:
        normalizedInput.marketDataAt
    },
    deployment: {
      configuredMode:
        mode,
      authorityMode,
      enabled:
        config.deployment
          ?.enabled === true,
      emergencyStop,
      rollout
    },
    baseline,
    shadowCandidate,
    proposedDecision:
      proposed,
    changes,
    blockedChanges,
    evidence: {
      baselinePolicy:
        summarizePolicy(
          baselineMatch.policy
        ),
      buyPolicy:
        summarizePolicy(
          buyMatch.policy
        ),
      sellPolicy:
        summarizePolicy(
          sellMatch.policy
        ),
      baselineMatchAttempts:
        baselineMatch.attempts,
      buyMatchAttempts:
        buyMatch.attempts,
      sellMatchAttempts:
        sellMatch.attempts,
      engineEvidence:
        normalizedInput
          .engineEvidence,
      evidenceReasons
    },
    validation: {
      valid:
        combinedValidation.valid,
      errors:
        uniqueStrings(
          combinedValidation.errors
        ),
      warnings:
        uniqueStrings(
          combinedValidation.warnings
        )
    },
    safety: {
      finalApprovalRequired: true,
      finalAuthority:
        "PipSight Pro AI Safety Gate",
      orderPlacementPermitted: false,
      riskLimitModificationPermitted:
        false,
      sourceCodeModificationPermitted:
        false,
      externalNetworkCalls:
        false,
      failClosedRecommendation:
        proposed.decision === "HOLD"
          ? "HOLD"
          : "VALIDATE_WITH_SAFETY_GATE",
      notes: [
        "proposedDecision is not executable until the independent Safety Gate approves it.",
        "Direction changes require an independently generated valid trade plan; this engine never invents prices.",
        "Risk limits remain immutable and outside AI policy authority."
      ]
    },
    metadata: {
      policyHash:
        policyDocument?.metadata
          ?.policyContentHash || null,
      policyGeneratedAt:
        policyDocument?.generatedAt || null,
      configVersion:
        config.configVersion || null,
      deterministic:
        true,
      deterministicRollout:
        true,
      explainable:
        true,
      duplicateSafe:
        true,
      liveOrderExecution:
        false,
      nextConsumer:
        "PipSight Pro AI Safety Gate"
    }
  };
}

function evaluateDecision(
  input,
  options = {}
) {
  const evaluatedAt =
    toISOStringOrNull(
      options.evaluatedAt
    ) ||
    new Date().toISOString();

  const config =
    options.config ||
    readJSON(
      options.autonomousConfigPath ||
      AUTONOMOUS_CONFIG_PATH
    );

  const policyDocument =
    options.policy ||
    readJSON(
      options.aiPolicyPath ||
      AI_POLICY_PATH
    );

  const policyState =
    options.policyState ||
    readJSON(
      options.aiPolicyStatePath ||
      AI_POLICY_STATE_PATH
    );

  const configPath =
    options.autonomousConfigPath ||
    AUTONOMOUS_CONFIG_PATH;

  const configHash =
    !options.config &&
    fileExists(configPath)
      ? hashFileContents(configPath)
      : (options.configHash || null);

  return evaluateDecisionWithSources({
    input,
    config,
    policyDocument,
    policyState,
    configHash,
    evaluatedAt
  });
}

function evaluateBatch(
  inputs,
  options = {}
) {
  if (!Array.isArray(inputs)) {
    throw new TypeError(
      "evaluateBatch inputs must be an array."
    );
  }

  const config =
    options.config ||
    readJSON(
      options.autonomousConfigPath ||
      AUTONOMOUS_CONFIG_PATH
    );

  const policy =
    options.policy ||
    readJSON(
      options.aiPolicyPath ||
      AI_POLICY_PATH
    );

  const policyState =
    options.policyState ||
    readJSON(
      options.aiPolicyStatePath ||
      AI_POLICY_STATE_PATH
    );

  const baseTime =
    toISOStringOrNull(
      options.evaluatedAt
    ) ||
    new Date().toISOString();

  const configPath =
    options.autonomousConfigPath ||
    AUTONOMOUS_CONFIG_PATH;

  const configHash =
    !options.config &&
    fileExists(configPath)
      ? hashFileContents(configPath)
      : (options.configHash || null);

  return inputs.map(
    (input, index) =>
      evaluateDecisionWithSources({
        input,
        config,
        policyDocument:
          policy,
        policyState,
        configHash,
        evaluatedAt:
          new Date(
            Date.parse(baseTime) +
            index
          ).toISOString()
      })
  );
}

// -----------------------------------------------------------------------------
// Decision log and state
// -----------------------------------------------------------------------------

function createEmptyDecisionLog() {
  return {
    version:
      LOG_SCHEMA_VERSION,
    engineName:
      ENGINE_NAME,
    engineVersion:
      ENGINE_VERSION,
    updatedAt: null,
    decisions: []
  };
}

function normalizeDecisionLog(log) {
  if (!isPlainObject(log)) {
    return createEmptyDecisionLog();
  }

  const decisions =
    Array.isArray(log.decisions)
      ? log.decisions
          .filter(isPlainObject)
      : [];

  return {
    version:
      LOG_SCHEMA_VERSION,
    engineName:
      ENGINE_NAME,
    engineVersion:
      ENGINE_VERSION,
    updatedAt:
      toISOStringOrNull(
        log.updatedAt
      ),
    decisions
  };
}

function createEmptyDecisionState(now) {
  return {
    version:
      STATE_SCHEMA_VERSION,
    engineName:
      ENGINE_NAME,
    engineVersion:
      ENGINE_VERSION,
    createdAt:
      now,
    updatedAt:
      now,
    lastDecisionAt: null,
    lastDecisionHash: null,
    counters: {
      evaluations: 0,
      loggedDecisions: 0,
      duplicateDecisions: 0,
      validationFailures: 0,
      shadowDecisions: 0,
      controlledDecisions: 0,
      autonomousDecisions: 0,
      emergencyStops: 0,
      suppressions: 0,
      reversals: 0,
      tradePlanSelections: 0
    }
  };
}

function normalizeDecisionState(
  state,
  now
) {
  const normalized =
    isPlainObject(state)
      ? state
      : createEmptyDecisionState(now);

  const defaults =
    createEmptyDecisionState(now);

  return {
    ...defaults,
    ...normalized,
    version:
      STATE_SCHEMA_VERSION,
    engineName:
      ENGINE_NAME,
    engineVersion:
      ENGINE_VERSION,
    createdAt:
      toISOStringOrNull(
        normalized.createdAt
      ) || now,
    updatedAt:
      now,
    counters: {
      ...defaults.counters,
      ...(isPlainObject(
        normalized.counters
      )
        ? Object.fromEntries(
            Object.entries(
              normalized.counters
            ).map(
              ([key, value]) => [
                key,
                toNonNegativeInteger(value)
              ]
            )
          )
        : {})
    }
  };
}

function buildDecisionLogRecord(result) {
  return {
    decisionHash:
      result.decisionHash,
    decisionId:
      result.decisionId,
    evaluatedAt:
      result.evaluatedAt,
    context:
      result.context,
    deployment:
      result.deployment,
    baseline:
      result.baseline,
    shadowCandidate:
      result.shadowCandidate,
    proposedDecision:
      result.proposedDecision,
    changes:
      result.changes,
    blockedChanges:
      result.blockedChanges,
    policyEvidence: {
      baselinePolicy:
        result.evidence
          .baselinePolicy,
      buyPolicy:
        result.evidence
          .buyPolicy,
      sellPolicy:
        result.evidence
          .sellPolicy
    },
    validation:
      result.validation,
    safety:
      result.safety,
    metadata:
      result.metadata
  };
}

function persistDecisionResult(
  result,
  options = {}
) {
  const logPath =
    options.decisionLogPath ||
    DECISION_LOG_PATH;

  const statePath =
    options.decisionStatePath ||
    DECISION_STATE_PATH;

  const previewPath =
    options.decisionPreviewPath ||
    DECISION_PREVIEW_PATH;

  const now =
    result.evaluatedAt;

  const log =
    normalizeDecisionLog(
      readJSON(
        logPath,
        {
          required: false,
          defaultValue:
            createEmptyDecisionLog()
        }
      )
    );

  const state =
    normalizeDecisionState(
      readJSON(
        statePath,
        {
          required: false,
          defaultValue:
            createEmptyDecisionState(
              now
            )
        }
      ),
      now
    );

  state.counters.evaluations += 1;

  const duplicate =
    log.decisions.some(
      (record) =>
        record.decisionHash ===
        result.decisionHash
    );

  if (duplicate) {
    state.counters
      .duplicateDecisions += 1;
  } else {
    log.decisions.push(
      buildDecisionLogRecord(
        result
      )
    );

    log.decisions =
      log.decisions
        .sort(
          (left, right) =>
            Date.parse(
              left.evaluatedAt
            ) -
              Date.parse(
                right.evaluatedAt
              ) ||
            left.decisionHash
              .localeCompare(
                right.decisionHash
              )
        )
        .slice(
          -MAX_DECISION_LOG_ENTRIES
        );

    state.counters
      .loggedDecisions += 1;
  }

  if (!result.validation.valid) {
    state.counters
      .validationFailures += 1;
  }

  const mode =
    result.deployment
      .authorityMode;

  if (mode === "SHADOW") {
    state.counters
      .shadowDecisions += 1;
  } else if (
    mode === "CONTROLLED" ||
    mode === "CONTROLLED_FALLBACK"
  ) {
    state.counters
      .controlledDecisions += 1;
  } else if (
    mode === "AUTONOMOUS"
  ) {
    state.counters
      .autonomousDecisions += 1;
  } else if (
    mode === "EMERGENCY_STOP"
  ) {
    state.counters
      .emergencyStops += 1;
  }

  for (const change of result.changes) {
    if (
      change.type ===
      "SIGNAL_SUPPRESSION"
    ) {
      state.counters
        .suppressions += 1;
    }

    if (
      change.type ===
      "DIRECTION_REVERSAL"
    ) {
      state.counters
        .reversals += 1;
    }

    if (
      change.type ===
      "TRADE_PLAN_SELECTION"
    ) {
      state.counters
        .tradePlanSelections += 1;
    }
  }

  log.updatedAt =
    now;

  state.updatedAt =
    now;

  state.lastDecisionAt =
    now;

  state.lastDecisionHash =
    result.decisionHash;

  if (options.skipPreview !== true) {
    atomicWriteJSON(
      previewPath,
      result
    );
  }

  atomicWriteJSON(
    logPath,
    log
  );

  atomicWriteJSON(
    statePath,
    state
  );

  return {
    duplicate,
    logEntries:
      log.decisions.length,
    state
  };
}

// -----------------------------------------------------------------------------
// CLI runner
// -----------------------------------------------------------------------------

function runAIDecisionEngine(
  options = {}
) {
  const evaluatedAt =
    new Date().toISOString();

  try {
    const inputPath =
      options.inputPath ||
      DECISION_INPUT_PATH;

    const inputDocument =
      options.input ||
      readJSON(inputPath);

    const inputs =
      Array.isArray(inputDocument)
        ? inputDocument
        : (
            Array.isArray(
              inputDocument.decisions
            )
              ? inputDocument.decisions
              : [inputDocument]
          );

    const results =
      evaluateBatch(
        inputs,
        {
          evaluatedAt,
          autonomousConfigPath:
            options.autonomousConfigPath,
          aiPolicyPath:
            options.aiPolicyPath,
          aiPolicyStatePath:
            options.aiPolicyStatePath
        }
      );

    const preview = {
      version:
        DECISION_SCHEMA_VERSION,
      engineName:
        ENGINE_NAME,
      engineVersion:
        ENGINE_VERSION,
      generatedAt:
        evaluatedAt,
      count:
        results.length,
      results
    };

    atomicWriteJSON(
      options.decisionPreviewPath ||
      DECISION_PREVIEW_PATH,
      preview
    );

    const persisted = [];

    if (
      options.persist !== false
    ) {
      for (const result of results) {
        persisted.push(
          persistDecisionResult(
            result,
            {
              ...options,
              skipPreview: true
            }
          )
        );
      }
    }

    const failed =
      results.filter(
        (result) =>
          !result.validation.valid
      ).length;

    console.log(
      `[ai-decision] Version: ${ENGINE_VERSION}`
    );
    console.log(
      `[ai-decision] Evaluated: ${results.length}`
    );
    console.log(
      `[ai-decision] Validation failures: ${failed}`
    );
    console.log(
      `[ai-decision] Final approval remains with ai-safety-gate.js`
    );

    return {
      status:
        failed === 0
          ? "SUCCESS"
          : "DEGRADED",
      generatedAt:
        evaluatedAt,
      results,
      persisted
    };
  } catch (error) {
    console.error(
      `[ai-decision] FAILED: ${error.stack || error.message}`
    );

    return {
      status: "FAILED",
      generatedAt:
        evaluatedAt,
      error:
        error.message
    };
  }
}

if (require.main === module) {
  const result =
    runAIDecisionEngine();

  if (
    result.status ===
    "FAILED"
  ) {
    process.exitCode = 1;
  }
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

module.exports = {
  ENGINE_NAME,
  ENGINE_VERSION,
  DECISION_SCHEMA_VERSION,
  STATE_SCHEMA_VERSION,
  LOG_SCHEMA_VERSION,

  paths: {
    data:
      DATA_DIR,
    autonomousConfig:
      AUTONOMOUS_CONFIG_PATH,
    aiPolicy:
      AI_POLICY_PATH,
    aiPolicyState:
      AI_POLICY_STATE_PATH,
    decisionInput:
      DECISION_INPUT_PATH,
    decisionPreview:
      DECISION_PREVIEW_PATH,
    decisionLog:
      DECISION_LOG_PATH,
    decisionState:
      DECISION_STATE_PATH
  },

  runAIDecisionEngine,
  evaluateDecision,
  evaluateDecisionWithSources,
  evaluateBatch,
  persistDecisionResult,
  normalizeDecisionInput,
  normalizeTradePlan,
  validateTradePlanGeometry,
  normalizeEngineEvidence,
  normalizeCandidateTradePlans,
  validateAutonomousConfig,
  validatePolicyDocument,
  validatePolicyRecord,
  buildScopeOrder,
  createPolicyIndex,
  findPolicyForDirection,
  calculateRolloutSelection,
  calculateDirectionalConsensus,
  calculateConfidenceAdjustment,
  selectTradePlanCandidate,
  normalizePair,
  normalizeEngine,
  normalizeTimeframe,
  normalizeDecision,
  createHash
};
