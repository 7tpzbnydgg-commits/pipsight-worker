"use strict";

/**
 * PipSight Pro — Unified Telegram Alerts
 *
 * One-file notification engine for:
 * - Existing remote Pattern Detector signals
 * - Backend Scalp signals
 * - Intraday signals
 * - Swing signals
 * - Master signals
 *
 * Compatibility guarantees:
 * - Existing Pattern Detector alerts remain supported.
 * - Existing Telegram secrets remain unchanged.
 * - Existing telegram-pattern-log.json remains supported.
 * - Existing Pattern Detector alert IDs remain unchanged.
 * - HOLD / WAIT / NEUTRAL decisions never create trade alerts.
 * - No other project file or workflow requires modification.
 *
 * Reads:
 * - Remote Pattern Detector data/pattern-signals.json
 * - Local data/scalp-signals.json
 * - Local data/live-analysis.json
 *
 * Writes:
 * - telegram-pattern-log.json
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

  liveAnalysisPath: path.join(
    __dirname,
    "data",
    "live-analysis.json"
  ),

  sentAlertsLogPath: path.join(
    __dirname,
    "telegram-pattern-log.json"
  ),

  requestTimeoutMs: 15_000,
  messageDelayMs: 1_000,
  maxStoredAlerts: 5_000
});

const TRADE_DIRECTIONS = new Set([
  "BUY",
  "SELL"
]);

const NON_TRADE_DIRECTIONS = new Set([
  "",
  "HOLD",
  "WAIT",
  "NEUTRAL",
  "NONE",
  "NO_TRADE",
  "NO TRADE",
  "N/A"
]);

const LIVE_ENGINES = Object.freeze([
  "swing",
  "intraday",
  "scalp",
  "master"
]);

function validateConfiguration() {
  const missing = [];

  if (!CONFIG.telegramBotToken) {
    missing.push(
      "TELEGRAM_BOT_TOKEN"
    );
  }

  if (!CONFIG.telegramChatId) {
    missing.push(
      "TELEGRAM_CHAT_ID"
    );
  }

  if (missing.length > 0) {
    throw new Error(
      "Missing required environment variable(s): " +
      missing.join(", ")
    );
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(
      resolve,
      milliseconds
    );
  });
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function asObject(value) {
  return isPlainObject(value)
    ? value
    : {};
}

function firstDefined(...values) {
  for (const value of values) {
    if (
      value !== undefined &&
      value !== null
    ) {
      return value;
    }
  }

  return null;
}

function toFiniteNumber(value) {
  if (
    value === null ||
    value === undefined ||
    (
      typeof value === "string" &&
      value.trim() === ""
    )
  ) {
    return null;
  }

  const number =
    Number(value);

  return Number.isFinite(number)
    ? number
    : null;
}

function normalizeText(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeKey(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
}

function normalizeDirection(value) {
  const direction =
    normalizeText(value)
      .toUpperCase();

  if (
    TRADE_DIRECTIONS.has(
      direction
    )
  ) {
    return direction;
  }

  if (
    NON_TRADE_DIRECTIONS.has(
      direction
    )
  ) {
    return "";
  }

  return "";
}

function extractDirection(signal) {
  const source =
    asObject(signal);

  return normalizeDirection(
    firstDefined(
      source.decision,
      source.signal,
      source.action,
      source.direction,
      source.bias,
      source.trend
    )
  );
}

function normalizePair(value) {
  return normalizeText(value)
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/\//g, "")
    .replace(/-/g, "")
    .replace(/_/g, "");
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

  return (
    normalizeText(value) ||
    normalized ||
    "UNKNOWN"
  );
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

  return number.toFixed(
    decimals
  );
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function normalizeTimeframe(value) {
  const raw =
    normalizeText(value);

  if (!raw) {
    return "";
  }

  const compact =
    raw
      .toUpperCase()
      .replace(/\s+/g, "");

  const aliases = {
    M1: "1M",
    "1MIN": "1M",
    "1MINUTE": "1M",

    M5: "5M",
    "5MIN": "5M",
    "5MINUTE": "5M",

    M15: "15M",
    "15MIN": "15M",
    "15MINUTE": "15M",

    M30: "30M",
    "30MIN": "30M",
    "30MINUTE": "30M",

    H1: "1H",
    "1HR": "1H",
    "1HOUR": "1H",

    H4: "4H",
    "4HR": "4H",
    "4HOUR": "4H",

    D1: "1D",
    DAILY: "1D",

    W1: "1W",
    WEEKLY: "1W"
  };

  return aliases[compact] || raw;
}

function normalizeEngine(value) {
  const key =
    normalizeKey(value);

  if (key === "swing") {
    return "swing";
  }

  if (
    key === "intraday" ||
    key === "daytrade"
  ) {
    return "intraday";
  }

  if (
    key === "scalp" ||
    key === "scalping"
  ) {
    return "scalp";
  }

  if (
    key === "master" ||
    key === "final" ||
    key === "combined"
  ) {
    return "master";
  }

  if (
    key === "pattern" ||
    key === "patterndetector"
  ) {
    return "pattern";
  }

  return key || "unknown";
}

function displayEngine(value) {
  const engine =
    normalizeEngine(value);

  const labels = {
    pattern: "Pattern",
    scalp: "Scalp",
    intraday: "Intraday",
    swing: "Swing",
    master: "Master"
  };

  return (
    labels[engine] ||
    normalizeText(value) ||
    "Signal"
  );
}

function normalizeTimestamp(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return "";
  }

  if (
    typeof value === "number" &&
    Number.isFinite(value)
  ) {
    const milliseconds =
      value < 10_000_000_000
        ? value * 1000
        : value;

    const date =
      new Date(milliseconds);

    return Number.isNaN(
      date.getTime()
    )
      ? ""
      : date.toISOString();
  }

  const text =
    normalizeText(value);

  if (!text) {
    return "";
  }

  const numeric =
    Number(text);

  if (
    Number.isFinite(numeric) &&
    /^\d+$/.test(text)
  ) {
    return normalizeTimestamp(
      numeric
    );
  }

  const date =
    new Date(text);

  return Number.isNaN(
    date.getTime()
  )
    ? text
    : date.toISOString();
}

function extractTimestamp(
  signal,
  fallback = ""
) {
  const source =
    asObject(signal);

  return normalizeTimestamp(
    firstDefined(
      source.generatedAt,
      source.createdAt,
      source.updatedAt,
      source.time,
      source.timestamp,
      source.signalTime,
      fallback
    )
  );
}

function extractConfidence(signal) {
  const source =
    asObject(signal);

  const confidence =
    toFiniteNumber(
      firstDefined(
        source.confidence,
        source.confidencePct,
        source.confidencePercent,
        source.probability,
        source.scorePct
      )
    );

  if (confidence === null) {
    return null;
  }

  if (
    confidence >= 0 &&
    confidence <= 1
  ) {
    return confidence * 100;
  }

  return confidence;
}

function extractTradePlan(signal) {
  const source =
    asObject(signal);

  return asObject(
    firstDefined(
      source.tradePlan,
      source.plan,
      source.trade,
      source.levels
    )
  );
}

function calculateRiskReward({
  direction,
  entry,
  stopLoss,
  takeProfit1
}) {
  const normalizedDirection =
    normalizeDirection(direction);

  const normalizedEntry =
    toFiniteNumber(entry);

  const normalizedStop =
    toFiniteNumber(stopLoss);

  const normalizedTarget =
    toFiniteNumber(takeProfit1);

  if (
    !normalizedDirection ||
    normalizedEntry === null ||
    normalizedStop === null ||
    normalizedTarget === null
  ) {
    return null;
  }

  const risk =
    Math.abs(
      normalizedEntry -
      normalizedStop
    );

  const reward =
    Math.abs(
      normalizedTarget -
      normalizedEntry
    );

  if (
    risk <= 0 ||
    !Number.isFinite(risk) ||
    !Number.isFinite(reward)
  ) {
    return null;
  }

  return reward / risk;
}

function readJsonFile(
  filePath,
  {
    required = false,
    label = "JSON file"
  } = {}
) {
  if (!fs.existsSync(filePath)) {
    if (required) {
      throw new Error(
        `${label} was not found: ${filePath}`
      );
    }

    console.log(
      `${label} was not found. Skipping.`
    );

    return null;
  }

  try {
    const raw =
      fs
        .readFileSync(
          filePath,
          "utf8"
        )
        .trim();

    if (!raw) {
      if (required) {
        throw new Error(
          `${label} is empty.`
        );
      }

      console.log(
        `${label} is empty. Skipping.`
      );

      return null;
    }

    return JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Unable to read ${label}: ${error.message}`
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
                        error.message
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
                    )
                      ? normalizeText(
                          parsedBody.description
                        )
                      : "";

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

/*
 * Existing Pattern Detector ID structure is retained exactly.
 * Previously sent Pattern alerts will therefore not be resent.
 */
