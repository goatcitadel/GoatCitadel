import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parsePluginManifest } from "@goatcitadel/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  claudeCodeSkillMarkdown,
  writeClaudeCodePluginFixture,
  type ClaudeCodePluginFixture,
} from "./claude-code-plugin.test-support.js";
import { translateClaudeCodePlugin, type ClaudeCodeTranslationResult } from "./claude-code-plugin-translator.js";
import { MCP_SERVER_TEMPLATES } from "./mcp-server-templates.js";

const TREE = "0123456789abcdef".repeat(4);
const LEARN_URL = MCP_SERVER_TEMPLATES.find((template) => template.templateId === "microsoft-learn")!.url!;
const PLUGIN_JSON = ".claude-plugin/plugin.json";
const OUTSIDE = "Points outside the plugin, so GoatCitadel leaves it out.";

let root: string;
let dir: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "cc-translator-"));
  dir = path.join(root, "plugin");
  await mkdir(dir);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function translate(fixture: ClaudeCodePluginFixture): Promise<ClaudeCodeTranslationResult> {
  await writeClaudeCodePluginFixture(dir, fixture);
  return translateClaudeCodePlugin({ snapshotDir: dir, treeSha256: TREE, templates: MCP_SERVER_TEMPLATES });
}

function ok(result: ClaudeCodeTranslationResult) {
  if (!result.ok) throw new Error(`refused: ${result.code} ${result.message}`);
  return result.translation;
}

const FULL: ClaudeCodePluginFixture = {
  pluginJson: {
    name: "notes-kit",
    description: "Notes tools.",
    version: "1.2.0",
    author: { name: "Ann" },
    homepage: "https://example.com/notes",
    keywords: ["notes"],
    userConfig: { token: { type: "string" } },
    commands: "./extra-commands",
  },
  skills: { "pdf-notes": claudeCodeSkillMarkdown("pdf-notes"), "Bad Name": claudeCodeSkillMarkdown("bad-name") },
  files: {
    "commands/deploy.md": "Deploy.",
    "agents/reviewer.md": "Review.",
    "hooks/hooks.json": "{}",
    "bin/tool": "#!/bin/sh\n",
    "extra-commands/ship.md": "Ship.",
  },
  mcpJson: { mcpServers: { docs: { type: "http", url: LEARN_URL, headers: { A: "b" } }, local: { command: "node" } } },
};

