"use strict";

/**
 * fetch-intraday-h1.js
 *
 * Fetches validated, fully closed 1-hour OHLC history for:
 *   - XAU/USD
 *   - GBP/JPY
 *
 * Writes:
 *   data/intraday-h1.json
 *
 * INTEGRATION CONTRACT
 * --------------------
 * Existing top-level candle arrays remain unchanged:
 *
 *   {
 *     XAUUSD: [...],
 *     GBPJPY: [...]
 *   }
 *
 * This preserves compatibility with:
 *   - run-live-analysis.js
 *   - Existing local H4 aggregation logic
 *   - Existing frontend consumers
 *   - Existing GitHub workflow validation
 *
 * PROFESSIONAL H1 DATA LAYER
 * --------------------------
 * - Exact UTC H1 timestamp alignment (HH:00:00 only)
 * - Fully closed candles only
 * - Strict OHLC validation
 * - Optional provider volume preservation
 * - Duplicate removal and chronological sorting
 * - Exact continuity and missing-interval diagnostics
 * - One immutable reference time per execution
 * - Authoritative fresh-window cache merging
 * - Explicit provider-coverage regression diagnostics
 * - Complete local H4 readiness diagnostics
 * - Atomic JSON replacement
 * - Maximum two provider requests per execution
 * - No automatic provider retries
 * - API credentials never written to output or logs
 */

const fs = require("fs");
const path = require("path");

/* =====================================================================
   Configuration
   ===================================================================== */

const FILE_VERSION = "2.1.0";
const SOURCE_NAME = "Twelve Data";
const INTERVAL = "1h";
const INTERVAL_MINUTES = 60;
const EXPECTED_INTERVAL_MS =
  INTERVAL_MINUTES * 60 * 1000;
const H4_INTERVAL_MS =
  4 * EXPECTED_INTERVAL_MS;

const API_BASE_URL =
  "https://api.twelvedata.com/time_series";

const DATA_DIR =
  path.join(
    __dirname,
    "data"
  );

const OUTPUT_PATH =
  path.join(
    DATA_DIR,
    "intraday-h1.json"
  );

const SYMBOLS = Object.freeze([
  Object.freeze({
    symbol: "XAU/USD",
    key: "XAUUSD",
    label: "XAU/USD"
  }),

  Object.freeze({
    symbol: "GBP/JPY",
    key: "GBPJPY",
    label: "GBP/JPY"
  })
]);

/*
 * Existing request/history settings are intentionally preserved.
 */
const OUTPUT_SIZE = 800;
const MAX_REQUESTS_PER_RUN =
  SYMBOLS.length;
const REQUEST_TIMEOUT_MS = 20_000;
const REQUEST_GAP_MS = 1_000;
const STALE_AFTER_HOURS = 6;
const MAX_STORED_CANDLES = 900;
const MAX_GAP_SAMPLES = 20;

/* =====================================================================
   Runtime State
   ===================================================================== */

let requestsMade = 0;

/* =====================================================================
   Generic Helpers
   ===================================================================== */

function isRecord(value) {
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

function errorMessageOf(error) {
  return error instanceof Error
    ? error.message
    : String(error);
}

function sleep(milliseconds) {
  return new Promise(resolve => {
    setTimeout(
      resolve,
      milliseconds
    );
  });
}

function parseNumber(value) {
  if (
    typeof value !== "number" &&
    typeof value !== "string"
  ) {
    return null;
  }

  const normalized =
    typeof value === "string"
      ? value.trim()
      : value;

  if (normalized === "") {
    return null;
  }

  const parsed =
    Number(normalized);

  return Number.isFinite(parsed)
    ? parsed
    : null;
}

function round(value, decimals = 2) {
  if (!Number.isFinite(value)) {
    return null;
  }

  const multiplier =
    10 ** decimals;

  return (
    Math.round(
      value * multiplier
    ) / multiplier
  );
}

function pad2(value) {
  return String(value)
    .padStart(2, "0");
}

function getConfiguredApiKey() {
  return typeof process.env.TWELVEDATA_API_KEY === "string"
    ? process.env.TWELVEDATA_API_KEY.trim()
    : "";
}

/* =====================================================================
   Startup Validation
   ===================================================================== */

function validateStartupConfiguration(
  apiKey = getConfiguredApiKey()
) {
  if (!apiKey) {
    throw new Error(
      "Missing TWELVEDATA_API_KEY environment variable."
    );
  }

  const positiveIntegers = [
    ["OUTPUT_SIZE", OUTPUT_SIZE],
    ["MAX_REQUESTS_PER_RUN", MAX_REQUESTS_PER_RUN],
    ["REQUEST_TIMEOUT_MS", REQUEST_TIMEOUT_MS],
    ["STALE_AFTER_HOURS", STALE_AFTER_HOURS],
    ["MAX_STORED_CANDLES", MAX_STORED_CANDLES],
    ["EXPECTED_INTERVAL_MS", EXPECTED_INTERVAL_MS]
  ];

  for (const [name, value] of positiveIntegers) {
    if (
      !Number.isInteger(value) ||
      value <= 0
    ) {
      throw new Error(
        `${name} must be a positive integer.`
      );
    }
  }

  if (MAX_STORED_CANDLES < OUTPUT_SIZE) {
    throw new Error(
      "MAX_STORED_CANDLES must be greater than or equal to OUTPUT_SIZE."
    );
  }

  if (
    !Number.isInteger(REQUEST_GAP_MS) ||
    REQUEST_GAP_MS < 0
  ) {
    throw new Error(
      "REQUEST_GAP_MS must be a non-negative integer."
    );
  }

  const seenKeys =
    new Set();

  for (const config of SYMBOLS) {
    if (
      !isRecord(config) ||
      typeof config.symbol !== "string" ||
      typeof config.key !== "string" ||
      typeof config.label !== "string" ||
      !config.symbol.trim() ||
      !config.key.trim() ||
      !config.label.trim()
    ) {
      throw new Error(
        "Every symbol configuration must contain symbol, key and label."
      );
    }

    if (seenKeys.has(config.key)) {
      throw new Error(
        `Duplicate symbol key configured: ${config.key}`
      );
    }

    seenKeys.add(
      config.key
    );
  }
}

/* =====================================================================
   Timestamp Helpers
   ===================================================================== */

function normalizeTimestamp(value) {
  if (
    typeof value !== "string" ||
    !value.trim()
  ) {
    return null;
  }

  const match =
    value
      .trim()
      .match(
        /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:Z)?$/
      );

  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] ?? 0);

  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    !Number.isInteger(second) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second > 59
  ) {
    return null;
  }

  const timestamp =
    Date.UTC(
      year,
      month - 1,
      day,
      hour,
      minute,
      second
    );

  const checked =
    new Date(timestamp);

  if (
    checked.getUTCFullYear() !== year ||
    checked.getUTCMonth() !== month - 1 ||
    checked.getUTCDate() !== day ||
    checked.getUTCHours() !== hour ||
    checked.getUTCMinutes() !== minute ||
    checked.getUTCSeconds() !== second
  ) {
    return null;
  }

  return (
    `${String(year).padStart(4, "0")}-` +
    `${pad2(month)}-` +
    `${pad2(day)} ` +
    `${pad2(hour)}:` +
    `${pad2(minute)}:` +
    `${pad2(second)}`
  );
}

