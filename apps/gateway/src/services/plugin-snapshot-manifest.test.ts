import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeCodeSkillMarkdown, writeClaudeCodePluginFixture } from "./claude-code-plugin.test-support.js";
import { MCP_SERVER_TEMPLATES } from "./mcp-server-templates.js";
import { readSnapshotPluginManifest } from "./plugin-snapshot-manifest.js";

const TREE = "a".repeat(64);
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "snapshot-manifest-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function read(sourceKind: "folder" | "built_in" = "folder") {
  return readSnapshotPluginManifest({
    snapshotDir: dir,
    treeSha256: TREE,
    templates: MCP_SERVER_TEMPLATES,
    sourceKind,
  });
}

const NATIVE = {
  schemaVersion: 1,
  pluginId: "native-kit",
  name: "Native kit",
  description: "Its own manifest.",
  version: "1.0.0",
  pieces: [{ kind: "skill", id: "a", path: "skills/a" }],
};

describe("readSnapshotPluginManifest", () => {
  it("reads a goatcitadel-plugin.json first when both manifests are there", async () => {
    await writeClaudeCodePluginFixture(dir, {
      pluginJson: { name: "cc-kit" },
      skills: { a: claudeCodeSkillMarkdown("a") },
      files: { "goatcitadel-plugin.json": JSON.stringify(NATIVE), "commands/x.md": "X." },
    });
    const reading = await read();
    expect(reading.format).toBe("goatcitadel");
    expect(reading.parsed).toMatchObject({ ok: true, manifest: { pluginId: "native-kit" } });
    expect(reading).not.toHaveProperty("ignored");
  });

  it("translates when only plugin.json is there", async () => {
    await writeClaudeCodePluginFixture(dir, {
      pluginJson: { name: "cc-kit" },
      skills: { a: claudeCodeSkillMarkdown("a") },
      files: { "commands/x.md": "X." },
    });
    const reading = await read();
    expect(reading.format).toBe("claude_code");
    if (reading.format !== "claude_code") return;
    expect(reading.parsed).toMatchObject({ ok: true, manifest: { pluginId: "cc-kit" } });
    expect(reading.translation?.coverage).toEqual({ usable: 1, total: 2 });
    expect(reading.ignored.map((part) => part.label)).toEqual(["x"]);
  });

  it("answers a refused translation with its code and left-out list", async () => {
    await writeClaudeCodePluginFixture(dir, { pluginJson: { name: "cc-kit" }, files: { "agents/a.md": "A." } });
    const reading = await read();
    expect(reading).toMatchObject({
      format: "claude_code",
      parsed: { ok: false, code: "NOTHING_TO_INSTALL", message: "GoatCitadel can't use any of this plugin's parts." },
    });
    if (reading.format !== "claude_code") return;
    expect(reading.translation).toBeUndefined();
    expect(reading.ignored.map((part) => part.kind)).toEqual(["agent"]);
  });

  it("answers MANIFEST_MISSING when neither is there", async () => {
    await writeClaudeCodePluginFixture(dir, { skills: { a: claudeCodeSkillMarkdown("a") } });
    const reading = await read();
    expect(reading.format).toBe("goatcitadel");
    expect(reading.parsed).toMatchObject({ ok: false, code: "MANIFEST_MISSING" });
  });

  it("never translates a built-in source", async () => {
    await writeClaudeCodePluginFixture(dir, {
      pluginJson: { name: "cc-kit" },
      skills: { a: claudeCodeSkillMarkdown("a") },
    });
    const reading = await read("built_in");
    expect(reading.format).toBe("goatcitadel");
    expect(reading.parsed).toMatchObject({ ok: false, code: "MANIFEST_MISSING" });
  });

  it("doesn't take a plugin.json that isn't a plain file", async () => {
    await mkdir(path.join(dir, ".claude-plugin", "plugin.json"), { recursive: true });
    await writeFile(path.join(dir, "README.md"), "x");
    expect((await read()).parsed).toMatchObject({ ok: false, code: "MANIFEST_MISSING" });
  });
});
