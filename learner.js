/* =====================================================================
   PipSight Pro AI v2
   MODULE 1 : Learning Configuration Engine
   Version : 2.0.0
   ===================================================================== */

class LearningConfig {

    static VERSION = "2.0.0";

    static ENGINE_NAME = "PipSight Pro AI";

    static DEBUG = false;

    static MAX_HISTORY = 5000;

    static AUTO_BACKUP = true;

    static AUTO_REPAIR = true;

    static DUPLICATE_CHECK = true;

    static AUTO_UPDATE_STATS = true;

    static MIN_SIGNALS_FOR_LEARNING = 20;

    static MIN_SIGNALS_FOR_CONFIDENCE = 30;

    static PERFORMANCE_WINDOW = 20;

    static MAX_CONFIDENCE = 95;

    static MIN_CONFIDENCE = 50;

    static DEFAULT_CONFIDENCE = 60;

    static SUPPORTED_RESULTS = [
        "WIN",
        "LOSS",
        "BREAKEVEN"
    ];

    static SUPPORTED_STRATEGIES = [
        "scalp",
        "daily",
        "weekly"
    ];

    static SUPPORTED_PAIRS = [
        "XAUUSD",
        "GBPJPY"
    ];

    static SUPPORTED_TIMEFRAMES = [
        "5m",
        "15m",
        "30m",
        "1H",
        "4H",
        "D1"
    ];

    static SUPPORTED_INDICATORS = [
        "EMA",
        "RSI",
        "MACD",
        "Support/Resistance",
        "News"
    ];

    static REQUIRED_SIGNAL_FIELDS = [

        "pair",

        "strategy",

        "timeframe",

        "entry"

    ];

    static PERFORMANCE_STATUS = {

        IMPROVING : "improving",

        STABLE : "stable",

        DECLINING : "declining",

        UNKNOWN : "insufficient-data"

    };

}

Object.freeze(LearningConfig);

/* =====================================================================
   PipSight Pro AI v2
   MODULE 2 : Signal Validator Engine
   Version : 2.0.0
   ===================================================================== */

class SignalValidator {

    static validate(signal) {

        const errors = [];

        if (!signal || typeof signal !== "object") {
            return {
                valid: false,
                errors: ["Signal is missing."]
            };
        }

        // Required Fields
        for (const field of LearningConfig.REQUIRED_SIGNAL_FIELDS) {

            if (
                signal[field] === undefined ||
                signal[field] === null ||
                signal[field] === ""
            ) {
                errors.push(`Missing required field: ${field}`);
            }

        }

        // Pair Validation
        if (
            signal.pair &&
            !LearningConfig.SUPPORTED_PAIRS.includes(signal.pair)
        ) {
            errors.push(`Unsupported pair: ${signal.pair}`);
        }

        // Strategy Validation
        if (
            signal.strategy &&
            !LearningConfig.SUPPORTED_STRATEGIES.includes(signal.strategy)
        ) {
            errors.push(`Unsupported strategy: ${signal.strategy}`);
        }

        // Timeframe Validation
        if (
            signal.timeframe &&
            !LearningConfig.SUPPORTED_TIMEFRAMES.includes(signal.timeframe)
        ) {
            errors.push(`Unsupported timeframe: ${signal.timeframe}`);
        }

        // Entry Validation
        if (
            signal.entry !== undefined &&
            (
                typeof signal.entry !== "number" ||
                isNaN(signal.entry) ||
                signal.entry <= 0
            )
        ) {
            errors.push("Invalid entry price.");
        }

        // Stop Loss Validation
        if (
            signal.stopLoss !== undefined &&
            (
                typeof signal.stopLoss !== "number" ||
                isNaN(signal.stopLoss)
            )
        ) {
            errors.push("Invalid Stop Loss.");
        }

        // Take Profit Validation
        if (
            signal.takeProfit !== undefined &&
            (
                typeof signal.takeProfit !== "number" ||
                isNaN(signal.takeProfit)
            )
        ) {
            errors.push("Invalid Take Profit.");
        }

        // Confidence Validation
        if (signal.confidence !== undefined) {

            if (
                typeof signal.confidence !== "number" ||
                signal.confidence < 0 ||
                signal.confidence > 100
            ) {
                errors.push("Confidence must be between 0 and 100.");
            }

        }

        // Indicator Validation
        if (
            signal.indicators &&
            !Array.isArray(signal.indicators)
        ) {
            errors.push("Indicators must be an array.");
        }

        // Direction Validation
        if (
            signal.direction &&
            !["BUY","SELL","HOLD"].includes(signal.direction)
        ) {
            errors.push("Invalid signal direction.");
        }

        return {

            valid: errors.length === 0,

            errors

        };

    }