function buildPatternSignalId(signal) {
  const source =
    asObject(signal);

  const pair =
    normalizePair(
      source.pair
    ) ||
    "UNKNOWN";

  const pattern =
    normalizeText(
      source.pattern
    ) ||
    "UNKNOWN";

  const timeframe =
    normalizeText(
      source.timeframe
    ) ||
    "UNKNOWN";

  const direction =
    normalizeDirection(
      source.direction
    ) ||
    "UNKNOWN";

  const createdAt =
    normalizeText(
      source.createdAt
    ) ||
    normalizeText(
      source.timestamp
    ) ||
    normalizeText(
      source.time
    ) ||
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
 * Local PipSight alert IDs are source-prefixed.
 * This prevents Pattern, Scalp, Intraday, Swing and Master
 * alerts from colliding with one another.
 */
function buildLocalSignalId(signal) {
  const source =
    asObject(signal);

  const engine =
    normalizeEngine(
      source.engine ||
      source.mode ||
      source.source
    );

  const pair =
    normalizePair(
      source.pair ||
      source.symbol ||
      source.pairLabel
    ) ||
    "UNKNOWN";

  const direction =
    extractDirection(source) ||
    "UNKNOWN";

  const timeframe =
    normalizeTimeframe(
      source.timeframe ||
      source.interval ||
      source.period ||
      source.mode
    ) ||
    engine.toUpperCase();

  const timestamp =
    extractTimestamp(source) ||
    "UNKNOWN";

  const plan =
    extractTradePlan(source);

  const entry =
    toFiniteNumber(
      firstDefined(
        plan.entry,
        plan.entryPrice,
        source.entry,
        source.entryPrice,
        source.price
      )
    );

  return [
    "PIPSIGHT",
    engine.toUpperCase(),
    pair,
    timeframe,
    direction,
    timestamp,
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
      normalizeTimestamp(
        entry.sentAt
      ) ||
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

    const unique =
      new Map();

    for (const entry of parsed) {
      const normalized =
        normalizeSentAlertEntry(
          entry
        );

      if (!normalized) {
        continue;
      }

      unique.set(
        normalized.id,
        normalized
      );
    }

    return Array.from(
      unique.values()
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
      normalizeSentAlertEntry(
        entry
      );

    if (
      !normalized ||
      seenIds.has(
        normalized.id
      )
    ) {
      continue;
    }

    seenIds.add(
      normalized.id
    );

    normalizedAlerts.push(
      normalized
    );
  }

  const trimmed =
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
        trimmed,
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
      // Ignore temporary-file cleanup errors.
    }

    throw new Error(
      `Unable to save sent-alert log: ${error.message}`
    );
  }
}

