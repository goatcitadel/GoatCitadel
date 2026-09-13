import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { ComparisonDispatchBudget, summarizeComparison } from "./agent-comparison.mjs";

const MAX_BYTES = 16 * 1024 * 1024;
const VERSION = "goatcitadel.agent-comparison.budget-journal.v1";

/** A single-writer, fsynced campaign journal, outside every model workspace.
 * A crash leaves the lock for operator inspection. Never steal another writer's
 * lock or truncate an incomplete reservation: either could hide a paid call. */
export async function openComparisonJournal({ directory, manifest }) {
  summarizeComparison(manifest, []);
  if (!path.isAbsolute(directory)) throw new Error("Campaign journal directory must be absolute.");
  const root = await realpath(directory);
  const comparablePath = (value) => (process.platform === "win32" ? value.toLowerCase() : value);
  if ((await lstat(directory)).isSymbolicLink() || comparablePath(root) !== comparablePath(path.resolve(directory)))
    throw new Error("Campaign journal must use its ordinary canonical directory.");
  const lockPath = path.join(root, "budget.lock");
  const lock = await open(lockPath, "wx", 0o600);
  const nonce = randomUUID();
  let handle;
  let closed = false;
  let tail = Promise.resolve();
  const events = [];
  const cellIds = new Set(manifest.cells.map((cell) => `${cell.product}:${cell.task}:${cell.trial}`));
  try {
    await lock.writeFile(
      JSON.stringify({ schemaVersion: VERSION, manifestSha256: manifest.manifestSha256, pid: process.pid, nonce }) +
        "\n",
    );
    await lock.sync();
    const filename = path.join(root, "budget.jsonl");
    const header = { schemaVersion: VERSION, manifestSha256: manifest.manifestSha256 };
    try {
      handle = await open(filename, "wx+", 0o600);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    if (handle) {
      await handle.writeFile(JSON.stringify(header) + "\n");
      await handle.sync();
    } else {
      const before = await lstat(filename);
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_BYTES)
        throw new Error("Campaign budget journal is not an ordinary bounded file.");
      handle = await open(filename, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
      const held = await handle.stat();
      if (held.dev !== before.dev || held.ino !== before.ino || held.size !== before.size)
        throw new Error("Campaign budget journal changed while opening.");
      const bytes = Buffer.alloc(held.size + 1);
      let count = 0;
      while (count < bytes.length) {
        const chunk = await handle.read(bytes, count, bytes.length - count, count);
        if (!chunk.bytesRead) break;
        count += chunk.bytesRead;
      }
      if (count !== held.size) throw new Error("Campaign budget journal changed while reading.");
      const raw = bytes.subarray(0, count).toString("utf8");
      if (!raw.endsWith("\n"))
        throw new Error("Campaign budget journal has an incomplete record; inspect it before resuming.");
      const lines = raw
        .slice(0, -1)
        .split("\n")
        .map((line) => JSON.parse(line));
      if (JSON.stringify(lines.shift()) !== JSON.stringify(header))
        throw new Error("Campaign journal belongs to another manifest.");
      events.push(...lines);
    }
    if (events.some((event) => !cellIds.has(event.cellId)))
      throw new Error("Campaign budget journal contains an undeclared cell.");
    let position = (await handle.stat()).size;
    const budget = new ComparisonDispatchBudget({
      maxRequests: manifest.maxRequests,
      maxCostUsd: manifest.maxCostUsd,
      events,
      persist: (event) => {
        if (closed || !cellIds.has(event.cellId))
          return Promise.reject(new Error("Campaign budget writer is closed or the cell is undeclared."));
        const snapshot = structuredClone(event);
        tail = tail.then(async () => {
          const bytes = Buffer.from(JSON.stringify(snapshot) + "\n");
          if (position + bytes.length > MAX_BYTES)
            throw new Error("Campaign budget journal reached its retained-evidence limit.");
          let offset = 0;
          while (offset < bytes.length) {
            const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, position + offset);
            if (!bytesWritten) throw new Error("Campaign budget journal write made no progress.");
            offset += bytesWritten;
          }
          await handle.sync();
          position += bytes.length;
          events.push(snapshot);
        });
        return tail;
      },
    });
    return {
      budget,
      snapshot: () => ({ manifestSha256: manifest.manifestSha256, events: structuredClone(events) }),
      async close() {
        if (closed) return;
        closed = true;
        try {
          await tail;
        } finally {
          await handle.close();
          await releaseLock(lock, lockPath);
        }
      },
    };
  } catch (error) {
    await handle?.close();
    await releaseLock(lock, lockPath);
    throw error;
  }
}

async function releaseLock(handle, filename) {
  try {
    const [held, current] = await Promise.all([handle.stat(), lstat(filename)]);
    if (current.isSymbolicLink() || held.dev !== current.dev || held.ino !== current.ino)
      throw new Error("Campaign lock was replaced; the replacement was preserved.");
    // Close first for Windows, after proving this is the exact lock we created.
    await handle.close();
    await unlink(filename);
  } catch (error) {
    await handle.close();
    throw error;
  }
}
