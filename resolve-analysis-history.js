// resolve-analysis-history.js
//
// PipSight Pro — Analysis History Trade Resolver.
//
// Phase 9 goals:
// - Resolve existing open history records against verified market candles.
// - Preserve the existing analysis-history.json schema.
// - Preserve legacy open / closed collections.
// - Preserve current records / history / items aliases.
// - Never modify trading strategy decisions.
// - Never invent missing prices, timestamps or outcomes.
// - Use deterministic processing and atomic JSON writes.
// - Remain duplicate-safe across repeated runs.
//
// Reads:
//   data/analysis-history.json
//   data/scalp-candles.json
//   data/intraday-h1.json
//   data/daily-ohlc.json
//
// Writes:
//   data/analysis-history.json
//
// Compatibility:
// - CommonJS / Node.js 20.
// - Existing Swing, Intraday, Scalp and Master logic remains unchanged.
// - Existing Telegram logic remains unchanged.
// - Existing Learning and AI Memory schemas remain unchanged.
// - Existing legacy history records remain supported.

"use strict";

const fs = require("fs");
const path = require("path");

// ============================================================================
// Engine metadata
// ============================================================================

const ENGINE_NAME = "PipSight Pro Analysis History Resolver";
const ENGINE_VERSION = "1.0.0";
const HISTORY_VERSION = 1;
const RECORD_CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

const MARKET_SOURCE_INTERVAL_MINUTES = Object.freeze({
  scalp: 5,
  intraday: 60,
  swing: 24 * 60
});

// ============================================================================
// Paths
// ============================================================================

const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, "data");
const ANALYSIS_HISTORY_PATH = path.join(DATA_DIR, "analysis-history.json");
const SCALP_CANDLES_PATH = path.join(DATA_DIR, "scalp-candles.json");
const INTRADAY_CANDLES_PATH = path.join(DATA_DIR, "intraday-h1.json");
const DAILY_CANDLES_PATH = path.join(DATA_DIR, "daily-ohlc.json");

// ============================================================================
// Supported values
// ============================================================================

const SUPPORTED_PAIRS = new Set(["XAUUSD", "GBPJPY"]);
const SUPPORTED_DIRECTIONS = new Set(["BUY", "SELL"]);
const RESOLVED_OUTCOMES = new Set(["WIN", "LOSS", "BREAKEVEN"]);
const OPEN_STATUSES = new Set(["open", "pending", "active"]);
const CLOSED_STATUSES = new Set(["closed", "resolved", "complete", "completed"]);

const ENGINE_ALIASES = Object.freeze({
  swing: "swing",
  weekly: "swing",
  intraday: "intraday",
  daily: "intraday",
  scalp: "scalp",
  "scalp-5m": "scalp",
  "scalp-15m": "scalp",
  "scalp-30m": "scalp",
  master: "master"
});

// ============================================================================
// Generic validation helpers
// ============================================================================

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function toFiniteNumber(value) {
  if (
    value === null ||
    value === undefined ||
    (typeof value === "string" && value.trim() === "")
  ) {
    return null;
  }

  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function toTrimmedString(value) {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value).trim();
}

function normalizeUpperString(value) {
  return toTrimmedString(value).toUpperCase();
}

function normalizeLowerString(value) {
  return toTrimmedString(value).toLowerCase();
}

function toTimestamp(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value < 100000000000 ? value * 1000 : value;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? null : date.getTime();
  }

  if (typeof value === "string") {
    const trimmed = value.trim();

    if (!trimmed) {
      return null;
    }

    const numeric = Number(trimmed);

    if (Number.isFinite(numeric)) {
      return toTimestamp(numeric);
    }

    let normalized = trimmed;

    /*
     * Market files use UTC timestamps but may omit an explicit timezone.
     * Normalize those exact date/time forms to UTC so resolution does not
     * depend on the host machine timezone.
     */
    if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
      normalized += "T00:00:00Z";
    } else {
      if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(normalized)) {
        normalized = normalized.replace(" ", "T");
      }

      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(normalized)) {
        normalized += "Z";
      }
    }

    const parsed = Date.parse(normalized);
    return Number.isNaN(parsed) ? null : parsed;
  }

  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

