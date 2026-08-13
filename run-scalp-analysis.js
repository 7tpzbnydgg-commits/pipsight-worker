"use strict";

/* =====================================================================
   PipSight Pro AI — Scalp Signal Engine
   Version: 1.0.1

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

const ENGINE_VERSION = "1.0.1";
const STRATEGY_VERSION = "scalp-professional-confluence-2.0.0";
const PROFESSIONAL_PIPELINE_VERSION = "2.0.0";

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

/*
 * Autonomous AI control plane.
 *
 * The Scalp Engine owns per-timeframe Scalp signal authority. Every M5/M15/M30
 * baseline is evaluated by the existing AI Decision Engine and then by the
 * independent AI Safety Gate before a new live BUY/SELL is published.
 *
 * The Safety Gate is intentionally evaluated in SIGNAL_ONLY mode with an
 * ephemeral state snapshot here. Stateful account/exposure authority remains
 * owned by the downstream live safety layer; this prevents pair-wide cooldown
 * state from collapsing legitimate independent M5/M15/M30 opportunities.
 */
const AUTONOMOUS_CONFIG_PATH = path.join(
  DATA_DIR,
  "autonomous-config.json"
);

const AI_POLICY_PATH = path.join(
  DATA_DIR,
  "ai-policy.json"
);

const AI_POLICY_STATE_PATH = path.join(
  DATA_DIR,
  "ai-policy-state.json"
);

const AI_DECISION_ENGINE_PATH = path.join(
  __dirname,
  "ai-decision-engine.js"
);

const AI_SAFETY_GATE_PATH = path.join(
  __dirname,
  "ai-safety-gate.js"
);

const AUTONOMOUS_SCALP_INTEGRATION = Object.freeze({
  enabled: true,
  executionContext: "SIGNAL_ONLY",
  failClosedWhenAuthorityUnavailable: true
});

const MAX_SIGNAL_LOG = 5000;
/*
 * Duplicate suppression:
 *
 * A continuously active signal is logged again only when its trade plan
 * changes materially. A fresh signal lifecycle, direction reversal, or
 * reactivation after WAIT is always logged.
 */
const LOG_CONFIDENCE_CHANGE_THRESHOLD = 5;
const LOG_RISK_REWARD_CHANGE_THRESHOLD = 0.1;
const LOG_PLAN_RISK_CHANGE_RATIO = 0.1;
const LOG_PLAN_PRICE_CHANGE_RATIO = 0.0002;
const MIN_M5_ROWS = 40;
const MIN_M15_ROWS = 35;
const MIN_M30_ROWS = 35;
const MIN_H1_ROWS = 20;
const NEWS_MAX_AGE_HOURS = 72;

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

/*
 * Central ATR-based scalp risk configuration.
 *
 * Pair keys intentionally match the canonical PAIRS keys above. Pair labels
 * such as XAU/USD and GBP/JPY are normalized before lookup, so existing
 * upstream and downstream symbol formats remain compatible.
 */
const ATR_RISK_CONFIG = Object.freeze({
  XAUUSD: Object.freeze({
    period: 14,
    stopMultiplier: 1.0,
    target1Multiplier: 2.0,
    target2Multiplier: 3.0,
    target3Multiplier: 4.0,
    minimumRiskReward: 2.0
  }),

  GBPJPY: Object.freeze({
    period: 14,
    stopMultiplier: 1.0,
    target1Multiplier: 2.0,
    target2Multiplier: 3.0,
    target3Multiplier: 4.0,
    minimumRiskReward: 2.0
  })
});

/*
 * Professional confluence and volatility controls.
 *
 * These settings do not permit a single indicator to create a signal. Every
 * indicator is evaluated independently, then BUY and SELL evidence is scored.
 * Hard blockers remain limited to data integrity, strong HTF conflict, fresh
 * high-impact news conflict, and invalid risk geometry.
 */
const PROFESSIONAL_CONFLUENCE_CONFIG = Object.freeze({
  M5: Object.freeze({
    minimumScore: 63,
    minimumEdge: 11,
    baseStopAtr: 1.25,
    minimumRiskReward: 2.0,
    maximumStopAtr: 2.6
  }),
  M15: Object.freeze({
    minimumScore: 61,
    minimumEdge: 11,
    baseStopAtr: 1.45,
    minimumRiskReward: 2.0,
    maximumStopAtr: 2.8
  }),
  M30: Object.freeze({
    minimumScore: 60,
    minimumEdge: 12,
    baseStopAtr: 1.65,
    minimumRiskReward: 2.0,
    maximumStopAtr: 3.0
  })
});

const PAIR_ATR_MODIFIERS = Object.freeze({
  XAUUSD: 1.08,
  GBPJPY: 1.0
});

const INDICATOR_WEIGHTS = Object.freeze({
  ema: 24,
  macd: 18,
  rsi: 18,
  dmiAdx: 16,
  structure: 10,
  higherTimeframe: 10,
  candlePattern: 4
});

const SOURCE_INTERVAL_MINUTES = 5;
const RSI_PERIOD = 14;
const ADX_PERIOD = 14;
const ATR_PERCENTILE_WINDOW = 100;
const ATR_STRUCTURE_BUFFER = 0.15;


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

