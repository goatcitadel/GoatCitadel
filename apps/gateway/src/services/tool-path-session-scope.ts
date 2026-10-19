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
 * sessions may also write by absolute path into the configured write roots,
 * and, when the operator opted into outside-root write approvals, may pass an
 * absolute write target outside every root through to policy. Delegated child
 * sessions (with or without an approved scope) never get either widening.
 */
export async function resolveToolRequestPathsForSessionScope<TRequest extends ToolPathRequest>(
  request: TRequest,
  deps: SessionToolPathScopeDeps,
): Promise<TRequest> {
  const configuredRootDir = deps.rootDir;
  const configuredWorkspaceDir = deps.workspaceDir;
  const sandbox = deps.sandbox;
  const storage = deps.storage;
  const rootDir = configuredRootDir.trim() ? configuredRootDir : process.cwd();
  const workspaceDir = configuredWorkspaceDir.trim() ? configuredWorkspaceDir : "workspace";
  const workspaceRoot = path.resolve(rootDir, workspaceDir);
  const projectId = (await storage.chatSessionProjects.get(request.sessionId))?.projectId;
  const project = projectId ? await storage.chatProjects.find(projectId) : undefined;
  const delegatedParent = (await storage.chatDelegationSteps.listParentsByChildSessionIds([request.sessionId])).get(
    request.sessionId,
  );
  const delegatedScope = delegatedParent
    ? (await storage.chatDelegationSteps.get(delegatedParent.stepId)).scopeControl
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
  const deferOutsideRootWrites = !delegatedParent && sandbox?.outsideRootWriteMode === "approval_required";
  return resolveToolRequestPaths(request, {
    workspaceRoot,
    projectRoot,
    projectWorkspacePath: project?.workspacePath,
    writeRoots: sandbox ? effectiveToolWriteRoots(sandbox, "write") : [],
    outsideRootWrites: deferOutsideRootWrites ? "defer_to_policy" : "reject",
  });
}
