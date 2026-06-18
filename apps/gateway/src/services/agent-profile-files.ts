import fs from "node:fs/promises";
import path from "node:path";
import type {
  AgenticContextMode,
  AgenticSurface,
  AgenticWorkspaceKind,
  AgentProfileFileRecord,
} from "@goatcitadel/contracts";

export type ProjectAgentProfileFileStatus = "enabled" | "disabled";

export interface ProjectAgentProfileFileRecord extends AgentProfileFileRecord {
  status: ProjectAgentProfileFileStatus;
  enabled: boolean;
  disabledReason?: string;
}

const VALID_CONTEXT_MODES = new Set<AgenticContextMode>(["isolated", "fork"]);
const VALID_SURFACES = new Set<AgenticSurface>(["chat", "cowork", "code"]);
const VALID_WORKSPACE_KINDS = new Set<AgenticWorkspaceKind>(["none", "session", "worktree", "external_harness"]);

export async function discoverProjectAgentProfiles(input: {
  projectRoot: string;
}): Promise<ProjectAgentProfileFileRecord[]> {
  const agentsDir = path.join(input.projectRoot, ".goatcitadel", "agents");
  let entries: Array<{ name: string; isFile: () => boolean }>;
  try {
    entries = await fs.readdir(agentsDir, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const profilePaths = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".yaml"))
    .map((entry) => path.join(agentsDir, entry.name))
    .sort((left, right) => left.localeCompare(right));

  return Promise.all(profilePaths.map((profilePath) => readProjectAgentProfile(profilePath, input.projectRoot)));
}

export async function readProjectAgentProfile(
  profilePath: string,
  projectRoot = process.cwd(),
): Promise<ProjectAgentProfileFileRecord> {
  const relPath = normalizeRelPath(path.relative(projectRoot, profilePath));
  const fallback = buildDisabledProfileFallback(profilePath, relPath);
  try {
    const source = await fs.readFile(profilePath, "utf8");
    const parsed = parseConservativeYamlObject(source);
    return {
      ...validateAgentProfileFileRecord(parsed, relPath),
      status: "enabled",
      enabled: true,
    };
  } catch (error) {
    return {
      ...fallback,
      status: "disabled",
      enabled: false,
      disabledReason: error instanceof Error ? error.message : String(error),
    };
  }
}

export function validateAgentProfileFileRecord(raw: Record<string, unknown>, relPath: string): AgentProfileFileRecord {
  const profileId = requireText(raw.profileId, "profileId");
  const name = requireText(raw.name, "name");
  const description = requireText(raw.description, "description");
  const tools = requireStringList(raw.tools, "tools");
  const contextMode = requireEnum(raw.contextMode, "contextMode", VALID_CONTEXT_MODES);
  const maxIterations = optionalPositiveInteger(raw.maxIterations, "maxIterations");
  const requiresApproval = optionalStringList(raw.requiresApproval, "requiresApproval");
  const surfaces = optionalEnumList(raw.surfaces, "surfaces", VALID_SURFACES);
  const workspaceKind =
    raw.workspaceKind === undefined
      ? undefined
      : requireEnum(raw.workspaceKind, "workspaceKind", VALID_WORKSPACE_KINDS);

  return {
    profileId,
    path: relPath,
    name,
    description,
    tools,
    contextMode,
    ...(maxIterations !== undefined ? { maxIterations } : {}),
    ...(requiresApproval !== undefined ? { requiresApproval } : {}),
    ...(surfaces !== undefined ? { surfaces } : {}),
    ...(workspaceKind !== undefined ? { workspaceKind } : {}),
  };
}

function buildDisabledProfileFallback(profilePath: string, relPath: string): AgentProfileFileRecord {
  const stem = path.basename(profilePath, path.extname(profilePath));
  return {
    profileId: sanitizeFallbackId(stem),
    path: relPath,
    name: stem,
    description: "",
    tools: [],
    contextMode: "isolated",
  };
}

