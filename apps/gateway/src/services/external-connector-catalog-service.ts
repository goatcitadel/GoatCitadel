import type {
  CapabilityProposalRecord,
  ExternalConnectorActionSummary,
  ExternalConnectorAuthSummary,
  ExternalConnectorConfigurationFieldSummary,
  ExternalConnectorReviewStatePatchInput,
  ExternalConnectorReviewStateRecord,
  ExternalConnectorReviewStateSummary,
  ExternalConnectorRuntimePosture,
  ExternalConnectorServiceDetail,
  ExternalConnectorServiceListQuery,
  ExternalConnectorServiceSummary,
  ExternalConnectorSourceId,
  ExternalConnectorSourceSnapshot,
  ExternalConnectorStageActionInput,
  ExternalConnectorStageActionResult,
  IntegrationCatalogEntry,
} from "@goatcitadel/contracts";
import { MSCR_CONNECTOR_CATALOG } from "../generated/mscr-connector-catalog.js";

const RUNTIME_POSTURE: ExternalConnectorRuntimePosture = "catalog_only";
const DEFAULT_WORKSPACE_ID = "default";
const SOURCE_ID: ExternalConnectorSourceId = "mscr";

interface GeneratedCatalog {
  source: ExternalConnectorSourceSnapshot;
  services: GeneratedService[];
}

interface GeneratedService {
  serviceId: string;
  label: string;
  description: string;
  icon?: string;
  auth: ExternalConnectorAuthSummary[];
  upstreamPath: string;
  actions: GeneratedAction[];
}

interface GeneratedAction {
  serviceId: string;
  actionId: string;
  label: string;
  description: string;
  active: boolean;
  configurationFields: ExternalConnectorConfigurationFieldSummary[];
  upstreamPath: string;
  handlerSha256?: string;
  docsPreview?: string;
}

interface ExternalConnectorReviewStateStore {
  list(query?: {
    workspaceId?: string;
    sourceId?: ExternalConnectorSourceId;
    serviceId?: string;
  }): Promise<ExternalConnectorReviewStateRecord[]>;
  find(input: {
    workspaceId?: string;
    sourceId: ExternalConnectorSourceId;
    serviceId: string;
    actionId?: string;
  }): Promise<ExternalConnectorReviewStateRecord | undefined>;
  upsert(
    lookup: {
      workspaceId?: string;
      sourceId: ExternalConnectorSourceId;
      serviceId: string;
      actionId?: string;
    },
    patch: ExternalConnectorReviewStatePatchInput,
  ): Promise<ExternalConnectorReviewStateRecord>;
}

export interface ExternalConnectorCatalogServiceOptions {
  reviewStates: ExternalConnectorReviewStateStore;
  createCapabilityProposal(input: {
    proposalKind: "skill" | "tool";
    title: string;
    summary: string;
    payload: Record<string, unknown>;
    candidateId?: string;
    activationTargetId?: string;
  }): Promise<CapabilityProposalRecord>;
}

const catalog = MSCR_CONNECTOR_CATALOG as unknown as GeneratedCatalog;

export class ExternalConnectorCatalogService {
  public constructor(private readonly options: ExternalConnectorCatalogServiceOptions) {}

  public listSources(): ExternalConnectorSourceSnapshot[] {
    return [catalog.source];
  }

  public async listServices(query: ExternalConnectorServiceListQuery = {}): Promise<ExternalConnectorServiceSummary[]> {
    const workspaceId = normalizeWorkspaceId(query.workspaceId);
    const states = await this.buildReviewStateMap(workspaceId);
    const search = query.search?.trim().toLowerCase();
    const status = query.status && query.status !== "all" ? query.status : undefined;
    const limit = clampLimit(query.limit, catalog.services.length);
    return catalog.services
      .map((service) => projectService(service, states, Boolean(query.includeActions)))
      .filter((service) => {
        if (status && service.reviewState.status !== status) {
          return false;
        }
        if (!search) {
          return true;
        }
        return [service.label, service.description, service.serviceId].join(" ").toLowerCase().includes(search);
      })
      .slice(0, limit);
  }

  public async getService(
    sourceId: ExternalConnectorSourceId,
    serviceId: string,
    workspaceId?: string,
  ): Promise<ExternalConnectorServiceDetail> {
    this.requireSource(sourceId);
    const service = requireService(serviceId);
    const states = await this.buildReviewStateMap(normalizeWorkspaceId(workspaceId), service.serviceId);
    return projectService(service, states, true);
  }