    static isDuplicate(signal, signalList = []) {

        if (!LearningConfig.DUPLICATE_CHECK) {
            return false;
        }

        return signalList.some(existing => {

            return (

                existing.pair === signal.pair &&

                existing.strategy === signal.strategy &&

                existing.timeframe === signal.timeframe &&

                existing.entry === signal.entry &&

                existing.direction === signal.direction

            );

        });

    }

}

/**
 * PipSight Learning Engine
 * Self-learning AI system for signal outcome tracking and accuracy improvement
 * Integrates with existing PipSight infrastructure
 */

class PipSightLearner {
  constructor() {
    this.dataPath = 'pipsight-learning.json';
    this.confidencePath = 'pipsight-confidence.json';
    this.data = {
      signals: [],
      outcomes: [],
      stats: {},
      updatedAt: new Date().toISOString()
    };
    this.confidence = {
      strategies: {},
      indicators: {},
      pairs: {},
      timeframes: {},
      updatedAt: new Date().toISOString()
    };
  }

  /**
 * Record a new signal for learning
 * @param {Object} signal - Signal object with pair, timeframe, strategy, entry, etc.
 */
recordSignal(signal) {

    // -----------------------------
    // Professional Validation Layer
    // -----------------------------
    const validation = SignalValidator.validate(signal);

    if (!validation.valid) {
        console.warn("Signal validation failed:", validation.errors);
        return false;
    }

    // -----------------------------
    // Duplicate Protection
    // -----------------------------
    if (SignalValidator.isDuplicate(signal, this.data.signals)) {
        console.warn("Duplicate signal ignored.");
        return false;
    }

    // -----------------------------
    // Legacy Validation (Backward Compatibility)
    // -----------------------------
    if (!signal.pair || !signal.timeframe || !signal.strategy) {
        console.warn("Invalid signal structure");
        return false;
    }

    // -----------------------------
    // Record Signal
    // -----------------------------
    const recordedSignal = {
        id: this.generateId(),
        ...signal,
        timestamp: new Date().toISOString(),
        outcome: null,
        profitPoints: null,
        resultPercentage: null
    };

    this.data.signals.push(recordedSignal);

    // Keep only latest history
    if (this.data.signals.length > LearningConfig.MAX_HISTORY) {
        this.data.signals = this.data.signals.slice(-LearningConfig.MAX_HISTORY);
    }

    this.data.updatedAt = new Date().toISOString();

    return recordedSignal.id;
}

  /**
   * Resolve a signal with outcome (WIN/LOSS)
   * @param {String} signalId - Signal ID to resolve
   * @param {String} outcome - 'WIN' or 'LOSS'
   * @param {Number} profitPoints - Profit/Loss in pips
   */
  resolveSignal(signalId, outcome, profitPoints = 0) {
    const signal = this.data.signals.find(s => s.id === signalId);
    
    if (!signal) {
      console.warn('Signal not found:', signalId);
      return false;
    }

    signal.outcome = outcome; // WIN or LOSS
    signal.profitPoints = profitPoints;
    signal.resultPercentage = profitPoints > 0 ? (profitPoints / Math.abs(signal.entry || 1)) * 100 : -1;
    signal.resolvedAt = new Date().toISOString();

    this.data.outcomes.push({
      signalId,
      outcome,
      profitPoints,
      timestamp: new Date().toISOString()
    });

    this.updateStats();
    return true;
  }

