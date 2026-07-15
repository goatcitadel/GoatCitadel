import type { ChatAttachmentRecord } from "@goatcitadel/contracts";
import { ValidationError } from "@goatcitadel/contracts";
import { createDatabase, type SqliteOptions } from "./sqlite.js";
import type { DatabaseClient, DatabaseOnlineBackupOptions } from "./db.js";
import { SessionRepository } from "./session-repo.js";
import { IdempotencyRepository } from "./idempotency-repo.js";
import { MutationIdempotencyRepository } from "./mutation-idempotency-repo.js";
import { TranscriptLog } from "./transcript-log.js";
import { AuditLog } from "./audit-log.js";
import { PostgresTranscriptLog } from "./postgres-transcript-log.js";
import { PostgresAuditLog } from "./postgres-audit-log.js";
import { ApprovalRepository } from "./approval-repo.js";
import { CitadelRepository } from "./citadel-repo.js";
import { CostLedgerRepository } from "./cost-ledger-repo.js";
import { ModelUsageEventRepository } from "./model-usage-event-repo.js";
import { LlmEvalProofRepository } from "./llm-eval-proof-repo.js";
import { LlmRuntimeMeasurementRepository } from "./llm-runtime-measurement-repo.js";
import { ApprovalEventRepository } from "./approval-event-repo.js";
import { PendingApprovalActionRepository } from "./pending-approval-action-repo.js";
import { RemoteActionTokenRepository } from "./remote-action-token-repo.js";
import { ApprovalInboxRepository } from "./approval-inbox-repo.js";
import { ApprovalEffectRepository } from "./approval-effect-repo.js";
import { ApprovalWaitRunRepository } from "./approval-wait-run-repo.js";
import { OrchestrationRepository } from "./orchestration-repo.js";
import { OrchestrationWorktreeLeaseRepository } from "./orchestration-worktree-lease-repo.js";
import { TaskRepository } from "./task-repo.js";
import { TaskActivityRepository } from "./task-activity-repo.js";
import { TaskDeliverableRepository } from "./task-deliverable-repo.js";
import { TaskSubagentRepository } from "./task-subagent-repo.js";
import { RealtimeEventRepository } from "./realtime-event-repo.js";
import { CronJobRepository } from "./cron-job-repo.js";
import { CronRunRepository } from "./cron-run-repo.js";
import { InboundChannelEventRepository } from "./inbound-channel-event-repo.js";
import { IntegrationConnectionRepository } from "./integration-connection-repo.js";
import { ChannelSetupDraftRepository } from "./channel-setup-draft-repo.js";
import { MeshRepository } from "./mesh-repo.js";
import { MeshCapabilityNodeAdmissionRepository } from "./mesh-capability-node-admission-repo.js";
import { MeshCapabilityPublicationRepository } from "./mesh-capability-publication-repo.js";
import { RemoteWorkerAdmissionRepository } from "./remote-worker-admission-repo.js";
import { MemoryContextRepository } from "./memory-context-repo.js";
import { ContextManifestRepository } from "./context-manifest-repo.js";
import { MemoryQmdRunRepository } from "./memory-qmd-run-repo.js";
import { AgentProfileRepository } from "./agent-profile-repo.js";
import { ImportedAgentCatalogRepository } from "./imported-agent-catalog-repo.js";
import { ExternalConnectorReviewStateRepository } from "./external-connector-state-repo.js";
import { ToolGrantRepository } from "./tool-grant-repo.js";
import { ToolAccessDecisionRepository } from "./tool-access-decision-repo.js";
import { PermissionProfileRepository } from "./permission-profile-repo.js";
import { KnowledgeRepository } from "./knowledge-repo.js";
import { CommsDeliveryRepository } from "./comms-delivery-repo.js";
import { ChatProjectRepository } from "./chat-project-repo.js";
import { ChatSessionRevisionRepository } from "./chat-session-revision-repo.js";
import { ChatSessionMetaRepository } from "./chat-session-meta-repo.js";
import { ChatSessionListRepository } from "./chat-session-list-repo.js";
import { ChatSessionProjectRepository } from "./chat-session-project-repo.js";
import { ChatSessionWorkbenchRepository } from "./chat-session-workbench-repo.js";
import { ChatSessionBranchStateRepository } from "./chat-session-branch-state-repo.js";
import { ChatSessionBindingRepository } from "./chat-session-binding-repo.js";
import { ChatSideChatRepository } from "./chat-side-chat-repo.js";
import { ChatAttachmentRepository } from "./chat-attachment-repo.js";
import { ChatSessionPrefsRepository } from "./chat-session-prefs-repo.js";
import { SessionAutonomyPrefsRepository } from "./session-autonomy-prefs-repo.js";
import { AgentCommitmentRepository } from "./agent-commitment-repo.js";
import { OperatorProfileRepository } from "./operator-profile-repo.js";
import { AutonomyAuditRepository } from "./autonomy-audit-repo.js";
import { ChatTurnTraceRepository } from "./chat-turn-trace-repo.js";
import { ChatTurnCapabilityProfileRepository } from "./chat-turn-capability-profile-repo.js";
import { RoutedContextSnapshotRepository } from "./routed-context-snapshot-repo.js";
export {
  ChatTurnCapabilityProfileRepository,
  sealChatTurnCapabilityProfile,
  verifyCapabilityCatalogEntryUniqueness,
  verifyChatTurnCapabilityCatalogBinding,
  verifyChatTurnCapabilityProfile,
  verifyChatTurnCapabilitySkillBindings,
} from "./chat-turn-capability-profile-repo.js";
import { ChatTurnRecoveryRepository } from "./chat-turn-recovery-repo.js";
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
import { CapabilityScopeRepository } from "./capability-scope-repo.js";
import { HookRunRepository } from "./hook-run-repo.js";
import { LearnedMemoryRepository } from "./learned-memory-repo.js";
import { MemoryMaintenanceRepository } from "./memory-maintenance-repo.js";
import { MemoryQualityIssueRepository } from "./memory-quality-issue-repo.js";
import { TranscriptOutboxRepository } from "./transcript-outbox-repo.js";
import { RealtimeStreamLeaseRepository } from "./realtime-stream-lease-repo.js";
import { CapabilityCatalogSnapshotRepository } from "./capability-catalog-snapshot-repo.js";
import { SkillLifecycleRepository } from "./skill-lifecycle-repo.js";
import { CandidateSkillVersionRepository } from "./candidate-skill-version-repo.js";
import { SkillHubSnapshotRepository } from "./skill-hub-snapshot-repo.js";
import { SkillHubArtifactRepository } from "./skill-hub-artifact-repo.js";
import { SkillHubOperationRepository } from "./skill-hub-operation-repo.js";
import { SkillAggregateRevisionRepository } from "./skill-aggregate-revision-repo.js";
import {
  CandidateSkillEvidenceLinkRepository,
  SkillLearningEvidenceRepository,
} from "./skill-learning-evidence-repo.js";
import { GovernanceJourneyEventRepository } from "./governance-journey-event-repo.js";
import { WorkspacePathBridgeSnapshotRepository } from "./workspace-path-bridge-snapshot-repo.js";
import { ExternalSourceConfigRepository } from "./external-source-config-repo.js";
import { ExternalSourceScanRepository } from "./external-source-scan-repo.js";
import { ExternalSourceImportRepository } from "./external-source-import-repo.js";
import { OpsSavedBoardRepository } from "./ops-saved-board-repo.js";
import {
  ExternalSessionAttachmentRepository,
  ExternalSourceKnowledgeLinkRepository,
} from "./external-session-attachment-repo.js";
export {
  ExternalSourceConfigRepository,
  sealExternalSourceRecord,
  verifyExternalSourceRecord,
} from "./external-source-config-repo.js";
export {
  ExternalSourceScanRepository,
  computeExternalSourceManifestSha256,
  decodeExternalSourceCursor,
  encodeExternalSourceCursor,
  sealExternalSourceCatalogItem,
  sealExternalSourceScanRecord,
  verifyExternalSourceCatalogItem,
} from "./external-source-scan-repo.js";
export {
  ExternalSourceImportRepository,
  computeExternalSourceArtifactSetSha256,
  computeExternalSourceImportRequestSha256,
  computeExternalSourceNormalizedSetSha256,
  computeExternalSourceRawSetSha256,
  computeExternalSourceSelectedItemSetSha256,
  computeExternalSourceSettlementResultSha256,
  deriveExternalSourceImportIdempotencyKey,
  sealExternalSourceImportIntent,
  sealExternalSourceImportItem,
  sealExternalSourceImportPlan,
  sealExternalSourceImportSettlement,
  verifyExternalSourceImportIntent,
  verifyExternalSourceImportItem,
  verifyExternalSourceImportPlan,
  verifyExternalSourceImportSettlement,
} from "./external-source-import-repo.js";
export {
  EXTERNAL_SOURCE_KNOWLEDGE_DOCUMENT_PROVENANCE_KIND,
  EXTERNAL_SOURCE_KNOWLEDGE_DOCUMENT_SOURCE_TYPE,
  ExternalSessionAttachmentRepository,
  ExternalSourceKnowledgeLinkRepository,
  buildExternalSourceKnowledgeDocumentBinding,
  sealExternalSourceKnowledgeLink,
  verifyExternalSourceKnowledgeLink,
  type ExternalSourceKnowledgeDocumentBinding,
  type ExternalSourceKnowledgeDocumentBindingInput,
} from "./external-session-attachment-repo.js";
import { CapabilityProposalEventRepository, CapabilityProposalRepository } from "./capability-proposal-repo.js";
import { SkillEvaluationRunRepository } from "./skill-evaluation-run-repo.js";
import { StateValidationQuarantineRepository } from "./state-validation-quarantine-repo.js";
import { CodeModeRunRepository } from "./code-mode-run-repo.js";
import { DurableRunEventRepository } from "./durable-run-event-repo.js";
import { DurableChildWatcherRepository } from "./durable-child-watcher-repo.js";
import { ChatReflectionAttemptRepository } from "./chat-reflection-attempt-repo.js";
import { EvidenceEnvelopeRepository } from "./evidence-envelope-repo.js";
import { ExternalSideEffectRunRepository } from "./external-side-effect-run-repo.js";
import { DryRunCommitRepository } from "./dry-run-commit-repo.js";
import { A2ATaskBindingRepository } from "./a2a-task-binding-repo.js";
import { A2ATaskPushConfigRepository } from "./a2a-task-push-config-repo.js";
import { RuntimeDecisionTraceRepository } from "./runtime-decision-trace-repo.js";
export {
  PersonalOpsInMemoryRepository,
  PersonalOpsStorageRepository,
  type PersonalOpsNoteListQuery,
  type PersonalOpsReminderListQuery,
  type PersonalOpsRepository,
  type PersonalOpsWorkspaceAccess,
} from "./personal-ops-repo.js";
export { ModelComparisonRunRepository } from "./model-comparison-run-repo.js";

