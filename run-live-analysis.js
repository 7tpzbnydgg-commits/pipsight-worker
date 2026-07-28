// run-live-analysis.js
//
// PipSight Pro — Live Analysis Engine
//
// Production revision:
// • Atomic JSON writes
// • Safe JSON loading
// • Dedicated scalp engine priority
// • Legacy scalp fallback retained
// • Telegram deduplication
// • History persistence
// • Backward-compatible outputs
// • Existing JSON schema preserved
// • AI Memory shadow advisory integration
//
// Phase 3 compatibility:
// • Existing BUY / SELL / HOLD decisions remain unchanged
// • Existing confidence values remain unchanged
// • AI Memory is advisory-only in SHADOW mode
// • AI Memory failure never blocks live analysis
// • Missing session, pattern or market-regime data is never invented

"use strict";

const fs = require("fs");
const path = require("path");

const ENGINE_VERSION = "1.4.0-pro";
const STRATEGY_VERSION = "legacy-compatible-1.1";

const TELEGRAM_TIMEOUT_MS = 15000;
const DAY_MS = 24 * 60 * 60 * 1000;

const DATA_DIR = path.join(
  __dirname,
  "data"
);

const HISTORY_PATH = path.join(
  DATA_DIR,
  "analysis-history.json"
);

const NOTIFY_STATE_PATH = path.join(
  DATA_DIR,
  "notify-state.json"
);

const LIVE_ANALYSIS_PATH = path.join(
  DATA_DIR,
  "live-analysis.json"
);

const AI_MEMORY_PATH = path.join(
  DATA_DIR,
  "ai-memory.json"
);

const AI_MEMORY_INTEGRATION = Object.freeze({
  enabled: true,

  mode: "CONTROLLED",

  applyConfidenceAdjustment: true,

  minimumSamples: 10,

  strongMinimumSamples: 20,

  supportiveProfitFactor: 1.2,

  strongProfitFactor: 1.5,

  cautionProfitFactor: 0.8,

  supportiveWinRate: 35,

  strongWinRate: 45,

  cautionWinRate: 25,

  maximumSuggestedAdjustment: 8,

  minimumSamplesToApply: 10,

  minimumReliabilityToApply: 0.5,

  maximumAppliedAdjustment: 5,
});

const PAIR_KEYS = [
  "XAUUSD",
  "GBPJPY",
];

const DECIMALS = {
  XAUUSD: 2,
  GBPJPY: 3,
};

const PAIR_ALIASES = {
  XAUUSD: [
    "XAUUSD",
    "XAU/USD",
    "XAU_USD",
    "XAU-USD",
  ],

  GBPJPY: [
    "GBPJPY",
    "GBP/JPY",
    "GBP_JPY",
    "GBP-JPY",
  ],
};

// ========================================================
// Safe JSON Helpers
// ========================================================

function readJSON(fileName) {
  const filePath = path.join(DATA_DIR, fileName);

  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    return JSON.parse(
      fs.readFileSync(filePath, "utf8")
    );
  } catch (err) {
    console.error(
      `Failed to parse ${fileName}:`,
      err.message
    );

    return null;
  }
}

function atomicWriteJSON(filePath, value) {
  fs.mkdirSync(
    path.dirname(filePath),
    {
      recursive: true,
    }
  );

  const tempFile =
    `${filePath}.${process.pid}.${Date.now()}.tmp`;

  fs.writeFileSync(
    tempFile,
    JSON.stringify(value, null, 2),
    "utf8"
  );

  fs.renameSync(
    tempFile,
    filePath
  );
}

// ========================================================
// AI Memory Safe Loading
// ========================================================

function isPlainObject(
  value
) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function createUnavailableAIMemoryState(
  reason
) {
  return {
    available: false,
    valid: false,
    enabled:
      AI_MEMORY_INTEGRATION.enabled,
    mode:
      AI_MEMORY_INTEGRATION.mode,
    reason:
      reason ||
      "AI Memory is unavailable",
    generatedAt: null,
    engineName: null,
    engineVersion: null,
    data: null,
  };
}

function validateAIMemoryDocument(
  document
) {
  if (!isPlainObject(document)) {
    return {
      valid: false,
      reason:
        "AI Memory root must be an object",
    };
  }

  if (
    document.engineName !==
    "PipSight Pro Adaptive AI Memory Engine"
  ) {
    return {
      valid: false,
      reason:
        "AI Memory engine name is missing or unsupported",
    };
  }

  if (
    typeof document.engineVersion !==
      "string" ||
    !document.engineVersion.trim()
  ) {
    return {
      valid: false,
      reason:
        "AI Memory engine version is missing",
    };
  }

  if (
    typeof document.generatedAt !==
      "string" ||
    Number.isNaN(
      Date.parse(document.generatedAt)
    )
  ) {
    return {
      valid: false,
      reason:
        "AI Memory generatedAt timestamp is invalid",
    };
  }

  if (!isPlainObject(document.memory)) {
    return {
      valid: false,
      reason:
        "AI Memory memory section is missing",
    };
  }

  if (
    !isPlainObject(
      document.memory.pairs
    ) ||
    !isPlainObject(
      document.memory.engines
    ) ||
    !isPlainObject(
      document.memory.directions
    ) ||
    !isPlainObject(
      document.memory.timeframes
    )
  ) {
    return {
      valid: false,
      reason:
        "AI Memory core metric sections are incomplete",
    };
  }

  if (
    !isPlainObject(
      document.combinations
    )
  ) {
    return {
      valid: false,
      reason:
        "AI Memory combinations section is missing",
    };
  }

  return {
    valid: true,
    reason: null,
  };
}

function loadAIMemory() {
  if (!AI_MEMORY_INTEGRATION.enabled) {
    return createUnavailableAIMemoryState(
      "AI Memory integration is disabled"
    );
  }

  if (!fs.existsSync(AI_MEMORY_PATH)) {
    return createUnavailableAIMemoryState(
      "data/ai-memory.json is missing"
    );
  }

  let document;

  try {
    document = JSON.parse(
      fs.readFileSync(
        AI_MEMORY_PATH,
        "utf8"
      )
    );
  } catch (err) {
    console.error(
      "Failed to read AI Memory:",
      err.message
    );

    return createUnavailableAIMemoryState(
      "data/ai-memory.json is unreadable or contains invalid JSON"
    );
  }

  const validation =
    validateAIMemoryDocument(
      document
    );

  if (!validation.valid) {
    console.warn(
      "AI Memory validation failed:",
      validation.reason
    );

    return createUnavailableAIMemoryState(
      validation.reason
    );
  }

  return {
    available: true,
    valid: true,
    enabled: true,
    mode:
      AI_MEMORY_INTEGRATION.mode,
    reason: null,
    generatedAt:
      document.generatedAt,
    engineName:
      document.engineName,
    engineVersion:
      document.engineVersion,
    data:
      document,
  };
}

// ========================================================
// AI Memory Metric Matching
// ========================================================

function normalizeAIMemoryEngine(
  value
) {
  if (
    typeof value !== "string" ||
    !value.trim()
  ) {
    return null;
  }

  const normalized =
    value
      .trim()
      .toLowerCase()
      .replace(
        /[^a-z0-9]/g,
        ""
      );

  if (
    normalized === "scalp" ||
    normalized === "scalping"
  ) {
    return "scalp";
  }

  if (
    normalized === "intraday" ||
    normalized === "daily" ||
    normalized === "day"
  ) {
    return "daily";
  }

  if (
    normalized === "swing" ||
    normalized === "weekly" ||
    normalized === "week"
  ) {
    return "weekly";
  }

  if (
    normalized === "master"
  ) {
    return "master";
  }

  return null;
}

function normalizeAIMemoryTimeframe(
  value
) {
  if (
    typeof value !== "string" ||
    !value.trim()
  ) {
    return null;
  }

  const normalized =
    value
      .trim()
      .toUpperCase()
      .replace(
        /\s+/g,
        ""
      );

  const aliases = {
    "5M": "5m",
    "M5": "5m",
    "5MIN": "5m",
    "5MINUTE": "5m",

    "15M": "15m",
    "M15": "15m",
    "15MIN": "15m",
    "15MINUTE": "15m",

    "30M": "30m",
    "M30": "30m",
    "30MIN": "30m",
    "30MINUTE": "30m",

    "1H": "1H",
    "H1": "1H",
    "60M": "1H",
    "60MIN": "1H",

    "4H": "4H",
    "H4": "4H",

    "1D": "D1",
    "D1": "D1",
    "DAILY": "D1",

    "1W": "W1",
    "W1": "W1",
    "WEEKLY": "W1",
  };

  return aliases[normalized] || null;
}

function normalizeAIMemoryDirection(
  value
) {
  const decision =
    normalizeSignalDecision(
      value
    );

  return (
    decision === "BUY" ||
    decision === "SELL"
  )
    ? decision
    : null;
}

function normalizeAIMemoryMetric(
  metric
) {
  if (!isPlainObject(metric)) {
    return null;
  }

  const totalTrades =
    firstFiniteNumber(
      metric.totalTrades,
      metric.total,
      metric.resolved,
      metric.samples
    );

  const wins =
    firstFiniteNumber(
      metric.wins,
      metric.learningConfidence &&
        metric.learningConfidence.wins
    );

  const losses =
    firstFiniteNumber(
      metric.losses,
      metric.learningConfidence &&
        metric.learningConfidence.losses
    );

  const winRate =
    firstFiniteNumber(
      metric.winRate,
      metric.learningConfidence &&
        metric.learningConfidence.winRate
    );

  const profitFactor =
    firstFiniteNumber(
      metric.profitFactor,
      metric.learningConfidence &&
        metric.learningConfidence.profitFactor
    );

  const averageProfitPoints =
    firstFiniteNumber(
      metric.averageProfitPoints,
      metric.learningConfidence &&
        metric.learningConfidence.averageProfitPoints
    );

  const averageResultPercentage =
    firstFiniteNumber(
      metric.averageResultPercentage
    );

  if (
    totalTrades == null ||
    totalTrades < 0
  ) {
    return null;
  }

  return {
    totalTrades:
      Math.max(
        0,
        Math.trunc(totalTrades)
      ),

    wins:
      wins == null
        ? null
        : Math.max(
            0,
            Math.trunc(wins)
          ),

    losses:
      losses == null
        ? null
        : Math.max(
            0,
            Math.trunc(losses)
          ),

    winRate:
      winRate == null
        ? null
        : Number(
            winRate.toFixed(2)
          ),

    profitFactor:
      profitFactor == null
        ? null
        : Number(
            profitFactor.toFixed(4)
          ),

    averageProfitPoints:
      averageProfitPoints == null
        ? null
        : Number(
            averageProfitPoints.toFixed(
              8
            )
          ),

    averageResultPercentage:
      averageResultPercentage == null
        ? null
        : Number(
            averageResultPercentage.toFixed(
              8
            )
          ),
  };
}

function getAIMemoryMetricByKey(
  container,
  key
) {
  if (
    !isPlainObject(container) ||
    typeof key !== "string" ||
    !key
  ) {
    return null;
  }

  if (
    !Object.prototype
      .hasOwnProperty.call(
        container,
        key
      )
  ) {
    return null;
  }

  return normalizeAIMemoryMetric(
    container[key]
  );
}

function resolveAIMemoryMetric(
  aiMemoryState,
  context = {}
) {
  if (
    !aiMemoryState ||
    !aiMemoryState.available ||
    !aiMemoryState.valid ||
    !isPlainObject(
      aiMemoryState.data
    )
  ) {
    return {
      matched: false,
      matchedBy: null,
      matchedKey: null,
      metric: null,
      reason:
        aiMemoryState &&
        aiMemoryState.reason
          ? aiMemoryState.reason
          : "AI Memory is unavailable",
    };
  }

  const memory =
    aiMemoryState.data.memory;

  const combinations =
    aiMemoryState.data.combinations;

  const pairKey =
    normalizePairKey(
      firstString(
        context.pair,
        context.pairKey,
        context.symbol,
        context.instrument
      )
    );

  const engine =
    normalizeAIMemoryEngine(
      firstString(
        context.engine,
        context.engineName,
        context.mode,
        context.strategy
      )
    );

  const direction =
    normalizeAIMemoryDirection(
      firstString(
        context.direction,
        context.decision,
        context.signal,
        context.action
      )
    );

  const timeframe =
    normalizeAIMemoryTimeframe(
      firstString(
        context.timeframe,
        context.tf,
        context.interval
      )
    );

  const candidates = [];

  if (
    pairKey &&
    engine &&
    direction
  ) {
    candidates.push({
      matchedBy:
        "pairEngineDirection",

      matchedKey:
        `${pairKey}::${engine}::${direction}`,

      container:
        combinations
          .pairEngineDirection,
    });
  }

  if (
    pairKey &&
    engine
  ) {
    candidates.push({
      matchedBy:
        "pairEngine",

      matchedKey:
        `${pairKey}::${engine}`,

      container:
        combinations
          .pairEngine,
    });
  }

  if (
    engine &&
    direction
  ) {
    candidates.push({
      matchedBy:
        "engineDirection",

      matchedKey:
        `${engine}::${direction}`,

      container:
        combinations
          .engineDirection,
    });
  }

  if (
    pairKey &&
    direction
  ) {
    candidates.push({
      matchedBy:
        "pairDirection",

      matchedKey:
        `${pairKey}::${direction}`,

      container:
        combinations
          .pairDirection,
    });
  }

  if (
    timeframe
  ) {
    candidates.push({
      matchedBy:
        "timeframe",

      matchedKey:
        timeframe,

      container:
        memory.timeframes,
    });
  }

  if (
    pairKey
  ) {
    candidates.push({
      matchedBy:
        "pair",

      matchedKey:
        pairKey,

      container:
        memory.pairs,
    });
  }

  if (
    engine &&
    engine !== "master"
  ) {
    candidates.push({
      matchedBy:
        "engine",

      matchedKey:
        engine,

      container:
        memory.engines,
    });
  }

  if (
    direction
  ) {
    candidates.push({
      matchedBy:
        "direction",

      matchedKey:
        direction,

      container:
        memory.directions,
    });
  }

  for (
    const candidate of candidates
  ) {
    const metric =
      getAIMemoryMetricByKey(
        candidate.container,
        candidate.matchedKey
      );

    if (
      metric &&
      metric.totalTrades > 0
    ) {
      return {
        matched: true,

        matchedBy:
          candidate.matchedBy,

        matchedKey:
          candidate.matchedKey,

        metric,

        reason: null,
      };
    }
  }

  return {
    matched: false,
    matchedBy: null,
    matchedKey: null,
    metric: null,
    reason:
      "No usable AI Memory metric matched the signal context",
  };
}

// ========================================================
// AI Memory Shadow Assessment
// ========================================================

function clampAIMemoryNumber(
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

function calculateAIMemoryReliability(
  sampleSize
) {
  if (
    !Number.isFinite(sampleSize) ||
    sampleSize <= 0
  ) {
    return 0;
  }

  if (
    sampleSize >=
    AI_MEMORY_INTEGRATION
      .strongMinimumSamples
  ) {
    return 1;
  }

  if (
    sampleSize <
    AI_MEMORY_INTEGRATION
      .minimumSamples
  ) {
    return Number(
      (
        sampleSize /
        AI_MEMORY_INTEGRATION
          .minimumSamples *
        0.5
      ).toFixed(4)
    );
  }

  const range =
    AI_MEMORY_INTEGRATION
      .strongMinimumSamples -
    AI_MEMORY_INTEGRATION
      .minimumSamples;

  const position =
    sampleSize -
    AI_MEMORY_INTEGRATION
      .minimumSamples;

  return Number(
    (
      0.5 +
      (
        range > 0
          ? position / range
          : 1
      ) *
        0.5
    ).toFixed(4)
  );
}

function classifyAIMemoryStatus(
  metric
) {
  if (
    !metric ||
    !Number.isFinite(
      metric.totalTrades
    ) ||
    metric.totalTrades <
      AI_MEMORY_INTEGRATION
        .minimumSamples
  ) {
    return "INSUFFICIENT_DATA";
  }

  const profitFactor =
    Number.isFinite(
      metric.profitFactor
    )
      ? metric.profitFactor
      : null;

  const winRate =
    Number.isFinite(
      metric.winRate
    )
      ? metric.winRate
      : null;

  const averageProfitPoints =
    Number.isFinite(
      metric.averageProfitPoints
    )
      ? metric.averageProfitPoints
      : null;

  const strongProfitFactor =
    profitFactor !== null &&
    profitFactor >=
      AI_MEMORY_INTEGRATION
        .strongProfitFactor;

  const strongWinRate =
    winRate !== null &&
    winRate >=
      AI_MEMORY_INTEGRATION
        .strongWinRate;

  const positiveAverage =
    averageProfitPoints !== null &&
    averageProfitPoints > 0;

  if (
    strongProfitFactor &&
    strongWinRate &&
    positiveAverage
  ) {
    return "STRONGLY_SUPPORTIVE";
  }

  const supportiveProfitFactor =
    profitFactor !== null &&
    profitFactor >=
      AI_MEMORY_INTEGRATION
        .supportiveProfitFactor;

  const supportiveWinRate =
    winRate !== null &&
    winRate >=
      AI_MEMORY_INTEGRATION
        .supportiveWinRate;

  if (
    positiveAverage &&
    (
      supportiveProfitFactor ||
      supportiveWinRate
    )
  ) {
    return "SUPPORTIVE";
  }

  const cautionProfitFactor =
    profitFactor !== null &&
    profitFactor <
      AI_MEMORY_INTEGRATION
        .cautionProfitFactor;

  const cautionWinRate =
    winRate !== null &&
    winRate <
      AI_MEMORY_INTEGRATION
        .cautionWinRate;

  const negativeAverage =
    averageProfitPoints !== null &&
    averageProfitPoints < 0;

  if (
    negativeAverage &&
    (
      cautionProfitFactor ||
      cautionWinRate
    )
  ) {
    return "CAUTION";
  }

  return "NEUTRAL";
}

function calculateAIMemoryRawAdjustment(
  metric,
  status
) {
  if (
    !metric ||
    status === "INSUFFICIENT_DATA"
  ) {
    return 0;
  }

  let adjustment = 0;

  if (
    Number.isFinite(
      metric.profitFactor
    )
  ) {
    if (
      metric.profitFactor >=
      AI_MEMORY_INTEGRATION
        .strongProfitFactor
    ) {
      adjustment += 4;
    } else if (
      metric.profitFactor >=
      AI_MEMORY_INTEGRATION
        .supportiveProfitFactor
    ) {
      adjustment += 2;
    } else if (
      metric.profitFactor <
      AI_MEMORY_INTEGRATION
        .cautionProfitFactor
    ) {
      adjustment -= 4;
    } else if (
      metric.profitFactor < 1
    ) {
      adjustment -= 2;
    }
  }

  if (
    Number.isFinite(
      metric.winRate
    )
  ) {
    if (
      metric.winRate >=
      AI_MEMORY_INTEGRATION
        .strongWinRate
    ) {
      adjustment += 3;
    } else if (
      metric.winRate >=
      AI_MEMORY_INTEGRATION
        .supportiveWinRate
    ) {
      adjustment += 1;
    } else if (
      metric.winRate <
      AI_MEMORY_INTEGRATION
        .cautionWinRate
    ) {
      adjustment -= 3;
    }
  }

  if (
    Number.isFinite(
      metric.averageProfitPoints
    )
  ) {
    if (
      metric.averageProfitPoints > 0
    ) {
      adjustment += 1;
    } else if (
      metric.averageProfitPoints < 0
    ) {
      adjustment -= 1;
    }
  }

  if (
    status ===
    "STRONGLY_SUPPORTIVE"
  ) {
    adjustment =
      Math.max(
        adjustment,
        5
      );
  }

  if (
    status === "SUPPORTIVE"
  ) {
    adjustment =
      Math.max(
        adjustment,
        1
      );
  }

  if (
    status === "CAUTION"
  ) {
    adjustment =
      Math.min(
        adjustment,
        -1
      );
  }

  return clampAIMemoryNumber(
    adjustment,
    -AI_MEMORY_INTEGRATION
      .maximumSuggestedAdjustment,
    AI_MEMORY_INTEGRATION
      .maximumSuggestedAdjustment
  );
}

function buildAIMemoryReason(
  status,
  metric,
  matchedBy
) {
  const sampleSize =
    metric &&
    Number.isFinite(
      metric.totalTrades
    )
      ? metric.totalTrades
      : 0;

  const sourceLabel =
    matchedBy ||
    "no matching dimension";

  if (
    status === "INSUFFICIENT_DATA"
  ) {
    return (
      `AI Memory matched ${sourceLabel}, ` +
      `but only ${sampleSize} historical trade` +
      `${sampleSize === 1 ? "" : "s"} are available`
    );
  }

  if (
    status ===
    "STRONGLY_SUPPORTIVE"
  ) {
    return (
      `Historical ${sourceLabel} performance ` +
      `strongly supports this signal`
    );
  }

  if (
    status === "SUPPORTIVE"
  ) {
    return (
      `Historical ${sourceLabel} performance ` +
      `supports this signal`
    );
  }

  if (
    status === "CAUTION"
  ) {
    return (
      `Historical ${sourceLabel} performance ` +
      `suggests caution for this signal`
    );
  }

  return (
    `Historical ${sourceLabel} performance ` +
    `is mixed or neutral`
  );
}

function createUnavailableAIMemoryAssessment(
  aiMemoryState,
  reason
) {
  return {
    enabled:
      Boolean(
        AI_MEMORY_INTEGRATION.enabled
      ),

    available:
      Boolean(
        aiMemoryState &&
        aiMemoryState.available
      ),

    valid:
      Boolean(
        aiMemoryState &&
        aiMemoryState.valid
      ),

    mode:
      AI_MEMORY_INTEGRATION.mode,

    applied: false,

    status: "UNAVAILABLE",

    reason:
      reason ||
      (
        aiMemoryState &&
        aiMemoryState.reason
      ) ||
      "AI Memory is unavailable",

    matchedBy: null,
    matchedKey: null,

    sampleSize: 0,
    wins: null,
    losses: null,
    winRate: null,
    profitFactor: null,
    averageProfitPoints: null,
    averageResultPercentage: null,

    reliability: 0,

    confidenceAdjustment: 0,
    suggestedConfidenceAdjustment: 0,

    generatedAt:
      aiMemoryState &&
      aiMemoryState.generatedAt
        ? aiMemoryState.generatedAt
        : null,

    engineName:
      aiMemoryState &&
      aiMemoryState.engineName
        ? aiMemoryState.engineName
        : null,

    engineVersion:
      aiMemoryState &&
      aiMemoryState.engineVersion
        ? aiMemoryState.engineVersion
        : null,
  };
}

function createAIMemoryAssessment(
  aiMemoryState,
  context = {}
) {
  if (
    !AI_MEMORY_INTEGRATION.enabled
  ) {
    return createUnavailableAIMemoryAssessment(
      aiMemoryState,
      "AI Memory integration is disabled"
    );
  }

  if (
    !aiMemoryState ||
    !aiMemoryState.available ||
    !aiMemoryState.valid
  ) {
    return createUnavailableAIMemoryAssessment(
      aiMemoryState
    );
  }

  const direction =
    normalizeAIMemoryDirection(
      firstString(
        context.direction,
        context.decision,
        context.signal,
        context.action
      )
    );

  if (!direction) {
    return {
      ...createUnavailableAIMemoryAssessment(
        aiMemoryState,
        "AI Memory assessment requires a BUY or SELL decision"
      ),

      available: true,
      valid: true,
      status: "NOT_APPLICABLE",
    };
  }

  const match =
    resolveAIMemoryMetric(
      aiMemoryState,
      {
        ...context,
        direction,
      }
    );

  if (
    !match.matched ||
    !match.metric
  ) {
    return {
      ...createUnavailableAIMemoryAssessment(
        aiMemoryState,
        match.reason
      ),

      available: true,
      valid: true,
      status: "NO_MATCH",
    };
  }

  const metric =
    match.metric;

  const status =
    classifyAIMemoryStatus(
      metric
    );

  const reliability =
    calculateAIMemoryReliability(
      metric.totalTrades
    );

  const rawAdjustment =
    calculateAIMemoryRawAdjustment(
      metric,
      status
    );

  const suggestedAdjustment =
    Math.round(
      rawAdjustment *
      reliability
    );

  return {
    enabled: true,
    available: true,
    valid: true,

    mode:
      AI_MEMORY_INTEGRATION.mode,

    applied: false,

    status,

    reason:
      buildAIMemoryReason(
        status,
        metric,
        match.matchedBy
      ),

    matchedBy:
      match.matchedBy,

    matchedKey:
      match.matchedKey,

    sampleSize:
      metric.totalTrades,

    wins:
      metric.wins,

    losses:
      metric.losses,

    winRate:
      metric.winRate,

    profitFactor:
      metric.profitFactor,

    averageProfitPoints:
      metric.averageProfitPoints,

    averageResultPercentage:
      metric.averageResultPercentage,

    reliability,

    confidenceAdjustment: 0,

    suggestedConfidenceAdjustment:
      suggestedAdjustment,

    generatedAt:
      aiMemoryState.generatedAt,

    engineName:
      aiMemoryState.engineName,

    engineVersion:
      aiMemoryState.engineVersion,
  };
}

// ========================================================
// AI Memory Controlled Confidence Application
// ========================================================

function applyAIMemoryConfidenceAdjustment(
  engineResult,
  assessment
) {
  if (
    !engineResult ||
    typeof engineResult !== "object" ||
    Array.isArray(engineResult)
  ) {
    return engineResult;
  }

  const memoryAssessment =
    assessment &&
    typeof assessment === "object" &&
    !Array.isArray(assessment)
      ? assessment
      : createUnavailableAIMemoryAssessment(
          null,
          "AI Memory assessment is unavailable"
        );

  const rawConfidence =
    Number(
      engineResult.confidence
    );

  const originalConfidence =
    Number.isFinite(rawConfidence)
      ? clampAIMemoryNumber(
          rawConfidence,
          0,
          100
        )
      : 0;

  const decision =
    normalizeSignalDecision(
      firstString(
        engineResult.decision,
        engineResult.signal,
        engineResult.action,
        engineResult.direction
      )
    ) ||
    "HOLD";

  function buildUnappliedResult(
    applicationReason
  ) {
    return {
      ...engineResult,

      confidence:
        originalConfidence,

      confidencePct:
        originalConfidence,

      originalConfidence,

      aiMemoryAdjustedConfidence:
        originalConfidence,

      aiMemory: {
        ...memoryAssessment,

        applied: false,

        confidenceAdjustment: 0,

        appliedConfidenceAdjustment: 0,

        originalConfidence,

        adjustedConfidence:
          originalConfidence,

        applicationReason:
          applicationReason ||
          "AI Memory confidence adjustment was not applied",
      },
    };
  }

  if (
    !AI_MEMORY_INTEGRATION.enabled
  ) {
    return buildUnappliedResult(
      "AI Memory integration is disabled"
    );
  }

  if (
    AI_MEMORY_INTEGRATION.mode !==
    "CONTROLLED"
  ) {
    return buildUnappliedResult(
      "AI Memory is not running in CONTROLLED mode"
    );
  }

  if (
    AI_MEMORY_INTEGRATION
      .applyConfidenceAdjustment !==
    true
  ) {
    return buildUnappliedResult(
      "AI Memory confidence adjustment is disabled"
    );
  }

  if (
    decision !== "BUY" &&
    decision !== "SELL"
  ) {
    return buildUnappliedResult(
      "Confidence adjustment requires a BUY or SELL decision"
    );
  }

  if (
    memoryAssessment.available !==
      true ||
    memoryAssessment.valid !==
      true
  ) {
    return buildUnappliedResult(
      memoryAssessment.reason ||
      "AI Memory is unavailable or invalid"
    );
  }

  if (
    memoryAssessment.status ===
      "INSUFFICIENT_DATA" ||
    memoryAssessment.status ===
      "UNAVAILABLE" ||
    memoryAssessment.status ===
      "NO_MATCH" ||
    memoryAssessment.status ===
      "NOT_APPLICABLE"
  ) {
    return buildUnappliedResult(
      memoryAssessment.reason ||
      "AI Memory assessment is not eligible for confidence adjustment"
    );
  }

  const sampleSize =
    Number(
      memoryAssessment.sampleSize
    );

  if (
    !Number.isFinite(sampleSize) ||
    sampleSize <
      AI_MEMORY_INTEGRATION
        .minimumSamplesToApply
  ) {
    return buildUnappliedResult(
      `AI Memory requires at least ${
        AI_MEMORY_INTEGRATION
          .minimumSamplesToApply
      } historical trades before applying confidence`
    );
  }

  const reliability =
    Number(
      memoryAssessment.reliability
    );

  if (
    !Number.isFinite(reliability) ||
    reliability <
      AI_MEMORY_INTEGRATION
        .minimumReliabilityToApply
  ) {
    return buildUnappliedResult(
      `AI Memory reliability must be at least ${
        AI_MEMORY_INTEGRATION
          .minimumReliabilityToApply
      } before applying confidence`
    );
  }

  const suggestedAdjustment =
    Number(
      memoryAssessment
        .suggestedConfidenceAdjustment
    );

  if (
    !Number.isFinite(
      suggestedAdjustment
    ) ||
    suggestedAdjustment === 0
  ) {
    return buildUnappliedResult(
      "AI Memory suggested no confidence adjustment"
    );
  }

  const maximumAdjustment =
    Math.abs(
      Number(
        AI_MEMORY_INTEGRATION
          .maximumAppliedAdjustment
      )
    );

  const safeMaximumAdjustment =
    Number.isFinite(
      maximumAdjustment
    )
      ? maximumAdjustment
      : 0;

  const appliedAdjustment =
    Math.round(
      clampAIMemoryNumber(
        suggestedAdjustment,
        -safeMaximumAdjustment,
        safeMaximumAdjustment
      )
    );

  if (appliedAdjustment === 0) {
    return buildUnappliedResult(
      "AI Memory adjustment was reduced to zero by safety limits"
    );
  }

  const adjustedConfidence =
    clampAIMemoryNumber(
      originalConfidence +
        appliedAdjustment,
      0,
      100
    );

  return {
    ...engineResult,

    confidence:
      adjustedConfidence,

    confidencePct:
      adjustedConfidence,

    originalConfidence,

    aiMemoryAdjustedConfidence:
      adjustedConfidence,

    aiMemory: {
      ...memoryAssessment,

      mode:
        AI_MEMORY_INTEGRATION.mode,

      applied: true,

      confidenceAdjustment:
        appliedAdjustment,

      appliedConfidenceAdjustment:
        appliedAdjustment,

      originalConfidence,

      adjustedConfidence,

      applicationReason:
        `AI Memory applied a bounded confidence adjustment of ${
          appliedAdjustment > 0
            ? "+"
            : ""
        }${appliedAdjustment}`,
    },
  };
}

// ========================================================
// Generic Helpers
// ========================================================

function isFiniteNumber(value) {
  return (
    typeof value === "number" &&
    Number.isFinite(value)
  );
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    if (
      value === null ||
      value === undefined ||
      value === ""
    ) {
      continue;
    }

    const numeric = Number(value);

    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }

  return null;
}