/*
 * END OF PART 1
 *
 * Part 2 starts directly below this line.
 * Do not add module.exports or main execution yet.
 */
function normalizeTradeSignal({
  source,
  engine,
  pair,
  timeframe,
  direction,
  confidence,
  reason,
  pattern,
  timestamp,
  tradePlan,
  rawSignal
}) {
  const normalizedDirection =
    normalizeDirection(direction);

  if (!normalizedDirection) {
    return null;
  }

  const raw =
    asObject(rawSignal);

  const plan =
    asObject(tradePlan);

  const normalizedPair =
    displayPair(
      firstDefined(
        pair,
        raw.pair,
        raw.symbol,
        raw.pairLabel
      )
    );

  const entry =
    toFiniteNumber(
      firstDefined(
        plan.entry,
        plan.entryPrice,
        raw.entry,
        raw.entryPrice,
        raw.price,
        raw.currentPrice,
        raw.lastPrice
      )
    );

  const stopLoss =
    toFiniteNumber(
      firstDefined(
        plan.stopLoss,
        plan.stop,
        plan.sl,
        raw.stopLoss,
        raw.stop,
        raw.sl
      )
    );

  const takeProfit1 =
    toFiniteNumber(
      firstDefined(
        plan.target1,
        plan.takeProfit1,
        plan.tp1,
        plan.takeProfit,
        plan.tp,
        raw.target1,
        raw.takeProfit1,
        raw.tp1,
        raw.takeProfit,
        raw.tp
      )
    );

  const takeProfit2 =
    toFiniteNumber(
      firstDefined(
        plan.target2,
        plan.takeProfit2,
        plan.tp2,
        raw.target2,
        raw.takeProfit2,
        raw.tp2
      )
    );

  const takeProfit3 =
    toFiniteNumber(
      firstDefined(
        plan.target3,
        plan.takeProfit3,
        plan.tp3,
        raw.target3,
        raw.takeProfit3,
        raw.tp3
      )
    );

  if (
    entry === null ||
    stopLoss === null ||
    takeProfit1 === null
  ) {
    return null;
  }

  const normalizedRiskReward =
    toFiniteNumber(
      firstDefined(
        plan.riskReward,
        plan.rr,
        raw.riskReward,
        raw.rr
      )
    ) ??
    calculateRiskReward({
      direction:
        normalizedDirection,

      entry,
      stopLoss,
      takeProfit1
    });

  return {
    source:
      normalizeEngine(
        source ||
        engine
      ),

    engine:
      normalizeEngine(
        engine ||
        source
      ),

    pair:
      normalizedPair,

    timeframe:
      normalizeTimeframe(
        firstDefined(
          timeframe,
          raw.timeframe,
          raw.interval,
          raw.period,
          raw.mode
        )
      ) ||
      displayEngine(
        engine ||
        source
      ),

    direction:
      normalizedDirection,

    confidence:
      toFiniteNumber(
        confidence
      ) ??
      extractConfidence(raw),

    reason:
      normalizeText(
        firstDefined(
          reason,
          raw.reason,
          raw.message,
          raw.summary
        )
      ),

    pattern:
      normalizeText(
        firstDefined(
          pattern,
          raw.pattern,
          raw.setup,
          raw.strategy
        )
      ),

    timestamp:
      extractTimestamp(
        raw,
        timestamp
      ),

    entry,
    stopLoss,
    takeProfit1,
    takeProfit2,
    takeProfit3,

    riskReward:
      normalizedRiskReward
  };
}

