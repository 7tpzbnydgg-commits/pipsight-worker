// run-live-analysis.js
//
// PipSight Pro — Live Analysis Engine
//
// Production revision:
// • Atomic JSON writes
// • Safe JSON loading
// • Dedicated scalp engine priority
// • Legacy scalp fallback retained
// • Telegram deduplication
// • History persistence
// • Backward-compatible outputs
// • Existing JSON schema preserved

"use strict";

const fs = require("fs");
const path = require("path");

const ENGINE_VERSION = "1.3.0-pro";
const STRATEGY_VERSION = "legacy-compatible-1.1";

const TELEGRAM_TIMEOUT_MS = 15000;
const DAY_MS = 24 * 60 * 60 * 1000;

const DATA_DIR = path.join(__dirname, "data");

const HISTORY_PATH = path.join(
  DATA_DIR,
  "analysis-history.json"
);

const NOTIFY_STATE_PATH = path.join(
  DATA_DIR,
  "notify-state.json"
);

const LIVE_ANALYSIS_PATH = path.join(
  DATA_DIR,
  "live-analysis.json"
);

const PAIR_KEYS = [
  "XAUUSD",
  "GBPJPY",
];

const DECIMALS = {
  XAUUSD: 2,
  GBPJPY: 3,
};

const PAIR_ALIASES = {
  XAUUSD: [
    "XAUUSD",
    "XAU/USD",
    "XAU_USD",
    "XAU-USD",
  ],

  GBPJPY: [
    "GBPJPY",
    "GBP/JPY",
    "GBP_JPY",
    "GBP-JPY",
  ],
};

// ========================================================
// Safe JSON Helpers
// ========================================================

function readJSON(fileName) {
  const filePath = path.join(DATA_DIR, fileName);

  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    return JSON.parse(
      fs.readFileSync(filePath, "utf8")
    );
  } catch (err) {
    console.error(
      `Failed to parse ${fileName}:`,
      err.message
    );

    return null;
  }
}

function atomicWriteJSON(filePath, value) {
  fs.mkdirSync(
    path.dirname(filePath),
    {
      recursive: true,
    }
  );

  const tempFile =
    `${filePath}.${process.pid}.${Date.now()}.tmp`;

  fs.writeFileSync(
    tempFile,
    JSON.stringify(value, null, 2),
    "utf8"
  );

  fs.renameSync(
    tempFile,
    filePath
  );
}

// ========================================================
// Generic Helpers
// ========================================================

function isFiniteNumber(value) {
  return (
    typeof value === "number" &&
    Number.isFinite(value)
  );
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    if (
      value === null ||
      value === undefined ||
      value === ""
    ) {
      continue;
    }

    const numeric = Number(value);

    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }

  return null;
}

function firstString(...values) {
  for (const value of values) {
    if (
      typeof value === "string" &&
      value.trim()
    ) {
      return value.trim();
    }
  }

  return null;
}

function normalizeTime(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();

  const parsed =
    Date.parse(trimmed);

  return Number.isNaN(parsed)
    ? null
    : trimmed;
}

function normalizePairKey(value) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized =
    value
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");

  return PAIR_KEYS.includes(normalized)
    ? normalized
    : null;
}

function normalizeSignalDecision(value) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized =
    value
      .trim()
      .toUpperCase()
      .replace(/\s+/g, " ");

  if (
    normalized === "WAIT" ||
    normalized === "NEUTRAL" ||
    normalized === "NO TRADE" ||
    normalized === "NO_TRADE"
  ) {
    return "HOLD";
  }

  if (
    normalized === "BUY" ||
    normalized === "SELL" ||
    normalized === "HOLD"
  ) {
    return normalized;
  }

  return null;
}

function roundPrice(
  value,
  decimals
) {
  if (!isFiniteNumber(value)) {
    return null;
  }

  return Number(
    value.toFixed(decimals)
  );
}
