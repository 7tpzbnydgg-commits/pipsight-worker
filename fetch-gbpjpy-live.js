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
// - Request, provider and fatal errors are centrally redacted before logging.
//
// Compatibility requirements:
// - Existing functionality is retained.
// - Existing output path is retained.
// - Existing JSON format is retained: { price, updatedAt }.
// - Existing GitHub Actions and frontend integration must not break.
// - Existing 15-second timeout, three total attempts and 1500ms base delay
//   are retained.
// -----------------------------------------------------------------------

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

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
    // maxAttempts is the authoritative meaning: three total requests/run.
    maxAttempts: 3,

    // Legacy alias retained for existing imports/tests that read this field.
    retries: 3,

    retryDelayMs: 1500,
    maxRetryDelayMs: 30000,
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
// Structured request error
// -----------------------------------------------------------------------

class RequestError extends Error {
  constructor(
    message,
    {
      code = "REQUEST_ERROR",
      httpStatus = null,
      providerCode = null,
      providerMessage = null,
      retryable = false,
      retryAfterMs = null,
    } = {}
  ) {
    super(message);

    this.name = "RequestError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.providerCode = providerCode;
    this.providerMessage = providerMessage;
    this.retryable = Boolean(retryable);
    this.retryAfterMs = retryAfterMs;
  }
}

// -----------------------------------------------------------------------
// Startup validation
// -----------------------------------------------------------------------

