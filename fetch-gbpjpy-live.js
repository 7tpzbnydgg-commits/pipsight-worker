"use strict";

// PipSight Robot — live GBP/JPY tick
// -----------------------------------------------------------------------
// Fetches the live GBP/JPY price from Twelve Data using an API key that
// lives ONLY as a GitHub Actions secret (TWELVEDATA_API_KEY).
//
// Security:
// - The API key is never written to a repository file.
// - The API key is never exposed to the browser.
// - The API key is never included in generated JSON.
//
// Compatibility requirements:
// - Existing functionality is retained.
// - Existing output path is retained.
// - Existing JSON format is retained: { price, updatedAt }.
// - Existing GitHub Actions and frontend integration must not break.
// - Duplicate logic is removed through reusable helpers.
// - The same production standard used in other upgraded PipSight files
//   is applied incrementally.
// -----------------------------------------------------------------------

const fs = require("fs");
const path = require("path");

// -----------------------------------------------------------------------
// Runtime configuration
// -----------------------------------------------------------------------

const CONFIG = Object.freeze({
  provider: "Twelve Data",

  symbol: "GBP/JPY",

  apiBaseUrl: "https://api.twelvedata.com",

  apiKeyEnvName: "TWELVEDATA_API_KEY",

  outputPath: path.join(
    __dirname,
    "data",
    "gbpjpy-live.json"
  ),

  request: Object.freeze({
    retries: 3,
    retryDelayMs: 1500,
    timeoutMs: 15000,
  }),
});

// Read the API key only from the server-side environment.
// Trimming prevents an accidentally stored leading/trailing space from
// causing an unclear provider authentication failure.
const API_KEY = String(
  process.env[CONFIG.apiKeyEnvName] || ""
).trim();

// -----------------------------------------------------------------------
// Startup validation
// -----------------------------------------------------------------------

function validateStartupConfig() {
  if (!API_KEY) {
    throw new Error(
      `${CONFIG.apiKeyEnvName} secret is not set — ` +
      "see worker/ADD-TO-EXISTING-REPO.md"
    );
  }

  if (
    typeof CONFIG.symbol !== "string" ||
    !CONFIG.symbol.trim()
  ) {
    throw new Error(
      "Live-price symbol is not configured"
    );
  }

  if (
    typeof CONFIG.apiBaseUrl !== "string" ||
    !CONFIG.apiBaseUrl.trim()
  ) {
    throw new Error(
      "Twelve Data API base URL is not configured"
    );
  }

  if (
    typeof CONFIG.outputPath !== "string" ||
    !CONFIG.outputPath.trim()
  ) {
    throw new Error(
      "Live-price output path is not configured"
    );
  }

  if (
    !Number.isInteger(CONFIG.request.retries) ||
    CONFIG.request.retries < 1
  ) {
    throw new Error(
      "Request retries must be a positive integer"
    );
  }

  if (
    !Number.isFinite(CONFIG.request.retryDelayMs) ||
    CONFIG.request.retryDelayMs < 0
  ) {
    throw new Error(
      "Request retry delay must be a non-negative number"
    );
  }

  if (
    !Number.isFinite(CONFIG.request.timeoutMs) ||
    CONFIG.request.timeoutMs <= 0
  ) {
    throw new Error(
      "Request timeout must be a positive number"
    );
  }
}

// -----------------------------------------------------------------------
// Shared utility helpers
// -----------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function buildPriceUrl() {
  const url = new URL(
    "/price",
    CONFIG.apiBaseUrl
  );

  url.searchParams.set(
    "symbol",
    CONFIG.symbol
  );

  url.searchParams.set(
    "apikey",
    API_KEY
  );

  return url;
}

function normalizeError(error, fallbackMessage = "Unknown error") {
  if (error instanceof Error) {
    return error;
  }

  if (typeof error === "string" && error.trim()) {
    return new Error(error);
  }

  return new Error(fallbackMessage);
}

function formatRequestError(error, timeoutMs) {
  if (
    error &&
    typeof error === "object" &&
    error.name === "AbortError"
  ) {
    return new Error(
      `Timed out after ${timeoutMs}ms`
    );
  }

  return normalizeError(
    error,
    "Unknown request error"
  );
}

// -----------------------------------------------------------------------
// HTTP request and retry engine
// -----------------------------------------------------------------------

