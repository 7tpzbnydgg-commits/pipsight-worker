// PipSight Robot — global news/data collector
// -----------------------------------------------------------------------
// Runs on a schedule via GitHub Actions (see .github/workflows/fetch-news.yml).
// No API key needed: pulls free, public RSS feeds, tags each headline to
// XAU/USD or GBP/JPY by keyword match, scores sentiment with a transparent
// keyword lexicon (not a black box), and writes data/news-feed.json.
// The PipSight front-end fetches that file directly from GitHub's raw CDN.
// -----------------------------------------------------------------------

const fs = require("fs");
const path = require("path");
const Parser = require("rss-parser");
const parser = new Parser({ timeout: 15000 });

// Free, keyless RSS sources. Add/remove freely — everything downstream
// (pair tagging, sentiment) works off the headline text, not the source.
const FEEDS = [
  { url: "https://www.forexlive.com/feed/", source: "ForexLive" },
  { url: "https://www.forexlive.com/feed/centralbank", source: "ForexLive (Central Banks)" },
  { url: "https://www.investing.com/rss/news_1.rss", source: "Investing.com" },
];

const PAIR_KEYWORDS = {
  "XAU/USD": ["gold", "xau", "bullion", "precious metal", "safe-haven", "safe haven"],
  "GBP/JPY": ["gbp", "pound sterling", "sterling", "jpy", "yen", "boj", "bank of japan", "boe", "bank of england", "cable"],
};

// Small, transparent keyword lexicon for directional tone. This is a
// heuristic, not NLP sentiment analysis — intentionally simple so the
// scoring is auditable in one glance, same spirit as the rest of the engine.
const BULLISH_WORDS = [
  "surge", "rally", "gain", "gains", "rose", "rises", "rising", "higher", "climb", "climbs",
  "jump", "jumps", "strengthen", "strengthens", "bullish", "upbeat", "recovery", "rebound",
  "soar", "soars", "advance", "advances", "buy", "buying", "support", "beat", "beats", "outperform",
];
const BEARISH_WORDS = [
  "plunge", "plunges", "slump", "slumps", "fall", "falls", "falling", "lower", "drop", "drops",
  "decline", "declines", "weaken", "weakens", "bearish", "sell-off", "selloff", "selling",
  "tumble", "tumbles", "retreat", "retreats", "slide", "slides", "miss", "misses", "underperform",
  "risk-off", "risk off",
];

// Headlines matching these are tagged impact:"high" — the kind of event
// (central bank decisions, jobs/inflation data) that can move price fast
// enough to justify blocking a trade that runs straight into it.
const HIGH_IMPACT_WORDS = [
  "fed", "fomc", "federal reserve", "rate decision", "interest rate", "rate hike", "rate cut",
  "nonfarm payrolls", "nfp", "jobs report", "unemployment rate", "cpi", "inflation report",
  "gdp", "boe", "bank of england", "boj", "bank of japan", "ecb", "european central bank",
  "powell", "central bank", "fomc minutes", "jackson hole",
];

function classifyImpact(text){
  const t = text.toLowerCase();
  return HIGH_IMPACT_WORDS.some(w => t.includes(w)) ? "high" : "normal";
}

function scoreSentiment(text){
  const t = text.toLowerCase();
  let score = 0;
  for(const w of BULLISH_WORDS) if(t.includes(w)) score += 5;
  for(const w of BEARISH_WORDS) if(t.includes(w)) score -= 5;
  return Math.max(-20, Math.min(20, score));
}

function pairsFor(text){
  const t = text.toLowerCase();
  const hits = [];
  for(const [pair, words] of Object.entries(PAIR_KEYWORDS)){
    if(words.some(w => t.includes(w))) hits.push(pair);
  }
  return hits;
}

function fmtDate(d){
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

async function main(){
  const items = [];

  for(const feed of FEEDS){
    try{
      const parsed = await parser.parseURL(feed.url);
      for(const entry of (parsed.items || [])){
        const text = (entry.title || "").trim();
        if(!text) continue;
        const pairs = pairsFor(text + " " + (entry.contentSnippet || ""));
        if(!pairs.length) continue; // not relevant to either pair we cover
        const date = entry.pubDate ? new Date(entry.pubDate) : new Date();
        const sentiment = scoreSentiment(text + " " + (entry.contentSnippet || ""));
        for(const pair of pairs){
          items.push({ pair, date: fmtDate(date), sentiment, source: feed.source, text, impact: classifyImpact(text), ts: date.getTime() });
        }
      }
    } catch(e){
      console.error("Feed failed:", feed.url, e.message);
      // Keep going — a single dead feed shouldn't blank the whole file.
    }
  }

  // Newest first, then cap per pair so the file (and the UI) stays readable.
  items.sort((a,b) => b.ts - a.ts);
  const perPairCap = 6;
  const counts = {};
  const trimmed = [];
  for(const it of items){
    counts[it.pair] = (counts[it.pair] || 0) + 1;
    if(counts[it.pair] <= perPairCap){
      const { ts, ...rest } = it;
      trimmed.push(rest);
    }
  }

  const out = {
    updatedAt: new Date().toISOString(),
    feedCount: FEEDS.length,
    items: trimmed,
  };

  const outPath = path.join(__dirname, "data", "news-feed.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`Wrote ${trimmed.length} items (${FEEDS.length} feeds polled) to ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
