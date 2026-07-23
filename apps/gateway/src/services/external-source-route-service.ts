import path from "node:path";
import type {
  ExternalSessionAttachmentListResponse,
  ExternalSessionAttachmentResponse,
  ExternalSessionDetachResponse,
  ExternalSourceCatalogListInput,
  ExternalSourceCreateInput,
  ExternalSourceDetailResponse,
  ExternalSourceImportApplyInput,
  ExternalSourceImportApplyResponse,
  ExternalSourceImportDetailResponse,
  ExternalSourceImportPlanInput,
  ExternalSourceImportPlanResponse,
  ExternalSourceListResponse,
  ExternalSourcePage,
  ExternalSourceScanInput,
  ExternalSourceScanRecord,
  ExternalSourceUpdateInput,
  EXTERNAL_SOURCE_SCHEMA_VERSION,
} from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import { resolveWardEffectForExternalAction, type CitadelWardGateStorage } from "./citadel-ward-gate.js";
import { ExternalSourceArtifactStore } from "./external-source-artifact-store.js";
import {
  ExternalSourceAttachmentService,
  type ExternalSessionAttachmentReadResult,
} from "./external-source-attachment-service.js";
import {
  ExternalSourceImportService,
  type ExternalSourceImportRecoverySummary,
} from "./external-source-import-service.js";
import {
  ExternalSourceKnowledgeEffectService,
  type ExternalSourceKnowledgeSnapshotApplyResult,
  type ExternalSourceKnowledgeSnapshotPolicyDecision,
} from "./external-source-knowledge-effect-service.js";
import { ExternalSourcePlanStagingStore } from "./external-source-plan-staging-store.js";
import { ExternalSourceReader } from "./external-source-reader.js";
import { ExternalSourceScanService } from "./external-source-scan-service.js";
import {
  ExternalSourceService,
  StorageExternalSourceIdentityResolver,
  type ExternalSourcePathVerifierPort,
  type ExternalSourceRequestActor,
} from "./external-source-service.js";

/**
 * Content-free receipt for one governed knowledge-snapshot approval request.
 * The route returns identifiers, disposition, and approval lifecycle facts
 * only; the C3 client extracts `approvalId` and hands the operator to the
 * existing approvals surface. No transcript bytes and no client-suppliable
 * hash enter or leave this envelope beyond the server-derived preview hashes.
 */
export interface ExternalSourceKnowledgeSnapshotRequestReceipt {
  schemaVersion: typeof EXTERNAL_SOURCE_SCHEMA_VERSION;
  approvalId: string;
  disposition: "created" | "replayed";
  status: string;
  expiresAt?: string;
  preview: Record<string, unknown>;
}

export interface ExternalSourceRoutePort {
  create(
    input: ExternalSourceCreateInput,
    actor: ExternalSourceRequestActor,
    signal: AbortSignal,
  ): Promise<ExternalSourceDetailResponse>;
  list(workspaceId: string, actor: ExternalSourceRequestActor): ExternalSourceListResponse;
  get(workspaceId: string, sourceId: string, actor: ExternalSourceRequestActor): ExternalSourceDetailResponse;
  update(
    sourceId: string,
    input: ExternalSourceUpdateInput,
    actor: ExternalSourceRequestActor,
  ): Promise<ExternalSourceDetailResponse>;
  scan(
    sourceId: string,
    input: ExternalSourceScanInput,
    actor: ExternalSourceRequestActor,
    signal: AbortSignal,
  ): Promise<ExternalSourceScanRecord>;
  listCatalog(
    sourceId: string,
    input: ExternalSourceCatalogListInput,
    actor: ExternalSourceRequestActor,
  ): ExternalSourcePage;
  createImportPlan(
    input: ExternalSourceImportPlanInput,
    actor: ExternalSourceRequestActor,
    signal: AbortSignal,
  ): Promise<ExternalSourceImportPlanResponse>;
  applyImport(
    input: ExternalSourceImportApplyInput,
    actor: ExternalSourceRequestActor,
    signal: AbortSignal,
  ): Promise<ExternalSourceImportApplyResponse>;
  getImport(
    workspaceId: string,
    importId: string,
    actor: ExternalSourceRequestActor,
  ): ExternalSourceImportDetailResponse;
  recoverImports(signal: AbortSignal, limit?: number): Promise<ExternalSourceImportRecoverySummary>;
  listSessionAttachments(input: unknown, actor: ExternalSourceRequestActor): ExternalSessionAttachmentListResponse;
  attachToSession(
    input: unknown,
    actor: ExternalSourceRequestActor,
    signal: AbortSignal,
  ): Promise<ExternalSessionAttachmentResponse>;
  detachFromSession(
    input: unknown,
    actor: ExternalSourceRequestActor,
    signal: AbortSignal,
  ): Promise<ExternalSessionDetachResponse>;
  createKnowledgeSnapshotRequest(
    input: unknown,
    actor: ExternalSourceRequestActor,
    signal: AbortSignal,
  ): Promise<ExternalSourceKnowledgeSnapshotRequestReceipt>;
}

