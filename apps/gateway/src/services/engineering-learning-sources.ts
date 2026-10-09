import fsSync from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { CodeModeRunVerificationResponse } from "@goatcitadel/contracts";
import type { AsyncStorage as Storage } from "@goatcitadel/storage";
import type { CapabilitySystemService } from "./capability-system-service.js";

/**
 * The source owners an Engineering learning reads, extracted from the Gateway's constructor wiring. Callers pass the
 * current config on every call, because the Gateway's config can be replaced after construction.
 */
export interface EngineeringLearningSourceRootOwners {
  storage: Pick<Storage, "chatSessionWorkbench" | "chatSessionProjects" | "chatProjects">;
  rootDir: string;
  workspaceDir: string;
}

/** A run in this workspace and the verification evidence its current verification names; throws when there is none. */
export async function readVerifiedCodeModeSource(
  capabilities: Pick<CapabilitySystemService, "getCodeModeRunInScope" | "listCodeModeRunVerificationEvidence">,
  runId: string,
  workspaceId: string,
): Promise<CodeModeRunVerificationResponse> {
  const run = await capabilities.getCodeModeRunInScope(runId, { workspaceId });
  const records = await capabilities.listCodeModeRunVerificationEvidence(runId, { workspaceId });
  const evidence = records.find((record) => record.evidenceId === run.verification?.evidenceId);
  if (!evidence) throw new Error("No current verification evidence exists for this source run.");
  return { run, evidence };
}

/** The repository root an Engineering learning reads: the session's ready worktree, else its project's Git root. */
export async function resolveEngineeringLearningSourceRoot(
  owners: EngineeringLearningSourceRootOwners,
  input: { sessionId?: string; projectId?: string },
): Promise<string | undefined> {
  const { storage, rootDir, workspaceDir } = owners;
  if (input.sessionId) {
    const workbench = await storage.chatSessionWorkbench.get(input.sessionId);
    if (
      workbench?.worktreeStatus === "ready" &&
      workbench.worktreePath &&
      workbench.worktreePath !== "[outside-root]"
    ) {
      const worktreePath = path.resolve(rootDir, workbench.worktreePath.replace(/^\.\//, ""));
      if (fsSync.existsSync(worktreePath)) return fsSync.realpathSync(worktreePath);
    }
  }
  const projectId =
    input.projectId ??
    (input.sessionId ? (await storage.chatSessionProjects.get(input.sessionId))?.projectId : undefined);
  const project = projectId ? await storage.chatProjects.find(projectId) : undefined;
  if (!project) return undefined;
  const workspaceRoot = path.resolve(rootDir, workspaceDir);
  const projectPath = fsSync.realpathSync(path.resolve(workspaceRoot, project.workspacePath));
  try {
    return fsSync.realpathSync(
      execFileSync("git", ["rev-parse", "--show-toplevel"], {
        cwd: projectPath,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim(),
    );
  } catch {
    return projectPath;
  }
}
