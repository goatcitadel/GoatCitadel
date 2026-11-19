import { describe, expect, it, vi } from "vitest";
import { ScriptsService } from "./scripts-service.js";
import type { AsyncStorage } from "@goatcitadel/storage";

function fixture() {
  const records = [{ id: "one", workspaceId: "a", title: "Script", kind: "code", sourceId: "immutable", runId: "run" }];
  const values = new Map<string, { key: string; value: unknown; updatedAt: string }>();
  const audit = vi.fn();
  const storage = {
    workspaces: { get: vi.fn(async () => ({})) },
    scriptInventory: { list: vi.fn(async (workspace: string) => (workspace === "a" ? records : [])) },
    systemSettings: {
      getMany: vi.fn(async (keys: string[]) => keys.flatMap((key) => (values.has(key) ? [values.get(key)!] : []))),
      get: vi.fn(async (key: string) => values.get(key)),
      compareAndSet: vi.fn(async (key: string, previous: unknown, value: unknown) => {
        if (values.get(key) !== previous) return undefined;
        const next = { key, value, updatedAt: "now" };
        values.set(key, next);
        return next;
      }),
    },
    audit: { append: audit },
    runImmediateTransaction: async <T>(work: () => Promise<T>) => work(),
  };
  return { service: new ScriptsService(storage as unknown as AsyncStorage, "C:\\fixture"), records, audit, storage };
}
describe("Scripts retention", () => {
  it("persists labels without expiration or evidence mutation and rejects stale writes", async () => {
    const { service, records, audit } = fixture();
    const before = structuredClone(records);
    expect((await service.list("a")).items[0]).toMatchObject({
      retention: "permanent",
      retentionVersion: 0,
      expiresAt: null,
    });
    const update = { workspaceId: "a", id: "one", retention: "temporary" as const, expectedVersion: 0 };
    expect(await service.update(update, "operator")).toMatchObject({
      retention: "temporary",
      retentionVersion: 1,
      expiresAt: null,
    });
    await expect(service.update(update, "operator")).rejects.toThrow();
    expect((await service.list("a")).items[0]?.retention).toBe("temporary");
    expect(records).toEqual(before);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(await service.update({ ...update, retention: "permanent", expectedVersion: 1 }, "operator")).toMatchObject({
      retention: "permanent",
      retentionVersion: 2,
      expiresAt: null,
    });
  });
  it("rejects foreign and missing items before storing retention", async () => {
    const { service, storage } = fixture();
    await expect(
      service.update({ workspaceId: "b", id: "one", retention: "temporary", expectedVersion: 0 }, "operator"),
    ).rejects.toThrow();
    expect(storage.systemSettings.compareAndSet).not.toHaveBeenCalled();
  });
});