  public async getAction(
    sourceId: ExternalConnectorSourceId,
    serviceId: string,
    actionId: string,
    workspaceId?: string,
  ): Promise<ExternalConnectorActionSummary> {
    const service = await this.getService(sourceId, serviceId, workspaceId);
    const action = service.actions.find((item) => item.actionId === actionId);
    if (!action) {
      throw new Error(`Unknown external connector action: ${sourceId}/${serviceId}/${actionId}`);
    }
    return action;
  }

  public async updateReviewState(
    lookup: {
      sourceId: ExternalConnectorSourceId;
      serviceId: string;
      actionId?: string;
    },
    patch: ExternalConnectorReviewStatePatchInput,
  ): Promise<ExternalConnectorReviewStateRecord> {
    this.requireSource(lookup.sourceId);
    const service = requireService(lookup.serviceId);
    if (lookup.actionId && !service.actions.some((action) => action.actionId === lookup.actionId)) {
      throw new Error(`Unknown external connector action: ${lookup.sourceId}/${lookup.serviceId}/${lookup.actionId}`);
    }
    return await this.options.reviewStates.upsert(
      {
        workspaceId: normalizeWorkspaceId(patch.workspaceId),
        sourceId: lookup.sourceId,
        serviceId: service.serviceId,
        actionId: lookup.actionId,
      },
      patch,
    );
  }

  public async stageAction(
    lookup: {
      sourceId: ExternalConnectorSourceId;
      serviceId: string;
      actionId: string;
    },
    input: ExternalConnectorStageActionInput = {},
  ): Promise<ExternalConnectorStageActionResult> {
    this.requireSource(lookup.sourceId);
    const service = requireService(lookup.serviceId);
    const action = service.actions.find((item) => item.actionId === lookup.actionId);
    if (!action) {
      throw new Error(`Unknown external connector action: ${lookup.sourceId}/${lookup.serviceId}/${lookup.actionId}`);
    }
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    const proposal = await this.options.createCapabilityProposal({
      proposalKind: "tool",
      title: `Review MSCR connector: ${service.label} / ${action.label}`,
      summary:
        "Catalog-only external connector action staged for governed review. It is not callable until a native capability or trusted plugin is approved.",
      payload: {
        sourceKind: "external_connector_catalog",
        sourceId: SOURCE_ID,
        sourceLabel: catalog.source.label,
        sourceRepositoryUrl: catalog.source.repositoryUrl,
        sourceCommit: catalog.source.commit,
        runtimePosture: RUNTIME_POSTURE,
        callable: false,
        service: {
          serviceId: service.serviceId,
          label: service.label,
          description: service.description,
          auth: service.auth,
          upstreamPath: service.upstreamPath,
        },
        action: {
          actionId: action.actionId,
          label: action.label,
          description: action.description,
          active: action.active,
          configurationFields: action.configurationFields,
          upstreamPath: action.upstreamPath,
          handlerSha256: action.handlerSha256,
          docsPreview: action.docsPreview,
        },
        reviewChecklist: [
          "Audit upstream handler code and SDK dependencies.",
          "Map secrets to GoatCitadel secret storage without exposing values.",
          "Declare read/write side effects and approval requirements.",
          "Add policy, diagnostics, tests, and durable side-effect evidence before activation.",
        ],
      },
    });
    const state = await this.options.reviewStates.upsert(
      {
        workspaceId,
        sourceId: SOURCE_ID,
        serviceId: service.serviceId,
        actionId: action.actionId,
      },
      {
        workspaceId,
        status: "staged",
        pinned: true,
        proposalId: proposal.proposalId,
        note: input.note ?? "Staged from the dormant external connector catalog.",
      },
    );
    return {
      action: await this.getAction(SOURCE_ID, service.serviceId, action.actionId, workspaceId),
      state,
      proposal,
      message: "External connector action staged as a capability proposal. It remains non-callable.",
    };
  }

