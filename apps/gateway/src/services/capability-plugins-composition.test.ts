import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  feedPluginToolGroupHolds,
  gatewayVersionForReviewKeys,
  operatorSwitchedOffToolGroups,
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

  /** The feed over a real store, wired as the composition wires it. */
  function feed(store: CapabilityPluginStore) {
    const setHolds = vi.fn();
    const report = vi.fn();
    const fed = feedPluginToolGroupHolds({
      readPlugins: () => store.list(),
      onStoreChange: (listener) => store.onChange(listener),
      setHolds,
      report,
    });
    return { fed, setHolds, report };
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
  });

  it("keeps the last holds it read, and reports the failure, when the store can't be read", async () => {
    const rows = settingRows();
    const store = new CapabilityPluginStore(rows);
    await store.update("meeting-tools", () => holding(["git"]));
    const policy = feed(store);
    await policy.fed;
    expect(policy.setHolds).toHaveBeenCalledTimes(1);

    // Another reader of the same unreadable row: its first read fails, and nothing is lifted.
    rows.record = { key: rows.record!.key, value: { version: 2 }, updatedAt: "unreadable" };
    const later = feed(store);
    await later.fed;

    expect(later.setHolds).not.toHaveBeenCalled();
    expect(later.report).toHaveBeenCalledWith(
      expect.objectContaining({ message: "The saved plugin records can't be read." }),
    );
    expect(policy.setHolds).toHaveBeenCalledTimes(1);
  });
});

describe("operatorSwitchedOffToolGroups", () => {
  it("reads the operator's own switch, never a plugin's hold", () => {
    const toolPolicy = { tools: { allow: [], deny: [], disabledGroups: ["browser", "core", "git"] } };
    expect(operatorSwitchedOffToolGroups({ toolPolicy })).toEqual(["git", "browser"]);
    expect(operatorSwitchedOffToolGroups({ toolPolicy: { tools: { allow: [], deny: [] } } })).toEqual([]);
  });
});