function validateStartupConfig(
  {
    apiKey = API_KEY,
  } = {}
) {
  if (!String(apiKey || "").trim()) {
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
    !Number.isInteger(CONFIG.request.maxAttempts) ||
    CONFIG.request.maxAttempts < 1
  ) {
    throw new Error(
      "Request maxAttempts must be a positive integer"
    );
  }

  if (
    !Number.isInteger(CONFIG.request.retries) ||
    CONFIG.request.retries !== CONFIG.request.maxAttempts
  ) {
    throw new Error(
      "Legacy retries alias must equal request maxAttempts"
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
    !Number.isFinite(CONFIG.request.maxRetryDelayMs) ||
    CONFIG.request.maxRetryDelayMs < 0
  ) {
    throw new Error(
      "Maximum retry delay must be a non-negative number"
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

function escapeRegExp(value) {
  return String(value).replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );
}

function redactSensitiveText(
  value,
  {
    apiKey = API_KEY,
  } = {}
) {
  let text = String(value ?? "");

  // Redact credential-like query parameters even when the current key is
  // unavailable or the provider echoes a differently encoded value.
  text = text.replace(
    /([?&](?:apikey|api_key)=)[^&\s]*/gi,
    "$1[REDACTED]"
  );

  const normalizedKey =
    String(apiKey || "").trim();

  if (normalizedKey) {
    const candidates = new Set([
      normalizedKey,
      encodeURIComponent(normalizedKey),
    ]);

    for (const candidate of candidates) {
      if (!candidate) {
        continue;
      }

      text = text.replace(
        new RegExp(
          escapeRegExp(candidate),
          "g"
        ),
        "[REDACTED]"
      );
    }
  }

  return text;
}

function normalizeError(
  error,
  fallbackMessage = "Unknown error"
) {
  if (error instanceof Error) {
    return error;
  }

  if (
    typeof error === "string" &&
    error.trim()
  ) {
    return new Error(error);
  }

  return new Error(fallbackMessage);
}

function createRequestError(
  message,
  details = {}
) {
  return new RequestError(
    redactSensitiveText(message),
    {
      ...details,
      providerMessage:
        details.providerMessage === null ||
        details.providerMessage === undefined
          ? null
          : redactSensitiveText(
              details.providerMessage
            ),
    }
  );
}

function formatRequestError(
  error,
  timeoutMs
) {
  if (error instanceof RequestError) {
    // Rebuild the error so every externally supplied message/property passes
    // through the central redaction boundary.
    return createRequestError(
      error.message,
      {
        code: error.code,
        httpStatus: error.httpStatus,
        providerCode: error.providerCode,
        providerMessage: error.providerMessage,
        retryable: error.retryable,
        retryAfterMs: error.retryAfterMs,
      }
    );
  }

  if (
    error &&
    typeof error === "object" &&
    error.name === "AbortError"
  ) {
    return createRequestError(
      `Timed out after ${timeoutMs}ms`,
      {
        code: "TIMEOUT",
        retryable: true,
      }
    );
  }

  const normalized = normalizeError(
    error,
    "Unknown request error"
  );

  return createRequestError(
    normalized.message,
    {
      code: "NETWORK_ERROR",
      retryable: true,
    }
  );
}

function buildPriceUrl(
  {
    apiKey = API_KEY,
  } = {}
) {
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
    String(apiKey || "").trim()
  );

  return url;
}

function isRetryableHttpStatus(status) {
  return (
    status === 408 ||
    status === 425 ||
    status === 429 ||
    (
      status >= 500 &&
      status <= 599
    )
  );
}

function parseRetryAfter(
  value,
  referenceTimeMs = Date.now()
) {
  const normalized =
    String(value || "").trim();

  if (!normalized) {
    return null;
  }

  if (/^\d+(?:\.\d+)?$/.test(normalized)) {
    const seconds = Number(normalized);

    if (
      !Number.isFinite(seconds) ||
      seconds < 0
    ) {
      return null;
    }

    return Math.ceil(seconds * 1000);
  }

  const retryAt = Date.parse(normalized);

  if (!Number.isFinite(retryAt)) {
    return null;
  }

  return Math.max(
    0,
    retryAt - referenceTimeMs
  );
}

function boundRetryDelay(
  delayMs,
  maxRetryDelayMs
) {
  if (
    !Number.isFinite(delayMs) ||
    delayMs < 0
  ) {
    return null;
  }

  return Math.min(
    Math.ceil(delayMs),
    maxRetryDelayMs
  );
}

function safeParseJson(text) {
  const normalized = String(text || "");

  if (!normalized.trim()) {
    return {
      parsed: false,
      value: null,
      error: new Error("Response body was empty"),
    };
  }

  try {
    return {
      parsed: true,
      value: JSON.parse(normalized),
      error: null,
    };
  } catch (error) {
    return {
      parsed: false,
      value: null,
      error: normalizeError(
        error,
        "Invalid JSON"
      ),
    };
  }
}

function getProviderErrorDetails(data) {
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data)
  ) {
    return null;
  }

  const status = String(
    data.status || ""
  )
    .trim()
    .toLowerCase();

  const numericCode = Number(data.code);
  const providerCode =
    Number.isFinite(numericCode)
      ? numericCode
      : (
          data.code === null ||
          data.code === undefined ||
          data.code === ""
            ? null
            : String(data.code)
        );

  const providerMessage =
    typeof data.message === "string"
      ? data.message.trim()
      : "";

  const isError =
    status === "error" ||
    (
      typeof providerCode === "number" &&
      providerCode >= 400
    );

  if (!isError) {
    return null;
  }

  return {
    providerCode,
    providerMessage:
      providerMessage ||
      `${CONFIG.provider} returned an API error`,
  };
}

function getProviderErrorMessage(data) {
  const details =
    getProviderErrorDetails(data);

  return details
    ? redactSensitiveText(
        details.providerMessage
      )
    : null;
}

function buildHttpError(
  response,
  responseText,
  referenceTimeMs = Date.now()
) {
  const parsedBody =
    safeParseJson(responseText);

  const providerDetails =
    parsedBody.parsed
      ? getProviderErrorDetails(
          parsedBody.value
        )
      : null;

  const fallbackBodyMessage =
    !parsedBody.parsed &&
    String(responseText || "").trim()
      ? String(responseText).trim().slice(0, 300)
      : null;

  const providerMessage =
    providerDetails?.providerMessage ||
    fallbackBodyMessage ||
    response.statusText ||
    "HTTP error";

  const retryAfterMs =
    parseRetryAfter(
      response.headers.get("retry-after"),
      referenceTimeMs
    );

  return createRequestError(
    `${CONFIG.provider} request failed ` +
    `(${response.status} ${providerMessage})`,
    {
      code: "HTTP_ERROR",
      httpStatus: response.status,
      providerCode:
        providerDetails?.providerCode ??
        null,
      providerMessage,
      retryable:
        isRetryableHttpStatus(
          response.status
        ),
      retryAfterMs,
    }
  );
}