function firstString(...values) {
  for (const value of values) {
    if (
      typeof value === "string" &&
      value.trim()
    ) {
      return value.trim();
    }
  }

  return null;
}

function normalizeTime(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();

  const parsed =
    Date.parse(trimmed);

  return Number.isNaN(parsed)
    ? null
    : trimmed;
}

function normalizePairKey(value) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized =
    value
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");

  return PAIR_KEYS.includes(normalized)
    ? normalized
    : null;
}

function normalizeSignalDecision(value) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized =
    value
      .trim()
      .toUpperCase()
      .replace(/\s+/g, " ");

  if (
    normalized === "WAIT" ||
    normalized === "NEUTRAL" ||
    normalized === "NO TRADE" ||
    normalized === "NO_TRADE"
  ) {
    return "HOLD";
  }

  if (
    normalized === "BUY" ||
    normalized === "SELL" ||
    normalized === "HOLD"
  ) {
    return normalized;
  }

  return null;
}

function roundPrice(
  value,
  decimals
) {
  if (!isFiniteNumber(value)) {
    return null;
  }

  return Number(
    value.toFixed(decimals)
  );
}

// ========================================================
// Candle Validation
// ========================================================

function normalizeCandle(
  row,
  timeField
) {
  if (
    !row ||
    typeof row !== "object"
  ) {
    return null;
  }

  const timeValue =
    normalizeTime(
      row[timeField]
    );

  const open =
    Number(row.open);

  const high =
    Number(row.high);

  const low =
    Number(row.low);

  const close =
    Number(row.close);

  const prices = [
    open,
    high,
    low,
    close,
  ];

  if (
    !timeValue ||
    !prices.every(Number.isFinite) ||
    prices.some(
      (value) => value <= 0
    ) ||
    high < low ||
    high < open ||
    high < close ||
    low > open ||
    low > close
  ) {
    return null;
  }

  return {
    ...row,
    [timeField]: timeValue,
    open,
    high,
    low,
    close,
  };
}

function validateCandles(
  rows,
  timeField
) {
  if (!Array.isArray(rows)) {
    return {
      rows: [],
      meta: {
        sourceRows: 0,
        validRows: 0,
        invalidRows: 0,
        duplicateRows: 0,
        latest: null,
        stale: true,
      },
    };
  }

  const rowsByTime =
    new Map();

  let invalidRows = 0;
  let duplicateRows = 0;

  for (const row of rows) {
    const normalized =
      normalizeCandle(
        row,
        timeField
      );

    if (!normalized) {
      invalidRows += 1;
      continue;
    }

    const key =
      normalized[timeField];

    if (
      rowsByTime.has(key)
    ) {
      duplicateRows += 1;
    }

    rowsByTime.set(
      key,
      normalized
    );
  }

  const cleanRows =
    [...rowsByTime.values()]
      .sort(
        (a, b) =>
          a[timeField]
            .localeCompare(
              b[timeField]
            )
      );

  const latest =
    cleanRows.length
      ? cleanRows[
          cleanRows.length - 1
        ][timeField]
      : null;

  return {
    rows: cleanRows,
    meta: {
      sourceRows:
        rows.length,

      validRows:
        cleanRows.length,

      invalidRows,

      duplicateRows,

      latest,

      stale:
        latest
          ? Date.now() -
              Date.parse(latest) >
            7 * DAY_MS
          : true,
    },
  };
}

// ========================================================
// Dedicated Scalp Signal Helpers
// ========================================================

function extractDecisionFromRecord(
  record
) {
  if (
    !record ||
    typeof record !== "object"
  ) {
    return null;
  }

  return normalizeSignalDecision(
    firstString(
      record.decision,
      record.signal,
      record.verdict,
      record.action,
      record.recommendation,
      record.side
    )
  );
}

function unwrapScalpRecord(
  record
) {
  if (
    !record ||
    typeof record !== "object"
  ) {
    return null;
  }

  const candidates = [
    record.scalp,
    record.signalData,
    record.analysis,
    record.result,
    record.latest,
    record.current,
    record,
  ];

  for (
    const candidate of candidates
  ) {
    if (
      candidate &&
      typeof candidate ===
        "object" &&
      extractDecisionFromRecord(
        candidate
      )
    ) {
      return candidate;
    }
  }

  return record;
}

function normalizeScalpMode(
  value
) {
  if (
    typeof value !== "string"
  ) {
    return null;
  }

  const normalized =
    value
      .trim()
      .toUpperCase()
      .replace(
        /[^A-Z0-9]/g,
        ""
      );

  if (
    normalized === "M5" ||
    normalized === "5M" ||
    normalized === "5MIN" ||
    normalized === "5MINUTE"
  ) {
    return "M5";
  }

  if (
    normalized === "M15" ||
    normalized === "15M" ||
    normalized === "15MIN" ||
    normalized === "15MINUTE"
  ) {
    return "M15";
  }

  if (
    normalized === "M30" ||
    normalized === "30M" ||
    normalized === "30MIN" ||
    normalized === "30MINUTE"
  ) {
    return "M30";
  }

  return null;
}

function collectDedicatedScalpPairRecords(
  rawScalpSignals,
  pairKey
) {
  if (
    !rawScalpSignals ||
    typeof rawScalpSignals !==
      "object"
  ) {
    return [];
  }

  const records = [];
  const seenRecords =
    new Set();

  function addRecord(
    candidate
  ) {
    if (
      !candidate ||
      typeof candidate !==
        "object" ||
      Array.isArray(candidate)
    ) {
      return;
    }

    if (
      seenRecords.has(candidate)
    ) {
      return;
    }

    const rawPair =
      firstString(
        candidate.pair,
        candidate.symbol,
        candidate.pairKey,
        candidate.instrument,
        candidate.market
      );

    if (
      rawPair &&
      normalizePairKey(rawPair) !==
        pairKey
    ) {
      return;
    }

    const unwrapped =
      unwrapScalpRecord(
        candidate
      );

    const decision =
      extractDecisionFromRecord(
        unwrapped
      );

    if (!decision) {
      return;
    }

    seenRecords.add(candidate);
    records.push(candidate);
  }

  function inspectPairValue(
    value
  ) {
    if (!value) {
      return;
    }

    if (Array.isArray(value)) {
      for (
        const candidate of value
      ) {
        addRecord(candidate);
      }

      return;
    }

    addRecord(value);
  }

  function inspectContainer(
    container
  ) {
    if (!container) {
      return;
    }

    if (
      Array.isArray(container)
    ) {
      for (
        const candidate of
        container
      ) {
        addRecord(candidate);
      }

      return;
    }

    if (
      typeof container !==
        "object"
    ) {
      return;
    }

    const aliases =
      PAIR_ALIASES[pairKey] ||
      [pairKey];

    for (
      const alias of aliases
    ) {
      if (
        Object.prototype
          .hasOwnProperty.call(
            container,
            alias
          )
      ) {
        inspectPairValue(
          container[alias]
        );
      }
    }

    for (
      const [rawKey, value] of
      Object.entries(container)
    ) {
      if (
        normalizePairKey(
          rawKey
        ) === pairKey
      ) {
        inspectPairValue(value);
      }
    }
  }

  inspectContainer(
    rawScalpSignals.signals
  );

  inspectContainer(
    rawScalpSignals.pairs
  );

  inspectContainer(
    rawScalpSignals.results
  );

  inspectContainer(
    rawScalpSignals.data
  );

  inspectContainer(
    rawScalpSignals.latest
  );

  inspectContainer(
    rawScalpSignals
  );

  return records;
}

function parseDedicatedScalpRecord(
  pairRecord,
  rawScalpSignals,
  decimals
) {
  const record =
    unwrapScalpRecord(
      pairRecord
    );

  if (!record) {
    return null;
  }

  const decision =
    extractDecisionFromRecord(
      record
    );

  if (!decision) {
    return null;
  }

  const tradePlan =
    record.tradePlan &&
    typeof record.tradePlan ===
      "object"
      ? record.tradePlan
      : {};

  const entry =
    firstFiniteNumber(
      record.entry,
      record.entryPrice,
      record.price,
      record.currentPrice,
      tradePlan.entry,
      tradePlan.entryPrice
    );

  const stopLoss =
    firstFiniteNumber(
      record.sl,
      record.stop,
      record.stopLoss,
      record.stop_loss,
      tradePlan.sl,
      tradePlan.stop,
      tradePlan.stopLoss
    );

  const takeProfit =
    firstFiniteNumber(
      record.tp,
      record.target,
      record.target1,
      record.takeProfit,
      record.take_profit,
      tradePlan.tp,
      tradePlan.target,
      tradePlan.target1,
      tradePlan.takeProfit
    );

  let riskReward =
    firstFiniteNumber(
      record.rr,
      record.riskReward,
      record.risk_reward,
      tradePlan.rr,
      tradePlan.riskReward
    );

  if (
    riskReward == null &&
    entry != null &&
    stopLoss != null &&
    takeProfit != null
  ) {
    const risk =
      Math.abs(
        entry - stopLoss
      );

    const reward =
      Math.abs(
        takeProfit - entry
      );

    riskReward =
      risk > 0
        ? reward / risk
        : null;
  }

  const mode =
    normalizeScalpMode(
      firstString(
        record.mode,
        record.timeframe,
        record.tf,
        pairRecord.mode,
        pairRecord.timeframe,
        pairRecord.tf
      )
    );

  const updatedAt =
    normalizeTime(
      firstString(
        record.updatedAt,
        record.generatedAt,
        record.analyzedCandleAt,
        record.timestamp,
        record.time,

        pairRecord.updatedAt,
        pairRecord.generatedAt,
        pairRecord.analyzedCandleAt,

        rawScalpSignals.updatedAt,
        rawScalpSignals.generatedAt,
        rawScalpSignals.timestamp,
        rawScalpSignals.time
      )
    );

  const reason =
    firstString(
      record.reason,
      record.explanation,
      record.suppressionReason,
      record.message
    );

  return {
    mode,
    decision,

    entry:
      roundPrice(
        entry,
        decimals
      ),

    sl:
      roundPrice(
        stopLoss,
        decimals
      ),

    tp:
      roundPrice(
        takeProfit,
        decimals
      ),

    rr:
      riskReward == null
        ? null
        : Number(
            riskReward.toFixed(2)
          ),

    reason,
    updatedAt,
  };
}

function resolveDedicatedScalpSignal(
  rawScalpSignals,
  pairKey,
  decimals
) {
  if (
    !rawScalpSignals ||
    typeof rawScalpSignals !==
      "object"
  ) {
    return {
      valid: false,

      reason:
        "data/scalp-signals.json is missing or unreadable",

      signal: null,

      meta: {
        available: false,
        pairFound: false,
        valid: false,
        decision: null,
        updatedAt: null,
        stale: null,
        recordCount: 0,
        timeframeCount: 0,
      },
    };
  }

  const rawRecords =
    collectDedicatedScalpPairRecords(
      rawScalpSignals,
      pairKey
    );

  if (
    rawRecords.length === 0
  ) {
    const sourceUpdatedAt =
      normalizeTime(
        firstString(
          rawScalpSignals.updatedAt,
          rawScalpSignals.generatedAt,
          rawScalpSignals.timestamp,
          rawScalpSignals.time
        )
      );

    return {
      valid: false,

      reason:
        `No dedicated scalp record found for ${pairKey}`,

      signal: null,

      meta: {
        available: true,
        pairFound: false,
        valid: false,
        decision: null,
        updatedAt:
          sourceUpdatedAt,
        stale:
          sourceUpdatedAt
            ? Date.now() -
                Date.parse(
                  sourceUpdatedAt
                ) >
              DAY_MS
            : null,
        recordCount: 0,
        timeframeCount: 0,
      },
    };
  }

  const parsedRecords =
    rawRecords
      .map(
        (record) =>
          parseDedicatedScalpRecord(
            record,
            rawScalpSignals,
            decimals
          )
      )
      .filter(Boolean);

  if (
    parsedRecords.length === 0
  ) {
    return {
      valid: false,

      reason:
        `Dedicated scalp records for ${pairKey} contain no valid decisions`,

      signal: null,

      meta: {
        available: true,
        pairFound: true,
        valid: false,
        decision: null,
        updatedAt: null,
        stale: null,
        recordCount: 0,
        timeframeCount: 0,
      },
    };
  }

  const recordsByMode =
    new Map();

  for (
    const record of
    parsedRecords
  ) {
    if (record.mode) {
      recordsByMode.set(
        record.mode,
        record
      );
    }
  }

  const record5m =
    recordsByMode.get("M5") ||
    null;

  const record15m =
    recordsByMode.get("M15") ||
    null;

  const record30m =
    recordsByMode.get("M30") ||
    null;

  let decision = "HOLD";
  let selectedRecord = null;
  let reason = null;

  if (record15m) {
    selectedRecord =
      record15m;

    if (
      record15m.decision ===
      "HOLD"
    ) {
      reason =
        record15m.reason ||
        "15-min anchor timeframe is not aligned";
    } else {
      const confirmations =
        (
          record5m &&
          record5m.decision ===
            record15m.decision
            ? 1
            : 0
        ) +
        (
          record30m &&
          record30m.decision ===
            record15m.decision
            ? 1
            : 0
        );

      if (
        confirmations >= 1
      ) {
        decision =
          record15m.decision;

        reason =
          "Dedicated scalp timeframes confirmed the 15-min anchor";
      } else {
        reason =
          "5-min and 30-min do not confirm the 15-min anchor";
      }
    }
  } else if (
    parsedRecords.length === 1
  ) {
    selectedRecord =
      parsedRecords[0];

    decision =
      selectedRecord.decision;

    reason =
      selectedRecord.reason ||
      "Single dedicated scalp record used for backward compatibility";
  } else {
    const buyRecords =
      parsedRecords.filter(
        (record) =>
          record.decision ===
          "BUY"
      );

    const sellRecords =
      parsedRecords.filter(
        (record) =>
          record.decision ===
          "SELL"
      );

    if (
      buyRecords.length >= 2 &&
      buyRecords.length >
        sellRecords.length
    ) {
      decision = "BUY";
      selectedRecord =
        buyRecords[0];
    } else if (
      sellRecords.length >= 2 &&
      sellRecords.length >
        buyRecords.length
    ) {
      decision = "SELL";
      selectedRecord =
        sellRecords[0];
    } else {
      decision = "HOLD";
      selectedRecord =
        parsedRecords[0];
    }

    reason =
      decision === "HOLD"
        ? "Dedicated scalp timeframes are mixed"
        : "Dedicated scalp decision selected by timeframe majority";
  }

  if (!selectedRecord) {
    selectedRecord =
      parsedRecords[0];
  }

  const timestamps =
    parsedRecords
      .map(
        (record) =>
          record.updatedAt
      )
      .filter(Boolean)
      .sort(
        (a, b) =>
          Date.parse(a) -
          Date.parse(b)
      );

  const updatedAt =
    timestamps.length
      ? timestamps[
          timestamps.length - 1
        ]
      : normalizeTime(
          firstString(
            rawScalpSignals.updatedAt,
            rawScalpSignals.generatedAt,
            rawScalpSignals.timestamp,
            rawScalpSignals.time
          )
        );

  const perTF = [
    {
      tf: "5m",
      signal:
        record5m
          ? record5m.decision
          : "HOLD",
    },
    {
      tf: "15m",
      signal:
        record15m
          ? record15m.decision
          : "HOLD",
    },
    {
      tf: "30m",
      signal:
        record30m
          ? record30m.decision
          : "HOLD",
    },
  ];

  return {
    valid: true,
    reason: null,

    signal: {
      decision,
      reason,
      perTF,

      entry:
        decision === "HOLD"
          ? null
          : selectedRecord.entry,

      sl:
        decision === "HOLD"
          ? null
          : selectedRecord.sl,

      tp:
        decision === "HOLD"
          ? null
          : selectedRecord.tp,

      rr:
        decision === "HOLD"
          ? null
          : selectedRecord.rr,

      source:
        "scalp-signals.json",

      sourceMode:
        "primary",

      updatedAt,
    },

    meta: {
      available: true,
      pairFound: true,
      valid: true,
      decision,
      updatedAt,

      stale:
        updatedAt
          ? Date.now() -
              Date.parse(
                updatedAt
              ) >
            DAY_MS
          : null,

      recordCount:
        parsedRecords.length,

      timeframeCount:
        recordsByMode.size,
    },
  };
}

// ========================================================
// Indicator Helpers
// ========================================================

function emaSeries(
  values,
  period
) {
  if (
    !Array.isArray(values) ||
    !Number.isInteger(period) ||
    period < 1
  ) {
    return [];
  }

  const output =
    new Array(
      values.length
    ).fill(null);

  if (
    values.length < period
  ) {
    return output;
  }

  const multiplier =
    2 / (period + 1);

  let previous =
    values
      .slice(0, period)
      .reduce(
        (sum, value) =>
          sum + value,
        0
      ) / period;

  output[
    period - 1
  ] = previous;

  for (
    let index = period;
    index < values.length;
    index += 1
  ) {
    previous =
      values[index] *
        multiplier +
      previous *
        (1 - multiplier);

    output[index] =
      previous;
  }

  return output;
}

function rsiSeries(
  values,
  period = 14
) {
  if (
    !Array.isArray(values)
  ) {
    return [];
  }

  const output =
    new Array(
      values.length
    ).fill(null);

  if (
    !Number.isInteger(period) ||
    period < 1 ||
    values.length <= period
  ) {
    return output;
  }

  let gainSum = 0;
  let lossSum = 0;

  for (
    let index = 1;
    index <= period;
    index += 1
  ) {
    const difference =
      values[index] -
      values[index - 1];

    if (
      difference >= 0
    ) {
      gainSum += difference;
    } else {
      lossSum -= difference;
    }
  }

  let averageGain =
    gainSum / period;

  let averageLoss =
    lossSum / period;

  output[period] =
    averageLoss === 0
      ? 100
      : 100 -
        100 /
          (
            1 +
            averageGain /
              averageLoss
          );

  for (
    let index =
      period + 1;
    index < values.length;
    index += 1
  ) {
    const difference =
      values[index] -
      values[index - 1];

    const gain =
      difference > 0
        ? difference
        : 0;

    const loss =
      difference < 0
        ? -difference
        : 0;

    averageGain =
      (
        averageGain *
          (period - 1) +
        gain
      ) / period;

    averageLoss =
      (
        averageLoss *
          (period - 1) +
        loss
      ) / period;

    output[index] =
      averageLoss === 0
        ? 100
        : 100 -
          100 /
            (
              1 +
              averageGain /
                averageLoss
            );
  }

  return output;
}

function computeVolatility(
  rows
) {
  if (
    !Array.isArray(rows) ||
    rows.length < 3
  ) {
    return 0.004;
  }

  let totalMove = 0;
  let count = 0;

  for (
    let index = 1;
    index < rows.length;
    index += 1
  ) {
    const previousClose =
      rows[index - 1]
        .close;

    const currentClose =
      rows[index].close;

    if (
      !isFiniteNumber(
        previousClose
      ) ||
      !isFiniteNumber(
        currentClose
      ) ||
      previousClose <= 0
    ) {
      continue;
    }

    totalMove +=
      Math.abs(
        currentClose -
          previousClose
      ) / previousClose;

    count += 1;
  }

  return count
    ? totalMove / count
    : 0.004;
}

function computeATR(
  ohlcRows,
  period = 14
) {
  if (
    !Array.isArray(
      ohlcRows
    ) ||
    !Number.isInteger(period) ||
    period < 1 ||
    ohlcRows.length <
      period + 1
  ) {
    return null;
  }

  const trueRanges = [];

  for (
    let index = 1;
    index <
      ohlcRows.length;
    index += 1
  ) {
    const current =
      ohlcRows[index];

    const previous =
      ohlcRows[
        index - 1
      ];

    trueRanges.push(
      Math.max(
        current.high -
          current.low,

        Math.abs(
          current.high -
            previous.close
        ),

        Math.abs(
          current.low -
            previous.close
        )
      )
    );
  }

  if (
    trueRanges.length <
    period
  ) {
    return null;
  }

  let atr =
    trueRanges
      .slice(0, period)
      .reduce(
        (sum, value) =>
          sum + value,
        0
      ) / period;

  for (
    let index = period;
    index <
      trueRanges.length;
    index += 1
  ) {
    atr =
      (
        atr *
          (period - 1) +
        trueRanges[index]
      ) / period;
  }

  return atr;
}

function computeADX(
  ohlcRows,
  period = 14
) {
  if (
    !Array.isArray(
      ohlcRows
    ) ||
    !Number.isInteger(period) ||
    period < 1 ||
    ohlcRows.length <
      period * 2 + 1
  ) {
    return null;
  }

  const trueRanges = [];
  const plusDM = [];
  const minusDM = [];

  for (
    let index = 1;
    index <
      ohlcRows.length;
    index += 1
  ) {
    const current =
      ohlcRows[index];

    const previous =
      ohlcRows[
        index - 1
      ];

    trueRanges.push(
      Math.max(
        current.high -
          current.low,

        Math.abs(
          current.high -
            previous.close
        ),

        Math.abs(
          current.low -
            previous.close
        )
      )
    );

    const upwardMove =
      current.high -
      previous.high;

    const downwardMove =
      previous.low -
      current.low;

    plusDM.push(
      upwardMove >
        downwardMove &&
      upwardMove > 0
        ? upwardMove
        : 0
    );

    minusDM.push(
      downwardMove >
        upwardMove &&
      downwardMove > 0
        ? downwardMove
        : 0
    );
  }

  let smoothedTR = 0;
  let smoothedPlusDM = 0;
  let smoothedMinusDM = 0;

  for (
    let index = 0;
    index < period;
    index += 1
  ) {
    smoothedTR +=
      trueRanges[index];

    smoothedPlusDM +=
      plusDM[index];

    smoothedMinusDM +=
      minusDM[index];
  }

  const dxSeries = [];

  for (
    let index = period;
    index <
      trueRanges.length;
    index += 1
  ) {
    smoothedTR =
      smoothedTR -
      smoothedTR /
        period +
      trueRanges[index];

    smoothedPlusDM =
      smoothedPlusDM -
      smoothedPlusDM /
        period +
      plusDM[index];

    smoothedMinusDM =
      smoothedMinusDM -
      smoothedMinusDM /
        period +
      minusDM[index];

    const plusDI =
      smoothedTR === 0
        ? 0
        : 100 *
          (
            smoothedPlusDM /
            smoothedTR
          );

    const minusDI =
      smoothedTR === 0
        ? 0
        : 100 *
          (
            smoothedMinusDM /
            smoothedTR
          );

    const denominator =
      plusDI + minusDI;

    const dx =
      denominator === 0
        ? 0
        : (
            100 *
            Math.abs(
              plusDI -
                minusDI
            )
          ) /
          denominator;

    dxSeries.push(dx);
  }

  if (
    dxSeries.length <
    period
  ) {
    return null;
  }

  let adx =
    dxSeries
      .slice(0, period)
      .reduce(
        (sum, value) =>
          sum + value,
        0
      ) / period;

  for (
    let index = period;
    index <
      dxSeries.length;
    index += 1
  ) {
    adx =
      (
        adx *
          (period - 1) +
        dxSeries[index]
      ) / period;
  }

  return adx;
}

function computeSR(
  rows,
  lastClose
) {
  if (
    !Array.isArray(rows) ||
    rows.length === 0 ||
    !isFiniteNumber(
      lastClose
    )
  ) {
    return {
      resistances: [],
      supports: [],
    };
  }

  const closes =
    rows
      .map(
        (row) =>
          row.close
      )
      .filter(
        isFiniteNumber
      );

  const count =
    closes.length;

  if (count === 0) {
    return {
      resistances: [],
      supports: [],
    };
  }

  const radius =
    count > 40
      ? 2
      : 1;

  const swingHighs = [];
  const swingLows = [];

  for (
    let index = radius;
    index <
      count - radius;
    index += 1
  ) {
    let isHigh = true;
    let isLow = true;

    for (
      let offset = 1;
      offset <= radius;
      offset += 1
    ) {
      if (
        closes[index] <
          closes[
            index - offset
          ] ||
        closes[index] <
          closes[
            index + offset
          ]
      ) {
        isHigh = false;
      }

      if (
        closes[index] >
          closes[
            index - offset
          ] ||
        closes[index] >
          closes[
            index + offset
          ]
      ) {
        isLow = false;
      }
    }

    if (isHigh) {
      swingHighs.push(
        closes[index]
      );
    }

    if (isLow) {
      swingLows.push(
        closes[index]
      );
    }
  }

  function dedupeLevels(
    levels
  ) {
    const sorted =
      [...levels].sort(
        (a, b) =>
          a - b
      );

    const output = [];

    for (
      const level of sorted
    ) {
      const previous =
        output[
          output.length - 1
        ];

      if (
        previous == null ||
        Math.abs(
          level - previous
        ) / level >
          0.0015
      ) {
        output.push(level);
      } else {
        output[
          output.length - 1
        ] =
          (
            previous +
            level
          ) / 2;
      }
    }

    return output;
  }

  let resistances =
    dedupeLevels(
      swingHighs
    )
      .filter(
        (level) =>
          level >
          lastClose
      )
      .sort(
        (a, b) =>
          a - b
      )
      .slice(0, 2);

  let supports =
    dedupeLevels(
      swingLows
    )
      .filter(
        (level) =>
          level <
          lastClose
      )
      .sort(
        (a, b) =>
          b - a
      )
      .slice(0, 2);

  if (
    resistances.length ===
      0 &&
    count >= 3
  ) {
    const maximumClose =
      Math.max(
        ...closes
      );

    if (
      maximumClose >
      lastClose *
        1.0005
    ) {
      resistances = [
        maximumClose,
      ];
    }
  }

  if (
    supports.length ===
      0 &&
    count >= 3
  ) {
    const minimumClose =
      Math.min(
        ...closes
      );

    if (
      minimumClose <
      lastClose *
        0.9995
    ) {
      supports = [
        minimumClose,
      ];
    }
  }

  return {
    resistances,
    supports,
  };
}

function detectCandlePattern(
  ohlcRows,
  leanDirection
) {
  if (
    !Array.isArray(
      ohlcRows
    ) ||
    ohlcRows.length < 2 ||
    !leanDirection
  ) {
    return {
      ok: false,
      detail:
        "Not enough candle history",
    };
  }

  const last =
    ohlcRows[
      ohlcRows.length - 1
    ];

  const previous =
    ohlcRows[
      ohlcRows.length - 2
    ];

  const range =
    last.high -
    last.low;

  const body =
    Math.abs(
      last.close -
      last.open
    );

  const bodyPercentage =
    range > 0
      ? body / range
      : 0;

  if (
    leanDirection ===
    "BUY"
  ) {
    const bullishEngulfing =
      previous.close <
        previous.open &&
      last.close >
        last.open &&
      last.open <=
        previous.close &&
      last.close >=
        previous.open;

    if (
      bullishEngulfing
    ) {
      return {
        ok: true,
        detail:
          "Bullish engulfing on the latest candle",
      };
    }

    if (
      last.close >
        last.open &&
      bodyPercentage > 0.6
    ) {
      return {
        ok: true,
        detail:
          `Strong bullish candle ` +
          `(body ${(
            bodyPercentage *
            100
          ).toFixed(
            0
          )}% of range)`,
      };
    }

    return {
      ok: false,
      detail:
        "Latest candle doesn't confirm a bullish pattern",
    };
  }

  const bearishEngulfing =
    previous.close >
      previous.open &&
    last.close <
      last.open &&
    last.open >=
      previous.close &&
    last.close <=
      previous.open;

  if (
    bearishEngulfing
  ) {
    return {
      ok: true,
      detail:
        "Bearish engulfing on the latest candle",
    };
  }

  if (
    last.close <
      last.open &&
    bodyPercentage > 0.6
  ) {
    return {
      ok: true,
      detail:
        `Strong bearish candle ` +
        `(body ${(
          bodyPercentage *
          100
        ).toFixed(
          0
        )}% of range)`,
    };
  }

  return {
    ok: false,
    detail:
      "Latest candle doesn't confirm a bearish pattern",
  };
}

