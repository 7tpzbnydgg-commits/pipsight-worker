// manage-analysis-history.js
//
// PipSight Pro — reusable analysis-history maintenance.
//
// Purpose:
// - Keep data/analysis-history.json safely below the configured active target.
// - Preserve open state and verified closed learning history byte-semantically.
// - Move only proven-resolved rich records into immutable gzip archive shards.
// - Preserve records/history/items alias synchronization.
// - Fail closed when a resolved rich record cannot be tied deterministically
//   to an existing verified closed record.
//
// Usage:
//   node manage-analysis-history.js          # dry run
//   node manage-analysis-history.js --apply  # apply verified maintenance

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");

const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, "data");
const HISTORY_PATH = path.join(DATA_DIR, "analysis-history.json");
const ARCHIVE_ROOT = path.join(DATA_DIR, "history-archive");
const ARCHIVE_DIR = path.join(ARCHIVE_ROOT, "rich");
const MANIFEST_PATH = path.join(ARCHIVE_ROOT, "manifest.json");

const ARCHIVE_VERSION = 1;
const TARGET_MIB = 20;
const TARGET_BYTES = TARGET_MIB * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 90 * 1024 * 1024;

const APPLY_CONFIRMATION_ENV =
  "PIPSIGHT_HISTORY_MAINTENANCE_CONFIRM";

const APPLY_CONFIRMATION_TOKEN =
  "MAINTAIN_ANALYSIS_HISTORY";

const RESOLVED_STATUSES = new Set([
  "closed",
  "resolved",
  "complete",
  "completed"
]);

const SUPPORTED_OUTCOMES = new Set([
  "WIN",
  "LOSS",
  "BREAKEVEN"
]);

function isPlainObject(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function sha256(value) {
  return crypto
    .createHash("sha256")
    .update(value)
    .digest("hex");
}

function semanticHash(value) {
  return sha256(
    Buffer.from(
      JSON.stringify(value),
      "utf8"
    )
  );
}

function prettyBuffer(value) {
  return Buffer.from(
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8"
  );
}

function sizeMiB(bytes) {
  return Number(
    (bytes / 1024 / 1024).toFixed(2)
  );
}

function firstString(...values) {
  for (const value of values) {
    if (
      typeof value === "string" &&
      value.trim()
    ) {
      return value.trim();
    }
  }

  return null;
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    if (
      value === null ||
      value === undefined ||
      value === ""
    ) {
      continue;
    }

    const number = Number(value);

    if (Number.isFinite(number)) {
      return number;
    }
  }

  return null;
}

function normalizePair(value) {
  const compact = String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

  if (compact === "XAUUSD") return "XAUUSD";
  if (compact === "GBPJPY") return "GBPJPY";
  return compact;
}

function normalizeEngine(record) {
  const raw = firstString(
    record?.engine,
    record?.engineName,
    record?.mode,
    record?.strategy,
    record?.snapshot?.engine,
    record?.snapshot?.mode
  );

  if (!raw) return "";

  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "");

  if (
    normalized === "intraday" ||
    normalized === "daily"
  ) {
    return "intraday";
  }

  if (
    normalized === "swing" ||
    normalized === "weekly"
  ) {
    return "swing";
  }

  if (
    normalized === "scalp" ||
    normalized.startsWith("scalp-")
  ) {
    return "scalp";
  }

  return normalized;
}

function normalizeDirection(record) {
  const raw = firstString(
    record?.direction,
    record?.decision,
    record?.signal,
    record?.action,
    record?.snapshot?.direction,
    record?.snapshot?.decision,
    record?.snapshot?.signal
  );

  if (!raw) return "";

  const direction = raw.toUpperCase();

  return direction === "BUY" || direction === "SELL"
    ? direction
    : "";
}

function normalizeOutcome(record) {
  const raw = firstString(
    record?.outcome,
    record?.result,
    record?.resolution?.outcome
  );

  if (!raw) return "";

  const normalized = raw
    .toUpperCase()
    .replace(/[_\s-]/g, "");

  if (normalized === "BREAKEVEN") {
    return "BREAKEVEN";
  }

  return SUPPORTED_OUTCOMES.has(normalized)
    ? normalized
    : "";
}

