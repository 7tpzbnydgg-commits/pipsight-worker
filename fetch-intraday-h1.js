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
 * FREE-TIER SAFETY
 * ----------------
 * - Exactly one API request per symbol.
 * - Maximum two Twelve Data requests per execution.
 * - No automatic retries.
 * - H4 remains derived locally from H1 candles.
 * - Cached data is retained when a request fails.
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
    "intraday-h1.json"
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
 * 800 H1 candles provide approximately:
 *
 * - 33 calendar days if the market traded continuously
 * - Enough bars to derive roughly 200 H4 candles
 *
 * This remains one time_series request per symbol.
 */
const OUTPUT_SIZE = 800;

/*
 * Hard request safety:
 *
 * XAU/USD = 1 request
 * GBP/JPY = 1 request
 *
 * No retries are performed.
 */
const MAX_REQUESTS_PER_RUN =
  SYMBOLS.length;

const REQUEST_TIMEOUT_MS =
  20_000;

const REQUEST_GAP_MS =
  1_000;

/*
 * H1 data is expected to refresh frequently.
 *
 * Market closure, weekends and holidays can naturally make the latest
 * candle older. This threshold is therefore used mainly as metadata;
 * failed fetches are always explicitly marked stale.
 */
const STALE_AFTER_HOURS =
  6;

/*
 * Keep slightly more than the requested amount after merging cache and
 * fresh data. This prevents uncontrolled file growth.
 */
const MAX_STORED_CANDLES =
  900;

/*
 * Used only for data-quality reporting.
 *
 * A weekend gap or market closure is not automatically considered
 * corruption.
 */
const EXPECTED_INTERVAL_MS =
  60 * 60 * 1000;

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

/*
 * Twelve Data normally returns intraday timestamps in:
 *
 * YYYY-MM-DD HH:mm:ss
 *
 * We preserve this backward-compatible format in the output.
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

  /*
   * Validate calendar correctness while treating the provider timestamp
   * consistently as UTC for ordering and freshness calculations.
   */
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

  const iso =
    normalized.replace(
      " ",
      "T"
    ) + "Z";

  const timestamp =
    Date.parse(iso);

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
    (
      60 *
      60 *
      1000
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
      // Preserve original write error.
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

  const time =
    normalizeTimestamp(
      raw.datetime ||
      raw.time
    );

  const open =
    parsePrice(raw.open);

  const high =
    parsePrice(raw.high);

  const low =
    parsePrice(raw.low);

  const close =
    parsePrice(raw.close);

  if (!time) {
    return {
      candle: null,
      reason: "invalid-time"
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

function analyzeTimeGaps(rows) {
  let normalGapCount = 0;
  let largeGapCount = 0;
  let largestGapHours = 0;

  const gaps = [];

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
     * Do not repair missing bars artificially.
     *
     * Forex and metals can have:
     * - weekends
     * - holidays
     * - maintenance windows
     *
     * Gaps are recorded for diagnostics only.
     */
    largeGapCount++;

    if (gaps.length < 20) {
      gaps.push({
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

    sampleLargeGaps:
      gaps
  };
}

function normalizeCandles(values) {
  const byTime =
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
        duplicateTimes: 0,

        rejectedReasons: {
          "values-not-array": 1
        },

        firstTime: null,
        lastTime: null,
        ageHours: null,
        stale: true,

        gaps: {
          normalGapCount: 0,
          largeGapCount: 0,
          largestGapHours: 0,
          sampleLargeGaps: []
        }
      }
    };
  }

  for (const raw of values) {
    const normalized =
      normalizeCandle(raw);

    if (!normalized.candle) {
      rejectedCount++;

      rejectedReasons[
        normalized.reason
      ] =
        (
          rejectedReasons[
            normalized.reason
          ] ||
          0
        ) + 1;

      continue;
    }

    const time =
      normalized.candle.time;

    if (byTime.has(time)) {
      duplicateCount++;
    }

    /*
     * Last valid occurrence wins.
     */
    byTime.set(
      time,
      normalized.candle
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

  const latestAgeHours =
    ageHours(lastTime);

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
        latestAgeHours == null
          ? null
          : Number(
              latestAgeHours.toFixed(2)
            ),

      stale:
        latestAgeHours == null ||
        latestAgeHours >
          STALE_AFTER_HOURS,

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
   * Existing backward-compatible format:
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
   * Optional nested-format compatibility.
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

  const timer =
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

    const body =
      await response.text();

    let payload;

    try {
      payload =
        body
          ? JSON.parse(body)
          : null;
    } catch {
      throw new Error(
        `Twelve Data returned invalid JSON ` +
        `(HTTP ${response.status})`
      );
    }

    if (!response.ok) {
      const message =
        payload &&
        typeof payload.message ===
          "string"
          ? payload.message
          : `HTTP ${response.status}`;

      const error =
        new Error(
          `Twelve Data request failed: ${message}`
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
    clearTimeout(timer);
  }
}

/* =====================================================================
   Twelve Data H1 Fetch
   ===================================================================== */

async function fetchH1(symbol) {
  const params =
    new URLSearchParams({
      symbol,
      interval:
        INTERVAL,

      outputsize:
        String(OUTPUT_SIZE),

      apikey:
        API_KEY
    });

  const url =
    `https://api.twelvedata.com/time_series?${params.toString()}`;

  /*
   * Exactly one API request for this symbol.
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
   * Twelve Data may return HTTP 200 with an API-level error object.
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
      `No valid H1 candles returned for ${symbol}`
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
  /*
   * Previous candles are inserted first and fresh candles second.
   * Fresh candles therefore replace cached candles for duplicate times.
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
   Open-Candle Detection
   ===================================================================== */

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

  const currentHour =
    floorToHourMs(
      Date.now()
    );

  return (
    candleTimestamp ===
    currentHour
  );
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

  const latestAge =
    ageHours(lastTime);

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

    firstTime,
    lastTime,

    ageHours:
      latestAge == null
        ? null
        : Number(
            latestAge.toFixed(2)
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
   * Keep direct XAUUSD and GBPJPY arrays unchanged for compatibility
   * with the frontend and any existing analysis code.
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
        `Fetching ${config.symbol} H1 OHLC ` +
        `(${requestsMade + 1}/${MAX_REQUESTS_PER_RUN})...`
      );

      const fetched =
        await fetchH1(
          config.symbol
        );

      /*
       * Merge the new response with the existing file. This protects
       * older history when the provider temporarily returns fewer bars.
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
        `Fetched ${fetched.rows.length} valid H1 candles for ` +
        `${config.symbol}; stored ${merged.rows.length} candles.`
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
       * No retry is performed. Cached candles are used immediately.
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
          `Using ${cached.rows.length} cached H1 candles for ${config.symbol}.`
        );
      } else {
        console.warn(
          `No cached H1 data is available for ${config.symbol}.`
        );
      }
    }

    /*
     * A short delay reduces request bursts. It consumes no extra credit.
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
   * Atomic replacement prevents partial or corrupted JSON output.
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
    "fetch-intraday-h1.js failed:",
    error instanceof Error
      ? error.stack ||
        error.message
      : error
  );

  process.exitCode = 1;
});