// ========================================================
// Trend Helpers
// ========================================================

function adaptiveEmaPeriods(
  rowCount
) {
  if (
    !Number.isInteger(
      rowCount
    ) ||
    rowCount < 6
  ) {
    return null;
  }

  const cap =
    rowCount - 1;

  const p200 =
    Math.min(
      200,
      cap
    );

  const p100 =
    Math.min(
      100,
      Math.max(
        4,
        Math.floor(
          p200 * 0.5
        )
      )
    );

  const p50 =
    Math.min(
      50,
      Math.max(
        3,
        Math.floor(
          p100 * 0.6
        )
      )
    );

  const p20 =
    Math.min(
      20,
      Math.max(
        2,
        Math.floor(
          p50 * 0.5
        )
      )
    );

  return {
    p20,
    p50,
    p100,
    p200,
    fullStack:
      cap >= 200,
  };
}

function calculateTrendState(
  rows
) {
  if (
    !Array.isArray(rows) ||
    rows.length < 6
  ) {
    return {
      direction: null,

      label:
        "Building history — not enough sessions yet",

      values: null,
      periods: null,
    };
  }

  const closes =
    rows
      .map(
        (row) =>
          row.close
      )
      .filter(
        isFiniteNumber
      );

  if (
    closes.length < 6
  ) {
    return {
      direction: null,

      label:
        "Building history — valid close history is not ready",

      values: null,
      periods: null,
    };
  }

  const periods =
    adaptiveEmaPeriods(
      closes.length
    );

  if (!periods) {
    return {
      direction: null,

      label:
        "Building history — not enough sessions yet",

      values: null,
      periods: null,
    };
  }

  const {
    p20,
    p50,
    p100,
    p200,
    fullStack,
  } = periods;

  const ema20 =
    emaSeries(
      closes,
      p20
    );

  const ema50 =
    emaSeries(
      closes,
      p50
    );

  const ema100 =
    emaSeries(
      closes,
      p100
    );

  const ema200 =
    emaSeries(
      closes,
      p200
    );

  const lastIndex =
    closes.length - 1;

  const lastClose =
    closes[lastIndex];

  const values = {
    v20:
      ema20[lastIndex],

    v50:
      ema50[lastIndex],

    v100:
      ema100[lastIndex],

    v200:
      ema200[lastIndex],
  };

  const {
    v20,
    v50,
    v100,
    v200,
  } = values;

  if (
    v20 == null ||
    v50 == null ||
    v100 == null ||
    v200 == null
  ) {
    return {
      direction: null,

      label:
        "Building history — EMA values are not ready",

      values,
      periods,
    };
  }

  const bullishChecks = [
    v20 > v50,
    v50 > v100,
    v100 > v200,
    lastClose > v20,
  ];

  const bearishChecks = [
    v20 < v50,
    v50 < v100,
    v100 < v200,
    lastClose < v20,
  ];

  const bullishCount =
    bullishChecks
      .filter(Boolean)
      .length;

  const bearishCount =
    bearishChecks
      .filter(Boolean)
      .length;

  const note =
    fullStack
      ? ""
      : " (adaptive periods — full EMA200 needs more history)";

  if (
    bullishCount === 4
  ) {
    return {
      direction: "BUY",

      label:
        `Bullish — full EMA stack ` +
        `${p20}>${p50}>${p100}>${p200}` +
        note,

      values,
      periods,
    };
  }

  if (
    bearishCount === 4
  ) {
    return {
      direction: "SELL",

      label:
        `Bearish — full EMA stack ` +
        `${p20}<${p50}<${p100}<${p200}` +
        note,

      values,
      periods,
    };
  }

  if (
    bullishCount >= 3
  ) {
    return {
      direction: null,

      label:
        `Partial bullish lean only ` +
        `(${bullishCount}/4) — not enough to qualify` +
        note,

      values,
      periods,
    };
  }

  if (
    bearishCount >= 3
  ) {
    return {
      direction: null,

      label:
        `Partial bearish lean only ` +
        `(${bearishCount}/4) — not enough to qualify` +
        note,

      values,
      periods,
    };
  }

  return {
    direction: null,

    label:
      `Mixed EMA alignment — no clear trend` +
      note,

    values,
    periods,
  };
}

function trendDirectionOf(
  rows
) {
  return calculateTrendState(
    rows
  ).direction;
}

// ============================================================================
// PART 4 — CANDLE AGGREGATION + WEEKLY AGGREGATION
//          + LEGACY-COMPATIBLE ANALYSIS PIPELINE
// ============================================================================
//
// This section:
// - Normalizes mixed candle formats without changing upstream JSON files.
// - Aggregates lower-timeframe candles safely.
// - Builds UTC daily and Monday-based UTC weekly candles.
// - Preserves completed candles and optionally includes the active candle.
// - Provides indicator calculations required by the live analysis engines.
// - Produces a legacy-compatible analysis result.
// - Keeps WAIT/NEUTRAL-style decisions normalized to HOLD.
// - Does not change Telegram, history, notification or output-writing logic.
//
// Expected integration:
// - Part 1: constants/configuration
// - Part 2: JSON safety, normalization and shared helpers
// - Part 3: input loading / signal-source preparation
// - Part 4: this section
// ============================================================================


// ---------------------------------------------------------------------------
// Candle field helpers
// ---------------------------------------------------------------------------

function candleNumber(value, fallback = null) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function candleInteger(value, fallback = null) {
  const parsed = candleNumber(value, fallback);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function firstDefinedValue(object, keys, fallback = undefined) {
  if (!object || typeof object !== "object") {
    return fallback;
  }

  for (const key of keys) {
    if (
      Object.prototype.hasOwnProperty.call(object, key) &&
      object[key] !== null &&
      object[key] !== undefined &&
      object[key] !== ""
    ) {
      return object[key];
    }
  }

  return fallback;
}

function normalizeTimestampMs(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : null;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return null;
    }

    // Seconds timestamp.
    if (value > 0 && value < 10_000_000_000) {
      return Math.trunc(value * 1000);
    }

    // Microseconds timestamp.
    if (value >= 10_000_000_000_000 && value < 10_000_000_000_000_000) {
      return Math.trunc(value / 1000);
    }

    // Nanoseconds timestamp.
    if (value >= 10_000_000_000_000_000) {
      return Math.trunc(value / 1_000_000);
    }

    return Math.trunc(value);
  }

  const raw = String(value).trim();

  if (!raw) {
    return null;
  }

  if (/^-?\d+(\.\d+)?$/.test(raw)) {
    return normalizeTimestampMs(Number(raw));
  }

  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractCandleTimestampMs(rawCandle) {
  if (!rawCandle || typeof rawCandle !== "object") {
    return null;
  }

  return normalizeTimestampMs(
    firstDefinedValue(rawCandle, [
      "timestamp",
      "timestampMs",
      "time",
      "datetime",
      "dateTime",
      "date",
      "openTime",
      "open_time",
      "startTime",
      "start_time",
      "t",
      "x",
    ])
  );
}

function extractCandleCloseTimestampMs(rawCandle) {
  if (!rawCandle || typeof rawCandle !== "object") {
    return null;
  }

  return normalizeTimestampMs(
    firstDefinedValue(rawCandle, [
      "closeTimestamp",
      "closeTimestampMs",
      "closeTime",
      "close_time",
      "endTime",
      "end_time",
      "closedAt",
    ])
  );
}

function normalizeBooleanValue(value, fallback = null) {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();

    if (
      normalized === "true" ||
      normalized === "yes" ||
      normalized === "closed" ||
      normalized === "complete" ||
      normalized === "completed" ||
      normalized === "final"
    ) {
      return true;
    }

    if (
      normalized === "false" ||
      normalized === "no" ||
      normalized === "open" ||
      normalized === "active" ||
      normalized === "forming" ||
      normalized === "incomplete"
    ) {
      return false;
    }
  }

  return fallback;
}


// ---------------------------------------------------------------------------
// Canonical candle normalization
// ---------------------------------------------------------------------------

function normalizeLiveCandle(rawCandle, options = {}) {
  if (!rawCandle || typeof rawCandle !== "object") {
    return null;
  }

  const timestamp = extractCandleTimestampMs(rawCandle);

  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return null;
  }

  const rawOpen = firstDefinedValue(rawCandle, [
    "open",
    "Open",
    "o",
    "priceOpen",
    "openPrice",
  ]);

  const rawHigh = firstDefinedValue(rawCandle, [
    "high",
    "High",
    "h",
    "priceHigh",
    "highPrice",
  ]);

  const rawLow = firstDefinedValue(rawCandle, [
    "low",
    "Low",
    "l",
    "priceLow",
    "lowPrice",
  ]);

  const rawClose = firstDefinedValue(rawCandle, [
    "close",
    "Close",
    "c",
    "price",
    "last",
    "value",
    "priceClose",
    "closePrice",
  ]);

  let open = candleNumber(rawOpen);
  let high = candleNumber(rawHigh);
  let low = candleNumber(rawLow);
  let close = candleNumber(rawClose);

  // Legacy close-only rows remain supported.
  if (!Number.isFinite(close)) {
    close = candleNumber(
      firstDefinedValue(rawCandle, ["mid", "bid", "ask"])
    );
  }

  if (!Number.isFinite(close) || close <= 0) {
    return null;
  }

  if (!Number.isFinite(open)) {
    open = close;
  }

  if (!Number.isFinite(high)) {
    high = Math.max(open, close);
  }

  if (!Number.isFinite(low)) {
    low = Math.min(open, close);
  }

  // Repair malformed provider values without rejecting otherwise usable data.
  high = Math.max(high, open, close);
  low = Math.min(low, open, close);

  if (
    !Number.isFinite(open) ||
    !Number.isFinite(high) ||
    !Number.isFinite(low) ||
    !Number.isFinite(close) ||
    open <= 0 ||
    high <= 0 ||
    low <= 0 ||
    close <= 0 ||
    high < low
  ) {
    return null;
  }

  const volume = Math.max(
    0,
    candleNumber(
      firstDefinedValue(rawCandle, [
        "volume",
        "Volume",
        "v",
        "tickVolume",
        "tick_volume",
        "realVolume",
        "real_volume",
      ]),
      0
    )
  );

  const closeTimestamp =
    extractCandleCloseTimestampMs(rawCandle) ??
    candleNumber(options.defaultCloseTimestamp, null);

  const explicitClosed = normalizeBooleanValue(
    firstDefinedValue(rawCandle, [
      "closed",
      "isClosed",
      "is_closed",
      "complete",
      "completed",
      "isComplete",
      "is_complete",
      "final",
      "isFinal",
    ]),
    null
  );

  const source = firstDefinedValue(
    rawCandle,
    ["source", "provider", "feed"],
    options.source || null
  );

  const normalized = {
    timestamp,
    time: new Date(timestamp).toISOString(),
    open,
    high,
    low,
    close,
    volume,
  };

  if (Number.isFinite(closeTimestamp)) {
    normalized.closeTimestamp = closeTimestamp;
    normalized.closeTime = new Date(closeTimestamp).toISOString();
  }

  if (explicitClosed !== null) {
    normalized.closed = explicitClosed;
  }

  if (source) {
    normalized.source = String(source);
  }

  return normalized;
}

function normalizeLiveCandleArray(rawRows, options = {}) {
  const sourceRows = Array.isArray(rawRows) ? rawRows : [];
  const byTimestamp = new Map();

  for (const rawRow of sourceRows) {
    const candle = normalizeLiveCandle(rawRow, options);

    if (!candle) {
      continue;
    }

    // Latest duplicate wins. This preserves provider corrections to a candle.
    byTimestamp.set(candle.timestamp, candle);
  }

  const rows = [...byTimestamp.values()].sort(
    (left, right) => left.timestamp - right.timestamp
  );

  const maxRows = Math.max(
    0,
    candleInteger(options.maxRows, 0) || 0
  );

  if (maxRows > 0 && rows.length > maxRows) {
    return rows.slice(-maxRows);
  }

  return rows;
}


// ---------------------------------------------------------------------------
// Timeframe parsing and bucket calculation
// ---------------------------------------------------------------------------

const LIVE_TIMEFRAME_MS = Object.freeze({
  M1: 60 * 1000,
  M2: 2 * 60 * 1000,
  M3: 3 * 60 * 1000,
  M5: 5 * 60 * 1000,
  M10: 10 * 60 * 1000,
  M15: 15 * 60 * 1000,
  M20: 20 * 60 * 1000,
  M30: 30 * 60 * 1000,
  M45: 45 * 60 * 1000,

  H1: 60 * 60 * 1000,
  H2: 2 * 60 * 60 * 1000,
  H3: 3 * 60 * 60 * 1000,
  H4: 4 * 60 * 60 * 1000,
  H6: 6 * 60 * 60 * 1000,
  H8: 8 * 60 * 60 * 1000,
  H12: 12 * 60 * 60 * 1000,

  D1: 24 * 60 * 60 * 1000,
  W1: 7 * 24 * 60 * 60 * 1000,
});

function normalizeLiveTimeframe(value, fallback = "H1") {
  const raw = String(value || fallback)
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");

  const aliases = {
    "1M": "M1",
    "2M": "M2",
    "3M": "M3",
    "5M": "M5",
    "10M": "M10",
    "15M": "M15",
    "20M": "M20",
    "30M": "M30",
    "45M": "M45",

    "1H": "H1",
    "2H": "H2",
    "3H": "H3",
    "4H": "H4",
    "6H": "H6",
    "8H": "H8",
    "12H": "H12",

    "1D": "D1",
    DAY: "D1",
    DAILY: "D1",

    "1W": "W1",
    WEEK: "W1",
    WEEKLY: "W1",
  };

  const normalized = aliases[raw] || raw;

  if (Object.prototype.hasOwnProperty.call(LIVE_TIMEFRAME_MS, normalized)) {
    return normalized;
  }

  return fallback;
}

function liveTimeframeMs(value, fallback = "H1") {
  const timeframe = normalizeLiveTimeframe(value, fallback);
  return LIVE_TIMEFRAME_MS[timeframe] || LIVE_TIMEFRAME_MS[fallback];
}

function utcDayBucketStart(timestamp) {
  const date = new Date(timestamp);

  return Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate()
  );
}

function utcWeekBucketStart(timestamp) {
  const date = new Date(timestamp);

  const dayStart = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate()
  );

  // JavaScript UTC day: Sunday=0 ... Saturday=6.
  // Convert to ISO-style Monday=0 ... Sunday=6.
  const mondayOffsetDays = (date.getUTCDay() + 6) % 7;

  return dayStart - mondayOffsetDays * LIVE_TIMEFRAME_MS.D1;
}

function liveBucketStart(timestamp, timeframe) {
  const normalizedTimeframe = normalizeLiveTimeframe(timeframe);

  if (normalizedTimeframe === "D1") {
    return utcDayBucketStart(timestamp);
  }

  if (normalizedTimeframe === "W1") {
    return utcWeekBucketStart(timestamp);
  }

  const intervalMs = liveTimeframeMs(normalizedTimeframe);
  return Math.floor(timestamp / intervalMs) * intervalMs;
}


// ---------------------------------------------------------------------------
// Generic OHLC aggregation
// ---------------------------------------------------------------------------

function aggregateLiveCandles(rawRows, timeframe, options = {}) {
  const normalizedTimeframe = normalizeLiveTimeframe(timeframe);
  const intervalMs = liveTimeframeMs(normalizedTimeframe);
  const nowMs = candleNumber(options.nowMs, Date.now());
  const includeActive = options.includeActive !== false;

  const rows = normalizeLiveCandleArray(rawRows, {
    source: options.source,
  });

  if (rows.length === 0) {
    return [];
  }

  const buckets = new Map();

  for (const row of rows) {
    const bucketTimestamp = liveBucketStart(
      row.timestamp,
      normalizedTimeframe
    );

    let bucket = buckets.get(bucketTimestamp);

    if (!bucket) {
      bucket = {
        timestamp: bucketTimestamp,
        time: new Date(bucketTimestamp).toISOString(),

        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        volume: row.volume || 0,

        sourceCount: 1,
        firstSourceTimestamp: row.timestamp,
        lastSourceTimestamp: row.timestamp,
      };

      buckets.set(bucketTimestamp, bucket);
      continue;
    }

    bucket.high = Math.max(bucket.high, row.high);
    bucket.low = Math.min(bucket.low, row.low);
    bucket.close = row.close;
    bucket.volume += row.volume || 0;
    bucket.sourceCount += 1;
    bucket.lastSourceTimestamp = row.timestamp;
  }

  let aggregated = [...buckets.values()].sort(
    (left, right) => left.timestamp - right.timestamp
  );

  aggregated = aggregated.map((bucket) => {
    const closeTimestamp = bucket.timestamp + intervalMs;
    const closed = closeTimestamp <= nowMs;

    return {
      timestamp: bucket.timestamp,
      time: bucket.time,

      open: bucket.open,
      high: bucket.high,
      low: bucket.low,
      close: bucket.close,
      volume: bucket.volume,

      closeTimestamp,
      closeTime: new Date(closeTimestamp).toISOString(),
      closed,

      timeframe: normalizedTimeframe,
      sourceCount: bucket.sourceCount,
      firstSourceTimestamp: bucket.firstSourceTimestamp,
      lastSourceTimestamp: bucket.lastSourceTimestamp,
    };
  });

  if (!includeActive) {
    aggregated = aggregated.filter((row) => row.closed);
  }

  const maxRows = Math.max(
    0,
    candleInteger(options.maxRows, 0) || 0
  );

  if (maxRows > 0 && aggregated.length > maxRows) {
    aggregated = aggregated.slice(-maxRows);
  }

  return aggregated;
}

function aggregateDailyCandles(rawRows, options = {}) {
  return aggregateLiveCandles(rawRows, "D1", options);
}

function aggregateWeeklyCandles(rawRows, options = {}) {
  return aggregateLiveCandles(rawRows, "W1", options);
}


// ---------------------------------------------------------------------------
// Weekly aggregation preserving legacy-compatible date fields
// ---------------------------------------------------------------------------

function buildLegacyWeeklyCandles(rawDailyRows, options = {}) {
  const weeklyRows = aggregateWeeklyCandles(rawDailyRows, {
    ...options,
    includeActive: options.includeActive !== false,
  });

  return weeklyRows.map((row) => {
    const isoDate = row.time.slice(0, 10);

    return {
      timestamp: row.timestamp,
      time: row.time,
      date: isoDate,

      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: row.volume,

      closeTimestamp: row.closeTimestamp,
      closeTime: row.closeTime,
      closed: row.closed,

      timeframe: "W1",
      sourceCount: row.sourceCount,
    };
  });
}


// ---------------------------------------------------------------------------
// Candle-frame preparation
// ---------------------------------------------------------------------------

function prepareLiveAnalysisFrames(input = {}) {
  const scalpRows = normalizeLiveCandleArray(
    input.scalpCandles || input.scalpRows || [],
    {
      source: "scalp",
      maxRows: input.maxScalpRows || 5000,
    }
  );

  const intradayRows = normalizeLiveCandleArray(
    input.intradayCandles ||
      input.intradayRows ||
      input.h1Candles ||
      input.h1Rows ||
      [],
    {
      source: "intraday",
      maxRows: input.maxIntradayRows || 3000,
    }
  );

  const suppliedDailyRows = normalizeLiveCandleArray(
    input.dailyCandles ||
      input.dailyRows ||
      input.dailyOhlc ||
      [],
    {
      source: "daily",
      maxRows: input.maxDailyRows || 1500,
    }
  );

  const derivedH1Rows =
    intradayRows.length > 0
      ? intradayRows
      : aggregateLiveCandles(scalpRows, "H1", {
          includeActive: true,
          maxRows: input.maxIntradayRows || 3000,
          source: "scalp-derived-h1",
        });

  const derivedDailyRows =
    suppliedDailyRows.length > 0
      ? suppliedDailyRows
      : aggregateDailyCandles(derivedH1Rows, {
          includeActive: true,
          maxRows: input.maxDailyRows || 1500,
          source: "h1-derived-d1",
        });

  const weeklyRows = buildLegacyWeeklyCandles(derivedDailyRows, {
    includeActive: true,
    maxRows: input.maxWeeklyRows || 500,
    source: "daily-derived-w1",
  });

  return {
    scalp: scalpRows,
    intraday: derivedH1Rows,
    daily: derivedDailyRows,
    weekly: weeklyRows,

    metadata: {
      scalpCount: scalpRows.length,
      intradayCount: derivedH1Rows.length,
      dailyCount: derivedDailyRows.length,
      weeklyCount: weeklyRows.length,

      intradayDerived: intradayRows.length === 0 && scalpRows.length > 0,
      dailyDerived:
        suppliedDailyRows.length === 0 && derivedH1Rows.length > 0,
      weeklyDerived: derivedDailyRows.length > 0,
    },
  };
}


// ---------------------------------------------------------------------------
// Indicator helpers
// ---------------------------------------------------------------------------

function liveCloseValues(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => candleNumber(row && row.close))
    .filter((value) => Number.isFinite(value));
}

function liveLastFinite(values) {
  if (!Array.isArray(values)) {
    return null;
  }

  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (Number.isFinite(values[index])) {
      return values[index];
    }
  }

  return null;
}

function liveSma(values, period) {
  const source = Array.isArray(values) ? values : [];
  const safePeriod = Math.max(1, candleInteger(period, 1));
  const output = Array(source.length).fill(null);

  if (source.length < safePeriod) {
    return output;
  }

  let rollingSum = 0;
  let finiteCount = 0;

  for (let index = 0; index < source.length; index += 1) {
    const value = source[index];

    if (Number.isFinite(value)) {
      rollingSum += value;
      finiteCount += 1;
    }

    if (index >= safePeriod) {
      const removed = source[index - safePeriod];

      if (Number.isFinite(removed)) {
        rollingSum -= removed;
        finiteCount -= 1;
      }
    }

    if (index >= safePeriod - 1 && finiteCount === safePeriod) {
      output[index] = rollingSum / safePeriod;
    }
  }

  return output;
}

function liveEma(values, period) {
  const source = Array.isArray(values) ? values : [];
  const safePeriod = Math.max(1, candleInteger(period, 1));
  const output = Array(source.length).fill(null);

  if (source.length < safePeriod) {
    return output;
  }

  let seedSum = 0;

  for (let index = 0; index < safePeriod; index += 1) {
    if (!Number.isFinite(source[index])) {
      return output;
    }

    seedSum += source[index];
  }

  const multiplier = 2 / (safePeriod + 1);
  let previous = seedSum / safePeriod;

  output[safePeriod - 1] = previous;

  for (let index = safePeriod; index < source.length; index += 1) {
    const value = source[index];

    if (!Number.isFinite(value)) {
      output[index] = previous;
      continue;
    }

    previous = (value - previous) * multiplier + previous;
    output[index] = previous;
  }

  return output;
}

function liveRsi(values, period = 14) {
  const source = Array.isArray(values) ? values : [];
  const safePeriod = Math.max(2, candleInteger(period, 14));
  const output = Array(source.length).fill(null);

  if (source.length <= safePeriod) {
    return output;
  }

  let gainSum = 0;
  let lossSum = 0;

  for (let index = 1; index <= safePeriod; index += 1) {
    const current = source[index];
    const previous = source[index - 1];

    if (!Number.isFinite(current) || !Number.isFinite(previous)) {
      return output;
    }

    const change = current - previous;

    if (change > 0) {
      gainSum += change;
    } else {
      lossSum += Math.abs(change);
    }
  }

  let averageGain = gainSum / safePeriod;
  let averageLoss = lossSum / safePeriod;

  if (averageLoss === 0) {
    output[safePeriod] = averageGain === 0 ? 50 : 100;
  } else {
    const relativeStrength = averageGain / averageLoss;
    output[safePeriod] = 100 - 100 / (1 + relativeStrength);
  }

  for (
    let index = safePeriod + 1;
    index < source.length;
    index += 1
  ) {
    const current = source[index];
    const previous = source[index - 1];

    if (!Number.isFinite(current) || !Number.isFinite(previous)) {
      output[index] = output[index - 1];
      continue;
    }

    const change = current - previous;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;

    averageGain =
      (averageGain * (safePeriod - 1) + gain) / safePeriod;

    averageLoss =
      (averageLoss * (safePeriod - 1) + loss) / safePeriod;

    if (averageLoss === 0) {
      output[index] = averageGain === 0 ? 50 : 100;
    } else {
      const relativeStrength = averageGain / averageLoss;
      output[index] = 100 - 100 / (1 + relativeStrength);
    }
  }

  return output;
}

function liveTrueRangeSeries(rows) {
  const sourceRows = Array.isArray(rows) ? rows : [];
  const output = Array(sourceRows.length).fill(null);

  for (let index = 0; index < sourceRows.length; index += 1) {
    const row = sourceRows[index];
    const high = candleNumber(row && row.high);
    const low = candleNumber(row && row.low);

    if (!Number.isFinite(high) || !Number.isFinite(low)) {
      continue;
    }

    if (index === 0) {
      output[index] = high - low;
      continue;
    }

    const previousClose = candleNumber(
      sourceRows[index - 1] && sourceRows[index - 1].close
    );

    if (!Number.isFinite(previousClose)) {
      output[index] = high - low;
      continue;
    }

    output[index] = Math.max(
      high - low,
      Math.abs(high - previousClose),
      Math.abs(low - previousClose)
    );
  }

  return output;
}

function liveAtr(rows, period = 14) {
  const trueRanges = liveTrueRangeSeries(rows);
  const safePeriod = Math.max(2, candleInteger(period, 14));
  const output = Array(trueRanges.length).fill(null);

  if (trueRanges.length < safePeriod) {
    return output;
  }

  let seedSum = 0;

  for (let index = 0; index < safePeriod; index += 1) {
    if (!Number.isFinite(trueRanges[index])) {
      return output;
    }

    seedSum += trueRanges[index];
  }

  let previousAtr = seedSum / safePeriod;
  output[safePeriod - 1] = previousAtr;

  for (
    let index = safePeriod;
    index < trueRanges.length;
    index += 1
  ) {
    const currentTrueRange = trueRanges[index];

    if (!Number.isFinite(currentTrueRange)) {
      output[index] = previousAtr;
      continue;
    }

    previousAtr =
      (previousAtr * (safePeriod - 1) + currentTrueRange) /
      safePeriod;

    output[index] = previousAtr;
  }

  return output;
}

function liveMacd(
  values,
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9
) {
  const source = Array.isArray(values) ? values : [];
  const fast = liveEma(source, fastPeriod);
  const slow = liveEma(source, slowPeriod);

  const macdLine = source.map((_, index) => {
    if (
      !Number.isFinite(fast[index]) ||
      !Number.isFinite(slow[index])
    ) {
      return null;
    }

    return fast[index] - slow[index];
  });

  const compactMacdValues = [];
  const compactIndexes = [];

  for (let index = 0; index < macdLine.length; index += 1) {
    if (Number.isFinite(macdLine[index])) {
      compactMacdValues.push(macdLine[index]);
      compactIndexes.push(index);
    }
  }

  const compactSignal = liveEma(compactMacdValues, signalPeriod);
  const signalLine = Array(source.length).fill(null);

  for (let index = 0; index < compactIndexes.length; index += 1) {
    signalLine[compactIndexes[index]] = compactSignal[index];
  }

  const histogram = source.map((_, index) => {
    if (
      !Number.isFinite(macdLine[index]) ||
      !Number.isFinite(signalLine[index])
    ) {
      return null;
    }

    return macdLine[index] - signalLine[index];
  });

  return {
    macdLine,
    signalLine,
    histogram,
  };
}


// ---------------------------------------------------------------------------
// Market structure and support/resistance
// ---------------------------------------------------------------------------

function liveSwingPoints(rows, radius = 2) {
  const sourceRows = Array.isArray(rows) ? rows : [];
  const safeRadius = Math.max(1, candleInteger(radius, 2));

  const highs = [];
  const lows = [];

  for (
    let index = safeRadius;
    index < sourceRows.length - safeRadius;
    index += 1
  ) {
    const candidateHigh = candleNumber(sourceRows[index].high);
    const candidateLow = candleNumber(sourceRows[index].low);

    if (
      !Number.isFinite(candidateHigh) ||
      !Number.isFinite(candidateLow)
    ) {
      continue;
    }

    let isSwingHigh = true;
    let isSwingLow = true;

    for (
      let offset = 1;
      offset <= safeRadius;
      offset += 1
    ) {
      const previousHigh = candleNumber(
        sourceRows[index - offset].high
      );

      const nextHigh = candleNumber(
        sourceRows[index + offset].high
      );

      const previousLow = candleNumber(
        sourceRows[index - offset].low
      );

      const nextLow = candleNumber(
        sourceRows[index + offset].low
      );

      if (
        !Number.isFinite(previousHigh) ||
        !Number.isFinite(nextHigh) ||
        candidateHigh <= previousHigh ||
        candidateHigh < nextHigh
      ) {
        isSwingHigh = false;
      }

      if (
        !Number.isFinite(previousLow) ||
        !Number.isFinite(nextLow) ||
        candidateLow >= previousLow ||
        candidateLow > nextLow
      ) {
        isSwingLow = false;
      }
    }

    if (isSwingHigh) {
      highs.push({
        index,
        timestamp: sourceRows[index].timestamp,
        price: candidateHigh,
      });
    }

    if (isSwingLow) {
      lows.push({
        index,
        timestamp: sourceRows[index].timestamp,
        price: candidateLow,
      });
    }
  }

  return {
    highs,
    lows,
  };
}