function timestampToMs(value) {
  const normalized =
    normalizeTimestamp(value);

  if (!normalized) {
    return null;
  }

  const timestamp =
    Date.parse(
      `${normalized.replace(" ", "T")}Z`
    );

  return Number.isFinite(timestamp)
    ? timestamp
    : null;
}

function timestampFromMs(timestamp) {
  if (!Number.isFinite(timestamp)) {
    return null;
  }

  const date =
    new Date(timestamp);

  return (
    `${String(date.getUTCFullYear()).padStart(4, "0")}-` +
    `${pad2(date.getUTCMonth() + 1)}-` +
    `${pad2(date.getUTCDate())} ` +
    `${pad2(date.getUTCHours())}:` +
    `${pad2(date.getUTCMinutes())}:` +
    `${pad2(date.getUTCSeconds())}`
  );
}

function floorToIntervalMs(
  timestamp,
  intervalMs
) {
  if (
    !Number.isFinite(timestamp) ||
    !Number.isInteger(intervalMs) ||
    intervalMs <= 0
  ) {
    return null;
  }

  return (
    Math.floor(
      timestamp / intervalMs
    ) * intervalMs
  );
}

function isAlignedH1Timestamp(value) {
  const timestamp =
    timestampToMs(value);

  if (!Number.isFinite(timestamp)) {
    return false;
  }

  const date =
    new Date(timestamp);

  return (
    date.getUTCMinutes() === 0 &&
    date.getUTCSeconds() === 0 &&
    date.getUTCMilliseconds() === 0
  );
}

function getH1CandleTimeState(
  timeValue,
  referenceTimeMs = Date.now()
) {
  const candleStartMs =
    timestampToMs(timeValue);

  if (
    !Number.isFinite(candleStartMs) ||
    !Number.isFinite(referenceTimeMs)
  ) {
    return "invalid";
  }

  if (!isAlignedH1Timestamp(timeValue)) {
    return "misaligned";
  }

  if (candleStartMs > referenceTimeMs) {
    return "future";
  }

  if (
    candleStartMs +
      EXPECTED_INTERVAL_MS >
    referenceTimeMs
  ) {
    return "open";
  }

  return "closed";
}

function ageHoursFromStart(
  timeValue,
  referenceTimeMs = Date.now()
) {
  const candleStartMs =
    timestampToMs(timeValue);

  if (
    !Number.isFinite(candleStartMs) ||
    !Number.isFinite(referenceTimeMs)
  ) {
    return null;
  }

  return Math.max(
    0,
    (
      referenceTimeMs -
      candleStartMs
    ) / EXPECTED_INTERVAL_MS
  );
}

function closeAgeHours(
  timeValue,
  referenceTimeMs = Date.now()
) {
  const candleStartMs =
    timestampToMs(timeValue);

  if (
    !Number.isFinite(candleStartMs) ||
    !Number.isFinite(referenceTimeMs)
  ) {
    return null;
  }

  const candleCloseMs =
    candleStartMs +
    EXPECTED_INTERVAL_MS;

  return Math.max(
    0,
    (
      referenceTimeMs -
      candleCloseMs
    ) / EXPECTED_INTERVAL_MS
  );
}

function isPossiblyOpenLastCandle(
  timeValue,
  referenceTimeMs = Date.now()
) {
  return (
    getH1CandleTimeState(
      timeValue,
      referenceTimeMs
    ) === "open"
  );
}

/* =====================================================================
   Safe JSON Handling
   ===================================================================== */

function readJsonFile(
  filePath,
  fallback = null
) {
  try {
    if (!fs.existsSync(filePath)) {
      return fallback;
    }

    const content =
      fs.readFileSync(
        filePath,
        "utf8"
      );

    if (!content.trim()) {
      return fallback;
    }

    return JSON.parse(content);
  } catch (error) {
    console.warn(
      `Could not safely read ${filePath}: ${errorMessageOf(error)}`
    );

    return fallback;
  }
}

function atomicWriteJson(
  filePath,
  value
) {
  const directory =
    path.dirname(filePath);

  fs.mkdirSync(
    directory,
    {
      recursive: true
    }
  );

  const temporaryPath =
    `${filePath}.${process.pid}.${Date.now()}.tmp`;

  const serialized =
    `${JSON.stringify(value, null, 2)}\n`;

  try {
    fs.writeFileSync(
      temporaryPath,
      serialized,
      {
        encoding: "utf8",
        mode: 0o600
      }
    );

    fs.renameSync(
      temporaryPath,
      filePath
    );
  } catch (error) {
    try {
      if (fs.existsSync(temporaryPath)) {
        fs.unlinkSync(temporaryPath);
      }
    } catch {
      // Preserve the original filesystem error.
    }

    throw error;
  }
}

/* =====================================================================
   Candle Validation
   ===================================================================== */

function parseOptionalVolume(raw) {
  if (!isRecord(raw)) {
    return null;
  }

  const value =
    raw.volume ??
    raw.tick_volume ??
    raw.tickVolume;

  const parsed =
    parseNumber(value);

  return (
    Number.isFinite(parsed) &&
    parsed >= 0
  )
    ? parsed
    : null;
}

