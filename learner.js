"use strict";

/* =====================================================================
   PipSight Pro AI
   Learning and Confidence Engine
   Public compatibility version: 2.1.0
   Autonomous learning extension: 1.4.0

   Compatibility:
   - Existing public methods preserved.
   - Existing signal and confidence structures preserved.
   - Exact immutable trade attribution; no approximate pending matching.
   - Legacy external IDs reconcile through exact immutable opening identity.
   - Risk-normalized R feedback, context snapshots and correction revisions.
   - Works in Node.js and browser environments.
   ===================================================================== */

class LearningConfig {
    static VERSION = "2.1.0";
    static ENGINE_NAME = "PipSight Pro AI";

    /*
     * Autonomous learning extension.
     *
     * VERSION remains 2.1.0 because existing workflows and integrations
     * validate that public compatibility contract. AUTONOMOUS_VERSION identifies
     * the additive policy-grade learning layer introduced for the autonomous
     * stack.
     */
    static AUTONOMOUS_VERSION = "1.4.0";
    static AUTONOMOUS_SCHEMA_VERSION = 1;
    static MAX_ABSOLUTE_REALIZED_R = 20;
    static MAX_CORRECTION_HISTORY = 20;
    static MAX_CONTEXT_VALUE_LENGTH = 120;

    static DEBUG = false;
    static MAX_HISTORY = 5000;

    static DUPLICATE_CHECK = true;
    static MIN_SIGNALS_FOR_LEARNING = 20;
    static MIN_SIGNALS_FOR_CONFIDENCE = 30;
    static PERFORMANCE_WINDOW = 20;

    static MAX_CONFIDENCE = 95;
    static MIN_CONFIDENCE = 50;
    static DEFAULT_CONFIDENCE = 60;
    static ACTIONABLE_CONFIDENCE_THRESHOLD = 65;

    static SUPPORTED_RESULTS = Object.freeze([
        "WIN",
        "LOSS",
        "BREAKEVEN"
    ]);

    static SUPPORTED_STRATEGIES = Object.freeze([
        "scalp",
        "daily",
        "weekly"
    ]);

    static SUPPORTED_PAIRS = Object.freeze([
        "XAUUSD",
        "GBPJPY"
    ]);

    static SUPPORTED_TIMEFRAMES = Object.freeze([
        "5m",
        "15m",
        "30m",
        "1H",
        "4H",
        "D1"
    ]);

    static SUPPORTED_INDICATORS = Object.freeze([
        "EMA",
        "RSI",
        "MACD",
        "Support/Resistance",
        "News"
    ]);

    static REQUIRED_SIGNAL_FIELDS = Object.freeze([
        "pair",
        "strategy",
        "timeframe",
        "entry"
    ]);

    static PERFORMANCE_STATUS = Object.freeze({
        IMPROVING: "improving",
        STABLE: "stable",
        DECLINING: "declining",
        UNKNOWN: "insufficient-data"
    });
}

Object.freeze(LearningConfig);

/* =====================================================================
   General Helpers
   ===================================================================== */

function isPlainObject(value) {
    return (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value)
    );
}

function isFiniteNumber(value) {
    return (
        typeof value === "number" &&
        Number.isFinite(value)
    );
}

function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
}

function round(value, decimals = 2) {
    if (!isFiniteNumber(value)) {
        return 0;
    }

    const multiplier = 10 ** decimals;
    return Math.round(value * multiplier) / multiplier;
}


function toFiniteNumber(value) {
    if (
        value === null ||
        value === undefined ||
        value === ""
    ) {
        return null;
    }

    const numeric = Number(value);

    return Number.isFinite(numeric)
        ? numeric
        : null;
}

function toISOStringOrNull(value) {
    if (
        value === null ||
        value === undefined ||
        value === ""
    ) {
        return null;
    }

    const date = new Date(value);

    return Number.isFinite(date.getTime())
        ? date.toISOString()
        : null;
}

function toTrimmedStringOrNull(
    value,
    maximumLength =
        LearningConfig.MAX_CONTEXT_VALUE_LENGTH
) {
    if (
        value === null ||
        value === undefined
    ) {
        return null;
    }

    const normalized =
        String(value)
            .trim();

    if (!normalized) {
        return null;
    }

    return normalized.slice(
        0,
        Math.max(1, maximumLength)
    );
}

function stableIdentityNumber(value) {
    const numeric =
        toFiniteNumber(value);

    return numeric === null
        ? null
        : Number(
            numeric.toFixed(10)
        );
}

function fnv1a64(value) {
    const input =
        String(value ?? "");

    let hash =
        0xcbf29ce484222325n;

    const prime =
        0x100000001b3n;

    for (
        let index = 0;
        index < input.length;
        index += 1
    ) {
        hash ^=
            BigInt(
                input.charCodeAt(index)
            );

        hash =
            BigInt.asUintN(
                64,
                hash * prime
            );
    }

    return hash
        .toString(16)
        .padStart(16, "0");
}


function createDeterministicHash(value) {
    const input =
        String(value ?? "");

    /*
     * Node.js production uses SHA-256. The browser compatibility fallback is
     * deterministic FNV-1a 64-bit because learner.js must remain dependency-free
     * and usable without a bundler.
     */
    if (
        typeof module !== "undefined" &&
        module.exports &&
        typeof require === "function"
    ) {
        try {
            const crypto =
                require("crypto");

            return crypto
                .createHash("sha256")
                .update(
                    input,
                    "utf8"
                )
                .digest("hex");
        } catch (error) {
            // Fall through to the deterministic browser-safe hash.
        }
    }

    return fnv1a64(input);
}

function calculateInitialRiskPoints(signal) {
    const entry =
        toFiniteNumber(
            signal?.entry
        );

    const stopLoss =
        toFiniteNumber(
            signal?.stopLoss ??
            signal?.stop
        );

    if (
        entry === null ||
        stopLoss === null
    ) {
        return null;
    }

    const risk =
        Math.abs(
            entry - stopLoss
        );

    return risk > 0
        ? round(risk, 10)
        : null;
}

function calculatePlannedRewardPoints(signal) {
    const entry =
        toFiniteNumber(
            signal?.entry
        );

    const takeProfit =
        toFiniteNumber(
            signal?.takeProfit ??
            signal?.takeProfit1 ??
            signal?.target
        );

    if (
        entry === null ||
        takeProfit === null
    ) {
        return null;
    }

    const reward =
        Math.abs(
            takeProfit - entry
        );

    return reward > 0
        ? round(reward, 10)
        : null;
}

function calculateRealizedR(
    profitPoints,
    initialRiskPoints
) {
    const profit =
        toFiniteNumber(
            profitPoints
        );

    const risk =
        toFiniteNumber(
            initialRiskPoints
        );

    if (
        profit === null ||
        risk === null ||
        risk <= 0
    ) {
        return null;
    }

    const realizedR =
        profit / risk;

    if (
        !Number.isFinite(realizedR) ||
        Math.abs(realizedR) >
            LearningConfig
                .MAX_ABSOLUTE_REALIZED_R
    ) {
        return null;
    }

    return round(
        realizedR,
        6
    );
}

function buildMaximumDrawdownR(values) {
    let equity = 0;
    let peak = 0;
    let maximumDrawdown = 0;

    for (const value of values) {
        if (!isFiniteNumber(value)) {
            continue;
        }

        equity += value;
        peak = Math.max(peak, equity);

        maximumDrawdown =
            Math.max(
                maximumDrawdown,
                peak - equity
            );
    }

    return round(
        maximumDrawdown,
        6
    );
}

function createEmptyStats() {
    return {
        totalSignals: 0,
        resolvedSignals: 0,
        wins: 0,
        losses: 0,
        breakevens: 0,
        pending: 0,

        winRate: 0,
        lossRate: 0,
        breakevenRate: 0,

        avgProfitPoints: 0,
        totalProfitPoints: 0,
        grossProfitPoints: 0,
        grossLossPoints: 0,
        profitFactor: null,

        strategies: {},
        indicators: {},
        pairs: {},
        timeframes: {}
    };
}

function createEmptyLearningData() {
    return {
        signals: [],
        outcomes: [],
        stats: createEmptyStats(),
        updatedAt: new Date().toISOString(),
        metadata: {
            engine: LearningConfig.ENGINE_NAME,
            version: LearningConfig.VERSION,
            autonomousLearning: {
                schemaVersion:
                    LearningConfig
                        .AUTONOMOUS_SCHEMA_VERSION,
                version:
                    LearningConfig
                        .AUTONOMOUS_VERSION,
                deterministicIdentity: true,
                exactOutcomeAttribution: true,
                correctedRecordSafe: true,
                advisoryOnly: true,
                liveAuthorityPermitted: false
            }
        }
    };
}

function createEmptyConfidenceData() {
    return {
        strategies: {},
        indicators: {},
        pairs: {},
        timeframes: {},
        overall: {
            totalSignals: 0,
            winRate: 0,
            avgProfitPoints: 0
        },
        updatedAt: new Date().toISOString(),
        metadata: {
            engine: LearningConfig.ENGINE_NAME,
            version: LearningConfig.VERSION,
            autonomousLearning: {
                schemaVersion:
                    LearningConfig
                        .AUTONOMOUS_SCHEMA_VERSION,
                version:
                    LearningConfig
                        .AUTONOMOUS_VERSION,
                deterministicIdentity: true,
                exactOutcomeAttribution: true,
                correctedRecordSafe: true,
                advisoryOnly: true,
                liveAuthorityPermitted: false
            }
        }
    };
}

/* =====================================================================
   Signal Validator Engine
   ===================================================================== */

class SignalValidator {
    static validate(signal) {
        const errors = [];

        if (!isPlainObject(signal)) {
            return {
                valid: false,
                errors: ["Signal is missing or invalid."]
            };
        }

        for (const field of LearningConfig.REQUIRED_SIGNAL_FIELDS) {
            if (
                signal[field] === undefined ||
                signal[field] === null ||
                signal[field] === ""
            ) {
                errors.push(`Missing required field: ${field}`);
            }
        }

        if (
            signal.pair &&
            !LearningConfig.SUPPORTED_PAIRS.includes(signal.pair)
        ) {
            errors.push(`Unsupported pair: ${signal.pair}`);
        }

        if (
            signal.strategy &&
            !LearningConfig.SUPPORTED_STRATEGIES.includes(signal.strategy)
        ) {
            errors.push(`Unsupported strategy: ${signal.strategy}`);
        }

        if (
            signal.timeframe &&
            !LearningConfig.SUPPORTED_TIMEFRAMES.includes(signal.timeframe)
        ) {
            errors.push(`Unsupported timeframe: ${signal.timeframe}`);
        }

        if (
            signal.entry !== undefined &&
            (
                !isFiniteNumber(signal.entry) ||
                signal.entry <= 0
            )
        ) {
            errors.push("Invalid entry price.");
        }

        if (
            signal.stopLoss !== undefined &&
            signal.stopLoss !== null &&
            (
                !isFiniteNumber(signal.stopLoss) ||
                signal.stopLoss <= 0
            )
        ) {
            errors.push("Invalid Stop Loss.");
        }

        if (
            signal.takeProfit !== undefined &&
            signal.takeProfit !== null &&
            (
                !isFiniteNumber(signal.takeProfit) ||
                signal.takeProfit <= 0
            )
        ) {
            errors.push("Invalid Take Profit.");
        }

        if (
            signal.confidence !== undefined &&
            (
                !isFiniteNumber(signal.confidence) ||
                signal.confidence < 0 ||
                signal.confidence > 100
            )
        ) {
            errors.push("Confidence must be between 0 and 100.");
        }

        if (
            signal.indicators !== undefined &&
            !Array.isArray(signal.indicators)
        ) {
            errors.push("Indicators must be an array.");
        }

        if (Array.isArray(signal.indicators)) {
            const invalidIndicators = signal.indicators.filter(
                indicator =>
                    !LearningConfig.SUPPORTED_INDICATORS.includes(indicator)
            );

            if (invalidIndicators.length > 0) {
                errors.push(
                    `Unsupported indicator(s): ${[
                        ...new Set(invalidIndicators)
                    ].join(", ")}`
                );
            }
        }

        if (
            signal.direction !== undefined &&
            !["BUY", "SELL", "HOLD"].includes(signal.direction)
        ) {
            errors.push("Invalid signal direction.");
        }

        if (
            signal.direction === "BUY" &&
            isFiniteNumber(signal.stopLoss) &&
            signal.stopLoss >= signal.entry
        ) {
            errors.push(
                "BUY signal Stop Loss must be below entry."
            );
        }

        if (
            signal.direction === "BUY" &&
            isFiniteNumber(signal.takeProfit) &&
            signal.takeProfit <= signal.entry
        ) {
            errors.push(
                "BUY signal Take Profit must be above entry."
            );
        }

        if (
            signal.direction === "SELL" &&
            isFiniteNumber(signal.stopLoss) &&
            signal.stopLoss <= signal.entry
        ) {
            errors.push(
                "SELL signal Stop Loss must be above entry."
            );
        }

        if (
            signal.direction === "SELL" &&
            isFiniteNumber(signal.takeProfit) &&
            signal.takeProfit >= signal.entry
        ) {
            errors.push(
                "SELL signal Take Profit must be below entry."
            );
        }

        return {
            valid: errors.length === 0,
            errors
        };
    }

