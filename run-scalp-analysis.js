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
      item.publishedAt ??
      item.time ??
      item.datetime ??
      null,

    source:
      item.source ??
      "",

    raw: item

  };

}

function readNewsFeed() {

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
    .filter(Boolean);

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
  newsItems
) {

  for (const news of newsItems) {

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
      newsItems
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
   * Preserve the setup calculation on its own mode while executing the
   * qualified trade from the latest fully closed execution candle. The
   * worker passes the normalized M5 rows here for M15 and M30 setups.
   * Direct analyze() callers that omit executionRows retain the original
   * same-timeframe entry behavior.
   */
  const entry =
    lastClose(
      executionRows
    );

  const tradePlanResult =
    buildProfessionalTradePlan({
      direction,
      entry,
      pairLabel,
      mode,
      atrSnapshot: atr,
      supportResistance,
      structure
    });

  result.riskDiagnostics =
    tradePlanResult.diagnostics ??
    {
      reason:
        tradePlanResult.reason
    };

  result.steps.push({
    name: "Risk Reward",
    pass:
      tradePlanResult.valid,
    status:
      tradePlanResult.valid
        ? "pass"
        : "fail",
    detail:
      tradePlanResult.valid
        ? `Professional ATR-regime plan passed: ${tradePlanResult.plan.riskReward}R target, ${tradePlanResult.plan.stopAtrMultiplier} ATR stop, regime ${tradePlanResult.plan.atrRegime}`
        : `Trade plan rejected: ${tradePlanResult.reason}`
  });

  if (!tradePlanResult.valid) {
    result.reasons.push(
      tradePlanResult.reason ||
      "Risk plan invalid"
    );
    return result;
  }

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

  const news =
    readNewsFeed();

  const signals = [];

  const generatedAt =
    new Date().toISOString();

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
            executionRows:
              scalp.rows,
            executionTimeframe:
              "M5",
            dataQuality:
              mode === "M5"
                ? prepared.quality.m5
                : {
                    stale:
                      prepared.quality.m5
                        .stale,
                    derivedFrom:
                      "complete-closed-M5",
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
        decision.reason ===
        "unchanged-active-signal"
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
