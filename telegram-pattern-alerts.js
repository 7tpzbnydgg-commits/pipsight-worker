"use strict";

/**
 * PipSight Telegram Alerts
 *
 * Existing behavior retained:
 * - Fetches AI pattern signals from the Pattern Detector repository.
 * - Sends previously unsent pattern signals to Telegram.
 * - Stores sent-alert state in telegram-pattern-log.json.
 *
 * Additive scalp integration:
 * - Reads data/scalp-signals.json from the current repository.
 * - Sends valid BUY/SELL scalp signals to Telegram.
 * - HOLD signals are ignored.
 * - Existing pattern alerts remain unchanged.
 * - The same duplicate-protection log is used safely.
 *
 * The GitHub Actions workflow must commit telegram-pattern-log.json
 * so duplicate protection remains available across workflow runs.
 */

const fs = require("fs");
const path = require("path");
const https = require("https");

const CONFIG = Object.freeze({
  telegramBotToken: String(
    process.env.TELEGRAM_BOT_TOKEN || ""
  ).trim(),

  telegramChatId: String(
    process.env.TELEGRAM_CHAT_ID || ""
  ).trim(),

  patternSignalsUrl:
    "https://raw.githubusercontent.com/" +
    "Detector-byte/pattern-detector-bot/" +
    "main/data/pattern-signals.json",

  scalpSignalsPath: path.join(
    __dirname,
    "data",
    "scalp-signals.json"
  ),

  sentAlertsLogPath: path.join(
    __dirname,
    "telegram-pattern-log.json"
  ),

  requestTimeoutMs: 15_000,
  messageDelayMs: 1_000,
  maxStoredAlerts: 5_000
});