/** The C1 attachment owner plus the C2 recovered-knowledge owner, composed. */
export interface ExternalSourceChatComposition {
  attachments: ExternalSourceAttachmentService;
  knowledge: ExternalSourceKnowledgeEffectService;
}

export class ExternalSourceRouteService implements ExternalSourceRoutePort {
  public constructor(
    private readonly service: ExternalSourceService,
    private readonly imports?: ExternalSourceImportService,
    private readonly chat?: ExternalSourceChatComposition,
  ) {}

  public create(
    input: ExternalSourceCreateInput,
    actor: ExternalSourceRequestActor,
    signal: AbortSignal,
  ): Promise<ExternalSourceDetailResponse> {
    return this.service.create(input, actor, signal);
  }

  public list(workspaceId: string, actor: ExternalSourceRequestActor): ExternalSourceListResponse {
    return this.service.list(workspaceId, actor);
  }

  public get(workspaceId: string, sourceId: string, actor: ExternalSourceRequestActor): ExternalSourceDetailResponse {
    return this.service.get(workspaceId, sourceId, actor);
  }

  public update(
    sourceId: string,
    input: ExternalSourceUpdateInput,
    actor: ExternalSourceRequestActor,
  ): Promise<ExternalSourceDetailResponse> {
    return this.service.update(sourceId, input, actor);
  }

  public scan(
    sourceId: string,
    input: ExternalSourceScanInput,
    actor: ExternalSourceRequestActor,
    signal: AbortSignal,
  ): Promise<ExternalSourceScanRecord> {
    return this.service.scan(sourceId, input, actor, signal);
  }

  public listCatalog(
    sourceId: string,
    input: ExternalSourceCatalogListInput,
    actor: ExternalSourceRequestActor,
  ): ExternalSourcePage {
    return this.service.listCatalog(sourceId, input, actor);
  }

  public createImportPlan(
    input: ExternalSourceImportPlanInput,
    actor: ExternalSourceRequestActor,
    signal: AbortSignal,
  ): Promise<ExternalSourceImportPlanResponse> {
    return this.requireImports().createPlan(input, actor, signal);
  }

  public applyImport(
    input: ExternalSourceImportApplyInput,
    actor: ExternalSourceRequestActor,
    signal: AbortSignal,
  ): Promise<ExternalSourceImportApplyResponse> {
    return this.requireImports().apply(input, actor, signal);
  }

  public getImport(
    workspaceId: string,
    importId: string,
    actor: ExternalSourceRequestActor,
  ): ExternalSourceImportDetailResponse {
    return this.requireImports().get(workspaceId, importId, actor);
  }

  public recoverImports(signal: AbortSignal, limit?: number): Promise<ExternalSourceImportRecoverySummary> {
    return this.requireImports().recover(signal, limit);
  }

  /** True when the C1/C2 chat-side composition (attachments + knowledge) is live. */
  public supportsChatAttachments(): boolean {
    return this.chat !== undefined;
  }

  public listSessionAttachments(
    input: unknown,
    actor: ExternalSourceRequestActor,
  ): ExternalSessionAttachmentListResponse {
    return this.requireChat().attachments.list(input, actor);
  }

  public attachToSession(
    input: unknown,
    actor: ExternalSourceRequestActor,
    signal: AbortSignal,
  ): Promise<ExternalSessionAttachmentResponse> {
    return this.requireChat().attachments.attach(input, actor, signal);
  }

  public detachFromSession(
    input: unknown,
    actor: ExternalSourceRequestActor,
    signal: AbortSignal,
  ): Promise<ExternalSessionDetachResponse> {
    return this.requireChat().attachments.detach(input, actor, signal);
  }

