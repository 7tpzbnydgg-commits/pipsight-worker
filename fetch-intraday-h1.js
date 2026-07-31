"use strict";

/**
 * fetch-intraday-h1.js
 *
 * Fetches 1-hour OHLC history for:
 *   - XAU/USD
 *   - GBP/JPY
 *
 * Writes:
 *   data/intraday-h1.json
 *
 * Integration contract
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
 *   - Existing H4 aggregation logic
 *   - Existing frontend consumers
 *   - Existing GitHub workflow validation
 *
 * FREE-TIER SAFETY
 * ----------------
 * - Exactly one Twelve Data request per symbol.
 * - Maximum two provider requests per execution.
 * - No automatic retries.
 * - H4 remains derived locally from H1 candles.
 * - Existing cached data is retained when a request fails.
 * - API credentials are never written to output or logs.
 *
 * Recommended cadence:
 *   Every 15 minutes
 *
 * Normal request usage:
 *   2 requests/run × 96 runs/day = 192 requests/day
 */

const fs = require("fs");
const path = require("path");

/* =====================================================================
   Configuration
   ===================================================================== */

const FILE_VERSION = "2.0.0";
const SOURCE_NAME = "Twelve Data";
const INTERVAL = "1h";

const API_BASE_URL =
  "https://api.twelvedata.com/time_series";

const API_KEY =
  typeof process.env.TWELVEDATA_API_KEY === "string"
    ? process.env.TWELVEDATA_API_KEY.trim()
    : "";

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
 * 800 H1 candles provide approximately:
 *
 * - 33 calendar days for continuously traded markets
 * - Around 200 locally derived H4 candles
 *
 * The complete history remains one time_series request per symbol.
 */
const OUTPUT_SIZE = 800;

/*
 * Hard provider-request budget:
 *
 * XAU/USD = one request
 * GBP/JPY = one request
 */
const MAX_REQUESTS_PER_RUN =
  SYMBOLS.length;

/*
 * No retries are used because another request may consume another
 * provider credit.
 */
const REQUEST_TIMEOUT_MS = 20_000;

/*
 * A short gap prevents both allowed requests from being sent as one burst.
 */
const REQUEST_GAP_MS = 1_000;

/*
 * H1 data normally refreshes frequently.
 *
 * Weekends, holidays and market closures may naturally create older bars.
 * Failed fetches are always explicitly marked stale regardless of age.
 */
const STALE_AFTER_HOURS = 6;

/*
 * Retain slightly more history than the provider request while preventing
 * uncontrolled output growth after cache merging.
 */
const MAX_STORED_CANDLES = 900;

/*
 * Used for diagnostics only.
 *
 * Missing candles are never fabricated because valid gaps may represent:
 * - Weekends
 * - Holidays
 * - Provider maintenance
 * - Market closures
 */
const EXPECTED_INTERVAL_MS =
  60 * 60 * 1000;

/* =====================================================================
   Runtime State
   ===================================================================== */

let requestsMade = 0;

/* =====================================================================
   Startup Validation
   ===================================================================== */