function normalizeStatus(record) {
  const status = firstString(record?.status);
  return status ? status.toLowerCase() : "";
}

function normalizeIdentityNumber(value) {
  const number = firstFiniteNumber(value);

  if (number === null) return "";

  return Number(
    number.toFixed(10)
  ).toString();
}

function toIso(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return "";
  }

  let timestamp = null;

  if (
    typeof value === "number" &&
    Number.isFinite(value)
  ) {
    timestamp = value;
  } else if (
    typeof value === "string" &&
    /^\d{10,13}$/.test(value.trim())
  ) {
    timestamp = Number(value.trim());
  } else {
    const parsed = Date.parse(String(value));
    timestamp = Number.isNaN(parsed) ? null : parsed;
  }

  if (!Number.isFinite(timestamp)) return "";

  try {
    return new Date(timestamp).toISOString();
  } catch {
    return "";
  }
}

function openedAtOf(record) {
  for (const value of [
    record?.openedAt,
    record?.signalTime,
    record?.signalTimestamp,
    record?.analyzedCandleAt,
    record?.snapshot?.analyzedCandleAt,
    record?.snapshot?.signalTime,
    record?.snapshot?.signalTimestamp,
    record?.createdAt,
    record?.recordedAt
  ]) {
    const iso = toIso(value);
    if (iso) return iso;
  }

  return "";
}

function closedAtOf(record) {
  for (const value of [
    record?.closedAt,
    record?.resolvedAt,
    record?.resolution?.resolvedAt,
    record?.updatedAt
  ]) {
    const iso = toIso(value);
    if (iso) return iso;
  }

  return "";
}

function fingerprintOf(record) {
  return firstString(
    record?.fingerprint,
    record?.snapshot?.fingerprint
  ) || "";
}

function setupIdentityOf(record) {
  return firstString(
    record?.setupIdentity,
    record?.snapshot?.setupIdentity
  ) || "";
}

function coreIdentityOf(record) {
  return {
    pair: normalizePair(
      record?.pair ??
      record?.symbol ??
      record?.pairLabel ??
      record?.snapshot?.pair ??
      record?.snapshot?.symbol
    ),
    engine: normalizeEngine(record),
    direction: normalizeDirection(record),
    outcome: normalizeOutcome(record)
  };
}

function coreCompatible(left, right) {
  const a = coreIdentityOf(left);
  const b = coreIdentityOf(right);

  for (const key of [
    "pair",
    "engine",
    "direction",
    "outcome"
  ]) {
    if (
      a[key] &&
      b[key] &&
      a[key] !== b[key]
    ) {
      return false;
    }
  }

  return Boolean(
    a.pair &&
    a.engine &&
    a.direction &&
    a.outcome &&
    b.pair &&
    b.engine &&
    b.direction &&
    b.outcome
  );
}

function buildCompositeClosedKey(record) {
  const entry = normalizeIdentityNumber(
    firstFiniteNumber(
      record?.entry,
      record?.entryPrice,
      record?.tradePlan?.entry,
      record?.snapshot?.entry,
      record?.snapshot?.entryPrice
    )
  );

  const stop = normalizeIdentityNumber(
    firstFiniteNumber(
      record?.stopLoss,
      record?.stop,
      record?.sl,
      record?.tradePlan?.stopLoss,
      record?.tradePlan?.stop,
      record?.snapshot?.stopLoss,
      record?.snapshot?.stop
    )
  );

  const target1 = normalizeIdentityNumber(
    firstFiniteNumber(
      record?.target1,
      record?.takeProfit1,
      record?.tp1,
      record?.target,
      record?.takeProfit,
      record?.tradePlan?.target1,
      record?.snapshot?.target1,
      record?.snapshot?.tp1
    )
  );

  const core = coreIdentityOf(record);

  return [
    core.pair,
    core.engine,
    core.direction,
    entry,
    stop,
    target1,
    openedAtOf(record),
    closedAtOf(record),
    core.outcome
  ].join("|");
}

function pushIndex(map, key, record) {
  if (!key) return;

  if (!map.has(key)) {
    map.set(key, []);
  }

  map.get(key).push(record);
}

