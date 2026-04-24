import { AuthAdminRouteService, type AuthAdminRoutePort } from "./auth-admin-route-service.js";
import { createAddonsRouteService, type AddonsRoutePort, type AddonsRouteService } from "./addons-route-service.js";
import { createAgentsRouteService, type AgentsRoutePort, type AgentsRouteService } from "./agents-route-service.js";
import {
  createAssemblyRouteService,
  type AssemblyRoutePort,
  type AssemblyRouteService,
} from "./assembly-route-service.js";
import type { ApprovalRuntime } from "./approval-runtime-service.js";
import { ApprovalsRouteService } from "./approvals-route-service.js";
import { CapabilitiesRouteService, type CapabilitiesRoutePort } from "./capabilities-route-service.js";
import {
  createChatAttachmentsRouteService,
  type ChatAttachmentsRoutePort,
  type ChatAttachmentsRouteService,
} from "./chat-attachments-route-service.js";
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
import {
  createConnectorsRouteService,
  type ConnectorsRoutePort,
  type ConnectorsRouteService,
} from "./connectors-route-service.js";
import { createCostsRouteService, type CostsRoutePort, type CostsRouteService } from "./costs-route-service.js";
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
import {
  createLlamaCppRouteService,
  type LlamaCppRoutePort,
  type LlamaCppRouteService,
} from "./llama-cpp-route-service.js";
import { createLlmRouteService, type LlmRoutePort, type LlmRouteService } from "./llm-route-service.js";
import type { MemoryLifecycleService } from "./memory-lifecycle-service.js";
import { MemoryRouteService } from "./memory-route-service.js";
import { McpRouteService, type McpRoutePort } from "./mcp-route-service.js";
import { createMediaRouteService, type MediaRoutePort, type MediaRouteService } from "./media-route-service.js";
import { createMeshRouteService, type MeshRoutePort, type MeshRouteService } from "./mesh-route-service.js";
import { createNpuRouteService, type NpuRoutePort, type NpuRouteService } from "./npu-route-service.js";
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
import {
  createRealtimeEventsRouteService,
  type RealtimeEventsRoutePort,
  type RealtimeEventsRouteService,
} from "./realtime-events-route-service.js";
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
import { SkillsRouteService, type SkillsRoutePort } from "./skills-route-service.js";
import { TasksRouteService, type TasksRoutePort } from "./tasks-route-service.js";
import {
  createToolsInvokeRouteService,
  type ToolsInvokeRoutePort,
  type ToolsInvokeRouteService,
} from "./tools-invoke-route-service.js";
import { createToolsRouteService, type ToolsRoutePort, type ToolsRouteService } from "./tools-route-service.js";
import { createVoiceRouteService, type VoiceRoutePort, type VoiceRouteService } from "./voice-route-service.js";
import {
  createWorkspacesRouteService,
  type WorkspacesRoutePort,
  type WorkspacesRouteService,
} from "./workspaces-route-service.js";
export interface GatewayRouteServices {
  addons: AddonsRouteService;
  agents: AgentsRouteService;
  assembly: AssemblyRouteService;
  authAdmin: AuthAdminRouteService;
  approvals: ApprovalsRouteService;
  capabilities: CapabilitiesRouteService;
  chatAttachments: ChatAttachmentsRouteService;
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
  dashboard: DashboardRouteService;
  daemon: DaemonRouteService;
  devDiagnostics: DevDiagnosticsRouteService;
  devVerification: DevVerificationRouteService;
  durable: DurableRouteService;
  files: FilesRouteService;
  gatewayEvents: GatewayEventsRouteService;
  health: HealthRouteService;
  hooks: HooksRouteService;
  improvement: ImprovementRouteService;
  integrations: IntegrationRouteService;
  integrationWebhooks: IntegrationWebhookRouteService;
  knowledge: KnowledgeRouteService;
  llamaCpp: LlamaCppRouteService;
  llm: LlmRouteService;
  memory: MemoryRouteService;
  mcp: McpRouteService;
  media: MediaRouteService;
  mesh: MeshRouteService;
  npu: NpuRouteService;
  onboarding: OnboardingRouteService;
  obsidian: ObsidianRouteService;
  orchestration: OrchestrationRouteService;
  promptPacks: PromptPacksRouteService;
  realtimeEvents: RealtimeEventsRouteService;
  runtimeLifecycle: RuntimeLifecycleRouteService;
  secrets: SecretsRouteService;
  settings: SettingsRouteService;
  sessionsList: SessionsListRouteService;
  skills: SkillsRouteService;
  tasks: TasksRouteService;
  tools: ToolsRouteService;
  toolsInvoke: ToolsInvokeRouteService;
  voice: VoiceRouteService;
  workspaces: WorkspacesRouteService;
}