function buildTelegramMessage(signal) {
  const directionEmoji =
    signal.direction === "BUY"
      ? "🟢"
      : "🔴";

  const engineLabel =
    displayEngine(
      signal.engine ||
      signal.source
    );

  const confidence =
    toFiniteNumber(
      signal.confidence
    );

  const confidenceText =
    confidence === null
      ? "N/A"
      : `${Math.round(confidence)}%`;

  const titleSuffix =
    signal.pattern
      ? ` — ${escapeHtml(signal.pattern)}`
      : "";

  const lines = [
    `${directionEmoji} <b>${escapeHtml(signal.pair)} ` +
      `${escapeHtml(engineLabel)} ${escapeHtml(signal.direction)}` +
      `${titleSuffix}</b>`,

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

  if (
    toFiniteNumber(
      signal.riskReward
    ) !== null
  ) {
    lines.push(
      "",
      `R:R = 1:${formatNumber(
        signal.riskReward,
        2
      )}`
    );
  }

  if (signal.reason) {
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

async function sendTelegramMessage(message) {
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

async function sendUnsentSignal({
  signal,
  signalId,
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
      buildTelegramMessage(signal)
    );

    sentAlerts.push({
      id:
        signalId,

      sentAt:
        new Date().toISOString()
    });

    sentIds.add(
      signalId
    );

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
          "PipSight-Telegram-Alerts/2.0"
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
      'Pattern response field "signals" must be an array.'
    );
  }

  return Array.isArray(
    response.signals
  )
    ? response.signals
    : [];
}

function normalizePatternSignal(
  signal,
  index
) {
  if (!isPlainObject(signal)) {
    throw new Error(
      `Pattern signal at index ${index} must be an object.`
    );
  }

  const pair =
    normalizeText(
      signal.pair
    );

  const pattern =
    normalizeText(
      signal.pattern
    );

  const timeframe =
    normalizeText(
      signal.timeframe
    );

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
      `Pattern signal at index ${index} has no BUY/SELL direction.`
    );
  }

  const normalized =
    normalizeTradeSignal({
      source:
        "pattern",

      engine:
        "pattern",

      pair,

      timeframe,

      direction,

      confidence:
        signal.confidence,

      pattern,

      reason:
        signal.reason,

      timestamp:
        firstDefined(
          signal.createdAt,
          signal.timestamp,
          signal.time
        ),

      tradePlan: {
        entry:
          signal.entry,

        stopLoss:
          firstDefined(
            signal.stopLoss,
            signal.stop,
            signal.sl
          ),

        takeProfit1:
          firstDefined(
            signal.takeProfit1,
            signal.target1,
            signal.tp1
          ),

        takeProfit2:
          firstDefined(
            signal.takeProfit2,
            signal.target2,
            signal.tp2
          ),

        takeProfit3:
          firstDefined(
            signal.takeProfit3,
            signal.target3,
            signal.tp3
          ),

        riskReward:
          firstDefined(
            signal.riskReward,
            signal.rr
          )
      },

      rawSignal:
        signal
    });

  if (!normalized) {
    throw new Error(
      `Pattern signal at index ${index} has an incomplete trade plan.`
    );
  }

  return normalized;
}

async function collectPatternAlerts() {
  console.log(
    "Fetching Pattern Detector signals..."
  );

  const rawSignals =
    await fetchPatternSignals();

  const alerts = [];
  let invalidCount = 0;

  for (
    let index = 0;
    index < rawSignals.length;
    index += 1
  ) {
    try {
      const signal =
        normalizePatternSignal(
          rawSignals[index],
          index
        );

      alerts.push({
        signal,

        /*
         * Existing ID function uses original raw fields,
         * preserving the old duplicate-protection contract.
         */
        signalId:
          buildPatternSignalId(
            rawSignals[index]
          )
      });
    } catch (error) {
      invalidCount += 1;

      console.error(
        `Skipping invalid Pattern signal at index ${index}: ` +
        error.message
      );
    }
  }

  console.log(
    `Pattern source: fetched=${rawSignals.length}, ` +
    `qualified=${alerts.length}, invalid=${invalidCount}`
  );

  return {
    alerts,
    fetched:
      rawSignals.length,

    invalid:
      invalidCount
  };
}

/*
 * END OF PART 2
 *
 * Part 3 adds data/live-analysis.json support for:
 * - Swing
 * - Intraday
 * - Master
 * - Live-analysis Scalp
 *
 * Do not add module.exports or main execution yet.
 */
