import {
  DEFAULT_CITADEL_ID,
  ValidationError,
  resolveEffectiveRuntimeScope,
  type EffectiveRuntimeScope,
  type EffectiveRuntimeScopeSource,
} from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";

export interface EffectiveRuntimeScopeDependencies {
  storage: Pick<Storage, "chatProjects" | "chatSessionMeta" | "chatSessionProjects" | "workspaces">;
  normalizeWorkspaceId: (workspaceId?: string) => string;
}

export function resolveEffectiveRuntimeScopeFromStorage(
  deps: EffectiveRuntimeScopeDependencies,
  source: EffectiveRuntimeScopeSource,
): EffectiveRuntimeScope {
  const workspaceId = resolveWorkspaceId(deps, source);
  const workspace = deps.storage.workspaces.find(workspaceId);
  const citadelId = source.citadelId?.trim() || workspace?.citadelId || DEFAULT_CITADEL_ID;
  if (workspace?.citadelId && workspace.citadelId !== citadelId) {
    throw new ValidationError({
      field: "workspaceId",
      message: `workspace ${workspaceId} belongs to citadel ${workspace.citadelId}, not ${citadelId}`,
    });
  }
  if (source.projectId?.trim()) {
    const project = deps.storage.chatProjects.get(source.projectId.trim());
    const projectWorkspaceId = deps.normalizeWorkspaceId(project.workspaceId);
    if (projectWorkspaceId !== workspaceId) {
      throw new ValidationError({
        field: "projectId",
        message: `project ${project.projectId} belongs to workspace ${projectWorkspaceId}, not ${workspaceId}`,
      });
    }
  }
  return resolveEffectiveRuntimeScope({ ...source, citadelId, workspaceId }, citadelId);
}

function resolveWorkspaceId(deps: EffectiveRuntimeScopeDependencies, source: EffectiveRuntimeScopeSource): string {
  if (source.workspaceId?.trim()) {
    return deps.normalizeWorkspaceId(source.workspaceId);
  }
  if (source.sessionId?.trim()) {
    return deps.normalizeWorkspaceId(deps.storage.chatSessionMeta.ensure(source.sessionId.trim()).workspaceId);
  }
  if (source.projectId?.trim()) {
    return deps.normalizeWorkspaceId(deps.storage.chatProjects.get(source.projectId.trim()).workspaceId);
  }
  return deps.normalizeWorkspaceId(undefined);
}
