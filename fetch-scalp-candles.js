// fetch-scalp-candles.js
// Pulls the latest 5-minute candles for XAU/USD and GBP/JPY from Twelve Data
// and writes them to data/scalp-candles.json. The frontend aggregates these
// 5-minute bars into 15-minute and 30-minute candles itself (no extra API
// calls needed), then runs a relaxed 3-of-5 signal check on each timeframe.
//
// Run cadence: every 10 minutes (same cadence as fetch-gbpjpy-live.js).
// Cost: 2 Twelve Data credits per run (one per symbol) = ~288 credits/day.

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

const OUTPUT_PATH = path.join(__dirname, "data", "scalp-candles.json");

async function fetchCandles(symbol) {
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=5min&outputsize=100&apikey=${API_KEY}`;
  const res = await fetch(url);
  const data = await res.json();

  if (data.status === "error" || !Array.isArray(data.values)) {
    throw new Error(`Twelve Data error for ${symbol}: ${data.message || JSON.stringify(data)}`);
  }

  // Twelve Data returns newest-first; flip to chronological order.
  const rows = data.values
    .map((v) => ({
      time: v.datetime,
      open: parseFloat(v.open),
      high: parseFloat(v.high),
      low: parseFloat(v.low),
      close: parseFloat(v.close),
    }))
    .reverse();

  return rows;
}

async function main() {
  const out = { updatedAt: new Date().toISOString() };

  for (const { symbol, key } of SYMBOLS) {
    try {
      out[key] = await fetchCandles(symbol);
      console.log(`Fetched ${out[key].length} 5m candles for ${symbol}`);
    } catch (e) {
      console.error(`Failed to fetch ${symbol}:`, e.message);
      // Keep previous data for this symbol rather than wiping it out.
      if (fs.existsSync(OUTPUT_PATH)) {
        const prev = JSON.parse(fs.readFileSync(OUTPUT_PATH, "utf8"));
        if (prev[key]) out[key] = prev[key];
      }
    }
  }

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(out, null, 2));
  console.log("Wrote", OUTPUT_PATH);
}

main();
