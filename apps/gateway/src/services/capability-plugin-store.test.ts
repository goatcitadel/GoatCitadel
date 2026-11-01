import { describe, expect, it } from "vitest";
import type { CapabilityPluginInspection } from "@goatcitadel/contracts";
import {
  CAPABILITY_PLUGINS_SETTING_KEY,
  CapabilityPluginStore,
  findPluginOwning,
  pluginToolGroupHolds,
  readPluginPieceOwner,
  removedPluginSkills,
  type CapabilityPluginSettingRecord,
  type CapabilityPluginSettingRows,
  type StoredPlugin,
} from "./capability-plugin-store.js";

const NOW = Date.parse("2026-10-31T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

/**
 * The system settings row the store keeps, with the repository's own compare-and-set rule: a write lands only when the
 * row still holds exactly what the writer read (the same value and time), and a first write only when no row exists.
 */
class SettingRows implements CapabilityPluginSettingRows {
  public record: CapabilityPluginSettingRecord | undefined;
  public writes = 0;
  public refusedWrites = 0;
  /** Runs once, inside the next compare-and-set and before its comparison, as a second writer would. */
  public beforeNextCompare: (() => void) | undefined;
  private clock = 0;

  public async get(key: string): Promise<CapabilityPluginSettingRecord | undefined> {
    expect(key).toBe(CAPABILITY_PLUGINS_SETTING_KEY);
    return this.record ? structuredClone(this.record) : undefined;
  }

  public async compareAndSet(
    key: string,
    expected: CapabilityPluginSettingRecord | undefined,
    value: unknown,
  ): Promise<CapabilityPluginSettingRecord | undefined> {
    expect(key).toBe(CAPABILITY_PLUGINS_SETTING_KEY);
    const competing = this.beforeNextCompare;
    this.beforeNextCompare = undefined;
    competing?.();
    const unchanged = expected
      ? this.record !== undefined &&
        this.record.updatedAt === expected.updatedAt &&
        JSON.stringify(this.record.value) === JSON.stringify(expected.value)
      : this.record === undefined;
    if (!unchanged) {
      this.refusedWrites += 1;
      return undefined;
    }
    this.writes += 1;
    this.record = { key, value: structuredClone(value), updatedAt: new Date(NOW + ++this.clock).toISOString() };
    return structuredClone(this.record);
  }
}

function inspection(index: number, overrides: Partial<CapabilityPluginInspection> = {}): CapabilityPluginInspection {
  const inspectedAt = new Date(NOW - (60 - index) * 60_000);
  return {
    inspectionId: `inspection-${String(index).padStart(3, "0")}`,
    workspaceId: "default",
    pluginId: "meeting-tools",
    name: "Meeting tools",
    description: "Notes and checks for meetings.",
    version: "1.0.0",
    trust: "unverified",
    sourceKind: "folder",
    sourceDisplay: "meeting-tools",
    pin: { kind: "content", treeSha256: "a".repeat(64) },
    manifestSha256: "b".repeat(64),
    pieces: [],
    ignored: [],
    installable: true,
    inspectedAt: inspectedAt.toISOString(),
    expiresAt: new Date(inspectedAt.getTime() + 24 * HOUR).toISOString(),
    ...overrides,
  };
}

function plugin(pluginId: string, overrides: Partial<StoredPlugin> = {}): StoredPlugin {
  return {
    pluginId,
    name: `Plugin ${pluginId}`,
    description: "A plugin.",
    version: "1.0.0",
    trust: "unverified",
    sourceKind: "folder",
    sourceDisplay: pluginId,
    pin: { kind: "content", treeSha256: "c".repeat(64) },
    manifestSha256: "d".repeat(64),
    snapshotTreeSha256: "c".repeat(64),
    workspaceId: "default",
    installPlanId: `plan-${pluginId}`,
    state: "installed",
    installedAt: new Date(NOW).toISOString(),
    pieces: [],
    ...overrides,
  };
}

describe("CapabilityPluginStore", () => {
  it("keeps the newest 50 inspections and drops expired ones", async () => {
    const rows = new SettingRows();
    let now = NOW;
    const store = new CapabilityPluginStore(rows, () => new Date(now));
    // One that ran out of time a minute ago, then 52 live ones, oldest first.
    const expired = inspection(0, {
      inspectionId: "inspection-expired",
      inspectedAt: new Date(NOW - 25 * HOUR).toISOString(),
      expiresAt: new Date(NOW - 60_000).toISOString(),
    });
    await store.saveInspection(expired, "e".repeat(64));
    for (let index = 1; index <= 52; index += 1) {
      await store.saveInspection(inspection(index), `${index}`.padStart(64, "0"));
    }

    const kept = (rows.record?.value as { inspections: { inspection: CapabilityPluginInspection }[] }).inspections;
    expect(kept).toHaveLength(50);
    expect(kept.map((entry) => entry.inspection.inspectionId)).toEqual(
      Array.from({ length: 50 }, (_unused, offset) => `inspection-${String(52 - offset).padStart(3, "0")}`),
    );
    await expect(store.getInspection("inspection-expired")).resolves.toBeUndefined();
    await expect(store.getInspection("inspection-001")).resolves.toBeUndefined();
    await expect(store.getInspection("inspection-002")).resolves.toBeUndefined();
    await expect(store.getInspection("inspection-003")).resolves.toEqual({
      inspection: inspection(3),
      snapshotTreeSha256: "3".padStart(64, "0"),
    });

    // A kept inspection reads as gone once it runs out of time, before any write drops it.
    now = Date.parse(inspection(52).expiresAt);
    await expect(store.getInspection("inspection-052")).resolves.toBeUndefined();
  });

  it("retries on a concurrent write", async () => {
    const rows = new SettingRows();
    const store = new CapabilityPluginStore(rows, () => new Date(NOW));
    await store.update("first", () => plugin("first"));

    // Another Gateway process saves its plugin between this write's read and its compare-and-set.
    rows.beforeNextCompare = () => {
      const saved = rows.record!;
      const value = saved.value as { plugins: StoredPlugin[] };
      rows.record = {
        ...saved,
        value: { ...value, plugins: [...value.plugins, plugin("second")] },
        updatedAt: new Date(NOW + 500).toISOString(),
      };
    };
    let calls = 0;
    await store.update("first", (current) => {
      calls += 1;
      return current ? { ...current, state: "uninstalling" } : undefined;
    });

    expect(rows.refusedWrites).toBe(1);
    expect(calls).toBe(2);
    const saved = await store.list();
    expect(saved.map((item) => [item.pluginId, item.state])).toEqual([
      ["first", "uninstalling"],
      ["second", "installed"],
    ]);
  });

  it("removes a record when the change answers nothing, and refuses one that changes its id", async () => {
    const rows = new SettingRows();
    const store = new CapabilityPluginStore(rows, () => new Date(NOW));
    await store.update("first", () => plugin("first"));
    await store.update("second", () => plugin("second"));

    await store.update("first", () => undefined);
    await expect(store.update("second", (current) => current && { ...current, pluginId: "third" })).rejects.toThrow(
      "A plugin record can't change its id.",
    );

    await expect(store.get("first")).resolves.toBeUndefined();
    await expect(store.get("second")).resolves.toEqual(plugin("second"));
  });

  it("gives up with a plain conflict when every write keeps losing", async () => {
    const rows = new SettingRows();
    const store = new CapabilityPluginStore(rows, () => new Date(NOW));
    await store.update("first", () => plugin("first"));
    const compare = rows.compareAndSet.bind(rows);
    rows.compareAndSet = async () => undefined;

    await expect(store.update("first", (current) => current)).rejects.toMatchObject({
      code: "WRITE_CONFLICT",
      message: "Plugins changed while this was being saved. Try again.",
    });
    rows.compareAndSet = compare;
  });

  it("refuses to read or overwrite a saved value it doesn't recognise", async () => {
    const rows = new SettingRows();
    rows.record = { key: CAPABILITY_PLUGINS_SETTING_KEY, value: { version: 2, plugins: [] }, updatedAt: "x" };
    const store = new CapabilityPluginStore(rows, () => new Date(NOW));

    await expect(store.list()).rejects.toThrow("The saved plugin records can't be read.");
    await expect(store.update("first", () => plugin("first"))).rejects.toThrow(
      "The saved plugin records can't be read.",
    );
    expect(rows.writes).toBe(0);
  });

  it("finds an inspection by the scope and key that asked for it, until it runs out of time", async () => {
    const rows = new SettingRows();
    let now = NOW;
    const store = new CapabilityPluginStore(rows, () => new Date(now));
    const request = { actorScope: "operator-1", idempotencyKey: "inspect-1", payloadSha256: "f".repeat(64) };
    await store.saveInspection(inspection(1), "1".padStart(64, "0"), request);
    await store.saveInspection(inspection(2), "2".padStart(64, "0"));

    await expect(store.findInspectionByRequest("operator-1", "inspect-1")).resolves.toEqual({
      inspection: inspection(1),
      payloadSha256: "f".repeat(64),
    });
    await expect(store.findInspectionByRequest("operator-2", "inspect-1")).resolves.toBeUndefined();
    await expect(store.findInspectionByRequest("operator-1", "inspect-2")).resolves.toBeUndefined();
    // The request rides with the inspection it made, and nothing else changes about the kept inspection.
    await expect(store.getInspection("inspection-001")).resolves.toEqual({
      inspection: inspection(1),
      snapshotTreeSha256: "1".padStart(64, "0"),
    });

    // Without sign-in the scope is "", as the idempotency plugin's is: that is a scope of its own.
    const unsigned = { actorScope: "", idempotencyKey: "inspect-3", payloadSha256: "e".repeat(64) };
    await store.saveInspection(inspection(3), "3".padStart(64, "0"), unsigned);
    await expect(store.findInspectionByRequest("", "inspect-3")).resolves.toEqual({
      inspection: inspection(3),
      payloadSha256: "e".repeat(64),
    });
    await expect(store.findInspectionByRequest("operator-1", "inspect-3")).resolves.toBeUndefined();

    now = Date.parse(inspection(1).expiresAt);
    await expect(store.findInspectionByRequest("operator-1", "inspect-1")).resolves.toBeUndefined();
  });
});

describe("findPluginOwning", () => {
  it("finds the plugin that added a piece, never one that only kept it", () => {
    const adding = plugin("adding", {
      pieces: [{ pieceId: "notes", kind: "connector", owned: true, ref: "server-1" }],
    });
    const keeping = plugin("keeping", {
      pieces: [{ pieceId: "notes", kind: "connector", owned: false, ref: "server-2" }],
    });

    expect(findPluginOwning([keeping, adding], "connector", "server-1")).toBe(adding);
    expect(findPluginOwning([keeping, adding], "connector", "server-2")).toBeUndefined();
    expect(findPluginOwning([keeping, adding], "hook", "server-1")).toBeUndefined();
  });
});

describe("store changes", () => {
  it("tells each listener after a write lands, never after one that fails", async () => {
    const rows = new SettingRows();
    const store = new CapabilityPluginStore(rows, () => new Date(NOW));
    const heard: string[] = [];
    const stop = store.onChange(() => heard.push("first"));
    store.onChange(() => {
      heard.push("second");
      throw new Error("a listener's own failure");
    });

    await store.update("meeting-tools", () => plugin("meeting-tools"));
    await store.saveInspection(inspection(1), "1".padStart(64, "0"));
    expect(heard).toEqual(["first", "second", "first", "second"]);

    stop();
    await store.update("meeting-tools", () => undefined);
    expect(heard).toEqual(["first", "second", "first", "second", "second"]);

    rows.compareAndSet = async () => undefined;
    await expect(store.update("meeting-tools", () => plugin("meeting-tools"))).rejects.toMatchObject({
      code: "WRITE_CONFLICT",
    });
    expect(heard).toHaveLength(5);
  });
});

describe("readPluginPieceOwner", () => {
  it("names the plugin that added a piece from the saved records", async () => {
    const rows = new SettingRows();
    const store = new CapabilityPluginStore(rows);
    await store.update("meeting-tools", () =>
      plugin("meeting-tools", {
        name: "Meeting tools",
        pieces: [
          { pieceId: "tool-watch", kind: "hook", owned: true, ref: "hook-1" },
          { pieceId: "kept", kind: "hook", owned: false, ref: "hook-2" },
        ],
      }),
    );

    await expect(readPluginPieceOwner(rows, "hook", "hook-1")).resolves.toEqual({
      pluginId: "meeting-tools",
      name: "Meeting tools",
      installPlanId: "plan-meeting-tools",
    });
    await expect(readPluginPieceOwner(rows, "hook", "hook-2")).resolves.toBeUndefined();
    await expect(readPluginPieceOwner(new SettingRows(), "hook", "hook-1")).resolves.toBeUndefined();
  });
});

describe("pluginToolGroupHolds", () => {
  it("holds each group a plugin switched off itself, in any state, and never one it only kept", () => {
    const holding = plugin("holding", {
      name: "Holding",
      state: "uninstalling",
      pieces: [
        { pieceId: "no-git", kind: "tool_group_off", owned: true, ref: "git" },
        { pieceId: "no-browser", kind: "tool_group_off", owned: false, ref: "browser" },
        { pieceId: "pending", kind: "tool_group_off", owned: true },
        { pieceId: "server", kind: "connector", owned: true, ref: "files" },
      ],
    });
    const installing = plugin("installing", {
      name: "Installing",
      state: "installing",
      pieces: [{ pieceId: "no-files", kind: "tool_group_off", owned: true, ref: "files" }],
    });

    expect(pluginToolGroupHolds([holding, installing])).toEqual([
      { groupId: "git", pluginId: "holding", pluginName: "Holding" },
      { groupId: "files", pluginId: "installing", pluginName: "Installing" },
    ]);
    expect(pluginToolGroupHolds([])).toEqual([]);
  });
});

describe("removed plugins", () => {
  const removedAt = (index: number) => new Date(NOW + index * 1_000).toISOString();

  it("deletes a record and keeps its tombstone in the same write", async () => {
    const rows = new SettingRows();
    const store = new CapabilityPluginStore(rows, () => new Date(NOW));
    await store.update("first", () => plugin("first"));
    await store.update("second", () => plugin("second"));
    const writes = rows.writes;

    await store.remove("first", (current) => ({
      pluginId: current!.pluginId,
      name: current!.name,
      skillIds: ["extra:notes"],
      removedAt: removedAt(1),
    }));

    expect(rows.writes).toBe(writes + 1);
    await expect(store.get("first")).resolves.toBeUndefined();
    await expect(store.get("second")).resolves.toEqual(plugin("second"));
    await expect(store.listRemoved()).resolves.toEqual([
      { pluginId: "first", name: "Plugin first", skillIds: ["extra:notes"], removedAt: removedAt(1) },
    ]);
    // A refused removal writes nothing: the record stays and no tombstone is kept.
    await expect(
      store.remove("second", () => {
        throw new Error("Not this install's record.");
      }),
    ).rejects.toThrow("Not this install's record.");
    expect(rows.writes).toBe(writes + 1);
    await expect(store.get("second")).resolves.toEqual(plugin("second"));
  });

  it("drops the removed plugin's kept inspections in the same write, so none of them installs it again", async () => {
    const rows = new SettingRows();
    const store = new CapabilityPluginStore(rows, () => new Date(NOW));
    await store.update("meeting-tools", () => plugin("meeting-tools"));
    await store.saveInspection(inspection(1), "1".padStart(64, "0"));
    const other = inspection(2, { inspectionId: "inspection-other", pluginId: "other-tools" });
    await store.saveInspection(other, "2".padStart(64, "0"));
    const writes = rows.writes;

    await store.remove("meeting-tools", (current) => ({
      pluginId: current!.pluginId,
      name: current!.name,
      skillIds: [],
      removedAt: removedAt(1),
    }));

    expect(rows.writes).toBe(writes + 1);
    await expect(store.getInspection("inspection-001")).resolves.toBeUndefined();
    // Another plugin's inspection stays.
    await expect(store.getInspection("inspection-other")).resolves.toEqual({
      inspection: other,
      snapshotTreeSha256: "2".padStart(64, "0"),
    });
  });

  it("keeps the newest 100 tombstones, and reads a row without any as none", async () => {
    const rows = new SettingRows();
    const store = new CapabilityPluginStore(rows, () => new Date(NOW));
    await store.update("first", () => plugin("first"));
    // A row written before tombstones existed holds none.
    await expect(store.listRemoved()).resolves.toEqual([]);

    for (let index = 1; index <= 101; index += 1) {
      await store.update(`plugin-${index}`, () => plugin(`plugin-${index}`));
      await store.remove(`plugin-${index}`, () => ({
        pluginId: `plugin-${index}`,
        name: `Plugin ${index}`,
        skillIds: [],
        removedAt: removedAt(index),
      }));
    }

    const removed = await store.listRemoved();
    expect(removed).toHaveLength(100);
    expect(removed[0]?.pluginId).toBe("plugin-101");
    expect(removed.at(-1)?.pluginId).toBe("plugin-2");
    // Records and inspections are kept as they were.
    await expect(store.get("first")).resolves.toEqual(plugin("first"));
  });

  it("refuses a tombstone list it doesn't recognise, rather than reading it as none", async () => {
    const rows = new SettingRows();
    rows.record = {
      key: CAPABILITY_PLUGINS_SETTING_KEY,
      value: { version: 1, plugins: [], inspections: [], removed: [{ pluginId: 7 }] },
      updatedAt: "x",
    };
    const store = new CapabilityPluginStore(rows, () => new Date(NOW));

    await expect(store.listRemoved()).rejects.toThrow("The saved plugin records can't be read.");
    await expect(store.list()).rejects.toThrow("The saved plugin records can't be read.");
  });

  it("names the skills each uninstalled plugin removed, the newest uninstall first", () => {
    expect(
      removedPluginSkills([
        { pluginId: "second", name: "Second", skillIds: ["extra:notes"], removedAt: removedAt(2) },
        { pluginId: "first", name: "First", skillIds: ["extra:notes", "extra:digest"], removedAt: removedAt(1) },
      ]),
    ).toEqual(
      new Map([
        ["extra:notes", { name: "Second" }],
        ["extra:digest", { name: "First" }],
      ]),
    );
  });
});