function normalizeCandle(
  raw,
  referenceTimeMs = Date.now()
) {
  if (!isRecord(raw)) {
    return {
      candle: null,
      reason: "not-an-object"
    };
  }

  const time =
    normalizeTimestamp(
      raw.datetime ??
      raw.time
    );

  if (!time) {
    return {
      candle: null,
      reason: "invalid-time"
    };
  }

  const timeState =
    getH1CandleTimeState(
      time,
      referenceTimeMs
    );

  if (timeState === "misaligned") {
    return {
      candle: null,
      reason: "misaligned-h1-candle-time"
    };
  }

  if (timeState === "future") {
    return {
      candle: null,
      reason: "future-candle"
    };
  }

  if (timeState === "open") {
    return {
      candle: null,
      reason: "open-candle"
    };
  }

  if (timeState !== "closed") {
    return {
      candle: null,
      reason: "invalid-time"
    };
  }

  const open = parseNumber(raw.open);
  const high = parseNumber(raw.high);
  const low = parseNumber(raw.low);
  const close = parseNumber(raw.close);

  if (
    !isFiniteNumber(open) ||
    !isFiniteNumber(high) ||
    !isFiniteNumber(low) ||
    !isFiniteNumber(close)
  ) {
    return {
      candle: null,
      reason: "invalid-price"
    };
  }

  if (
    open <= 0 ||
    high <= 0 ||
    low <= 0 ||
    close <= 0
  ) {
    return {
      candle: null,
      reason: "non-positive-price"
    };
  }

  if (high < low) {
    return {
      candle: null,
      reason: "high-below-low"
    };
  }

  if (
    high < open ||
    high < close
  ) {
    return {
      candle: null,
      reason: "high-below-open-or-close"
    };
  }

  if (
    low > open ||
    low > close
  ) {
    return {
      candle: null,
      reason: "low-above-open-or-close"
    };
  }

  return {
    candle: {
      time,
      open,
      high,
      low,
      close,
      volume:
        parseOptionalVolume(raw)
    },

    reason: null
  };
}

/* =====================================================================
   Data Quality and Continuity Diagnostics
   ===================================================================== */

function createEmptyGapAnalysis() {
  return {
    expectedIntervalHours: 1,
    evaluatedIntervals: 0,
    normalGapCount: 0,
    continuousIntervals: 0,
    irregularIntervalCount: 0,
    largeGapCount: 0,
    missingIntervalEstimate: 0,
    largestGapHours: 0,
    continuityPercent: null,
    sampleLargeGaps: []
  };
}

function analyzeTimeGaps(rows) {
  if (
    !Array.isArray(rows) ||
    rows.length < 2
  ) {
    return createEmptyGapAnalysis();
  }

  let evaluatedIntervals = 0;
  let continuousIntervals = 0;
  let irregularIntervalCount = 0;
  let largeGapCount = 0;
  let missingIntervalEstimate = 0;
  let largestGapHours = 0;

  const sampleLargeGaps = [];

  for (
    let index = 1;
    index < rows.length;
    index++
  ) {
    const previousTime =
      timestampToMs(
        rows[index - 1]?.time
      );

    const currentTime =
      timestampToMs(
        rows[index]?.time
      );

    if (
      !Number.isFinite(previousTime) ||
      !Number.isFinite(currentTime)
    ) {
      continue;
    }

    const gapMs =
      currentTime -
      previousTime;

    if (gapMs <= 0) {
      continue;
    }

    evaluatedIntervals++;

    const gapHours =
      gapMs /
      EXPECTED_INTERVAL_MS;

    largestGapHours =
      Math.max(
        largestGapHours,
        gapHours
      );

    if (gapMs === EXPECTED_INTERVAL_MS) {
      continuousIntervals++;
      continue;
    }

    irregularIntervalCount++;

    if (gapMs > EXPECTED_INTERVAL_MS) {
      largeGapCount++;
      missingIntervalEstimate +=
        Math.max(
          0,
          Math.floor(
            gapMs /
            EXPECTED_INTERVAL_MS
          ) - 1
        );
    }

    if (
      sampleLargeGaps.length <
      MAX_GAP_SAMPLES
    ) {
      sampleLargeGaps.push({
        from:
          rows[index - 1].time,

        to:
          rows[index].time,

        hours:
          round(
            gapHours,
            2
          ),

        missingIntervals:
          gapMs > EXPECTED_INTERVAL_MS
            ? Math.max(
                0,
                Math.floor(
                  gapMs /
                  EXPECTED_INTERVAL_MS
                ) - 1
              )
            : 0
      });
    }
  }

  return {
    expectedIntervalHours: 1,
    evaluatedIntervals,
    normalGapCount:
      continuousIntervals,
    continuousIntervals,
    irregularIntervalCount,
    largeGapCount,
    missingIntervalEstimate,
    largestGapHours:
      round(
        largestGapHours,
        2
      ),
    continuityPercent:
      evaluatedIntervals > 0
        ? round(
            continuousIntervals /
              evaluatedIntervals *
              100,
            2
          )
        : null,
    sampleLargeGaps
  };
}

function buildEmptyQuality(
  rejectedReasons = {}
) {
  return {
    receivedRows: 0,
    validRows: 0,
    rejectedRows: 0,
    duplicateTimes: 0,
    trimmedRows: 0,
    volumeRows: 0,
    missingVolumeRows: 0,
    rejectedReasons,
    firstTime: null,
    lastTime: null,
    ageHours: null,
    closeAgeHours: null,
    stale: true,
    gaps:
      createEmptyGapAnalysis()
  };
}

function normalizeCandles(
  values,
  referenceTimeMs = Date.now()
) {
  if (!Array.isArray(values)) {
    return {
      rows: [],
      quality:
        buildEmptyQuality({
          "values-not-array": 1
        })
    };
  }

  const candlesByTime =
    new Map();
  const rejectedReasons = {};

  let rejectedCount = 0;
  let duplicateCount = 0;

  for (const raw of values) {
    const result =
      normalizeCandle(
        raw,
        referenceTimeMs
      );

    if (!result.candle) {
      rejectedCount++;

      const reason =
        result.reason ||
        "unknown";

      rejectedReasons[reason] =
        (
          rejectedReasons[reason] ||
          0
        ) + 1;

      continue;
    }

    const { time } =
      result.candle;

    if (candlesByTime.has(time)) {
      duplicateCount++;
    }

    /* Latest valid duplicate occurrence wins. */
    candlesByTime.set(
      time,
      result.candle
    );
  }

  const uniqueRows =
    Array.from(
      candlesByTime.values()
    ).sort(
      (left, right) =>
        timestampToMs(left.time) -
        timestampToMs(right.time)
    );

  const trimmedRows =
    Math.max(
      0,
      uniqueRows.length -
      MAX_STORED_CANDLES
    );

  const rows =
    uniqueRows.slice(
      -MAX_STORED_CANDLES
    );

  const firstTime =
    rows[0]?.time ??
    null;

  const lastTime =
    rows.at(-1)?.time ??
    null;

  const latestStartAgeHours =
    ageHoursFromStart(
      lastTime,
      referenceTimeMs
    );

  const latestCloseAgeHours =
    closeAgeHours(
      lastTime,
      referenceTimeMs
    );

  const volumeRows =
    rows.reduce(
      (count, row) =>
        count +
        (
          Number.isFinite(row.volume)
            ? 1
            : 0
        ),
      0
    );

  return {
    rows,

    quality: {
      receivedRows:
        values.length,
      validRows:
        rows.length,
      rejectedRows:
        rejectedCount,
      duplicateTimes:
        duplicateCount,
      trimmedRows,
      volumeRows,
      missingVolumeRows:
        rows.length -
        volumeRows,
      rejectedReasons,
      firstTime,
      lastTime,
      ageHours:
        round(
          latestStartAgeHours,
          2
        ),
      closeAgeHours:
        round(
          latestCloseAgeHours,
          2
        ),
      stale:
        latestCloseAgeHours === null ||
        latestCloseAgeHours >
          STALE_AFTER_HOURS,
      gaps:
        analyzeTimeGaps(
          rows
        )
    }
  };
}

