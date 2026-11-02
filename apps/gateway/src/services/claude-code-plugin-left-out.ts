import {
  CLAUDE_CODE_PLUGIN_MANIFEST_PATH,
  type CapabilityPluginIgnoredKind,
  type CapabilityPluginIgnoredPart,
} from "@goatcitadel/contracts";
import {
  isPlainObject,
  pluginRelativePath,
  stringsOf,
  type ClaudeCodePluginFiles,
} from "./claude-code-plugin-files.js";

// The parts of a Claude Code plugin GoatCitadel leaves out, one entry each with a plain reason. Skills and remote
// servers are the translator's own; everything here is listed and never read past its name.

export const CLAUDE_CODE_LEFT_OUT = {
  outside: "Points outside the plugin, so GoatCitadel leaves it out.",
  command: "A command. GoatCitadel doesn't take commands from plugins.",
  agent: "A subagent. GoatCitadel's agents aren't set by plugins.",
  hook: "Hooks that run code or change what happens. Plugin hooks in GoatCitadel can only watch.",
  output_style:
    "An output style, which changes how every reply is written. Plugins can only add instructions as skills.",
  lsp_server: "A language server, which would run a program. Plugins run no code.",
  monitor: "A background command, which would run a program. Plugins run no code.",
  executable: "A program for the command line. Plugins run no code.",
  settings: "Claude Code settings. GoatCitadel doesn't take settings from plugins.",
  userConfig:
    "Values Claude Code asks for when the plugin is switched on. GoatCitadel never asks for them, and nothing that would read them comes across.",
  dependencies: "Other plugins it needs. GoatCitadel doesn't fetch them.",
  unused: "GoatCitadel doesn't use this.",
} as const;

/** plugin.json keys the generated manifest reads, or that the translator's skills and servers read. */
const READ_KEYS: ReadonlySet<string> = new Set([
  "name",
  "displayName",
  "description",
  "version",
  "author",
  "homepage",
  "skills",
  "mcpServers",
]);
const PATH_KEYS = { commands: "command", agents: "agent", outputStyles: "output_style" } as const;
const OWN_KEYS: ReadonlySet<string> = new Set([...Object.keys(PATH_KEYS), "hooks", "lspServers"]);
const PLUGIN_JSON = CLAUDE_CODE_PLUGIN_MANIFEST_PATH;

/** Every left-out part the folders and plugin.json show, unsorted. */
export async function leftOutPartsOf(
  files: ClaudeCodePluginFiles,
  pluginJson: Record<string, unknown>,
): Promise<CapabilityPluginIgnoredPart[]> {
  return [
    ...(await mdFilesUnder(files, "commands", "command", true)),
    ...(await mdFilesUnder(files, "agents", "agent", false)),
    ...(await filesIn(files, "hooks", "hook", true)),
    ...(await filesIn(files, "output-styles", "output_style", false)),
    ...(await lspServersIn(files, ".lsp.json")),
    ...(await filesIn(files, "monitors", "monitor", false)),
    ...(await filesIn(files, "bin", "executable", false)),
    ...(await settingsParts(files)),
    ...(await pluginJsonParts(files, pluginJson)),
  ];
}

async function pluginJsonParts(
  files: ClaudeCodePluginFiles,
  pluginJson: Record<string, unknown>,
): Promise<CapabilityPluginIgnoredPart[]> {
  const parts: CapabilityPluginIgnoredPart[] = [];
  for (const [key, kind] of Object.entries(PATH_KEYS)) {
    if (pluginJson[key] !== undefined) parts.push(...(await namedPaths(files, pluginJson[key], kind, key)));
  }
  const hooks = pluginJson.hooks;
  if (typeof hooks === "string" || Array.isArray(hooks))
    parts.push(...(await namedPaths(files, hooks, "hook", "hooks")));
  else if (hooks !== undefined) parts.push(part(PLUGIN_JSON, "hook", "Hooks in plugin.json"));
  const lsp = pluginJson.lspServers;
  if (isPlainObject(lsp)) parts.push(...Object.keys(lsp).map((name) => part(PLUGIN_JSON, "lsp_server", name)));
  else {
    for (const raw of stringsOf(lsp)) {
      const relativePath = pluginRelativePath(raw);
      parts.push(
        ...(relativePath === undefined ? [outsidePart("lsp_server", raw)] : await lspServersIn(files, relativePath)),
      );
    }
  }
  for (const key of Object.keys(pluginJson).sort()) {
    if (READ_KEYS.has(key) || OWN_KEYS.has(key)) continue;
    const reason =
      key === "userConfig"
        ? CLAUDE_CODE_LEFT_OUT.userConfig
        : key === "dependencies"
          ? CLAUDE_CODE_LEFT_OUT.dependencies
          : CLAUDE_CODE_LEFT_OUT.unused;
    parts.push({ path: PLUGIN_JSON, kind: "manifest_field", label: key, reason });
  }
  return parts;
}

