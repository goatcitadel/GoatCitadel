import path from "node:path";
import { ValidationError, type ToolPolicyConfig } from "@goatcitadel/contracts";
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
 * sessions (with or without an approved scope) never get either widening:
 * without a scope they write only in the workspace and runtime write jail,
 * even when their project folder sits inside an operator write root. A failed
 * delegation lookup refuses the request.
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
  const { delegatedParent, delegatedScope } = await readDelegationScope(request.sessionId, storage);
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
  if (delegatedParent) {
    // D8: a delegated child without an approved scope keeps the workspace and
    // runtime write jail only. Operator write roots are never inherited, even
    // through a project folder that sits inside one.
    const jailRoots = [workspaceRoot, ...(sandbox?.writeJailRoots ?? [])];
    return resolveToolRequestPaths(request, {
      workspaceRoot,
      projectRoot,
      projectWorkspacePath: project?.workspacePath,
      writeRoots: jailRoots,
      outsideRootWrites: "reject",
      confineWritesTo: jailRoots,
    });
  }
  return resolveToolRequestPaths(request, {
    workspaceRoot,
    projectRoot,
    projectWorkspacePath: project?.workspacePath,
    writeRoots: sandbox ? effectiveToolWriteRoots(sandbox, "write") : [],
    outsideRootWrites: sandbox?.outsideRootWriteMode === "approval_required" ? "defer_to_policy" : "reject",
  });
}

type DelegationStepsStorage = SessionToolPathScopeDeps["storage"]["chatDelegationSteps"];

/**
 * Read whether the session is a delegated child and its approved scope. A
 * failed lookup fails closed: the tool request is refused rather than
 * resolved with ordinary-session write roots.
 */
async function readDelegationScope(
  sessionId: string,
  storage: { chatDelegationSteps: DelegationStepsStorage },
): Promise<{
  delegatedParent?: { stepId: string };
  delegatedScope?: Awaited<ReturnType<DelegationStepsStorage["get"]>>["scopeControl"];
}> {
  try {
    const delegatedParent = (await storage.chatDelegationSteps.listParentsByChildSessionIds([sessionId])).get(
      sessionId,
    );
    if (!delegatedParent) {
      return {};
    }
    const step = await storage.chatDelegationSteps.get(delegatedParent.stepId);
    return { delegatedParent, delegatedScope: step.scopeControl };
  } catch {
    throw new ValidationError({
      message: "Could not confirm this session's delegation scope, so the tool paths were not resolved.",
    });
  }
}