    static validateOutcome(outcome, profitPoints) {
        const errors = [];

        if (!LearningConfig.SUPPORTED_RESULTS.includes(outcome)) {
            errors.push(
                `Unsupported outcome: ${String(outcome)}`
            );
        }

        if (!isFiniteNumber(profitPoints)) {
            errors.push(
                "Profit points must be a finite number."
            );
        }

        if (outcome === "WIN" && profitPoints < 0) {
            errors.push(
                "WIN outcome cannot have negative profit points."
            );
        }

        if (outcome === "LOSS" && profitPoints > 0) {
            errors.push(
                "LOSS outcome cannot have positive profit points."
            );
        }

        return {
            valid: errors.length === 0,
            errors
        };
    }

    static isDuplicate(signal, signalList = []) {
        if (
            !LearningConfig.DUPLICATE_CHECK ||
            !Array.isArray(signalList)
        ) {
            return false;
        }

        return signalList.some(existing => {
            if (!existing || typeof existing !== "object") {
                return false;
            }

            return (
                existing.pair === signal.pair &&
                existing.strategy === signal.strategy &&
                existing.timeframe === signal.timeframe &&
                existing.entry === signal.entry &&
                existing.direction === signal.direction &&
                existing.outcome === null
            );
        });
    }
}

/* =====================================================================
   Memory Manager Engine
   ===================================================================== */

class MemoryManager {
    static initialize(learner) {
        if (!learner || typeof learner !== "object") {
            return false;
        }

        if (!isPlainObject(learner.data)) {
            learner.data = createEmptyLearningData();
        }

        if (!Array.isArray(learner.data.signals)) {
            learner.data.signals = [];
        }

        if (!Array.isArray(learner.data.outcomes)) {
            learner.data.outcomes = [];
        }

        if (!isPlainObject(learner.data.stats)) {
            learner.data.stats = createEmptyStats();
        }

        if (!isPlainObject(learner.data.metadata)) {
            learner.data.metadata = {};
        }

        learner.data.metadata.engine =
            LearningConfig.ENGINE_NAME;

        learner.data.metadata.version =
            LearningConfig.VERSION;

        learner.data.metadata.autonomousLearning = {
            schemaVersion:
                LearningConfig
                    .AUTONOMOUS_SCHEMA_VERSION,
            version:
                LearningConfig
                    .AUTONOMOUS_VERSION,
            deterministicIdentity: true,
            exactOutcomeAttribution: true,
            correctedRecordSafe: true,
            advisoryOnly: true,
            liveAuthorityPermitted: false
        };

        MemoryManager.repairSignals(learner);
        MemoryManager.repairOutcomes(learner);
        MemoryManager.cleanup(learner);
        MemoryManager.updateTimestamp(learner);

        return true;
    }

    static repairSignals(learner) {
        const seenIds = new Set();
        const repairedSignals = [];

        for (const signal of learner.data.signals) {
            if (!isPlainObject(signal)) {
                continue;
            }

            if (!signal.id || seenIds.has(signal.id)) {
                signal.id = learner.generateId();
            }

            seenIds.add(signal.id);

            if (
                signal.outcome !== null &&
                signal.outcome !== undefined &&
                !LearningConfig.SUPPORTED_RESULTS.includes(
                    signal.outcome
                )
            ) {
                signal.outcome = null;
                signal.profitPoints = null;
                signal.resultPercentage = null;
                delete signal.resolvedAt;
            }

            if (signal.outcome === undefined) {
                signal.outcome = null;
            }

            if (signal.profitPoints === undefined) {
                signal.profitPoints = null;
            }

            if (signal.resultPercentage === undefined) {
                signal.resultPercentage = null;
            }

            if (!signal.timestamp) {
                signal.timestamp =
                    new Date().toISOString();
            }

            if (
                learner &&
                typeof learner
                    .enrichSignalForAutonomousLearning ===
                    "function"
            ) {
                learner
                    .enrichSignalForAutonomousLearning(
                        signal,
                        {
                            repair: true
                        }
                    );
            }

            repairedSignals.push(signal);
        }

        learner.data.signals = repairedSignals;
    }

    static repairOutcomes(learner) {
        const validSignalIds = new Set(
            learner.data.signals.map(signal => signal.id)
        );

        const seenSignalIds = new Set();

        learner.data.outcomes = learner.data.outcomes.filter(
            outcomeRecord => {
                if (!isPlainObject(outcomeRecord)) {
                    return false;
                }

                if (
                    !validSignalIds.has(outcomeRecord.signalId) ||
                    seenSignalIds.has(outcomeRecord.signalId)
                ) {
                    return false;
                }

                if (
                    !LearningConfig.SUPPORTED_RESULTS.includes(
                        outcomeRecord.outcome
                    )
                ) {
                    return false;
                }

                seenSignalIds.add(outcomeRecord.signalId);
                return true;
            }
        );
    }

    static cleanup(learner) {
        if (
            !learner.data ||
            !Array.isArray(learner.data.signals)
        ) {
            return;
        }

        if (
            learner.data.signals.length >
            LearningConfig.MAX_HISTORY
        ) {
            const removedSignals = learner.data.signals.slice(
                0,
                learner.data.signals.length -
                    LearningConfig.MAX_HISTORY
            );

            const removedIds = new Set(
                removedSignals.map(signal => signal.id)
            );

            learner.data.signals =
                learner.data.signals.slice(
                    -LearningConfig.MAX_HISTORY
                );

            learner.data.outcomes =
                learner.data.outcomes.filter(
                    outcome =>
                        !removedIds.has(outcome.signalId)
                );
        }
    }

    static getResolvedSignals(learner) {
        return learner.data.signals.filter(
            signal =>
                LearningConfig.SUPPORTED_RESULTS.includes(
                    signal.outcome
                )
        );
    }

    static getPendingSignals(learner) {
        return learner.data.signals.filter(
            signal => signal.outcome === null
        );
    }

    static getSignalById(learner, id) {
        return learner.data.signals.find(
            signal => signal.id === id
        );
    }

    static updateTimestamp(learner) {
        learner.data.updatedAt =
            new Date().toISOString();
    }
}

/* =====================================================================
   Main Learning Engine
   ===================================================================== */

class PipSightLearner {
    constructor(options = {}) {
        this.dataPath =
            options.dataPath || "pipsight-learning.json";

        this.confidencePath =
            options.confidencePath || "pipsight-confidence.json";

        this.data = createEmptyLearningData();
        this.confidence = createEmptyConfidenceData();

        MemoryManager.initialize(this);
    }

    /* -----------------------------------------------------------------
       Legacy Frontend Compatibility Helpers
       ----------------------------------------------------------------- */

    normalizeLegacyPair(pair) {
        const normalized =
            String(pair || "")
                .trim()
                .toUpperCase()
                .replace(/[^A-Z]/g, "");

        if (
            normalized === "XAUUSD" ||
            normalized === "GOLD"
        ) {
            return "XAUUSD";
        }

        if (normalized === "GBPJPY") {
            return "GBPJPY";
        }

        return normalized;
    }

    normalizeLegacyStrategy(strategy) {
        const normalized =
            String(strategy || "")
                .trim()
                .toLowerCase();

        if (
            normalized === "intraday" ||
            normalized === "day"
        ) {
            return "daily";
        }

        if (
            normalized === "swing" ||
            normalized === "position"
        ) {
            return "weekly";
        }

        if (
            LearningConfig.SUPPORTED_STRATEGIES.includes(
                normalized
            )
        ) {
            return normalized;
        }

        return "scalp";
    }

    normalizeLegacyTimeframe(
        timeframe,
        strategy = "scalp"
    ) {
        const raw =
            String(timeframe || "")
                .trim();

        const aliases = {
            "5M": "5m",
            "M5": "5m",
            "5MIN": "5m",
            "15M": "15m",
            "M15": "15m",
            "15MIN": "15m",
            "30M": "30m",
            "M30": "30m",
            "30MIN": "30m",
            "H1": "1H",
            "1H": "1H",
            "H4": "4H",
            "4H": "4H",
            "D1": "D1",
            "1D": "D1",
            "DAILY": "D1"
        };

        const normalized =
            aliases[raw.toUpperCase()] ||
            raw;

        if (
            LearningConfig.SUPPORTED_TIMEFRAMES.includes(
                normalized
            )
        ) {
            return normalized;
        }

        if (strategy === "weekly") {
            return "D1";
        }

        if (strategy === "daily") {
            return "1H";
        }

        return "5m";
    }

    normalizeLegacyDirection(direction) {
        const normalized =
            String(direction || "")
                .trim()
                .toUpperCase();

        if (
            normalized === "BUY" ||
            normalized === "LONG"
        ) {
            return "BUY";
        }

        if (
            normalized === "SELL" ||
            normalized === "SHORT"
        ) {
            return "SELL";
        }

        return "HOLD";
    }

    normalizeLegacyOutcome(result) {
        const normalized =
            String(result || "")
                .trim()
                .toUpperCase();

        if (
            normalized === "WIN" ||
            normalized === "WON" ||
            normalized === "PROFIT" ||
            normalized === "TP" ||
            normalized === "TP1"
        ) {
            return "WIN";
        }

        if (
            normalized === "LOSS" ||
            normalized === "LOST" ||
            normalized === "SL" ||
            normalized === "STOP" ||
            normalized === "STOPPED"
        ) {
            return "LOSS";
        }

        if (
            normalized === "BREAKEVEN" ||
            normalized === "BREAK-EVEN" ||
            normalized === "BE" ||
            normalized === "DRAW"
        ) {
            return "BREAKEVEN";
        }

        return null;
    }

    calculateLegacyProfitPoints({
        outcome,
        direction,
        entry,
        closePrice,
        stopLoss,
        takeProfit
    } = {}) {
        const safeEntry =
            Number(entry);

        let safeClose =
            Number(closePrice);

        const safeStop =
            Number(stopLoss);

        const safeTarget =
            Number(takeProfit);

        if (
            !Number.isFinite(safeEntry) ||
            safeEntry <= 0
        ) {
            return 0;
        }

        if (
            !Number.isFinite(safeClose) ||
            safeClose <= 0
        ) {
            if (
                outcome === "WIN" &&
                Number.isFinite(safeTarget) &&
                safeTarget > 0
            ) {
                safeClose = safeTarget;
            } else if (
                outcome === "LOSS" &&
                Number.isFinite(safeStop) &&
                safeStop > 0
            ) {
                safeClose = safeStop;
            } else {
                safeClose = safeEntry;
            }
        }

        let profitPoints =
            direction === "SELL"
                ? safeEntry - safeClose
                : safeClose - safeEntry;

        if (outcome === "WIN") {
            profitPoints =
                Math.abs(profitPoints);
        } else if (outcome === "LOSS") {
            profitPoints =
                -Math.abs(profitPoints);
        } else {
            profitPoints = 0;
        }

        return round(
            profitPoints,
            6
        );
    }