function liveUniquePriceLevels(levels, thresholdRatio = 0.0015) {
  const sorted = [...levels]
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((left, right) => left - right);

  const output = [];

  for (const level of sorted) {
    const duplicate = output.some((existing) => {
      const denominator = Math.max(Math.abs(existing), Math.abs(level), 1);
      return Math.abs(existing - level) / denominator <= thresholdRatio;
    });

    if (!duplicate) {
      output.push(level);
    }
  }

  return output;
}

function liveSupportResistance(rows, currentPrice) {
  const sourceRows = Array.isArray(rows) ? rows : [];
  const price = candleNumber(currentPrice);

  if (!Number.isFinite(price) || sourceRows.length === 0) {
    return {
      supports: [],
      resistances: [],
      nearestSupport: null,
      nearestResistance: null,
    };
  }

  const radius =
    sourceRows.length > 80 ? 3 :
    sourceRows.length > 35 ? 2 :
    1;

  const swings = liveSwingPoints(sourceRows, radius);

  let highLevels = liveUniquePriceLevels(
    swings.highs.map((point) => point.price)
  );

  let lowLevels = liveUniquePriceLevels(
    swings.lows.map((point) => point.price)
  );

  const allHighs = sourceRows
    .map((row) => candleNumber(row.high))
    .filter(Number.isFinite);

  const allLows = sourceRows
    .map((row) => candleNumber(row.low))
    .filter(Number.isFinite);

  const maximumHigh =
    allHighs.length > 0 ? Math.max(...allHighs) : null;

  const minimumLow =
    allLows.length > 0 ? Math.min(...allLows) : null;

  if (
    highLevels.every((level) => level <= price) &&
    Number.isFinite(maximumHigh) &&
    maximumHigh > price * 1.0005
  ) {
    highLevels.push(maximumHigh);
  }

  if (
    lowLevels.every((level) => level >= price) &&
    Number.isFinite(minimumLow) &&
    minimumLow < price * 0.9995
  ) {
    lowLevels.push(minimumLow);
  }

  const supports = liveUniquePriceLevels(
    lowLevels.filter((level) => level < price)
  )
    .sort((left, right) => right - left)
    .slice(0, 3);

  const resistances = liveUniquePriceLevels(
    highLevels.filter((level) => level > price)
  )
    .sort((left, right) => left - right)
    .slice(0, 3);

  return {
    supports,
    resistances,
    nearestSupport: supports[0] ?? null,
    nearestResistance: resistances[0] ?? null,
  };
}

function liveMarketStructure(rows) {
  const sourceRows = Array.isArray(rows) ? rows : [];

  if (sourceRows.length < 8) {
    return {
      direction: "NEUTRAL",
      label: "Not enough structure data",
      score: 0,
      latestHighs: [],
      latestLows: [],
    };
  }

  const radius =
    sourceRows.length > 60 ? 3 :
    sourceRows.length > 30 ? 2 :
    1;

  const swings = liveSwingPoints(sourceRows, radius);

  const latestHighs = swings.highs.slice(-2);
  const latestLows = swings.lows.slice(-2);

  if (latestHighs.length < 2 || latestLows.length < 2) {
    return {
      direction: "NEUTRAL",
      label: "Mixed structure",
      score: 0,
      latestHighs,
      latestLows,
    };
  }

  const higherHigh =
    latestHighs[1].price > latestHighs[0].price;

  const lowerHigh =
    latestHighs[1].price < latestHighs[0].price;

  const higherLow =
    latestLows[1].price > latestLows[0].price;

  const lowerLow =
    latestLows[1].price < latestLows[0].price;

  if (higherHigh && higherLow) {
    return {
      direction: "BUY",
      label: "Bullish structure",
      score: 15,
      latestHighs,
      latestLows,
    };
  }

  if (lowerHigh && lowerLow) {
    return {
      direction: "SELL",
      label: "Bearish structure",
      score: -15,
      latestHighs,
      latestLows,
    };
  }

  return {
    direction: "NEUTRAL",
    label: "Mixed structure",
    score: 0,
    latestHighs,
    latestLows,
  };
}


// ---------------------------------------------------------------------------
// Adaptive EMA trend
// ---------------------------------------------------------------------------

function liveAdaptiveEmaPeriods(rowCount) {
  const count = Math.max(2, candleInteger(rowCount, 2));

  const ema200 = Math.max(2, Math.min(200, count - 1));
  const ema100 = Math.max(2, Math.min(100, Math.round(ema200 * 0.5)));
  const ema50 = Math.max(2, Math.min(50, Math.round(ema100 * 0.6)));
  const ema20 = Math.max(2, Math.min(20, Math.round(ema50 * 0.5)));

  return {
    ema20,
    ema50,
    ema100,
    ema200,
  };
}

function liveTrendSnapshot(rows) {
  const sourceRows = Array.isArray(rows) ? rows : [];
  const closes = liveCloseValues(sourceRows);

  if (closes.length < 5) {
    return {
      direction: "NEUTRAL",
      legacyDirection: null,
      fullAlignment: false,
      partialAlignment: false,
      periods: liveAdaptiveEmaPeriods(closes.length),
      values: {
        ema20: null,
        ema50: null,
        ema100: null,
        ema200: null,
      },
      reason: "Insufficient candle history",
    };
  }

  const periods = liveAdaptiveEmaPeriods(closes.length);

  const ema20Series = liveEma(closes, periods.ema20);
  const ema50Series = liveEma(closes, periods.ema50);
  const ema100Series = liveEma(closes, periods.ema100);
  const ema200Series = liveEma(closes, periods.ema200);

  const ema20 = liveLastFinite(ema20Series);
  const ema50 = liveLastFinite(ema50Series);
  const ema100 = liveLastFinite(ema100Series);
  const ema200 = liveLastFinite(ema200Series);
  const price = closes[closes.length - 1];

  const valuesAvailable = [
    ema20,
    ema50,
    ema100,
    ema200,
    price,
  ].every(Number.isFinite);

  if (!valuesAvailable) {
    return {
      direction: "NEUTRAL",
      legacyDirection: null,
      fullAlignment: false,
      partialAlignment: false,
      periods,
      values: {
        ema20,
        ema50,
        ema100,
        ema200,
      },
      reason: "EMA values unavailable",
    };
  }

  const bullishComparisons = [
    price > ema20,
    ema20 > ema50,
    ema50 > ema100,
    ema100 > ema200,
  ];

  const bearishComparisons = [
    price < ema20,
    ema20 < ema50,
    ema50 < ema100,
    ema100 < ema200,
  ];

  const bullishCount = bullishComparisons.filter(Boolean).length;
  const bearishCount = bearishComparisons.filter(Boolean).length;

  const bullishFull = bullishCount === 4;
  const bearishFull = bearishCount === 4;

  let direction = "NEUTRAL";
  let legacyDirection = null;
  let reason = "EMA stack mixed";

  if (bullishFull) {
    direction = "BUY";
    legacyDirection = "BUY";
    reason = "Full bullish EMA alignment";
  } else if (bearishFull) {
    direction = "SELL";
    legacyDirection = "SELL";
    reason = "Full bearish EMA alignment";
  } else if (bullishCount >= 3) {
    reason = "Partial bullish EMA alignment";
  } else if (bearishCount >= 3) {
    reason = "Partial bearish EMA alignment";
  }

  return {
    direction,
    legacyDirection,
    fullAlignment: bullishFull || bearishFull,
    partialAlignment:
      !bullishFull &&
      !bearishFull &&
      Math.max(bullishCount, bearishCount) >= 3,

    bullishCount,
    bearishCount,

    periods,
    values: {
      ema20,
      ema50,
      ema100,
      ema200,
    },

    reason,
  };
}


// ---------------------------------------------------------------------------
// Legacy-compatible step records
// ---------------------------------------------------------------------------

function livePipelineStep(
  name,
  status,
  detail,
  extra = {}
) {
  const normalizedStatus = String(status || "na").toLowerCase();

  return {
    name,
    status: [
      "pass",
      "fail",
      "skip",
      "na",
      "info",
    ].includes(normalizedStatus)
      ? normalizedStatus
      : "na",

    passed:
      normalizedStatus === "pass"
        ? true
        : normalizedStatus === "fail"
          ? false
          : null,

    detail: String(detail || ""),
    ...extra,
  };
}

function normalizePipelineDecision(value) {
  const normalized = String(value || "")
    .trim()
    .toUpperCase();

  if (
    normalized === "BUY" ||
    normalized === "LONG" ||
    normalized === "BULLISH"
  ) {
    return "BUY";
  }

  if (
    normalized === "SELL" ||
    normalized === "SHORT" ||
    normalized === "BEARISH"
  ) {
    return "SELL";
  }

  return "HOLD";
}

function liveRoundPrice(value, decimals = 5) {
  const parsed = candleNumber(value);

  if (!Number.isFinite(parsed)) {
    return null;
  }

  const safeDecimals = Math.max(
    0,
    Math.min(10, candleInteger(decimals, 5))
  );

  return Number(parsed.toFixed(safeDecimals));
}

function livePairPriceDecimals(pair) {
  const normalized = String(pair || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z]/g, "");

  if (normalized === "XAUUSD") {
    return 2;
  }

  if (normalized.endsWith("JPY")) {
    return 3;
  }

  return 5;
}


// ---------------------------------------------------------------------------
// Trade-plan builder
// ---------------------------------------------------------------------------

function buildLiveTradePlan({
  direction,
  price,
  atr,
  supportResistance,
  pair,
}) {
  const normalizedDirection = normalizePipelineDecision(direction);
  const currentPrice = candleNumber(price);
  const currentAtr = candleNumber(atr);
  const decimals = livePairPriceDecimals(pair);

  if (
    normalizedDirection === "HOLD" ||
    !Number.isFinite(currentPrice) ||
    currentPrice <= 0
  ) {
    return null;
  }

  const volatilityBuffer = Math.max(
    Number.isFinite(currentAtr) ? currentAtr * 0.5 : 0,
    currentPrice * 0.0004
  );

  const nearestSupport = candleNumber(
    supportResistance &&
      supportResistance.nearestSupport
  );

  const nearestResistance = candleNumber(
    supportResistance &&
      supportResistance.nearestResistance
  );

  let stopLoss;
  let takeProfit1;
  let takeProfit2;
  let takeProfit3;

  if (normalizedDirection === "BUY") {
    stopLoss =
      Number.isFinite(nearestSupport) &&
      nearestSupport < currentPrice
        ? nearestSupport - volatilityBuffer
        : currentPrice - volatilityBuffer * 3;

    const risk = currentPrice - stopLoss;

    if (!Number.isFinite(risk) || risk <= 0) {
      return null;
    }

    takeProfit1 =
      Number.isFinite(nearestResistance) &&
      nearestResistance > currentPrice
        ? Math.max(
            nearestResistance,
            currentPrice + risk * 2
          )
        : currentPrice + risk * 2;

    takeProfit2 = Math.max(
      takeProfit1,
      currentPrice + risk * 3
    );

    takeProfit3 = Math.max(
      takeProfit2,
      currentPrice + risk * 4
    );
  } else {
    stopLoss =
      Number.isFinite(nearestResistance) &&
      nearestResistance > currentPrice
        ? nearestResistance + volatilityBuffer
        : currentPrice + volatilityBuffer * 3;

    const risk = stopLoss - currentPrice;

    if (!Number.isFinite(risk) || risk <= 0) {
      return null;
    }

    takeProfit1 =
      Number.isFinite(nearestSupport) &&
      nearestSupport < currentPrice
        ? Math.min(
            nearestSupport,
            currentPrice - risk * 2
          )
        : currentPrice - risk * 2;

    takeProfit2 = Math.min(
      takeProfit1,
      currentPrice - risk * 3
    );

    takeProfit3 = Math.min(
      takeProfit2,
      currentPrice - risk * 4
    );
  }

  const risk = Math.abs(currentPrice - stopLoss);
  const reward1 = Math.abs(takeProfit1 - currentPrice);
  const riskReward =
    risk > 0 ? reward1 / risk : 0;

  return {
    direction: normalizedDirection,

    entry: liveRoundPrice(currentPrice, decimals),
    entryPrice: liveRoundPrice(currentPrice, decimals),

    stop: liveRoundPrice(stopLoss, decimals),
    stopLoss: liveRoundPrice(stopLoss, decimals),
    sl: liveRoundPrice(stopLoss, decimals),

    target1: liveRoundPrice(takeProfit1, decimals),
    target2: liveRoundPrice(takeProfit2, decimals),
    target3: liveRoundPrice(takeProfit3, decimals),

    takeProfit1: liveRoundPrice(takeProfit1, decimals),
    takeProfit2: liveRoundPrice(takeProfit2, decimals),
    takeProfit3: liveRoundPrice(takeProfit3, decimals),

    tp1: liveRoundPrice(takeProfit1, decimals),
    tp2: liveRoundPrice(takeProfit2, decimals),
    tp3: liveRoundPrice(takeProfit3, decimals),

    risk: liveRoundPrice(risk, decimals),
    reward: liveRoundPrice(reward1, decimals),
    riskReward: Number(riskReward.toFixed(2)),
    rr: Number(riskReward.toFixed(2)),

    atr: Number.isFinite(currentAtr)
      ? liveRoundPrice(currentAtr, decimals)
      : null,
  };
}


// ---------------------------------------------------------------------------
// Single-timeframe analysis
// ---------------------------------------------------------------------------

function analyzeLiveTimeframe(rows, options = {}) {
  const normalizedRows = normalizeLiveCandleArray(rows, {
    maxRows: options.maxRows || 2000,
  });

  const pair =
    options.pair ||
    options.symbol ||
    "UNKNOWN";

  const timeframe =
    options.timeframe ||
    "unknown";

  const steps = [];

  if (normalizedRows.length < 5) {
    steps.push(
      livePipelineStep(
        "Data Availability",
        "fail",
        `Only ${normalizedRows.length} usable candles available`
      )
    );

    return {
      pair,
      timeframe,
      decision: "HOLD",
      signal: "HOLD",
      action: "HOLD",
      direction: "HOLD",

      confidence: 0,
      score: 0,

      price: normalizedRows.length
        ? normalizedRows[normalizedRows.length - 1].close
        : null,

      trend: "NEUTRAL",
      trendDirection: "NEUTRAL",
      tradePlan: null,
      plan: null,
      steps,
      pipeline: steps,
      candleCount: normalizedRows.length,
      reason: "Insufficient candle history",
    };
  }

  const closes = liveCloseValues(normalizedRows);
  const lastCandle = normalizedRows[normalizedRows.length - 1];
  const currentPrice = candleNumber(lastCandle.close);

  const trend = liveTrendSnapshot(normalizedRows);
  const structure = liveMarketStructure(normalizedRows);
  const supportResistance = liveSupportResistance(
    normalizedRows,
    currentPrice
  );

  const rsiSeries = liveRsi(
    closes,
    Math.min(14, Math.max(4, closes.length - 2))
  );

  const rsi = liveLastFinite(rsiSeries);

  const macd = liveMacd(closes);
  const macdValue = liveLastFinite(macd.macdLine);
  const macdSignal = liveLastFinite(macd.signalLine);
  const macdHistogram = liveLastFinite(macd.histogram);

  const atrSeries = liveAtr(normalizedRows, 14);
  const atr = liveLastFinite(atrSeries);

  let alive = true;
  let direction = trend.legacyDirection;

  steps.push(
    livePipelineStep(
      "Trend",
      trend.fullAlignment ? "pass" : "fail",
      trend.reason,
      {
        direction: trend.direction,
        periods: trend.periods,
        values: trend.values,
      }
    )
  );

  if (!trend.fullAlignment || !direction) {
    alive = false;
  }

  steps.push(
    livePipelineStep(
      "EMA Alignment",
      trend.fullAlignment ? "pass" : "fail",
      trend.fullAlignment
        ? `${direction} EMA stack confirmed`
        : "Full EMA stack not confirmed"
    )
  );

  // Retain legacy behavior: ADX unavailable when the supplied feed does not
  // contain a dedicated ADX calculation.
  steps.push(
    livePipelineStep(
      "ADX > 25?",
      "na",
      "ADX confirmation unavailable in the legacy-compatible candle pipeline"
    )
  );

  const hasMeaningfulVolume = normalizedRows.some(
    (row) => candleNumber(row.volume, 0) > 0
  );

  steps.push(
    livePipelineStep(
      "Volume Confirmed?",
      hasMeaningfulVolume ? "info" : "na",
      hasMeaningfulVolume
        ? "Volume data present; retained as informational"
        : "Reliable centralized volume unavailable"
    )
  );

  if (!alive) {
    steps.push(
      livePipelineStep(
        "MACD Confirmation",
        "skip",
        "Skipped because trend alignment failed"
      )
    );
  } else {
    const macdPassed =
      direction === "BUY"
        ? Number.isFinite(macdValue) &&
          Number.isFinite(macdSignal) &&
          macdValue > macdSignal
        : Number.isFinite(macdValue) &&
          Number.isFinite(macdSignal) &&
          macdValue < macdSignal;

    steps.push(
      livePipelineStep(
        "MACD Confirmation",
        macdPassed ? "pass" : "fail",
        Number.isFinite(macdValue) &&
        Number.isFinite(macdSignal)
          ? `MACD ${macdValue.toFixed(6)} vs signal ${macdSignal.toFixed(6)}`
          : "MACD values unavailable",
        {
          macd: macdValue,
          signal: macdSignal,
          histogram: macdHistogram,
        }
      )
    );

    if (!macdPassed) {
      alive = false;
    }
  }

  if (!alive) {
    steps.push(
      livePipelineStep(
        "RSI Confirmation",
        "skip",
        "Skipped because an earlier required confirmation failed"
      )
    );
  } else {
    const rsiPassed =
      direction === "BUY"
        ? Number.isFinite(rsi) && rsi >= 45 && rsi <= 65
        : Number.isFinite(rsi) && rsi >= 35 && rsi <= 55;

    steps.push(
      livePipelineStep(
        "RSI Confirmation",
        rsiPassed ? "pass" : "fail",
        Number.isFinite(rsi)
          ? `RSI ${rsi.toFixed(2)}`
          : "RSI unavailable",
        {
          rsi,
        }
      )
    );

    if (!rsiPassed) {
      alive = false;
    }
  }

  steps.push(
    livePipelineStep(
      "Market Structure",
      structure.direction === direction
        ? "pass"
        : structure.direction === "NEUTRAL"
          ? "info"
          : "fail",
      structure.label,
      {
        direction: structure.direction,
        score: structure.score,
      }
    )
  );

  if (
    alive &&
    structure.direction !== "NEUTRAL" &&
    structure.direction !== direction
  ) {
    alive = false;
  }

  if (!alive) {
    steps.push(
      livePipelineStep(
        "Support/Resistance",
        "skip",
        "Skipped because an earlier required confirmation failed"
      )
    );
  } else {
    let distanceRatio = null;
    let level = null;

    if (direction === "BUY") {
      level = supportResistance.nearestResistance;

      if (Number.isFinite(level) && level > currentPrice) {
        distanceRatio = (level - currentPrice) / currentPrice;
      }
    } else {
      level = supportResistance.nearestSupport;

      if (Number.isFinite(level) && level < currentPrice) {
        distanceRatio = (currentPrice - level) / currentPrice;
      }
    }

    const srPassed =
      !Number.isFinite(level) ||
      !Number.isFinite(distanceRatio) ||
      distanceRatio >= 0.003;

    steps.push(
      livePipelineStep(
        "Support/Resistance",
        srPassed ? "pass" : "fail",
        !Number.isFinite(level)
          ? "No blocking nearby level detected"
          : `${direction === "BUY" ? "Resistance" : "Support"} distance ${(distanceRatio * 100).toFixed(2)}%`,
        {
          level,
          distanceRatio,
          supports: supportResistance.supports,
          resistances: supportResistance.resistances,
        }
      )
    );

    if (!srPassed) {
      alive = false;
    }
  }

  steps.push(
    livePipelineStep(
      "ATR-style Stop Loss",
      Number.isFinite(atr) ? "info" : "na",
      Number.isFinite(atr)
        ? `ATR ${atr.toFixed(livePairPriceDecimals(pair))}`
        : "ATR unavailable",
      {
        atr,
      }
    )
  );

  const preliminaryDecision = alive
    ? normalizePipelineDecision(direction)
    : "HOLD";

  const tradePlan =
    preliminaryDecision !== "HOLD"
      ? buildLiveTradePlan({
          direction: preliminaryDecision,
          price: currentPrice,
          atr,
          supportResistance,
          pair,
        })
      : null;

  let finalDecision = preliminaryDecision;

  if (preliminaryDecision === "HOLD") {
    steps.push(
      livePipelineStep(
        "Trade Plan + Risk:Reward",
        "skip",
        "No trade plan because required confirmations did not pass"
      )
    );
  } else if (!tradePlan) {
    finalDecision = "HOLD";

    steps.push(
      livePipelineStep(
        "Trade Plan + Risk:Reward",
        "fail",
        "A valid risk-managed trade plan could not be constructed"
      )
    );
  } else if (tradePlan.riskReward < 2) {
    finalDecision = "HOLD";

    steps.push(
      livePipelineStep(
        "Trade Plan + Risk:Reward",
        "fail",
        `Risk:Reward ${tradePlan.riskReward.toFixed(2)} is below 2.00`,
        {
          riskReward: tradePlan.riskReward,
        }
      )
    );
  } else {
    steps.push(
      livePipelineStep(
        "Trade Plan + Risk:Reward",
        "pass",
        `Risk:Reward ${tradePlan.riskReward.toFixed(2)}`,
        {
          riskReward: tradePlan.riskReward,
        }
      )
    );
  }

  const requiredSteps = steps.filter(
    (step) =>
      step.status === "pass" ||
      step.status === "fail"
  );

  const passedRequiredSteps = requiredSteps.filter(
    (step) => step.status === "pass"
  ).length;

  const failedRequiredSteps = requiredSteps.filter(
    (step) => step.status === "fail"
  ).length;

  const confirmationRatio =
    requiredSteps.length > 0
      ? passedRequiredSteps / requiredSteps.length
      : 0;

  let score = 0;

  if (trend.direction === "BUY") score += 30;
  if (trend.direction === "SELL") score -= 30;

  score += structure.score;

  if (
    Number.isFinite(macdHistogram) &&
    macdHistogram > 0
  ) {
    score += 15;
  } else if (
    Number.isFinite(macdHistogram) &&
    macdHistogram < 0
  ) {
    score -= 15;
  }

  if (Number.isFinite(rsi)) {
    if (rsi >= 50 && rsi <= 65) {
      score += 10;
    } else if (rsi >= 35 && rsi < 50) {
      score -= 10;
    }
  }

  score = Math.max(-100, Math.min(100, score));

  const confidence =
    finalDecision === "HOLD"
      ? Math.max(
          0,
          Math.min(
            69,
            Math.round(confirmationRatio * 70)
          )
        )
      : Math.max(
          50,
          Math.min(
            99,
            Math.round(60 + confirmationRatio * 35)
          )
        );

  const reason =
    finalDecision === "HOLD"
      ? failedRequiredSteps > 0
        ? `${failedRequiredSteps} required confirmation(s) failed`
        : "No fully confirmed directional setup"
      : `${finalDecision} setup confirmed by the legacy-compatible pipeline`;

  return {
    pair,
    timeframe,

    decision: finalDecision,
    signal: finalDecision,
    action: finalDecision,
    direction: finalDecision,

    rawDirection: direction || "NEUTRAL",
    trend: trend.direction,
    trendDirection: trend.direction,

    confidence,
    score,

    price: currentPrice,
    currentPrice,
    lastPrice: currentPrice,

    timestamp: lastCandle.timestamp,
    time: lastCandle.time,

    candleCount: normalizedRows.length,

    indicators: {
      rsi,
      macd: macdValue,
      macdSignal,
      macdHistogram,
      atr,

      ema20: trend.values.ema20,
      ema50: trend.values.ema50,
      ema100: trend.values.ema100,
      ema200: trend.values.ema200,
    },

    rsi,
    macd: macdValue,
    macdSignal,
    macdHistogram,
    atr,

    ema20: trend.values.ema20,
    ema50: trend.values.ema50,
    ema100: trend.values.ema100,
    ema200: trend.values.ema200,

    marketStructure: structure,
    structure,

    supportResistance,
    supports: supportResistance.supports,
    resistances: supportResistance.resistances,
    nearestSupport: supportResistance.nearestSupport,
    nearestResistance: supportResistance.nearestResistance,

    tradePlan:
      finalDecision !== "HOLD" ? tradePlan : null,

    plan:
      finalDecision !== "HOLD" ? tradePlan : null,

    entry:
      finalDecision !== "HOLD" && tradePlan
        ? tradePlan.entry
        : null,

    stop:
      finalDecision !== "HOLD" && tradePlan
        ? tradePlan.stop
        : null,

    stopLoss:
      finalDecision !== "HOLD" && tradePlan
        ? tradePlan.stopLoss
        : null,

    target1:
      finalDecision !== "HOLD" && tradePlan
        ? tradePlan.target1
        : null,

    target2:
      finalDecision !== "HOLD" && tradePlan
        ? tradePlan.target2
        : null,

    target3:
      finalDecision !== "HOLD" && tradePlan
        ? tradePlan.target3
        : null,

    tp1:
      finalDecision !== "HOLD" && tradePlan
        ? tradePlan.tp1
        : null,

    tp2:
      finalDecision !== "HOLD" && tradePlan
        ? tradePlan.tp2
        : null,

    tp3:
      finalDecision !== "HOLD" && tradePlan
        ? tradePlan.tp3
        : null,

    riskReward:
      finalDecision !== "HOLD" && tradePlan
        ? tradePlan.riskReward
        : null,

    rr:
      finalDecision !== "HOLD" && tradePlan
        ? tradePlan.rr
        : null,

    reason,

    steps,
    pipeline: steps,

    diagnostics: {
      requiredSteps: requiredSteps.length,
      passedRequiredSteps,
      failedRequiredSteps,
      confirmationRatio: Number(
        confirmationRatio.toFixed(4)
      ),
    },
  };
}


// ---------------------------------------------------------------------------
// Multi-timeframe confirmation
// ---------------------------------------------------------------------------

function applyLiveHigherTimeframeConfirmation(
  lowerAnalysis,
  higherAnalysis,
  options = {}
) {
  const lower =
    lowerAnalysis && typeof lowerAnalysis === "object"
      ? { ...lowerAnalysis }
      : null;

  if (!lower) {
    return lowerAnalysis;
  }

  const higher =
    higherAnalysis && typeof higherAnalysis === "object"
      ? higherAnalysis
      : null;

  const steps = Array.isArray(lower.steps)
    ? [...lower.steps]
    : [];

  if (!higher) {
    steps.push(
      livePipelineStep(
        "Multi-Timeframe Confirmation",
        "na",
        "Higher-timeframe analysis unavailable"
      )
    );

    lower.steps = steps;
    lower.pipeline = steps;

    return lower;
  }

  const lowerDecision = normalizePipelineDecision(
    lower.decision || lower.signal
  );

  const higherTrend = normalizePipelineDecision(
    higher.rawDirection ||
      higher.trendDirection ||
      higher.trend ||
      higher.decision
  );

  if (lowerDecision === "HOLD") {
    steps.push(
      livePipelineStep(
        "Multi-Timeframe Confirmation",
        "skip",
        "Lower timeframe has no active directional setup",
        {
          higherTimeframe:
            options.higherTimeframe ||
            higher.timeframe ||
            null,

          higherDirection: higherTrend,
        }
      )
    );

    lower.steps = steps;
    lower.pipeline = steps;

    return lower;
  }

  const confirmed = higherTrend === lowerDecision;

  steps.push(
    livePipelineStep(
      "Multi-Timeframe Confirmation",
      confirmed ? "pass" : "fail",
      confirmed
        ? `${higher.timeframe || "Higher timeframe"} confirms ${lowerDecision}`
        : `${higher.timeframe || "Higher timeframe"} does not confirm ${lowerDecision}`,
      {
        higherTimeframe:
          options.higherTimeframe ||
          higher.timeframe ||
          null,

        higherDirection: higherTrend,
      }
    )
  );

  lower.steps = steps;
  lower.pipeline = steps;

  lower.higherTimeframe = {
    timeframe:
      options.higherTimeframe ||
      higher.timeframe ||
      null,

    decision:
      normalizePipelineDecision(
        higher.decision || higher.signal
      ),

    direction: higherTrend,
    confidence: candleNumber(higher.confidence, 0),
  };

  lower.mtfConfirmed = confirmed;

  if (!confirmed) {
    lower.decision = "HOLD";
    lower.signal = "HOLD";
    lower.action = "HOLD";
    lower.direction = "HOLD";

    lower.tradePlan = null;
    lower.plan = null;

    lower.entry = null;
    lower.stop = null;
    lower.stopLoss = null;

    lower.target1 = null;
    lower.target2 = null;
    lower.target3 = null;

    lower.tp1 = null;
    lower.tp2 = null;
    lower.tp3 = null;

    lower.riskReward = null;
    lower.rr = null;

    lower.confidence = Math.min(
      candleInteger(lower.confidence, 0),
      69
    );

    lower.reason =
      "Higher timeframe did not confirm the lower-timeframe setup";
  }

  return lower;
}


// ---------------------------------------------------------------------------
// Legacy-compatible complete analysis pipeline
// ---------------------------------------------------------------------------