function normalizeLiveSignal({
  rawSignal,
  engine,
  pairFallback,
  timestampFallback
}) {
  if (!isPlainObject(rawSignal)) {
    return null;
  }

  const normalizedEngine =
    normalizeEngine(
      firstDefined(
        rawSignal.engine,
        rawSignal.engineName,
        rawSignal.mode,
        engine
      )
    );

  const direction =
    extractDirection(
      rawSignal
    );

  /*
   * HOLD, WAIT and NEUTRAL are valid analysis results,
   * but they are not Telegram trade alerts.
   */
  if (!direction) {
    return null;
  }

  const pair =
    firstDefined(
      rawSignal.pair,
      rawSignal.pairLabel,
      rawSignal.symbol,
      pairFallback
    );

  const tradePlan =
    extractTradePlan(
      rawSignal
    );

  return normalizeTradeSignal({
    source:
      normalizedEngine,

    engine:
      normalizedEngine,

    pair,

    timeframe:
      firstDefined(
        rawSignal.timeframe,
        rawSignal.interval,
        rawSignal.period,
        rawSignal.mode,
        normalizedEngine
      ),

    direction,

    confidence:
      firstDefined(
        rawSignal.confidence,
        rawSignal.confidencePct,
        rawSignal.confidencePercent
      ),

    reason:
      firstDefined(
        rawSignal.reason,
        rawSignal.summary,
        rawSignal.message
      ),

    pattern:
      firstDefined(
        rawSignal.pattern,
        rawSignal.setup,
        rawSignal.strategy
      ),

    timestamp:
      firstDefined(
        rawSignal.generatedAt,
        rawSignal.createdAt,
        rawSignal.updatedAt,
        rawSignal.time,
        rawSignal.timestamp,
        timestampFallback
      ),

    tradePlan,

    rawSignal
  });
}

function readLiveAnalysis() {
  const payload =
    readJsonFile(
      CONFIG.liveAnalysisPath,
      {
        required:
          false,

        label:
          "data/live-analysis.json"
      }
    );

  if (payload === null) {
    return null;
  }

  if (!isPlainObject(payload)) {
    throw new Error(
      "data/live-analysis.json must contain a JSON object."
    );
  }

  if (
    payload.pairs !== undefined &&
    !isPlainObject(
      payload.pairs
    )
  ) {
    throw new Error(
      'data/live-analysis.json field "pairs" must be an object.'
    );
  }

  return payload;
}

function resolveLivePairs(payload) {
  if (!isPlainObject(payload)) {
    return {};
  }

  if (
    isPlainObject(
      payload.pairs
    )
  ) {
    return payload.pairs;
  }

  /*
   * Legacy fallback for files where pair objects
   * are stored directly at the root.
   */
  const pairs = {};

  for (
    const [
      key,
      value
    ] of Object.entries(payload)
  ) {
    const normalizedPair =
      normalizePair(key);

    if (
      (
        normalizedPair === "XAUUSD" ||
        normalizedPair === "GBPJPY"
      ) &&
      isPlainObject(value)
    ) {
      pairs[key] = value;
    }
  }

  return pairs;
}

function resolvePairEngine(
  pairData,
  engine
) {
  if (!isPlainObject(pairData)) {
    return null;
  }

  const normalizedEngine =
    normalizeEngine(engine);

  /*
   * Current schema:
   * pairData.swing
   * pairData.intraday
   * pairData.master
   *
   * Aliases remain supported for legacy compatibility.
   */
  const aliases = {
    swing: [
      "swing",
      "swingAnalysis",
      "swingSignal"
    ],

    intraday: [
      "intraday",
      "intradayAnalysis",
      "intradaySignal",
      "dayTrade"
    ],

    master: [
      "master",
      "masterAnalysis",
      "masterSignal",
      "final",
      "combined"
    ],

    scalp: [
      "scalp",
      "scalpAnalysis",
      "scalpSignal"
    ]
  };

  for (
    const key of
    aliases[normalizedEngine] || [
      normalizedEngine
    ]
  ) {
    if (
      isPlainObject(
        pairData[key]
      )
    ) {
      return pairData[key];
    }
  }

  return null;
}

