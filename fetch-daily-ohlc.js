"use strict";

/**
 * fetch-daily-ohlc.js
 *
 * Fetches daily OHLC history for:
 *   - XAU/USD
 *   - GBP/JPY
 *
 * Writes:
 *   data/daily-ohlc.json
 *
 * Integration contract
 * --------------------
 * Direct top-level candle arrays remain available:
 *
 *   {
 *     XAUUSD: [...],
 *     GBPJPY: [...]
 *   }
 *
 * This preserves compatibility with:
 *   - run-live-analysis.js
 *   - fetch-signals.js
 *   - index.html
 *   - Existing GitHub workflows
 *
 * FREE-TIER SAFETY
 * ----------------
 * - Exactly one Twelve Data request per symbol.
 * - Maximum two provider requests per execution.
 * - No automatic HTTP retries.
 * - outputsize does not create additional requests.
 * - Existing cached data is preserved when a request fails.
 * - API credentials are never written to output or logs.
 * - Missing required datasets fail the workflow after diagnostics are written.
 * - Direct imports do not execute provider requests or overwrite output.
 * - Runtime dependencies can be injected for deterministic tests.
 *
 * Recommended schedule:
 *   Every 4 hours = 6 runs/day
 *   2 requests/run × 6 runs = 12 requests/day
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/* =====================================================================
   Configuration
   ===================================================================== */

const FILE_VERSION = "2.0.0";
const SOURCE_NAME = "Twelve Data";
const INTERVAL = "1day";

const API_BASE_URL =
  "https://api.twelvedata.com/time_series";

const API_KEY =
  typeof process.env.TWELVEDATA_API_KEY === "string"
    ? process.env.TWELVEDATA_API_KEY.trim()
    : "";

const DATA_DIR = path.join(
  __dirname,
  "data"
);

