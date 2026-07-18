// PipSight Robot — live GBP/JPY tick
// -----------------------------------------------------------------------
// Fetches the live GBP/JPY price from Twelve Data using an API key that
// lives ONLY as a GitHub Actions secret (TWELVEDATA_API_KEY) — it is never
// written to any file in this repo and never sent to a browser, so it
// can't be scraped from page source the way a key embedded in client-side
// JS can be. The site reads the small JSON this writes instead of calling
// Twelve Data directly.
// -----------------------------------------------------------------------

const fs = require("fs");
const path = require("path");

const OUT_PATH = path.join(__dirname, "data", "gbpjpy-live.json");
const API_KEY = process.env.TWELVEDATA_API_KEY;

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
      if (!res.ok) throw new Error("Twelve Data request failed (" + res.status + ")");
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

async function main(){
  if(!API_KEY){
    console.error("TWELVEDATA_API_KEY secret is not set — see worker/ADD-TO-EXISTING-REPO.md");
    process.exit(1);
  }

  const data = await fetchJsonWithRetry(`https://api.twelvedata.com/price?symbol=GBP/JPY&apikey=${API_KEY}`);
  const price = parseFloat(data && data.price);
  if(!Number.isFinite(price)) throw new Error("Unexpected response: " + JSON.stringify(data));

  const out = { price, updatedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
  console.log("Wrote live GBP/JPY tick:", out);
}

// Same as before: if all retries are exhausted, this still throws and the
// process exits with code 1 — so the GitHub Action shows a clear failure
// instead of silently succeeding with no update. Kept intentionally so a
// future "workflow failed" alert can hook into this.
main().catch(e => { console.error(e); process.exit(1); });