function buildClosedIndexes(closed) {
  const bySourceRecordId = new Map();
  const bySetupIdentity = new Map();
  const byComposite = new Map();

  for (const record of closed) {
    if (!isPlainObject(record)) continue;

    pushIndex(
      bySourceRecordId,
      firstString(record.sourceHistoryRecordId),
      record
    );

    pushIndex(
      bySetupIdentity,
      setupIdentityOf(record),
      record
    );

    pushIndex(
      byComposite,
      buildCompositeClosedKey(record),
      record
    );
  }

  return {
    bySourceRecordId,
    bySetupIdentity,
    byComposite
  };
}

function proveClosedMatch(record, indexes) {
  const recordId = firstString(record?.id);

  if (recordId) {
    const matches = indexes.bySourceRecordId.get(recordId) || [];

    if (
      matches.length === 1 &&
      coreCompatible(record, matches[0])
    ) {
      const richFingerprint = fingerprintOf(record);
      const closedFingerprint = fingerprintOf(matches[0]);

      if (
        !richFingerprint ||
        !closedFingerprint ||
        richFingerprint === closedFingerprint
      ) {
        return {
          proven: true,
          method: "sourceHistoryRecordId"
        };
      }
    }
  }

  const setupIdentity = setupIdentityOf(record);

  if (setupIdentity) {
    const matches = indexes.bySetupIdentity.get(setupIdentity) || [];

    if (
      matches.length === 1 &&
      coreCompatible(record, matches[0])
    ) {
      return {
        proven: true,
        method: "setupIdentity"
      };
    }
  }

  const composite = buildCompositeClosedKey(record);
  const matches = indexes.byComposite.get(composite) || [];

  if (
    composite &&
    matches.length === 1 &&
    coreCompatible(record, matches[0])
  ) {
    return {
      proven: true,
      method: "compositeClosedIdentity"
    };
  }

  return {
    proven: false,
    method: null
  };
}

function validateHistoryContract(history) {
  if (!isPlainObject(history)) {
    throw new Error(
      "analysis-history.json root must be an object."
    );
  }

  for (const field of [
    "records",
    "history",
    "items",
    "closed"
  ]) {
    if (!Array.isArray(history[field])) {
      throw new Error(
        `analysis-history.${field} must be an array.`
      );
    }
  }

  if (
    JSON.stringify(history.records) !==
      JSON.stringify(history.history) ||
    JSON.stringify(history.records) !==
      JSON.stringify(history.items)
  ) {
    throw new Error(
      "analysis-history records/history/items aliases are not exactly synchronized."
    );
  }

  if (
    history.open !== undefined &&
    !isPlainObject(history.open)
  ) {
    throw new Error(
      "analysis-history.open must remain an object when present."
    );
  }

  if (
    history.count !== undefined &&
    Number(history.count) !== history.records.length
  ) {
    throw new Error(
      `analysis-history.count (${String(history.count)}) does not equal records.length (${history.records.length}).`
    );
  }
}

function immutableTopLevelProjection(history) {
  const projection = {};

  for (const [key, value] of Object.entries(history)) {
    if (
      key === "records" ||
      key === "history" ||
      key === "items" ||
      key === "count"
    ) {
      continue;
    }

    projection[key] = value;
  }

  return projection;
}

function buildUpdatedHistory(history, selectedIndices) {
  const kept = history.records.filter(
    (_record, index) => !selectedIndices.has(index)
  );

  return {
    ...history,
    records: kept,
    history: kept,
    items: kept,
    count: kept.length
  };
}

function selectArchiveCandidates(history) {
  const indexes = buildClosedIndexes(history.closed);
  const candidates = [];
  const unresolvedOrUnproven = [];

  history.records.forEach((record, index) => {
    if (!isPlainObject(record)) return;

    const outcome = normalizeOutcome(record);
    const status = normalizeStatus(record);

    if (
      !outcome ||
      !RESOLVED_STATUSES.has(status)
    ) {
      return;
    }

    const proof = proveClosedMatch(record, indexes);

    if (!proof.proven) {
      unresolvedOrUnproven.push({
        index,
        id: firstString(record.id),
        fingerprint: fingerprintOf(record),
        setupIdentity: setupIdentityOf(record)
      });
      return;
    }

    const sortTime =
      Date.parse(closedAtOf(record) || openedAtOf(record)) || 0;

    candidates.push({
      index,
      record,
      proofMethod: proof.method,
      sortTime
    });
  });

  candidates.sort(
    (left, right) =>
      left.sortTime - right.sortTime ||
      left.index - right.index
  );

  return {
    candidates,
    unresolvedOrUnproven
  };
}