/* =====================================================================
   Previous Data Recovery
   ===================================================================== */

function getPreviousRows(
  previousOutput,
  key,
  referenceTimeMs = Date.now()
) {
  if (!isRecord(previousOutput)) {
    return [];
  }

  if (
    Array.isArray(
      previousOutput[key]
    )
  ) {
    return normalizeCandles(
      previousOutput[key],
      referenceTimeMs
    ).rows;
  }

  const nestedRows =
    previousOutput
      .symbols
      ?.[key]
      ?.candles;

  if (Array.isArray(nestedRows)) {
    return normalizeCandles(
      nestedRows,
      referenceTimeMs
    ).rows;
  }

  return [];
}

/* =====================================================================
   Authoritative Fresh-Window Cache Merge
   ===================================================================== */

function createEmptyMergeDiagnostics() {
  return {
    previousRowsReceived: 0,
    previousRowsValid: 0,
    freshRowsReceived: 0,
    freshRowsValid: 0,
    freshRowsStored: 0,
    cachedRowsRetainedOlder: 0,
    cachedRowsRetainedNewer: 0,
    cachedRowsDiscardedOverlap: 0,
    previousLatestTime: null,
    freshWindowStart: null,
    freshWindowEnd: null,
    finalLatestTime: null,
    providerCoverageRegressed: false,
    mixedSource: false
  };
}

function mergeCandleRows(
  previousRows,
  freshRows,
  referenceTimeMs = Date.now()
) {
  const previousInput =
    Array.isArray(previousRows)
      ? previousRows
      : [];

  const freshInput =
    Array.isArray(freshRows)
      ? freshRows
      : [];

  const normalizedPrevious =
    normalizeCandles(
      previousInput,
      referenceTimeMs
    );

  const normalizedFresh =
    normalizeCandles(
      freshInput,
      referenceTimeMs
    );

  const diagnostics = {
    ...createEmptyMergeDiagnostics(),
    previousRowsReceived:
      previousInput.length,
    previousRowsValid:
      normalizedPrevious.rows.length,
    freshRowsReceived:
      freshInput.length,
    freshRowsValid:
      normalizedFresh.rows.length
  };

  if (normalizedFresh.rows.length === 0) {
    return {
      ...normalizedPrevious,
      mergeDiagnostics: {
        ...diagnostics,
        finalLatestTime:
          normalizedPrevious.rows.at(-1)?.time ??
          null,
        mixedSource: false
      }
    };
  }

  const firstFreshTime =
    timestampToMs(
      normalizedFresh.rows[0].time
    );

  const lastFreshTime =
    timestampToMs(
      normalizedFresh.rows.at(-1).time
    );

  const previousLatestTime =
    normalizedPrevious.rows.at(-1)?.time ??
    null;

  const previousLatestMs =
    timestampToMs(
      previousLatestTime
    );

  const cachedOlder = [];
  const cachedNewer = [];
  let cachedOverlapCount = 0;

  for (const row of normalizedPrevious.rows) {
    const rowTime =
      timestampToMs(row.time);

    if (!Number.isFinite(rowTime)) {
      continue;
    }

    if (rowTime < firstFreshTime) {
      cachedOlder.push(row);
      continue;
    }

    if (rowTime > lastFreshTime) {
      cachedNewer.push(row);
      continue;
    }

    cachedOverlapCount++;
  }

  const merged =
    normalizeCandles(
      [
        ...cachedOlder,
        ...normalizedFresh.rows,
        ...cachedNewer
      ],
      referenceTimeMs
    );

  const providerCoverageRegressed =
    Number.isFinite(previousLatestMs) &&
    Number.isFinite(lastFreshTime) &&
    previousLatestMs > lastFreshTime;

  return {
    ...merged,
    mergeDiagnostics: {
      ...diagnostics,
      freshRowsStored:
        normalizedFresh.rows.length,
      cachedRowsRetainedOlder:
        cachedOlder.length,
      cachedRowsRetainedNewer:
        cachedNewer.length,
      cachedRowsDiscardedOverlap:
        cachedOverlapCount,
      previousLatestTime,
      freshWindowStart:
        normalizedFresh.rows[0].time,
      freshWindowEnd:
        normalizedFresh.rows.at(-1).time,
      finalLatestTime:
        merged.rows.at(-1)?.time ??
        null,
      providerCoverageRegressed,
      mixedSource:
        cachedOlder.length > 0 ||
        cachedNewer.length > 0
    }
  };
}

/* =====================================================================
   Complete Local H4 Diagnostics
   ===================================================================== */

