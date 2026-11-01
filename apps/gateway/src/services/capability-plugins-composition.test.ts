import fs, { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginSnapshotStore } from "./plugin-snapshot-store.js";
import {
  feedPluginToolGroupHolds,
  gatewayVersionForReviewKeys,
  operatorSwitchedOffToolGroups,
  reclaimPluginStorage,
  readGatewayVersion,
  UNVERSIONED_REVIEW_KEY_LABEL,
} from "./capability-plugins-composition.js";
import {
  CapabilityPluginStore,
  type CapabilityPluginSettingRecord,
  type CapabilityPluginSettingRows,
  type StoredPlugin,
} from "./capability-plugin-store.js";

describe("readGatewayVersion", () => {
  it("reads the Gateway package's own version", () => {
    const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
      name: string;
      version: string;
    };
    expect(manifest.name).toBe("@goatcitadel/gateway");
    expect(readGatewayVersion()).toBe(manifest.version);
  });

  it("reads it once from the package file two folders up, as from src and from dist", () => {
    const asked: string[] = [];
    const version = readGatewayVersion((specifier) => {
      asked.push(specifier);
      return { version: "2.3.0-beta.4+build.7" };
    });
    expect(version).toBe("2.3.0-beta.4+build.7");
    expect(asked).toEqual(["../../package.json"]);
  });

  it("refuses a version that can't name a review key, rather than making one up", () => {
    for (const manifest of [{}, { version: "" }, { version: "1.0 beta" }, { version: "x".repeat(65) }, undefined]) {
      expect(() => readGatewayVersion(() => manifest), JSON.stringify(manifest)).toThrow(
        "The Gateway package's version can't name a plugin skill's review key.",
      );
    }
  });
});

describe("gatewayVersionForReviewKeys", () => {
  it("uses the Gateway package's version when it can be read", () => {
    expect(gatewayVersionForReviewKeys(() => "2.3.0")).toBe("2.3.0");
  });

  it("falls back to a fixed label instead of stopping the Gateway when the version can't be read", () => {
    const label = gatewayVersionForReviewKeys(() => {
      throw new Error("The Gateway package's version can't name a plugin skill's review key.");
    });
    expect(label).toBe(UNVERSIONED_REVIEW_KEY_LABEL);
    expect(readGatewayVersion(() => ({ version: label }))).toBe(label);
  });
});

