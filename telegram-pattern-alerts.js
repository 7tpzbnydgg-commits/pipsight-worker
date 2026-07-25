"use strict";

/**
 * Telegram Pattern Detector Alerts
 *
 * Fetches AI pattern signals from the Pattern Detector repository,
 * sends previously unsent signals to Telegram, and stores sent-alert
 * state in telegram-pattern-log.json.
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
  const direction = normalizeText(value).toUpperCase();

  if (direction === "BUY" || direction === "SELL") {
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

function decimalsForPair(pair) {
  return normalizePair(pair) === "GBPJPY"
    ? 3
    : 2;
}

function formatPrice(value, pair) {
  const number = toFiniteNumber(value);

  if (number === null) {
    return "N/A";
  }

  return number.toFixed(decimalsForPair(pair));
}

function formatNumber(value, decimals = 1) {
  const number = toFiniteNumber(value);

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

function buildSignalId(signal) {
  const pair = normalizePair(signal.pair) || "UNKNOWN";
  const pattern = normalizeText(signal.pattern) || "UNKNOWN";
  const timeframe = normalizeText(signal.timeframe) || "UNKNOWN";
  const direction = normalizeDirection(signal.direction) || "UNKNOWN";
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

function normalizeSentAlertEntry(entry) {
  if (!isPlainObject(entry)) {
    return null;
  }

  const id = normalizeText(entry.id);

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
    if (!fs.existsSync(CONFIG.sentAlertsLogPath)) {
      return [];
    }

    const raw = fs
      .readFileSync(CONFIG.sentAlertsLogPath, "utf8")
      .trim();

    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw);

    if (!Array.isArray(parsed)) {
      console.warn(
        "Sent-alert log is not an array. Starting with an empty log."
      );

      return [];
    }

    const uniqueAlerts = new Map();

    for (const entry of parsed) {
      const normalized = normalizeSentAlertEntry(entry);

      if (!normalized) {
        continue;
      }

      uniqueAlerts.set(normalized.id, normalized);
    }

    return Array.from(uniqueAlerts.values());
  } catch (error) {
    console.warn(
      `Unable to read sent-alert log: ${error.message}. ` +
      "Starting with an empty log."
    );

    return [];
  }
}

function trimSentAlerts(alerts) {
  if (alerts.length <= CONFIG.maxStoredAlerts) {
    return alerts;
  }

  return alerts.slice(-CONFIG.maxStoredAlerts);
}

function saveSentAlerts(alerts) {
  const normalizedAlerts = [];
  const seenIds = new Set();

  for (const entry of alerts) {
    const normalized = normalizeSentAlertEntry(entry);

    if (!normalized || seenIds.has(normalized.id)) {
      continue;
    }

    seenIds.add(normalized.id);
    normalizedAlerts.push(normalized);
  }

  const trimmedAlerts = trimSentAlerts(normalizedAlerts);

  const temporaryPath =
    `${CONFIG.sentAlertsLogPath}.tmp-${process.pid}-${Date.now()}`;

  try {
    fs.writeFileSync(
      temporaryPath,
      `${JSON.stringify(trimmedAlerts, null, 2)}\n`,
      "utf8"
    );

    fs.renameSync(
      temporaryPath,
      CONFIG.sentAlertsLogPath
    );
  } catch (error) {
    try {
      if (fs.existsSync(temporaryPath)) {
        fs.unlinkSync(temporaryPath);
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
  return new Promise((resolve, reject) => {
    let settled = false;

    const finishResolve = (value) => {
      if (settled) {
        return;
      }

      settled = true;
      resolve(value);
    };

    const finishReject = (error) => {
      if (settled) {
        return;
      }

      settled = true;
      reject(error);
    };

    const request = https.request(
      {
        hostname,
        port: 443,
        path: requestPath,
        method,
        headers
      },
      (response) => {
        let responseBody = "";

        response.setEncoding("utf8");

        response.on("data", (chunk) => {
          responseBody += chunk;
        });

        response.on("end", () => {
          const statusCode = Number(response.statusCode || 0);

          let parsedBody = null;

          if (responseBody.trim()) {
            try {
              parsedBody = JSON.parse(responseBody);
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

          if (statusCode < 200 || statusCode >= 300) {
            const description =
              isPlainObject(parsedBody) &&
              normalizeText(parsedBody.description);

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

          finishResolve(parsedBody);
        });
      }
    );

    request.setTimeout(timeoutMs, () => {
      request.destroy(
        new Error(
          `Request timed out after ${timeoutMs}ms: ${hostname}`
        )
      );
    });

    request.on("error", finishReject);

    if (body !== null) {
      request.write(body);
    }

    request.end();
  });
}

async function sendTelegramMessage(message) {
  const payload = JSON.stringify({
    chat_id: CONFIG.telegramChatId,
    text: message,
    parse_mode: "HTML",
    disable_web_page_preview: true
  });

  const response = await requestJson({
    hostname: "api.telegram.org",
    path:
      `/bot${CONFIG.telegramBotToken}` +
      "/sendMessage",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload)
    },
    body: payload
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
  const url = new URL(CONFIG.patternSignalsUrl);

  const response = await requestJson({
    hostname: url.hostname,
    path: `${url.pathname}${url.search}`,
    method: "GET",
    headers: {
      Accept: "application/json",
      "User-Agent": "PipSight-Pattern-Alerts/1.0"
    }
  });

  if (!isPlainObject(response)) {
    throw new Error(
      "Pattern signal response must be a JSON object."
    );
  }

  if (
    response.signals !== undefined &&
    !Array.isArray(response.signals)
  ) {
    throw new Error(
      'Pattern signal response field "signals" must be an array.'
    );
  }

  return response;
}

function validateSignal(signal, index) {
  if (!isPlainObject(signal)) {
    throw new Error(
      `Pattern signal at index ${index} must be an object.`
    );
  }

  const pair = normalizeText(signal.pair);
  const pattern = normalizeText(signal.pattern);
  const timeframe = normalizeText(signal.timeframe);
  const direction = normalizeDirection(signal.direction);

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

function buildTelegramMessage(signal) {
  const emoji =
    signal.direction === "BUY"
      ? "🟢"
      : "🔴";

  const confidence =
    toFiniteNumber(signal.confidence);

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
    `Entry: ${formatPrice(signal.entry, signal.pair)}`,
    `Stop: ${formatPrice(signal.stopLoss, signal.pair)}`,
    `TP1: ${formatPrice(signal.takeProfit1, signal.pair)}`,
    "",
    `R:R = 1:${formatNumber(signal.riskReward, 1)}`,
    "",
    "⚠️ Not financial advice"
  ].join("\n");
}

async function processPatternAlerts() {
  validateConfiguration();

  console.log("Fetching pattern signals...");

  const data = await fetchPatternSignals();
  const signals = Array.isArray(data.signals)
    ? data.signals
    : [];

  if (signals.length === 0) {
    console.log("No pattern signals found.");
    return {
      fetched: 0,
      sent: 0,
      skipped: 0,
      failed: 0
    };
  }

  const sentAlerts = loadSentAlerts();
  const sentIds = new Set(
    sentAlerts.map((entry) => entry.id)
  );

  let sentCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  for (let index = 0; index < signals.length; index += 1) {
    let signal;

    try {
      signal = validateSignal(signals[index], index);
    } catch (error) {
      failedCount += 1;

      console.error(
        `Skipping invalid signal at index ${index}: ${error.message}`
      );

      continue;
    }

    const signalId = buildSignalId(signal);

    if (sentIds.has(signalId)) {
      skippedCount += 1;

      console.log(
        `Skipping previously sent alert: ${signalId}`
      );

      continue;
    }

    const message = buildTelegramMessage(signal);

    try {
      await sendTelegramMessage(message);

      const logEntry = {
        id: signalId,
        sentAt: new Date().toISOString()
      };

      sentAlerts.push(logEntry);
      sentIds.add(signalId);

      /*
       * Save immediately after each successful message.
       * If a later signal fails, already-sent signals remain recorded.
       */
      saveSentAlerts(sentAlerts);

      sentCount += 1;

      console.log(
        `Telegram alert sent successfully: ${signalId}`
      );

      await delay(CONFIG.messageDelayMs);
    } catch (error) {
      failedCount += 1;

      console.error(
        `Failed to send Telegram alert ${signalId}: ${error.message}`
      );
    }
  }

  console.log(
    `Pattern alert summary: fetched=${signals.length}, ` +
    `sent=${sentCount}, skipped=${skippedCount}, ` +
    `failed=${failedCount}`
  );

  /*
   * Fail the workflow when at least one alert could not be processed.
   * This prevents false-green GitHub Actions runs.
   */
  if (failedCount > 0) {
    throw new Error(
      `${failedCount} pattern alert(s) failed to process.`
    );
  }

  return {
    fetched: signals.length,
    sent: sentCount,
    skipped: skippedCount,
    failed: failedCount
  };
}

function logFatalError(error) {
  const message =
    error instanceof Error
      ? error.stack || error.message
      : String(error);

  console.error(`Telegram pattern alerts failed:\n${message}`);
  process.exitCode = 1;
}

if (require.main === module) {
  processPatternAlerts().catch(logFatalError);
}

module.exports = {
  CONFIG,
  buildSignalId,
  buildTelegramMessage,
  fetchPatternSignals,
  loadSentAlerts,
  processPatternAlerts,
  saveSentAlerts,
  sendTelegramMessage,
  validateConfiguration,
  validateSignal
};