const OUTPUT_PATH = path.join(
  DATA_DIR,
  "daily-ohlc.json"
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
 * One time_series request can return the complete requested history.
 * It does not consume one request per candle.
 *
 * 500 daily candles provide sufficient data for:
 * - EMA 200
 * - Weekly resampling
 * - Market structure
 * - ATR
 * - ADX
 * - Support/resistance
 * - Candle-pattern analysis
 */
const OUTPUT_SIZE = 500;

/*
 * No retry is used because each retry may consume another API credit.
 */
const REQUEST_TIMEOUT_MS = 20_000;

/*
 * A short delay avoids sending both allowed requests as one burst.
 */
const REQUEST_GAP_MS = 1_000;

/*
 * Daily markets naturally have weekend and holiday gaps.
 */
const STALE_AFTER_DAYS = 4;

/*
 * Twelve Data 1day candles for both configured markets are labeled in
 * Australia/Sydney market time. Daily intervals ignore the timezone request
 * parameter, so closed/open classification must use the market calendar rather
 * than the runner's UTC calendar.
 */
const DAILY_MARKET_TIME_ZONE =
  "Australia/Sydney";

/*
 * Prevent unexpectedly large output files while retaining more history
 * than the normal provider request size.
 */
const MAX_STORED_CANDLES = 600;

/*
 * Fixed budget:
 * - XAU/USD: one request
 * - GBP/JPY: one request
 */
const MAX_REQUESTS_PER_RUN =
  SYMBOLS.length;

/* =====================================================================
   Runtime State
   ===================================================================== */

let requestsMade = 0;

/* =====================================================================
   Startup Validation
   ===================================================================== */

function validateStartupConfiguration(
  options = {}
) {
  const apiKey =
    typeof options.apiKey === "string"
      ? options.apiKey.trim()
      : API_KEY;

  if (!apiKey) {
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
      "MAX_STORED_CANDLES must be an integer greater than or equal to OUTPUT_SIZE."
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

  const seenKeys =
    new Set();

  for (const config of SYMBOLS) {
    if (
      !config ||
      typeof config !== "object" ||
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

    seenKeys.add(config.key);
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


function resolveRuntimeDate(
  value,
  label = "runtime date"
) {
  const date =
    value instanceof Date
      ? new Date(value.getTime())
      : new Date(value);

  if (!Number.isFinite(date.getTime())) {
    throw new TypeError(
      `${label} must be a valid Date-compatible value.`
    );
  }

  return date;
}

function resolveFetchImplementation(
  fetchImpl
) {
  const resolved =
    typeof fetchImpl === "function"
      ? fetchImpl
      : globalThis.fetch;

  if (typeof resolved !== "function") {
    throw new Error(
      "A Fetch API implementation is required."
    );
  }

  return resolved;
}

function redactSensitiveText(
  value,
  apiKey = API_KEY
) {
  let text =
    String(value ?? "Unknown error");

  const normalizedKey =
    typeof apiKey === "string"
      ? apiKey.trim()
      : "";

  if (normalizedKey) {
    text = text
      .split(normalizedKey)
      .join("[REDACTED]");
  }

  return text
    .replace(
      /([?&]apikey=)[^&\\s]+/gi,
      "$1[REDACTED]"
    )
    .replace(
      /(TWELVEDATA_API_KEY\\s*[=:]\\s*)[^\\s]+/gi,
      "$1[REDACTED]"
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

/* =====================================================================
   Date Helpers
   ===================================================================== */

function safeIsoDate(value) {
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
        /^(\d{4})-(\d{2})-(\d{2})(?:\s|T|$)/
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

  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return null;
  }

  const timestamp =
    Date.UTC(
      year,
      month - 1,
      day
    );

  const date =
    new Date(timestamp);

  /*
   * Date.UTC normalizes impossible dates. Round-trip checks reject them.
   */
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return [
    String(year).padStart(4, "0"),
    String(month).padStart(2, "0"),
    String(day).padStart(2, "0")
  ].join("-");
}

function currentUtcDate(
  now = new Date()
) {
  return resolveRuntimeDate(
    now,
    "Current UTC date"
  )
    .toISOString()
    .slice(0, 10);
}

function currentMarketDate(
  now = new Date()
) {
  const current =
    resolveRuntimeDate(
      now,
      "Current daily-market date"
    );

  const parts =
    new Intl.DateTimeFormat(
      "en-US",
      {
        timeZone:
          DAILY_MARKET_TIME_ZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }
    ).formatToParts(current);

  const byType =
    Object.fromEntries(
      parts.map(part => [
        part.type,
        part.value
      ])
    );

  const normalized =
    safeIsoDate(
      `${byType.year}-${byType.month}-${byType.day}`
    );

  if (!normalized) {
    throw new Error(
      "Could not resolve the current Australia/Sydney daily-market date."
    );
  }

  return normalized;
}

function calendarAgeDays(
  dateString,
  now = new Date()
) {
  const normalized =
    safeIsoDate(dateString);

  if (!normalized) {
    return null;
  }

  const candleTime =
    Date.parse(
      `${normalized}T00:00:00.000Z`
    );

  if (!Number.isFinite(candleTime)) {
    return null;
  }

  const marketDate =
    currentMarketDate(now);

  const marketDateTime =
    Date.parse(
      `${marketDate}T00:00:00.000Z`
    );

  if (!Number.isFinite(marketDateTime)) {
    return null;
  }

  return Math.max(
    0,
    Math.floor(
      (marketDateTime - candleTime) /
      86_400_000
    )
  );
}

function isPossiblyOpenCandle(
  dateString,
  now = new Date()
) {
  return (
    safeIsoDate(dateString) ===
    currentMarketDate(now)
  );
}

/* =====================================================================
   Safe JSON File Handling
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

  const randomSuffix =
    crypto
      .randomBytes(8)
      .toString("hex");

  const temporaryPath =
    `${filePath}.${process.pid}.${Date.now()}.${randomSuffix}.tmp`;

  const serialized =
    `${JSON.stringify(value, null, 2)}\n`;

  try {
    fs.writeFileSync(
      temporaryPath,
      serialized,
      {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx"
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

  const date =
    safeIsoDate(
      raw.datetime ??
      raw.date
    );

  if (!date) {
    return {
      candle: null,
      reason: "invalid-date"
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
      date,
      open,
      high,
      low,
      close
    },

    reason: null
  };
}

function buildEmptyQuality(
  rejectedReasons = {}
) {
  return {
    receivedRows: 0,
    validRows: 0,
    rejectedRows: 0,
    duplicateDates: 0,
    rejectedReasons,
    firstDate: null,
    lastDate: null,
    ageDays: null,
    stale: true
  };
}

function normalizeCandles(
  values,
  options = {}
) {
  const now =
    resolveRuntimeDate(
      options.now ?? new Date(),
      "Candle normalization time"
    );

  if (!Array.isArray(values)) {
    return {
      rows: [],

      quality:
        buildEmptyQuality({
          "values-not-array": 1
        })
    };
  }

  const candlesByDate =
    new Map();

  const marketDate =
    currentMarketDate(now);

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

    /*
     * Twelve Data labels 1day bars in the market calendar. For the two
     * configured markets that calendar is Australia/Sydney. The bar carrying
     * today's market date is still forming and any later label is invalid.
     *
     * Daily analysis must use completed D1 candles only. This also removes an
     * open/future candle inherited from cache.
     */
    if (result.candle.date > marketDate) {
      rejectedCount++;

      rejectedReasons["future-candle"] =
        (
          rejectedReasons["future-candle"] ||
          0
        ) + 1;

      continue;
    }

    if (result.candle.date === marketDate) {
      rejectedCount++;

      rejectedReasons["open-candle"] =
        (
          rejectedReasons["open-candle"] ||
          0
        ) + 1;

      continue;
    }

    const { date } =
      result.candle;

    if (candlesByDate.has(date)) {
      duplicateCount++;
    }

    /*
     * The last valid occurrence replaces an earlier duplicate date.
     */
    candlesByDate.set(
      date,
      result.candle
    );
  }

  const uniqueRows =
    Array.from(
      candlesByDate.values()
    ).sort(
      (left, right) =>
        left.date.localeCompare(
          right.date
        )
    );

  const rows =
    uniqueRows.slice(
      -MAX_STORED_CANDLES
    );

  const firstDate =
    rows[0]?.date ??
    null;

  const lastDate =
    rows.at(-1)?.date ??
    null;

  const ageDays =
    calendarAgeDays(
      lastDate,
      now
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

      duplicateDates:
        duplicateCount,

      rejectedReasons,

      firstDate,
      lastDate,
      ageDays,

      stale:
        ageDays === null ||
        ageDays > STALE_AFTER_DAYS
    }
  };
}

/* =====================================================================
   Previous-Data Recovery
   ===================================================================== */

function getPreviousRows(
  previousOutput,
  key,
  options = {}
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
      previousOutput[key],
      options
    ).rows;
  }

  /*
   * Forward-compatible nested format:
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
      nestedRows,
      options
    ).rows;
  }

  return [];
}

/* =====================================================================
   Cache Merge
   ===================================================================== */

function mergeCandleRows(
  previousRows,
  freshRows,
  options = {}
) {
  /*
   * Cached rows are inserted first and fresh rows second.
   * A fresh candle therefore replaces the cached candle for the same date.
   */
  return normalizeCandles(
    [
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
    ],
    options
  );
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
  apiKey = API_KEY
) {
  return redactSensitiveText(
    errorMessageOf(error),
    apiKey
  );
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


function resetRequestCounter() {
  requestsMade = 0;
}

function getRequestsMade() {
  return requestsMade;
}

function buildProviderUrl(
  symbol,
  apiKey = API_KEY
) {
  const normalizedKey =
    typeof apiKey === "string"
      ? apiKey.trim()
      : "";

  if (!normalizedKey) {
    throw new Error(
      "Cannot build Twelve Data URL without an API key."
    );
  }

  const url =
    new URL(API_BASE_URL);

  url.search =
    new URLSearchParams({
      symbol,
      interval: INTERVAL,
      outputsize:
        String(OUTPUT_SIZE),
      apikey:
        normalizedKey
    }).toString();

  return url;
}

/* =====================================================================
   Single-Request JSON Fetch
   ===================================================================== */

async function fetchJsonOnce(
  url,
  timeoutOrOptions = REQUEST_TIMEOUT_MS,
  legacyOptions = {}
) {
  const options =
    isRecord(timeoutOrOptions)
      ? timeoutOrOptions
      : legacyOptions;

  const timeoutMs =
    isRecord(timeoutOrOptions)
      ? (
          Number.isInteger(options.timeoutMs)
            ? options.timeoutMs
            : REQUEST_TIMEOUT_MS
        )
      : timeoutOrOptions;

  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs <= 0
  ) {
    throw new TypeError(
      "Request timeout must be a positive integer."
    );
  }

  const fetchImpl =
    resolveFetchImplementation(
      options.fetchImpl
    );

  const apiKey =
    typeof options.apiKey === "string"
      ? options.apiKey.trim()
      : API_KEY;

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

    if (
      !response ||
      typeof response.text !== "function" ||
      typeof response.ok !== "boolean"
    ) {
      throw new Error(
        "Twelve Data returned an invalid HTTP response object."
      );
    }

    /*
     * The response body is read exactly once so provider errors can be
     * interpreted without issuing another request.
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
   Twelve Data Daily Fetch
   ===================================================================== */

async function fetchDaily(
  config,
  options = {}
) {
  const apiKey =
    typeof options.apiKey === "string"
      ? options.apiKey.trim()
      : API_KEY;

  const now =
    resolveRuntimeDate(
      options.now ?? new Date(),
      "Daily-fetch reference time"
    );

  const url =
    buildProviderUrl(
      config.symbol,
      apiKey
    );

  const payload =
    await fetchJsonOnce(
      url,
      {
        timeoutMs:
          options.timeoutMs ??
          REQUEST_TIMEOUT_MS,
        fetchImpl:
          options.fetchImpl,
        apiKey
      }
    );

  /*
   * Twelve Data may return HTTP 200 with an API-level error payload.
   */
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
      {
        now
      }
    );

  if (normalized.rows.length === 0) {
    throw new Error(
      `No valid daily OHLC candles returned for ${config.symbol}.`
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
  now = new Date()
}) {
  const firstDate =
    rows[0]?.date ??
    null;

  const lastDate =
    rows.at(-1)?.date ??
    null;

  const ageDays =
    calendarAgeDays(
      lastDate,
      now
    );

  return {
    symbol:
      config.symbol,

    key:
      config.key,

    label:
      config.label,

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

    firstDate,
    lastDate,
    ageDays,

    stale:
      !fetchSucceeded ||
      rows.length === 0 ||
      finalQuality.stale,

    possiblyOpenLastCandle:
      isPossiblyOpenCandle(
        lastDate,
        now
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

    version:
      FILE_VERSION,

    source:
      SOURCE_NAME,

    interval:
      INTERVAL,

    outputSizeRequested:
      OUTPUT_SIZE,

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
  fetched,
  options = {}
) {
  const now =
    resolveRuntimeDate(
      options.now ?? new Date(),
      "Successful-result reference time"
    );

  const merged =
    mergeCandleRows(
      previousRows,
      fetched.rows,
      {
        now
      }
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
        fetched.provider,

      now
    });

  return merged;
}

function storeFailedResult(
  output,
  config,
  previousRows,
  error,
  options = {}
) {
  const apiKey =
    typeof options.apiKey === "string"
      ? options.apiKey.trim()
      : API_KEY;

  const now =
    resolveRuntimeDate(
      options.now ?? new Date(),
      "Failed-result reference time"
    );

  const message =
    sanitizeRequestError(
      error,
      apiKey
    );

  const cached =
    normalizeCandles(
      previousRows,
      {
        now
      }
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
        null,

      now
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
  options = {}
) {
  const now =
    resolveRuntimeDate(
      options.now ?? new Date(),
      "Output-validation reference time"
    );

  if (!isRecord(output)) {
    throw new Error(
      "Completed daily OHLC output must be a JSON object."
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
        {
          now
        }
      );

    if (
      normalized.rows.length !==
      rows.length
    ) {
      throw new Error(
        `${config.key} output contains invalid or duplicate candles.`
      );
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

  return output;
}

/* =====================================================================
   Symbol Processing
   ===================================================================== */

async function processSymbol({
  output,
  previousOutput,
  config,
  fetchImpl,
  apiKey = API_KEY,
  now = new Date()
}) {
  const referenceTime =
    resolveRuntimeDate(
      now,
      `${config.key} processing time`
    );

  const previousRows =
    getPreviousRows(
      previousOutput,
      config.key,
      {
        now:
          referenceTime
      }
    );

  console.log(
    `Fetching ${config.symbol} daily OHLC ` +
    `(${requestsMade + 1}/${MAX_REQUESTS_PER_RUN})...`
  );

  try {
    /*
     * Exactly one provider request is permitted for this symbol.
     */
    const fetched =
      await fetchDaily(
        config,
        {
          fetchImpl,
          apiKey,
          now:
            referenceTime
        }
      );

    const merged =
      storeSuccessfulResult(
        output,
        config,
        previousRows,
        fetched,
        {
          now:
            referenceTime
        }
      );

    console.log(
      `Fetched ${fetched.rows.length} valid candles for ` +
      `${config.symbol}; stored ${merged.rows.length} total candles.`
    );
  } catch (error) {
    const failed =
      storeFailedResult(
        output,
        config,
        previousRows,
        error,
        {
          apiKey,
          now:
            referenceTime
        }
      );

    console.error(
      `Failed to fetch ${config.symbol}: ${failed.message}`
    );

    /*
     * No retry is attempted. Cached data is used immediately so the
     * execution remains inside the fixed provider request budget.
     */
    if (failed.fallbackUsed) {
      console.warn(
        `Using ${failed.cachedRows.length} cached candles for ` +
        `${config.symbol}.`
      );
    } else {
      console.warn(
        `No cached data is available for ${config.symbol}.`
      );
    }
  }
}

/* =====================================================================
   Run Summary
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

  if (output.failureCount > 0) {
    console.warn(
      `Completed with ${output.failureCount} fetch failure(s); ` +
      "cached data was preserved where available."
    );
  }
}

function assertRequiredDataAvailable(
  output
) {
  const missingKeys =
    SYMBOLS
      .filter(
        config =>
          !Array.isArray(
            output?.[config.key]
          ) ||
          output[config.key].length === 0
      )
      .map(
        config =>
          config.key
      );

  if (missingKeys.length > 0) {
    throw new Error(
      "Required daily OHLC data is unavailable for: " +
      missingKeys.join(", ") +
      ". Diagnostic output was written, but the workflow is failing closed."
    );
  }

  return true;
}

/* =====================================================================
   Main Worker
   ===================================================================== */

async function main(
  options = {}
) {
  const apiKey =
    typeof options.apiKey === "string"
      ? options.apiKey.trim()
      : API_KEY;

  const fetchImpl =
    resolveFetchImplementation(
      options.fetchImpl
    );

  const sleepImpl =
    typeof options.sleepImpl === "function"
      ? options.sleepImpl
      : sleep;

  const nowProvider =
    typeof options.now === "function"
      ? options.now
      : () => new Date();

  const outputPath =
    typeof options.outputPath === "string" &&
    options.outputPath.trim()
      ? options.outputPath
      : OUTPUT_PATH;

  const dataDir =
    typeof options.dataDir === "string" &&
    options.dataDir.trim()
      ? options.dataDir
      : path.dirname(outputPath);

  resetRequestCounter();

  validateStartupConfiguration({
    apiKey
  });

  const startedAt =
    resolveRuntimeDate(
      nowProvider(),
      "Run start time"
    );

  fs.mkdirSync(
    dataDir,
    {
      recursive: true
    }
  );

  const previousOutput =
    readJsonFile(
      outputPath,
      {}
    );

  /*
   * Direct top-level arrays remain part of the permanent integration
   * contract for existing analysis engines and frontend consumers.
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
    const processingTime =
      resolveRuntimeDate(
        nowProvider(),
        `${SYMBOLS[index].key} processing time`
      );

    await processSymbol({
      output,
      previousOutput,
      config:
        SYMBOLS[index],
      fetchImpl,
      apiKey,
      now:
        processingTime
    });

    /*
     * A short gap avoids a burst while making no additional API request.
     */
    if (
      index <
      SYMBOLS.length - 1
    ) {
      await sleepImpl(
        REQUEST_GAP_MS
      );
    }
  }

  const completedAt =
    resolveRuntimeDate(
      nowProvider(),
      "Run completion time"
    );

  finalizeOutput(
    output,
    startedAt,
    completedAt
  );

  validateCompletedOutput(
    output,
    {
      now:
        completedAt
    }
  );

  /*
   * Atomic replacement prevents downstream workers from reading a
   * partially written daily-ohlc.json file.
   */
  atomicWriteJson(
    outputPath,
    output
  );

  logRunSummary(
    output,
    outputPath
  );

  /*
   * Preserve diagnostics, then fail closed when a required symbol has
   * neither a successful fetch nor usable cached candles.
   */
  assertRequiredDataAvailable(
    output
  );

  return output;
}

/* =====================================================================
   Process-Level Error Handling
   ===================================================================== */

function logFatalError(
  error,
  options = {}
) {
  const apiKey =
    typeof options.apiKey === "string"
      ? options.apiKey.trim()
      : API_KEY;

  const rawMessage =
    error instanceof Error
      ? error.stack ||
        error.message
      : String(error);

  console.error(
    "fetch-daily-ohlc.js failed:",
    redactSensitiveText(
      rawMessage,
      apiKey
    )
  );
}

/* =====================================================================
   Direct-Execution Guard
   ===================================================================== */

if (require.main === module) {
  main().catch(error => {
    logFatalError(error);
    process.exitCode = 1;
  });
}

/* =====================================================================
   Test and Integration Exports
   ===================================================================== */

module.exports = Object.freeze({
  FILE_VERSION,
  SOURCE_NAME,
  INTERVAL,
  API_BASE_URL,
  DATA_DIR,
  OUTPUT_PATH,
  SYMBOLS,
  OUTPUT_SIZE,
  REQUEST_TIMEOUT_MS,
  REQUEST_GAP_MS,
  STALE_AFTER_DAYS,
  MAX_STORED_CANDLES,
  MAX_REQUESTS_PER_RUN,

  validateStartupConfiguration,

  isRecord,
  isFiniteNumber,
  errorMessageOf,
  resolveRuntimeDate,
  resolveFetchImplementation,
  redactSensitiveText,
  sleep,
  parsePrice,

  safeIsoDate,
  currentUtcDate,
  calendarAgeDays,
  isPossiblyOpenCandle,

  readJsonFile,
  atomicWriteJson,

  normalizeCandle,
  buildEmptyQuality,
  normalizeCandles,
  getPreviousRows,
  mergeCandleRows,

  createProviderError,
  sanitizeRequestError,
  reserveProviderRequest,
  resetRequestCounter,
  getRequestsMade,
  buildProviderUrl,
  fetchJsonOnce,
  fetchDaily,

  buildSymbolMetadata,
  createInitialOutput,
  storeSuccessfulResult,
  storeFailedResult,
  validateCompletedOutput,
  processSymbol,
  finalizeOutput,
  logRunSummary,
  assertRequiredDataAvailable,
  main,
  logFatalError
});
