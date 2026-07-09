import path from "node:path";
import type { ToolGrantConstraints, ToolGrantRecord, ToolGrantScope } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";

export type PromptPackGrantStorage = Pick<Storage, "toolGrants" | "chatSessionMeta">;

export function resolvePromptPackWorkspaceRoot(rootDir: string, workspaceDir: string): string {
  return isPromptPackWindowsAbsolutePath(rootDir)
    ? path.win32.resolve(rootDir, workspaceDir)
    : path.resolve(rootDir, workspaceDir);
}

export function listActivePromptPackToolGrants(
  storage: PromptPackGrantStorage,
  scope: ToolGrantScope,
  scopeRef: string,
): ToolGrantRecord[] {
  const grantRepo = storage.toolGrants as {
    listActive?: (scope?: ToolGrantScope, scopeRef?: string) => ToolGrantRecord[];
    list: (scope?: ToolGrantScope, scopeRef?: string, limit?: number) => ToolGrantRecord[];
  };
  if (grantRepo.listActive) {
    return grantRepo.listActive(scope, scopeRef);
  }
  return grantRepo.list(scope, scopeRef, Number.MAX_SAFE_INTEGER).filter(isPromptPackToolGrantActive);
}

export function listActivePromptPackWorkspaceGrants(
  storage: PromptPackGrantStorage,
  sessionId: string,
  defaultWorkspaceId: string,
): ToolGrantRecord[] {
  const workspaceId = storage.chatSessionMeta?.get(sessionId)?.workspaceId ?? defaultWorkspaceId;
  return listActivePromptPackToolGrants(storage, "workspace", workspaceId);
}

export function promptPackGrantPatternMatches(pattern: string, toolName: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(toolName);
}

export function promptPackReadGrantConstraintsCover(
  existing: ToolGrantConstraints | undefined,
  required: ToolGrantConstraints,
): boolean {
  const requiredPaths = required.allowedPaths ?? [];
  if (requiredPaths.length === 0) {
    return (existing?.allowedPaths ?? []).length === 0;
  }
  const existingPaths = existing?.allowedPaths ?? [];
  if (existingPaths.includes("*")) {
    return true;
  }
  return requiredPaths.every((requiredPath) =>
    existingPaths.some((existingPath) => promptPackPathIsWithinRoot(existingPath, requiredPath)),
  );
}

function isPromptPackWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value.trim());
}

function isPromptPackToolGrantActive(grant: ToolGrantRecord): boolean {
  if (grant.revokedAt) {
    return false;
  }
  if (grant.expiresAt) {
    const expiry = Date.parse(grant.expiresAt);
    if (Number.isFinite(expiry) && expiry <= Date.now()) {
      return false;
    }
  }
  if (grant.grantType === "one_time") {
    return (grant.usesRemaining ?? 0) > 0;
  }
  return true;
}

function promptPackPathIsWithinRoot(root: string, target: string): boolean {
  const pathApi = promptPackPathApiForGrant(root, target);
  const relative = pathApi.relative(pathApi.resolve(root), pathApi.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !pathApi.isAbsolute(relative));
}

function promptPackPathApiForGrant(...values: string[]): typeof path.win32 | typeof path {
  return values.some((value) => /^[A-Za-z]:[\\/]/.test(value.trim())) ? path.win32 : path;
}
