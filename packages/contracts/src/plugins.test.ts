import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HOOK_TRIGGER_VALUES } from "./hooks.js";
import {
  PLUGIN_LIMITS,
  PLUGIN_MANIFEST_FILENAME,
  isPortablePluginPath,
  parsePluginManifest,
  pluginManifestTooLarge,
  type PluginManifestRefusalCode,
} from "./plugins.js";

const REFERENCE_PLUGIN_MANIFEST = new URL(
  `../../extensions-sdk/templates/plugins/reference-plugin/${PLUGIN_MANIFEST_FILENAME}`,
  import.meta.url,
);

type Json = Record<string, unknown>;

/** A valid manifest with one piece of every kind. Index: 0 skill, 1 connector, 2 tool_group_off, 3 hook, 4 prompt_pack. */
function validManifest(): Json {
  return {
    schemaVersion: 1,
    pluginId: "fixture-plugin",
    name: "Fixture plugin",
    description: "A fixture that holds one piece of every kind.",
    version: "1.2.3-beta.1+build.5",
    author: "Fixture Author",
    homepage: "https://example.com/fixture",
    pieces: [
      { kind: "skill", id: "notes", path: "skills/notes" },
      { kind: "connector", id: "github", templateId: "github", asksFirst: "everything" },
      { kind: "tool_group_off", id: "no-shell", groupId: "shell_and_code" },
      {
        kind: "hook",
        id: "watch-tools",
        trigger: "tool.call.after",
        url: "https://hooks.example.com/in",
        mode: "observe",
      },
      { kind: "prompt_pack", id: "checks", path: "prompt-packs/checks.md" },
    ],
  };
}

function withPiece(index: number, change: (piece: Json) => Json): Json {
  const manifest = validManifest();
  const pieces = (manifest.pieces as Json[]).map((piece, position) => (position === index ? change(piece) : piece));
  return { ...manifest, pieces };
}

function withPieces(extra: Json[]): Json {
  const manifest = validManifest();
  return { ...manifest, pieces: [...(manifest.pieces as Json[]), ...extra] };
}

function refusalOf(manifest: unknown) {
  const result = parsePluginManifest(JSON.stringify(manifest));
  if (result.ok) throw new Error("expected a refusal, but the manifest parsed");
  return result;
}

interface RefusalCase {
  readonly name: string;
  readonly manifest: Json;
  readonly code: PluginManifestRefusalCode;
  readonly field: string;
}

