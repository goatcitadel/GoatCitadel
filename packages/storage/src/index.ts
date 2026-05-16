import type { ChatAttachmentRecord } from "@goatcitadel/contracts";
import { ValidationError } from "@goatcitadel/contracts";
import { createDatabase, type SqliteOptions } from "./sqlite.js";
import type { DatabaseClient } from "./db.js";
import { SessionRepository } from "./session-repo.js";
import { IdempotencyRepository } from "./idempotency-repo.js";
import { MutationIdempotencyRepository } from "./mutation-idempotency-repo.js";
import { TranscriptLog } from "./transcript-log.js";
import { AuditLog } from "./audit-log.js";
import { PostgresTranscriptLog } from "./postgres-transcript-log.js";
import { PostgresAuditLog } from "./postgres-audit-log.js";
import { ApprovalRepository } from "./approval-repo.js";
import { CostLedgerRepository } from "./cost-ledger-repo.js";
import { ApprovalEventRepository } from "./approval-event-repo.js";
import { PendingApprovalActionRepository } from "./pending-approval-action-repo.js";
import { RemoteActionTokenRepository } from "./remote-action-token-repo.js";
import { ApprovalInboxRepository } from "./approval-inbox-repo.js";
import { ApprovalEffectRepository } from "./approval-effect-repo.js";
import { ApprovalWaitRunRepository } from "./approval-wait-run-repo.js";
import { OrchestrationRepository } from "./orchestration-repo.js";
import { TaskRepository } from "./task-repo.js";
import { TaskActivityRepository } from "./task-activity-repo.js";
import { TaskDeliverableRepository } from "./task-deliverable-repo.js";
import { TaskSubagentRepository } from "./task-subagent-repo.js";
import { RealtimeEventRepository } from "./realtime-event-repo.js";
import { CronJobRepository } from "./cron-job-repo.js";
import { IntegrationConnectionRepository } from "./integration-connection-repo.js";
import { ChannelSetupDraftRepository } from "./channel-setup-draft-repo.js";
import { MeshRepository } from "./mesh-repo.js";
import { MemoryContextRepository } from "./memory-context-repo.js";
import { ContextManifestRepository } from "./context-manifest-repo.js";
import { MemoryQmdRunRepository } from "./memory-qmd-run-repo.js";
import { AgentProfileRepository } from "./agent-profile-repo.js";
import { ImportedAgentCatalogRepository } from "./imported-agent-catalog-repo.js";
import { ToolGrantRepository } from "./tool-grant-repo.js";
import { ToolAccessDecisionRepository } from "./tool-access-decision-repo.js";
import { KnowledgeRepository } from "./knowledge-repo.js";
import { CommsDeliveryRepository } from "./comms-delivery-repo.js";
import { ChatProjectRepository } from "./chat-project-repo.js";
import { ChatSessionMetaRepository } from "./chat-session-meta-repo.js";
import { ChatSessionProjectRepository } from "./chat-session-project-repo.js";
import { ChatSessionWorkbenchRepository } from "./chat-session-workbench-repo.js";
import { ChatSessionBranchStateRepository } from "./chat-session-branch-state-repo.js";
import { ChatSessionBindingRepository } from "./chat-session-binding-repo.js";
import { ChatAttachmentRepository } from "./chat-attachment-repo.js";
import { ChatSessionPrefsRepository } from "./chat-session-prefs-repo.js";
import { SessionAutonomyPrefsRepository } from "./session-autonomy-prefs-repo.js";
import { ChatTurnTraceRepository } from "./chat-turn-trace-repo.js";
import { ChatStreamEventRepository } from "./chat-stream-event-repo.js";
import { ChatExecutionPlanRepository } from "./chat-execution-plan-repo.js";
import { ChatConversationSummaryRepository } from "./chat-conversation-summary-repo.js";
import { ChatSpecialistCandidateRepository } from "./chat-specialist-candidate-repo.js";
import { ChatToolRunRepository } from "./chat-tool-run-repo.js";
import { ChatToolArtifactRepository } from "./chat-tool-artifact-repo.js";
import { ChatGeneratedArtifactRepository } from "./chat-generated-artifact-repo.js";
import { ChatInlineApprovalRepository } from "./chat-inline-approval-repo.js";
import { ChatDelegationRunRepository } from "./chat-delegation-run-repo.js";
import { ChatDelegationStepRepository } from "./chat-delegation-step-repo.js";
import { ChatMessageRepository } from "./chat-message-repo.js";
import { ChatThreadKnowledgeAttachmentRepository } from "./chat-thread-knowledge-attachment-repo.js";
import { SystemSettingsRepository } from "./system-settings-repo.js";
import { ResearchRunRepository } from "./research-run-repo.js";
import { ResearchSourceRepository } from "./research-source-repo.js";
import { PromptPackRepository } from "./prompt-pack-repo.js";
import { PromptPackRunRepository } from "./prompt-pack-run-repo.js";
import { PromptPackAutoScoreV2Repository } from "./prompt-pack-auto-score-v2-repo.js";
import { PromptPackHumanReviewV2Repository } from "./prompt-pack-human-review-v2-repo.js";
import { PromptPackScoreRepository } from "./prompt-pack-score-repo.js";
import { WorkspaceRepository } from "./workspace-repo.js";
import { DurableRunRepository } from "./durable-run-repo.js";
import { GatewaySqlRepository } from "./gateway-sql-repo.js";
import { AssemblyRepository } from "./assembly-repo.js";
import { WorkspaceHookRepository } from "./workspace-hook-repo.js";
import { HookRunRepository } from "./hook-run-repo.js";
import { LearnedMemoryRepository } from "./learned-memory-repo.js";
import { MemoryMaintenanceRepository } from "./memory-maintenance-repo.js";
import { TranscriptOutboxRepository } from "./transcript-outbox-repo.js";
import { RealtimeStreamLeaseRepository } from "./realtime-stream-lease-repo.js";
import { CapabilityCatalogSnapshotRepository } from "./capability-catalog-snapshot-repo.js";
import { SkillLifecycleRepository } from "./skill-lifecycle-repo.js";
import { CandidateSkillVersionRepository } from "./candidate-skill-version-repo.js";
import { CapabilityProposalEventRepository, CapabilityProposalRepository } from "./capability-proposal-repo.js";
import { SkillEvaluationRunRepository } from "./skill-evaluation-run-repo.js";
import { StateValidationQuarantineRepository } from "./state-validation-quarantine-repo.js";
import { CodeModeRunRepository } from "./code-mode-run-repo.js";
import { DurableRunEventRepository } from "./durable-run-event-repo.js";
import { ChatReflectionAttemptRepository } from "./chat-reflection-attempt-repo.js";
import { EvidenceEnvelopeRepository } from "./evidence-envelope-repo.js";

