"use strict";

/**
 * fetch-scalp-candles.js
 *
 * Fetches clean 5-minute OHLC candles for:
 *   - XAU/USD
 *   - GBP/JPY
 *
 * Writes:
 *   data/scalp-candles.json
 *
 * PROFESSIONAL SCALP DATA LAYER
 * --------------------------------
 * - Strict OHLC validation
 * - Duplicate candle removal
 * - Chronological sorting
 * - Closed/open candle metadata
 * - Gap diagnostics
 * - Safe cache recovery
 * - Atomic JSON writes
 * - Maximum two API requests per run
 * - No automatic API retries
 *
 * Important:
 * This file only provides reliable candle data.
 * Trading decisions belong in the scalp analysis engine.
 */

const fs = require("fs");
const path = require("path");

/* =====================================================================
   Configuration
   ===================================================================== */

const FILE_VERSION = "2.0.0";
const SOURCE_NAME = "Twelve Data";

const INTERVAL = "5min";
const INTERVAL_MINUTES = 5;
const INTERVAL_MS = INTERVAL_MINUTES * 60 * 1000;

const API_KEY =
  process.env.TWELVEDATA_API_KEY;

const DATA_DIR =
  path.join(
    __dirname,
    "data"
  );

const OUTPUT_PATH =
  path.join(
    DATA_DIR,
    "scalp-candles.json"
  );

const SYMBOLS = [
  {
    symbol: "XAU/USD",
    key: "XAUUSD",
    label: "XAU/USD"
  },
  {
    symbol: "GBP/JPY",
    key: "GBPJPY",
    label: "GBP/JPY"
  }
];

/*
 * Preserve existing provider usage.
 *
 * 300 × 5-minute candles gives enough recent data for:
 * - 5-minute indicators
 * - 15-minute aggregation
 * - 30-minute aggregation
 * - Recent support/resistance
 * - ATR and market structure
 *
 * Higher-timeframe context should come from intraday-h1.json rather than
 * increasing requests or fetching additional intervals.
 */
const OUTPUT_SIZE = 300;

/*
 * Cache merge may temporarily retain a little more history.
 */
const MAX_STORED_CANDLES = 360;

/*
 * Free-tier safety:
 *
 * Exactly one request per configured symbol.
 * No automatic retries.
 */
const MAX_REQUESTS_PER_RUN =
  SYMBOLS.length;

const REQUEST_TIMEOUT_MS = 20_000;
const REQUEST_GAP_MS = 1_000;

/*
 * 5-minute data should normally be relatively fresh.
 *
 * Fetch failure is always marked stale regardless of candle age.
 * Weekend and closed-market periods are exposed through metadata.
 */
const STALE_AFTER_MINUTES = 30;

/*
 * Maximum samples stored in gap diagnostics.
 */
const MAX_GAP_SAMPLES = 20;

let requestsMade = 0;

/* =====================================================================
   Startup Validation
   ===================================================================== */

if (!API_KEY) {
  console.error(
    "Missing TWELVEDATA_API_KEY environment variable."
  );

  process.exit(1);
}

/* =====================================================================
   Generic Helpers
   ===================================================================== */

function isFiniteNumber(value) {
  return (
    typeof value === "number" &&
    Number.isFinite(value)
  );
}

function sleep(milliseconds) {
  return new Promise(resolve => {
    setTimeout(
      resolve,
      milliseconds
    );
  });
}

function parsePrice(value) {
  const parsed =
    Number.parseFloat(value);

  return Number.isFinite(parsed)
    ? parsed
    : null;
}