function validateConfiguration() {
  const missing = [];

  if (!CONFIG.telegramBotToken) {
    missing.push("TELEGRAM_BOT_TOKEN");
  }

  if (!CONFIG.telegramChatId) {
    missing.push("TELEGRAM_CHAT_ID");
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(", ")}`
    );
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function safeObject(value) {
  return isPlainObject(value)
    ? value
    : {};
}

function toFiniteNumber(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : null;
}

function normalizeText(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeDirection(value) {
  const direction =
    normalizeText(value)
      .toUpperCase();

  if (
    direction === "BUY" ||
    direction === "SELL"
  ) {
    return direction;
  }

  return "";
}

function normalizePair(value) {
  return normalizeText(value)
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace("/", "");
}

function displayPair(value) {
  const normalized =
    normalizePair(value);

  if (normalized === "XAUUSD") {
    return "XAU/USD";
  }

  if (normalized === "GBPJPY") {
    return "GBP/JPY";
  }

  return normalizeText(value) || normalized;
}

function decimalsForPair(pair) {
  return normalizePair(pair) === "GBPJPY"
    ? 3
    : 2;
}

function formatPrice(value, pair) {
  const number =
    toFiniteNumber(value);

  if (number === null) {
    return "N/A";
  }

  return number.toFixed(
    decimalsForPair(pair)
  );
}

function formatNumber(
  value,
  decimals = 1
) {
  const number =
    toFiniteNumber(value);

  if (number === null) {
    return "N/A";
  }

  return number.toFixed(decimals);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/*
 * Existing Pattern Detector ID format is intentionally unchanged.
 * This prevents previously sent pattern alerts from being resent.
 */
function buildSignalId(signal) {
  const pair =
    normalizePair(signal.pair) ||
    "UNKNOWN";

  const pattern =
    normalizeText(signal.pattern) ||
    "UNKNOWN";

  const timeframe =
    normalizeText(signal.timeframe) ||
    "UNKNOWN";

  const direction =
    normalizeDirection(signal.direction) ||
    "UNKNOWN";

  const createdAt =
    normalizeText(signal.createdAt) ||
    normalizeText(signal.timestamp) ||
    normalizeText(signal.time) ||
    "UNKNOWN";

  return [
    pair,
    pattern,
    timeframe,
    direction,
    createdAt
  ].join("-");
}

/*
 * Scalp IDs use a prefix so they cannot conflict
 * with existing Pattern Detector alert IDs.
 */
function buildScalpSignalId(signal) {
  const pair =
    normalizePair(signal.pair) ||
    "UNKNOWN";

  const timeframe =
    normalizeText(signal.timeframe) ||
    "SCALP";

  const direction =
    normalizeDirection(signal.direction) ||
    "UNKNOWN";

  const createdAt =
    normalizeText(signal.createdAt) ||
    normalizeText(signal.generatedAt) ||
    normalizeText(signal.updatedAt) ||
    normalizeText(signal.timestamp) ||
    "UNKNOWN";

  const entry =
    toFiniteNumber(signal.entry);

  return [
    "SCALP",
    pair,
    timeframe,
    direction,
    createdAt,
    entry === null
      ? "NO-ENTRY"
      : String(entry)
  ].join("-");
}

function normalizeSentAlertEntry(entry) {
  if (!isPlainObject(entry)) {
    return null;
  }

  const id =
    normalizeText(entry.id);

  if (!id) {
    return null;
  }

  return {
    id,

    sentAt:
      normalizeText(entry.sentAt) ||
      new Date(0).toISOString()
  };
}

function loadSentAlerts() {
  try {
    if (
      !fs.existsSync(
        CONFIG.sentAlertsLogPath
      )
    ) {
      return [];
    }

    const raw =
      fs
        .readFileSync(
          CONFIG.sentAlertsLogPath,
          "utf8"
        )
        .trim();

    if (!raw) {
      return [];
    }

    const parsed =
      JSON.parse(raw);

    if (!Array.isArray(parsed)) {
      console.warn(
        "Sent-alert log is not an array. " +
        "Starting with an empty log."
      );

      return [];
    }

    const uniqueAlerts =
      new Map();

    for (const entry of parsed) {
      const normalized =
        normalizeSentAlertEntry(entry);

      if (!normalized) {
        continue;
      }

      uniqueAlerts.set(
        normalized.id,
        normalized
      );
    }

    return Array.from(
      uniqueAlerts.values()
    );
  } catch (error) {
    console.warn(
      `Unable to read sent-alert log: ${error.message}. ` +
      "Starting with an empty log."
    );

    return [];
  }
}

function trimSentAlerts(alerts) {
  if (
    alerts.length <=
    CONFIG.maxStoredAlerts
  ) {
    return alerts;
  }

  return alerts.slice(
    -CONFIG.maxStoredAlerts
  );
}

function saveSentAlerts(alerts) {
  const normalizedAlerts = [];
  const seenIds = new Set();

  for (const entry of alerts) {
    const normalized =
      normalizeSentAlertEntry(entry);

    if (
      !normalized ||
      seenIds.has(normalized.id)
    ) {
      continue;
    }

    seenIds.add(normalized.id);
    normalizedAlerts.push(normalized);
  }

  const trimmedAlerts =
    trimSentAlerts(
      normalizedAlerts
    );

  const temporaryPath =
    `${CONFIG.sentAlertsLogPath}` +
    `.tmp-${process.pid}-${Date.now()}`;

  try {
    fs.writeFileSync(
      temporaryPath,
      `${JSON.stringify(
        trimmedAlerts,
        null,
        2
      )}\n`,
      "utf8"
    );

    fs.renameSync(
      temporaryPath,
      CONFIG.sentAlertsLogPath
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
      // Ignore cleanup errors.
    }

    throw new Error(
      `Unable to save sent-alert log: ${error.message}`
    );
  }
}

function requestJson({
  hostname,
  path: requestPath,
  method = "GET",
  headers = {},
  body = null,
  timeoutMs = CONFIG.requestTimeoutMs
}) {
  return new Promise(
    (resolve, reject) => {
      let settled = false;

      const finishResolve =
        (value) => {
          if (settled) {
            return;
          }

          settled = true;
          resolve(value);
        };

      const finishReject =
        (error) => {
          if (settled) {
            return;
          }

          settled = true;
          reject(error);
        };

      const request =
        https.request(
          {
            hostname,
            port: 443,
            path: requestPath,
            method,
            headers
          },
          (response) => {
            let responseBody = "";

            response.setEncoding(
              "utf8"
            );

            response.on(
              "data",
              (chunk) => {
                responseBody += chunk;
              }
            );

            response.on(
              "end",
              () => {
                const statusCode =
                  Number(
                    response.statusCode || 0
                  );

                let parsedBody = null;

                if (
                  responseBody.trim()
                ) {
                  try {
                    parsedBody =
                      JSON.parse(
                        responseBody
                      );
                  } catch (error) {
                    finishReject(
                      new Error(
                        `Invalid JSON response from ${hostname}: ` +
                        `${error.message}`
                      )
                    );

                    return;
                  }
                }

                if (
                  statusCode < 200 ||
                  statusCode >= 300
                ) {
                  const description =
                    isPlainObject(
                      parsedBody
                    ) &&
                    normalizeText(
                      parsedBody.description
                    );

                  finishReject(
                    new Error(
                      `HTTP ${statusCode} from ${hostname}` +
                      (
                        description
                          ? `: ${description}`
                          : ""
                      )
                    )
                  );

                  return;
                }

                finishResolve(
                  parsedBody
                );
              }
            );
          }
        );

      request.setTimeout(
        timeoutMs,
        () => {
          request.destroy(
            new Error(
              `Request timed out after ${timeoutMs}ms: ` +
              hostname
            )
          );
        }
      );

      request.on(
        "error",
        finishReject
      );

      if (body !== null) {
        request.write(body);
      }

      request.end();
    }
  );
}

async function sendTelegramMessage(
  message
) {
  const payload =
    JSON.stringify({
      chat_id:
        CONFIG.telegramChatId,

      text:
        message,

      parse_mode:
        "HTML",

      disable_web_page_preview:
        true
    });

  const response =
    await requestJson({
      hostname:
        "api.telegram.org",

      path:
        `/bot${CONFIG.telegramBotToken}` +
        "/sendMessage",

      method:
        "POST",

      headers: {
        "Content-Type":
          "application/json",

        "Content-Length":
          Buffer.byteLength(
            payload
          )
      },

      body:
        payload
    });

  if (
    !isPlainObject(response) ||
    response.ok !== true
  ) {
    throw new Error(
      "Telegram returned an unsuccessful response."
    );
  }

  return response;
}

async function fetchPatternSignals() {
  const url =
    new URL(
      CONFIG.patternSignalsUrl
    );

  const response =
    await requestJson({
      hostname:
        url.hostname,

      path:
        `${url.pathname}${url.search}`,

      method:
        "GET",

      headers: {
        Accept:
          "application/json",

        "User-Agent":
          "PipSight-Pattern-Alerts/1.1"
      }
    });

  if (!isPlainObject(response)) {
    throw new Error(
      "Pattern signal response must be a JSON object."
    );
  }

  if (
    response.signals !== undefined &&
    !Array.isArray(
      response.signals
    )
  ) {
    throw new Error(
      'Pattern signal response field "signals" ' +
      "must be an array."
    );
  }

  return response;
}

function readScalpSignals() {
  if (
    !fs.existsSync(
      CONFIG.scalpSignalsPath
    )
  ) {
    console.log(
      "No data/scalp-signals.json file found. " +
      "Skipping scalp alerts."
    );

    return null;
  }

  try {
    const raw =
      fs.readFileSync(
        CONFIG.scalpSignalsPath,
        "utf8"
      );

    const parsed =
      JSON.parse(raw);

    if (
      !isPlainObject(parsed) &&
      !Array.isArray(parsed)
    ) {
      throw new Error(
        "Scalp signal JSON must contain an object or array."
      );
    }

    return parsed;
  } catch (error) {
    throw new Error(
      `Unable to read scalp signals: ${error.message}`
    );
  }
}

function validateSignal(
  signal,
  index
) {
  if (!isPlainObject(signal)) {
    throw new Error(
      `Pattern signal at index ${index} must be an object.`
    );
  }

  const pair =
    normalizeText(signal.pair);

  const pattern =
    normalizeText(signal.pattern);

  const timeframe =
    normalizeText(signal.timeframe);

  const direction =
    normalizeDirection(
      signal.direction
    );

  if (!pair) {
    throw new Error(
      `Pattern signal at index ${index} is missing pair.`
    );
  }

  if (!pattern) {
    throw new Error(
      `Pattern signal at index ${index} is missing pattern.`
    );
  }

  if (!timeframe) {
    throw new Error(
      `Pattern signal at index ${index} is missing timeframe.`
    );
  }

  if (!direction) {
    throw new Error(
      `Pattern signal at index ${index} has an invalid direction.`
    );
  }

  return {
    ...signal,
    pair,
    pattern,
    timeframe,
    direction
  };
}

function normalizeScalpEntry(
  entry,
  pairFallback = ""
) {
  if (!isPlainObject(entry)) {
    return null;
  }

  const direction =
    normalizeDirection(
      entry.decision ||
      entry.signal ||
      entry.direction
    );

  /*
   * HOLD and invalid decisions do not generate
   * Telegram trade notifications.
   */
  if (!direction) {
    return null;
  }

  const tradePlan =
    safeObject(
      entry.tradePlan ||
      entry.plan
    );

  const pair =
    normalizeText(
      entry.pair ||
      entry.symbol ||
      pairFallback
    );

  if (!pair) {
    return null;
  }

  const rawEntry =
    toFiniteNumber(
      tradePlan.entry ??
      entry.rawEntry ??
      entry.entry ??
      entry.price
    );

  const stopLoss =
    toFiniteNumber(
      tradePlan.stopLoss ??
      tradePlan.stop ??
      tradePlan.sl ??
      entry.rawSl ??
      entry.stopLoss ??
      entry.sl
    );

  const takeProfit1 =
    toFiniteNumber(
      tradePlan.target1 ??
      tradePlan.takeProfit1 ??
      tradePlan.takeProfit ??
      tradePlan.tp1 ??
      tradePlan.tp ??
      entry.rawTp1 ??
      entry.rawTp ??
      entry.target1 ??
      entry.takeProfit1 ??
      entry.takeProfit ??
      entry.tp1 ??
      entry.tp
    );

  const takeProfit2 =
    toFiniteNumber(
      tradePlan.target2 ??
      tradePlan.takeProfit2 ??
      tradePlan.tp2 ??
      entry.rawTp2 ??
      entry.target2 ??
      entry.takeProfit2 ??
      entry.tp2
    );

  const takeProfit3 =
    toFiniteNumber(
      tradePlan.target3 ??
      tradePlan.takeProfit3 ??
      tradePlan.tp3 ??
      entry.rawTp3 ??
      entry.target3 ??
      entry.takeProfit3 ??
      entry.tp3
    );

  if (
    rawEntry === null ||
    stopLoss === null ||
    takeProfit1 === null
  ) {
    console.warn(
      `Skipping incomplete scalp ${direction} signal for ${pair}.`
    );

    return null;
  }

  const risk =
    Math.abs(
      rawEntry -
      stopLoss
    );

  const reward =
    Math.abs(
      takeProfit1 -
      rawEntry
    );

  if (
    risk <= 0 ||
    !Number.isFinite(risk)
  ) {
    console.warn(
      `Skipping scalp signal with invalid risk for ${pair}.`
    );

    return null;
  }

  const calculatedRiskReward =
    reward /
    risk;

  const riskReward =
    toFiniteNumber(
      tradePlan.riskReward ??
      tradePlan.rr ??
      entry.riskReward ??
      entry.rr
    ) ??
    calculatedRiskReward;

  const createdAt =
    normalizeText(
      entry.generatedAt ||
      entry.updatedAt ||
      entry.timestamp ||
      entry.createdAt
    );

  return {
    source:
      "scalp",

    pair:
      displayPair(pair),

    pattern:
      normalizeText(
        entry.pattern
      ) ||
      "Backend Scalp Setup",

    timeframe:
      normalizeText(
        entry.timeframe ||
        entry.mode
      ) ||
      "Scalp",

    direction,

    confidence:
      toFiniteNumber(
        entry.confidence
      ),

    entry:
      rawEntry,

    stopLoss,

    takeProfit1,

    takeProfit2,

    takeProfit3,

    riskReward,

    reason:
      normalizeText(
        entry.reason
      ),

    createdAt,

    generatedAt:
      createdAt
  };
}

function extractScalpSignals(payload) {
  if (!payload) {
    return [];
  }

  const extracted = [];

  const addEntry =
    (
      entry,
      pairFallback = ""
    ) => {
      const normalized =
        normalizeScalpEntry(
          entry,
          pairFallback
        );

      if (normalized) {
        extracted.push(
          normalized
        );
      }
    };

  if (Array.isArray(payload)) {
    for (const entry of payload) {
      addEntry(entry);
    }

    return extracted;
  }

  if (!isPlainObject(payload)) {
    return extracted;
  }

  /*
   * Supports an array-based schema.
   */
  if (Array.isArray(payload.signals)) {
    for (
      const entry of
      payload.signals
    ) {
      addEntry(entry);
    }
  }

  if (Array.isArray(payload.results)) {
    for (
      const entry of
      payload.results
    ) {
      addEntry(entry);
    }
  }

  /*
   * Supports pair-key schemas such as:
   * XAUUSD, GBPJPY, XAU/USD and GBP/JPY.
   */
  const ignoredKeys =
    new Set([
      "signals",
      "results",
      "metadata",
      "updatedAt",
      "generatedAt",
      "timestamp",
      "stale",
      "version",
      "engineVersion"
    ]);

  for (
    const [
      key,
      value
    ] of Object.entries(payload)
  ) {
    if (ignoredKeys.has(key)) {
      continue;
    }

    if (!isPlainObject(value)) {
      continue;
    }

    const normalizedKey =
      normalizePair(key);

    if (
      normalizedKey === "XAUUSD" ||
      normalizedKey === "GBPJPY"
    ) {
      addEntry(
        value,
        key
      );
    }
  }

  return extracted;
}

function buildTelegramMessage(signal) {
  const emoji =
    signal.direction === "BUY"
      ? "🟢"
      : "🔴";

  const confidence =
    toFiniteNumber(
      signal.confidence
    );

  const confidenceText =
    confidence === null
      ? "N/A"
      : `${confidence.toFixed(0)}%`;

  return [
    `${emoji} <b>${escapeHtml(signal.pair)} ` +
      `${escapeHtml(signal.pattern)}</b>`,

    "",

    `<b>Signal:</b> ${escapeHtml(signal.direction)}`,
    `<b>Timeframe:</b> ${escapeHtml(signal.timeframe)}`,
    `<b>Confidence:</b> ${confidenceText}`,

    "",

    "📍 <b>Levels:</b>",

    `Entry: ${formatPrice(
      signal.entry,
      signal.pair
    )}`,

    `Stop: ${formatPrice(
      signal.stopLoss,
      signal.pair
    )}`,

    `TP1: ${formatPrice(
      signal.takeProfit1,
      signal.pair
    )}`,

    "",

    `R:R = 1:${formatNumber(
      signal.riskReward,
      1
    )}`,

    "",

    "⚠️ Not financial advice"
  ].join("\n");
}

function buildScalpTelegramMessage(
  signal
) {
  const emoji =
    signal.direction === "BUY"
      ? "🟢"
      : "🔴";

  const confidence =
    toFiniteNumber(
      signal.confidence
    );

  const confidenceText =
    confidence === null
      ? "N/A"
      : `${confidence.toFixed(0)}%`;

  const lines = [
    `${emoji} <b>${escapeHtml(signal.pair)} ` +
      `SCALP ${escapeHtml(signal.direction)}</b>`,

    "",

    `<b>Signal:</b> ${escapeHtml(signal.direction)}`,
    `<b>Timeframe:</b> ${escapeHtml(signal.timeframe)}`,
    `<b>Confidence:</b> ${confidenceText}`,

    "",

    "📍 <b>Trade Plan:</b>",

    `Entry: ${formatPrice(
      signal.entry,
      signal.pair
    )}`,

    `Stop Loss: ${formatPrice(
      signal.stopLoss,
      signal.pair
    )}`,

    `TP1: ${formatPrice(
      signal.takeProfit1,
      signal.pair
    )}`
  ];

  if (
    toFiniteNumber(
      signal.takeProfit2
    ) !== null
  ) {
    lines.push(
      `TP2: ${formatPrice(
        signal.takeProfit2,
        signal.pair
      )}`
    );
  }

  if (
    toFiniteNumber(
      signal.takeProfit3
    ) !== null
  ) {
    lines.push(
      `TP3: ${formatPrice(
        signal.takeProfit3,
        signal.pair
      )}`
    );
  }

  lines.push(
    "",
    `R:R = 1:${formatNumber(
      signal.riskReward,
      2
    )}`
  );

  if (
    signal.reason &&
    !/no qualified setup/i.test(
      signal.reason
    )
  ) {
    lines.push(
      "",
      `<b>Reason:</b> ${escapeHtml(
        signal.reason
      )}`
    );
  }

  lines.push(
    "",
    "⚠️ Not financial advice"
  );

  return lines.join("\n");
}

async function sendNewAlert({
  signal,
  signalId,
  message,
  sentAlerts,
  sentIds
}) {
  if (sentIds.has(signalId)) {
    console.log(
      `Skipping previously sent alert: ${signalId}`
    );

    return "skipped";
  }

  try {
    await sendTelegramMessage(
      message
    );

    const logEntry = {
      id:
        signalId,

      sentAt:
        new Date().toISOString()
    };

    sentAlerts.push(logEntry);
    sentIds.add(signalId);

    /*
     * Save immediately after each successful message.
     * Already-sent alerts remain protected even if
     * another alert fails later.
     */
    saveSentAlerts(
      sentAlerts
    );

    console.log(
      `Telegram alert sent successfully: ${signalId}`
    );

    await delay(
      CONFIG.messageDelayMs
    );

    return "sent";
  } catch (error) {
    console.error(
      `Failed to send Telegram alert ${signalId}: ` +
      error.message
    );

    return "failed";
  }
}

async function processPatternAlerts() {
  validateConfiguration();

  const sentAlerts =
    loadSentAlerts();

  const sentIds =
    new Set(
      sentAlerts.map(
        (entry) => entry.id
      )
    );

  let fetchedCount = 0;
  let sentCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  /*
   * Existing Pattern Detector processing.
   */
  console.log(
    "Fetching pattern signals..."
  );

  const patternData =
    await fetchPatternSignals();

  const patternSignals =
    Array.isArray(
      patternData.signals
    )
      ? patternData.signals
      : [];

  fetchedCount +=
    patternSignals.length;

  if (
    patternSignals.length === 0
  ) {
    console.log(
      "No pattern signals found."
    );
  }

  for (
    let index = 0;
    index < patternSignals.length;
    index += 1
  ) {
    let signal;

    try {
      signal =
        validateSignal(
          patternSignals[index],
          index
        );
    } catch (error) {
      failedCount += 1;

      console.error(
        `Skipping invalid pattern signal at index ${index}: ` +
        error.message
      );

      continue;
    }

    const result =
      await sendNewAlert({
        signal,

        signalId:
          buildSignalId(
            signal
          ),

        message:
          buildTelegramMessage(
            signal
          ),

        sentAlerts,
        sentIds
      });

    if (result === "sent") {
      sentCount += 1;
    } else if (
      result === "skipped"
    ) {
      skippedCount += 1;
    } else {
      failedCount += 1;
    }
  }

  /*
   * Additive PipSight scalp processing.
   */
  console.log(
    "Reading backend scalp signals..."
  );

  const scalpData =
    readScalpSignals();

  const scalpSignals =
    extractScalpSignals(
      scalpData
    );

  fetchedCount +=
    scalpSignals.length;

  if (
    scalpSignals.length === 0
  ) {
    console.log(
      "No qualified BUY/SELL scalp signals found."
    );
  }

  for (
    const signal of scalpSignals
  ) {
    const result =
      await sendNewAlert({
        signal,

        signalId:
          buildScalpSignalId(
            signal
          ),

        message:
          buildScalpTelegramMessage(
            signal
          ),

        sentAlerts,
        sentIds
      });

    if (result === "sent") {
      sentCount += 1;
    } else if (
      result === "skipped"
    ) {
      skippedCount += 1;
    } else {
      failedCount += 1;
    }
  }

  console.log(
    `Telegram alert summary: fetched=${fetchedCount}, ` +
    `sent=${sentCount}, skipped=${skippedCount}, ` +
    `failed=${failedCount}`
  );

  /*
   * Fail the workflow when at least one alert
   * could not be processed.
   */
  if (failedCount > 0) {
    throw new Error(
      `${failedCount} Telegram alert(s) failed to process.`
    );
  }

  return {
    fetched:
      fetchedCount,

    sent:
      sentCount,

    skipped:
      skippedCount,

    failed:
      failedCount
  };
}

function logFatalError(error) {
  const message =
    error instanceof Error
      ? error.stack ||
        error.message
      : String(error);

  console.error(
    `Telegram alerts failed:\n${message}`
  );

  process.exitCode = 1;
}

if (require.main === module) {
  processPatternAlerts()
    .catch(
      logFatalError
    );
}

module.exports = {
  CONFIG,
  buildScalpSignalId,
  buildScalpTelegramMessage,
  buildSignalId,
  buildTelegramMessage,
  extractScalpSignals,
  fetchPatternSignals,
  loadSentAlerts,
  normalizeScalpEntry,
  processPatternAlerts,
  readScalpSignals,
  saveSentAlerts,
  sendTelegramMessage,
  validateConfiguration,
  validateSignal
};