    normalizeAutonomousContext(
        source = {}
    ) {
        if (!isPlainObject(source)) {
            return {};
        }

        const context = {};

        const stringFields = {
            engine:
                source.engine ??
                source.strategy,

            source:
                source.source,

            session:
                source.session ??
                source.marketSession,

            pattern:
                source.pattern ??
                source.patternName,

            marketRegime:
                source.marketRegime ??
                source.regime ??
                source.marketState,

            marketState:
                source.marketState,

            historyRecordId:
                source.historyRecordId,

            fingerprint:
                source.fingerprint,

            sourceTradeKey:
                source.sourceTradeKey ??
                source.tradeKey,

            setupIdentity:
                source.setupIdentity ??
                source.setupId,

            reason:
                source.reason,

            exitReason:
                source.exitReason ??
                source.resolutionReason,

            qualityGrade:
                source.qualityGrade,

            correctionReason:
                source.correctionReason ??
                source.revisionReason,

            sourceResolutionHash:
                source.sourceResolutionHash ??
                source.resolutionHash,

            resolverVersion:
                source.resolverVersion
        };

        for (
            const [
                field,
                value
            ] of Object.entries(
                stringFields
            )
        ) {
            const normalized =
                toTrimmedStringOrNull(
                    value
                );

            if (normalized) {
                context[field] =
                    normalized;
            }
        }

        const numericFields = {
            originalConfidence:
                source.originalConfidence ??
                source.confidence,

            legacyConfidence:
                source.legacyConfidence,

            aiScore:
                source.aiScore ??
                source.score,

            durationMinutes:
                source.durationMinutes ??
                source.tradeDurationMinutes,

            highestTargetReached:
                source.highestTargetReached,

            mfeR:
                source.mfeR,

            maeR:
                source.maeR,

            atr:
                source.atr
        };

        for (
            const [
                field,
                value
            ] of Object.entries(
                numericFields
            )
        ) {
            const normalized =
                toFiniteNumber(
                    value
                );

            if (normalized !== null) {
                context[field] =
                    normalized;
            }
        }

        return context;
    }

    buildOpeningIdentityPayload(
        source = {}
    ) {
        const context =
            this.normalizeAutonomousContext(
                source
            );

        const openedAt =
            toISOStringOrNull(
                source.openedAt ??
                source.signalTime ??
                source.timestamp
            );

        return {
            historyRecordId:
                context.historyRecordId ||
                null,

            sourceTradeKey:
                context.sourceTradeKey ||
                null,

            setupIdentity:
                context.setupIdentity ||
                null,

            fingerprint:
                context.fingerprint ||
                null,

            pair:
                this.normalizeLegacyPair(
                    source.pair
                ) || null,

            strategy:
                this.normalizeLegacyStrategy(
                    source.strategy ??
                    source.engine
                ),

            timeframe:
                this.normalizeLegacyTimeframe(
                    source.timeframe,
                    this.normalizeLegacyStrategy(
                        source.strategy ??
                        source.engine
                    )
                ),

            direction:
                this.normalizeLegacyDirection(
                    source.direction ??
                    source.signal
                ),

            entry:
                stableIdentityNumber(
                    source.entry ??
                    source.entryPrice
                ),

            openedAt
        };
    }

    createLearningIdentity(
        source = {}
    ) {
        const payload =
            this.buildOpeningIdentityPayload(
                source
            );

        let identitySource;

        if (payload.historyRecordId) {
            identitySource = {
                historyRecordId:
                    payload.historyRecordId
            };
        } else if (
            payload.sourceTradeKey
        ) {
            identitySource = {
                sourceTradeKey:
                    payload.sourceTradeKey
            };
        } else if (
            payload.fingerprint
        ) {
            identitySource = {
                fingerprint:
                    payload.fingerprint
            };
        } else {
            identitySource = {
                pair:
                    payload.pair,
                strategy:
                    payload.strategy,
                timeframe:
                    payload.timeframe,
                direction:
                    payload.direction,
                entry:
                    payload.entry,
                openedAt:
                    payload.openedAt
            };
        }

        const serialized =
            JSON.stringify(
                identitySource
            );

        return {
            schemaVersion:
                LearningConfig
                    .AUTONOMOUS_SCHEMA_VERSION,

            key:
                `learn_${createDeterministicHash(serialized)}`,

            source:
                identitySource,

            complete:
                Boolean(
                    payload.pair &&
                    payload.strategy &&
                    payload.timeframe &&
                    (
                        payload.direction ===
                            "BUY" ||
                        payload.direction ===
                            "SELL"
                    ) &&
                    payload.entry !== null &&
                    payload.entry > 0 &&
                    payload.openedAt
                ) ||
                Boolean(
                    payload.historyRecordId ||
                    payload.sourceTradeKey ||
                    payload.fingerprint
                )
        };
    }

    createOpeningIdentity(
        source = {}
    ) {
        const payload =
            this.buildOpeningIdentityPayload(
                source
            );

        const identitySource = {
            pair:
                payload.pair,
            strategy:
                payload.strategy,
            timeframe:
                payload.timeframe,
            direction:
                payload.direction,
            entry:
                payload.entry,
            openedAt:
                payload.openedAt
        };

        const complete =
            Boolean(
                identitySource.pair &&
                identitySource.strategy &&
                identitySource.timeframe &&
                (
                    identitySource.direction ===
                        "BUY" ||
                    identitySource.direction ===
                        "SELL"
                ) &&
                identitySource.entry !== null &&
                identitySource.entry > 0 &&
                identitySource.openedAt
            );

        return {
            schemaVersion:
                LearningConfig
                    .AUTONOMOUS_SCHEMA_VERSION,

            key:
                complete
                    ? `open_${createDeterministicHash(
                        JSON.stringify(
                            identitySource
                        )
                    )}`
                    : null,

            source:
                identitySource,

            complete
        };
    }

    haveConflictingExternalIdentities(
        leftSource = {},
        rightSource = {}
    ) {
        const left =
            this.buildOpeningIdentityPayload(
                leftSource
            );

        const right =
            this.buildOpeningIdentityPayload(
                rightSource
            );

        const externalIdentityFields = [
            "historyRecordId",
            "sourceTradeKey",
            "fingerprint"
        ];

        return externalIdentityFields.some(
            field =>
                Boolean(
                    left[field] &&
                    right[field] &&
                    left[field] !==
                        right[field]
                )
        );
    }

    haveMatchingExternalIdentity(
        leftSource = {},
        rightSource = {}
    ) {
        const left =
            this.buildOpeningIdentityPayload(
                leftSource
            );

        const right =
            this.buildOpeningIdentityPayload(
                rightSource
            );

        const externalIdentityFields = [
            "historyRecordId",
            "sourceTradeKey",
            "fingerprint"
        ];

        return externalIdentityFields.some(
            field =>
                Boolean(
                    left[field] &&
                    right[field] &&
                    left[field] ===
                        right[field]
                )
        );
    }

    backfillExternalIdentity(
        signal,
        source = {}
    ) {
        if (!isPlainObject(signal)) {
            return signal;
        }

        const payload =
            this.buildOpeningIdentityPayload(
                source
            );

        const externalIdentityFields = [
            "historyRecordId",
            "sourceTradeKey",
            "setupIdentity",
            "fingerprint"
        ];

        let changed = false;

        for (
            const field of
            externalIdentityFields
        ) {
            if (
                !toTrimmedStringOrNull(
                    signal[field]
                ) &&
                payload[field]
            ) {
                signal[field] =
                    payload[field];

                changed = true;
            }
        }

        if (changed) {
            this
                .enrichSignalForAutonomousLearning(
                    signal,
                    {
                        repair: true
                    }
                );
        }

        return signal;
    }

    deriveSignalId(
        source = {}
    ) {
        const explicitId =
            toTrimmedStringOrNull(
                source.id
            );

        if (
            explicitId &&
            !this.getSignalById(
                explicitId
            )
        ) {
            return explicitId;
        }

        const identity =
            this.createLearningIdentity(
                source
            );

        if (
            identity.complete
        ) {
            const deterministicId =
                `signal_${identity.key.slice(6)}`;

            if (
                !this.getSignalById(
                    deterministicId
                )
            ) {
                return deterministicId;
            }
        }

        return this.generateId();
    }

    buildAttributionQuality(
        signal
    ) {
        const reasons = [];
        let score = 100;

        const identity =
            this.createLearningIdentity(
                signal
            );

        if (!identity.complete) {
            score -= 35;
            reasons.push(
                "INCOMPLETE_OPENING_IDENTITY"
            );
        }

        const initialRiskPoints =
            calculateInitialRiskPoints(
                signal
            );

        if (
            initialRiskPoints === null
        ) {
            score -= 25;
            reasons.push(
                "INVALID_OR_MISSING_INITIAL_RISK"
            );
        }

        const openedAt =
            toISOStringOrNull(
                signal.openedAt ??
                signal.timestamp
            );

        if (!openedAt) {
            score -= 15;
            reasons.push(
                "MISSING_OPENED_AT"
            );
        }

        const context =
            this.normalizeAutonomousContext(
                signal
            );

        if (!context.engine) {
            score -= 5;
            reasons.push(
                "MISSING_ENGINE"
            );
        }

        if (
            !context.historyRecordId &&
            !context.sourceTradeKey &&
            !context.fingerprint
        ) {
            score -= 5;
            reasons.push(
                "NO_EXTERNAL_SOURCE_ID"
            );
        }

        score =
            clamp(
                score,
                0,
                100
            );

        return {
            score,
            grade:
                score >= 90
                    ? "A"
                    : score >= 75
                        ? "B"
                        : score >= 60
                            ? "C"
                            : "D",
            reasons
        };
    }

    enrichSignalForAutonomousLearning(
        signal,
        options = {}
    ) {
        if (!isPlainObject(signal)) {
            return signal;
        }

        const context =
            this.normalizeAutonomousContext(
                signal
            );

        for (
            const [
                field,
                value
            ] of Object.entries(
                context
            )
        ) {
            if (
                signal[field] === undefined ||
                signal[field] === null ||
                signal[field] === ""
            ) {
                signal[field] =
                    value;
            }
        }

        if (!signal.engine) {
            signal.engine =
                signal.strategy || null;
        }

        const openedAt =
            toISOStringOrNull(
                signal.openedAt ??
                signal.signalTime ??
                signal.timestamp
            );

        if (openedAt) {
            signal.openedAt =
                openedAt;

            if (!signal.timestamp) {
                signal.timestamp =
                    openedAt;
            }
        }

        const closedAt =
            toISOStringOrNull(
                signal.closedAt ??
                signal.resolvedAt
            );

        if (closedAt) {
            signal.closedAt =
                closedAt;
        }

        const initialRiskPoints =
            calculateInitialRiskPoints(
                signal
            );

        const plannedRewardPoints =
            calculatePlannedRewardPoints(
                signal
            );

        const plannedRiskReward =
            (
                initialRiskPoints !== null &&
                plannedRewardPoints !== null &&
                initialRiskPoints > 0
            )
                ? round(
                    plannedRewardPoints /
                        initialRiskPoints,
                    6
                )
                : null;

        const realizedR =
            calculateRealizedR(
                signal.profitPoints,
                initialRiskPoints
            );

        signal.initialRiskPoints =
            initialRiskPoints;

        signal.plannedRewardPoints =
            plannedRewardPoints;

        signal.plannedRiskReward =
            plannedRiskReward;

        signal.realizedR =
            realizedR;

        if (
            initialRiskPoints !== null
        ) {
            signal.initialRisk =
                initialRiskPoints;

            signal.risk =
                initialRiskPoints;
        }

        if (
            plannedRewardPoints !== null
        ) {
            signal.plannedReward =
                plannedRewardPoints;

            signal.reward =
                plannedRewardPoints;
        }

        if (
            plannedRiskReward !== null
        ) {
            signal.riskReward =
                plannedRiskReward;
        }

        const identity =
            this.createLearningIdentity(
                signal
            );

        signal.learningIdentity =
            identity.key;

        if (
            !Number.isInteger(
                signal.learningRevision
            ) ||
            signal.learningRevision < 1
        ) {
            signal.learningRevision = 1;
        }

        if (
            !Array.isArray(
                signal.correctionHistory
            )
        ) {
            signal.correctionHistory = [];
        }

        if (
            signal.correctionHistory.length >
            LearningConfig
                .MAX_CORRECTION_HISTORY
        ) {
            signal.correctionHistory =
                signal.correctionHistory.slice(
                    -LearningConfig
                        .MAX_CORRECTION_HISTORY
                );
        }

        const attribution =
            this.buildAttributionQuality(
                signal
            );

        signal.autonomousLearning = {
            schemaVersion:
                LearningConfig
                    .AUTONOMOUS_SCHEMA_VERSION,

            version:
                LearningConfig
                    .AUTONOMOUS_VERSION,

            advisoryOnly: true,
            liveAuthorityPermitted: false,

            identity: {
                key:
                    identity.key,
                complete:
                    identity.complete
            },

            context: {
                engine:
                    signal.engine || null,
                marketRegime:
                    signal.marketRegime || null,
                marketState:
                    signal.marketState || null,
                session:
                    signal.session || null,
                pattern:
                    signal.pattern || null,
                source:
                    signal.source || null
            },

            risk: {
                initialRiskPoints,
                plannedRewardPoints,
                plannedRiskReward,
                realizedR,
                eligible:
                    initialRiskPoints !== null &&
                    realizedR !== null
            },

            attribution,

            revision:
                signal.learningRevision,

            corrected:
                signal.learningRevision > 1,

            repaired:
                options.repair === true
        };

        return signal;
    }

