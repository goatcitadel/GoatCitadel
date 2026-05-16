/* eslint-disable max-lines */
import { randomUUID } from "node:crypto";
import type {
  ApprovalEffectRecord,
  ApprovalRequest,
  DevDiagnosticsEvent,
  GoogleMeetPrerequisiteStatusResponse,
  LlmModelRecord,
  LlmRuntimeConfig,
  ApprovalReplayEvent,
  MemoryContextPack,
  McpServerPolicy,
  McpServerTemplateRecord,
  McpTemplateDiscoveryResult,
  NpuModelManifest,
  NpuRuntimeStatus,
  OnboardingBootstrapInput,
  OnboardingBootstrapResult,
  OnboardingState,
  LlmModelPreviewResponse,
  PendingApprovalAction,
  RealtimeEvent,
  SessionMeta,
  SkillImportHistoryRecord,
  SkillImportSourceType,
  SkillImportValidationResult,
  SkillRuntimeState,
  SkillSourceListResponse,
  SkillSourceLookupResponse,
  SkillSourceProvider,
  SkillStateRecord,
  ToolAccessEvaluateResponse,
  ToolCatalogEntry,
  ToolGrantRecord,
  ToolInvokeResult,
} from "@goatcitadel/contracts";

type TuiThinkingLevel = "off" | "minimal" | "standard" | "extended" | "deep";
type TuiSpeedMode = "standard" | "fast";
type TuiSubagentPolicy = "off" | "ask_when_useful" | "auto_when_useful";
import type { TuiResolvedAuth } from "./profile.js";

export interface TuiApiClientOptions {
  baseUrl: string;
  auth: TuiResolvedAuth;
  readOnly: boolean;
}

export interface TuiCostSummaryResponse {
  scope: string;
  from: string;
  to: string;
  items: Array<{
    key: string;
    tokenInput: number;
    tokenOutput: number;
    tokenCachedInput: number;
    tokenTotal: number;
    costUsd: number;
  }>;
}

const MAX_SSE_BUFFER_CHARS = 256_000;
const MAX_SSE_ERROR_PREVIEW_CHARS = 180;

export class TuiApiClient {
  public readonly baseUrl: string;
  public readonly readOnly: boolean;
  private readonly auth: TuiResolvedAuth;

  public constructor(options: TuiApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.auth = options.auth;
    this.readOnly = options.readOnly;
  }

  public async health(): Promise<{ status: string }> {
    return this.request("/health", { method: "GET" });
  }

  public async dashboard(): Promise<{
    timestamp: string;
    sessions: SessionMeta[];
    pendingApprovals: number;
    activeSubagents: number;
    taskStatusCounts: Array<{ status: string; count: number }>;
    recentEvents: RealtimeEvent[];
    dailyCostUsd: number;
  }> {
    return this.request("/api/v1/dashboard/state", { method: "GET" });
  }

  public async devDiagnostics(limit = 8): Promise<{ items: DevDiagnosticsEvent[] }> {
    const query = new URLSearchParams({ limit: String(Math.max(1, Math.min(50, Math.trunc(limit) || 8))) });
    return this.request(`/api/v1/dev/diagnostics?${query.toString()}`, { method: "GET" });
  }

  public async googleMeetPrerequisites(): Promise<GoogleMeetPrerequisiteStatusResponse> {
    return this.request("/api/v1/voice/google-meet/prerequisites", {
      method: "POST",
      body: JSON.stringify({}),
    });
  }

  public async systemVitals(): Promise<{
    hostname: string;
    platform: string;
    release: string;
    uptimeSeconds: number;
    loadAverage: number[];
    cpuCount: number;
    memoryTotalBytes: number;
    memoryFreeBytes: number;
    memoryUsedBytes: number;
    processRssBytes: number;
    processHeapUsedBytes: number;
  }> {
    return this.request("/api/v1/system/vitals", { method: "GET" });
  }

  public async listApprovals(status = "pending"): Promise<{ items: ApprovalRequest[] }> {
    return this.request(`/api/v1/approvals?status=${encodeURIComponent(status)}`, { method: "GET" });
  }

  public async getApprovalReplay(approvalId: string): Promise<{
    approval: ApprovalRequest;
    events: ApprovalReplayEvent[];
    pendingAction?: PendingApprovalAction;
    effects: ApprovalEffectRecord[];
  }> {
    return this.request(`/api/v1/approvals/${encodeURIComponent(approvalId)}/replay`, { method: "GET" });
  }