describe("translateClaudeCodePlugin", () => {
  it("translates skills, a matched connector and leaves out commands, agents and hooks", async () => {
    const translation = ok(await translate(FULL));
    expect(translation.manifestText).toBe(
      `${JSON.stringify(
        {
          schemaVersion: 1,
          pluginId: "notes-kit",
          name: "notes-kit",
          description: "Notes tools.",
          version: "1.2.0",
          author: "Ann",
          homepage: "https://example.com/notes",
          pieces: [
            { kind: "skill", id: "skill-1", path: "skills/Bad Name" },
            { kind: "skill", id: "pdf-notes", path: "skills/pdf-notes" },
            { kind: "connector", id: "connector-1", templateId: "microsoft-learn", asksFirst: "changes" },
          ],
        },
        null,
        2,
      )}\n`,
    );
    expect(translation.ignored).toEqual([
      {
        path: "agents/reviewer.md",
        kind: "agent",
        label: "reviewer",
        reason: "A subagent. GoatCitadel's agents aren't set by plugins.",
      },
      {
        path: "commands/deploy.md",
        kind: "command",
        label: "deploy",
        reason: "A command. GoatCitadel doesn't take commands from plugins.",
      },
      {
        path: "extra-commands/ship.md",
        kind: "command",
        label: "ship",
        reason: "A command. GoatCitadel doesn't take commands from plugins.",
      },
      {
        path: "bin/tool",
        kind: "executable",
        label: "tool",
        reason: "A program for the command line. Plugins run no code.",
      },
      {
        path: "hooks/hooks.json",
        kind: "hook",
        label: "hooks.json",
        reason: "Hooks that run code or change what happens. Plugin hooks in GoatCitadel can only watch.",
      },
      { path: PLUGIN_JSON, kind: "manifest_field", label: "keywords", reason: "GoatCitadel doesn't use this." },
      {
        path: PLUGIN_JSON,
        kind: "manifest_field",
        label: "userConfig",
        reason:
          "Values Claude Code asks for when the plugin is switched on. GoatCitadel never asks for them, and nothing that would read them comes across.",
      },
      {
        path: ".mcp.json",
        kind: "mcp_server",
        label: "local",
        reason: "A local server, which would run a program. Plugins run no code.",
      },
    ]);
    expect(translation.coverage).toEqual({ usable: 3, total: 9 });
    expect(translation.pieceWarnings).toEqual({
      "connector-1": ["GoatCitadel signs in its own way. The plugin's own sign-in settings aren't used."],
    });
    expect(translation.pluginJsonSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("gives the same bytes and hash for the same plugin", async () => {
    const first = ok(await translate(FULL));
    const second = ok(
      await translateClaudeCodePlugin({ snapshotDir: dir, treeSha256: TREE, templates: MCP_SERVER_TEMPLATES }),
    );
    expect(second).toEqual(first);
  });

  it("names a missing version after the plugin's files", async () => {
    const translation = ok(
      await translate({ pluginJson: { name: "notes-kit" }, skills: { a: claudeCodeSkillMarkdown("a") } }),
    );
    const version = JSON.parse(translation.manifestText).version as string;
    expect(version).toBe(`content-${TREE.slice(0, 12)}`);
    expect(version).toMatch(/^content-[0-9a-f]{12}$/u);
  });

  it("uses the placeholder for a missing or unusable description", async () => {
    const missing = ok(
      await translate({ pluginJson: { name: "notes-kit" }, skills: { a: claudeCodeSkillMarkdown("a") } }),
    );
    expect(JSON.parse(missing.manifestText).description).toBe("No description was provided.");
    expect(missing.ignored).toEqual([]);
    const long = ok(await translate({ pluginJson: { name: "notes-kit", description: "x".repeat(501) } }));
    expect(JSON.parse(long.manifestText).description).toBe("No description was provided.");
    expect(long.ignored).toEqual([
      {
        path: PLUGIN_JSON,
        kind: "manifest_field",
        label: "description",
        reason: "Its description is too long or holds characters GoatCitadel can't show.",
      },
    ]);
  });

  it("refuses a plugin.json without a usable name", async () => {
    const result = await translate({
      pluginJson: { name: "Notes Kit" },
      skills: { a: claudeCodeSkillMarkdown("a") },
      files: { "commands/go.md": "Go." },
    });
    expect(result).toMatchObject({
      ok: false,
      code: "CLAUDE_CODE_MANIFEST_INVALID",
      message: "Its plugin.json has no name GoatCitadel can use as an id.",
    });
    if (result.ok) return;
    expect(result.ignored.map((part) => part.label)).toEqual(["go"]);
  });

  it("refuses an unreadable plugin.json", async () => {
    const result = await translate({ pluginJson: "{ nope", skills: { a: claudeCodeSkillMarkdown("a") } });
    expect(result).toMatchObject({
      ok: false,
      code: "CLAUDE_CODE_MANIFEST_INVALID",
      message: "Its plugin.json isn't valid JSON GoatCitadel can read.",
    });
  });

  it("refuses a plugin with nothing to take, with its full left-out list", async () => {
    const result = await translate({
      pluginJson: { name: "notes-kit" },
      files: { "commands/go.md": "Go.", "agents/a.md": "A.", "monitors/watch.sh": "x", "settings.json": "{}" },
    });
    expect(result).toMatchObject({
      ok: false,
      code: "NOTHING_TO_INSTALL",
      message: "GoatCitadel can't use any of this plugin's parts.",
    });
    if (result.ok) return;
    expect(result.ignored.map((part) => [part.kind, part.label])).toEqual([
      ["agent", "a"],
      ["command", "go"],
      ["monitor", "watch.sh"],
      ["settings", "settings.json"],
    ]);
  });

  it("refuses a plugin with more than 32 pieces", async () => {
    const skills = Object.fromEntries(
      Array.from({ length: 48 }, (_, index) => [`s${index}`, claudeCodeSkillMarkdown(`s${index}`)]),
    );
    expect(await translate({ pluginJson: { name: "small-business" }, skills })).toMatchObject({
      ok: false,
      code: "TOO_MANY_PIECES",
      message: "It has 48 parts GoatCitadel could take; one plugin can hold 32.",
    });
  });

  it("leaves out paths that point outside the plugin and reads nothing outside it", async () => {
    await mkdir(path.join(root, "shared", "sneaky"), { recursive: true });
    await writeFile(path.join(root, "shared", "sneaky", "SKILL.md"), claudeCodeSkillMarkdown("sneaky"));
    await writeFile(path.join(root, "shared", "SKILL.md"), claudeCodeSkillMarkdown("shared"));
    const translation = ok(
      await translate({
        pluginJson: {
          name: "notes-kit",
          skills: ["../shared", "/etc", "a\\b"],
          commands: ["/etc"],
          mcpServers: "../servers.json",
        },
        skills: { a: claudeCodeSkillMarkdown("a") },
      }),
    );
    expect(JSON.parse(translation.manifestText).pieces).toEqual([{ kind: "skill", id: "a", path: "skills/a" }]);
    expect(translation.ignored.filter((part) => part.reason === OUTSIDE).map((part) => [part.kind, part.path])).toEqual(
      [
        ["command", "/etc"],
        ["mcp_server", "../servers.json"],
        ["skill", "../shared"],
        ["skill", "/etc"],
        ["skill", "a\\b"],
      ],
    );
  });

  it("reads extra skills paths from plugin.json", async () => {
    const translation = ok(
      await translate({
        pluginJson: { name: "notes-kit", skills: ["./extra", "./one"] },
        files: {
          "extra/b/SKILL.md": claudeCodeSkillMarkdown("b"),
          "extra/c/SKILL.md": claudeCodeSkillMarkdown("c"),
          "one/SKILL.md": claudeCodeSkillMarkdown("one"),
        },
      }),
    );
    expect(JSON.parse(translation.manifestText).pieces).toEqual([
      { kind: "skill", id: "b", path: "extra/b" },
      { kind: "skill", id: "c", path: "extra/c" },
      { kind: "skill", id: "one", path: "one" },
    ]);
  });

  it("leaves out a top-level SKILL.md", async () => {
    const translation = ok(
      await translate({
        pluginJson: { name: "notes-kit" },
        skills: { a: claudeCodeSkillMarkdown("a") },
        files: { "SKILL.md": claudeCodeSkillMarkdown("top") },
      }),
    );
    expect(translation.ignored).toEqual([
      {
        path: "SKILL.md",
        kind: "skill",
        label: "SKILL.md",
        reason: "A skill at the plugin's top level. Import it from the Skills tab instead.",
      },
    ]);
  });

  it("leaves out a second server for the same app", async () => {
    const translation = ok(
      await translate({
        pluginJson: { name: "notes-kit", mcpServers: { zdocs: { type: "http", url: `${LEARN_URL}/` } } },
        mcpJson: { adocs: { type: "http", url: LEARN_URL } },
      }),
    );
    expect(JSON.parse(translation.manifestText).pieces).toEqual([
      { kind: "connector", id: "connector-1", templateId: "microsoft-learn", asksFirst: "changes" },
    ]);
    expect(translation.ignored).toEqual([
      { path: PLUGIN_JSON, kind: "mcp_server", label: "zdocs", reason: "Another of its servers is the same app." },
    ]);
    expect(translation.pieceWarnings).toEqual({});
  });

  it("generates a manifest parsePluginManifest accepts for every fixture", async () => {
    const fixtures: ClaudeCodePluginFixture[] = [
      FULL,
      { pluginJson: { name: "a1", displayName: "A one", version: "not valid!" }, skills: { x: "y" } },
      { pluginJson: { name: "a2", author: "\u0007bad", homepage: "http://insecure" }, skills: { x: "y" } },
    ];
    for (const [index, fixture] of fixtures.entries()) {
      dir = path.join(root, `p${index}`);
      await mkdir(dir);
      const translation = ok(await translate(fixture));
      expect(parsePluginManifest(translation.manifestText).ok).toBe(true);
    }
  });

  it("never counts manifest fields as parts", async () => {
    const translation = ok(
      await translate({
        pluginJson: { name: "notes-kit", license: "MIT", repository: "x", dependencies: ["other"] },
        skills: { a: claudeCodeSkillMarkdown("a") },
      }),
    );
    expect(translation.ignored.map((part) => part.label)).toEqual(["dependencies", "license", "repository"]);
    expect(translation.ignored.every((part) => part.kind === "manifest_field")).toBe(true);
    expect(translation.coverage).toEqual({ usable: 1, total: 1 });
  });
});