  /**
   * Update statistics based on all signals
   */
  updateStats() {
    const stats = {
      totalSignals: this.data.signals.length,
      resolvedSignals: this.data.signals.filter(s => s.outcome).length,
      wins: this.data.signals.filter(s => s.outcome === 'WIN').length,
      losses: this.data.signals.filter(s => s.outcome === 'LOSS').length,
      pending: this.data.signals.filter(s => !s.outcome).length,
      winRate: 0,
      avgProfitPoints: 0,
      totalProfitPoints: 0,
      strategies: {},
      indicators: {},
      pairs: {},
      timeframes: {}
    };

    // Overall stats
    if (stats.resolvedSignals > 0) {
      stats.winRate = (stats.wins / stats.resolvedSignals) * 100;
    }

    const profitSignals = this.data.signals.filter(s => s.profitPoints !== null);
    if (profitSignals.length > 0) {
      stats.totalProfitPoints = profitSignals.reduce((sum, s) => sum + s.profitPoints, 0);
      stats.avgProfitPoints = stats.totalProfitPoints / profitSignals.length;
    }

    // Strategy stats
    for (const strategy of ['scalp', 'daily', 'weekly']) {
      const strategySignals = this.data.signals.filter(s => s.strategy === strategy);
      const strategyOutcomes = strategySignals.filter(s => s.outcome);
      
      if (strategyOutcomes.length > 0) {
        stats.strategies[strategy] = {
          total: strategySignals.length,
          resolved: strategyOutcomes.length,
          wins: strategyOutcomes.filter(s => s.outcome === 'WIN').length,
          losses: strategyOutcomes.filter(s => s.outcome === 'LOSS').length,
          winRate: (strategyOutcomes.filter(s => s.outcome === 'WIN').length / strategyOutcomes.length) * 100,
          confidence: this.calculateConfidence(strategy, null, null)
        };
      }
    }

    // Indicator stats
    for (const indicator of ['EMA', 'RSI', 'MACD', 'Support/Resistance', 'News']) {
      const indicatorSignals = this.data.signals.filter(s => 
        s.indicators && s.indicators.includes(indicator)
      );
      const indicatorOutcomes = indicatorSignals.filter(s => s.outcome);
      
      if (indicatorOutcomes.length > 0) {
        stats.indicators[indicator] = {
          total: indicatorSignals.length,
          resolved: indicatorOutcomes.length,
          wins: indicatorOutcomes.filter(s => s.outcome === 'WIN').length,
          losses: indicatorOutcomes.filter(s => s.outcome === 'LOSS').length,
          winRate: (indicatorOutcomes.filter(s => s.outcome === 'WIN').length / indicatorOutcomes.length) * 100,
          confidence: this.calculateConfidence(null, indicator, null)
        };
      }
    }

    // Pair stats
    for (const pair of ['XAUUSD', 'GBPJPY']) {
      const pairSignals = this.data.signals.filter(s => s.pair === pair);
      const pairOutcomes = pairSignals.filter(s => s.outcome);
      
      if (pairOutcomes.length > 0) {
        stats.pairs[pair] = {
          total: pairSignals.length,
          resolved: pairOutcomes.length,
          wins: pairOutcomes.filter(s => s.outcome === 'WIN').length,
          losses: pairOutcomes.filter(s => s.outcome === 'LOSS').length,
          winRate: (pairOutcomes.filter(s => s.outcome === 'WIN').length / pairOutcomes.length) * 100,
          confidence: this.calculateConfidence(null, null, pair)
        };
      }
    }

    // Timeframe stats
    for (const tf of ['5m', '15m', '30m', '1H', '4H', 'D1']) {
      const tfSignals = this.data.signals.filter(s => s.timeframe === tf);
      const tfOutcomes = tfSignals.filter(s => s.outcome);
      
      if (tfOutcomes.length > 0) {
        stats.timeframes[tf] = {
          total: tfSignals.length,
          resolved: tfOutcomes.length,
          wins: tfOutcomes.filter(s => s.outcome === 'WIN').length,
          losses: tfOutcomes.filter(s => s.outcome === 'LOSS').length,
          winRate: (tfOutcomes.filter(s => s.outcome === 'WIN').length / tfOutcomes.length) * 100,
          confidence: this.calculateConfidence(null, null, null, tf)
        };
      }
    }

    this.data.stats = stats;
    return stats;
  }

