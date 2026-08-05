import type {
  GuidanceBundleRecord,
  GuidanceDocType,
  GuidanceDocumentRecord,
  WorkspaceCreateInput,
  WorkspaceLifecycleStatus,
  WorkspaceRecord,
  WorkspaceUpdateInput,
} from "@goatcitadel/contracts";
import type { AsyncStorage as Storage } from "@goatcitadel/storage";
import { createRouteService } from "./route-service-factory.js";

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

export interface WorkspacesRoutePort {
  archiveWorkspace(workspaceId: string, expectedRevision: number): Promise<WorkspaceRecord>;
  createWorkspace(input: WorkspaceCreateInput): Promise<WorkspaceRecord>;
  getWorkspace(workspaceId: string): Promise<WorkspaceRecord>;
  listGlobalGuidance(): Promise<GuidanceDocumentRecord[]>;
  listWorkspaceGuidance(workspaceId: string): Promise<GuidanceBundleRecord>;
  listWorkspaces(
    view?: WorkspaceLifecycleStatus | "all",
    limit?: number,
    citadelId?: string,
  ): Promise<WorkspaceRecord[]>;
  restoreWorkspace(workspaceId: string, expectedRevision: number): Promise<WorkspaceRecord>;
  updateGlobalGuidance(docType: GuidanceDocType, content: string): Promise<GuidanceDocumentRecord>;
  updateWorkspace(workspaceId: string, input: WorkspaceUpdateInput, expectedRevision: number): Promise<WorkspaceRecord>;
  updateWorkspaceGuidance(
    workspaceId: string,
    docType: GuidanceDocType,
    content: string,
  ): Promise<GuidanceDocumentRecord>;
}

export type WorkspacesRouteService = Readonly<WorkspacesRoutePort>;

export interface WorkspacesRoutePortDependencies {
  storage: Pick<Storage, "workspaces">;
  normalizeWorkspaceId: (workspaceId?: string) => string;
  publishRealtime: (eventType: string, source: string, payload?: Record<string, unknown>) => Promise<unknown>;
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
  const getWorkspace = async (workspaceId: string): Promise<WorkspaceRecord> =>
    deps.storage.workspaces.get(deps.normalizeWorkspaceId(workspaceId));

  return {
    archiveWorkspace: async (workspaceId, expectedRevision: number) => {
      const archived = await deps.storage.workspaces.archiveWithRevision(
        deps.normalizeWorkspaceId(workspaceId),
        expectedRevision,
      );
      await deps.publishRealtime("workspace_archived", "system", {
        workspaceId: archived.workspaceId,
      });
      return archived;
    },
    createWorkspace: async (input: WorkspaceCreateInput) => {
      const created = await deps.storage.workspaces.create(input);
      await deps.publishRealtime("workspace_created", "system", {
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
    restoreWorkspace: async (workspaceId, expectedRevision: number) => {
      const restored = await deps.storage.workspaces.restoreWithRevision(
        deps.normalizeWorkspaceId(workspaceId),
        expectedRevision,
      );
      await deps.publishRealtime("workspace_restored", "system", {
        workspaceId: restored.workspaceId,
      });
      return restored;
    },
    updateGlobalGuidance: (docType, content) => deps.updateGlobalGuidance(docType, content),
    updateWorkspace: async (workspaceId: string, input: WorkspaceUpdateInput, expectedRevision: number) => {
      const updated = await deps.storage.workspaces.updateWithRevision(
        deps.normalizeWorkspaceId(workspaceId),
        input,
        expectedRevision,
      );
      await deps.publishRealtime("workspace_updated", "system", {
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
  return createRouteService(port, workspacesRouteMethods) as WorkspacesRouteService;
}