function findSelectionForTarget(history, candidates) {
  const originalBytes = prettyBuffer(history).length;

  if (originalBytes <= TARGET_BYTES) {
    return {
      selected: [],
      after: history,
      beforeBytes: originalBytes,
      afterBytes: originalBytes,
      alreadyWithinTarget: true
    };
  }

  if (candidates.length === 0) {
    throw new Error(
      `History is ${sizeMiB(originalBytes)} MiB but no proven-resolved rich records are available for safe archival.`
    );
  }

  function evaluate(count) {
    const selectedIndices = new Set(
      candidates
        .slice(0, count)
        .map(item => item.index)
    );

    const after = buildUpdatedHistory(
      history,
      selectedIndices
    );

    return {
      selectedIndices,
      after,
      bytes: prettyBuffer(after).length
    };
  }

  const all = evaluate(candidates.length);

  if (all.bytes > TARGET_BYTES) {
    throw new Error(
      `Safe archival cannot reach the ${TARGET_MIB} MiB target. ` +
      `Minimum proven-safe active size is ${sizeMiB(all.bytes)} MiB. ` +
      "Protected open/unresolved records and verified closed history were not modified."
    );
  }

  let low = 1;
  let high = candidates.length;
  let best = all;
  let bestCount = candidates.length;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const result = evaluate(middle);

    if (result.bytes <= TARGET_BYTES) {
      best = result;
      bestCount = middle;
      high = middle - 1;
    } else {
      low = middle + 1;
    }
  }

  const selected = candidates
    .slice(0, bestCount)
    .sort((left, right) => left.index - right.index);

  return {
    selected,
    after: best.after,
    beforeBytes: originalBytes,
    afterBytes: best.bytes,
    alreadyWithinTarget: false
  };
}

function validateReconstruction(originalRecords, keptRecords, selected) {
  const archivedByIndex = new Map(
    selected.map(item => [item.index, item.record])
  );

  const reconstructed = [];
  let keptIndex = 0;

  for (let index = 0; index < originalRecords.length; index += 1) {
    if (archivedByIndex.has(index)) {
      reconstructed.push(archivedByIndex.get(index));
    } else {
      reconstructed.push(keptRecords[keptIndex]);
      keptIndex += 1;
    }
  }

  if (
    JSON.stringify(reconstructed) !==
      JSON.stringify(originalRecords)
  ) {
    throw new Error(
      "Rich-history reconstruction invariant failed; maintenance aborted."
    );
  }
}

function validateExistingManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    return {
      version: ARCHIVE_VERSION,
      updatedAt: null,
      archives: [],
      totals: {
        archiveCount: 0,
        archivedRichRecords: 0
      }
    };
  }

  const manifest = JSON.parse(
    fs.readFileSync(MANIFEST_PATH, "utf8")
  );

  if (
    !isPlainObject(manifest) ||
    manifest.version !== ARCHIVE_VERSION ||
    !Array.isArray(manifest.archives)
  ) {
    throw new Error(
      "Existing analysis-history archive manifest is invalid or unsupported."
    );
  }

  const archiveRoot = path.resolve(ARCHIVE_ROOT);
  const seenFiles = new Set();

  let archivedRichRecords = 0;

  for (const entry of manifest.archives) {
    if (
      !isPlainObject(entry) ||
      typeof entry.file !== "string" ||
      !entry.file.trim() ||
      typeof entry.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/i.test(entry.sha256) ||
      typeof entry.uncompressedSha256 !== "string" ||
      !/^[a-f0-9]{64}$/i.test(entry.uncompressedSha256) ||
      !Number.isInteger(entry.recordCount) ||
      entry.recordCount < 0
    ) {
      throw new Error(
        "Existing analysis-history archive manifest contains an invalid entry."
      );
    }

    const relativePath = entry.file
      .trim()
      .replace(/\\/g, "/");

    if (
      path.isAbsolute(relativePath) ||
      relativePath.split("/").includes("..")
    ) {
      throw new Error(
        `Existing archive path is unsafe: ${entry.file}`
      );
    }

    if (seenFiles.has(relativePath)) {
      throw new Error(
        `Existing archive manifest contains a duplicate file entry: ${entry.file}`
      );
    }

    seenFiles.add(relativePath);

    const archivePath = path.resolve(
      ARCHIVE_ROOT,
      relativePath
    );

    if (
      archivePath !== archiveRoot &&
      !archivePath.startsWith(`${archiveRoot}${path.sep}`)
    ) {
      throw new Error(
        `Existing archive path escapes archive root: ${entry.file}`
      );
    }

    if (!fs.existsSync(archivePath)) {
      throw new Error(
        `Existing archive file is missing: ${entry.file}`
      );
    }

    const compressed = fs.readFileSync(archivePath);
    const actualHash = sha256(compressed);

    if (actualHash !== entry.sha256.toLowerCase()) {
      throw new Error(
        `Existing archive checksum mismatch: ${entry.file}`
      );
    }

    let uncompressed;

    try {
      uncompressed = zlib.gunzipSync(compressed);
    } catch (error) {
      throw new Error(
        `Existing archive is unreadable: ${entry.file}: ${error.message}`
      );
    }

    if (
      sha256(uncompressed) !==
      entry.uncompressedSha256.toLowerCase()
    ) {
      throw new Error(
        `Existing archive uncompressed checksum mismatch: ${entry.file}`
      );
    }

    let document;

    try {
      document = JSON.parse(
        uncompressed.toString("utf8")
      );
    } catch (error) {
      throw new Error(
        `Existing archive JSON is invalid: ${entry.file}: ${error.message}`
      );
    }

    if (
      !isPlainObject(document) ||
      document.version !== ARCHIVE_VERSION ||
      !Array.isArray(document.records) ||
      !Array.isArray(document.recordPositions) ||
      document.records.length !== entry.recordCount ||
      document.recordPositions.length !== entry.recordCount
    ) {
      throw new Error(
        `Existing archive contract mismatch: ${entry.file}`
      );
    }

    if (
      document.records.some(record => !isPlainObject(record)) ||
      document.recordPositions.some(
        value => !Number.isInteger(value) || value < 0
      ) ||
      new Set(document.recordPositions).size !==
        document.recordPositions.length
    ) {
      throw new Error(
        `Existing archive payload is invalid: ${entry.file}`
      );
    }

    if (
      entry.sourceHistorySha256 &&
      document.sourceHistorySha256 !==
        entry.sourceHistorySha256
    ) {
      throw new Error(
        `Existing archive source-history checksum metadata mismatch: ${entry.file}`
      );
    }

    archivedRichRecords += entry.recordCount;
  }

  if (
    isPlainObject(manifest.totals) &&
    (
      Number(manifest.totals.archiveCount) !==
        manifest.archives.length ||
      Number(manifest.totals.archivedRichRecords) !==
        archivedRichRecords
    )
  ) {
    throw new Error(
      "Existing archive manifest totals are inconsistent."
    );
  }

  return manifest;
}

function atomicWrite(filePath, buffer) {
  fs.mkdirSync(path.dirname(filePath), {
    recursive: true
  });

  const temporaryPath =
    `${filePath}.${process.pid}.${Date.now()}.tmp`;

  try {
    fs.writeFileSync(temporaryPath, buffer);
    fs.renameSync(temporaryPath, filePath);
  } finally {
    if (fs.existsSync(temporaryPath)) {
      fs.unlinkSync(temporaryPath);
    }
  }
}