  /**
   * Calculate confidence for strategy/indicator/pair/timeframe
   */
  calculateConfidence(strategy = null, indicator = null, pair = null, timeframe = null) {
    const signals = this.data.signals.filter(s => {
      if (strategy && s.strategy !== strategy) return false;
      if (indicator && (!s.indicators || !s.indicators.includes(indicator))) return false;
      if (pair && s.pair !== pair) return false;
      if (timeframe && s.timeframe !== timeframe) return false;
      return true;
    });

    const outcomes = signals.filter(s => s.outcome);
    
    if (outcomes.length === 0) return 60; // Default confidence
    
    const winRate = (outcomes.filter(s => s.outcome === 'WIN').length / outcomes.length) * 100;
    
    // Confidence based on sample size and win rate
    let confidence = winRate;
    
    // Boost for large sample size
    if (outcomes.length > 50) confidence = Math.min(90, confidence + 5);
    if (outcomes.length > 100) confidence = Math.min(92, confidence + 3);
    
    // Penalty for small sample size
    if (outcomes.length < 10) confidence = Math.max(50, confidence - 10);
    
    // Trend detection
    const recent10 = outcomes.slice(-10);
    const recentWins = recent10.filter(s => s.outcome === 'WIN').length;
    const recentRate = (recentWins / recent10.length) * 100;
    
    if (recentRate > winRate + 15) {
      confidence = Math.min(95, confidence + 3); // Improving trend
    } else if (recentRate < winRate - 15) {
      confidence = Math.max(50, confidence - 3); // Declining trend
    }
    
    return Math.round(confidence);
  }

  /**
   * Get detailed statistics
   */
  getStats() {
    return this.data.stats;
  }

  /**
   * Get all confidence data
   */
  getConfidenceData() {
    const confidence = {
      strategies: {},
      indicators: {},
      pairs: {},
      timeframes: {},
      overall: {
        totalSignals: this.data.signals.length,
        winRate: this.data.stats.winRate || 0,
        avgProfitPoints: this.data.stats.avgProfitPoints || 0
      },
      updatedAt: new Date().toISOString()
    };

    // Populate all confidence values
    for (const strategy in this.data.stats.strategies) {
      confidence.strategies[strategy] = this.data.stats.strategies[strategy];
    }

    for (const indicator in this.data.stats.indicators) {
      confidence.indicators[indicator] = this.data.stats.indicators[indicator];
    }

    for (const pair in this.data.stats.pairs) {
      confidence.pairs[pair] = this.data.stats.pairs[pair];
    }

    for (const tf in this.data.stats.timeframes) {
      confidence.timeframes[tf] = this.data.stats.timeframes[tf];
    }

    this.confidence = confidence;
    return confidence;
  }

  /**
   * Get best performing strategy
   */
  getBestStrategy() {
    const strategies = this.data.stats.strategies || {};
    let best = null;
    let bestRate = 0;

    for (const strategy in strategies) {
      if (strategies[strategy].winRate > bestRate) {
        bestRate = strategies[strategy].winRate;
        best = strategy;
      }
    }

    return { strategy: best, winRate: bestRate };
  }