    findExistingLegacySignal({
        pair,
        strategy,
        timeframe,
        direction,
        entry,
        openedAt,
        historyRecordId,
        sourceTradeKey,
        setupIdentity,
        fingerprint
    } = {}) {
        const identitySource = {
            pair,
            strategy,
            timeframe,
            direction,
            entry,
            openedAt,
            historyRecordId,
            sourceTradeKey,
            setupIdentity,
            fingerprint
        };

        const query =
            this.createLearningIdentity(
                identitySource
            );

        const openingIdentity =
            this.createOpeningIdentity(
                identitySource
            );

        let openingMatch = null;

        for (
            const signal of
            this.data.signals
        ) {
            if (!isPlainObject(signal)) {
                continue;
            }

            this
                .enrichSignalForAutonomousLearning(
                    signal,
                    {
                        repair: true
                    }
                );

            if (
                signal.learningIdentity ===
                query.key
            ) {
                return this
                    .backfillExternalIdentity(
                        signal,
                        identitySource
                    );
            }

            const querySetupIdentity =
                toTrimmedStringOrNull(
                    identitySource.setupIdentity
                );

            const candidateSetupIdentity =
                toTrimmedStringOrNull(
                    signal.setupIdentity
                );

            if (
                querySetupIdentity &&
                candidateSetupIdentity &&
                querySetupIdentity ===
                    candidateSetupIdentity
            ) {
                return this
                    .backfillExternalIdentity(
                        signal,
                        identitySource
                    );
            }

            if (
                !openingMatch &&
                openingIdentity.complete
            ) {
                const candidateOpeningIdentity =
                    this.createOpeningIdentity(
                        signal
                    );

                if (
                    candidateOpeningIdentity.complete &&
                    candidateOpeningIdentity.key ===
                        openingIdentity.key
                ) {
                    openingMatch =
                        signal;
                }
            }

            const externalIdentityConflict =
                this
                    .haveConflictingExternalIdentities(
                        signal,
                        identitySource
                    );

            if (externalIdentityConflict) {
                continue;
            }

            if (
                this
                    .haveMatchingExternalIdentity(
                        signal,
                        identitySource
                    )
            ) {
                return this
                    .backfillExternalIdentity(
                        signal,
                        identitySource
                    );
            }
        }

        return openingMatch
            ? this.backfillExternalIdentity(
                openingMatch,
                identitySource
            )
            : null;
    }

    isEquivalentResolution(
        signal,
        {
            outcome,
            profitPoints,
            closePrice,
            closedAt
        } = {}
    ) {
        if (!isPlainObject(signal)) {
            return false;
        }

        const sameOutcome =
            signal.outcome === outcome;

        const existingProfit =
            toFiniteNumber(
                signal.profitPoints
            );

        const candidateProfit =
            toFiniteNumber(
                profitPoints
            );

        const sameProfit =
            existingProfit !== null &&
            candidateProfit !== null &&
            Math.abs(
                existingProfit -
                candidateProfit
            ) <= 1e-9;

        const existingClose =
            toFiniteNumber(
                signal.closePrice
            );

        const candidateClose =
            toFiniteNumber(
                closePrice
            );

        const sameClose =
            (
                existingClose === null &&
                candidateClose === null
            ) ||
            (
                existingClose !== null &&
                candidateClose !== null &&
                Math.abs(
                    existingClose -
                    candidateClose
                ) <= 1e-9
            );

        const existingClosedAt =
            toISOStringOrNull(
                signal.closedAt ??
                signal.resolvedAt
            );

        const candidateClosedAt =
            toISOStringOrNull(
                closedAt
            );

        const sameClosedAt =
            !candidateClosedAt ||
            existingClosedAt ===
                candidateClosedAt;

        return (
            sameOutcome &&
            sameProfit &&
            sameClose &&
            sameClosedAt
        );
    }

    correctSignalOutcome(
        signalId,
        correction = {}
    ) {
        const signal =
            this.getSignalById(
                signalId
            );

        if (
            !signal ||
            !isPlainObject(correction)
        ) {
            return false;
        }

        const outcome =
            this.normalizeLegacyOutcome(
                correction.outcome ??
                correction.result
            );

        const profitPoints =
            toFiniteNumber(
                correction.profitPoints
            );

        const validation =
            SignalValidator
                .validateOutcome(
                    outcome,
                    profitPoints
                );

        if (!validation.valid) {
            console.warn(
                "Outcome correction failed:",
                validation.errors
            );

            return false;
        }

        const correctedAt =
            new Date().toISOString();

        if (
            !Array.isArray(
                signal.correctionHistory
            )
        ) {
            signal.correctionHistory = [];
        }

        signal.correctionHistory.push({
            revision:
                Number.isInteger(
                    signal.learningRevision
                )
                    ? signal.learningRevision
                    : 1,

            outcome:
                signal.outcome,

            profitPoints:
                signal.profitPoints,

            closePrice:
                signal.closePrice ?? null,

            closedAt:
                signal.closedAt ??
                signal.resolvedAt ??
                null,

            correctedAt,

            reason:
                toTrimmedStringOrNull(
                    correction.correctionReason ??
                    correction.reason
                ) ||
                "SOURCE_RECORD_CORRECTION"
        });

        signal.correctionHistory =
            signal.correctionHistory.slice(
                -LearningConfig
                    .MAX_CORRECTION_HISTORY
            );

        const currentRevision =
            Number.isInteger(
                signal.learningRevision
            )
                ? signal.learningRevision
                : 1;

        const requestedRevision =
            Number.isInteger(
                Number(
                    correction.revision
                )
            )
                ? Number(
                    correction.revision
                )
                : null;

        signal.learningRevision =
            Math.max(
                currentRevision + 1,
                requestedRevision || 1
            );

        const correctionContext =
            this.normalizeAutonomousContext(
                correction
            );

        Object.assign(
            signal,
            correctionContext
        );

        signal.outcome =
            outcome;

        signal.profitPoints =
            profitPoints;

        const closePrice =
            toFiniteNumber(
                correction.closePrice
            );

        if (
            closePrice !== null &&
            closePrice > 0
        ) {
            signal.closePrice =
                closePrice;
        }

        const closedAt =
            toISOStringOrNull(
                correction.closedAt ??
                correction.resolvedAt
            );

        if (closedAt) {
            signal.closedAt =
                closedAt;

            signal.resolvedAt =
                closedAt;
        } else if (
            !signal.resolvedAt
        ) {
            signal.resolvedAt =
                correctedAt;
        }

        if (
            isFiniteNumber(
                signal.entry
            ) &&
            signal.entry !== 0
        ) {
            signal.resultPercentage =
                round(
                    (
                        profitPoints /
                        Math.abs(
                            signal.entry
                        )
                    ) * 100,
                    4
                );
        } else {
            signal.resultPercentage =
                null;
        }

        const outcomeRecord =
            this.data.outcomes.find(
                record =>
                    record.signalId ===
                    signalId
            );

        if (outcomeRecord) {
            outcomeRecord.outcome =
                outcome;

            outcomeRecord.profitPoints =
                profitPoints;

            outcomeRecord.timestamp =
                signal.resolvedAt ||
                correctedAt;

            outcomeRecord.revision =
                signal.learningRevision;

            outcomeRecord.correctedAt =
                correctedAt;
        } else {
            this.data.outcomes.push({
                signalId,
                outcome,
                profitPoints,
                timestamp:
                    signal.resolvedAt ||
                    correctedAt,
                revision:
                    signal.learningRevision,
                correctedAt
            });
        }

        this
            .enrichSignalForAutonomousLearning(
                signal
            );

        this.updateStats();
        this.refreshPendingConfidence();
        MemoryManager.updateTimestamp(this);

        return signal.id;
    }

    findPendingLegacySignal({
        pair,
        strategy,
        timeframe,
        direction,
        entry,
        openedAt,
        historyRecordId,
        sourceTradeKey,
        setupIdentity,
        fingerprint
    } = {}) {
        const exactSignal =
            this.findExistingLegacySignal({
                pair,
                strategy,
                timeframe,
                direction,
                entry,
                openedAt,
                historyRecordId,
                sourceTradeKey,
                setupIdentity,
                fingerprint
            });

        return (
            exactSignal &&
            exactSignal.outcome === null
        )
            ? exactSignal
            : null;
    }

    /* -----------------------------------------------------------------
       Signal Recording
       ----------------------------------------------------------------- */

    recordSignal(signal) {
        const validation =
            SignalValidator.validate(signal);

        if (!validation.valid) {
            console.warn(
                "Signal validation failed:",
                validation.errors
            );

            return false;
        }

        const normalizedSignal = {
            ...signal
        };

        const openedAt =
            toISOStringOrNull(
                signal.openedAt ??
                signal.signalTime ??
                signal.timestamp
            ) ||
            new Date().toISOString();

        normalizedSignal.timestamp =
            openedAt;

        normalizedSignal.openedAt =
            openedAt;

        const context =
            this.normalizeAutonomousContext(
                signal
            );

        Object.assign(
            normalizedSignal,
            context
        );

        if (
            SignalValidator.isDuplicate(
                normalizedSignal,
                this.data.signals
            )
        ) {
            console.warn(
                "Duplicate pending signal ignored."
            );

            return false;
        }

        const existingIdentity =
            this.findExistingLegacySignal({
                pair:
                    normalizedSignal.pair,
                strategy:
                    normalizedSignal.strategy,
                timeframe:
                    normalizedSignal.timeframe,
                direction:
                    normalizedSignal.direction,
                entry:
                    normalizedSignal.entry,
                openedAt:
                    normalizedSignal.openedAt,
                historyRecordId:
                    normalizedSignal
                        .historyRecordId,
                sourceTradeKey:
                    normalizedSignal
                        .sourceTradeKey,
                setupIdentity:
                    normalizedSignal
                        .setupIdentity,
                fingerprint:
                    normalizedSignal
                        .fingerprint
            });

        if (existingIdentity) {
            console.warn(
                "Duplicate immutable trade identity ignored."
            );

            return false;
        }

        const recordedSignal = {
            ...normalizedSignal,

            id:
                this.deriveSignalId(
                    normalizedSignal
                ),

            indicators:
                Array.isArray(
                    normalizedSignal.indicators
                )
                    ? [
                        ...new Set(
                            normalizedSignal
                                .indicators
                        )
                    ]
                    : [],

            outcome: null,
            profitPoints: null,
            resultPercentage: null,
            resolvedAt: null,
            closedAt: null,
            closePrice: null,
            realizedR: null,
            learningRevision: 1,
            correctionHistory: []
        };

        recordedSignal.confidence =
            this.calculateAdaptiveConfidence(
                recordedSignal
            );

        const resolvedCount =
            MemoryManager
                .getResolvedSignals(
                    this
                )
                .length;

        const enoughDataToFilter =
            resolvedCount >=
            LearningConfig
                .MIN_SIGNALS_FOR_CONFIDENCE;

        recordedSignal.status =
            !enoughDataToFilter ||
            recordedSignal.confidence >=
                LearningConfig
                    .ACTIONABLE_CONFIDENCE_THRESHOLD
                ? "actionable"
                : "filtered";

        this
            .enrichSignalForAutonomousLearning(
                recordedSignal
            );

        this.data.signals.push(
            recordedSignal
        );

        MemoryManager.cleanup(this);
        MemoryManager.updateTimestamp(this);

        if (
            LearningConfig
                .AUTO_UPDATE_STATS !==
            false
        ) {
            this.updateStats();
        }

        return recordedSignal.id;
    }