  public async resolveApproval(
    approvalId: string,
    decision: "approve" | "reject",
  ): Promise<{
    approval: ApprovalRequest;
    executedAction?: ToolInvokeResult;
    effects: ApprovalEffectRecord[];
    replay: {
      approval: ApprovalRequest;
      events: ApprovalReplayEvent[];
      pendingAction?: PendingApprovalAction;
      effects: ApprovalEffectRecord[];
    };
    durableRunId?: string;
  }> {
    return this.request(
      `/api/v1/approvals/${encodeURIComponent(approvalId)}/resolve`,
      {
        method: "POST",
        body: JSON.stringify({
          decision,
          resolvedBy: "tui-operator",
        }),
      },
      true,
    );
  }

  public async listSessions(limit = 50): Promise<{ items: SessionMeta[]; nextCursor?: string }> {
    return this.request(`/api/v1/sessions?limit=${limit}`, { method: "GET" });
  }

  public async listChatSessions(input?: {
    limit?: number;
    workspaceId?: string;
    projectId?: string;
    scope?: "mission" | "external" | "all";
    view?: "active" | "archived" | "all";
    q?: string;
  }): Promise<{ items: Array<Record<string, unknown>>; nextCursor?: string }> {
    const query = new URLSearchParams();
    query.set("limit", String(input?.limit ?? 80));
    if (input?.workspaceId) {
      query.set("workspaceId", input.workspaceId);
    }
    if (input?.projectId) {
      query.set("projectId", input.projectId);
    }
    if (input?.scope) {
      query.set("scope", input.scope);
    }
    if (input?.view) {
      query.set("view", input.view);
    }
    if (input?.q) {
      query.set("q", input.q);
    }
    return this.request(`/api/v1/chat/sessions?${query.toString()}`, { method: "GET" });
  }

  public async createChatSession(input: {
    workspaceId?: string;
    title?: string;
    projectId?: string;
  }): Promise<Record<string, unknown>> {
    return this.request(
      "/api/v1/chat/sessions",
      {
        method: "POST",
        body: JSON.stringify(input),
      },
      true,
    );
  }

  public async listChatMessages(
    sessionId: string,
    limit = 120,
    cursor?: string,
  ): Promise<{ items: Array<Record<string, unknown>>; nextCursor?: string }> {
    const query = new URLSearchParams();
    query.set("limit", String(limit));
    if (cursor) {
      query.set("cursor", cursor);
    }
    return this.request(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/messages?${query.toString()}`, {
      method: "GET",
    });
  }

  public async sendChatMessage(
    sessionId: string,
    input: {
      content: string;
      providerId?: string;
      model?: string;
      mode?: "chat" | "cowork" | "code";
      webMode?: "auto" | "off" | "quick" | "deep";
      memoryMode?: "auto" | "on" | "off";
      thinkingLevel?: TuiThinkingLevel;
      speedMode?: TuiSpeedMode;
      subagentPolicy?: TuiSubagentPolicy;
    },
  ): Promise<Record<string, unknown>> {
    return this.request(
      `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/agent-send`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
      true,
    );
  }

  public async *streamChatMessage(
    sessionId: string,
    input: {
      content: string;
      providerId?: string;
      model?: string;
      mode?: "chat" | "cowork" | "code";
      webMode?: "auto" | "off" | "quick" | "deep";
      memoryMode?: "auto" | "on" | "off";
      thinkingLevel?: TuiThinkingLevel;
      speedMode?: TuiSpeedMode;
      subagentPolicy?: TuiSubagentPolicy;
      agentMode?: boolean;
    },
  ): AsyncGenerator<Record<string, unknown>> {
    const route = `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/agent-send/stream`;
    const body = { ...input };
    delete (body as { agentMode?: boolean }).agentMode;
    for await (const event of this.requestStream(
      route,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
      true,
    )) {
      yield event;
    }
  }

  public async getChatPrefs(sessionId: string): Promise<Record<string, unknown>> {
    return this.request(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/prefs`, { method: "GET" });
  }

  public async patchChatPrefs(sessionId: string, patch: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request(
      `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/prefs`,
      {
        method: "PATCH",
        body: JSON.stringify(patch),
      },
      true,
    );
  }

  public async listCosts(scope: "day" | "session" | "agent" | "task"): Promise<TuiCostSummaryResponse> {
    return this.request(`/api/v1/costs/summary?scope=${scope}`, { method: "GET" });
  }

  public async runCheaper(): Promise<{ mode: string; actions: string[] }> {
    return this.request(
      "/api/v1/costs/run-cheaper",
      {
        method: "POST",
        body: JSON.stringify({}),
      },
      true,
    );
  }

  public async listTasks(status?: string): Promise<{ items: Array<Record<string, unknown>>; nextCursor?: string }> {
    const query = status ? `?status=${encodeURIComponent(status)}&limit=100` : "?limit=100";
    return this.request(`/api/v1/tasks${query}`, { method: "GET" });
  }

