import type {
  GuidanceBundleRecord,
  GuidanceDocType,
  GuidanceDocumentRecord,
  WorkspaceCreateInput,
  WorkspaceRecord,
  WorkspaceUpdateInput,
} from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import { createRouteService, type RoutePort, type RouteService } from "./route-service-factory.js";

export const workspacesRouteMethods = [
  "archiveWorkspace",
  "createWorkspace",
  "getWorkspace",
  "listGlobalGuidance",
  "listWorkspaceGuidance",
  "listWorkspaces",
  "restoreWorkspace",
  "updateGlobalGuidance",
  "updateWorkspace",
  "updateWorkspaceGuidance",
] as const;

export type WorkspacesRouteMethod = (typeof workspacesRouteMethods)[number];
export type WorkspacesRoutePort = RoutePort<WorkspacesRouteMethod>;
export type WorkspacesRouteService = RouteService<WorkspacesRouteMethod>;

export interface WorkspacesRoutePortDependencies {
  storage: Pick<Storage, "workspaces">;
  normalizeWorkspaceId: (workspaceId?: string) => string;
  publishRealtime: (eventType: string, source: string, payload?: Record<string, unknown>) => void;
  listGlobalGuidance: () => Promise<GuidanceDocumentRecord[]>;
  listWorkspaceGuidance: (workspaceId: string) => Promise<GuidanceBundleRecord>;
  updateGlobalGuidance: (docType: GuidanceDocType, content: string) => Promise<GuidanceDocumentRecord>;
  updateWorkspaceGuidance: (
    workspaceId: string,
    docType: GuidanceDocType,
    content: string,
  ) => Promise<GuidanceDocumentRecord>;
}

export function createWorkspacesRoutePort(deps: WorkspacesRoutePortDependencies): WorkspacesRoutePort {
  const getWorkspace = (workspaceId: string): WorkspaceRecord =>
    deps.storage.workspaces.get(deps.normalizeWorkspaceId(workspaceId));

  return {
    archiveWorkspace: (workspaceId) => {
      const archived = deps.storage.workspaces.archive(deps.normalizeWorkspaceId(workspaceId));
      deps.publishRealtime("workspace_archived", "system", {
        workspaceId: archived.workspaceId,
      });
      return archived;
    },
    createWorkspace: (input: WorkspaceCreateInput) => {
      const created = deps.storage.workspaces.create(input);
      deps.publishRealtime("workspace_created", "system", {
        workspaceId: created.workspaceId,
        name: created.name,
        slug: created.slug,
      });
      return created;
    },
    getWorkspace,
    listGlobalGuidance: () => deps.listGlobalGuidance(),
    listWorkspaceGuidance: (workspaceId) => deps.listWorkspaceGuidance(workspaceId),
    listWorkspaces: (view = "active", limit = 200, citadelId?: string) =>
      citadelId?.trim()
        ? deps.storage.workspaces.listByCitadel(citadelId, view, limit)
        : deps.storage.workspaces.list(view, limit),
    restoreWorkspace: (workspaceId) => {
      const restored = deps.storage.workspaces.restore(deps.normalizeWorkspaceId(workspaceId));
      deps.publishRealtime("workspace_restored", "system", {
        workspaceId: restored.workspaceId,
      });
      return restored;
    },
    updateGlobalGuidance: (docType, content) => deps.updateGlobalGuidance(docType, content),
    updateWorkspace: (workspaceId: string, input: WorkspaceUpdateInput) => {
      const updated = deps.storage.workspaces.update(deps.normalizeWorkspaceId(workspaceId), input);
      deps.publishRealtime("workspace_updated", "system", {
        workspaceId: updated.workspaceId,
        name: updated.name,
        slug: updated.slug,
      });
      return updated;
    },
    updateWorkspaceGuidance: (workspaceId, docType, content) =>
      deps.updateWorkspaceGuidance(workspaceId, docType, content),
  };
}

export function createWorkspacesRouteService(port: WorkspacesRoutePort): WorkspacesRouteService {
  return createRouteService(port, workspacesRouteMethods);
}
