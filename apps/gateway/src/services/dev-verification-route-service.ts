import { createHash, randomUUID } from "node:crypto";
import type {
  ApprovalCreateInput,
  ApprovalRequest,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatSendMessageRequest,
  ChatSessionCreateInput,
  ChatSessionRecord,
  LlmRuntimeConfig,
  ModelUsageAttributionContext,
  RealtimeEvent,
  WorkspaceCreateInput,
  WorkspaceRecord,
} from "@goatcitadel/contracts";
import { TOOL_EFFECT_CLASSIFICATION_VERSION } from "@goatcitadel/contracts";
import type { AsyncStorage as Storage } from "@goatcitadel/storage";
import type { AcquireLocalEmbeddingLease } from "@goatcitadel/policy-engine";
import type { GatewayDevDiagnosticsService } from "../dev-diagnostics/service.js";
import {
  buildChatTurnRuntimeAuthoritySeal,
  withChatTurnRuntimeAuthority,
  withChatTurnRuntimeAuthorityCheckpoint,
} from "./chat-durable-runtime-authority.js";
import { markGeneralChatPostCommitPending } from "./chat-durable-run-service.js";
import { DURABLE_RETRY_POLICY_DEFAULT } from "./durable-retry-policy.js";
import {
  computeEffectiveChatTurnRequestMaterialSha256,
  computeFrozenChatTurnAdmissionMaterialSha256,
  freezeChatTurnExecutionRequest,
  freezeChatTurnRequestActor,
} from "./session-control-service.js";

export interface DevVerificationDurableChatWaitInput {
  workspaceId: string;
  sessionId: string;
  turnId: string;
  userMessageId: string;
  content: string;
  authActorId: string;
  authActorSource: NonNullable<ChatSendMessageRequest["authActorSource"]>;
  traceStatus: "waiting_for_approval" | "waiting_for_user_input";
  waitForEvent: {
    eventKey: "approval.resolved" | "chat.user_input.resolved";
    correlationId: string;
  };
  now: string;
}

export interface DevVerificationChatAttachmentEvidenceInput {
  workspaceId: string;
  sessionId: string;
  now?: string;
}

export const DEV_VERIFICATION_CHAT_ATTACHMENT_EVIDENCE = Object.freeze({
  sourceUrl: "https://fixture.example.invalid/usability-attachment-source",
  sourceTitle: "Deterministic attachment citation",
  sourceSnippet: "Fixture-only source content for the Chat attachment, citation, and tool-event usability journey.",
  toolName: "verification.inspect",
});

const DEV_VERIFICATION_POST_COMMIT_ELIGIBILITY = Object.freeze({
  version: 1 as const,
  autonomyEnabledAtParentSettlement: true,
  evalIntegrityTurn: false,
  humanSession: true,
});

export interface DevVerificationRouteDependencies {
  readonly storage: Storage;
  readonly acquireLocalEmbeddingLease?: AcquireLocalEmbeddingLease;
  createApproval(input: ApprovalCreateInput): Promise<ApprovalRequest>;
  createChatCompletion(
    input: ChatCompletionRequest,
    attribution: ModelUsageAttributionContext,
  ): Promise<ChatCompletionResponse>;
  createChatCompletionStream(
    input: ChatCompletionRequest,
    attribution: ModelUsageAttributionContext,
  ): AsyncGenerator<Record<string, unknown>>;
  createChatSession(input: ChatSessionCreateInput): Promise<ChatSessionRecord>;
  createWorkspace(input: WorkspaceCreateInput): Promise<WorkspaceRecord>;
  getLlmConfig(): LlmRuntimeConfig;
  getProviderSecretStatus(providerId: string): {
    providerId: string;
    hasSecret: boolean;
    source: "none" | "keychain" | "env" | "inline";
  };
  getRealtimeEventSequenceBounds(): Promise<{ oldestSequence?: number; newestSequence?: number }>;
  isDevDiagnosticsEnabled(): boolean;
  listDevDiagnostics(
    input?: Parameters<GatewayDevDiagnosticsService["list"]>[0],
  ): ReturnType<GatewayDevDiagnosticsService["list"]>;
  publishRealtime(
    eventType: string,
    source: string,
    payload: Record<string, unknown>,
    options?: Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links" | "correlationId">,
  ): Promise<RealtimeEvent>;
  reconcileGeneralChatPostCommit(runId: string): Promise<boolean>;
}