export interface StorageOptions extends Partial<SqliteOptions> {
  transcriptsDir: string;
  auditDir: string;
  db?: DatabaseClient;
  transcripts?: TranscriptLog | PostgresTranscriptLog;
  audit?: AuditLog | PostgresAuditLog;
}

export interface DeleteChatSessionDataResult {
  sessionId: string;
  deleted: boolean;
  cleanupRelPaths: string[];
  attachments: ChatAttachmentRecord[];
}

export class Storage {
  public readonly db: DatabaseClient;
  public readonly sessions: SessionRepository;
  public readonly idempotency: IdempotencyRepository;
  public readonly mutationIdempotency: MutationIdempotencyRepository;
  public readonly transcripts: TranscriptLog | PostgresTranscriptLog;
  public readonly audit: AuditLog | PostgresAuditLog;
  public readonly approvals: ApprovalRepository;
  public readonly approvalEvents: ApprovalEventRepository;
  public readonly pendingApprovalActions: PendingApprovalActionRepository;
  public readonly remoteActionTokens: RemoteActionTokenRepository;
  public readonly approvalInbox: ApprovalInboxRepository;
  public readonly approvalEffects: ApprovalEffectRepository;
  public readonly approvalWaitRuns: ApprovalWaitRunRepository;
  public readonly costLedger: CostLedgerRepository;
  public readonly orchestration: OrchestrationRepository;
  public readonly tasks: TaskRepository;
  public readonly taskActivities: TaskActivityRepository;
  public readonly taskDeliverables: TaskDeliverableRepository;
  public readonly taskSubagents: TaskSubagentRepository;
  public readonly realtimeEvents: RealtimeEventRepository;
  public readonly cronJobs: CronJobRepository;
  public readonly integrationConnections: IntegrationConnectionRepository;
  public readonly channelSetupDrafts: ChannelSetupDraftRepository;
  public readonly agentProfiles: AgentProfileRepository;
  public readonly importedAgentCatalog: ImportedAgentCatalogRepository;
  public readonly mesh: MeshRepository;
  public readonly memoryContexts: MemoryContextRepository;
  public readonly contextManifests: ContextManifestRepository;
  public readonly memoryQmdRuns: MemoryQmdRunRepository;
  public readonly toolGrants: ToolGrantRepository;
  public readonly toolAccessDecisions: ToolAccessDecisionRepository;
  public readonly knowledge: KnowledgeRepository;
  public readonly commsDeliveries: CommsDeliveryRepository;
  public readonly chatProjects: ChatProjectRepository;
  public readonly chatSessionMeta: ChatSessionMetaRepository;
  public readonly chatSessionProjects: ChatSessionProjectRepository;
  public readonly chatSessionWorkbench: ChatSessionWorkbenchRepository;
  public readonly chatSessionBranchState: ChatSessionBranchStateRepository;
  public readonly chatSessionBindings: ChatSessionBindingRepository;
  public readonly chatAttachments: ChatAttachmentRepository;
  public readonly chatSessionPrefs: ChatSessionPrefsRepository;
  public readonly sessionAutonomyPrefs: SessionAutonomyPrefsRepository;
  public readonly chatMessages: ChatMessageRepository;
  public readonly chatTurnTraces: ChatTurnTraceRepository;
  public readonly chatStreamEvents: ChatStreamEventRepository;
  public readonly chatExecutionPlans: ChatExecutionPlanRepository;
  public readonly chatConversationSummaries: ChatConversationSummaryRepository;
  public readonly chatSpecialistCandidates: ChatSpecialistCandidateRepository;
  public readonly chatToolRuns: ChatToolRunRepository;
  public readonly chatToolArtifacts: ChatToolArtifactRepository;
  public readonly chatGeneratedArtifacts: ChatGeneratedArtifactRepository;
  public readonly chatInlineApprovals: ChatInlineApprovalRepository;
  public readonly chatDelegationRuns: ChatDelegationRunRepository;
  public readonly chatDelegationSteps: ChatDelegationStepRepository;
  public readonly chatThreadKnowledgeAttachments: ChatThreadKnowledgeAttachmentRepository;
  public readonly systemSettings: SystemSettingsRepository;
  public readonly researchRuns: ResearchRunRepository;
  public readonly researchSources: ResearchSourceRepository;
  public readonly promptPacks: PromptPackRepository;
  public readonly promptPackRuns: PromptPackRunRepository;
  public readonly promptPackAutoScoresV2: PromptPackAutoScoreV2Repository;
  public readonly promptPackHumanReviewsV2: PromptPackHumanReviewV2Repository;
  public readonly promptPackScores: PromptPackScoreRepository;
  public readonly workspaces: WorkspaceRepository;
  public readonly workspaceHooks: WorkspaceHookRepository;
  public readonly hookRuns: HookRunRepository;
  public readonly learnedMemory: LearnedMemoryRepository;
  public readonly memoryMaintenance: MemoryMaintenanceRepository;
  public readonly durableRuns: DurableRunRepository;
  public readonly gatewaySql: GatewaySqlRepository;
  public readonly assembly: AssemblyRepository;
  public readonly transcriptOutbox: TranscriptOutboxRepository;
  public readonly realtimeStreamLeases: RealtimeStreamLeaseRepository;
  public readonly capabilityCatalogSnapshots: CapabilityCatalogSnapshotRepository;
  public readonly skillLifecycle: SkillLifecycleRepository;
  public readonly candidateSkillVersions: CandidateSkillVersionRepository;
  public readonly capabilityProposals: CapabilityProposalRepository;
  public readonly capabilityProposalEvents: CapabilityProposalEventRepository;
  public readonly skillEvaluationRuns: SkillEvaluationRunRepository;
  public readonly codeModeRuns: CodeModeRunRepository;
  public readonly durableRunEvents: DurableRunEventRepository;
  public readonly chatReflectionAttempts: ChatReflectionAttemptRepository;
  public readonly evidenceEnvelopes: EvidenceEnvelopeRepository;
  public readonly stateValidationQuarantine: StateValidationQuarantineRepository;