function collectLiveAnalysisAlerts({
  includeScalp = false
} = {}) {
  console.log(
    "Reading live-analysis signals..."
  );

  const payload =
    readLiveAnalysis();

  if (!payload) {
    return {
      alerts: [],
      fetched: 0,
      invalid: 0
    };
  }

  const pairs =
    resolveLivePairs(
      payload
    );

  const engines =
    includeScalp
      ? LIVE_ENGINES
      : [
          "swing",
          "intraday",
          "master"
        ];

  const rootTimestamp =
    firstDefined(
      payload.generatedAt,
      payload.updatedAt,
      payload.timestamp
    );

  const alerts = [];
  let fetchedCount = 0;
  let invalidCount = 0;

  for (
    const [
      pairKey,
      pairData
    ] of Object.entries(pairs)
  ) {
    if (!isPlainObject(pairData)) {
      invalidCount += 1;

      console.error(
        `Skipping invalid live-analysis pair object: ${pairKey}`
      );

      continue;
    }

    const pairFallback =
      firstDefined(
        pairData.pair,
        pairData.pairLabel,
        pairData.symbol,
        pairKey
      );

    const pairTimestamp =
      firstDefined(
        pairData.generatedAt,
        pairData.updatedAt,
        pairData.timestamp,
        rootTimestamp
      );

    for (const engine of engines) {
      const rawSignal =
        resolvePairEngine(
          pairData,
          engine
        );

      if (!rawSignal) {
        continue;
      }

      fetchedCount += 1;

      const direction =
        extractDirection(
          rawSignal
        );

      /*
       * HOLD/WAIT/NEUTRAL are expected states.
       * They are skipped without being counted as errors.
       */
      if (!direction) {
        console.log(
          `Skipping ${displayPair(pairFallback)} ` +
          `${displayEngine(engine)} HOLD signal.`
        );

        continue;
      }

      const signal =
        normalizeLiveSignal({
          rawSignal,
          engine,
          pairFallback,
          timestampFallback:
            pairTimestamp
        });

      if (!signal) {
        invalidCount += 1;

        console.error(
          `Skipping incomplete ${displayPair(pairFallback)} ` +
          `${displayEngine(engine)} trade signal.`
        );

        continue;
      }

      alerts.push({
        signal,

        signalId:
          buildLocalSignalId(
            signal
          )
      });
    }
  }

  console.log(
    `Live-analysis source: checked=${fetchedCount}, ` +
    `qualified=${alerts.length}, invalid=${invalidCount}`
  );

  return {
    alerts,
    fetched:
      fetchedCount,

    invalid:
      invalidCount
  };
}

/*
 * END OF PART 3
 *
 * Completed in this section:
 * - Swing alerts
 * - Intraday alerts
 * - Master alerts
 * - Current and legacy live-analysis pair schemas
 * - HOLD / WAIT / NEUTRAL filtering
 *
 * Part 4 adds:
 * - data/scalp-signals.json as primary Scalp source
 * - live-analysis Scalp fallback
 * - duplicate-safe combined processing
 * - main execution and module exports
 */
function readScalpSignals() {
  const payload =
    readJsonFile(
      CONFIG.scalpSignalsPath,
      {
        required:
          false,

        label:
          "data/scalp-signals.json"
      }
    );

  if (payload === null) {
    return null;
  }

  if (
    !isPlainObject(payload) &&
    !Array.isArray(payload)
  ) {
    throw new Error(
      "data/scalp-signals.json must contain an object or array."
    );
  }

  return payload;
}

function extractScalpCandidates(payload) {
  const candidates = [];
  const visited = new Set();

  const metadataKeys =
    new Set([
      "generatedAt",
      "updatedAt",
      "createdAt",
      "timestamp",
      "version",
      "engineVersion",
      "strategyVersion",
      "metadata",
      "prepared",
      "stale",
      "status"
    ]);

  const addCandidate = (
    value,
    pairFallback = ""
  ) => {
    if (!isPlainObject(value)) {
      return;
    }

    candidates.push({
      rawSignal:
        value,

      pairFallback
    });
  };

  const hasSignalContent =
    (value) => {
      if (!isPlainObject(value)) {
        return false;
      }

      return Boolean(
        extractDirection(value) ||
        value.tradePlan ||
        value.plan ||
        value.entry !== undefined ||
        value.rawEntry !== undefined ||
        value.stopLoss !== undefined ||
        value.stop !== undefined ||
        value.sl !== undefined ||
        value.target1 !== undefined ||
        value.tp1 !== undefined
      );
    };

  const visit = (
    value,
    pairFallback = "",
    depth = 0
  ) => {
    if (
      value === null ||
      value === undefined ||
      depth > 8
    ) {
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        visit(
          item,
          pairFallback,
          depth + 1
        );
      }

      return;
    }

    if (!isPlainObject(value)) {
      return;
    }

    if (visited.has(value)) {
      return;
    }

    visited.add(value);

    const directPair =
      firstDefined(
        value.pair,
        value.pairLabel,
        value.symbol,
        pairFallback
      );

    /*
     * A complete BUY/SELL or trade-plan signal object
     * can be collected directly.
     */
    if (hasSignalContent(value)) {
      addCandidate(
        value,
        directPair
      );

      return;
    }

    /*
     * Common nested signal wrappers.
     */
    const nestedKeys = [
      "scalp",
      "scalpSignal",
      "scalpAnalysis",
      "signal",
      "analysis",
      "result",
      "latest"
    ];

    for (const key of nestedKeys) {
      const nestedValue =
        value[key];

      if (
        isPlainObject(nestedValue) ||
        Array.isArray(nestedValue)
      ) {
        visit(
          nestedValue,
          directPair,
          depth + 1
        );
      }
    }

    /*
     * Supports both array and object-map containers:
     *
     * signals: []
     * signals: { XAUUSD: {...} }
     * pairs: { XAUUSD: {...} }
     * results: {...}
     */
    const containerKeys = [
      "signals",
      "results",
      "alerts",
      "pairs",
      "data",
      "items"
    ];

    for (const key of containerKeys) {
      const container =
        value[key];

      if (
        !isPlainObject(container) &&
        !Array.isArray(container)
      ) {
        continue;
      }

      if (Array.isArray(container)) {
        visit(
          container,
          directPair,
          depth + 1
        );

        continue;
      }

      for (
        const [
          childKey,
          childValue
        ] of Object.entries(container)
      ) {
        const normalizedChildPair =
          normalizePair(childKey);

        const childPairFallback =
          (
            normalizedChildPair === "XAUUSD" ||
            normalizedChildPair === "GBPJPY"
          )
            ? childKey
            : directPair;

        visit(
          childValue,
          childPairFallback,
          depth + 1
        );
      }
    }

    /*
     * Supports pair keys placed directly at any level:
     *
     * XAUUSD: {...}
     * XAU/USD: {...}
     * GBPJPY: {...}
     * GBP/JPY: {...}
     */
    for (
      const [
        key,
        childValue
      ] of Object.entries(value)
    ) {
      if (metadataKeys.has(key)) {
        continue;
      }

      const normalizedPair =
        normalizePair(key);

      if (
        normalizedPair !== "XAUUSD" &&
        normalizedPair !== "GBPJPY"
      ) {
        continue;
      }

      visit(
        childValue,
        key,
        depth + 1
      );
    }
  };

  visit(payload);

  return candidates;
}