    processSignal(signal) {
        const id = this.recordSignal(signal);

        if (id === false) {
            return {
                execute: false,
                reason:
                    "Signal was rejected because it was invalid or duplicated."
            };
        }

        const recorded =
            this.getSignalById(id);

        return {
            execute:
                recorded.status === "actionable",
            id: recorded.id,
            confidence: recorded.confidence,
            status: recorded.status,
            signal: recorded
        };
    }

    /* -----------------------------------------------------------------
       Signal Resolution
       ----------------------------------------------------------------- */

    resolveSignal(
        signalId,
        outcome,
        profitPoints = 0,
        resolutionMetadata = {}
    ) {
        const signal =
            this.getSignalById(signalId);

        if (!signal) {
            console.warn(
                "Signal not found:",
                signalId
            );

            return false;
        }

        if (signal.outcome !== null) {
            if (
                this.isEquivalentResolution(
                    signal,
                    {
                        outcome,
                        profitPoints,
                        closePrice:
                            resolutionMetadata
                                ?.closePrice,
                        closedAt:
                            resolutionMetadata
                                ?.closedAt
                    }
                )
            ) {
                return true;
            }

            console.warn(
                "Signal has already been resolved:",
                signalId
            );

            return false;
        }

        const validation =
            SignalValidator.validateOutcome(
                outcome,
                profitPoints
            );

        if (!validation.valid) {
            console.warn(
                "Outcome validation failed:",
                validation.errors
            );

            return false;
        }

        const resolvedAt =
            toISOStringOrNull(
                resolutionMetadata.closedAt ??
                resolutionMetadata.resolvedAt
            ) ||
            new Date().toISOString();

        signal.outcome =
            outcome;

        signal.profitPoints =
            profitPoints;

        signal.resolvedAt =
            resolvedAt;

        signal.closedAt =
            resolvedAt;

        const closePrice =
            toFiniteNumber(
                resolutionMetadata.closePrice
            );

        if (
            closePrice !== null &&
            closePrice > 0
        ) {
            signal.closePrice =
                closePrice;
        }

        const openedAt =
            toISOStringOrNull(
                resolutionMetadata.openedAt
            );

        if (openedAt) {
            signal.openedAt =
                openedAt;

            signal.timestamp =
                signal.timestamp ||
                openedAt;
        }

        const context =
            this.normalizeAutonomousContext(
                resolutionMetadata
            );

        Object.assign(
            signal,
            context
        );

        if (
            isFiniteNumber(signal.entry) &&
            signal.entry !== 0
        ) {
            signal.resultPercentage =
                round(
                    (
                        profitPoints /
                        Math.abs(
                            signal.entry
                        )
                    ) * 100,
                    4
                );
        } else {
            signal.resultPercentage =
                null;
        }

        const existingOutcome =
            this.data.outcomes.find(
                record =>
                    record.signalId ===
                    signalId
            );

        if (!existingOutcome) {
            this.data.outcomes.push({
                signalId,
                outcome,
                profitPoints,
                timestamp:
                    resolvedAt,
                revision:
                    signal.learningRevision ||
                    1
            });
        } else {
            existingOutcome.outcome =
                outcome;

            existingOutcome.profitPoints =
                profitPoints;

            existingOutcome.timestamp =
                resolvedAt;

            existingOutcome.revision =
                signal.learningRevision ||
                1;
        }

        this
            .enrichSignalForAutonomousLearning(
                signal
            );

        this.updateStats();
        this.refreshPendingConfidence();
        MemoryManager.updateTimestamp(this);

        return true;
    }

    /* -----------------------------------------------------------------
       Legacy Frontend Outcome Adapter
       ----------------------------------------------------------------- */

    recordOutcome(outcomeData = {}) {
        if (!isPlainObject(outcomeData)) {
            console.warn(
                "Legacy outcome recording failed: invalid outcome data."
            );

            return false;
        }

        const strategy =
            this.normalizeLegacyStrategy(
                outcomeData.strategy ??
                outcomeData.engine
            );

        const pair =
            this.normalizeLegacyPair(
                outcomeData.pair
            );

        const timeframe =
            this.normalizeLegacyTimeframe(
                outcomeData.timeframe,
                strategy
            );

        const direction =
            this.normalizeLegacyDirection(
                outcomeData.signal ??
                outcomeData.direction
            );

        const outcome =
            this.normalizeLegacyOutcome(
                outcomeData.result ??
                outcomeData.outcome
            );

        const entry =
            toFiniteNumber(
                outcomeData.entry ??
                outcomeData.entryPrice
            );

        const stopLoss =
            toFiniteNumber(
                outcomeData.stopLoss ??
                outcomeData.stop
            );

        const takeProfit =
            toFiniteNumber(
                outcomeData.takeProfit ??
                outcomeData.takeProfit1 ??
                outcomeData.target
            );

        const closePrice =
            toFiniteNumber(
                outcomeData.closePrice ??
                outcomeData.close
            );

        const openedAt =
            toISOStringOrNull(
                outcomeData.openedAt ??
                outcomeData.signalTime ??
                outcomeData.timestamp
            );

        const closedAt =
            toISOStringOrNull(
                outcomeData.closedAt ??
                outcomeData.resolvedAt
            );

        if (
            !LearningConfig
                .SUPPORTED_PAIRS
                .includes(pair)
        ) {
            console.warn(
                "Legacy outcome recording failed: unsupported pair.",
                pair
            );

            return false;
        }

        if (
            !LearningConfig
                .SUPPORTED_STRATEGIES
                .includes(strategy)
        ) {
            console.warn(
                "Legacy outcome recording failed: unsupported strategy.",
                strategy
            );

            return false;
        }

        if (
            !LearningConfig
                .SUPPORTED_TIMEFRAMES
                .includes(timeframe)
        ) {
            console.warn(
                "Legacy outcome recording failed: unsupported timeframe.",
                timeframe
            );

            return false;
        }

        if (
            direction !== "BUY" &&
            direction !== "SELL"
        ) {
            console.warn(
                "Legacy outcome recording failed: invalid trade direction.",
                direction
            );

            return false;
        }

        if (!outcome) {
            console.warn(
                "Legacy outcome recording failed: invalid result.",
                outcomeData.result ??
                outcomeData.outcome
            );

            return false;
        }

        if (
            entry === null ||
            entry <= 0
        ) {
            console.warn(
                "Legacy outcome recording failed: invalid entry price."
            );

            return false;
        }

        const profitPoints =
            this.calculateLegacyProfitPoints({
                outcome,
                direction,
                entry,
                closePrice,
                stopLoss,
                takeProfit
            });

        const identityQuery = {
            pair,
            strategy,
            timeframe,
            direction,
            entry,
            openedAt,
            historyRecordId:
                outcomeData.historyRecordId,
            sourceTradeKey:
                outcomeData.sourceTradeKey ??
                outcomeData.tradeKey,
            setupIdentity:
                outcomeData.setupIdentity ??
                outcomeData.setupId,
            fingerprint:
                outcomeData.fingerprint
        };

        let signal =
            this.findExistingLegacySignal(
                identityQuery
            );

        if (
            signal &&
            signal.outcome !== null
        ) {
            const correctionAllowed =
                outcomeData.corrected === true ||
                outcomeData.correction === true ||
                outcomeData.allowCorrection === true ||
                (
                    Number.isInteger(
                        Number(
                            outcomeData.revision
                        )
                    ) &&
                    Number(
                        outcomeData.revision
                    ) >
                    (
                        Number.isInteger(
                            signal.learningRevision
                        )
                            ? signal.learningRevision
                            : 1
                    )
                );

            const incomingResolutionHash =
                toTrimmedStringOrNull(
                    outcomeData
                        .sourceResolutionHash ??
                    outcomeData.resolutionHash
                );

            const currentResolutionHash =
                toTrimmedStringOrNull(
                    signal.sourceResolutionHash
                );

            const requestedRevision =
                Number.isInteger(
                    Number(
                        outcomeData.revision
                    )
                )
                    ? Number(
                        outcomeData.revision
                    )
                    : null;

            const currentRevision =
                Number.isInteger(
                    signal.learningRevision
                )
                    ? signal.learningRevision
                    : 1;

            const equivalentResolution =
                this.isEquivalentResolution(
                    signal,
                    {
                        outcome,
                        profitPoints,
                        closePrice,
                        closedAt
                    }
                );

            if (
                equivalentResolution &&
                (
                    !correctionAllowed ||
                    (
                        incomingResolutionHash &&
                        incomingResolutionHash ===
                            currentResolutionHash
                    ) ||
                    (
                        !incomingResolutionHash &&
                        requestedRevision !== null &&
                        requestedRevision <=
                            currentRevision
                    )
                )
            ) {
                return signal.id;
            }

            if (!correctionAllowed) {
                console.warn(
                    "Legacy outcome recording rejected: immutable trade identity is already resolved with different mutable fields. Mark the source as a correction."
                );

                return false;
            }

            return this.correctSignalOutcome(
                signal.id,
                {
                    ...outcomeData,
                    outcome,
                    profitPoints,
                    closePrice,
                    closedAt,
                    correctionReason:
                        outcomeData
                            .correctionReason ??
                        outcomeData.reason
                }
            );
        }

        if (!signal) {
            const signalPayload = {
                pair,
                strategy,
                timeframe,
                direction,
                entry,

                indicators:
                    Array.isArray(
                        outcomeData.indicators
                    )
                        ? outcomeData.indicators
                        : [],

                timestamp:
                    openedAt ||
                    new Date().toISOString(),

                openedAt:
                    openedAt ||
                    undefined,

                engine:
                    toTrimmedStringOrNull(
                        outcomeData.engine
                    ) ||
                    strategy,

                source:
                    toTrimmedStringOrNull(
                        outcomeData.source
                    ) ||
                    "legacy-outcome-adapter",

                historyRecordId:
                    toTrimmedStringOrNull(
                        outcomeData
                            .historyRecordId
                    ),

                sourceTradeKey:
                    toTrimmedStringOrNull(
                        outcomeData
                            .sourceTradeKey ??
                        outcomeData.tradeKey
                    ),

                setupIdentity:
                    toTrimmedStringOrNull(
                        outcomeData
                            .setupIdentity ??
                        outcomeData.setupId
                    ),

                fingerprint:
                    toTrimmedStringOrNull(
                        outcomeData.fingerprint
                    ),

                session:
                    toTrimmedStringOrNull(
                        outcomeData.session ??
                        outcomeData
                            .marketSession
                    ),

                pattern:
                    toTrimmedStringOrNull(
                        outcomeData.pattern ??
                        outcomeData
                            .patternName
                    ),

                marketRegime:
                    toTrimmedStringOrNull(
                        outcomeData
                            .marketRegime ??
                        outcomeData.regime ??
                        outcomeData
                            .marketState
                    ),

                marketState:
                    toTrimmedStringOrNull(
                        outcomeData.marketState
                    ),

                reason:
                    toTrimmedStringOrNull(
                        outcomeData.reason
                    )
            };

            const breakevenStopAtEntry =
                outcome === "BREAKEVEN" &&
                stopLoss !== null &&
                stopLoss === entry;

            if (
                stopLoss !== null &&
                stopLoss > 0 &&
                !breakevenStopAtEntry
            ) {
                signalPayload.stopLoss =
                    stopLoss;
            }

            Object.assign(
                signalPayload,
                this.normalizeAutonomousContext(
                    outcomeData
                )
            );

            if (
                takeProfit !== null &&
                takeProfit > 0
            ) {
                signalPayload.takeProfit =
                    takeProfit;
            }

            const confidence =
                toFiniteNumber(
                    outcomeData.confidence ??
                    outcomeData
                        .originalConfidence
                );

            if (confidence !== null) {
                signalPayload.confidence =
                    clamp(
                        confidence,
                        0,
                        100
                    );
            }

            const aiScore =
                toFiniteNumber(
                    outcomeData.aiScore ??
                    outcomeData.score
                );

            if (aiScore !== null) {
                signalPayload.aiScore =
                    aiScore;
            }

            const durationMinutes =
                toFiniteNumber(
                    outcomeData
                        .durationMinutes ??
                    outcomeData
                        .tradeDurationMinutes
                );

            if (
                durationMinutes !== null &&
                durationMinutes >= 0
            ) {
                signalPayload
                    .durationMinutes =
                    durationMinutes;
            }

            const signalId =
                this.recordSignal(
                    signalPayload
                );

            if (signalId === false) {
                signal =
                    this.findExistingLegacySignal(
                        identityQuery
                    );

                if (!signal) {
                    console.warn(
                        "Legacy outcome recording failed: signal could not be created."
                    );

                    return false;
                }
            } else {
                signal =
                    this.getSignalById(
                        signalId
                    );
            }
        }

        if (
            signal &&
            outcome === "BREAKEVEN" &&
            stopLoss !== null &&
            stopLoss === entry &&
            signal.outcome === null
        ) {
            signal.stopLoss =
                stopLoss;
        }

        if (
            !signal ||
            signal.outcome !== null
        ) {
            return false;
        }

        const resolvedClosePrice =
            closePrice !== null &&
            closePrice > 0
                ? closePrice
                : outcome === "WIN" &&
                  takeProfit !== null &&
                  takeProfit > 0
                    ? takeProfit
                    : outcome === "LOSS" &&
                      stopLoss !== null &&
                      stopLoss > 0
                        ? stopLoss
                        : entry;

        const resolved =
            this.resolveSignal(
                signal.id,
                outcome,
                profitPoints,
                {
                    ...outcomeData,
                    openedAt:
                        openedAt ||
                        signal.openedAt ||
                        signal.timestamp,
                    closedAt:
                        closedAt ||
                        new Date().toISOString(),
                    closePrice:
                        resolvedClosePrice,
                    engine:
                        outcomeData.engine ||
                        strategy
                }
            );

        if (!resolved) {
            return false;
        }

        const legacyConfidence =
            toFiniteNumber(
                outcomeData.confidence
            );

        signal.legacyConfidence =
            legacyConfidence !== null
                ? clamp(
                    legacyConfidence,
                    0,
                    100
                )
                : null;

        this
            .enrichSignalForAutonomousLearning(
                signal
            );

        MemoryManager.updateTimestamp(this);

        return signal.id;
    }