function toISOStringOrNull(value) {
  const timestamp = toTimestamp(value);

  if (timestamp === null) {
    return null;
  }

  return new Date(timestamp).toISOString();
}

function cloneJSONValue(value) {
  if (value === undefined) {
    return undefined;
  }
  return JSON.parse(JSON.stringify(value));
}

function ensureDirectory(directoryPath) {
  if (fs.existsSync(directoryPath)) {
    return;
  }

  fs.mkdirSync(directoryPath, { recursive: true });
}

// ============================================================================
// Safe JSON I/O
// ============================================================================

function readJSON(filePath, options = {}) {
  const required = options.required === true;
  const fallbackValue = options.fallbackValue === undefined ? null : options.fallbackValue;

  if (!fs.existsSync(filePath)) {
    if (required) {
      throw new Error(
        `Required file does not exist: ${path.relative(ROOT_DIR, filePath)}`
      );
    }
    return fallbackValue;
  }

  const raw = fs.readFileSync(filePath, "utf8");

  if (!raw.trim()) {
    if (required) {
      throw new Error(
        `Required file is empty: ${path.relative(ROOT_DIR, filePath)}`
      );
    }
    return fallbackValue;
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid JSON in ${path.relative(ROOT_DIR, filePath)}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

function atomicWriteJSON(filePath, data) {
  ensureDirectory(path.dirname(filePath));

  const tempPath = filePath + ".tmp";
  const backupPath = filePath + ".bak";

  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), "utf8");

  if (fs.existsSync(filePath)) {
    fs.copyFileSync(filePath, backupPath);
  }

  fs.renameSync(tempPath, filePath);
}

// ============================================================================
// History loading and initialization
// ============================================================================

function normalizeStatus(status, outcome) {
  const normalized = normalizeLowerString(status);

  if (CLOSED_STATUSES.has(normalized)) {
    return "closed";
  }
  if (OPEN_STATUSES.has(normalized)) {
    return "open";
  }

  return outcome ? "closed" : "open";
}

function getRecordOutcome(record) {
  if (!isPlainObject(record)) {
    return null;
  }

  const outcome = normalizeUpperString(record.outcome);
  return RESOLVED_OUTCOMES.has(outcome) ? outcome : null;
}

function loadAnalysisHistory() {
  return readJSON(ANALYSIS_HISTORY_PATH, {
    required: true,
    fallbackValue: {
      version: HISTORY_VERSION,
      records: [],
      history: [],
      items: [],
      open: {},
      closed: [],
      updatedAt: new Date().toISOString()
    }
  });
}

// ============================================================================
// Market data loading
// ============================================================================

function normalizeCandle(candle, source) {
  if (!isPlainObject(candle)) {
    return null;
  }

  const timestamp = toTimestamp(candle.timestamp || candle.time);
  if (!timestamp) {
    return null;
  }

  const open = toFiniteNumber(candle.open || candle.o);
  const high = toFiniteNumber(candle.high || candle.h);
  const low = toFiniteNumber(candle.low || candle.l);
  const close = toFiniteNumber(candle.close || candle.c);

  if (open === null || high === null || low === null || close === null) {
    return null;
  }

  return {
    timestamp,
    open,
    high,
    low,
    close,
    source: normalizeLowerString(source)
  };
}

function normalizeCandles(candles, source) {
  return asArray(candles)
    .map(candle => normalizeCandle(candle, source))
    .filter(candle => candle !== null);
}

function loadMarketDocuments() {
  const scalp = normalizeCandles(
    readJSON(SCALP_CANDLES_PATH, { fallbackValue: [] }),
    "scalp"
  );

  const intraday = normalizeCandles(
    readJSON(INTRADAY_CANDLES_PATH, { fallbackValue: [] }),
    "intraday"
  );

  const daily = normalizeCandles(
    readJSON(DAILY_CANDLES_PATH, { fallbackValue: [] }),
    "swing"
  );

  return { scalp, intraday, daily };
}

