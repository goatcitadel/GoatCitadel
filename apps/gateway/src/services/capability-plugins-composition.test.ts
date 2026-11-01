import fs, { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolPolicyConfig } from "@goatcitadel/contracts";
import {
  PLUGIN_TOOL_GROUP_HOLDS_UNAVAILABLE_REASON_CODE,
  ToolPolicyEngine,
  type PluginToolGroupHold,
} from "@goatcitadel/policy-engine";
import type { AsyncStorage } from "@goatcitadel/storage";
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
  /** A policy where nothing but a tool group's switch or a hold can stop a tool. */
  const ENGINE_CONFIG: ToolPolicyConfig = {
    tools: { approvalMode: "bypass", allow: ["*"], deny: [] },
    agents: {},
    sandbox: {
      writeJailRoots: ["."],
      readOnlyRoots: [],
      networkAllowlist: [],
      riskyShellPatterns: [],
      requireApprovalForRiskyShell: true,
    },
  };

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

  /**
   * The feed over a real store and a real policy engine, wired as the composition wires them, with the waits between
   * first reads skipped. Each background wait is held until the test lets it go, and `closing` stands for the Gateway's.
   */
  function feed(store: CapabilityPluginStore, readPlugins: () => Promise<StoredPlugin[]> = () => store.list()) {
    const engine = new ToolPolicyEngine(ENGINE_CONFIG, {} as AsyncStorage);
    const setHolds = vi.fn((held: readonly PluginToolGroupHold[]) => engine.setPluginToolGroupHolds(held));
    const setHoldsUnavailable = vi.fn(() => engine.setPluginToolGroupHoldsUnavailable());
    const report = vi.fn();
    const reportFirstReadFailure = vi.fn();
    const wait = vi.fn(async (_ms: number) => undefined);
    const backgroundWaits: Array<() => void> = [];
    const waitInBackground = vi.fn(
      (_ms: number) => new Promise<void>((resolve) => backgroundWaits.push(() => resolve())),
    );
    const gateway = { closing: false };
    const holds = feedPluginToolGroupHolds({
      readPlugins,
      onStoreChange: (listener) => store.onChange(listener),
      setHolds,
      setHoldsUnavailable,
      report,
      reportFirstReadFailure,
      wait,
      waitInBackground,
      isClosing: () => gateway.closing,
    });
    /** Ends the oldest background wait and lets the read it was waiting for run. */
    const endBackgroundWait = async (): Promise<void> => {
      const end = backgroundWaits.shift();
      if (!end) throw new Error("No background wait is pending.");
      end();
      // The fake store reads through promises only, so they all settle before the next turn of the event loop.
      await new Promise((resolve) => setImmediate(resolve));
    };
    return {
      holds,
      fed: holds.load(),
      engine,
      setHolds,
      setHoldsUnavailable,
      report,
      reportFirstReadFailure,
      wait,
      waitInBackground,
      backgroundWaits,
      endBackgroundWait,
      gateway,
    };
  }

  /** True when the engine denies the tool because no read of the holds has landed. */
  async function keptOffUnread(engine: ToolPolicyEngine, toolName: string): Promise<boolean> {
    // Only a switched-off tool is inspected: its denial comes before any read of the engine's storage.
    if (!engine.listSwitchedOffToolNames().has(toolName)) return false;
    const access = await engine.inspectAccess({ toolName, args: {}, agentId: "assistant", sessionId: "s" });
    return !access.allowed && access.reasonCodes.includes(PLUGIN_TOOL_GROUP_HOLDS_UNAVAILABLE_REASON_CODE);
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
    // Nothing is lifted because a read failed, and the holds read stay known: nothing else is kept off.
    expect(policy.setHolds).toHaveBeenCalledTimes(1);
    expect(policy.reportFirstReadFailure).not.toHaveBeenCalled();
    expect(policy.setHoldsUnavailable).not.toHaveBeenCalled();
    expect(policy.engine.listSwitchedOffToolNames().has("git.status")).toBe(true);
    expect(policy.engine.listSwitchedOffToolNames().has("browser.navigate")).toBe(false);
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
    expect(policy.setHoldsUnavailable).not.toHaveBeenCalled();
    expect(policy.waitInBackground).not.toHaveBeenCalled();
  });

  it("keeps every tool a plugin could hold off when the first read keeps failing, and startup still goes on", async () => {
    const store = new CapabilityPluginStore(settingRows());
    let reads = 0;
    const policy = feed(store, async () => {
      reads += 1;
      throw new Error("The saved plugin records can't be read.");
    });

    // `load` settles after the three tries, so startup is never blocked.
    await policy.fed;

    expect(reads).toBe(3);
    expect(policy.reportFirstReadFailure).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: "The saved plugin records can't be read." }),
    );
    expect(policy.setHoldsUnavailable).toHaveBeenCalledOnce();
    expect(policy.setHolds).not.toHaveBeenCalled();
    // Fail closed: a group no record could be read for is off all the same, and Core stays on.
    for (const toolName of ["browser.navigate", "git.status", "fs.write", "shell.exec"]) {
      expect(await keptOffUnread(policy.engine, toolName), toolName).toBe(true);
    }
    expect(policy.engine.listSwitchedOffToolNames().has("session.status")).toBe(false);
    // The next read waits in the background, not in startup.
    expect(policy.waitInBackground.mock.calls.map(([ms]) => ms)).toEqual([5_000]);
  });

  it("reads again in the background after 5 s, 15 s and then every minute, and a read that lands ends it", async () => {
    const store = new CapabilityPluginStore(settingRows());
    await store.update("meeting-tools", () => holding(["git"]));
    let readable = false;
    const policy = feed(store, async () => {
      if (!readable) throw new Error("The saved plugin records can't be read.");
      return await store.list();
    });
    await policy.fed;
    expect(await keptOffUnread(policy.engine, "browser.navigate")).toBe(true);

    for (const nextWait of [15_000, 60_000, 60_000]) {
      await policy.endBackgroundWait();
      expect(policy.waitInBackground.mock.calls.at(-1)?.[0]).toBe(nextWait);
    }
    // Each background read that failed is reported, and nothing is lifted.
    expect(policy.report).toHaveBeenCalledTimes(3);
    expect(policy.setHolds).not.toHaveBeenCalled();
    expect(await keptOffUnread(policy.engine, "browser.navigate")).toBe(true);

    readable = true;
    await policy.endBackgroundWait();

    expect(policy.setHolds).toHaveBeenCalledExactlyOnceWith([
      { groupId: "git", pluginId: "meeting-tools", pluginName: "Meeting tools" },
    ]);
    // The read set the holds, which ends the unavailable state: only the held group stays off.
    expect(await keptOffUnread(policy.engine, "browser.navigate")).toBe(false);
    expect(policy.engine.listSwitchedOffToolNames().has("browser.navigate")).toBe(false);
    expect(policy.engine.listSwitchedOffToolNames().has("git.status")).toBe(true);
    // The loop is done: it asks for no further wait.
    expect(policy.waitInBackground).toHaveBeenCalledTimes(4);
    expect(policy.backgroundWaits).toHaveLength(0);
  });

  it("ends the unavailable state when a store write's read lands, and the background reads stop", async () => {
    const store = new CapabilityPluginStore(settingRows());
    let readable = false;
    let reads = 0;
    const policy = feed(store, async () => {
      reads += 1;
      if (!readable) throw new Error("The saved plugin records can't be read.");
      return await store.list();
    });
    await policy.fed;
    expect(await keptOffUnread(policy.engine, "browser.navigate")).toBe(true);

    readable = true;
    await store.update("meeting-tools", () => holding(["browser"]));
    await vi.waitFor(() =>
      expect(policy.setHolds).toHaveBeenCalledWith([
        { groupId: "browser", pluginId: "meeting-tools", pluginName: "Meeting tools" },
      ]),
    );
    expect(await keptOffUnread(policy.engine, "git.status")).toBe(false);
    expect(policy.engine.listSwitchedOffToolNames().has("git.status")).toBe(false);
    expect(policy.engine.listSwitchedOffToolNames().has("browser.navigate")).toBe(true);

    const readsSoFar = reads;
    await policy.endBackgroundWait();
    // The pending background wait ends with no read and no new wait.
    expect(reads).toBe(readsSoFar);
    expect(policy.waitInBackground).toHaveBeenCalledOnce();
    expect(policy.setHolds).toHaveBeenCalledOnce();
  });

  it("stops reading in the background once the Gateway closes", async () => {
    const store = new CapabilityPluginStore(settingRows());
    let reads = 0;
    const policy = feed(store, async () => {
      reads += 1;
      throw new Error("The saved plugin records can't be read.");
    });
    await policy.fed;
    await policy.endBackgroundWait();
    expect(reads).toBe(4);
    expect(policy.waitInBackground).toHaveBeenCalledTimes(2);

    policy.gateway.closing = true;
    await policy.endBackgroundWait();

    expect(reads).toBe(4);
    expect(policy.waitInBackground).toHaveBeenCalledTimes(2);
    expect(policy.backgroundWaits).toHaveLength(0);
    // Closing lifts nothing: the tools stay off.
    expect(await keptOffUnread(policy.engine, "browser.navigate")).toBe(true);
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
