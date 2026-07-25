"use strict";

/**
 * PipSight Robot — global news/data collector
 * -----------------------------------------------------------------------
 * Runs on a schedule via GitHub Actions:
 * .github/workflows/fetch-news.yml
 *
 * No API key required.
 *
 * Responsibilities:
 * - Fetch public RSS feeds.
 * - Tag headlines to XAU/USD or GBP/JPY.
 * - Score transparent keyword-based sentiment.
 * - Classify high-impact market news.
 * - Write data/news-feed.json.
 *
 * Existing output format is preserved:
 *
 * {
 *   updatedAt,
 *   feedCount,
 *   items
 * }
 * -----------------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");
const Parser = require("rss-parser");

const CONFIG = Object.freeze({
  requestTimeoutMs: 15000,
  perPairCap: 6,
  outputPath: path.join(
    __dirname,
    "data",
    "news-feed.json"
  ),
  temporaryOutputPath: path.join(
    __dirname,
    "data",
    "news-feed.json.tmp"
  )
});

const parser = new Parser({
  timeout: CONFIG.requestTimeoutMs,
  headers: {
    "User-Agent":
      "PipSight-Robot/1.0 RSS News Collector",
    Accept:
      "application/rss+xml, application/xml, text/xml, */*"
  }
});

// Free, keyless RSS sources.
//
// Pair tagging and sentiment processing are based on article text,
// so feeds may be added or removed without changing downstream logic.
const FEEDS = Object.freeze([
  Object.freeze({
    url: "https://www.forexlive.com/feed/",
    source: "ForexLive"
  }),
  Object.freeze({
    url: "https://www.forexlive.com/feed/centralbank",
    source: "ForexLive (Central Banks)"
  }),
  Object.freeze({
    url: "https://www.investing.com/rss/news_1.rss",
    source: "Investing.com"
  })
]);

const PAIR_KEYWORDS = Object.freeze({
  "XAU/USD": Object.freeze([
    "gold",
    "xau",
    "bullion",
    "precious metal",
    "safe-haven",
    "safe haven"
  ]),

  "GBP/JPY": Object.freeze([
    "gbp",
    "pound sterling",
    "sterling",
    "jpy",
    "yen",
    "boj",
    "bank of japan",
    "boe",
    "bank of england",
    "cable"
  ])
});

// Transparent directional-tone lexicon.
//
// This remains a simple auditable heuristic and does not introduce
// black-box NLP behavior.
const BULLISH_WORDS = Object.freeze([
  "surge",
  "rally",
  "gain",
  "gains",
  "rose",
  "rises",
  "rising",
  "higher",
  "climb",
  "climbs",
  "jump",
  "jumps",
  "strengthen",
  "strengthens",
  "bullish",
  "upbeat",
  "recovery",
  "rebound",
  "soar",
  "soars",
  "advance",
  "advances",
  "buy",
  "buying",
  "support",
  "beat",
  "beats",
  "outperform"
]);

const BEARISH_WORDS = Object.freeze([
  "plunge",
  "plunges",
  "slump",
  "slumps",
  "fall",
  "falls",
  "falling",
  "lower",
  "drop",
  "drops",
  "decline",
  "declines",
  "weaken",
  "weakens",
  "bearish",
  "sell-off",
  "selloff",
  "selling",
  "tumble",
  "tumbles",
  "retreat",
  "retreats",
  "slide",
  "slides",
  "miss",
  "misses",
  "underperform",
  "risk-off",
  "risk off"
]);

// Headlines containing these phrases retain impact: "high".
const HIGH_IMPACT_WORDS = Object.freeze([
  "fed",
  "fomc",
  "federal reserve",
  "rate decision",
  "interest rate",
  "rate hike",
  "rate cut",
  "nonfarm payrolls",
  "nfp",
  "jobs report",
  "unemployment rate",
  "cpi",
  "inflation report",
  "gdp",
  "boe",
  "bank of england",
  "boj",
  "bank of japan",
  "ecb",
  "european central bank",
  "powell",
  "central bank",
  "fomc minutes",
  "jackson hole"
]);

function normalizeText(value) {
  return String(
    value ?? ""
  )
    .replace(/\s+/g, " ")
    .trim();
}

function classifyImpact(text) {
  const normalized =
    normalizeText(text)
      .toLowerCase();

  return HIGH_IMPACT_WORDS.some(
    word => normalized.includes(word)
  )
    ? "high"
    : "normal";
}

function scoreSentiment(text) {
  const normalized =
    normalizeText(text)
      .toLowerCase();

  let score = 0;

  for (const word of BULLISH_WORDS) {
    if (normalized.includes(word)) {
      score += 5;
    }
  }

  for (const word of BEARISH_WORDS) {
    if (normalized.includes(word)) {
      score -= 5;
    }
  }

  return Math.max(
    -20,
    Math.min(20, score)
  );
}