  public async createTask(input: {
    title: string;
    description?: string;
    priority?: "low" | "normal" | "high" | "urgent";
  }): Promise<Record<string, unknown>> {
    return this.request(
      "/api/v1/tasks",
      {
        method: "POST",
        body: JSON.stringify(input),
      },
      true,
    );
  }

  public async updateTask(taskId: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request(
      `/api/v1/tasks/${encodeURIComponent(taskId)}`,
      {
        method: "PATCH",
        body: JSON.stringify(input),
      },
      true,
    );
  }

  public async listTaskActivities(taskId: string): Promise<{ items: Array<Record<string, unknown>> }> {
    return this.request(`/api/v1/tasks/${encodeURIComponent(taskId)}/activities`, { method: "GET" });
  }

  public async appendTaskActivity(taskId: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request(
      `/api/v1/tasks/${encodeURIComponent(taskId)}/activities`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
      true,
    );
  }

  public async listSkills(): Promise<{ items: Array<Record<string, unknown>> }> {
    return this.request("/api/v1/skills", { method: "GET" });
  }

  public async reloadSkills(): Promise<{ items: Array<Record<string, unknown>> }> {
    return this.request(
      "/api/v1/skills/reload",
      {
        method: "POST",
        body: JSON.stringify({}),
      },
      true,
    );
  }

  public async resolveSkills(text: string, explicitSkills?: string[]): Promise<Record<string, unknown>> {
    return this.request("/api/v1/skills/resolve-activation", {
      method: "POST",
      body: JSON.stringify({
        text,
        explicitSkills: explicitSkills && explicitSkills.length > 0 ? explicitSkills : undefined,
      }),
    });
  }

  public async getCuratorStatus(): Promise<Record<string, unknown>> {
    return this.request("/api/v1/curator/status", { method: "GET" });
  }

  public async archiveCuratorSkill(
    skillId: string,
    reason?: string,
    actorId?: string,
  ): Promise<Record<string, unknown>> {
    return this.request(
      "/api/v1/curator/archive",
      {
        method: "POST",
        body: JSON.stringify({ skillId, reason, confirm: true, actorId }),
      },
      true,
    );
  }

  public async pruneCuratorSkill(skillId: string, actorId?: string): Promise<Record<string, unknown>> {
    return this.request(
      "/api/v1/curator/prune",
      {
        method: "POST",
        body: JSON.stringify({ skillId, confirm: true, actorId }),
      },
      true,
    );
  }

  public async listCuratorArchived(): Promise<Record<string, unknown>> {
    return this.request("/api/v1/curator/archived", { method: "GET" });
  }

  public async runCurator(
    options: { sync?: boolean; dryRun?: true; actorId?: string } = {},
  ): Promise<Record<string, unknown>> {
    return this.request(
      "/api/v1/curator/run",
      {
        method: "POST",
        body: JSON.stringify(options),
      },
      true,
    );
  }

  public async listSkillSources(query?: string, limit = 25): Promise<SkillSourceListResponse> {
    const params = new URLSearchParams();
    if (query?.trim()) {
      params.set("q", query.trim());
    }
    params.set("limit", String(Math.max(1, Math.min(limit, 100))));
    return this.request(`/api/v1/skills/sources?${params.toString()}`, { method: "GET" });
  }

  public async lookupSkillSources(query: string, limit = 10): Promise<SkillSourceLookupResponse> {
    const params = new URLSearchParams();
    params.set("q", query.trim());
    params.set("limit", String(Math.max(1, Math.min(limit, 100))));
    return this.request(`/api/v1/skills/lookup?${params.toString()}`, { method: "GET" });
  }

  public async installSkillImport(input: {
    sourceRef: string;
    sourceType?: SkillImportSourceType;
    sourceProvider?: SkillSourceProvider;
    force?: boolean;
    confirmHighRisk?: boolean;
  }): Promise<{
    validation: SkillImportValidationResult;
    installedPath: string;
    sourceManifestPath: string;
    installedSkillId?: string;
  }> {
    return this.request(
      "/api/v1/skills/import/install",
      {
        method: "POST",
        body: JSON.stringify(input),
      },
      true,
    );
  }

  public async fetchSkillImportHistory(limit = 100): Promise<{ items: SkillImportHistoryRecord[] }> {
    const bounded = Math.max(1, Math.min(limit, 300));
    return this.request(`/api/v1/skills/import/history?limit=${bounded}`, { method: "GET" });
  }

