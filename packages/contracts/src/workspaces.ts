export type WorkspaceLifecycleStatus = "active" | "archived";

export interface WorkspacePrefs {
  uiMode?: "simple" | "advanced";
  technicalDetailsDefault?: boolean;
  operatorProfileId?: string;
  hooks?: {
    allowMutatingHooks?: boolean;
    allowInterceptingHooks?: boolean;
  };
  [key: string]: unknown;
}

export interface WorkspaceRecord {
  workspaceId: string;
  revision: number;
  citadelId?: string;
  name: string;
  description?: string;
  slug: string;
  lifecycleStatus: WorkspaceLifecycleStatus;
  archivedAt?: string;
  workspacePrefs?: WorkspacePrefs;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceCreateInput {
  citadelId?: string;
  name: string;
  description?: string;
  slug?: string;
  workspacePrefs?: WorkspacePrefs;
}

export interface WorkspaceUpdateInput {
  citadelId?: string;
  name?: string;
  description?: string;
  slug?: string;
  workspacePrefs?: WorkspacePrefs;
}

/** `product` and `design` (PRODUCT.md / DESIGN.md) are workspace-only: there is no global copy and no runtime-guidance fallback. */
export type GuidanceDocType =
  | "goatcitadel"
  | "agents"
  | "claude"
  | "contributing"
  | "security"
  | "vision"
  | "product"
  | "design";

export interface GuidanceDocumentRecord {
  docType: GuidanceDocType;
  scope: "global" | "workspace";
  workspaceId?: string;
  fileName: string;
  absolutePath: string;
  exists: boolean;
  content: string;
  updatedAt?: string;
}

export interface GuidanceBundleRecord {
  workspaceId: string;
  global: GuidanceDocumentRecord[];
  workspace: GuidanceDocumentRecord[];
}
