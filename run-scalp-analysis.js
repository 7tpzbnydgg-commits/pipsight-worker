"use strict";

/* =====================================================================
   PipSight Pro AI — Scalp Signal Engine
   Version: 1.0.0

   Architecture:
   - Existing fetch-signals.js decision philosophy preserved.
   - M5 candles read from data/scalp-candles.json.
   - M15 and M30 candles generated internally from M5.
   - H1 confirmation read from data/intraday-h1.json.
   - News read from data/news-feed.json.
   - Outputs written to:
       data/scalp-signals.json
       data/scalp-signal-log.json

   Important:
   - Only closed candles are analyzed.
   - OHLC features remain enabled when valid OHLC exists.
   - No additional market-data API request is made.
   ===================================================================== */

const fs = require("fs");
const path = require("path");

const ENGINE_VERSION = "1.0.0";
const STRATEGY_VERSION = "scalp-lockstep-1.0";

const DATA_DIR = path.join(
  __dirname,
  "data"
);

const SCALP_CANDLES_PATH = path.join(
  DATA_DIR,
  "scalp-candles.json"
);

const H1_CANDLES_PATH = path.join(
  DATA_DIR,
  "intraday-h1.json"
);

const NEWS_FEED_PATH = path.join(
  DATA_DIR,
  "news-feed.json"
);

const SIGNALS_OUT_PATH = path.join(
  DATA_DIR,
  "scalp-signals.json"
);

const LOG_OUT_PATH = path.join(
  DATA_DIR,
  "scalp-signal-log.json"
);

const MAX_SIGNAL_LOG = 5000;

const MIN_M5_ROWS = 40;
const MIN_M15_ROWS = 35;
const MIN_M30_ROWS = 35;
const MIN_H1_ROWS = 20;

const PAIRS = Object.freeze([
  {
    key: "XAUUSD",
    type: "metal",
    symbol: "XAU",
    quote: "USD",
    label: "XAU/USD"
  },
  {
    key: "GBPJPY",
    type: "forex",
    base: "GBP",
    quote: "JPY",
    label: "GBP/JPY"
  }
]);

const MODES = Object.freeze([
  "M5",
  "M15",
  "M30"
]);

/* =====================================================================
   General Helpers
   ===================================================================== */

function clamp(
  value,
  minimum,
  maximum
) {
  return Math.max(
    minimum,
    Math.min(maximum, value)
  );
}

function isFiniteNumber(value) {
  return (
    typeof value === "number" &&
    Number.isFinite(value)
  );
}

function round(
  value,
  decimals = 6
) {
  if (!isFiniteNumber(value)) {
    return null;
  }

  const factor =
    10 ** decimals;

  return (
    Math.round(value * factor) /
    factor
  );
}

function decimalsFor(pair) {
  if (pair.type === "metal") {
    return 2;
  }

  if (pair.quote === "JPY") {
    return 3;
  }

  return 4;
}

function normalizePairKey(value) {
  if (
    value === null ||
    value === undefined
  ) {
    return null;
  }

  return String(value)
    .replace(/\//g, "")
    .replace(/-/g, "")
    .replace(/_/g, "")
    .replace(/\s+/g, "")
    .toUpperCase();
}

function parseTimestamp(value) {
  if (
    typeof value !== "string" &&
    typeof value !== "number"
  ) {
    return null;
  }

  let parsed;

  if (
    typeof value === "number" ||
    /^\d{10,13}$/.test(String(value))
  ) {
    const numeric =
      Number(value);

    const milliseconds =
      numeric < 100000000000
        ? numeric * 1000
        : numeric;

    parsed =
      new Date(milliseconds);
  } else {
    let normalized =
      String(value).trim();

    if (!normalized) {
      return null;
    }

    /*
       Twelve Data can return:
       2026-07-24 15:30:00

       Convert the space to T. When no timezone exists,
       UTC is used so aggregation remains deterministic.
    */

    if (
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(
        normalized
      )
    ) {
      normalized =
        normalized.replace(" ", "T");
    }

    if (
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(
        normalized
      )
    ) {
      normalized += "Z";
    }

    parsed =
      new Date(normalized);
  }

  if (
    Number.isNaN(parsed.getTime())
  ) {
    return null;
  }

  return parsed;
}

function toIsoTimestamp(value) {
  const parsed =
    value instanceof Date
      ? value
      : parseTimestamp(value);

  if (
    !parsed ||
    Number.isNaN(parsed.getTime())
  ) {
    return null;
  }

  return parsed.toISOString();
}

/* =====================================================================
   Safe File Handling
   ===================================================================== */

function readJsonFile(
  filePath,
  fallback
) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }

  try {
    const text =
      fs.readFileSync(
        filePath,
        "utf8"
      );

    if (!text.trim()) {
      return fallback;
    }

    return JSON.parse(text);
  } catch (error) {
    console.warn(
      `Unable to read ${path.basename(filePath)}: ` +
      error.message
    );

    return fallback;
  }
}