  /**
   * Get best performing indicator
   */
  getBestIndicator() {
    const indicators = this.data.stats.indicators || {};
    let best = null;
    let bestRate = 0;

    for (const indicator in indicators) {
      if (indicators[indicator].winRate > bestRate) {
        bestRate = indicators[indicator].winRate;
        best = indicator;
      }
    }

    return { indicator: best, winRate: bestRate };
  }

  /**
   * Get performance trend (improving/declining/stable)
   */
  getPerformanceTrend() {
    if (this.data.signals.length < 20) return 'insufficient-data';

    const recent = this.data.signals.slice(-20).filter(s => s.outcome);
    const older = this.data.signals.slice(-40, -20).filter(s => s.outcome);

    if (older.length === 0) return 'insufficient-data';

    const recentWinRate = (recent.filter(s => s.outcome === 'WIN').length / recent.length) * 100;
    const olderWinRate = (older.filter(s => s.outcome === 'WIN').length / older.length) * 100;

    const diff = recentWinRate - olderWinRate;

    if (diff > 10) return 'improving';
    if (diff < -10) return 'declining';
    return 'stable';
  }

  /**
   * Get recommendation based on learning
   */
  getRecommendation() {
    const bestStrategy = this.getBestStrategy();
    const bestIndicator = this.getBestIndicator();
    const trend = this.getPerformanceTrend();

    return {
      bestStrategy: bestStrategy.strategy,
      bestStrategyRate: bestStrategy.winRate,
      bestIndicator: bestIndicator.indicator,
      bestIndicatorRate: bestIndicator.winRate,
      trend,
      recommendation: this.generateRecommendation(bestStrategy, bestIndicator, trend)
    };
  }

  /**
   * Generate trading recommendation based on learning
   */
  generateRecommendation(bestStrategy, bestIndicator, trend) {
    let recommendation = [];

    if (bestStrategy.strategy) {
      recommendation.push(`Focus on ${bestStrategy.strategy} strategy (${bestStrategy.winRate.toFixed(1)}% win rate)`);
    }

    if (bestIndicator.indicator) {
      recommendation.push(`${bestIndicator.indicator} is most reliable (${bestIndicator.winRate.toFixed(1)}% accuracy)`);
    }

    if (trend === 'improving') {
      recommendation.push('Performance is improving - increase position size');
    } else if (trend === 'declining') {
      recommendation.push('Performance is declining - reduce position size and review strategy');
    }

    if (this.data.stats.winRate < 50) {
      recommendation.push('⚠️ Overall win rate below 50% - review all signals carefully');
    } else if (this.data.stats.winRate > 65) {
      recommendation.push('✅ Strong performance - continue current approach');
    }

    return recommendation.length > 0 ? recommendation : ['Insufficient data for recommendation'];
  }

  /**
   * Reset all learning data (DANGER - use carefully)
   */
  resetLearning() {
    this.data = {
      signals: [],
      outcomes: [],
      stats: {},
      updatedAt: new Date().toISOString()
    };
    return true;
  }

  /**
   * Helper: Generate unique ID
   */
  generateId() {
    return `signal_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Export data for backup
   */
  exportData() {
    return {
      learning: this.data,
      confidence: this.confidence,
      exportedAt: new Date().toISOString()
    };
  }

  /**
   * Import data from backup
   */
  importData(data) {
    if (data.learning) {
      this.data = data.learning;
    }
    if (data.confidence) {
      this.confidence = data.confidence;
    }
    return true;
  }
}

// Export for Node.js environment
if (typeof module !== 'undefined' && module.exports) {
  module.exports = PipSightLearner;
}

// Export for browser environment
if (typeof window !== 'undefined') {
  window.PipSightLearner = PipSightLearner;
}
