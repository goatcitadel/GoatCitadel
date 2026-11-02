import { createHash } from "node:crypto";
import {
  CLAUDE_CODE_PLUGIN_MANIFEST_PATH,
  PLUGIN_ID_PATTERN,
  PLUGIN_LIMITS,
  PLUGIN_PIECE_ID_PATTERN,
  parsePluginManifest,
  pluginManifestSchema,
  type CapabilityPluginIgnoredPart,
  type McpServerTemplateRecord,
  type PluginPiece,
} from "@goatcitadel/contracts";
import { matchClaudeCodeMcpServer, type ClaudeCodeMcpServerEntry } from "./claude-code-mcp-match.js";
import {
  ClaudeCodePluginFiles,
  compareStrings,
  isPlainObject,
  pluginRelativePath,
  stringsOf,
} from "./claude-code-plugin-files.js";
import { leftOutPartsOf, outsidePart as outside } from "./claude-code-plugin-left-out.js";

// Translates a Claude Code plugin into the text of a GoatCitadel manifest. It only reads the snapshot: it takes the
// plugin's skills and the remote servers that exactly match a shipped connector template, and lists every other part
// as left out with a plain reason. The same snapshot always gives the same bytes. The text goes through the same
// `parsePluginManifest` as any other manifest, so every named refusal still applies.

/** Bump when the translation of the same plugin would change, so an install can tell it from the checked one. */
export const CLAUDE_CODE_TRANSLATOR_VERSION = 1;

export interface ClaudeCodeTranslation {
  /** The generated goatcitadel-plugin.json text. Same input, same bytes. */
  manifestText: string;
  pluginJsonSha256: string;
  /** Sorted by kind, then path. */
  ignored: CapabilityPluginIgnoredPart[];
  coverage: { usable: number; total: number };
  /** Plain lines for a connector piece, by piece id. */
  pieceWarnings: Readonly<Record<string, string[]>>;
}

export type ClaudeCodeTranslationResult =
  | { ok: true; translation: ClaudeCodeTranslation }
  | {
      ok: false;
      code: "CLAUDE_CODE_MANIFEST_INVALID" | "NOTHING_TO_INSTALL" | "TOO_MANY_PIECES";
      message: string;
      ignored: CapabilityPluginIgnoredPart[];
    };

export interface ClaudeCodeTranslatorLog {
  warn(details: Record<string, unknown>, message: string): void;
}

const NOT_JSON = "Its plugin.json isn't valid JSON GoatCitadel can read.";
const NO_ID = "Its plugin.json has no name GoatCitadel can use as an id.";
const NO_NAME = "Its plugin.json has no name GoatCitadel can show.";
const TRANSLATOR_FAULT = "GoatCitadel couldn't read this Claude Code plugin.";
const NOTHING = "GoatCitadel can't use any of this plugin's parts.";
const NO_DESCRIPTION = "No description was provided.";
const BAD_DESCRIPTION = "Its description is too long or holds characters GoatCitadel can't show.";
const SAME_APP = "Another of its servers is the same app.";
const OWN_SIGN_IN_DROPPED = "GoatCitadel signs in its own way. The plugin's own sign-in settings aren't used.";
const TOP_LEVEL_SKILL = "A skill at the plugin's top level. Import it from the Skills tab instead.";
const UNREADABLE_SERVER = "It isn't a server GoatCitadel can read.";
const SHAPE = pluginManifestSchema.shape;