function aggregateClosedH1ToH4(
  rows,
  referenceTimeMs = Date.now()
) {
  const normalized =
    normalizeCandles(
      Array.isArray(rows)
        ? rows
        : [],
      referenceTimeMs
    );

  const groups =
    new Map();

  for (const row of normalized.rows) {
    const timestamp =
      timestampToMs(row.time);

    if (!Number.isFinite(timestamp)) {
      continue;
    }

    const bucketStart =
      floorToIntervalMs(
        timestamp,
        H4_INTERVAL_MS
      );

    if (!groups.has(bucketStart)) {
      groups.set(
        bucketStart,
        []
      );
    }

    groups
      .get(bucketStart)
      .push({
        row,
        timestamp
      });
  }

  const candles = [];

  const diagnostics = {
    sourceTimeframe: "H1",
    targetTimeframe: "H4",
    expectedSourceCount: 4,
    sourceCandles: normalized.rows.length,
    estimatedCandles:
      Math.floor(
        normalized.rows.length /
        4
      ),
    totalBuckets:
      groups.size,
    actualCompleteCandles: 0,
    incompleteBuckets: 0,
    nonContiguousBuckets: 0,
    formingBucketsSkipped: 0,
    invalidOhlcBuckets: 0,
    completeVolumeCandles: 0,
    latestCompleteH4Time: null,
    available: false
  };

  for (const [bucketStart, items] of groups.entries()) {
    if (
      bucketStart +
        H4_INTERVAL_MS >
      referenceTimeMs
    ) {
      diagnostics.formingBucketsSkipped++;
      continue;
    }

    items.sort(
      (left, right) =>
        left.timestamp -
        right.timestamp
    );

    if (items.length !== 4) {
      diagnostics.incompleteBuckets++;
      continue;
    }

    let contiguous = true;

    for (
      let index = 0;
      index < items.length;
      index++
    ) {
      const expectedTimestamp =
        bucketStart +
        index *
          EXPECTED_INTERVAL_MS;

      if (
        items[index].timestamp !==
        expectedTimestamp
      ) {
        contiguous = false;
        break;
      }
    }

    if (!contiguous) {
      diagnostics.nonContiguousBuckets++;
      continue;
    }

    const sourceCandles =
      items.map(item => item.row);

    const open =
      sourceCandles[0].open;
    const close =
      sourceCandles.at(-1).close;
    const high =
      Math.max(
        ...sourceCandles.map(
          candle => candle.high
        )
      );
    const low =
      Math.min(
        ...sourceCandles.map(
          candle => candle.low
        )
      );

    if (
      !isFiniteNumber(open) ||
      !isFiniteNumber(high) ||
      !isFiniteNumber(low) ||
      !isFiniteNumber(close) ||
      high < low ||
      high < open ||
      high < close ||
      low > open ||
      low > close
    ) {
      diagnostics.invalidOhlcBuckets++;
      continue;
    }

    const allVolumeAvailable =
      sourceCandles.every(
        candle =>
          Number.isFinite(
            candle.volume
          )
      );

    const volume =
      allVolumeAvailable
        ? sourceCandles.reduce(
            (total, candle) =>
              total +
              candle.volume,
            0
          )
        : null;

    if (allVolumeAvailable) {
      diagnostics.completeVolumeCandles++;
    }

    candles.push({
      time:
        timestampFromMs(
          bucketStart
        ),
      open,
      high,
      low,
      close,
      volume
    });
  }

  diagnostics.actualCompleteCandles =
    candles.length;
  diagnostics.latestCompleteH4Time =
    candles.at(-1)?.time ??
    null;
  diagnostics.available =
    candles.length > 0;

  return {
    candles,
    diagnostics
  };
}

/* =====================================================================
   Provider Error Handling
   ===================================================================== */

function createProviderError(
  symbol,
  payload
) {
  const providerCode =
    isRecord(payload)
      ? payload.code ?? null
      : null;

  const providerMessage =
    isRecord(payload) &&
    typeof payload.message === "string" &&
    payload.message.trim()
      ? payload.message.trim()
      : "Unknown provider error";

  const error =
    new Error(
      `Twelve Data error for ${symbol}: ${providerMessage}`
    );

  error.providerCode =
    providerCode;

  return error;
}

function sanitizeRequestError(
  error,
  apiKey = getConfiguredApiKey()
) {
  const message =
    errorMessageOf(error);

  if (!apiKey) {
    return message;
  }

  return message
    .split(apiKey)
    .join("[REDACTED]");
}

/* =====================================================================
   Free-Tier Request Control
   ===================================================================== */

function resetRequestBudget() {
  requestsMade = 0;
}

function reserveProviderRequest() {
  if (
    requestsMade >=
    MAX_REQUESTS_PER_RUN
  ) {
    throw new Error(
      `Request safety limit reached: maximum ${MAX_REQUESTS_PER_RUN} ` +
      "Twelve Data requests per run."
    );
  }

  requestsMade++;

  return requestsMade;
}

function buildProviderUrl(
  symbol,
  apiKey = getConfiguredApiKey()
) {
  const url =
    new URL(
      API_BASE_URL
    );

  url.search =
    new URLSearchParams({
      symbol,
      interval:
        INTERVAL,
      outputsize:
        String(OUTPUT_SIZE),
      timezone:
        "UTC",
      apikey:
        apiKey
    }).toString();

  return url;
}

/* =====================================================================
   Single-Request JSON Fetch
   ===================================================================== */

async function fetchJsonOnce(
  url,
  {
    timeoutMs = REQUEST_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
    apiKey = getConfiguredApiKey()
  } = {}
) {
  if (typeof fetchImpl !== "function") {
    throw new Error(
      "A compatible fetch implementation is required."
    );
  }

  reserveProviderRequest();

  const controller =
    new AbortController();

  const timeoutHandle =
    setTimeout(
      () => controller.abort(),
      timeoutMs
    );

  try {
    const response =
      await fetchImpl(
        url,
        {
          method: "GET",
          signal:
            controller.signal,
          headers: {
            Accept:
              "application/json"
          }
        }
      );

    const responseText =
      await response.text();

    let payload = null;

    if (responseText) {
      try {
        payload =
          JSON.parse(
            responseText
          );
      } catch {
        throw new Error(
          `Twelve Data returned invalid JSON (HTTP ${response.status}).`
        );
      }
    }

    if (!response.ok) {
      const providerMessage =
        isRecord(payload) &&
        typeof payload.message === "string" &&
        payload.message.trim()
          ? payload.message.trim()
          : `HTTP ${response.status}`;

      const error =
        new Error(
          `Twelve Data request failed: ${providerMessage}`
        );

      error.httpStatus =
        response.status;

      throw error;
    }

    return payload;
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === "AbortError"
    ) {
      throw new Error(
        `Twelve Data request timed out after ${timeoutMs}ms.`
      );
    }

    throw new Error(
      sanitizeRequestError(
        error,
        apiKey
      )
    );
  } finally {
    clearTimeout(
      timeoutHandle
    );
  }
}

/* =====================================================================
   Twelve Data H1 Fetch
   ===================================================================== */