function atomicWriteJson(
  filePath,
  value
) {
  fs.mkdirSync(
    path.dirname(filePath),
    {
      recursive: true
    }
  );

  const tempPath =
    `${filePath}.${process.pid}.${Date.now()}.tmp`;

  const serialized =
    JSON.stringify(
      value,
      null,
      2
    );

  fs.writeFileSync(
    tempPath,
    serialized,
    "utf8"
  );

  try {
    fs.renameSync(
      tempPath,
      filePath
    );
  } catch (error) {
    try {
      if (
        fs.existsSync(filePath)
      ) {
        fs.unlinkSync(filePath);
      }

      fs.renameSync(
        tempPath,
        filePath
      );
    } catch (renameError) {
      if (
        fs.existsSync(tempPath)
      ) {
        fs.unlinkSync(tempPath);
      }

      throw renameError;
    }
  }
}

/* =====================================================================
   Candle Normalization
   ===================================================================== */

function normalizeCandle(raw) {
  if (
    !raw ||
    typeof raw !== "object"
  ) {
    return null;
  }

  const rawTime =
    raw.datetime ??
    raw.timestamp ??
    raw.time ??
    raw.date;

  const parsedTime =
    parseTimestamp(rawTime);

  if (!parsedTime) {
    return null;
  }

  const open =
    Number(raw.open);

  const high =
    Number(raw.high);

  const low =
    Number(raw.low);

  const close =
    Number(raw.close);

  if (
    !Number.isFinite(close) ||
    close <= 0
  ) {
    return null;
  }

  const hasValidOHLC =
    Number.isFinite(open) &&
    Number.isFinite(high) &&
    Number.isFinite(low) &&
    open > 0 &&
    high > 0 &&
    low > 0 &&
    high >= Math.max(
      open,
      close,
      low
    ) &&
    low <= Math.min(
      open,
      close,
      high
    );

  const volume =
    Number(raw.volume);

  const isClosed =
    raw.isClosed !== false &&
    raw.closed !== false &&
    raw.isFinal !== false &&
    raw.complete !== false;

  return {
    date:
      parsedTime.toISOString(),

    timestamp:
      parsedTime.getTime(),

    open:
      hasValidOHLC
        ? open
        : close,

    high:
      hasValidOHLC
        ? high
        : close,

    low:
      hasValidOHLC
        ? low
        : close,

    close,

    volume:
      Number.isFinite(volume)
        ? volume
        : null,

    hasOHLC:
      hasValidOHLC,

    isClosed
  };
}

function normalizeRows(input) {
  if (!Array.isArray(input)) {
    return {
      rows: [],
      rejected: 0,
      duplicateTimestamps: 0,
      openCandlesRemoved: 0,
      hasOHLC: false
    };
  }

  const byTimestamp =
    new Map();

  let rejected = 0;
  let duplicateTimestamps = 0;
  let openCandlesRemoved = 0;

  for (const raw of input) {
    const candle =
      normalizeCandle(raw);

    if (!candle) {
      rejected++;
      continue;
    }

    if (!candle.isClosed) {
      openCandlesRemoved++;
      continue;
    }

    if (
      byTimestamp.has(
        candle.timestamp
      )
    ) {
      duplicateTimestamps++;
    }

    byTimestamp.set(
      candle.timestamp,
      candle
    );
  }

  const rows =
    Array.from(
      byTimestamp.values()
    ).sort(
      (a, b) =>
        a.timestamp -
        b.timestamp
    );

  const hasOHLC =
    rows.length > 0 &&
    rows.every(
      row => row.hasOHLC
    );

  return {
    rows,
    rejected,
    duplicateTimestamps,
    openCandlesRemoved,
    hasOHLC
  };
}

/* =====================================================================
   Flexible Pair Extraction
   ===================================================================== */

