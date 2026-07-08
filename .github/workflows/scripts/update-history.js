const fs = require('fs');
const path = require('path');

const FILE_PATH = path.join(__dirname, '..', 'data', 'xau-usd-history.json');
const MAX_ENTRIES = 600;

async function main() {
  const res = await fetch('https://api.gold-api.com/price/XAU/USD');
  if (!res.ok) {
    throw new Error(`Gold price service returned ${res.status}`);
  }
  const data = await res.json();
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
