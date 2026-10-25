import { createHash } from "node:crypto";
import fs from "node:fs/promises";

/** Files above this size are not hashed during a staleness check; their drift is unknown, not stale. */
export const MAX_STALENESS_HASH_BYTES = 5 * 1024 * 1024;
export const STALENESS_CHECK_CONCURRENCY = 6;

export interface LearningFileProbe {
  exists(absolutePath: string): Promise<boolean>;
  /** sha256 of a regular file, or undefined when it is missing, not a file, or over the size cap. */
  hash(absolutePath: string): Promise<string | undefined>;
}

/** One probe per staleness run: each path is stat'ed once and hashed at most once per mtime. */
export function createLearningFileProbe(maxBytes = MAX_STALENESS_HASH_BYTES): LearningFileProbe {
  const stats = new Map<string, Promise<{ isFile: boolean; size: number; mtimeMs: number } | undefined>>();
  const hashes = new Map<string, Promise<string | undefined>>();
  const stat = (absolutePath: string) => {
    let cached = stats.get(absolutePath);
    if (!cached) {
      cached = fs.stat(absolutePath).then(
        (value) => ({ isFile: value.isFile(), size: value.size, mtimeMs: value.mtimeMs }),
        () => undefined,
      );
      stats.set(absolutePath, cached);
    }
    return cached;
  };
  return {
    async exists(absolutePath) {
      return (await stat(absolutePath)) !== undefined;
    },
    async hash(absolutePath) {
      const info = await stat(absolutePath);
      if (!info || !info.isFile || info.size > maxBytes) return undefined;
      const key = `${absolutePath}\u0000${info.mtimeMs}`;
      let cached = hashes.get(key);
      if (!cached) {
        cached = fs.readFile(absolutePath).then(
          (buffer) => createHash("sha256").update(buffer).digest("hex"),
          () => undefined,
        );
        hashes.set(key, cached);
      }
      return await cached;
    },
  };
}

/** Maps with at most `limit` concurrent workers, preserving input order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await mapper(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}