/** The files plugin.json's key names: each file, or each file in a named folder. Anything else is one part. */
async function namedPaths(
  files: ClaudeCodePluginFiles,
  value: unknown,
  kind: CapabilityPluginIgnoredKind,
  key: string,
): Promise<CapabilityPluginIgnoredPart[]> {
  const raws = stringsOf(value);
  if (raws.length === 0) return [part(PLUGIN_JSON, kind, key)];
  const parts: CapabilityPluginIgnoredPart[] = [];
  for (const raw of raws) {
    const relativePath = pluginRelativePath(raw);
    if (relativePath === undefined) parts.push(outsidePart(kind, raw));
    else if ((await files.kindOf(relativePath)) === "dir")
      parts.push(...(await filesIn(files, relativePath, kind, true)));
    else parts.push(part(relativePath, kind, fileLabel(relativePath, kind)));
  }
  return parts;
}

async function mdFilesUnder(
  files: ClaudeCodePluginFiles,
  dir: string,
  kind: CapabilityPluginIgnoredKind,
  deep: boolean,
): Promise<CapabilityPluginIgnoredPart[]> {
  const found = deep
    ? await files.listFilesDeep(dir)
    : (await files.list(dir)).filter((entry) => entry.kind === "file").map((entry) => `${dir}/${entry.name}`);
  return found.filter((file) => file.endsWith(".md")).map((file) => part(file, kind, fileLabel(file, kind)));
}

async function filesIn(
  files: ClaudeCodePluginFiles,
  dir: string,
  kind: CapabilityPluginIgnoredKind,
  deep: boolean,
): Promise<CapabilityPluginIgnoredPart[]> {
  const found = deep ? await files.listFilesDeep(dir) : (await files.list(dir)).map((entry) => `${dir}/${entry.name}`);
  const named = kind === "command" || kind === "agent" ? found.filter((file) => file.endsWith(".md")) : found;
  return named.map((file) => part(file, kind, fileLabel(file, kind)));
}

/** One part per server a language-server file names; one for the file when it can't be read. */
async function lspServersIn(
  files: ClaudeCodePluginFiles,
  relativePath: string,
): Promise<CapabilityPluginIgnoredPart[]> {
  const read = await files.readJson(relativePath);
  if (read.kind === "missing") return [];
  if (read.kind === "ok" && isPlainObject(read.value)) {
    return Object.keys(read.value).map((name) => part(relativePath, "lsp_server", name));
  }
  return [part(relativePath, "lsp_server", baseName(relativePath))];
}

async function settingsParts(files: ClaudeCodePluginFiles): Promise<CapabilityPluginIgnoredPart[]> {
  const parts: CapabilityPluginIgnoredPart[] = [];
  if ((await files.kindOf("settings.json")) === "file") parts.push(part("settings.json", "settings", "settings.json"));
  for (const dir of ["themes", "workflows"]) {
    if ((await files.kindOf(dir)) === "dir") parts.push(part(dir, "settings", dir));
  }
  return parts;
}

function part(path: string, kind: CapabilityPluginIgnoredKind, label: string): CapabilityPluginIgnoredPart {
  const reason =
    kind === "manifest_field" || kind === "skill" || kind === "mcp_server"
      ? CLAUDE_CODE_LEFT_OUT.unused
      : CLAUDE_CODE_LEFT_OUT[kind];
  return { path, kind, label, reason };
}

export function outsidePart(kind: CapabilityPluginIgnoredKind, raw: string): CapabilityPluginIgnoredPart {
  return { path: raw, kind, label: baseName(raw) || raw, reason: CLAUDE_CODE_LEFT_OUT.outside };
}

function fileLabel(file: string, kind: CapabilityPluginIgnoredKind): string {
  const name = baseName(file);
  return (kind === "command" || kind === "agent") && name.endsWith(".md") ? name.slice(0, -3) : name;
}

function baseName(value: string): string {
  return value.split(/[\\/]/u).filter(Boolean).pop() ?? "";
}
