import fs from "node:fs";
import path from "node:path";
import {
  OPERATOR_WRITE_ROOT_LIMIT,
  SWITCHABLE_TOOL_GROUP_IDS,
  ValidationError,
  isGlobalToolAccessChange,
  isOperatorWriteRootChange,
  isToolGroupChange,
  type GlobalToolAccessChange,
  type GlobalToolAccessSummary,
  type OperatorWriteRoot,
  type OperatorWriteRootChange,
  type OperatorWriteRootSummary,
  type ToolGroupChange,
  type ToolGroupId,
  type ToolPolicyConfig,
} from "@goatcitadel/contracts";
import {
  canonicalizeOperatorWriteRoot,
  matchesToolPattern,
  resolveWriteRootPreset,
  type WriteRootSafetyContext,
} from "@goatcitadel/policy-engine";
import type { PluginToolGroupHoldSummary } from "./gateway/runtime-settings.js";
import { PluginOwnedError } from "./plugin-owned-refusal.js";

/**
 * Settings-owner rules for operator write roots, the global posture of the
 * curated filesystem mutation tools, and which tool groups are switched off.
 * These helpers mutate only the candidate tool policy they are handed (settings
 * candidates are isolated clones); the live config changes through the shared
 * settings commit path, which updates the object the policy engine holds.
 */

export function projectOperatorWriteRoots(toolPolicy: ToolPolicyConfig): OperatorWriteRootSummary[] {
  return (toolPolicy.sandbox.operatorWriteRoots ?? []).map((root) => ({
    path: root.path,
    allowDelete: root.allowDelete,
    ...(root.label !== undefined ? { label: root.label } : {}),
    ...(root.preset !== undefined ? { preset: root.preset } : {}),
    ...(root.addedAt !== undefined ? { addedAt: root.addedAt } : {}),
  }));
}

export function projectGlobalToolAccess(toolPolicy: ToolPolicyConfig): GlobalToolAccessSummary {
  return { deny: [...(toolPolicy.tools.deny ?? [])], allow: [...(toolPolicy.tools.allow ?? [])] };
}

/**
 * The switchable groups that are off, once each, in the group map's order. `disabledGroups` can be hand-edited,
 * so a value that is not a list reads as nothing switched off, and Core, unknown ids and non-strings are dropped.
 */
export function projectSwitchedOffToolGroups(toolPolicy: Pick<ToolPolicyConfig, "tools">): ToolGroupId[] {
  const disabled: unknown = toolPolicy.tools.disabledGroups;
  return Array.isArray(disabled) ? SWITCHABLE_TOOL_GROUP_IDS.filter((groupId) => disabled.includes(groupId)) : [];
}

/**
 * The holds plugins keep on switchable groups, in the group map's order and then the order given. Core and unknown ids
 * are never held, as the policy engine ignores them too.
 */
export function projectPluginToolGroupHolds(
  holds: readonly { groupId: string; pluginId: string; pluginName: string }[],
): PluginToolGroupHoldSummary[] {
  return SWITCHABLE_TOOL_GROUP_IDS.flatMap((groupId) =>
    holds
      .filter((hold) => hold.groupId === groupId)
      .map((hold) => ({ groupId, pluginId: hold.pluginId, pluginName: hold.pluginName })),
  );
}

/** What reads off: the operator's own switch and every held group, once each, in the group map's order. */
export function unionSwitchedOffToolGroups(
  switchedOff: readonly ToolGroupId[],
  holds: readonly PluginToolGroupHoldSummary[],
): ToolGroupId[] {
  const off = new Set<ToolGroupId>([...switchedOff, ...holds.map((hold) => hold.groupId)]);
  return SWITCHABLE_TOOL_GROUP_IDS.filter((groupId) => off.has(groupId));
}

export function applyOperatorWriteRootChange(
  toolPolicy: ToolPolicyConfig,
  change: OperatorWriteRootChange,
  now: () => Date = () => new Date(),
): void {
  if (!isOperatorWriteRootChange(change)) {
    throw new ValidationError({ message: "operatorWriteRootChange is not a valid operator write-root change." });
  }
  const current = toolPolicy.sandbox.operatorWriteRoots ?? [];
  if (change.action === "remove") {
    const index = findOperatorWriteRoot(current, change);
    if (index < 0) {
      throw new ValidationError({ message: "That folder is not an operator write root." });
    }
    toolPolicy.sandbox.operatorWriteRoots = current.filter((_, position) => position !== index);
    return;
  }

  const ctx = writeRootSafetyContext(toolPolicy);
  const requestedPath = change.preset ? resolveWriteRootPreset(change.preset, ctx) : (change.path as string).trim();
  const canonical = canonicalizeOperatorWriteRoot(requestedPath, ctx);
  if (!canonical.ok) {
    throw new ValidationError({
      field: "operatorWriteRootChange.path",
      message: `Folder cannot be an operator write root (${canonical.rejection}): ${canonical.detail}`,
    });
  }
  if (current.some((root) => samePath(root.path, canonical.canonicalPath))) {
    throw new ValidationError({
      message: `${canonical.canonicalPath} is already an operator write root. Remove it first to change its settings.`,
    });
  }
  if (change.preset && current.some((root) => root.preset === change.preset)) {
    throw new ValidationError({ message: `The ${change.preset} preset is already an operator write root.` });
  }
  if (current.length >= OPERATOR_WRITE_ROOT_LIMIT) {
    throw new ValidationError({ message: `At most ${OPERATOR_WRITE_ROOT_LIMIT} operator write roots are supported.` });
  }
  const label = change.label?.trim();
  const added: OperatorWriteRoot = {
    path: canonical.canonicalPath,
    allowDelete: change.allowDelete ?? false,
    ...(label ? { label } : {}),
    ...(change.preset ? { preset: change.preset } : {}),
    addedAt: now().toISOString(),
  };
  toolPolicy.sandbox.operatorWriteRoots = [...current, added];
}