export async function translateClaudeCodePlugin(input: {
  snapshotDir: string;
  treeSha256: string;
  templates: readonly McpServerTemplateRecord[];
  /** Where a translator fault's detail goes. */
  log?: ClaudeCodeTranslatorLog;
}): Promise<ClaudeCodeTranslationResult> {
  const files = new ClaudeCodePluginFiles(input.snapshotDir);
  const read = await files.readJson(CLAUDE_CODE_PLUGIN_MANIFEST_PATH);
  const pluginJson = read.kind === "ok" && isPlainObject(read.value) ? read.value : undefined;
  const ignored: CapabilityPluginIgnoredPart[] = await leftOutPartsOf(files, pluginJson ?? {});
  const skills = await skillPieces(files, pluginJson ?? {}, ignored);
  const connectors = await connectorPieces(files, pluginJson ?? {}, input.templates, ignored);
  const sorted = sortParts(ignored);
  const refuse = (code: Extract<ClaudeCodeTranslationResult, { ok: false }>["code"], message: string) =>
    ({ ok: false, code, message, ignored: sorted }) as const;

  if (read.kind !== "ok" || pluginJson === undefined) return refuse("CLAUDE_CODE_MANIFEST_INVALID", NOT_JSON);
  const pluginId = typeof pluginJson.name === "string" ? pluginJson.name : "";
  if (!PLUGIN_ID_PATTERN.test(pluginId)) return refuse("CLAUDE_CODE_MANIFEST_INVALID", NO_ID);
  const name = typeof pluginJson.displayName === "string" ? pluginJson.displayName : pluginId;
  if (!SHAPE.name.safeParse(name).success) return refuse("CLAUDE_CODE_MANIFEST_INVALID", NO_NAME);

  const pieces: PluginPiece[] = [...skills, ...connectors.pieces];
  if (pieces.length === 0) return refuse("NOTHING_TO_INSTALL", NOTHING);
  if (pieces.length > PLUGIN_LIMITS.maxPieces) {
    return refuse(
      "TOO_MANY_PIECES",
      `It has ${pieces.length} parts GoatCitadel could take; one plugin can hold ${PLUGIN_LIMITS.maxPieces}.`,
    );
  }
  const description = manifestDescription(pluginJson.description, ignored);
  const finalIgnored = sortParts(ignored);
  const manifest = {
    schemaVersion: 1,
    pluginId,
    name,
    description,
    version: SHAPE.version.safeParse(pluginJson.version).success
      ? (pluginJson.version as string)
      : `content-${input.treeSha256.slice(0, 12)}`,
    ...optional("author", authorOf(pluginJson.author)),
    ...optional("homepage", SHAPE.homepage.safeParse(pluginJson.homepage).success ? pluginJson.homepage : undefined),
    pieces,
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const parsed = parsePluginManifest(manifestText);
  if (!parsed.ok) {
    input.log?.warn(
      { code: parsed.code, field: parsed.field, message: parsed.message },
      "a Claude Code translation was refused",
    );
    return { ok: false, code: "CLAUDE_CODE_MANIFEST_INVALID", message: TRANSLATOR_FAULT, ignored: finalIgnored };
  }
  return {
    ok: true,
    translation: {
      manifestText,
      pluginJsonSha256: createHash("sha256").update(read.bytes).digest("hex"),
      ignored: finalIgnored,
      coverage: {
        usable: pieces.length,
        total: pieces.length + finalIgnored.filter((part) => part.kind !== "manifest_field").length,
      },
      pieceWarnings: connectors.warnings,
    },
  };
}

/** Each folder holding a SKILL.md: every child of `skills/`, and each path plugin.json's `skills` names. */
async function skillPieces(
  files: ClaudeCodePluginFiles,
  pluginJson: Record<string, unknown>,
  ignored: CapabilityPluginIgnoredPart[],
): Promise<PluginPiece[]> {
  const folders = new Set<string>();
  const addChildren = async (dir: string) => {
    for (const entry of await files.list(dir)) {
      if (entry.kind === "dir" && (await files.kindOf(`${dir}/${entry.name}/SKILL.md`)) === "file") {
        folders.add(`${dir}/${entry.name}`);
      }
    }
  };
  await addChildren("skills");
  for (const raw of stringsOf(pluginJson.skills)) {
    const dir = pluginRelativePath(raw);
    if (dir === undefined) {
      ignored.push(outside("skill", raw));
      continue;
    }
    if ((await files.kindOf(`${dir}/SKILL.md`)) === "file") folders.add(dir);
    else await addChildren(dir);
  }
  if ((await files.kindOf("SKILL.md")) === "file") {
    ignored.push({ path: "SKILL.md", kind: "skill", label: "SKILL.md", reason: TOP_LEVEL_SKILL });
  }
  const taken = new Set<string>();
  return [...folders].sort(compareStrings).map((folder, index) => {
    const folderName = folder.slice(folder.lastIndexOf("/") + 1);
    // A folder named like a generated id (`skill-<n>`, `connector-<n>`) would collide with one, so it gets a fallback.
    const generated = /^(?:skill|connector)-\d+$/u.test(folderName);
    const id =
      PLUGIN_PIECE_ID_PATTERN.test(folderName) && !generated && !taken.has(folderName)
        ? folderName
        : `skill-${index + 1}`;
    taken.add(id);
    return { kind: "skill", id, path: folder };
  });
}

/** The servers of `.mcp.json` and plugin.json's `mcpServers`, matched in server-name order. */
async function connectorPieces(
  files: ClaudeCodePluginFiles,
  pluginJson: Record<string, unknown>,
  templates: readonly McpServerTemplateRecord[],
  ignored: CapabilityPluginIgnoredPart[],
): Promise<{ pieces: PluginPiece[]; warnings: Record<string, string[]> }> {
  const entries: ClaudeCodeMcpServerEntry[] = [];
  const readServerFile = async (relativePath: string) => {
    const read = await files.readJson(relativePath);
    if (read.kind === "missing") return;
    if (read.kind === "unreadable" || !isPlainObject(read.value)) {
      ignored.push({ path: relativePath, kind: "mcp_server", label: relativePath, reason: UNREADABLE_SERVER });
      return;
    }
    entries.push(...serverEntries(read.value, relativePath));
  };
  await readServerFile(".mcp.json");
  const declared = pluginJson.mcpServers;
  if (isPlainObject(declared)) entries.push(...serverEntries(declared, CLAUDE_CODE_PLUGIN_MANIFEST_PATH));
  else {
    for (const raw of stringsOf(declared)) {
      const relativePath = pluginRelativePath(raw);
      if (relativePath === undefined) ignored.push(outside("mcp_server", raw));
      else if (relativePath !== ".mcp.json") await readServerFile(relativePath);
    }
  }
  const pieces: PluginPiece[] = [];
  const warnings: Record<string, string[]> = {};
  const takenTemplates = new Set<string>();
  const ordered = [...entries].sort(
    (left, right) => compareStrings(left.name, right.name) || compareStrings(left.definedIn, right.definedIn),
  );
  for (const entry of ordered) {
    const match = matchClaudeCodeMcpServer(entry, templates);
    const part = { path: entry.definedIn, kind: "mcp_server" as const, label: entry.name };
    if (match.kind === "left_out") ignored.push({ ...part, reason: match.reason });
    else if (takenTemplates.has(match.templateId)) ignored.push({ ...part, reason: SAME_APP });
    else {
      takenTemplates.add(match.templateId);
      const id = `connector-${pieces.length + 1}`;
      pieces.push({ kind: "connector", id, templateId: match.templateId, asksFirst: "changes" });
      if (match.dropsOwnSignIn) warnings[id] = [OWN_SIGN_IN_DROPPED];
    }
  }
  return { pieces, warnings };
}

function serverEntries(document: Record<string, unknown>, definedIn: string): ClaudeCodeMcpServerEntry[] {
  const map = isPlainObject(document.mcpServers) ? document.mcpServers : document;
  return Object.entries(map).map(([name, config]) => ({ name, definedIn, config }));
}

function manifestDescription(value: unknown, ignored: CapabilityPluginIgnoredPart[]): string {
  if (SHAPE.description.safeParse(value).success) return value as string;
  if (value !== undefined) {
    ignored.push({
      path: CLAUDE_CODE_PLUGIN_MANIFEST_PATH,
      kind: "manifest_field",
      label: "description",
      reason: BAD_DESCRIPTION,
    });
  }
  return NO_DESCRIPTION;
}

function authorOf(value: unknown): string | undefined {
  const author = isPlainObject(value) ? value.name : value;
  return typeof author === "string" && SHAPE.author.safeParse(author).success ? author : undefined;
}

function optional<K extends string>(key: K, value: unknown): Partial<Record<K, unknown>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, unknown>);
}

/** By kind, then path, then label; one entry per kind, path and label. */
function sortParts(parts: readonly CapabilityPluginIgnoredPart[]): CapabilityPluginIgnoredPart[] {
  const unique = new Map(parts.map((part) => [`${part.kind}\u0000${part.path}\u0000${part.label}`, part]));
  return [...unique.values()].sort(
    (left, right) =>
      compareStrings(left.kind, right.kind) ||
      compareStrings(left.path, right.path) ||
      compareStrings(left.label, right.label),
  );
}