function runLegacyCompatibleAnalysisPipeline(input = {}) {
  const pair =
    input.pair ||
    input.symbol ||
    input.pairLabel ||
    "UNKNOWN";

  const frames =
    input.frames &&
    typeof input.frames === "object"
      ? input.frames
      : prepareLiveAnalysisFrames(input);

  const scalpAnalysis = analyzeLiveTimeframe(
    frames.scalp || [],
    {
      pair,
      timeframe:
        input.scalpTimeframe ||
        input.timeframe ||
        "SCALP",
      maxRows: input.maxScalpAnalysisRows || 1200,
    }
  );

  const intradayBase = analyzeLiveTimeframe(
    frames.intraday || [],
    {
      pair,
      timeframe: "H1",
      maxRows: input.maxIntradayAnalysisRows || 1000,
    }
  );

  const dailyBase = analyzeLiveTimeframe(
    frames.daily || [],
    {
      pair,
      timeframe: "D1",
      maxRows: input.maxDailyAnalysisRows || 600,
    }
  );

  const weeklyAnalysis = analyzeLiveTimeframe(
    frames.weekly || [],
    {
      pair,
      timeframe: "W1",
      maxRows: input.maxWeeklyAnalysisRows || 300,
    }
  );

  const dailyAnalysis =
    frames.weekly && frames.weekly.length > 0
      ? applyLiveHigherTimeframeConfirmation(
          dailyBase,
          weeklyAnalysis,
          {
            higherTimeframe: "W1",
          }
        )
      : dailyBase;

  const intradayAnalysis =
    frames.daily && frames.daily.length > 0
      ? applyLiveHigherTimeframeConfirmation(
          intradayBase,
          dailyAnalysis,
          {
            higherTimeframe: "D1",
          }
        )
      : intradayBase;

  const confirmedScalpAnalysis =
    frames.intraday && frames.intraday.length > 0
      ? applyLiveHigherTimeframeConfirmation(
          scalpAnalysis,
          intradayAnalysis,
          {
            higherTimeframe: "H1",
          }
        )
      : scalpAnalysis;

  return {
    pair,

    generatedAt: new Date().toISOString(),
    timestamp: Date.now(),

    scalp: confirmedScalpAnalysis,
    intraday: intradayAnalysis,
    daily: dailyAnalysis,
    weekly: weeklyAnalysis,

    analyses: {
      scalp: confirmedScalpAnalysis,
      intraday: intradayAnalysis,
      daily: dailyAnalysis,
      weekly: weeklyAnalysis,
    },

    frames: {
      scalp: frames.scalp || [],
      intraday: frames.intraday || [],
      daily: frames.daily || [],
      weekly: frames.weekly || [],
    },

    frameMetadata:
      frames.metadata &&
      typeof frames.metadata === "object"
        ? frames.metadata
        : {
            scalpCount: Array.isArray(frames.scalp)
              ? frames.scalp.length
              : 0,

            intradayCount: Array.isArray(frames.intraday)
              ? frames.intraday.length
              : 0,

            dailyCount: Array.isArray(frames.daily)
              ? frames.daily.length
              : 0,

            weeklyCount: Array.isArray(frames.weekly)
              ? frames.weekly.length
              : 0,
          },
  };
}


// ---------------------------------------------------------------------------
// Legacy analysis aliases
// ---------------------------------------------------------------------------
//
// These wrappers preserve compatibility for callers that use older analysis
// helper names while keeping the revised implementation centralized.
// ---------------------------------------------------------------------------

function aggregateCandles(rows, timeframe, options = {}) {
  return aggregateLiveCandles(rows, timeframe, options);
}

function aggregateToDaily(rows, options = {}) {
  return aggregateDailyCandles(rows, options);
}

function aggregateToWeekly(rows, options = {}) {
  return aggregateWeeklyCandles(rows, options);
}

function buildWeeklyCandles(rows, options = {}) {
  return buildLegacyWeeklyCandles(rows, options);
}

function prepareAnalysisFrames(input = {}) {
  return prepareLiveAnalysisFrames(input);
}

function analyzeLegacyCompatible(rows, options = {}) {
  return analyzeLiveTimeframe(rows, options);
}

function runAnalysisPipeline(input = {}) {
  return runLegacyCompatibleAnalysisPipeline(input);
}

// ============================================================================
// PART 5 — ENGINE SELECTION + MASTER CONSENSUS
//          + OUTPUT SCHEMA ASSEMBLY + HISTORY/TELEGRAM INTEGRATION
// ============================================================================
//
// This section:
// - Selects revised or legacy-compatible Scalp analysis safely.
// - Preserves data/scalp-signals.json as the primary Scalp source.
// - Uses candle-based Scalp analysis only as fallback.
// - Builds Swing, Intraday, Scalp and Master engine results.
// - Normalizes WAIT, NEUTRAL, NO_TRADE and similar states to HOLD.
// - Preserves common legacy output field aliases.
// - Appends analysis-history.json safely with deduplication.
// - Uses notify-state.json to prevent duplicate Telegram alerts.
// - Preserves Telegram as an optional, non-blocking integration.
// - Does not write live-analysis.json yet; final orchestration is in Part 6.
//
// Required from earlier parts:
// - safe JSON reading/writing helpers from Parts 1–3.
// - pair normalization helpers from Parts 1–3.
// - runLegacyCompatibleAnalysisPipeline() from Part 4.
// - TELEGRAM_TIMEOUT_MS from Part 1.
// ============================================================================


// ---------------------------------------------------------------------------
// Shared compatibility helpers
// ---------------------------------------------------------------------------

