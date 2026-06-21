import type { CapabilityProposalRecord } from "./capabilities.js";

export type ExternalConnectorSourceId = "mscr";

export type ExternalConnectorRuntimePosture = "catalog_only";

export type ExternalConnectorReviewStatus = "new" | "reviewed" | "hidden" | "staged";

export interface ExternalConnectorSourceSnapshot {
  sourceId: ExternalConnectorSourceId;
  label: string;
  repositoryUrl: string;
  commit: string;
  generatedAt: string;
  importerVersion: string;
  serviceCount: number;
  actionCount: number;
}

export interface ExternalConnectorAuthSummary {
  id: string;
  type?: string;
  name?: string;
  description?: string;
  managed?: boolean;
}

export interface ExternalConnectorConfigurationFieldSummary {
  variable: string;
  label?: string;
  type?: string;
  required?: boolean;
  helpText?: string;
  groupTitle?: string;
}

export interface ExternalConnectorReviewStateSummary {
  status: ExternalConnectorReviewStatus;
  pinned: boolean;
  note?: string;
  proposalId?: string;
  updatedAt?: string;
}

export interface ExternalConnectorReviewStateRecord {
  workspaceId: string;
  sourceId: ExternalConnectorSourceId;
  serviceId: string;
  actionId?: string;
  status: ExternalConnectorReviewStatus;
  pinned: boolean;
  note?: string;
  proposalId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ExternalConnectorReviewStatePatchInput {
  workspaceId?: string;
  status?: ExternalConnectorReviewStatus;
  pinned?: boolean;
  note?: string | null;
  proposalId?: string | null;
}

export interface ExternalConnectorActionSummary {
  sourceId: ExternalConnectorSourceId;
  serviceId: string;
  actionId: string;
  catalogId: string;
  label: string;
  description: string;
  active: boolean;
  callable: false;
  runtimePosture: ExternalConnectorRuntimePosture;
  configurationFields: ExternalConnectorConfigurationFieldSummary[];
  upstreamPath: string;
  handlerSha256?: string;
  docsPreview?: string;
  reviewState: ExternalConnectorReviewStateSummary;
}

export interface ExternalConnectorServiceSummary {
  sourceId: ExternalConnectorSourceId;
  serviceId: string;
  catalogId: string;
  label: string;
  description: string;
  icon?: string;
  auth: ExternalConnectorAuthSummary[];
  actionCount: number;
  activeActionCount: number;
  callable: false;
  runtimePosture: ExternalConnectorRuntimePosture;
  source: ExternalConnectorSourceSnapshot;
  reviewState: ExternalConnectorReviewStateSummary;
  actions?: ExternalConnectorActionSummary[];
}

export interface ExternalConnectorServiceDetail extends ExternalConnectorServiceSummary {
  actions: ExternalConnectorActionSummary[];
}

export interface ExternalConnectorServiceListQuery {
  workspaceId?: string;
  search?: string;
  status?: ExternalConnectorReviewStatus | "all";
  includeActions?: boolean;
  limit?: number;
}

export interface ExternalConnectorStageActionInput {
  workspaceId?: string;
  note?: string;
}

export interface ExternalConnectorStageActionResult {
  action: ExternalConnectorActionSummary;
  state: ExternalConnectorReviewStateRecord;
  proposal: CapabilityProposalRecord;
  message: string;
}