  public async createKnowledgeSnapshotRequest(
    input: unknown,
    actor: ExternalSourceRequestActor,
    signal: AbortSignal,
  ): Promise<ExternalSourceKnowledgeSnapshotRequestReceipt> {
    const result = await this.requireChat().knowledge.createApprovalRequest(input, actor, signal);
    return {
      schemaVersion: result.schemaVersion,
      approvalId: result.approval.approvalId,
      disposition: result.disposition,
      status: result.approval.status,
      ...(result.approval.expiresAt ? { expiresAt: result.approval.expiresAt } : {}),
      preview: { ...result.material.preview },
    };
  }

  /**
   * HX-307 seam for the routed-context resolver: exact rehash-verified managed
   * bytes plus complete provenance for one live `read_only_external`
   * attachment. Route-level authentication and the attach-time ownership gate
   * authorize the session-scoped read.
   */
  public readAttachedExternalContext(
    input: { workspaceId: string; sessionId: string; attachmentId: string },
    signal: AbortSignal,
  ): Promise<ExternalSessionAttachmentReadResult> {
    return this.requireChat().attachments.readAttachedExternalContext(input, signal);
  }

  /**
   * Approved-recovery executor for the approval-resolution effects worker: the
   * C2 apply revalidates the approval, the entire C1 identity chain, and the
   * managed artifact, then materializes the deterministic knowledge copy in
   * one storage transaction under current deny-wins policy.
   */
  public applyApprovedKnowledgeSnapshot(
    input: { workspaceId: string; approvalId: string },
    actor: ExternalSourceRequestActor,
    signal: AbortSignal,
  ): Promise<ExternalSourceKnowledgeSnapshotApplyResult> {
    return this.requireChat().knowledge.applyApprovedSnapshot(input, actor, signal);
  }

  private requireImports(): ExternalSourceImportService {
    if (!this.imports) throw new Error("External source import service is not composed.");
    return this.imports;
  }

  private requireChat(): ExternalSourceChatComposition {
    if (!this.chat) throw new Error("External source chat attachment composition is not composed.");
    return this.chat;
  }
}

/**
 * Ward action name for the governed external-source knowledge-snapshot apply.
 * Wards like `external_source.*`, `external_source.knowledge_snapshot.*`, or
 * an exact per-source pattern match meaningfully (same convention as
 * `buildIntegrationWardAction`).
 */
export function buildExternalSourceKnowledgeSnapshotWardAction(sourceId: string): string {
  return `external_source.knowledge_snapshot.${sourceId}`;
}

type ExternalSourceRouteStorage = Pick<
  Storage,
  | "externalSourceConfigs"
  | "externalSourceImports"
  | "externalSourceScans"
  | "workspacePathBridgeSnapshots"
  | "workspaces"
> &
  Partial<
    Pick<
      Storage,
      | "approvalEvents"
      | "approvals"
      | "chatSessionMeta"
      | "citadels"
      | "externalSessionAttachments"
      | "externalSourceKnowledgeLinks"
      | "governanceJourneyEvents"
      | "runImmediateTransaction"
    >
  >;

/**
 * Production deny-wins policy for the recovered knowledge-snapshot apply:
 * Citadel Wards evaluated through the same workspace→citadel chain the
 * tool-invoke path uses (`resolveWardEffectForExternalAction`). Deny wins and
 * cannot be overridden by the approval: `deny`, `require_approval`, and
 * `require_dry_run` all fail the apply closed (this boundary has no dry-run
 * concept and its dedicated approval is already spent); `redact`/`route_local`
 * are not meaningful at this boundary and pass through, per the ward gate's
 * documented enforcement contract.
 */
function buildKnowledgeSnapshotWardPolicy(storage: CitadelWardGateStorage): {
  evaluateKnowledgeSnapshotApply(context: {
    workspaceId: string;
    sourceId: string;
  }): ExternalSourceKnowledgeSnapshotPolicyDecision;
} {
  return {
    evaluateKnowledgeSnapshotApply(context) {
      const outcome = resolveWardEffectForExternalAction({
        storage,
        workspaceId: context.workspaceId,
        action: buildExternalSourceKnowledgeSnapshotWardAction(context.sourceId),
      });
      if (outcome.effect === "deny" || outcome.effect === "require_approval" || outcome.effect === "require_dry_run") {
        return { decision: "deny", reasonCode: `ward_${outcome.effect}` };
      }
      return { decision: "allow" };
    },
  };
}

