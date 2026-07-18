// fetch-intraday-h1.js
// Fetches 1-hour OHLC history for XAU/USD and GBP/JPY from Twelve Data and
// writes it to data/intraday-h1.json. This powers the new "Intraday" scan
// (Short-term button): H1 is the primary timeframe, H4 is derived on the
// frontend by grouping 4 consecutive H1 candles (no extra API call needed).
//
// outputsize=800 (~33 days of H1 bars) so that even after aggregating to H4
// there's enough history for a stable EMA200 read on the 4-hour chart.
//
// Run cadence: every 15 minutes.
// Cost: 2 Twelve Data credits per run = ~192 credits/day.

const fs = require("fs");
const path = require("path");

const API_KEY = process.env.TWELVEDATA_API_KEY;
if (!API_KEY) {
  console.error("Missing TWELVEDATA_API_KEY env var");
  process.exit(1);
}

const SYMBOLS = [
  { symbol: "XAU/USD", key: "XAUUSD" },
  { symbol: "GBP/JPY", key: "GBPJPY" },
];

const OUTPUT_PATH = path.join(__dirname, "data", "intraday-h1.json");

// Retries a JSON fetch up to `retries` times with increasing backoff
// (1.5s, 3s, 4.5s...) before giving up. Only fires on failure, so it does
// not add any Twelve Data credit cost on a normal successful run.
async function fetchJsonWithRetry(url, { retries = 3, retryDelayMs = 1500, timeoutMs = 15000 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      clearTimeout(timer);
      lastErr = e.name === "AbortError" ? new Error(`Timed out after ${timeoutMs}ms`) : e;
      console.warn(`  attempt ${attempt}/${retries} failed: ${lastErr.message}`);
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, retryDelayMs * attempt));
      }
    }
  }
  throw lastErr;
}

async function fetchH1(symbol) {
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=1h&outputsize=800&apikey=${API_KEY}`;
  const data = await fetchJsonWithRetry(url);

  if (data.status === "error" || !Array.isArray(data.values)) {
    throw new Error(`Twelve Data error for ${symbol}: ${data.message || JSON.stringify(data)}`);
  }

  return data.values
    .map((v) => ({
      time: v.datetime,
      open: parseFloat(v.open),
      high: parseFloat(v.high),
      low: parseFloat(v.low),
      close: parseFloat(v.close),
    }))
    .reverse();
}

async function main() {
  const out = { updatedAt: new Date().toISOString() };
  out.stale = {};

  for (const { symbol, key } of SYMBOLS) {
    try {
      out[key] = await fetchH1(symbol);
      out.stale[key] = false;
      console.log(`Fetched ${out[key].length} H1 candles for ${symbol}`);
    } catch (e) {
      console.error(`Failed to fetch ${symbol} after retries:`, e.message);
      if (fs.existsSync(OUTPUT_PATH)) {
        const prev = JSON.parse(fs.readFileSync(OUTPUT_PATH, "utf8"));
        if (prev[key]) out[key] = prev[key];
      }
      out.stale[key] = true;
    }
  }

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(out, null, 2));
  console.log("Wrote", OUTPUT_PATH);
}

main();