function buildMarketDataIndex(marketDocuments) {
  const index = {};

  for (const candle of marketDocuments.scalp || []) {
    const key = `scalp:${candle.timestamp}`;
    index[key] = candle;
  }

  for (const candle of marketDocuments.intraday || []) {
    const key = `intraday:${candle.timestamp}`;
    index[key] = candle;
  }

  for (const candle of marketDocuments.daily || []) {
    const key = `swing:${candle.timestamp}`;
    index[key] = candle;
  }

  return index;
}

// ============================================================================
// Trade validation and evaluation
// ============================================================================

function validateTradeGeometry(record) {
  if (!isPlainObject(record)) {
    return { valid: false };
  }

  const entry = toFiniteNumber(record.entry || record.entryPrice);
  const stop = toFiniteNumber(record.stop || record.stopLoss);
  const target = toFiniteNumber(record.target || record.takeProfit);

  if (entry === null || stop === null || target === null) {
    return { valid: false };
  }

  const direction = normalizeUpperString(record.direction || record.side);
  if (!SUPPORTED_DIRECTIONS.has(direction)) {
    return { valid: false };
  }

  return { valid: true, entry, stop, target, direction };
}

function candleTouchesStop(candle, trade) {
  if (!candle || !trade) {
    return false;
  }

  const { direction, stop } = trade;
  if (direction === "BUY") {
    return candle.low <= stop;
  }
  if (direction === "SELL") {
    return candle.high >= stop;
  }

  return false;
}

function candleTouchesTarget(candle, trade) {
  if (!candle || !trade) {
    return false;
  }

  const { direction, target } = trade;
  if (direction === "BUY") {
    return candle.high >= target;
  }
  if (direction === "SELL") {
    return candle.low <= target;
  }

  return false;
}

function getHighestTargetReached(candles, trade) {
  if (!Array.isArray(candles) || !trade) {
    return null;
  }

  let highestReached = 0;

  for (const candle of candles) {
    if (!candle) {
      continue;
    }

    if (trade.direction === "BUY" && candle.high >= trade.target) {
      return trade.target;
    }
    if (trade.direction === "SELL" && candle.low <= trade.target) {
      return trade.target;
    }

    if (trade.direction === "BUY") {
      const reachedPct =
        ((candle.high - trade.entry) / (trade.target - trade.entry)) * 100;
      if (reachedPct > highestReached) {
        highestReached = Math.min(reachedPct, 99.99);
      }
    }
    if (trade.direction === "SELL") {
      const reachedPct =
        ((trade.entry - candle.low) / (trade.entry - trade.target)) * 100;
      if (reachedPct > highestReached) {
        highestReached = Math.min(reachedPct, 99.99);
      }
    }
  }

  return highestReached > 0 ? highestReached : null;
}

function evaluateCandleAgainstTrade(candle, trade) {
  if (candleTouchesStop(candle, trade)) {
    return { outcome: "LOSS", reason: "Hit stop loss" };
  }
  if (candleTouchesTarget(candle, trade)) {
    return { outcome: "WIN", reason: "Hit target" };
  }

  return { outcome: null, reason: null };
}

// ============================================================================
// Record preparation and evaluation
// ============================================================================

function prepareRecordForResolution(record) {
  if (!isPlainObject(record)) {
    return null;
  }

  const timestamp = toTimestamp(record.createdAt || record.openedAt);
  const geometry = validateTradeGeometry(record);

  if (!geometry.valid || !timestamp) {
    return null;
  }

  return {
    record,
    timestamp,
    geometry
  };
}

function evaluatePreparedTrade(prepared, candlesBySource) {
  if (!prepared || !candlesBySource) {
    return { outcome: null };
  }

  const { record, timestamp, geometry } = prepared;
  const source = normalizeUpperString(record.engine || record.source || "");
  const engine = ENGINE_ALIASES[source] || source;

  const tolerance = RECORD_CLOCK_SKEW_TOLERANCE_MS;
  const relevantCandles = (candlesBySource[engine] || []).filter(
    candle => Math.abs(candle.timestamp - timestamp) < tolerance
  );

  for (const candle of relevantCandles) {
    const evaluation = evaluateCandleAgainstTrade(candle, geometry);
    if (evaluation.outcome) {
      return evaluation;
    }
  }

  return { outcome: null };
}

