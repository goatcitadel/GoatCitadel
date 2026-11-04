import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Storage, createSqliteAsyncStorage } from "@goatcitadel/storage";
import { CapabilityPluginStore } from "./capability-plugin-store.js";
import { feedPluginToolGroupHolds } from "./capability-plugins-composition.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "goat-plugin-record-lock-"));
  const storage = createSqliteAsyncStorage(new Storage({
    dbPath: path.join(root, "runtime.sqlite"),
    transcriptsDir: path.join(root, "transcripts"),
    auditDir: path.join(root, "audit"),
  }));
  const store = new CapabilityPluginStore(storage.systemSettings);
  const setHolds = vi.fn();
  const report = vi.fn();
  const readsDuringTransaction: boolean[] = [];
  const waits: Array<() => void> = [];
  const state = { transactionOpen: false, closing: false, failReads: false };
  const feed = feedPluginToolGroupHolds({
    readPlugins: async () => {
      readsDuringTransaction.push(state.transactionOpen);
      if (state.failReads) throw new Error("Temporary records read failure");
      return store.list();
    },
    onStoreChange: (listener) => { store.onChange(listener); },
    setHolds,
    setHoldsUnavailable: vi.fn(),
    report,
    reportFirstReadFailure: vi.fn(),
    wait: async () => undefined,
    waitInBackground: () => new Promise<void>((resolve) => waits.push(resolve)),
    isClosing: () => state.closing,
  });
  await feed.load();
  cleanups.push(async () => {
    state.closing = true;
    for (const resume of waits.splice(0)) resume();
    await new Promise((resolve) => setImmediate(resolve));
    await storage.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const transaction = async <T>(work: () => T | Promise<T>): Promise<Awaited<T>> => {
    const previous = state.transactionOpen;
    state.transactionOpen = true;
    try {
      return await storage.runImmediateTransaction(work);
    } finally {
      state.transactionOpen = previous;
    }
  };
  const saveHold = () => store.update("browser-hold", () => ({
    pluginId: "browser-hold", name: "Browser hold", description: "A hold", version: "1.0.0",
    trust: "unverified", sourceKind: "folder", sourceDisplay: "browser-hold",
    pin: { kind: "content", treeSha256: "a".repeat(64) },
    manifestSha256: "b".repeat(64), snapshotTreeSha256: "a".repeat(64),
    workspaceId: "default", installPlanId: "install-hold", state: "installed",
    installedAt: "2026-11-02T00:00:00.000Z",
    pieces: [{ pieceId: "no-browser", kind: "tool_group_off", owned: true, ref: "browser" }],
  }));
  return { store, state, transaction, saveHold, setHolds, report, readsDuringTransaction, waits };
}

describe("plugin record fence notifications over real async SQLite storage", () => {
  it("notifies only after commit and recovers from a subsequent read failure outside the transaction", async () => {
    const h = await fixture();
    await h.store.withLock(h.transaction, async () => {
      await h.saveHold();
      await new Promise((resolve) => setImmediate(resolve));
      expect(h.setHolds).toHaveBeenCalledTimes(1);
      h.state.failReads = true;
    });
    await vi.waitFor(() => expect(h.report).toHaveBeenCalledOnce());
    expect(h.readsDuringTransaction).not.toContain(true);
    h.state.failReads = false;
    h.waits.shift()!();
    await vi.waitFor(() => expect(h.setHolds).toHaveBeenLastCalledWith([
      { groupId: "browser", pluginId: "browser-hold", pluginName: "Browser hold" },
    ]));
    expect(h.readsDuringTransaction).not.toContain(true);
  });

  it("reconverges to committed records after rollback without publishing its temporary hold", async () => {
    const h = await fixture();
    await expect(h.store.withLock(h.transaction, async () => {
      await h.saveHold();
      await new Promise((resolve) => setImmediate(resolve));
      throw new Error("Roll back this install");
    })).rejects.toThrow("Roll back this install");

    await vi.waitFor(() => expect(h.setHolds).toHaveBeenCalledTimes(2));
    expect(h.setHolds.mock.calls).toEqual([[[]], [[]]]);
    expect(h.readsDuringTransaction).not.toContain(true);
    expect(await h.store.list()).toEqual([]);
    expect(h.report).not.toHaveBeenCalled();
  });

  it("defers a nested fence notification until the outer transaction rolls back", async () => {
    const h = await fixture();
    await expect(h.store.withLock(h.transaction, async () => {
      await h.store.withLock(h.transaction, h.saveHold);
      await new Promise((resolve) => setImmediate(resolve));
      expect(h.setHolds).toHaveBeenCalledTimes(1);
      throw new Error("Roll back the outer fence");
    })).rejects.toThrow("Roll back the outer fence");

    await vi.waitFor(() => expect(h.setHolds).toHaveBeenCalledTimes(2));
    expect(h.setHolds.mock.calls).toEqual([[[]], [[]]]);
    expect(h.readsDuringTransaction).not.toContain(true);
  });

  it("keeps an independent queued write observable after another fence rolls back", async () => {
    const h = await fixture();
    let entered!: () => void;
    let release!: () => void;
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const rolledBack = h.store.withLock(h.transaction, async () => {
      await h.saveHold();
      entered();
      await gate;
      throw new Error("Roll back only the fenced write");
    });
    const rejected = expect(rolledBack).rejects.toThrow("Roll back only the fenced write");
    await inside;
    // This call originates outside the fence's async scope, and its storage work queues after the transaction.
    const independent = h.saveHold();
    release();
    await rejected;
    await independent;

    await vi.waitFor(() => expect(h.setHolds).toHaveBeenLastCalledWith([
      { groupId: "browser", pluginId: "browser-hold", pluginName: "Browser hold" },
    ]));
    expect(h.readsDuringTransaction).not.toContain(true);
    expect(h.report).not.toHaveBeenCalled();
  });
});
