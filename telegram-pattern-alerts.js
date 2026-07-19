/**
 * Telegram Pattern Detector Alerts
 * Sends AI pattern signals to Telegram
 */

const https = require('https');
const fs = require('fs');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const PATTERN_SIGNALS_URL = 'https://raw.githubusercontent.com/Detector-byte/pattern-detector-bot/main/data/pattern-signals.json';
const SENT_ALERTS_LOG = 'telegram-pattern-log.json';

function loadSentAlerts() {
  try {
    return JSON.parse(fs.readFileSync(SENT_ALERTS_LOG, 'utf8'));
  } catch (e) {
    return [];
  }
}

function saveSentAlerts(alerts) {
  fs.writeFileSync(SENT_ALERTS_LOG, JSON.stringify(alerts, null, 2));
}

function sendTelegramMessage(message) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'HTML'
    });

    const options = {
      hostname: 'api.telegram.org',
      port: 443,
      path: `/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(JSON.parse(body));
        } else {
          reject(new Error(`Telegram error: ${res.statusCode}`));
        }
      });
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function fetchPatternSignals() {
  return new Promise((resolve, reject) => {
    https.get(PATTERN_SIGNALS_URL, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(JSON.parse(body));
        } else {
          reject(new Error(`HTTP ${res.statusCode}`));
        }
      });
    }).on('error', reject);
  });
}

async function processPatternAlerts() {
  try {
    console.log('Fetching pattern signals...');
    const data = await fetchPatternSignals();

    if (!data || !data.signals || data.signals.length === 0) {
      console.log('No new patterns found');
      return;
    }

    const sentAlerts = loadSentAlerts();
    const sentIds = new Set(sentAlerts.map(a => a.id));
    let alertCount = 0;

    for (const signal of data.signals) {
      const signalId = `${signal.pair}-${signal.pattern}-${signal.timeframe}-${signal.createdAt}`;

      if (sentIds.has(signalId)) continue;

      const emoji = signal.direction === 'BUY' ? '🟢' : '🔴';
      const message = `
${emoji} <b>${signal.pair} ${signal.pattern}</b>

<b>Signal:</b> ${signal.direction}
<b>Timeframe:</b> ${signal.timeframe}
<b>Confidence:</b> ${signal.confidence}%

📍 <b>Levels:</b>
Entry: ${signal.entry.toFixed(signal.pair === 'GBPJPY' ? 3 : 2)}
Stop: ${signal.stopLoss.toFixed(signal.pair === 'GBPJPY' ? 3 : 2)}
TP1: ${signal.takeProfit1.toFixed(signal.pair === 'GBPJPY' ? 3 : 2)}

R:R = 1:${signal.riskReward.toFixed(1)}

⚠️ Not financial advice
      `;

      try {
        await sendTelegramMessage(message);
        sentAlerts.push({ id: signalId, sentAt: new Date().toISOString() });
        saveSentAlerts(sentAlerts);
        alertCount++;
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (e) {
        console.error('Failed to send:', e.message);
      }
    }

    console.log(`Sent ${alertCount} alerts`);
  } catch (error) {
    console.error('Error:', error.message);
  }
}

processPatternAlerts();