function evaluateHistoryRecord(record, marketDataIndex) {
  const prepared = prepareRecordForResolution(record);
  if (!prepared) {
    return null;
  }

  const candlesBySource = {};
  for (const key of Object.keys(marketDataIndex)) {
    const [source] = key.split(":");
    if (!candlesBySource[source]) {
      candlesBySource[source] = [];
    }
    candlesBySource[source].push(marketDataIndex[key]);
  }

  return evaluatePreparedTrade(prepared, candlesBySource);
}

// ============================================================================
// Trade resolution
// ============================================================================

function applyResolutionToRichRecord(record, evaluation) {
  const modified = cloneJSONValue(record);

  if (!evaluation || !evaluation.outcome) {
    return { modified, changed: false };
  }

  const hadOutcome = getRecordOutcome(record) !== null;
  if (hadOutcome) {
    return { modified, changed: false };
  }

  modified.outcome = evaluation.outcome;
  modified.status = "closed";
  modified.resolvedAt = new Date().toISOString();

  return { modified, changed: true };
}

function createLegacyClosedTrade(record, evaluation) {
  return {
    id: record.id || String(Date.now()),
    pair: record.pair || "UNKNOWN",
    direction: record.direction || record.side || "UNKNOWN",
    entry: toFiniteNumber(record.entry || record.entryPrice),
    stop: toFiniteNumber(record.stop || record.stopLoss),
    target: toFiniteNumber(record.target || record.takeProfit),
    outcome: evaluation.outcome,
    status: "closed",
    openedAt: toISOStringOrNull(record.createdAt || record.openedAt),
    closedAt: new Date().toISOString(),
    engine: record.engine || record.source || "unknown"
  };
}

function applyResolvedTradeToHistory(history, record, evaluation) {
  const modified = cloneJSONValue(history);
  const applied = applyResolutionToRichRecord(record, evaluation);

  if (!applied.changed) {
    return { modified, changed: false };
  }

  const recordIndex = modified.records.findIndex(r => r.id === record.id);
  if (recordIndex >= 0) {
    modified.records[recordIndex] = applied.modified;
    if (Array.isArray(modified.history) && modified.history[recordIndex]) {
      modified.history[recordIndex] = applied.modified;
    }
    if (Array.isArray(modified.items) && modified.items[recordIndex]) {
      modified.items[recordIndex] = applied.modified;
    }
  }

  const legacyClosed = createLegacyClosedTrade(applied.modified, evaluation);
  modified.closed = Array.isArray(modified.closed) ? modified.closed : [];
  modified.closed.push(legacyClosed);

  modified.updatedAt = new Date().toISOString();

  return { modified, changed: true };
}

function resolveAnalysisHistory(history, marketDataIndex) {
  const results = [];
  let changed = false;
  let currentHistory = cloneJSONValue(history);

  const records = Array.isArray(currentHistory.records)
    ? currentHistory.records
    : [];

  for (const record of records) {
    if (!isPlainObject(record)) {
      continue;
    }

    const hasOutcome = getRecordOutcome(record) !== null;
    if (hasOutcome) {
      continue;
    }

    const status = normalizeStatus(record.status, null);
    if (status === "closed") {
      continue;
    }

    const evaluation = evaluateHistoryRecord(record, marketDataIndex);

    const application = applyResolvedTradeToHistory(
      currentHistory,
      record,
      evaluation
    );

    if (application.changed) {
      currentHistory = application.modified;
      changed = true;
    }

    results.push({
      recordId: record.id,
      outcome: evaluation?.outcome || null,
      changed: application.changed
    });
  }

  const legacyOpenInventory = buildOpenTradeInventory(currentHistory);

  return {
    history: currentHistory,
    changed,
    results,
    summary: {
      totalEvaluated: records.length,
      totalResolved: results.filter(r => r.outcome !== null).length,
      finalLegacyClosedCount: Array.isArray(currentHistory.closed)
        ? currentHistory.closed.length
        : 0,
      finalLegacyOpenCount: legacyOpenInventory.legacyOpenCount
    },
    legacyOpenIntegrity: legacyOpenInventory
  };
}

