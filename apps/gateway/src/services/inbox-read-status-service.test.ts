import { describe, expect, it } from "vitest";
import { Storage, createSqliteAsyncStorage } from "@goatcitadel/storage";
import { InboxReadStatusService, versionInboxUpdates } from "./inbox-read-status-service.js";
import type { OperatorInboxResponse } from "@goatcitadel/contracts";
const projection = () =>
  ({
    workspaceId: "a",
    items: [
      { id: "task_deliverable:x", group: "updates", title: "first", source: { workspaceId: "a" } },
      { id: "approval:x", group: "needs_decision", source: { workspaceId: "a" } },
    ],
  }) as OperatorInboxResponse;
describe("Inbox read owner", () => {
  it("versions only updates stably and changes with public content", () => {
    const a = versionInboxUpdates(projection());
    expect(a.items[0]?.version).toMatch(/^[a-f0-9]{64}$/);
    expect(versionInboxUpdates(projection()).items[0]?.version).toBe(a.items[0]?.version);
    const changed = projection();
    changed.items[0]!.title = "second";
    expect(versionInboxUpdates(changed).items[0]?.version).not.toBe(a.items[0]?.version);
    expect(a.items[1]?.version).toBeUndefined();
  });
  it("persists only current authorized updates and isolates actors and workspaces through actual SQLite", async () => {
    const storage = new Storage({ dbPath: ":memory:" });
    try {
      const owner = new InboxReadStatusService(createSqliteAsyncStorage(storage).systemSettings);
      const p = versionInboxUpdates(projection());
      const update = { id: p.items[0]!.id, version: p.items[0]!.version! };
      const result = await owner.acknowledge(p, "operator-a", [
        update,
        { id: "approval:x", version: "bad" },
        { ...update, version: "stale" },
      ]);
      expect(result.acknowledged).toEqual([update]);
      expect(result.skipped).toHaveLength(2);
      expect((await owner.project(p, "operator-a")).items[0]?.read).toBe(true);
      expect((await owner.project(p, "operator-b")).items[0]?.read).toBe(false);
      expect((await owner.project({ ...p, workspaceId: "b" }, "operator-a")).items[0]?.read).toBe(false);
      expect((await owner.acknowledge(p, undefined, [update])).acknowledged).toEqual([]);
    } finally {
      storage.close();
    }
  });
});

it("bounds retained receipts, prunes after fourteen days, and does not claim failed persistence", async () => {
  const storage = new Storage({ dbPath: ":memory:" });
  try {
    const asyncSettings = createSqliteAsyncStorage(storage).systemSettings;
    const owner = new InboxReadStatusService(asyncSettings);
    const p = versionInboxUpdates(projection());
    const u = { id: p.items[0]!.id, version: p.items[0]!.version! };
    const first = await owner.acknowledge(p, "actor", [u]);
    const key = first.readStatus.scopeId!;
    const now = Date.now();
    storage.systemSettings.set(key, [
      { id: "expired", version: "old", at: now - 15 * 86400000 },
      ...Array.from({ length: 1000 }, (_, i) => ({ id: "existing" + i, version: "old", at: now - 1 })),
    ]);
    await owner.acknowledge(p, "actor", [u]);
    const records = storage.systemSettings.get<Array<{ id: string }>>(key)!.value;
    expect(records).toHaveLength(1000);
    expect(records.some((r) => r.id === "expired")).toBe(false);
    expect(records.some((r) => r.id === u.id)).toBe(true);
    const broken = new InboxReadStatusService({
      get: async () => {
        throw new Error("private failure");
      },
      compareAndSet: async () => undefined,
    });
    expect((await broken.project(p, "actor")).readStatus?.scope).toBe("unavailable");
    const failed = await broken.acknowledge(p, "actor", [u]);
    expect(failed.acknowledged).toEqual([]);
    expect(failed.readStatus.scope).toBe("unavailable");
    expect(JSON.stringify(failed)).not.toContain("private failure");
  } finally {
    storage.close();
  }
});
