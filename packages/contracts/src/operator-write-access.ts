/**
 * Governed operator changes to where model-driven filesystem tools may write
 * and to the global posture of the curated filesystem mutation tools. The
 * Gateway settings owner validates and applies them; Settings and Change Plans
 * share these shapes so neither becomes a second mutation authority.
 */

/** The only tools whose global allow/deny posture these changes may touch. */
export const CURATED_FS_MUTATION_TOOLS = ["fs.write", "fs.delete", "fs.copy", "fs.move", "fs.patch"] as const;
export type CuratedFsMutationTool = (typeof CURATED_FS_MUTATION_TOOLS)[number];

/**
 * `denied` lists the tool in the global deny list, `available` lists it in the
 * global allow list, and `unlisted` removes it from both (permission profiles
 * and agent policy then decide). Only exact entries change; wildcard patterns
 * stay as configured, and deny-wins still applies.
 */
export const GLOBAL_TOOL_ACCESS_POSTURES = ["denied", "available", "unlisted"] as const;
export type GlobalToolAccessPosture = (typeof GLOBAL_TOOL_ACCESS_POSTURES)[number];

export const OPERATOR_WRITE_ROOT_PRESETS = ["os_temp"] as const;
export type OperatorWriteRootPreset = (typeof OPERATOR_WRITE_ROOT_PRESETS)[number];

export const OPERATOR_WRITE_ROOT_PATH_MAX = 1024;
export const OPERATOR_WRITE_ROOT_LABEL_MAX = 120;
export const OPERATOR_WRITE_ROOT_LIMIT = 32;

/**
 * Add or remove one operator write root. Exactly one of `path` (absolute) or
 * `preset` names the folder; a preset is always resolved on the server.
 * `allowDelete` and `label` apply to `add` only, and `allowDelete` defaults to false.
 */
export interface OperatorWriteRootChange {
  readonly action: "add" | "remove";
  readonly path?: string;
  readonly preset?: OperatorWriteRootPreset;
  readonly allowDelete?: boolean;
  readonly label?: string;
}

export interface GlobalToolAccessChange {
  readonly toolName: CuratedFsMutationTool;
  readonly posture: GlobalToolAccessPosture;
}

/** The runtime-configuration Change Plan operations that carry these changes. */
export type RuntimeWriteAccessOperation =
  | ({ readonly operation: "operator_write_root" } & OperatorWriteRootChange)
  | ({ readonly operation: "tool_global_access" } & GlobalToolAccessChange);

/** Public projection of one configured operator write root. */
export interface OperatorWriteRootSummary {
  /** Canonical absolute folder path (resolved on the server for presets). */
  readonly path: string;
  readonly allowDelete: boolean;
  readonly label?: string;
  readonly preset?: OperatorWriteRootPreset;
  readonly addedAt?: string;
}

/** The global (not agent or profile) allow and deny tool lists, as configured. */
export interface GlobalToolAccessSummary {
  readonly deny: readonly string[];
  readonly allow: readonly string[];
}

export function isRuntimeWriteAccessOperation(value: unknown): value is RuntimeWriteAccessOperation {
  if (!isRecord(value)) return false;
  const { operation, ...change } = value;
  if (operation === "operator_write_root") return isOperatorWriteRootChange(change);
  return operation === "tool_global_access" && isGlobalToolAccessChange(change);
}

export function isCuratedFsMutationTool(value: unknown): value is CuratedFsMutationTool {
  return typeof value === "string" && (CURATED_FS_MUTATION_TOOLS as readonly string[]).includes(value);
}

export function isGlobalToolAccessChange(value: unknown): value is GlobalToolAccessChange {
  if (!isRecord(value) || !hasOnlyKeys(value, ["toolName", "posture"])) return false;
  return (
    isCuratedFsMutationTool(value.toolName) &&
    (GLOBAL_TOOL_ACCESS_POSTURES as readonly string[]).includes(String(value.posture))
  );
}

export function isOperatorWriteRootChange(value: unknown): value is OperatorWriteRootChange {
  if (!isRecord(value) || !hasOnlyKeys(value, ["action", "path", "preset", "allowDelete", "label"])) return false;
  if (value.action !== "add" && value.action !== "remove") return false;
  if ((value.path === undefined) === (value.preset === undefined)) return false;
  if (value.path !== undefined && !isOperatorWriteRootPathText(value.path)) return false;
  if (value.preset !== undefined && !(OPERATOR_WRITE_ROOT_PRESETS as readonly string[]).includes(String(value.preset)))
    return false;
  if (value.action === "remove") return value.allowDelete === undefined && value.label === undefined;
  if (value.allowDelete !== undefined && typeof value.allowDelete !== "boolean") return false;
  return value.label === undefined || isOperatorWriteRootLabel(value.label);
}

/**
 * Lexical check only: bounded, free of control characters, and absolute on
 * Windows (drive or UNC) or POSIX. The settings owner still canonicalizes the
 * folder against the write-root safety rules.
 */
export function isOperatorWriteRootPathText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= OPERATOR_WRITE_ROOT_PATH_MAX &&
    !hasControlCharacters(value) &&
    /^(?:[A-Za-z]:[\\/]|\\\\[^\\]|\/)/u.test(value.trim())
  );
}

export function isOperatorWriteRootLabel(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= OPERATOR_WRITE_ROOT_LABEL_MAX &&
    !hasControlCharacters(value)
  );
}

function hasControlCharacters(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
