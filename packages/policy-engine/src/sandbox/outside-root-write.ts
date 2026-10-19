import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  OUTSIDE_ROOT_WRITE_GRANT_MAX_ROOTS,
  OUTSIDE_ROOT_WRITE_GRANT_MAX_TTL_MS,
  isOutsideRootWriteTool,
  type OutsideRootWriteCandidateRoot,
  type ToolGrantCreateInput,
  type ToolPolicyConfig,
} from "@goatcitadel/contracts";
import { assertWritePathInJail } from "./path-jail.js";
import { effectiveToolWriteRoots } from "./tool-write-gate.js";
import {
  canonicalizeOperatorWriteRoot,
  classifyHardForbiddenWritePath,
  isSamePathOrDescendant,
  type WriteRootRejection,
  type WriteRootSafetyContext,
} from "./write-root-safety.js";

/**
 * Pure path rules for writes outside every write root (runtime jail and
 * operator roots). A target qualifies for an approval only when it resolves to
 * a concrete, non-deceptive local path that is not hard-forbidden. Folder
 * candidates are derived on the server and identified by an opaque rootId, so a
 * client never supplies a path.
 */
type ToolSandbox = ToolPolicyConfig["sandbox"];

export type OutsideRootWriteRefusal =
  | WriteRootRejection
  | "device_namespace"
  | "network_path"
  | "reserved_device_name"
  | "alternate_data_stream"
  | "short_name_segment";

export type OutsideRootWriteTargetResolution =
  | { ok: true; resolved: string }
  | { ok: false; refusal: OutsideRootWriteRefusal };

const MAX_CANDIDATE_DEPTH = 3;
const WINDOWS_RESERVED_DEVICE_NAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "CONIN$",
  "CONOUT$",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
]);

/** Outside-root writes are possible only when opted in and runtime protection exists. */
export function isOutsideRootWriteEnabled(sandbox: ToolSandbox): boolean {
  return sandbox.outsideRootWriteMode === "approval_required" && Boolean(sandbox.runtimeWriteProtection);
}

/** Safety context derived from the gateway's runtime write protection, if present. */
export function outsideRootWriteSafetyContext(sandbox: ToolSandbox): WriteRootSafetyContext | undefined {
  const protection = sandbox.runtimeWriteProtection;
  return protection ? { rootDir: protection.rootDir, protectedRuntimePaths: protection.protectedPaths } : undefined;
}