function pairsFor(text) {
  const normalized =
    normalizeText(text)
      .toLowerCase();

  const hits = [];

  for (
    const [pair, words] of
    Object.entries(PAIR_KEYWORDS)
  ) {
    if (
      words.some(
        word => normalized.includes(word)
      )
    ) {
      hits.push(pair);
    }
  }

  return hits;
}

function fmtDate(date) {
  return date.toLocaleDateString(
    "en-GB",
    {
      day: "numeric",
      month: "short",
      year: "numeric"
    }
  );
}

function parsePublicationDate(value) {
  if (!value) {
    return new Date();
  }

  const parsedDate =
    new Date(value);

  if (
    !Number.isFinite(
      parsedDate.getTime()
    )
  ) {
    return new Date();
  }

  return parsedDate;
}

function buildArticleText(entry) {
  return normalizeText(
    [
      entry?.title,
      entry?.contentSnippet
    ]
      .filter(Boolean)
      .join(" ")
  );
}

function buildItemIdentity(item) {
  return [
    item.pair,
    item.source,
    item.text,
    item.ts
  ].join("|");
}

function deduplicateItems(items) {
  const seen =
    new Set();

  return items.filter(item => {
    const identity =
      buildItemIdentity(item);

    if (seen.has(identity)) {
      return false;
    }

    seen.add(identity);
    return true;
  });
}

async function collectFeedItems(feed) {
  const collected = [];

  const parsed =
    await parser.parseURL(
      feed.url
    );

  const entries =
    Array.isArray(parsed?.items)
      ? parsed.items
      : [];

  for (const entry of entries) {
    const text =
      normalizeText(entry?.title);

    if (!text) {
      continue;
    }

    const articleText =
      buildArticleText(entry);

    const pairs =
      pairsFor(articleText);

    if (pairs.length === 0) {
      continue;
    }

    const date =
      parsePublicationDate(
        entry?.pubDate
      );

    const sentiment =
      scoreSentiment(
        articleText
      );

    const impact =
      classifyImpact(text);

    for (const pair of pairs) {
      collected.push({
        pair,
        date: fmtDate(date),
        sentiment,
        source: feed.source,
        text,
        impact,
        ts: date.getTime()
      });
    }
  }

  return collected;
}

async function main() {

  const collectedItems = [];

  for (const feed of FEEDS) {

    try {

      const feedItems =
        await collectFeedItems(feed);

      collectedItems.push(
        ...feedItems
      );

    } catch (error) {

      console.error(
        `Feed failed: ${feed.url}`,
        error.message
      );

      // Continue processing remaining feeds.
    }

  }

  const uniqueItems =
    deduplicateItems(
      collectedItems
    );

  uniqueItems.sort(
    (first, second) =>
      second.ts - first.ts
  );

  const counts = {};

  const trimmed = [];

  for (const item of uniqueItems) {

    counts[item.pair] =
      (counts[item.pair] || 0) + 1;

    if (
      counts[item.pair] <=
      CONFIG.perPairCap
    ) {

      const {
        ts,
        ...rest
      } = item;

      trimmed.push(rest);

    }

  }

  const output = {

    updatedAt:
      new Date().toISOString(),

    feedCount:
      FEEDS.length,

    itemCount:
      trimmed.length,

    items:
      trimmed

  };

  fs.mkdirSync(
    path.dirname(
      CONFIG.outputPath
    ),
    {
      recursive: true
    }
  );

  fs.writeFileSync(
    CONFIG.temporaryOutputPath,
    JSON.stringify(
      output,
      null,
      2
    )
  );

  fs.renameSync(
    CONFIG.temporaryOutputPath,
    CONFIG.outputPath
  );

  console.log(
    `Collected ${trimmed.length} news items from ${FEEDS.length} feeds.`
  );

  console.log(
    `Saved to ${CONFIG.outputPath}`
  );

}

function logFatalError(
  error
) {

  console.error(
    "Fatal news collector error:"
  );

  console.error(
    error &&
    error.stack
      ? error.stack
      : error
  );

  process.exit(1);

}

if (
  require.main === module
) {

  main().catch(
    logFatalError
  );

}

module.exports = {

  FEEDS,

  PAIR_KEYWORDS,

  HIGH_IMPACT_WORDS,

  scoreSentiment,

  classifyImpact,

  pairsFor,

  collectFeedItems,

  deduplicateItems,

  normalizeText,

  parsePublicationDate,

  buildArticleText,

  main

};
