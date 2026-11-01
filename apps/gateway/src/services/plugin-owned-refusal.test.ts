import { describe, expect, it } from "vitest";
import { isGoatError } from "@goatcitadel/contracts";
import type { StoredPlugin } from "./capability-plugin-store.js";
import {
  PluginOwnedError,
  assertPromptPackIdNotFromPlugin,
  assertSkillHubSnapshotNotFromPlugin,
  isPluginOwnedError,
  namePluginOwnedError,
} from "./plugin-owned-refusal.js";

const MEETING_TOOLS = { pluginId: "meeting-tools", name: "Meeting tools" };

describe("PluginOwnedError", () => {
  it("is a 409 that names the plugin to uninstall", () => {
    const error = new PluginOwnedError(MEETING_TOOLS);

    expect(isGoatError(error)).toBe(true);
    expect(isPluginOwnedError(error)).toBe(true);
    expect(error).toMatchObject({ name: "PluginOwnedError", code: "PLUGIN_OWNED", httpStatus: 409 });
    expect(error.toJSON()).toEqual({
      error: "From Meeting tools. Uninstall it to remove this.",
      code: "PLUGIN_OWNED",
      details: { pluginId: "meeting-tools" },
    });
    expect(error.unnamedPiece).toBeUndefined();
    expect(isPluginOwnedError(new Error("From Meeting tools."))).toBe(false);
  });

  it("says a piece came with a plugin that isn't installed when the plugin can't be named", () => {
    expect(new PluginOwnedError({ kind: "skill", ref: "snapshot-1", pluginId: "meeting-tools" }).toJSON()).toEqual({
      error: "This skill came with a plugin that isn't installed.",
      code: "PLUGIN_OWNED",
      details: { pluginId: "meeting-tools" },
    });
    expect(new PluginOwnedError({ kind: "prompt_pack", ref: "plugin-meeting-tools-checks" }).toJSON()).toEqual({
      error: "This prompt pack came with a plugin that isn't installed.",
      code: "PLUGIN_OWNED",
    });
  });
});

describe("namePluginOwnedError", () => {
  const installed = {
    pluginId: "meeting-tools",
    name: "Meeting tools",
    pieces: [{ pieceId: "checks", kind: "prompt_pack", owned: true, ref: "plugin-meeting-tools-checks" }],
  } as StoredPlugin;

  it("names the installed plugin from its record, and leaves a refusal it can't name as it was", () => {
    const skill = new PluginOwnedError({ kind: "skill", ref: "snapshot-1", pluginId: "meeting-tools" });
    const pack = new PluginOwnedError({ kind: "prompt_pack", ref: "plugin-meeting-tools-checks" });
    const strayPack = new PluginOwnedError({ kind: "prompt_pack", ref: "plugin-gone-checks" });
    const named = new PluginOwnedError(MEETING_TOOLS);

    expect(namePluginOwnedError(skill, [installed]).toJSON()).toEqual(named.toJSON());
    expect(namePluginOwnedError(pack, [installed]).toJSON()).toEqual(named.toJSON());
    expect(namePluginOwnedError(strayPack, [installed])).toBe(strayPack);
    expect(namePluginOwnedError(skill, [])).toBe(skill);
    expect(namePluginOwnedError(named, [])).toBe(named);
  });
});

describe("the id and source checks", () => {
  it("refuses a plugin- prompt pack id unless the create-only key is that same id", () => {
    expect(() => assertPromptPackIdNotFromPlugin(undefined)).not.toThrow();
    expect(() => assertPromptPackIdNotFromPlugin("pack-1")).not.toThrow();
    expect(() => assertPromptPackIdNotFromPlugin("my-plugin-pack")).not.toThrow();
    expect(() => assertPromptPackIdNotFromPlugin("plugin-a-b")).toThrow(PluginOwnedError);
    expect(() => assertPromptPackIdNotFromPlugin("plugin-a-b", "plugin-a-c")).toThrow(PluginOwnedError);
    expect(() => assertPromptPackIdNotFromPlugin("plugin-a-b", "plugin-a-b")).not.toThrow();
  });

  it("refuses a Skill Hub check that came with a plugin unless that plugin's own pass is given", () => {
    const check = {
      snapshotId: "snapshot-1",
      sourceProvider: "goatcitadel_plugin",
      sourceRef: "plugin:meeting-tools/notes@content:x",
    };
    expect(() => assertSkillHubSnapshotNotFromPlugin({ ...check, sourceProvider: "clawhub" })).not.toThrow();
    expect(() => assertSkillHubSnapshotNotFromPlugin(check)).toThrow(
      expect.objectContaining({ code: "PLUGIN_OWNED", details: { pluginId: "meeting-tools" } }),
    );
    expect(() => assertSkillHubSnapshotNotFromPlugin(check, { pluginId: "other" })).toThrow(PluginOwnedError);
    expect(() => assertSkillHubSnapshotNotFromPlugin(check, { pluginId: "meeting-tools" })).not.toThrow();
    // A plugin check whose source can't be read is refused, and no pass opens it.
    const unreadable = { ...check, sourceRef: "somewhere-else" };
    expect(() => assertSkillHubSnapshotNotFromPlugin(unreadable, { pluginId: "meeting-tools" })).toThrow(
      expect.objectContaining({ code: "PLUGIN_OWNED", details: undefined }),
    );
  });
});