function resolveRetryDelay(
  error,
  attempt,
  retryDelayMs,
  maxRetryDelayMs
) {
  const providerDelay =
    boundRetryDelay(
      error?.retryAfterMs,
      maxRetryDelayMs
    );

  if (providerDelay !== null) {
    return providerDelay;
  }

  return boundRetryDelay(
    retryDelayMs * attempt,
    maxRetryDelayMs
  );
}

// -----------------------------------------------------------------------
// HTTP request and retry engine
// -----------------------------------------------------------------------

// Retries only transient failures:
// - Network errors and timeouts.
// - HTTP 408, 425, 429 and 5xx.
// Permanent HTTP errors, invalid JSON/content type and invalid provider
// payloads fail immediately.
async function fetchJsonWithRetry(
  url,
  options = {}
) {
  if (
    !(url instanceof URL) &&
    typeof url !== "string"
  ) {
    throw new TypeError(
      "fetchJsonWithRetry requires a URL or URL string"
    );
  }

  const maxAttempts =
    options.maxAttempts ??
    options.retries ??
    CONFIG.request.maxAttempts;

  const retryDelayMs =
    options.retryDelayMs ??
    CONFIG.request.retryDelayMs;

  const maxRetryDelayMs =
    options.maxRetryDelayMs ??
    CONFIG.request.maxRetryDelayMs;

  const timeoutMs =
    options.timeoutMs ??
    CONFIG.request.timeoutMs;

  const fetchImpl =
    options.fetchImpl ??
    globalThis.fetch;

  const sleepImpl =
    options.sleepImpl ??
    sleep;

  if (
    !Number.isInteger(maxAttempts) ||
    maxAttempts < 1
  ) {
    throw new TypeError(
      "maxAttempts must be a positive integer"
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
    !Number.isFinite(maxRetryDelayMs) ||
    maxRetryDelayMs < 0
  ) {
    throw new TypeError(
      "Maximum retry delay must be a non-negative number"
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

  if (typeof fetchImpl !== "function") {
    throw new TypeError(
      "A valid fetch implementation is required"
    );
  }

  if (typeof sleepImpl !== "function") {
    throw new TypeError(
      "A valid sleep implementation is required"
    );
  }

  let lastError = null;

  for (
    let attempt = 1;
    attempt <= maxAttempts;
    attempt += 1
  ) {
    const controller =
      new AbortController();

    const timeoutHandle = setTimeout(
      () => {
        controller.abort();
      },
      timeoutMs
    );

    try {
      const response = await fetchImpl(
        url,
        {
          method: "GET",

          headers: {
            Accept: "application/json",
            "User-Agent": "PipSight-Robot/1.0",
          },

          signal: controller.signal,
        }
      );

      if (
        !response ||
        typeof response !== "object" ||
        typeof response.text !== "function" ||
        !response.headers ||
        typeof response.headers.get !== "function"
      ) {
        throw createRequestError(
          `${CONFIG.provider} returned an invalid HTTP response object`,
          {
            code: "INVALID_HTTP_RESPONSE",
            retryable: false,
          }
        );
      }

      const responseText =
        await response.text();

      if (!response.ok) {
        throw buildHttpError(
          response,
          responseText
        );
      }

      const contentType = String(
        response.headers.get("content-type") ||
        ""
      ).toLowerCase();

      if (
        contentType &&
        !contentType.includes(
          "application/json"
        )
      ) {
        throw createRequestError(
          `${CONFIG.provider} returned an unexpected content type`,
          {
            code: "INVALID_CONTENT_TYPE",
            retryable: false,
          }
        );
      }

      const parsedBody =
        safeParseJson(responseText);

      if (!parsedBody.parsed) {
        throw createRequestError(
          `${CONFIG.provider} returned invalid JSON: ` +
          redactSensitiveText(
            parsedBody.error?.message ||
            "Invalid JSON"
          ),
          {
            code: "INVALID_JSON",
            retryable: false,
          }
        );
      }

      return parsedBody.value;
    } catch (error) {
      lastError = formatRequestError(
        error,
        timeoutMs
      );

      console.warn(
        `  attempt ${attempt}/${maxAttempts} failed: ` +
        redactSensitiveText(
          lastError.message
        )
      );

      const shouldRetry =
        lastError.retryable === true &&
        attempt < maxAttempts;

      if (!shouldRetry) {
        throw lastError;
      }

      const delayMs =
        resolveRetryDelay(
          lastError,
          attempt,
          retryDelayMs,
          maxRetryDelayMs
        );

      console.warn(
        `  retrying in ${delayMs}ms`
      );

      await sleepImpl(delayMs);
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  throw (
    lastError ||
    createRequestError(
      `${CONFIG.provider} request failed after all attempts`,
      {
        code: "REQUEST_FAILED",
        retryable: false,
      }
    )
  );
}

// -----------------------------------------------------------------------
// Twelve Data response validation
// -----------------------------------------------------------------------

function parseStrictPositivePrice(value) {
  let price = null;

  if (
    typeof value === "number"
  ) {
    price = value;
  } else if (
    typeof value === "string" &&
    value.trim()
  ) {
    price = Number(value.trim());
  }

  if (
    !Number.isFinite(price) ||
    price <= 0
  ) {
    return null;
  }

  return price;
}

function parseLivePrice(data) {
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data)
  ) {
    throw createRequestError(
      `${CONFIG.provider} returned an invalid response`,
      {
        code: "INVALID_PROVIDER_PAYLOAD",
        retryable: false,
      }
    );
  }

  const providerDetails =
    getProviderErrorDetails(data);

  if (providerDetails) {
    throw createRequestError(
      providerDetails.providerMessage,
      {
        code: "PROVIDER_ERROR",
        providerCode:
          providerDetails.providerCode,
        providerMessage:
          providerDetails.providerMessage,
        retryable: false,
      }
    );
  }

  const price =
    parseStrictPositivePrice(
      data.price
    );

  if (price === null) {
    throw createRequestError(
      `${CONFIG.provider} response did not contain a valid positive price`,
      {
        code: "INVALID_LIVE_PRICE",
        retryable: false,
      }
    );
  }

  return price;
}

// -----------------------------------------------------------------------
// Output validation and atomic JSON writing
// -----------------------------------------------------------------------

function normalizeOutputTimestamp(value) {
  const date =
    value instanceof Date
      ? new Date(value.getTime())
      : new Date(value);

  if (!Number.isFinite(date.getTime())) {
    throw new Error(
      "Failed to generate a valid updatedAt timestamp"
    );
  }

  return date.toISOString();
}

function createOutputPayload(
  price,
  updatedAt = new Date()
) {
  if (
    !Number.isFinite(price) ||
    price <= 0
  ) {
    throw new TypeError(
      "Output price must be a positive finite number"
    );
  }

  // Existing JSON format is intentionally retained.
  // Do not add, rename, or remove fields without updating all consumers.
  return {
    price,
    updatedAt:
      normalizeOutputTimestamp(
        updatedAt
      ),
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
    typeof payload.updatedAt !== "string"
  ) {
    throw new Error(
      "Output payload contains an invalid updatedAt timestamp"
    );
  }

  const timestamp =
    Date.parse(payload.updatedAt);

  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString() !==
      payload.updatedAt
  ) {
    throw new Error(
      "Output payload updatedAt must be an exact ISO-8601 timestamp"
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
      redactSensitiveText(
        normalizeError(error).message
      )
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
      "Failed to create output directory: " +
      redactSensitiveText(
        normalizeError(error).message
      )
    );
  }
}

function createTemporaryOutputPath(
  outputPath
) {
  const nonce =
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : crypto
          .randomBytes(16)
          .toString("hex");

  return (
    `${outputPath}.tmp-` +
    `${process.pid}-${Date.now()}-${nonce}`
  );
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
    `${serializeOutputPayload(payload)}\n`;

  ensureOutputDirectory(outputPath);

  const temporaryPath =
    createTemporaryOutputPath(
      outputPath
    );

  try {
    fs.writeFileSync(
      temporaryPath,
      json,
      {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
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
        redactSensitiveText(
          normalizeError(
            cleanupError
          ).message
        )
      );
    }

    throw new Error(
      `Failed to write ${path.basename(outputPath)}: ` +
      redactSensitiveText(
        normalizeError(error).message
      )
    );
  }
}

function writeLivePriceOutput(
  price,
  {
    updatedAt = new Date(),
    outputPath = CONFIG.outputPath,
  } = {}
) {
  const payload =
    createOutputPayload(
      price,
      updatedAt
    );

  writeJsonAtomic(
    outputPath,
    payload
  );

  return payload;
}

// -----------------------------------------------------------------------
// Main execution flow
// -----------------------------------------------------------------------

async function fetchLivePrice(
  options = {}
) {
  const requestUrl =
    buildPriceUrl({
      apiKey:
        options.apiKey ??
        API_KEY,
    });

  const data =
    await fetchJsonWithRetry(
      requestUrl,
      {
        ...CONFIG.request,
        ...options,
      }
    );

  return parseLivePrice(data);
}

async function main(
  options = {}
) {
  const apiKey =
    options.apiKey ??
    API_KEY;

  validateStartupConfig({
    apiKey,
  });

  console.log(
    `Fetching live ${CONFIG.symbol} price from ${CONFIG.provider}...`
  );

  const price =
    await fetchLivePrice({
      ...options,
      apiKey,
    });

  // This timestamp represents successful local receipt and validation of the
  // provider price. No provider timestamp is fabricated.
  const successfulFetchTime =
    typeof options.nowImpl === "function"
      ? options.nowImpl()
      : new Date();

  const output =
    writeLivePriceOutput(
      price,
      {
        updatedAt:
          successfulFetchTime,
        outputPath:
          options.outputPath ??
          CONFIG.outputPath,
      }
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
    redactSensitiveText(
      normalizedError.message
    )
  );

  if (
    process.env.NODE_ENV !== "production" &&
    normalizedError.stack
  ) {
    console.error(
      redactSensitiveText(
        normalizedError.stack
      )
    );
  }
}

// -----------------------------------------------------------------------
// Direct-execution guard
// -----------------------------------------------------------------------

// Run the worker only when this file is executed directly:
//
//   node fetch-gbpjpy-live.js
//
// Importing this file from tests or another worker will not accidentally
// call Twelve Data or overwrite the existing JSON output.
if (require.main === module) {
  main().catch((error) => {
    logFatalError(error);

    // GitHub Actions receives a non-zero exit status when all transient
    // attempts, permanent validation, or output writing fail.
    process.exitCode = 1;
  });
}

// -----------------------------------------------------------------------
// Test and integration exports
// -----------------------------------------------------------------------

// Existing exports remain available. New helpers are additive and allow
// deterministic unit testing without changing direct production behavior.
module.exports = Object.freeze({
  CONFIG,
  RequestError,

  validateStartupConfig,

  sleep,
  escapeRegExp,
  redactSensitiveText,
  normalizeError,
  createRequestError,
  formatRequestError,
  buildPriceUrl,
  isRetryableHttpStatus,
  parseRetryAfter,
  boundRetryDelay,
  safeParseJson,
  getProviderErrorDetails,
  buildHttpError,
  resolveRetryDelay,

  fetchJsonWithRetry,

  getProviderErrorMessage,
  parseStrictPositivePrice,
  parseLivePrice,

  normalizeOutputTimestamp,
  createOutputPayload,
  validateOutputPayload,
  serializeOutputPayload,
  ensureOutputDirectory,
  createTemporaryOutputPath,
  writeJsonAtomic,
  writeLivePriceOutput,

  fetchLivePrice,
  main,
  logFatalError,
});
