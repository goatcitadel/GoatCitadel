import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertWorkerDurableStateKey,
  createFileWorkerDurableState,
  createInMemoryWorkerDurableState,
  WorkerDurableStateError,
} from "./worker-durable-state.js";

describe("worker durable state", () => {
  const roots: string[] = [];
  afterEach(async () => {
    while (roots.length > 0) {
      const root = roots.pop();
      if (root !== undefined) await rm(root, { recursive: true, force: true });
    }
  });

  it("round-trips values in the in-memory adapter", async () => {
    const state = createInMemoryWorkerDurableState();
    expect(await state.read("runtime-credential")).toBeUndefined();
    await state.write("runtime-credential", "value-1");
    expect(await state.read("runtime-credential")).toBe("value-1");
    await state.write("runtime-credential", "value-2");
    expect(await state.read("runtime-credential")).toBe("value-2");
    await state.delete("runtime-credential");
    expect(await state.read("runtime-credential")).toBeUndefined();
  });

  it("persists atomically to disk and reads back after re-open", async () => {
    const root = await mkdtemp(join(tmpdir(), "rw-state-"));
    roots.push(root);
    const first = createFileWorkerDurableState(root);
    await first.write("assignment-leases", "[]");
    await first.write("assignment-leases", '[{"a":1}]');
    const second = createFileWorkerDurableState(root);
    expect(await second.read("assignment-leases")).toBe('[{"a":1}]');
    await second.delete("assignment-leases");
    expect(await createFileWorkerDurableState(root).read("assignment-leases")).toBeUndefined();
  });

  it("rejects unsafe keys in both adapters", async () => {
    expect(() => assertWorkerDurableStateKey("../escape")).toThrow(WorkerDurableStateError);
    const state = createInMemoryWorkerDurableState();
    await expect(state.write("bad/key", "x")).rejects.toBeInstanceOf(WorkerDurableStateError);
  });
});