  public listIntegrationCatalogEntries(): IntegrationCatalogEntry[] {
    return catalog.services.map((service) => {
      const authMethods = service.auth
        .map((entry) => entry.type ?? entry.id)
        .filter((entry): entry is string => Boolean(entry?.trim()));
      const activeActionCount = service.actions.filter((action) => action.active).length;
      return {
        catalogId: externalConnectorCatalogId(service.serviceId),
        kind: "external_connector",
        key: `${SOURCE_ID}.${service.serviceId}`,
        label: `${service.label} (MSCR)`,
        description: `Dormant imported connector from MindStudio Connector Registry. ${service.actions.length} actions are available for review; none are callable by default.`,
        maturity: "disabled",
        runtimeAvailability: "blocked",
        authMethods: authMethods.length ? authMethods : ["review_required"],
        capabilities: ["external_connector.catalog_review", "external_connector.stage_proposal"],
        docsUrl: `${catalog.source.repositoryUrl}/tree/${catalog.source.commit}/${service.upstreamPath}`,
        externalConnector: {
          sourceId: SOURCE_ID,
          serviceId: service.serviceId,
          sourceCommit: catalog.source.commit,
          actionCount: service.actions.length,
          activeActionCount,
          runtimePosture: RUNTIME_POSTURE,
          callable: false,
        },
      };
    });
  }

  private requireSource(sourceId: ExternalConnectorSourceId): void {
    if (sourceId !== SOURCE_ID) {
      throw new Error(`Unknown external connector source: ${sourceId}`);
    }
  }

  private async buildReviewStateMap(
    workspaceId: string,
    serviceId?: string,
  ): Promise<Map<string, ExternalConnectorReviewStateRecord>> {
    const states = await this.options.reviewStates.list({ workspaceId, sourceId: SOURCE_ID, serviceId });
    return new Map(states.map((state) => [reviewStateKey(state.serviceId, state.actionId), state]));
  }
}

function requireService(serviceId: string): GeneratedService {
  const service = catalog.services.find((item) => item.serviceId === serviceId);
  if (!service) {
    throw new Error(`Unknown external connector service: ${SOURCE_ID}/${serviceId}`);
  }
  return service;
}

function projectService(
  service: GeneratedService,
  states: Map<string, ExternalConnectorReviewStateRecord>,
  includeActions: boolean,
): ExternalConnectorServiceDetail {
  const activeActionCount = service.actions.filter((action) => action.active).length;
  return {
    sourceId: SOURCE_ID,
    serviceId: service.serviceId,
    catalogId: externalConnectorCatalogId(service.serviceId),
    label: service.label,
    description: service.description,
    icon: service.icon,
    auth: service.auth,
    actionCount: service.actions.length,
    activeActionCount,
    callable: false,
    runtimePosture: RUNTIME_POSTURE,
    source: catalog.source,
    reviewState: summarizeReviewState(states.get(reviewStateKey(service.serviceId))),
    actions: includeActions ? service.actions.map((action) => projectAction(service.serviceId, action, states)) : [],
  };
}

function projectAction(
  serviceId: string,
  action: GeneratedAction,
  states: Map<string, ExternalConnectorReviewStateRecord>,
): ExternalConnectorActionSummary {
  return {
    sourceId: SOURCE_ID,
    serviceId,
    actionId: action.actionId,
    catalogId: `${externalConnectorCatalogId(serviceId)}.${action.actionId}`,
    label: action.label,
    description: action.description,
    active: action.active,
    callable: false,
    runtimePosture: RUNTIME_POSTURE,
    configurationFields: action.configurationFields,
    upstreamPath: action.upstreamPath,
    handlerSha256: action.handlerSha256,
    docsPreview: action.docsPreview,
    reviewState: summarizeReviewState(states.get(reviewStateKey(serviceId, action.actionId))),
  };
}

function summarizeReviewState(state?: ExternalConnectorReviewStateRecord): ExternalConnectorReviewStateSummary {
  return {
    status: state?.status ?? "new",
    pinned: state?.pinned ?? false,
    note: state?.note,
    proposalId: state?.proposalId,
    updatedAt: state?.updatedAt,
  };
}

function reviewStateKey(serviceId: string, actionId?: string): string {
  return `${serviceId}:${actionId ?? ""}`;
}

function externalConnectorCatalogId(serviceId: string): string {
  return `external_connector.${SOURCE_ID}.${serviceId}`;
}

function normalizeWorkspaceId(value?: string): string {
  return value?.trim() || DEFAULT_WORKSPACE_ID;
}

function clampLimit(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.min(Math.trunc(value), 1_000));
}
