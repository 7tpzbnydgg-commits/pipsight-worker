"use strict";

/**
 * PipSight Pro — Immutable AI Safety Gate
 *
 * Version: 1.4.0
 *
 * Purpose:
 * - Act as the final, independent, fail-closed authority after the
 *   deterministic Rule Engine and Autonomous AI Decision Engine.
 * - Approve or reject a signal candidate before publication/execution.
 * - Enforce immutable risk, geometry, freshness, exposure, cooldown,
 *   duplicate, daily/weekly loss and emergency-stop controls.
 * - Never generate a new BUY/SELL direction and never invent prices.
 * - Keep broker order execution disabled unless a complete authenticated
 *   execution-risk snapshot is explicitly supplied and order execution is
 *   separately enabled by the caller.
 *
 * Reads:
 *   data/autonomous-config.json
 *
 * Optional CLI input:
 *   data/ai-safety-input.json
 *
 * Optional persisted outputs:
 *   data/ai-safety-preview.json
 *   data/ai-safety-log.json
 *   data/ai-safety-state.json
 *
 * CommonJS / Node.js 20
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// -----------------------------------------------------------------------------
// Metadata
// -----------------------------------------------------------------------------

const ENGINE_NAME =
  "PipSight Pro Immutable AI Safety Gate";

const ENGINE_VERSION =
  "1.4.0";

const SAFETY_SCHEMA_VERSION =
  1;

const STATE_SCHEMA_VERSION =
  1;

const LOG_SCHEMA_VERSION =
  1;

const SUPPORTED_CONFIG_NAME =
  "PipSight Pro Autonomous Trading Control Plane";

const SUPPORTED_CONFIG_VERSION =
  "1.4.0";

const SUPPORTED_DECISION_ENGINE_NAME =
  "PipSight Pro Autonomous AI Decision Engine";

const SUPPORTED_DECISION_ENGINE_VERSION =
  "1.4.0";

const HASH_ALGORITHM =
  "sha256";

const MAX_LOG_ENTRIES =
  5000;

const MAX_RECENT_FINGERPRINTS =
  5000;

const MAX_RECENT_APPROVALS =
  5000;

const MAX_STATE_SNAPSHOTS =
  10;

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

const SAFETY_INPUT_PATH =
  path.join(
    DATA_DIR,
    "ai-safety-input.json"
  );

const SAFETY_PREVIEW_PATH =
  path.join(
    DATA_DIR,
    "ai-safety-preview.json"
  );

const SAFETY_LOG_PATH =
  path.join(
    DATA_DIR,
    "ai-safety-log.json"
  );

const SAFETY_STATE_PATH =
  path.join(
    DATA_DIR,
    "ai-safety-state.json"
  );

const SAFETY_PENDING_PATH =
  path.join(
    DATA_DIR,
    "ai-safety-state.pending.json"
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

const ALLOWED_EXECUTION_CONTEXTS =
  new Set([
    "SIGNAL_ONLY",
    "ORDER_EXECUTION"
  ]);

const BLOCKING_CHECKS =
  new Set([
    "CONFIG_VALID",
    "EMERGENCY_STOP_CLEAR",
    "DECISION_DOCUMENT_VALID",
    "DECISION_VALIDATION_PASSED",
    "CONTEXT_VALID",
    "MARKET_DATA_FRESH",
    "TRADE_PLAN_PRESENT",
    "PRICE_VALUES_FINITE",
    "TRADE_GEOMETRY_VALID",
    "RISK_REWARD_VALID",
    "RISK_PERCENT_VALID",
    "OPEN_POSITION_LIMIT",
    "PAIR_POSITION_LIMIT",
    "CORRELATED_EXPOSURE_LIMIT",
    "DAILY_LOSS_LIMIT",
    "WEEKLY_LOSS_LIMIT",
    "CONSECUTIVE_LOSS_LIMIT",
    "LOSS_COOLDOWN_COMPLETE",
    "PAIR_DAILY_SIGNAL_LIMIT",
    "PAIR_SIGNAL_COOLDOWN",
    "DUPLICATE_SIGNAL_CLEAR",
    "BASELINE_PLAN_BOUNDARY_VALID",
    "EXECUTION_SNAPSHOT_COMPLETE"
  ]);

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

function toFiniteNumber(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const number =
    Number(value);

  return Number.isFinite(number)
    ? number
    : null;
}

function toInteger(value) {
  const number =
    toFiniteNumber(value);

  return number === null
    ? null
    : Math.trunc(number);
}

function clamp(
  value,
  minimum,
  maximum
) {
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
  const number =
    toFiniteNumber(value);

  if (number === null) {
    return null;
  }

  const factor =
    10 ** decimals;

  return Math.round(
    (
      number +
      Number.EPSILON
    ) * factor
  ) / factor;
}

function normalizeText(
  value,
  fallback = null
) {
  if (
    typeof value !== "string"
  ) {
    return fallback;
  }

  const text =
    value.trim();

  return text.length > 0
    ? text
    : fallback;
}

function normalizeUpper(
  value,
  fallback = null
) {
  const text =
    normalizeText(
      value,
      fallback
    );

  return text === null
    ? null
    : text.toUpperCase();
}

function normalizeLower(
  value,
  fallback = null
) {
  const text =
    normalizeText(
      value,
      fallback
    );

  return text === null
    ? null
    : text.toLowerCase();
}

function normalizeDecision(value) {
  const decision =
    normalizeUpper(
      value,
      "HOLD"
    );

  return ALLOWED_DECISIONS.has(
    decision
  )
    ? decision
    : "HOLD";
}

function normalizePair(value) {
  const normalized =
    normalizeUpper(
      value,
      null
    );

  if (normalized === null) {
    return null;
  }

  return normalized.replace(
    /[^A-Z0-9]/g,
    ""
  );
}

function normalizeTimeframe(value) {
  const text =
    normalizeText(
      value,
      null
    );

  if (text === null) {
    return null;
  }

  const compact =
    text.replace(
      /\s+/g,
      ""
    );

  const lower =
    compact.toLowerCase();

  const aliases = {
    m5: "5m",
    "5m": "5m",
    m15: "15m",
    "15m": "15m",
    m30: "30m",
    "30m": "30m",
    h1: "1H",
    "1h": "1H",
    h4: "4H",
    "4h": "4H",
    d1: "D1",
    "1d": "D1",
    w1: "W1",
    "1w": "W1"
  };

  return aliases[lower] ||
    compact;
}

function toISOStringOrNull(value) {
  if (
    value instanceof Date &&
    Number.isFinite(value.getTime())
  ) {
    return value.toISOString();
  }

  if (
    typeof value !== "string" &&
    typeof value !== "number"
  ) {
    return null;
  }

  const milliseconds =
    Date.parse(value);

  return Number.isFinite(milliseconds)
    ? new Date(milliseconds).toISOString()
    : null;
}

function uniqueStrings(values) {
  return [
    ...new Set(
      values
        .filter(
          (value) =>
            typeof value === "string"
        )
        .map(
          (value) =>
            value.trim()
        )
        .filter(Boolean)
    )
  ];
}

function stableSortValue(value) {
  if (Array.isArray(value)) {
    return value.map(
      stableSortValue
    );
  }

  if (isPlainObject(value)) {
    const sorted = {};

    for (
      const key of
      Object.keys(value).sort()
    ) {
      sorted[key] =
        stableSortValue(
          value[key]
        );
    }

    return sorted;
  }

  return value;
}

function stableStringify(value) {
  return JSON.stringify(
    stableSortValue(value)
  );
}

function createHash(value) {
  const buffer =
    Buffer.isBuffer(value)
      ? value
      : Buffer.from(
          typeof value === "string"
            ? value
            : stableStringify(value),
          "utf8"
        );

  return crypto
    .createHash(HASH_ALGORITHM)
    .update(buffer)
    .digest("hex");
}

function ensureDirectory(filePath) {
  fs.mkdirSync(
    path.dirname(filePath),
    {
      recursive: true
    }
  );
}

function readJSON(filePath) {
  const raw =
    fs.readFileSync(
      filePath,
      "utf8"
    );

  return {
    raw,
    value: JSON.parse(raw)
  };
}

function readJSONIfExists(
  filePath,
  fallback
) {
  if (!fs.existsSync(filePath)) {
    return deepClone(fallback);
  }

  return readJSON(filePath).value;
}

function fsyncDirectory(directoryPath) {
  let descriptor = null;

  try {
    descriptor =
      fs.openSync(
        directoryPath,
        "r"
      );

    fs.fsyncSync(descriptor);
  } catch {
    // Some filesystems do not support directory fsync.
  } finally {
    if (descriptor !== null) {
      fs.closeSync(descriptor);
    }
  }
}

function atomicWriteJSON(
  filePath,
  value
) {
  ensureDirectory(filePath);

  const temporaryPath =
    `${filePath}.${process.pid}.${Date.now()}.tmp`;

  const payload =
    JSON.stringify(
      value,
      null,
      2
    ) + "\n";

  let descriptor = null;

  try {
    descriptor =
      fs.openSync(
        temporaryPath,
        "wx",
        0o600
      );

    fs.writeFileSync(
      descriptor,
      payload,
      "utf8"
    );

    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;

    fs.renameSync(
      temporaryPath,
      filePath
    );

    fsyncDirectory(
      path.dirname(filePath)
    );
  } catch (error) {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Ignore cleanup errors.
      }
    }

    try {
      fs.rmSync(
        temporaryPath,
        { force: true }
      );
    } catch {
      // Ignore cleanup errors.
    }

    throw error;
  }
}

function dateKey(
  isoTimestamp
) {
  const iso =
    toISOStringOrNull(
      isoTimestamp
    );

  return iso === null
    ? null
    : iso.slice(0, 10);
}

function startOfIsoWeek(
  isoTimestamp
) {
  const iso =
    toISOStringOrNull(
      isoTimestamp
    );

  if (iso === null) {
    return null;
  }

  const date =
    new Date(iso);

  const day =
    date.getUTCDay() || 7;

  date.setUTCDate(
    date.getUTCDate() -
    day +
    1
  );

  date.setUTCHours(
    0,
    0,
    0,
    0
  );

  return date
    .toISOString()
    .slice(0, 10);
}

function minutesBetween(
  later,
  earlier
) {
  const laterIso =
    toISOStringOrNull(later);

  const earlierIso =
    toISOStringOrNull(earlier);

  if (
    laterIso === null ||
    earlierIso === null
  ) {
    return null;
  }

  return (
    Date.parse(laterIso) -
    Date.parse(earlierIso)
  ) / 60000;
}

function secondsBetween(
  later,
  earlier
) {
  const minutes =
    minutesBetween(
      later,
      earlier
    );

  return minutes === null
    ? null
    : minutes * 60;
}

// -----------------------------------------------------------------------------
// Configuration validation
// -----------------------------------------------------------------------------

function validateAutonomousConfig(config) {
  const errors = [];
  const warnings = [];

  if (!isPlainObject(config)) {
    return {
      valid: false,
      errors: [
        "Autonomous configuration must be an object."
      ],
      warnings
    };
  }

  if (
    config.schemaVersion !== 1
  ) {
    errors.push(
      "Unsupported autonomous configuration schemaVersion."
    );
  }

  if (
    config.configName !==
    SUPPORTED_CONFIG_NAME
  ) {
    errors.push(
      "Unsupported autonomous configuration name."
    );
  }

  if (
    config.configVersion !==
    SUPPORTED_CONFIG_VERSION
  ) {
    errors.push(
      `Unsupported autonomous configuration version: ${config.configVersion || "missing"}.`
    );
  }

  const mode =
    normalizeUpper(
      config.deployment?.mode,
      null
    );

  if (!ALLOWED_MODES.has(mode)) {
    errors.push(
      "Deployment mode is invalid."
    );
  }

  const gate =
    config.riskSafetyGate;

  if (!isPlainObject(gate)) {
    errors.push(
      "riskSafetyGate configuration is missing."
    );
  } else {
    if (gate.immutable !== true) {
      errors.push(
        "Safety Gate must be immutable."
      );
    }

    if (
      gate.policyMayOverride !==
      false
    ) {
      errors.push(
        "AI policy must not override the Safety Gate."
      );
    }

    if (
      gate.preTradeValidationRequired !==
      true
    ) {
      errors.push(
        "Pre-trade validation must be required."
      );
    }

    const positiveLimits = [
      [
        "riskPerTradePercent.maximum",
        gate.riskPerTradePercent?.maximum
      ],
      [
        "maximumOpenPositions",
        gate.maximumOpenPositions
      ],
      [
        "maximumOpenPositionsPerPair",
        gate.maximumOpenPositionsPerPair
      ],
      [
        "maximumDailyLossPercent",
        gate.maximumDailyLossPercent
      ],
      [
        "maximumWeeklyLossPercent",
        gate.maximumWeeklyLossPercent
      ],
      [
        "maximumConsecutiveLosses",
        gate.maximumConsecutiveLosses
      ],
      [
        "minimumRiskReward",
        gate.minimumRiskReward
      ]
    ];

    for (
      const [name, value] of
      positiveLimits
    ) {
      const number =
        toFiniteNumber(value);

      if (
        number === null ||
        number <= 0
      ) {
        errors.push(
          `${name} must be a positive finite number.`
        );
      }
    }

    const defaultRisk =
      toFiniteNumber(
        gate.riskPerTradePercent
          ?.default
      );

    const maximumRisk =
      toFiniteNumber(
        gate.riskPerTradePercent
          ?.maximum
      );

    if (
      defaultRisk === null ||
      maximumRisk === null ||
      defaultRisk <= 0 ||
      defaultRisk > maximumRisk
    ) {
      errors.push(
        "Default risk per trade must be positive and no greater than its maximum."
      );
    }

    if (
      !isPlainObject(
        gate.maximumMarketDataAgeSeconds
      )
    ) {
      errors.push(
        "maximumMarketDataAgeSeconds is missing."
      );
    }

    if (
      gate.killSwitchOnRepeatedWriteFailure ===
        true
    ) {
      const maximumWriteFailures =
        toInteger(
          gate.maximumConsecutiveStateWriteFailures
        );

      if (
        maximumWriteFailures === null ||
        maximumWriteFailures < 1
      ) {
        errors.push(
          "maximumConsecutiveStateWriteFailures must be a positive integer when the repeated-write-failure kill switch is enabled."
        );
      }
    }
  }

  if (
    config.experiencedTraderBehaviour
      ?.neverMartingale !== true ||
    config.experiencedTraderBehaviour
      ?.neverIncreaseRiskToRecoverLosses !== true
  ) {
    errors.push(
      "Martingale and loss-recovery risk escalation must remain disabled."
    );
  }

  if (
    config.deployment
      ?.allowRuntimeSelfPromotion !==
    false
  ) {
    errors.push(
      "Runtime self-promotion must remain disabled."
    );
  }

  if (
    config.deployment
      ?.allowPolicyToChangeDeploymentMode !==
    false
  ) {
    errors.push(
      "AI policy must not change deployment mode."
    );
  }

  return {
    valid:
      errors.length === 0,
    errors:
      uniqueStrings(errors),
    warnings:
      uniqueStrings(warnings)
  };
}

// -----------------------------------------------------------------------------
// Normalization
// -----------------------------------------------------------------------------

function normalizeTargets(source) {
  const targets = [];

  if (Array.isArray(source?.targets)) {
    for (
      const value of
      source.targets
    ) {
      const number =
        toFiniteNumber(value);

      if (number !== null) {
        targets.push(number);
      }
    }
  }

  const aliases = [
    source?.target1,
    source?.target2,
    source?.target3,
    source?.tp1,
    source?.tp2,
    source?.tp3,
    source?.target,
    source?.takeProfit,
    source?.tp
  ];

  for (const value of aliases) {
    const number =
      toFiniteNumber(value);

    if (
      number !== null &&
      !targets.includes(number)
    ) {
      targets.push(number);
    }
  }

  return targets;
}

function normalizeTradePlan(
  source,
  direction
) {
  if (!isPlainObject(source)) {
    return null;
  }

  const normalizedDirection =
    normalizeDecision(
      source.direction ||
      direction
    );

  if (
    normalizedDirection ===
    "HOLD"
  ) {
    return null;
  }

  const entry =
    toFiniteNumber(
      source.entry ??
      source.entryPrice ??
      source.price
    );

  const stop =
    toFiniteNumber(
      source.stop ??
      source.stopLoss ??
      source.sl
    );

  const targets =
    normalizeTargets(source);

  const risk =
    entry !== null &&
    stop !== null
      ? Math.abs(
          entry - stop
        )
      : null;

  const reward =
    entry !== null &&
    targets.length > 0
      ? Math.abs(
          targets[0] - entry
        )
      : null;

  const computedRiskReward =
    risk !== null &&
    risk > 0 &&
    reward !== null
      ? reward / risk
      : null;

  return {
    direction:
      normalizedDirection,
    entry,
    stop,
    stopLoss:
      stop,
    targets,
    target1:
      targets[0] ?? null,
    target2:
      targets[1] ?? null,
    target3:
      targets[2] ?? null,
    risk:
      risk === null
        ? null
        : round(risk, 10),
    riskReward:
      computedRiskReward === null
        ? toFiniteNumber(
            source.riskReward
          )
        : round(
            computedRiskReward,
            8
          ),
    requestedRiskPercent:
      toFiniteNumber(
        source.requestedRiskPercent ??
        source.riskPercent
      ),
    source:
      normalizeText(
        source.source,
        null
      )
  };
}

function extractDecisionDocument(input) {
  if (!isPlainObject(input)) {
    return null;
  }

  return (
    input.decisionResult ||
    input.aiDecision ||
    input.decisionDocument ||
    input
  );
}

function extractProposedDecision(document) {
  if (!isPlainObject(document)) {
    return {
      decision: "HOLD",
      confidence: 0,
      tradePlan: null,
      reasons: []
    };
  }

  const source =
    isPlainObject(
      document.proposedDecision
    )
      ? document.proposedDecision
      : (
          isPlainObject(
            document.finalDecision
          )
            ? document.finalDecision
            : document
        );

  const decision =
    normalizeDecision(
      source.decision ||
      source.signal ||
      source.direction
    );

  const confidence =
    clamp(
      toFiniteNumber(
        source.confidence
      ) || 0,
      0,
      100
    );

  return {
    decision,
    confidence:
      round(confidence, 4),
    tradePlan:
      normalizeTradePlan(
        source.tradePlan ||
        source.plan,
        decision
      ),
    reasons:
      Array.isArray(source.reasons)
        ? uniqueStrings(
            source.reasons
          )
        : []
  };
}

function normalizeOpenPositions(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(isPlainObject)
    .map(
      (position, index) => ({
        id:
          normalizeText(
            position.id ||
            position.tradeId ||
            position.signalId,
            `position-${index}`
          ),
        pair:
          normalizePair(
            position.pair ||
            position.symbol
          ),
        direction:
          normalizeDecision(
            position.direction ||
            position.signal
          ),
        openedAt:
          toISOStringOrNull(
            position.openedAt ||
            position.createdAt ||
            position.timestamp
          ),
        correlatedGroup:
          normalizeText(
            position.correlatedGroup ||
            position.exposureGroup,
            null
          )
      })
    );
}

function normalizeRecentSignals(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(isPlainObject)
    .map(
      (signal) => ({
        fingerprint:
          normalizeText(
            signal.fingerprint,
            null
          ),
        pair:
          normalizePair(
            signal.pair ||
            signal.symbol
          ),
        direction:
          normalizeDecision(
            signal.direction ||
            signal.decision ||
            signal.signal
          ),
        approvedAt:
          toISOStringOrNull(
            signal.approvedAt ||
            signal.createdAt ||
            signal.timestamp
          )
      })
    );
}

function normalizeSafetyInput(
  input,
  evaluatedAt = new Date().toISOString()
) {
  const document =
    extractDecisionDocument(input);

  const proposed =
    extractProposedDecision(document);

  const context =
    isPlainObject(document?.context)
      ? document.context
      : {};

  const baseline =
    isPlainObject(document?.baseline)
      ? document.baseline
      : {};

  const market =
    isPlainObject(input?.market)
      ? input.market
      : {};

  const account =
    isPlainObject(input?.account)
      ? input.account
      : {};

  const portfolio =
    isPlainObject(input?.portfolio)
      ? input.portfolio
      : {};

  const history =
    isPlainObject(input?.history)
      ? input.history
      : {};

  const executionContext =
    normalizeUpper(
      input?.executionContext,
      "SIGNAL_ONLY"
    );

  const pair =
    normalizePair(
      context.pair ||
      input?.pair ||
      input?.symbol
    );

  const marketDataAt =
    toISOStringOrNull(
      context.marketDataAt ||
      market.marketDataAt ||
      market.timestamp ||
      input?.marketDataAt
    );

  const decisionId =
    normalizeText(
      document?.decisionId ||
      input?.decisionId,
      createHash({
        pair,
        timeframe:
          context.timeframe ||
          input?.timeframe,
        proposed,
        marketDataAt
      }).slice(0, 24)
    );

  const openPositions =
    normalizeOpenPositions(
      portfolio.openPositions ||
      input?.openPositions
    );

  const recentSignals = [
    ...normalizeRecentSignals(
      history.recentSignals ||
      input?.recentSignals
    )
  ];

  return {
    evaluatedAt:
      toISOStringOrNull(
        evaluatedAt
      ) ||
      new Date().toISOString(),
    decisionDocument:
      document,
    decisionId,
    decisionHash:
      normalizeText(
        document?.decisionHash,
        null
      ),
    proposed,
    baseline: {
      decision:
        normalizeDecision(
          baseline.decision ||
          baseline.signal ||
          baseline.direction
        ),
      confidence:
        clamp(
          toFiniteNumber(
            baseline.confidence
          ) || 0,
          0,
          100
        ),
      tradePlan:
        normalizeTradePlan(
          baseline.tradePlan ||
          baseline.plan,
          baseline.decision ||
          baseline.signal ||
          baseline.direction
        )
    },
    context: {
      pair,
      timeframe:
        normalizeTimeframe(
          context.timeframe ||
          input?.timeframe
        ),
      engine:
        normalizeLower(
          context.engine ||
          input?.engine,
          null
        ),
      marketRegime:
        normalizeUpper(
          context.marketRegime ||
          input?.marketRegime,
          null
        ),
      session:
        normalizeUpper(
          context.session ||
          input?.session,
          null
        ),
      pattern:
        normalizeText(
          context.pattern ||
          input?.pattern,
          null
        ),
      marketDataAt
    },
    deployment: {
      configuredMode:
        normalizeUpper(
          document?.deployment
            ?.configuredMode,
          null
        ),
      authorityMode:
        normalizeUpper(
          document?.deployment
            ?.authorityMode,
          null
        ),
      emergencyStop:
        document?.deployment
          ?.emergencyStop === true
    },
    decisionValidation: {
      present:
        isPlainObject(
          document?.validation
        ),
      valid:
        document?.validation
          ?.valid === true,
      errors:
        Array.isArray(
          document?.validation?.errors
        )
          ? uniqueStrings(
              document.validation.errors
            )
          : [],
      warnings:
        Array.isArray(
          document?.validation?.warnings
        )
          ? uniqueStrings(
              document.validation.warnings
            )
          : []
    },
    decisionSafetyDeclaration: {
      present:
        isPlainObject(
          document?.safety
        ),
      finalApprovalRequired:
        document?.safety
          ?.finalApprovalRequired === true,
      orderPlacementPermitted:
        document?.safety
          ?.orderPlacementPermitted === true,
      riskLimitModificationPermitted:
        document?.safety
          ?.riskLimitModificationPermitted === true,
      sourceCodeModificationPermitted:
        document?.safety
          ?.sourceCodeModificationPermitted === true,
      externalNetworkCalls:
        document?.safety
          ?.externalNetworkCalls === true
    },
    executionContext:
      ALLOWED_EXECUTION_CONTEXTS.has(
        executionContext
      )
        ? executionContext
        : "SIGNAL_ONLY",
    executionRequested:
      input?.executionRequested === true,
    account: {
      authenticated:
        account.authenticated === true,
      accountId:
        normalizeText(
          account.accountId ||
          account.id,
          null
        ),
      balance:
        toFiniteNumber(
          account.balance
        ),
      equity:
        toFiniteNumber(
          account.equity
        ),
      requestedRiskPercent:
        toFiniteNumber(
          account.requestedRiskPercent ??
          proposed.tradePlan
            ?.requestedRiskPercent
        ),
      requestedRiskPercentPresent:
        account.requestedRiskPercent !== undefined ||
        proposed.tradePlan
          ?.requestedRiskPercent !== null,
      dailyLossPercent:
        toFiniteNumber(
          account.dailyLossPercent
        ),
      dailyLossPercentPresent:
        account.dailyLossPercent !== undefined &&
        toFiniteNumber(
          account.dailyLossPercent
        ) !== null,
      weeklyLossPercent:
        toFiniteNumber(
          account.weeklyLossPercent
        ),
      weeklyLossPercentPresent:
        account.weeklyLossPercent !== undefined &&
        toFiniteNumber(
          account.weeklyLossPercent
        ) !== null,
      consecutiveLosses:
        Math.max(
          0,
          toInteger(
            account.consecutiveLosses
          ) || 0
        ),
      consecutiveLossesPresent:
        account.consecutiveLosses !== undefined &&
        toInteger(
          account.consecutiveLosses
        ) !== null,
      lastLossAt:
        toISOStringOrNull(
          account.lastLossAt
        )
    },
    portfolio: {
      openPositions,
      openPositionCount:
        toInteger(
          portfolio.openPositionCount
        ) ??
        openPositions.length,
      openPositionCountPresent:
        portfolio.openPositionCount !== undefined ||
        Array.isArray(
          portfolio.openPositions ||
          input?.openPositions
        ),
      pairOpenPositionCount:
        toInteger(
          portfolio.pairOpenPositionCount
        ),
      pairOpenPositionCountPresent:
        portfolio.pairOpenPositionCount !== undefined ||
        Array.isArray(
          portfolio.openPositions ||
          input?.openPositions
        ),
      correlatedExposureCount:
        Math.max(
          0,
          toInteger(
            portfolio.correlatedExposureCount
          ) || 0
        ),
      correlatedExposureCountPresent:
        portfolio.correlatedExposureCount !== undefined &&
        toInteger(
          portfolio.correlatedExposureCount
        ) !== null,
      correlatedGroup:
        normalizeText(
          portfolio.correlatedGroup,
          null
        )
    },
    market: {
      currentPrice:
        toFiniteNumber(
          market.currentPrice ??
          market.price
        ),
      bid:
        toFiniteNumber(
          market.bid
        ),
      ask:
        toFiniteNumber(
          market.ask
        ),
      atr:
        toFiniteNumber(
          market.atr
        ),
      marketDataAt
    },
    history: {
      recentSignals,
      signalsForPairToday:
        toInteger(
          history.signalsForPairToday
        ),
      lastApprovedSignalAt:
        toISOStringOrNull(
          history.lastApprovedSignalAt
        ),
      dailyLossPercent:
        toFiniteNumber(
          history.dailyLossPercent
        ),
      weeklyLossPercent:
        toFiniteNumber(
          history.weeklyLossPercent
        ),
      consecutiveLosses:
        toInteger(
          history.consecutiveLosses
        ),
      lastLossAt:
        toISOStringOrNull(
          history.lastLossAt
        )
    }
  };
}

// -----------------------------------------------------------------------------
// State and transaction management
// -----------------------------------------------------------------------------

function createEmptyState(
  updatedAt = new Date().toISOString()
) {
  return {
    version:
      STATE_SCHEMA_VERSION,
    engineName:
      ENGINE_NAME,
    engineVersion:
      ENGINE_VERSION,
    updatedAt,
    lastRunAt: null,
    lastResultHash: null,
    lastDecisionId: null,
    approvedSignals: 0,
    rejectedSignals: 0,
    holdSignals: 0,
    emergencyStops: 0,
    consecutiveWriteFailures: 0,
    lastWriteFailureAt: null,
    recentFingerprints: [],
    recentApprovals: [],
    dailyPairCounts: {},
    lastApprovedSignalAtByPair: {},
    snapshots: [],
    pendingTransaction: null
  };
}

function normalizeState(
  source,
  updatedAt = new Date().toISOString()
) {
  const empty =
    createEmptyState(updatedAt);

  if (!isPlainObject(source)) {
    return empty;
  }

  return {
    ...empty,
    ...source,
    version:
      STATE_SCHEMA_VERSION,
    engineName:
      ENGINE_NAME,
    engineVersion:
      ENGINE_VERSION,
    recentFingerprints:
      Array.isArray(
        source.recentFingerprints
      )
        ? source.recentFingerprints
            .filter(isPlainObject)
            .slice(
              -MAX_RECENT_FINGERPRINTS
            )
        : [],
    recentApprovals:
      Array.isArray(
        source.recentApprovals
      )
        ? source.recentApprovals
            .filter(isPlainObject)
            .slice(
              -MAX_RECENT_APPROVALS
            )
        : [],
    dailyPairCounts:
      isPlainObject(
        source.dailyPairCounts
      )
        ? source.dailyPairCounts
        : {},
    lastApprovedSignalAtByPair:
      isPlainObject(
        source.lastApprovedSignalAtByPair
      )
        ? source.lastApprovedSignalAtByPair
        : {},
    snapshots:
      Array.isArray(source.snapshots)
        ? source.snapshots
            .filter(isPlainObject)
            .slice(
              -MAX_STATE_SNAPSHOTS
            )
        : [],
    pendingTransaction:
      isPlainObject(
        source.pendingTransaction
      )
        ? source.pendingTransaction
        : null
  };
}

function validateStateStructure(
  source,
  options = {}
) {
  const errors = [];
  const skipSnapshots =
    options.skipSnapshots === true;

  if (!isPlainObject(source)) {
    return {
      valid: false,
      errors: [
        "Safety Gate state must be an object."
      ]
    };
  }

  if (
    source.version !==
      STATE_SCHEMA_VERSION ||
    source.engineName !==
      ENGINE_NAME ||
    source.engineVersion !==
      ENGINE_VERSION
  ) {
    errors.push(
      "Safety Gate state identity/version is invalid."
    );
  }

  const timestampFields = [
    "updatedAt",
    "lastRunAt",
    "lastWriteFailureAt"
  ];

  for (const field of timestampFields) {
    if (
      source[field] !== null &&
      source[field] !== undefined &&
      !toISOStringOrNull(
        source[field]
      )
    ) {
      errors.push(
        `Safety Gate state ${field} is invalid.`
      );
    }
  }

  const counterFields = [
    "approvedSignals",
    "rejectedSignals",
    "holdSignals",
    "emergencyStops",
    "consecutiveWriteFailures"
  ];

  for (const field of counterFields) {
    const value =
      source[field];

    if (
      !Number.isInteger(value) ||
      value < 0
    ) {
      errors.push(
        `Safety Gate state ${field} must be a non-negative integer.`
      );
    }
  }

  if (!Array.isArray(
    source.recentFingerprints
  )) {
    errors.push(
      "Safety Gate state recentFingerprints must be an array."
    );
  } else if (
    source.recentFingerprints.some(
      (entry) =>
        !isPlainObject(entry) ||
        !normalizeText(
          entry.fingerprint,
          null
        ) ||
        !toISOStringOrNull(
          entry.approvedAt
        )
    )
  ) {
    errors.push(
      "Safety Gate state recentFingerprints contains a malformed entry."
    );
  }

  if (!Array.isArray(
    source.recentApprovals
  )) {
    errors.push(
      "Safety Gate state recentApprovals must be an array."
    );
  } else if (
    source.recentApprovals.some(
      (entry) =>
        !isPlainObject(entry) ||
        !normalizeText(
          entry.safetyResultHash,
          null
        ) ||
        !normalizeText(
          entry.fingerprint,
          null
        ) ||
        !toISOStringOrNull(
          entry.approvedAt
        )
    )
  ) {
    errors.push(
      "Safety Gate state recentApprovals contains a malformed entry."
    );
  }

  if (!isPlainObject(
    source.dailyPairCounts
  )) {
    errors.push(
      "Safety Gate state dailyPairCounts must be an object."
    );
  } else {
    for (
      const pairCounts of
      Object.values(
        source.dailyPairCounts
      )
    ) {
      if (!isPlainObject(pairCounts)) {
        errors.push(
          "Safety Gate state dailyPairCounts contains a malformed date bucket."
        );
        break;
      }

      if (
        Object.values(pairCounts).some(
          (value) =>
            !Number.isInteger(value) ||
            value < 0
        )
      ) {
        errors.push(
          "Safety Gate state dailyPairCounts contains an invalid counter."
        );
        break;
      }
    }
  }

  if (!isPlainObject(
    source.lastApprovedSignalAtByPair
  )) {
    errors.push(
      "Safety Gate state lastApprovedSignalAtByPair must be an object."
    );
  } else if (
    Object.values(
      source.lastApprovedSignalAtByPair
    ).some(
      (value) =>
        !toISOStringOrNull(value)
    )
  ) {
    errors.push(
      "Safety Gate state lastApprovedSignalAtByPair contains an invalid timestamp."
    );
  }

  if (
    source.pendingTransaction !== null &&
    source.pendingTransaction !== undefined &&
    !isPlainObject(
      source.pendingTransaction
    )
  ) {
    errors.push(
      "Safety Gate state pendingTransaction is malformed."
    );
  }

  if (!skipSnapshots) {
    if (!Array.isArray(source.snapshots)) {
      errors.push(
        "Safety Gate state snapshots must be an array."
      );
    } else {
      for (const snapshot of source.snapshots) {
        if (!isPlainObject(snapshot)) {
          errors.push(
            "Safety Gate state snapshots contains a malformed entry."
          );
          break;
        }

        const hasRestorableState =
          Object.prototype
            .hasOwnProperty.call(
              snapshot,
              "restorableState"
            ) ||
          Object.prototype
            .hasOwnProperty.call(
              snapshot,
              "restorableStateHash"
            );

        if (!hasRestorableState) {
          continue;
        }

        if (
          !isPlainObject(
            snapshot.restorableState
          ) ||
          !normalizeText(
            snapshot.restorableStateHash,
            null
          ) ||
          createHash(
            snapshot.restorableState
          ) !==
            snapshot.restorableStateHash
        ) {
          errors.push(
            "Safety Gate state contains a corrupt restorable snapshot."
          );
          break;
        }

        const snapshotValidation =
          validateStateStructure(
            snapshot.restorableState,
            {
              skipSnapshots: true
            }
          );

        if (!snapshotValidation.valid) {
          errors.push(
            "Safety Gate state contains an invalid restorable snapshot payload."
          );
          break;
        }
      }
    }
  }

  return {
    valid:
      errors.length === 0,
    errors:
      uniqueStrings(errors)
  };
}

function createRestorableStatePayload(
  state
) {
  const normalized =
    normalizeState(
      state,
      state?.updatedAt ||
      new Date().toISOString()
    );

  return {
    version:
      STATE_SCHEMA_VERSION,
    engineName:
      ENGINE_NAME,
    engineVersion:
      ENGINE_VERSION,
    updatedAt:
      normalized.updatedAt,
    lastRunAt:
      normalized.lastRunAt,
    lastResultHash:
      normalized.lastResultHash,
    lastDecisionId:
      normalized.lastDecisionId,
    approvedSignals:
      normalized.approvedSignals,
    rejectedSignals:
      normalized.rejectedSignals,
    holdSignals:
      normalized.holdSignals,
    emergencyStops:
      normalized.emergencyStops,
    consecutiveWriteFailures:
      normalized.consecutiveWriteFailures,
    lastWriteFailureAt:
      normalized.lastWriteFailureAt,
    recentFingerprints:
      deepClone(
        normalized.recentFingerprints
      ),
    recentApprovals:
      deepClone(
        normalized.recentApprovals
      ),
    dailyPairCounts:
      deepClone(
        normalized.dailyPairCounts
      ),
    lastApprovedSignalAtByPair:
      deepClone(
        normalized
          .lastApprovedSignalAtByPair
      ),
    snapshots: [],
    pendingTransaction: null
  };
}

function recoverStateFromLastKnownGoodSnapshot(
  source,
  updatedAt = new Date().toISOString()
) {
  if (
    !isPlainObject(source) ||
    !Array.isArray(source.snapshots)
  ) {
    return null;
  }

  for (
    let index =
      source.snapshots.length - 1;
    index >= 0;
    index -= 1
  ) {
    const snapshot =
      source.snapshots[index];

    if (
      !isPlainObject(snapshot) ||
      !isPlainObject(
        snapshot.restorableState
      ) ||
      !normalizeText(
        snapshot.restorableStateHash,
        null
      ) ||
      createHash(
        snapshot.restorableState
      ) !==
        snapshot.restorableStateHash
    ) {
      continue;
    }

    const validation =
      validateStateStructure(
        snapshot.restorableState,
        {
          skipSnapshots: true
        }
      );

    if (!validation.valid) {
      continue;
    }

    const restored =
      normalizeState(
        snapshot.restorableState,
        updatedAt
      );

    restored.updatedAt =
      updatedAt;
    restored.snapshots =
      source.snapshots
        .filter(isPlainObject)
        .slice(
          -MAX_STATE_SNAPSHOTS
        );
    restored.pendingTransaction =
      null;

    return {
      state: restored,
      snapshotIndex: index,
      snapshotHash:
        snapshot.restorableStateHash
    };
  }

  return null;
}

function prepareSafetyState(
  source,
  updatedAt = new Date().toISOString()
) {
  if (
    source === null ||
    source === undefined
  ) {
    return {
      state:
        createEmptyState(updatedAt),
      integrity: {
        valid: true,
        corruptionDetected: false,
        recoveredFromSnapshot: false,
        errors: []
      }
    };
  }

  const validation =
    validateStateStructure(source);

  if (validation.valid) {
    return {
      state:
        normalizeState(
          source,
          updatedAt
        ),
      integrity: {
        valid: true,
        corruptionDetected: false,
        recoveredFromSnapshot: false,
        errors: []
      }
    };
  }

  const recovery =
    recoverStateFromLastKnownGoodSnapshot(
      source,
      updatedAt
    );

  if (recovery) {
    return {
      state:
        recovery.state,
      integrity: {
        valid: false,
        corruptionDetected: true,
        recoveredFromSnapshot: true,
        snapshotIndex:
          recovery.snapshotIndex,
        snapshotHash:
          recovery.snapshotHash,
        errors:
          validation.errors
      }
    };
  }

  return {
    state:
      createEmptyState(updatedAt),
    integrity: {
      valid: false,
      corruptionDetected: true,
      recoveredFromSnapshot: false,
      errors:
        validation.errors
    }
  };
}

function validatePendingTransactionDocument(
  pending
) {
  const errors = [];

  if (!isPlainObject(pending)) {
    return {
      valid: false,
      errors: [
        "Safety Gate pending transaction must be an object."
      ]
    };
  }

  if (pending.version !== 1) {
    errors.push(
      "Safety Gate pending transaction version is invalid."
    );
  }

  if (
    !isPlainObject(pending.nextState) ||
    !isPlainObject(pending.nextLog) ||
    !isPlainObject(pending.preview)
  ) {
    errors.push(
      "Safety Gate pending transaction payload is incomplete."
    );
  }

  if (errors.length === 0) {
    const nextStateHash =
      createHash(
        pending.nextState
      );

    const nextLogHash =
      createHash(
        pending.nextLog
      );

    const previewHash =
      createHash(
        pending.preview
      );

    const expectedTransactionId =
      createHash({
        resultHash:
          pending.resultHash,
        startedAt:
          pending.createdAt,
        nextStateHash,
        nextLogHash
      });

    if (
      pending.preview
        .safetyResultHash !==
        pending.resultHash
    ) {
      errors.push(
        "Safety Gate pending transaction result hash does not match its preview."
      );
    }

    if (
      pending.previewHash !==
        previewHash
    ) {
      errors.push(
        "Safety Gate pending transaction preview hash is invalid."
      );
    }

    if (
      pending.nextLogHash !==
        nextLogHash
    ) {
      errors.push(
        "Safety Gate pending transaction log hash is invalid."
      );
    }

    if (
      pending.nextStateHash !==
        undefined &&
      pending.nextStateHash !==
        nextStateHash
    ) {
      errors.push(
        "Safety Gate pending transaction state hash is invalid."
      );
    }

    if (
      pending.transactionId !==
        expectedTransactionId
    ) {
      errors.push(
        "Safety Gate pending transaction id is invalid."
      );
    }

    const stateValidation =
      validateStateStructure(
        pending.nextState
      );

    if (!stateValidation.valid) {
      errors.push(
        "Safety Gate pending transaction contains an invalid next state."
      );
    }

    if (
      pending.nextLog.version !==
        LOG_SCHEMA_VERSION ||
      pending.nextLog.engineName !==
        ENGINE_NAME ||
      pending.nextLog.engineVersion !==
        ENGINE_VERSION ||
      !Array.isArray(
        pending.nextLog.decisions
      )
    ) {
      errors.push(
        "Safety Gate pending transaction contains an invalid next log."
      );
    }
  }

  return {
    valid:
      errors.length === 0,
    errors:
      uniqueStrings(errors)
  };
}

function recordPendingWriteFailure(
  pendingPath,
  pending,
  failedAt = new Date().toISOString()
) {
  const updated =
    deepClone(pending);

  const previousFailures =
    Math.max(
      0,
      toInteger(
        updated.writeFailureCount
      ) ||
      toInteger(
        updated.nextState
          ?.consecutiveWriteFailures
      ) ||
      0
    );

  updated.writeFailureCount =
    previousFailures + 1;
  updated.lastWriteFailureAt =
    failedAt;

  if (isPlainObject(
    updated.nextState
  )) {
    updated.nextState
      .consecutiveWriteFailures =
      updated.writeFailureCount;
    updated.nextState
      .lastWriteFailureAt =
      failedAt;
  }

  updated.nextStateHash =
    createHash(
      updated.nextState
    );
  updated.nextLogHash =
    createHash(
      updated.nextLog
    );
  updated.previewHash =
    createHash(
      updated.preview
    );
  updated.transactionId =
    createHash({
      resultHash:
        updated.resultHash,
      startedAt:
        updated.createdAt,
      nextStateHash:
        updated.nextStateHash,
      nextLogHash:
        updated.nextLogHash
    });

  atomicWriteJSON(
    pendingPath,
    updated
  );

  return updated;
}

function recoverPendingTransaction(
  options = {}
) {
  const pendingPath =
    options.pendingPath ||
    SAFETY_PENDING_PATH;

  const statePath =
    options.statePath ||
    SAFETY_STATE_PATH;

  const logPath =
    options.logPath ||
    SAFETY_LOG_PATH;

  const previewPath =
    options.previewPath ||
    SAFETY_PREVIEW_PATH;

  if (!fs.existsSync(pendingPath)) {
    return {
      recovered: false,
      reason: "NO_PENDING_TRANSACTION"
    };
  }

  let pending =
    readJSON(pendingPath).value;

  const validation =
    validatePendingTransactionDocument(
      pending
    );

  if (!validation.valid) {
    throw new Error(
      `Safety Gate pending transaction is corrupt: ${validation.errors.join(" ")}`
    );
  }

  try {
    atomicWriteJSON(
      previewPath,
      pending.preview
    );

    atomicWriteJSON(
      logPath,
      pending.nextLog
    );

    atomicWriteJSON(
      statePath,
      pending.nextState
    );

    fs.rmSync(
      pendingPath,
      { force: true }
    );
  } catch (error) {
    try {
      pending =
        recordPendingWriteFailure(
          pendingPath,
          pending,
          new Date().toISOString()
        );
    } catch {
      // Preserve the original recovery failure.
    }

    throw new Error(
      `Safety Gate pending transaction recovery failed: ${error.message}`
    );
  }

  return {
    recovered: true,
    transactionId:
      pending.transactionId || null,
    writeFailureCount:
      toInteger(
        pending.writeFailureCount
      ) || 0
  };
}

// -----------------------------------------------------------------------------
// Check helpers
// -----------------------------------------------------------------------------

function createCheck({
  id,
  passed,
  blocking = true,
  skipped = false,
  message,
  details = null
}) {
  let status;

  if (skipped) {
    status = "SKIP";
  } else if (passed) {
    status = "PASS";
  } else {
    status = blocking
      ? "FAIL"
      : "WARN";
  }

  return {
    id,
    status,
    blocking:
      blocking === true,
    message,
    details
  };
}

function addCheck(
  checks,
  check
) {
  checks.push(
    createCheck(check)
  );
}

function hasBlockingFailure(checks) {
  return checks.some(
    (check) =>
      check.status === "FAIL" &&
      check.blocking === true
  );
}

function deriveMarketClass(
  engine,
  timeframe
) {
  const normalizedEngine =
    normalizeLower(
      engine,
      ""
    );

  const normalizedTimeframe =
    normalizeTimeframe(
      timeframe
    );

  if (
    normalizedEngine === "scalp" ||
    [
      "5m",
      "15m",
      "30m"
    ].includes(
      normalizedTimeframe
    )
  ) {
    return "scalp";
  }

  if (
    normalizedEngine === "daily" ||
    [
      "1H",
      "4H"
    ].includes(
      normalizedTimeframe
    )
  ) {
    return "intraday";
  }

  return "swing";
}

function validateTradeGeometry(
  decision,
  plan,
  config
) {
  const errors = [];
  const gate =
    config.riskSafetyGate;

  if (
    decision === "HOLD"
  ) {
    return {
      valid: true,
      errors,
      riskReward: null
    };
  }

  if (!isPlainObject(plan)) {
    return {
      valid: false,
      errors: [
        "BUY/SELL decision requires a trade plan."
      ],
      riskReward: null
    };
  }

  if (
    normalizeDecision(
      plan.direction
    ) !== decision
  ) {
    errors.push(
      "Trade plan direction does not match the proposed decision."
    );
  }

  const values = [
    plan.entry,
    plan.stop,
    ...plan.targets
  ];

  if (
    gate.rejectNonFinitePrices === true &&
    values.some(
      (value) =>
        !Number.isFinite(value)
    )
  ) {
    errors.push(
      "Trade plan contains a non-finite price."
    );
  }

  if (
    plan.targets.length === 0
  ) {
    errors.push(
      "Trade plan requires at least one target."
    );
  }

  if (
    !Number.isFinite(plan.risk) ||
    plan.risk <= 0
  ) {
    errors.push(
      "Trade plan risk must be positive."
    );
  }

  if (decision === "BUY") {
    if (
      gate.rejectInvalidBuyGeometry === true &&
      !(
        plan.stop < plan.entry &&
        plan.targets.every(
          (target) =>
            target > plan.entry
        )
      )
    ) {
      errors.push(
        "BUY geometry requires stop below entry and every target above entry."
      );
    }

    if (
      gate.rejectNonIncreasingBuyTargets === true &&
      plan.targets.some(
        (target, index) =>
          index > 0 &&
          target <= plan.targets[index - 1]
      )
    ) {
      errors.push(
        "BUY targets must be strictly increasing."
      );
    }
  }

  if (decision === "SELL") {
    if (
      gate.rejectInvalidSellGeometry === true &&
      !(
        plan.stop > plan.entry &&
        plan.targets.every(
          (target) =>
            target < plan.entry
        )
      )
    ) {
      errors.push(
        "SELL geometry requires stop above entry and every target below entry."
      );
    }

    if (
      gate.rejectNonDecreasingSellTargets === true &&
      plan.targets.some(
        (target, index) =>
          index > 0 &&
          target >= plan.targets[index - 1]
      )
    ) {
      errors.push(
        "SELL targets must be strictly decreasing."
      );
    }
  }

  const riskReward =
    toFiniteNumber(
      plan.riskReward
    );

  if (
    gate.requireMinimumRiskReward === true &&
    (
      riskReward === null ||
      riskReward <
        toFiniteNumber(
          gate.minimumRiskReward
        )
    )
  ) {
    errors.push(
      `Trade plan risk/reward must be at least ${gate.minimumRiskReward}.`
    );
  }

  const maximumRiskReward =
    toFiniteNumber(
      config.authority
        ?.tradePlanOptimization
        ?.maximumRiskReward
    );

  if (
    maximumRiskReward !== null &&
    riskReward !== null &&
    riskReward > maximumRiskReward
  ) {
    errors.push(
      `Trade plan risk/reward exceeds the configured maximum of ${maximumRiskReward}.`
    );
  }

  return {
    valid:
      errors.length === 0,
    errors:
      uniqueStrings(errors),
    riskReward
  };
}

function validateBaselineBoundaries(
  normalized,
  config
) {
  const decision =
    normalized.proposed.decision;

  const proposed =
    normalized.proposed.tradePlan;

  const baseline =
    normalized.baseline.tradePlan;

  if (
    decision === "HOLD" ||
    proposed === null ||
    baseline === null ||
    normalized.baseline.decision !==
      decision
  ) {
    return {
      valid: true,
      skipped: true,
      errors: []
    };
  }

  const rules =
    config.authority
      ?.tradePlanOptimization || {};

  const errors = [];

  const proposedRisk =
    toFiniteNumber(
      proposed.risk
    );

  const baselineRisk =
    toFiniteNumber(
      baseline.risk
    );

  if (
    proposedRisk !== null &&
    baselineRisk !== null &&
    proposedRisk >
      baselineRisk +
      Number.EPSILON &&
    rules.allowStopWidening !== true
  ) {
    errors.push(
      "Proposed plan widens the deterministic stop while stop widening is disabled."
    );
  }

  if (
    proposedRisk !== null &&
    baselineRisk !== null &&
    proposedRisk <
      baselineRisk -
      Number.EPSILON
  ) {
    if (
      rules.allowStopTightening !==
      true
    ) {
      errors.push(
        "Proposed plan tightens the stop while stop tightening is disabled."
      );
    } else {
      const tighteningPercent =
        (
          1 -
          proposedRisk /
          baselineRisk
        ) * 100;

      const maximumTightening =
        toFiniteNumber(
          rules.maximumStopTighteningPercent
        ) || 0;

      if (
        tighteningPercent >
        maximumTightening +
        Number.EPSILON
      ) {
        errors.push(
          "Proposed stop tightening exceeds the configured percentage limit."
        );
      }
    }
  }

  const entryDisplacement =
    Math.abs(
      proposed.entry -
      baseline.entry
    );

  if (
    entryDisplacement >
    Number.EPSILON
  ) {
    if (
      rules.allowEntryRefinement !==
      true
    ) {
      errors.push(
        "Proposed entry differs from baseline while entry refinement is disabled."
      );
    } else {
      const atr =
        normalized.market.atr;

      const maximumAtr =
        toFiniteNumber(
          rules.maximumEntryDisplacementAtr
        ) || 0;

      if (
        atr === null ||
        atr <= 0
      ) {
        errors.push(
          "ATR is required to validate a refined entry."
        );
      } else if (
        entryDisplacement >
        atr * maximumAtr +
        Number.EPSILON
      ) {
        errors.push(
          "Proposed entry displacement exceeds the ATR boundary."
        );
      }
    }
  }

  return {
    valid:
      errors.length === 0,
    skipped: false,
    errors:
      uniqueStrings(errors)
  };
}

function createSignalFingerprint(
  normalized
) {
  const plan =
    normalized.proposed.tradePlan;

  return createHash({
    pair:
      normalized.context.pair,
    timeframe:
      normalized.context.timeframe,
    engine:
      normalized.context.engine,
    direction:
      normalized.proposed.decision,
    entry:
      round(plan?.entry, 8),
    stop:
      round(plan?.stop, 8),
    targets:
      Array.isArray(plan?.targets)
        ? plan.targets.map(
            (value) =>
              round(value, 8)
          )
        : [],
    marketDataAt:
      normalized.context.marketDataAt
  });
}

function mergeRiskSnapshotFromState(
  normalized,
  state
) {
  const pair =
    normalized.context.pair;

  const evaluatedDate =
    dateKey(
      normalized.evaluatedAt
    );

  const stateDailyCount =
    toInteger(
      state.dailyPairCounts
        ?.[evaluatedDate]
        ?.[pair]
    ) || 0;

  const inputDailyCount =
    normalized.history
      .signalsForPairToday;

  const lastFromState =
    toISOStringOrNull(
      state.lastApprovedSignalAtByPair
        ?.[pair]
    );

  return {
    dailyLossPercent:
      normalized.account
        .dailyLossPercent ??
      normalized.history
        .dailyLossPercent,
    weeklyLossPercent:
      normalized.account
        .weeklyLossPercent ??
      normalized.history
        .weeklyLossPercent,
    consecutiveLosses:
      normalized.account
        .consecutiveLosses ||
      Math.max(
        0,
        normalized.history
          .consecutiveLosses ||
        0
      ),
    lastLossAt:
      normalized.account
        .lastLossAt ||
      normalized.history
        .lastLossAt,
    signalsForPairToday:
      Math.max(
        stateDailyCount,
        inputDailyCount ?? 0
      ),
    lastApprovedSignalAt:
      [
        lastFromState,
        normalized.history
          .lastApprovedSignalAt
      ]
        .filter(Boolean)
        .sort()
        .at(-1) || null
  };
}

function tradePlansSemanticallyEqual(
  left,
  right
) {
  if (left === null && right === null) {
    return true;
  }

  if (
    !isPlainObject(left) ||
    !isPlainObject(right)
  ) {
    return false;
  }

  return createHash({
    direction:
      left.direction,
    entry:
      round(left.entry, 10),
    stop:
      round(left.stop, 10),
    targets:
      Array.isArray(left.targets)
        ? left.targets.map(
            (value) =>
              round(value, 10)
          )
        : []
  }) === createHash({
    direction:
      right.direction,
    entry:
      round(right.entry, 10),
    stop:
      round(right.stop, 10),
    targets:
      Array.isArray(right.targets)
        ? right.targets.map(
            (value) =>
              round(value, 10)
          )
        : []
  });
}

// -----------------------------------------------------------------------------
// Main evaluation
// -----------------------------------------------------------------------------

function evaluateSafetyGateWithSources({
  input,
  config,
  configHash = null,
  state = null,
  stateIntegrity = null,
  evaluatedAt = new Date().toISOString()
}) {
  const normalized =
    normalizeSafetyInput(
      input,
      evaluatedAt
    );

  const preparedState =
    isPlainObject(stateIntegrity)
      ? {
          state:
            normalizeState(
              state,
              normalized.evaluatedAt
            ),
          integrity:
            stateIntegrity
        }
      : prepareSafetyState(
          state,
          normalized.evaluatedAt
        );

  const currentState =
    preparedState.state;

  const currentStateIntegrity =
    preparedState.integrity;

  const checks = [];
  const configValidation =
    validateAutonomousConfig(config);

  addCheck(
    checks,
    {
      id: "CONFIG_VALID",
      passed:
        configValidation.valid,
      message:
        configValidation.valid
          ? "Autonomous configuration and immutable Safety Gate controls are valid."
          : "Autonomous configuration failed Safety Gate validation.",
      details: {
        errors:
          configValidation.errors,
        warnings:
          configValidation.warnings,
        configHash
      }
    }
  );

  const configuredMode =
    normalizeUpper(
      config?.deployment?.mode,
      "OFF"
    );

  const stateCorruptionKillSwitch =
    config?.riskSafetyGate
      ?.killSwitchOnStateCorruption ===
      true &&
    currentStateIntegrity
      .corruptionDetected === true;

  const maximumWriteFailures =
    Math.max(
      1,
      toInteger(
        config?.riskSafetyGate
          ?.maximumConsecutiveStateWriteFailures
      ) || 1
    );

  const repeatedWriteFailureKillSwitch =
    config?.riskSafetyGate
      ?.killSwitchOnRepeatedWriteFailure ===
      true &&
    currentState
      .consecutiveWriteFailures >=
      maximumWriteFailures;

  const emergencyStop =
    configuredMode ===
      "EMERGENCY_STOP" ||
    config?.deployment
      ?.emergencyStop === true ||
    normalized.deployment
      .emergencyStop === true ||
    stateCorruptionKillSwitch ||
    repeatedWriteFailureKillSwitch;

  addCheck(
    checks,
    {
      id:
        "EMERGENCY_STOP_CLEAR",
      passed:
        !emergencyStop,
      message:
        emergencyStop
          ? "Emergency stop is active; BUY/SELL approval is prohibited."
          : "Emergency stop is clear.",
      details: {
        configuredMode,
        configEmergencyStop:
          config?.deployment
            ?.emergencyStop === true,
        decisionEmergencyStop:
          normalized.deployment
            .emergencyStop === true,
        reason:
          stateCorruptionKillSwitch
            ? "STATE_CORRUPTION_KILL_SWITCH"
            : repeatedWriteFailureKillSwitch
              ? "REPEATED_WRITE_FAILURE_KILL_SWITCH"
              : config?.deployment
                  ?.emergencyStopReason ||
                null
      }
    }
  );

  const decisionDocumentValid =
    isPlainObject(
      normalized.decisionDocument
    ) &&
    normalized.decisionDocument
      .engineName ===
      SUPPORTED_DECISION_ENGINE_NAME &&
    normalized.decisionDocument
      .engineVersion ===
      SUPPORTED_DECISION_ENGINE_VERSION &&
    normalized.decisionDocument
      .metadata?.configVersion ===
      config?.configVersion &&
    normalized.decisionSafetyDeclaration
      .present &&
    normalized.decisionSafetyDeclaration
      .finalApprovalRequired &&
    !normalized
      .decisionSafetyDeclaration
      .orderPlacementPermitted &&
    !normalized
      .decisionSafetyDeclaration
      .riskLimitModificationPermitted &&
    !normalized
      .decisionSafetyDeclaration
      .sourceCodeModificationPermitted &&
    !normalized
      .decisionSafetyDeclaration
      .externalNetworkCalls;

  addCheck(
    checks,
    {
      id:
        "DECISION_DOCUMENT_VALID",
      passed:
        decisionDocumentValid,
      message:
        decisionDocumentValid
          ? "AI Decision Engine document and safety declaration are valid."
          : "Decision document is missing, incompatible, or declares prohibited authority.",
      details: {
        receivedEngineName:
          normalized.decisionDocument
            ?.engineName || null,
        receivedEngineVersion:
          normalized.decisionDocument
            ?.engineVersion || null,
        requiredEngineName:
          SUPPORTED_DECISION_ENGINE_NAME,
        requiredEngineVersion:
          SUPPORTED_DECISION_ENGINE_VERSION
      }
    }
  );

  const deterministicFallbackMode =
    [
      "DETERMINISTIC_FALLBACK",
      "CONTROLLED_FALLBACK"
    ].includes(
      normalized.deployment
        .authorityMode
    );

  const deterministicFallbackEquivalent =
    deterministicFallbackMode &&
    config?.deployment
      ?.fallbackOnAnyValidationFailure ===
      true &&
    config?.deployment
      ?.deterministicFallbackRequired ===
      true &&
    normalized.proposed.decision ===
      normalized.baseline.decision &&
    round(
      normalized.proposed.confidence,
      4
    ) === round(
      normalized.baseline.confidence,
      4
    ) &&
    tradePlansSemanticallyEqual(
      normalized.proposed.tradePlan,
      normalized.baseline.tradePlan
    );

  const decisionValidationAccepted =
    normalized.decisionValidation
      .present &&
    (
      normalized.decisionValidation
        .valid ||
      deterministicFallbackEquivalent
    );

  addCheck(
    checks,
    {
      id:
        "DECISION_VALIDATION_PASSED",
      passed:
        decisionValidationAccepted,
      message:
        normalized.decisionValidation
          .valid
          ? "AI Decision Engine validation passed."
          : deterministicFallbackEquivalent
            ? "AI policy validation failed, but the exact deterministic baseline fallback is permitted by configuration."
            : "AI Decision Engine validation did not pass and no exact deterministic fallback was established.",
      details: {
        deterministicFallbackEquivalent,
        authorityMode:
          normalized.deployment
            .authorityMode,
        errors:
          normalized.decisionValidation
            .errors,
        warnings:
          normalized.decisionValidation
            .warnings
      }
    }
  );

  const proposedDecision =
    normalized.proposed.decision;

  const isTradeCandidate =
    proposedDecision === "BUY" ||
    proposedDecision === "SELL";

  const contextValid =
    !isTradeCandidate ||
    (
      normalized.decisionId !== null &&
      normalized.context.pair !== null &&
      normalized.context.timeframe !== null &&
      normalized.context.engine !== null
    );

  addCheck(
    checks,
    {
      id:
        "CONTEXT_VALID",
      passed:
        contextValid,
      skipped:
        !isTradeCandidate,
      message:
        !isTradeCandidate
          ? "Trading context is not required for HOLD."
          : contextValid
            ? "Decision ID, pair, timeframe and engine context are present."
            : "Trade candidate is missing required context."
    }
  );

  const marketClass =
    deriveMarketClass(
      normalized.context.engine,
      normalized.context.timeframe
    );

  const maximumAgeSeconds =
    toFiniteNumber(
      config?.riskSafetyGate
        ?.maximumMarketDataAgeSeconds
        ?.[marketClass]
    );

  const marketAgeSeconds =
    secondsBetween(
      normalized.evaluatedAt,
      normalized.context.marketDataAt
    );

  const marketDataFresh =
    !isTradeCandidate ||
    (
      normalized.context.marketDataAt !==
        null &&
      marketAgeSeconds !== null &&
      marketAgeSeconds >= 0 &&
      maximumAgeSeconds !== null &&
      marketAgeSeconds <=
        maximumAgeSeconds
    );

  addCheck(
    checks,
    {
      id:
        "MARKET_DATA_FRESH",
      passed:
        marketDataFresh,
      skipped:
        !isTradeCandidate,
      message:
        !isTradeCandidate
          ? "Market freshness check is not required for HOLD."
          : marketDataFresh
            ? "Market data is within the configured freshness limit."
            : "Market data is missing, future-dated, or stale.",
      details: {
        marketClass,
        marketDataAt:
          normalized.context
            .marketDataAt,
        evaluatedAt:
          normalized.evaluatedAt,
        marketAgeSeconds:
          round(
            marketAgeSeconds,
            3
          ),
        maximumAgeSeconds
      }
    }
  );

  const plan =
    normalized.proposed.tradePlan;

  addCheck(
    checks,
    {
      id:
        "TRADE_PLAN_PRESENT",
      passed:
        !isTradeCandidate ||
        plan !== null,
      skipped:
        !isTradeCandidate,
      message:
        !isTradeCandidate
          ? "Trade plan is not required for HOLD."
          : plan !== null
            ? "Trade plan is present."
            : "BUY/SELL candidate is missing a trade plan."
    }
  );

  const priceValuesFinite =
    !isTradeCandidate ||
    (
      plan !== null &&
      Number.isFinite(plan.entry) &&
      Number.isFinite(plan.stop) &&
      plan.targets.length > 0 &&
      plan.targets.every(
        Number.isFinite
      )
    );

  addCheck(
    checks,
    {
      id:
        "PRICE_VALUES_FINITE",
      passed:
        priceValuesFinite,
      skipped:
        !isTradeCandidate,
      message:
        !isTradeCandidate
          ? "Price validation is not required for HOLD."
          : priceValuesFinite
            ? "Entry, stop and targets are finite numeric values."
            : "Trade plan contains missing or non-finite prices."
    }
  );

  const geometry =
    validateTradeGeometry(
      proposedDecision,
      plan,
      config || {}
    );

  addCheck(
    checks,
    {
      id:
        "TRADE_GEOMETRY_VALID",
      passed:
        geometry.valid,
      skipped:
        !isTradeCandidate,
      message:
        !isTradeCandidate
          ? "Trade geometry is not required for HOLD."
          : geometry.valid
            ? "Trade direction, stop and target geometry are valid."
            : "Trade geometry failed validation.",
      details: {
        errors:
          geometry.errors
      }
    }
  );

  const minimumRiskReward =
    toFiniteNumber(
      config?.riskSafetyGate
        ?.minimumRiskReward
    );

  const maximumRiskReward =
    toFiniteNumber(
      config?.authority
        ?.tradePlanOptimization
        ?.maximumRiskReward
    );

  const riskRewardValid =
    !isTradeCandidate ||
    (
      geometry.riskReward !== null &&
      minimumRiskReward !== null &&
      geometry.riskReward >=
        minimumRiskReward &&
      (
        maximumRiskReward === null ||
        geometry.riskReward <=
          maximumRiskReward
      )
    );

  addCheck(
    checks,
    {
      id:
        "RISK_REWARD_VALID",
      passed:
        riskRewardValid,
      skipped:
        !isTradeCandidate,
      message:
        !isTradeCandidate
          ? "Risk/reward validation is not required for HOLD."
          : riskRewardValid
            ? "Risk/reward is within immutable boundaries."
            : "Risk/reward is outside immutable boundaries.",
      details: {
        actual:
          geometry.riskReward,
        minimum:
          minimumRiskReward,
        maximum:
          maximumRiskReward
      }
    }
  );

  const baselineBoundary =
    validateBaselineBoundaries(
      normalized,
      config || {}
    );

  addCheck(
    checks,
    {
      id:
        "BASELINE_PLAN_BOUNDARY_VALID",
      passed:
        baselineBoundary.valid,
      skipped:
        !isTradeCandidate ||
        baselineBoundary.skipped,
      message:
        !isTradeCandidate ||
        baselineBoundary.skipped
          ? "Baseline trade-plan boundary comparison is not applicable."
          : baselineBoundary.valid
            ? "Proposed plan remains within deterministic baseline boundaries."
            : "Proposed plan exceeds deterministic baseline boundaries.",
      details: {
        errors:
          baselineBoundary.errors
      }
    }
  );

  const configuredDefaultRisk =
    toFiniteNumber(
      config?.riskSafetyGate
        ?.riskPerTradePercent
        ?.default
    );

  const configuredMaximumRisk =
    toFiniteNumber(
      config?.riskSafetyGate
        ?.riskPerTradePercent
        ?.maximum
    );

  const requestedRiskPercent =
    normalized.account
      .requestedRiskPercent ??
    configuredDefaultRisk;

  const riskPercentValid =
    !isTradeCandidate ||
    (
      requestedRiskPercent !== null &&
      configuredMaximumRisk !== null &&
      requestedRiskPercent > 0 &&
      requestedRiskPercent <=
        configuredMaximumRisk
    );

  addCheck(
    checks,
    {
      id:
        "RISK_PERCENT_VALID",
      passed:
        riskPercentValid,
      skipped:
        !isTradeCandidate,
      message:
        !isTradeCandidate
          ? "Risk-percent validation is not required for HOLD."
          : riskPercentValid
            ? "Requested risk percentage is within immutable limits."
            : "Requested risk percentage is invalid or exceeds the maximum.",
      details: {
        requested:
          requestedRiskPercent,
        default:
          configuredDefaultRisk,
        maximum:
          configuredMaximumRisk
      }
    }
  );

  const pair =
    normalized.context.pair;

  const totalOpenPositions =
    Math.max(
      0,
      normalized.portfolio
        .openPositionCount || 0
    );

  const derivedPairOpenCount =
    normalized.portfolio
      .openPositions.filter(
        (position) =>
          position.pair === pair
      ).length;

  const pairOpenPositions =
    normalized.portfolio
      .pairOpenPositionCount ??
    derivedPairOpenCount;

  const maximumOpenPositions =
    toInteger(
      config?.riskSafetyGate
        ?.maximumOpenPositions
    );

  const maximumOpenPositionsPerPair =
    toInteger(
      config?.riskSafetyGate
        ?.maximumOpenPositionsPerPair
    );

  const openPositionLimitValid =
    !isTradeCandidate ||
    (
      maximumOpenPositions !== null &&
      totalOpenPositions <
        maximumOpenPositions
    );

  addCheck(
    checks,
    {
      id:
        "OPEN_POSITION_LIMIT",
      passed:
        openPositionLimitValid,
      skipped:
        !isTradeCandidate,
      message:
        !isTradeCandidate
          ? "Open-position limit is not required for HOLD."
          : openPositionLimitValid
            ? "Portfolio open-position limit allows this signal."
            : "Portfolio open-position limit has been reached.",
      details: {
        current:
          totalOpenPositions,
        maximum:
          maximumOpenPositions
      }
    }
  );

  const pairPositionLimitValid =
    !isTradeCandidate ||
    (
      maximumOpenPositionsPerPair !==
        null &&
      pairOpenPositions <
        maximumOpenPositionsPerPair
    );

  addCheck(
    checks,
    {
      id:
        "PAIR_POSITION_LIMIT",
      passed:
        pairPositionLimitValid,
      skipped:
        !isTradeCandidate,
      message:
        !isTradeCandidate
          ? "Pair-position limit is not required for HOLD."
          : pairPositionLimitValid
            ? "Pair-specific open-position limit allows this signal."
            : "An open position already occupies the pair limit.",
      details: {
        pair,
        current:
          pairOpenPositions,
        maximum:
          maximumOpenPositionsPerPair
      }
    }
  );

  const maximumCorrelatedExposure =
    toInteger(
      config?.riskSafetyGate
        ?.maximumCorrelatedExposurePositions
    );

  const correlatedExposureValid =
    !isTradeCandidate ||
    (
      maximumCorrelatedExposure !==
        null &&
      normalized.portfolio
        .correlatedExposureCount <
        maximumCorrelatedExposure
    );

  addCheck(
    checks,
    {
      id:
        "CORRELATED_EXPOSURE_LIMIT",
      passed:
        correlatedExposureValid,
      skipped:
        !isTradeCandidate,
      message:
        !isTradeCandidate
          ? "Correlated exposure check is not required for HOLD."
          : correlatedExposureValid
            ? "Correlated exposure is within the configured limit."
            : "Correlated exposure limit has been reached.",
      details: {
        current:
          normalized.portfolio
            .correlatedExposureCount,
        maximum:
          maximumCorrelatedExposure,
        group:
          normalized.portfolio
            .correlatedGroup
      }
    }
  );

  const riskSnapshot =
    mergeRiskSnapshotFromState(
      normalized,
      currentState
    );

  const maximumDailyLoss =
    toFiniteNumber(
      config?.riskSafetyGate
        ?.maximumDailyLossPercent
    );

  const maximumWeeklyLoss =
    toFiniteNumber(
      config?.riskSafetyGate
        ?.maximumWeeklyLossPercent
    );

  const dailyLossAvailable =
    riskSnapshot
      .dailyLossPercent !== null;

  const weeklyLossAvailable =
    riskSnapshot
      .weeklyLossPercent !== null;

  const dailyLossValid =
    !isTradeCandidate ||
    (
      dailyLossAvailable &&
      riskSnapshot.dailyLossPercent <
        maximumDailyLoss
    );

  const weeklyLossValid =
    !isTradeCandidate ||
    (
      weeklyLossAvailable &&
      riskSnapshot.weeklyLossPercent <
        maximumWeeklyLoss
    );

  addCheck(
    checks,
    {
      id:
        "DAILY_LOSS_LIMIT",
      passed:
        dailyLossValid,
      blocking:
        dailyLossAvailable ||
        normalized.executionContext ===
          "ORDER_EXECUTION",
      skipped:
        !isTradeCandidate,
      message:
        !isTradeCandidate
          ? "Daily loss limit is not required for HOLD."
          : !dailyLossAvailable
            ? "Daily loss snapshot is unavailable; signal-only approval may continue but order execution remains prohibited."
            : dailyLossValid
              ? "Daily loss remains below the shutdown threshold."
              : "Daily loss shutdown threshold has been reached.",
      details: {
        current:
          riskSnapshot
            .dailyLossPercent,
        maximum:
          maximumDailyLoss,
        snapshotAvailable:
          dailyLossAvailable
      }
    }
  );

  addCheck(
    checks,
    {
      id:
        "WEEKLY_LOSS_LIMIT",
      passed:
        weeklyLossValid,
      blocking:
        weeklyLossAvailable ||
        normalized.executionContext ===
          "ORDER_EXECUTION",
      skipped:
        !isTradeCandidate,
      message:
        !isTradeCandidate
          ? "Weekly loss limit is not required for HOLD."
          : !weeklyLossAvailable
            ? "Weekly loss snapshot is unavailable; signal-only approval may continue but order execution remains prohibited."
            : weeklyLossValid
              ? "Weekly loss remains below the shutdown threshold."
              : "Weekly loss shutdown threshold has been reached.",
      details: {
        current:
          riskSnapshot
            .weeklyLossPercent,
        maximum:
          maximumWeeklyLoss,
        snapshotAvailable:
          weeklyLossAvailable
      }
    }
  );

  const maximumConsecutiveLosses =
    toInteger(
      config?.riskSafetyGate
        ?.maximumConsecutiveLosses
    );

  const consecutiveLossesValid =
    !isTradeCandidate ||
    (
      maximumConsecutiveLosses !==
        null &&
      riskSnapshot
        .consecutiveLosses <=
        maximumConsecutiveLosses
    );

  addCheck(
    checks,
    {
      id:
        "CONSECUTIVE_LOSS_LIMIT",
      passed:
        consecutiveLossesValid,
      skipped:
        !isTradeCandidate,
      message:
        !isTradeCandidate
          ? "Consecutive-loss limit is not required for HOLD."
          : consecutiveLossesValid
            ? "Consecutive losses remain below the cooldown trigger."
            : "Maximum consecutive-loss threshold has been reached.",
      details: {
        current:
          riskSnapshot
            .consecutiveLosses,
        maximum:
          maximumConsecutiveLosses
      }
    }
  );

  const lossCooldownMinutes =
    toFiniteNumber(
      config?.riskSafetyGate
        ?.lossCooldownMinutes
    );

  const minutesSinceLoss =
    minutesBetween(
      normalized.evaluatedAt,
      riskSnapshot.lastLossAt
    );

  const lossCooldownRequired =
    riskSnapshot.consecutiveLosses >=
      maximumConsecutiveLosses;

  const lossCooldownComplete =
    !isTradeCandidate ||
    !lossCooldownRequired ||
    (
      minutesSinceLoss !== null &&
      minutesSinceLoss >=
        lossCooldownMinutes
    );

  addCheck(
    checks,
    {
      id:
        "LOSS_COOLDOWN_COMPLETE",
      passed:
        lossCooldownComplete,
      skipped:
        !isTradeCandidate ||
        !lossCooldownRequired,
      message:
        !isTradeCandidate ||
        !lossCooldownRequired
          ? "Loss cooldown is not currently required."
          : lossCooldownComplete
            ? "Loss cooldown has completed."
            : "Loss cooldown is still active.",
      details: {
        lastLossAt:
          riskSnapshot.lastLossAt,
        minutesSinceLoss:
          round(
            minutesSinceLoss,
            3
          ),
        requiredMinutes:
          lossCooldownMinutes
      }
    }
  );

  const maximumSignalsPerPairPerDay =
    toInteger(
      config?.riskSafetyGate
        ?.maximumSignalsPerPairPerDay
    );

  const pairDailySignalLimitValid =
    !isTradeCandidate ||
    (
      maximumSignalsPerPairPerDay !==
        null &&
      riskSnapshot
        .signalsForPairToday <
        maximumSignalsPerPairPerDay
    );

  addCheck(
    checks,
    {
      id:
        "PAIR_DAILY_SIGNAL_LIMIT",
      passed:
        pairDailySignalLimitValid,
      skipped:
        !isTradeCandidate,
      message:
        !isTradeCandidate
          ? "Daily pair-signal limit is not required for HOLD."
          : pairDailySignalLimitValid
            ? "Daily pair-signal limit allows this candidate."
            : "Daily pair-signal limit has been reached.",
      details: {
        pair,
        current:
          riskSnapshot
            .signalsForPairToday,
        maximum:
          maximumSignalsPerPairPerDay
      }
    }
  );

  const minimumMinutesBetweenSignals =
    toFiniteNumber(
      config?.riskSafetyGate
        ?.minimumMinutesBetweenSamePairSignals
    );

  const minutesSincePairSignal =
    minutesBetween(
      normalized.evaluatedAt,
      riskSnapshot
        .lastApprovedSignalAt
    );

  const pairSignalCooldownValid =
    !isTradeCandidate ||
    riskSnapshot
      .lastApprovedSignalAt === null ||
    (
      minutesSincePairSignal !== null &&
      minutesSincePairSignal >=
        minimumMinutesBetweenSignals
    );

  addCheck(
    checks,
    {
      id:
        "PAIR_SIGNAL_COOLDOWN",
      passed:
        pairSignalCooldownValid,
      skipped:
        !isTradeCandidate ||
        riskSnapshot
          .lastApprovedSignalAt === null,
      message:
        !isTradeCandidate ||
        riskSnapshot
          .lastApprovedSignalAt === null
          ? "No prior pair signal requires a cooldown check."
          : pairSignalCooldownValid
            ? "Minimum spacing from the previous pair signal has elapsed."
            : "Pair signal cooldown is still active.",
      details: {
        pair,
        lastApprovedSignalAt:
          riskSnapshot
            .lastApprovedSignalAt,
        minutesSincePrevious:
          round(
            minutesSincePairSignal,
            3
          ),
        minimumMinutes:
          minimumMinutesBetweenSignals
      }
    }
  );

  const fingerprint =
    createSignalFingerprint(
      normalized
    );

  const knownFingerprints =
    new Set([
      ...currentState
        .recentFingerprints
        .map(
          (item) =>
            item.fingerprint
        ),
      ...normalized.history
        .recentSignals
        .map(
          (item) =>
            item.fingerprint
        )
    ].filter(Boolean));

  const duplicateSignal =
    isTradeCandidate &&
    knownFingerprints.has(
      fingerprint
    );

  const duplicateSignalClear =
    !isTradeCandidate ||
    config?.riskSafetyGate
      ?.rejectDuplicateOrders !== true ||
    !duplicateSignal;

  addCheck(
    checks,
    {
      id:
        "DUPLICATE_SIGNAL_CLEAR",
      passed:
        duplicateSignalClear,
      skipped:
        !isTradeCandidate,
      message:
        !isTradeCandidate
          ? "Duplicate check is not required for HOLD."
          : duplicateSignalClear
            ? "No identical approved signal fingerprint was found."
            : "An identical signal fingerprint has already been approved.",
      details: {
        fingerprint,
        duplicate:
          duplicateSignal
      }
    }
  );

  const executionSnapshotComplete =
    !isTradeCandidate ||
    normalized.executionContext !==
      "ORDER_EXECUTION" ||
    (
      normalized.executionRequested &&
      normalized.account.authenticated &&
      normalized.account.accountId !==
        null &&
      normalized.account.balance !==
        null &&
      normalized.account.balance > 0 &&
      normalized.account.equity !==
        null &&
      normalized.account.equity > 0 &&
      normalized.account
        .requestedRiskPercentPresent &&
      normalized.account
        .dailyLossPercentPresent &&
      normalized.account
        .weeklyLossPercentPresent &&
      normalized.account
        .consecutiveLossesPresent &&
      normalized.portfolio
        .openPositionCountPresent &&
      normalized.portfolio
        .pairOpenPositionCountPresent &&
      normalized.portfolio
        .correlatedExposureCountPresent &&
      dailyLossAvailable &&
      weeklyLossAvailable
    );

  addCheck(
    checks,
    {
      id:
        "EXECUTION_SNAPSHOT_COMPLETE",
      passed:
        executionSnapshotComplete,
      skipped:
        !isTradeCandidate ||
        normalized.executionContext !==
          "ORDER_EXECUTION",
      message:
        !isTradeCandidate ||
        normalized.executionContext !==
          "ORDER_EXECUTION"
          ? "Broker execution is not requested; signal-only approval remains possible."
          : executionSnapshotComplete
            ? "Authenticated execution-risk snapshot is complete."
            : "Broker execution requires a complete authenticated account and loss snapshot.",
      details: {
        executionContext:
          normalized.executionContext,
        executionRequested:
          normalized.executionRequested,
        authenticated:
          normalized.account.authenticated,
        accountIdPresent:
          normalized.account.accountId !==
          null,
        balancePresent:
          normalized.account.balance !==
          null,
        equityPresent:
          normalized.account.equity !==
          null,
        dailyLossPresent:
          dailyLossAvailable,
        weeklyLossPresent:
          weeklyLossAvailable,
        requestedRiskPresent:
          normalized.account
            .requestedRiskPercentPresent,
        consecutiveLossesPresent:
          normalized.account
            .consecutiveLossesPresent,
        openPositionSnapshotPresent:
          normalized.portfolio
            .openPositionCountPresent,
        pairPositionSnapshotPresent:
          normalized.portfolio
            .pairOpenPositionCountPresent,
        correlatedExposureSnapshotPresent:
          normalized.portfolio
            .correlatedExposureCountPresent
      }
    }
  );

  const blockers =
    checks
      .filter(
        (check) =>
          check.status === "FAIL" &&
          BLOCKING_CHECKS.has(
            check.id
          )
      )
      .map(
        (check) => ({
          id:
            check.id,
          message:
            check.message,
          details:
            check.details
        })
      );

  const hasFailure =
    hasBlockingFailure(checks);

  let finalDecision =
    proposedDecision;

  let status;

  if (proposedDecision === "HOLD") {
    finalDecision = "HOLD";
    status = emergencyStop
      ? "EMERGENCY_STOP"
      : "HOLD";
  } else if (hasFailure) {
    finalDecision = "HOLD";
    status = emergencyStop
      ? "EMERGENCY_STOP"
      : "REJECTED";
  } else {
    status = "APPROVED";
  }

  const signalApproved =
    isTradeCandidate &&
    finalDecision ===
      proposedDecision &&
    status === "APPROVED";

  const orderApproved =
    signalApproved &&
    normalized.executionContext ===
      "ORDER_EXECUTION" &&
    normalized.executionRequested &&
    executionSnapshotComplete;

  const finalTradePlan =
    signalApproved
      ? deepClone(plan)
      : null;

  const resultHash =
    createHash({
      engineVersion:
        ENGINE_VERSION,
      evaluatedAt:
        normalized.evaluatedAt,
      decisionId:
        normalized.decisionId,
      fingerprint,
      proposedDecision,
      finalDecision,
      checks
    });

  const reasons =
    signalApproved
      ? uniqueStrings([
          ...normalized.proposed
            .reasons,
          "Independent immutable Safety Gate approved the signal candidate."
        ])
      : uniqueStrings([
          ...normalized.proposed
            .reasons,
          ...blockers.map(
            (blocker) =>
              blocker.message
          ),
          proposedDecision !== "HOLD" &&
          finalDecision === "HOLD"
            ? "Safety Gate converted the candidate to HOLD."
            : null
        ]);

  return {
    version:
      SAFETY_SCHEMA_VERSION,
    engineName:
      ENGINE_NAME,
    engineVersion:
      ENGINE_VERSION,
    evaluatedAt:
      normalized.evaluatedAt,
    decisionId:
      normalized.decisionId,
    sourceDecisionHash:
      normalized.decisionHash,
    safetyResultHash:
      resultHash,
    signalFingerprint:
      fingerprint,
    context:
      deepClone(
        normalized.context
      ),
    deployment: {
      configuredMode,
      decisionAuthorityMode:
        normalized.deployment
          .authorityMode,
      emergencyStop,
      signalOnly:
        normalized.executionContext ===
        "SIGNAL_ONLY"
    },
    proposedDecision:
      deepClone(
        normalized.proposed
      ),
    finalDecision: {
      decision:
        finalDecision,
      confidence:
        signalApproved
          ? normalized.proposed
              .confidence
          : 0,
      tradePlan:
        finalTradePlan,
      reasons
    },
    approval: {
      status,
      signalApproved,
      orderApproved,
      publishSignal:
        signalApproved,
      executeOrder:
        orderApproved,
      failClosed:
        true,
      blockerCount:
        blockers.length,
      blockers
    },
    risk: {
      requestedRiskPercent,
      maximumRiskPercent:
        configuredMaximumRisk,
      dailyLossPercent:
        riskSnapshot
          .dailyLossPercent,
      maximumDailyLossPercent:
        maximumDailyLoss,
      weeklyLossPercent:
        riskSnapshot
          .weeklyLossPercent,
      maximumWeeklyLossPercent:
        maximumWeeklyLoss,
      consecutiveLosses:
        riskSnapshot
          .consecutiveLosses,
      maximumConsecutiveLosses,
      openPositions:
        totalOpenPositions,
      maximumOpenPositions,
      pairOpenPositions,
      maximumOpenPositionsPerPair,
      correlatedExposureCount:
        normalized.portfolio
          .correlatedExposureCount,
      maximumCorrelatedExposure,
      signalsForPairToday:
        riskSnapshot
          .signalsForPairToday,
      maximumSignalsPerPairPerDay
    },
    checks,
    validation: {
      valid:
        configValidation.valid &&
        decisionDocumentValid &&
        decisionValidationAccepted,
      errors:
        uniqueStrings([
          ...configValidation.errors,
          ...normalized
            .decisionValidation.errors,
          ...blockers.map(
            (blocker) =>
              blocker.message
          )
        ]),
      warnings:
        uniqueStrings([
          ...configValidation.warnings,
          ...normalized
            .decisionValidation.warnings,
          !dailyLossAvailable &&
          isTradeCandidate
            ? "Daily loss snapshot was unavailable; order execution remains prohibited."
            : null,
          !weeklyLossAvailable &&
          isTradeCandidate
            ? "Weekly loss snapshot was unavailable; order execution remains prohibited."
            : null
        ])
    },
    governance: {
      immutableSafetyGate: true,
      policyOverridePermitted: false,
      directionGenerationPermitted: false,
      priceGenerationPermitted: false,
      riskLimitModificationPermitted: false,
      sourceCodeModificationPermitted: false,
      externalNetworkCalls: false,
      brokerExecutionRequiresAuthenticatedSnapshot:
        true,
      deterministic:
        true,
      auditable:
        true
    },
    metadata: {
      configName:
        config?.configName || null,
      configVersion:
        config?.configVersion || null,
      configHash,
      marketClass,
      inputExecutionContext:
        normalized.executionContext,
      nextConsumer:
        signalApproved
          ? "Live Analysis Output / Telegram / History"
          : "HOLD / Audit Log"
    }
  };
}

function evaluateSafetyGate(
  input,
  options = {}
) {
  const evaluatedAt =
    toISOStringOrNull(
      options.evaluatedAt
    ) ||
    new Date().toISOString();

  let config;
  let configHash;

  if (isPlainObject(options.config)) {
    config =
      deepClone(
        options.config
      );

    configHash =
      options.configHash ||
      createHash(config);
  } else {
    const configPath =
      options.autonomousConfigPath ||
      AUTONOMOUS_CONFIG_PATH;

    const source =
      readJSON(configPath);

    config =
      source.value;

    configHash =
      createHash(
        Buffer.from(
          source.raw,
          "utf8"
        )
      );
  }

  let preparedState;

  if (
    options.state !== undefined &&
    options.state !== null
  ) {
    preparedState =
      isPlainObject(
        options.stateIntegrity
      )
        ? {
            state:
              normalizeState(
                options.state,
                evaluatedAt
              ),
            integrity:
              options.stateIntegrity
          }
        : prepareSafetyState(
            options.state,
            evaluatedAt
          );
  } else {
    const statePath =
      options.statePath ||
      SAFETY_STATE_PATH;

    preparedState =
      prepareSafetyState(
        readJSONIfExists(
          statePath,
          createEmptyState(
            evaluatedAt
          )
        ),
        evaluatedAt
      );
  }

  return evaluateSafetyGateWithSources({
    input,
    config,
    configHash,
    state:
      preparedState.state,
    stateIntegrity:
      preparedState.integrity,
    evaluatedAt
  });
}

function evaluateBatch(
  inputs,
  options = {}
) {
  if (!Array.isArray(inputs)) {
    throw new TypeError(
      "Safety Gate batch input must be an array."
    );
  }

  const batchEvaluatedAt =
    options.evaluatedAt ||
    new Date().toISOString();

  let state = null;
  let stateIntegrity = null;

  if (
    options.state !== undefined &&
    options.state !== null
  ) {
    const preparedBatchState =
      prepareSafetyState(
        options.state,
        batchEvaluatedAt
      );

    state =
      preparedBatchState.state;
    stateIntegrity =
      preparedBatchState.integrity;
  }

  const results = [];

  for (const input of inputs) {
    const result =
      evaluateSafetyGate(
        input,
        {
          ...options,
          state:
            state ||
            options.state,
          ...(stateIntegrity
            ? { stateIntegrity }
            : {})
        }
      );

    results.push(result);

    if (
      result.approval
        .signalApproved
    ) {
      state =
        applyResultToState(
          state ||
          createEmptyState(
            result.evaluatedAt
          ),
          result
        );

      if (stateIntegrity === null) {
        stateIntegrity = {
          valid: true,
          corruptionDetected: false,
          recoveredFromSnapshot: false,
          errors: []
        };
      }
    }
  }

  return results;
}

// -----------------------------------------------------------------------------
// Persistence and audit
// -----------------------------------------------------------------------------

function createEmptyLog(
  updatedAt = new Date().toISOString()
) {
  return {
    version:
      LOG_SCHEMA_VERSION,
    engineName:
      ENGINE_NAME,
    engineVersion:
      ENGINE_VERSION,
    updatedAt,
    decisions: []
  };
}

function normalizeLog(
  source,
  updatedAt = new Date().toISOString()
) {
  const empty =
    createEmptyLog(updatedAt);

  if (!isPlainObject(source)) {
    return empty;
  }

  return {
    ...empty,
    ...source,
    version:
      LOG_SCHEMA_VERSION,
    engineName:
      ENGINE_NAME,
    engineVersion:
      ENGINE_VERSION,
    decisions:
      Array.isArray(source.decisions)
        ? source.decisions
            .filter(isPlainObject)
            .slice(-MAX_LOG_ENTRIES)
        : []
  };
}

function createLogEntry(result) {
  return {
    safetyResultHash:
      result.safetyResultHash,
    decisionId:
      result.decisionId,
    sourceDecisionHash:
      result.sourceDecisionHash,
    signalFingerprint:
      result.signalFingerprint,
    evaluatedAt:
      result.evaluatedAt,
    pair:
      result.context.pair,
    timeframe:
      result.context.timeframe,
    engine:
      result.context.engine,
    proposedDecision:
      result.proposedDecision
        .decision,
    finalDecision:
      result.finalDecision
        .decision,
    status:
      result.approval.status,
    signalApproved:
      result.approval
        .signalApproved,
    orderApproved:
      result.approval
        .orderApproved,
    blockerIds:
      result.approval
        .blockers.map(
          (blocker) =>
            blocker.id
        ),
    configHash:
      result.metadata.configHash
  };
}

function applyResultToState(
  state,
  result
) {
  const next =
    normalizeState(
      state,
      result.evaluatedAt
    );

  next.updatedAt =
    result.evaluatedAt;
  next.lastRunAt =
    result.evaluatedAt;
  next.lastResultHash =
    result.safetyResultHash;
  next.lastDecisionId =
    result.decisionId;

  if (
    result.approval
      .signalApproved
  ) {
    next.approvedSignals += 1;

    const date =
      dateKey(
        result.evaluatedAt
      );

    const pair =
      result.context.pair;

    if (!isPlainObject(
      next.dailyPairCounts[date]
    )) {
      next.dailyPairCounts[date] = {};
    }

    next.dailyPairCounts[date][pair] =
      (
        toInteger(
          next.dailyPairCounts
            [date][pair]
        ) || 0
      ) + 1;

    next.lastApprovedSignalAtByPair[pair] =
      result.evaluatedAt;

    next.recentFingerprints.push({
      fingerprint:
        result.signalFingerprint,
      decisionId:
        result.decisionId,
      pair,
      direction:
        result.finalDecision
          .decision,
      approvedAt:
        result.evaluatedAt
    });

    next.recentApprovals.push({
      safetyResultHash:
        result.safetyResultHash,
      decisionId:
        result.decisionId,
      fingerprint:
        result.signalFingerprint,
      pair,
      timeframe:
        result.context.timeframe,
      engine:
        result.context.engine,
      direction:
        result.finalDecision
          .decision,
      approvedAt:
        result.evaluatedAt
    });
  } else if (
    result.approval.status ===
    "HOLD"
  ) {
    next.holdSignals += 1;
  } else {
    next.rejectedSignals += 1;
  }

  if (
    result.approval.status ===
    "EMERGENCY_STOP"
  ) {
    next.emergencyStops += 1;
  }

  next.recentFingerprints =
    next.recentFingerprints
      .slice(
        -MAX_RECENT_FINGERPRINTS
      );

  next.recentApprovals =
    next.recentApprovals
      .slice(
        -MAX_RECENT_APPROVALS
      );

  const currentWeek =
    startOfIsoWeek(
      result.evaluatedAt
    );

  const minimumDate =
    new Date(
      `${currentWeek}T00:00:00.000Z`
    );

  minimumDate.setUTCDate(
    minimumDate.getUTCDate() -
    14
  );

  const minimumDateKey =
    minimumDate
      .toISOString()
      .slice(0, 10);

  for (
    const key of
    Object.keys(
      next.dailyPairCounts
    )
  ) {
    if (key < minimumDateKey) {
      delete next.dailyPairCounts[key];
    }
  }

  next.pendingTransaction =
    null;
  next.consecutiveWriteFailures =
    0;
  next.lastWriteFailureAt =
    null;

  const restorableState =
    createRestorableStatePayload(
      next
    );

  const snapshot = {
    createdAt:
      result.evaluatedAt,
    resultHash:
      result.safetyResultHash,
    approvedSignals:
      next.approvedSignals,
    rejectedSignals:
      next.rejectedSignals,
    holdSignals:
      next.holdSignals,
    stateHash:
      createHash({
        recentFingerprints:
          next.recentFingerprints,
        dailyPairCounts:
          next.dailyPairCounts,
        lastApprovedSignalAtByPair:
          next.lastApprovedSignalAtByPair
      }),
    restorableState,
    restorableStateHash:
      createHash(
        restorableState
      )
  };

  next.snapshots.push(snapshot);
  next.snapshots =
    next.snapshots.slice(
      -MAX_STATE_SNAPSHOTS
    );

  return next;
}

function persistSafetyResult(
  result,
  options = {}
) {
  if (!isPlainObject(result)) {
    throw new TypeError(
      "Safety result must be an object."
    );
  }

  const previewPath =
    options.safetyPreviewPath ||
    SAFETY_PREVIEW_PATH;

  const logPath =
    options.safetyLogPath ||
    SAFETY_LOG_PATH;

  const statePath =
    options.statePath ||
    SAFETY_STATE_PATH;

  const pendingPath =
    options.pendingPath ||
    SAFETY_PENDING_PATH;

  recoverPendingTransaction({
    pendingPath,
    statePath,
    logPath,
    previewPath
  });

  const preparedExistingState =
    prepareSafetyState(
      readJSONIfExists(
        statePath,
        createEmptyState(
          result.evaluatedAt
        )
      ),
      result.evaluatedAt
    );

  if (
    preparedExistingState.integrity
      .corruptionDetected === true &&
    preparedExistingState.integrity
      .recoveredFromSnapshot !== true
  ) {
    throw new Error(
      `Safety Gate state is corrupt and no valid last-known-good snapshot is available: ${preparedExistingState.integrity.errors.join(" ")}`
    );
  }

  const existingState =
    preparedExistingState.state;

  const existingLog =
    normalizeLog(
      readJSONIfExists(
        logPath,
        createEmptyLog(
          result.evaluatedAt
        )
      ),
      result.evaluatedAt
    );

  const duplicateLog =
    existingLog.decisions.some(
      (entry) =>
        entry.safetyResultHash ===
        result.safetyResultHash
    );

  const nextState =
    duplicateLog
      ? existingState
      : applyResultToState(
          existingState,
          result
        );

  const nextLog =
    deepClone(existingLog);

  nextLog.updatedAt =
    result.evaluatedAt;

  if (!duplicateLog) {
    nextLog.decisions.push(
      createLogEntry(result)
    );

    nextLog.decisions =
      nextLog.decisions.slice(
        -MAX_LOG_ENTRIES
      );
  }

  const transactionId =
    createHash({
      resultHash:
        result.safetyResultHash,
      startedAt:
        result.evaluatedAt,
      nextStateHash:
        createHash(nextState),
      nextLogHash:
        createHash(nextLog)
    });

  let pending = {
    version: 1,
    transactionId,
    createdAt:
      result.evaluatedAt,
    resultHash:
      result.safetyResultHash,
    nextState,
    nextLog,
    preview:
      result,
    nextStateHash:
      createHash(nextState),
    nextLogHash:
      createHash(nextLog),
    previewHash:
      createHash(result),
    writeFailureCount:
      Math.max(
        0,
        toInteger(
          existingState
            .consecutiveWriteFailures
        ) || 0
      ),
    lastWriteFailureAt:
      existingState
        .lastWriteFailureAt ||
      null
  };

  try {
    atomicWriteJSON(
      pendingPath,
      pending
    );
  } catch (error) {
    const failureState =
      normalizeState(
        existingState,
        result.evaluatedAt
      );

    failureState
      .consecutiveWriteFailures += 1;
    failureState.lastWriteFailureAt =
      result.evaluatedAt;

    try {
      atomicWriteJSON(
        statePath,
        failureState
      );
    } catch {
      // Preserve the original pending-write failure.
    }

    throw new Error(
      `Safety Gate persistence transaction failed: ${error.message}`
    );
  }

  try {
    if (
      options.skipPreview !==
      true
    ) {
      atomicWriteJSON(
        previewPath,
        result
      );
    }

    atomicWriteJSON(
      logPath,
      nextLog
    );

    atomicWriteJSON(
      statePath,
      nextState
    );

    fs.rmSync(
      pendingPath,
      { force: true }
    );
  } catch (error) {
    try {
      pending =
        recordPendingWriteFailure(
          pendingPath,
          pending,
          result.evaluatedAt
        );
    } catch {
      // Preserve the original transaction failure.
    }

    throw new Error(
      `Safety Gate persistence transaction failed: ${error.message}`
    );
  }

  return {
    duplicate:
      duplicateLog,
    transactionId,
    logEntries:
      nextLog.decisions.length,
    state:
      nextState
  };
}

// -----------------------------------------------------------------------------
// CLI runner
// -----------------------------------------------------------------------------

function runAISafetyGate(
  options = {}
) {
  const evaluatedAt =
    toISOStringOrNull(
      options.evaluatedAt
    ) ||
    new Date().toISOString();

  try {
    const inputPath =
      options.inputPath ||
      SAFETY_INPUT_PATH;

    const inputDocument =
      options.input ||
      readJSON(inputPath).value;

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

    const statePath =
      options.statePath ||
      SAFETY_STATE_PATH;

    if (
      options.persist !== false
    ) {
      recoverPendingTransaction({
        pendingPath:
          options.pendingPath ||
          SAFETY_PENDING_PATH,
        statePath,
        logPath:
          options.safetyLogPath ||
          SAFETY_LOG_PATH,
        previewPath:
          options.safetyPreviewPath ||
          SAFETY_PREVIEW_PATH
      });
    }

    const preparedRunState =
      prepareSafetyState(
        readJSONIfExists(
          statePath,
          createEmptyState(
            evaluatedAt
          )
        ),
        evaluatedAt
      );

    let state =
      preparedRunState.state;

    const stateIntegrity =
      preparedRunState.integrity;

    const results = [];
    const persisted = [];

    for (const input of inputs) {
      const result =
        evaluateSafetyGate(
          input,
          {
            ...options,
            evaluatedAt,
            state,
            stateIntegrity
          }
        );

      results.push(result);

      if (
        options.persist !==
        false
      ) {
        const persistence =
          persistSafetyResult(
            result,
            {
              ...options,
              skipPreview: true
            }
          );

        persisted.push(
          persistence
        );

        state =
          persistence.state;
      } else if (
        result.approval
          .signalApproved
      ) {
        state =
          applyResultToState(
            state,
            result
          );
      }
    }

    const preview = {
      version:
        SAFETY_SCHEMA_VERSION,
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
      options.safetyPreviewPath ||
      SAFETY_PREVIEW_PATH,
      preview
    );

    const approved =
      results.filter(
        (result) =>
          result.approval
            .signalApproved
      ).length;

    const rejected =
      results.filter(
        (result) =>
          result.approval.status ===
          "REJECTED"
      ).length;

    const emergency =
      results.filter(
        (result) =>
          result.approval.status ===
          "EMERGENCY_STOP"
      ).length;

    console.log(
      `[ai-safety] Version: ${ENGINE_VERSION}`
    );
    console.log(
      `[ai-safety] Evaluated: ${results.length}`
    );
    console.log(
      `[ai-safety] Signal approvals: ${approved}`
    );
    console.log(
      `[ai-safety] Rejections: ${rejected}`
    );
    console.log(
      `[ai-safety] Emergency stops: ${emergency}`
    );
    console.log(
      `[ai-safety] Broker order approvals: ${results.filter((result) => result.approval.orderApproved).length}`
    );

    return {
      status:
        emergency > 0
          ? "EMERGENCY_STOP"
          : rejected > 0
            ? "DEGRADED"
            : "SUCCESS",
      generatedAt:
        evaluatedAt,
      results,
      persisted
    };
  } catch (error) {
    console.error(
      `[ai-safety] FAILED: ${error.stack || error.message}`
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
    runAISafetyGate();

  if (
    result.status === "FAILED"
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
  SAFETY_SCHEMA_VERSION,
  STATE_SCHEMA_VERSION,
  LOG_SCHEMA_VERSION,

  paths: {
    data:
      DATA_DIR,
    autonomousConfig:
      AUTONOMOUS_CONFIG_PATH,
    safetyInput:
      SAFETY_INPUT_PATH,
    safetyPreview:
      SAFETY_PREVIEW_PATH,
    safetyLog:
      SAFETY_LOG_PATH,
    safetyState:
      SAFETY_STATE_PATH,
    safetyPending:
      SAFETY_PENDING_PATH
  },

  runAISafetyGate,
  evaluateSafetyGate,
  evaluateSafetyGateWithSources,
  evaluateBatch,
  persistSafetyResult,
  recoverPendingTransaction,
  applyResultToState,
  createEmptyState,
  normalizeState,
  normalizeSafetyInput,
  normalizeTradePlan,
  validateTradeGeometry,
  validateBaselineBoundaries,
  tradePlansSemanticallyEqual,
  validateAutonomousConfig,
  createSignalFingerprint,
  deriveMarketClass,
  createHash
};