function buildOpenTradeInventory(history) {
  const open = history.open || {};
  let legacyOpenCount = 0;

  if (isPlainObject(open)) {
    for (const engine of Object.keys(ENGINE_ALIASES)) {
      const trades = open[engine];
      if (Array.isArray(trades)) {
        legacyOpenCount += trades.length;
      }
    }
  }

  return {
    legacyOpenCount,
    open
  };
}

// ============================================================================
// Logging
// ============================================================================

function logResolverHeader() {
  console.log("");
  console.log(
    "============================================================"
  );
  console.log(`[trade-resolver] ${ENGINE_NAME} v${ENGINE_VERSION}`);
  console.log(
    "============================================================"
  );
  console.log("");
  console.log(`Started: ${new Date().toISOString()}`);
  console.log("");
}

function logMarketDataSummary(marketDocuments, marketDataIndex) {
  console.log("[trade-resolver] Market data loaded:");
  console.log(
    `  Scalp (5m): ${(marketDocuments.scalp || []).length} candles`
  );
  console.log(
    `  Intraday (H1): ${(marketDocuments.intraday || []).length} candles`
  );
  console.log(
    `  Daily (D1): ${(marketDocuments.daily || []).length} candles`
  );
  console.log(`  Total indexed: ${Object.keys(marketDataIndex).length} candles`);
  console.log("");
}

function logResolutionResult(result) {
  const status = result.changed ? "RESOLVED" : "PENDING";
  const outcome = result.outcome || "UNRESOLVED";
  console.log(
    `[trade-resolver] ${status}: ${result.recordId} → ${outcome}`
  );
}

function logLegacyOpenIntegrity(legacyOpenIntegrity) {
  console.log("");
  console.log("[trade-resolver] Legacy open inventory:");
  console.log(`  Total legacy open trades: ${legacyOpenIntegrity.legacyOpenCount}`);
  console.log("");
}

function logRunSummary(summary, { changed, written }) {
  console.log("[trade-resolver] Summary:");
  console.log(`  Total records evaluated: ${summary.totalEvaluated}`);
  console.log(`  Total trades resolved: ${summary.totalResolved}`);
  console.log(`  Final legacy closed: ${summary.finalLegacyClosedCount}`);
  console.log(`  History changed: ${changed ? "YES" : "NO"}`);
  console.log(`  History written: ${written ? "YES" : "NO"}`);
  console.log("");
  console.log(`Completed: ${new Date().toISOString()}`);
  console.log(
    "============================================================"
  );
  console.log("");
}

// ============================================================================
// Final history validation
// ============================================================================

