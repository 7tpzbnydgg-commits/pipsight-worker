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
    rows.length === 0
  ) {
    return [];
  }

  const buckets =
    new Map();

  for (const row of rows) {

    if (
      !row ||
      !row.isClosed
    ) {
      continue;
    }

    const bucketTime =
      floorToBucket(
        row.date,
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

        open:
          row.open,

        high:
          row.high,

        low:
          row.low,

        close:
          row.close,

        volume:
          row.volume || 0,

        hasOHLC:
          row.hasOHLC,

        isClosed: true

      });

      continue;
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
      row.volume || 0;

    candle.hasOHLC =
      candle.hasOHLC &&
      row.hasOHLC;
  }

  return Array
    .from(
      buckets.values()
    )
    .sort(
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
    }
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

  const ema20 =
    emaSeries(
      closes,
      periods.p20
    );

  const ema50 =
    emaSeries(
      closes,
      periods.p50
    );

  const ema100 =
    emaSeries(
      closes,
      periods.p100
    );

  const ema200 =
    emaSeries(
      closes,
      periods.p200
    );

  const lastIndex =
    closes.length - 1;

  const lastCloseValue =
    closes[lastIndex];

  const v20 =
    ema20[lastIndex];

  const v50 =
    ema50[lastIndex];

  const v100 =
    ema100[lastIndex];

  const v200 =
    ema200[lastIndex];

  if (
    ![
      lastCloseValue,
      v20,
      v50,
      v100,
      v200
    ].every(isFiniteNumber)
  ) {
    return {
      ...unavailable,
      lastClose:
        isFiniteNumber(lastCloseValue)
          ? lastCloseValue
          : null,
      periods
    };
  }

  const bullishChecks = [
    lastCloseValue > v20,
    v20 > v50,
    v50 > v100,
    v100 > v200
  ];

  const bearishChecks = [
    lastCloseValue < v20,
    v20 < v50,
    v50 < v100,
    v100 < v200
  ];

  const bullishCount =
    bullishChecks.filter(Boolean)
      .length;

  const bearishCount =
    bearishChecks.filter(Boolean)
      .length;

  let direction = null;
  let alignmentCount = 0;

  if (bullishCount === 4) {
    direction = "BUY";
    alignmentCount = 4;
  } else if (bearishCount === 4) {
    direction = "SELL";
    alignmentCount = 4;
  } else if (
    bullishCount >
    bearishCount
  ) {
    alignmentCount =
      bullishCount;
  } else if (
    bearishCount >
    bullishCount
  ) {
    alignmentCount =
      bearishCount;
  } else {
    alignmentCount =
      bullishCount;
  }

  return {
    available: true,
    direction,
    alignmentCount,

    fullAlignment:
      alignmentCount === 4 &&
      direction !== null,

    partialAlignment:
      alignmentCount === 3 &&
      direction === null,

    lastClose:
      lastCloseValue,

    periods,

    values: {
      ema20: v20,
      ema50: v50,
      ema100: v100,
      ema200: v200
    },

    bullishCount,
    bearishCount
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
   Main Analysis Engine
   ===================================================================== */

function analyze(
  rows,
  pairLabel,
  newsScoreRaw,
  htfRows,
  newsItems
) {

  const result = {
    pair: pairLabel,
    signal: "WAIT",
    confidence: 0,
    reasons: [],
    steps: [],
    tradePlan: null
  };

  if (!hasEnoughRows(rows, 35)) {
    result.reasons.push("Not enough candles");
    return result;
  }

  const closes = closeSeries(rows);

  const emaState =
    getEMAState(rows);

  const macd =
    computeMACD(closes);

  const rsi =
    rsiSeries(closes);

  const lastRSI =
    rsi[rsi.length - 1];

  const market =
    computeMarketStructure(rows);

  const sr =
    computeSupportResistance(rows);

  const candlePattern =
    detectCandlePattern(rows);

  /* =============================
     STEP 1 : EMA Trend
     ============================= */

  if (!emaState.fullAlignment) {

    result.steps.push({
      name: "EMA Trend",
      pass: false
    });

    result.reasons.push(
      "EMA alignment failed"
    );

    return result;

  }

  result.steps.push({
    name: "EMA Trend",
    pass: true
  });

  let direction =
    emaState.direction;

  /* =============================
     STEP 2 : MACD
     ============================= */

  let macdPass = false;

  if (
    direction === "BUY" &&
    macd.available &&
    macd.macd > macd.signal
  ) {
    macdPass = true;
  }

  if (
    direction === "SELL" &&
    macd.available &&
    macd.macd < macd.signal
  ) {
    macdPass = true;
  }

  result.steps.push({
    name: "MACD",
    pass: macdPass
  });

  if (!macdPass) {
    result.reasons.push(
      "MACD confirmation failed"
    );
    return result;
  }

  /* =============================
     STEP 3 : RSI
     ============================= */

  let rsiPass = false;

  if (
    direction === "BUY" &&
    lastRSI >= 45 &&
    lastRSI <= 65
  ) {
    rsiPass = true;
  }

  if (
    direction === "SELL" &&
    lastRSI >= 35 &&
    lastRSI <= 55
  ) {
    rsiPass = true;
  }

  result.steps.push({
    name: "RSI",
    pass: rsiPass
  });

  if (!rsiPass) {

    result.reasons.push(
      "RSI confirmation failed"
    );

    return result;

  }

  /* =============================
     STEP 4 : Higher TF
     ============================= */

  if (htfRows) {

    const htfTrend =
      trendDirectionOf(htfRows);

    if (
      htfTrend &&
      htfTrend !== direction
    ) {

      result.steps.push({
        name: "Higher TF",
        pass: false
      });

      result.reasons.push(
        "Higher timeframe mismatch"
      );

      return result;

    }

    result.steps.push({
      name: "Higher TF",
      pass: true
    });

  }

  /* =============================
     STEP 5 : News Filter
     ============================= */

  const conflict =
    conflictingHighImpactNews(
      direction,
      newsItems
    );

  if (conflict) {

    result.steps.push({
      name: "News",
      pass: false
    });

    result.reasons.push(
      "High impact news conflict"
    );

    return result;

  }

  result.steps.push({
    name: "News",
    pass: true
  });

  /* =============================
     STEP 6 : Support / Resistance
     ============================= */

  const entry =
    lastClose(rows);

  let stop;
  let target;

  if (direction === "BUY") {

    const support =
      sr.supports[0];

    const resistance =
      sr.resistances[0];

    if (
      !support ||
      !resistance
    ) {
      result.reasons.push(
        "Support/Resistance unavailable"
      );
      return result;
    }

    stop = support;

    target = resistance;

  } else {

    const resistance =
      sr.resistances[0];

    const support =
      sr.supports[0];

    if (
      !support ||
      !resistance
    ) {
      result.reasons.push(
        "Support/Resistance unavailable"
      );
      return result;
    }

    stop = resistance;

    target = support;

  }

  const rr =
    calculateRiskReward(
      entry,
      stop,
      target
    );

  if (rr < 2) {

    result.steps.push({
      name: "Risk Reward",
      pass: false
    });

    result.reasons.push(
      "Risk Reward below 1:2"
    );

    return result;

  }

  result.steps.push({
    name: "Risk Reward",
    pass: true
  });

  /* =============================
     Final Signal
     ============================= */

  result.signal =
    direction;

  result.confidence =
    80;

  if (market.direction === direction)
    result.confidence += 10;

  if (candlePattern)
    result.confidence += 5;

  if (Math.abs(newsScoreRaw) < 10)
    result.confidence += 5;

  result.confidence =
    clamp(
      result.confidence,
      0,
      100
    );

  const risk =
    Math.abs(entry - stop);

  result.tradePlan = {

    entry,

    stopLoss: stop,

    target1: target,

    target2:
      direction === "BUY"
        ? entry + risk * 3
        : entry - risk * 3,

    target3:
      direction === "BUY"
        ? entry + risk * 4
        : entry - risk * 4,

    riskReward:
      round(rr, 2)

  };

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

    logReason:
      reason
  };
}

/* =====================================================================
   Main Worker
   ===================================================================== */

function run() {

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

    if (!hasEnoughRows(scalp.rows, MIN_M5_ROWS)) {
      continue;
    }

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
          pairNews
        );

      analysis.mode = mode;
      analysis.generatedAt = generatedAt;

      signals.push(analysis);

    }

  }

  atomicWriteJson(
    SIGNALS_OUT_PATH,
    {
      generatedAt,
      engineVersion: ENGINE_VERSION,
      strategyVersion: STRATEGY_VERSION,
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

  for (const signal of signals) {

    if (
      signal.signal === "BUY" ||
      signal.signal === "SELL"
    ) {

      log.push({
        pair: signal.pair,
        mode: signal.mode,
        signal: signal.signal,
        confidence: signal.confidence,
        tradePlan: signal.tradePlan,
        generatedAt
      });

    }

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
    `[Scalp Engine] ${signals.length} analyses completed.`
  );

}

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
