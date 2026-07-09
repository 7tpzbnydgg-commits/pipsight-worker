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

async function main(){
  if(!API_KEY){
    console.error("TWELVEDATA_API_KEY secret is not set — see worker/ADD-TO-EXISTING-REPO.md");
    process.exit(1);
  }

  const res = await fetch(`https://api.twelvedata.com/price?symbol=GBP/JPY&apikey=${API_KEY}`);
  if(!res.ok) throw new Error("Twelve Data request failed (" + res.status + ")");
  const data = await res.json();
  const price = parseFloat(data && data.price);
  if(!Number.isFinite(price)) throw new Error("Unexpected response: " + JSON.stringify(data));

  const out = { price, updatedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
  console.log("Wrote live GBP/JPY tick:", out);
}

main().catch(e => { console.error(e); process.exit(1); });