  public async updateSkillState(
    skillId: string,
    input: { state: SkillRuntimeState; note?: string },
  ): Promise<SkillStateRecord> {
    return this.request(
      "/api/v1/skills/by-id/state",
      {
        method: "PATCH",
        body: JSON.stringify({ ...input, skillId }),
      },
      true,
    );
  }

  public async integrationCatalog(kind?: string): Promise<{ items: Array<Record<string, unknown>> }> {
    const query = kind ? `?kind=${encodeURIComponent(kind)}` : "";
    return this.request(`/api/v1/integrations/catalog${query}`, { method: "GET" });
  }

  public async integrationConnections(kind?: string): Promise<{ items: Array<Record<string, unknown>> }> {
    const query = kind ? `?kind=${encodeURIComponent(kind)}` : "";
    return this.request(`/api/v1/integrations/connections${query}`, { method: "GET" });
  }

  public async createIntegrationConnection(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request(
      "/api/v1/integrations/connections",
      {
        method: "POST",
        body: JSON.stringify(input),
      },
      true,
    );
  }

  public async updateIntegrationConnection(
    connectionId: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request(
      `/api/v1/integrations/connections/${encodeURIComponent(connectionId)}`,
      {
        method: "PATCH",
        body: JSON.stringify(input),
      },
      true,
    );
  }

  public async deleteIntegrationConnection(connectionId: string): Promise<{ deleted: boolean }> {
    return this.request(
      `/api/v1/integrations/connections/${encodeURIComponent(connectionId)}`,
      {
        method: "DELETE",
        body: JSON.stringify({}),
      },
      true,
    );
  }

  public async meshStatus(): Promise<Record<string, unknown>> {
    return this.request("/api/v1/mesh/status", { method: "GET" });
  }

  public async meshNodes(): Promise<{ items: Array<Record<string, unknown>> }> {
    return this.request("/api/v1/mesh/nodes?limit=100", { method: "GET" });
  }

  public async meshLeases(): Promise<{ items: Array<Record<string, unknown>> }> {
    return this.request("/api/v1/mesh/leases?limit=100", { method: "GET" });
  }

  public async meshOwners(): Promise<{ items: Array<Record<string, unknown>> }> {
    return this.request("/api/v1/mesh/sessions/owners?limit=200", { method: "GET" });
  }

  public async meshReplicationOffsets(): Promise<{ items: Array<Record<string, unknown>> }> {
    return this.request("/api/v1/mesh/replication/offsets?limit=200", { method: "GET" });
  }

  public async meshAcquireLease(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request(
      "/api/v1/mesh/leases/acquire",
      {
        method: "POST",
        body: JSON.stringify(input),
      },
      true,
    );
  }

  public async meshRenewLease(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request(
      "/api/v1/mesh/leases/renew",
      {
        method: "POST",
        body: JSON.stringify(input),
      },
      true,
    );
  }

  public async meshReleaseLease(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request(
      "/api/v1/mesh/leases/release",
      {
        method: "POST",
        body: JSON.stringify(input),
      },
      true,
    );
  }

  public async meshClaimSession(sessionId: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request(
      `/api/v1/mesh/sessions/${encodeURIComponent(sessionId)}/claim`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
      true,
    );
  }

  public async npuStatus(): Promise<NpuRuntimeStatus> {
    return this.request("/api/v1/npu/status", { method: "GET" });
  }

  public async npuModels(): Promise<{ items: NpuModelManifest[] }> {
    return this.request("/api/v1/npu/models", { method: "GET" });
  }

  public async npuStart(): Promise<NpuRuntimeStatus> {
    return this.request(
      "/api/v1/npu/start",
      {
        method: "POST",
        body: JSON.stringify({}),
      },
      true,
    );
  }

  public async npuStop(): Promise<NpuRuntimeStatus> {
    return this.request(
      "/api/v1/npu/stop",
      {
        method: "POST",
        body: JSON.stringify({}),
      },
      true,
    );
  }

  public async npuRefresh(): Promise<NpuRuntimeStatus> {
    return this.request(
      "/api/v1/npu/refresh",
      {
        method: "POST",
        body: JSON.stringify({}),
      },
      true,
    );
  }

  public async onboardingState(): Promise<OnboardingState> {
    return this.request("/api/v1/onboarding/state", { method: "GET" });
  }

  public async onboardingBootstrap(input: OnboardingBootstrapInput): Promise<OnboardingBootstrapResult> {
    return this.request(
      "/api/v1/onboarding/bootstrap",
      {
        method: "POST",
        body: JSON.stringify(input),
      },
      true,
    );
  }

  public async onboardingComplete(completedBy: string): Promise<{ state: OnboardingState }> {
    return this.request(
      "/api/v1/onboarding/complete",
      {
        method: "POST",
        body: JSON.stringify({ completedBy }),
      },
      true,
    );
  }

