"use strict";

/**
 * PipSight Pro — One-Time Analysis History Reconciliation
 *
 * Purpose:
 * - Remove only the 18 historical duplicate resolved trades proven in the
 *   production analysis-history snapshot audited on 2026-08-08.
 * - Preserve the earliest representative for each canonical setupIdentity.
 * - Preserve all unrelated and newly appended records.
 * - Keep records/history/items synchronized and refresh aggregate closed stats.
 *
 * Safety:
 * - Dry-run by default. Use --apply to write.
 * - Fails closed on unexpected schema, alias divergence, missing expected IDs,
 *   changed setup identities, or any additional unknown duplicate setupIdentity.
 * - Creates a backup before the atomic write.
 * - Does not edit learning/confidence/memory/policy files.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const HISTORY_PATH = process.env.ANALYSIS_HISTORY_PATH
  ? path.resolve(process.env.ANALYSIS_HISTORY_PATH)
  : path.resolve(process.cwd(), "data", "analysis-history.json");

const APPLY = process.argv.includes("--apply");

const EXPECTED_DUPLICATES = [
  {
    "setupIdentity": "setup-v1|XAUUSD|intraday|1H|BUY|2026-08-06T08:00:00.000Z",
    "retainId": "1786007445747-XAUUSD-intraday",
    "removeId": "1786009550068-XAUUSD-intraday"
  },
  {
    "setupIdentity": "setup-v1|XAUUSD|intraday|1H|BUY|2026-08-06T09:00:00.000Z",
    "retainId": "1786011046851-XAUUSD-intraday",
    "removeId": "1786012846910-XAUUSD-intraday"
  },
  {
    "setupIdentity": "setup-v1|XAUUSD|intraday|1H|BUY|2026-08-06T10:00:00.000Z",
    "retainId": "1786014643733-XAUUSD-intraday",
    "removeId": "1786016444709-XAUUSD-intraday"
  },
  {
    "setupIdentity": "setup-v1|XAUUSD|intraday|1H|BUY|2026-08-06T13:00:00.000Z",
    "retainId": "1786025457980-XAUUSD-intraday",
    "removeId": "1786027546329-XAUUSD-intraday"
  },
  {
    "setupIdentity": "setup-v1|XAUUSD|intraday|1H|BUY|2026-08-06T14:00:00.000Z",
    "retainId": "1786029048699-XAUUSD-intraday",
    "removeId": "1786057997043-XAUUSD-intraday"
  },
  {
    "setupIdentity": "setup-v1|XAUUSD|intraday|1H|BUY|2026-08-06T23:00:00.000Z",
    "retainId": "1786061447513-XAUUSD-intraday",
    "removeId": "1786063248201-XAUUSD-intraday"
  },
  {
    "setupIdentity": "setup-v1|XAUUSD|intraday|1H|BUY|2026-08-06T05:00:00.000Z",
    "retainId": "1785996945929-XAUUSD-intraday",
    "removeId": "1785999651870-XAUUSD-intraday"
  },
  {
    "setupIdentity": "setup-v1|XAUUSD|intraday|1H|BUY|2026-08-06T06:00:00.000Z",
    "retainId": "1786000544120-XAUUSD-intraday",
    "removeId": "1786002346355-XAUUSD-intraday"
  },
  {
    "setupIdentity": "setup-v1|XAUUSD|intraday|1H|BUY|2026-08-06T07:00:00.000Z",
    "retainId": "1786003339876-XAUUSD-intraday",
    "removeId": "1786005641581-XAUUSD-intraday"
  },
  {
    "setupIdentity": "setup-v1|XAUUSD|intraday|1H|BUY|2026-08-06T11:00:00.000Z",
    "retainId": "1786018243679-XAUUSD-intraday",
    "removeId": "1786020046979-XAUUSD-intraday"
  },
  {
    "setupIdentity": "setup-v1|XAUUSD|intraday|1H|BUY|2026-08-07T04:00:00.000Z",
    "retainId": "1786079446721-XAUUSD-intraday",
    "removeId": "1786081248814-XAUUSD-intraday"
  },
  {
    "setupIdentity": "setup-v1|XAUUSD|intraday|1H|BUY|2026-08-07T05:00:00.000Z",
    "retainId": "1786083054560-XAUUSD-intraday",
    "removeId": "1786085145207-XAUUSD-intraday"
  },
  {
    "setupIdentity": "setup-v1|XAUUSD|intraday|1H|BUY|2026-08-07T08:00:00.000Z",
    "retainId": "1786093934061-XAUUSD-intraday",
    "removeId": "1786095947366-XAUUSD-intraday"
  },
  {
    "setupIdentity": "setup-v1|GBPJPY|intraday|1H|SELL|2026-08-07T08:00:00.000Z",
    "retainId": "1786093934062-GBPJPY-intraday",
    "removeId": "1786095947368-GBPJPY-intraday"
  },
  {
    "setupIdentity": "setup-v1|GBPJPY|intraday|1H|SELL|2026-08-07T09:00:00.000Z",
    "retainId": "1786097453432-GBPJPY-intraday",
    "removeId": "1786099541791-GBPJPY-intraday"
  },
  {
    "setupIdentity": "setup-v1|GBPJPY|intraday|1H|SELL|2026-08-07T10:00:00.000Z",
    "retainId": "1786101052412-GBPJPY-intraday",
    "removeId": "1786102853139-GBPJPY-intraday"
  },
  {
    "setupIdentity": "setup-v1|GBPJPY|intraday|1H|SELL|2026-08-07T12:00:00.000Z",
    "retainId": "1786108249918-GBPJPY-intraday",
    "removeId": "1786110063138-GBPJPY-intraday"
  },
  {
    "setupIdentity": "setup-v1|GBPJPY|scalp|5m|BUY|2026-08-07T20:15:00.000Z",
    "retainId": "1786134008728-GBPJPY-scalp",
    "removeId": "1786134071287-GBPJPY-scalp"
  }
];

const ARRAY_FIELDS = ["closed", "records", "history", "items"];

function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function fail(message) {
  throw new Error(`[reconciliation] ${message}`);
}

function readHistory(filePath) {
  if (!fs.existsSync(filePath)) {
    fail(`Missing history file: ${filePath}`);
  }

  const raw = fs.readFileSync(filePath);
  if (raw.length === 0) {
    fail(`History file is empty: ${filePath}`);
  }

  let history;
  try {
    history = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    fail(`History JSON is invalid: ${error.message}`);
  }

  if (history === null || typeof history !== "object" || Array.isArray(history)) {
    fail("History root must be a JSON object.");
  }

  for (const field of ARRAY_FIELDS) {
    if (!Array.isArray(history[field])) {
      fail(`History field ${field} must be an array.`);
    }
  }

  if (
    JSON.stringify(history.records) !== JSON.stringify(history.history) ||
    JSON.stringify(history.records) !== JSON.stringify(history.items)
  ) {
    fail("records/history/items aliases are not synchronized before reconciliation.");
  }

  if (history.stats === null || typeof history.stats !== "object" || Array.isArray(history.stats)) {
    fail("History stats must be an object.");
  }

  return { history, raw };
}

function indexById(records) {
  const index = new Map();
  for (const record of records) {
    const id = typeof record?.id === "string" ? record.id : null;
    if (!id) continue;
    if (!index.has(id)) index.set(id, []);
    index.get(id).push(record);
  }
  return index;
}

function collectDuplicateSetupGroups(records) {
  const groups = new Map();

  for (const record of records) {
    const key = typeof record?.setupIdentity === "string"
      ? record.setupIdentity.trim()
      : "";

    if (!key) continue;

    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }

  return new Map(
    [...groups.entries()].filter(([, recordsForKey]) => recordsForKey.length > 1)
  );
}

function validateExpectedDuplicates(history) {
  const expectedKeys = new Set(EXPECTED_DUPLICATES.map((item) => item.setupIdentity));
  const actualGroups = collectDuplicateSetupGroups(history.closed);

  if (actualGroups.size !== EXPECTED_DUPLICATES.length) {
    fail(
      `Expected exactly ${EXPECTED_DUPLICATES.length} duplicate setupIdentity groups, ` +
      `but found ${actualGroups.size}. No changes were written.`
    );
  }

  for (const key of actualGroups.keys()) {
    if (!expectedKeys.has(key)) {
      fail(`Unknown duplicate setupIdentity detected: ${key}. No changes were written.`);
    }
  }

  const indexes = Object.fromEntries(
    ARRAY_FIELDS.map((field) => [field, indexById(history[field])])
  );

  for (const expected of EXPECTED_DUPLICATES) {
    const group = actualGroups.get(expected.setupIdentity);

    if (!group || group.length !== 2) {
      fail(`Expected exactly 2 closed records for ${expected.setupIdentity}.`);
    }

    const ids = group.map((record) => record.id);
    if (ids[0] !== expected.retainId || ids[1] !== expected.removeId) {
      fail(
        `Representative ordering changed for ${expected.setupIdentity}. ` +
        `Expected [${expected.retainId}, ${expected.removeId}], got [${ids.join(", ")}].`
      );
    }

    for (const field of ARRAY_FIELDS) {
      const retainMatches = indexes[field].get(expected.retainId) || [];
      const removeMatches = indexes[field].get(expected.removeId) || [];

      if (retainMatches.length !== 1 || removeMatches.length !== 1) {
        fail(
          `Expected one retain and one remove record in ${field} for ` +
          `${expected.setupIdentity}.`
        );
      }

      if (
        retainMatches[0].setupIdentity !== expected.setupIdentity ||
        removeMatches[0].setupIdentity !== expected.setupIdentity
      ) {
        fail(`setupIdentity changed for expected records in ${field}.`);
      }
    }
  }
}

function getClosedStats(records) {
  let wins = 0;
  let losses = 0;
  let breakevens = 0;

  for (const record of records) {
    if (record?.outcome === "WIN") wins += 1;
    else if (record?.outcome === "LOSS") losses += 1;
    else if (record?.outcome === "BREAK_EVEN" || record?.outcome === "BREAKEVEN") {
      breakevens += 1;
    }
  }

  const totalClosed = records.length;
  const winRate = totalClosed > 0
    ? Number(((wins / totalClosed) * 100).toFixed(2))
    : 0;

  return { totalClosed, wins, losses, winRate, breakevens };
}

function updateStats(history) {
  const groups = {
    overall: history.closed,
    scalp: history.closed.filter((record) =>
      typeof record?.engine === "string" && record.engine.startsWith("scalp")
    ),
    intraday: history.closed.filter((record) => record?.engine === "intraday"),
    swing: history.closed.filter((record) => record?.engine === "swing")
  };

  for (const [name, records] of Object.entries(groups)) {
    const previous = history.stats?.[name];
    if (previous === null || typeof previous !== "object" || Array.isArray(previous)) {
      fail(`Missing stats.${name} object.`);
    }

    history.stats[name] = {
      ...previous,
      ...getClosedStats(records),
      openCount: previous.openCount
    };
  }
}

function reconcile(history) {
  const removeIds = new Set(EXPECTED_DUPLICATES.map((item) => item.removeId));
  const result = structuredClone(history);

  for (const field of ARRAY_FIELDS) {
    result[field] = result[field].filter((record) => !removeIds.has(record?.id));
  }

  result.count = result.records.length;
  updateStats(result);

  if (
    JSON.stringify(result.records) !== JSON.stringify(result.history) ||
    JSON.stringify(result.records) !== JSON.stringify(result.items)
  ) {
    fail("records/history/items aliases diverged during reconciliation.");
  }

  const remainingDuplicates = collectDuplicateSetupGroups(result.closed);
  if (remainingDuplicates.size !== 0) {
    fail(`Reconciliation left ${remainingDuplicates.size} duplicate setupIdentity group(s).`);
  }

  const expectedClosedCount = history.closed.length - EXPECTED_DUPLICATES.length;
  const expectedRichCount = history.records.length - EXPECTED_DUPLICATES.length;

  if (result.closed.length !== expectedClosedCount) {
    fail(`Closed count mismatch after reconciliation: expected ${expectedClosedCount}, got ${result.closed.length}.`);
  }

  if (
    result.records.length !== expectedRichCount ||
    result.history.length !== expectedRichCount ||
    result.items.length !== expectedRichCount ||
    result.count !== expectedRichCount
  ) {
    fail(`Rich-record count mismatch after reconciliation; expected ${expectedRichCount}.`);
  }

  return result;
}

function writeAtomic(filePath, outputText, originalRaw) {
  const directory = path.dirname(filePath);
  const tempPath = path.join(
    directory,
    `.analysis-history.reconcile.${process.pid}.tmp`
  );

  const backupDirectory = process.env.RUNNER_TEMP
    ? path.resolve(process.env.RUNNER_TEMP)
    : directory;

  const backupPath = path.join(
    backupDirectory,
    `analysis-history.before-reconciliation.${Date.now()}.json`
  );

  fs.writeFileSync(backupPath, originalRaw);
  fs.writeFileSync(tempPath, outputText, "utf8");

  // Parse the exact bytes that will be promoted before replacing production history.
  JSON.parse(fs.readFileSync(tempPath, "utf8"));
  fs.renameSync(tempPath, filePath);

  return backupPath;
}

function main() {
  const { history, raw } = readHistory(HISTORY_PATH);
  const sourceHash = sha256Buffer(raw);

  validateExpectedDuplicates(history);
  const reconciled = reconcile(history);

  // Match the repository's current pretty-printed JSON style and preserve no trailing newline.
  const outputText = JSON.stringify(reconciled, null, 2);
  const outputHash = sha256Buffer(Buffer.from(outputText, "utf8"));

  console.log("PipSight Pro analysis-history reconciliation validation passed.");
  console.log(`History: ${HISTORY_PATH}`);
  console.log(`Mode: ${APPLY ? "APPLY" : "DRY-RUN"}`);
  console.log(`Source SHA-256: ${sourceHash}`);
  console.log(`Duplicate setupIdentity groups: ${EXPECTED_DUPLICATES.length} -> 0`);
  console.log(`Closed records: ${history.closed.length} -> ${reconciled.closed.length}`);
  console.log(`Rich records: ${history.records.length} -> ${reconciled.records.length}`);
  console.log(`Output SHA-256: ${outputHash}`);

  if (!APPLY) {
    console.log("Dry-run only. No file was changed.");
    console.log("Run again with --apply to write the validated reconciliation.");
    return;
  }

  const backupPath = writeAtomic(HISTORY_PATH, outputText, raw);
  const writtenHash = sha256Buffer(fs.readFileSync(HISTORY_PATH));

  if (writtenHash !== outputHash) {
    fail("Post-write SHA-256 verification failed.");
  }

  console.log(`Backup created: ${backupPath}`);
  console.log("Reconciliation applied successfully.");
}

try {
  main();
} catch (error) {
  console.error(`::error::${error.message}`);
  process.exitCode = 1;
}
