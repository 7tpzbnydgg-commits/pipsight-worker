"use strict";

/* =====================================================================
   PipSight Pro AI
   Learning and Confidence Engine
   Version: 2.1.0

   Compatibility:
   - Existing public methods preserved.
   - Existing signal and confidence structures preserved.
   - Works in Node.js and browser environments.
   ===================================================================== */

class LearningConfig {
    static VERSION = "2.1.0";
    static ENGINE_NAME = "PipSight Pro AI";

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
            version: LearningConfig.VERSION
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
            version: LearningConfig.VERSION
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
                signal.timestamp = new Date().toISOString();
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

    findPendingLegacySignal({
        pair,
        strategy,
        timeframe,
        direction,
        entry
    } = {}) {
        const safeEntry =
            Number(entry);

        const exactMatch =
            this.data.signals.find(signal => {
                return (
                    signal &&
                    signal.outcome === null &&
                    signal.pair === pair &&
                    signal.strategy === strategy &&
                    signal.timeframe === timeframe &&
                    signal.direction === direction &&
                    Number(signal.entry) === safeEntry
                );
            });

        if (exactMatch) {
            return exactMatch;
        }

        return this.data.signals.find(signal => {
            return (
                signal &&
                signal.outcome === null &&
                signal.pair === pair &&
                signal.strategy === strategy &&
                signal.direction === direction
            );
        }) || null;
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

        if (
            SignalValidator.isDuplicate(
                signal,
                this.data.signals
            )
        ) {
            console.warn(
                "Duplicate pending signal ignored."
            );

            return false;
        }

        const now = new Date().toISOString();

        const recordedSignal = {
            ...signal,

            id: this.generateId(),

            indicators: Array.isArray(signal.indicators)
                ? [...new Set(signal.indicators)]
                : [],

            timestamp: signal.timestamp || now,

            outcome: null,
            profitPoints: null,
            resultPercentage: null,
            resolvedAt: null
        };

        recordedSignal.confidence =
            this.calculateAdaptiveConfidence(
                recordedSignal
            );

        const resolvedCount =
            MemoryManager.getResolvedSignals(this).length;

        const enoughDataToFilter =
            resolvedCount >=
            LearningConfig.MIN_SIGNALS_FOR_CONFIDENCE;

        recordedSignal.status =
            !enoughDataToFilter ||
            recordedSignal.confidence >=
                LearningConfig
                    .ACTIONABLE_CONFIDENCE_THRESHOLD
                ? "actionable"
                : "filtered";

        this.data.signals.push(recordedSignal);

        MemoryManager.cleanup(this);
        MemoryManager.updateTimestamp(this);

        if (LearningConfig.AUTO_UPDATE_STATS !== false) {
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
        profitPoints = 0
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
            new Date().toISOString();

        signal.outcome = outcome;
        signal.profitPoints = profitPoints;
        signal.resolvedAt = resolvedAt;

        if (
            isFiniteNumber(signal.entry) &&
            signal.entry !== 0
        ) {
            signal.resultPercentage = round(
                (profitPoints /
                    Math.abs(signal.entry)) *
                    100,
                4
            );
        } else {
            signal.resultPercentage = null;
        }

        const existingOutcome =
            this.data.outcomes.find(
                record =>
                    record.signalId === signalId
            );

        if (!existingOutcome) {
            this.data.outcomes.push({
                signalId,
                outcome,
                profitPoints,
                timestamp: resolvedAt
            });
        }

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
                outcomeData.strategy
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
                outcomeData.signal ||
                outcomeData.direction
            );

        const outcome =
            this.normalizeLegacyOutcome(
                outcomeData.result ||
                outcomeData.outcome
            );

        const entry =
            Number(outcomeData.entry);

        const stopLoss =
            Number(
                outcomeData.stopLoss ??
                outcomeData.stop
            );

        const takeProfit =
            Number(
                outcomeData.takeProfit ??
                outcomeData.target
            );

        const closePrice =
            Number(
                outcomeData.closePrice ??
                outcomeData.close
            );

        if (
            !LearningConfig.SUPPORTED_PAIRS.includes(
                pair
            )
        ) {
            console.warn(
                "Legacy outcome recording failed: unsupported pair.",
                pair
            );

            return false;
        }

        if (
            !LearningConfig.SUPPORTED_STRATEGIES.includes(
                strategy
            )
        ) {
            console.warn(
                "Legacy outcome recording failed: unsupported strategy.",
                strategy
            );

            return false;
        }

        if (
            !LearningConfig.SUPPORTED_TIMEFRAMES.includes(
                timeframe
            )
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
                outcomeData.result ||
                outcomeData.outcome
            );

            return false;
        }

