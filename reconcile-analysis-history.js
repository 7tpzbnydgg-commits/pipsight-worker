"use strict";

/**
 * PipSight Pro — One-Time Analysis History Reconciliation
 *
 * Purpose:
 * - Reconcile the 18 historical duplicate resolved trades proven in
 *   production analysis history, while remaining safe if that history cleanup
 *   has already been applied.
 * - Remove the one proven stale learned duplicate that survived in
 *   data/learning-data.json after upstream history reconciliation.
 * - Leave statistics/confidence regeneration to the existing
 *   run-learning-engine.js + learner.js production path.
 *
 * Safety:
 * - Dry-run by default. Use --apply to write.
 * - Fails closed on unexpected schema, alias divergence, changed audited IDs,
 *   unknown duplicate setup identities, or unknown learned semantic duplicates.
 * - Creates backups before atomic writes.
 * - Never hand-calculates learning stats, confidence, AI Memory or AI Policy.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const HISTORY_PATH = process.env.ANALYSIS_HISTORY_PATH
  ? path.resolve(process.env.ANALYSIS_HISTORY_PATH)
  : path.resolve(process.cwd(), "data", "analysis-history.json");

const LEARNING_PATH = process.env.LEARNING_DATA_PATH
  ? path.resolve(process.env.LEARNING_DATA_PATH)
  : path.resolve(process.cwd(), "data", "learning-data.json");

const APPLY = process.argv.includes("--apply");

const LEARNING_RETAIN = {
  historyRecordId: "1786134008728-GBPJPY-scalp",
  sourceTradeKey: "77c3ae76d2e32c69940b23293c025946897ff5db201241ab11337a5350419f93",
  pair: "GBPJPY",
  strategy: "scalp",
  timeframe: "5m",
  direction: "BUY",
  openedAt: "2026-08-07T20:15:00.000Z",
  entry: 212.862,
  stopLoss: 212.786,
  takeProfit: 213.014,
  outcome: "LOSS"
};

const LEARNING_REMOVE = {
  historyRecordId: "1786134071287-GBPJPY-scalp",
  sourceTradeKey: "cd247a976f73cc548f937ed1b5ca390bf87ecfaa3ca7093ec52bf0552855265b",
  pair: "GBPJPY",
  strategy: "scalp",
  timeframe: "5m",
  direction: "BUY",
  openedAt: "2026-08-07T20:15:00.000Z",
  entry: 212.865,
  stopLoss: 212.788,
  takeProfit: 213.019,
  outcome: "LOSS"
};

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

function validateHistoryReconciliationStatus(history) {
  const expectedKeys = new Set(
    EXPECTED_DUPLICATES.map(
      (item) => item.setupIdentity
    )
  );

  const actualGroups =
    collectDuplicateSetupGroups(
      history.closed
    );

  const indexes =
    Object.fromEntries(
      ARRAY_FIELDS.map(
        (field) => [
          field,
          indexById(
            history[field]
          )
        ]
      )
    );

  if (actualGroups.size === 0) {
    for (const expected of EXPECTED_DUPLICATES) {
      for (const field of ARRAY_FIELDS) {
        const retainMatches =
          indexes[field].get(
            expected.retainId
          ) || [];

        const removeMatches =
          indexes[field].get(
            expected.removeId
          ) || [];

        if (
          retainMatches.length !== 1 ||
          removeMatches.length !== 0
        ) {
          fail(
            `History is neither in the audited pre-reconciliation state nor the audited reconciled state for ${expected.setupIdentity}.`
          );
        }

        if (
          retainMatches[0].setupIdentity !==
          expected.setupIdentity
        ) {
          fail(
            `Retained setupIdentity changed for ${expected.retainId} in ${field}.`
          );
        }
      }
    }

    return {
      status:
        "ALREADY_RECONCILED",
      duplicateGroups: 0
    };
  }

  if (
    actualGroups.size !==
    EXPECTED_DUPLICATES.length
  ) {
    fail(
      `Expected either 0 or exactly ${EXPECTED_DUPLICATES.length} audited duplicate setupIdentity groups, ` +
      `but found ${actualGroups.size}. No changes were written.`
    );
  }

  for (const key of actualGroups.keys()) {
    if (!expectedKeys.has(key)) {
      fail(
        `Unknown duplicate setupIdentity detected: ${key}. No changes were written.`
      );
    }
  }

  for (const expected of EXPECTED_DUPLICATES) {
    const group =
      actualGroups.get(
        expected.setupIdentity
      );

    if (
      !group ||
      group.length !== 2
    ) {
      fail(
        `Expected exactly 2 closed records for ${expected.setupIdentity}.`
      );
    }

    const ids =
      group.map(
        (record) => record.id
      );

    if (
      ids[0] !== expected.retainId ||
      ids[1] !== expected.removeId
    ) {
      fail(
        `Representative ordering changed for ${expected.setupIdentity}. ` +
        `Expected [${expected.retainId}, ${expected.removeId}], got [${ids.join(", ")}].`
      );
    }

    for (const field of ARRAY_FIELDS) {
      const retainMatches =
        indexes[field].get(
          expected.retainId
        ) || [];

      const removeMatches =
        indexes[field].get(
          expected.removeId
        ) || [];

      if (
        retainMatches.length !== 1 ||
        removeMatches.length !== 1
      ) {
        fail(
          `Expected one retain and one remove record in ${field} for ${expected.setupIdentity}.`
        );
      }

      if (
        retainMatches[0].setupIdentity !==
          expected.setupIdentity ||
        removeMatches[0].setupIdentity !==
          expected.setupIdentity
      ) {
        fail(
          `setupIdentity changed for expected records in ${field}.`
        );
      }
    }
  }

  return {
    status:
      "NEEDS_RECONCILIATION",
    duplicateGroups:
      actualGroups.size
  };
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


function readLearning(filePath) {
  if (!fs.existsSync(filePath)) {
    fail(
      `Missing learning file: ${filePath}`
    );
  }

  const raw =
    fs.readFileSync(
      filePath
    );

  if (raw.length === 0) {
    fail(
      `Learning file is empty: ${filePath}`
    );
  }

  let document;

  try {
    document =
      JSON.parse(
        raw.toString("utf8")
      );
  } catch (error) {
    fail(
      `Learning JSON is invalid: ${error.message}`
    );
  }

  if (
    document === null ||
    typeof document !== "object" ||
    Array.isArray(document)
  ) {
    fail(
      "Learning root must be a JSON object."
    );
  }

  if (
    document.learning === null ||
    typeof document.learning !== "object" ||
    Array.isArray(document.learning) ||
    !Array.isArray(
      document.learning.signals
    )
  ) {
    fail(
      "learning-data.json must contain learning.signals as an array."
    );
  }

  return {
    document,
    raw
  };
}

function learningRecordMatches(
  record,
  expected
) {
  return Boolean(
    record &&
    record.historyRecordId ===
      expected.historyRecordId &&
    record.sourceTradeKey ===
      expected.sourceTradeKey &&
    record.pair ===
      expected.pair &&
    record.strategy ===
      expected.strategy &&
    record.timeframe ===
      expected.timeframe &&
    record.direction ===
      expected.direction &&
    record.openedAt ===
      expected.openedAt &&
    record.entry ===
      expected.entry &&
    record.stopLoss ===
      expected.stopLoss &&
    record.takeProfit ===
      expected.takeProfit &&
    record.outcome ===
      expected.outcome
  );
}

function createLearningSemanticKey(
  record
) {
  const values = [
    record?.pair,
    record?.strategy,
    record?.timeframe,
    record?.direction,
    record?.openedAt
  ];

  if (
    values.some(
      (value) =>
        typeof value !== "string" ||
        !value.trim()
    )
  ) {
    return null;
  }

  return values.join("|");
}

function collectLearningSemanticDuplicates(
  records
) {
  const groups =
    new Map();

  for (const record of records) {
    const key =
      createLearningSemanticKey(
        record
      );

    if (!key) {
      continue;
    }

    if (!groups.has(key)) {
      groups.set(
        key,
        []
      );
    }

    groups.get(key).push(
      record
    );
  }

  return new Map(
    [...groups.entries()].filter(
      ([, group]) =>
        group.length > 1
    )
  );
}

function reconcileLearningDocument(
  document
) {
  const result =
    structuredClone(
      document
    );

  const signals =
    result.learning.signals;

  const retainMatches =
    signals.filter(
      (record) =>
        record?.historyRecordId ===
        LEARNING_RETAIN.historyRecordId
    );

  const removeMatches =
    signals.filter(
      (record) =>
        record?.historyRecordId ===
        LEARNING_REMOVE.historyRecordId
    );

  if (
    retainMatches.length !== 1 ||
    !learningRecordMatches(
      retainMatches[0],
      LEARNING_RETAIN
    )
  ) {
    fail(
      "The audited retained learned trade is missing or changed."
    );
  }

  if (removeMatches.length > 1) {
    fail(
      "The audited stale learned duplicate appears more than once."
    );
  }

  if (
    removeMatches.length === 1 &&
    !learningRecordMatches(
      removeMatches[0],
      LEARNING_REMOVE
    )
  ) {
    fail(
      "The audited stale learned duplicate changed and cannot be removed safely."
    );
  }

  const beforeDuplicates =
    collectLearningSemanticDuplicates(
      signals
    );

  if (removeMatches.length === 1) {
    if (
      beforeDuplicates.size !== 1
    ) {
      fail(
        `Expected exactly 1 learned semantic duplicate group before cleanup, found ${beforeDuplicates.size}.`
      );
    }

    const expectedKey =
      createLearningSemanticKey(
        LEARNING_RETAIN
      );

    if (
      !beforeDuplicates.has(
        expectedKey
      )
    ) {
      fail(
        "The only learned semantic duplicate is not the audited GBPJPY Scalp setup."
      );
    }

    result.learning.signals =
      signals.filter(
        (record) =>
          record?.historyRecordId !==
          LEARNING_REMOVE.historyRecordId
      );
  } else if (
    beforeDuplicates.size !== 0
  ) {
    fail(
      `Stale learned duplicate is already absent, but ${beforeDuplicates.size} unknown semantic duplicate group(s) remain.`
    );
  }

  const afterDuplicates =
    collectLearningSemanticDuplicates(
      result.learning.signals
    );

  if (afterDuplicates.size !== 0) {
    fail(
      `Learning reconciliation left ${afterDuplicates.size} semantic duplicate group(s).`
    );
  }

  return {
    document:
      result,
    removed:
      removeMatches.length,
    beforeCount:
      signals.length,
    afterCount:
      result.learning.signals.length
  };
}

function writeAtomicWithBackup(
  filePath,
  outputText,
  originalRaw,
  backupName
) {
  const directory =
    path.dirname(
      filePath
    );

  const tempPath =
    path.join(
      directory,
      `.${backupName}.${process.pid}.${Date.now()}.tmp`
    );

  const backupDirectory =
    process.env.RUNNER_TEMP
      ? path.resolve(
          process.env.RUNNER_TEMP
        )
      : directory;

  const backupPath =
    path.join(
      backupDirectory,
      `${backupName}.${Date.now()}.json`
    );

  fs.writeFileSync(
    backupPath,
    originalRaw
  );

  fs.writeFileSync(
    tempPath,
    outputText,
    "utf8"
  );

  JSON.parse(
    fs.readFileSync(
      tempPath,
      "utf8"
    )
  );

  fs.renameSync(
    tempPath,
    filePath
  );

  return backupPath;
}

function writeAtomic(
  filePath,
  outputText,
  originalRaw
) {
  return writeAtomicWithBackup(
    filePath,
    outputText,
    originalRaw,
    "analysis-history.before-reconciliation"
  );
}

function main() {
  const {
    history,
    raw:
      historyRaw
  } =
    readHistory(
      HISTORY_PATH
    );

  const historySourceHash =
    sha256Buffer(
      historyRaw
    );

  const historyStatus =
    validateHistoryReconciliationStatus(
      history
    );

  const reconciledHistory =
    historyStatus.status ===
      "NEEDS_RECONCILIATION"
      ? reconcile(
          history
        )
      : structuredClone(
          history
        );

  const historyOutputText =
    JSON.stringify(
      reconciledHistory,
      null,
      2
    );

  const historyOutputHash =
    sha256Buffer(
      Buffer.from(
        historyOutputText,
        "utf8"
      )
    );

  const {
    document:
      learningDocument,
    raw:
      learningRaw
  } =
    readLearning(
      LEARNING_PATH
    );

  const learningSourceHash =
    sha256Buffer(
      learningRaw
    );

  const learningResult =
    reconcileLearningDocument(
      learningDocument
    );

  const learningOutputText =
    JSON.stringify(
      learningResult.document,
      null,
      2
    ) + "\n";

  const learningOutputHash =
    sha256Buffer(
      Buffer.from(
        learningOutputText,
        "utf8"
      )
    );

  console.log(
    "PipSight Pro one-time adaptive reconciliation validation passed."
  );

  console.log(
    `Mode: ${APPLY ? "APPLY" : "DRY-RUN"}`
  );

  console.log(
    `History status: ${historyStatus.status}`
  );

  console.log(
    `History SHA-256: ${historySourceHash} -> ${historyOutputHash}`
  );

  console.log(
    `History duplicate setupIdentity groups: ${historyStatus.duplicateGroups} -> 0`
  );

  console.log(
    `History closed records: ${history.closed.length} -> ${reconciledHistory.closed.length}`
  );

  console.log(
    `Learning SHA-256: ${learningSourceHash} -> ${learningOutputHash}`
  );

  console.log(
    `Learning stale duplicate records removed: ${learningResult.removed}`
  );

  console.log(
    `Learning signals: ${learningResult.beforeCount} -> ${learningResult.afterCount}`
  );

  if (!APPLY) {
    console.log(
      "Dry-run only. No file was changed."
    );

    console.log(
      "The workflow must run this script again with --apply, then run the existing learning engine to regenerate stats/confidence/downstream outputs."
    );

    return;
  }

  if (
    historyStatus.status ===
    "NEEDS_RECONCILIATION"
  ) {
    const historyBackup =
      writeAtomic(
        HISTORY_PATH,
        historyOutputText,
        historyRaw
      );

    const writtenHistoryHash =
      sha256Buffer(
        fs.readFileSync(
          HISTORY_PATH
        )
      );

    if (
      writtenHistoryHash !==
      historyOutputHash
    ) {
      fail(
        "Post-write analysis-history SHA-256 verification failed."
      );
    }

    console.log(
      `History backup created: ${historyBackup}`
    );
  } else {
    console.log(
      "History was already reconciled; analysis-history.json was not rewritten."
    );
  }

  if (learningResult.removed === 1) {
    const learningBackup =
      writeAtomicWithBackup(
        LEARNING_PATH,
        learningOutputText,
        learningRaw,
        "learning-data.before-reconciliation"
      );

    const writtenLearningHash =
      sha256Buffer(
        fs.readFileSync(
          LEARNING_PATH
        )
      );

    if (
      writtenLearningHash !==
      learningOutputHash
    ) {
      fail(
        "Post-write learning-data SHA-256 verification failed."
      );
    }

    console.log(
      `Learning backup created: ${learningBackup}`
    );
  } else {
    console.log(
      "Learning stale duplicate was already absent; learning-data.json was not rewritten."
    );
  }

  console.log(
    "Targeted reconciliation applied successfully. Derived learning stats/confidence must now be regenerated by run-learning-engine.js."
  );
}

try {
  main();
} catch (error) {
  console.error(`::error::${error.message}`);
  process.exitCode = 1;
}