describe("parsePluginManifest", () => {
  it("accepts a manifest with a piece of every kind", () => {
    const result = parsePluginManifest(JSON.stringify(validManifest()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.pieces.map((piece) => piece.kind)).toEqual([
      "skill",
      "connector",
      "tool_group_off",
      "hook",
      "prompt_pack",
    ]);
    expect(result.manifest.pluginId).toBe("fixture-plugin");
  });

  it("accepts the reference plugin", () => {
    const bytes = readFileSync(REFERENCE_PLUGIN_MANIFEST);
    const result = parsePluginManifest(bytes.toString("utf8"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.pluginId).toBe("reference-plugin");
    expect(result.manifest.pieces.map((piece) => piece.kind).sort()).toEqual(["prompt_pack", "skill"]);
    expect(result.manifestSha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  });

  it("accepts every hook trigger the hooks contract lists", () => {
    for (const trigger of HOOK_TRIGGER_VALUES) {
      const result = parsePluginManifest(JSON.stringify(withPiece(3, (piece) => ({ ...piece, trigger }))));
      expect(result.ok, trigger).toBe(true);
    }
  });

  it("leaves optional fields off when they are absent", () => {
    const { author: _author, homepage: _homepage, ...bare } = validManifest();
    const connectorWithoutAsksFirst = {
      ...bare,
      pieces: [{ kind: "connector", id: "github", templateId: "github" }],
    };
    const result = parsePluginManifest(JSON.stringify(connectorWithoutAsksFirst));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.author).toBeUndefined();
    expect(result.manifest.pieces[0]).toEqual({ kind: "connector", id: "github", templateId: "github" });
  });

  describe("named refusals", () => {
    const cases: readonly RefusalCase[] = [
      // Rule 1: feature flags and runtime presets
      {
        name: "a top-level featureFlags key",
        manifest: { ...validManifest(), featureFlags: { x: true } },
        code: "FEATURE_FLAGS_NOT_ALLOWED",
        field: "featureFlags",
      },
      {
        name: "a top-level flags key",
        manifest: { ...validManifest(), flags: [] },
        code: "FEATURE_FLAGS_NOT_ALLOWED",
        field: "flags",
      },
      {
        name: "a top-level runtimePresets key",
        manifest: { ...validManifest(), runtimePresets: {} },
        code: "FEATURE_FLAGS_NOT_ALLOWED",
        field: "runtimePresets",
      },
      {
        name: "a featureFlags key on a piece",
        manifest: withPiece(1, (piece) => ({ ...piece, featureFlags: {} })),
        code: "FEATURE_FLAGS_NOT_ALLOWED",
        field: "pieces[1].featureFlags",
      },
      {
        name: "a runtimePresets key on a piece",
        manifest: withPiece(4, (piece) => ({ ...piece, runtimePresets: {} })),
        code: "FEATURE_FLAGS_NOT_ALLOWED",
        field: "pieces[4].runtimePresets",
      },
      {
        name: "a runtime_preset piece",
        manifest: withPieces([{ kind: "runtime_preset", id: "preset" }]),
        code: "FEATURE_FLAGS_NOT_ALLOWED",
        field: "pieces[5].kind",
      },
      // Rule 2: chat instructions
      {
        name: "a top-level instructions key",
        manifest: { ...validManifest(), instructions: "Be terse." },
        code: "CHAT_INSTRUCTIONS_NOT_ALLOWED",
        field: "instructions",
      },
      {
        name: "a top-level systemPrompt key",
        manifest: { ...validManifest(), systemPrompt: "x" },
        code: "CHAT_INSTRUCTIONS_NOT_ALLOWED",
        field: "systemPrompt",
      },
      {
        name: "a prompt key on a piece",
        manifest: withPiece(0, (piece) => ({ ...piece, prompt: "x" })),
        code: "CHAT_INSTRUCTIONS_NOT_ALLOWED",
        field: "pieces[0].prompt",
      },
      {
        name: "a chatInstructions key on a piece",
        manifest: withPiece(2, (piece) => ({ ...piece, chatInstructions: "x" })),
        code: "CHAT_INSTRUCTIONS_NOT_ALLOWED",
        field: "pieces[2].chatInstructions",
      },
      // Rule 3: hooks that change what happens
      {
        name: "a hook in mutate mode",
        manifest: withPiece(3, (piece) => ({ ...piece, mode: "mutate" })),
        code: "HOOK_MUST_ONLY_OBSERVE",
        field: "pieces[3].mode",
      },
      {
        name: "a hook in intercept mode",
        manifest: withPiece(3, (piece) => ({ ...piece, mode: "intercept" })),
        code: "HOOK_MUST_ONLY_OBSERVE",
        field: "pieces[3].mode",
      },
      {
        name: "a hook with a patch key",
        manifest: withPiece(3, (piece) => ({ ...piece, patch: {} })),
        code: "HOOK_MUST_ONLY_OBSERVE",
        field: "pieces[3].patch",
      },
      {
        name: "a hook with an intercept key",
        manifest: withPiece(3, (piece) => ({ ...piece, intercept: true })),
        code: "HOOK_MUST_ONLY_OBSERVE",
        field: "pieces[3].intercept",
      },
      {
        name: "a hook with a requiresApproval key",
        manifest: withPiece(3, (piece) => ({ ...piece, requiresApproval: false })),
        code: "HOOK_MUST_ONLY_OBSERVE",
        field: "pieces[3].requiresApproval",
      },
      {
        name: "a hook with a riskLevel key",
        manifest: withPiece(3, (piece) => ({ ...piece, riskLevel: "low" })),
        code: "HOOK_MUST_ONLY_OBSERVE",
        field: "pieces[3].riskLevel",
      },
      // Rule 4: hooks that run code
      {
        name: "a hook with an action key",
        manifest: withPiece(3, (piece) => ({ ...piece, action: { type: "managed_package" } })),
        code: "HOOK_CODE_NOT_ALLOWED",
        field: "pieces[3].action",
      },
      {
        name: "a hook with a package key",
        manifest: withPiece(3, (piece) => ({ ...piece, package: "x" })),
        code: "HOOK_CODE_NOT_ALLOWED",
        field: "pieces[3].package",
      },
      {
        name: "a hook with a command key",
        manifest: withPiece(3, (piece) => ({ ...piece, command: "x" })),
        code: "HOOK_CODE_NOT_ALLOWED",
        field: "pieces[3].command",
      },
      {
        name: "a hook with a script key",
        manifest: withPiece(3, (piece) => ({ ...piece, script: "x" })),
        code: "HOOK_CODE_NOT_ALLOWED",
        field: "pieces[3].script",
      },
      // Rule 5: presets that loosen
      {
        name: "a connector that asks first about nothing",
        manifest: withPiece(1, (piece) => ({ ...piece, asksFirst: "nothing" })),
        code: "PRESET_MUST_TIGHTEN",
        field: "pieces[1].asksFirst",
      },
      {
        name: "a tool_group_on piece",
        manifest: withPieces([{ kind: "tool_group_on", id: "shell-on", groupId: "shell_and_code" }]),
        code: "PRESET_MUST_TIGHTEN",
        field: "pieces[5].kind",
      },
      // Rule 6: unknown kinds
      {
        name: "an addon piece",
        manifest: withPieces([{ kind: "addon", id: "arena" }]),
        code: "UNKNOWN_PIECE_KIND",
        field: "pieces[5].kind",
      },
      {
        name: "a plugin piece",
        manifest: withPieces([{ kind: "plugin", id: "nested" }]),
        code: "UNKNOWN_PIECE_KIND",
        field: "pieces[5].kind",
      },
      {
        name: "an mcp_template piece",
        manifest: withPieces([{ kind: "mcp_template", id: "server" }]),
        code: "UNKNOWN_PIECE_KIND",
        field: "pieces[5].kind",
      },
      {
        name: "a made-up piece kind",
        manifest: withPiece(2, (piece) => ({ ...piece, kind: "teleport" })),
        code: "UNKNOWN_PIECE_KIND",
        field: "pieces[2].kind",
      },
      // Rule 7: piece paths
      {
        name: "an absolute skill path",
        manifest: withPiece(0, (piece) => ({ ...piece, path: "/etc/skills" })),
        code: "PIECE_PATH_INVALID",
        field: "pieces[0].path",
      },
      {
        name: "a drive-letter skill path",
        manifest: withPiece(0, (piece) => ({ ...piece, path: "C:/skills/notes" })),
        code: "PIECE_PATH_INVALID",
        field: "pieces[0].path",
      },
      {
        name: "a skill path with a backslash",
        manifest: withPiece(0, (piece) => ({ ...piece, path: "skills\\notes" })),
        code: "PIECE_PATH_INVALID",
        field: "pieces[0].path",
      },
      {
        name: "a skill path that climbs out",
        manifest: withPiece(0, (piece) => ({ ...piece, path: "skills/../../outside" })),
        code: "PIECE_PATH_INVALID",
        field: "pieces[0].path",
      },
      {
        name: "a skill path with a NUL",
        manifest: withPiece(0, (piece) => ({ ...piece, path: "skills/notes\u0000.md" })),
        code: "PIECE_PATH_INVALID",
        field: "pieces[0].path",
      },
      {
        name: "a skill path that is not NFC",
        manifest: withPiece(0, (piece) => ({ ...piece, path: "skills/cafe\u0301" })),
        code: "PIECE_PATH_INVALID",
        field: "pieces[0].path",
      },
      // The paths GoatCitadel's copy of a plugin can't hold are refused here too, so the preflight and an inspection
      // agree about them.
      ...[
        "./skills/notes",
        "skills/notes/",
        "skills//notes",
        "skills/notes.",
        "skills/con",
        "skills/a:b",
        "skills/.git/x",
      ].map((path) => ({
        name: `the skill path ${JSON.stringify(path)}`,
        manifest: withPiece(0, (piece) => ({ ...piece, path })),
        code: "PIECE_PATH_INVALID" as const,
        field: "pieces[0].path",
      })),
      {
        name: "a prompt pack path with a trailing space",
        manifest: withPiece(4, (piece) => ({ ...piece, path: "prompt-packs/checks.md " })),
        code: "PIECE_PATH_INVALID",
        field: "pieces[4].path",
      },
      {
        name: "a prompt pack path that is not .md",
        manifest: withPiece(4, (piece) => ({ ...piece, path: "prompt-packs/checks.txt" })),
        code: "PIECE_PATH_INVALID",
        field: "pieces[4].path",
      },
      {
        name: "an absolute prompt pack path",
        manifest: withPiece(4, (piece) => ({ ...piece, path: "/checks.md" })),
        code: "PIECE_PATH_INVALID",
        field: "pieces[4].path",
      },
      // Rule 8: the strict schema
      {
        name: "an unknown top-level key",
        manifest: { ...validManifest(), extra: true },
        code: "MANIFEST_INVALID",
        field: "extra",
      },
      {
        name: "an unknown key on a piece",
        manifest: withPiece(0, (piece) => ({ ...piece, extra: true })),
        code: "MANIFEST_INVALID",
        field: "pieces[0].extra",
      },
      {
        name: "a plugin id with capitals",
        manifest: { ...validManifest(), pluginId: "Fixture" },
        code: "MANIFEST_INVALID",
        field: "pluginId",
      },
      {
        name: "a plugin id that is one character",
        manifest: { ...validManifest(), pluginId: "a" },
        code: "MANIFEST_INVALID",
        field: "pluginId",
      },
      {
        name: "a schema version other than 1",
        manifest: { ...validManifest(), schemaVersion: 2 },
        code: "MANIFEST_INVALID",
        field: "schemaVersion",
      },
      { name: "an empty name", manifest: { ...validManifest(), name: "" }, code: "MANIFEST_INVALID", field: "name" },
      { name: "a blank name", manifest: { ...validManifest(), name: "   " }, code: "MANIFEST_INVALID", field: "name" },
      {
        name: "a name of only line breaks and tabs",
        manifest: { ...validManifest(), name: "\n\t " },
        code: "MANIFEST_INVALID",
        field: "name",
      },
      // A control or format character in text that reaches the approval text (F5).
      {
        name: "a name of one control character",
        manifest: { ...validManifest(), name: "\u0001" },
        code: "MANIFEST_INVALID",
        field: "name",
      },
      {
        name: "a name ending in NUL",
        manifest: { ...validManifest(), name: "Acme\u0000" },
        code: "MANIFEST_INVALID",
        field: "name",
      },
      {
        name: "a name with a right-to-left override",
        manifest: { ...validManifest(), name: "Acme ‮slooc" },
        code: "MANIFEST_INVALID",
        field: "name",
      },
      {
        name: "a description with a line break",
        manifest: { ...validManifest(), description: "Notes.\nAnd more." },
        code: "MANIFEST_INVALID",
        field: "description",
      },
      {
        name: "an author with a bidi isolate",
        manifest: { ...validManifest(), author: "Fixture ⁦Author⁩" },
        code: "MANIFEST_INVALID",
        field: "author",
      },
      {
        name: "a version with a space",
        manifest: { ...validManifest(), version: "1.0 beta" },
        code: "MANIFEST_INVALID",
        field: "version",
      },
      {
        name: "an http homepage",
        manifest: { ...validManifest(), homepage: "http://example.com" },
        code: "MANIFEST_INVALID",
        field: "homepage",
      },
      { name: "no pieces", manifest: { ...validManifest(), pieces: [] }, code: "MANIFEST_INVALID", field: "pieces" },
      {
        name: "a hook trigger that does not exist",
        manifest: withPiece(3, (piece) => ({ ...piece, trigger: "tool.call.sometimes" })),
        code: "MANIFEST_INVALID",
        field: "pieces[3].trigger",
      },
      {
        name: "a hook to an http address",
        manifest: withPiece(3, (piece) => ({ ...piece, url: "http://hooks.example.com/in" })),
        code: "MANIFEST_INVALID",
        field: "pieces[3].url",
      },
      {
        name: "a connector that asks first about something else",
        manifest: withPiece(1, (piece) => ({ ...piece, asksFirst: "sometimes" })),
        code: "MANIFEST_INVALID",
        field: "pieces[1].asksFirst",
      },
      {
        name: "a piece id with capitals",
        manifest: withPiece(0, (piece) => ({ ...piece, id: "Notes" })),
        code: "MANIFEST_INVALID",
        field: "pieces[0].id",
      },
    ];

    it.each(cases)("refuses $name with $code at $field", ({ manifest, code, field }) => {
      const refusal = refusalOf(manifest);
      expect(refusal.code).toBe(code);
      expect(refusal.field).toBe(field);
      expect(refusal.message.length).toBeGreaterThan(0);
    });

    it("says why a path is refused, keeping the words for the paths it always refused", () => {
      const pathMessage = (path: string) => refusalOf(withPiece(0, (piece) => ({ ...piece, path }))).message;
      expect(pathMessage("/etc/skills")).toBe("A piece's path must be relative to the plugin folder.");
      expect(pathMessage("skills\\notes")).toBe("A piece's path must use forward slashes.");
      expect(pathMessage("skills/../notes")).toBe("A piece's path must not contain '..'.");
      expect(pathMessage("skills/cafe\u0301")).toBe("A piece's path must be NFC-normalized.");
      expect(pathMessage("skills/notes.")).toBe(
        'A piece\'s path must be a plain path every computer can hold: no empty or "." parts, no colon, no name that ' +
          "ends in a dot or a space, no .git folder and no device name such as CON.",
      );
    });

    it("says a blank name must not be blank, and keeps a name with spaces around it", () => {
      expect(refusalOf({ ...validManifest(), name: "  \t" }).message).toBe(
        "The manifest isn't valid at name: must not be blank.",
      );
      expect(parsePluginManifest(JSON.stringify({ ...validManifest(), name: " Meeting tools " }))).toMatchObject({
        ok: true,
        manifest: { name: " Meeting tools " },
      });
    });

    it("says a name with a control character must not hold one", () => {
      for (const name of ["\u0001", "Acme\u0000", "Acme ‮slooc"]) {
        expect(refusalOf({ ...validManifest(), name })).toEqual({
          ok: false,
          code: "MANIFEST_INVALID",
          message: "The manifest isn't valid at name: must not hold control characters.",
          field: "name",
        });
      }
    });

    it("refuses more pieces than the limit", () => {
      const pieces = Array.from({ length: PLUGIN_LIMITS.maxPieces + 1 }, (_, index) => ({
        kind: "tool_group_off",
        id: `hold-${index}`,
        groupId: "browser",
      }));
      const refusal = refusalOf({ ...validManifest(), pieces });
      expect(refusal).toMatchObject({ code: "MANIFEST_INVALID", field: "pieces" });
    });

    it("accepts exactly the most pieces it allows", () => {
      const pieces = Array.from({ length: PLUGIN_LIMITS.maxPieces }, (_, index) => ({
        kind: "tool_group_off",
        id: `hold-${index}`,
        groupId: "browser",
      }));
      expect(parsePluginManifest(JSON.stringify({ ...validManifest(), pieces })).ok).toBe(true);
    });
  });

  describe("refusal order", () => {
    // Each manifest breaks two rules. The earlier rule must win, wherever in the manifest each break sits.
    const orderCases: readonly RefusalCase[] = [
      {
        name: "feature flags before chat instructions",
        manifest: { ...validManifest(), instructions: "x", featureFlags: {} },
        code: "FEATURE_FLAGS_NOT_ALLOWED",
        field: "featureFlags",
      },
      {
        name: "a later piece's feature flag before an earlier piece's chat instruction",
        manifest: {
          ...validManifest(),
          pieces: [
            { kind: "skill", id: "notes", path: "skills/notes", prompt: "x" },
            { kind: "tool_group_off", id: "no-shell", groupId: "shell_and_code", flags: [] },
          ],
        },
        code: "FEATURE_FLAGS_NOT_ALLOWED",
        field: "pieces[1].flags",
      },
      {
        name: "chat instructions before a mutating hook",
        manifest: withPiece(3, (piece) => ({ ...piece, mode: "mutate", systemPrompt: "x" })),
        code: "CHAT_INSTRUCTIONS_NOT_ALLOWED",
        field: "pieces[3].systemPrompt",
      },
      {
        name: "a mutating hook before a hook that runs code",
        manifest: withPiece(3, (piece) => ({ ...piece, command: "x", mode: "mutate" })),
        code: "HOOK_MUST_ONLY_OBSERVE",
        field: "pieces[3].mode",
      },
      {
        name: "a hook that runs code before a loosening connector",
        manifest: {
          ...validManifest(),
          pieces: [
            { kind: "connector", id: "github", templateId: "github", asksFirst: "nothing" },
            { kind: "hook", id: "watch", trigger: "tool.call.after", url: "https://hooks.example.com/in", script: "x" },
          ],
        },
        code: "HOOK_CODE_NOT_ALLOWED",
        field: "pieces[1].script",
      },
      {
        name: "a loosening connector before an unknown kind",
        manifest: {
          ...validManifest(),
          pieces: [
            { kind: "addon", id: "arena" },
            { kind: "connector", id: "github", templateId: "github", asksFirst: "nothing" },
          ],
        },
        code: "PRESET_MUST_TIGHTEN",
        field: "pieces[1].asksFirst",
      },
      {
        name: "an unknown kind before a bad path",
        manifest: {
          ...validManifest(),
          pieces: [
            { kind: "skill", id: "notes", path: "../notes" },
            { kind: "addon", id: "arena" },
          ],
        },
        code: "UNKNOWN_PIECE_KIND",
        field: "pieces[1].kind",
      },
      {
        name: "a bad path before the strict schema",
        manifest: {
          ...validManifest(),
          pluginId: "Not Valid",
          pieces: [{ kind: "skill", id: "notes", path: "/abs" }],
        },
        code: "PIECE_PATH_INVALID",
        field: "pieces[0].path",
      },
      {
        name: "the strict schema before a duplicate id",
        manifest: {
          ...validManifest(),
          extra: true,
          pieces: [
            { kind: "skill", id: "notes", path: "skills/a" },
            { kind: "skill", id: "notes", path: "skills/b" },
          ],
        },
        code: "MANIFEST_INVALID",
        field: "extra",
      },
    ];

    it.each(orderCases)("puts $name", ({ manifest, code, field }) => {
      const refusal = refusalOf(manifest);
      expect(refusal.code).toBe(code);
      expect(refusal.field).toBe(field);
    });
  });

  it("holds a plugin path to what every disk can write the same", () => {
    for (const ok of ["SKILL.md", "skills/a/SKILL.md", "docs/guide.v2.md", "naïve/readme.md", ".github/notes.md"]) {
      expect(isPortablePluginPath(ok), ok).toBe(true);
    }
    for (const bad of [
      "",
      "../up.md",
      "a/../b.md",
      "/abs.md",
      "C:/drive.md",
      "a\\b.md",
      "a//b.md",
      "./a.md",
      "a/",
      ".git/config",
      "a/.GIT/config",
      "a/CON.txt",
      "a/aux",
      "a/com1",
      "a/stream.txt:evil",
      "a/trailing.",
      "a/trailing ",
      "tab\there.md",
      "nul\u0000.md",
      "bad\uFFFD.md",
      "\ufb01le.md",
      "e\u0301.md",
      `${"a".repeat(256)}/b.md`,
      `${"a/".repeat(2_049)}b`,
    ]) {
      expect(isPortablePluginPath(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("refuses duplicate piece ids", () => {
    const manifest = {
      ...validManifest(),
      pieces: [
        { kind: "skill", id: "notes", path: "skills/notes" },
        { kind: "prompt_pack", id: "checks", path: "checks.md" },
        { kind: "tool_group_off", id: "notes", groupId: "browser" },
      ],
    };
    const refusal = refusalOf(manifest);
    expect(refusal).toMatchObject({ code: "DUPLICATE_PIECE_ID", field: "pieces[2].id" });
    expect(refusal.message).toContain("notes");
  });

  it("refuses a manifest over 64 KiB", () => {
    const padded = `${JSON.stringify(validManifest())}${" ".repeat(PLUGIN_LIMITS.maxManifestBytes)}`;
    expect(parsePluginManifest(padded)).toMatchObject({ ok: false, code: "MANIFEST_TOO_LARGE" });
  });

  it("gives one too-large refusal, whichever way the size is found", () => {
    const refusal = pluginManifestTooLarge();
    expect(refusal).toMatchObject({ ok: false, code: "MANIFEST_TOO_LARGE" });
    expect(refusal.message).toContain("64 KiB");
    // Too many characters, and too many bytes with few characters.
    expect(parsePluginManifest(" ".repeat(PLUGIN_LIMITS.maxManifestBytes + 1))).toEqual(refusal);
    expect(parsePluginManifest(`"${"é".repeat(33_000)}"`)).toEqual(refusal);
  });

  it("measures the manifest in bytes, not characters", () => {
    // 33,000 two-byte characters is 66,000 bytes but only 33,000 characters.
    const text = JSON.stringify({ ...validManifest(), name: "é".repeat(33_000) });
    expect(text.length).toBeLessThan(PLUGIN_LIMITS.maxManifestBytes);
    expect(parsePluginManifest(text)).toMatchObject({ ok: false, code: "MANIFEST_TOO_LARGE" });
  });

  it("accepts a manifest of exactly 64 KiB", () => {
    const json = JSON.stringify(validManifest());
    const exact = `${json}${" ".repeat(PLUGIN_LIMITS.maxManifestBytes - json.length)}`;
    expect(Buffer.byteLength(exact)).toBe(PLUGIN_LIMITS.maxManifestBytes);
    expect(parsePluginManifest(exact).ok).toBe(true);
  });

  it("refuses text that is not a JSON object", () => {
    expect(parsePluginManifest("{ nope")).toMatchObject({ ok: false, code: "MANIFEST_INVALID" });
    expect(parsePluginManifest("[]")).toMatchObject({ ok: false, code: "MANIFEST_INVALID" });
    expect(parsePluginManifest("null")).toMatchObject({ ok: false, code: "MANIFEST_INVALID" });
    expect(parsePluginManifest("")).toMatchObject({ ok: false, code: "MANIFEST_INVALID" });
  });

  it("does not echo manifest text in the JSON error", () => {
    const refusal = parsePluginManifest('{"PRIVATE_SENTINEL":');
    expect(refusal.ok).toBe(false);
    expect(JSON.stringify(refusal)).not.toContain("PRIVATE_SENTINEL");
  });

  describe("manifestSha256", () => {
    it("gives the same hash for the same bytes", () => {
      const text = JSON.stringify(validManifest(), null, 2);
      const first = parsePluginManifest(text);
      const second = parsePluginManifest(text);
      expect(first.ok && second.ok).toBe(true);
      if (!first.ok || !second.ok) return;
      expect(first.manifestSha256).toBe(second.manifestSha256);
      expect(first.manifestSha256).toBe(createHash("sha256").update(text, "utf8").digest("hex"));
      expect(first.manifestSha256).toMatch(/^[0-9a-f]{64}$/u);
    });

    it("gives a different hash when a byte changes, line endings included", () => {
      const lf = JSON.stringify(validManifest(), null, 2);
      const crlf = lf.replaceAll("\n", "\r\n");
      const a = parsePluginManifest(lf);
      const b = parsePluginManifest(crlf);
      expect(a.ok && b.ok).toBe(true);
      if (!a.ok || !b.ok) return;
      expect(a.manifestSha256).not.toBe(b.manifestSha256);
      expect(b.manifestSha256).toBe(createHash("sha256").update(crlf, "utf8").digest("hex"));
    });

    it("hashes a leading byte-order mark, though it parses past it", () => {
      const text = `\uFEFF${JSON.stringify(validManifest())}`;
      const result = parsePluginManifest(text);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.manifestSha256).toBe(createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex"));
    });
  });
});
