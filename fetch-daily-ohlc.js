// fetch-daily-ohlc.js
// Fetches daily OHLC (open/high/low/close) history for XAU/USD and GBP/JPY
// from Twelve Data and writes it to data/daily-ohlc.json.
//
// This is what unlocks TRUE ADX and real candle-pattern recognition in the
// strict daily/weekly engine — both need high/low data, which the existing
// close-price-only history source structurally can't provide.
//
// Run cadence: every 4 hours (a daily candle only closes once a day, so this
// doesn't need to run as often as the 5-min scalp worker).
// Cost: 2 Twelve Data credits per run = ~12 credits/day.

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

const OUTPUT_PATH = path.join(__dirname, "data", "daily-ohlc.json");

async function fetchDaily(symbol) {
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=1day&outputsize=60&apikey=${API_KEY}`;
  const res = await fetch(url);
  const data = await res.json();

  if (data.status === "error" || !Array.isArray(data.values)) {
    throw new Error(`Twelve Data error for ${symbol}: ${data.message || JSON.stringify(data)}`);
  }

  return data.values
    .map((v) => ({
      date: v.datetime,
      open: parseFloat(v.open),
      high: parseFloat(v.high),
      low: parseFloat(v.low),
      close: parseFloat(v.close),
    }))
    .reverse();
}

async function main() {
  const out = { updatedAt: new Date().toISOString() };

  for (const { symbol, key } of SYMBOLS) {
    try {
      out[key] = await fetchDaily(symbol);
      console.log(`Fetched ${out[key].length} daily candles for ${symbol}`);
    } catch (e) {
      console.error(`Failed to fetch ${symbol}:`, e.message);
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
