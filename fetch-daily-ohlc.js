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
 *
 * Recommended schedule:
 *   Every 4 hours = 6 runs/day
 *   2 requests/run × 6 runs = 12 requests/day
 */

const fs = require("fs");
const path = require("path");

const {
  createMt5MarketDataAdapter
} = require("./mt5/mt5-market-data-adapter");

/* =====================================================================
   Configuration
   ===================================================================== */

const FILE_VERSION = "2.0.0";
const SOURCE_NAME = "Twelve Data";
const MT5_SOURCE_NAME = "MT5_BROKER";
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

const mt5MarketDataAdapter =
  createMt5MarketDataAdapter();

let requestsMade = 0;

/* =====================================================================
   Startup Validation
   ===================================================================== */

function validateStartupConfiguration() {
  if (!API_KEY) {
    console.warn(
      "TWELVEDATA_API_KEY is unavailable; Twelve Data fallback is disabled."
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

function currentUtcDate() {
  return new Date()
    .toISOString()
    .slice(0, 10);
}

function calendarAgeDays(dateString) {
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

  const now =
    new Date();

  const todayUtc =
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate()
    );

  return Math.max(
    0,
    Math.floor(
      (todayUtc - candleTime) /
      86_400_000
    )
  );
}

function isPossiblyOpenCandle(dateString) {
  return (
    safeIsoDate(dateString) ===
    currentUtcDate()
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

  const candlesByDate =
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

    /*
     * Twelve Data can return the current UTC daily candle
     * while it is still forming.
     *
     * Daily analysis must use completed D1 candles only.
     * This also removes an open candle inherited from cache.
     */
    if (
      isPossiblyOpenCandle(
        result.candle.date
      )
    ) {
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
      lastDate
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
   * Cached rows are inserted first and fresh rows second.
   * A fresh candle therefore replaces the cached candle for the same date.
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
  if (!API_KEY) {
    throw new Error(
      "Missing TWELVEDATA_API_KEY environment variable."
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
      sanitizeRequestError(error)
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
  config
) {
  const url =
    buildProviderUrl(
      config.symbol
    );

  const payload =
    await fetchJsonOnce(
      url
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
      payload.values
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
   MT5 Primary / Twelve Data Fallback
   ===================================================================== */

async function fetchPrimaryDaily(
  config
) {
  const mt5Result =
    mt5MarketDataAdapter
      .getDailyRows(
        config.key,
        {
          limit:
            OUTPUT_SIZE,

          minimumRows:
            200
        }
      );

  if (mt5Result.available) {
    const normalized =
      normalizeCandles(
        mt5Result.data
      );

    if (
      normalized.rows.length === 0
    ) {
      throw new Error(
        `MT5 returned no valid daily candles for ${config.symbol}.`
      );
    }

    return {
      rows:
        normalized.rows,

      quality:
        normalized.quality,

      source:
        MT5_SOURCE_NAME,

      fallbackUsed:
        false,

      primaryFailure:
        null,

      provider: {
        name:
          MT5_SOURCE_NAME,

        symbol:
          config.key,

        brokerSymbol:
          mt5Result.metadata
            ?.brokerSymbol ||
          null,

        interval:
          "D1",

        availableRows:
          mt5Result.metadata
            ?.availableRows ??
          normalized.rows.length,

        storedRows:
          mt5Result.metadata
            ?.storedRows ??
          normalized.rows.length,

        latestOpenTimeUtc:
          mt5Result.metadata
            ?.latestOpenTimeUtc ||
          null,

        latestCloseTimeUtc:
          mt5Result.metadata
            ?.latestCloseTimeUtc ||
          null,

        ageMs:
          mt5Result.metadata
            ?.ageMs ??
          null,

        stale:
          Boolean(
            mt5Result.metadata
              ?.stale
          )
      }
    };
  }

  const primaryFailure = {
    source:
      MT5_SOURCE_NAME,

    reason:
      mt5Result.reason ||
      "MT5_UNAVAILABLE",

    metadata:
      mt5Result.metadata ||
      null
  };

  console.warn(
    `MT5 primary unavailable for ${config.symbol}: ` +
    `${primaryFailure.reason}. Using Twelve Data fallback.`
  );

  const fallback =
    await fetchDaily(
      config
    );

  return {
    ...fallback,

    source:
      SOURCE_NAME,

    fallbackUsed:
      true,

    primaryFailure
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
  const firstDate =
    rows[0]?.date ??
    null;

  const lastDate =
    rows.at(-1)?.date ??
    null;

  const ageDays =
    calendarAgeDays(
      lastDate
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
        lastDate
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
        fetched.source,

      fetchSucceeded:
        true,

      fallbackUsed:
        fetched.fallbackUsed,

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
        rows
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
    `Loading ${config.symbol} daily OHLC ` +
    `(MT5 primary, Twelve Data fallback)...`
  );

  try {
    /*
     * MT5 is primary. The existing Twelve Data function remains the
     * automatic provider fallback and still uses at most one request.
     */
    const fetched =
      await fetchPrimaryDaily(
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
      `Loaded ${fetched.rows.length} valid daily candles from ` +
      `${fetched.source} for ${config.symbol}; ` +
      `stored ${merged.rows.length} total candles.`
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
          ]?.source ===
          "local-cache"
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
  output
) {
  console.log(
    `Wrote ${OUTPUT_PATH}`
  );

  console.log(
    `Twelve Data fallback requests used: ` +
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
    await processSymbol({
      output,
      previousOutput,
      config:
        SYMBOLS[index]
    });

    /*
     * A short gap avoids a burst while making no additional API request.
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
   * partially written daily-ohlc.json file.
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
    "fetch-daily-ohlc.js failed:",
    error instanceof Error
      ? error.stack ||
        error.message
      : String(error)
  );

  process.exitCode = 1;
});