function parseConservativeYamlObject(source: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const lines = source
    .split(/\r?\n/u)
    .map((line) => stripYamlComment(line).replace(/\t/gu, "  "))
    .filter((line) => line.trim().length > 0);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const indent = line.match(/^ */u)?.[0].length ?? 0;
    if (indent !== 0) {
      throw new Error(`Invalid YAML profile at line ${index + 1}: nested mappings are not supported.`);
    }
    const { key, value } = splitYamlKeyValue(line.trim(), index + 1);
    if (value !== undefined) {
      root[key] = parseYamlScalar(value);
      continue;
    }
    const list: unknown[] = [];
    let cursor = index + 1;
    for (; cursor < lines.length; cursor += 1) {
      const childLine = lines[cursor]!;
      const childIndent = childLine.match(/^ */u)?.[0].length ?? 0;
      const childText = childLine.trim();
      if (childIndent === 0) {
        break;
      }
      if (!childText.startsWith("- ")) {
        throw new Error(`Invalid YAML profile at line ${cursor + 1}: only scalar lists are supported.`);
      }
      list.push(parseYamlScalar(childText.slice(2).trim()));
    }
    root[key] = list;
    index = cursor - 1;
  }

  return root;
}

function splitYamlKeyValue(text: string, lineNumber: number): { key: string; value?: string } {
  const separator = text.indexOf(":");
  if (separator < 1) {
    throw new Error(`Invalid YAML profile at line ${lineNumber}: expected key/value mapping.`);
  }
  const key = text.slice(0, separator).trim();
  const value = text.slice(separator + 1).trim();
  return { key, value: value.length > 0 ? value : undefined };
}

function parseYamlScalar(value: string): unknown {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (/^-?\d+$/u.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) {
      return [];
    }
    return inner.split(",").map((item) => parseYamlScalar(item.trim()));
  }
  return trimmed;
}

function requireText(raw: unknown, field: string): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error(`Invalid agent profile: ${field} must be a non-empty string.`);
  }
  return raw.trim();
}

function requireStringList(raw: unknown, field: string): string[] {
  const values = optionalStringList(raw, field);
  if (!values || values.length === 0) {
    throw new Error(`Invalid agent profile: ${field} must include at least one string.`);
  }
  return values;
}

function optionalStringList(raw: unknown, field: string): string[] | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (!Array.isArray(raw)) {
    throw new Error(`Invalid agent profile: ${field} must be a string list.`);
  }
  const normalized = Array.from(
    new Set(raw.map((value) => (typeof value === "string" ? value.trim() : "")).filter((value) => value.length > 0)),
  );
  if (normalized.length !== raw.length) {
    throw new Error(`Invalid agent profile: ${field} must contain only non-empty strings.`);
  }
  return normalized;
}

function requireEnum<TValue extends string>(raw: unknown, field: string, allowed: Set<TValue>): TValue {
  if (typeof raw !== "string" || !allowed.has(raw as TValue)) {
    throw new Error(`Invalid agent profile: ${field} must be one of ${Array.from(allowed).join(", ")}.`);
  }
  return raw as TValue;
}

function optionalEnumList<TValue extends string>(
  raw: unknown,
  field: string,
  allowed: Set<TValue>,
): TValue[] | undefined {
  const values = optionalStringList(raw, field);
  if (!values) {
    return undefined;
  }
  for (const value of values) {
    if (!allowed.has(value as TValue)) {
      throw new Error(`Invalid agent profile: ${field} contains unsupported value "${value}".`);
    }
  }
  return values as TValue[];
}

function optionalPositiveInteger(raw: unknown, field: string): number | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
    throw new Error(`Invalid agent profile: ${field} must be a positive integer.`);
  }
  return raw;
}

function stripYamlComment(line: string): string {
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if ((char === '"' || char === "'") && line[index - 1] !== "\\") {
      quote = quote === char ? undefined : (quote ?? char);
      continue;
    }
    if (char === "#" && quote === undefined) {
      return line.slice(0, index).trimEnd();
    }
  }
  return line;
}

function sanitizeFallbackId(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/gu, "-")
      .replace(/^-+|-+$/gu, "") || "invalid-profile"
  );
}

function normalizeRelPath(value: string): string {
  return value.replace(/\\/gu, "/");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
