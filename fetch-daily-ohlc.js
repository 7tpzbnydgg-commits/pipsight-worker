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
 * FREE-TIER SAFETY
 * ----------------
 * - Exactly one Twelve Data request per symbol.
 * - Maximum two API requests per execution.
 * - No automatic HTTP retries.
 * - outputsize does not create extra requests.
 * - Existing cached data is preserved when a request fails.
 *
 * Recommended schedule:
 *   Every 4 hours = 6 runs/day
 *   2 requests/run × 6 runs = 12 requests/day
 */

const fs = require("fs");
const path = require("path");

/* =====================================================================
   Configuration
   ===================================================================== */

const FILE_VERSION = "2.0.0";
const SOURCE_NAME = "Twelve Data";

const API_KEY = process.env.TWELVEDATA_API_KEY;

const DATA_DIR = path.join(
  __dirname,
  "data"
);

const OUTPUT_PATH = path.join(
  DATA_DIR,
  "daily-ohlc.json"
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
 * Twelve Data allows larger output sizes in one time_series request.
 * This remains one request per symbol.
 *
 * 500 daily candles provide enough history for:
 * - EMA 200
 * - Weekly resampling
 * - Market structure
 * - ATR
 * - Support/resistance
 * - Candle-pattern analysis
 */
const OUTPUT_SIZE = 500;

/*
 * No retries are used because every retry may consume another API credit.
 */
const REQUEST_TIMEOUT_MS = 20_000;

/*
 * Daily data normally changes only once per day.
 *
 * A file is marked stale after this many calendar days. A larger tolerance
 * is used because weekends and market holidays can create natural gaps.
 */
const STALE_AFTER_DAYS = 4;

/*
 * Safety limit preventing unexpectedly huge files.
 */
const MAX_STORED_CANDLES = 600;

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
    setTimeout(resolve, milliseconds);
  });
}

function safeIsoDate(value) {
  if (
    typeof value !== "string" ||
    value.trim() === ""
  ) {
    return null;
  }

  const trimmed =
    value.trim();

  /*
   * Twelve Data daily dates normally arrive as YYYY-MM-DD.
   */
  const match =
    trimmed.match(
      /^(\d{4})-(\d{2})-(\d{2})/
    );

  if (!match) {
    return null;
  }

  const normalized =
    `${match[1]}-${match[2]}-${match[3]}`;

  const timestamp =
    Date.parse(
      `${normalized}T00:00:00Z`
    );

  if (!Number.isFinite(timestamp)) {
    return null;
  }

  return normalized;
}

function calendarAgeDays(dateString) {
  const normalized =
    safeIsoDate(dateString);

  if (!normalized) {
    return null;
  }

  const candleTime =
    Date.parse(
      `${normalized}T00:00:00Z`
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
      (
        todayUtc -
        candleTime
      ) /
      86_400_000
    )
  );
}

function parsePrice(value) {
  const parsed =
    Number.parseFloat(value);

  return Number.isFinite(parsed)
    ? parsed
    : null;
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
      // Preserve the original write error.
    }

    throw error;
  }
}

/* =====================================================================
   Candle Validation
   ===================================================================== */