  public async fetchLlmConfig(): Promise<LlmRuntimeConfig> {
    return this.request("/api/v1/llm/config", { method: "GET" });
  }

  public async listLlmModels(providerId?: string): Promise<{ items: LlmModelRecord[] }> {
    const query = providerId ? `?providerId=${encodeURIComponent(providerId)}` : "";
    return this.request(`/api/v1/llm/models${query}`, { method: "GET" });
  }

  public async fetchLlmModels(providerId?: string): Promise<LlmModelPreviewResponse> {
    const query = providerId ? `?providerId=${encodeURIComponent(providerId)}` : "";
    return this.request(`/api/v1/llm/models${query}`, { method: "GET" });
  }

  public async previewLlmModels(input: {
    providerId: string;
    baseUrl: string;
    apiKey?: string;
    apiKeyEnv?: string;
    request?: {
      headers?: Record<string, string>;
      auth?: Record<string, unknown>;
      proxy?: Record<string, unknown>;
      tls?: Record<string, unknown>;
    };
    headers?: Record<string, string>;
  }): Promise<LlmModelPreviewResponse> {
    return this.request(
      "/api/v1/llm/models/preview",
      {
        method: "POST",
        body: JSON.stringify(input),
      },
      true,
    );
  }

  public async runtimeSettings(): Promise<Record<string, unknown>> {
    return this.request("/api/v1/settings", { method: "GET" });
  }

  public async patchRuntimeSettings(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request(
      "/api/v1/settings",
      {
        method: "PATCH",
        body: JSON.stringify(input),
      },
      true,
    );
  }

  public async fetchMcpTemplates(): Promise<{ items: Array<McpServerTemplateRecord & { installed: boolean }> }> {
    return this.request("/api/v1/mcp/templates", { method: "GET" });
  }

  public async fetchMcpTemplateDiscovery(): Promise<{ items: McpTemplateDiscoveryResult[] }> {
    return this.request("/api/v1/mcp/templates/discovery", { method: "GET" });
  }

  public async createMcpServer(input: {
    label: string;
    transport: "stdio" | "http" | "sse";
    command?: string;
    args?: string[];
    url?: string;
    authType?: "none" | "token" | "oauth2";
    enabled?: boolean;
    category?: string;
    trustTier?: "trusted" | "restricted" | "quarantined";
    costTier?: "free" | "mixed" | "paid" | "unknown";
    policy?: Partial<McpServerPolicy>;
    verifiedAt?: string;
  }): Promise<Record<string, unknown>> {
    return this.request(
      "/api/v1/mcp/servers",
      {
        method: "POST",
        body: JSON.stringify(input),
      },
      true,
    );
  }

  public async listEvents(limit = 100): Promise<{ items: RealtimeEvent[]; nextCursor?: string }> {
    return this.request(`/api/v1/events?limit=${limit}`, { method: "GET" });
  }

  public async listMemoryQmdStats(): Promise<{
    from: string;
    to: string;
    totalRuns: number;
    generatedRuns: number;
    cacheHitRuns: number;
    fallbackRuns: number;
    failedRuns: number;
    originalTokenEstimate: number;
    distilledTokenEstimate: number;
    savingsPercent: number;
    recent: MemoryContextPack[];
  }> {
    return this.request("/api/v1/memory/qmd/stats?limit=25", { method: "GET" });
  }

  public async listMemoryItems(input?: {
    namespace?: string;
    status?: "active" | "forgotten" | "all";
    query?: string;
    limit?: number;
  }): Promise<{ items: Array<Record<string, unknown>> }> {
    const query = new URLSearchParams();
    query.set("limit", String(input?.limit ?? 120));
    if (input?.namespace) {
      query.set("namespace", input.namespace);
    }
    if (input?.status) {
      query.set("status", input.status);
    }
    if (input?.query) {
      query.set("query", input.query);
    }
    return this.request(`/api/v1/memory/items?${query.toString()}`, { method: "GET" });
  }

  public async patchMemoryItem(itemId: string, patch: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request(
      `/api/v1/memory/items/${encodeURIComponent(itemId)}`,
      {
        method: "PATCH",
        body: JSON.stringify(patch),
      },
      true,
    );
  }

  public async forgetMemoryItem(itemId: string): Promise<Record<string, unknown>> {
    return this.request(
      `/api/v1/memory/items/${encodeURIComponent(itemId)}/forget`,
      {
        method: "POST",
        body: JSON.stringify({}),
      },
      true,
    );
  }

