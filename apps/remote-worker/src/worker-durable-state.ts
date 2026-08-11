import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * The worker runtime's OWN durable state boundary. The connected worker keeps
 * its retained credential, per-assignment leases, transcript outbox, and
 * settlement receipts here so a restarted process re-hydrates exactly what it
 * held before — never by replaying a one-time bootstrap secret. This is the
 * worker's local state, entirely separate from the Gateway's canonical storage.
 *
 * Keys are bounded to a filesystem-safe charset so a file-backed adapter can
 * map each key to a sibling file without traversal.
 */
export interface WorkerDurableStatePort {
  read(key: string): Promise<string | undefined>;
  write(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

const SAFE_KEY = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u;

export class WorkerDurableStateError extends Error {
  readonly code = "REMOTE_WORKER_DURABLE_STATE_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "WorkerDurableStateError";
  }
}

export function assertWorkerDurableStateKey(key: string): string {
  if (typeof key !== "string" || !SAFE_KEY.test(key)) {
    throw new WorkerDurableStateError("Worker durable-state key is invalid.");
  }
  return key;
}

/** Deterministic in-memory adapter for tests and ephemeral runs. */
export function createInMemoryWorkerDurableState(seed?: Iterable<readonly [string, string]>): WorkerDurableStatePort {
  const store = new Map<string, string>();
  if (seed !== undefined) {
    for (const [key, value] of seed) store.set(assertWorkerDurableStateKey(key), value);
  }
  return Object.freeze({
    read: (key: string): Promise<string | undefined> =>
      Promise.resolve().then(() => store.get(assertWorkerDurableStateKey(key))),
    write: (key: string, value: string): Promise<void> =>
      Promise.resolve().then(() => {
        store.set(assertWorkerDurableStateKey(key), assertValue(value));
      }),
    delete: (key: string): Promise<void> =>
      Promise.resolve().then(() => {
        store.delete(assertWorkerDurableStateKey(key));
      }),
  });
}

/**
 * File-backed adapter. Each key is one sibling file under `rootDir`; writes are
 * atomic (temp file plus rename) so a crash between writes never leaves a
 * torn snapshot. A missing file reads as `undefined`.
 */
export function createFileWorkerDurableState(rootDir: string): WorkerDurableStatePort {
  const pathFor = (key: string): string => join(rootDir, `${assertWorkerDurableStateKey(key)}.json`);
  return Object.freeze({
    read: async (key: string): Promise<string | undefined> => {
      try {
        return await readFile(pathFor(key), "utf8");
      } catch (error) {
        if (isNotFound(error)) return undefined;
        throw error;
      }
    },
    write: async (key: string, value: string): Promise<void> => {
      const target = pathFor(key);
      await mkdir(dirname(target), { recursive: true });
      const temporary = `${target}.${randomBytes(8).toString("hex")}.tmp`;
      await writeFile(temporary, assertValue(value), { encoding: "utf8", mode: 0o600 });
      await rename(temporary, target);
    },
    delete: async (key: string): Promise<void> => {
      await rm(pathFor(key), { force: true });
    },
  });
}

function assertValue(value: string): string {
  if (typeof value !== "string") {
    throw new WorkerDurableStateError("Worker durable-state value must be a string.");
  }
  return value;
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}