export class DevVerificationRouteService {
  public readonly storage: Storage;
  public readonly acquireLocalEmbeddingLease?: AcquireLocalEmbeddingLease;

  public constructor(private readonly deps: DevVerificationRouteDependencies) {
    this.storage = deps.storage;
    this.acquireLocalEmbeddingLease = deps.acquireLocalEmbeddingLease;
  }

  public createApproval(input: ApprovalCreateInput) {
    return this.deps.createApproval(input);
  }

  public createChatCompletion(input: ChatCompletionRequest, attribution: ModelUsageAttributionContext) {
    return this.deps.createChatCompletion(input, attribution);
  }

  public createChatCompletionStream(input: ChatCompletionRequest, attribution: ModelUsageAttributionContext) {
    return this.deps.createChatCompletionStream(input, attribution);
  }

  public createChatSession(input: ChatSessionCreateInput) {
    return this.deps.createChatSession(input);
  }

  public createWorkspace(input: WorkspaceCreateInput) {
    return this.deps.createWorkspace(input);
  }

  /**
   * Adds inspectable citation/tool evidence and a ready URL source to the
   * current completed verification turn. The ready source is backed by local
   * knowledge rows so the visible Attach source action remains deterministic
   * and never dispatches to the public network.
   */
  public async seedChatAttachmentEvidence(input: DevVerificationChatAttachmentEvidenceInput) {
    const workspaceId = input.workspaceId.trim();
    const sessionId = input.sessionId.trim();
    const now = input.now ?? new Date().toISOString();
    const session = await this.storage.chatSessionMeta.get(sessionId);
    if (!session || session.workspaceId !== workspaceId) {
      throw new Error("Verification Chat attachment evidence requires an exact session/workspace match.");
    }
    const branch = await this.storage.chatSessionBranchState.get(sessionId);
    if (!branch) {
      throw new Error(`Verification Chat session ${sessionId} has no active branch.`);
    }
    const trace = await this.storage.chatTurnTraces.get(branch.activeLeafTurnId);
    if (trace.status !== "completed") {
      throw new Error(`Verification Chat turn ${trace.turnId} must be completed before evidence is attached.`);
    }

    const identity = createHash("sha256")
      .update(`${workspaceId}\n${sessionId}\n${trace.turnId}`, "utf8")
      .digest("hex")
      .slice(0, 24);
    const citationId = `dev-verification-citation-${identity}`;
    const citation = {
      citationId,
      title: DEV_VERIFICATION_CHAT_ATTACHMENT_EVIDENCE.sourceTitle,
      url: DEV_VERIFICATION_CHAT_ATTACHMENT_EVIDENCE.sourceUrl,
      snippet: DEV_VERIFICATION_CHAT_ATTACHMENT_EVIDENCE.sourceSnippet,
      sourceType: "web" as const,
    };
    const citations = trace.citations.some((item) => item.citationId === citationId)
      ? trace.citations
      : [...trace.citations, citation];
    if (citations !== trace.citations) {
      await this.storage.chatTurnTraces.patch(trace.turnId, { citations });
    }

    const toolRunId = `dev-verification-tool-${identity}`;
    let toolRun = (await this.storage.chatToolRuns.listByTurn(trace.turnId)).find(
      (item) => item.toolRunId === toolRunId,
    );
    if (!toolRun) {
      toolRun = await this.storage.chatToolRuns.create({
        toolRunId,
        turnId: trace.turnId,
        sessionId,
        toolName: DEV_VERIFICATION_CHAT_ATTACHMENT_EVIDENCE.toolName,
        status: "executed",
        args: { target: "fixture-only attachment evidence" },
        result: { observed: true, sourceUrl: DEV_VERIFICATION_CHAT_ATTACHMENT_EVIDENCE.sourceUrl },
        effectPotential: "none",
        effectDisposition: "none",
        effectOutcomeKind: "none",
        effectEvidence: {
          version: TOOL_EFFECT_CLASSIFICATION_VERSION,
          outcomeKind: "none",
          reason: "trusted_safe_read",
          refs: [],
        },
        startedAt: now,
        finishedAt: now,
      });
    }

    let source = (await this.storage.chatThreadKnowledgeAttachments.listBySession(sessionId)).find(
      (item) =>
        item.sourceType === "url" &&
        item.sourceRef === DEV_VERIFICATION_CHAT_ATTACHMENT_EVIDENCE.sourceUrl &&
        item.retrievalMode === "retrieval",
    );
    if (!source) {
      const namespace = `chat-session:${sessionId}:knowledge`;
      const document = await this.storage.knowledge.createDocument(
        {
          namespace,
          sourceType: "url",
          sourceRef: DEV_VERIFICATION_CHAT_ATTACHMENT_EVIDENCE.sourceUrl,
          title: DEV_VERIFICATION_CHAT_ATTACHMENT_EVIDENCE.sourceTitle,
          metadata: { sessionId, fixture: "chat-attachment-evidence" },
        },
        now,
      );
      const chunks = await this.storage.knowledge.appendChunks(
        document.docId,
        [{ content: DEV_VERIFICATION_CHAT_ATTACHMENT_EVIDENCE.sourceSnippet }],
        now,
      );
      source = await this.storage.chatThreadKnowledgeAttachments.create({
        attachmentId: `dev-verification-url-${identity}`,
        sessionId,
        sourceType: "url",
        sourceRef: DEV_VERIFICATION_CHAT_ATTACHMENT_EVIDENCE.sourceUrl,
        title: DEV_VERIFICATION_CHAT_ATTACHMENT_EVIDENCE.sourceTitle,
        retrievalMode: "retrieval",
        ingestStatus: "ready",
        chunkCount: chunks.length,
        namespace,
        documentId: document.docId,
        lastIngestAt: now,
        createdAt: now,
        updatedAt: now,
      });
    }

    return {
      workspaceId,
      sessionId,
      turnId: trace.turnId,
      citationId,
      toolRunId: toolRun.toolRunId,
      sourceAttachmentId: source.attachmentId,
      sourceUrl: source.sourceRef,
    };
  }

