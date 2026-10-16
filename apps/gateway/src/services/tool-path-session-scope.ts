import path from "node:path";
import type { ToolPolicyConfig } from "@goatcitadel/contracts";
import { effectiveToolWriteRoots } from "@goatcitadel/policy-engine";
import type { AsyncStorage } from "@goatcitadel/storage";
import {
  resolveProjectRootForToolContext,
  resolveToolRequestPaths,
  type ToolPathRequest,
} from "./tool-path-resolution.js";

export interface SessionToolPathScopeDeps {
  rootDir: string;
  workspaceDir: string;
  /**
   * Read live on every call so settings changes apply without a restart. When
   * absent, no extra write roots are admitted (workspace and project only).
   */
  sandbox?: ToolPolicyConfig["sandbox"];
  storage: Pick<AsyncStorage, "chatSessionProjects" | "chatProjects" | "chatDelegationSteps">;
}

/**
 * Resolve a tool request's paths for the session's scope: its project (or the
 * workspace), or the approved scope of a delegated child session. Ordinary
 * sessions may also write by absolute path into the configured write roots;
 * delegated child sessions stay confined to their approved scope.
 */
export async function resolveToolRequestPathsForSessionScope<TRequest extends ToolPathRequest>(
  request: TRequest,
  deps: SessionToolPathScopeDeps,
): Promise<TRequest> {
  const rootDir = deps.rootDir.trim() ? deps.rootDir : process.cwd();
  const workspaceDir = deps.workspaceDir.trim() ? deps.workspaceDir : "workspace";
  const workspaceRoot = path.resolve(rootDir, workspaceDir);
  const projectId = (await deps.storage.chatSessionProjects.get(request.sessionId))?.projectId;
  const project = projectId ? await deps.storage.chatProjects.find(projectId) : undefined;
  const delegatedParent = (
    await deps.storage.chatDelegationSteps.listParentsByChildSessionIds([request.sessionId])
  ).get(request.sessionId);
  const delegatedScope = delegatedParent
    ? (await deps.storage.chatDelegationSteps.get(delegatedParent.stepId)).scopeControl
    : undefined;
  if (delegatedScope) {
    return resolveToolRequestPaths(request, {
      workspaceRoot,
      projectRoot: path.resolve(
        delegatedScope.rootPath,
        delegatedScope.workingPath ?? delegatedScope.approvedPaths[0] ?? ".",
      ),
    });
  }
  const projectRoot = resolveProjectRootForToolContext({
    workspaceRoot,
    repoRoot: rootDir,
    projectWorkspacePath: project?.workspacePath,
  });
  return resolveToolRequestPaths(request, {
    workspaceRoot,
    projectRoot,
    projectWorkspacePath: project?.workspacePath,
    writeRoots: deps.sandbox ? effectiveToolWriteRoots(deps.sandbox, "write") : [],
  });
}