function buildArchive(historyRawBuffer, history, selected, afterBytes) {
  const createdAt = new Date().toISOString();
  const records = selected.map(item => item.record);
  const recordPositions = selected.map(item => item.index);
  const proofCounts = {};

  for (const item of selected) {
    proofCounts[item.proofMethod] =
      (proofCounts[item.proofMethod] || 0) + 1;
  }

  const document = {
    version: ARCHIVE_VERSION,
    createdAt,
    sourceHistorySha256: sha256(historyRawBuffer),
    sourceHistoryUpdatedAt:
      typeof history.updatedAt === "string"
        ? history.updatedAt
        : null,
    originalRecordCount: history.records.length,
    recordPositions,
    records
  };

  const uncompressed = Buffer.from(
    JSON.stringify(document),
    "utf8"
  );

  const compressed = zlib.gzipSync(
    uncompressed,
    {
      level: 9
    }
  );

  if (compressed.length >= MAX_ARCHIVE_BYTES) {
    throw new Error(
      `Generated archive shard is ${sizeMiB(compressed.length)} MiB, which exceeds the maintenance safety ceiling.`
    );
  }

  const compressedHash = sha256(compressed);
  const uncompressedHash = sha256(uncompressed);
  const safeTimestamp = createdAt
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  const fileName =
    `analysis-history-rich-${safeTimestamp}-${compressedHash.slice(0, 12)}.json.gz`;
  const relativeFile = `rich/${fileName}`;

  return {
    createdAt,
    document,
    compressed,
    relativeFile,
    entry: {
      file: relativeFile,
      createdAt,
      recordCount: records.length,
      sha256: compressedHash,
      uncompressedSha256: uncompressedHash,
      sourceHistorySha256: document.sourceHistorySha256,
      sourceHistoryUpdatedAt: document.sourceHistoryUpdatedAt,
      originalRecordCount: history.records.length,
      firstOriginalIndex:
        recordPositions.length > 0
          ? Math.min(...recordPositions)
          : null,
      lastOriginalIndex:
        recordPositions.length > 0
          ? Math.max(...recordPositions)
          : null,
      proofCounts,
      activeHistoryBytesAfter: afterBytes
    }
  };
}

function updateManifest(manifest, archiveEntry) {
  const archives = [
    ...manifest.archives,
    archiveEntry
  ];

  return {
    version: ARCHIVE_VERSION,
    updatedAt: archiveEntry.createdAt,
    archives,
    totals: {
      archiveCount: archives.length,
      archivedRichRecords: archives.reduce(
        (sum, entry) => sum + entry.recordCount,
        0
      )
    }
  };
}