    /* -----------------------------------------------------------------
       Legacy addResult() Compatibility Adapter
       ----------------------------------------------------------------- */

    addResult(...args) {

        if (args.length === 0) {
            return false;
        }

        /*
         * Modern object style
         *
         * addResult({
         *     pair,
         *     strategy,
         *     timeframe,
         *     direction,
         *     result,
         *     ...
         * })
         */
        if (isPlainObject(args[0])) {
            return this.recordOutcome(args[0]);
        }

        /*
         * Legacy positional style
         *
         * addResult(
         *     strategy,
         *     pair,
         *     won,
         *     confidence
         * )
         */

        const [
            strategyInput,
            pairInput,
            won,
            confidence
        ] = args;

        const strategy =
            this.normalizeLegacyStrategy(
                strategyInput
            );

        const pair =
            this.normalizeLegacyPair(
                pairInput
            );

        /*
         * The four-argument legacy signature does not contain timeframe,
         * direction or entry. Never invent those values. Resolve it only
         * when exactly one existing pending signal matches the supplied
         * pair and strategy, then reuse that signal's verified fields.
         */
        const matchingPendingSignals =
            this.data.signals.filter(
                signal =>
                    isPlainObject(signal) &&
                    signal.outcome === null &&
                    signal.pair === pair &&
                    signal.strategy === strategy &&
                    LearningConfig
                        .SUPPORTED_TIMEFRAMES
                        .includes(
                            signal.timeframe
                        ) &&
                    (
                        signal.direction === "BUY" ||
                        signal.direction === "SELL"
                    ) &&
                    isFiniteNumber(
                        signal.entry
                    ) &&
                    signal.entry > 0
            );

        if (
            matchingPendingSignals.length !==
            1
        ) {
            console.warn(
                matchingPendingSignals.length === 0
                    ? "Legacy addResult failed: no unique pending signal matches the supplied pair and strategy."
                    : "Legacy addResult failed: multiple pending signals match; use object-style addResult with timeframe, direction and entry."
            );

            return false;
        }

        const pendingSignal =
            matchingPendingSignals[0];

        return this.recordOutcome({
            strategy:
                pendingSignal.strategy,

            pair:
                pendingSignal.pair,

            timeframe:
                pendingSignal.timeframe,

            direction:
                pendingSignal.direction,

            entry:
                pendingSignal.entry,

            stopLoss:
                pendingSignal.stopLoss,

            takeProfit:
                pendingSignal.takeProfit,

            openedAt:
                pendingSignal.openedAt ||
                pendingSignal.timestamp,

            result:
                won ? "WIN" : "LOSS",

            confidence
        });
    }

    /* -----------------------------------------------------------------
       Statistics
       ----------------------------------------------------------------- */

    buildGroupStats(
        signals,
        confidenceFilter = {}
    ) {
        const resolved = signals.filter(signal =>
            LearningConfig.SUPPORTED_RESULTS.includes(
                signal.outcome
            )
        );

        const wins = resolved.filter(
            signal => signal.outcome === "WIN"
        ).length;

        const losses = resolved.filter(
            signal => signal.outcome === "LOSS"
        ).length;

        const breakevens = resolved.filter(
            signal =>
                signal.outcome === "BREAKEVEN"
        ).length;

        const profitRecords = resolved.filter(
            signal =>
                isFiniteNumber(signal.profitPoints)
        );

        const totalProfitPoints =
            profitRecords.reduce(
                (sum, signal) =>
                    sum + signal.profitPoints,
                0
            );

        const grossProfitPoints =
            profitRecords
                .filter(
                    signal =>
                        signal.profitPoints > 0
                )
                .reduce(
                    (sum, signal) =>
                        sum +
                        signal.profitPoints,
                    0
                );

        const grossLossPoints =
            Math.abs(
                profitRecords
                    .filter(
                        signal =>
                            signal.profitPoints < 0
                    )
                    .reduce(
                        (sum, signal) =>
                            sum +
                            signal.profitPoints,
                        0
                    )
            );

        const decisiveTrades =
            wins + losses;

        const winRate =
            decisiveTrades > 0
                ? (wins / decisiveTrades) * 100
                : 0;

        const lossRate =
            decisiveTrades > 0
                ? (losses / decisiveTrades) *
                  100
                : 0;

        const breakevenRate =
            resolved.length > 0
                ? (breakevens /
                      resolved.length) *
                  100
                : 0;

        const avgProfitPoints =
            profitRecords.length > 0
                ? totalProfitPoints /
                  profitRecords.length
                : 0;

        let profitFactor = null;

        if (grossLossPoints > 0) {
            profitFactor =
                grossProfitPoints /
                grossLossPoints;
        } else if (grossProfitPoints > 0) {
            profitFactor = Infinity;
        }

        return {
            total: signals.length,
            resolved: resolved.length,
            pending:
                signals.length -
                resolved.length,

            wins,
            losses,
            breakevens,

            winRate: round(winRate),
            lossRate: round(lossRate),
            breakevenRate:
                round(breakevenRate),

            totalProfitPoints:
                round(totalProfitPoints),

            avgProfitPoints:
                round(avgProfitPoints),

            grossProfitPoints:
                round(grossProfitPoints),

            grossLossPoints:
                round(grossLossPoints),

            profitFactor:
                profitFactor === Infinity
                    ? "Infinity"
                    : profitFactor === null
                        ? null
                        : round(
                            profitFactor,
                            3
                        ),

            confidence:
                this.calculateConfidence(
                    confidenceFilter.strategy ||
                        null,

                    confidenceFilter.indicator ||
                        null,

                    confidenceFilter.pair ||
                        null,

                    confidenceFilter.timeframe ||
                        null
                )
        };
    }

    buildAutonomousStats(
        signals = []
    ) {
        const resolved =
            signals.filter(
                signal =>
                    isPlainObject(signal) &&
                    LearningConfig
                        .SUPPORTED_RESULTS
                        .includes(
                            signal.outcome
                        )
            );

        const eligible =
            resolved.filter(
                signal =>
                    isFiniteNumber(
                        signal.realizedR
                    )
            );

        const decisiveEligible =
            eligible.filter(
                signal =>
                    signal.outcome === "WIN" ||
                    signal.outcome === "LOSS"
            );

        const values =
            eligible.map(
                signal =>
                    signal.realizedR
            );

        const grossProfitR =
            round(
                values
                    .filter(
                        value =>
                            value > 0
                    )
                    .reduce(
                        (
                            sum,
                            value
                        ) =>
                            sum + value,
                        0
                    ),
                6
            );

        const grossLossR =
            round(
                Math.abs(
                    values
                        .filter(
                            value =>
                                value < 0
                        )
                        .reduce(
                            (
                                sum,
                                value
                            ) =>
                                sum + value,
                            0
                        )
                ),
                6
            );

        return {
            schemaVersion:
                LearningConfig
                    .AUTONOMOUS_SCHEMA_VERSION,

            version:
                LearningConfig
                    .AUTONOMOUS_VERSION,

            resolvedSignals:
                resolved.length,

            riskNormalizedSignals:
                eligible.length,

            excludedFromRiskNormalization:
                resolved.length -
                eligible.length,

            decisiveRiskNormalizedSignals:
                decisiveEligible.length,

            totalRealizedR:
                round(
                    values.reduce(
                        (
                            sum,
                            value
                        ) =>
                            sum + value,
                        0
                    ),
                    6
                ),

            averageRealizedR:
                values.length > 0
                    ? round(
                        values.reduce(
                            (
                                sum,
                                value
                            ) =>
                                sum + value,
                            0
                        ) /
                        values.length,
                        6
                    )
                    : 0,

            grossProfitR,

            grossLossR,

            profitFactorR:
                grossLossR > 0
                    ? round(
                        grossProfitR /
                            grossLossR,
                        6
                    )
                    : grossProfitR > 0
                        ? "Infinity"
                        : null,

            maximumDrawdownR:
                buildMaximumDrawdownR(
                    values
                ),

            correctedSignals:
                resolved.filter(
                    signal =>
                        Number.isInteger(
                            signal
                                .learningRevision
                        ) &&
                        signal
                            .learningRevision >
                            1
                ).length,

            advisoryOnly: true,
            liveAuthorityPermitted: false
        };
    }