export interface StorageOptions extends Partial<SqliteOptions> {
  transcriptsDir: string;
  auditDir: string;
  db?: DatabaseClient;
  transcripts?: TranscriptLog | PostgresTranscriptLog;
  audit?: AuditLog | PostgresAuditLog;
  /** Test/embedding override; production defaults to a one-minute usage recovery sweep. */
  modelUsageRecoverySweepIntervalMs?: number;
}

export interface DeleteChatSessionDataResult {
  sessionId: string;
  deleted: boolean;
  cleanupRelPaths: string[];
  attachments: ChatAttachmentRecord[];
}

export class Storage {
  private modelUsageRecoverySweepTimer?: ReturnType<typeof setInterval>;
  public readonly db: DatabaseClient;
  public readonly sessions: SessionRepository;
  public readonly idempotency: IdempotencyRepository;
  public readonly mutationIdempotency: MutationIdempotencyRepository;
  public readonly transcripts: TranscriptLog | PostgresTranscriptLog;
  public readonly audit: AuditLog | PostgresAuditLog;
  public readonly approvals: ApprovalRepository;
  public readonly citadels: CitadelRepository;
  public readonly approvalEvents: ApprovalEventRepository;
  public readonly pendingApprovalActions: PendingApprovalActionRepository;
  public readonly remoteActionTokens: RemoteActionTokenRepository;
  public readonly approvalInbox: ApprovalInboxRepository;
  public readonly approvalEffects: ApprovalEffectRepository;
  public readonly approvalWaitRuns: ApprovalWaitRunRepository;
  public readonly costLedger: CostLedgerRepository;
  public readonly modelUsageEvents: ModelUsageEventRepository;
  public readonly llmRuntimeMeasurements: LlmRuntimeMeasurementRepository;
  public readonly llmEvalProofRuns: LlmEvalProofRepository;
  public readonly orchestration: OrchestrationRepository;
  public readonly orchestrationWorktreeLeases: OrchestrationWorktreeLeaseRepository;
  public readonly tasks: TaskRepository;
  public readonly taskActivities: TaskActivityRepository;
  public readonly taskDeliverables: TaskDeliverableRepository;
  public readonly taskSubagents: TaskSubagentRepository;
  public readonly realtimeEvents: RealtimeEventRepository;
  public readonly cronJobs: CronJobRepository;
  public readonly cronRuns: CronRunRepository;
  public readonly inboundChannelEvents: InboundChannelEventRepository;
  public readonly integrationConnections: IntegrationConnectionRepository;
  public readonly externalConnectorReviewStates: ExternalConnectorReviewStateRepository;
  public readonly channelSetupDrafts: ChannelSetupDraftRepository;
  public readonly agentProfiles: AgentProfileRepository;
  public readonly importedAgentCatalog: ImportedAgentCatalogRepository;
  public readonly mesh: MeshRepository;
  public readonly meshCapabilityNodeAdmissions: MeshCapabilityNodeAdmissionRepository;
  public readonly meshCapabilityPublications: MeshCapabilityPublicationRepository;
  public readonly remoteWorkerAdmissions: RemoteWorkerAdmissionRepository;
  public readonly memoryContexts: MemoryContextRepository;
  public readonly contextManifests: ContextManifestRepository;
  public readonly memoryQmdRuns: MemoryQmdRunRepository;
  public readonly toolGrants: ToolGrantRepository;
  public readonly toolAccessDecisions: ToolAccessDecisionRepository;
  public readonly permissionProfiles: PermissionProfileRepository;
  public readonly knowledge: KnowledgeRepository;
  public readonly commsDeliveries: CommsDeliveryRepository;
  public readonly chatProjects: ChatProjectRepository;
  public readonly chatSessionRevisions: ChatSessionRevisionRepository;
  public readonly chatSessionMeta: ChatSessionMetaRepository;
  public readonly chatSessionLists: ChatSessionListRepository;
  public readonly chatSessionProjects: ChatSessionProjectRepository;
  public readonly chatSessionWorkbench: ChatSessionWorkbenchRepository;
  public readonly chatSessionBranchState: ChatSessionBranchStateRepository;
  public readonly chatSessionBindings: ChatSessionBindingRepository;
  public readonly chatSideChats: ChatSideChatRepository;
  public readonly chatAttachments: ChatAttachmentRepository;
  public readonly chatSessionPrefs: ChatSessionPrefsRepository;
  public readonly sessionAutonomyPrefs: SessionAutonomyPrefsRepository;
  public readonly agentCommitments: AgentCommitmentRepository;
  public readonly operatorProfiles: OperatorProfileRepository;
  public readonly autonomyAudit: AutonomyAuditRepository;
  public readonly chatMessages: ChatMessageRepository;
  public readonly chatTurnTraces: ChatTurnTraceRepository;
  public readonly chatTurnCapabilityProfiles: ChatTurnCapabilityProfileRepository;
  public readonly routedContextSnapshots: RoutedContextSnapshotRepository;
  public readonly chatTurnRecovery: ChatTurnRecoveryRepository;
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
  public readonly capabilityScope: CapabilityScopeRepository;
  public readonly hookRuns: HookRunRepository;
  public readonly learnedMemory: LearnedMemoryRepository;
  public readonly memoryMaintenance: MemoryMaintenanceRepository;
  public readonly memoryQualityIssues: MemoryQualityIssueRepository;
  public readonly durableRuns: DurableRunRepository;
  public readonly gatewaySql: GatewaySqlRepository;
  public readonly assembly: AssemblyRepository;
  public readonly transcriptOutbox: TranscriptOutboxRepository;
  public readonly realtimeStreamLeases: RealtimeStreamLeaseRepository;
  public readonly capabilityCatalogSnapshots: CapabilityCatalogSnapshotRepository;
  public readonly skillLifecycle: SkillLifecycleRepository;
  public readonly candidateSkillVersions: CandidateSkillVersionRepository;
  public readonly skillHubSnapshots: SkillHubSnapshotRepository;
  public readonly skillHubArtifacts: SkillHubArtifactRepository;
  public readonly skillHubOperations: SkillHubOperationRepository;
  public readonly skillAggregateRevisions: SkillAggregateRevisionRepository;
  public readonly skillLearningEvidence: SkillLearningEvidenceRepository;
  public readonly candidateSkillEvidenceLinks: CandidateSkillEvidenceLinkRepository;
  public readonly governanceJourneyEvents: GovernanceJourneyEventRepository;
  public readonly workspacePathBridgeSnapshots: WorkspacePathBridgeSnapshotRepository;
  public readonly externalSourceConfigs: ExternalSourceConfigRepository;
  public readonly externalSourceScans: ExternalSourceScanRepository;
  public readonly externalSourceImports: ExternalSourceImportRepository;
  public readonly opsSavedBoards: OpsSavedBoardRepository;
  public readonly externalSessionAttachments: ExternalSessionAttachmentRepository;
  public readonly externalSourceKnowledgeLinks: ExternalSourceKnowledgeLinkRepository;
  public readonly capabilityProposals: CapabilityProposalRepository;
  public readonly capabilityProposalEvents: CapabilityProposalEventRepository;
  public readonly skillEvaluationRuns: SkillEvaluationRunRepository;
  public readonly codeModeRuns: CodeModeRunRepository;
  public readonly durableRunEvents: DurableRunEventRepository;
  public readonly durableChildWatchers: DurableChildWatcherRepository;
  public readonly chatReflectionAttempts: ChatReflectionAttemptRepository;
  public readonly evidenceEnvelopes: EvidenceEnvelopeRepository;
  public readonly externalSideEffectRuns: ExternalSideEffectRunRepository;
  public readonly dryRunCommits: DryRunCommitRepository;
  public readonly a2aTaskBindings: A2ATaskBindingRepository;
  public readonly a2aTaskPushConfigs: A2ATaskPushConfigRepository;
  public readonly runtimeDecisionTraces: RuntimeDecisionTraceRepository;
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
      (this.db.dialect === "postgres"
        ? new PostgresTranscriptLog(this.db)
        : new TranscriptLog(options.transcriptsDir, { quarantine: this.stateValidationQuarantine }));
    this.audit =
      options.audit ??
      (this.db.dialect === "postgres" ? new PostgresAuditLog(this.db) : new AuditLog(options.auditDir));
    this.approvals = new ApprovalRepository(this.db);
    this.citadels = new CitadelRepository(this.db);
    this.approvalEvents = new ApprovalEventRepository(this.db);
    this.pendingApprovalActions = new PendingApprovalActionRepository(this.db, {
      quarantine: this.stateValidationQuarantine,
    });
    this.remoteActionTokens = new RemoteActionTokenRepository(this.db);
    this.approvalInbox = new ApprovalInboxRepository(this.db);
    this.approvalEffects = new ApprovalEffectRepository(this.db);
    this.approvalWaitRuns = new ApprovalWaitRunRepository(this.db);
    this.costLedger = new CostLedgerRepository(this.db);
    this.modelUsageEvents = new ModelUsageEventRepository(this.db);
    this.llmRuntimeMeasurements = new LlmRuntimeMeasurementRepository(this.db);
    this.llmEvalProofRuns = new LlmEvalProofRepository(this.db);
    this.orchestration = new OrchestrationRepository(this.db);
    this.orchestrationWorktreeLeases = new OrchestrationWorktreeLeaseRepository(this.db);
    this.tasks = new TaskRepository(this.db, { quarantine: this.stateValidationQuarantine });
    this.taskActivities = new TaskActivityRepository(this.db);
    this.taskDeliverables = new TaskDeliverableRepository(this.db);
    this.taskSubagents = new TaskSubagentRepository(this.db);
    this.realtimeEvents = new RealtimeEventRepository(this.db);
    this.cronJobs = new CronJobRepository(this.db, { quarantine: this.stateValidationQuarantine });
    this.cronRuns = new CronRunRepository(this.db);
    this.inboundChannelEvents = new InboundChannelEventRepository(this.db);
    this.integrationConnections = new IntegrationConnectionRepository(this.db);
    this.externalConnectorReviewStates = new ExternalConnectorReviewStateRepository(this.db);
    this.channelSetupDrafts = new ChannelSetupDraftRepository(this.db);
    this.agentProfiles = new AgentProfileRepository(this.db);
    this.importedAgentCatalog = new ImportedAgentCatalogRepository(this.db);
    this.mesh = new MeshRepository(this.db);
    this.meshCapabilityNodeAdmissions = new MeshCapabilityNodeAdmissionRepository(this.db);
    this.meshCapabilityPublications = new MeshCapabilityPublicationRepository(this.db);
    this.remoteWorkerAdmissions = new RemoteWorkerAdmissionRepository(this.db);
    this.memoryContexts = new MemoryContextRepository(this.db);
    this.contextManifests = new ContextManifestRepository(this.db);
    this.memoryQmdRuns = new MemoryQmdRunRepository(this.db);
    this.toolGrants = new ToolGrantRepository(this.db);
    this.toolAccessDecisions = new ToolAccessDecisionRepository(this.db);
    this.permissionProfiles = new PermissionProfileRepository(this.db);
    this.knowledge = new KnowledgeRepository(this.db);
    this.commsDeliveries = new CommsDeliveryRepository(this.db);
    this.chatProjects = new ChatProjectRepository(this.db);
    this.chatSessionRevisions = new ChatSessionRevisionRepository(this.db);
    this.chatSessionMeta = new ChatSessionMetaRepository(this.db);
    this.chatSessionLists = new ChatSessionListRepository(this.db);
    this.chatSessionProjects = new ChatSessionProjectRepository(this.db);
    this.chatSessionWorkbench = new ChatSessionWorkbenchRepository(this.db);
    this.chatSessionBranchState = new ChatSessionBranchStateRepository(this.db);
    this.chatSessionBindings = new ChatSessionBindingRepository(this.db);
    this.chatSideChats = new ChatSideChatRepository(this.db);
    this.chatAttachments = new ChatAttachmentRepository(this.db);
    this.chatSessionPrefs = new ChatSessionPrefsRepository(this.db);
    this.sessionAutonomyPrefs = new SessionAutonomyPrefsRepository(this.db);
    this.agentCommitments = new AgentCommitmentRepository(this.db);
    this.operatorProfiles = new OperatorProfileRepository(this.db);
    this.autonomyAudit = new AutonomyAuditRepository(this.db);
    this.chatMessages = new ChatMessageRepository(this.db, { quarantine: this.stateValidationQuarantine });
    this.chatTurnTraces = new ChatTurnTraceRepository(this.db);
    this.chatTurnCapabilityProfiles = new ChatTurnCapabilityProfileRepository(this.db);
    this.routedContextSnapshots = new RoutedContextSnapshotRepository(this.db);
    this.chatTurnRecovery = new ChatTurnRecoveryRepository(this.db);
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
    this.capabilityScope = new CapabilityScopeRepository(this.db);
    this.hookRuns = new HookRunRepository(this.db);
    this.learnedMemory = new LearnedMemoryRepository(this.db);
    this.memoryMaintenance = new MemoryMaintenanceRepository(this.db);
    this.memoryQualityIssues = new MemoryQualityIssueRepository(this.db);
    this.durableRuns = new DurableRunRepository(this.db, { quarantine: this.stateValidationQuarantine });
    this.gatewaySql = new GatewaySqlRepository(this.db);
    this.assembly = new AssemblyRepository(this.db);
    this.transcriptOutbox = new TranscriptOutboxRepository(this.db);
    this.realtimeStreamLeases = new RealtimeStreamLeaseRepository(this.db);
    this.capabilityCatalogSnapshots = new CapabilityCatalogSnapshotRepository(this.db);
    this.skillLifecycle = new SkillLifecycleRepository(this.db);
    this.candidateSkillVersions = new CandidateSkillVersionRepository(this.db);
    this.skillHubSnapshots = new SkillHubSnapshotRepository(this.db);
    this.skillHubArtifacts = new SkillHubArtifactRepository(this.db);
    this.skillHubOperations = new SkillHubOperationRepository(this.db);
    this.skillAggregateRevisions = new SkillAggregateRevisionRepository(this.db);
    this.skillLearningEvidence = new SkillLearningEvidenceRepository(this.db);
    this.candidateSkillEvidenceLinks = new CandidateSkillEvidenceLinkRepository(this.db);
    this.governanceJourneyEvents = new GovernanceJourneyEventRepository(this.db);
    this.workspacePathBridgeSnapshots = new WorkspacePathBridgeSnapshotRepository(this.db);
    this.externalSourceConfigs = new ExternalSourceConfigRepository(this.db);
    this.externalSourceScans = new ExternalSourceScanRepository(this.db);
    this.externalSourceImports = new ExternalSourceImportRepository(this.db);
    this.opsSavedBoards = new OpsSavedBoardRepository(this.db);
    this.externalSessionAttachments = new ExternalSessionAttachmentRepository(this.db);
    this.externalSourceKnowledgeLinks = new ExternalSourceKnowledgeLinkRepository(this.db);
    this.capabilityProposals = new CapabilityProposalRepository(this.db);
    this.capabilityProposalEvents = new CapabilityProposalEventRepository(this.db);
    this.skillEvaluationRuns = new SkillEvaluationRunRepository(this.db);
    this.codeModeRuns = new CodeModeRunRepository(this.db);
    this.durableRunEvents = new DurableRunEventRepository(this.db);
    this.durableChildWatchers = new DurableChildWatcherRepository(this.db);
    this.chatReflectionAttempts = new ChatReflectionAttemptRepository(this.db);
    this.evidenceEnvelopes = new EvidenceEnvelopeRepository(this.db);
    this.externalSideEffectRuns = new ExternalSideEffectRunRepository(this.db);
    this.dryRunCommits = new DryRunCommitRepository(this.db);
    this.a2aTaskBindings = new A2ATaskBindingRepository(this.db);
    this.a2aTaskPushConfigs = new A2ATaskPushConfigRepository(this.db);
    this.runtimeDecisionTraces = new RuntimeDecisionTraceRepository(this.db);
    const modelUsageRecoverySweepIntervalMs = Math.max(
      10,
      Math.floor(options.modelUsageRecoverySweepIntervalMs ?? 60_000),
    );
    this.modelUsageRecoverySweepTimer = setInterval(() => {
      try {
        this.modelUsageEvents.recoverExpiredBacklog(new Date().toISOString(), {
          batchSize: 1_000,
          maxBatches: 10,
        });
      } catch (error) {
        // Keep storage available; a later periodic sweep retries the bounded backlog.
        // eslint-disable-next-line no-console
        console.warn("[goatcitadel] model usage recovery sweep failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }, modelUsageRecoverySweepIntervalMs);
    this.modelUsageRecoverySweepTimer.unref?.();
  }

  public close(): void {
    if (this.modelUsageRecoverySweepTimer) {
      clearInterval(this.modelUsageRecoverySweepTimer);
      this.modelUsageRecoverySweepTimer = undefined;
    }
    this.db.close();
  }

  public async createSqliteSnapshot(destinationPath: string, options?: DatabaseOnlineBackupOptions): Promise<void> {
    if (this.db.dialect !== "sqlite") {
      throw new Error("Online SQLite snapshots are only available for SQLite storage");
    }
    if (typeof this.db.backupTo !== "function") {
      throw new Error("The configured SQLite storage client does not support online snapshots");
    }
    await this.db.backupTo(destinationPath, options);
  }

  public runImmediateTransaction<T>(callback: () => T): T {
    return this.db.transaction("immediate", callback);
  }

  public deleteChatSessionData(sessionId: string): DeleteChatSessionDataResult {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) {
      throw new ValidationError({ code: "FIELD_REQUIRED", field: "sessionId" });
    }

    const revision = this.chatSessionRevisions.ensure(normalizedSessionId);
    return this.deleteChatSessionDataWithRevision(normalizedSessionId, revision.revision);
  }

  public deleteChatSessionDataWithRevision(sessionId: string, expectedRevision: number): DeleteChatSessionDataResult {
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

    const deleted = this.chatSessionRevisions.runDeleteWithRevision(normalizedSessionId, expectedRevision, () => {
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
      this.db.prepare("DELETE FROM chat_side_chats WHERE parent_session_id = ? OR child_session_id = ?").run(sid, sid);
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
        "llm_runtime_measurements",
        "llm_eval_proof_runs",
        "chat_execution_plans",
        "chat_conversation_summaries",
        "chat_compaction_breaker_actions",
        "chat_compaction_breakers",
        "chat_compaction_states",
        "tool_access_decisions",
        "tool_invocations",
        "policy_blocks",
        "model_usage_events",
        "cost_ledger",
        "voice_sessions",
        "mesh_session_owners",
        "transcript_outbox",
        "chat_inline_approvals",
        "chat_stream_events",
        "runtime_decision_traces",
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
export * from "./orchestration-worktree-lease-repo.js";
export { TaskRepository } from "./task-repo.js";
export type { TaskListQuery, TaskRepositoryOptions, TaskStatusCount } from "./task-repo.js";
export * from "./task-activity-repo.js";
export * from "./task-deliverable-repo.js";
export * from "./task-subagent-repo.js";
export * from "./realtime-event-repo.js";
export * from "./cron-job-repo.js";
export * from "./cron-run-repo.js";
export * from "./inbound-channel-event-repo.js";
export * from "./integration-connection-repo.js";
export * from "./agent-profile-repo.js";
export * from "./imported-agent-catalog-repo.js";
export * from "./mesh-repo.js";
export * from "./mesh-capability-node-admission-repo.js";
export * from "./mesh-capability-publication-repo.js";
export * from "./remote-worker-admission-repo.js";
export * from "./memory-context-repo.js";
export * from "./memory-qmd-run-repo.js";
export * from "./tool-grant-repo.js";
export * from "./tool-access-decision-repo.js";
export * from "./model-usage-event-repo.js";
export * from "./knowledge-repo.js";
export * from "./comms-delivery-repo.js";
export * from "./chat-project-repo.js";
export * from "./chat-session-revision-repo.js";
export * from "./chat-session-meta-repo.js";
export * from "./chat-session-list-repo.js";
export * from "./chat-session-project-repo.js";
export * from "./chat-session-branch-state-repo.js";
export * from "./chat-session-binding-repo.js";
export * from "./chat-attachment-repo.js";
export * from "./chat-session-prefs-repo.js";
export * from "./session-autonomy-prefs-repo.js";
export * from "./operator-profile-repo.js";
export * from "./autonomy-audit-repo.js";
export * from "./chat-message-repo.js";
export * from "./chat-stream-event-repo.js";
export * from "./chat-turn-trace-repo.js";
export * from "./chat-turn-recovery-repo.js";
export * from "./routed-context-snapshot-repo.js";
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
export * from "./capability-scope-repo.js";
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
export * from "./durable-child-watcher-repo.js";
export * from "./chat-reflection-attempt-repo.js";
export * from "./external-side-effect-run-repo.js";
export * from "./runtime-decision-trace-repo.js";
export * from "./skill-evaluation-run-repo.js";
export * from "./candidate-skill-version-repo.js";
export * from "./skill-hub-snapshot-repo.js";
export * from "./skill-hub-artifact-repo.js";
export * from "./skill-hub-operation-repo.js";
export * from "./skill-aggregate-revision-repo.js";
export * from "./skill-learning-evidence-repo.js";
export * from "./governance-journey-event-repo.js";
export * from "./workspace-path-bridge-snapshot-repo.js";
export * from "./ops-saved-board-repo.js";
export { loadAndSanitize } from "./load-and-sanitize.js";
export type { QuarantineEntry, SafeParse, SafeParseResult } from "./load-and-sanitize.js";
export { parseJsonObject, parseJsonArray, parseStringRecord } from "./state-validators.js";
export { StateValidationQuarantineRepository } from "./state-validation-quarantine-repo.js";
export type { StoredQuarantineEntry } from "./state-validation-quarantine-repo.js";
export * from "./postgres/index.js";
