import { AuthAdminRouteService, type AuthAdminRoutePort } from "./auth-admin-route-service.js";
import { createAddonsRouteService, type AddonsRoutePort, type AddonsRouteService } from "./addons-route-service.js";
import { createAgentsRouteService, type AgentsRoutePort, type AgentsRouteService } from "./agents-route-service.js";
import { A2ARouteService, type A2ARouteServiceDependencies } from "./a2a-route-service.js";
import {
  createAssemblyRouteService,
  type AssemblyRoutePort,
  type AssemblyRouteService,
} from "./assembly-route-service.js";
import type { ApprovalRuntime } from "./approval-runtime-service.js";
import { ApprovalsRouteService } from "./approvals-route-service.js";
import {
  CitadelsRouteService,
  type CitadelsRoutePort,
  type MasonInterpret,
  type VaultKeyProvider,
} from "./citadels-route-service.js";
import { CapabilitiesRouteService, type CapabilitiesRoutePort } from "./capabilities-route-service.js";
import { CapabilityScopeRouteService, type CapabilityScopeRouteServiceDeps } from "./capability-scope-route-service.js";
import {
  createCapabilityPacksRouteService,
  type CapabilityPacksRoutePort,
  type CapabilityPacksRouteService,
} from "./capability-packs-route-service.js";
import {
  createChatAttachmentsRouteService,
  type ChatAttachmentsRoutePort,
  type ChatAttachmentsRouteService,
} from "./chat-attachments-route-service.js";
import type { ChatCompactionBreakerActionService } from "./chat-compaction-breaker-action-service.js";
import {
  createChatDelegateRouteService,
  type ChatDelegateRoutePort,
  type ChatDelegateRouteService,
} from "./chat-delegate-route-service.js";
import {
  createChatMessagesRouteService,
  type ChatMessagesRoutePort,
  type ChatMessagesRouteService,
} from "./chat-messages-route-service.js";
import {
  createChatProjectsRouteService,
  type ChatProjectsRoutePort,
  type ChatProjectsRouteService,
} from "./chat-projects-route-service.js";
import { ChatSupportRouteService, type ChatSupportRouteDependencies } from "./chat-support-route-service.js";
import {
  createChatSessionsRouteService,
  type ChatSessionsRoutePort,
  type ChatSessionsRouteService,
} from "./chat-sessions-route-service.js";
import {
  createChatToolsRouteService,
  type ChatToolsRoutePort,
  type ChatToolsRouteService,
} from "./chat-tools-route-service.js";
import {
  createChannelSetupRouteService,
  type ChannelSetupRoutePort,
  type ChannelSetupRouteService,
} from "./channel-setup-route-service.js";
import { createCommsRouteService, type CommsRoutePort, type CommsRouteService } from "./comms-route-service.js";
import { createComplianceRouteService, type ComplianceRouteService } from "./compliance-export-route-service.js";
import type { ComplianceExportServiceDeps } from "./compliance-export-service.js";
import {
  createConnectorsRouteService,
  type ConnectorsRoutePort,
  type ConnectorsRouteService,
} from "./connectors-route-service.js";
import { createCostsRouteService, type CostsRoutePort, type CostsRouteService } from "./costs-route-service.js";
import { CuratorRouteService, type CuratorRoutePort } from "./curator-route-service.js";
import { createCronRouteService, type CronRoutePort, type CronRouteService } from "./cron-route-service.js";
import {
  createDashboardRouteService,
  type DashboardRoutePort,
  type DashboardRouteService,
} from "./dashboard-route-service.js";
import { createDaemonRouteService, type DaemonRoutePort, type DaemonRouteService } from "./daemon-route-service.js";
import {
  DevVerificationRouteService,
  type DevVerificationRouteDependencies,
} from "./dev-verification-route-service.js";
import {
  createDevDiagnosticsRouteService,
  type DevDiagnosticsRoutePort,
  type DevDiagnosticsRouteService,
} from "./dev-diagnostics-route-service.js";
import type { DurableOperatorService } from "./durable-operator-service.js";
import { DurableRouteService } from "./durable-route-service.js";
import { createFilesRouteService, type FilesRoutePort, type FilesRouteService } from "./files-route-service.js";
import {
  createEvidenceRouteService,
  type EvidenceRoutePort,
  type EvidenceRouteService,
} from "./evidence-route-service.js";
import {
  createEvidenceReceiptsRouteService,
  type EvidenceReceiptsRouteService,
} from "./evidence-receipts-route-service.js";
import type { EvidenceReceiptServiceDeps } from "./evidence-receipt-service.js";
import {
  createGatewayEventsRouteService,
  type GatewayEventsRoutePort,
  type GatewayEventsRouteService,
} from "./gateway-events-route-service.js";
import { createHealthRouteService, type HealthRoutePort, type HealthRouteService } from "./health-route-service.js";
import { createHooksRouteService, type HooksRoutePort, type HooksRouteService } from "./hooks-route-service.js";
import { ImprovementRouteService, type ImprovementRouteDependencies } from "./improvement-route-service.js";
import {
  createIntegrationRouteService,
  type IntegrationRoutePort,
  type IntegrationRouteService,
} from "./integration-route-service.js";
import {
  createIntegrationWebhookRouteService,
  type IntegrationWebhookRoutePort,
  type IntegrationWebhookRouteService,
} from "./integration-webhook-route-service.js";
import {
  createKnowledgeRouteService,
  type KnowledgeRoutePort,
  type KnowledgeRouteService,
} from "./knowledge-route-service.js";
import type { JourneyTimelineRouteService } from "./journey-timeline-route-service.js";
import type { LocalAiRouteService } from "./local-ai-route-service.js";
import {
  createLlamaCppRouteService,
  type LlamaCppRoutePort,
  type LlamaCppRouteService,
} from "./llama-cpp-route-service.js";
import { createLlmRouteService, type LlmRoutePort, type LlmRouteService } from "./llm-route-service.js";
import type { MemoryLifecycleService } from "./memory-lifecycle-service.js";
import { MemoryRouteService } from "./memory-route-service.js";
import { McpRouteService, type McpRoutePort } from "./mcp-route-service.js";
import type { ModelComparisonService } from "./model-comparison-service.js";
import { createMediaRouteService, type MediaRoutePort, type MediaRouteService } from "./media-route-service.js";
import { createMeshRouteService, type MeshRoutePort, type MeshRouteService } from "./mesh-route-service.js";
import { createMobileRouteService, type MobileRoutePort, type MobileRouteService } from "./mobile-route-service.js";
import { createNpuRouteService, type NpuRoutePort, type NpuRouteService } from "./npu-route-service.js";
import type { PersonalOpsRouteService } from "./personal-ops-route-service.js";
import type { OpsSavedBoardService } from "./ops-saved-board-service.js";
import {
  createOnboardingRouteService,
  type OnboardingRoutePort,
  type OnboardingRouteService,
} from "./onboarding-route-service.js";
import {
  createObsidianRouteService,
  type ObsidianRoutePort,
  type ObsidianRouteService,
} from "./obsidian-route-service.js";
import { OrchestrationRouteService, type OrchestrationRoutePort } from "./orchestration-route-service.js";
import { PromptPacksRouteService, type PromptPacksRoutePort } from "./prompt-packs-route-service.js";
import type { SessionControlRouteService } from "./session-control-route-service.js";
import {
  createRealtimeEventsRouteService,
  type RealtimeEventsRoutePort,
  type RealtimeEventsRouteService,
} from "./realtime-events-route-service.js";
import { ResearchSearchRouteService, type ResearchSearchRoutePort } from "./research-search-broker-service.js";
import { RemoteWorkersRouteService, type RemoteWorkerRegistryStore } from "./remote-workers-route-service.js";
import { RuntimeLifecycleRouteService, type RuntimeLifecycleRoutePort } from "./runtime-lifecycle-route-service.js";
import {
  createSessionsListRouteService,
  type SessionsListRoutePort,
  type SessionsListRouteService,
} from "./sessions-list-route-service.js";
import { createSecretsRouteService, type SecretsRoutePort, type SecretsRouteService } from "./secrets-route-service.js";
import {
  createSettingsRouteService,
  type SettingsRoutePort,
  type SettingsRouteService,
} from "./settings-route-service.js";
import {
  createAutonomyControlRouteService,
  type AutonomyControlRoutePort,
  type AutonomyControlRouteService,
} from "./autonomy-control-route-service.js";
import { SkillsRouteService, type SkillsRoutePort } from "./skills-route-service.js";
import { TasksRouteService, type TasksRoutePort } from "./tasks-route-service.js";
import {
  createToolsInvokeRouteService,
  type ToolsInvokeRoutePort,
  type ToolsInvokeRouteService,
} from "./tools-invoke-route-service.js";
import { createToolsRouteService, type ToolsRoutePort, type ToolsRouteService } from "./tools-route-service.js";
import { UpdateScoutRouteService, type UpdateScoutRoutePort } from "./update-scout-service.js";
import { createVoiceRouteService, type VoiceRoutePort, type VoiceRouteService } from "./voice-route-service.js";
import {
  createWorkspacesRouteService,
  type WorkspacesRoutePort,
  type WorkspacesRouteService,
} from "./workspaces-route-service.js";
import type { WorkspacePathBridgeRouteService } from "../routes/workspace-path-bridge.js";
import type { ExternalSourceRouteService } from "./external-source-route-service.js";
export interface GatewayRouteServices {
  a2a: A2ARouteService;
  addons: AddonsRouteService;
  agents: AgentsRouteService;
  assembly: AssemblyRouteService;
  authAdmin: AuthAdminRouteService;
  autonomyControl: AutonomyControlRouteService;
  approvals: ApprovalsRouteService;
  capabilityScope: CapabilityScopeRouteService;
  citadels: CitadelsRouteService;
  compliance: ComplianceRouteService;
  capabilities: CapabilitiesRouteService;
  capabilityPacks: CapabilityPacksRouteService;
  chatAttachments: ChatAttachmentsRouteService;
  chatCompactionBreakerActions: ChatCompactionBreakerActionService;
  chatDelegate: ChatDelegateRouteService;
  chatMessages: ChatMessagesRouteService;
  chatProjects: ChatProjectsRouteService;
  chatSessions: ChatSessionsRouteService;
  chatSupport: ChatSupportRouteService;
  chatTools: ChatToolsRouteService;
  channelSetup: ChannelSetupRouteService;
  comms: CommsRouteService;
  connectors: ConnectorsRouteService;
  costs: CostsRouteService;
  cron: CronRouteService;
  curator: CuratorRouteService;
  dashboard: DashboardRouteService;
  daemon: DaemonRouteService;
  devDiagnostics: DevDiagnosticsRouteService;
  devVerification: DevVerificationRouteService;
  durable: DurableRouteService;
  evidence: EvidenceRouteService;
  evidenceReceipts: EvidenceReceiptsRouteService;
  externalSources?: ExternalSourceRouteService;
  files: FilesRouteService;
  gatewayEvents: GatewayEventsRouteService;
  health: HealthRouteService;
  hooks: HooksRouteService;
  improvement: ImprovementRouteService;
  integrations: IntegrationRouteService;
  integrationWebhooks: IntegrationWebhookRouteService;
  knowledge: KnowledgeRouteService;
  journeyTimeline?: JourneyTimelineRouteService;
  localAi: LocalAiRouteService;
  llamaCpp: LlamaCppRouteService;
  llm: LlmRouteService;
  memory: MemoryRouteService;
  mcp: McpRouteService;
  modelComparisons: ModelComparisonService;
  media: MediaRouteService;
  mesh: MeshRouteService;
  mobile: MobileRouteService;
  npu: NpuRouteService;
  personalOps: PersonalOpsRouteService;
  opsSavedBoards?: OpsSavedBoardService;
  onboarding: OnboardingRouteService;
  obsidian: ObsidianRouteService;
  orchestration: OrchestrationRouteService;
  promptPacks: PromptPacksRouteService;
  realtimeEvents: RealtimeEventsRouteService;
  researchSearch: ResearchSearchRouteService;
  remoteWorkers: RemoteWorkersRouteService;
  runtimeLifecycle: RuntimeLifecycleRouteService;
  secrets: SecretsRouteService;
  sessionControl: SessionControlRouteService;
  settings: SettingsRouteService;
  sessionsList: SessionsListRouteService;
  skills: SkillsRouteService;
  tasks: TasksRouteService;
  tools: ToolsRouteService;
  toolsInvoke: ToolsInvokeRouteService;
  updateScout: UpdateScoutRouteService;
  voice: VoiceRouteService;
  workspacePathBridge?: WorkspacePathBridgeRouteService;
  workspaces: WorkspacesRouteService;
}