// Fetches JSON with:
// - Per-request timeout.
// - Incremental retry backoff.
// - Clear HTTP/provider errors.
// - No API key logging.
// - Existing retry behavior retained.
async function fetchJsonWithRetry(
  url,
  {
    retries = CONFIG.request.retries,
    retryDelayMs = CONFIG.request.retryDelayMs,
    timeoutMs = CONFIG.request.timeoutMs,
  } = {}
) {
  if (!(url instanceof URL) && typeof url !== "string") {
    throw new TypeError(
      "fetchJsonWithRetry requires a URL or URL string"
    );
  }

  if (!Number.isInteger(retries) || retries < 1) {
    throw new TypeError(
      "Retry count must be a positive integer"
    );
  }

  if (
    !Number.isFinite(retryDelayMs) ||
    retryDelayMs < 0
  ) {
    throw new TypeError(
      "Retry delay must be a non-negative number"
    );
  }

  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0
  ) {
    throw new TypeError(
      "Request timeout must be a positive number"
    );
  }

  let lastError = null;

  for (
    let attempt = 1;
    attempt <= retries;
    attempt += 1
  ) {
    const controller = new AbortController();

    const timeoutHandle = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    try {
      const response = await fetch(url, {
        method: "GET",

        headers: {
          Accept: "application/json",
          "User-Agent": "PipSight-Robot/1.0",
        },

        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(
          `${CONFIG.provider} request failed ` +
          `(${response.status} ${response.statusText || "HTTP error"})`
        );
      }

      const contentType = String(
        response.headers.get("content-type") || ""
      ).toLowerCase();

      if (
        contentType &&
        !contentType.includes("application/json")
      ) {
        throw new Error(
          `${CONFIG.provider} returned an unexpected content type`
        );
      }

      try {
        return await response.json();
      } catch (error) {
        throw new Error(
          `${CONFIG.provider} returned invalid JSON: ` +
          normalizeError(error).message
        );
      }
    } catch (error) {
      lastError = formatRequestError(
        error,
        timeoutMs
      );

      console.warn(
        `  attempt ${attempt}/${retries} failed: ` +
        lastError.message
      );

      if (attempt < retries) {
        const delayMs =
          retryDelayMs * attempt;

        console.warn(
          `  retrying in ${delayMs}ms`
        );

        await sleep(delayMs);
      }
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  throw (
    lastError ||
    new Error(
      `${CONFIG.provider} request failed after all retries`
    )
  );
}

// -----------------------------------------------------------------------
// Twelve Data response validation
// -----------------------------------------------------------------------

function getProviderErrorMessage(data) {
  if (!data || typeof data !== "object") {
    return null;
  }

  const status = String(
    data.status || ""
  ).toLowerCase();

  const code = data.code;

  const message =
    typeof data.message === "string"
      ? data.message.trim()
      : "";

  if (
    status === "error" ||
    code === 400 ||
    code === 401 ||
    code === 403 ||
    code === 404 ||
    code === 429
  ) {
    return (
      message ||
      `${CONFIG.provider} returned an API error`
    );
  }

  return null;
}

function parseLivePrice(data) {
  if (!data || typeof data !== "object") {
    throw new Error(
      `${CONFIG.provider} returned an invalid response`
    );
  }

  const providerError =
    getProviderErrorMessage(data);

  if (providerError) {
    throw new Error(providerError);
  }

  const price = Number.parseFloat(
    data.price
  );

  if (!Number.isFinite(price)) {
    throw new Error(
      `${CONFIG.provider} response did not contain a valid price`
    );
  }

  if (price <= 0) {
    throw new Error(
      `${CONFIG.provider} returned a non-positive price`
    );
  }

  return price;
}

// -----------------------------------------------------------------------
// Output validation and atomic JSON writing
// -----------------------------------------------------------------------

function createOutputPayload(price) {
  if (!Number.isFinite(price) || price <= 0) {
    throw new TypeError(
      "Output price must be a positive finite number"
    );
  }

  const updatedAt = new Date().toISOString();

  if (
    typeof updatedAt !== "string" ||
    Number.isNaN(Date.parse(updatedAt))
  ) {
    throw new Error(
      "Failed to generate a valid updatedAt timestamp"
    );
  }

  // Existing JSON format is intentionally retained.
  // Do not add, rename, or remove fields without updating all consumers.
  return {
    price,
    updatedAt,
  };
}

function validateOutputPayload(payload) {
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    throw new TypeError(
      "Output payload must be a plain object"
    );
  }

  const keys = Object.keys(payload);

  if (
    keys.length !== 2 ||
    !keys.includes("price") ||
    !keys.includes("updatedAt")
  ) {
    throw new Error(
      "Output payload must retain exactly: price and updatedAt"
    );
  }

  if (
    !Number.isFinite(payload.price) ||
    payload.price <= 0
  ) {
    throw new Error(
      "Output payload contains an invalid price"
    );
  }

  if (
    typeof payload.updatedAt !== "string" ||
    Number.isNaN(
      Date.parse(payload.updatedAt)
    )
  ) {
    throw new Error(
      "Output payload contains an invalid updatedAt timestamp"
    );
  }

  return payload;
}

function serializeOutputPayload(payload) {
  validateOutputPayload(payload);

  try {
    return JSON.stringify(
      payload,
      null,
      2
    );
  } catch (error) {
    throw new Error(
      "Failed to serialize live-price output: " +
      normalizeError(error).message
    );
  }
}

function ensureOutputDirectory(outputPath) {
  const outputDirectory =
    path.dirname(outputPath);

  try {
    fs.mkdirSync(
      outputDirectory,
      {
        recursive: true,
      }
    );
  } catch (error) {
    throw new Error(
      `Failed to create output directory: ` +
      normalizeError(error).message
    );
  }
}

function writeJsonAtomic(
  outputPath,
  payload
) {
  if (
    typeof outputPath !== "string" ||
    !outputPath.trim()
  ) {
    throw new TypeError(
      "A valid output path is required"
    );
  }

  const json =
    serializeOutputPayload(payload);

  ensureOutputDirectory(outputPath);

  const temporaryPath =
    `${outputPath}.tmp-${process.pid}-${Date.now()}`;

  try {
    fs.writeFileSync(
      temporaryPath,
      json,
      {
        encoding: "utf8",
        flag: "w",
      }
    );

    fs.renameSync(
      temporaryPath,
      outputPath
    );
  } catch (error) {
    try {
      if (
        fs.existsSync(temporaryPath)
      ) {
        fs.unlinkSync(
          temporaryPath
        );
      }
    } catch (cleanupError) {
      console.warn(
        "  temporary output cleanup failed: " +
        normalizeError(
          cleanupError
        ).message
      );
    }

    throw new Error(
      `Failed to write ${path.basename(outputPath)}: ` +
      normalizeError(error).message
    );
  }
}

function writeLivePriceOutput(price) {
  const payload =
    createOutputPayload(price);

  writeJsonAtomic(
    CONFIG.outputPath,
    payload
  );

  return payload;
}

// -----------------------------------------------------------------------
// Main execution flow
// -----------------------------------------------------------------------

async function fetchLivePrice() {
  const requestUrl =
    buildPriceUrl();

  const data =
    await fetchJsonWithRetry(
      requestUrl,
      CONFIG.request
    );

  return parseLivePrice(
    data
  );
}

async function main() {
  validateStartupConfig();

  console.log(
    `Fetching live ${CONFIG.symbol} price from ${CONFIG.provider}...`
  );

  const price =
    await fetchLivePrice();

  const output =
    writeLivePriceOutput(
      price
    );

  console.log(
    `Wrote live ${CONFIG.symbol} tick:`,
    output
  );

  return output;
}

// -----------------------------------------------------------------------
// Process-level error handling
// -----------------------------------------------------------------------

function logFatalError(error) {
  const normalizedError =
    normalizeError(
      error,
      "Unknown fatal error"
    );

  console.error(
    `[${CONFIG.symbol}] live tick update failed: ` +
    normalizedError.message
  );

  if (
    process.env.NODE_ENV !== "production" &&
    normalizedError.stack
  ) {
    console.error(
      normalizedError.stack
    );
  }
}

main().catch((error) => {
  logFatalError(error);

  // Existing failure behavior is retained:
  // the process exits with code 1 so GitHub Actions clearly reports
  // a failed workflow instead of silently succeeding without an update.
  process.exitCode = 1;
});