async function fetchH1(
  config,
  {
    referenceTimeMs = Date.now(),
    fetchImpl = globalThis.fetch,
    apiKey = getConfiguredApiKey()
  } = {}
) {
  const url =
    buildProviderUrl(
      config.symbol,
      apiKey
    );

  const payload =
    await fetchJsonOnce(
      url,
      {
        fetchImpl,
        apiKey
      }
    );

  if (!isRecord(payload)) {
    throw new Error(
      `Empty or invalid Twelve Data response for ${config.symbol}.`
    );
  }

  if (
    payload.status === "error" ||
    payload.code != null
  ) {
    throw createProviderError(
      config.symbol,
      payload
    );
  }

  if (!Array.isArray(payload.values)) {
    throw new Error(
      `Twelve Data response for ${config.symbol} ` +
      "does not contain a values array."
    );
  }

  const normalized =
    normalizeCandles(
      payload.values,
      referenceTimeMs
    );

  if (normalized.rows.length === 0) {
    throw new Error(
      `No valid H1 candles returned for ${config.symbol}.`
    );
  }

  return {
    rows:
      normalized.rows,
    quality:
      normalized.quality,
    provider: {
      name:
        SOURCE_NAME,
      symbol:
        typeof payload.meta?.symbol === "string"
          ? payload.meta.symbol
          : config.symbol,
      interval:
        typeof payload.meta?.interval === "string"
          ? payload.meta.interval
          : INTERVAL,
      currencyBase:
        typeof payload.meta?.currency_base === "string"
          ? payload.meta.currency_base
          : null,
      currencyQuote:
        typeof payload.meta?.currency_quote === "string"
          ? payload.meta.currency_quote
          : null,
      exchange:
        typeof payload.meta?.exchange === "string"
          ? payload.meta.exchange
          : null,
      exchangeTimezone:
        typeof payload.meta?.exchange_timezone === "string"
          ? payload.meta.exchange_timezone
          : null,
      instrumentType:
        typeof payload.meta?.type === "string"
          ? payload.meta.type
          : null
    }
  };
}

/* =====================================================================
   Symbol Metadata
   ===================================================================== */

function buildSymbolMetadata({
  config,
  rows,
  source,
  fetchSucceeded,
  fallbackUsed,
  errorMessage,
  fetchedQuality,
  finalQuality,
  provider,
  mergeDiagnostics,
  h4Diagnostics,
  referenceTimeMs
}) {
  const firstTime =
    rows[0]?.time ??
    null;

  const lastTime =
    rows.at(-1)?.time ??
    null;

  const latestAgeHours =
    ageHoursFromStart(
      lastTime,
      referenceTimeMs
    );

  const latestCloseAgeHours =
    closeAgeHours(
      lastTime,
      referenceTimeMs
    );

  return {
    symbol:
      config.symbol,
    key:
      config.key,
    label:
      config.label,
    interval:
      INTERVAL,
    source,
    fetchSucceeded:
      Boolean(fetchSucceeded),
    fallbackUsed:
      Boolean(fallbackUsed),
    error:
      errorMessage ||
      null,
    candleCount:
      rows.length,
    firstTime,
    lastTime,
    ageHours:
      round(
        latestAgeHours,
        2
      ),
    closeAgeHours:
      round(
        latestCloseAgeHours,
        2
      ),
    stale:
      !fetchSucceeded ||
      rows.length === 0 ||
      finalQuality.stale,
    possiblyOpenLastCandle:
      isPossiblyOpenLastCandle(
        lastTime,
        referenceTimeMs
      ),
    sourceComposition: {
      mixedSource:
        mergeDiagnostics?.mixedSource === true,
      providerCoverageRegressed:
        mergeDiagnostics?.providerCoverageRegressed === true,
      freshRowsStored:
        mergeDiagnostics?.freshRowsStored ??
        0,
      cachedRowsRetained:
        (
          mergeDiagnostics?.cachedRowsRetainedOlder ??
          0
        ) +
        (
          mergeDiagnostics?.cachedRowsRetainedNewer ??
          0
        )
    },
    fetchedQuality:
      fetchedQuality ||
      null,
    quality:
      finalQuality,
    mergeDiagnostics:
      mergeDiagnostics ||
      createEmptyMergeDiagnostics(),
    h4Readiness:
      h4Diagnostics,
    provider:
      provider ||
      null
  };
}

/* =====================================================================
   Output Construction
   ===================================================================== */

function createInitialOutput(
  startedAt
) {
  return {
    updatedAt:
      startedAt.toISOString(),
    startedAt:
      startedAt.toISOString(),
    version:
      FILE_VERSION,
    source:
      SOURCE_NAME,
    interval:
      INTERVAL,
    intervalMinutes:
      INTERVAL_MINUTES,
    outputSizeRequested:
      OUTPUT_SIZE,
    derivedTimeframes: {
      H4: {
        source:
          "H1",
        grouping:
          4,
        exactUtcAlignment:
          true,
        completeBucketsOnly:
          true,
        extraApiRequests:
          0
      }
    },
    requestPolicy: {
      maximumRequestsPerRun:
        MAX_REQUESTS_PER_RUN,
      retries:
        0,
      timeoutMs:
        REQUEST_TIMEOUT_MS,
      requestGapMs:
        REQUEST_GAP_MS
    },
    dataPolicy: {
      utcTimestamps:
        true,
      exactH1Alignment:
        true,
      closedCandlesOnly:
        true,
      preserveOptionalVolume:
        true,
      authoritativeFreshWindowMerge:
        true,
      fabricateMissingCandles:
        false
    },
    stale: {},
    metadata: {},
    h4Diagnostics: {},
    errors: [],
    warnings: []
  };
}

function storeSuccessfulResult(
  output,
  config,
  previousRows,
  fetched,
  referenceTimeMs
) {
  const merged =
    mergeCandleRows(
      previousRows,
      fetched.rows,
      referenceTimeMs
    );

  const h4 =
    aggregateClosedH1ToH4(
      merged.rows,
      referenceTimeMs
    );

  output[config.key] =
    merged.rows;

  output.stale[config.key] =
    merged.quality.stale;

  output.h4Diagnostics[config.key] =
    h4.diagnostics;

  output.metadata[config.key] =
    buildSymbolMetadata({
      config,
      rows:
        merged.rows,
      source:
        SOURCE_NAME,
      fetchSucceeded:
        true,
      fallbackUsed:
        false,
      errorMessage:
        null,
      fetchedQuality:
        fetched.quality,
      finalQuality:
        merged.quality,
      provider:
        fetched.provider,
      mergeDiagnostics:
        merged.mergeDiagnostics,
      h4Diagnostics:
        h4.diagnostics,
      referenceTimeMs
    });

  if (
    merged.mergeDiagnostics
      .providerCoverageRegressed
  ) {
    output.warnings.push({
      symbol:
        config.symbol,
      key:
        config.key,
      code:
        "provider-coverage-regressed",
      message:
        "Fresh provider history ended before the previously cached latest candle; newer valid cache rows were retained and the mixed source is explicitly reported.",
      previousLatestTime:
        merged.mergeDiagnostics
          .previousLatestTime,
      freshWindowEnd:
        merged.mergeDiagnostics
          .freshWindowEnd
    });
  }

  return merged;
}

