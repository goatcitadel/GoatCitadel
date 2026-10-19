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
 * - A delete may not remove a write root itself, nor any folder that contains
 *   a runtime-protected path.
 * - An optional admission (a verified outside-root folder grant or approve-once
 *   target) adds folders for write intent only; hard-forbidden checks still run.
 */
export type ToolWriteIntent = "write" | "delete";

type ToolSandbox = ToolPolicyConfig["sandbox"];

/**
 * Operator-opened folders admitted for the given intent. Fails closed: without
 * runtime write protection (set by the gateway at config load) the protected
 * runtime paths cannot be enforced, so no operator root is admitted.
 */
export function operatorWriteRootPaths(sandbox: ToolSandbox, intent: ToolWriteIntent = "write"): string[] {
  if (!sandbox.runtimeWriteProtection) {
    return [];
  }
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

/**
 * Extra folders admitted for write-intent targets of one evaluation or one
 * execution: a verified outside-root folder grant, or the exact targets of a
 * verified approve-once outside-root write. Never applies to deletes and never
 * widens reads.
 */
export interface ToolWriteAdmission {
  roots: readonly string[];
}

/**
 * Process-local key for an execution-scoped admission. A symbol key cannot be
 * produced by parsed configuration, so a config file can never pre-admit
 * folders; only `withExecutionWriteAdmission` attaches it to a per-call copy.
 */
const EXECUTION_WRITE_ADMISSION = Symbol("goatcitadel.executionWriteAdmission");

type AdmissionCarrier = { [EXECUTION_WRITE_ADMISSION]?: ToolWriteAdmission };

/** Copy `config` with an execution-scoped admission for the write gate (or return it unchanged). */
export function withExecutionWriteAdmission(
  config: ToolPolicyConfig,
  admission: ToolWriteAdmission | undefined,
): ToolPolicyConfig {
  if (!admission || admission.roots.length === 0) return config;
  const sandbox: ToolSandbox & AdmissionCarrier = { ...config.sandbox, [EXECUTION_WRITE_ADMISSION]: admission };
  return { ...config, sandbox };
}

function admittedWriteRoots(sandbox: ToolSandbox, admission: ToolWriteAdmission | undefined): string[] {
  const carried = (sandbox as ToolSandbox & AdmissionCarrier)[EXECUTION_WRITE_ADMISSION];
  return [...(admission?.roots ?? []), ...(carried?.roots ?? [])];
}

/** Assert a tool may write or delete `targetPath`; returns the resolved target. */
export function assertToolWritePath(
  targetPath: string,
  sandbox: ToolSandbox,
  intent: ToolWriteIntent = "write",
  admission?: ToolWriteAdmission,
): string {
  const roots = effectiveToolWriteRoots(sandbox, intent);
  if (intent === "write") roots.push(...admittedWriteRoots(sandbox, admission));
  const resolvedTarget = assertWritePathInJail(targetPath, roots);
  assertNotHardForbiddenWritePath(resolvedTarget, sandbox);
  if (intent === "delete") {
    assertNotWriteRootItself(resolvedTarget, sandbox);
    assertNotProtectedPathAncestor(resolvedTarget, sandbox);
  }
  return resolvedTarget;
}

/**
 * A recursive delete (or moving away a folder) removes everything beneath the
 * target, so refuse any target that contains a runtime-protected path, even
 * when the target itself is not protected.
 */
function assertNotProtectedPathAncestor(resolvedTarget: string, sandbox: ToolSandbox): void {
  const protectedPaths = sandbox.runtimeWriteProtection?.protectedPaths ?? [];
  const contained = protectedPaths.find((protectedPath) => isSamePathOrDescendant(resolvedTarget, protectedPath));
  if (contained) {
    throw new Error(
      `Path contains a protected runtime folder and cannot be deleted or moved by tools: ${resolvedTarget} (contains ${contained})`,
    );
  }
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