export interface GatewayRouteServiceDependencies {
  a2a: A2ARouteServiceDependencies;
  addons: AddonsRoutePort;
  agents: AgentsRoutePort;
  assembly: AssemblyRoutePort;
  authAdmin: AuthAdminRoutePort;
  autonomyControl: AutonomyControlRoutePort;
  approvals: ApprovalRuntime;
  capabilityScope: CapabilityScopeRouteServiceDeps;
  citadels: CitadelsRoutePort;
  masonInterpret?: MasonInterpret;
  vaultKey?: VaultKeyProvider;
  compliance: ComplianceExportServiceDeps;
  capabilities: CapabilitiesRoutePort;
  capabilityPacks: CapabilityPacksRoutePort;
  chatAttachments: ChatAttachmentsRoutePort;
  chatCompactionBreakerActions: ChatCompactionBreakerActionService;
  chatDelegate: ChatDelegateRoutePort;
  chatMessages: ChatMessagesRoutePort;
  chatProjects: ChatProjectsRoutePort;
  chatSessions: ChatSessionsRoutePort;
  chatSupport: ChatSupportRouteDependencies;
  chatTools: ChatToolsRoutePort;
  channelSetup: ChannelSetupRoutePort;
  comms: CommsRoutePort;
  connectors: ConnectorsRoutePort;
  costs: CostsRoutePort;
  cron: CronRoutePort;
  curator: CuratorRoutePort;
  dashboard: DashboardRoutePort;
  daemon: DaemonRoutePort;
  devDiagnostics: DevDiagnosticsRoutePort;
  devVerification: DevVerificationRouteDependencies;
  durable: DurableOperatorService;
  evidence: EvidenceRoutePort;
  evidenceReceipts: EvidenceReceiptServiceDeps;
  files: FilesRoutePort;
  gatewayEvents: GatewayEventsRoutePort;
  health: HealthRoutePort;
  hooks: HooksRoutePort;
  improvement: ImprovementRouteDependencies;
  integrations: IntegrationRoutePort;
  integrationWebhooks: IntegrationWebhookRoutePort;
  knowledge: KnowledgeRoutePort;
  localAi: LocalAiRouteService;
  llamaCpp: LlamaCppRoutePort;
  llm: LlmRoutePort;
  memory: MemoryLifecycleService;
  mcp: McpRoutePort;
  modelComparisons: ModelComparisonService;
  media: MediaRoutePort;
  mesh: MeshRoutePort;
  mobile: MobileRoutePort;
  npu: NpuRoutePort;
  personalOps: PersonalOpsRouteService;
  onboarding: OnboardingRoutePort;
  obsidian: ObsidianRoutePort;
  orchestration: OrchestrationRoutePort;
  promptPacks: PromptPacksRoutePort;
  realtimeEvents: RealtimeEventsRoutePort;
  researchSearch: ResearchSearchRoutePort;
  remoteWorkers: RemoteWorkerRegistryStore;
  runtimeLifecycle: RuntimeLifecycleRoutePort;
  secrets: SecretsRoutePort;
  sessionControl: SessionControlRouteService;
  settings: SettingsRoutePort;
  sessionsList: SessionsListRoutePort;
  skills: SkillsRoutePort;
  tasks: TasksRoutePort;
  tools: ToolsRoutePort;
  toolsInvoke: ToolsInvokeRoutePort;
  updateScout: UpdateScoutRoutePort;
  voice: VoiceRoutePort;
  workspaces: WorkspacesRoutePort;
}