function normalizeScalpSignal({
  rawSignal,
  pairFallback,
  timestampFallback
}) {
  if (!isPlainObject(rawSignal)) {
    return null;
  }

  const direction =
    extractDirection(
      rawSignal
    );

  if (!direction) {
    return null;
  }

  return normalizeTradeSignal({
    source:
      "scalp",

    engine:
      "scalp",

    pair:
      firstDefined(
        rawSignal.pair,
        rawSignal.pairLabel,
        rawSignal.symbol,
        pairFallback
      ),

    timeframe:
      firstDefined(
        rawSignal.timeframe,
        rawSignal.interval,
        rawSignal.period,
        rawSignal.executionTimeframe,
        rawSignal.mode,
        "5M"
      ),

    direction,

    confidence:
      firstDefined(
        rawSignal.confidence,
        rawSignal.confidencePct,
        rawSignal.confidencePercent
      ),

    reason:
      firstDefined(
        rawSignal.reason,
        rawSignal.summary,
        rawSignal.message
      ),

    pattern:
      firstDefined(
        rawSignal.pattern,
        rawSignal.setup,
        rawSignal.strategy,
        "Backend Scalp Setup"
      ),

    timestamp:
      firstDefined(
        rawSignal.generatedAt,
        rawSignal.createdAt,
        rawSignal.updatedAt,
        rawSignal.time,
        rawSignal.timestamp,
        timestampFallback
      ),

    tradePlan:
      extractTradePlan(
        rawSignal
      ),

    rawSignal
  });
}

function collectScalpAlerts() {
  console.log(
    "Reading primary backend Scalp signals..."
  );

  const payload =
    readScalpSignals();

  if (!payload) {
    return {
      alerts: [],
      fetched: 0,
      invalid: 0
    };
  }

  const rootTimestamp =
    isPlainObject(payload)
      ? firstDefined(
          payload.generatedAt,
          payload.updatedAt,
          payload.timestamp
        )
      : "";

  const candidates =
    extractScalpCandidates(
      payload
    );

  const alerts = [];
  const seenIds = new Set();

  let invalidCount = 0;

  for (
    const {
      rawSignal,
      pairFallback
    } of candidates
  ) {
    const direction =
      extractDirection(
        rawSignal
      );

    /*
     * HOLD, WAIT and NEUTRAL are normal results.
     */
    if (!direction) {
      continue;
    }

    const signal =
      normalizeScalpSignal({
        rawSignal,
        pairFallback,
        timestampFallback:
          rootTimestamp
      });

    if (!signal) {
      invalidCount += 1;

      console.error(
        `Skipping incomplete ${displayPair(
          pairFallback ||
          rawSignal.pair ||
          rawSignal.symbol
        )} Scalp trade signal.`
      );

      continue;
    }

    const signalId =
      buildLocalSignalId(
        signal
      );

    /*
     * Prevent duplicate extraction when the same signal
     * appears in both an array and a pair-key object.
     */
    if (seenIds.has(signalId)) {
      continue;
    }

    seenIds.add(signalId);

    alerts.push({
      signal,
      signalId
    });
  }

  console.log(
    `Primary Scalp source: checked=${candidates.length}, ` +
    `qualified=${alerts.length}, invalid=${invalidCount}`
  );

  return {
    alerts,

    fetched:
      candidates.length,

    invalid:
      invalidCount
  };
}