export function applyGlobalToolAccessChange(toolPolicy: ToolPolicyConfig, change: GlobalToolAccessChange): void {
  if (!isGlobalToolAccessChange(change)) {
    throw new ValidationError({
      message: "globalToolAccessChange must name a curated filesystem mutation tool and a known posture.",
    });
  }
  const { toolName, posture } = change;
  const deny = (toolPolicy.tools.deny ?? []).filter((entry) => entry.trim() !== toolName);
  const allow = (toolPolicy.tools.allow ?? []).filter((entry) => entry.trim() !== toolName);
  if (posture === "denied") deny.push(toolName);
  if (posture === "available") {
    const blockingPattern = deny.find((pattern) => matchesToolPattern(pattern, toolName));
    if (blockingPattern) {
      throw new ValidationError({
        message: `${toolName} stays denied by the global deny pattern "${blockingPattern}". Edit that pattern first.`,
      });
    }
    allow.push(toolName);
  }
  toolPolicy.tools.deny = deny;
  toolPolicy.tools.allow = allow;
}

/**
 * Switches one group off or on. Only `tools.disabledGroups` changes, so tools.allow, tools.deny and every other
 * deny keep their say. The list is rewritten once per group in the group map's order, dropping unusable entries.
 */
export function applyToolGroupChange(
  toolPolicy: ToolPolicyConfig,
  change: ToolGroupChange,
  holds: readonly { groupId: string; pluginId: string; pluginName: string }[] = [],
): void {
  if (!isToolGroupChange(change)) {
    throw new ValidationError({
      message: "toolGroupChange must name a tool group other than Core, and say whether to switch it on.",
    });
  }
  // A group a plugin holds off is that plugin's piece: only uninstalling it switches the group back on, so the first
  // holder is named. Switching a held group off is the operator's own switch, kept after the hold is released.
  const holder = change.enabled ? holds.find((hold) => hold.groupId === change.groupId) : undefined;
  if (holder) throw new PluginOwnedError({ pluginId: holder.pluginId, name: holder.pluginName });
  const switchedOff = new Set(projectSwitchedOffToolGroups(toolPolicy));
  if (change.enabled) switchedOff.delete(change.groupId);
  else switchedOff.add(change.groupId);
  toolPolicy.tools.disabledGroups = SWITCHABLE_TOOL_GROUP_IDS.filter((groupId) => switchedOff.has(groupId));
}

function writeRootSafetyContext(toolPolicy: ToolPolicyConfig): WriteRootSafetyContext {
  const protection = toolPolicy.sandbox.runtimeWriteProtection;
  if (!protection) {
    // Without the derived runtime protection the safety rules cannot see the
    // runtime's own config, secrets, and audit trees, so fail closed.
    throw new ValidationError({
      message: "Runtime write protection is unavailable; operator write roots cannot be changed.",
    });
  }
  return { rootDir: protection.rootDir, protectedRuntimePaths: protection.protectedPaths };
}

function findOperatorWriteRoot(roots: readonly OperatorWriteRoot[], change: OperatorWriteRootChange): number {
  return change.preset
    ? roots.findIndex((root) => root.preset === change.preset)
    : roots.findIndex((root) => isSameOperatorWriteRootFolder(root.path, change.path ?? ""));
}

/**
 * True when a requested folder names a configured root: lexically (case-folded
 * on Windows, trailing separators ignored) or through its real path.
 */
export function isSameOperatorWriteRootFolder(configuredPath: string, requestedPath: string): boolean {
  if (!requestedPath.trim()) return false;
  const lexical = path.resolve(requestedPath.trim());
  if (samePath(configuredPath, lexical)) return true;
  try {
    return samePath(configuredPath, fs.realpathSync.native(lexical));
  } catch {
    return false;
  }
}

function samePath(left: string, right: string): boolean {
  return foldPath(left) === foldPath(right);
}

function foldPath(value: string): string {
  const resolved = path.resolve(value);
  const trimmed = resolved.length > path.parse(resolved).root.length ? resolved.replace(/[\\/]+$/u, "") : resolved;
  return process.platform === "win32" ? trimmed.toLowerCase() : trimmed;
}