export function createExternalSourceRouteService(
  storage: ExternalSourceRouteStorage,
  pathVerifier: ExternalSourcePathVerifierPort,
  managedRootDir?: string,
): ExternalSourceRouteService {
  const identityResolver = new StorageExternalSourceIdentityResolver({
    configs: storage.externalSourceConfigs,
    pathSnapshots: storage.workspacePathBridgeSnapshots,
    pathVerifier,
  });
  const reader = new ExternalSourceReader({ identityResolver });
  const scanner = new ExternalSourceScanService({
    configs: storage.externalSourceConfigs,
    scans: storage.externalSourceScans,
    reader,
  });
  const sourceService = new ExternalSourceService({
    configs: storage.externalSourceConfigs,
    scans: storage.externalSourceScans,
    pathSnapshots: storage.workspacePathBridgeSnapshots,
    pathVerifier,
    workspaces: storage.workspaces,
    scanner,
  });
  if (!managedRootDir || !storage.externalSourceImports) return new ExternalSourceRouteService(sourceService);
  const artifacts = new ExternalSourceArtifactStore(path.join(managedRootDir, "artifacts"));
  const importService = new ExternalSourceImportService({
    configs: storage.externalSourceConfigs,
    scans: storage.externalSourceScans,
    imports: storage.externalSourceImports,
    workspaces: storage.workspaces,
    reader,
    staging: new ExternalSourcePlanStagingStore(path.join(managedRootDir, "staging")),
    artifacts,
  });
  const chat = buildChatComposition(storage, artifacts);
  return new ExternalSourceRouteService(sourceService, importService, chat);
}

function buildChatComposition(
  storage: ExternalSourceRouteStorage,
  artifacts: ExternalSourceArtifactStore,
): ExternalSourceChatComposition | undefined {
  const {
    approvalEvents,
    approvals,
    chatSessionMeta,
    externalSessionAttachments,
    externalSourceKnowledgeLinks,
    governanceJourneyEvents,
  } = storage;
  const runImmediateTransaction = storage.runImmediateTransaction;
  if (
    !approvalEvents ||
    !approvals ||
    !chatSessionMeta ||
    !externalSessionAttachments ||
    !externalSourceKnowledgeLinks ||
    !governanceJourneyEvents ||
    typeof runImmediateTransaction !== "function"
  ) {
    return undefined;
  }
  const attachments = new ExternalSourceAttachmentService({
    configs: storage.externalSourceConfigs,
    scans: storage.externalSourceScans,
    imports: storage.externalSourceImports,
    attachments: externalSessionAttachments,
    sessions: { get: (sessionId) => chatSessionMeta.get(sessionId) },
    artifacts,
  });
  const knowledge = new ExternalSourceKnowledgeEffectService({
    requests: attachments,
    approvals: {
      get: (approvalId) => approvals.get(approvalId),
      // Composition-owned inbox visibility: the deterministic detached
      // approval appends the standard `created` approval event exactly once
      // (mirroring the mesh capability-activation precedent) inside the C2
      // request transaction; exact replays observe `created: false` and append
      // nothing. C2 itself stays byte-identical.
      createDeterministicDetachedWithTtlDuration: (input, ttlMs) => {
        const stored = approvals.createDeterministicDetachedWithTtlDuration(input, ttlMs);
        if (stored.created) {
          approvalEvents.append({
            approvalId: stored.approval.approvalId,
            eventType: "created",
            actorId: "system",
            timestamp: stored.approval.createdAt,
            payload: {
              kind: stored.approval.kind,
              riskLevel: stored.approval.riskLevel,
              status: stored.approval.status,
            },
          });
        }
        return stored;
      },
    },
    links: externalSourceKnowledgeLinks,
    journeys: governanceJourneyEvents,
    policy: buildKnowledgeSnapshotWardPolicy({
      workspaces: storage.workspaces,
      citadels: storage.citadels,
    }),
    runImmediateTransaction: <T>(callback: () => T): T => runImmediateTransaction.call(storage, callback) as T,
  });
  return { attachments, knowledge };
}