describe("feedPluginToolGroupHolds", () => {
  /** One `system_settings` row with the repository's compare-and-set rule. */
  function settingRows(): CapabilityPluginSettingRows & { record?: CapabilityPluginSettingRecord } {
    let clock = 0;
    const rows: CapabilityPluginSettingRows & { record?: CapabilityPluginSettingRecord } = {
      get: async () => (rows.record ? structuredClone(rows.record) : undefined),
      compareAndSet: async (key, expected, value) => {
        if ((expected?.updatedAt ?? undefined) !== rows.record?.updatedAt) return undefined;
        rows.record = { key, value: structuredClone(value), updatedAt: String(++clock) };
        return structuredClone(rows.record);
      },
    };
    return rows;
  }

  function holding(groupIds: string[]): StoredPlugin {
    return {
      pluginId: "meeting-tools",
      name: "Meeting tools",
      description: "Notes and checks for meetings.",
      version: "1.0.0",
      trust: "built_in",
      sourceKind: "built_in",
      sourceDisplay: "Ships with GoatCitadel",
      pin: { kind: "content", treeSha256: "a".repeat(64) },
      manifestSha256: "b".repeat(64),
      snapshotTreeSha256: "a".repeat(64),
      workspaceId: "default",
      installPlanId: "plan-1",
      state: "installed",
      installedAt: "2026-10-31T00:00:00.000Z",
      pieces: groupIds.map((groupId) => ({
        pieceId: `no-${groupId}`,
        kind: "tool_group_off",
        owned: true,
        ref: groupId,
      })),
    };
  }

  /** The feed over a real store, wired as the composition wires it, with the waits between first reads skipped. */
  function feed(store: CapabilityPluginStore, readPlugins: () => Promise<StoredPlugin[]> = () => store.list()) {
    const setHolds = vi.fn();
    const report = vi.fn();
    const reportFirstReadFailure = vi.fn();
    const wait = vi.fn(async (_ms: number) => undefined);
    const holds = feedPluginToolGroupHolds({
      readPlugins,
      onStoreChange: (listener) => store.onChange(listener),
      setHolds,
      report,
      reportFirstReadFailure,
      wait,
    });
    return { holds, fed: holds.load(), setHolds, report, reportFirstReadFailure, wait };
  }

  it("loads the holds at startup and reads them again after every write to the store", async () => {
    const rows = settingRows();
    await new CapabilityPluginStore(rows).update("meeting-tools", () => holding(["git"]));
    const store = new CapabilityPluginStore(rows);
    const policy = feed(store);

    await policy.fed;
    expect(policy.setHolds).toHaveBeenLastCalledWith([
      { groupId: "git", pluginId: "meeting-tools", pluginName: "Meeting tools" },
    ]);

    await store.update("meeting-tools", () => holding(["git", "browser"]));
    await vi.waitFor(() =>
      expect(policy.setHolds).toHaveBeenLastCalledWith([
        { groupId: "git", pluginId: "meeting-tools", pluginName: "Meeting tools" },
        { groupId: "browser", pluginId: "meeting-tools", pluginName: "Meeting tools" },
      ]),
    );

    await store.update("meeting-tools", () => undefined);
    await vi.waitFor(() => expect(policy.setHolds).toHaveBeenLastCalledWith([]));
    expect(policy.report).not.toHaveBeenCalled();
    // The first read happens once, however often startup asks for it.
    await policy.holds.load();
    expect(policy.wait).not.toHaveBeenCalled();
  });

  it("keeps the last holds it read, and reports the failure, when the store can't be read", async () => {
    const store = new CapabilityPluginStore(settingRows());
    await store.update("meeting-tools", () => holding(["git"]));
    let readable = true;
    const policy = feed(store, async () => {
      if (!readable) throw new Error("The saved plugin records can't be read.");
      return await store.list();
    });
    await policy.fed;
    expect(policy.setHolds).toHaveBeenCalledTimes(1);

    readable = false;
    await store.update("meeting-tools", () => holding([]));
    await vi.waitFor(() =>
      expect(policy.report).toHaveBeenCalledWith(
        expect.objectContaining({ message: "The saved plugin records can't be read." }),
      ),
    );
    // Nothing is lifted because a read failed.
    expect(policy.setHolds).toHaveBeenCalledTimes(1);
    expect(policy.reportFirstReadFailure).not.toHaveBeenCalled();
  });

  it("reads again when the first read fails, so the holds are set before startup goes on", async () => {
    const store = new CapabilityPluginStore(settingRows());
    await store.update("meeting-tools", () => holding(["git"]));
    let calls = 0;
    const policy = feed(store, async () => {
      calls += 1;
      if (calls < 3) throw new Error("The database isn't ready yet.");
      return await store.list();
    });

    await policy.fed;

    expect(calls).toBe(3);
    expect(policy.wait.mock.calls.map(([ms]) => ms)).toEqual([250, 1000]);
    expect(policy.setHolds).toHaveBeenCalledExactlyOnceWith([
      { groupId: "git", pluginId: "meeting-tools", pluginName: "Meeting tools" },
    ]);
    expect(policy.reportFirstReadFailure).not.toHaveBeenCalled();
  });

  it("reports a first read that keeps failing, and sets the holds once a later write can be read", async () => {
    const store = new CapabilityPluginStore(settingRows());
    let readable = false;
    const policy = feed(store, async () => {
      if (!readable) throw new Error("The saved plugin records can't be read.");
      return await store.list();
    });

    await policy.fed;

    expect(policy.reportFirstReadFailure).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: "The saved plugin records can't be read." }),
    );
    expect(policy.setHolds).not.toHaveBeenCalled();

    readable = true;
    await store.update("meeting-tools", () => holding(["browser"]));
    await vi.waitFor(() =>
      expect(policy.setHolds).toHaveBeenCalledWith([
        { groupId: "browser", pluginId: "meeting-tools", pluginName: "Meeting tools" },
      ]),
    );
  });
});

describe("operatorSwitchedOffToolGroups", () => {
  it("reads the operator's own switch, never a plugin's hold", () => {
    const toolPolicy = { tools: { allow: [], deny: [], disabledGroups: ["browser", "core", "git"] } };
    expect(operatorSwitchedOffToolGroups({ toolPolicy })).toEqual(["git", "browser"]);
    expect(operatorSwitchedOffToolGroups({ toolPolicy: { tools: { allow: [], deny: [] } } })).toEqual([]);
  });
});

describe("reclaimPluginStorage", () => {
  const scratch: string[] = [];
  afterEach(() => {
    for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function makeSource(root: string, name: string): string {
    const dir = path.join(root, "src", name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "a.txt"), name);
    return dir;
  }

  it("clears temp copies and orphan snapshots but keeps one an installed plugin references", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "goat-plugin-reclaim-"));
    scratch.push(root);
    const snapshots = new PluginSnapshotStore(path.join(root, "snapshots"));
    const tempRoot = path.join(root, "tmp");
    fs.mkdirSync(path.join(tempRoot, "git-abc"), { recursive: true });
    fs.mkdirSync(path.join(tempRoot, "copy-def"), { recursive: true });
    fs.writeFileSync(path.join(tempRoot, "copy-def", "x.txt"), "x");
    const kept = await snapshots.importDirectory(makeSource(root, "kept"));
    const orphan = await snapshots.importDirectory(makeSource(root, "orphan"));
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(kept.dir, old, old);
    fs.utimesSync(orphan.dir, old, old);
    await reclaimPluginStorage(
      tempRoot,
      async () => new Set([kept.treeSha256]),
      (keep, options) => snapshots.sweep(keep, options),
    );

    expect(fs.readdirSync(tempRoot)).toEqual([]);
    expect(snapshots.resolve(kept.treeSha256)).toBe(kept.dir);
    expect(() => snapshots.resolve(orphan.treeSha256)).toThrow();
  });

  it("logs and swallows a failure instead of blocking boot", async () => {
    await expect(
      reclaimPluginStorage(
        path.join(os.tmpdir(), "goat-plugin-reclaim-missing"),
        async () => {
          throw new Error("settings unreadable");
        },
        async () => ({ removed: [] }),
      ),
    ).resolves.toBeUndefined();
  });
});