function pad2(value) {
  return String(value)
    .padStart(2, "0");
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

/* =====================================================================
   Timestamp Handling
   ===================================================================== */

/*
 * Twelve Data typically returns:
 *
 * YYYY-MM-DD HH:mm:ss
 *
 * Preserve this output format for frontend compatibility.
 */
function normalizeTimestamp(value) {
  if (
    typeof value !== "string" ||
    value.trim() === ""
  ) {
    return null;
  }

  const trimmed =
    value.trim();

  const match =
    trimmed.match(
      /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/
    );

  if (!match) {
    return null;
  }

  const year =
    Number(match[1]);

  const month =
    Number(match[2]);

  const day =
    Number(match[3]);

  const hour =
    Number(match[4]);

  const minute =
    Number(match[5]);

  const second =
    Number(match[6] || 0);

  if (
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
    `${year}-${pad2(month)}-${pad2(day)} ` +
    `${pad2(hour)}:${pad2(minute)}:${pad2(second)}`
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

function ageMinutes(
  value,
  referenceTimeMs = Date.now()
) {
  const timestamp =
    timestampToMs(value);

  if (
    !Number.isFinite(timestamp) ||
    !Number.isFinite(referenceTimeMs)
  ) {
    return null;
  }

  return Math.max(
    0,
    (
      referenceTimeMs -
      timestamp
    ) /
    60_000
  );
}

/*
 * Twelve Data candle timestamps represent candle start time.
 *
 * A candle is safe for downstream analysis only when its full interval has
 * elapsed. Future timestamps are classified separately so they can never be
 * mistaken for closed data.
 */
function getCandleTimeState(
  time,
  referenceTimeMs = Date.now()
) {
  const candleTime =
    timestampToMs(time);

  if (
    !Number.isFinite(candleTime) ||
    !Number.isFinite(referenceTimeMs)
  ) {
    return "invalid";
  }

  if (candleTime > referenceTimeMs) {
    return "future";
  }

  if (
    candleTime +
      INTERVAL_MS >
    referenceTimeMs
  ) {
    return "open";
  }

  return "closed";
}

function isPossiblyOpenCandle(
  time,
  referenceTimeMs = Date.now()
) {
  return (
    getCandleTimeState(
      time,
      referenceTimeMs
    ) === "open"
  );
}

function isClosedCandle(
  time,
  referenceTimeMs = Date.now()
) {
  return (
    getCandleTimeState(
      time,
      referenceTimeMs
    ) === "closed"
  );
}

/*
 * Main output arrays are closed-candle-only. This helper remains defensive
 * for cached or externally supplied arrays.
 */
function countClosedCandles(
  rows,
  referenceTimeMs = Date.now()
) {
  if (!Array.isArray(rows)) {
    return 0;
  }

  return rows.reduce(
    (count, row) =>
      isClosedCandle(
        row?.time,
        referenceTimeMs
      )
        ? count + 1
        : count,
    0
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
      `Could not safely read ${filePath}: ${error.message}`
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

  const json =
    `${JSON.stringify(value, null, 2)}\n`;

  try {
    fs.writeFileSync(
      temporaryPath,
      json,
      "utf8"
    );

    fs.renameSync(
      temporaryPath,
      filePath
    );
  } catch (error) {
    try {
      if (
        fs.existsSync(
          temporaryPath
        )
      ) {
        fs.unlinkSync(
          temporaryPath
        );
      }
    } catch {
      // Keep the original write error.
    }

    throw error;
  }
}

/* =====================================================================
   Candle Validation
   ===================================================================== */

function normalizeCandle(
  raw,
  referenceTimeMs = Date.now()
) {
  if (
    !raw ||
    typeof raw !== "object"
  ) {
    return {
      candle: null,
      reason: "not-an-object"
    };
  }

  const safeReferenceTimeMs =
    Number.isFinite(referenceTimeMs)
      ? referenceTimeMs
      : Date.now();

  const time =
    normalizeTimestamp(
      raw.datetime ||
      raw.time
    );

  if (!time) {
    return {
      candle: null,
      reason: "invalid-time"
    };
  }

  const timeState =
    getCandleTimeState(
      time,
      safeReferenceTimeMs
    );

  if (timeState === "future") {
    return {
      candle: null,
      reason: "future-candle-time"
    };
  }

  if (timeState === "open") {
    return {
      candle: null,
      reason: "open-candle"
    };
  }

  if (timeState === "invalid") {
    return {
      candle: null,
      reason: "invalid-time"
    };
  }

  const open =
    parsePrice(raw.open);

  const high =
    parsePrice(raw.high);

  const low =
    parsePrice(raw.low);

  const close =
    parsePrice(raw.close);

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
      close
    },

    reason: null
  };
}

/* =====================================================================
   Gap and Continuity Diagnostics
   ===================================================================== */

function analyzeTimeGaps(rows) {
  let continuousIntervals = 0;
  let missingIntervalEstimate = 0;
  let largeGapCount = 0;
  let largestGapMinutes = 0;

  const samples = [];

  for (
    let index = 1;
    index < rows.length;
    index++
  ) {
    const previousTime =
      timestampToMs(
        rows[index - 1].time
      );

    const currentTime =
      timestampToMs(
        rows[index].time
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

    const gapMinutes =
      gapMs / 60_000;

    largestGapMinutes =
      Math.max(
        largestGapMinutes,
        gapMinutes
      );

    /*
     * Small tolerance handles provider timestamp variation.
     */
    if (
      gapMinutes >= 4 &&
      gapMinutes <= 6
    ) {
      continuousIntervals++;
      continue;
    }

    if (
      gapMinutes >
      INTERVAL_MINUTES
    ) {
      largeGapCount++;

      missingIntervalEstimate +=
        Math.max(
          0,
          Math.floor(
            gapMinutes /
            INTERVAL_MINUTES
          ) - 1
        );

      if (
        samples.length <
        MAX_GAP_SAMPLES
      ) {
        samples.push({
          from:
            rows[index - 1].time,

          to:
            rows[index].time,

          gapMinutes:
            round(
              gapMinutes,
              2
            )
        });
      }
    }
  }

  return {
    continuousIntervals,

    largeGapCount,

    missingIntervalEstimate,

    largestGapMinutes:
      round(
        largestGapMinutes,
        2
      ),

    sampleLargeGaps:
      samples
  };
}

/* =====================================================================
   Candle Collection Normalization
   ===================================================================== */

function normalizeCandles(
  values,
  referenceTimeMs = Date.now()
) {
  const byTime =
    new Map();

  const rejectedReasons = {};

  let rejectedCount = 0;
  let duplicateCount = 0;

  const safeReferenceTimeMs =
    Number.isFinite(referenceTimeMs)
      ? referenceTimeMs
      : Date.now();

  if (!Array.isArray(values)) {
    return {
      rows: [],

      quality: {
        receivedRows: 0,
        validRows: 0,
        rejectedRows: 0,
        duplicateTimes: 0,

        rejectedReasons: {
          "values-not-array": 1
        },

        firstTime: null,
        lastTime: null,
        ageMinutes: null,

        stale: true,

        possiblyOpenLastCandle:
          false,

        closedCandleCount:
          0,

        gaps: {
          continuousIntervals: 0,
          largeGapCount: 0,
          missingIntervalEstimate: 0,
          largestGapMinutes: 0,
          sampleLargeGaps: []
        }
      }
    };
  }

  for (const raw of values) {
    const result =
      normalizeCandle(
        raw,
        safeReferenceTimeMs
      );

    if (!result.candle) {
      rejectedCount++;

      rejectedReasons[
        result.reason
      ] =
        (
          rejectedReasons[
            result.reason
          ] ||
          0
        ) + 1;

      continue;
    }

    const time =
      result.candle.time;

    if (byTime.has(time)) {
      duplicateCount++;
    }

    /*
     * Freshest valid duplicate occurrence wins.
     */
    byTime.set(
      time,
      result.candle
    );
  }

  const rows =
    Array.from(
      byTime.values()
    )
      .sort(
        (a, b) =>
          timestampToMs(a.time) -
          timestampToMs(b.time)
      )
      .slice(
        -MAX_STORED_CANDLES
      );

  const firstTime =
    rows[0]?.time ||
    null;

  const lastTime =
    rows[
      rows.length - 1
    ]?.time ||
    null;

  const latestAgeMinutes =
    ageMinutes(
      lastTime,
      safeReferenceTimeMs
    );

  const openLastCandle =
    isPossiblyOpenCandle(
      lastTime,
      safeReferenceTimeMs
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

      rejectedReasons,

      firstTime,
      lastTime,

      ageMinutes:
        latestAgeMinutes == null
          ? null
          : round(
              latestAgeMinutes,
              2
            ),

      stale:
        latestAgeMinutes == null ||
        latestAgeMinutes >
          STALE_AFTER_MINUTES,

      possiblyOpenLastCandle:
        openLastCandle,

      closedCandleCount:
        countClosedCandles(
          rows,
          safeReferenceTimeMs
        ),

      gaps:
        analyzeTimeGaps(rows)
    }
  };
}

/* =====================================================================
   Previous Data Recovery
   ===================================================================== */

function getPreviousRows(
  previousOutput,
  key
) {
  if (
    !previousOutput ||
    typeof previousOutput !== "object"
  ) {
    return [];
  }

  /*
   * Existing output structure:
   *
   * {
   *   XAUUSD: [...],
   *   GBPJPY: [...]
   * }
   */
  if (
    Array.isArray(
      previousOutput[key]
    )
  ) {
    return normalizeCandles(
      previousOutput[key]
    ).rows;
  }

  /*
   * Optional nested compatibility.
   */
  const nestedRows =
    previousOutput
      ?.symbols
      ?.[key]
      ?.candles;

  if (Array.isArray(nestedRows)) {
    return normalizeCandles(
      nestedRows
    ).rows;
  }

  return [];
}

/* =====================================================================
   Provider Error Builder
   ===================================================================== */

function createProviderError(
  symbol,
  payload
) {
  const providerCode =
    payload &&
    typeof payload === "object"
      ? payload.code
      : null;

  const providerMessage =
    payload &&
    typeof payload === "object" &&
    typeof payload.message === "string"
      ? payload.message
      : "Unknown provider error";

  const error =
    new Error(
      `Twelve Data error for ${symbol}: ${providerMessage}`
    );

  error.providerCode =
    providerCode;

  error.providerPayload =
    payload;

  return error;
}

/* =====================================================================
   Free-Tier-Safe Single Request
   ===================================================================== */

async function fetchJsonOnce(
  url,
  timeoutMs = REQUEST_TIMEOUT_MS
) {
  if (
    requestsMade >=
    MAX_REQUESTS_PER_RUN
  ) {
    throw new Error(
      `Request safety limit reached: maximum ` +
      `${MAX_REQUESTS_PER_RUN} Twelve Data requests per run`
    );
  }

  requestsMade++;

  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () => controller.abort(),
      timeoutMs
    );

  try {
    const response =
      await fetch(
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

    let payload;

    try {
      payload =
        responseText
          ? JSON.parse(
              responseText
            )
          : null;
    } catch {
      throw new Error(
        `Twelve Data returned invalid JSON ` +
        `(HTTP ${response.status})`
      );
    }

    if (!response.ok) {
      const providerMessage =
        payload &&
        typeof payload.message ===
          "string"
          ? payload.message
          : `HTTP ${response.status}`;

      const error =
        new Error(
          `Twelve Data request failed: ${providerMessage}`
        );

      error.httpStatus =
        response.status;

      error.providerPayload =
        payload;

      throw error;
    }

    return payload;
  } catch (error) {
    if (
      error &&
      error.name ===
        "AbortError"
    ) {
      throw new Error(
        `Twelve Data request timed out after ${timeoutMs}ms`
      );
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/* =====================================================================
   Twelve Data 5-Minute Fetch
   ===================================================================== */

async function fetchCandles(symbol) {
  const params =
    new URLSearchParams({
      symbol,

      interval:
        INTERVAL,

      outputsize:
        String(OUTPUT_SIZE),

      timezone:
        "UTC",

      apikey:
        API_KEY
    });

  const url =
    `https://api.twelvedata.com/time_series?${params.toString()}`;

  /*
   * Exactly one API request is made for this symbol.
   */
  const payload =
    await fetchJsonOnce(url);

  if (
    !payload ||
    typeof payload !== "object"
  ) {
    throw new Error(
      `Empty or invalid Twelve Data response for ${symbol}`
    );
  }

  /*
   * Twelve Data may return HTTP 200 with an API error body.
   */
  if (
    payload.status === "error" ||
    payload.code != null
  ) {
    throw createProviderError(
      symbol,
      payload
    );
  }

  if (
    !Array.isArray(
      payload.values
    )
  ) {
    throw new Error(
      `Twelve Data response for ${symbol} does not contain a values array`
    );
  }

  const normalized =
    normalizeCandles(
      payload.values
    );

  if (
    normalized.rows.length === 0
  ) {
    throw new Error(
      `No valid 5-minute candles returned for ${symbol}`
    );
  }

  return {
    rows:
      normalized.rows,

    quality:
      normalized.quality,

    providerMeta: {
      symbol:
        payload.meta?.symbol ||
        symbol,

      interval:
        payload.meta?.interval ||
        INTERVAL,

      currencyBase:
        payload.meta
          ?.currency_base ||
        null,

      currencyQuote:
        payload.meta
          ?.currency_quote ||
        null,

      exchange:
        payload.meta?.exchange ||
        null,

      exchangeTimezone:
        payload.meta
          ?.exchange_timezone ||
        null,

      type:
        payload.meta?.type ||
        null
    }
  };
}

/* =====================================================================
   Cache Merge
   ===================================================================== */

function mergeCandleRows(
  previousRows,
  freshRows
) {
  const normalizedFresh =
    normalizeCandles(
      Array.isArray(freshRows)
        ? freshRows
        : []
    );

  /*
   * Defensive fallback:
   * if no usable fresh candles are available, preserve the
   * existing cached rows through the normal validation pipeline.
   */
  if (normalizedFresh.rows.length === 0) {
    return normalizeCandles(
      Array.isArray(previousRows)
        ? previousRows
        : []
    );
  }

  const firstFreshTime =
    timestampToMs(
      normalizedFresh.rows[0].time
    );

  /*
   * A successful fresh fetch is authoritative for its complete
   * time window.
   *
   * Keep only cached candles that are strictly older than the
   * first fresh candle. Cached candles overlapping the fresh
   * window—or incorrectly appearing after it—are discarded.
   */
  const safePreviousRows =
    Array.isArray(previousRows) &&
    Number.isFinite(firstFreshTime)
      ? previousRows.filter(row => {
          const previousTime =
            timestampToMs(
              row?.time
            );

          return (
            Number.isFinite(previousTime) &&
            previousTime < firstFreshTime
          );
        })
      : [];

  /*
   * normalizeCandles() retains the existing validation,
   * chronological sorting, duplicate handling, quality metadata
   * and MAX_STORED_CANDLES limit.
   */
  return normalizeCandles([
    ...safePreviousRows,
    ...normalizedFresh.rows
  ]);
}

/* =====================================================================
   Closed-Candle Helpers
   ===================================================================== */

function getClosedRows(
  rows,
  referenceTimeMs = Date.now()
) {
  if (!Array.isArray(rows)) {
    return [];
  }

  return rows.filter(
    row =>
      isClosedCandle(
        row?.time,
        referenceTimeMs
      )
  );
}

function getLatestClosedCandle(rows) {
  const closedRows =
    getClosedRows(rows);

  return (
    closedRows[
      closedRows.length - 1
    ] ||
    null
  );
}

/* =====================================================================
   Aggregation Readiness
   ===================================================================== */

function calculateAggregationReadiness(rows) {
  const closedRows =
    getClosedRows(rows);

  const closedCount =
    closedRows.length;

  return {
    fiveMinute: {
      availableCandles:
        closedCount,

      minimumRecommended:
        200,

      ready:
        closedCount >= 200
    },

    fifteenMinute: {
      estimatedCandles:
        Math.floor(
          closedCount / 3
        ),

      groupSize:
        3,

      minimumRecommended:
        100,

      ready:
        Math.floor(
          closedCount / 3
        ) >= 100
    },

    thirtyMinute: {
      estimatedCandles:
        Math.floor(
          closedCount / 6
        ),

      groupSize:
        6,

      minimumRecommended:
        50,

      ready:
        Math.floor(
          closedCount / 6
        ) >= 50
    }
  };
}

/* =====================================================================
   Professional Strategy Context Metadata
   ===================================================================== */

function buildStrategyContext(rows) {
  const closedRows =
    getClosedRows(rows);

  const latestClosed =
    getLatestClosedCandle(rows);

  return {
    dataOnly:
      true,

    strategyExecutedHere:
      false,

    recommendedEntryTimeframe:
      "5m",

    confirmationTimeframes: [
      "15m",
      "30m",
      "1h"
    ],

    useClosedCandlesOnly:
      true,

    latestClosedCandleTime:
      latestClosed?.time ||
      null,

    closedCandleCount:
      closedRows.length,

    aggregation:
      calculateAggregationReadiness(
        rows
      ),

    recommendedFilters: {
      higherTimeframeTrend:
        "H1 trend must align with trade direction",

      entryConfirmation:
        "5m candle close plus 15m momentum confirmation",

      volatility:
        "ATR must be inside a tradable range",

      structure:
        "Trade with HH/HL or LH/LL structure",

      supportResistance:
        "Avoid entries directly into nearby barriers",

      candlePattern:
        "Require rejection, engulfing or breakout confirmation",

      news:
        "Block conflicting high-impact news",

      riskReward:
        "Minimum planned reward should justify risk",

      duplicateProtection:
        "Do not issue repeated signals from the same candle"
    }
  };
}

/* =====================================================================
   Symbol Metadata Builder
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
  providerMeta
}) {
  const firstTime =
    rows[0]?.time ||
    null;

  const lastTime =
    rows[
      rows.length - 1
    ]?.time ||
    null;

  const latestAgeMinutes =
    ageMinutes(lastTime);

  const latestClosed =
    getLatestClosedCandle(rows);

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

    fetchSucceeded,

    fallbackUsed,

    error:
      errorMessage ||
      null,

    candleCount:
      rows.length,

    closedCandleCount:
      getClosedRows(rows).length,

    firstTime,

    lastTime,

    latestClosedTime:
      latestClosed?.time ||
      null,

    ageMinutes:
      latestAgeMinutes == null
        ? null
        : round(
            latestAgeMinutes,
            2
          ),

    stale:
      !fetchSucceeded ||
      rows.length === 0 ||
      finalQuality.stale,

    possiblyOpenLastCandle:
      isPossiblyOpenCandle(
        lastTime
      ),

    fetchedQuality:
      fetchedQuality ||
      null,

    quality:
      finalQuality,

    aggregationReadiness:
      calculateAggregationReadiness(
        rows
      ),

    strategyContext:
      buildStrategyContext(
        rows
      ),

    provider:
      providerMeta ||
      null
  };
}

/* =====================================================================
   Main Worker
   ===================================================================== */

async function main() {
  const startedAt =
    new Date();

  fs.mkdirSync(
    DATA_DIR,
    {
      recursive: true
    }
  );

  const previousOutput =
    readJsonFile(
      OUTPUT_PATH,
      {}
    );

  /*
   * Direct symbol arrays are preserved for full compatibility with the
   * existing frontend:
   *
   * {
   *   XAUUSD: [...],
   *   GBPJPY: [...]
   * }
   */
  const output = {
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
      M15: {
        source:
          "5m",

        grouping:
          3,

        extraApiRequests:
          0
      },

      M30: {
        source:
          "5m",

        grouping:
          6,

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

    strategyPolicy: {
      dataCollectorOnly:
        true,

      closedCandlesOnly:
        true,

      professionalScalpMode:
        true,

      weakThreeOfFiveDeprecated:
        true,

      recommendedDecisionModel:
        "weighted multi-timeframe confirmation"
    },

    stale: {},

    metadata: {},

    errors: []
  };

  for (
    let index = 0;
    index < SYMBOLS.length;
    index++
  ) {
    const config =
      SYMBOLS[index];

    const previousRows =
      getPreviousRows(
        previousOutput,
        config.key
      );

    try {
      console.log(
        `Fetching ${config.symbol} 5m OHLC ` +
        `(${requestsMade + 1}/${MAX_REQUESTS_PER_RUN})...`
      );

      const fetched =
        await fetchCandles(
          config.symbol
        );

      const merged =
        mergeCandleRows(
          previousRows,
          fetched.rows
        );

      output[
        config.key
      ] =
        merged.rows;

      output.stale[
        config.key
      ] =
        merged.quality.stale;

      output.metadata[
        config.key
      ] =
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

          providerMeta:
            fetched.providerMeta
        });

      console.log(
        `Fetched ${fetched.rows.length} valid 5m candles for ` +
        `${config.symbol}; stored ${merged.rows.length}, ` +
        `closed ${output.metadata[config.key].closedCandleCount}.`
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : String(error);

      console.error(
        `Failed to fetch ${config.symbol}: ${message}`
      );

      /*
       * No retry is performed. Cached data becomes the fallback.
       */
      const cached =
        normalizeCandles(
          previousRows
        );

      output[
        config.key
      ] =
        cached.rows;

      output.stale[
        config.key
      ] =
        true;

      output.metadata[
        config.key
      ] =
        buildSymbolMetadata({
          config,

          rows:
            cached.rows,

          source:
            cached.rows.length > 0
              ? "local-cache"
              : "unavailable",

          fetchSucceeded:
            false,

          fallbackUsed:
            cached.rows.length >
            0,

          errorMessage:
            message,

          fetchedQuality:
            null,

          finalQuality: {
            ...cached.quality,
            stale: true
          },

          providerMeta:
            null
        });

      output.errors.push({
        symbol:
          config.symbol,

        key:
          config.key,

        message,

        fallbackUsed:
          cached.rows.length >
          0,

        cachedCandleCount:
          cached.rows.length,

        cachedClosedCandleCount:
          getClosedRows(
            cached.rows
          ).length
      });

      if (
        cached.rows.length > 0
      ) {
        console.warn(
          `Using ${cached.rows.length} cached 5m candles for ` +
          `${config.symbol}.`
        );
      } else {
        console.warn(
          `No cached 5m candles are available for ${config.symbol}.`
        );
      }
    }

    /*
     * Reduces burst pressure without consuming extra credits.
     */
    if (
      index <
      SYMBOLS.length - 1
    ) {
      await sleep(
        REQUEST_GAP_MS
      );
    }
  }

  const completedAt =
    new Date();

  output.updatedAt =
    completedAt.toISOString();

  output.completedAt =
    completedAt.toISOString();

  output.durationMs =
    completedAt.getTime() -
    startedAt.getTime();

  output.requestsMade =
    requestsMade;

  output.requestLimitReached =
    requestsMade >=
    MAX_REQUESTS_PER_RUN;

  output.successCount =
    SYMBOLS.filter(
      config =>
        output.metadata[
          config.key
        ]?.fetchSucceeded
    ).length;

  output.failureCount =
    output.errors.length;

  /*
   * Atomic replacement protects the downstream scalp engine from a
   * partially written JSON file.
   */
  atomicWriteJson(
    OUTPUT_PATH,
    output
  );

  console.log(
    `Wrote ${OUTPUT_PATH}`
  );

  console.log(
    `Twelve Data requests used: ` +
    `${requestsMade}/${MAX_REQUESTS_PER_RUN}`
  );

  console.log(
    `Successful symbols: ` +
    `${output.successCount}/${SYMBOLS.length}`
  );

  if (
    output.failureCount > 0
  ) {
    console.warn(
      `Completed with ${output.failureCount} fetch failure(s); ` +
      "cached data was preserved where available."
    );
  }
}

/* =====================================================================
   Process-Level Error Handling
   ===================================================================== */

main().catch(error => {
  console.error(
    "fetch-scalp-candles.js failed:",
    error instanceof Error
      ? error.stack ||
        error.message
      : error
  );

  process.exitCode = 1;
});