function storeFailedResult(
  output,
  config,
  previousRows,
  error,
  referenceTimeMs,
  apiKey
) {
  const message =
    sanitizeRequestError(
      error,
      apiKey
    );

  const cached =
    normalizeCandles(
      previousRows,
      referenceTimeMs
    );

  const fallbackUsed =
    cached.rows.length > 0;

  const finalQuality = {
    ...cached.quality,
    stale: true
  };

  const h4 =
    aggregateClosedH1ToH4(
      cached.rows,
      referenceTimeMs
    );

  const mergeDiagnostics = {
    ...createEmptyMergeDiagnostics(),
    previousRowsReceived:
      Array.isArray(previousRows)
        ? previousRows.length
        : 0,
    previousRowsValid:
      cached.rows.length,
    finalLatestTime:
      cached.rows.at(-1)?.time ??
      null
  };

  output[config.key] =
    cached.rows;
  output.stale[config.key] =
    true;
  output.h4Diagnostics[config.key] =
    h4.diagnostics;

  output.metadata[config.key] =
    buildSymbolMetadata({
      config,
      rows:
        cached.rows,
      source:
        fallbackUsed
          ? "local-cache"
          : "unavailable",
      fetchSucceeded:
        false,
      fallbackUsed,
      errorMessage:
        message,
      fetchedQuality:
        null,
      finalQuality,
      provider:
        null,
      mergeDiagnostics,
      h4Diagnostics:
        h4.diagnostics,
      referenceTimeMs
    });

  output.errors.push({
    symbol:
      config.symbol,
    key:
      config.key,
    message,
    fallbackUsed,
    cachedCandleCount:
      cached.rows.length
  });

  return {
    message,
    cachedRows:
      cached.rows,
    fallbackUsed
  };
}

/* =====================================================================
   Output Validation
   ===================================================================== */

function validateCompletedOutput(
  output,
  referenceTimeMs
) {
  if (!isRecord(output)) {
    throw new Error(
      "Completed intraday H1 output must be a JSON object."
    );
  }

  if (output.interval !== INTERVAL) {
    throw new Error(
      `Output interval must remain ${INTERVAL}.`
    );
  }

  if (
    output.derivedTimeframes?.H4?.source !== "H1" ||
    output.derivedTimeframes?.H4?.grouping !== 4 ||
    output.derivedTimeframes?.H4?.extraApiRequests !== 0
  ) {
    throw new Error(
      "H4 derivation metadata is missing or invalid."
    );
  }

  for (const config of SYMBOLS) {
    const rows =
      output[config.key];

    if (!Array.isArray(rows)) {
      throw new Error(
        `${config.key} output must be an array.`
      );
    }

    const normalized =
      normalizeCandles(
        rows,
        referenceTimeMs
      );

    if (
      normalized.rows.length !==
      rows.length
    ) {
      throw new Error(
        `${config.key} output contains invalid or duplicate H1 candles.`
      );
    }

    for (let index = 0; index < rows.length; index++) {
      const row =
        rows[index];

      if (!isAlignedH1Timestamp(row.time)) {
        throw new Error(
          `${config.key} contains a candle that is not aligned to HH:00:00 UTC.`
        );
      }

      if (
        getH1CandleTimeState(
          row.time,
          referenceTimeMs
        ) !== "closed"
      ) {
        throw new Error(
          `${config.key} contains an open, future or invalid H1 candle.`
        );
      }

      if (
        row.volume !== null &&
        (
          !Number.isFinite(row.volume) ||
          row.volume < 0
        )
      ) {
        throw new Error(
          `${config.key} contains invalid optional volume data.`
        );
      }

      if (index > 0) {
        const previousTime =
          timestampToMs(
            rows[index - 1].time
          );

        const currentTime =
          timestampToMs(
            row.time
          );

        if (
          !Number.isFinite(previousTime) ||
          !Number.isFinite(currentTime) ||
          currentTime <= previousTime
        ) {
          throw new Error(
            `${config.key} candles must be strictly chronological.`
          );
        }
      }
    }

    const metadata =
      output.metadata?.[config.key];

    if (!isRecord(metadata)) {
      throw new Error(
        `${config.key} metadata is missing or invalid.`
      );
    }

    if (
      metadata.fetchSucceeded &&
      rows.length === 0
    ) {
      throw new Error(
        `${config.key} cannot report a successful fetch with no candles.`
      );
    }

    if (
      metadata.key !== config.key ||
      metadata.symbol !== config.symbol
    ) {
      throw new Error(
        `${config.key} metadata identity does not match its configured symbol.`
      );
    }

    if (
      metadata.candleCount !==
      rows.length
    ) {
      throw new Error(
        `${config.key} metadata candle count does not match its output array.`
      );
    }

    const recomputedH4 =
      aggregateClosedH1ToH4(
        rows,
        referenceTimeMs
      ).diagnostics;

    const recordedH4 =
      output.h4Diagnostics?.[config.key];

    if (
      !isRecord(recordedH4) ||
      recordedH4.actualCompleteCandles !==
        recomputedH4.actualCompleteCandles ||
      recordedH4.latestCompleteH4Time !==
        recomputedH4.latestCompleteH4Time
    ) {
      throw new Error(
        `${config.key} H4 diagnostics are missing or inconsistent.`
      );
    }
  }

  if (!Array.isArray(output.errors)) {
    throw new Error(
      "Output errors must be an array."
    );
  }

  if (!Array.isArray(output.warnings)) {
    throw new Error(
      "Output warnings must be an array."
    );
  }

  if (
    !Number.isInteger(output.requestsMade) ||
    output.requestsMade < 0 ||
    output.requestsMade >
      MAX_REQUESTS_PER_RUN
  ) {
    throw new Error(
      "Output request count is invalid."
    );
  }

  if (
    !isRecord(output.requestBudget) ||
    output.requestBudget.maximum !==
      MAX_REQUESTS_PER_RUN ||
    output.requestBudget.used !==
      output.requestsMade ||
    output.requestBudget.exceeded !==
      (
        output.requestsMade >
        MAX_REQUESTS_PER_RUN
      )
  ) {
    throw new Error(
      "Output request budget metadata is invalid."
    );
  }

  if (
    !Number.isInteger(output.successCount) ||
    !Number.isInteger(output.failureCount) ||
    output.successCount < 0 ||
    output.failureCount < 0 ||
    output.successCount +
      output.failureCount !==
    SYMBOLS.length
  ) {
    throw new Error(
      "Success and failure counts do not cover every configured symbol."
    );
  }
}

/* =====================================================================
   Symbol Processing
   ===================================================================== */