    updateStats() {
        const allSignals =
            this.data.signals;

        const stats =
            createEmptyStats();

        const resolved =
            MemoryManager.getResolvedSignals(this);

        stats.totalSignals =
            allSignals.length;

        stats.resolvedSignals =
            resolved.length;

        stats.wins =
            resolved.filter(
                signal =>
                    signal.outcome === "WIN"
            ).length;

        stats.losses =
            resolved.filter(
                signal =>
                    signal.outcome === "LOSS"
            ).length;

        stats.breakevens =
            resolved.filter(
                signal =>
                    signal.outcome ===
                    "BREAKEVEN"
            ).length;

        stats.pending =
            allSignals.length -
            stats.resolvedSignals;

        const decisiveTrades =
            stats.wins + stats.losses;

        stats.winRate =
            decisiveTrades > 0
                ? round(
                    (stats.wins /
                        decisiveTrades) *
                        100
                )
                : 0;

        stats.lossRate =
            decisiveTrades > 0
                ? round(
                    (stats.losses /
                        decisiveTrades) *
                        100
                )
                : 0;

        stats.breakevenRate =
            stats.resolvedSignals > 0
                ? round(
                    (stats.breakevens /
                        stats.resolvedSignals) *
                        100
                )
                : 0;

        const profitSignals =
            resolved.filter(
                signal =>
                    isFiniteNumber(
                        signal.profitPoints
                    )
            );

        stats.totalProfitPoints =
            round(
                profitSignals.reduce(
                    (sum, signal) =>
                        sum +
                        signal.profitPoints,
                    0
                )
            );

        stats.avgProfitPoints =
            profitSignals.length > 0
                ? round(
                    stats.totalProfitPoints /
                        profitSignals.length
                )
                : 0;

        stats.grossProfitPoints =
            round(
                profitSignals
                    .filter(
                        signal =>
                            signal.profitPoints >
                            0
                    )
                    .reduce(
                        (sum, signal) =>
                            sum +
                            signal.profitPoints,
                        0
                    )
            );

        stats.grossLossPoints =
            round(
                Math.abs(
                    profitSignals
                        .filter(
                            signal =>
                                signal.profitPoints <
                                0
                        )
                        .reduce(
                            (sum, signal) =>
                                sum +
                                signal.profitPoints,
                            0
                        )
                )
            );

        if (stats.grossLossPoints > 0) {
            stats.profitFactor = round(
                stats.grossProfitPoints /
                    stats.grossLossPoints,
                3
            );
        } else if (
            stats.grossProfitPoints > 0
        ) {
            stats.profitFactor = "Infinity";
        } else {
            stats.profitFactor = null;
        }

        for (
            const strategy of
            LearningConfig.SUPPORTED_STRATEGIES
        ) {
            const matchingSignals =
                allSignals.filter(
                    signal =>
                        signal.strategy ===
                        strategy
                );

            if (matchingSignals.length > 0) {
                stats.strategies[strategy] =
                    this.buildGroupStats(
                        matchingSignals,
                        { strategy }
                    );
            }
        }

        for (
            const indicator of
            LearningConfig.SUPPORTED_INDICATORS
        ) {
            const matchingSignals =
                allSignals.filter(
                    signal =>
                        Array.isArray(
                            signal.indicators
                        ) &&
                        signal.indicators.includes(
                            indicator
                        )
                );

            if (matchingSignals.length > 0) {
                stats.indicators[indicator] =
                    this.buildGroupStats(
                        matchingSignals,
                        { indicator }
                    );
            }
        }

        for (
            const pair of
            LearningConfig.SUPPORTED_PAIRS
        ) {
            const matchingSignals =
                allSignals.filter(
                    signal =>
                        signal.pair === pair
                );

            if (matchingSignals.length > 0) {
                stats.pairs[pair] =
                    this.buildGroupStats(
                        matchingSignals,
                        { pair }
                    );
            }
        }

        for (
            const timeframe of
            LearningConfig.SUPPORTED_TIMEFRAMES
        ) {
            const matchingSignals =
                allSignals.filter(
                    signal =>
                        signal.timeframe ===
                        timeframe
                );

            if (matchingSignals.length > 0) {
                stats.timeframes[timeframe] =
                    this.buildGroupStats(
                        matchingSignals,
                        { timeframe }
                    );
            }
        }

        for (
            const signal of allSignals
        ) {
            this
                .enrichSignalForAutonomousLearning(
                    signal,
                    {
                        repair: true
                    }
                );
        }

        stats.autonomous =
            this.buildAutonomousStats(
                allSignals
            );

        stats.updatedAt =
            new Date().toISOString();

        this.data.stats = stats;
        MemoryManager.updateTimestamp(this);

        return stats;
    }

    /* -----------------------------------------------------------------
       Confidence Engine
       ----------------------------------------------------------------- */

    calculateConfidence(
        strategy = null,
        indicator = null,
        pair = null,
        timeframe = null
    ) {
        const matchingSignals =
            this.data.signals.filter(signal => {
                if (
                    strategy &&
                    signal.strategy !== strategy
                ) {
                    return false;
                }

                if (
                    indicator &&
                    (
                        !Array.isArray(
                            signal.indicators
                        ) ||
                        !signal.indicators.includes(
                            indicator
                        )
                    )
                ) {
                    return false;
                }

                if (
                    pair &&
                    signal.pair !== pair
                ) {
                    return false;
                }

                if (
                    timeframe &&
                    signal.timeframe !==
                        timeframe
                ) {
                    return false;
                }

                return true;
            });

        const outcomes =
            matchingSignals.filter(signal =>
                LearningConfig.SUPPORTED_RESULTS.includes(
                    signal.outcome
                )
            );

        if (
            outcomes.length <
            LearningConfig.MIN_SIGNALS_FOR_LEARNING
        ) {
            return LearningConfig
                .DEFAULT_CONFIDENCE;
        }

        const decisiveOutcomes =
            outcomes.filter(
                signal =>
                    signal.outcome === "WIN" ||
                    signal.outcome === "LOSS"
            );

        if (decisiveOutcomes.length === 0) {
            return LearningConfig
                .DEFAULT_CONFIDENCE;
        }

        const wins =
            decisiveOutcomes.filter(
                signal =>
                    signal.outcome === "WIN"
            ).length;

        const longTermRate =
            (wins /
                decisiveOutcomes.length) *
            100;

        const recentWindow =
            decisiveOutcomes.slice(
                -LearningConfig
                    .PERFORMANCE_WINDOW
            );

        const recentWins =
            recentWindow.filter(
                signal =>
                    signal.outcome === "WIN"
            ).length;

        const recentRate =
            recentWindow.length > 0
                ? (recentWins /
                      recentWindow.length) *
                  100
                : longTermRate;

        const sampleWeight =
            Math.min(
                decisiveOutcomes.length / 100,
                1
            );

        let confidence =
            LearningConfig.DEFAULT_CONFIDENCE *
                (1 - sampleWeight) +
            longTermRate * sampleWeight;

        confidence =
            confidence * 0.75 +
            recentRate * 0.25;

        if (
            recentRate >
            longTermRate + 15
        ) {
            confidence += 3;
        } else if (
            recentRate <
            longTermRate - 15
        ) {
            confidence -= 3;
        }

        if (
            decisiveOutcomes.length >= 50
        ) {
            confidence += 2;
        }

        if (
            decisiveOutcomes.length >= 100
        ) {
            confidence += 2;
        }

        return Math.round(
            clamp(
                confidence,
                LearningConfig.MIN_CONFIDENCE,
                LearningConfig.MAX_CONFIDENCE
            )
        );
    }

    calculateAdaptiveConfidence(signal) {
        if (!isPlainObject(signal)) {
            return LearningConfig
                .DEFAULT_CONFIDENCE;
        }

        let confidence =
            this.calculateConfidence(
                signal.strategy,
                null,
                signal.pair,
                signal.timeframe
            );

        if (
            Array.isArray(signal.indicators) &&
            signal.indicators.length > 0
        ) {
            const indicatorScores =
                signal.indicators.map(
                    indicator =>
                        this.calculateConfidence(
                            null,
                            indicator,
                            signal.pair,
                            signal.timeframe
                        )
                );

            const indicatorAverage =
                indicatorScores.reduce(
                    (sum, score) =>
                        sum + score,
                    0
                ) /
                indicatorScores.length;

            confidence =
                confidence * 0.65 +
                indicatorAverage * 0.35;
        }

        const recentSignals =
            this.data.signals
                .filter(
                    existing =>
                        (
                            existing.outcome ===
                                "WIN" ||
                            existing.outcome ===
                                "LOSS"
                        ) &&
                        existing.strategy ===
                            signal.strategy &&
                        existing.pair ===
                            signal.pair
                )
                .slice(
                    -LearningConfig
                        .PERFORMANCE_WINDOW
                );

        if (recentSignals.length >= 10) {
            const recentWins =
                recentSignals.filter(
                    existing =>
                        existing.outcome ===
                        "WIN"
                ).length;

            const recentWinRate =
                (recentWins /
                    recentSignals.length) *
                100;

            if (recentWinRate > 70) {
                confidence += 3;
            } else if (
                recentWinRate < 40
            ) {
                confidence -= 3;
            }
        }

        return Math.round(
            clamp(
                confidence,
                LearningConfig.MIN_CONFIDENCE,
                LearningConfig.MAX_CONFIDENCE
            )
        );
    }

    updateSignalConfidence(signal) {
        if (!signal || signal.outcome !== null) {
            return false;
        }

        signal.confidence =
            this.calculateAdaptiveConfidence(
                signal
            );

        signal.status =
            signal.confidence >=
            LearningConfig
                .ACTIONABLE_CONFIDENCE_THRESHOLD
                ? "actionable"
                : "filtered";

        return signal.confidence;
    }

    refreshPendingConfidence() {
        const resolvedCount =
            MemoryManager
                .getResolvedSignals(this)
                .length;

        const enoughDataToFilter =
            resolvedCount >=
            LearningConfig.MIN_SIGNALS_FOR_CONFIDENCE;

        for (
            const signal of
            MemoryManager.getPendingSignals(this)
        ) {
            signal.confidence =
                this.calculateAdaptiveConfidence(
                    signal
                );

            signal.status =
                !enoughDataToFilter ||
                signal.confidence >=
                    LearningConfig
                        .ACTIONABLE_CONFIDENCE_THRESHOLD
                    ? "actionable"
                    : "filtered";
        }

        MemoryManager.updateTimestamp(this);

        return true;
    }

    /* -----------------------------------------------------------------
       Performance Analysis
       ----------------------------------------------------------------- */

    optimizePerformance() {
        if (
            !this.data.stats ||
            !isPlainObject(this.data.stats)
        ) {
            this.updateStats();
        }

        const optimization = {
            bestStrategy: null,
            bestPair: null,
            bestTimeframe: null,

            weakestStrategy: null,
            weakestPair: null,
            weakestTimeframe: null,

            suggestions: []
        };

        const pickBestAndWeakest = (
            source,
            minimumResolved = 1
        ) => {
            const entries = Object.entries(
                source || {}
            ).filter(([, value]) => {
                return (
                    value &&
                    isFiniteNumber(value.winRate) &&
                    Number(value.resolved || 0) >=
                        minimumResolved
                );
            });

            if (entries.length === 0) {
                return {
                    best: null,
                    weakest: null
                };
            }

            const sorted = entries.sort(
                (a, b) =>
                    b[1].winRate -
                    a[1].winRate
            );

            return {
                best: sorted[0][0],
                weakest:
                    sorted[sorted.length - 1][0]
            };
        };

        const strategySelection =
            pickBestAndWeakest(
                this.data.stats.strategies,
                LearningConfig.MIN_SIGNALS_FOR_LEARNING
            );

        optimization.bestStrategy =
            strategySelection.best;

        optimization.weakestStrategy =
            strategySelection.weakest;

        const pairSelection =
            pickBestAndWeakest(
                this.data.stats.pairs,
                LearningConfig.MIN_SIGNALS_FOR_LEARNING
            );

        optimization.bestPair =
            pairSelection.best;

        optimization.weakestPair =
            pairSelection.weakest;

        const timeframeSelection =
            pickBestAndWeakest(
                this.data.stats.timeframes,
                LearningConfig.MIN_SIGNALS_FOR_LEARNING
            );

        optimization.bestTimeframe =
            timeframeSelection.best;

        optimization.weakestTimeframe =
            timeframeSelection.weakest;

        if (optimization.bestStrategy) {
            optimization.suggestions.push(
                `Best-performing strategy: ${optimization.bestStrategy}.`
            );
        }

        if (
            optimization.weakestStrategy &&
            optimization.weakestStrategy !==
                optimization.bestStrategy
        ) {
            optimization.suggestions.push(
                `Review the ${optimization.weakestStrategy} strategy before increasing its use.`
            );
        }

        if (optimization.bestPair) {
            optimization.suggestions.push(
                `Best-performing pair: ${optimization.bestPair}.`
            );
        }

        if (
            optimization.weakestPair &&
            optimization.weakestPair !==
                optimization.bestPair
        ) {
            optimization.suggestions.push(
                `Review signal quality on ${optimization.weakestPair}.`
            );
        }

        if (optimization.bestTimeframe) {
            optimization.suggestions.push(
                `Best-performing timeframe: ${optimization.bestTimeframe}.`
            );
        }

        if (
            optimization.weakestTimeframe &&
            optimization.weakestTimeframe !==
                optimization.bestTimeframe
        ) {
            optimization.suggestions.push(
                `Review the ${optimization.weakestTimeframe} timeframe rules.`
            );
        }

        if (
            optimization.suggestions.length === 0
        ) {
            optimization.suggestions.push(
                "Insufficient resolved history for reliable optimization."
            );
        }

        return optimization;
    }

