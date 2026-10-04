import type { TestbenchEnv } from "../env";
import type { TargetKind, TargetRequest } from "./resolve-target";

export interface DevVerificationStatus {
  readonly diagnosticsEnabled: boolean;
  readonly rootDir: string;
  readonly activeProviderId?: string;
  readonly activeModel?: string;
}

export interface TargetInfo {
  /** Rules applied to checks: "sandbox" only when every sandbox condition held. */
  readonly kind: TargetKind;
  readonly requested: TargetKind;
  readonly origin: string;
  readonly sandboxVerified: boolean;
  readonly rootDir: string | undefined;
  /** Why the sandbox check failed; undefined when verified or when the real gateway was requested. */
  readonly reason: string | undefined;
}

export interface DetectTargetDeps {
  readonly apiBase: string;
  readonly fetchStatus: () => Promise<DevVerificationStatus>;
}

interface TargetBase {
  readonly requested: TargetKind;
  readonly origin: string;
}

export async function detectTarget(
  request: TargetRequest,
  env: TestbenchEnv,
  deps: DetectTargetDeps,
): Promise<TargetInfo> {
  const base: TargetBase = { requested: request.requested, origin: normalizeOrigin(deps.apiBase) };
  if (request.requested !== "sandbox") {
    return { ...base, kind: "real", sandboxVerified: false, rootDir: undefined, reason: undefined };
  }
  if (!env.sandboxOrigin || !env.sandboxRoot) {
    return demoted(base, "No sandbox was launched. Start one with `pnpm testbench`.");
  }
  const expectedOrigin = normalizeOrigin(env.sandboxOrigin);
  if (expectedOrigin !== base.origin) {
    return demoted(base, `Gateway ${base.origin} is not the launched sandbox ${expectedOrigin}.`);
  }
  let status: DevVerificationStatus;
  try {
    status = await deps.fetchStatus();
  } catch (error) {
    return demoted(base, `Sandbox status is unavailable: ${describeError(error)}`);
  }
  // The status body is external data: a missing root cannot prove the sandbox.
  if (typeof status.rootDir !== "string" || status.rootDir.trim() === "") {
    return demoted(base, "The gateway did not report its runtime root, so it cannot be verified as the sandbox.");
  }
  if (normalizeRootPath(status.rootDir) !== normalizeRootPath(env.sandboxRoot)) {
    return demoted(base, `Gateway root ${status.rootDir} is not the launched sandbox root.`, status.rootDir);
  }
  return { ...base, kind: "sandbox", sandboxVerified: true, rootDir: status.rootDir, reason: undefined };
}

export function normalizeOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    // Fallback for values that are not absolute URLs: compare them trimmed.
    return value.trim().replace(/\/+$/, "");
  }
}

export function normalizeRootPath(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
}

function demoted(base: TargetBase, reason: string, rootDir?: string): TargetInfo {
  return { ...base, kind: "real", sandboxVerified: false, rootDir, reason };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