async function processSymbol({
  output,
  previousOutput,
  config,
  referenceTimeMs,
  fetchImpl,
  apiKey
}) {
  const previousRows =
    getPreviousRows(
      previousOutput,
      config.key,
      referenceTimeMs
    );

  console.log(
    `Fetching ${config.symbol} H1 OHLC ` +
    `(${requestsMade + 1}/${MAX_REQUESTS_PER_RUN})...`
  );

  try {
    const fetched =
      await fetchH1(
        config,
        {
          referenceTimeMs,
          fetchImpl,
          apiKey
        }
      );

    const merged =
      storeSuccessfulResult(
        output,
        config,
        previousRows,
        fetched,
        referenceTimeMs
      );

    console.log(
      `Fetched ${fetched.rows.length} valid H1 candles for ` +
      `${config.symbol}; stored ${merged.rows.length} candles.`
    );
  } catch (error) {
    const failed =
      storeFailedResult(
        output,
        config,
        previousRows,
        error,
        referenceTimeMs,
        apiKey
      );

    console.error(
      `Failed to fetch ${config.symbol}: ${failed.message}`
    );

    if (failed.fallbackUsed) {
      console.warn(
        `Using ${failed.cachedRows.length} cached H1 candles for ` +
        `${config.symbol}.`
      );
    } else {
      console.warn(
        `No cached H1 data is available for ${config.symbol}.`
      );
    }
  }
}

/* =====================================================================
   Run Finalization
   ===================================================================== */

function finalizeOutput(
  output,
  startedAt,
  completedAt
) {
  output.startedAt =
    startedAt.toISOString();
  output.updatedAt =
    completedAt.toISOString();
  output.completedAt =
    completedAt.toISOString();
  output.durationMs =
    completedAt.getTime() -
    startedAt.getTime();
  output.requestsMade =
    requestsMade;

  /* Legacy compatibility field. */
  output.requestLimitReached =
    requestsMade >=
    MAX_REQUESTS_PER_RUN;

  output.requestBudget = {
    maximum:
      MAX_REQUESTS_PER_RUN,
    used:
      requestsMade,
    remaining:
      Math.max(
        0,
        MAX_REQUESTS_PER_RUN -
        requestsMade
      ),
    exhausted:
      requestsMade >=
      MAX_REQUESTS_PER_RUN,
    exceeded:
      requestsMade >
      MAX_REQUESTS_PER_RUN
  };

  output.successCount =
    SYMBOLS.reduce(
      (count, config) =>
        count +
        (
          output.metadata[
            config.key
          ]?.fetchSucceeded
            ? 1
            : 0
        ),
      0
    );

  output.failureCount =
    output.errors.length;

  output.cacheFallbackCount =
    SYMBOLS.reduce(
      (count, config) =>
        count +
        (
          output.metadata[
            config.key
          ]?.fallbackUsed
            ? 1
            : 0
        ),
      0
    );

  output.allSymbolsAvailable =
    SYMBOLS.every(
      config =>
        Array.isArray(
          output[config.key]
        ) &&
        output[config.key].length > 0
    );

  output.hasFreshFetch =
    output.successCount > 0;

  return output;
}

/* =====================================================================
   Run Logging
   ===================================================================== */

function logRunSummary(
  output,
  outputPath = OUTPUT_PATH
) {
  console.log(
    `Wrote ${outputPath}`
  );

  console.log(
    `Twelve Data requests used: ` +
    `${output.requestsMade}/${MAX_REQUESTS_PER_RUN}`
  );

  console.log(
    `Successful symbols: ` +
    `${output.successCount}/${SYMBOLS.length}`
  );

  if (output.cacheFallbackCount > 0) {
    console.warn(
      `Cache fallback used for ` +
      `${output.cacheFallbackCount} symbol(s).`
    );
  }

  if (output.warnings.length > 0) {
    console.warn(
      `Completed with ${output.warnings.length} data-quality warning(s).`
    );
  }

  if (output.failureCount > 0) {
    console.warn(
      `Completed with ${output.failureCount} fetch failure(s); ` +
      "cached H1 data was preserved where available."
    );
  }
}

/* =====================================================================
   Main Worker
   ===================================================================== */

async function main({
  referenceTimeMs = Date.now(),
  fetchImpl = globalThis.fetch,
  apiKey = getConfiguredApiKey(),
  outputPath = OUTPUT_PATH,
  requestGapMs = REQUEST_GAP_MS
} = {}) {
  if (!Number.isFinite(referenceTimeMs)) {
    throw new Error(
      "referenceTimeMs must be a finite timestamp."
    );
  }

  validateStartupConfiguration(
    apiKey
  );

  resetRequestBudget();

  const startedAt =
    new Date(referenceTimeMs);

  fs.mkdirSync(
    path.dirname(outputPath),
    {
      recursive: true
    }
  );

  const previousOutput =
    readJsonFile(
      outputPath,
      {}
    );

  const output =
    createInitialOutput(
      startedAt
    );

  for (
    let index = 0;
    index < SYMBOLS.length;
    index++
  ) {
    await processSymbol({
      output,
      previousOutput,
      config:
        SYMBOLS[index],
      referenceTimeMs,
      fetchImpl,
      apiKey
    });

    if (
      index <
      SYMBOLS.length - 1 &&
      requestGapMs > 0
    ) {
      await sleep(
        requestGapMs
      );
    }
  }

  const completedAt =
    new Date();

  finalizeOutput(
    output,
    startedAt,
    completedAt
  );

  validateCompletedOutput(
    output,
    referenceTimeMs
  );

  atomicWriteJson(
    outputPath,
    output
  );

  logRunSummary(
    output,
    outputPath
  );

  return output;
}

/* =====================================================================
   Process-Level Error Handling and Exports
   ===================================================================== */

function handleFatalError(error) {
  console.error(
    "fetch-intraday-h1.js failed:",
    error instanceof Error
      ? error.stack ||
        error.message
      : String(error)
  );

  process.exitCode = 1;
}

if (require.main === module) {
  main().catch(
    handleFatalError
  );
}

module.exports = Object.freeze({
  FILE_VERSION,
  SOURCE_NAME,
  INTERVAL,
  OUTPUT_SIZE,
  MAX_STORED_CANDLES,
  MAX_REQUESTS_PER_RUN,
  STALE_AFTER_HOURS,
  SYMBOLS,
  normalizeTimestamp,
  timestampToMs,
  timestampFromMs,
  isAlignedH1Timestamp,
  getH1CandleTimeState,
  ageHoursFromStart,
  closeAgeHours,
  normalizeCandle,
  normalizeCandles,
  analyzeTimeGaps,
  mergeCandleRows,
  aggregateClosedH1ToH4,
  buildProviderUrl,
  fetchJsonOnce,
  fetchH1,
  validateCompletedOutput,
  resetRequestBudget,
  main
});