    getPerformanceTrend() {
        const decisiveSignals =
            this.data.signals.filter(
                signal =>
                    signal.outcome === "WIN" ||
                    signal.outcome === "LOSS"
            );

        const windowSize =
            LearningConfig.PERFORMANCE_WINDOW;

        if (
            decisiveSignals.length <
            windowSize * 2
        ) {
            return LearningConfig
                .PERFORMANCE_STATUS.UNKNOWN;
        }

        const recent =
            decisiveSignals.slice(-windowSize);

        const older =
            decisiveSignals.slice(
                -(windowSize * 2),
                -windowSize
            );

        if (
            recent.length === 0 ||
            older.length === 0
        ) {
            return LearningConfig
                .PERFORMANCE_STATUS.UNKNOWN;
        }

        const recentWinRate =
            (
                recent.filter(
                    signal =>
                        signal.outcome === "WIN"
                ).length /
                recent.length
            ) * 100;

        const olderWinRate =
            (
                older.filter(
                    signal =>
                        signal.outcome === "WIN"
                ).length /
                older.length
            ) * 100;

        const difference =
            recentWinRate -
            olderWinRate;

        if (difference > 10) {
            return LearningConfig
                .PERFORMANCE_STATUS.IMPROVING;
        }

        if (difference < -10) {
            return LearningConfig
                .PERFORMANCE_STATUS.DECLINING;
        }

        return LearningConfig
            .PERFORMANCE_STATUS.STABLE;
    }

    getBestStrategy() {
        const strategies =
            this.data.stats.strategies || {};

        let bestStrategy = null;
        let bestRate = -1;

        for (
            const [strategy, values] of
            Object.entries(strategies)
        ) {
            if (
                !values ||
                !isFiniteNumber(values.winRate) ||
                Number(values.resolved || 0) <
                    LearningConfig.MIN_SIGNALS_FOR_LEARNING
            ) {
                continue;
            }

            if (values.winRate > bestRate) {
                bestRate = values.winRate;
                bestStrategy = strategy;
            }
        }

        return {
            strategy: bestStrategy,
            winRate:
                bestStrategy === null
                    ? 0
                    : bestRate
        };
    }

    getBestIndicator() {
        const indicators =
            this.data.stats.indicators || {};

        let bestIndicator = null;
        let bestRate = -1;

        for (
            const [indicator, values] of
            Object.entries(indicators)
        ) {
            if (
                !values ||
                !isFiniteNumber(values.winRate) ||
                Number(values.resolved || 0) <
                    LearningConfig.MIN_SIGNALS_FOR_LEARNING
            ) {
                continue;
            }

            if (values.winRate > bestRate) {
                bestRate = values.winRate;
                bestIndicator = indicator;
            }
        }

        return {
            indicator: bestIndicator,
            winRate:
                bestIndicator === null
                    ? 0
                    : bestRate
        };
    }

    getRecommendation() {
        if (
            !this.data.stats ||
            !isPlainObject(this.data.stats)
        ) {
            this.updateStats();
        }

        const bestStrategy =
            this.getBestStrategy();

        const bestIndicator =
            this.getBestIndicator();

        const trend =
            this.getPerformanceTrend();

        const optimization =
            this.optimizePerformance();

        return {
            bestStrategy:
                bestStrategy.strategy,

            bestStrategyRate:
                bestStrategy.winRate,

            bestIndicator:
                bestIndicator.indicator,

            bestIndicatorRate:
                bestIndicator.winRate,

            trend,
            optimization,

            recommendation:
                this.generateRecommendation(
                    bestStrategy,
                    bestIndicator,
                    trend
                )
        };
    }

    generateRecommendation(
        bestStrategy,
        bestIndicator,
        trend
    ) {
        const recommendations = [];

        if (bestStrategy.strategy) {
            recommendations.push(
                `Best strategy is ${bestStrategy.strategy} with a ${bestStrategy.winRate.toFixed(
                    1
                )}% win rate.`
            );
        }

        if (bestIndicator.indicator) {
            recommendations.push(
                `${bestIndicator.indicator} is currently the strongest indicator with ${bestIndicator.winRate.toFixed(
                    1
                )}% accuracy.`
            );
        }

        if (
            trend ===
            LearningConfig
                .PERFORMANCE_STATUS.IMPROVING
        ) {
            recommendations.push(
                "Performance is improving; keep risk rules unchanged while monitoring the trend."
            );
        } else if (
            trend ===
            LearningConfig
                .PERFORMANCE_STATUS.DECLINING
        ) {
            recommendations.push(
                "Performance is declining; reduce exposure and review recent losing setups."
            );
        }

        const resolvedSignals =
            Number(
                this.data.stats
                    .resolvedSignals || 0
            );

        if (
            resolvedSignals <
            LearningConfig.MIN_SIGNALS_FOR_LEARNING
        ) {
            recommendations.push(
                `At least ${LearningConfig.MIN_SIGNALS_FOR_LEARNING} resolved signals are required before relying on performance conclusions.`
            );
        } else if (
            this.data.stats.winRate < 50
        ) {
            recommendations.push(
                "Overall win rate is below 50%; review filters and execution quality."
            );
        } else if (
            this.data.stats.winRate > 65
        ) {
            recommendations.push(
                "Overall performance is strong; continue using the existing risk limits."
            );
        }

        return recommendations.length > 0
            ? recommendations
            : [
                "Insufficient data for a reliable recommendation."
            ];
    }

    /* -----------------------------------------------------------------
       Query Helpers
       ----------------------------------------------------------------- */

    getActionableSignals() {
        return this.data.signals.filter(
            signal =>
                signal.status === "actionable"
        );
    }

    getFilteredSignals() {
        return this.data.signals.filter(
            signal =>
                signal.status === "filtered"
        );
    }

    getSignalById(id) {
        return MemoryManager.getSignalById(
            this,
            id
        );
    }

    getStats() {
        if (
            !this.data.stats ||
            !isPlainObject(this.data.stats)
        ) {
            return this.updateStats();
        }

        return this.data.stats;
    }

    getConfidenceData() {
        if (
            !this.data.stats ||
            !isPlainObject(this.data.stats)
        ) {
            this.updateStats();
        }

        this.confidence = {
            strategies: {
                ...this.data.stats.strategies
            },

            indicators: {
                ...this.data.stats.indicators
            },

            pairs: {
                ...this.data.stats.pairs
            },

            timeframes: {
                ...this.data.stats.timeframes
            },

            overall: {
                totalSignals:
                    this.data.signals.length,

                resolvedSignals:
                    this.data.stats
                        .resolvedSignals || 0,

                winRate:
                    this.data.stats.winRate || 0,

                avgProfitPoints:
                    this.data.stats
                        .avgProfitPoints || 0,

                profitFactor:
                    this.data.stats
                        .profitFactor ?? null,

                autonomous:
                    this.data.stats
                        .autonomous || null
            },

            updatedAt:
                new Date().toISOString(),

            metadata: {
                engine:
                    LearningConfig.ENGINE_NAME,

                version:
                    LearningConfig.VERSION,

                autonomousLearning: {
                    schemaVersion:
                        LearningConfig
                            .AUTONOMOUS_SCHEMA_VERSION,

                    version:
                        LearningConfig
                            .AUTONOMOUS_VERSION,

                    advisoryOnly: true,
                    liveAuthorityPermitted: false
                }
            }
        };

        return this.confidence;
    }

    getAutonomousLearningData() {
        if (
            !this.data.stats ||
            !isPlainObject(
                this.data.stats
            )
        ) {
            this.updateStats();
        }

        return {
            schemaVersion:
                LearningConfig
                    .AUTONOMOUS_SCHEMA_VERSION,

            version:
                LearningConfig
                    .AUTONOMOUS_VERSION,

            advisoryOnly: true,
            liveAuthorityPermitted: false,

            stats:
                this.data.stats
                    .autonomous || null,

            signals:
                this.data.signals.map(
                    signal => ({
                        id:
                            signal.id,
                        learningIdentity:
                            signal
                                .learningIdentity ||
                            null,
                        learningRevision:
                            signal
                                .learningRevision ||
                            1,
                        autonomousLearning:
                            signal
                                .autonomousLearning ||
                            null
                    })
                )
        };
    }

    /* -----------------------------------------------------------------
       Import, Export and Reset
       ----------------------------------------------------------------- */

    resetLearning() {
        this.data =
            createEmptyLearningData();

        this.confidence =
            createEmptyConfidenceData();

        MemoryManager.initialize(this);

        return true;
    }

    exportData() {
        return {
            learning: this.data,
            confidence:
                this.getConfidenceData(),

            autonomousLearning:
                this.getAutonomousLearningData(),

            exportedAt:
                new Date().toISOString(),

            metadata: {
                engine:
                    LearningConfig.ENGINE_NAME,

                version:
                    LearningConfig.VERSION,

                autonomousLearning: {
                    schemaVersion:
                        LearningConfig
                            .AUTONOMOUS_SCHEMA_VERSION,

                    version:
                        LearningConfig
                            .AUTONOMOUS_VERSION,

                    advisoryOnly: true,
                    liveAuthorityPermitted: false
                }
            }
        };
    }

    importData(data) {
        if (!isPlainObject(data)) {
            console.warn(
                "Import failed: invalid backup data."
            );

            return false;
        }

        if (
            data.learning !== undefined &&
            !isPlainObject(data.learning)
        ) {
            console.warn(
                "Import failed: learning data is invalid."
            );

            return false;
        }

        if (
            data.confidence !== undefined &&
            !isPlainObject(data.confidence)
        ) {
            console.warn(
                "Import failed: confidence data is invalid."
            );

            return false;
        }

        if (data.learning) {
            this.data = data.learning;
        }

        if (data.confidence) {
            this.confidence =
                data.confidence;
        }

        MemoryManager.initialize(this);
        this.updateStats();
        this.refreshPendingConfidence();

        return true;
    }

    generateId() {
        const randomPart =
            Math.random()
                .toString(36)
                .slice(2, 11);

        return `signal_${Date.now()}_${randomPart}`;
    }
}
/* =====================================================================
   Node.js Export
   ===================================================================== */
if (
    typeof module !== "undefined" &&
    module.exports
) {
    module.exports = {
        PipSightLearner,
        LearningConfig,
        SignalValidator,
        MemoryManager,
        AUTONOMOUS_LEARNING_VERSION:
            LearningConfig
                .AUTONOMOUS_VERSION
    };
}
/* =====================================================================
   Browser Export
   ===================================================================== */
if (typeof window !== "undefined") {
    window.PipSightLearner = PipSightLearner;
    window.LearningConfig = LearningConfig;
    window.SignalValidator = SignalValidator;
    window.MemoryManager = MemoryManager;
}
