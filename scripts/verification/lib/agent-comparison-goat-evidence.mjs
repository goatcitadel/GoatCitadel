import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { sha256 } from "./agent-comparison.mjs";
import { EXECUTION_BINDING_FIELDS, PERMISSION_REVIEW_FILE } from "./agent-comparison-permissions.mjs";

const PHASES = ["source", "review", "reuse"];
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const requireValue = (condition, message) => {
  if (!condition) throw new Error(message);
};
const samePath = (left, right) =>
  process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;

/** Phase bundles retain the full native snapshots. Check their lossless coverage
 * before referencing them in the bounded campaign receipt list. Raw snapshots
 * remain on disk; their filenames alone never establish workflow success. */
export const readNativeGoatWorkflowEvidence = (options) =>
  readNativeComparisonWorkflowEvidence({ ...options, product: "goatcitadel" });

export async function readNativeComparisonWorkflowEvidence({ evidenceDirectory, binding, source, signal, product }) {
  requireValue(
    ["goatcitadel", "openclaw", "hermes"].includes(product),
    "Use a supported native workflow evidence owner.",
  );
  const phaseFiles = PHASES.map(
    (phase) => `native-${product === "goatcitadel" ? "goat" : product}-workflow-${phase}.json`,
  );
  requireValue(
    ["native_receipts", "controlled_fixture"].includes(source) &&
      EXECUTION_BINDING_FIELDS.every((key) => typeof binding?.[key] === "string" && binding[key]),
    "Retain an explicit native workflow execution binding and source.",
  );
  let totalBytes = 0;
  await ordinary(evidenceDirectory, "directory");
  const read = async (filename) => {
    signal?.throwIfAborted();
    const stat = await ordinary(filename, "file");
    totalBytes += stat.size;
    requireValue(
      stat.nlink === 1 && stat.size <= MAX_FILE_BYTES && totalBytes <= MAX_TOTAL_BYTES,
      "Native workflow evidence exceeds its ordinary-file or byte bound.",
    );
    const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const held = await handle.stat();
      requireValue(
        held.dev === stat.dev && held.ino === stat.ino && held.size === stat.size && held.nlink === 1,
        "Native workflow evidence changed while opening.",
      );
      const buffer = Buffer.alloc(held.size + 1);
      let offset = 0;
      while (offset < buffer.length) {
        signal?.throwIfAborted();
        const part = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (!part.bytesRead) break;
        offset += part.bytesRead;
      }
      const after = await handle.stat();
      requireValue(
        offset === held.size &&
          after.size === held.size &&
          after.mtimeMs === held.mtimeMs &&
          after.ctimeMs === held.ctimeMs &&
          after.nlink === 1,
        "Native workflow evidence changed while reading.",
      );
      const bytes = buffer.subarray(0, offset);
      return { value: JSON.parse(bytes.toString("utf8")), sha256: sha256(bytes) };
    } finally {
      await handle.close();
    }
  };
  const matchesBinding = (value) =>
    value?.source === source && EXECUTION_BINDING_FIELDS.every((key) => value[key] === binding[key]);
  const summaryFile = "workflow-execution.json";
  const summary = await read(path.join(evidenceDirectory, summaryFile));
  const execution = summary.value;
  const expected = [...phaseFiles, PERMISSION_REVIEW_FILE];
  requireValue(
    matchesBinding(execution) &&
      execution.schemaVersion === "goatcitadel.agent-comparison.execution.v1" &&
      execution.product === product &&
      execution.taskId === "workflow_capture_reuse" &&
      execution.workflow &&
      Array.isArray(execution.nativeReceipts) &&
      execution.nativeReceipts.length === expected.length &&
      new Set(execution.nativeReceipts.map((ref) => ref.path)).size === expected.length &&
      execution.nativeReceipts.every((ref) => expected.includes(ref.path)),
    "The native skill workflow receipt changed its execution binding or phase inventory.",
  );
  const snapshots = new Map();
  let snapshotCount = 0;
  for (const reference of execution.nativeReceipts) {
    const receipt = await read(path.join(evidenceDirectory, reference.path));
    requireValue(receipt.sha256 === reference.sha256, "The native skill workflow evidence changed.");
    if (reference.path === PERMISSION_REVIEW_FILE) continue;
    const phase = PHASES[phaseFiles.indexOf(reference.path)];
    requireValue(
      matchesBinding(receipt.value) && Array.isArray(receipt.value.records) && receipt.value.records.length > 0,
      "A native workflow phase changed its execution binding or has no snapshots.",
    );
    for (const record of receipt.value.records) {
      requireValue(
        record?.phase === phase && /^[a-z0-9-]{1,120}$/u.test(record.name ?? "") && ++snapshotCount <= 500,
        "Native workflow snapshots changed phase or exceed their inventory bound.",
      );
      const { phase: _phase, name, ...value } = record;
      const key = sha256({ name, value });
      snapshots.set(key, (snapshots.get(key) ?? 0) + 1);
    }
  }
  const rawDirectory = path.join(evidenceDirectory, product);
  await ordinary(rawDirectory, "directory");
  const names = (await readdir(rawDirectory)).sort();
  requireValue(names.length === snapshotCount, "Native workflow phase bundles do not cover the raw inventory.");
  for (const [index, filename] of names.entries()) {
    const match = /^workflow-(\d{4})-([a-z0-9-]{1,120})\.json$/u.exec(filename);
    requireValue(match && Number(match[1]) === index + 1, "Native workflow snapshot inventory is incomplete.");
    const receipt = await read(path.join(rawDirectory, filename));
    // Concurrent native reads can finish in a different order than their file
    // sequence. Compare the complete multiset, including repeated identical polls.
    const key = sha256({ name: match[2], value: receipt.value });
    const remaining = snapshots.get(key) ?? 0;
    requireValue(remaining > 0, "A raw native workflow snapshot is missing from its phase bundle.");
    snapshots.set(key, remaining - 1);
  }
  requireValue(
    [...snapshots.values()].every((count) => count === 0),
    "Native workflow snapshot coverage changed.",
  );
  return {
    ...execution,
    nativeReceipts: [...execution.nativeReceipts, { path: summaryFile, sha256: summary.sha256 }],
    nativeSnapshotCount: snapshotCount,
  };
}

async function ordinary(filename, kind) {
  requireValue(path.isAbsolute(filename), "Use an absolute native evidence path.");
  const stat = await lstat(filename);
  requireValue(
    !stat.isSymbolicLink() &&
      (kind === "file" ? stat.isFile() : stat.isDirectory()) &&
      samePath(path.resolve(filename), await realpath(filename)),
    "Native workflow evidence must use ordinary paths without linked ancestors.",
  );
  return stat;
}