  public constructor(options: StorageOptions) {
    this.db =
      options.db ??
      createDatabase({
        dbPath: options.dbPath ?? ":memory:",
        tuning: options.tuning,
      });
    this.stateValidationQuarantine = new StateValidationQuarantineRepository(this.db);
    this.sessions = new SessionRepository(this.db, { quarantine: this.stateValidationQuarantine });
    this.idempotency = new IdempotencyRepository(this.db);
    this.mutationIdempotency = new MutationIdempotencyRepository(this.db);
    this.transcripts =
      options.transcripts ??
      (this.db.dialect === "postgres" ? new PostgresTranscriptLog(this.db) : new TranscriptLog(options.transcriptsDir));
    this.audit =
      options.audit ??
      (this.db.dialect === "postgres" ? new PostgresAuditLog(this.db) : new AuditLog(options.auditDir));
    this.approvals = new ApprovalRepository(this.db);
    this.approvalEvents = new ApprovalEventRepository(this.db);
    this.pendingApprovalActions = new PendingApprovalActionRepository(this.db);
    this.remoteActionTokens = new RemoteActionTokenRepository(this.db);
    this.approvalInbox = new ApprovalInboxRepository(this.db);
    this.approvalEffects = new ApprovalEffectRepository(this.db);
    this.approvalWaitRuns = new ApprovalWaitRunRepository(this.db);
    this.costLedger = new CostLedgerRepository(this.db);
    this.orchestration = new OrchestrationRepository(this.db);
    this.tasks = new TaskRepository(this.db, { quarantine: this.stateValidationQuarantine });
    this.taskActivities = new TaskActivityRepository(this.db);
    this.taskDeliverables = new TaskDeliverableRepository(this.db);
    this.taskSubagents = new TaskSubagentRepository(this.db);
    this.realtimeEvents = new RealtimeEventRepository(this.db);
    this.cronJobs = new CronJobRepository(this.db);
    this.integrationConnections = new IntegrationConnectionRepository(this.db);
    this.channelSetupDrafts = new ChannelSetupDraftRepository(this.db);
    this.agentProfiles = new AgentProfileRepository(this.db);
    this.importedAgentCatalog = new ImportedAgentCatalogRepository(this.db);
    this.mesh = new MeshRepository(this.db);
    this.memoryContexts = new MemoryContextRepository(this.db);
    this.contextManifests = new ContextManifestRepository(this.db);
    this.memoryQmdRuns = new MemoryQmdRunRepository(this.db);
    this.toolGrants = new ToolGrantRepository(this.db);
    this.toolAccessDecisions = new ToolAccessDecisionRepository(this.db);
    this.knowledge = new KnowledgeRepository(this.db);
    this.commsDeliveries = new CommsDeliveryRepository(this.db);
    this.chatProjects = new ChatProjectRepository(this.db);
    this.chatSessionMeta = new ChatSessionMetaRepository(this.db);
    this.chatSessionProjects = new ChatSessionProjectRepository(this.db);
    this.chatSessionWorkbench = new ChatSessionWorkbenchRepository(this.db);
    this.chatSessionBranchState = new ChatSessionBranchStateRepository(this.db);
    this.chatSessionBindings = new ChatSessionBindingRepository(this.db);
    this.chatAttachments = new ChatAttachmentRepository(this.db);
    this.chatSessionPrefs = new ChatSessionPrefsRepository(this.db);
    this.sessionAutonomyPrefs = new SessionAutonomyPrefsRepository(this.db);
    this.chatMessages = new ChatMessageRepository(this.db);
    this.chatTurnTraces = new ChatTurnTraceRepository(this.db);
    this.chatStreamEvents = new ChatStreamEventRepository(this.db);
    this.chatExecutionPlans = new ChatExecutionPlanRepository(this.db);
    this.chatConversationSummaries = new ChatConversationSummaryRepository(this.db);
    this.chatSpecialistCandidates = new ChatSpecialistCandidateRepository(this.db);
    this.chatToolRuns = new ChatToolRunRepository(this.db);
    this.chatToolArtifacts = new ChatToolArtifactRepository(this.db);
    this.chatGeneratedArtifacts = new ChatGeneratedArtifactRepository(this.db);
    this.chatInlineApprovals = new ChatInlineApprovalRepository(this.db);
    this.chatDelegationRuns = new ChatDelegationRunRepository(this.db);
    this.chatDelegationSteps = new ChatDelegationStepRepository(this.db);
    this.chatThreadKnowledgeAttachments = new ChatThreadKnowledgeAttachmentRepository(this.db);
    this.systemSettings = new SystemSettingsRepository(this.db);
    this.researchRuns = new ResearchRunRepository(this.db);
    this.researchSources = new ResearchSourceRepository(this.db);
    this.promptPacks = new PromptPackRepository(this.db);
    this.promptPackRuns = new PromptPackRunRepository(this.db);
    this.promptPackAutoScoresV2 = new PromptPackAutoScoreV2Repository(this.db);
    this.promptPackHumanReviewsV2 = new PromptPackHumanReviewV2Repository(this.db);
    this.promptPackScores = new PromptPackScoreRepository(this.db);
    this.workspaces = new WorkspaceRepository(this.db);
    this.workspaceHooks = new WorkspaceHookRepository(this.db);
    this.hookRuns = new HookRunRepository(this.db);
    this.learnedMemory = new LearnedMemoryRepository(this.db);
    this.memoryMaintenance = new MemoryMaintenanceRepository(this.db);
    this.durableRuns = new DurableRunRepository(this.db, { quarantine: this.stateValidationQuarantine });
    this.gatewaySql = new GatewaySqlRepository(this.db);
    this.assembly = new AssemblyRepository(this.db);
    this.transcriptOutbox = new TranscriptOutboxRepository(this.db);
    this.realtimeStreamLeases = new RealtimeStreamLeaseRepository(this.db);
    this.capabilityCatalogSnapshots = new CapabilityCatalogSnapshotRepository(this.db);
    this.skillLifecycle = new SkillLifecycleRepository(this.db);
    this.candidateSkillVersions = new CandidateSkillVersionRepository(this.db);
    this.capabilityProposals = new CapabilityProposalRepository(this.db);
    this.capabilityProposalEvents = new CapabilityProposalEventRepository(this.db);
    this.skillEvaluationRuns = new SkillEvaluationRunRepository(this.db);
    this.codeModeRuns = new CodeModeRunRepository(this.db);
    this.durableRunEvents = new DurableRunEventRepository(this.db);
    this.chatReflectionAttempts = new ChatReflectionAttemptRepository(this.db);
    this.evidenceEnvelopes = new EvidenceEnvelopeRepository(this.db);
  }

