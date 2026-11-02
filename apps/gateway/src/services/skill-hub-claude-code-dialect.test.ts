import { describe, expect, it } from "vitest";
import {
  CLAUDE_CODE_SETTING_NOT_KEPT,
  CLAUDE_CODE_SKILL_DIALECT,
  SKILL_RUNS_SHELL_COMMANDS,
  checkClaudeCodeFrontmatter,
  hasClaudeCodeShellLines,
} from "./skill-hub-claude-code-dialect.js";

const BASE = { name: "pdf-notes", description: "Turns a PDF into short meeting notes for the team." };

describe("checkClaudeCodeFrontmatter", () => {
  it("passes a skill with only a name, a description and GoatCitadel's own metadata, and ignores nothing", () => {
    expect(
      checkClaudeCodeFrontmatter({
        ...BASE,
        metadata: { version: "1.0.0", tags: ["notes"], tools: [], requires: [], keywords: ["pdf"] },
      }),
    ).toEqual({ ok: true, reading: { ignoredKeys: [], widenedKeys: [] } });
  });

  it.each(CLAUDE_CODE_SKILL_DIALECT.ignoredKeys)("passes and records the ignored key %s", (key) => {
    expect(checkClaudeCodeFrontmatter({ ...BASE, [key]: "Read, Grep" })).toEqual({
      ok: true,
      reading: { ignoredKeys: [key], widenedKeys: [] },
    });
  });

  it.each(CLAUDE_CODE_SKILL_DIALECT.ignoredMetadataKeys)("passes and records the ignored metadata key %s", (key) => {
    expect(checkClaudeCodeFrontmatter({ ...BASE, metadata: { version: "2.0.0", [key]: "Someone" } })).toEqual({
      ok: true,
      reading: { ignoredKeys: [`metadata.${key}`], widenedKeys: [] },
    });
  });

  it.each(CLAUDE_CODE_SKILL_DIALECT.refusedKeys)("refuses %s, naming it", (key) => {
    expect(checkClaudeCodeFrontmatter({ ...BASE, "allowed-tools": "Read", [key]: true })).toEqual({
      ok: false,
      code: CLAUDE_CODE_SETTING_NOT_KEPT,
      key,
    });
  });

  it("names the first refused key in the list's order, whatever the file's order", () => {
    expect(
      checkClaudeCodeFrontmatter({ ...BASE, background: true, hooks: {}, "disable-model-invocation": true }),
    ).toEqual({ ok: false, code: CLAUDE_CODE_SETTING_NOT_KEPT, key: "disable-model-invocation" });
  });

  it("refuses a key no list names", () => {
    expect(checkClaudeCodeFrontmatter({ ...BASE, foo: 1 })).toEqual({
      ok: false,
      code: "UNKNOWN_FRONTMATTER_DIMENSION",
      key: "foo",
    });
    expect(
      checkClaudeCodeFrontmatter({ ...BASE, metadata: { version: "1.0.0", homepage: "https://example.com" } }),
    ).toEqual({ ok: false, code: "UNKNOWN_FRONTMATTER_DIMENSION", key: "metadata.homepage" });
  });

  it("refuses metadata that isn't an object", () => {
    for (const metadata of ["1.0.0", ["author"], null, 3]) {
      expect(checkClaudeCodeFrontmatter({ ...BASE, metadata }), JSON.stringify(metadata)).toEqual({
        ok: false,
        code: "UNKNOWN_FRONTMATTER_DIMENSION",
        key: "metadata",
      });
    }
  });

  it("names the refused key before an unknown one", () => {
    expect(checkClaudeCodeFrontmatter({ ...BASE, foo: 1, metadata: { homepage: "x" }, paths: ["src/**"] })).toEqual({
      ok: false,
      code: CLAUDE_CODE_SETTING_NOT_KEPT,
      key: "paths",
    });
  });

  it("warns only for user-invocable false", () => {
    expect(checkClaudeCodeFrontmatter({ ...BASE, "user-invocable": false })).toEqual({
      ok: true,
      reading: { ignoredKeys: ["user-invocable"], widenedKeys: ["user-invocable"] },
    });
    expect(checkClaudeCodeFrontmatter({ ...BASE, "user-invocable": true })).toEqual({
      ok: true,
      reading: { ignoredKeys: ["user-invocable"], widenedKeys: [] },
    });
    // Anything but a literal true is read as the wider setting, so the warning is never missed.
    expect(checkClaudeCodeFrontmatter({ ...BASE, "user-invocable": "false" })).toEqual({
      ok: true,
      reading: { ignoredKeys: ["user-invocable"], widenedKeys: ["user-invocable"] },
    });
  });

  it("ignores a top-level version beside metadata.version, and records it", () => {
    expect(checkClaudeCodeFrontmatter({ ...BASE, version: "9.9.9", metadata: { version: "1.0.0" } })).toEqual({
      ok: true,
      reading: { ignoredKeys: ["version"], widenedKeys: [] },
    });
  });

  it("sorts what it ignored, with metadata keys under their own prefix", () => {
    expect(
      checkClaudeCodeFrontmatter({
        ...BASE,
        when_to_use: "When notes are needed.",
        "argument-hint": "[file]",
        "allowed-tools": "Read",
        metadata: { version: "1.0.0", date: "2026-01-01", author: "Someone" },
      }),
    ).toEqual({
      ok: true,
      reading: {
        ignoredKeys: ["allowed-tools", "argument-hint", "metadata.author", "metadata.date", "when_to_use"],
        widenedKeys: [],
      },
    });
  });
});

describe("hasClaudeCodeShellLines", () => {
  it("names the refusal code", () => {
    expect(SKILL_RUNS_SHELL_COMMANDS).toBe("SKILL_RUNS_SHELL_COMMANDS");
  });

  it.each([
    ["an inline command at a line start", "Intro.\n!`git status`\nMore."],
    ["an inline command after a space", "Check the tree first: !`git status` then go on."],
    ["a fence opened with ```!", "Steps:\n\n```!\ngit status\n```\n"],
    ["an indented fence opened with ```!", "Steps:\n   ```!\nls\n```\n"],
    ["a four-backtick fence opened with ````!", "Steps:\n````!\nls\n````\n"],
    ["an inline command after punctuation", "Run it (!`ls`) or quote it >!`pwd`."],
    ["an inline command inside a code block", "```md\nSee !`git log`\n```\n"],
    ["an inline command that spans a newline", "Check first: !`git\nstatus` then go on."],
    ["a ```! fence opener in the middle of a line", "Run this: ```!\ngit status\n```\n"],
    ["a tilde fence opened with ~~~!", "Steps:\n~~~!\nls\n~~~\n"],
    ["an inline command in a CRLF file", "Intro.\r\n!`ls`\r\n"],
    ["a fence in a CRLF file", "Steps:\r\n```!\r\nls\r\n```\r\n"],
  ])("finds %s", (_label, markdown) => {
    expect(hasClaudeCodeShellLines(markdown)).toBe(true);
  });

  it.each([
    ["an inline `!important`", "Use `!important` only when you must."],
    ["a ! in prose", "Do this now! It matters!\nReally!"],
    ["an image", "![alt](x.png)\n"],
    ["a plain fence", "```bash\ngit status\n```\n"],
    ["an empty inline command", "Odd text: !`` here."],
  ])("leaves %s alone", (_label, markdown) => {
    expect(hasClaudeCodeShellLines(markdown)).toBe(false);
  });
});
