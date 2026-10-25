import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLearningFileProbe, mapWithConcurrency } from "./memory-learning-file-probe.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function tempFile(name: string, content: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "goat-learning-probe-"));
  roots.push(root);
  const file = path.join(root, name);
  await fs.writeFile(file, content);
  return file;
}

describe("learning file probe", () => {
  it("hashes regular files, reports missing ones, and caches per run", async () => {
    const file = await tempFile("a.txt", "hello");
    const probe = createLearningFileProbe();
    expect(await probe.exists(file)).toBe(true);
    expect(await probe.exists(`${file}.nope`)).toBe(false);
    const first = await probe.hash(file);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(await probe.hash(file)).toBe(first);
    expect(await probe.hash(`${file}.nope`)).toBeUndefined();
  });

  it("does not hash files over the cap (unknown, not stale)", async () => {
    const file = await tempFile("big.txt", "x".repeat(32));
    expect(await createLearningFileProbe(16).hash(file)).toBeUndefined();
    expect(await createLearningFileProbe(16).exists(file)).toBe(true);
  });
});

describe("mapWithConcurrency", () => {
  it("never exceeds the limit and preserves order", async () => {
    let active = 0;
    let peak = 0;
    const out = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8], 3, async (n) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14, 16]);
    expect(peak).toBeLessThanOrEqual(3);
  });
});