function atrRiskConfigFor(pairValue) {
  const key =
    normalizePairKey(pairValue);

  return (
    key &&
    ATR_RISK_CONFIG[key]
  )
    ? ATR_RISK_CONFIG[key]
    : null;
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

function isSourceStaleForPair(
  source,
  pair
) {
  if (
    !source ||
    typeof source !== "object"
  ) {
    return false;
  }

  if (source.stale === true) {
    return true;
  }

  const expectedKey =
    normalizePairKey(
      pair?.key ??
      pair?.label
    );

  if (!expectedKey) {
    return false;
  }

  if (
    source.stale &&
    typeof source.stale === "object"
  ) {
    for (
      const [key, value] of
      Object.entries(source.stale)
    ) {
      if (
        normalizePairKey(key) ===
          expectedKey &&
        value === true
      ) {
        return true;
      }
    }
  }

  if (
    source.metadata &&
    typeof source.metadata === "object"
  ) {
    for (
      const [key, metadata] of
      Object.entries(source.metadata)
    ) {
      if (
        normalizePairKey(key) ===
          expectedKey &&
        metadata &&
        typeof metadata === "object" &&
        metadata.stale === true
      ) {
        return true;
      }
    }
  }

  return false;
}

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
      isSourceStaleForPair(
        source,
        pair
      )
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
      isSourceStaleForPair(
        source,
        pair
      )
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

/* =====================================================================
   Timeframe Aggregation Engine
   ===================================================================== */

function floorToBucket(timestamp, minutes) {
  const date =
    timestamp instanceof Date
      ? new Date(timestamp.getTime())
      : parseTimestamp(timestamp);

  if (!date) {
    return null;
  }

  date.setUTCSeconds(0, 0);

  const bucketMinute =
    Math.floor(
      date.getUTCMinutes() / minutes
    ) * minutes;

  date.setUTCMinutes(bucketMinute);

  return date;
}

function aggregateCandles(
  rows,
  timeframeMinutes
) {
  if (
    !Array.isArray(rows) ||
    rows.length === 0 ||
    !Number.isInteger(timeframeMinutes) ||
    timeframeMinutes < SOURCE_INTERVAL_MINUTES ||
    timeframeMinutes % SOURCE_INTERVAL_MINUTES !== 0
  ) {
    return [];
  }

  const expectedSourceCandles =
    timeframeMinutes /
    SOURCE_INTERVAL_MINUTES;

  const sourceIntervalMs =
    SOURCE_INTERVAL_MINUTES *
    60 * 1000;

  const timeframeMs =
    timeframeMinutes *
    60 * 1000;

  const buckets =
    new Map();

  for (const row of rows) {
    if (
      !row ||
      row.isClosed !== true ||
      !isFiniteNumber(row.timestamp) ||
      ![
        row.open,
        row.high,
        row.low,
        row.close
      ].every(isFiniteNumber)
    ) {
      continue;
    }

    const bucketTime =
      floorToBucket(
        row.timestamp,
        timeframeMinutes
      );

    if (!bucketTime) {
      continue;
    }

    const key =
      bucketTime.toISOString();

    if (!buckets.has(key)) {
      buckets.set(key, {
        date: key,
        timestamp:
          bucketTime.getTime(),
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        volume:
          isFiniteNumber(row.volume)
            ? row.volume
            : 0,
        hasOHLC:
          row.hasOHLC === true,
        isClosed: false,
        sourceTimestamps: [],
        sourceCount: 0,
        expectedSourceCandles,
        timeframeMinutes
      });
    }

    const candle =
      buckets.get(key);

    candle.high =
      Math.max(
        candle.high,
        row.high
      );

    candle.low =
      Math.min(
        candle.low,
        row.low
      );

    candle.close =
      row.close;

    candle.volume +=
      isFiniteNumber(row.volume)
        ? row.volume
        : 0;

    candle.hasOHLC =
      candle.hasOHLC &&
      row.hasOHLC === true;

    candle.sourceTimestamps.push(
      row.timestamp
    );
  }

  const completed = [];

  for (const candle of buckets.values()) {
    const timestamps =
      Array.from(
        new Set(
          candle.sourceTimestamps
        )
      ).sort(
        (a, b) => a - b
      );

    candle.sourceCount =
      timestamps.length;

    const expectedFirst =
      candle.timestamp;

    const expectedLast =
      candle.timestamp +
      timeframeMs -
      sourceIntervalMs;

    const correctBoundaries =
      timestamps.length ===
        expectedSourceCandles &&
      timestamps[0] ===
        expectedFirst &&
      timestamps[
        timestamps.length - 1
      ] === expectedLast;

    let contiguous =
      correctBoundaries;

    if (contiguous) {
      for (
        let index = 1;
        index < timestamps.length;
        index += 1
      ) {
        if (
          timestamps[index] -
          timestamps[index - 1] !==
          sourceIntervalMs
        ) {
          contiguous = false;
          break;
        }
      }
    }

    candle.isClosed =
      contiguous;

    delete candle.sourceTimestamps;

    if (candle.isClosed) {
      completed.push(candle);
    }
  }

  return completed.sort(
    (a, b) =>
      a.timestamp -
      b.timestamp
  );
}

/* =====================================================================
   Internal Timeframes
   ===================================================================== */

function buildM15Rows(
  m5Rows
) {
  return aggregateCandles(
    m5Rows,
    15
  );
}

function buildM30Rows(
  m5Rows
) {
  return aggregateCandles(
    m5Rows,
    30
  );
}

/* =====================================================================
   Mode Selection
   ===================================================================== */

function rowsForMode(
  mode,
  m5Rows
) {

  switch (mode) {

    case "M5":
      return m5Rows;

    case "M15":
      return buildM15Rows(
        m5Rows
      );

    case "M30":
      return buildM30Rows(
        m5Rows
      );

    default:
      return [];

  }

}

function higherTimeframeRows(
  mode,
  m5Rows,
  h1Rows
) {

  switch (mode) {

    case "M5":
      return buildM15Rows(
        m5Rows
      );

    case "M15":
      return buildM30Rows(
        m5Rows
      );

    case "M30":
      return h1Rows;

    default:
      return null;

  }

}

/* =====================================================================
   Row Helpers
   ===================================================================== */

function latestRow(
  rows
) {

  if (
    !Array.isArray(rows) ||
    rows.length === 0
  ) {
    return null;
  }

  return rows[
    rows.length - 1
  ];

}

function closeSeries(
  rows
) {

  return rows.map(
    row => row.close
  );

}

function highSeries(
  rows
) {

  return rows.map(
    row => row.high
  );

}

function lowSeries(
  rows
) {

  return rows.map(
    row => row.low
  );

}

/* =====================================================================
   News Engine
   ===================================================================== */

function normalizeNewsPair(value) {
  return normalizePairKey(value);
}

function normalizeNewsItem(item) {

  if (
    !item ||
    typeof item !== "object"
  ) {
    return null;
  }

  const pair =
    normalizeNewsPair(
      item.pair ??
      item.symbol ??
      item.instrument
    );

  return {

    pair,

    title:
      String(
        item.title ??
        item.headline ??
        item.text ??
        ""
      ).trim(),

    impact:
      String(
        item.impact ??
        "medium"
      ).toLowerCase(),

    sentiment:
      Number(
        item.sentiment ?? 0
      ),

    publishedAt:
      toIsoTimestamp(
        item.publishedAt ??
        item.timestamp ??
        item.time ??
        item.datetime ??
        null
      ),

    source:
      item.source ??
      "",

    raw: item

  };

}

function newsItemIsFresh(
  news,
  referenceTime = new Date()
) {
  if (
    !news ||
    typeof news !== "object"
  ) {
    return false;
  }

  const published =
    parseTimestamp(
      news.publishedAt
    );

  const reference =
    referenceTime instanceof Date
      ? referenceTime
      : parseTimestamp(
          referenceTime
        );

  if (
    !published ||
    !reference
  ) {
    return false;
  }

  const ageMs =
    reference.getTime() -
    published.getTime();

  return (
    ageMs >= 0 &&
    ageMs <=
      NEWS_MAX_AGE_HOURS *
      60 * 60 * 1000
  );
}

function readNewsFeed(
  referenceTime = new Date()
) {

  const raw =
    readJsonFile(
      NEWS_FEED_PATH,
      {}
    );

  const list =
    Array.isArray(raw)
      ? raw
      : Array.isArray(raw.items)
      ? raw.items
      : [];

  return list
    .map(normalizeNewsItem)
    .filter(
      item =>
        item &&
        newsItemIsFresh(
          item,
          referenceTime
        )
    );

}

function newsForPair(
  pairLabel,
  allNews
) {

  const key =
    normalizePairKey(pairLabel);

  return allNews.filter(
    news =>
      news.pair === key
  );

}

/* =====================================================================
   News Sentiment
   ===================================================================== */

function newsScoreForPair(
  pairLabel,
  newsItems
) {

  let score = 0;

  for (const news of newsItems) {

    if (
      normalizePairKey(
        pairLabel
      ) !== news.pair
    ) {
      continue;
    }

    if (
      Number.isFinite(
        news.sentiment
      )
    ) {
      score +=
        news.sentiment;
    }

  }

  return clamp(
    score,
    -100,
    100
  );

}

function conflictingHighImpactNews(
  direction,
  newsItems,
  referenceTime = new Date()
) {

  for (const news of newsItems) {

    if (
      !newsItemIsFresh(
        news,
        referenceTime
      )
    ) {
      continue;
    }

    if (
      news.impact !== "high"
    ) {
      continue;
    }

    if (
      direction === "BUY" &&
      news.sentiment <= -10
    ) {
      return news;
    }

    if (
      direction === "SELL" &&
      news.sentiment >= 10
    ) {
      return news;
    }

  }

  return null;

}

/* =====================================================================
   Validation Helpers
   ===================================================================== */

function hasEnoughRows(
  rows,
  minimum
) {

  return (
    Array.isArray(rows) &&
    rows.length >= minimum
  );

}

function lastClose(
  rows
) {

  if (
    !rows ||
    rows.length === 0
  ) {
    return null;
  }

  return rows[
    rows.length - 1
  ].close;

}

function cloneRows(
  rows
) {

  return rows.map(
    row => ({
      ...row
    })
  );

}

/* =====================================================================
   Technical Indicator Engine
   (Ported from fetch-signals.js)
   ===================================================================== */

function emaSeries(values, period) {

  if (!Array.isArray(values)) {
    return [];
  }

  const ema =
    new Array(values.length).fill(null);

  if (
    values.length < period ||
    period < 2
  ) {
    return ema;
  }

  let seed = 0;

  for (
    let i = 0;
    i < period;
    i++
  ) {
    seed += values[i];
  }

  seed /= period;

  ema[
    period - 1
  ] = seed;

  const multiplier =
    2 / (period + 1);

  for (
    let i = period;
    i < values.length;
    i++
  ) {

    ema[i] =
      (
        values[i] -
        ema[i - 1]
      ) *
      multiplier +
      ema[i - 1];

  }

  return ema;

}

function rsiSeries(
  values,
  period = 14
) {

  const output =
    new Array(values.length)
      .fill(null);

  if (
    values.length <= period
  ) {
    return output;
  }

  let gain = 0;
  let loss = 0;

  for (
    let i = 1;
    i <= period;
    i++
  ) {

    const diff =
      values[i] -
      values[i - 1];

    if (diff >= 0) {
      gain += diff;
    } else {
      loss -= diff;
    }

  }

  let avgGain =
    gain / period;

  let avgLoss =
    loss / period;

  output[period] =
    avgLoss === 0
      ? 100
      : 100 -
        (
          100 /
          (
            1 +
            avgGain /
            avgLoss
          )
        );

  for (
    let i = period + 1;
    i < values.length;
    i++
  ) {

    const diff =
      values[i] -
      values[i - 1];

    const currentGain =
      diff > 0
        ? diff
        : 0;

    const currentLoss =
      diff < 0
        ? -diff
        : 0;

    avgGain =
      (
        avgGain *
        (period - 1) +
        currentGain
      ) / period;

    avgLoss =
      (
        avgLoss *
        (period - 1) +
        currentLoss
      ) / period;

    output[i] =
      avgLoss === 0
        ? 100
        : 100 -
          (
            100 /
            (
              1 +
              avgGain /
              avgLoss
            )
          );

  }

  return output;

}

function trueRange(
  current,
  previous
) {

  if (!previous) {
    return (
      current.high -
      current.low
    );
  }

  return Math.max(
    current.high -
      current.low,

    Math.abs(
      current.high -
      previous.close
    ),

    Math.abs(
      current.low -
      previous.close
    )
  );

}

function atrSeries(
  rows,
  period = 14
) {

  const atr =
    new Array(rows.length)
      .fill(null);

  if (
    rows.length <= period
  ) {
    return atr;
  }

  const tr = [];

  for (
    let i = 0;
    i < rows.length;
    i++
  ) {

    tr.push(
      trueRange(
        rows[i],
        i > 0
          ? rows[i - 1]
          : null
      )
    );

  }

  let sum = 0;

  for (
    let i = 0;
    i < period;
    i++
  ) {
    sum += tr[i];
  }

  atr[
    period - 1
  ] = sum / period;

  for (
    let i = period;
    i < rows.length;
    i++
  ) {

    atr[i] =
      (
        atr[i - 1] *
        (period - 1) +
        tr[i]
      ) / period;

  }

  return atr;

}

function computeVolatility(
  rows
) {

  if (
    rows.length < 3
  ) {
    return 0.004;
  }

  let total = 0;

  for (
    let i = 1;
    i < rows.length;
    i++
  ) {

    total +=
      Math.abs(
        (
          rows[i].close -
          rows[i - 1].close
        ) /
        rows[i - 1].close
      );

  }

  return (
    total /
    (rows.length - 1)
  );

}

function getAdaptivePeriods(
  rowCount
) {

  const p200 =
    Math.min(
      200,
      rowCount - 1
    );

  const p100 =
    Math.max(
      30,
      Math.round(
        p200 * 0.5
      )
    );

  const p50 =
    Math.max(
      15,
      Math.round(
        p100 * 0.6
      )
    );

  const p20 =
    Math.max(
      8,
      Math.round(
        p50 * 0.5
      )
    );

  return {
    p20,
    p50,
    p100,
    p200
  };

}

/* =====================================================================
   MACD Engine
   ===================================================================== */

function computeMACD(
  values,
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9
) {
  const emptyResult = {
    macdSeries: [],
    signalSeries: [],
    histogramSeries: [],
    macd: null,
    signal: null,
    histogram: null,
    available: false
  };

  if (
    !Array.isArray(values) ||
    values.length <
      slowPeriod + signalPeriod
  ) {
    return emptyResult;
  }

  const fastEMA =
    emaSeries(
      values,
      fastPeriod
    );

  const slowEMA =
    emaSeries(
      values,
      slowPeriod
    );

  const macdSeries =
    new Array(values.length)
      .fill(null);

  const compactMACD = [];
  const compactIndexes = [];

  for (
    let i = 0;
    i < values.length;
    i++
  ) {
    if (
      !isFiniteNumber(fastEMA[i]) ||
      !isFiniteNumber(slowEMA[i])
    ) {
      continue;
    }

    const value =
      fastEMA[i] -
      slowEMA[i];

    macdSeries[i] =
      value;

    compactMACD.push(value);
    compactIndexes.push(i);
  }

  if (
    compactMACD.length <
    signalPeriod
  ) {
    return {
      ...emptyResult,
      macdSeries
    };
  }

  const compactSignal =
    emaSeries(
      compactMACD,
      signalPeriod
    );

  const signalSeries =
    new Array(values.length)
      .fill(null);

  const histogramSeries =
    new Array(values.length)
      .fill(null);

  for (
    let i = 0;
    i < compactIndexes.length;
    i++
  ) {
    const sourceIndex =
      compactIndexes[i];

    const signalValue =
      compactSignal[i];

    if (
      !isFiniteNumber(signalValue)
    ) {
      continue;
    }

    signalSeries[sourceIndex] =
      signalValue;

    histogramSeries[sourceIndex] =
      macdSeries[sourceIndex] -
      signalValue;
  }

  const lastIndex =
    values.length - 1;

  const macd =
    macdSeries[lastIndex];

  const signal =
    signalSeries[lastIndex];

  const histogram =
    histogramSeries[lastIndex];

  return {
    macdSeries,
    signalSeries,
    histogramSeries,

    macd:
      isFiniteNumber(macd)
        ? macd
        : null,

    signal:
      isFiniteNumber(signal)
        ? signal
        : null,

    histogram:
      isFiniteNumber(histogram)
        ? histogram
        : null,

    available:
      isFiniteNumber(macd) &&
      isFiniteNumber(signal)
  };
}

/* =====================================================================
   EMA State
   ===================================================================== */

function getEMAState(rows) {
  const unavailable = {
    available: false,
    direction: null,
    biasDirection: null,
    alignmentCount: 0,
    fullAlignment: false,
    partialAlignment: false,
    lastClose: null,
    periods: null,
    values: {
      ema20: null,
      ema50: null,
      ema100: null,
      ema200: null
    },
    slopes: {
      ema20: null,
      ema50: null,
      ema100: null,
      ema200: null
    },
    bullishChecks: [],
    bearishChecks: [],
    bullishCount: 0,
    bearishCount: 0
  };

  if (
    !Array.isArray(rows) ||
    rows.length < 10
  ) {
    return unavailable;
  }

  const closes =
    closeSeries(rows);

  const periods =
    getAdaptivePeriods(
      rows.length
    );

  const series = {
    ema20:
      emaSeries(
        closes,
        periods.p20
      ),
    ema50:
      emaSeries(
        closes,
        periods.p50
      ),
    ema100:
      emaSeries(
        closes,
        periods.p100
      ),
    ema200:
      emaSeries(
        closes,
        periods.p200
      )
  };

  const lastIndex =
    closes.length - 1;

  const previousIndex =
    Math.max(
      0,
      lastIndex - 3
    );

  const lastCloseValue =
    closes[lastIndex];

  const values = {
    ema20:
      series.ema20[lastIndex],
    ema50:
      series.ema50[lastIndex],
    ema100:
      series.ema100[lastIndex],
    ema200:
      series.ema200[lastIndex]
  };

  if (
    ![
      lastCloseValue,
      values.ema20,
      values.ema50,
      values.ema100,
      values.ema200
    ].every(isFiniteNumber)
  ) {
    return {
      ...unavailable,
      lastClose:
        isFiniteNumber(lastCloseValue)
          ? lastCloseValue
          : null,
      periods,
      values
    };
  }

  const slopes = {};

  for (const key of Object.keys(series)) {
    const previous =
      series[key][previousIndex];

    slopes[key] =
      isFiniteNumber(previous) &&
      lastCloseValue !== 0
        ? (
            values[key] -
            previous
          ) /
          Math.abs(lastCloseValue)
        : null;
  }

  const bullishChecks = [
    lastCloseValue > values.ema20,
    values.ema20 > values.ema50,
    values.ema50 > values.ema100,
    values.ema100 > values.ema200
  ];

  const bearishChecks = [
    lastCloseValue < values.ema20,
    values.ema20 < values.ema50,
    values.ema50 < values.ema100,
    values.ema100 < values.ema200
  ];

  const bullishCount =
    bullishChecks.filter(Boolean)
      .length;

  const bearishCount =
    bearishChecks.filter(Boolean)
      .length;

  const bullishSlopeCount =
    [
      slopes.ema20,
      slopes.ema50
    ].filter(
      value =>
        isFiniteNumber(value) &&
        value > 0
    ).length;

  const bearishSlopeCount =
    [
      slopes.ema20,
      slopes.ema50
    ].filter(
      value =>
        isFiniteNumber(value) &&
        value < 0
    ).length;

  let direction = null;

  if (bullishCount === 4) {
    direction = "BUY";
  } else if (bearishCount === 4) {
    direction = "SELL";
  }

  let biasDirection = null;

  const bullishEvidence =
    bullishCount +
    bullishSlopeCount;

  const bearishEvidence =
    bearishCount +
    bearishSlopeCount;

  if (
    bullishEvidence >= 4 &&
    bullishEvidence >
      bearishEvidence
  ) {
    biasDirection = "BUY";
  } else if (
    bearishEvidence >= 4 &&
    bearishEvidence >
      bullishEvidence
  ) {
    biasDirection = "SELL";
  }

  const alignmentCount =
    Math.max(
      bullishCount,
      bearishCount
    );

  return {
    available: true,
    direction,
    biasDirection,
    alignmentCount,
    fullAlignment:
      direction !== null,
    partialAlignment:
      direction === null &&
      alignmentCount >= 3,
    lastClose:
      lastCloseValue,
    periods,
    values,
    slopes,
    bullishChecks,
    bearishChecks,
    bullishCount,
    bearishCount,
    bullishSlopeCount,
    bearishSlopeCount
  };
}

/* =====================================================================
   Trend Direction
   ===================================================================== */

function trendDirectionOf(rows) {
  const state =
    getEMAState(rows);

  if (
    !state.available ||
    !state.fullAlignment
  ) {
    return null;
  }

  return state.direction;
}

/* =====================================================================
   Market Structure
   ===================================================================== */

function computeMarketStructure(rows) {
  const unavailable = {
    direction: null,
    score: 0,
    label:
      "Not enough swing points",
    swingHighs: [],
    swingLows: [],
    latestHigh: null,
    previousHigh: null,
    latestLow: null,
    previousLow: null
  };

  if (
    !Array.isArray(rows) ||
    rows.length < 7
  ) {
    return unavailable;
  }

  const radius =
    rows.length > 60
      ? 3
      : rows.length > 30
      ? 2
      : 1;

  const swingHighs = [];
  const swingLows = [];

  for (
    let i = radius;
    i < rows.length - radius;
    i++
  ) {
    const current =
      rows[i];

    let isSwingHigh = true;
    let isSwingLow = true;

    for (
      let offset = 1;
      offset <= radius;
      offset++
    ) {
      const left =
        rows[i - offset];

      const right =
        rows[i + offset];

      if (
        current.high <= left.high ||
        current.high <= right.high
      ) {
        isSwingHigh = false;
      }

      if (
        current.low >= left.low ||
        current.low >= right.low
      ) {
        isSwingLow = false;
      }

      if (
        !isSwingHigh &&
        !isSwingLow
      ) {
        break;
      }
    }

    if (isSwingHigh) {
      swingHighs.push({
        index: i,
        date: current.date,
        price: current.high
      });
    }

    if (isSwingLow) {
      swingLows.push({
        index: i,
        date: current.date,
        price: current.low
      });
    }
  }

  if (
    swingHighs.length < 2 ||
    swingLows.length < 2
  ) {
    return {
      ...unavailable,
      swingHighs,
      swingLows
    };
  }

  const previousHigh =
    swingHighs[
      swingHighs.length - 2
    ];

  const latestHigh =
    swingHighs[
      swingHighs.length - 1
    ];

  const previousLow =
    swingLows[
      swingLows.length - 2
    ];

  const latestLow =
    swingLows[
      swingLows.length - 1
    ];

  const higherHigh =
    latestHigh.price >
    previousHigh.price;

  const lowerHigh =
    latestHigh.price <
    previousHigh.price;

  const higherLow =
    latestLow.price >
    previousLow.price;

  const lowerLow =
    latestLow.price <
    previousLow.price;

  let direction = null;
  let score = 0;
  let label =
    "Mixed market structure";

  if (
    higherHigh &&
    higherLow
  ) {
    direction = "BUY";
    score = 15;
    label =
      "Bullish structure: HH + HL";
  } else if (
    lowerHigh &&
    lowerLow
  ) {
    direction = "SELL";
    score = -15;
    label =
      "Bearish structure: LH + LL";
  }

  return {
    direction,
    score,
    label,

    radius,

    swingHighs,
    swingLows,

    latestHigh,
    previousHigh,
    latestLow,
    previousLow,

    higherHigh,
    lowerHigh,
    higherLow,
    lowerLow
  };
}

/* =====================================================================
   Support / Resistance
   ===================================================================== */

function computeSupportResistance(rows) {

  if (!rows || rows.length < 10) {
    return {
      supports: [],
      resistances: []
    };
  }

  const lastClose = rows[rows.length - 1].close;

  const supports = [];
  const resistances = [];

  const radius =
    rows.length > 40 ? 2 : 1;

  for (let i = radius; i < rows.length - radius; i++) {

    let swingHigh = true;
    let swingLow = true;

    for (let j = 1; j <= radius; j++) {

      if (
        rows[i].high <= rows[i-j].high ||
        rows[i].high <= rows[i+j].high
      ) {
        swingHigh = false;
      }

      if (
        rows[i].low >= rows[i-j].low ||
        rows[i].low >= rows[i+j].low
      ) {
        swingLow = false;
      }
    }

    if (swingHigh && rows[i].high > lastClose)
      resistances.push(rows[i].high);

    if (swingLow && rows[i].low < lastClose)
      supports.push(rows[i].low);
  }

  return {
    supports: supports.sort((a,b)=>b-a).slice(0,2),
    resistances: resistances.sort((a,b)=>a-b).slice(0,2)
  };

}

/* =====================================================================
   Candle Pattern
   ===================================================================== */

function detectCandlePattern(rows) {

  if (!rows || rows.length < 2)
    return null;

  const last = rows[rows.length-1];
  const prev = rows[rows.length-2];

  const bullish =
    last.close > last.open &&
    prev.close < prev.open &&
    last.close > prev.open &&
    last.open < prev.close;

  const bearish =
    last.close < last.open &&
    prev.close > prev.open &&
    last.open > prev.close &&
    last.close < prev.open;

  if (bullish)
    return "Bullish Engulfing";

  if (bearish)
    return "Bearish Engulfing";

  return null;

}

/* =====================================================================
   Risk Reward
   ===================================================================== */

function calculateRiskReward(
  entry,
  stop,
  target
) {

  const risk =
    Math.abs(entry-stop);

  const reward =
    Math.abs(target-entry);

  return risk === 0
    ? 0
    : reward/risk;

}

/* =====================================================================
   Professional Indicator Diagnostics and Confluence
   ===================================================================== */

function lastFiniteValue(
  values,
  offset = 0
) {
  if (!Array.isArray(values)) {
    return null;
  }

  let remaining =
    Math.max(
      0,
      Math.trunc(offset)
    );

  for (
    let index = values.length - 1;
    index >= 0;
    index -= 1
  ) {
    if (!isFiniteNumber(values[index])) {
      continue;
    }

    if (remaining === 0) {
      return values[index];
    }

    remaining -= 1;
  }

  return null;
}

function percentileRank(
  values,
  current
) {
  const finite =
    Array.isArray(values)
      ? values.filter(isFiniteNumber)
      : [];

  if (
    finite.length === 0 ||
    !isFiniteNumber(current)
  ) {
    return null;
  }

  const lower =
    finite.filter(
      value => value < current
    ).length;

  const equal =
    finite.filter(
      value => value === current
    ).length;

  return (
    (
      lower +
      equal * 0.5
    ) /
    finite.length
  ) * 100;
}

function median(values) {
  const finite =
    Array.isArray(values)
      ? values
          .filter(isFiniteNumber)
          .sort((a, b) => a - b)
      : [];

  if (finite.length === 0) {
    return null;
  }

  const middle =
    Math.floor(
      finite.length / 2
    );

  if (finite.length % 2 === 1) {
    return finite[middle];
  }

  return (
    finite[middle - 1] +
    finite[middle]
  ) / 2;
}

function buildRsiSnapshot(
  values,
  period = RSI_PERIOD
) {
  const series =
    rsiSeries(
      values,
      period
    );

  const current =
    lastFiniteValue(series, 0);

  const previous =
    lastFiniteValue(series, 1);

  const threeBarsAgo =
    lastFiniteValue(series, 3);

  const slope =
    isFiniteNumber(current) &&
    isFiniteNumber(previous)
      ? current - previous
      : null;

  const momentum =
    isFiniteNumber(current) &&
    isFiniteNumber(threeBarsAgo)
      ? current - threeBarsAgo
      : null;

  const crossedAbove50 =
    isFiniteNumber(current) &&
    isFiniteNumber(previous) &&
    previous <= 50 &&
    current > 50;

  const crossedBelow50 =
    isFiniteNumber(current) &&
    isFiniteNumber(previous) &&
    previous >= 50 &&
    current < 50;

  let direction = null;

  if (
    isFiniteNumber(current) &&
    (
      crossedAbove50 ||
      (
        current >= 50 &&
        isFiniteNumber(slope) &&
        slope > 0
      )
    )
  ) {
    direction = "BUY";
  } else if (
    isFiniteNumber(current) &&
    (
      crossedBelow50 ||
      (
        current <= 50 &&
        isFiniteNumber(slope) &&
        slope < 0
      )
    )
  ) {
    direction = "SELL";
  }

  return {
    available:
      isFiniteNumber(current),
    period,
    current,
    previous,
    threeBarsAgo,
    slope,
    momentum,
    crossedAbove50,
    crossedBelow50,
    overbought:
      isFiniteNumber(current) &&
      current >= 72,
    oversold:
      isFiniteNumber(current) &&
      current <= 28,
    direction,
    series
  };
}

function buildMacdSnapshot(values) {
  const macd =
    computeMACD(values);

  const previousMacd =
    lastFiniteValue(
      macd.macdSeries,
      1
    );

  const previousSignal =
    lastFiniteValue(
      macd.signalSeries,
      1
    );

  const previousHistogram =
    lastFiniteValue(
      macd.histogramSeries,
      1
    );

  const histogramSlope =
    isFiniteNumber(macd.histogram) &&
    isFiniteNumber(previousHistogram)
      ? macd.histogram -
        previousHistogram
      : null;

  const crossedBullish =
    macd.available &&
    isFiniteNumber(previousMacd) &&
    isFiniteNumber(previousSignal) &&
    previousMacd <= previousSignal &&
    macd.macd > macd.signal;

  const crossedBearish =
    macd.available &&
    isFiniteNumber(previousMacd) &&
    isFiniteNumber(previousSignal) &&
    previousMacd >= previousSignal &&
    macd.macd < macd.signal;

  let direction = null;

  if (
    macd.available &&
    macd.macd > macd.signal
  ) {
    direction = "BUY";
  } else if (
    macd.available &&
    macd.macd < macd.signal
  ) {
    direction = "SELL";
  }

  return {
    ...macd,
    previousMacd,
    previousSignal,
    previousHistogram,
    histogramSlope,
    crossedBullish,
    crossedBearish,
    direction
  };
}

function computeDmiAdx(
  rows,
  period = ADX_PERIOD
) {
  const unavailable = {
    available: false,
    period,
    plusDI: null,
    minusDI: null,
    adx: null,
    previousAdx: null,
    adxSlope: null,
    direction: null,
    trendStrength: "UNAVAILABLE"
  };

  if (
    !Array.isArray(rows) ||
    rows.length <
      period * 2 + 1
  ) {
    return unavailable;
  }

  const trueRanges =
    new Array(rows.length)
      .fill(null);

  const plusDm =
    new Array(rows.length)
      .fill(0);

  const minusDm =
    new Array(rows.length)
      .fill(0);

  for (
    let index = 1;
    index < rows.length;
    index += 1
  ) {
    const current =
      rows[index];

    const previous =
      rows[index - 1];

    trueRanges[index] =
      trueRange(
        current,
        previous
      );

    const upwardMove =
      current.high -
      previous.high;

    const downwardMove =
      previous.low -
      current.low;

    plusDm[index] =
      upwardMove > downwardMove &&
      upwardMove > 0
        ? upwardMove
        : 0;

    minusDm[index] =
      downwardMove > upwardMove &&
      downwardMove > 0
        ? downwardMove
        : 0;
  }

  let smoothedTr = 0;
  let smoothedPlus = 0;
  let smoothedMinus = 0;

  for (
    let index = 1;
    index <= period;
    index += 1
  ) {
    smoothedTr +=
      trueRanges[index];
    smoothedPlus +=
      plusDm[index];
    smoothedMinus +=
      minusDm[index];
  }

  const plusSeries =
    new Array(rows.length)
      .fill(null);

  const minusSeries =
    new Array(rows.length)
      .fill(null);

  const dxSeries =
    new Array(rows.length)
      .fill(null);

  function writeDirectionalIndex(index) {
    if (
      !isFiniteNumber(smoothedTr) ||
      smoothedTr <= 0
    ) {
      return;
    }

    const plus =
      100 *
      smoothedPlus /
      smoothedTr;

    const minus =
      100 *
      smoothedMinus /
      smoothedTr;

    plusSeries[index] = plus;
    minusSeries[index] = minus;

    const denominator =
      plus + minus;

    dxSeries[index] =
      denominator > 0
        ? 100 *
          Math.abs(
            plus - minus
          ) /
          denominator
        : 0;
  }

  writeDirectionalIndex(period);

  for (
    let index = period + 1;
    index < rows.length;
    index += 1
  ) {
    smoothedTr =
      smoothedTr -
      smoothedTr / period +
      trueRanges[index];

    smoothedPlus =
      smoothedPlus -
      smoothedPlus / period +
      plusDm[index];

    smoothedMinus =
      smoothedMinus -
      smoothedMinus / period +
      minusDm[index];

    writeDirectionalIndex(index);
  }

  const adxSeries =
    new Array(rows.length)
      .fill(null);

  const firstAdxIndex =
    period * 2 - 1;

  let dxSum = 0;
  let dxCount = 0;

  for (
    let index = period;
    index <= firstAdxIndex;
    index += 1
  ) {
    if (isFiniteNumber(dxSeries[index])) {
      dxSum += dxSeries[index];
      dxCount += 1;
    }
  }

  if (dxCount !== period) {
    return unavailable;
  }

  adxSeries[firstAdxIndex] =
    dxSum / period;

  for (
    let index = firstAdxIndex + 1;
    index < rows.length;
    index += 1
  ) {
    if (!isFiniteNumber(dxSeries[index])) {
      adxSeries[index] =
        adxSeries[index - 1];
      continue;
    }

    adxSeries[index] =
      (
        adxSeries[index - 1] *
        (period - 1) +
        dxSeries[index]
      ) /
      period;
  }

  const plusDI =
    lastFiniteValue(
      plusSeries,
      0
    );

  const minusDI =
    lastFiniteValue(
      minusSeries,
      0
    );

  const adx =
    lastFiniteValue(
      adxSeries,
      0
    );

  const previousAdx =
    lastFiniteValue(
      adxSeries,
      1
    );

  if (
    ![
      plusDI,
      minusDI,
      adx
    ].every(isFiniteNumber)
  ) {
    return unavailable;
  }

  let direction = null;

  if (plusDI > minusDI) {
    direction = "BUY";
  } else if (minusDI > plusDI) {
    direction = "SELL";
  }

  const trendStrength =
    adx >= 35
      ? "STRONG"
      : adx >= 25
      ? "TRENDING"
      : adx >= 18
      ? "DEVELOPING"
      : "WEAK";

  return {
    available: true,
    period,
    plusDI,
    minusDI,
    adx,
    previousAdx,
    adxSlope:
      isFiniteNumber(previousAdx)
        ? adx - previousAdx
        : null,
    direction,
    trendStrength,
    plusSeries,
    minusSeries,
    adxSeries
  };
}

function buildAtrSnapshot(
  rows,
  period = 14
) {
  const series =
    atrSeries(
      rows,
      period
    );

  const atr =
    lastFiniteValue(series, 0);

  const previousAtr =
    lastFiniteValue(series, 1);

  const currentPrice =
    lastClose(rows);

  const finiteTail =
    series
      .filter(isFiniteNumber)
      .slice(
        -ATR_PERCENTILE_WINDOW
      );

  const atrMedian =
    median(finiteTail);

  const percentile =
    percentileRank(
      finiteTail,
      atr
    );

  const atrPercent =
    isFiniteNumber(atr) &&
    isFiniteNumber(currentPrice) &&
    currentPrice !== 0
      ? atr /
        Math.abs(currentPrice) *
        100
      : null;

  const medianRatio =
    isFiniteNumber(atr) &&
    isFiniteNumber(atrMedian) &&
    atrMedian > 0
      ? atr / atrMedian
      : null;

  let regime =
    "UNAVAILABLE";

  if (isFiniteNumber(percentile)) {
    regime =
      percentile >= 95 ||
      (
        isFiniteNumber(medianRatio) &&
        medianRatio >= 1.75
      )
        ? "EXTREME"
        : percentile >= 80 ||
          (
            isFiniteNumber(medianRatio) &&
            medianRatio >= 1.3
          )
        ? "HIGH"
        : percentile <= 20 ||
          (
            isFiniteNumber(medianRatio) &&
            medianRatio <= 0.7
          )
        ? "LOW"
        : "NORMAL";
  }

  return {
    available:
      isFiniteNumber(atr) &&
      atr > 0,
    period,
    atr,
    previousAtr,
    atrSlope:
      isFiniteNumber(atr) &&
      isFiniteNumber(previousAtr)
        ? atr - previousAtr
        : null,
    atrPercent,
    medianAtr: atrMedian,
    medianRatio,
    percentile,
    regime,
    series
  };
}

function scoreEmaDirection(
  state,
  direction
) {
  if (!state.available) {
    return {
      available: false,
      score: 0,
      weight:
        INDICATOR_WEIGHTS.ema,
      detail:
        "EMA values unavailable"
    };
  }

  const checks =
    direction === "BUY"
      ? state.bullishChecks
      : state.bearishChecks;

  const slopeValues =
    [
      state.slopes.ema20,
      state.slopes.ema50
    ];

  const aligned =
    checks.filter(Boolean)
      .length;

  const supportiveSlopes =
    slopeValues.filter(
      value =>
        isFiniteNumber(value) &&
        (
          direction === "BUY"
            ? value > 0
            : value < 0
        )
    ).length;

  const score =
    clamp(
      aligned * 4.5 +
      supportiveSlopes * 3,
      0,
      INDICATOR_WEIGHTS.ema
    );

  return {
    available: true,
    score,
    weight:
      INDICATOR_WEIGHTS.ema,
    alignedChecks: aligned,
    supportiveSlopes,
    detail:
      `${direction} EMA checks ${aligned}/4; fast/medium slopes ${supportiveSlopes}/2`
  };
}

function scoreMacdDirection(
  snapshot,
  direction
) {
  if (!snapshot.available) {
    return {
      available: false,
      score: 0,
      weight:
        INDICATOR_WEIGHTS.macd,
      detail:
        "MACD values unavailable"
    };
  }

  const relation =
    direction === "BUY"
      ? snapshot.macd >
        snapshot.signal
      : snapshot.macd <
        snapshot.signal;

  const histogram =
    direction === "BUY"
      ? snapshot.histogram > 0
      : snapshot.histogram < 0;

  const acceleration =
    isFiniteNumber(
      snapshot.histogramSlope
    ) &&
    (
      direction === "BUY"
        ? snapshot.histogramSlope > 0
        : snapshot.histogramSlope < 0
    );

  const crossed =
    direction === "BUY"
      ? snapshot.crossedBullish
      : snapshot.crossedBearish;

  const score =
    (
      relation ? 8 : 0
    ) +
    (
      histogram ? 4 : 0
    ) +
    (
      acceleration ? 4 : 0
    ) +
    (
      crossed ? 2 : 0
    );

  return {
    available: true,
    score,
    weight:
      INDICATOR_WEIGHTS.macd,
    relation,
    histogram,
    acceleration,
    crossed,
    detail:
      `${direction} MACD relation ${relation ? "supportive" : "opposed"}; histogram ${histogram ? "supportive" : "opposed"}; acceleration ${acceleration ? "supportive" : "not supportive"}`
  };
}

function scoreRsiDirection(
  snapshot,
  direction
) {
  if (!snapshot.available) {
    return {
      available: false,
      score: 0,
      weight:
        INDICATOR_WEIGHTS.rsi,
      detail:
        "RSI unavailable"
    };
  }

  const directionalZone =
    direction === "BUY"
      ? snapshot.current >= 50
      : snapshot.current <= 50;

  const slopeSupport =
    isFiniteNumber(snapshot.slope) &&
    (
      direction === "BUY"
        ? snapshot.slope > 0
        : snapshot.slope < 0
    );

  const momentumSupport =
    isFiniteNumber(snapshot.momentum) &&
    (
      direction === "BUY"
        ? snapshot.momentum > 0
        : snapshot.momentum < 0
    );

  const crossed =
    direction === "BUY"
      ? snapshot.crossedAbove50
      : snapshot.crossedBelow50;

  const exhausted =
    direction === "BUY"
      ? snapshot.current >= 78
      : snapshot.current <= 22;

  let score =
    (
      directionalZone ? 7 : 0
    ) +
    (
      slopeSupport ? 4 : 0
    ) +
    (
      momentumSupport ? 3 : 0
    ) +
    (
      crossed ? 4 : 0
    );

  if (exhausted) {
    score -= 3;
  }

  score =
    clamp(
      score,
      0,
      INDICATOR_WEIGHTS.rsi
    );

  return {
    available: true,
    score,
    weight:
      INDICATOR_WEIGHTS.rsi,
    directionalZone,
    slopeSupport,
    momentumSupport,
    crossed,
    exhausted,
    detail:
      `RSI ${round(snapshot.current, 2)}; slope ${round(snapshot.slope, 2)}; three-bar momentum ${round(snapshot.momentum, 2)}`
  };
}

function scoreDmiDirection(
  snapshot,
  direction
) {
  if (!snapshot.available) {
    return {
      available: false,
      score: 0,
      weight:
        INDICATOR_WEIGHTS.dmiAdx,
      detail:
        "ADX/DMI unavailable"
    };
  }

  const directional =
    direction === "BUY"
      ? snapshot.plusDI >
        snapshot.minusDI
      : snapshot.minusDI >
        snapshot.plusDI;

  const diGap =
    Math.abs(
      snapshot.plusDI -
      snapshot.minusDI
    );

  const trending =
    snapshot.adx >= 25;

  const developing =
    snapshot.adx >= 18;

  const rising =
    isFiniteNumber(snapshot.adxSlope) &&
    snapshot.adxSlope > 0;

  const score =
    (
      directional ? 7 : 0
    ) +
    (
      trending ? 5 :
      developing ? 2 : 0
    ) +
    (
      rising ? 2 : 0
    ) +
    (
      directional &&
      diGap >= 8
        ? 2
        : 0
    );

  return {
    available: true,
    score:
      clamp(
        score,
        0,
        INDICATOR_WEIGHTS.dmiAdx
      ),
    weight:
      INDICATOR_WEIGHTS.dmiAdx,
    directional,
    trending,
    rising,
    diGap,
    detail:
      `ADX ${round(snapshot.adx, 2)} (${snapshot.trendStrength}); +DI ${round(snapshot.plusDI, 2)}, -DI ${round(snapshot.minusDI, 2)}`
  };
}

function inferHigherTimeframeBias(rows) {
  if (
    !Array.isArray(rows) ||
    rows.length < 20
  ) {
    return {
      available: false,
      direction: null,
      strength: 0,
      buyVotes: 0,
      sellVotes: 0,
      detail:
        "Higher timeframe data unavailable"
    };
  }

  const closes =
    closeSeries(rows);

  const ema =
    getEMAState(rows);

  const macd =
    buildMacdSnapshot(closes);

  const rsi =
    buildRsiSnapshot(closes);

  const dmi =
    computeDmiAdx(rows);

  const structure =
    computeMarketStructure(rows);

  let buyVotes = 0;
  let sellVotes = 0;
  let possibleVotes = 0;

  if (ema.available) {
    possibleVotes += 4;
    if (
      ema.direction === "BUY"
    ) {
      buyVotes += 4;
    } else if (
      ema.direction === "SELL"
    ) {
      sellVotes += 4;
    } else if (
      ema.biasDirection === "BUY"
    ) {
      buyVotes += 2.5;
    } else if (
      ema.biasDirection === "SELL"
    ) {
      sellVotes += 2.5;
    }
  }

  if (macd.available) {
    possibleVotes += 2;
    if (macd.direction === "BUY") {
      buyVotes += 2;
    } else if (macd.direction === "SELL") {
      sellVotes += 2;
    }
  }

  if (rsi.available) {
    possibleVotes += 1.5;
    if (rsi.direction === "BUY") {
      buyVotes += 1.5;
    } else if (rsi.direction === "SELL") {
      sellVotes += 1.5;
    }
  }

  if (dmi.available) {
    possibleVotes += 2.5;
    if (dmi.direction === "BUY") {
      buyVotes += 2.5;
    } else if (dmi.direction === "SELL") {
      sellVotes += 2.5;
    }
  }

  if (structure.direction) {
    possibleVotes += 1;
    if (structure.direction === "BUY") {
      buyVotes += 1;
    } else if (structure.direction === "SELL") {
      sellVotes += 1;
    }
  }

  let direction = null;

  if (
    buyVotes >= 4 &&
    buyVotes > sellVotes
  ) {
    direction = "BUY";
  } else if (
    sellVotes >= 4 &&
    sellVotes > buyVotes
  ) {
    direction = "SELL";
  }

  const winningVotes =
    Math.max(
      buyVotes,
      sellVotes
    );

  const strength =
    possibleVotes > 0
      ? winningVotes /
        possibleVotes *
        100
      : 0;

  return {
    available:
      possibleVotes > 0,
    direction,
    strength,
    buyVotes,
    sellVotes,
    possibleVotes,
    detail:
      `HTF votes BUY ${round(buyVotes, 2)}, SELL ${round(sellVotes, 2)}; strength ${round(strength, 2)}%`,
    indicators: {
      ema,
      macd: {
        available: macd.available,
        direction: macd.direction,
        macd: macd.macd,
        signal: macd.signal,
        histogram: macd.histogram
      },
      rsi: {
        available: rsi.available,
        direction: rsi.direction,
        current: rsi.current,
        slope: rsi.slope
      },
      dmi: {
        available: dmi.available,
        direction: dmi.direction,
        adx: dmi.adx,
        plusDI: dmi.plusDI,
        minusDI: dmi.minusDI
      },
      structure
    }
  };
}

function scoreDirection({
  direction,
  ema,
  macd,
  rsi,
  dmi,
  structure,
  higherTimeframe,
  candlePattern
}) {
  const components = {
    ema:
      scoreEmaDirection(
        ema,
        direction
      ),
    macd:
      scoreMacdDirection(
        macd,
        direction
      ),
    rsi:
      scoreRsiDirection(
        rsi,
        direction
      ),
    dmiAdx:
      scoreDmiDirection(
        dmi,
        direction
      )
  };

  const structureAvailable =
    Boolean(
      structure &&
      structure.direction
    );

  components.structure = {
    available:
      structureAvailable,
    weight:
      INDICATOR_WEIGHTS.structure,
    score:
      structureAvailable &&
      structure.direction === direction
        ? INDICATOR_WEIGHTS.structure
        : 0,
    detail:
      structure?.label ??
      "Market structure unavailable"
  };

  const htfAvailable =
    higherTimeframe?.available === true &&
    Boolean(
      higherTimeframe.direction
    );

  components.higherTimeframe = {
    available:
      htfAvailable,
    weight:
      INDICATOR_WEIGHTS.higherTimeframe,
    score:
      htfAvailable &&
      higherTimeframe.direction === direction
        ? INDICATOR_WEIGHTS.higherTimeframe *
          clamp(
            higherTimeframe.strength /
            70,
            0.55,
            1
          )
        : 0,
    detail:
      higherTimeframe?.detail ??
      "Higher timeframe unavailable"
  };

  const bullishPattern =
    candlePattern ===
    "Bullish Engulfing";

  const bearishPattern =
    candlePattern ===
    "Bearish Engulfing";

  const patternAvailable =
    bullishPattern ||
    bearishPattern;

  components.candlePattern = {
    available:
      patternAvailable,
    weight:
      INDICATOR_WEIGHTS.candlePattern,
    score:
      (
        direction === "BUY" &&
        bullishPattern
      ) ||
      (
        direction === "SELL" &&
        bearishPattern
      )
        ? INDICATOR_WEIGHTS.candlePattern
        : 0,
    detail:
      candlePattern ??
      "No directional candle pattern"
  };

  let rawScore = 0;
  let availableWeight = 0;

  for (const component of Object.values(components)) {
    if (!component.available) {
      continue;
    }

    rawScore +=
      component.score;

    availableWeight +=
      component.weight;
  }

  const normalizedScore =
    availableWeight >= 60
      ? rawScore /
        availableWeight *
        100
      : 0;

  return {
    direction,
    rawScore:
      round(rawScore, 4),
    availableWeight:
      round(availableWeight, 4),
    score:
      round(
        clamp(
          normalizedScore,
          0,
          100
        ),
        2
      ),
    components
  };
}

function modeConfluenceConfig(mode) {
  return (
    PROFESSIONAL_CONFLUENCE_CONFIG[
      String(mode ?? "M5")
        .trim()
        .toUpperCase()
    ] ||
    PROFESSIONAL_CONFLUENCE_CONFIG.M5
  );
}

function selectDirection(
  buy,
  sell,
  mode
) {
  const config =
    modeConfluenceConfig(mode);

  const winner =
    buy.score >= sell.score
      ? buy
      : sell;

  const loser =
    winner === buy
      ? sell
      : buy;

  const edge =
    winner.score -
    loser.score;

  const qualified =
    winner.score >=
      config.minimumScore &&
    edge >=
      config.minimumEdge;

  return {
    direction:
      qualified
        ? winner.direction
        : null,
    qualified,
    winnerScore:
      winner.score,
    opposingScore:
      loser.score,
    edge:
      round(edge, 2),
    requiredScore:
      config.minimumScore,
    requiredEdge:
      config.minimumEdge,
    config
  };
}

function selectStructureLevel(
  direction,
  entry,
  supportResistance,
  structure
) {
  const candidates = [];

  if (direction === "BUY") {
    for (
      const value of supportResistance.supports || []
    ) {
      if (
        isFiniteNumber(value) &&
        value < entry
      ) {
        candidates.push(value);
      }
    }

    const swingLow =
      structure?.latestLow?.price;

    if (
      isFiniteNumber(swingLow) &&
      swingLow < entry
    ) {
      candidates.push(swingLow);
    }

    return candidates.length > 0
      ? Math.max(...candidates)
      : null;
  }

  for (
    const value of supportResistance.resistances || []
  ) {
    if (
      isFiniteNumber(value) &&
      value > entry
    ) {
      candidates.push(value);
    }
  }

  const swingHigh =
    structure?.latestHigh?.price;

  if (
    isFiniteNumber(swingHigh) &&
    swingHigh > entry
  ) {
    candidates.push(swingHigh);
  }

  return candidates.length > 0
    ? Math.min(...candidates)
    : null;
}

function buildProfessionalTradePlan({
  direction,
  entry,
  pairLabel,
  mode,
  atrSnapshot,
  supportResistance,
  structure
}) {
  const config =
    modeConfluenceConfig(mode);

  const pairKey =
    normalizePairKey(pairLabel);

  const pairModifier =
    PAIR_ATR_MODIFIERS[
      pairKey
    ] ?? 1;

  const regimeMultiplier =
    atrSnapshot.regime === "LOW"
      ? 0.9
      : atrSnapshot.regime === "HIGH"
      ? 1.15
      : atrSnapshot.regime === "EXTREME"
      ? 1.3
      : 1;

  const atr =
    atrSnapshot.atr;

  if (
    !isFiniteNumber(entry) ||
    !isFiniteNumber(atr) ||
    atr <= 0
  ) {
    return {
      valid: false,
      reason:
        "ATR or entry is unavailable"
    };
  }

  const baseMultiplier =
    config.baseStopAtr *
    pairModifier *
    regimeMultiplier;

  const baseRiskDistance =
    atr *
    baseMultiplier;

  const structureLevel =
    selectStructureLevel(
      direction,
      entry,
      supportResistance,
      structure
    );

  let structureRiskDistance = null;

  if (isFiniteNumber(structureLevel)) {
    structureRiskDistance =
      direction === "BUY"
        ? entry -
          structureLevel +
          atr *
          ATR_STRUCTURE_BUFFER
        : structureLevel -
          entry +
          atr *
          ATR_STRUCTURE_BUFFER;
  }

  const riskDistance =
    Math.max(
      baseRiskDistance,
      isFiniteNumber(
        structureRiskDistance
      )
        ? structureRiskDistance
        : 0
    );

  const riskAtrMultiple =
    riskDistance / atr;

  if (
    riskAtrMultiple >
      config.maximumStopAtr
  ) {
    return {
      valid: false,
      reason:
        `Required structural stop is ${round(riskAtrMultiple, 2)} ATR; maximum is ${config.maximumStopAtr} ATR`,
      atr,
      structureLevel,
      riskAtrMultiple
    };
  }

  const priceDecimals =
    pairKey === "XAUUSD"
      ? 2
      : pairKey === "GBPJPY"
      ? 3
      : 6;

  const roundedEntry =
    round(
      entry,
      priceDecimals
    );

  const stopLoss =
    round(
      direction === "BUY"
        ? roundedEntry - riskDistance
        : roundedEntry + riskDistance,
      priceDecimals
    );

  const roundedRiskDistance =
    Math.abs(
      roundedEntry -
      stopLoss
    );

  if (
    !isFiniteNumber(roundedRiskDistance) ||
    roundedRiskDistance <= 0
  ) {
    return {
      valid: false,
      reason:
        "Rounded ATR stop distance is zero or invalid"
    };
  }

  const target1 =
    round(
      direction === "BUY"
        ? roundedEntry +
          roundedRiskDistance *
          config.minimumRiskReward
        : roundedEntry -
          roundedRiskDistance *
          config.minimumRiskReward,
      priceDecimals
    );

  const target2 =
    round(
      direction === "BUY"
        ? roundedEntry +
          roundedRiskDistance * 3
        : roundedEntry -
          roundedRiskDistance * 3,
      priceDecimals
    );

  const target3 =
    round(
      direction === "BUY"
        ? roundedEntry +
          roundedRiskDistance * 4
        : roundedEntry -
          roundedRiskDistance * 4,
      priceDecimals
    );

  const blockingLevel =
    direction === "BUY"
      ? supportResistance
          .resistances?.[0]
      : supportResistance
          .supports?.[0];

  let roomToLevelR = null;

  if (isFiniteNumber(blockingLevel)) {
    const room =
      direction === "BUY"
        ? blockingLevel - entry
        : entry - blockingLevel;

    if (room > 0) {
      roomToLevelR =
        room / riskDistance;
    }
  }

  if (
    isFiniteNumber(roomToLevelR) &&
    roomToLevelR <
      config.minimumRiskReward
  ) {
    return {
      valid: false,
      reason:
        `Nearest opposing level provides only ${round(roomToLevelR, 2)}R room; ${config.minimumRiskReward}R is required`,
      atr,
      structureLevel,
      blockingLevel,
      roomToLevelR,
      riskAtrMultiple
    };
  }

  const riskReward =
    calculateRiskReward(
      roundedEntry,
      stopLoss,
      target1
    );

  const geometryValid =
    direction === "BUY"
      ? stopLoss < entry &&
        entry < target1 &&
        target1 < target2 &&
        target2 < target3
      : target3 < target2 &&
        target2 < target1 &&
        target1 < entry &&
        entry < stopLoss;

  if (
    !geometryValid ||
    riskReward <
      config.minimumRiskReward
  ) {
    return {
      valid: false,
      reason:
        "Generated ATR trade-plan geometry is invalid"
    };
  }

  return {
    valid: true,
    reason: null,
    plan: {
      entry:
        roundedEntry,
      stopLoss,
      target1,
      target2,
      target3,
      riskReward:
        round(riskReward, 2),
      atr:
        round(
          atr,
          priceDecimals
        ),
      atrPeriod:
        atrSnapshot.period,
      atrPercent:
        round(
          atrSnapshot.atrPercent,
          6
        ),
      atrPercentile:
        round(
          atrSnapshot.percentile,
          2
        ),
      atrRegime:
        atrSnapshot.regime,
      riskModel:
        "ATR_REGIME_STRUCTURE",
      stopAtrMultiplier:
        round(
          riskAtrMultiple,
          4
        ),
      baseStopAtrMultiplier:
        round(
          baseMultiplier,
          4
        ),
      structureLevel:
        isFiniteNumber(structureLevel)
          ? round(
              structureLevel,
              priceDecimals
            )
          : null,
      opposingLevel:
        isFiniteNumber(blockingLevel)
          ? round(
              blockingLevel,
              priceDecimals
            )
          : null,
      roomToOpposingLevelR:
        round(
          roomToLevelR,
          4
        ),
      targetAtrMultipliers: {
        target1:
          round(
            riskDistance *
            config.minimumRiskReward /
            atr,
            4
          ),
        target2:
          round(
            riskDistance * 3 /
            atr,
            4
          ),
        target3:
          round(
            riskDistance * 4 /
            atr,
            4
          )
      }
    },
    diagnostics: {
      baseMultiplier,
      regimeMultiplier,
      pairModifier,
      baseRiskDistance,
      structureRiskDistance,
      riskDistance,
      riskAtrMultiple,
      structureLevel,
      blockingLevel,
      roomToLevelR
    }
  };
}

/* =====================================================================
   Professional M5 Execution & Risk Layer

   Additive authority only:
   - Existing setup/confluence direction is accepted as immutable input.
   - Entry timing is validated on the supplied execution timeframe rows.
   - Production worker supplies fully closed M5 rows for M5/M15/M30 setups.
   - Entry paths: breakout-retest, pullback-resumption, momentum continuation.
   - EXTREME execution volatility blocks direct momentum chasing.
   - SL/TP are rebuilt from execution-timeframe ATR/structure, then checked
     against setup-timeframe opposing structure so wide setup-TF ATR does not
     automatically force wide M5 execution plans.
   - No opposite-direction signal is created here. Failure means WAIT.
   ===================================================================== */

function evaluateProfessionalExecutionRiskLayer({
  direction,
  executionRows,
  executionTimeframe,
  pairLabel,
  setupMode,
  setupSupportResistance,
  setupStructure,
  setupHigherTimeframe,
  previousSignal
}) {
  const rows =
    Array.isArray(executionRows)
      ? executionRows
          .filter(
            row =>
              row &&
              row.isClosed === true &&
              [
                row.open,
                row.high,
                row.low,
                row.close,
                row.timestamp
              ].every(isFiniteNumber)
          )
          .slice()
          .sort(
            (a, b) =>
              a.timestamp -
              b.timestamp
          )
      : [];

  const normalizedDirection =
    String(direction ?? "")
      .trim()
      .toUpperCase();

  const normalizedExecutionTimeframe =
    String(
      executionTimeframe ??
      "M5"
    )
      .trim()
      .toUpperCase();

  if (
    normalizedDirection !== "BUY" &&
    normalizedDirection !== "SELL"
  ) {
    return {
      valid: false,
      waiting: true,
      reason:
        "Execution layer requires an already-qualified BUY or SELL direction",
      entryModel: null,
      tradePlan: null,
      diagnostics: {
        setupMode,
        executionTimeframe:
          normalizedExecutionTimeframe
      }
    };
  }

  function isUsableExistingTradePlan(plan) {
    if (
      !plan ||
      typeof plan !== "object"
    ) {
      return false;
    }

    const entry = Number(plan.entry);
    const stopLoss = Number(plan.stopLoss);
    const target1 = Number(plan.target1);
    const target2 = Number(plan.target2);
    const target3 = Number(plan.target3);

    if (
      ![
        entry,
        stopLoss,
        target1,
        target2,
        target3
      ].every(Number.isFinite)
    ) {
      return false;
    }

    return normalizedDirection === "BUY"
      ? (
          stopLoss < entry &&
          entry < target1 &&
          target1 < target2 &&
          target2 < target3
        )
      : (
          target3 < target2 &&
          target2 < target1 &&
          target1 < entry &&
          entry < stopLoss
        );
  }

  function resolveExistingTradePlanOutcome(
    plan,
    executionCandleAt
  ) {
    if (
      !isUsableExistingTradePlan(plan)
    ) {
      return null;
    }

    const executionTime =
      parseTimestamp(
        executionCandleAt
      );

    if (!executionTime) {
      return null;
    }

    const executionTimeMs =
      executionTime.getTime();

    const stopLoss =
      Number(plan.stopLoss);

    const target1 =
      Number(plan.target1);

    for (const row of rows) {
      if (
        !isFiniteNumber(row.timestamp) ||
        row.timestamp <=
          executionTimeMs
      ) {
        continue;
      }

      const stopHit =
        normalizedDirection === "BUY"
          ? row.low <= stopLoss
          : row.high >= stopLoss;

      const targetHit =
        normalizedDirection === "BUY"
          ? row.high >= target1
          : row.low <= target1;

      if (stopHit && targetHit) {
        return {
          result: "LOSS",
          reason:
            "SL and TP1 crossed within the same closed M5 candle; conservative SL-first resolution applied",
          resolvedCandleAt:
            row.date ?? null
        };
      }

      if (stopHit) {
        return {
          result: "LOSS",
          reason:
            "Closed M5 path crossed the preserved stop loss",
          resolvedCandleAt:
            row.date ?? null
        };
      }

      if (targetHit) {
        return {
          result: "WIN",
          reason:
            "Closed M5 path crossed the preserved TP1",
          resolvedCandleAt:
            row.date ?? null
        };
      }
    }

    return null;
  }

  const previousDirection =
    normalizeSignalDirection(
      previousSignal?.signal
    );

  const previousPlanUsable =
    previousDirection ===
      normalizedDirection &&
    isUsableExistingTradePlan(
      previousSignal?.tradePlan
    );

  const previousTradeOutcome =
    previousPlanUsable
      ? resolveExistingTradePlanOutcome(
          previousSignal.tradePlan,
          previousSignal
            ?.executionCandleAt ??
          null
        )
      : null;

  if (
    previousPlanUsable &&
    previousTradeOutcome
  ) {
    return {
      valid: false,
      waiting: true,
      reason:
        `Previous active trade resolved ${previousTradeOutcome.result} on the closed M5 path; waiting for a fresh execution`,
      entryModel: null,
      tradePlan: null,
      diagnostics: {
        setupMode,
        executionTimeframe:
          normalizedExecutionTimeframe,
        entryModel:
          "ACTIVE_SIGNAL_RESOLVED",
        preservedActiveTradePlan:
          false,
        originalExecutionCandleAt:
          previousSignal
            ?.executionCandleAt ??
          null,
        resolution:
          previousTradeOutcome
      }
    };
  }

  if (previousPlanUsable) {
    return {
      valid: true,
      waiting: false,
      reason: null,
      entryModel:
        "ACTIVE_SIGNAL_CONTINUATION",
      tradePlan: {
        ...previousSignal.tradePlan
      },
      diagnostics: {
        setupMode,
        executionTimeframe:
          normalizedExecutionTimeframe,
        entryModel:
          "ACTIVE_SIGNAL_CONTINUATION",
        preservedActiveTradePlan:
          true,
        originalExecutionCandleAt:
          previousSignal
            ?.executionCandleAt ??
          null
      }
    };
  }

  if (rows.length < 4) {
    return {
      valid: false,
      waiting: true,
      reason:
        "Not enough fully closed execution candles for professional entry confirmation",
      entryModel: null,
      tradePlan: null,
      diagnostics: {
        setupMode,
        executionTimeframe:
          normalizedExecutionTimeframe,
        executionRows:
          rows.length
      }
    };
  }

  const atrPeriod =
    atrRiskConfigFor(pairLabel)
      ?.period ?? 14;

  const executionAtr =
    buildAtrSnapshot(
      rows,
      atrPeriod
    );

  if (!executionAtr.available) {
    return {
      valid: false,
      waiting: true,
      reason:
        "Execution-timeframe ATR is unavailable",
      entryModel: null,
      tradePlan: null,
      diagnostics: {
        setupMode,
        executionTimeframe:
          normalizedExecutionTimeframe,
        atrPeriod
      }
    };
  }

  const structureBuffer =
    executionAtr.atr *
    ATR_STRUCTURE_BUFFER;

  function contextBefore(excludedTail) {
    const contextRows =
      rows.slice(
        0,
        Math.max(
          0,
          rows.length -
          excludedTail
        )
      );

    return {
      rows:
        contextRows,
      structure:
        computeMarketStructure(
          contextRows
        ),
      supportResistance:
        computeSupportResistance(
          contextRows
        )
    };
  }

  function nearestBreakoutLevel(
    context,
    referencePrice
  ) {
    const candidates = [];

    if (
      !context ||
      !isFiniteNumber(referencePrice)
    ) {
      return null;
    }

    if (
      normalizedDirection ===
      "BUY"
    ) {
      for (
        const value of
          context
            .supportResistance
            .resistances || []
      ) {
        if (
          isFiniteNumber(value) &&
          value > referencePrice
        ) {
          candidates.push(value);
        }
      }

      for (
        const value of [
          context.structure
            ?.latestHigh?.price,
          context.structure
            ?.previousHigh?.price
        ]
      ) {
        if (
          isFiniteNumber(value) &&
          value > referencePrice
        ) {
          candidates.push(value);
        }
      }

      return candidates.length > 0
        ? Math.min(...candidates)
        : null;
    }

    for (
      const value of
        context
          .supportResistance
          .supports || []
    ) {
      if (
        isFiniteNumber(value) &&
        value < referencePrice
      ) {
        candidates.push(value);
      }
    }

    for (
      const value of [
        context.structure
          ?.latestLow?.price,
        context.structure
          ?.previousLow?.price
      ]
    ) {
      if (
        isFiniteNumber(value) &&
        value < referencePrice
      ) {
        candidates.push(value);
      }
    }

    return candidates.length > 0
      ? Math.max(...candidates)
      : null;
  }

  function directionalBody(candle) {
    if (!candle) {
      return false;
    }

    return normalizedDirection ===
      "BUY"
      ? candle.close > candle.open
      : candle.close < candle.open;
  }

  function breakoutPassed(
    candle,
    level,
    previousClose
  ) {
    if (
      !candle ||
      !isFiniteNumber(level) ||
      !isFiniteNumber(previousClose)
    ) {
      return false;
    }

    if (
      normalizedDirection ===
      "BUY"
    ) {
      return (
        previousClose <= level &&
        candle.close > level &&
        directionalBody(candle)
      );
    }

    return (
      previousClose >= level &&
      candle.close < level &&
      directionalBody(candle)
    );
  }

  function retestHeld(
    candle,
    level
  ) {
    if (
      !candle ||
      !isFiniteNumber(level)
    ) {
      return false;
    }

    if (
      normalizedDirection ===
      "BUY"
    ) {
      return (
        candle.low <=
          level +
          structureBuffer &&
        candle.close >= level &&
        directionalBody(candle)
      );
    }

    return (
      candle.high >=
        level -
        structureBuffer &&
      candle.close <= level &&
      directionalBody(candle)
    );
  }

  function closesBeyond(
    candle,
    referenceCandle
  ) {
    if (
      !candle ||
      !referenceCandle ||
      !directionalBody(candle)
    ) {
      return false;
    }

    return normalizedDirection ===
      "BUY"
      ? candle.close >
        referenceCandle.high
      : candle.close <
        referenceCandle.low;
  }

  const trigger =
    rows[
      rows.length - 1
    ];

  const previous =
    rows[
      rows.length - 2
    ];

  const twoBack =
    rows[
      rows.length - 3
    ];

  /*
   * Adaptive execution evidence.
   *
   * The data layer recommends M5 candle-close confirmation with structure,
   * support/resistance, volatility and rejection/engulfing/breakout evidence.
   * No new numeric score or threshold is introduced here. A qualified setup
   * may execute through any recognised closed-candle confirmation path.
   */
  const preTriggerContext =
    contextBefore(1);

  const structureLevel =
    selectStructureLevel(
      normalizedDirection,
      trigger.close,
      preTriggerContext
        .supportResistance,
      preTriggerContext
        .structure
    );

  const structureRejectionConfirmed =
    retestHeld(
      trigger,
      structureLevel
    );

  const engulfingPattern =
    detectCandlePattern([
      previous,
      trigger
    ]);

  const engulfingConfirmed =
    normalizedDirection === "BUY"
      ? engulfingPattern ===
        "Bullish Engulfing"
      : engulfingPattern ===
        "Bearish Engulfing";

  const breakoutLevel =
    nearestBreakoutLevel(
      preTriggerContext,
      previous.close
    );

  const freshBreakoutConfirmed =
    breakoutPassed(
      trigger,
      breakoutLevel,
      previous.close
    );

  const directionalFollowThrough =
    closesBeyond(
      trigger,
      previous
    );

  const previousCounterMove =
    normalizedDirection === "BUY"
      ? (
          previous.close <
            previous.open ||
          previous.close <
            twoBack.close
        )
      : (
          previous.close >
            previous.open ||
          previous.close >
            twoBack.close
        );

  const pullbackResumptionConfirmed =
    previousCounterMove &&
    directionalFollowThrough;

  const directMomentumEvidence =
    freshBreakoutConfirmed ||
    (
      directionalFollowThrough &&
      !pullbackResumptionConfirmed
    ) ||
    engulfingConfirmed;

  const blockedMomentumByVolatility =
    executionAtr.regime ===
      "EXTREME" &&
    directMomentumEvidence &&
    !pullbackResumptionConfirmed &&
    !structureRejectionConfirmed;

  let entryModel = null;
  let triggerLevel = null;

  if (pullbackResumptionConfirmed) {
    entryModel =
      "PULLBACK_RESUMPTION_CONFIRMATION";
    triggerLevel =
      isFiniteNumber(structureLevel)
        ? structureLevel
        : previous.low;
  } else if (structureRejectionConfirmed) {
    entryModel =
      "STRUCTURE_REJECTION_CONFIRMATION";
    triggerLevel =
      structureLevel;
  } else if (
    engulfingConfirmed &&
    !blockedMomentumByVolatility
  ) {
    entryModel =
      "ENGULFING_CONFIRMATION";
    triggerLevel =
      previous.close;
  } else if (
    freshBreakoutConfirmed &&
    !blockedMomentumByVolatility
  ) {
    entryModel =
      "FRESH_BREAKOUT_CONFIRMATION";
    triggerLevel =
      breakoutLevel;
  } else if (
    directionalFollowThrough &&
    !blockedMomentumByVolatility
  ) {
    entryModel =
      "DIRECTIONAL_FOLLOW_THROUGH";
    triggerLevel =
      normalizedDirection === "BUY"
        ? previous.high
        : previous.low;
  }

  if (!entryModel) {
    return {
      valid: false,
      waiting: true,
      reason:
        blockedMomentumByVolatility
          ? "Qualified setup is waiting for an M5 pullback or structure rejection because direct momentum entry is blocked in EXTREME volatility"
          : "Qualified setup is waiting for closed-M5 pullback resumption, structure rejection, engulfing, breakout, or directional follow-through confirmation",
      entryModel: null,
      tradePlan: null,
      diagnostics: {
        setupMode,
        executionTimeframe:
          normalizedExecutionTimeframe,
        executionCandleAt:
          trigger.date ?? null,
        executionAtr:
          executionAtr.atr,
        executionAtrRegime:
          executionAtr.regime,
        blockedMomentumByVolatility,
        evidence: {
          pullbackResumptionConfirmed,
          structureRejectionConfirmed,
          engulfingConfirmed,
          freshBreakoutConfirmed,
          directionalFollowThrough
        },
        structureLevel,
        breakoutLevel
      }
    };
  }

  const entry =
    trigger.close;

  const executionStructure =
    computeMarketStructure(rows);

  const executionSupportResistance =
    computeSupportResistance(rows);

  /*
   * Execution-aware risk input:
   * - Protective-side structure comes from M5 execution data so the stop is
   *   not widened by setup-timeframe ATR/structure.
   * - Opposing-side room remains anchored to the setup timeframe so normal
   *   M5 micro swing noise does not become a new hard blocker for M15/M30.
   *
   * BUY uses M5 supports for stop structure and setup resistances for room.
   * SELL uses M5 resistances for stop structure and setup supports for room.
   */
  const executionRiskSupportResistance =
    normalizedDirection === "BUY"
      ? {
          supports:
            executionSupportResistance
              .supports || [],
          resistances:
            Array.isArray(
              setupSupportResistance
                ?.resistances
            )
              ? setupSupportResistance
                  .resistances
              : executionSupportResistance
                  .resistances || []
        }
      : {
          supports:
            Array.isArray(
              setupSupportResistance
                ?.supports
            )
              ? setupSupportResistance
                  .supports
              : executionSupportResistance
                  .supports || [],
          resistances:
            executionSupportResistance
              .resistances || []
        };

  /*
   * Reuse the existing professional risk engine with M5 ATR and M5
   * protective structure. No new stop multiplier or risk threshold is added.
   */
  const basePlanResult =
    buildProfessionalTradePlan({
      direction:
        normalizedDirection,
      entry,
      pairLabel,
      mode:
        normalizedExecutionTimeframe,
      atrSnapshot:
        executionAtr,
      supportResistance:
        executionRiskSupportResistance,
      structure:
        executionStructure
    });

  if (!basePlanResult.valid) {
    return {
      valid: false,
      waiting: false,
      reason:
        basePlanResult.reason ||
        "Execution-timeframe risk plan is invalid",
      entryModel,
      tradePlan: null,
      diagnostics: {
        ...(basePlanResult.diagnostics || {}),
        setupMode,
        executionTimeframe:
          normalizedExecutionTimeframe,
        entryModel,
        triggerLevel,
        executionAtr:
          executionAtr.atr,
        executionAtrRegime:
          executionAtr.regime
      }
    };
  }

  const plan = {
    ...basePlanResult.plan
  };

  const riskDistance =
    Math.abs(
      plan.entry -
      plan.stopLoss
    );

  const minimumRiskReward =
    modeConfluenceConfig(
      normalizedExecutionTimeframe
    ).minimumRiskReward;

  const priceDecimals =
    normalizePairKey(pairLabel) ===
      "XAUUSD"
      ? 2
      : normalizePairKey(pairLabel) ===
        "GBPJPY"
      ? 3
      : 6;

  const minimumIncrement =
    minimumPriceIncrement(
      pairLabel
    );

  function collectLevels({
    includeExecution,
    includeSetup
  }) {
    const levels = [];

    function add(value) {
      if (!isFiniteNumber(value)) {
        return;
      }

      const isOpposing =
        normalizedDirection ===
          "BUY"
          ? value > plan.entry
          : value < plan.entry;

      if (isOpposing) {
        levels.push(value);
      }
    }

    if (includeExecution) {
      const executionOpposing =
        normalizedDirection ===
          "BUY"
          ? executionSupportResistance
              .resistances || []
          : executionSupportResistance
              .supports || [];

      for (const value of executionOpposing) {
        add(value);
      }

      if (
        normalizedDirection ===
        "BUY"
      ) {
        add(
          executionStructure
            ?.latestHigh?.price
        );
        add(
          executionStructure
            ?.previousHigh?.price
        );
      } else {
        add(
          executionStructure
            ?.latestLow?.price
        );
        add(
          executionStructure
            ?.previousLow?.price
        );
      }
    }

    if (includeSetup) {
      const setupOpposing =
        normalizedDirection ===
          "BUY"
          ? setupSupportResistance
              ?.resistances || []
          : setupSupportResistance
              ?.supports || [];

      for (const value of setupOpposing) {
        add(value);
      }

      if (
        normalizedDirection ===
        "BUY"
      ) {
        add(
          setupStructure
            ?.latestHigh?.price
        );
        add(
          setupStructure
            ?.previousHigh?.price
        );
      } else {
        add(
          setupStructure
            ?.latestLow?.price
        );
        add(
          setupStructure
            ?.previousLow?.price
        );
      }
    }

    const unique =
      Array.from(
        new Set(
          levels.map(
            value =>
              round(
                value,
                priceDecimals
              )
          )
        )
      ).filter(isFiniteNumber);

    return unique.sort(
      normalizedDirection ===
        "BUY"
        ? (a, b) => a - b
        : (a, b) => b - a
    );
  }

  /*
   * Setup-timeframe opposing structure is the hard room gate. This preserves
   * the setup's own market context instead of allowing every M5 micro swing to
   * invalidate an otherwise qualified M15/M30 trade.
   */
  const hardOpposingLevels =
    collectLevels({
      includeExecution: false,
      includeSetup: true
    });

  /*
   * M5 + setup levels remain useful as soft target references beyond TP1, so
   * TP2/TP3 can be shortened to realistic structure without creating a new
   * pre-TP1 hard blocker.
   */
  const targetOpposingLevels =
    collectLevels({
      includeExecution: true,
      includeSetup: true
    });

  const opposingLevels =
    targetOpposingLevels;

  const nearestOpposingLevel =
    hardOpposingLevels.length > 0
      ? hardOpposingLevels[0]
      : null;

  const nearestOpposingRoomR =
    isFiniteNumber(
      nearestOpposingLevel
    ) &&
    isFiniteNumber(
      riskDistance
    ) &&
    riskDistance > 0
      ? (
          normalizedDirection ===
            "BUY"
            ? nearestOpposingLevel -
              plan.entry
            : plan.entry -
              nearestOpposingLevel
        ) /
        riskDistance
      : null;

  if (
    isFiniteNumber(
      nearestOpposingRoomR
    ) &&
    nearestOpposingRoomR <
      minimumRiskReward
  ) {
    return {
      valid: false,
      waiting: false,
      reason:
        `Setup-timeframe opposing structure provides only ${round(nearestOpposingRoomR, 2)}R room; ${minimumRiskReward}R is required`,
      entryModel,
      tradePlan: null,
      diagnostics: {
        ...(basePlanResult.diagnostics || {}),
        setupMode,
        executionTimeframe:
          normalizedExecutionTimeframe,
        entryModel,
        triggerLevel,
        nearestOpposingLevel,
        nearestOpposingRoomR,
        executionAtr:
          executionAtr.atr,
        executionAtrRegime:
          executionAtr.regime
      }
    };
  }

  function bufferedTargetAtLevel(
    level
  ) {
    if (!isFiniteNumber(level)) {
      return null;
    }

    return round(
      normalizedDirection ===
        "BUY"
        ? level -
          structureBuffer
        : level +
          structureBuffer,
      priceDecimals
    );
  }

  function isBeyond(
    value,
    reference
  ) {
    if (
      !isFiniteNumber(value) ||
      !isFiniteNumber(reference)
    ) {
      return false;
    }

    return normalizedDirection ===
      "BUY"
      ? value >
        reference +
        minimumIncrement
      : value <
        reference -
        minimumIncrement;
  }

  function closerToEntry(
    baseTarget,
    structuralTarget
  ) {
    if (
      !isFiniteNumber(
        structuralTarget
      )
    ) {
      return baseTarget;
    }

    return normalizedDirection ===
      "BUY"
      ? Math.min(
          baseTarget,
          structuralTarget
        )
      : Math.max(
          baseTarget,
          structuralTarget
        );
  }

  const baseTarget1 =
    plan.target1;

  const baseTarget2 =
    plan.target2;

  const baseTarget3 =
    plan.target3;

  let target2 =
    baseTarget2;

  let target3 =
    baseTarget3;

  const target2Level =
    opposingLevels.find(
      level => {
        const target =
          bufferedTargetAtLevel(
            level
          );

        return isBeyond(
          target,
          baseTarget1
        );
      }
    ) ?? null;

  if (
    isFiniteNumber(target2Level)
  ) {
    const structuralTarget2 =
      bufferedTargetAtLevel(
        target2Level
      );

    const candidateTarget2 =
      closerToEntry(
        baseTarget2,
        structuralTarget2
      );

    if (
      isBeyond(
        candidateTarget2,
        baseTarget1
      )
    ) {
      target2 =
        round(
          candidateTarget2,
          priceDecimals
        );
    }
  }

  const target3Level =
    opposingLevels.find(
      level => {
        const target =
          bufferedTargetAtLevel(
            level
          );

        return isBeyond(
          target,
          target2
        );
      }
    ) ?? null;

  if (
    isFiniteNumber(target3Level)
  ) {
    const structuralTarget3 =
      bufferedTargetAtLevel(
        target3Level
      );

    const candidateTarget3 =
      closerToEntry(
        baseTarget3,
        structuralTarget3
      );

    if (
      isBeyond(
        candidateTarget3,
        target2
      )
    ) {
      target3 =
        round(
          candidateTarget3,
          priceDecimals
        );
    }
  }

  const geometryValid =
    normalizedDirection ===
      "BUY"
      ? (
          plan.stopLoss <
            plan.entry &&
          plan.entry <
            baseTarget1 &&
          baseTarget1 <
            target2 &&
          target2 <
            target3
        )
      : (
          target3 <
            target2 &&
          target2 <
            baseTarget1 &&
          baseTarget1 <
            plan.entry &&
          plan.entry <
            plan.stopLoss
        );

  if (!geometryValid) {
    return {
      valid: false,
      waiting: false,
      reason:
        "Execution-aware structure targets produced invalid trade-plan geometry",
      entryModel,
      tradePlan: null,
      diagnostics: {
        ...(basePlanResult.diagnostics || {}),
        setupMode,
        executionTimeframe:
          normalizedExecutionTimeframe,
        entryModel,
        triggerLevel,
        opposingLevels,
        target2Level,
        target3Level,
        executionAtr:
          executionAtr.atr,
        executionAtrRegime:
          executionAtr.regime
      }
    };
  }

  plan.target2 =
    target2;

  plan.target3 =
    target3;

  plan.opposingLevel =
    isFiniteNumber(
      nearestOpposingLevel
    )
      ? round(
          nearestOpposingLevel,
          priceDecimals
        )
      : plan.opposingLevel;

  plan.roomToOpposingLevelR =
    isFiniteNumber(
      nearestOpposingRoomR
    )
      ? round(
          nearestOpposingRoomR,
          4
        )
      : plan
          .roomToOpposingLevelR;

  plan.targetAtrMultipliers = {
    target1:
      round(
        Math.abs(
          baseTarget1 -
          plan.entry
        ) /
        executionAtr.atr,
        4
      ),
    target2:
      round(
        Math.abs(
          target2 -
          plan.entry
        ) /
        executionAtr.atr,
        4
      ),
    target3:
      round(
        Math.abs(
          target3 -
          plan.entry
        ) /
        executionAtr.atr,
        4
      )
  };

  return {
    valid: true,
    waiting: false,
    reason: null,
    entryModel,
    tradePlan:
      plan,
    diagnostics: {
      ...(basePlanResult.diagnostics || {}),
      setupMode,
      executionTimeframe:
        normalizedExecutionTimeframe,
      entryModel,
      triggerLevel:
        isFiniteNumber(triggerLevel)
          ? round(
              triggerLevel,
              priceDecimals
            )
          : null,
      executionCandleAt:
        trigger.date ?? null,
      executionAtr:
        executionAtr.atr,
      executionAtrRegime:
        executionAtr.regime,
      setupStructureLevel:
        normalizedDirection ===
          "BUY"
          ? setupStructure
              ?.latestLow?.price ??
            null
          : setupStructure
              ?.latestHigh?.price ??
            null,
      nearestOpposingLevel,
      nearestOpposingRoomR,
      opposingLevels,
      target2Level,
      target3Level
    }
  };
}

/* =====================================================================
   Main Analysis Engine
   ===================================================================== */

function appendSkippedPipelineSteps(
  result,
  stepNames,
  failedStepName
) {

  for (const name of stepNames) {

    result.steps.push({
      name,
      pass: null,
      status: "skip",
      detail:
        `Skipped because ${failedStepName} did not pass`
    });

  }

}

function analyze(
  rows,
  pairLabel,
  newsScoreRaw,
  htfRows,
  newsItems,
  context = {}
) {
  const mode =
    String(
      context.mode ??
      "M5"
    )
      .trim()
      .toUpperCase();

  const executionRows =
    Array.isArray(
      context.executionRows
    ) &&
    context.executionRows.length > 0
      ? context.executionRows
      : rows;

  const executionTimeframe =
    String(
      context.executionTimeframe ??
      mode
    )
      .trim()
      .toUpperCase();

  const setupCandleAt =
    latestRow(rows)?.date ??
    null;

  const executionCandleAt =
    latestRow(executionRows)?.date ??
    null;

  const result = {
    pair: pairLabel,
    signal: "WAIT",
    confidence: 0,
    reasons: [],
    steps: [],
    tradePlan: null,
    professionalPipelineVersion:
      PROFESSIONAL_PIPELINE_VERSION,
    indicatorSnapshot: null,
    confluence: null,
    riskDiagnostics: null,
    timeframe:
      mode,
    reason: null,
    setupTimeframe:
      mode,
    confirmationTimeframe:
      mode,
    executionTimeframe,
    entryTimeframe:
      executionTimeframe,
    setupCandleAt,
    executionCandleAt
  };

  if (!hasEnoughRows(rows, 35)) {
    result.reasons.push(
      "Not enough candles"
    );

    result.steps.push({
      name: "Data Availability",
      pass: false,
      status: "fail",
      detail:
        `Only ${Array.isArray(rows) ? rows.length : 0} complete closed candles are available; at least 35 are required`
    });

    return result;
  }

  const sourceQuality =
    context.dataQuality;

  const stale =
    sourceQuality?.stale === true;

  result.steps.push({
    name: "Data Availability",
    pass: !stale,
    status:
      stale
        ? "fail"
        : "pass",
    detail:
      stale
        ? "Market data is stale; no live signal is permitted"
        : `${rows.length} complete closed ${mode} candles available; latest ${latestRow(rows)?.date ?? "unknown"}`
  });

  if (stale) {
    result.reasons.push(
      "Stale market data"
    );
    return result;
  }

  const closes =
    closeSeries(rows);

  const ema =
    getEMAState(rows);

  const macd =
    buildMacdSnapshot(closes);

  const rsi =
    buildRsiSnapshot(closes);

  const dmi =
    computeDmiAdx(rows);

  const atr =
    buildAtrSnapshot(
      rows,
      atrRiskConfigFor(pairLabel)
        ?.period ?? 14
    );

  const structure =
    computeMarketStructure(rows);

  const supportResistance =
    computeSupportResistance(rows);

  const candlePattern =
    detectCandlePattern(rows);

  const higherTimeframe =
    inferHigherTimeframeBias(
      htfRows
    );

  const buy =
    scoreDirection({
      direction: "BUY",
      ema,
      macd,
      rsi,
      dmi,
      structure,
      higherTimeframe,
      candlePattern
    });

  const sell =
    scoreDirection({
      direction: "SELL",
      ema,
      macd,
      rsi,
      dmi,
      structure,
      higherTimeframe,
      candlePattern
    });

  const selection =
    selectDirection(
      buy,
      sell,
      mode
    );

  result.indicatorSnapshot = {
    timeframe: mode,
    analyzedCandleAt:
      latestRow(rows)?.date ??
      null,
    ema,
    macd: {
      available: macd.available,
      macd: macd.macd,
      signal: macd.signal,
      histogram: macd.histogram,
      previousHistogram:
        macd.previousHistogram,
      histogramSlope:
        macd.histogramSlope,
      crossedBullish:
        macd.crossedBullish,
      crossedBearish:
        macd.crossedBearish,
      direction:
        macd.direction
    },
    rsi: {
      available: rsi.available,
      period: rsi.period,
      current: rsi.current,
      previous: rsi.previous,
      slope: rsi.slope,
      momentum: rsi.momentum,
      crossedAbove50:
        rsi.crossedAbove50,
      crossedBelow50:
        rsi.crossedBelow50,
      overbought:
        rsi.overbought,
      oversold:
        rsi.oversold,
      direction:
        rsi.direction
    },
    dmiAdx: {
      available: dmi.available,
      period: dmi.period,
      plusDI: dmi.plusDI,
      minusDI: dmi.minusDI,
      adx: dmi.adx,
      previousAdx:
        dmi.previousAdx,
      adxSlope:
        dmi.adxSlope,
      direction:
        dmi.direction,
      trendStrength:
        dmi.trendStrength
    },
    atr: {
      available: atr.available,
      period: atr.period,
      value: atr.atr,
      previous: atr.previousAtr,
      slope: atr.atrSlope,
      percent: atr.atrPercent,
      percentile: atr.percentile,
      median: atr.medianAtr,
      medianRatio:
        atr.medianRatio,
      regime: atr.regime
    },
    structure,
    supportResistance,
    candlePattern,
    higherTimeframe
  };

  result.confluence = {
    version:
      PROFESSIONAL_PIPELINE_VERSION,
    buy,
    sell,
    selection
  };

  const provisionalDirection =
    selection.direction ||
    (
      buy.score >= sell.score
        ? "BUY"
        : "SELL"
    );

  const provisionalScore =
    provisionalDirection === "BUY"
      ? buy
      : sell;

  function componentStep(
    name,
    component
  ) {
    const ratio =
      component.available &&
      component.weight > 0
        ? component.score /
          component.weight
        : null;

    result.steps.push({
      name,
      pass:
        ratio === null
          ? null
          : ratio >= 0.55,
      status:
        ratio === null
          ? "na"
          : ratio >= 0.55
          ? "pass"
          : ratio > 0
          ? "info"
          : "fail",
      detail:
        `${provisionalDirection} evidence ${round(component.score, 2)}/${component.weight}. ${component.detail}`,
      direction:
        provisionalDirection,
      score:
        round(component.score, 2),
      maximumScore:
        component.weight
    });
  }

  componentStep(
    "EMA Trend",
    provisionalScore.components.ema
  );

  componentStep(
    "MACD",
    provisionalScore.components.macd
  );

  componentStep(
    "RSI",
    provisionalScore.components.rsi
  );

  componentStep(
    "ADX / DMI",
    provisionalScore.components.dmiAdx
  );

  componentStep(
    "Market Structure",
    provisionalScore.components.structure
  );

  componentStep(
    "Higher TF",
    provisionalScore
      .components
      .higherTimeframe
  );

  result.steps.push({
    name: "Candle Pattern",
    pass:
      provisionalScore
        .components
        .candlePattern
        .available
        ? provisionalScore
            .components
            .candlePattern
            .score > 0
        : null,
    status:
      provisionalScore
        .components
        .candlePattern
        .available
        ? provisionalScore
            .components
            .candlePattern
            .score > 0
          ? "pass"
          : "info"
        : "na",
    detail:
      candlePattern ??
      "No directional engulfing pattern on the latest complete candle"
  });

  result.steps.push({
    name: "ATR Volatility",
    pass:
      atr.available,
    status:
      atr.available
        ? atr.regime === "EXTREME"
          ? "info"
          : "pass"
        : "fail",
    detail:
      atr.available
        ? `ATR(${atr.period}) ${round(atr.atr, 6)}; ${round(atr.atrPercent, 4)}% of price; percentile ${round(atr.percentile, 2)}; regime ${atr.regime}`
        : "ATR is unavailable"
  });

  if (!selection.qualified) {
    result.steps.push({
      name: "Confluence Decision",
      pass: false,
      status: "fail",
      detail:
        `No qualified edge: BUY ${buy.score}, SELL ${sell.score}; winner requires score ${selection.requiredScore} and edge ${selection.requiredEdge}, observed edge ${selection.edge}`
    });

    result.reasons.push(
      `No qualified confluence: BUY ${buy.score}, SELL ${sell.score}, edge ${selection.edge}`
    );

    return result;
  }

  const direction =
    selection.direction;

  const strongHtfConflict =
    higherTimeframe.available &&
    higherTimeframe.direction &&
    higherTimeframe.direction !==
      direction &&
    higherTimeframe.strength >= 70;

  if (strongHtfConflict) {
    result.steps.push({
      name: "Confluence Decision",
      pass: false,
      status: "fail",
      detail:
        `${direction} score qualified, but strong higher-timeframe ${higherTimeframe.direction} conflict (${round(higherTimeframe.strength, 2)}%) blocks entry`
    });

    result.reasons.push(
      "Strong higher timeframe conflict"
    );

    return result;
  }

  const conflict =
    conflictingHighImpactNews(
      direction,
      newsItems,
      context.newsReferenceTime
    );

  result.steps.push({
    name: "News",
    pass:
      !conflict,
    status:
      conflict
        ? "fail"
        : "pass",
    detail:
      conflict
        ? `Conflicting high-impact news: ${conflict.title || "Untitled news item"}; sentiment ${round(conflict.sentiment, 2)}`
        : Array.isArray(newsItems) &&
          newsItems.length > 0
        ? `No conflicting high-impact news across ${newsItems.length} pair-specific item(s); net score ${round(newsScoreRaw, 2)}`
        : `No pair-specific conflicting high-impact news; net score ${round(newsScoreRaw, 2)}`
  });

  if (conflict) {
    result.reasons.push(
      "High impact news conflict"
    );
    return result;
  }

  /*
   * Additive professional execution/risk authority.
   * Existing setup direction remains immutable; this layer only decides
   * whether the current execution candle is a professional entry and, when
   * it is, rebuilds SL/TP from execution-timeframe structure and ATR.
   */
  const executionLayer =
    evaluateProfessionalExecutionRiskLayer({
      direction,
      executionRows,
      executionTimeframe,
      pairLabel,
      setupMode:
        mode,
      setupSupportResistance:
        supportResistance,
      setupStructure:
        structure,
      setupHigherTimeframe:
        higherTimeframe,
      previousSignal:
        context.previousSignal ??
        null
    });

  const activeSignalContinuation =
    executionLayer.entryModel ===
    "ACTIVE_SIGNAL_CONTINUATION";

  if (activeSignalContinuation) {
    /*
     * A continuing trade is one lifecycle. Preserve both original setup and
     * execution timestamps so downstream identity/dedupe never treats the same
     * open trade as a fresh setup merely because a newer setup candle closed.
     */
    if (
      typeof context
        .previousSignal
        ?.setupCandleAt ===
        "string"
    ) {
      result.setupCandleAt =
        context
          .previousSignal
          .setupCandleAt;
    }

    if (
      typeof context
        .previousSignal
        ?.executionCandleAt ===
        "string"
    ) {
      result.executionCandleAt =
        context
          .previousSignal
          .executionCandleAt;
    }
  }

  result.riskDiagnostics =
    executionLayer.diagnostics ??
    {
      reason:
        executionLayer.reason
    };

  result.steps.push({
    name:
      "M5 Entry Execution",
    pass:
      executionLayer.valid,
    status:
      executionLayer.valid
        ? "pass"
        : executionLayer.waiting
        ? "info"
        : "fail",
    detail:
      executionLayer.valid
        ? activeSignalContinuation
          ? "Existing active signal remains qualified; original M5 entry and trade plan are preserved"
          : `${executionLayer.entryModel} confirmed on ${executionTimeframe}; execution-aware SL/TP passed`
        : executionLayer.reason
  });

  if (!executionLayer.valid) {
    result.reason =
      executionLayer.reason;

    result.reasons.push(
      executionLayer.reason ||
      "Professional execution layer did not qualify the entry"
    );

    return result;
  }

  const tradePlanResult = {
    valid: true,
    reason: null,
    plan:
      executionLayer.tradePlan,
    diagnostics:
      executionLayer.diagnostics
  };

  result.steps.push({
    name: "Risk Reward",
    pass: true,
    status: "pass",
    detail:
      activeSignalContinuation
        ? `Existing active trade plan preserved at ${tradePlanResult.plan.riskReward}R TP1; no new entry/SL/TP generated`
        : `Execution-aware plan passed: ${tradePlanResult.plan.riskReward}R TP1, ${tradePlanResult.plan.stopAtrMultiplier} ATR stop on ${executionTimeframe}, regime ${tradePlanResult.plan.atrRegime}`
  });

  result.steps.push({
    name: "Confluence Decision",
    pass: true,
    status: "pass",
    detail:
      `${direction} qualified: score ${selection.winnerScore}, opposing score ${selection.opposingScore}, edge ${selection.edge}`
  });

  const market =
    computeMarketStructure(rows);

  let confidence =
    45 +
    selection.winnerScore *
      0.42 +
    selection.edge *
      0.35;

  if (
    dmi.available &&
    dmi.adx >= 25 &&
    dmi.direction === direction
  ) {
    confidence += 4;
  }

  if (
    market.direction === direction
  ) {
    confidence += 3;
  }

  if (
    atr.regime === "EXTREME"
  ) {
    confidence -= 5;
  } else if (
    atr.regime === "HIGH"
  ) {
    confidence -= 2;
  }

  if (
    Math.abs(newsScoreRaw) < 10
  ) {
    confidence += 2;
  }

  result.signal =
    direction;

  result.confidence =
    Math.round(
      clamp(
        confidence,
        55,
        95
      )
    );

  result.tradePlan =
    tradePlanResult.plan;

  result.reasons.push(
    `${direction} professional confluence passed at score ${selection.winnerScore} with edge ${selection.edge}`
  );

  const setupTimeframeLabel =
    mode === "M5"
      ? "5M"
      : mode === "M15"
      ? "15M"
      : mode === "M30"
      ? "30M"
      : mode;

  const executionTimeframeLabel =
    executionTimeframe === "M5"
      ? "5M"
      : executionTimeframe === "M15"
      ? "15M"
      : executionTimeframe === "M30"
      ? "30M"
      : executionTimeframe;

  result.executionReason =
    `${setupTimeframeLabel} setup executed on ${executionTimeframeLabel}`;

  result.reason =
    result.executionReason;

  result.reasons.push(
    result.executionReason
  );

  return result;
}

/* =====================================================================
   Autonomous AI Decision + Safety Authority
   ===================================================================== */

let autonomousScalpModulesCache = null;

function normalizeAutonomousMode(value) {
  const normalized =
    String(value ?? "")
      .trim()
      .toUpperCase();

  return [
    "OFF",
    "SHADOW",
    "CONTROLLED",
    "AUTONOMOUS",
    "EMERGENCY_STOP"
  ].includes(normalized)
    ? normalized
    : "OFF";
}

function loadAutonomousScalpModules() {
  if (autonomousScalpModulesCache) {
    return autonomousScalpModulesCache;
  }

  try {
    const decisionModule =
      require(AI_DECISION_ENGINE_PATH);

    const safetyModule =
      require(AI_SAFETY_GATE_PATH);

    if (
      typeof decisionModule?.evaluateDecision !==
        "function" ||
      typeof safetyModule?.evaluateSafetyGate !==
        "function" ||
      typeof safetyModule?.createEmptyState !==
        "function"
    ) {
      throw new Error(
        "Autonomous AI modules do not expose the required production interfaces"
      );
    }

    autonomousScalpModulesCache = {
      available: true,
      reason: null,
      decisionModule,
      safetyModule
    };
  } catch (error) {
    autonomousScalpModulesCache = {
      available: false,
      reason:
        error?.message ||
        "Autonomous AI modules are unavailable",
      decisionModule: null,
      safetyModule: null
    };
  }

  return autonomousScalpModulesCache;
}

function configuredAutonomousState() {
  const config =
    readJsonFile(
      AUTONOMOUS_CONFIG_PATH,
      null
    );

  const configAvailable =
    Boolean(
      config &&
      typeof config === "object" &&
      !Array.isArray(config) &&
      config.deployment &&
      typeof config.deployment ===
        "object" &&
      !Array.isArray(
        config.deployment
      )
    );

  const rawMode =
    typeof config?.deployment?.mode ===
      "string"
      ? config.deployment.mode
          .trim()
          .toUpperCase()
      : null;

  const modeValid =
    rawMode !== null &&
    [
      "OFF",
      "SHADOW",
      "CONTROLLED",
      "AUTONOMOUS",
      "EMERGENCY_STOP"
    ].includes(rawMode);

  const enabled =
    config?.deployment?.enabled === true;

  const mode =
    normalizeAutonomousMode(rawMode);

  return {
    config,
    configAvailable,
    modeValid,
    enabled,
    mode,
    liveAuthority:
      configAvailable &&
      modeValid &&
      enabled &&
      (
        mode === "CONTROLLED" ||
        mode === "AUTONOMOUS"
      ) &&
      config?.deployment?.emergencyStop !==
        true
  };
}

function uniqueSignalReasons(values) {
  const output = [];
  const seen = new Set();

  for (const value of values) {
    if (
      typeof value !== "string" ||
      !value.trim()
    ) {
      continue;
    }

    const normalized = value.trim();

    if (seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    output.push(normalized);
  }

  return output;
}

function autonomousDecisionId(signal) {
  const pair =
    normalizePairKey(signal?.pair) ||
    "UNKNOWN";

  const mode =
    String(
      signal?.setupTimeframe ??
      signal?.timeframe ??
      signal?.mode ??
      "UNKNOWN"
    )
      .trim()
      .toUpperCase();

  const direction =
    normalizeSignalDirection(
      signal?.signal
    );

  const setupAt =
    toIsoTimestamp(
      signal?.setupCandleAt ??
      signal?.analyzedCandleAt
    ) ||
    "NO_SETUP_TIME";

  const executionAt =
    toIsoTimestamp(
      signal?.executionCandleAt ??
      signal?.analyzedCandleAt
    ) ||
    "NO_EXECUTION_TIME";

  return [
    "scalp-ai-v1",
    pair,
    mode,
    direction,
    setupAt,
    executionAt
  ].join("|");
}

function autonomousAtrValue(signal) {
  const candidates = [
    signal?.riskDiagnostics?.executionAtr,
    signal?.tradePlan?.atr,
    signal?.indicatorSnapshot?.atr?.value,
    signal?.indicatorSnapshot?.atr?.atr
  ];

  for (const value of candidates) {
    const numeric = Number(value);

    if (
      Number.isFinite(numeric) &&
      numeric > 0
    ) {
      return numeric;
    }
  }

  return null;
}

function autonomousCurrentPrice(
  signal,
  explicitPrice
) {
  const candidates = [
    explicitPrice,
    signal?.currentPrice,
    signal?.price,
    signal?.tradePlan?.entry,
    signal?.indicatorSnapshot?.ema?.lastClose
  ];

  for (const value of candidates) {
    const numeric = Number(value);

    if (
      Number.isFinite(numeric) &&
      numeric > 0
    ) {
      return numeric;
    }
  }

  return null;
}

function sameTradePlanGeometry(
  left,
  right
) {
  if (!left || !right) {
    return false;
  }

  const fields = [
    "entry",
    "stopLoss",
    "target1",
    "target2",
    "target3"
  ];

  return fields.every(field => {
    const a = Number(left[field]);
    const b = Number(right[field]);

    return (
      Number.isFinite(a) &&
      Number.isFinite(b) &&
      Math.abs(a - b) <= 1e-10
    );
  });
}

function mergeAutonomousTradePlan(
  baselinePlan,
  finalPlan
) {
  if (!finalPlan) {
    return null;
  }

  if (
    baselinePlan &&
    sameTradePlanGeometry(
      baselinePlan,
      finalPlan
    )
  ) {
    return {
      ...baselinePlan,
      ...finalPlan
    };
  }

  return {
    ...finalPlan
  };
}

function summarizeAutonomousPolicy(policy) {
  if (!policy || typeof policy !== "object") {
    return null;
  }

  return {
    key:
      policy.key ?? null,
    scope:
      policy.scope ?? null,
    action:
      policy.action ?? null,
    authorityLevel:
      policy.authorityLevel ??
      policy.authority?.level ??
      null,
    decisiveTrades:
      Number.isFinite(
        Number(policy.decisiveTrades)
      )
        ? Number(policy.decisiveTrades)
        : null,
    reliability:
      Number.isFinite(
        Number(policy.reliability)
      )
        ? Number(policy.reliability)
        : Number.isFinite(
            Number(
              policy.reliability?.value
            )
          )
        ? Number(
            policy.reliability.value
          )
        : null,
    edgeScore:
      Number.isFinite(
        Number(policy.edgeScore)
      )
        ? Number(policy.edgeScore)
        : null
  };
}

function buildAutonomousScalpDecisionInput(
  signal,
  context = {}
) {
  const baselineDirection =
    normalizeSignalDirection(
      signal?.signal
    );

  const decision =
    isActionableSignal(
      baselineDirection
    )
      ? baselineDirection
      : "HOLD";

  const timeframe =
    signal?.setupTimeframe ??
    signal?.timeframe ??
    signal?.mode ??
    context.mode;

  const currentMarketDataAt =
    toIsoTimestamp(
      context.currentMarketDataAt
    ) ||
    toIsoTimestamp(
      signal?.analyzedCandleAt
    ) ||
    toIsoTimestamp(
      signal?.executionCandleAt
    ) ||
    toIsoTimestamp(
      signal?.setupCandleAt
    );

  const confidence =
    Number.isFinite(
      Number(signal?.confidence)
    )
      ? Number(signal.confidence)
      : 0;

  return {
    decisionId:
      autonomousDecisionId(signal),
    pair:
      signal?.pair ??
      context.pair?.label ??
      context.pair?.key,
    timeframe,
    engine: "scalp",
    marketDataAt:
      currentMarketDataAt,
    atr:
      autonomousAtrValue(signal),
    baseline: {
      decision,
      confidence,
      tradePlan:
        signal?.tradePlan ?? null,
      reasons:
        Array.isArray(signal?.reasons)
          ? signal.reasons
          : []
    },
    engineSignals: [
      {
        engine: "scalp",
        decision,
        confidence,
        active:
          decision !== "HOLD",
        tradePlan:
          signal?.tradePlan ?? null,
        source:
          `scalp-${String(timeframe ?? "unknown").toLowerCase()}`
      }
    ]
  };
}

function buildAutonomousSummary({
  decisionResult,
  safetyResult,
  baselineDirection,
  finalDirection,
  activeLifecycleChangeDeferred = false,
  unavailableReason = null
}) {
  return {
    enabled:
      AUTONOMOUS_SCALP_INTEGRATION
        .enabled === true,
    evaluated:
      Boolean(decisionResult),
    configuredMode:
      decisionResult?.deployment
        ?.configuredMode ??
      null,
    authorityMode:
      decisionResult?.deployment
        ?.authorityMode ??
      null,
    rolloutSelected:
      decisionResult?.deployment
        ?.rollout?.selected ??
      null,
    baselineDecision:
      baselineDirection,
    proposedDecision:
      decisionResult
        ?.proposedDecision
        ?.decision ??
      null,
    finalDecision:
      finalDirection,
    activeLifecycleChangeDeferred,
    unavailableReason,
    changes:
      Array.isArray(
        decisionResult?.changes
      )
        ? decisionResult.changes
        : [],
    blockedChanges:
      Array.isArray(
        decisionResult?.blockedChanges
      )
        ? decisionResult.blockedChanges
        : [],
    policy: {
      baseline:
        summarizeAutonomousPolicy(
          decisionResult?.evidence
            ?.baselinePolicy
        ),
      buy:
        summarizeAutonomousPolicy(
          decisionResult?.evidence
            ?.buyPolicy
        ),
      sell:
        summarizeAutonomousPolicy(
          decisionResult?.evidence
            ?.sellPolicy
        )
    },
    decisionValidation: {
      valid:
        decisionResult?.validation
          ?.valid === true,
      errors:
        Array.isArray(
          decisionResult?.validation
            ?.errors
        )
          ? decisionResult
              .validation
              .errors
          : [],
      warnings:
        Array.isArray(
          decisionResult?.validation
            ?.warnings
        )
          ? decisionResult
              .validation
              .warnings
          : []
    },
    safety: {
      status:
        safetyResult?.approval
          ?.status ?? null,
      signalApproved:
        safetyResult?.approval
          ?.signalApproved === true,
      failClosed:
        safetyResult?.approval
          ?.failClosed === true,
      blockerCount:
        Number.isFinite(
          Number(
            safetyResult?.approval
              ?.blockerCount
          )
        )
          ? Number(
              safetyResult.approval
                .blockerCount
            )
          : 0,
      blockers:
        Array.isArray(
          safetyResult?.approval
            ?.blockers
        )
          ? safetyResult
              .approval
              .blockers
          : []
    }
  };
}

function appendAutonomousStep(
  signal,
  step
) {
  if (!Array.isArray(signal.steps)) {
    signal.steps = [];
  }

  signal.steps.push(step);
}

function failClosedAutonomousSignal(
  signal,
  reason,
  configuredState
) {
  const baselineDirection =
    normalizeSignalDirection(
      signal?.signal
    );

  if (
    !isActionableSignal(
      baselineDirection
    )
  ) {
    signal.aiAutonomous = {
      enabled: true,
      evaluated: false,
      configuredMode:
        configuredState?.mode ?? null,
      authorityMode: null,
      baselineDecision: "HOLD",
      proposedDecision: null,
      finalDecision: "HOLD",
      activeLifecycleChangeDeferred:
        false,
      unavailableReason: reason,
      changes: [],
      blockedChanges: [],
      policy: {
        baseline: null,
        buy: null,
        sell: null
      },
      decisionValidation: {
        valid: false,
        errors: [reason],
        warnings: []
      },
      safety: {
        status: "HOLD",
        signalApproved: false,
        failClosed: true,
        blockerCount: 1,
        blockers: [reason]
      }
    };

    return signal;
  }

  signal.signal = "WAIT";
  signal.confidence = 0;
  signal.tradePlan = null;
  signal.reason = reason;
  signal.reasons =
    uniqueSignalReasons([
      ...(Array.isArray(signal.reasons)
        ? signal.reasons
        : []),
      reason
    ]);

  appendAutonomousStep(
    signal,
    {
      name: "AI Autonomous Decision",
      pass: false,
      status: "fail",
      detail: reason
    }
  );

  signal.aiAutonomous = {
    enabled: true,
    evaluated: false,
    configuredMode:
      configuredState?.mode ?? null,
    authorityMode: null,
    baselineDecision:
      baselineDirection,
    proposedDecision: null,
    finalDecision: "HOLD",
    activeLifecycleChangeDeferred:
      false,
    unavailableReason: reason,
    changes: [],
    blockedChanges: [],
    policy: {
      baseline: null,
      buy: null,
      sell: null
    },
    decisionValidation: {
      valid: false,
      errors: [reason],
      warnings: []
    },
    safety: {
      status: "HOLD",
      signalApproved: false,
      failClosed: true,
      blockerCount: 1,
      blockers: [reason]
    }
  };

  return signal;
}

function applyAutonomousScalpAuthority(
  signal,
  context = {}
) {
  if (
    !signal ||
    typeof signal !== "object" ||
    Array.isArray(signal) ||
    AUTONOMOUS_SCALP_INTEGRATION
      .enabled !== true
  ) {
    return signal;
  }

  const configuredState =
    configuredAutonomousState();

  const baselineDirection =
    normalizeSignalDirection(
      signal.signal
    );

  const activeContinuation =
    signal?.riskDiagnostics
      ?.entryModel ===
      "ACTIVE_SIGNAL_CONTINUATION";

  const modules =
    loadAutonomousScalpModules();

  if (!modules.available) {
    const reason =
      `Autonomous AI authority unavailable: ${modules.reason}`;

    if (
      (
        !configuredState.configAvailable ||
        !configuredState.modeValid ||
        configuredState.liveAuthority
      ) &&
      AUTONOMOUS_SCALP_INTEGRATION
        .failClosedWhenAuthorityUnavailable &&
      isActionableSignal(
        baselineDirection
      ) &&
      !activeContinuation
    ) {
      return failClosedAutonomousSignal(
        signal,
        reason,
        configuredState
      );
    }

    signal.aiAutonomous = {
      enabled: true,
      evaluated: false,
      configuredMode:
        configuredState.mode,
      authorityMode: null,
      baselineDecision:
        isActionableSignal(
          baselineDirection
        )
          ? baselineDirection
          : "HOLD",
      proposedDecision: null,
      finalDecision:
        isActionableSignal(
          baselineDirection
        )
          ? baselineDirection
          : "HOLD",
      activeLifecycleChangeDeferred:
        activeContinuation,
      unavailableReason: reason,
      changes: [],
      blockedChanges: [],
      policy: {
        baseline: null,
        buy: null,
        sell: null
      },
      decisionValidation: {
        valid: false,
        errors: [reason],
        warnings: []
      },
      safety: {
        status: null,
        signalApproved: false,
        failClosed: false,
        blockerCount: 0,
        blockers: []
      }
    };

    return signal;
  }

  const evaluatedAt =
    context.generatedAt ||
    new Date().toISOString();

  let decisionResult;
  let safetyResult;

  try {
    const decisionInput =
      buildAutonomousScalpDecisionInput(
        signal,
        context
      );

    decisionResult =
      modules.decisionModule
        .evaluateDecision(
          decisionInput,
          {
            evaluatedAt,
            autonomousConfigPath:
              AUTONOMOUS_CONFIG_PATH,
            aiPolicyPath:
              AI_POLICY_PATH,
            aiPolicyStatePath:
              AI_POLICY_STATE_PATH
          }
        );

    const currentPrice =
      autonomousCurrentPrice(
        signal,
        context.currentPrice
      );

    const atr =
      autonomousAtrValue(signal);

    /*
     * Stateless SIGNAL_ONLY validation is intentional in the Scalp producer.
     * The downstream live layer owns account/open-position/cooldown state.
     * This prevents one timeframe's state from suppressing a separate valid
     * timeframe while retaining immutable geometry, freshness and config gates.
     */
    const ephemeralState =
      modules.safetyModule
        .createEmptyState(
          evaluatedAt
        );

    safetyResult =
      modules.safetyModule
        .evaluateSafetyGate(
          {
            decisionResult,
            executionContext:
              AUTONOMOUS_SCALP_INTEGRATION
                .executionContext,
            executionRequested: false,
            market: {
              currentPrice,
              atr,
              marketDataAt:
                buildAutonomousScalpDecisionInput(
                  signal,
                  context
                ).marketDataAt
            }
          },
          {
            evaluatedAt,
            autonomousConfigPath:
              AUTONOMOUS_CONFIG_PATH,
            state:
              ephemeralState
          }
        );
  } catch (error) {
    const reason =
      `Autonomous AI evaluation failed: ${error?.message || "unknown error"}`;

    if (
      (
        !configuredState.configAvailable ||
        !configuredState.modeValid ||
        configuredState.liveAuthority
      ) &&
      AUTONOMOUS_SCALP_INTEGRATION
        .failClosedWhenAuthorityUnavailable &&
      isActionableSignal(
        baselineDirection
      ) &&
      !activeContinuation
    ) {
      return failClosedAutonomousSignal(
        signal,
        reason,
        configuredState
      );
    }

    signal.aiAutonomous = {
      enabled: true,
      evaluated: false,
      configuredMode:
        configuredState.mode,
      authorityMode: null,
      baselineDecision:
        isActionableSignal(
          baselineDirection
        )
          ? baselineDirection
          : "HOLD",
      proposedDecision: null,
      finalDecision:
        isActionableSignal(
          baselineDirection
        )
          ? baselineDirection
          : "HOLD",
      activeLifecycleChangeDeferred:
        activeContinuation,
      unavailableReason: reason,
      changes: [],
      blockedChanges: [],
      policy: {
        baseline: null,
        buy: null,
        sell: null
      },
      decisionValidation: {
        valid: false,
        errors: [reason],
        warnings: []
      },
      safety: {
        status: null,
        signalApproved: false,
        failClosed: false,
        blockerCount: 0,
        blockers: []
      }
    };

    return signal;
  }

  const safetyDecision =
    String(
      safetyResult?.finalDecision
        ?.decision ??
      "HOLD"
    )
      .trim()
      .toUpperCase();

  const proposedDecision =
    String(
      decisionResult?.proposedDecision
        ?.decision ??
      "HOLD"
    )
      .trim()
      .toUpperCase();

  const baselineActionable =
    isActionableSignal(
      baselineDirection
    );

  const finalActionable =
    safetyDecision === "BUY" ||
    safetyDecision === "SELL";

  const proposedPlan =
    safetyResult?.finalDecision
      ?.tradePlan ??
    decisionResult?.proposedDecision
      ?.tradePlan ??
    null;

  const directionChanged =
    finalActionable &&
    safetyDecision !==
      baselineDirection;

  const planChanged =
    finalActionable &&
    signal.tradePlan &&
    proposedPlan &&
    !sameTradePlanGeometry(
      signal.tradePlan,
      proposedPlan
    );

  const suppressionRequested =
    baselineActionable &&
    !finalActionable;

  const activeLifecycleChangeDeferred =
    activeContinuation &&
    (
      directionChanged ||
      planChanged ||
      suppressionRequested
    );

  if (activeLifecycleChangeDeferred) {
    /*
     * AI entry authority is fully live for fresh lifecycles, but an already
     * active trade cannot be retrospectively cancelled/reversed/replanned by a
     * signal generator. Preserve its original direction/plan until resolution.
     * Confidence may still receive the AI's bounded update for observability.
     */
    const proposedConfidence =
      Number(
        decisionResult?.proposedDecision
          ?.confidence
      );

    if (Number.isFinite(proposedConfidence)) {
      signal.confidence =
        clamp(
          proposedConfidence,
          0,
          100
        );
    }

    appendAutonomousStep(
      signal,
      {
        name:
          "AI Autonomous Decision",
        pass: true,
        status: "info",
        detail:
          "AI evaluated the active lifecycle, but direction/plan/suppression changes were deferred until the preserved trade resolves"
      }
    );

    signal.aiAutonomous =
      buildAutonomousSummary({
        decisionResult,
        safetyResult,
        baselineDirection,
        finalDirection:
          baselineDirection,
        activeLifecycleChangeDeferred:
          true
      });

    return signal;
  }

  if (!finalActionable) {
    signal.signal = "WAIT";
    signal.confidence = 0;
    signal.tradePlan = null;

    const aiReasons =
      Array.isArray(
        safetyResult?.finalDecision
          ?.reasons
      )
        ? safetyResult
            .finalDecision
            .reasons
        : [];

    signal.reasons =
      uniqueSignalReasons([
        ...(Array.isArray(signal.reasons)
          ? signal.reasons
          : []),
        ...aiReasons
      ]);

    if (
      baselineActionable ||
      proposedDecision !== "HOLD"
    ) {
      signal.reason =
        aiReasons[
          aiReasons.length - 1
        ] ||
        "AI autonomous authority returned HOLD";
    }

    appendAutonomousStep(
      signal,
      {
        name:
          "AI Autonomous Decision",
        pass:
          !baselineActionable,
        status:
          baselineActionable
            ? "fail"
            : "info",
        detail:
          baselineActionable
            ? "Live autonomous AI authority converted the deterministic Scalp candidate to HOLD"
            : "Autonomous AI evaluated the deterministic HOLD; no validated live direction activation was approved"
      }
    );

    signal.aiAutonomous =
      buildAutonomousSummary({
        decisionResult,
        safetyResult,
        baselineDirection:
          baselineActionable
            ? baselineDirection
            : "HOLD",
        finalDirection: "HOLD"
      });

    return signal;
  }

  const finalConfidence =
    Number(
      safetyResult?.finalDecision
        ?.confidence
    );

  signal.signal =
    safetyDecision;

  signal.confidence =
    Number.isFinite(finalConfidence)
      ? clamp(
          finalConfidence,
          0,
          100
        )
      : signal.confidence;

  signal.tradePlan =
    mergeAutonomousTradePlan(
      signal.tradePlan,
      proposedPlan
    );

  const aiReasons =
    Array.isArray(
      safetyResult?.finalDecision
        ?.reasons
    )
      ? safetyResult
          .finalDecision
          .reasons
      : [];

  signal.reasons =
    uniqueSignalReasons([
      ...(Array.isArray(signal.reasons)
        ? signal.reasons
        : []),
      ...aiReasons
    ]);

  appendAutonomousStep(
    signal,
    {
      name:
        "AI Autonomous Decision",
      pass: true,
      status: "pass",
      detail:
        `AI ${decisionResult?.deployment?.authorityMode || "UNKNOWN"} authority approved ${safetyDecision}; Safety Gate ${safetyResult?.approval?.status || "UNKNOWN"}`
    }
  );

  signal.aiAutonomous =
    buildAutonomousSummary({
      decisionResult,
      safetyResult,
      baselineDirection:
        baselineActionable
          ? baselineDirection
          : "HOLD",
      finalDirection:
        safetyDecision
    });

  return signal;
}

/* =====================================================================
   Signal Log Duplicate Suppression
   ===================================================================== */

function normalizeSignalDirection(value) {
  const normalized =
    String(value ?? "")
      .trim()
      .toUpperCase();

  return (
    normalized === "BUY" ||
    normalized === "SELL"
  )
    ? normalized
    : "WAIT";
}

function isActionableSignal(value) {
  const direction =
    normalizeSignalDirection(value);

  return (
    direction === "BUY" ||
    direction === "SELL"
  );
}

function findPairConfiguration(pairLabel) {
  const normalized =
    normalizePairKey(pairLabel);

  return (
    PAIRS.find(
      pair =>
        normalizePairKey(pair.label) === normalized ||
        normalizePairKey(pair.key) === normalized
    ) ||
    null
  );
}

function minimumPriceIncrement(pairLabel) {
  const pair =
    findPairConfiguration(pairLabel);

  const decimals =
    pair
      ? decimalsFor(pair)
      : 6;

  return 10 ** -decimals;
}

function numericValue(value) {
  const number =
    Number(value);

  return Number.isFinite(number)
    ? number
    : null;
}

function tradePlanRisk(tradePlan) {
  if (
    !tradePlan ||
    typeof tradePlan !== "object"
  ) {
    return null;
  }

  const entry =
    numericValue(
      tradePlan.entry
    );

  const stopLoss =
    numericValue(
      tradePlan.stopLoss
    );

  if (
    entry === null ||
    stopLoss === null
  ) {
    return null;
  }

  return Math.abs(
    entry - stopLoss
  );
}

function tradePlanPriceTolerance(signal) {
  const tradePlan =
    signal?.tradePlan;

  const entry =
    numericValue(
      tradePlan?.entry
    );

  const risk =
    tradePlanRisk(
      tradePlan
    );

  const minimumIncrement =
    minimumPriceIncrement(
      signal?.pair
    );

  const incrementTolerance =
    minimumIncrement * 2;

  const priceTolerance =
    entry !== null
      ? Math.abs(entry) *
        LOG_PLAN_PRICE_CHANGE_RATIO
      : 0;

  const riskTolerance =
    risk !== null
      ? risk *
        LOG_PLAN_RISK_CHANGE_RATIO
      : 0;

  return Math.max(
    incrementTolerance,
    priceTolerance,
    riskTolerance
  );
}

function numbersMateriallyEqual(
  first,
  second,
  tolerance
) {
  const firstNumber =
    numericValue(first);

  const secondNumber =
    numericValue(second);

  if (
    firstNumber === null &&
    secondNumber === null
  ) {
    return true;
  }

  if (
    firstNumber === null ||
    secondNumber === null
  ) {
    return false;
  }

  return (
    Math.abs(
      firstNumber -
      secondNumber
    ) <= tolerance
  );
}

function tradePlansMateriallyEqual(
  previousSignal,
  currentSignal
) {
  const previousPlan =
    previousSignal?.tradePlan;

  const currentPlan =
    currentSignal?.tradePlan;

  if (
    !previousPlan &&
    !currentPlan
  ) {
    return true;
  }

  if (
    !previousPlan ||
    !currentPlan
  ) {
    return false;
  }

  const tolerance =
    Math.max(
      tradePlanPriceTolerance(
        previousSignal
      ),
      tradePlanPriceTolerance(
        currentSignal
      )
    );

  const priceFields = [
    "entry",
    "stopLoss",
    "target1",
    "target2",
    "target3"
  ];

  for (
    const field of priceFields
  ) {
    if (
      !numbersMateriallyEqual(
        previousPlan[field],
        currentPlan[field],
        tolerance
      )
    ) {
      return false;
    }
  }

  if (
    !numbersMateriallyEqual(
      previousPlan.riskReward,
      currentPlan.riskReward,
      LOG_RISK_REWARD_CHANGE_THRESHOLD
    )
  ) {
    return false;
  }

  return true;
}

function confidenceMateriallyEqual(
  previousConfidence,
  currentConfidence
) {
  const previous =
    numericValue(
      previousConfidence
    );

  const current =
    numericValue(
      currentConfidence
    );

  if (
    previous === null &&
    current === null
  ) {
    return true;
  }

  if (
    previous === null ||
    current === null
  ) {
    return false;
  }

  return (
    Math.abs(
      previous -
      current
    ) <
    LOG_CONFIDENCE_CHANGE_THRESHOLD
  );
}

function findPreviousSnapshotSignal(
  previousSnapshot,
  currentSignal
) {
  const previousSignals =
    Array.isArray(
      previousSnapshot?.signals
    )
      ? previousSnapshot.signals
      : [];

  const expectedPair =
    normalizePairKey(
      currentSignal?.pair
    );

  const expectedMode =
    String(
      currentSignal?.mode ??
      ""
    )
      .trim()
      .toUpperCase();

  return (
    previousSignals.find(
      previous =>
        normalizePairKey(
          previous?.pair
        ) === expectedPair &&
        String(
          previous?.mode ??
          ""
        )
          .trim()
          .toUpperCase() ===
          expectedMode
    ) ||
    null
  );
}

function findLatestSignalLogEntry(
  log,
  currentSignal
) {
  const expectedPair =
    normalizePairKey(
      currentSignal?.pair
    );

  const expectedMode =
    String(
      currentSignal?.mode ??
      ""
    )
      .trim()
      .toUpperCase();

  for (
    let index =
      log.length - 1;
    index >= 0;
    index--
  ) {
    const entry =
      log[index];

    if (
      !entry ||
      typeof entry !== "object"
    ) {
      continue;
    }

    if (
      normalizePairKey(
        entry.pair
      ) !== expectedPair
    ) {
      continue;
    }

    if (
      String(
        entry.mode ??
        ""
      )
        .trim()
        .toUpperCase() !==
      expectedMode
    ) {
      continue;
    }

    return entry;
  }

  return null;
}

function signalLifecycleIdentity(signal) {
  if (
    !signal ||
    typeof signal !== "object"
  ) {
    return null;
  }

  const pair =
    normalizePairKey(signal.pair);

  const mode =
    String(
      signal.setupTimeframe ??
      signal.timeframe ??
      signal.mode ??
      ""
    )
      .trim()
      .toUpperCase();

  const direction =
    normalizeSignalDirection(
      signal.signal
    );

  if (
    !pair ||
    !mode ||
    !isActionableSignal(direction)
  ) {
    return null;
  }

  const setupAt =
    toIsoTimestamp(
      signal.setupCandleAt ??
      signal.analyzedCandleAt
    );

  const executionAt =
    toIsoTimestamp(
      signal.executionCandleAt ??
      signal.analyzedCandleAt
    );

  if (setupAt || executionAt) {
    return [
      "scalp-lifecycle-v1",
      pair,
      mode,
      direction,
      setupAt || "",
      executionAt || ""
    ].join("|");
  }

  const plan =
    signal.tradePlan;

  if (!plan || typeof plan !== "object") {
    return null;
  }

  const fields = [
    plan.entry,
    plan.stopLoss,
    plan.target1
  ].map(value => {
    const numeric = Number(value);

    return Number.isFinite(numeric)
      ? String(numeric)
      : "";
  });

  if (fields.every(value => !value)) {
    return null;
  }

  return [
    "scalp-plan-v1",
    pair,
    mode,
    direction,
    ...fields
  ].join("|");
}

function latestMatchingLifecycleLogEntry(
  log,
  signal
) {
  const identity =
    signalLifecycleIdentity(signal);

  if (!identity || !Array.isArray(log)) {
    return null;
  }

  for (
    let index = log.length - 1;
    index >= 0;
    index -= 1
  ) {
    if (
      signalLifecycleIdentity(
        log[index]
      ) === identity
    ) {
      return log[index];
    }
  }

  return null;
}

function shouldAppendSignalLogEntry({
  signal,
  previousSnapshot,
  log
}) {
  if (
    !isActionableSignal(
      signal?.signal
    )
  ) {
    return {
      append: false,
      reason:
        "non-actionable-signal"
    };
  }

  const previousSnapshotSignal =
    findPreviousSnapshotSignal(
      previousSnapshot,
      signal
    );

  /*
   * No previous snapshot means this is either the first run or the
   * previous output was unavailable. Preserve the signal in the log.
   */
  if (!previousSnapshotSignal) {
    /*
     * Snapshot loss/recovery must not replay an already-persisted lifecycle.
     * Only suppress an exact pair+timeframe+direction+lifecycle identity; a
     * genuinely new M5/M15/M30 opportunity remains appendable.
     */
    if (
      latestMatchingLifecycleLogEntry(
        log,
        signal
      )
    ) {
      return {
        append: false,
        reason:
          "duplicate-lifecycle-recovery"
      };
    }

    return {
      append: true,
      reason:
        "no-previous-snapshot"
    };
  }

  const previousDirection =
    normalizeSignalDirection(
      previousSnapshotSignal.signal
    );

  const currentDirection =
    normalizeSignalDirection(
      signal.signal
    );

  /*
   * A signal appearing after WAIT represents a new signal lifecycle,
   * even when an older historical log entry has the same direction.
   */
  if (
    !isActionableSignal(
      previousDirection
    )
  ) {
    return {
      append: true,
      reason:
        "signal-reactivated"
    };
  }

  if (
    previousDirection !==
    currentDirection
  ) {
    return {
      append: true,
      reason:
        "direction-changed"
    };
  }

  const latestLogEntry =
    findLatestSignalLogEntry(
      log,
      signal
    );

  /*
   * Recover safely if the snapshot says a signal was active but its
   * matching persistent log entry is missing.
   */
  if (!latestLogEntry) {
    return {
      append: true,
      reason:
        "missing-log-history"
    };
  }

  if (
    normalizeSignalDirection(
      latestLogEntry.signal
    ) !== currentDirection
  ) {
    return {
      append: true,
      reason:
        "log-direction-changed"
    };
  }

  if (
    !tradePlansMateriallyEqual(
      latestLogEntry,
      signal
    )
  ) {
    return {
      append: true,
      reason:
        "trade-plan-changed"
    };
  }

  if (
    !confidenceMateriallyEqual(
      latestLogEntry.confidence,
      signal.confidence
    )
  ) {
    return {
      append: true,
      reason:
        "confidence-changed"
    };
  }

  return {
    append: false,
    reason:
      "unchanged-active-signal"
  };
}

function createSignalLogEntry(
  signal,
  generatedAt,
  reason
) {
  return {
    pair:
      signal.pair,

    mode:
      signal.mode,

    signal:
      normalizeSignalDirection(
        signal.signal
      ),

    confidence:
      signal.confidence,

    tradePlan:
      signal.tradePlan,

    generatedAt,

    analyzedCandleAt:
      signal.analyzedCandleAt ??
      null,

    setupTimeframe:
      signal.setupTimeframe ??
      signal.mode ??
      null,

    confirmationTimeframe:
      signal.confirmationTimeframe ??
      signal.setupTimeframe ??
      signal.mode ??
      null,

    executionTimeframe:
      signal.executionTimeframe ??
      signal.entryTimeframe ??
      signal.mode ??
      null,

    entryTimeframe:
      signal.entryTimeframe ??
      signal.executionTimeframe ??
      signal.mode ??
      null,

    setupCandleAt:
      signal.setupCandleAt ??
      signal.analyzedCandleAt ??
      null,

    executionCandleAt:
      signal.executionCandleAt ??
      signal.analyzedCandleAt ??
      null,

    executionReason:
      signal.executionReason ??
      null,

    aiAutonomous:
      signal.aiAutonomous &&
      typeof signal.aiAutonomous ===
        "object"
        ? signal.aiAutonomous
        : null,

    logReason:
      reason
  };
}

/* =====================================================================
   Prepared Market Data Diagnostics
   ===================================================================== */

function buildPreparedMarketData(
  scalp,
  h1
) {
  const m5Rows =
    Array.isArray(scalp?.rows)
      ? scalp.rows
      : [];

  const h1Rows =
    Array.isArray(h1?.rows)
      ? h1.rows
      : [];

  /*
   * Build these once from the exact normalized, fully closed M5 rows
   * used by the backend analysis pipeline.
   */
  const m15Rows =
    buildM15Rows(
      m5Rows
    );

  const m30Rows =
    buildM30Rows(
      m5Rows
    );

  return {
    counts: {
      m5:
        m5Rows.length,

      m15:
        m15Rows.length,

      m30:
        m30Rows.length,

      h1:
        h1Rows.length
    },

    source: {
      m5:
        scalp?.source ??
        "scalp-candles.json",

      h1:
        h1?.source ??
        "intraday-h1.json"
    },

    updatedAt: {
      m5:
        scalp?.sourceUpdatedAt ??
        null,

      h1:
        h1?.sourceUpdatedAt ??
        null
    },

    quality: {
      m5:
        candleDataQuality(
          scalp,
          5
        ),

      h1:
        candleDataQuality(
          h1,
          60
        )
    }
  };
}

/* =====================================================================
   Main Worker
   ===================================================================== */

function run() {

  const previousSnapshot =
    readJsonFile(
      SIGNALS_OUT_PATH,
      {
        signals: []
      }
    );

  const generatedAt =
    new Date().toISOString();

  const news =
    readNewsFeed(
      generatedAt
    );

  const signals = [];

  for (const pair of PAIRS) {

    const scalp =
      readScalpRows(pair);

    const h1 =
      readH1Rows(pair);

    if (
      !hasEnoughRows(
        scalp.rows,
        MIN_M5_ROWS
      )
    ) {
      continue;
    }

    /*
     * Prepared market-data information is calculated
     * once per pair and shared across all scalp modes.
     *
     * This is additive only and does not change the
     * existing analysis or signal-generation logic.
     */

    const derivedM15Rows =
      buildM15Rows(
        scalp.rows
      );

    const derivedM30Rows =
      buildM30Rows(
        scalp.rows
      );

    const prepared = {

      counts: {

        m5:
          Array.isArray(scalp.rows)
            ? scalp.rows.length
            : 0,

        m15:
          Array.isArray(derivedM15Rows)
            ? derivedM15Rows.length
            : 0,

        m30:
          Array.isArray(derivedM30Rows)
            ? derivedM30Rows.length
            : 0,

        h1:
          Array.isArray(h1.rows)
            ? h1.rows.length
            : 0

      },

      source: {

        m5:
          scalp.source ??
          null,

        h1:
          h1.source ??
          null

      },

      updatedAt: {

        m5:
          scalp.sourceUpdatedAt ??
          latestRow(scalp.rows)?.date ??
          null,

        h1:
          h1.sourceUpdatedAt ??
          latestRow(h1.rows)?.date ??
          null

      },

      quality: {

        m5:
          candleDataQuality(
            scalp,
            5
          ),

        h1:
          candleDataQuality(
            h1,
            60
          )

      }

    };

    for (const mode of MODES) {

      const rows =
        rowsForMode(
          mode,
          scalp.rows
        );

      const higherRows =
        higherTimeframeRows(
          mode,
          scalp.rows,
          h1.rows
        );

      const pairNews =
        newsForPair(
          pair.label,
          news
        );

      const score =
        newsScoreForPair(
          pair.label,
          pairNews
        );

      const analysis =
        analyze(
          rows,
          pair.label,
          score,
          higherRows,
          pairNews,
          {
            mode,
            newsReferenceTime:
              generatedAt,
            executionRows:
              scalp.rows,
            executionTimeframe:
              "M5",
            previousSignal:
              findPreviousSnapshotSignal(
                previousSnapshot,
                {
                  pair:
                    pair.label,
                  mode
                }
              ),
            dataQuality:
              mode === "M5"
                ? prepared.quality.m5
                : {
                    stale:
                      prepared.quality.m5
                        .stale ||
                      (
                        mode === "M30" &&
                        prepared.quality.h1
                          .stale
                      ),
                    derivedFrom:
                      mode === "M30"
                        ? "complete-closed-M5-with-H1-confirmation"
                        : "complete-closed-M5",
                    validRows:
                      Array.isArray(rows)
                        ? rows.length
                        : 0
                  }
          }
        );

      analysis.mode =
        mode;

      analysis.generatedAt =
        generatedAt;

      analysis.analyzedCandleAt =
        latestRow(rows)?.date ??
        null;

      /*
       * Preserve prepared market-data diagnostics
       * in every generated signal.
       */

      analysis.prepared = {
        counts: {
          ...prepared.counts
        },

        source: {
          ...prepared.source
        },

        updatedAt: {
          ...prepared.updatedAt
        },

        quality: {
          ...prepared.quality
        }
      };

      applyAutonomousScalpAuthority(
        analysis,
        {
          pair,
          mode,
          generatedAt,
          currentMarketDataAt:
            latestRow(scalp.rows)?.date ??
            null,
          currentPrice:
            latestRow(scalp.rows)?.close ??
            null
        }
      );

      signals.push(
        analysis
      );

    }

  }

  atomicWriteJson(
    SIGNALS_OUT_PATH,
    {
      generatedAt,
      engineVersion:
        ENGINE_VERSION,
      strategyVersion:
        STRATEGY_VERSION,
      professionalPipelineVersion:
        PROFESSIONAL_PIPELINE_VERSION,
      signals
    }
  );

  let log =
    readJsonFile(
      LOG_OUT_PATH,
      []
    );

  if (!Array.isArray(log)) {
    log = [];
  }

  let appendedLogEntries =
    0;

  let suppressedLogEntries =
    0;

  for (const signal of signals) {

    const decision =
      shouldAppendSignalLogEntry({
        signal,
        previousSnapshot,
        log
      });

    if (!decision.append) {

      if (
        (
          decision.reason ===
            "unchanged-active-signal" ||
          decision.reason ===
            "duplicate-lifecycle-recovery"
        )
      ) {

        suppressedLogEntries++;

        console.log(
          `[Scalp Engine] Duplicate log suppressed: ` +
          `${signal.pair} ${signal.mode} ` +
          `${signal.signal}`
        );

      }

      continue;

    }

    log.push(
      createSignalLogEntry(
        signal,
        generatedAt,
        decision.reason
      )
    );

    appendedLogEntries++;

    console.log(
      `[Scalp Engine] Signal logged: ` +
      `${signal.pair} ${signal.mode} ` +
      `${signal.signal} ` +
      `(${decision.reason})`
    );

  }

  if (log.length > MAX_SIGNAL_LOG) {

    log =
      log.slice(
        log.length -
        MAX_SIGNAL_LOG
      );

  }

  atomicWriteJson(
    LOG_OUT_PATH,
    log
  );

  console.log(
    `[Scalp Engine] ${signals.length} analyses completed; ` +
    `${appendedLogEntries} signal log entr` +
    `${appendedLogEntries === 1 ? "y" : "ies"} added; ` +
    `${suppressedLogEntries} duplicate` +
    `${suppressedLogEntries === 1 ? "" : "s"} suppressed.`
  );

}

module.exports = {
  ENGINE_VERSION,
  STRATEGY_VERSION,
  PROFESSIONAL_PIPELINE_VERSION,
  aggregateCandles,
  buildM15Rows,
  buildM30Rows,
  rsiSeries,
  atrSeries,
  computeMACD,
  computeDmiAdx,
  getEMAState,
  buildAtrSnapshot,
  inferHigherTimeframeBias,
  analyze,
  applyAutonomousScalpAuthority,
  signalLifecycleIdentity,
  shouldAppendSignalLogEntry,
  run
};

if (require.main === module) {

  try {

    run();

  } catch (error) {

    console.error(
      "[Scalp Engine]",
      error
    );

    process.exit(1);

  }

}