/** True when the target already lands inside the runtime jail or an operator root. */
export function isInsideToolWriteRoots(target: string, sandbox: ToolSandbox): boolean {
  try {
    assertWritePathInJail(target, effectiveToolWriteRoots(sandbox, "write"));
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve an outside-root write target through its closest existing ancestor
 * with the native realpath, refusing device, network, reserved-name, stream and
 * unexpanded short-name paths, then the hard-forbidden runtime and system paths.
 */
export function resolveOutsideRootWriteTarget(
  rawPath: string,
  ctx: WriteRootSafetyContext,
  platform: NodeJS.Platform = process.platform,
): OutsideRootWriteTargetResolution {
  const trimmed = rawPath.trim();
  if (platform === "win32") {
    const lexicalRefusal = classifyWindowsLexicalTarget(trimmed);
    if (lexicalRefusal) return { ok: false, refusal: lexicalRefusal };
  }
  const absolute = path.resolve(trimmed);
  const { resolved, missingTail } = resolveThroughNativeAncestor(absolute);
  if (platform === "win32" && missingTail.some((segment) => /~\d/u.test(segment))) {
    return { ok: false, refusal: "short_name_segment" };
  }
  const forbidden = classifyHardForbiddenWritePath(resolved, { ...ctx, platform });
  return forbidden ? { ok: false, refusal: forbidden } : { ok: true, resolved };
}

/** Opaque identifier for a server-derived candidate folder. */
export function outsideRootWriteRootId(canonicalPath: string, platform: NodeJS.Platform = process.platform): string {
  const key = platform === "win32" ? canonicalPath.toLowerCase() : canonicalPath;
  return `owr_${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}

/**
 * Folders an approval may open: the closest existing folder above the first
 * target and up to two of its ancestors, each passing the write-root safety
 * rules and containing every target.
 */
export function deriveOutsideRootWriteCandidates(
  resolvedTargets: readonly string[],
  ctx: WriteRootSafetyContext,
  platform: NodeJS.Platform = process.platform,
): OutsideRootWriteCandidateRoot[] {
  const first = resolvedTargets[0];
  if (!first) return [];
  const candidates: OutsideRootWriteCandidateRoot[] = [];
  let directory = nearestExistingDirectory(path.dirname(first));
  for (let depth = 0; directory && depth < MAX_CANDIDATE_DEPTH; depth += 1) {
    const result = canonicalizeOperatorWriteRoot(directory, { ...ctx, platform });
    if (
      result.ok &&
      !isNetworkPath(result.canonicalPath) &&
      resolvedTargets.every((target) => isSamePathOrDescendant(result.canonicalPath, target, platform)) &&
      !candidates.some((candidate) => samePath(candidate.path, result.canonicalPath, platform))
    ) {
      candidates.push({ rootId: outsideRootWriteRootId(result.canonicalPath, platform), path: result.canonicalPath });
    }
    const parent = path.dirname(directory);
    directory = parent === directory ? undefined : parent;
  }
  return candidates;
}

/**
 * Re-canonicalize a grant's folders at use time; returns the canonical folders
 * when every target lies inside one of them, otherwise undefined. A folder that
 * no longer canonicalizes to its stored path (for example a swapped junction)
 * is ignored.
 */
export function grantWriteRootsAdmit(
  roots: readonly string[],
  resolvedTargets: readonly string[],
  ctx: WriteRootSafetyContext,
  platform: NodeJS.Platform = process.platform,
): string[] | undefined {
  if (resolvedTargets.length === 0) return undefined;
  const canonicalRoots = roots.flatMap((root) => {
    const result = canonicalizeOperatorWriteRoot(root, { ...ctx, platform });
    return result.ok && !isNetworkPath(result.canonicalPath) && samePath(result.canonicalPath, root, platform)
      ? [result.canonicalPath]
      : [];
  });
  const admitted = resolvedTargets.every((target) =>
    canonicalRoots.some((root) => isSamePathOrDescendant(root, target, platform)),
  );
  return admitted ? canonicalRoots : undefined;
}

/**
 * Validate a grant that carries `writeRoots` and return it with canonical
 * folders. Throws for anything that could widen writes beyond one approved
 * tool, one scope, a bounded lifetime and a few safe local folders.
 */
export function validateWriteRootsGrantInput(
  input: ToolGrantCreateInput,
  sandbox: ToolSandbox,
  nowMs: number = Date.now(),
  platform: NodeJS.Platform = process.platform,
): ToolGrantCreateInput {
  const roots = input.constraints?.writeRoots;
  if (roots === undefined) return input;
  const ctx = outsideRootWriteSafetyContext(sandbox);
  const fail: (reason: string) => never = (reason) => {
    throw new Error(`Invalid write-root grant: ${reason}.`);
  };
  if (!ctx) fail("runtime write protection is unavailable");
  if (input.decision !== "allow") fail("only allow grants may carry writeRoots");
  if (!isOutsideRootWriteTool(input.toolPattern)) fail("the tool pattern must name one outside-root write tool");
  if (input.scope !== "session" && input.scope !== "workspace") fail("scope must be session or workspace");
  if (!input.scopeRef?.trim()) fail("a scopeRef is required");
  // Only ttl: a one_time grant is consumed before execution re-checks it.
  if (input.grantType !== "ttl") fail("folder grants must be ttl grants");
  assertBoundedExpiry(input.expiresAt, nowMs, fail);
  if (input.constraints?.allowedPaths?.length || input.constraints?.referenceRoots?.length) {
    fail("writeRoots cannot be combined with allowedPaths or referenceRoots");
  }
  if (roots.length === 0 || roots.length > OUTSIDE_ROOT_WRITE_GRANT_MAX_ROOTS) {
    fail(`between 1 and ${OUTSIDE_ROOT_WRITE_GRANT_MAX_ROOTS} folders are required`);
  }
  const canonical: string[] = [];
  for (const root of roots) {
    if (typeof root !== "string" || root.trim() === "*" || !path.isAbsolute(root.trim())) {
      fail("folders must be absolute paths");
    }
    if (isNetworkPath(root.trim())) fail("network folders cannot be opened from a grant");
    const result = canonicalizeOperatorWriteRoot(root, { ...(ctx as WriteRootSafetyContext), platform });
    if (!result.ok) fail(result.detail);
    else if (!canonical.some((existing) => samePath(existing, result.canonicalPath, platform))) {
      canonical.push(result.canonicalPath);
    }
  }
  return { ...input, constraints: { ...input.constraints, writeRoots: canonical } };
}

function assertBoundedExpiry(expiresAt: string | undefined, nowMs: number, fail: (reason: string) => never): void {
  const expiresMs = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  if (!Number.isFinite(expiresMs) || expiresMs <= nowMs) fail("a future expiresAt is required");
  if (expiresMs - nowMs > OUTSIDE_ROOT_WRITE_GRANT_MAX_TTL_MS) fail("grants may last at most 24 hours");
}

function classifyWindowsLexicalTarget(value: string): OutsideRootWriteRefusal | undefined {
  if (/^[\\/]{2}[?.][\\/]/u.test(value)) return "device_namespace";
  if (isNetworkPath(value)) return "network_path";
  const absolute = path.win32.resolve(value);
  const segments = absolute
    .slice(path.win32.parse(absolute).root.length)
    .split(/[\\/]+/u)
    .filter(Boolean);
  for (const segment of segments) {
    if (segment.includes(":")) return "alternate_data_stream";
    const baseName = segment.split(".")[0]?.trimEnd().toUpperCase() ?? "";
    if (WINDOWS_RESERVED_DEVICE_NAMES.has(baseName)) return "reserved_device_name";
  }
  return undefined;
}

function isNetworkPath(value: string): boolean {
  return /^[\\/]{2}[^\\/?.]/u.test(value);
}

function resolveThroughNativeAncestor(absolute: string): { resolved: string; missingTail: string[] } {
  const missingTail: string[] = [];
  let probe = absolute;
  for (;;) {
    if (fs.existsSync(probe)) {
      const real = fs.realpathSync.native(probe);
      return { resolved: missingTail.length ? path.join(real, ...missingTail) : real, missingTail };
    }
    const parent = path.dirname(probe);
    if (parent === probe) return { resolved: absolute, missingTail };
    missingTail.unshift(path.basename(probe));
    probe = parent;
  }
}

function nearestExistingDirectory(start: string): string | undefined {
  let probe = start;
  for (;;) {
    if (fs.statSync(probe, { throwIfNoEntry: false })?.isDirectory()) return fs.realpathSync.native(probe);
    const parent = path.dirname(probe);
    if (parent === probe) return undefined;
    probe = parent;
  }
}

function samePath(left: string, right: string, platform: NodeJS.Platform): boolean {
  return isSamePathOrDescendant(left, right, platform) && isSamePathOrDescendant(right, left, platform);
}