export function createGatewayRouteServices(deps: GatewayRouteServiceDependencies): GatewayRouteServices {
  return {
    a2a: new A2ARouteService(deps.a2a),
    addons: createAddonsRouteService(deps.addons),
    agents: createAgentsRouteService(deps.agents),
    assembly: createAssemblyRouteService(deps.assembly),
    authAdmin: new AuthAdminRouteService(deps.authAdmin),
    autonomyControl: createAutonomyControlRouteService(deps.autonomyControl),
    approvals: new ApprovalsRouteService(deps.approvals),
    capabilityScope: new CapabilityScopeRouteService(deps.capabilityScope),
    citadels: new CitadelsRouteService(deps.citadels, deps.masonInterpret, deps.vaultKey),
    compliance: createComplianceRouteService(deps.compliance),
    capabilities: new CapabilitiesRouteService(deps.capabilities),
    capabilityPacks: createCapabilityPacksRouteService(deps.capabilityPacks),
    chatAttachments: createChatAttachmentsRouteService(deps.chatAttachments),
    chatCompactionBreakerActions: deps.chatCompactionBreakerActions,
    chatDelegate: createChatDelegateRouteService(deps.chatDelegate),
    chatMessages: createChatMessagesRouteService(deps.chatMessages),
    chatProjects: createChatProjectsRouteService(deps.chatProjects),
    chatSessions: createChatSessionsRouteService(deps.chatSessions),
    chatSupport: new ChatSupportRouteService(deps.chatSupport),
    chatTools: createChatToolsRouteService(deps.chatTools),
    channelSetup: createChannelSetupRouteService(deps.channelSetup),
    comms: createCommsRouteService(deps.comms),
    connectors: createConnectorsRouteService(deps.connectors),
    costs: createCostsRouteService(deps.costs),
    cron: createCronRouteService(deps.cron),
    curator: new CuratorRouteService(deps.curator),
    dashboard: createDashboardRouteService(deps.dashboard),
    daemon: createDaemonRouteService(deps.daemon),
    devDiagnostics: createDevDiagnosticsRouteService(deps.devDiagnostics),
    devVerification: new DevVerificationRouteService(deps.devVerification),
    durable: new DurableRouteService(deps.durable),
    evidence: createEvidenceRouteService(deps.evidence),
    evidenceReceipts: createEvidenceReceiptsRouteService(deps.evidenceReceipts),
    files: createFilesRouteService(deps.files),
    gatewayEvents: createGatewayEventsRouteService(deps.gatewayEvents),
    health: createHealthRouteService(deps.health),
    hooks: createHooksRouteService(deps.hooks),
    improvement: new ImprovementRouteService(deps.improvement),
    integrations: createIntegrationRouteService(deps.integrations),
    integrationWebhooks: createIntegrationWebhookRouteService(deps.integrationWebhooks),
    knowledge: createKnowledgeRouteService(deps.knowledge),
    localAi: deps.localAi,
    llamaCpp: createLlamaCppRouteService(deps.llamaCpp),
    llm: createLlmRouteService(deps.llm),
    memory: new MemoryRouteService(deps.memory),
    mcp: new McpRouteService(deps.mcp),
    modelComparisons: deps.modelComparisons,
    media: createMediaRouteService(deps.media),
    mesh: createMeshRouteService(deps.mesh),
    mobile: createMobileRouteService(deps.mobile),
    npu: createNpuRouteService(deps.npu),
    personalOps: deps.personalOps,
    onboarding: createOnboardingRouteService(deps.onboarding),
    obsidian: createObsidianRouteService(deps.obsidian),
    orchestration: new OrchestrationRouteService(deps.orchestration),
    promptPacks: new PromptPacksRouteService(deps.promptPacks),
    realtimeEvents: createRealtimeEventsRouteService(deps.realtimeEvents),
    researchSearch: new ResearchSearchRouteService(deps.researchSearch),
    remoteWorkers: new RemoteWorkersRouteService(deps.remoteWorkers),
    runtimeLifecycle: new RuntimeLifecycleRouteService(deps.runtimeLifecycle),
    secrets: createSecretsRouteService(deps.secrets),
    sessionControl: deps.sessionControl,
    settings: createSettingsRouteService(deps.settings),
    sessionsList: createSessionsListRouteService(deps.sessionsList),
    skills: new SkillsRouteService(deps.skills),
    tasks: new TasksRouteService(deps.tasks),
    tools: createToolsRouteService(deps.tools),
    toolsInvoke: createToolsInvokeRouteService(deps.toolsInvoke),
    updateScout: new UpdateScoutRouteService(deps.updateScout),
    voice: createVoiceRouteService(deps.voice),
    workspaces: createWorkspacesRouteService(deps.workspaces),
  };
}