function validateResolvedHistory(history) {
  const errors = [];

  if (!isPlainObject(history)) {
    return {
      valid: false,
      errors: ["Resolved history must be an object"]
    };
  }

  if (!Array.isArray(history.records)) {
    errors.push("history.records must be an array");
  }

  if (!Array.isArray(history.history)) {
    errors.push("history.history must be an array");
  }

  if (!Array.isArray(history.items)) {
    errors.push("history.items must be an array");
  }

  if (!Array.isArray(history.closed)) {
    errors.push("history.closed must be an array");
  }

  if (!isPlainObject(history.open)) {
    errors.push("history.open must be an object");
  }

  if (
    Array.isArray(history.records) &&
    Array.isArray(history.history) &&
    history.records.length !== history.history.length
  ) {
    errors.push("records and history aliases are not synchronized");
  }

  if (
    Array.isArray(history.records) &&
    Array.isArray(history.items) &&
    history.records.length !== history.items.length
  ) {
    errors.push("records and items aliases are not synchronized");
  }

  const records = Array.isArray(history.records) ? history.records : [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];

    if (!isPlainObject(record)) {
      errors.push(`records[${index}] is not an object`);
      continue;
    }

    const outcome = getRecordOutcome(record);

    if (!outcome) {
      continue;
    }

    const status = normalizeStatus(record.status, outcome);
    const resolvedAt = toISOStringOrNull(
      record.resolvedAt ?? record.closedAt
    );

    if (status !== "closed") {
      errors.push(
        `records[${index}] has an outcome but is not closed`
      );
    }

    if (!resolvedAt) {
      errors.push(
        `records[${index}] has an outcome but no resolvedAt/closedAt`
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

// ============================================================================
// Safe persistence
// ============================================================================

function saveResolvedHistory(history) {
  const validation = validateResolvedHistory(history);

  if (validation.valid !== true) {
    throw new Error(
      ["Resolved history validation failed", ...validation.errors].join("; ")
    );
  }

  atomicWriteJSON(ANALYSIS_HISTORY_PATH, history);

  return {
    path: ANALYSIS_HISTORY_PATH,
    recordCount: history.records.length,
    closedCount: history.closed.length,
    updatedAt: history.updatedAt || null
  };
}

// ============================================================================
// Resolver orchestration
// ============================================================================

function runTradeResolution() {
  logResolverHeader();

  const loadedHistory = loadAnalysisHistory();

  console.log(
    `[trade-resolver] Loaded ${loadedHistory.records.length} rich history records.`
  );

  console.log(
    `[trade-resolver] Loaded ${loadedHistory.closed.length} legacy closed trades.`
  );

  const loadedOpenInventory = buildOpenTradeInventory(loadedHistory);

  console.log(
    `[trade-resolver] Current legacy open count: ${loadedOpenInventory.legacyOpenCount}`
  );

  console.log("");

  const marketDocuments = loadMarketDocuments();

  const marketDataIndex = buildMarketDataIndex(marketDocuments);

  logMarketDataSummary(marketDocuments, marketDataIndex);

  const resolutionRun = resolveAnalysisHistory(loadedHistory, marketDataIndex);

  for (const result of resolutionRun.results) {
    logResolutionResult(result);
  }

  logLegacyOpenIntegrity(resolutionRun.legacyOpenIntegrity);

  let persistence = null;

  if (resolutionRun.changed === true) {
    persistence = saveResolvedHistory(resolutionRun.history);

    console.log("");

    console.log(
      `[trade-resolver] Updated history written atomically to ${persistence.path}.`
    );
  } else {
    console.log("");

    console.log(
      "[trade-resolver] No trades resolved; analysis-history.json was not rewritten."
    );
  }

  logRunSummary(resolutionRun.summary, {
    changed: resolutionRun.changed,
    written: Boolean(persistence)
  });

  return {
    success: true,
    changed: resolutionRun.changed,
    written: Boolean(persistence),
    output: persistence,
    summary: resolutionRun.summary,
    legacyOpenIntegrity: resolutionRun.legacyOpenIntegrity,
    results: resolutionRun.results
  };
}

// ============================================================================
// Command-line execution
// ============================================================================

function main() {
  try {
    const result = runTradeResolution();

    if (result.success !== true) {
      process.exitCode = 1;
    }

    return result;
  } catch (error) {
    console.error("");
    console.error(
      "============================================================"
    );
    console.error("[trade-resolver] FATAL ERROR");
    console.error(
      error instanceof Error ? error.stack || error.message : String(error)
    );
    console.error(
      "============================================================"
    );
    console.error("");

    process.exitCode = 1;

    return {
      success: false,
      changed: false,
      written: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

if (require.main === module) {
  main();
}

// ============================================================================
// Public exports
// ============================================================================

module.exports = {
  ENGINE_NAME,
  ENGINE_VERSION,
  RESOLUTION_POLICY,

  loadAnalysisHistory,
  loadMarketDocuments,
  buildMarketDataIndex,

  normalizeCandle,
  normalizeCandles,

  validateTradeGeometry,
  candleTouchesStop,
  candleTouchesTarget,
  getHighestTargetReached,
  evaluateCandleAgainstTrade,

  prepareRecordForResolution,
  evaluatePreparedTrade,
  evaluateHistoryRecord,

  applyResolutionToRichRecord,
  createLegacyClosedTrade,
  applyResolvedTradeToHistory,
  resolveAnalysisHistory,

  validateResolvedHistory,
  saveResolvedHistory,
  runTradeResolution,
  main
};