        if (
            !Number.isFinite(entry) ||
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

        let pendingSignal =
            this.findPendingLegacySignal({
                pair,
                strategy,
                timeframe,
                direction,
                entry
            });

        if (!pendingSignal) {
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
                    outcomeData.openedAt ||
                    outcomeData.timestamp ||
                    new Date().toISOString()
            };

            if (
                Number.isFinite(stopLoss) &&
                stopLoss > 0
            ) {
                signalPayload.stopLoss =
                    stopLoss;
            }

            if (
                Number.isFinite(takeProfit) &&
                takeProfit > 0
            ) {
                signalPayload.takeProfit =
                    takeProfit;
            }

            if (
                Number.isFinite(
                    Number(outcomeData.confidence)
                )
            ) {
                signalPayload.confidence =
                    clamp(
                        Number(
                            outcomeData.confidence
                        ),
                        0,
                        100
                    );
            }

            const signalId =
                this.recordSignal(
                    signalPayload
                );

            if (signalId === false) {
                pendingSignal =
                    this.findPendingLegacySignal({
                        pair,
                        strategy,
                        timeframe,
                        direction,
                        entry
                    });

                if (!pendingSignal) {
                    console.warn(
                        "Legacy outcome recording failed: signal could not be created."
                    );

                    return false;
                }
            } else {
                pendingSignal =
                    this.getSignalById(
                        signalId
                    );
            }
        }

        if (!pendingSignal) {
            return false;
        }

        const resolved =
            this.resolveSignal(
                pendingSignal.id,
                outcome,
                profitPoints
            );

        if (!resolved) {
            return false;
        }

        pendingSignal.openedAt =
            outcomeData.openedAt ||
            pendingSignal.timestamp ||
            null;

        pendingSignal.closedAt =
            outcomeData.closedAt ||
            pendingSignal.resolvedAt ||
            null;

        pendingSignal.closePrice =
            Number.isFinite(closePrice) &&
            closePrice > 0
                ? closePrice
                : outcome === "WIN" &&
                  Number.isFinite(takeProfit) &&
                  takeProfit > 0
                    ? takeProfit
                    : outcome === "LOSS" &&
                      Number.isFinite(stopLoss) &&
                      stopLoss > 0
                        ? stopLoss
                        : entry;

        pendingSignal.legacyConfidence =
            Number.isFinite(
                Number(outcomeData.confidence)
            )
                ? clamp(
                    Number(
                        outcomeData.confidence
                    ),
                    0,
                    100
                )
                : null;

        MemoryManager.updateTimestamp(this);

        return pendingSignal.id;
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
                        .profitFactor ?? null
            },

            updatedAt:
                new Date().toISOString(),

            metadata: {
                engine:
                    LearningConfig.ENGINE_NAME,

                version:
                    LearningConfig.VERSION
            }
        };

        return this.confidence;
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

            exportedAt:
                new Date().toISOString(),

            metadata: {
                engine:
                    LearningConfig.ENGINE_NAME,

                version:
                    LearningConfig.VERSION
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
        MemoryManager
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