  public close(): void {
    this.db.close();
  }

  public runImmediateTransaction<T>(callback: () => T): T {
    return this.db.transaction("immediate", callback);
  }

  public deleteChatSessionData(sessionId: string): DeleteChatSessionDataResult {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) {
      throw new ValidationError({ code: "FIELD_REQUIRED", field: "sessionId" });
    }

    const attachments = this.chatAttachments.listBySession(normalizedSessionId, 10_000);
    const cleanupRelPaths = dedupeStrings([
      ...attachments.map((record) => record.storageRelPath),
      ...attachments.map((record) => record.thumbnailRelPath),
      ...this.listMediaArtifactPathsForSession(normalizedSessionId, attachments),
      ...this.chatToolArtifacts.listBySession(normalizedSessionId, 10_000).map((record) => record.storageRelPath),
    ]);

    const deleted = this.db.transaction("immediate", () => {
      const attachmentIds = attachments.map((record) => record.attachmentId);
      const attachmentClause =
        attachmentIds.length > 0 ? ` OR attachment_id IN (${attachmentIds.map(() => "?").join(", ")})` : "";

      // Subquery-dependent deletes (must run before their parent tables)
      this.db
        .prepare(
          `
        DELETE FROM media_artifacts
        WHERE job_id IN (
          SELECT job_id
          FROM media_jobs
          WHERE session_id = ?
             ${attachmentClause}
        )
      `,
        )
        .run(normalizedSessionId, ...attachmentIds);
      this.db
        .prepare(
          `
        DELETE FROM media_jobs
        WHERE session_id = ?
           ${attachmentClause}
      `,
        )
        .run(normalizedSessionId, ...attachmentIds);
      this.db
        .prepare(
          `
        DELETE FROM research_sources
        WHERE run_id IN (SELECT run_id FROM research_runs WHERE session_id = ?)
      `,
        )
        .run(normalizedSessionId);
      this.db
        .prepare(
          `
        UPDATE chat_delegation_steps
        SET child_session_id = NULL,
            child_turn_id = NULL
        WHERE child_session_id = ?
      `,
        )
        .run(normalizedSessionId);
      this.db
        .prepare(
          `
        DELETE FROM chat_delegation_steps
        WHERE run_id IN (SELECT run_id FROM chat_delegation_runs WHERE session_id = ?)
      `,
        )
        .run(normalizedSessionId);
      this.db
        .prepare(
          `
        DELETE FROM learned_memory_sources
        WHERE item_id IN (SELECT item_id FROM learned_memory_items WHERE session_id = ?)
      `,
        )
        .run(normalizedSessionId);
      this.db
        .prepare(
          `
        DELETE FROM prompt_pack_human_reviews_v2
        WHERE run_id IN (SELECT run_id FROM prompt_pack_runs WHERE session_id = ?)
      `,
        )
        .run(normalizedSessionId);
      this.db
        .prepare(
          `
        DELETE FROM prompt_pack_auto_scores_v2
        WHERE run_id IN (SELECT run_id FROM prompt_pack_runs WHERE session_id = ?)
      `,
        )
        .run(normalizedSessionId);
      this.db
        .prepare(
          `
        DELETE FROM prompt_pack_scores
        WHERE run_id IN (SELECT run_id FROM prompt_pack_runs WHERE session_id = ?)
      `,
        )
        .run(normalizedSessionId);
      this.db
        .prepare(
          `
        DELETE FROM chat_execution_plan_steps
        WHERE plan_id IN (SELECT plan_id FROM chat_execution_plans WHERE session_id = ?)
      `,
        )
        .run(normalizedSessionId);

      // All simple WHERE session_id = ? deletes in a single statement batch
      const sid = normalizedSessionId;
      this.db.prepare("DELETE FROM research_runs WHERE session_id = ?").run(sid);
      this.db.prepare("DELETE FROM chat_delegation_runs WHERE session_id = ?").run(sid);
      const simpleSessionDeletes = [
        "proactive_actions",
        "proactive_runs",
        "learned_memory_conflicts",
        "learned_memory_items",
        "chat_reflection_attempts",
        "prompt_pack_runs",
        "memory_context_packs",
        "context_manifests",
        "memory_qmd_runs",
        "chat_execution_plans",
        "chat_conversation_summaries",
        "tool_access_decisions",
        "tool_invocations",
        "policy_blocks",
        "cost_ledger",
        "bankr_action_audit",
        "voice_sessions",
        "mesh_session_owners",
        "transcript_outbox",
        "chat_inline_approvals",
        "chat_stream_events",
        "chat_thread_knowledge_attachments",
        "chat_generated_artifacts",
        "chat_tool_artifacts",
        "chat_tool_runs",
        "chat_specialist_candidates",
        "chat_turn_traces",
        "chat_messages",
        "session_autonomy_prefs",
        "chat_session_prefs",
        "chat_session_branch_state",
        "chat_session_bindings",
        "chat_session_projects",
        "chat_session_workbench",
        "chat_attachments",
        "chat_session_meta",
      ];
      for (const table of simpleSessionDeletes) {
        this.db.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(sid);
      }
      this.knowledge.deleteNamespace(`chat-session:${sid}:knowledge`);

      this.db
        .prepare(
          `
        DELETE FROM tool_grants
        WHERE scope = 'session'
          AND scope_ref = ?
      `,
        )
        .run(sid);
      return Number(this.db.prepare("DELETE FROM sessions WHERE session_id = ?").run(sid).changes ?? 0) > 0;
    });
    return {
      sessionId: normalizedSessionId,
      deleted,
      cleanupRelPaths,
      attachments,
    };
  }

  private listMediaArtifactPathsForSession(sessionId: string, attachments: ChatAttachmentRecord[]): string[] {
    const attachmentIds = attachments.map((record) => record.attachmentId);
    const attachmentClause =
      attachmentIds.length > 0 ? ` OR attachment_id IN (${attachmentIds.map(() => "?").join(", ")})` : "";
    const rows = this.db
      .prepare(
        `
      SELECT storage_rel_path
      FROM media_artifacts
      WHERE storage_rel_path IS NOT NULL
        AND job_id IN (
          SELECT job_id
          FROM media_jobs
          WHERE session_id = ?
             ${attachmentClause}
        )
    `,
      )
      .all(sessionId, ...attachmentIds) as Array<{ storage_rel_path?: string | null }>;
    return rows.map((row) => row.storage_rel_path?.trim()).filter((value): value is string => Boolean(value));
  }
}