function main() {
  const apply = process.argv.includes("--apply");

  if (
    apply &&
    process.env[APPLY_CONFIRMATION_ENV] !==
      APPLY_CONFIRMATION_TOKEN
  ) {
    throw new Error(
      `Apply mode requires ${APPLY_CONFIRMATION_ENV}=${APPLY_CONFIRMATION_TOKEN}.`
    );
  }

  if (!fs.existsSync(HISTORY_PATH)) {
    throw new Error(
      `Required history file is missing: ${HISTORY_PATH}`
    );
  }

  const rawBuffer = fs.readFileSync(HISTORY_PATH);
  const history = JSON.parse(rawBuffer.toString("utf8"));

  validateHistoryContract(history);

  const existingManifest =
    validateExistingManifest();

  const protectedHash = semanticHash(
    immutableTopLevelProjection(history)
  );

  const selection = selectArchiveCandidates(history);
  const plan = findSelectionForTarget(
    history,
    selection.candidates
  );

  console.log("");
  console.log("PipSight Pro Analysis History Maintenance");
  console.log(`Mode: ${apply ? "APPLY" : "DRY RUN"}`);
  console.log(`Target active size: ${TARGET_MIB} MiB`);
  console.log(`Current file bytes: ${rawBuffer.length}`);
  console.log(`Current pretty semantic size: ${sizeMiB(plan.beforeBytes)} MiB`);
  console.log(`Rich records: ${history.records.length}`);
  console.log(`Verified closed records: ${history.closed.length}`);
  console.log(`Proven-resolved archive candidates: ${selection.candidates.length}`);
  console.log(`Resolved-but-unproven candidates: ${selection.unresolvedOrUnproven.length}`);

  if (plan.alreadyWithinTarget) {
    console.log("History is already within the 20 MiB target. No changes required.");
    return;
  }

  if (selection.unresolvedOrUnproven.length > 0) {
    console.warn(
      `${selection.unresolvedOrUnproven.length} resolved-looking rich record(s) were not archive-eligible because no unique verified closed proof was found; they remain protected in the active file.`
    );
  }

  const selectedIndices = new Set(
    plan.selected.map(item => item.index)
  );

  validateHistoryContract(plan.after);

  if (
    semanticHash(
      immutableTopLevelProjection(plan.after)
    ) !== protectedHash
  ) {
    throw new Error(
      "Protected analysis-history state changed during planning."
    );
  }

  validateReconstruction(
    history.records,
    plan.after.records,
    plan.selected
  );

  if (plan.afterBytes > TARGET_BYTES) {
    throw new Error(
      "Planned active history still exceeds the 20 MiB target."
    );
  }

  const archive = buildArchive(
    rawBuffer,
    history,
    plan.selected,
    plan.afterBytes
  );

  const roundTripArchive = JSON.parse(
    zlib
      .gunzipSync(archive.compressed)
      .toString("utf8")
  );

  if (
    JSON.stringify(roundTripArchive.records) !==
      JSON.stringify(plan.selected.map(item => item.record)) ||
    JSON.stringify(roundTripArchive.recordPositions) !==
      JSON.stringify(plan.selected.map(item => item.index))
  ) {
    throw new Error(
      "Generated archive failed the pre-write round-trip invariant."
    );
  }

  console.log(`Rich records selected for immutable archive: ${plan.selected.length}`);
  console.log(`Projected active size: ${sizeMiB(plan.afterBytes)} MiB`);
  console.log(`Archive shard size: ${sizeMiB(archive.compressed.length)} MiB`);
  console.log(`Archive proof counts: ${JSON.stringify(archive.entry.proofCounts)}`);

  if (!apply) {
    console.log("Dry run PASS. Re-run with --apply to write the verified plan.");
    return;
  }

  const manifest =
    existingManifest;

  const archivePath = path.join(
    ARCHIVE_ROOT,
    archive.relativeFile
  );

  if (fs.existsSync(archivePath)) {
    throw new Error(
      `Refusing to overwrite existing immutable archive: ${archive.relativeFile}`
    );
  }

  const updatedManifest = updateManifest(
    manifest,
    archive.entry
  );

  atomicWrite(
    archivePath,
    archive.compressed
  );

  atomicWrite(
    MANIFEST_PATH,
    prettyBuffer(updatedManifest)
  );

  atomicWrite(
    HISTORY_PATH,
    prettyBuffer(plan.after)
  );

  const writtenHistoryRaw = fs.readFileSync(HISTORY_PATH);
  const writtenHistory = JSON.parse(
    writtenHistoryRaw.toString("utf8")
  );

  validateHistoryContract(writtenHistory);

  if (writtenHistoryRaw.length > TARGET_BYTES) {
    throw new Error(
      `Written active history is ${sizeMiB(writtenHistoryRaw.length)} MiB and exceeds the 20 MiB target.`
    );
  }

  if (
    semanticHash(
      immutableTopLevelProjection(writtenHistory)
    ) !== protectedHash
  ) {
    throw new Error(
      "Protected analysis-history state changed after write."
    );
  }

  const writtenArchive = fs.readFileSync(archivePath);

  if (sha256(writtenArchive) !== archive.entry.sha256) {
    throw new Error(
      "Written archive checksum does not match the manifest entry."
    );
  }

  const writtenManifest = validateExistingManifest();
  const finalEntry = writtenManifest.archives[
    writtenManifest.archives.length - 1
  ];

  if (
    !finalEntry ||
    finalEntry.sha256 !== archive.entry.sha256 ||
    finalEntry.recordCount !== plan.selected.length
  ) {
    throw new Error(
      "Written archive manifest failed final verification."
    );
  }

  validateReconstruction(
    history.records,
    writtenHistory.records,
    plan.selected
  );

  console.log("Analysis history maintenance APPLY PASS.");
  console.log(`Active history: ${sizeMiB(writtenHistoryRaw.length)} MiB`);
  console.log(`Archived rich records: ${plan.selected.length}`);
  console.log(`Immutable shard: ${archive.relativeFile}`);
  console.log(`Archive SHA-256: ${archive.entry.sha256}`);
}

try {
  main();
} catch (error) {
  console.error(
    `[history-maintenance] ${error && error.message ? error.message : String(error)}`
  );
  process.exitCode = 1;
}