export interface GatewayRouteServiceDependencies {
  addons: AddonsRoutePort;
  agents: AgentsRoutePort;
  assembly: AssemblyRoutePort;
  authAdmin: AuthAdminRoutePort;
  approvals: ApprovalRuntime;
  capabilities: CapabilitiesRoutePort;
  chatAttachments: ChatAttachmentsRoutePort;
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
  dashboard: DashboardRoutePort;
  daemon: DaemonRoutePort;
  devDiagnostics: DevDiagnosticsRoutePort;
  devVerification: DevVerificationRouteDependencies;
  durable: DurableOperatorService;
  files: FilesRoutePort;
  gatewayEvents: GatewayEventsRoutePort;
  health: HealthRoutePort;
  hooks: HooksRoutePort;
  improvement: ImprovementRouteDependencies;
  integrations: IntegrationRoutePort;
  integrationWebhooks: IntegrationWebhookRoutePort;
  knowledge: KnowledgeRoutePort;
  llamaCpp: LlamaCppRoutePort;
  llm: LlmRoutePort;
  memory: MemoryLifecycleService;
  mcp: McpRoutePort;
  media: MediaRoutePort;
  mesh: MeshRoutePort;
  npu: NpuRoutePort;
  onboarding: OnboardingRoutePort;
  obsidian: ObsidianRoutePort;
  orchestration: OrchestrationRoutePort;
  promptPacks: PromptPacksRoutePort;
  realtimeEvents: RealtimeEventsRoutePort;
  runtimeLifecycle: RuntimeLifecycleRoutePort;
  secrets: SecretsRoutePort;
  settings: SettingsRoutePort;
  sessionsList: SessionsListRoutePort;
  skills: SkillsRoutePort;
  tasks: TasksRoutePort;
  tools: ToolsRoutePort;
  toolsInvoke: ToolsInvokeRoutePort;
  voice: VoiceRoutePort;
  workspaces: WorkspacesRoutePort;
}

export function createGatewayRouteServices(deps: GatewayRouteServiceDependencies): GatewayRouteServices {
  return {
    addons: createAddonsRouteService(deps.addons),
    agents: createAgentsRouteService(deps.agents),
    assembly: createAssemblyRouteService(deps.assembly),
    authAdmin: new AuthAdminRouteService(deps.authAdmin),
    approvals: new ApprovalsRouteService(deps.approvals),
    capabilities: new CapabilitiesRouteService(deps.capabilities),
    chatAttachments: createChatAttachmentsRouteService(deps.chatAttachments),
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
    dashboard: createDashboardRouteService(deps.dashboard),
    daemon: createDaemonRouteService(deps.daemon),
    devDiagnostics: createDevDiagnosticsRouteService(deps.devDiagnostics),
    devVerification: new DevVerificationRouteService(deps.devVerification),
    durable: new DurableRouteService(deps.durable),
    files: createFilesRouteService(deps.files),
    gatewayEvents: createGatewayEventsRouteService(deps.gatewayEvents),
    health: createHealthRouteService(deps.health),
    hooks: createHooksRouteService(deps.hooks),
    improvement: new ImprovementRouteService(deps.improvement),
    integrations: createIntegrationRouteService(deps.integrations),
    integrationWebhooks: createIntegrationWebhookRouteService(deps.integrationWebhooks),
    knowledge: createKnowledgeRouteService(deps.knowledge),
    llamaCpp: createLlamaCppRouteService(deps.llamaCpp),
    llm: createLlmRouteService(deps.llm),
    memory: new MemoryRouteService(deps.memory),
    mcp: new McpRouteService(deps.mcp),
    media: createMediaRouteService(deps.media),
    mesh: createMeshRouteService(deps.mesh),
    npu: createNpuRouteService(deps.npu),
    onboarding: createOnboardingRouteService(deps.onboarding),
    obsidian: createObsidianRouteService(deps.obsidian),
    orchestration: new OrchestrationRouteService(deps.orchestration),
    promptPacks: new PromptPacksRouteService(deps.promptPacks),
    realtimeEvents: createRealtimeEventsRouteService(deps.realtimeEvents),
    runtimeLifecycle: new RuntimeLifecycleRouteService(deps.runtimeLifecycle),
    secrets: createSecretsRouteService(deps.secrets),
    settings: createSettingsRouteService(deps.settings),
    sessionsList: createSessionsListRouteService(deps.sessionsList),
    skills: new SkillsRouteService(deps.skills),
    tasks: new TasksRouteService(deps.tasks),
    tools: createToolsRouteService(deps.tools),
    toolsInvoke: createToolsInvokeRouteService(deps.toolsInvoke),
    voice: createVoiceRouteService(deps.voice),
    workspaces: createWorkspacesRouteService(deps.workspaces),
  };
}