function dedupeStrings(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const value of values) {
    const normalized = value?.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    deduped.push(normalized);
  }
  return deduped;
}

export { createDatabase, createSqliteSchemaBlueprint, ensureParentDir } from "./sqlite.js";
export type {
  SqliteOptions,
  SqliteSchemaBlueprint,
  SqliteSchemaColumnBlueprint,
  SqliteSchemaForeignKeyBlueprint,
  SqliteSchemaIndexBlueprint,
  SqliteSchemaTableBlueprint,
} from "./sqlite.js";
export * from "./db.js";
export * from "./session-repo.js";
export * from "./idempotency-repo.js";
export * from "./mutation-idempotency-repo.js";
export * from "./transcript-log.js";
export * from "./audit-log.js";
export * from "./approval-repo.js";
export * from "./approval-event-repo.js";
export * from "./pending-approval-action-repo.js";
export * from "./cost-ledger-repo.js";
export * from "./orchestration-repo.js";
export { TaskRepository } from "./task-repo.js";
export type { TaskListQuery, TaskRepositoryOptions, TaskStatusCount } from "./task-repo.js";
export * from "./task-activity-repo.js";
export * from "./task-deliverable-repo.js";
export * from "./task-subagent-repo.js";
export * from "./realtime-event-repo.js";
export * from "./cron-job-repo.js";
export * from "./integration-connection-repo.js";
export * from "./agent-profile-repo.js";
export * from "./imported-agent-catalog-repo.js";
export * from "./mesh-repo.js";
export * from "./memory-context-repo.js";
export * from "./memory-qmd-run-repo.js";
export * from "./tool-grant-repo.js";
export * from "./tool-access-decision-repo.js";
export * from "./knowledge-repo.js";
export * from "./comms-delivery-repo.js";
export * from "./chat-project-repo.js";
export * from "./chat-session-meta-repo.js";
export * from "./chat-session-project-repo.js";
export * from "./chat-session-branch-state-repo.js";
export * from "./chat-session-binding-repo.js";
export * from "./chat-attachment-repo.js";
export * from "./chat-session-prefs-repo.js";
export * from "./session-autonomy-prefs-repo.js";
export * from "./chat-message-repo.js";
export * from "./chat-stream-event-repo.js";
export * from "./chat-turn-trace-repo.js";
export * from "./chat-execution-plan-repo.js";
export * from "./chat-conversation-summary-repo.js";
export * from "./chat-tool-run-repo.js";
export * from "./chat-tool-artifact-repo.js";
export * from "./chat-generated-artifact-repo.js";
export * from "./chat-inline-approval-repo.js";
export * from "./chat-delegation-run-repo.js";
export * from "./chat-delegation-step-repo.js";
export * from "./chat-thread-knowledge-attachment-repo.js";
export * from "./system-settings-repo.js";
export * from "./research-run-repo.js";
export * from "./research-source-repo.js";
export * from "./prompt-pack-policy.js";
export * from "./prompt-pack-repo.js";
export * from "./prompt-pack-run-repo.js";
export * from "./prompt-pack-auto-score-v2-repo.js";
export * from "./prompt-pack-human-review-v2-repo.js";
export * from "./prompt-pack-score-repo.js";
export * from "./workspace-repo.js";
export * from "./workspace-hook-repo.js";
export * from "./hook-run-repo.js";
export * from "./memory-maintenance-repo.js";
export * from "./durable-run-repo.js";
export * from "./safe-json.js";
export * from "./gateway-sql-repo.js";
export * from "./assembly-repo.js";
export * from "./request-attribution.js";
export * from "./remote-action-token-repo.js";
export { ApprovalInboxRepository } from "./approval-inbox-repo.js";
export * from "./approval-effect-repo.js";
export * from "./transcript-outbox-repo.js";
export * from "./realtime-stream-lease-repo.js";
export * from "./durable-run-event-repo.js";
export * from "./chat-reflection-attempt-repo.js";
export * from "./skill-evaluation-run-repo.js";
export { loadAndSanitize } from "./load-and-sanitize.js";
export type { QuarantineEntry, SafeParse, SafeParseResult } from "./load-and-sanitize.js";
export { parseJsonObject, parseJsonArray, parseStringRecord } from "./state-validators.js";
export { StateValidationQuarantineRepository } from "./state-validation-quarantine-repo.js";
export type { StoredQuarantineEntry } from "./state-validation-quarantine-repo.js";
export * from "./postgres/index.js";