async function collectSourceSafely(
  label,
  collector
) {
  try {
    return {
      ...await collector(),
      sourceFailed:
        false
    };
  } catch (error) {
    console.error(
      `${label} source failed: ${error.message}`
    );

    return {
      alerts: [],
      fetched: 0,
      invalid: 1,
      sourceFailed: true
    };
  }
}

function mergeAlertCollections(
  collections
) {
  const alerts = [];
  const seenIds = new Set();

  let fetched = 0;
  let invalid = 0;
  let sourceFailures = 0;

  for (const collection of collections) {
    fetched +=
      Number(
        collection.fetched || 0
      );

    invalid +=
      Number(
        collection.invalid || 0
      );

    if (collection.sourceFailed) {
      sourceFailures += 1;
    }

    for (
      const alert of
      collection.alerts || []
    ) {
      if (
        !alert ||
        !alert.signal ||
        !alert.signalId ||
        seenIds.has(
          alert.signalId
        )
      ) {
        continue;
      }

      seenIds.add(
        alert.signalId
      );

      alerts.push(alert);
    }
  }

  return {
    alerts,
    fetched,
    invalid,
    sourceFailures
  };
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

  const patternCollection =
    await collectSourceSafely(
      "Pattern Detector",
      collectPatternAlerts
    );

  const liveCollection =
    await collectSourceSafely(
      "Live Analysis",
      () =>
        collectLiveAnalysisAlerts({
          includeScalp:
            false
        })
    );

  const primaryScalpCollection =
    await collectSourceSafely(
      "Primary Scalp",
      collectScalpAlerts
    );

  /*
   * data/scalp-signals.json is the primary Scalp source.
   * live-analysis Scalp is used only when the primary source
   * contains no qualified BUY/SELL trade.
   */
  let scalpCollection =
    primaryScalpCollection;

  if (
    !primaryScalpCollection.sourceFailed &&
    primaryScalpCollection.alerts.length === 0
  ) {
    console.log(
      "No qualified primary Scalp trade found. " +
      "Checking live-analysis Scalp fallback..."
    );

    scalpCollection =
      await collectSourceSafely(
        "Live Analysis Scalp Fallback",
        () =>
          collectLiveAnalysisAlerts({
            includeScalp:
              true
          })
      );

    /*
     * includeScalp=true also returns Swing, Intraday and Master.
     * Keep only Scalp here because those engines were already
     * collected by liveCollection.
     */
    scalpCollection.alerts =
      scalpCollection.alerts.filter(
        ({ signal }) =>
          normalizeEngine(
            signal.engine
          ) === "scalp"
      );
  }

  const combined =
    mergeAlertCollections([
      patternCollection,
      liveCollection,
      scalpCollection
    ]);

  let sentCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  for (const alert of combined.alerts) {
    const result =
      await sendUnsentSignal({
        signal:
          alert.signal,

        signalId:
          alert.signalId,

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
    "Telegram alert summary: " +
    `fetched=${combined.fetched}, ` +
    `qualified=${combined.alerts.length}, ` +
    `sent=${sentCount}, ` +
    `skipped=${skippedCount}, ` +
    `invalid=${combined.invalid}, ` +
    `failed=${failedCount}, ` +
    `sourceFailures=${combined.sourceFailures}`
  );

  if (
    failedCount > 0 ||
    combined.sourceFailures > 0
  ) {
    throw new Error(
      "Telegram alert processing completed with " +
      `${failedCount} send failure(s) and ` +
      `${combined.sourceFailures} source failure(s).`
    );
  }

  return {
    fetched:
      combined.fetched,

    qualified:
      combined.alerts.length,

    sent:
      sentCount,

    skipped:
      skippedCount,

    invalid:
      combined.invalid,

    failed:
      failedCount,

    sourceFailures:
      combined.sourceFailures
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

  buildLocalSignalId,
  buildPatternSignalId,
  buildSignalId:
    buildPatternSignalId,

  buildTelegramMessage,

  collectLiveAnalysisAlerts,
  collectPatternAlerts,
  collectScalpAlerts,

  extractScalpCandidates,
  fetchPatternSignals,

  loadSentAlerts,

  normalizeLiveSignal,
  normalizePatternSignal,
  normalizeScalpSignal,
  normalizeTradeSignal,

  processPatternAlerts,

  readLiveAnalysis,
  readScalpSignals,

  saveSentAlerts,
  sendTelegramMessage,

  validateConfiguration,
  validateSignal:
    normalizePatternSignal
};