  public async listMemoryItemHistory(itemId: string, limit = 40): Promise<{ items: Array<Record<string, unknown>> }> {
    return this.request(`/api/v1/memory/items/${encodeURIComponent(itemId)}/history?limit=${limit}`, {
      method: "GET",
    });
  }

  public async forgetMemory(input: {
    itemIds?: string[];
    namespace?: string;
    query?: string;
  }): Promise<Record<string, unknown>> {
    return this.request(
      "/api/v1/memory/forget",
      {
        method: "POST",
        body: JSON.stringify(input),
      },
      true,
    );
  }

  public async listFiles(input?: { dir?: string; limit?: number }): Promise<{ items: Array<Record<string, unknown>> }> {
    const query = new URLSearchParams();
    query.set("dir", input?.dir ?? ".");
    query.set("limit", String(input?.limit ?? 250));
    return this.request(`/api/v1/files/list?${query.toString()}`, { method: "GET" });
  }

  public async downloadFile(relativePath: string): Promise<Record<string, unknown>> {
    const query = new URLSearchParams();
    query.set("relativePath", relativePath);
    return this.request(`/api/v1/files/download?${query.toString()}`, { method: "GET" });
  }

  public async uploadFile(relativePath: string, content: string): Promise<Record<string, unknown>> {
    return this.request(
      "/api/v1/files/upload",
      {
        method: "POST",
        body: JSON.stringify({ relativePath, content }),
      },
      true,
    );
  }

  public async listCronJobs(): Promise<{ items: Array<Record<string, unknown>> }> {
    return this.request("/api/v1/cron/jobs", { method: "GET" });
  }

  public async startCronJob(jobId: string): Promise<Record<string, unknown>> {
    return this.request(
      `/api/v1/cron/jobs/${encodeURIComponent(jobId)}/start`,
      {
        method: "POST",
        body: JSON.stringify({}),
      },
      true,
    );
  }

  public async pauseCronJob(jobId: string): Promise<Record<string, unknown>> {
    return this.request(
      `/api/v1/cron/jobs/${encodeURIComponent(jobId)}/pause`,
      {
        method: "POST",
        body: JSON.stringify({}),
      },
      true,
    );
  }

  public async runCronJob(jobId: string): Promise<Record<string, unknown>> {
    return this.request(
      `/api/v1/cron/jobs/${encodeURIComponent(jobId)}/run`,
      {
        method: "POST",
        body: JSON.stringify({}),
      },
      true,
    );
  }

  public async deleteCronJob(jobId: string): Promise<Record<string, unknown>> {
    return this.request(
      `/api/v1/cron/jobs/${encodeURIComponent(jobId)}`,
      {
        method: "DELETE",
        body: JSON.stringify({}),
      },
      true,
    );
  }

  public async listCronReviewQueue(limit = 120): Promise<{ items: Array<Record<string, unknown>> }> {
    return this.request(`/api/v1/cron/review-queue?limit=${limit}`, { method: "GET" });
  }

  public async retryCronReviewItem(itemId: string): Promise<Record<string, unknown>> {
    return this.request(
      `/api/v1/cron/review-queue/${encodeURIComponent(itemId)}/retry`,
      {
        method: "POST",
        body: JSON.stringify({}),
      },
      true,
    );
  }

  public async getCronRunDiff(runId: string): Promise<Record<string, unknown>> {
    return this.request(`/api/v1/cron/runs/${encodeURIComponent(runId)}/diff`, { method: "GET" });
  }

  public async listPromptPacks(limit = 50): Promise<{ items: Array<Record<string, unknown>> }> {
    return this.request(`/api/v1/prompt-packs?limit=${limit}`, { method: "GET" });
  }

  public async listPromptPackTests(packId: string, limit = 200): Promise<{ items: Array<Record<string, unknown>> }> {
    return this.request(`/api/v1/prompt-packs/${encodeURIComponent(packId)}/tests?limit=${limit}`, {
      method: "GET",
    });
  }

  public async runPromptPackTest(
    packId: string,
    testId: string,
    input?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request(
      `/api/v1/prompt-packs/${encodeURIComponent(packId)}/tests/${encodeURIComponent(testId)}/run`,
      {
        method: "POST",
        body: JSON.stringify(input ?? {}),
      },
      true,
    );
  }

  public async runPromptPackBenchmark(
    packId: string,
    input?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request(
      `/api/v1/prompt-packs/${encodeURIComponent(packId)}/benchmark/run`,
      {
        method: "POST",
        body: JSON.stringify(input ?? {}),
      },
      true,
    );
  }

  public async getPromptPackBenchmark(benchmarkRunId: string): Promise<Record<string, unknown>> {
    return this.request(`/api/v1/prompt-packs/benchmark/${encodeURIComponent(benchmarkRunId)}`, {
      method: "GET",
    });
  }