function extractPairRows(
  source,
  pair
) {
  if (!source) {
    return [];
  }

  const expectedKey =
    normalizePairKey(pair.key);

  if (Array.isArray(source)) {
    return source.filter(row => {
      if (
        !row ||
        typeof row !== "object"
      ) {
        return false;
      }

      const rowPair =
        row.pair ??
        row.symbol ??
        row.key ??
        row.instrument;

      if (!rowPair) {
        return false;
      }

      return (
        normalizePairKey(rowPair) ===
        expectedKey
      );
    });
  }

  if (
    typeof source !== "object"
  ) {
    return [];
  }

  const possibleKeys = [
    pair.key,
    pair.label,
    pair.label.replace("/", "-"),
    pair.label.replace("/", "_"),
    pair.label.replace("/", ""),
    pair.key.toLowerCase()
  ];

  for (
    const key of possibleKeys
  ) {
    if (
      Array.isArray(source[key])
    ) {
      return source[key];
    }

    const directValue =
      source[key];

    if (
      directValue &&
      typeof directValue === "object"
    ) {
      if (
        Array.isArray(
          directValue.rows
        )
      ) {
        return directValue.rows;
      }

      if (
        Array.isArray(
          directValue.candles
        )
      ) {
        return directValue.candles;
      }

      if (
        Array.isArray(
          directValue.values
        )
      ) {
        return directValue.values;
      }
    }
  }

  const containers = [
    source.pairs,
    source.data,
    source.markets,
    source.symbols
  ];

  for (
    const container of containers
  ) {
    if (
      !container ||
      typeof container !== "object"
    ) {
      continue;
    }

    for (
      const [
        containerKey,
        containerValue
      ] of Object.entries(container)
    ) {
      if (
        normalizePairKey(
          containerKey
        ) !== expectedKey
      ) {
        continue;
      }

      if (
        Array.isArray(
          containerValue
        )
      ) {
        return containerValue;
      }

      if (
        containerValue &&
        typeof containerValue === "object"
      ) {
        if (
          Array.isArray(
            containerValue.rows
          )
        ) {
          return containerValue.rows;
        }

        if (
          Array.isArray(
            containerValue.candles
          )
        ) {
          return containerValue.candles;
        }

        if (
          Array.isArray(
            containerValue.values
          )
        ) {
          return containerValue.values;
        }
      }
    }
  }

  if (
    Array.isArray(source.rows)
  ) {
    return extractPairRows(
      source.rows,
      pair
    );
  }

  if (
    Array.isArray(source.candles)
  ) {
    return extractPairRows(
      source.candles,
      pair
    );
  }

  if (
    Array.isArray(source.values)
  ) {
    return extractPairRows(
      source.values,
      pair
    );
  }

  return [];
}

/* =====================================================================
   Source Readers
   ===================================================================== */

function readScalpRows(pair) {
  const source =
    readJsonFile(
      SCALP_CANDLES_PATH,
      {}
    );

  const extracted =
    extractPairRows(
      source,
      pair
    );

  return {
    ...normalizeRows(extracted),

    source:
      "scalp-candles.json",

    sourceUpdatedAt:
      typeof source?.updatedAt === "string"
        ? source.updatedAt
        : null,

    sourceStale:
      source?.stale === true
  };
}

function readH1Rows(pair) {
  const source =
    readJsonFile(
      H1_CANDLES_PATH,
      {}
    );

  const extracted =
    extractPairRows(
      source,
      pair
    );

  return {
    ...normalizeRows(extracted),

    source:
      "intraday-h1.json",

    sourceUpdatedAt:
      typeof source?.updatedAt === "string"
        ? source.updatedAt
        : null,

    sourceStale:
      source?.stale === true
  };
}

/* =====================================================================
   Data Quality
   ===================================================================== */

function candleDataQuality(
  normalized,
  expectedIntervalMinutes
) {
  const rows =
    normalized.rows;

  const firstDate =
    rows.length > 0
      ? rows[0].date
      : null;

  const lastDate =
    rows.length > 0
      ? rows[
          rows.length - 1
        ].date
      : null;

  let ageMinutes = null;

  if (lastDate) {
    const parsed =
      parseTimestamp(lastDate);

    if (parsed) {
      ageMinutes =
        Math.max(
          0,
          Math.floor(
            (
              Date.now() -
              parsed.getTime()
            ) / 60000
          )
        );
    }
  }

  const staleThresholdMinutes =
    expectedIntervalMinutes * 4;

  return {
    validRows:
      rows.length,

    rejectedRows:
      normalized.rejected,

    duplicateTimestamps:
      normalized
        .duplicateTimestamps,

    openCandlesRemoved:
      normalized
        .openCandlesRemoved,

    firstDate,
    lastDate,
    ageMinutes,

    expectedIntervalMinutes,

    hasOHLC:
      normalized.hasOHLC,

    stale:
      normalized.sourceStale === true ||
      (
        ageMinutes !== null &&
        ageMinutes >
          staleThresholdMinutes
      )
  };
}