function liveIsPlainObject(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function liveAsArray(value) {
  return Array.isArray(value) ? value : [];
}

function liveCloneValue(value) {
  if (value === undefined) {
    return undefined;
  }

  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

function liveFiniteNumber(value, fallback = null) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function liveBoundNumber(value, minimum, maximum, fallback = 0) {
  const parsed = liveFiniteNumber(value, fallback);

  return Math.max(
    minimum,
    Math.min(maximum, parsed)
  );
}

function liveNonEmptyString(value, fallback = "") {
  if (value === null || value === undefined) {
    return fallback;
  }

  const text = String(value).trim();
  return text || fallback;
}

function liveFirstDefined(object, keys, fallback = undefined) {
  if (!liveIsPlainObject(object)) {
    return fallback;
  }

  for (const key of keys) {
    if (
      Object.prototype.hasOwnProperty.call(object, key) &&
      object[key] !== undefined &&
      object[key] !== null &&
      object[key] !== ""
    ) {
      return object[key];
    }
  }

  return fallback;
}

function liveNowIso() {
  return new Date().toISOString();
}

function liveStableTimestamp(value, fallback = Date.now()) {
  if (typeof normalizeTimestampMs === "function") {
    const normalized = normalizeTimestampMs(value);

    if (Number.isFinite(normalized)) {
      return normalized;
    }
  }

  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : fallback;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 10_000_000_000
      ? Math.trunc(value * 1000)
      : Math.trunc(value);
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  return fallback;
}

function liveNormalizePairLabel(value, fallback = "UNKNOWN") {
  if (typeof normalizePairLabel === "function") {
    try {
      const normalized = normalizePairLabel(value);

      if (normalized) {
        return normalized;
      }
    } catch {
      // Continue with local fallback.
    }
  }

  if (typeof normalizePair === "function") {
    try {
      const normalized = normalizePair(value);

      if (normalized) {
        return normalized;
      }
    } catch {
      // Continue with local fallback.
    }
  }

  const raw = liveNonEmptyString(value, fallback)
    .toUpperCase()
    .replace(/\s+/g, "");

  const compact = raw.replace(/[^A-Z0-9]/g, "");

  const aliases = {
    XAUUSD: "XAU/USD",
    GOLD: "XAU/USD",
    GOLDUSD: "XAU/USD",

    GBPJPY: "GBP/JPY",
    GJ: "GBP/JPY",
  };

  if (aliases[compact]) {
    return aliases[compact];
  }

  if (/^[A-Z]{6}$/.test(compact)) {
    return `${compact.slice(0, 3)}/${compact.slice(3)}`;
  }

  return raw || fallback;
}

function liveCompactPair(value) {
  return liveNormalizePairLabel(value)
    .replace(/[^A-Z0-9]/g, "");
}

function liveNormalizeMode(value, fallback = "unknown") {
  const raw = liveNonEmptyString(value, fallback)
    .toLowerCase()
    .replace(/[\s_-]+/g, "");

  const aliases = {
    scalp: "scalp",
    scalping: "scalp",

    intraday: "intraday",
    daytrade: "intraday",
    daytrading: "intraday",
    h1: "intraday",

    swing: "swing",
    daily: "swing",
    d1: "swing",

    weekly: "weekly",
    w1: "weekly",

    master: "master",
    consensus: "master",
  };

  return aliases[raw] || fallback;
}


// ---------------------------------------------------------------------------
// Universal decision normalization
// ---------------------------------------------------------------------------

function normalizeLiveDecision(value) {
  if (typeof normalizePipelineDecision === "function") {
    try {
      return normalizePipelineDecision(value);
    } catch {
      // Continue with local compatibility rules.
    }
  }

  const normalized = liveNonEmptyString(value)
    .toUpperCase()
    .replace(/[\s_-]+/g, "");

  const buyValues = new Set([
    "BUY",
    "LONG",
    "BULL",
    "BULLISH",
    "STRONGBUY",
    "BUYSETUP",
    "UP",
  ]);

  const sellValues = new Set([
    "SELL",
    "SHORT",
    "BEAR",
    "BEARISH",
    "STRONGSELL",
    "SELLSETUP",
    "DOWN",
  ]);

  if (buyValues.has(normalized)) {
    return "BUY";
  }

  if (sellValues.has(normalized)) {
    return "SELL";
  }

  // WAIT, NEUTRAL, NONE, FLAT and unknown states intentionally become HOLD.
  return "HOLD";
}

function liveDecisionScore(decision) {
  const normalized = normalizeLiveDecision(decision);

  if (normalized === "BUY") return 1;
  if (normalized === "SELL") return -1;

  return 0;
}

function liveOppositeDecision(decision) {
  const normalized = normalizeLiveDecision(decision);

  if (normalized === "BUY") return "SELL";
  if (normalized === "SELL") return "BUY";

  return "HOLD";
}


// ---------------------------------------------------------------------------
// Confidence and price extraction
// ---------------------------------------------------------------------------

function liveNormalizeConfidence(value, fallback = 0) {
  let confidence = liveFiniteNumber(value, fallback);

  if (!Number.isFinite(confidence)) {
    confidence = fallback;
  }

  // Accept 0–1 confidence ratios as well as 0–100 percentages.
  if (confidence >= 0 && confidence <= 1) {
    confidence *= 100;
  }

  return Math.round(
    liveBoundNumber(confidence, 0, 100, fallback)
  );
}

function liveExtractDecision(source) {
  if (!liveIsPlainObject(source)) {
    return normalizeLiveDecision(source);
  }

  return normalizeLiveDecision(
    liveFirstDefined(source, [
      "decision",
      "signal",
      "action",
      "direction",
      "recommendation",
      "bias",
      "side",
      "trade",
      "result",
    ])
  );
}

function liveExtractConfidence(source, fallback = 0) {
  if (!liveIsPlainObject(source)) {
    return liveNormalizeConfidence(fallback);
  }

  return liveNormalizeConfidence(
    liveFirstDefined(source, [
      "confidence",
      "confidencePct",
      "confidencePercent",
      "probability",
      "scorePercent",
      "strength",
      "quality",
      "accuracy",
    ]),
    fallback
  );
}

function liveExtractScore(source, fallback = 0) {
  if (!liveIsPlainObject(source)) {
    return liveFiniteNumber(fallback, 0);
  }

  const raw = liveFirstDefined(source, [
    "score",
    "signalScore",
    "weightedScore",
    "netScore",
    "biasScore",
  ]);

  const parsed = liveFiniteNumber(raw);

  if (Number.isFinite(parsed)) {
    return liveBoundNumber(parsed, -100, 100, fallback);
  }

  const decision = liveExtractDecision(source);
  const confidence = liveExtractConfidence(source, fallback);

  return liveDecisionScore(decision) * confidence;
}

function liveExtractPrice(source, fallback = null) {
  if (!liveIsPlainObject(source)) {
    return liveFiniteNumber(source, fallback);
  }

  return liveFiniteNumber(
    liveFirstDefined(source, [
      "price",
      "currentPrice",
      "lastPrice",
      "entry",
      "entryPrice",
      "close",
      "marketPrice",
    ]),
    fallback
  );
}

function liveExtractTimestamp(source, fallback = Date.now()) {
  if (!liveIsPlainObject(source)) {
    return liveStableTimestamp(source, fallback);
  }

  return liveStableTimestamp(
    liveFirstDefined(source, [
      "timestamp",
      "generatedAt",
      "updatedAt",
      "createdAt",
      "time",
      "date",
      "signalTime",
    ]),
    fallback
  );
}


// ---------------------------------------------------------------------------
// Trade-plan normalization
// ---------------------------------------------------------------------------

function normalizeLiveTradePlan(source, pair, decision) {
  if (!liveIsPlainObject(source)) {
    return null;
  }

  const normalizedDecision = normalizeLiveDecision(decision);
  const decimals =
    typeof livePairPriceDecimals === "function"
      ? livePairPriceDecimals(pair)
      : liveCompactPair(pair).endsWith("JPY")
        ? 3
        : liveCompactPair(pair) === "XAUUSD"
          ? 2
          : 5;

  const roundPrice = (value) => {
    const parsed = liveFiniteNumber(value);

    if (!Number.isFinite(parsed)) {
      return null;
    }

    if (typeof liveRoundPrice === "function") {
      return liveRoundPrice(parsed, decimals);
    }

    return Number(parsed.toFixed(decimals));
  };

  const entry = roundPrice(
    liveFirstDefined(source, [
      "entry",
      "entryPrice",
      "price",
      "currentPrice",
    ])
  );

  const stopLoss = roundPrice(
    liveFirstDefined(source, [
      "stopLoss",
      "stop",
      "sl",
      "stop_price",
    ])
  );

  const takeProfit1 = roundPrice(
    liveFirstDefined(source, [
      "takeProfit1",
      "target1",
      "tp1",
      "take_profit_1",
    ])
  );

  const takeProfit2 = roundPrice(
    liveFirstDefined(source, [
      "takeProfit2",
      "target2",
      "tp2",
      "take_profit_2",
    ])
  );

  const takeProfit3 = roundPrice(
    liveFirstDefined(source, [
      "takeProfit3",
      "target3",
      "tp3",
      "take_profit_3",
    ])
  );

  if (
    normalizedDecision === "HOLD" ||
    !Number.isFinite(entry) ||
    !Number.isFinite(stopLoss) ||
    !Number.isFinite(takeProfit1)
  ) {
    return null;
  }

  const calculatedRisk = Math.abs(entry - stopLoss);
  const calculatedReward = Math.abs(takeProfit1 - entry);

  const risk = roundPrice(
    liveFirstDefined(source, ["risk"], calculatedRisk)
  );

  const reward = roundPrice(
    liveFirstDefined(source, ["reward"], calculatedReward)
  );

  const suppliedRiskReward = liveFiniteNumber(
    liveFirstDefined(source, [
      "riskReward",
      "risk_reward",
      "rr",
      "riskToReward",
    ])
  );

  const riskReward =
    Number.isFinite(suppliedRiskReward)
      ? Number(suppliedRiskReward.toFixed(2))
      : calculatedRisk > 0
        ? Number((calculatedReward / calculatedRisk).toFixed(2))
        : null;

  return {
    direction: normalizedDecision,

    entry,
    entryPrice: entry,

    stop: stopLoss,
    stopLoss,
    sl: stopLoss,

    target1: takeProfit1,
    target2: takeProfit2,
    target3: takeProfit3,

    takeProfit1,
    takeProfit2,
    takeProfit3,

    tp1: takeProfit1,
    tp2: takeProfit2,
    tp3: takeProfit3,

    risk,
    reward,

    riskReward,
    rr: riskReward,

    atr: liveFiniteNumber(source.atr, null),
  };
}

function liveExtractTradePlan(source, pair, decision) {
  if (!liveIsPlainObject(source)) {
    return null;
  }

  const directPlan =
    liveFirstDefined(source, [
      "tradePlan",
      "plan",
      "trade_plan",
      "setup",
    ]);

  if (liveIsPlainObject(directPlan)) {
    return normalizeLiveTradePlan(
      directPlan,
      pair,
      decision
    );
  }

  return normalizeLiveTradePlan(
    source,
    pair,
    decision
  );
}


// ---------------------------------------------------------------------------
// Canonical engine result
// ---------------------------------------------------------------------------

function buildCanonicalEngineResult(
  source,
  options = {}
) {
  const rawSource = liveIsPlainObject(source)
    ? source
    : {};

  const pair = liveNormalizePairLabel(
    options.pair ||
      rawSource.pair ||
      rawSource.symbol ||
      rawSource.pairLabel
  );

  const mode = liveNormalizeMode(
    options.mode ||
      rawSource.mode ||
      rawSource.engine ||
      rawSource.timeframe,
    options.defaultMode || "unknown"
  );

  const engineName = liveNonEmptyString(
    options.engineName ||
      rawSource.engineName ||
      rawSource.engine ||
      rawSource.source,
    mode
  );

  let decision = liveExtractDecision(rawSource);
  let confidence = liveExtractConfidence(
    rawSource,
    decision === "HOLD" ? 0 : 50
  );

  let score = liveExtractScore(
    rawSource,
    liveDecisionScore(decision) * confidence
  );

  const price = liveExtractPrice(
    rawSource,
    liveFiniteNumber(options.price, null)
  );

  const timestamp = liveExtractTimestamp(
    rawSource,
    options.timestamp || Date.now()
  );

  const tradePlan = liveExtractTradePlan(
    rawSource,
    pair,
    decision
  );

  if (decision !== "HOLD" && !tradePlan && options.requireTradePlan) {
    decision = "HOLD";
    confidence = Math.min(confidence, 69);
  }

  if (decision === "HOLD") {
    score = liveBoundNumber(score, -69, 69, 0);
  }

  const reason = liveNonEmptyString(
    liveFirstDefined(rawSource, [
      "reason",
      "summary",
      "message",
      "explanation",
      "note",
    ]),
    decision === "HOLD"
      ? "No fully confirmed setup"
      : `${decision} setup confirmed`
  );

  const steps = liveAsArray(
    liveFirstDefined(rawSource, [
      "steps",
      "pipeline",
      "checks",
    ])
  ).map((step) => liveCloneValue(step));

  const canonical = {
    pair,
    symbol: pair,
    pairLabel: pair,

    mode,
    engine: engineName,
    engineName,

    decision,
    signal: decision,
    action: decision,
    direction: decision,

    confidence,
    confidencePct: confidence,

    score: Number(
      liveBoundNumber(score, -100, 100, 0).toFixed(2)
    ),

    price,
    currentPrice: price,
    lastPrice: price,

    timestamp,
    time: new Date(timestamp).toISOString(),
    generatedAt: new Date(timestamp).toISOString(),

    reason,

    tradePlan:
      decision === "HOLD" ? null : tradePlan,

    plan:
      decision === "HOLD" ? null : tradePlan,

    entry:
      decision !== "HOLD" && tradePlan
        ? tradePlan.entry
        : null,

    entryPrice:
      decision !== "HOLD" && tradePlan
        ? tradePlan.entryPrice
        : null,

    stop:
      decision !== "HOLD" && tradePlan
        ? tradePlan.stop
        : null,

    stopLoss:
      decision !== "HOLD" && tradePlan
        ? tradePlan.stopLoss
        : null,

    sl:
      decision !== "HOLD" && tradePlan
        ? tradePlan.sl
        : null,

    target1:
      decision !== "HOLD" && tradePlan
        ? tradePlan.target1
        : null,

    target2:
      decision !== "HOLD" && tradePlan
        ? tradePlan.target2
        : null,

    target3:
      decision !== "HOLD" && tradePlan
        ? tradePlan.target3
        : null,

    takeProfit1:
      decision !== "HOLD" && tradePlan
        ? tradePlan.takeProfit1
        : null,

    takeProfit2:
      decision !== "HOLD" && tradePlan
        ? tradePlan.takeProfit2
        : null,

    takeProfit3:
      decision !== "HOLD" && tradePlan
        ? tradePlan.takeProfit3
        : null,

    tp1:
      decision !== "HOLD" && tradePlan
        ? tradePlan.tp1
        : null,

    tp2:
      decision !== "HOLD" && tradePlan
        ? tradePlan.tp2
        : null,

    tp3:
      decision !== "HOLD" && tradePlan
        ? tradePlan.tp3
        : null,

    riskReward:
      decision !== "HOLD" && tradePlan
        ? tradePlan.riskReward
        : null,

    rr:
      decision !== "HOLD" && tradePlan
        ? tradePlan.rr
        : null,

    steps,
    pipeline: steps,

    status:
      decision === "HOLD"
        ? "HOLD"
        : "ACTIVE",

    source: liveNonEmptyString(
      options.source ||
        rawSource.source ||
        engineName,
      engineName
    ),

    available:
      options.available !== undefined
        ? Boolean(options.available)
        : true,
  };

  // Preserve useful fields from the source without overwriting canonical keys.
    const passthroughKeys = [
    "indicators",
    "trend",
    "trendDirection",
    "rawDirection",
    "marketStructure",
    "structure",
    "supportResistance",
    "supports",
    "resistances",
    "nearestSupport",
    "nearestResistance",
    "higherTimeframe",
    "mtfConfirmed",
    "candleCount",
    "diagnostics",
    "metadata",
    "version",
    "strategyVersion",

    // Phase 4 controlled-confidence compatibility.
    "originalConfidence",
    "aiMemoryAdjustedConfidence",
    "aiMemory",
  ];

  for (const key of passthroughKeys) {
    if (
      rawSource[key] !== undefined &&
      canonical[key] === undefined
    ) {
      canonical[key] = liveCloneValue(rawSource[key]);
    }
  }

  return canonical;
}


// ---------------------------------------------------------------------------
// Scalp signal extraction
// ---------------------------------------------------------------------------

function liveFindPairRecord(container, pair) {
  if (!container) {
    return null;
  }

  const normalizedPair = liveNormalizePairLabel(pair);
  const compactPair = liveCompactPair(pair);

  if (Array.isArray(container)) {
    return (
      container.find((item) => {
        if (!liveIsPlainObject(item)) {
          return false;
        }

        const itemPair = liveNormalizePairLabel(
          item.pair ||
            item.symbol ||
            item.pairLabel ||
            item.instrument
        );

        return (
          itemPair === normalizedPair ||
          liveCompactPair(itemPair) === compactPair
        );
      }) || null
    );
  }

  if (!liveIsPlainObject(container)) {
    return null;
  }

  const directKeys = [
    normalizedPair,
    compactPair,
    normalizedPair.replace("/", "-"),
    normalizedPair.replace("/", "_"),
    normalizedPair.replace("/", ""),
  ];

  for (const key of directKeys) {
    if (
      Object.prototype.hasOwnProperty.call(container, key) &&
      container[key] !== null &&
      container[key] !== undefined
    ) {
      return container[key];
    }
  }

  for (const [key, value] of Object.entries(container)) {
    if (liveCompactPair(key) === compactPair) {
      return value;
    }
  }

  return null;
}

function extractPrimaryScalpSignal(
  scalpSignalsData,
  pair
) {
  if (!scalpSignalsData) {
    return null;
  }

  const candidateContainers = [
    scalpSignalsData,
    scalpSignalsData.signals,
    scalpSignalsData.results,
    scalpSignalsData.pairs,
    scalpSignalsData.data,
    scalpSignalsData.analysis,
    scalpSignalsData.scalp,
  ];

  let record = null;

  for (const container of candidateContainers) {
    record = liveFindPairRecord(container, pair);

    if (record) {
      break;
    }
  }

  if (!record && liveIsPlainObject(scalpSignalsData)) {
    const recordPair = liveNormalizePairLabel(
      scalpSignalsData.pair ||
        scalpSignalsData.symbol ||
        scalpSignalsData.pairLabel
    );

    if (
      liveCompactPair(recordPair) ===
      liveCompactPair(pair)
    ) {
      record = scalpSignalsData;
    }
  }

  if (!record) {
    return null;
  }

  const nestedSignal =
    liveIsPlainObject(record.signal)
      ? record.signal
      : liveIsPlainObject(record.analysis)
        ? record.analysis
        : liveIsPlainObject(record.result)
          ? record.result
          : record;

  return liveIsPlainObject(nestedSignal)
    ? {
        ...record,
        ...nestedSignal,
      }
    : record;
}

function isUsablePrimaryScalpSignal(
  signal,
  options = {}
) {
  if (!liveIsPlainObject(signal)) {
    return false;
  }

  const decision = liveExtractDecision(signal);
  const timestamp = liveExtractTimestamp(signal, 0);

  if (decision === "HOLD" && options.allowHold !== true) {
    return false;
  }

  const maximumAgeMs = Math.max(
    0,
    liveFiniteNumber(
      options.maximumAgeMs,
      6 * 60 * 60 * 1000
    )
  );

  if (
    maximumAgeMs > 0 &&
    timestamp > 0 &&
    Date.now() - timestamp > maximumAgeMs
  ) {
    return false;
  }

  return true;
}


// ---------------------------------------------------------------------------
// Scalp engine selection
// ---------------------------------------------------------------------------

function selectScalpEngineResult(input = {}) {
  const pair = liveNormalizePairLabel(
    input.pair ||
      input.symbol ||
      input.pairLabel
  );

  const primarySignal = extractPrimaryScalpSignal(
    input.scalpSignalsData ||
      input.scalpSignals ||
      input.primaryScalpData,
    pair
  );

  const allowPrimaryHold =
    input.allowPrimaryHold === true;

  if (
    isUsablePrimaryScalpSignal(primarySignal, {
      allowHold: allowPrimaryHold,
      maximumAgeMs:
        input.maximumPrimaryScalpAgeMs,
    })
  ) {
    const primaryResult = buildCanonicalEngineResult(
      primarySignal,
      {
        pair,
        mode: "scalp",
        engineName: "scalp-signals",
        source: "data/scalp-signals.json",
        requireTradePlan: false,
      }
    );

    return {
      ...primaryResult,

      selection: {
        selected: "primary-signal",
        primaryAvailable: true,
        fallbackAvailable: Boolean(
          input.fallbackScalpAnalysis
        ),
        reason:
          "Primary Scalp signal selected from data/scalp-signals.json",
      },
    };
  }

  const fallbackSource =
    input.fallbackScalpAnalysis ||
    input.legacyScalpAnalysis ||
    input.candleScalpAnalysis ||
    null;

  if (liveIsPlainObject(fallbackSource)) {
    const fallbackResult = buildCanonicalEngineResult(
      fallbackSource,
      {
        pair,
        mode: "scalp",
        engineName: "legacy-scalp-candles",
        source: "data/scalp-candles.json",
        requireTradePlan: false,
      }
    );

    return {
      ...fallbackResult,

      selection: {
        selected: "legacy-candle-fallback",
        primaryAvailable: Boolean(primarySignal),
        fallbackAvailable: true,
        reason: primarySignal
          ? "Primary Scalp signal was stale or unusable; candle fallback selected"
          : "Primary Scalp signal unavailable; candle fallback selected",
      },
    };
  }

  const holdResult = buildCanonicalEngineResult(
    {
      decision: "HOLD",
      confidence: 0,
      reason:
        "No usable primary or fallback Scalp analysis available",
      timestamp: Date.now(),
    },
    {
      pair,
      mode: "scalp",
      engineName: "scalp-unavailable",
      source: "none",
      available: false,
    }
  );

  return {
    ...holdResult,

    selection: {
      selected: "none",
      primaryAvailable: Boolean(primarySignal),
      fallbackAvailable: false,
      reason:
        "No usable Scalp engine result available",
    },
  };
}


// ---------------------------------------------------------------------------
// Swing and Intraday result selection
// ---------------------------------------------------------------------------

function selectSwingEngineResult(input = {}) {
  const pair = liveNormalizePairLabel(
    input.pair ||
      input.symbol ||
      input.pairLabel
  );

  const source =
    input.swingAnalysis ||
    input.dailyAnalysis ||
    input.analysisPipeline?.daily ||
    input.pipeline?.daily ||
    null;

  if (!liveIsPlainObject(source)) {
    return buildCanonicalEngineResult(
      {
        decision: "HOLD",
        confidence: 0,
        reason: "Swing analysis unavailable",
      },
      {
        pair,
        mode: "swing",
        engineName: "swing",
        source: "daily-analysis",
        available: false,
      }
    );
  }

  return buildCanonicalEngineResult(
    source,
    {
      pair,
      mode: "swing",
      engineName: "swing",
      source: "daily-analysis",
      requireTradePlan: false,
    }
  );
}

function selectIntradayEngineResult(input = {}) {
  const pair = liveNormalizePairLabel(
    input.pair ||
      input.symbol ||
      input.pairLabel
  );

  const source =
    input.intradayAnalysis ||
    input.h1Analysis ||
    input.analysisPipeline?.intraday ||
    input.pipeline?.intraday ||
    null;

  if (!liveIsPlainObject(source)) {
    return buildCanonicalEngineResult(
      {
        decision: "HOLD",
        confidence: 0,
        reason: "Intraday analysis unavailable",
      },
      {
        pair,
        mode: "intraday",
        engineName: "intraday",
        source: "data/intraday-h1.json",
        available: false,
      }
    );
  }

  return buildCanonicalEngineResult(
    source,
    {
      pair,
      mode: "intraday",
      engineName: "intraday",
      source: "data/intraday-h1.json",
      requireTradePlan: false,
    }
  );
}


// ---------------------------------------------------------------------------
// Consensus weighting
// ---------------------------------------------------------------------------

const DEFAULT_MASTER_ENGINE_WEIGHTS = Object.freeze({
  swing: 0.40,
  intraday: 0.35,
  scalp: 0.25,
});

function normalizeMasterWeights(rawWeights = {}) {
  const weights = {
    swing: Math.max(
      0,
      liveFiniteNumber(
        rawWeights.swing,
        DEFAULT_MASTER_ENGINE_WEIGHTS.swing
      )
    ),

    intraday: Math.max(
      0,
      liveFiniteNumber(
        rawWeights.intraday,
        DEFAULT_MASTER_ENGINE_WEIGHTS.intraday
      )
    ),

    scalp: Math.max(
      0,
      liveFiniteNumber(
        rawWeights.scalp,
        DEFAULT_MASTER_ENGINE_WEIGHTS.scalp
      )
    ),
  };

  const total =
    weights.swing +
    weights.intraday +
    weights.scalp;

  if (total <= 0) {
    return {
      ...DEFAULT_MASTER_ENGINE_WEIGHTS,
    };
  }

  return {
    swing: weights.swing / total,
    intraday: weights.intraday / total,
    scalp: weights.scalp / total,
  };
}

function masterEngineContribution(
  engineResult,
  weight
) {
  const result = liveIsPlainObject(engineResult)
    ? engineResult
    : {};

  const decision = liveExtractDecision(result);
  const confidence = liveExtractConfidence(result, 0);
  const availability =
    result.available === false ? 0 : 1;

  const directionalValue =
    liveDecisionScore(decision);

  const contribution =
    directionalValue *
    (confidence / 100) *
    weight *
    availability;

  return {
    decision,
    confidence,
    weight,
    available: availability === 1,
    contribution,
  };
}


// ---------------------------------------------------------------------------
// Master trade-plan selection
// ---------------------------------------------------------------------------

function selectMasterTradePlan(
  finalDecision,
  engines
) {
  const normalizedDecision =
    normalizeLiveDecision(finalDecision);

  if (normalizedDecision === "HOLD") {
    return null;
  }

  const candidates = [
    {
      name: "swing",
      priority: 3,
      result: engines.swing,
    },
    {
      name: "intraday",
      priority: 2,
      result: engines.intraday,
    },
    {
      name: "scalp",
      priority: 1,
      result: engines.scalp,
    },
  ]
    .filter((candidate) => {
      const result = candidate.result;

      return (
        liveIsPlainObject(result) &&
        liveExtractDecision(result) ===
          normalizedDecision &&
        liveIsPlainObject(result.tradePlan)
      );
    })
    .map((candidate) => ({
      ...candidate,
      confidence: liveExtractConfidence(
        candidate.result,
        0
      ),
    }))
    .sort((left, right) => {
      if (right.priority !== left.priority) {
        return right.priority - left.priority;
      }

      return right.confidence - left.confidence;
    });

  if (candidates.length === 0) {
    return null;
  }

  const selected = candidates[0];

  return {
    ...liveCloneValue(selected.result.tradePlan),

    sourceEngine: selected.name,
  };
}


// ---------------------------------------------------------------------------
// Master consensus
// ---------------------------------------------------------------------------

function buildMasterConsensus(input = {}) {
  const pair = liveNormalizePairLabel(
    input.pair ||
      input.symbol ||
      input.pairLabel ||
      input.swing?.pair ||
      input.intraday?.pair ||
      input.scalp?.pair
  );

  const engines = {
    swing: buildCanonicalEngineResult(
      input.swing || {},
      {
        pair,
        mode: "swing",
        engineName: "swing",
        available:
          input.swing?.available !== false,
      }
    ),

    intraday: buildCanonicalEngineResult(
      input.intraday || {},
      {
        pair,
        mode: "intraday",
        engineName: "intraday",
        available:
          input.intraday?.available !== false,
      }
    ),

    scalp: buildCanonicalEngineResult(
      input.scalp || {},
      {
        pair,
        mode: "scalp",
        engineName: "scalp",
        available:
          input.scalp?.available !== false,
      }
    ),
  };

  const weights = normalizeMasterWeights(
    input.weights ||
      input.engineWeights ||
      {}
  );

  const contributions = {
    swing: masterEngineContribution(
      engines.swing,
      weights.swing
    ),

    intraday: masterEngineContribution(
      engines.intraday,
      weights.intraday
    ),

    scalp: masterEngineContribution(
      engines.scalp,
      weights.scalp
    ),
  };

  const netContribution =
    contributions.swing.contribution +
    contributions.intraday.contribution +
    contributions.scalp.contribution;

  const activeDirectionalEngines = Object.values(
    contributions
  ).filter(
    (item) =>
      item.available &&
      item.decision !== "HOLD"
  );

  const buyEngines = activeDirectionalEngines.filter(
    (item) => item.decision === "BUY"
  );

  const sellEngines = activeDirectionalEngines.filter(
    (item) => item.decision === "SELL"
  );

  const directionalAgreement =
    buyEngines.length >= 2
      ? "BUY"
      : sellEngines.length >= 2
        ? "SELL"
        : "HOLD";

  const minimumNetContribution = liveBoundNumber(
    input.minimumNetContribution,
    0,
    1,
    0.18
  );

  const minimumDirectionalEngines = Math.max(
    1,
    Math.trunc(
      liveFiniteNumber(
        input.minimumDirectionalEngines,
        2
      )
    )
  );

  let decision = "HOLD";

  if (
    directionalAgreement === "BUY" &&
    buyEngines.length >= minimumDirectionalEngines &&
    netContribution >= minimumNetContribution
  ) {
    decision = "BUY";
  } else if (
    directionalAgreement === "SELL" &&
    sellEngines.length >= minimumDirectionalEngines &&
    netContribution <= -minimumNetContribution
  ) {
    decision = "SELL";
  }

  const directionalWeight = Math.abs(netContribution);
  const agreementCount =
    decision === "BUY"
      ? buyEngines.length
      : decision === "SELL"
        ? sellEngines.length
        : Math.max(
            buyEngines.length,
            sellEngines.length
          );

  const activeCount =
    activeDirectionalEngines.length;

  const agreementRatio =
    activeCount > 0
      ? agreementCount / activeCount
      : 0;

  const directionEngines =
    decision === "BUY"
      ? buyEngines
      : decision === "SELL"
        ? sellEngines
        : [];

  const directionConfidenceAverage =
    directionEngines.length > 0
      ? directionEngines.reduce(
          (sum, item) => sum + item.confidence,
          0
        ) / directionEngines.length
      : 0;

  let confidence;

  if (decision === "HOLD") {
    confidence = Math.round(
      Math.min(
        69,
        Math.abs(netContribution) * 100 +
          agreementRatio * 15
      )
    );
  } else {
    confidence = Math.round(
      Math.min(
        99,
        45 +
          directionalWeight * 35 +
          agreementRatio * 15 +
          directionConfidenceAverage * 0.15
      )
    );
  }

  const masterTradePlan = selectMasterTradePlan(
    decision,
    engines
  );

  // Without a valid source plan, retain the directional consensus but expose
  // no fabricated entry, stop or targets.
  const priceCandidates = [
    engines.intraday.price,
    engines.scalp.price,
    engines.swing.price,
  ].filter(Number.isFinite);

  const price =
    priceCandidates.length > 0
      ? priceCandidates[0]
      : null;

  const reasons = [];

  if (decision === "HOLD") {
    if (activeCount === 0) {
      reasons.push(
        "No directional engine produced an active setup"
      );
    } else if (
      buyEngines.length > 0 &&
      sellEngines.length > 0
    ) {
      reasons.push(
        "Directional engines are conflicting"
      );
    } else if (
      Math.abs(netContribution) <
      minimumNetContribution
    ) {
      reasons.push(
        "Weighted consensus is below the required threshold"
      );
    } else {
      reasons.push(
        "Insufficient multi-engine agreement"
      );
    }
  } else {
    reasons.push(
      `${agreementCount} engine(s) confirm ${decision}`
    );

    reasons.push(
      `Weighted consensus ${netContribution.toFixed(3)}`
    );
  }

  const timestamp = Date.now();

  return {
    pair,
    symbol: pair,
    pairLabel: pair,

    mode: "master",
    engine: "master-consensus",
    engineName: "master-consensus",

    decision,
    signal: decision,
    action: decision,
    direction: decision,

    confidence,
    confidencePct: confidence,

    score: Number(
      (netContribution * 100).toFixed(2)
    ),

    weightedScore: Number(
      (netContribution * 100).toFixed(2)
    ),

    netContribution: Number(
      netContribution.toFixed(6)
    ),

    price,
    currentPrice: price,
    lastPrice: price,

    timestamp,
    time: new Date(timestamp).toISOString(),
    generatedAt: new Date(timestamp).toISOString(),

    reason: reasons.join("; "),
    reasons,

    status:
      decision === "HOLD"
        ? "HOLD"
        : "ACTIVE",

    available: true,

    tradePlan:
      decision === "HOLD"
        ? null
        : masterTradePlan,

    plan:
      decision === "HOLD"
        ? null
        : masterTradePlan,

    entry:
      decision !== "HOLD" && masterTradePlan
        ? masterTradePlan.entry
        : null,

    entryPrice:
      decision !== "HOLD" && masterTradePlan
        ? masterTradePlan.entryPrice
        : null,

    stop:
      decision !== "HOLD" && masterTradePlan
        ? masterTradePlan.stop
        : null,

    stopLoss:
      decision !== "HOLD" && masterTradePlan
        ? masterTradePlan.stopLoss
        : null,

    sl:
      decision !== "HOLD" && masterTradePlan
        ? masterTradePlan.sl
        : null,

    target1:
      decision !== "HOLD" && masterTradePlan
        ? masterTradePlan.target1
        : null,

    target2:
      decision !== "HOLD" && masterTradePlan
        ? masterTradePlan.target2
        : null,

    target3:
      decision !== "HOLD" && masterTradePlan
        ? masterTradePlan.target3
        : null,

    takeProfit1:
      decision !== "HOLD" && masterTradePlan
        ? masterTradePlan.takeProfit1
        : null,

    takeProfit2:
      decision !== "HOLD" && masterTradePlan
        ? masterTradePlan.takeProfit2
        : null,

    takeProfit3:
      decision !== "HOLD" && masterTradePlan
        ? masterTradePlan.takeProfit3
        : null,

    tp1:
      decision !== "HOLD" && masterTradePlan
        ? masterTradePlan.tp1
        : null,

    tp2:
      decision !== "HOLD" && masterTradePlan
        ? masterTradePlan.tp2
        : null,

    tp3:
      decision !== "HOLD" && masterTradePlan
        ? masterTradePlan.tp3
        : null,

    riskReward:
      decision !== "HOLD" && masterTradePlan
        ? masterTradePlan.riskReward
        : null,

    rr:
      decision !== "HOLD" && masterTradePlan
        ? masterTradePlan.rr
        : null,

    weights,

    contributions,

    agreement: {
      direction: directionalAgreement,
      activeDirectionalEngines: activeCount,
      buyEngines: buyEngines.length,
      sellEngines: sellEngines.length,
      agreementCount,
      agreementRatio: Number(
        agreementRatio.toFixed(4)
      ),
    },

    engines: {
      swing: {
        decision: engines.swing.decision,
        confidence: engines.swing.confidence,
        score: engines.swing.score,
        available: engines.swing.available,
      },

      intraday: {
        decision: engines.intraday.decision,
        confidence: engines.intraday.confidence,
        score: engines.intraday.score,
        available: engines.intraday.available,
      },

      scalp: {
        decision: engines.scalp.decision,
        confidence: engines.scalp.confidence,
        score: engines.scalp.score,
        available: engines.scalp.available,
        source: engines.scalp.source,
      },
    },
  };
}


// ---------------------------------------------------------------------------
// Per-pair engine bundle
// ---------------------------------------------------------------------------

function attachAIMemoryAssessment(
  engineResult,
  aiMemoryState,
  context = {}
) {
  if (
    !engineResult ||
    typeof engineResult !== "object" ||
    Array.isArray(engineResult)
  ) {
    return engineResult;
  }

  const assessment =
    createAIMemoryAssessment(
      aiMemoryState,
      {
        ...context,

        pair:
          context.pair ||
          engineResult.pair ||
          engineResult.symbol ||
          engineResult.pairLabel,

        engine:
          context.engine ||
          context.mode ||
          engineResult.engineName ||
          engineResult.engine ||
          engineResult.mode,

        direction:
          engineResult.decision ||
          engineResult.signal ||
          engineResult.action ||
          engineResult.direction,

        timeframe:
          context.timeframe ||
          engineResult.timeframe ||
          engineResult.tf ||
          engineResult.interval,
      }
    );

  return applyAIMemoryConfidenceAdjustment(
    engineResult,
    assessment
  );
}

function buildPairEngineBundle(
  input = {}
) {
  const pair =
    liveNormalizePairLabel(
      input.pair ||
      input.symbol ||
      input.pairLabel
    );

  const aiMemoryState =
    input.aiMemoryState ||
    input.aiMemory ||
    createUnavailableAIMemoryState(
      "AI Memory was not supplied to the pair analysis pipeline"
    );

  const pipeline =
    liveIsPlainObject(
      input.analysisPipeline
    )
      ? input.analysisPipeline
      : liveIsPlainObject(
          input.pipeline
        )
        ? input.pipeline
        : typeof runLegacyCompatibleAnalysisPipeline ===
            "function"
          ? runLegacyCompatibleAnalysisPipeline({
              ...input,
              pair,
            })
          : {};

  // --------------------------------------------------------
  // Build original engine results first.
  //
  // These unadjusted results are used by Master consensus so
  // Phase 4 does not change the established engine weighting.
  // --------------------------------------------------------

  const baseSwing =
    selectSwingEngineResult({
      pair,

      swingAnalysis:
        input.swingAnalysis ||
        pipeline.daily,

      analysisPipeline:
        pipeline,
    });

  const baseIntraday =
    selectIntradayEngineResult({
      pair,

      intradayAnalysis:
        input.intradayAnalysis ||
        pipeline.intraday,

      analysisPipeline:
        pipeline,
    });

  const baseScalp =
    selectScalpEngineResult({
      pair,

      scalpSignalsData:
        input.scalpSignalsData ||
        input.scalpSignals,

      fallbackScalpAnalysis:
        input.fallbackScalpAnalysis ||
        input.legacyScalpAnalysis ||
        pipeline.scalp,

      allowPrimaryHold:
        input.allowPrimaryScalpHold,

      maximumPrimaryScalpAgeMs:
        input.maximumPrimaryScalpAgeMs,
    });

  // --------------------------------------------------------
  // Master consensus intentionally uses original confidence.
  // --------------------------------------------------------

  const baseMaster =
    buildMasterConsensus({
      pair,

      swing:
        baseSwing,

      intraday:
        baseIntraday,

      scalp:
        baseScalp,

      weights:
        input.masterWeights ||
        input.engineWeights,

      minimumNetContribution:
        input.minimumNetContribution,

      minimumDirectionalEngines:
        input.minimumDirectionalEngines,
    });

  // --------------------------------------------------------
  // Apply controlled AI Memory adjustment only after the
  // original Master consensus has already been calculated.
  // --------------------------------------------------------

  const swing =
    attachAIMemoryAssessment(
      baseSwing,
      aiMemoryState,
      {
        pair,
        engine: "weekly",
        mode: "swing",
        timeframe: "D1",
      }
    );

  const intraday =
    attachAIMemoryAssessment(
      baseIntraday,
      aiMemoryState,
      {
        pair,
        engine: "daily",
        mode: "intraday",
        timeframe: "1H",
      }
    );

  const scalpTimeframe =
    normalizeAIMemoryTimeframe(
      firstString(
        baseScalp.timeframe,
        baseScalp.tf,
        baseScalp.interval,

        baseScalp.sourceData &&
          baseScalp.sourceData.timeframe,

        baseScalp.raw &&
          baseScalp.raw.timeframe
      )
    ) ||
    "15m";

  const scalp =
    attachAIMemoryAssessment(
      baseScalp,
      aiMemoryState,
      {
        pair,
        engine: "scalp",
        mode: "scalp",
        timeframe:
          scalpTimeframe,
      }
    );

  const master =
    attachAIMemoryAssessment(
      baseMaster,
      aiMemoryState,
      {
        pair,
        engine: "master",
        mode: "master",
        timeframe: null,
      }
    );

  return {
    pair,
    symbol: pair,
    pairLabel: pair,

    generatedAt:
      liveNowIso(),

    timestamp:
      Date.now(),

    swing,
    intraday,
    scalp,
    master,

    engines: {
      swing,
      intraday,
      scalp,
      master,
    },

    aiMemory: {
      enabled:
        AI_MEMORY_INTEGRATION.enabled,

      available:
        Boolean(
          aiMemoryState.available
        ),

      valid:
        Boolean(
          aiMemoryState.valid
        ),

      mode:
        AI_MEMORY_INTEGRATION.mode,

      applyConfidenceAdjustment:
        AI_MEMORY_INTEGRATION
          .applyConfidenceAdjustment ===
        true,

      maximumAppliedAdjustment:
        AI_MEMORY_INTEGRATION
          .maximumAppliedAdjustment,

      minimumSamplesToApply:
        AI_MEMORY_INTEGRATION
          .minimumSamplesToApply,

      minimumReliabilityToApply:
        AI_MEMORY_INTEGRATION
          .minimumReliabilityToApply,

      generatedAt:
        aiMemoryState.generatedAt ||
        null,

      engineName:
        aiMemoryState.engineName ||
        null,

      engineVersion:
        aiMemoryState.engineVersion ||
        null,

      reason:
        aiMemoryState.reason ||
        null,
    },

    pipelineMetadata:
      liveCloneValue(
        pipeline.frameMetadata ||
        pipeline.metadata ||
        null
      ),
  };
}


// ---------------------------------------------------------------------------
// Live-analysis output schema
// ---------------------------------------------------------------------------

function buildLiveAnalysisOutput(input = {}) {
  const pairBundles = Array.isArray(input.pairs)
    ? input.pairs
    : liveIsPlainObject(input.pairs)
      ? Object.values(input.pairs)
      : [];

  const generatedTimestamp =
    liveStableTimestamp(
      input.timestamp,
      Date.now()
    );

  const generatedAt =
    input.generatedAt ||
    new Date(generatedTimestamp).toISOString();

  const byPair = {};

  for (const rawBundle of pairBundles) {
    if (!liveIsPlainObject(rawBundle)) {
      continue;
    }

    const pair = liveNormalizePairLabel(
      rawBundle.pair ||
        rawBundle.symbol ||
        rawBundle.pairLabel
    );

    if (!pair || pair === "UNKNOWN") {
      continue;
    }

    const swing = buildCanonicalEngineResult(
      rawBundle.swing ||
        rawBundle.engines?.swing ||
        {},
      {
        pair,
        mode: "swing",
        engineName: "swing",
      }
    );

    const intraday = buildCanonicalEngineResult(
      rawBundle.intraday ||
        rawBundle.engines?.intraday ||
        {},
      {
        pair,
        mode: "intraday",
        engineName: "intraday",
      }
    );

    const scalp = buildCanonicalEngineResult(
      rawBundle.scalp ||
        rawBundle.engines?.scalp ||
        {},
      {
        pair,
        mode: "scalp",
        engineName: "scalp",
      }
    );

    const master = buildCanonicalEngineResult(
      rawBundle.master ||
        rawBundle.engines?.master ||
        buildMasterConsensus({
          pair,
          swing,
          intraday,
          scalp,
        }),
      {
        pair,
        mode: "master",
        engineName: "master-consensus",
      }
    );

    const pairRecord = {
      pair,
      symbol: pair,
      pairLabel: pair,

      generatedAt,
      timestamp: generatedTimestamp,

      swing,
      intraday,
      scalp,
      master,

      engines: {
        swing,
        intraday,
        scalp,
        master,
      },

      // Legacy-compatible mode access.
      modes: {
        swing,
        intraday,
        scalp,
        master,
      },

      // Convenient top-level master aliases.
      decision: master.decision,
      signal: master.signal,
      action: master.action,
      direction: master.direction,

      confidence: master.confidence,
      score: master.score,

      price: master.price,
      currentPrice: master.currentPrice,
      lastPrice: master.lastPrice,

      tradePlan: master.tradePlan,
      plan: master.plan,

      entry: master.entry,
      stop: master.stop,
      stopLoss: master.stopLoss,

      target1: master.target1,
      target2: master.target2,
      target3: master.target3,

      tp1: master.tp1,
      tp2: master.tp2,
      tp3: master.tp3,

      riskReward: master.riskReward,
      rr: master.rr,

      reason: master.reason,
      status: master.status,
    };

    byPair[pair] = pairRecord;
  }

  const pairList = Object.values(byPair);

  return {
    generatedAt,
    updatedAt: generatedAt,
    timestamp: generatedTimestamp,

    engineVersion:
      typeof ENGINE_VERSION !== "undefined"
        ? ENGINE_VERSION
        : input.engineVersion ||
          "unknown",

    strategyVersion:
      typeof STRATEGY_VERSION !== "undefined"
        ? STRATEGY_VERSION
        : input.strategyVersion ||
          "unknown",

    status: "ok",

    pairCount: pairList.length,

    // Primary current schema.
    pairs: byPair,

    // Legacy-compatible array aliases.
    results: pairList,
    analyses: pairList,
    data: pairList,

    // Optional direct aliases for known pairs.
    xauUsd:
      byPair["XAU/USD"] || null,

    gbpJpy:
      byPair["GBP/JPY"] || null,

    "XAU/USD":
      byPair["XAU/USD"] || null,

    "GBP/JPY":
      byPair["GBP/JPY"] || null,

    metadata: {
      generatedAt,
      pairCount: pairList.length,
      engineVersion:
        typeof ENGINE_VERSION !== "undefined"
          ? ENGINE_VERSION
          : input.engineVersion ||
            "unknown",

      strategyVersion:
        typeof STRATEGY_VERSION !== "undefined"
          ? STRATEGY_VERSION
          : input.strategyVersion ||
            "unknown",
    },
  };
}


// ---------------------------------------------------------------------------
// History fingerprinting
// ---------------------------------------------------------------------------

function liveHistoryFingerprint(record) {
  const pair = liveNormalizePairLabel(
    record?.pair ||
      record?.symbol ||
      record?.pairLabel
  );

  const mode = liveNormalizeMode(
    record?.mode ||
      record?.engine ||
      "master",
    "master"
  );

  const decision = liveExtractDecision(record);

  const entry = liveFiniteNumber(
    record?.entry ??
      record?.entryPrice ??
      record?.tradePlan?.entry,
    null
  );

  const stopLoss = liveFiniteNumber(
    record?.stopLoss ??
      record?.stop ??
      record?.tradePlan?.stopLoss,
    null
  );

  const target1 = liveFiniteNumber(
    record?.target1 ??
      record?.tp1 ??
      record?.tradePlan?.target1,
    null
  );

  return [
    liveCompactPair(pair),
    mode,
    decision,
    Number.isFinite(entry) ? entry : "",
    Number.isFinite(stopLoss) ? stopLoss : "",
    Number.isFinite(target1) ? target1 : "",
  ].join("|");
}

function liveHistoryRecordFromEngine(
  engineResult,
  options = {}
) {
  const canonical =
    buildCanonicalEngineResult(
      engineResult,
      {
        pair:
          options.pair ||
          engineResult?.pair,

        mode:
          options.mode ||
          engineResult?.mode ||
          "master",

        engineName:
          options.engineName ||
          engineResult?.engine ||
          engineResult?.engineName,
      }
    );

  const recordedAt =
    liveNowIso();

  const finalConfidence =
    liveNormalizeConfidence(
      canonical.confidence,
      0
    );

  const originalConfidence =
    liveNormalizeConfidence(
      canonical.originalConfidence ??
        canonical.aiMemory
          ?.originalConfidence ??
        finalConfidence,
      finalConfidence
    );

  const aiMemoryAdjustedConfidence =
    liveNormalizeConfidence(
      canonical.aiMemoryAdjustedConfidence ??
        canonical.aiMemory
          ?.adjustedConfidence ??
        finalConfidence,
      finalConfidence
    );

  const appliedConfidenceAdjustment =
    liveFiniteNumber(
      canonical.aiMemory
        ?.appliedConfidenceAdjustment ??
        canonical.aiMemory
          ?.confidenceAdjustment,
      0
    );

  const aiMemoryApplied =
    canonical.aiMemory?.applied ===
    true;

  return {
    id:
      options.id ||
      `${Date.now()}-${liveCompactPair(
        canonical.pair
      )}-${canonical.mode}`,

    recordedAt,
    createdAt: recordedAt,
    updatedAt: recordedAt,

    pair: canonical.pair,
    symbol: canonical.pair,
    pairLabel: canonical.pair,

    mode: canonical.mode,
    engine: canonical.engine,
    engineName:
      canonical.engineName,

    decision:
      canonical.decision,

    signal:
      canonical.signal,

    action:
      canonical.action,

    direction:
      canonical.direction,

    // Final confidence used by the live engine,
    // Telegram and all existing consumers.
    confidence:
      finalConfidence,

    confidencePct:
      finalConfidence,

    // Phase 4 audit fields.
    originalConfidence,

    aiMemoryAdjustedConfidence,

    appliedConfidenceAdjustment,

    aiMemoryApplied,

    score:
      canonical.score,

    price:
      canonical.price,

    currentPrice:
      canonical.currentPrice,

    entry:
      canonical.entry,

    entryPrice:
      canonical.entryPrice,

    stop:
      canonical.stop,

    stopLoss:
      canonical.stopLoss,

    sl:
      canonical.sl,

    target1:
      canonical.target1,

    target2:
      canonical.target2,

    target3:
      canonical.target3,

    takeProfit1:
      canonical.takeProfit1,

    takeProfit2:
      canonical.takeProfit2,

    takeProfit3:
      canonical.takeProfit3,

    tp1:
      canonical.tp1,

    tp2:
      canonical.tp2,

    tp3:
      canonical.tp3,

    riskReward:
      canonical.riskReward,

    rr:
      canonical.rr,

    reason:
      canonical.reason,

    source:
      canonical.source,

    signalTimestamp:
      canonical.timestamp,

    signalTime:
      canonical.time,

    status:
      canonical.decision ===
      "HOLD"
        ? "hold"
        : "open",

    outcome: null,
    resolvedAt: null,

    fingerprint:
      liveHistoryFingerprint(
        canonical
      ),

    aiMemory:
      liveCloneValue(
        canonical.aiMemory ||
        null
      ),

    snapshot:
      liveCloneValue(
        canonical
      ),
  };
}


// ---------------------------------------------------------------------------
// History normalization
// ---------------------------------------------------------------------------

function normalizeAnalysisHistory(rawHistory) {
  if (Array.isArray(rawHistory)) {
    return {
      version: 1,
      updatedAt: liveNowIso(),
      records: rawHistory,
    };
  }

  if (!liveIsPlainObject(rawHistory)) {
    return {
      version: 1,
      updatedAt: liveNowIso(),
      records: [],
    };
  }

  const records =
    liveAsArray(rawHistory.records).length > 0
      ? rawHistory.records
      : liveAsArray(rawHistory.history).length > 0
        ? rawHistory.history
        : liveAsArray(rawHistory.items).length > 0
          ? rawHistory.items
          : liveAsArray(rawHistory.signals);

  return {
    ...rawHistory,

    version:
      liveFiniteNumber(rawHistory.version, 1),

    updatedAt:
      rawHistory.updatedAt ||
      liveNowIso(),

    records,

    // Preserve common aliases.
    history: records,
    items: records,
  };
}

function shouldAppendHistoryRecord(
  history,
  record,
  options = {}
) {
  if (!liveIsPlainObject(record)) {
    return false;
  }

  const decision = liveExtractDecision(record);

  if (
    decision === "HOLD" &&
    options.includeHold !== true
  ) {
    return false;
  }

  const records = liveAsArray(history.records);
  const fingerprint =
    record.fingerprint ||
    liveHistoryFingerprint(record);

  const dedupeWindowMs = Math.max(
    0,
    liveFiniteNumber(
      options.dedupeWindowMs,
      30 * 60 * 1000
    )
  );

  for (
    let index = records.length - 1;
    index >= 0;
    index -= 1
  ) {
    const existing = records[index];

    if (!liveIsPlainObject(existing)) {
      continue;
    }

    const existingTimestamp = liveExtractTimestamp(
      existing,
      0
    );

    if (
      dedupeWindowMs > 0 &&
      existingTimestamp > 0 &&
      Date.now() - existingTimestamp >
        dedupeWindowMs
    ) {
      break;
    }

    const existingFingerprint =
      existing.fingerprint ||
      liveHistoryFingerprint(existing);

    if (existingFingerprint === fingerprint) {
      return false;
    }
  }

  return true;
}

function appendAnalysisHistoryRecords(
  rawHistory,
  recordsToAppend,
  options = {}
) {
  const history =
    normalizeAnalysisHistory(rawHistory);

  const existingRecords =
    liveAsArray(history.records);

  const appended = [];

  for (const rawRecord of liveAsArray(recordsToAppend)) {
    const record = liveIsPlainObject(rawRecord)
      ? rawRecord
      : null;

    if (!record) {
      continue;
    }

    if (
      shouldAppendHistoryRecord(
        {
          records: [
            ...existingRecords,
            ...appended,
          ],
        },
        record,
        options
      )
    ) {
      appended.push(record);
    }
  }

  const maximumRecords = Math.max(
    1,
    Math.trunc(
      liveFiniteNumber(
        options.maximumRecords,
        5000
      )
    )
  );

  const records = [
    ...existingRecords,
    ...appended,
  ].slice(-maximumRecords);

  const updatedAt = liveNowIso();

  return {
    history: {
      ...history,

      updatedAt,
      records,

      // Preserve aliases used by older readers.
      history: records,
      items: records,

      count: records.length,
    },

    appended,
    appendedCount: appended.length,
  };
}


// ---------------------------------------------------------------------------
// History collection from current output
// ---------------------------------------------------------------------------

function collectHistoryRecordsFromOutput(
  liveOutput,
  options = {}
) {
  const records = [];

  const pairRecords = liveIsPlainObject(
    liveOutput?.pairs
  )
    ? Object.values(liveOutput.pairs)
    : liveAsArray(liveOutput?.results);

  const modes = Array.isArray(options.modes)
    ? options.modes.map((mode) =>
        liveNormalizeMode(mode)
      )
    : ["master", "swing", "intraday", "scalp"];

  for (const pairRecord of pairRecords) {
    if (!liveIsPlainObject(pairRecord)) {
      continue;
    }

    const pair = liveNormalizePairLabel(
      pairRecord.pair ||
        pairRecord.symbol
    );

    for (const mode of modes) {
      const engineResult =
        pairRecord[mode] ||
        pairRecord.engines?.[mode] ||
        pairRecord.modes?.[mode];

      if (!liveIsPlainObject(engineResult)) {
        continue;
      }

      const decision =
        liveExtractDecision(engineResult);

      if (
        decision === "HOLD" &&
        options.includeHold !== true
      ) {
        continue;
      }

      records.push(
        liveHistoryRecordFromEngine(
          engineResult,
          {
            pair,
            mode,
          }
        )
      );
    }
  }

  return records;
}


// ---------------------------------------------------------------------------
// Notify-state normalization
// ---------------------------------------------------------------------------

function normalizeNotifyState(rawState) {
  if (!liveIsPlainObject(rawState)) {
    return {
      version: 1,
      updatedAt: liveNowIso(),
      signals: {},
    };
  }

  const signals =
    liveIsPlainObject(rawState.signals)
      ? rawState.signals
      : liveIsPlainObject(rawState.notifications)
        ? rawState.notifications
        : liveIsPlainObject(rawState.state)
          ? rawState.state
          : {};

  return {
    ...rawState,

    version:
      liveFiniteNumber(rawState.version, 1),

    updatedAt:
      rawState.updatedAt ||
      liveNowIso(),

    signals,

    // Preserve older aliases.
    notifications: signals,
    state: signals,
  };
}

function liveNotifyStateKey(record) {
  const pair = liveCompactPair(
    record?.pair ||
      record?.symbol ||
      record?.pairLabel
  );

  const mode = liveNormalizeMode(
    record?.mode ||
      record?.engine ||
      "master",
    "master"
  );

  return `${pair}:${mode}`;
}

function liveNotifySignature(record) {
  return liveHistoryFingerprint(record);
}


// ---------------------------------------------------------------------------
// Telegram notification eligibility
// ---------------------------------------------------------------------------

function shouldSendTelegramNotification(
  rawNotifyState,
  engineResult,
  options = {}
) {
  const state =
    normalizeNotifyState(rawNotifyState);

  const canonical =
    buildCanonicalEngineResult(
      engineResult,
      {
        pair:
          options.pair ||
          engineResult?.pair,

        mode:
          options.mode ||
          engineResult?.mode ||
          "master",
      }
    );

  const decision =
    canonical.decision;

  if (
    decision === "HOLD" &&
    options.notifyHold !== true
  ) {
    return {
      shouldSend: false,
      reason: "HOLD notifications are disabled",
      state,
      canonical,
    };
  }

  const minimumConfidence =
    liveNormalizeConfidence(
      options.minimumConfidence,
      0
    );

  if (
    canonical.confidence <
    minimumConfidence
  ) {
    return {
      shouldSend: false,
      reason:
        `Confidence ${canonical.confidence}% is below ${minimumConfidence}%`,
      state,
      canonical,
    };
  }

  const key =
    liveNotifyStateKey(canonical);

  const signature =
    liveNotifySignature(canonical);

  const previous =
    liveIsPlainObject(state.signals[key])
      ? state.signals[key]
      : null;

  const cooldownMs = Math.max(
    0,
    liveFiniteNumber(
      options.cooldownMs,
      4 * 60 * 60 * 1000
    )
  );

  if (previous) {
    const previousSignature =
      liveNonEmptyString(
        previous.signature ||
          previous.fingerprint
      );

    const previousSentAt =
      liveStableTimestamp(
        previous.sentAt ||
          previous.timestamp ||
          previous.updatedAt,
        0
      );

    const stillInCooldown =
      cooldownMs > 0 &&
      previousSentAt > 0 &&
      Date.now() - previousSentAt <
        cooldownMs;

    if (
      previousSignature === signature &&
      stillInCooldown
    ) {
      return {
        shouldSend: false,
        reason:
          "An identical signal was already notified within the cooldown window",
        state,
        canonical,
        key,
        signature,
      };
    }
  }

  return {
    shouldSend: true,
    reason: "Signal is eligible for notification",
    state,
    canonical,
    key,
    signature,
  };
}

function updateNotifyStateAfterSend(
  rawNotifyState,
  engineResult,
  options = {}
) {
  const eligibility =
    shouldSendTelegramNotification(
      rawNotifyState,
      engineResult,
      {
        ...options,
        cooldownMs: 0,
      }
    );

  const state =
    eligibility.state;

  const canonical =
    eligibility.canonical;

  const key =
    eligibility.key ||
    liveNotifyStateKey(
      canonical
    );

  const signature =
    eligibility.signature ||
    liveNotifySignature(
      canonical
    );

  const sentAt =
    liveNowIso();

  const finalConfidence =
    liveNormalizeConfidence(
      canonical.confidence,
      0
    );

  const originalConfidence =
    liveNormalizeConfidence(
      canonical.originalConfidence ??
        canonical.aiMemory
          ?.originalConfidence ??
        finalConfidence,
      finalConfidence
    );

  const appliedConfidenceAdjustment =
    liveFiniteNumber(
      canonical.aiMemory
        ?.appliedConfidenceAdjustment ??
        canonical.aiMemory
          ?.confidenceAdjustment,
      0
    );

  const signals = {
    ...state.signals,

    [key]: {
      pair:
        canonical.pair,

      mode:
        canonical.mode,

      decision:
        canonical.decision,

      // Final adjusted confidence used in
      // the Telegram eligibility check.
      confidence:
        finalConfidence,

      // Additive Phase 4 audit fields.
      originalConfidence,

      aiMemoryAdjustedConfidence:
        finalConfidence,

      appliedConfidenceAdjustment,

      aiMemoryApplied:
        canonical.aiMemory
          ?.applied === true,

      signature,
      fingerprint:
        signature,

      sentAt,
      updatedAt:
        sentAt,

      timestamp:
        Date.now(),

      messageId:
        options.messageId ||
        null,
    },
  };

  return {
    ...state,

    updatedAt:
      sentAt,

    signals,

    notifications:
      signals,

    state:
      signals,
  };
}


// ---------------------------------------------------------------------------
// Telegram formatting
// ---------------------------------------------------------------------------

function liveEscapeTelegramHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function liveFormatTelegramPrice(
  value,
  pair
) {
  const parsed = liveFiniteNumber(value);

  if (!Number.isFinite(parsed)) {
    return "—";
  }

  const decimals =
    typeof livePairPriceDecimals === "function"
      ? livePairPriceDecimals(pair)
      : liveCompactPair(pair).endsWith("JPY")
        ? 3
        : liveCompactPair(pair) === "XAUUSD"
          ? 2
          : 5;

  return parsed.toFixed(decimals);
}

function liveDecisionEmoji(decision) {
  const normalized =
    normalizeLiveDecision(decision);

  if (normalized === "BUY") return "🟢";
  if (normalized === "SELL") return "🔴";

  return "🟡";
}

function formatTelegramSignalMessage(
  engineResult,
  options = {}
) {
  const canonical =
    buildCanonicalEngineResult(
      engineResult,
      {
        pair:
          options.pair ||
          engineResult?.pair,

        mode:
          options.mode ||
          engineResult?.mode ||
          "master",
      }
    );

  const emoji =
    liveDecisionEmoji(canonical.decision);

  const title =
    options.title ||
    "PipSight Pro Signal";

  const lines = [
    `<b>${liveEscapeTelegramHtml(title)}</b>`,
    "",
    `${emoji} <b>${liveEscapeTelegramHtml(canonical.decision)}</b>`,
    `<b>Pair:</b> ${liveEscapeTelegramHtml(canonical.pair)}`,
    `<b>Engine:</b> ${liveEscapeTelegramHtml(canonical.mode.toUpperCase())}`,
    `<b>Confidence:</b> ${canonical.confidence}%`,
  ];

  if (Number.isFinite(canonical.price)) {
    lines.push(
      `<b>Market:</b> ${liveFormatTelegramPrice(
        canonical.price,
        canonical.pair
      )}`
    );
  }

  if (
    canonical.decision !== "HOLD" &&
    canonical.tradePlan
  ) {
    lines.push("");
    lines.push(
      `<b>Entry:</b> ${liveFormatTelegramPrice(
        canonical.entry,
        canonical.pair
      )}`
    );

    lines.push(
      `<b>Stop Loss:</b> ${liveFormatTelegramPrice(
        canonical.stopLoss,
        canonical.pair
      )}`
    );

    lines.push(
      `<b>TP1:</b> ${liveFormatTelegramPrice(
        canonical.target1,
        canonical.pair
      )}`
    );

    if (Number.isFinite(canonical.target2)) {
      lines.push(
        `<b>TP2:</b> ${liveFormatTelegramPrice(
          canonical.target2,
          canonical.pair
        )}`
      );
    }

    if (Number.isFinite(canonical.target3)) {
      lines.push(
        `<b>TP3:</b> ${liveFormatTelegramPrice(
          canonical.target3,
          canonical.pair
        )}`
      );
    }

    if (
      Number.isFinite(
        canonical.riskReward
      )
    ) {
      lines.push(
        `<b>Risk:Reward:</b> 1:${canonical.riskReward.toFixed(2)}`
      );
    }
  }

  if (canonical.reason) {
    lines.push("");
    lines.push(
      `<b>Reason:</b> ${liveEscapeTelegramHtml(
        canonical.reason
      )}`
    );
  }

  lines.push("");
  lines.push(
    `<i>${liveEscapeTelegramHtml(
      new Date(canonical.timestamp).toISOString()
    )}</i>`
  );

  return lines.join("\n");
}


// ---------------------------------------------------------------------------
// Telegram transport
// ---------------------------------------------------------------------------

function liveTelegramConfig(options = {}) {
  const token =
    options.token ||
    options.botToken ||
    process.env.TELEGRAM_BOT_TOKEN ||
    process.env.TELEGRAM_TOKEN ||
    "";

  const chatId =
    options.chatId ||
    options.chat_id ||
    process.env.TELEGRAM_CHAT_ID ||
    "";

  return {
    token: liveNonEmptyString(token),
    chatId: liveNonEmptyString(chatId),

    enabled:
      Boolean(
        liveNonEmptyString(token) &&
        liveNonEmptyString(chatId)
      ),

    timeoutMs: Math.max(
      1000,
      liveFiniteNumber(
        options.timeoutMs,
        typeof TELEGRAM_TIMEOUT_MS !== "undefined"
          ? TELEGRAM_TIMEOUT_MS
          : 15000
      )
    ),
  };
}

async function sendTelegramMessage(
  message,
  options = {}
) {
  const config =
    liveTelegramConfig(options);

  if (!config.enabled) {
    return {
      ok: false,
      skipped: true,
      reason:
        "Telegram token or chat ID is not configured",
    };
  }

  if (
    typeof fetch !== "function"
  ) {
    return {
      ok: false,
      skipped: true,
      reason:
        "Global fetch is unavailable in this Node.js runtime",
    };
  }

  const controller =
    typeof AbortController === "function"
      ? new AbortController()
      : null;

  const timeoutHandle = setTimeout(() => {
    if (controller) {
      controller.abort();
    }
  }, config.timeoutMs);

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${config.token}/sendMessage`,
      {
        method: "POST",

        headers: {
          "content-type": "application/json",
        },

        body: JSON.stringify({
          chat_id: config.chatId,
          text: String(message || ""),
          parse_mode:
            options.parseMode ||
            "HTML",

          disable_web_page_preview: true,

          disable_notification:
            options.disableNotification === true,
        }),

        signal:
          controller
            ? controller.signal
            : undefined,
      }
    );

    let payload = null;

    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok || payload?.ok === false) {
      return {
        ok: false,
        skipped: false,

        status: response.status,

        reason:
          payload?.description ||
          `Telegram HTTP ${response.status}`,

        payload,
      };
    }

    return {
      ok: true,
      skipped: false,

      status: response.status,

      messageId:
        payload?.result?.message_id ||
        null,

      payload,
    };
  } catch (error) {
    const aborted =
      error &&
      (
        error.name === "AbortError" ||
        String(error.message || "")
          .toLowerCase()
          .includes("abort")
      );

    return {
      ok: false,
      skipped: false,

      reason: aborted
        ? `Telegram request timed out after ${config.timeoutMs}ms`
        : `Telegram request failed: ${
            error?.message ||
            String(error)
          }`,
    };
  } finally {
    clearTimeout(timeoutHandle);
  }
}


// ---------------------------------------------------------------------------
// Telegram processing for one engine
// ---------------------------------------------------------------------------

async function processTelegramNotification(
  rawNotifyState,
  engineResult,
  options = {}
) {
  const eligibility =
    shouldSendTelegramNotification(
      rawNotifyState,
      engineResult,
      options
    );

  if (!eligibility.shouldSend) {
    return {
      sent: false,
      skipped: true,

      reason: eligibility.reason,

      notifyState:
        eligibility.state,

      engine:
        eligibility.canonical,
    };
  }

  const message =
    options.message ||
    formatTelegramSignalMessage(
      eligibility.canonical,
      options
    );

  const sendResult =
    await sendTelegramMessage(
      message,
      options
    );

  if (!sendResult.ok) {
    return {
      sent: false,
      skipped:
        sendResult.skipped === true,

      reason:
        sendResult.reason ||
        "Telegram send failed",

      sendResult,

      notifyState:
        eligibility.state,

      engine:
        eligibility.canonical,
    };
  }

  const notifyState =
    updateNotifyStateAfterSend(
      eligibility.state,
      eligibility.canonical,
      {
        ...options,

        messageId:
          sendResult.messageId,
      }
    );

  return {
    sent: true,
    skipped: false,

    reason:
      "Telegram notification sent",

    sendResult,
    notifyState,

    engine:
      eligibility.canonical,

    message,
  };
}


// ---------------------------------------------------------------------------
// Telegram processing for complete live output
// ---------------------------------------------------------------------------

async function processLiveOutputNotifications(
  liveOutput,
  rawNotifyState,
  options = {}
) {
  let notifyState =
    normalizeNotifyState(rawNotifyState);

  const results = [];

  const modes = Array.isArray(options.modes)
    ? options.modes.map((mode) =>
        liveNormalizeMode(mode)
      )
    : ["master"];

  const pairRecords =
    liveIsPlainObject(liveOutput?.pairs)
      ? Object.values(liveOutput.pairs)
      : liveAsArray(liveOutput?.results);

  for (const pairRecord of pairRecords) {
    if (!liveIsPlainObject(pairRecord)) {
      continue;
    }

    const pair =
      liveNormalizePairLabel(
        pairRecord.pair ||
          pairRecord.symbol
      );

    for (const mode of modes) {
      const engineResult =
        pairRecord[mode] ||
        pairRecord.engines?.[mode] ||
        pairRecord.modes?.[mode];

      if (!liveIsPlainObject(engineResult)) {
        continue;
      }

      const result =
        await processTelegramNotification(
          notifyState,
          engineResult,
          {
            ...options,
            pair,
            mode,
          }
        );

      notifyState =
        result.notifyState ||
        notifyState;

      results.push({
        pair,
        mode,
        sent: result.sent,
        skipped: result.skipped,
        reason: result.reason,
        messageId:
          result.sendResult?.messageId ||
          null,
      });
    }
  }

  return {
    notifyState: {
      ...notifyState,
      updatedAt: liveNowIso(),
    },

    results,

    sentCount: results.filter(
      (result) => result.sent
    ).length,

    skippedCount: results.filter(
      (result) => result.skipped
    ).length,

    failedCount: results.filter(
      (result) =>
        !result.sent &&
        !result.skipped
    ).length,
  };
}


// ---------------------------------------------------------------------------
// Complete output/history/notification assembly
// ---------------------------------------------------------------------------

async function assembleLiveAnalysisArtifacts(
  input = {}
) {
  const output =
    buildLiveAnalysisOutput({
      pairs:
        input.pairBundles ||
        input.pairs ||
        [],

      timestamp:
        input.timestamp,

      generatedAt:
        input.generatedAt,

      engineVersion:
        input.engineVersion,

      strategyVersion:
        input.strategyVersion,
    });

  const historyCandidates =
    collectHistoryRecordsFromOutput(
      output,
      {
        modes:
          input.historyModes ||
          ["master", "swing", "intraday", "scalp"],

        includeHold:
          input.includeHoldHistory === true,
      }
    );

  const historyResult =
    appendAnalysisHistoryRecords(
      input.analysisHistory ||
        input.history ||
        {},
      historyCandidates,
      {
        includeHold:
          input.includeHoldHistory === true,

        dedupeWindowMs:
          input.historyDedupeWindowMs,

        maximumRecords:
          input.maximumHistoryRecords,
      }
    );

  let notificationResult = {
    notifyState:
      normalizeNotifyState(
        input.notifyState
      ),

    results: [],
    sentCount: 0,
    skippedCount: 0,
    failedCount: 0,
  };

  if (input.processTelegram !== false) {
    notificationResult =
      await processLiveOutputNotifications(
        output,
        input.notifyState,
        {
          modes:
            input.telegramModes ||
            ["master"],

          minimumConfidence:
            input.telegramMinimumConfidence,

          cooldownMs:
            input.telegramCooldownMs,

          notifyHold:
            input.telegramNotifyHold === true,

          token:
            input.telegramToken,

          chatId:
            input.telegramChatId,

          timeoutMs:
            input.telegramTimeoutMs,

          disableNotification:
            input.telegramSilent === true,

          title:
            input.telegramTitle ||
            "PipSight Pro Signal",
        }
      );
  }

  return {
    output,

    history:
      historyResult.history,

    appendedHistory:
      historyResult.appended,

    appendedHistoryCount:
      historyResult.appendedCount,

    notifyState:
      notificationResult.notifyState,

    telegram:
      {
        results:
          notificationResult.results,

        sentCount:
          notificationResult.sentCount,

        skippedCount:
          notificationResult.skippedCount,

        failedCount:
          notificationResult.failedCount,
      },
  };
}


// ---------------------------------------------------------------------------
// Legacy-compatible aliases
// ---------------------------------------------------------------------------

function selectScalpResult(input = {}) {
  return selectScalpEngineResult(input);
}

function buildMasterAnalysis(input = {}) {
  return buildMasterConsensus(input);
}

function buildMasterSignal(input = {}) {
  return buildMasterConsensus(input);
}

function buildPairAnalysis(input = {}) {
  return buildPairEngineBundle(input);
}

function assembleLiveAnalysis(input = {}) {
  return buildLiveAnalysisOutput(input);
}

function buildAnalysisHistoryRecord(
  engineResult,
  options = {}
) {
  return liveHistoryRecordFromEngine(
    engineResult,
    options
  );
}

function appendAnalysisHistory(
  rawHistory,
  records,
  options = {}
) {
  return appendAnalysisHistoryRecords(
    rawHistory,
    records,
    options
  );
}

function formatTelegramMessage(
  engineResult,
  options = {}
) {
  return formatTelegramSignalMessage(
    engineResult,
    options
  );
}

async function notifyTelegram(
  rawNotifyState,
  engineResult,
  options = {}
) {
  return processTelegramNotification(
    rawNotifyState,
    engineResult,
    options
  );
}

// ============================================================================
// PART 6 — FINAL RUNTIME ORCHESTRATION
//          + INPUT LOADING
//          + ATOMIC OUTPUT WRITES
//          + STARTUP VALIDATION
//          + ERROR HANDLING
//          + MAIN EXECUTION
// ============================================================================
//
// This is the final section of run-live-analysis.js.
//
// It:
// - Resolves all input/output paths safely.
// - Loads Scalp signals, Scalp candles, H1 candles and Daily OHLC.
// - Supports pair-keyed, array-based and nested JSON structures.
// - Runs XAU/USD and GBP/JPY through the complete pipeline.
// - Preserves primary Scalp signals with candle-analysis fallback.
// - Builds Swing, Intraday, Scalp and Master results.
// - Preserves existing live-analysis.json compatibility fields.
// - Appends analysis-history.json without duplicate active signals.
// - Preserves notify-state.json and Telegram cooldown behavior.
// - Writes all JSON files atomically.
// - Keeps Telegram failures non-fatal.
// - Provides startup validation and final execution.
// ============================================================================


// ---------------------------------------------------------------------------
// Final runtime configuration
// ---------------------------------------------------------------------------

const P6_DATA_DIRECTORY =
  typeof DATA_DIR !== "undefined"
    ? DATA_DIR
    : path.join(__dirname, "data");

const P6_SCALP_SIGNALS_PATH =
  typeof SCALP_SIGNALS_PATH !== "undefined"
    ? SCALP_SIGNALS_PATH
    : path.join(
        P6_DATA_DIRECTORY,
        "scalp-signals.json"
      );

const P6_SCALP_CANDLES_PATH =
  typeof SCALP_CANDLES_PATH !== "undefined"
    ? SCALP_CANDLES_PATH
    : path.join(
        P6_DATA_DIRECTORY,
        "scalp-candles.json"
      );

const P6_INTRADAY_H1_PATH =
  typeof INTRADAY_H1_PATH !== "undefined"
    ? INTRADAY_H1_PATH
    : path.join(
        P6_DATA_DIRECTORY,
        "intraday-h1.json"
      );

const P6_DAILY_OHLC_PATH =
  typeof DAILY_OHLC_PATH !== "undefined"
    ? DAILY_OHLC_PATH
    : path.join(
        P6_DATA_DIRECTORY,
        "daily-ohlc.json"
      );

const P6_LIVE_ANALYSIS_PATH =
  typeof LIVE_ANALYSIS_PATH !== "undefined"
    ? LIVE_ANALYSIS_PATH
    : path.join(
        P6_DATA_DIRECTORY,
        "live-analysis.json"
      );

const P6_ANALYSIS_HISTORY_PATH =
  typeof ANALYSIS_HISTORY_PATH !== "undefined"
    ? ANALYSIS_HISTORY_PATH
    : path.join(
        P6_DATA_DIRECTORY,
        "analysis-history.json"
      );

const P6_NOTIFY_STATE_PATH =
  typeof NOTIFY_STATE_PATH !== "undefined"
    ? NOTIFY_STATE_PATH
    : path.join(
        P6_DATA_DIRECTORY,
        "notify-state.json"
      );

const P6_RUNTIME_PAIRS = Object.freeze([
  "XAU/USD",
  "GBP/JPY",
]);

const P6_MAX_HISTORY_RECORDS = 5000;

const P6_HISTORY_DEDUPE_WINDOW_MS =
  30 * 60 * 1000;

const P6_DEFAULT_TELEGRAM_COOLDOWN_MS =
  4 * 60 * 60 * 1000;

const P6_DEFAULT_TELEGRAM_MINIMUM_CONFIDENCE = 70;


// ---------------------------------------------------------------------------
// Runtime logging
// ---------------------------------------------------------------------------

function p6Log(level, message, details = null) {
  const timestamp = new Date().toISOString();
  const normalizedLevel = String(
    level || "INFO"
  ).toUpperCase();

  const prefix =
    `[${timestamp}] [run-live-analysis] [${normalizedLevel}]`;

  if (
    details !== null &&
    details !== undefined
  ) {
    if (
      normalizedLevel === "ERROR" ||
      normalizedLevel === "WARN"
    ) {
      console.error(prefix, message, details);
    } else {
      console.log(prefix, message, details);
    }

    return;
  }

  if (
    normalizedLevel === "ERROR" ||
    normalizedLevel === "WARN"
  ) {
    console.error(prefix, message);
  } else {
    console.log(prefix, message);
  }
}

function p6ErrorMessage(error) {
  if (!error) {
    return "Unknown error";
  }

  if (error instanceof Error) {
    return error.stack || error.message;
  }

  return String(error);
}


// ---------------------------------------------------------------------------
// Directory and file helpers
// ---------------------------------------------------------------------------

function p6EnsureDirectory(directoryPath) {
  fs.mkdirSync(directoryPath, {
    recursive: true,
  });
}

function p6FileExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function p6ReadJsonFile(
  filePath,
  fallbackValue,
  options = {}
) {
  if (!p6FileExists(filePath)) {
    if (options.required === true) {
      p6Log(
        "WARN",
        `Required input file is missing: ${filePath}`
      );
    }

    return liveCloneValue(fallbackValue);
  }

  try {
    const rawText = fs.readFileSync(
      filePath,
      "utf8"
    );

    if (!rawText.trim()) {
      p6Log(
        "WARN",
        `JSON file is empty: ${filePath}`
      );

      return liveCloneValue(fallbackValue);
    }

    return JSON.parse(rawText);
  } catch (error) {
    p6Log(
      "WARN",
      `Could not read JSON file: ${filePath}`,
      p6ErrorMessage(error)
    );

    return liveCloneValue(fallbackValue);
  }
}

function p6AtomicWriteJson(
  filePath,
  value,
  options = {}
) {
  const directory = path.dirname(filePath);
  const fileName = path.basename(filePath);

  p6EnsureDirectory(directory);

  const temporaryPath = path.join(
    directory,
    `.${fileName}.${process.pid}.${Date.now()}.tmp`
  );

  const spacing =
    Number.isFinite(Number(options.spacing))
      ? Number(options.spacing)
      : 2;

  const serialized =
    `${JSON.stringify(value, null, spacing)}\n`;

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
      if (p6FileExists(temporaryPath)) {
        fs.unlinkSync(temporaryPath);
      }
    } catch {
      // Cleanup failure must not hide the original write error.
    }

    throw error;
  }
}

function p6CreateBackupIfRequested(
  filePath,
  enabled
) {
  if (!enabled || !p6FileExists(filePath)) {
    return null;
  }

  const backupPath =
    `${filePath}.backup`;

  try {
    fs.copyFileSync(
      filePath,
      backupPath
    );

    return backupPath;
  } catch (error) {
    p6Log(
      "WARN",
      `Could not create backup for ${filePath}`,
      p6ErrorMessage(error)
    );

    return null;
  }
}


// ---------------------------------------------------------------------------
// Environment helpers
// ---------------------------------------------------------------------------

function p6EnvironmentBoolean(
  name,
  fallback = false
) {
  const value = process.env[name];

  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return fallback;
  }

  const normalized = String(value)
    .trim()
    .toLowerCase();

  if (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  ) {
    return true;
  }

  if (
    normalized === "0" ||
    normalized === "false" ||
    normalized === "no" ||
    normalized === "off"
  ) {
    return false;
  }

  return fallback;
}

function p6EnvironmentNumber(
  name,
  fallback
) {
  const parsed = Number(process.env[name]);

  return Number.isFinite(parsed)
    ? parsed
    : fallback;
}


// ---------------------------------------------------------------------------
// Input-shape helpers
// ---------------------------------------------------------------------------

function p6LooksLikeCandle(value) {
  if (!liveIsPlainObject(value)) {
    return false;
  }

  const hasClose =
    value.close !== undefined ||
    value.Close !== undefined ||
    value.c !== undefined ||
    value.price !== undefined;

  const hasTime =
    value.timestamp !== undefined ||
    value.time !== undefined ||
    value.date !== undefined ||
    value.datetime !== undefined ||
    value.openTime !== undefined;

  return hasClose && hasTime;
}

function p6LooksLikeSignal(value) {
  if (!liveIsPlainObject(value)) {
    return false;
  }

  return [
    "decision",
    "signal",
    "action",
    "direction",
    "recommendation",
    "bias",
    "side",
  ].some(
    (key) =>
      value[key] !== undefined &&
      value[key] !== null
  );
}

function p6PairMatches(value, pair) {
  const candidate =
    liveNormalizePairLabel(value);

  return (
    candidate ===
      liveNormalizePairLabel(pair) ||
    liveCompactPair(candidate) ===
      liveCompactPair(pair)
  );
}

function p6ObjectPairMatches(
  object,
  pair
) {
  if (!liveIsPlainObject(object)) {
    return false;
  }

  const objectPair =
    object.pair ||
    object.symbol ||
    object.pairLabel ||
    object.instrument ||
    object.market ||
    object.asset;

  return objectPair
    ? p6PairMatches(objectPair, pair)
    : false;
}


// ---------------------------------------------------------------------------
// Recursive pair-data extraction
// ---------------------------------------------------------------------------

function p6ExtractPairValue(
  container,
  pair,
  options = {},
  depth = 0
) {
  if (
    container === null ||
    container === undefined ||
    depth > 7
  ) {
    return null;
  }

  const expectedType =
    options.expectedType ||
    "any";

  if (Array.isArray(container)) {
    if (
      expectedType === "candles" &&
      container.length > 0 &&
      container.every(
        (item) =>
          p6LooksLikeCandle(item)
      )
    ) {
      const pairTaggedRows =
        container.filter(
          (item) =>
            !p6ObjectPairMatches(item, pair) ||
            p6ObjectPairMatches(item, pair)
        );

      return pairTaggedRows;
    }

    const matchingItems =
      container.filter(
        (item) =>
          p6ObjectPairMatches(item, pair)
      );

    if (matchingItems.length > 0) {
      if (expectedType === "candles") {
        const nestedRows = [];

        for (const item of matchingItems) {
          const nested =
            item.candles ||
            item.rows ||
            item.data ||
            item.prices ||
            item.ohlc;

          if (Array.isArray(nested)) {
            nestedRows.push(...nested);
          } else if (p6LooksLikeCandle(item)) {
            nestedRows.push(item);
          }
        }

        if (nestedRows.length > 0) {
          return nestedRows;
        }
      }

      if (
        expectedType === "signal" ||
        expectedType === "any"
      ) {
        return matchingItems[0];
      }
    }

    for (const item of container) {
      const nested = p6ExtractPairValue(
        item,
        pair,
        options,
        depth + 1
      );

      if (nested !== null) {
        return nested;
      }
    }

    return null;
  }

  if (!liveIsPlainObject(container)) {
    return null;
  }

  const normalizedPair =
    liveNormalizePairLabel(pair);

  const compactPair =
    liveCompactPair(pair);

  const directKeys = [
    normalizedPair,
    compactPair,
    normalizedPair.replace("/", "-"),
    normalizedPair.replace("/", "_"),
    normalizedPair.replace("/", ""),
    normalizedPair.toLowerCase(),
    compactPair.toLowerCase(),
  ];

  for (const key of directKeys) {
    if (
      Object.prototype.hasOwnProperty.call(
        container,
        key
      )
    ) {
      const directValue = container[key];

      if (
        expectedType === "candles" &&
        liveIsPlainObject(directValue)
      ) {
        const nested =
          directValue.candles ||
          directValue.rows ||
          directValue.data ||
          directValue.prices ||
          directValue.ohlc;

        if (Array.isArray(nested)) {
          return nested;
        }
      }

      return directValue;
    }
  }

  for (const [key, value] of Object.entries(container)) {
    if (
      liveCompactPair(key) === compactPair
    ) {
      if (
        expectedType === "candles" &&
        liveIsPlainObject(value)
      ) {
        const nested =
          value.candles ||
          value.rows ||
          value.data ||
          value.prices ||
          value.ohlc;

        if (Array.isArray(nested)) {
          return nested;
        }
      }

      return value;
    }
  }

  if (p6ObjectPairMatches(container, pair)) {
    if (expectedType === "candles") {
      const nested =
        container.candles ||
        container.rows ||
        container.data ||
        container.prices ||
        container.ohlc ||
        container.history;

      if (Array.isArray(nested)) {
        return nested;
      }

      if (p6LooksLikeCandle(container)) {
        return [container];
      }
    }

    if (
      expectedType === "signal" ||
      expectedType === "any"
    ) {
      return container;
    }
  }

  const preferredContainerKeys = [
    "pairs",
    "signals",
    "results",
    "analyses",
    "analysis",
    "data",
    "items",
    "records",
    "markets",
    "symbols",
    "instruments",
    "candles",
    "rows",
    "history",
    "prices",
    "ohlc",
    "scalp",
    "intraday",
    "daily",
    "weekly",
  ];

  for (const key of preferredContainerKeys) {
    if (
      container[key] === undefined ||
      container[key] === container
    ) {
      continue;
    }

    const nested = p6ExtractPairValue(
      container[key],
      pair,
      options,
      depth + 1
    );

    if (nested !== null) {
      return nested;
    }
  }

  return null;
}


// ---------------------------------------------------------------------------
// Candle extraction and normalization
// ---------------------------------------------------------------------------

function p6ExtractPairCandles(
  rawData,
  pair
) {
  const extracted =
    p6ExtractPairValue(
      rawData,
      pair,
      {
        expectedType: "candles",
      }
    );

  if (Array.isArray(extracted)) {
    return normalizeLiveCandleArray(
      extracted,
      {
        maxRows: 10000,
      }
    );
  }

  if (liveIsPlainObject(extracted)) {
    const nested =
      extracted.candles ||
      extracted.rows ||
      extracted.data ||
      extracted.prices ||
      extracted.ohlc ||
      extracted.history;

    if (Array.isArray(nested)) {
      return normalizeLiveCandleArray(
        nested,
        {
          maxRows: 10000,
        }
      );
    }
  }

  return [];
}

function p6ExtractPairSignal(
  rawData,
  pair
) {
  const extracted =
    p6ExtractPairValue(
      rawData,
      pair,
      {
        expectedType: "signal",
      }
    );

  if (liveIsPlainObject(extracted)) {
    return extracted;
  }

  return null;
}


// ---------------------------------------------------------------------------
// Input loading
// ---------------------------------------------------------------------------

function p6LoadRuntimeInputs() {
  const scalpSignals =
    p6ReadJsonFile(
      P6_SCALP_SIGNALS_PATH,
      {},
      {
        required: false,
      }
    );

  const scalpCandles =
    p6ReadJsonFile(
      P6_SCALP_CANDLES_PATH,
      {},
      {
        required: false,
      }
    );

  const intradayH1 =
    p6ReadJsonFile(
      P6_INTRADAY_H1_PATH,
      {},
      {
        required: false,
      }
    );

  const dailyOhlc =
    p6ReadJsonFile(
      P6_DAILY_OHLC_PATH,
      {},
      {
        required: false,
      }
    );

  const analysisHistory =
    p6ReadJsonFile(
      P6_ANALYSIS_HISTORY_PATH,
      {
        version: 1,
        records: [],
      },
      {
        required: false,
      }
    );

  const notifyState =
    p6ReadJsonFile(
      P6_NOTIFY_STATE_PATH,
      {
        version: 1,
        signals: {},
      },
      {
        required: false,
      }
    );

  const aiMemoryState =
    typeof loadAIMemory ===
      "function"
      ? loadAIMemory()
      : createUnavailableAIMemoryState(
          "AI Memory loader is unavailable"
        );

  return {
    scalpSignals,
    scalpCandles,
    intradayH1,
    dailyOhlc,
    analysisHistory,
    notifyState,
    aiMemoryState,
  };
}


// ---------------------------------------------------------------------------
// Startup validation
// ---------------------------------------------------------------------------

function p6ValidateRuntime() {
  const errors = [];
  const warnings = [];

  if (
    typeof fs === "undefined" ||
    !fs ||
    typeof fs.readFileSync !== "function"
  ) {
    errors.push(
      "Node.js fs module is unavailable"
    );
  }

  if (
    typeof path === "undefined" ||
    !path ||
    typeof path.join !== "function"
  ) {
    errors.push(
      "Node.js path module is unavailable"
    );
  }

  const requiredFunctions = [
    [
      "prepareLiveAnalysisFrames",
      typeof prepareLiveAnalysisFrames,
    ],
    [
      "runLegacyCompatibleAnalysisPipeline",
      typeof runLegacyCompatibleAnalysisPipeline,
    ],
    [
      "buildPairEngineBundle",
      typeof buildPairEngineBundle,
    ],
    [
      "buildLiveAnalysisOutput",
      typeof buildLiveAnalysisOutput,
    ],
    [
      "collectHistoryRecordsFromOutput",
      typeof collectHistoryRecordsFromOutput,
    ],
    [
      "appendAnalysisHistoryRecords",
      typeof appendAnalysisHistoryRecords,
    ],
    [
      "processLiveOutputNotifications",
      typeof processLiveOutputNotifications,
    ],
  ];

  for (const [name, type] of requiredFunctions) {
    if (type !== "function") {
      errors.push(
        `Required function is missing: ${name}()`
      );
    }
  }

  const inputFiles = [
    P6_SCALP_SIGNALS_PATH,
    P6_SCALP_CANDLES_PATH,
    P6_INTRADAY_H1_PATH,
    P6_DAILY_OHLC_PATH,
  ];

  if (
    !inputFiles.some(
      (filePath) =>
        p6FileExists(filePath)
    )
  ) {
    warnings.push(
      "No market input files currently exist"
    );
  }

  const telegramConfigured =
    Boolean(
      process.env.TELEGRAM_BOT_TOKEN ||
      process.env.TELEGRAM_TOKEN
    ) &&
    Boolean(
      process.env.TELEGRAM_CHAT_ID
    );

  if (!telegramConfigured) {
    warnings.push(
      "Telegram is not configured; analysis will continue without notifications"
    );
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
  };
}


// ---------------------------------------------------------------------------
// Pair input preparation
// ---------------------------------------------------------------------------

function p6PreparePairInput(
  pair,
  inputs
) {
  const scalpSignal =
    p6ExtractPairSignal(
      inputs.scalpSignals,
      pair
    );

  const scalpCandles =
    p6ExtractPairCandles(
      inputs.scalpCandles,
      pair
    );

  const intradayCandles =
    p6ExtractPairCandles(
      inputs.intradayH1,
      pair
    );

  const dailyCandles =
    p6ExtractPairCandles(
      inputs.dailyOhlc,
      pair
    );

  return {
    pair,

    scalpSignal,
    scalpCandles,
    intradayCandles,
    dailyCandles,

    counts: {
      scalpCandles:
        scalpCandles.length,

      intradayCandles:
        intradayCandles.length,

      dailyCandles:
        dailyCandles.length,
    },
  };
}


// ---------------------------------------------------------------------------
// Individual pair analysis
// ---------------------------------------------------------------------------

function p6RunPairAnalysis(
  pair,
  inputs,
  runtimeOptions = {}
) {
  const pairInput =
    p6PreparePairInput(
      pair,
      inputs
    );

  const frames =
    prepareLiveAnalysisFrames({
      pair,

      scalpCandles:
        pairInput.scalpCandles,

      intradayCandles:
        pairInput.intradayCandles,

      dailyCandles:
        pairInput.dailyCandles,

      maxScalpRows:
        runtimeOptions.maxScalpRows ||
        5000,

      maxIntradayRows:
        runtimeOptions.maxIntradayRows ||
        3000,

      maxDailyRows:
        runtimeOptions.maxDailyRows ||
        1500,

      maxWeeklyRows:
        runtimeOptions.maxWeeklyRows ||
        500,
    });

  const pipeline =
    runLegacyCompatibleAnalysisPipeline({
      pair,
      frames,

      scalpTimeframe:
        runtimeOptions.scalpTimeframe ||
        "SCALP",

      maxScalpAnalysisRows:
        runtimeOptions.maxScalpAnalysisRows ||
        1200,

      maxIntradayAnalysisRows:
        runtimeOptions.maxIntradayAnalysisRows ||
        1000,

      maxDailyAnalysisRows:
        runtimeOptions.maxDailyAnalysisRows ||
        600,

      maxWeeklyAnalysisRows:
        runtimeOptions.maxWeeklyAnalysisRows ||
        300,
    });

  const isolatedPrimaryScalpData =
    pairInput.scalpSignal
      ? {
          [pair]:
            pairInput.scalpSignal,
        }
      : inputs.scalpSignals;

  const bundle =
  buildPairEngineBundle({
    pair,

    aiMemoryState:
      inputs.aiMemoryState,

    analysisPipeline:
      pipeline,

    scalpSignalsData:
      isolatedPrimaryScalpData,

    fallbackScalpAnalysis:
      pipeline.scalp,

    allowPrimaryScalpHold:
      runtimeOptions.allowPrimaryScalpHold ===
      true,

    maximumPrimaryScalpAgeMs:
      runtimeOptions.maximumPrimaryScalpAgeMs,

    masterWeights:
      runtimeOptions.masterWeights,

    minimumNetContribution:
      runtimeOptions.minimumNetContribution,

    minimumDirectionalEngines:
      runtimeOptions.minimumDirectionalEngines,
  });

  return {
    ...bundle,

    inputMetadata: {
      ...pairInput.counts,

      primaryScalpSignalAvailable:
        Boolean(pairInput.scalpSignal),

      preparedScalpFrames:
        frames.scalp.length,

      preparedIntradayFrames:
        frames.intraday.length,

      preparedDailyFrames:
        frames.daily.length,

      preparedWeeklyFrames:
        frames.weekly.length,
    },
  };
}


// ---------------------------------------------------------------------------
// Safe pair execution
// ---------------------------------------------------------------------------

function p6BuildFailedPairBundle(
  pair,
  error
) {
  const reason =
    `Pair analysis failed: ${p6ErrorMessage(error)}`;

  const holdEngine = (
    mode,
    source
  ) =>
    buildCanonicalEngineResult(
      {
        pair,
        decision: "HOLD",
        confidence: 0,
        score: 0,
        reason,
        timestamp: Date.now(),
      },
      {
        pair,
        mode,
        engineName:
          `${mode}-error`,
        source,
        available: false,
      }
    );

  const swing =
    holdEngine(
      "swing",
      "runtime-error"
    );

  const intraday =
    holdEngine(
      "intraday",
      "runtime-error"
    );

  const scalp =
    holdEngine(
      "scalp",
      "runtime-error"
    );

  const master =
    buildCanonicalEngineResult(
      {
        pair,
        decision: "HOLD",
        confidence: 0,
        score: 0,
        reason,
        timestamp: Date.now(),
      },
      {
        pair,
        mode: "master",
        engineName:
          "master-consensus-error",
        source: "runtime-error",
        available: false,
      }
    );

  return {
    pair,
    symbol: pair,
    pairLabel: pair,

    generatedAt:
      new Date().toISOString(),

    timestamp:
      Date.now(),

    swing,
    intraday,
    scalp,
    master,

    engines: {
      swing,
      intraday,
      scalp,
      master,
    },

    error: reason,
  };
}

function p6RunAllPairs(
  inputs,
  runtimeOptions = {}
) {
  const bundles = [];

  for (const pair of P6_RUNTIME_PAIRS) {
    try {
      p6Log(
        "INFO",
        `Analyzing ${pair}`
      );

      const bundle =
        p6RunPairAnalysis(
          pair,
          inputs,
          runtimeOptions
        );

      bundles.push(bundle);

      p6Log(
        "INFO",
        `${pair} analysis complete`,
        {
          swing:
            bundle.swing.decision,

          intraday:
            bundle.intraday.decision,

          scalp:
            bundle.scalp.decision,

          master:
            bundle.master.decision,

          confidence:
            bundle.master.confidence,
        }
      );
    } catch (error) {
      p6Log(
        "ERROR",
        `${pair} analysis failed`,
        p6ErrorMessage(error)
      );

      bundles.push(
        p6BuildFailedPairBundle(
          pair,
          error
        )
      );
    }
  }

  return bundles;
}


// ---------------------------------------------------------------------------
// Preserve existing live-output metadata
// ---------------------------------------------------------------------------

function p6MergeExistingOutputMetadata(
  newOutput,
  oldOutput
) {
  if (!liveIsPlainObject(oldOutput)) {
    return newOutput;
  }

  const preservedTopLevelKeys = [
    "schemaVersion",
    "appVersion",
    "environment",
    "deployment",
    "repository",
  ];

  const merged = {
    ...newOutput,
  };

  for (const key of preservedTopLevelKeys) {
    if (
      merged[key] === undefined &&
      oldOutput[key] !== undefined
    ) {
      merged[key] =
        liveCloneValue(
          oldOutput[key]
        );
    }
  }

  if (
    liveIsPlainObject(oldOutput.metadata)
  ) {
    merged.metadata = {
      ...liveCloneValue(
        oldOutput.metadata
      ),

      ...merged.metadata,
    };
  }

  return merged;
}


// ---------------------------------------------------------------------------
// Runtime options
// ---------------------------------------------------------------------------

function p6BuildRuntimeOptions() {
  return {
    allowPrimaryScalpHold:
      p6EnvironmentBoolean(
        "PIPSIGHT_ALLOW_PRIMARY_SCALP_HOLD",
        false
      ),

    maximumPrimaryScalpAgeMs:
      p6EnvironmentNumber(
        "PIPSIGHT_SCALP_MAX_AGE_MS",
        6 * 60 * 60 * 1000
      ),

    minimumNetContribution:
      p6EnvironmentNumber(
        "PIPSIGHT_MASTER_MIN_CONTRIBUTION",
        0.18
      ),

    minimumDirectionalEngines:
      p6EnvironmentNumber(
        "PIPSIGHT_MASTER_MIN_ENGINES",
        2
      ),

    masterWeights: {
      swing:
        p6EnvironmentNumber(
          "PIPSIGHT_SWING_WEIGHT",
          0.40
        ),

      intraday:
        p6EnvironmentNumber(
          "PIPSIGHT_INTRADAY_WEIGHT",
          0.35
        ),

      scalp:
        p6EnvironmentNumber(
          "PIPSIGHT_SCALP_WEIGHT",
          0.25
        ),
    },

    includeHoldHistory:
      p6EnvironmentBoolean(
        "PIPSIGHT_HISTORY_INCLUDE_HOLD",
        false
      ),

    historyDedupeWindowMs:
      p6EnvironmentNumber(
        "PIPSIGHT_HISTORY_DEDUPE_MS",
        P6_HISTORY_DEDUPE_WINDOW_MS
      ),

    maximumHistoryRecords:
      p6EnvironmentNumber(
        "PIPSIGHT_HISTORY_MAX_RECORDS",
        P6_MAX_HISTORY_RECORDS
      ),

    processTelegram:
      !p6EnvironmentBoolean(
        "PIPSIGHT_DISABLE_TELEGRAM",
        false
      ),

    telegramModes:
      (
        process.env.PIPSIGHT_TELEGRAM_MODES ||
        "master,swing,intraday,scalp"
      )
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),

    telegramMinimumConfidence:
      p6EnvironmentNumber(
        "PIPSIGHT_TELEGRAM_MIN_CONFIDENCE",
        P6_DEFAULT_TELEGRAM_MINIMUM_CONFIDENCE
      ),

    telegramCooldownMs:
      p6EnvironmentNumber(
        "PIPSIGHT_TELEGRAM_COOLDOWN_MS",
        P6_DEFAULT_TELEGRAM_COOLDOWN_MS
      ),

    telegramNotifyHold:
      p6EnvironmentBoolean(
        "PIPSIGHT_TELEGRAM_NOTIFY_HOLD",
        false
      ),

    telegramSilent:
      p6EnvironmentBoolean(
        "PIPSIGHT_TELEGRAM_SILENT",
        false
      ),

    telegramTitle:
      process.env.PIPSIGHT_TELEGRAM_TITLE ||
      "PipSight Pro Signal",

    createBackups:
      p6EnvironmentBoolean(
        "PIPSIGHT_CREATE_BACKUPS",
        false
      ),
  };
}


// ---------------------------------------------------------------------------
// Output summary
// ---------------------------------------------------------------------------

function p6BuildRuntimeSummary(
  output,
  telegramResult,
  appendedHistoryCount
) {
  const pairs =
    liveIsPlainObject(output?.pairs)
      ? Object.values(output.pairs)
      : [];

  return {
    generatedAt:
      output?.generatedAt ||
      new Date().toISOString(),

    pairCount:
      pairs.length,

    pairs:
      pairs.map((record) => ({
        pair:
          record.pair,

        swing:
          record.swing?.decision ||
          "HOLD",

        intraday:
          record.intraday?.decision ||
          "HOLD",

        scalp:
          record.scalp?.decision ||
          "HOLD",

        master:
          record.master?.decision ||
          "HOLD",

        confidence:
          record.master?.confidence ||
          0,
      })),

    historyAppended:
      appendedHistoryCount,

    telegramSent:
      telegramResult?.sentCount ||
      0,

    telegramSkipped:
      telegramResult?.skippedCount ||
      0,

    telegramFailed:
      telegramResult?.failedCount ||
      0,
  };
}


// ---------------------------------------------------------------------------
// Main analysis runtime
// ---------------------------------------------------------------------------

async function runLiveAnalysisRuntime(
  overrideOptions = {}
) {
  const startedAt = Date.now();

  p6EnsureDirectory(
    P6_DATA_DIRECTORY
  );

  const validation =
    p6ValidateRuntime();

  for (const warning of validation.warnings) {
    p6Log(
      "WARN",
      warning
    );
  }

  if (!validation.ok) {
    const message =
      `Startup validation failed:\n- ${validation.errors.join("\n- ")}`;

    throw new Error(message);
  }

  const runtimeOptions = {
    ...p6BuildRuntimeOptions(),
    ...overrideOptions,
  };

  p6Log(
    "INFO",
    "Loading analysis inputs"
  );

  const inputs =
    p6LoadRuntimeInputs();

  const oldLiveOutput =
    p6ReadJsonFile(
      P6_LIVE_ANALYSIS_PATH,
      {},
      {
        required: false,
      }
    );

  const pairBundles =
    p6RunAllPairs(
      inputs,
      runtimeOptions
    );

  const generatedTimestamp =
    Date.now();

  let output =
    buildLiveAnalysisOutput({
      pairs:
        pairBundles,

      timestamp:
        generatedTimestamp,

      generatedAt:
        new Date(
          generatedTimestamp
        ).toISOString(),

      engineVersion:
        typeof ENGINE_VERSION !== "undefined"
          ? ENGINE_VERSION
          : "unknown",

      strategyVersion:
        typeof STRATEGY_VERSION !== "undefined"
          ? STRATEGY_VERSION
          : "unknown",
    });

  output =
    p6MergeExistingOutputMetadata(
      output,
      oldLiveOutput
    );

  output.runtime = {
    startedAt:
      new Date(startedAt).toISOString(),

    completedAt:
      new Date().toISOString(),

    durationMs:
      Date.now() - startedAt,

    nodeVersion:
      process.version,

    inputFiles: {
      scalpSignals:
        P6_SCALP_SIGNALS_PATH,

      scalpCandles:
        P6_SCALP_CANDLES_PATH,

      intradayH1:
        P6_INTRADAY_H1_PATH,

      dailyOhlc:
        P6_DAILY_OHLC_PATH,

      aiMemory:
        AI_MEMORY_PATH,
    },

    aiMemory: {
      enabled:
        AI_MEMORY_INTEGRATION.enabled,

      mode:
        AI_MEMORY_INTEGRATION.mode,

      available:
        Boolean(
          inputs.aiMemoryState &&
          inputs.aiMemoryState.available
        ),

      valid:
  Boolean(
    inputs.aiMemoryState &&
    inputs.aiMemoryState.valid
  ),

applied:
  pairBundles.some(
    (bundle) =>
      [
        bundle &&
          bundle.swing,
        bundle &&
          bundle.intraday,
        bundle &&
          bundle.scalp,
        bundle &&
          bundle.master,
      ].some(
        (engineResult) =>
          Boolean(
            engineResult &&
            engineResult.aiMemory &&
            engineResult.aiMemory.applied ===
              true
          )
      )
  ),

generatedAt:
  inputs.aiMemoryState &&
  inputs.aiMemoryState.generatedAt
    ? inputs.aiMemoryState.generatedAt
    : null,

      engineName:
        inputs.aiMemoryState &&
        inputs.aiMemoryState.engineName
          ? inputs.aiMemoryState.engineName
          : null,

      engineVersion:
        inputs.aiMemoryState &&
        inputs.aiMemoryState.engineVersion
          ? inputs.aiMemoryState.engineVersion
          : null,

      reason:
        inputs.aiMemoryState &&
        inputs.aiMemoryState.reason
          ? inputs.aiMemoryState.reason
          : null,
    },

    outputFiles: {
      liveAnalysis:
        P6_LIVE_ANALYSIS_PATH,

      analysisHistory:
        P6_ANALYSIS_HISTORY_PATH,

      notifyState:
        P6_NOTIFY_STATE_PATH,
    },
  };

  const historyCandidates =
    collectHistoryRecordsFromOutput(
      output,
      {
        modes:
          runtimeOptions.historyModes ||
          [
            "master",
            "swing",
            "intraday",
            "scalp",
          ],

        includeHold:
          runtimeOptions.includeHoldHistory ===
          true,
      }
    );

  const historyResult =
    appendAnalysisHistoryRecords(
      inputs.analysisHistory,
      historyCandidates,
      {
        includeHold:
          runtimeOptions.includeHoldHistory ===
          true,

        dedupeWindowMs:
          runtimeOptions.historyDedupeWindowMs,

        maximumRecords:
          runtimeOptions.maximumHistoryRecords,
      }
    );

  let telegramResult = {
    notifyState:
      normalizeNotifyState(
        inputs.notifyState
      ),

    results: [],
    sentCount: 0,
    skippedCount: 0,
    failedCount: 0,
  };

  if (
    runtimeOptions.processTelegram !== false
  ) {
    try {
      telegramResult =
        await processLiveOutputNotifications(
          output,
          inputs.notifyState,
          {
            modes:
              runtimeOptions.telegramModes ||
              "master",
              "swing",
              "intraday",
              "scalp",
            ],

            minimumConfidence:
              runtimeOptions.telegramMinimumConfidence,

            cooldownMs:
              runtimeOptions.telegramCooldownMs,

            notifyHold:
              runtimeOptions.telegramNotifyHold ===
              true,

            token:
              runtimeOptions.telegramToken,

            chatId:
              runtimeOptions.telegramChatId,

            timeoutMs:
              runtimeOptions.telegramTimeoutMs,

            disableNotification:
              runtimeOptions.telegramSilent ===
              true,

            title:
              runtimeOptions.telegramTitle ||
              "PipSight Pro Signal",
          }
        );
    } catch (error) {
      p6Log(
        "WARN",
        "Telegram processing failed; analysis output will still be saved",
        p6ErrorMessage(error)
      );

      telegramResult = {
        notifyState:
          normalizeNotifyState(
            inputs.notifyState
          ),

        results: [
          {
            sent: false,
            skipped: false,
            reason:
              p6ErrorMessage(error),
          },
        ],

        sentCount: 0,
        skippedCount: 0,
        failedCount: 1,
      };
    }
  }

  output.runtime.telegram = {
    enabled:
      runtimeOptions.processTelegram !==
      false,

    sentCount:
      telegramResult.sentCount,

    skippedCount:
      telegramResult.skippedCount,

    failedCount:
      telegramResult.failedCount,
  };

  output.runtime.history = {
    candidateCount:
      historyCandidates.length,

    appendedCount:
      historyResult.appendedCount,

    totalCount:
      liveAsArray(
        historyResult.history.records
      ).length,
  };

  output.runtime.durationMs =
    Date.now() - startedAt;

  output.runtime.completedAt =
    new Date().toISOString();

  p6CreateBackupIfRequested(
    P6_LIVE_ANALYSIS_PATH,
    runtimeOptions.createBackups
  );

  p6CreateBackupIfRequested(
    P6_ANALYSIS_HISTORY_PATH,
    runtimeOptions.createBackups
  );

  p6CreateBackupIfRequested(
    P6_NOTIFY_STATE_PATH,
    runtimeOptions.createBackups
  );

  // Write notify state only after Telegram processing.
  // This prevents failed Telegram attempts from being marked as sent.
  p6AtomicWriteJson(
    P6_LIVE_ANALYSIS_PATH,
    output
  );

  p6AtomicWriteJson(
    P6_ANALYSIS_HISTORY_PATH,
    historyResult.history
  );

  p6AtomicWriteJson(
    P6_NOTIFY_STATE_PATH,
    telegramResult.notifyState
  );

  const summary =
    p6BuildRuntimeSummary(
      output,
      telegramResult,
      historyResult.appendedCount
    );

  p6Log(
    "INFO",
    "Live analysis completed successfully",
    summary
  );

  return {
    ok: true,

    output,
    history:
      historyResult.history,

    notifyState:
      telegramResult.notifyState,

    telegram:
      telegramResult,

    summary,
  };
}


// ---------------------------------------------------------------------------
// Final compatibility aliases
// ---------------------------------------------------------------------------

async function runLiveAnalysis(
  options = {}
) {
  return runLiveAnalysisRuntime(
    options
  );
}

async function executeLiveAnalysis(
  options = {}
) {
  return runLiveAnalysisRuntime(
    options
  );
}

async function run(
  options = {}
) {
  return runLiveAnalysisRuntime(
    options
  );
}


// ---------------------------------------------------------------------------
// Unhandled runtime safety
// ---------------------------------------------------------------------------

function p6InstallRuntimeSafetyHandlers() {
  process.on(
    "unhandledRejection",
    (reason) => {
      p6Log(
        "ERROR",
        "Unhandled promise rejection",
        p6ErrorMessage(reason)
      );

      process.exitCode = 1;
    }
  );

  process.on(
    "uncaughtException",
    (error) => {
      p6Log(
        "ERROR",
        "Uncaught exception",
        p6ErrorMessage(error)
      );

      process.exitCode = 1;
    }
  );
}


// ---------------------------------------------------------------------------
// Direct execution
// ---------------------------------------------------------------------------

async function main() {
  p6InstallRuntimeSafetyHandlers();

  try {
    await runLiveAnalysisRuntime();
  } catch (error) {
    p6Log(
      "ERROR",
      "Live analysis runtime failed",
      p6ErrorMessage(error)
    );

    process.exitCode = 1;
  }
}

if (
  typeof require !== "undefined" &&
  typeof module !== "undefined" &&
  require.main === module
) {
  void main();
}


// ---------------------------------------------------------------------------
// Optional CommonJS exports
// ---------------------------------------------------------------------------

if (
  typeof module !== "undefined" &&
  module.exports
) {
  module.exports = {
    runLiveAnalysisRuntime,
    runLiveAnalysis,
    executeLiveAnalysis,
    run,

    prepareLiveAnalysisFrames,
    runLegacyCompatibleAnalysisPipeline,

    selectScalpEngineResult,
    selectSwingEngineResult,
    selectIntradayEngineResult,

    buildMasterConsensus,
    buildPairEngineBundle,
    buildLiveAnalysisOutput,

    collectHistoryRecordsFromOutput,
    appendAnalysisHistoryRecords,

    normalizeNotifyState,
    processTelegramNotification,
    processLiveOutputNotifications,

    formatTelegramSignalMessage,
    sendTelegramMessage,
  };
}


// ============================================================================
// END PART 6
// END OF FILE — run-live-analysis.js
// ============================================================================