function normalizeCandle(raw) {
  if (
    !raw ||
    typeof raw !== "object"
  ) {
    return {
      candle: null,
      reason: "not-an-object"
    };
  }

  const date =
    safeIsoDate(
      raw.datetime ||
      raw.date
    );

  const open =
    parsePrice(raw.open);

  const high =
    parsePrice(raw.high);

  const low =
    parsePrice(raw.low);

  const close =
    parsePrice(raw.close);

  if (!date) {
    return {
      candle: null,
      reason: "invalid-date"
    };
  }

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

function normalizeCandles(values) {
  const byDate =
    new Map();

  const rejectedReasons = {};

  let rejectedCount = 0;
  let duplicateCount = 0;

  if (!Array.isArray(values)) {
    return {
      rows: [],
      quality: {
        receivedRows: 0,
        validRows: 0,
        rejectedRows: 0,
        duplicateDates: 0,
        rejectedReasons: {
          "values-not-array": 1
        },
        firstDate: null,
        lastDate: null,
        ageDays: null,
        stale: true
      }
    };
  }

  for (const raw of values) {
    const result =
      normalizeCandle(raw);

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

    const date =
      result.candle.date;

    if (byDate.has(date)) {
      duplicateCount++;
    }

    /*
     * Last valid occurrence wins if the provider returns a duplicate date.
     */
    byDate.set(
      date,
      result.candle
    );
  }

  const rows =
    Array.from(
      byDate.values()
    )
      .sort(
        (a, b) =>
          a.date.localeCompare(
            b.date
          )
      )
      .slice(
        -MAX_STORED_CANDLES
      );

  const firstDate =
    rows[0]?.date ||
    null;

  const lastDate =
    rows[
      rows.length - 1
    ]?.date ||
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
        ageDays == null ||
        ageDays >
          STALE_AFTER_DAYS
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
  if (
    !previousOutput ||
    typeof previousOutput !== "object"
  ) {
    return [];
  }

  /*
   * Backward-compatible format:
   *
   * {
   *   XAUUSD: [...],
   *   GBPJPY: [...]
   * }
   */
  const directRows =
    previousOutput[key];

  if (Array.isArray(directRows)) {
    return normalizeCandles(
      directRows
    ).rows;
  }

  /*
   * Optional future nested compatibility:
   *
   * {
   *   symbols: {
   *     XAUUSD: { candles: [...] }
   *   }
   * }
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
   Twelve Data Error Handling
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
   Free-Tier-Safe Request Control
   ===================================================================== */

/*
 * Hard safety limit:
 * - XAU/USD = one request
 * - GBP/JPY = one request
 *
 * No third request can be made during the same execution.
 */
const MAX_REQUESTS_PER_RUN =
  SYMBOLS.length;

/*
 * Small delay between symbols helps avoid burst/rate-limit issues.
 * It does not use additional API credits.
 */
const REQUEST_GAP_MS = 1_000;

let requestsMade = 0;

/* =====================================================================
   Single-Request JSON Fetch
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
    setTimeout(() => {
      controller.abort();
    }, timeoutMs);

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
     * Read the body once. This lets us show provider details even when
     * the HTTP response itself is not successful.
     */
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
   Twelve Data Daily Fetch
   ===================================================================== */

async function fetchDaily(symbol) {
  const parameters =
    new URLSearchParams({
      symbol,
      interval: "1day",

      /*
       * A larger history is returned in the same API request.
       * It does not cause one request per candle.
       */
      outputsize:
        String(OUTPUT_SIZE),

      apikey:
        API_KEY
    });

  const url =
    `https://api.twelvedata.com/time_series?${parameters.toString()}`;

  const payload =
    await fetchJsonOnce(url);

  /*
   * Twelve Data can return HTTP 200 while reporting an API-level error.
   */
  if (
    !payload ||
    typeof payload !== "object"
  ) {
    throw new Error(
      `Empty or invalid Twelve Data response for ${symbol}`
    );
  }

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
      `No valid daily OHLC candles returned for ${symbol}`
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
        "1day",

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
  /*
   * Previous candles are inserted first and fresh candles second.
   * Therefore, a newly fetched candle replaces the cached candle for
   * the same date.
   */
  const combined = [
    ...(
      Array.isArray(
        previousRows
      )
        ? previousRows
        : []
    ),

    ...(
      Array.isArray(
        freshRows
      )
        ? freshRows
        : []
    )
  ];

  return normalizeCandles(
    combined
  );
}

/* =====================================================================
   Daily-Candle Status
   ===================================================================== */

function currentUtcDate() {
  return new Date()
    .toISOString()
    .slice(0, 10);
}

function isPossiblyOpenCandle(
  dateString
) {
  /*
   * When the provider returns today's daily candle, that candle might
   * still be forming. We keep it for backward compatibility and expose
   * this status through metadata instead of silently deleting it.
   */
  return (
    safeIsoDate(dateString) ===
    currentUtcDate()
  );
}

/* =====================================================================
   Symbol Result Builder
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
  const lastDate =
    rows[
      rows.length - 1
    ]?.date ||
    null;

  return {
    symbol:
      config.symbol,

    key:
      config.key,

    label:
      config.label,

    source,

    fetchSucceeded,

    fallbackUsed,

    error:
      errorMessage ||
      null,

    candleCount:
      rows.length,

    firstDate:
      rows[0]?.date ||
      null,

    lastDate,

    ageDays:
      calendarAgeDays(
        lastDate
      ),

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
   * Keep direct XAUUSD and GBPJPY arrays for complete backward
   * compatibility with fetch-signals.js and any existing frontend.
   */
  const output = {
    updatedAt:
      startedAt.toISOString(),

    version:
      FILE_VERSION,

    source:
      SOURCE_NAME,

    interval:
      "1day",

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

  for (
    let index = 0;
    index <
      SYMBOLS.length;
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
        `Fetching ${config.symbol} daily OHLC ` +
        `(${requestsMade + 1}/${MAX_REQUESTS_PER_RUN})...`
      );

      /*
       * Exactly one provider request for this symbol.
       */
      const fetched =
        await fetchDaily(
          config.symbol
        );

      /*
       * Merge with cache so older valid history is retained if the
       * provider returns fewer than OUTPUT_SIZE candles.
       */
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
        `Fetched ${fetched.rows.length} valid candles for ` +
        `${config.symbol}; stored ${merged.rows.length} total candles.`
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
       * No retry is attempted. Cached data is used immediately to keep
       * the execution inside the fixed request budget.
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
          cached.rows.length
      });

      if (
        cached.rows.length > 0
      ) {
        console.warn(
          `Using ${cached.rows.length} cached candles for ${config.symbol}.`
        );
      } else {
        console.warn(
          `No cached data is available for ${config.symbol}.`
        );
      }
    }

    /*
     * Avoid a burst of two requests. There is no delay after the final
     * symbol and no additional API call.
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

  output.startedAt =
    startedAt.toISOString();

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
   * Atomic replacement prevents a partially written JSON file from
   * breaking downstream workers.
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
    `Successful symbols: ${output.successCount}/${SYMBOLS.length}`
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
    "fetch-daily-ohlc.js failed:",
    error instanceof Error
      ? error.stack ||
        error.message
      : error
  );

  process.exitCode = 1;
});

