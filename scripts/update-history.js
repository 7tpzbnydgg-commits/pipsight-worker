const fs = require('fs');
const path = require('path');

const FILE_PATH = path.join(__dirname, '..', 'data', 'xau-usd-history.json');
const MAX_ENTRIES = 600;

// Retries a JSON fetch up to `retries` times with increasing backoff
// (1.5s, 3s, 4.5s...) before giving up. api.gold-api.com has no per-call
// credit cost, so retries here are free — they only add a few seconds of
// runtime on a bad connection, nothing else.
async function fetchJsonWithRetry(url, { retries = 3, retryDelayMs = 1500, timeoutMs = 15000 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`Gold price service returned ${res.status}`);
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

async function main() {
  const data = await fetchJsonWithRetry('https://api.gold-api.com/price/XAU/USD');
  if (typeof data.price !== 'number') {
    throw new Error('Unexpected response shape from gold price service');
  }

  let rows = [];
  if (fs.existsSync(FILE_PATH)) {
    try {
      rows = JSON.parse(fs.readFileSync(FILE_PATH, 'utf8'));
    } catch (e) {
      rows = [];
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const idx = rows.findIndex(r => r.date === today);
  if (idx >= 0) {
    rows[idx] = { date: today, close: data.price };
  } else {
    rows.push({ date: today, close: data.price });
  }

  rows.sort((a, b) => a.date.localeCompare(b.date));
  if (rows.length > MAX_ENTRIES) {
    rows = rows.slice(rows.length - MAX_ENTRIES);
  }

  fs.mkdirSync(path.dirname(FILE_PATH), { recursive: true });
  fs.writeFileSync(FILE_PATH, JSON.stringify(rows, null, 2));
  console.log(`Updated ${FILE_PATH} — ${rows.length} entries, latest: ${today} = ${data.price}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
