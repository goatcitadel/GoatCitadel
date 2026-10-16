import path from "node:path";
import type { ToolPolicyConfig } from "@goatcitadel/contracts";
import { assertWritePathInJail } from "./path-jail.js";
import {
  classifyHardForbiddenWritePath,
  isSamePathOrDescendant,
  type WriteRootSafetyContext,
} from "./write-root-safety.js";

/**
 * Central write gate for model-driven filesystem, artifact, and browser-output
 * tools. Both the policy engine (structural check) and the tool executor
 * (execution-time re-check) call it, so a widening never reaches only one of
 * the two gates.
 *
 * - `write` targets may live in the runtime write jail or any operator write root.
 * - `delete` targets (fs.delete, the source of fs.move) may live in the jail or
 *   only in operator roots that opted into `allowDelete`.
 * - Hard-forbidden targets (system, credential, profile, runtime config/secrets/
 *   database/audit paths) are refused everywhere, even inside an allowed root.
 * - A delete may not remove a write root itself.
 */
export type ToolWriteIntent = "write" | "delete";

type ToolSandbox = ToolPolicyConfig["sandbox"];

/** Operator-opened folders admitted for the given intent. */
export function operatorWriteRootPaths(sandbox: ToolSandbox, intent: ToolWriteIntent = "write"): string[] {
  return (sandbox.operatorWriteRoots ?? [])
    .filter((root) => intent === "write" || root.allowDelete)
    .map((root) => root.path);
}

/** Roots a tool may write (or delete) into: the runtime jail plus admitted operator roots. */
export function effectiveToolWriteRoots(sandbox: ToolSandbox, intent: ToolWriteIntent = "write"): string[] {
  return [...sandbox.writeJailRoots, ...operatorWriteRootPaths(sandbox, intent)];
}

/** Writable roots that also count as readable for filesystem tools (jail plus every operator root). */
export function toolReadableWriteRoots(sandbox: ToolSandbox): string[] {
  return effectiveToolWriteRoots(sandbox, "write");
}

/** Assert a tool may write or delete `targetPath`; returns the resolved target. */
export function assertToolWritePath(
  targetPath: string,
  sandbox: ToolSandbox,
  intent: ToolWriteIntent = "write",
): string {
  const resolvedTarget = assertWritePathInJail(targetPath, effectiveToolWriteRoots(sandbox, intent));
  assertNotHardForbiddenWritePath(resolvedTarget, sandbox);
  if (intent === "delete") {
    assertNotWriteRootItself(resolvedTarget, sandbox);
  }
  return resolvedTarget;
}

/** Refuse hard-forbidden targets regardless of which root or grant admitted them. */
export function assertNotHardForbiddenWritePath(resolvedTarget: string, sandbox: ToolSandbox): void {
  const rejection = classifyHardForbiddenWritePath(path.resolve(resolvedTarget), writeSafetyContext(sandbox));
  if (rejection) {
    throw new Error(`Path is protected and cannot be written by tools (${rejection}): ${resolvedTarget}`);
  }
}

function assertNotWriteRootItself(resolvedTarget: string, sandbox: ToolSandbox): void {
  const roots = [...sandbox.writeJailRoots, ...operatorWriteRootPaths(sandbox, "write")];
  const isRoot = roots.some(
    (root) => isSamePathOrDescendant(root, resolvedTarget) && isSamePathOrDescendant(resolvedTarget, root),
  );
  if (isRoot) {
    throw new Error(`A write root cannot be deleted by tools; delete items inside it instead: ${resolvedTarget}`);
  }
}

function writeSafetyContext(sandbox: ToolSandbox): WriteRootSafetyContext {
  const protection = sandbox.runtimeWriteProtection;
  return protection ? { rootDir: protection.rootDir, protectedRuntimePaths: protection.protectedPaths } : {};
}