function validateStartupConfiguration() {
  if (!API_KEY) {
    throw new Error(
      "Missing TWELVEDATA_API_KEY environment variable."
    );
  }

  if (
    !Number.isInteger(OUTPUT_SIZE) ||
    OUTPUT_SIZE <= 0
  ) {
    throw new Error(
      "OUTPUT_SIZE must be a positive integer."
    );
  }

  if (
    !Number.isInteger(MAX_STORED_CANDLES) ||
    MAX_STORED_CANDLES < OUTPUT_SIZE
  ) {
    throw new Error(
      "MAX_STORED_CANDLES must be greater than or equal to OUTPUT_SIZE."
    );
  }

  if (
    !Number.isInteger(REQUEST_TIMEOUT_MS) ||
    REQUEST_TIMEOUT_MS <= 0
  ) {
    throw new Error(
      "REQUEST_TIMEOUT_MS must be a positive integer."
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

  if (
    !Number.isInteger(STALE_AFTER_HOURS) ||
    STALE_AFTER_HOURS <= 0
  ) {
    throw new Error(
      "STALE_AFTER_HOURS must be a positive integer."
    );
  }

  if (
    !Number.isInteger(EXPECTED_INTERVAL_MS) ||
    EXPECTED_INTERVAL_MS <= 0
  ) {
    throw new Error(
      "EXPECTED_INTERVAL_MS must be a positive integer."
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
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
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

function pad2(value) {
  return String(value)
    .padStart(2, "0");
}

/* =====================================================================
   Timestamp Helpers
   ===================================================================== */

/*
 * Twelve Data normally returns intraday timestamps as:
 *
 *   YYYY-MM-DD HH:mm:ss
 *
 * This exact backward-compatible format remains in the output.
 *
 * Provider timestamps are treated consistently as UTC for:
 * - Ordering
 * - Freshness calculations
 * - Duplicate detection
 * - Gap analysis
 */
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
    Number(match[6] ?? 0);

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

  /*
   * Date.UTC normalizes impossible dates. Round-trip validation rejects
   * invalid timestamps such as 2026-02-31 10:00:00.
   */
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

function ageHours(value) {
  const timestamp =
    timestampToMs(value);

  if (!Number.isFinite(timestamp)) {
    return null;
  }

  return Math.max(
    0,
    (
      Date.now() -
      timestamp
    ) /
    EXPECTED_INTERVAL_MS
  );
}

function floorToHourMs(timestamp) {
  if (!Number.isFinite(timestamp)) {
    return null;
  }

  return (
    Math.floor(
      timestamp /
      EXPECTED_INTERVAL_MS
    ) *
    EXPECTED_INTERVAL_MS
  );
}

function isPossiblyOpenLastCandle(
  timeValue
) {
  const candleTimestamp =
    timestampToMs(
      timeValue
    );

  if (!Number.isFinite(candleTimestamp)) {
    return false;
  }

  return (
    candleTimestamp ===
    floorToHourMs(
      Date.now()
    )
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
      /*
       * Preserve the original filesystem error.
       */
    }

    throw error;
  }
}

/* =====================================================================
   Candle Validation
   ===================================================================== */

function normalizeCandle(raw) {
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

    const candleTimestamp =
    timestampToMs(
      time
    );

  const currentHourStart =
    floorToHourMs(
      Date.now()
    );

  if (
    !Number.isFinite(
      candleTimestamp
    ) ||
    !Number.isFinite(
      currentHourStart
    )
  ) {
    return {
      candle: null,
      reason: "invalid-time"
    };
  }

  /*
   * H1 timestamps represent candle opening times.
   *
   * A timestamp after the current UTC hour is future data and must never
   * enter indicators, cache merging or downstream analysis.
   */
  if (
    candleTimestamp >
      currentHourStart
  ) {
    return {
      candle: null,
      reason: "future-candle"
    };
  }

  /*
   * A candle stamped with the current UTC hour is still forming.
   * Only fully closed H1 candles are retained.
   */
  if (
    candleTimestamp ===
      currentHourStart
  ) {
    return {
      candle: null,
      reason: "open-candle"
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
   Data Quality Analysis
   ===================================================================== */

function createEmptyGapAnalysis() {
  return {
    normalGapCount: 0,
    largeGapCount: 0,
    largestGapHours: 0,
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

  let normalGapCount = 0;
  let largeGapCount = 0;
  let largestGapHours = 0;

  const sampleLargeGaps = [];

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

    const gapHours =
      gapMs /
      EXPECTED_INTERVAL_MS;

    largestGapHours =
      Math.max(
        largestGapHours,
        gapHours
      );

    if (gapHours <= 1.5) {
      normalGapCount++;
      continue;
    }

    /*
     * Gaps are recorded only. Missing bars are never created locally.
     */
    largeGapCount++;

    if (sampleLargeGaps.length < 20) {
      sampleLargeGaps.push({
        from:
          rows[index - 1].time,

        to:
          rows[index].time,

        hours:
          Number(
            gapHours.toFixed(2)
          )
      });
    }
  }

  return {
    normalGapCount,
    largeGapCount,

    largestGapHours:
      Number(
        largestGapHours.toFixed(2)
      ),

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
    rejectedReasons,
    firstTime: null,
    lastTime: null,
    ageHours: null,
    stale: true,
    gaps:
      createEmptyGapAnalysis()
  };
}

function normalizeCandles(values) {
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
      normalizeCandle(raw);

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

    /*
     * The latest valid occurrence replaces an earlier duplicate time.
     */
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

  const latestAgeHours =
    ageHours(
      lastTime
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

      ageHours:
        latestAgeHours === null
          ? null
          : Number(
              latestAgeHours.toFixed(2)
            ),

      stale:
        latestAgeHours === null ||
        latestAgeHours >
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
  key
) {
  if (!isRecord(previousOutput)) {
    return [];
  }

  /*
   * Existing production format:
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
   * Optional forward-compatible nested format:
   *
   * {
   *   symbols: {
   *     XAUUSD: {
   *       candles: [...]
   *     }
   *   }
   * }
   */
  const nestedRows =
    previousOutput
      .symbols
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
   Cache Merge
   ===================================================================== */

function mergeCandleRows(
  previousRows,
  freshRows
) {
  /*
   * Cached candles are inserted first and fresh candles second.
   * A fresh candle therefore replaces the cached candle for the same time.
   */
  return normalizeCandles([
    ...(
      Array.isArray(previousRows)
        ? previousRows
        : []
    ),

    ...(
      Array.isArray(freshRows)
        ? freshRows
        : []
    )
  ]);
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
  error
) {
  const message =
    errorMessageOf(error);

  if (!API_KEY) {
    return message;
  }

  return message
    .split(API_KEY)
    .join("[REDACTED]");
}

/* =====================================================================
   Free-Tier Request Control
   ===================================================================== */

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

function buildProviderUrl(symbol) {
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

      /*
       * Force provider timestamps to UTC.
       *
       * Without this parameter, Twelve Data may return timestamps in
       * an instrument/provider timezone while the downstream parser
       * correctly treats the stored integration format as UTC.
       */
      timezone:
        "UTC",

      apikey:
        API_KEY
    }).toString();

  return url;
}

/* =====================================================================
   Single-Request JSON Fetch
   ===================================================================== */

async function fetchJsonOnce(
  url,
  timeoutMs = REQUEST_TIMEOUT_MS
) {
  reserveProviderRequest();

  const controller =
    new AbortController();

  const timeoutHandle =
    setTimeout(
      () => {
        controller.abort();
      },
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

    /*
     * The response body is read exactly once. This avoids any accidental
     * additional provider request while preserving API error details.
     */
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
      sanitizeRequestError(error)
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
  config
) {
  const url =
    buildProviderUrl(
      config.symbol
    );

  /*
   * Exactly one provider request is permitted for this symbol.
   */
  const payload =
    await fetchJsonOnce(
      url
    );

  if (!isRecord(payload)) {
    throw new Error(
      `Empty or invalid Twelve Data response for ${config.symbol}.`
    );
  }

  /*
   * Twelve Data may return HTTP 200 with an API-level error payload.
   */
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
      payload.values
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
  provider
}) {
  const firstTime =
    rows[0]?.time ??
    null;

  const lastTime =
    rows.at(-1)?.time ??
    null;

  const latestAgeHours =
    ageHours(
      lastTime
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
      latestAgeHours === null
        ? null
        : Number(
            latestAgeHours.toFixed(2)
          ),

    stale:
      !fetchSucceeded ||
      rows.length === 0 ||
      finalQuality.stale,

    possiblyOpenLastCandle:
      isPossiblyOpenLastCandle(
        lastTime
      ),

    fetchedQuality:
      fetchedQuality ||
      null,

    quality:
      finalQuality,

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

    outputSizeRequested:
      OUTPUT_SIZE,

    derivedTimeframes: {
      H4: {
        source:
          "H1",

        grouping:
          4,

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

    stale: {},

    metadata: {},

    errors: []
  };
}

function storeSuccessfulResult(
  output,
  config,
  previousRows,
  fetched
) {
  const merged =
    mergeCandleRows(
      previousRows,
      fetched.rows
    );

  output[config.key] =
    merged.rows;

  output.stale[config.key] =
    merged.quality.stale;

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
        fetched.provider
    });

  return merged;
}

function storeFailedResult(
  output,
  config,
  previousRows,
  error
) {
  const message =
    sanitizeRequestError(
      error
    );

  const cached =
    normalizeCandles(
      previousRows
    );

  const fallbackUsed =
    cached.rows.length > 0;

  const finalQuality = {
    ...cached.quality,
    stale: true
  };

  output[config.key] =
    cached.rows;

  output.stale[config.key] =
    true;

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
        null
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
  output
) {
  if (!isRecord(output)) {
    throw new Error(
      "Completed intraday H1 output must be a JSON object."
    );
  }

  if (
    output.interval !==
    INTERVAL
  ) {
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
        rows
      );

    if (
      normalized.rows.length !==
      rows.length
    ) {
      throw new Error(
        `${config.key} output contains invalid or duplicate H1 candles.`
      );
    }

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
        !Number.isFinite(currentTime) ||
        currentTime <= previousTime
      ) {
        throw new Error(
          `${config.key} candles must be strictly chronological.`
        );
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
      metadata.key !==
      config.key
    ) {
      throw new Error(
        `${config.key} metadata key does not match its integration key.`
      );
    }

    if (
      metadata.symbol !==
      config.symbol
    ) {
      throw new Error(
        `${config.key} metadata symbol does not match ${config.symbol}.`
      );
    }
  }

  if (!Array.isArray(output.errors)) {
    throw new Error(
      "Output errors must be an array."
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
    !Number.isInteger(output.successCount) ||
    output.successCount < 0 ||
    output.successCount >
      SYMBOLS.length
  ) {
    throw new Error(
      "Output success count is invalid."
    );
  }

  if (
    !Number.isInteger(output.failureCount) ||
    output.failureCount < 0 ||
    output.failureCount >
      SYMBOLS.length
  ) {
    throw new Error(
      "Output failure count is invalid."
    );
  }

  if (
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
  config
}) {
  const previousRows =
    getPreviousRows(
      previousOutput,
      config.key
    );

  console.log(
    `Fetching ${config.symbol} H1 OHLC ` +
    `(${requestsMade + 1}/${MAX_REQUESTS_PER_RUN})...`
  );

  try {
    const fetched =
      await fetchH1(
        config
      );

    const merged =
      storeSuccessfulResult(
        output,
        config,
        previousRows,
        fetched
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
        error
      );

    console.error(
      `Failed to fetch ${config.symbol}: ${failed.message}`
    );

    /*
     * No retry is attempted. Cached candles are used immediately to keep
     * execution within the fixed two-request provider budget.
     */
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

  output.requestLimitReached =
    requestsMade >=
    MAX_REQUESTS_PER_RUN;

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
  output
) {
  console.log(
    `Wrote ${OUTPUT_PATH}`
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

async function main() {
  validateStartupConfiguration();

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
   * Direct top-level XAUUSD and GBPJPY arrays remain the permanent
   * integration contract for run-live-analysis.js and other consumers.
   */
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
        SYMBOLS[index]
    });

    /*
     * Avoid a two-request burst. No delay occurs after the final symbol.
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

  finalizeOutput(
    output,
    startedAt,
    completedAt
  );

  validateCompletedOutput(
    output
  );

  /*
   * Atomic replacement prevents downstream workers from reading a
   * partially written intraday-h1.json file.
   */
  atomicWriteJson(
    OUTPUT_PATH,
    output
  );

  logRunSummary(
    output
  );
}

/* =====================================================================
   Process-Level Error Handling
   ===================================================================== */

main().catch(error => {
  console.error(
    "fetch-intraday-h1.js failed:",
    error instanceof Error
      ? error.stack ||
        error.message
      : String(error)
  );

  process.exitCode = 1;
});