  /**
   * Seeds the same admitted v2 durable identity required by production Chat
   * continuation paths. Verification blockers must never be trace-only: a
   * visible approval or user-input prompt is resumable only when its exact turn
   * admission is bound to a waiting `chat.turn.execute` run.
   */
  public async seedDurableChatWait(input: DevVerificationDurableChatWaitInput) {
    const runId = randomUUID();
    const assistantMessageId = randomUUID();
    const transportRequest: ChatSendMessageRequest = {
      content: input.content,
      providerId: "verification-stub",
      model: "verification-stub-chat",
      mode: "chat",
      webMode: "auto",
      memoryMode: "auto",
      thinkingLevel: "standard",
      policyRunId: runId,
      operatorId: input.authActorId,
      authActorId: input.authActorId,
      authActorSource: input.authActorSource,
    };
    const request = freezeChatTurnExecutionRequest(transportRequest);
    const requestActor = freezeChatTurnRequestActor(transportRequest);
    const lifecycle = await this.storage.chatSessionLifecycles.ensureActive({
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      actorId: requestActor.actorId,
      idempotencyKey: `dev-verification:lifecycle:${input.sessionId}`,
      correlationId: `dev-verification:lifecycle:${input.sessionId}`,
      metadataTimestamp: input.now,
    });
    const sessionMeta = await this.storage.chatSessionMeta.get(input.sessionId);
    if (!sessionMeta) {
      throw new Error(`Verification Chat session ${input.sessionId} has no canonical metadata.`);
    }
    const admissionMaterialSha256 = computeFrozenChatTurnAdmissionMaterialSha256(request);
    const admission = (
      await this.storage.sessionMutationAdmissions.admit({
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        expectedSessionIncarnationId: lifecycle.intent.sessionIncarnationId,
        turnId: input.turnId,
        runtimeOwnerId: `dev-verification:${runId}`,
        admissionKind: "turn_write",
        aggregateRevision: sessionMeta.revision,
        controllerGeneration: lifecycle.generation,
        actorKind: requestActor.actorKind,
        actorId: requestActor.actorId,
        operation: "chat_send",
        materialSha256: admissionMaterialSha256,
        idempotencyKey: `dev-verification:admission:${runId}`,
        correlationId: `dev-verification:${runId}`,
      })
    ).admission;
    const postCommitGenerationId = randomUUID();
    const authority = buildChatTurnRuntimeAuthoritySeal({
      runId,
      turnId: input.turnId,
      transitionKind: "waiting",
      durableStatus: "waiting",
      traceStatus: input.traceStatus,
      transitionAt: input.now,
      postCommitGenerationId,
      postCommitEligibility: DEV_VERIFICATION_POST_COMMIT_ELIGIBILITY,
      waitForEvent: input.waitForEvent,
      requiredFinalizers: ["general"],
    });
    const metadata = withChatTurnRuntimeAuthority(
      markGeneralChatPostCommitPending(
        {
          surface: "chat",
          retryPolicy: { ...DURABLE_RETRY_POLICY_DEFAULT },
          waitForEvent: input.waitForEvent,
        },
        input.now,
        input.traceStatus,
        DEV_VERIFICATION_POST_COMMIT_ELIGIBILITY,
        postCommitGenerationId,
      ),
      authority,
    );
    const run = await this.storage.durableRuns.createRun({
      runId,
      workflowKey: "chat.turn.execute",
      status: "waiting",
      maxAttempts: DURABLE_RETRY_POLICY_DEFAULT.maxAttempts,
      payload: {
        version: "chat.turn.execute.v2",
        admissionId: admission.admissionId,
        sessionIncarnationId: admission.sessionIncarnationId,
        admissionMaterialSha256,
        effectiveRequestMaterialSha256: computeEffectiveChatTurnRequestMaterialSha256(admissionMaterialSha256, request),
        workspaceId: input.workspaceId,
        admissionAggregateRevision: admission.aggregateRevision,
        admissionControllerGeneration: admission.controllerGeneration,
        requestActor,
        sessionId: input.sessionId,
        turnId: input.turnId,
        userMessageId: input.userMessageId,
        assistantMessageId,
        branchKind: "append",
        threadEventType: "chat_thread_turn_appended",
        request,
        userInputResponses: [],
      },
      metadata,
      startedAt: input.now,
      now: input.now,
    });
    await this.storage.sessionMutationAdmissions.bindDurableRun({
      admissionId: admission.admissionId,
      sessionIncarnationId: admission.sessionIncarnationId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      durableRunId: run.runId,
      requestRuntimeClaim: {
        runtimeOwnerId: admission.runtimeOwnerId!,
        leaseRevision: admission.runtimeLeaseRevision!,
      },
    });
    await this.storage.durableRuns.createCheckpoint({
      runId: run.runId,
      checkpointKind: "run_waiting",
      state: withChatTurnRuntimeAuthorityCheckpoint(
        { currentStep: input.traceStatus, waitForEvent: input.waitForEvent },
        authority,
      ),
      createdAt: input.now,
    });
    return { runId: run.runId, assistantMessageId, version: run.version };
  }

  public getLlmConfig() {
    return this.deps.getLlmConfig();
  }

  public getProviderSecretStatus(providerId: string) {
    return this.deps.getProviderSecretStatus(providerId);
  }

  public getRealtimeEventSequenceBounds() {
    return this.deps.getRealtimeEventSequenceBounds();
  }

  public isDevDiagnosticsEnabled() {
    return this.deps.isDevDiagnosticsEnabled();
  }

  public listDevDiagnostics(input?: Parameters<GatewayDevDiagnosticsService["list"]>[0]) {
    return this.deps.listDevDiagnostics(input);
  }

  public async publishRealtime(
    eventType: string,
    source: string,
    payload: Record<string, unknown>,
    options?: Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links" | "correlationId">,
  ) {
    return await this.deps.publishRealtime(eventType, source, payload, options);
  }

  public async settleDurableChatWait(runId: string): Promise<void> {
    if (!(await this.deps.reconcileGeneralChatPostCommit(runId))) {
      throw new Error(`Verification Chat wait ${runId} did not settle its canonical post-commit generation.`);
    }
  }
}
