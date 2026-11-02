import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claudeCodeSkillMarkdown, writeClaudeCodePluginFixture } from "./claude-code-plugin.test-support.js";
import { MCP_SERVER_TEMPLATES } from "./mcp-server-templates.js";
import {
  readInstalledPluginManifest,
  readSnapshotManifestParse,
  readSnapshotPluginManifest,
} from "./plugin-snapshot-manifest.js";

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

describe("the manifest an install and an installed plugin read", () => {
  const LEARN = { learn: { type: "http", url: "https://learn.microsoft.com/api/mcp" } };
  const withoutLearn = MCP_SERVER_TEMPLATES.filter((template) => template.templateId !== "microsoft-learn");

  async function writeKit(): Promise<void> {
    await writeClaudeCodePluginFixture(dir, {
      pluginJson: { name: "cc-kit" },
      skills: { a: claudeCodeSkillMarkdown("a") },
      mcpJson: { mcpServers: LEARN },
    });
  }

  function fresh(templates = MCP_SERVER_TEMPLATES) {
    return readSnapshotManifestParse({ snapshotDir: dir, treeSha256: TREE, templates });
  }

  it("answers a fresh translation with its text, so a changed catalog gives another hash", async () => {
    await writeKit();
    const checked = await fresh();
    expect(checked).toMatchObject({ ok: true, claudeCode: { translatorVersion: 1 } });
    if (!checked.ok) return;
    expect(sha256(checked.claudeCode!.manifestText)).toBe(checked.manifestSha256);
    expect(checked.manifest.pieces.map((piece) => piece.kind)).toEqual(["skill", "connector"]);

    const later = await fresh(withoutLearn);
    expect(later).toMatchObject({ ok: true });
    if (!later.ok) return;
    expect(later.manifestSha256).not.toBe(checked.manifestSha256);
  });

  it("answers a GoatCitadel manifest with no translation", async () => {
    await writeClaudeCodePluginFixture(dir, {
      skills: { a: claudeCodeSkillMarkdown("a") },
      files: { "goatcitadel-plugin.json": JSON.stringify(NATIVE) },
    });
    const parsed = await fresh();
    expect(parsed).toMatchObject({ ok: true, manifest: { pluginId: "native-kit" } });
    expect(parsed).not.toHaveProperty("claudeCode");
  });

  it("reads an installed plugin's manifest from its record after the translation changes", async () => {
    await writeKit();
    const installed = await fresh();
    if (!installed.ok) throw new Error("The fixture is refused.");
    const record = {
      snapshotTreeSha256: TREE,
      claudeCode: { ...installed.claudeCode!, ignored: [], coverage: { usable: 2, total: 2 } },
    };
    const readFresh = vi.fn(() => fresh(withoutLearn));

    const parsed = await readInstalledPluginManifest(TREE, [record], readFresh);

    expect(readFresh).not.toHaveBeenCalled();
    expect(parsed).toMatchObject({ ok: true, manifestSha256: installed.manifestSha256 });
    if (!parsed.ok) return;
    expect(parsed.manifest.pieces.map((piece) => piece.id)).toEqual(installed.manifest.pieces.map((piece) => piece.id));
  });

  it("decides another plugin's kept connector from the record during an uninstall", async () => {
    // The uninstall scope reads each other plugin through the same reader: its kept connector still names its template.
    await writeKit();
    const installed = await fresh();
    if (!installed.ok) throw new Error("The fixture is refused.");
    const other = {
      snapshotTreeSha256: TREE,
      claudeCode: { ...installed.claudeCode!, ignored: [], coverage: { usable: 2, total: 2 } },
    };
    const parsed = await readInstalledPluginManifest(TREE, [other], () => fresh(withoutLearn));
    expect(parsed.ok && parsed.manifest.pieces.find((piece) => piece.kind === "connector")).toMatchObject({
      templateId: "microsoft-learn",
    });
  });

  it("reads a record without a kept translation fresh", async () => {
    const readFresh = vi.fn(async () => ({ ok: false as const, code: "MANIFEST_MISSING" as const, message: "x" }));
    await readInstalledPluginManifest(TREE, [{ snapshotTreeSha256: TREE }], readFresh);
    expect(readFresh).toHaveBeenCalledExactlyOnceWith(TREE);
  });
});

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