  public async getPromptPackReport(packId: string): Promise<Record<string, unknown>> {
    return this.request(`/api/v1/prompt-packs/${encodeURIComponent(packId)}/report`, { method: "GET" });
  }

  public async runPromptPackReplayRegression(
    packId: string,
    input?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request(
      `/api/v1/prompt-packs/${encodeURIComponent(packId)}/replay-regression/run`,
      {
        method: "POST",
        body: JSON.stringify(input ?? {}),
      },
      true,
    );
  }

  public async getPromptPackReplayRegression(runId: string): Promise<Record<string, unknown>> {
    return this.request(`/api/v1/prompt-packs/replay-regression/${encodeURIComponent(runId)}`, {
      method: "GET",
    });
  }

  public async getPromptPackTrends(packId: string): Promise<Record<string, unknown>> {
    return this.request(`/api/v1/prompt-packs/${encodeURIComponent(packId)}/trends`, { method: "GET" });
  }

  public async listImprovementReports(limit = 24): Promise<{ items: Array<Record<string, unknown>> }> {
    return this.request(`/api/v1/improvement/reports?limit=${limit}`, { method: "GET" });
  }

  public async getImprovementReport(reportId: string): Promise<Record<string, unknown>> {
    return this.request(`/api/v1/improvement/reports/${encodeURIComponent(reportId)}`, { method: "GET" });
  }

  public async runImprovementReplay(input?: { sampleSize?: number }): Promise<Record<string, unknown>> {
    return this.request(
      "/api/v1/improvement/replay/run",
      {
        method: "POST",
        body: JSON.stringify(input ?? {}),
      },
      true,
    );
  }

  public async listImprovementReplayRuns(limit = 40): Promise<{ items: Array<Record<string, unknown>> }> {
    return this.request(`/api/v1/improvement/replay/runs?limit=${limit}`, { method: "GET" });
  }

  public async getImprovementReplayRun(runId: string): Promise<Record<string, unknown>> {
    return this.request(`/api/v1/improvement/replay/runs/${encodeURIComponent(runId)}`, { method: "GET" });
  }

  public async createReplayDraft(
    runId: string,
    overrides: Array<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    return this.request(
      `/api/v1/replay/runs/${encodeURIComponent(runId)}/draft`,
      {
        method: "POST",
        body: JSON.stringify({ overrides }),
      },
      true,
    );
  }

  public async executeReplayOverride(
    runId: string,
    overrides: Array<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    return this.request(
      `/api/v1/replay/runs/${encodeURIComponent(runId)}/execute`,
      {
        method: "POST",
        body: JSON.stringify({ overrides }),
      },
      true,
    );
  }

  public async getReplayDiff(replayRunId: string): Promise<Record<string, unknown>> {
    return this.request(`/api/v1/replay/${encodeURIComponent(replayRunId)}/diff`, { method: "GET" });
  }

  public async toolsCatalog(): Promise<{ items: ToolCatalogEntry[] }> {
    return this.request("/api/v1/tools/catalog", { method: "GET" });
  }

  public async toolsEvaluateAccess(input: {
    toolName: string;
    agentId: string;
    sessionId: string;
    taskId?: string;
    args?: Record<string, unknown>;
  }): Promise<ToolAccessEvaluateResponse> {
    return this.request(
      "/api/v1/tools/access/evaluate",
      {
        method: "POST",
        body: JSON.stringify(input),
      },
      true,
    );
  }

  public async toolsListGrants(input?: {
    scope?: "global" | "session" | "agent" | "task";
    scopeRef?: string;
    limit?: number;
  }): Promise<{ items: ToolGrantRecord[] }> {
    const query = new URLSearchParams();
    if (input?.scope) {
      query.set("scope", input.scope);
    }
    if (input?.scopeRef) {
      query.set("scopeRef", input.scopeRef);
    }
    query.set("limit", String(input?.limit ?? 300));
    return this.request(`/api/v1/tools/grants?${query.toString()}`, { method: "GET" });
  }

  public async toolsCreateGrant(input: {
    toolPattern: string;
    decision: "allow" | "deny";
    scope: "global" | "session" | "agent" | "task";
    scopeRef?: string;
    grantType?: "one_time" | "ttl" | "persistent";
    constraints?: Record<string, unknown>;
    createdBy: string;
    expiresAt?: string;
    usesRemaining?: number;
  }): Promise<ToolGrantRecord> {
    return this.request(
      "/api/v1/tools/grants",
      {
        method: "POST",
        body: JSON.stringify(input),
      },
      true,
    );
  }

  public async toolsRevokeGrant(grantId: string): Promise<{ revoked: boolean; grantId: string }> {
    return this.request(
      `/api/v1/tools/grants/${encodeURIComponent(grantId)}/revoke`,
      {
        method: "POST",
        body: JSON.stringify({}),
      },
      true,
    );
  }

  public async toolsInvoke(input: {
    toolName: string;
    args: Record<string, unknown>;
    agentId: string;
    sessionId: string;
    taskId?: string;
    dryRun?: boolean;
    consentContext?: {
      operatorId?: string;
      source?: "ui" | "tui" | "agent";
      reason?: string;
    };
  }): Promise<ToolInvokeResult> {
    return this.request(
      "/api/v1/tools/invoke",
      {
        method: "POST",
        body: JSON.stringify(input),
      },
      true,
    );
  }

  public streamHeaders(): Record<string, string> {
    if (this.auth.mode === "token" && this.auth.token) {
      return { Authorization: `Bearer ${this.auth.token}` };
    }
    if (this.auth.mode === "basic" && this.auth.username && this.auth.password) {
      return {
        Authorization: `Basic ${Buffer.from(`${this.auth.username}:${this.auth.password}`).toString("base64")}`,
      };
    }
    return {};
  }

  private async *requestStream(
    routePath: string,
    init: RequestInit,
    mutating = false,
  ): AsyncGenerator<Record<string, unknown>> {
    if (mutating && this.readOnly) {
      throw new Error("Read-only mode is enabled for this TUI session");
    }

    const headers = new Headers(init.headers ?? {});
    headers.set("Content-Type", "application/json");
    if (mutating) {
      headers.set("Idempotency-Key", randomUUID());
    }
    if (this.auth.mode === "token" && this.auth.token) {
      headers.set("Authorization", `Bearer ${this.auth.token}`);
    } else if (this.auth.mode === "basic" && this.auth.username && this.auth.password) {
      headers.set(
        "Authorization",
        `Basic ${Buffer.from(`${this.auth.username}:${this.auth.password}`).toString("base64")}`,
      );
    }

    const response = await fetch(`${this.baseUrl}${routePath}`, {
      ...init,
      headers,
    });
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      throw new Error(`${init.method ?? "GET"} ${routePath} failed (${response.status}): ${text}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > MAX_SSE_BUFFER_CHARS) {
          throw new Error("Streaming response exceeded the SSE buffer limit before a complete event was received.");
        }
        let split = buffer.indexOf("\n\n");
        while (split >= 0) {
          const block = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const parsed = parseSseDataRecord(block);
          if (parsed) {
            yield parsed;
          }
          split = buffer.indexOf("\n\n");
        }
      }
    } finally {
      reader.releaseLock();
    }
    if (buffer.trim()) {
      throw new Error(`Streaming response ended before a complete SSE event was received: ${previewSseText(buffer)}`);
    }
  }

  private async request<T>(routePath: string, init: RequestInit, mutating = false): Promise<T> {
    if (mutating && this.readOnly) {
      throw new Error("Read-only mode is enabled for this TUI session");
    }

    const headers = new Headers(init.headers ?? {});
    headers.set("Content-Type", "application/json");

    if (mutating) {
      headers.set("Idempotency-Key", randomUUID());
    }

    if (this.auth.mode === "token" && this.auth.token) {
      headers.set("Authorization", `Bearer ${this.auth.token}`);
    } else if (this.auth.mode === "basic" && this.auth.username && this.auth.password) {
      headers.set(
        "Authorization",
        `Basic ${Buffer.from(`${this.auth.username}:${this.auth.password}`).toString("base64")}`,
      );
    }

    const response = await fetch(`${this.baseUrl}${routePath}`, {
      ...init,
      headers,
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`${init.method ?? "GET"} ${routePath} failed (${response.status}): ${body}`);
    }
    if (response.status === 204) {
      return {} as T;
    }
    return (await response.json()) as T;
  }
}

function parseSseDataRecord(block: string): Record<string, unknown> | undefined {
  const trimmed = block.trim();
  if (!trimmed || trimmed.startsWith(":")) {
    return undefined;
  }
  const dataLines = trimmed
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());
  if (dataLines.length === 0) {
    return undefined;
  }
  const payload = dataLines.join("\n").trim();
  if (!payload) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    return parsed;
  } catch {
    throw new Error(`Malformed SSE event payload: ${previewSseText(payload)}`);
  }
}

function previewSseText(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "(empty)";
  }
  if (trimmed.length <= MAX_SSE_ERROR_PREVIEW_CHARS) {
    return trimmed;
  }
  return `${trimmed.slice(0, MAX_SSE_ERROR_PREVIEW_CHARS)}...`;
}
