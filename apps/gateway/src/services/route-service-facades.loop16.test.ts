import { describe, expect, it, vi } from "vitest";
import { DurableRouteService } from "./durable-route-service.js";
import { McpRouteService } from "./mcp-route-service.js";
import {
  createChatThreadKnowledgeDependenciesForGateway,
  createSettingsAuthRuntimeDependenciesForGateway,
  createSettingsRuntimeDependenciesForGateway,
  createWorkspacesRoutePortForGateway,
  getLlmConfigForGateway,
  getProviderSecretStatusForGateway,
} from "./gateway-route-composition-shared.js";
import { createWorkspacesRoutePort, createWorkspacesRouteService } from "./workspaces-route-service.js";

function fn<TArgs extends unknown[] = unknown[], TResult = unknown>(impl: (...args: TArgs) => TResult) {
  return vi.fn(impl);
}

describe("gateway route service facades", () => {
  it("forwards durable operator route calls without changing route payloads", async () => {
    const durable = {
      cancelRun: fn((runId: string, actorId: string) => ({ method: "cancelRun", runId, actorId })),
      createRun: fn((input: unknown) => ({ method: "createRun", input })),
      getDiagnostics: fn(() => ({ method: "getDiagnostics" })),
      getRun: fn((runId: string) => ({ method: "getRun", runId })),
      listDeadLetters: fn((limit: number) => [{ method: "listDeadLetters", limit }]),
      listRunCheckpoints: fn((runId: string, limit: number) => [{ method: "listRunCheckpoints", runId, limit }]),
      listRunTimeline: fn((runId: string, limit: number) => [{ method: "listRunTimeline", runId, limit }]),
      listRuns: fn((limit: number) => [{ method: "listRuns", limit }]),
      pauseRun: fn((runId: string, actorId: string) => ({ method: "pauseRun", runId, actorId })),
      recoverDeadLetter: fn((entryId: string, actorId: string, options?: unknown) => ({
        method: "recoverDeadLetter",
        entryId,
        actorId,
        options,
      })),
      resumeRun: fn((runId: string, actorId: string) => ({ method: "resumeRun", runId, actorId })),
      retryRun: fn((runId: string, reason: string | undefined, actorId: string) => ({
        method: "retryRun",
        runId,
        reason,
        actorId,
      })),
      wakeRun: fn((runId: string, input: unknown) => ({ method: "wakeRun", runId, input })),
    };
    const service = new DurableRouteService(durable as never);

    expect(service.getDiagnostics()).toEqual({ method: "getDiagnostics" });
    expect(service.listRuns(5)).toEqual([{ method: "listRuns", limit: 5 }]);
    expect(service.listDeadLetters(2)).toEqual([{ method: "listDeadLetters", limit: 2 }]);
    expect(service.listRunCheckpoints("run-1", 3)).toEqual([
      { method: "listRunCheckpoints", runId: "run-1", limit: 3 },
    ]);
    expect(service.createRun({ kind: "chat" })).toEqual({ method: "createRun", input: { kind: "chat" } });
    expect(service.getRun("run-1")).toEqual({ method: "getRun", runId: "run-1" });
    expect(service.listRunTimeline("run-1", 4)).toEqual([{ method: "listRunTimeline", runId: "run-1", limit: 4 }]);
    expect(service.pauseRun("run-1", "operator")).toEqual({
      method: "pauseRun",
      runId: "run-1",
      actorId: "operator",
    });
    expect(service.resumeRun("run-1", "operator")).toEqual({
      method: "resumeRun",
      runId: "run-1",
      actorId: "operator",
    });
    expect(service.cancelRun("run-1", "operator")).toEqual({
      method: "cancelRun",
      runId: "run-1",
      actorId: "operator",
    });
    expect(service.retryRun("run-1", undefined, "operator")).toEqual({
      method: "retryRun",
      runId: "run-1",
      reason: undefined,
      actorId: "operator",
    });
    expect(service.wakeRun("run-1", { reason: "manual" })).toEqual({
      method: "wakeRun",
      runId: "run-1",
      input: { reason: "manual" },
    });
    expect(service.recoverDeadLetter("dead-1", "operator", { retry: true })).toEqual({
      method: "recoverDeadLetter",
      entryId: "dead-1",
      actorId: "operator",
      options: { retry: true },
    });
  });

  it("forwards MCP route calls through the narrow admin facade", async () => {
    const mcp = {
      completeMcpOAuth: fn(async (serverId: string, code: string, state?: string) => ({ serverId, code, state })),
      connectMcpServer: fn(async (serverId: string) => ({ serverId, status: "connected" })),
      createMcpServer: fn((input: unknown) => ({ serverId: "server-1", input })),
      deleteMcpServer: fn((serverId: string) => ({ serverId, deleted: true })),
      disconnectMcpServer: fn((serverId: string) => ({ serverId, status: "disconnected" })),
      invokeMcpTool: fn(async (input: unknown) => ({ ok: true, input })),
      listMcpServers: fn(() => [{ serverId: "server-1" }]),
      listMcpTemplateDiscovery: fn(() => [{ templateId: "template-1" }]),
      listMcpTemplates: fn(() => [{ serverId: "template-1", installed: false }]),
      listMcpTools: fn((serverId: string) => [{ serverId, toolName: "tool-1" }]),
      runMcpServerHealthCheck: fn((serverId: string) => ({ serverId, status: "ok" })),
      startMcpOAuth: fn((serverId: string) => ({ serverId, authorizationUrl: "https://example.test" })),
      updateMcpServer: fn((serverId: string, input: unknown) => ({ serverId, input })),
      updateMcpServerPolicy: fn((serverId: string, policy: unknown) => ({ serverId, policy })),
    };
    const service = new McpRouteService(mcp as never);

    expect(service.listMcpServers()).toEqual([{ serverId: "server-1" }]);
    expect(service.listMcpTemplates()).toEqual([{ serverId: "template-1", installed: false }]);
    expect(service.listMcpTemplateDiscovery()).toEqual([{ templateId: "template-1" }]);
    expect(service.createMcpServer({ label: "Local" })).toEqual({ serverId: "server-1", input: { label: "Local" } });
    expect(service.updateMcpServer("server-1", { label: "Renamed" })).toEqual({
      serverId: "server-1",
      input: { label: "Renamed" },
    });
    expect(service.deleteMcpServer("server-1")).toEqual({ serverId: "server-1", deleted: true });
    await expect(service.connectMcpServer("server-1")).resolves.toEqual({ serverId: "server-1", status: "connected" });
    expect(service.disconnectMcpServer("server-1")).toEqual({ serverId: "server-1", status: "disconnected" });
    expect(service.startMcpOAuth("server-1")).toEqual({
      serverId: "server-1",
      authorizationUrl: "https://example.test",
    });
    await expect(service.completeMcpOAuth("server-1", "code", "state")).resolves.toEqual({
      serverId: "server-1",
      code: "code",
      state: "state",
    });
    expect(service.listMcpTools("server-1")).toEqual([{ serverId: "server-1", toolName: "tool-1" }]);
    await expect(service.invokeMcpTool({ serverId: "server-1", toolName: "tool-1" } as never)).resolves.toEqual({
      ok: true,
      input: { serverId: "server-1", toolName: "tool-1" },
    });
    expect(service.updateMcpServerPolicy("server-1", { grants: [] })).toEqual({
      serverId: "server-1",
      policy: { grants: [] },
    });
    expect(service.runMcpServerHealthCheck("server-1")).toEqual({ serverId: "server-1", status: "ok" });
  });

  it("reconciles redacted MCP public updates before calling the raw admin port", () => {
    const rawServer = {
      serverId: "server-secret",
      label: "Secret server",
      transport: "stdio",
      command: "node",
      args: ["server.mjs", "--password", "short-pass", "--api-key=short-key", "--port", "3000"],
      url: "https://mcp.example.test/token/path-secret?token=query-secret&mode=safe",
      authType: "none",
      enabled: true,
      status: "disconnected",
      category: "development",
      trustTier: "restricted",
      costTier: "free",
      policy: {
        requireFirstToolApproval: true,
        redactionMode: "strict",
        allowedToolPatterns: ["*"],
        blockedToolPatterns: [],
        notes: "Authorization: Bearer short-policy-secret",
      },
      createdAt: "2026-07-09T12:00:00.000Z",
      updatedAt: "2026-07-09T12:00:00.000Z",
    } as const;
    const updateMcpServer = vi.fn((_serverId: string, input: Record<string, unknown>) => ({
      ...rawServer,
      ...input,
    }));
    const updateMcpServerPolicy = vi.fn((_serverId: string, policy: Record<string, unknown>) => ({
      ...rawServer,
      policy: { ...rawServer.policy, ...policy },
    }));
    const service = new McpRouteService({
      listMcpServers: vi.fn(() => [rawServer]),
      updateMcpServer,
      updateMcpServerPolicy,
    } as never);
    const projected = service.listMcpServers()[0]!;

    service.updateMcpServer(rawServer.serverId, {
      label: "Renamed server",
      args: projected.args?.map((entry) => (entry === "3000" ? "4000" : entry)),
      url: projected.url?.replace("mode=safe", "mode=fast"),
    });

    expect(updateMcpServer).toHaveBeenCalledWith(
      rawServer.serverId,
      expect.objectContaining({
        label: "Renamed server",
        args: ["server.mjs", "--password", "short-pass", "--api-key=short-key", "--port", "4000"],
        url: "https://mcp.example.test/token/path-secret?token=query-secret&mode=fast",
      }),
    );
    expect(rawServer.args[2]).toBe("short-pass");

    service.updateMcpServerPolicy(rawServer.serverId, {
      ...projected.policy,
      redactionMode: "basic",
    });

    expect(updateMcpServerPolicy).toHaveBeenCalledWith(
      rawServer.serverId,
      expect.objectContaining({
        notes: rawServer.policy.notes,
        redactionMode: "basic",
      }),
    );
  });

  it("keeps workspace route mutations explicit and realtime-backed", async () => {
    const published: Array<{ eventType: string; source: string; payload?: Record<string, unknown> }> = [];
    const port = createWorkspacesRoutePort({
      storage: {
        workspaces: {
          archive: fn((workspaceId: string) => ({ workspaceId, name: "Archived", slug: "archived" })),
          create: fn((input: { name: string }) => ({ workspaceId: "workspace-1", name: input.name, slug: "ops" })),
          get: fn((workspaceId: string) => ({ workspaceId, name: "Ops", slug: "ops" })),
          list: fn((view: string, limit: number) => [{ view, limit }]),
          restore: fn((workspaceId: string) => ({ workspaceId, name: "Restored", slug: "restored" })),
          update: fn((workspaceId: string, input: { name?: string }) => ({
            workspaceId,
            name: input.name ?? "Ops",
            slug: "ops",
          })),
        },
      } as never,
      normalizeWorkspaceId: (workspaceId = "default") => `normalized:${workspaceId}`,
      publishRealtime: (eventType, source, payload) => published.push({ eventType, source, payload }),
      listGlobalGuidance: fn(async () => [{ docType: "agents", content: "global" }]),
      listWorkspaceGuidance: fn(async (workspaceId: string) => ({ workspaceId, documents: [] })),
      updateGlobalGuidance: fn(async (docType: never, content: string) => ({ docType, content })),
      updateWorkspaceGuidance: fn(async (workspaceId: string, docType: never, content: string) => ({
        workspaceId,
        docType,
        content,
      })),
    });
    const service = createWorkspacesRouteService(port);

    expect(service.createWorkspace({ name: "Ops" } as never)).toMatchObject({ workspaceId: "workspace-1" });
    expect(service.archiveWorkspace("workspace-1")).toMatchObject({ workspaceId: "normalized:workspace-1" });
    expect(service.restoreWorkspace("workspace-1")).toMatchObject({ workspaceId: "normalized:workspace-1" });
    expect(service.updateWorkspace("workspace-1", { name: "Ops 2" } as never)).toMatchObject({
      workspaceId: "normalized:workspace-1",
      name: "Ops 2",
    });
    expect(service.getWorkspace("workspace-1")).toMatchObject({ workspaceId: "normalized:workspace-1" });
    expect(service.listWorkspaces(undefined, undefined)).toEqual([{ view: "active", limit: 200 }]);
    await expect(service.listGlobalGuidance()).resolves.toEqual([{ docType: "agents", content: "global" }]);
    await expect(service.listWorkspaceGuidance("workspace-1")).resolves.toEqual({
      workspaceId: "workspace-1",
      documents: [],
    });
    await expect(service.updateGlobalGuidance("agents" as never, "updated")).resolves.toEqual({
      docType: "agents",
      content: "updated",
    });
    await expect(service.updateWorkspaceGuidance("workspace-1", "agents" as never, "updated")).resolves.toEqual({
      workspaceId: "workspace-1",
      docType: "agents",
      content: "updated",
    });
    expect(published.map((event) => event.eventType)).toEqual([
      "workspace_created",
      "workspace_archived",
      "workspace_restored",
      "workspace_updated",
    ]);
  });

  it("adapts gateway shared composition helpers to explicit route dependencies", async () => {
    const gateway = {
      config: { rootDir: "F:/code/personal-ai" },
      storage: {
        gatewaySql: { prepare: vi.fn() },
        workspaces: {
          archive: fn((workspaceId: string) => ({ workspaceId })),
          create: fn((input: unknown) => ({ workspaceId: "workspace-1", input })),
          get: fn((workspaceId: string) => ({ workspaceId })),
          list: fn(() => []),
          restore: fn((workspaceId: string) => ({ workspaceId })),
          update: fn((workspaceId: string, input: unknown) => ({ workspaceId, input })),
        },
      },
      llmService: {
        getProviderSecretStatus: fn((providerId: string) => ({
          providerId,
          hasApiKey: true,
          apiKeySource: "keychain",
        })),
        getRuntimeConfig: fn((options: unknown) => ({ activeProviderId: "openai", options })),
      },
      meshService: { status: fn(() => ({ ok: true })) },
      npuSidecar: { status: fn(() => ({ ok: true })) },
      llamaCppRuntime: { status: fn(() => ({ ok: true })) },
      guidanceService: {
        listGlobalGuidance: fn(async () => []),
        listWorkspaceGuidance: fn(async (workspaceId: string) => ({ workspaceId, documents: [] })),
        updateGlobalGuidance: fn(async (docType: string, content: string) => ({ docType, content })),
        updateWorkspaceGuidance: fn(async (workspaceId: string, docType: string, content: string) => ({
          workspaceId,
          docType,
          content,
        })),
      },
      approvalEffectsService: {
        listByApproval: fn((approvalId: string) => [{ approvalId }]),
      },
      improvementService: {
        handleActivationApprovalResolution: fn((approval: unknown) => ({ handled: approval })),
        recordApprovalResolutionSignal: fn((approval: unknown) => ({ recorded: approval })),
      },
      createApproval: fn((input: unknown) => ({ input, approvalId: "approval-1" })),
      resolveApproval: fn((approvalId: string, input: unknown) => ({ approvalId, input })),
      enqueueApprovalResolutionEffects: fn((approval: unknown, input: unknown) => ({ approval, input })),
      buildApprovalRealtimeLinks: fn((approval: unknown) => [{ approval }]),
      publishRealtime: fn((eventType: string, source: string, payload?: unknown, options?: unknown) => ({
        eventType,
        source,
        payload,
        options,
      })),
      normalizeWorkspaceId: fn((workspaceId?: string) => workspaceId?.trim() || "default"),
      readFeatureFlags: fn(() => ({ gateway: true })),
      updateFeatureFlags: fn((patch: unknown) => ({ patch })),
      assertDeploymentProfileUpdate: fn((input: unknown) => ({ input })),
      assertFirecrawlRuntimeUpdate: fn((input: unknown) => ({ input })),
      persistAssistantConfig: fn(() => undefined),
      persistBudgetsConfig: fn(() => undefined),
      persistLlmConfig: fn(() => undefined),
      persistToolPolicyConfig: fn(() => undefined),
      getSession: fn((sessionId: string) => ({ sessionId })),
      invokeAndUnwrap: fn((request: unknown, realtimeType?: string) => ({ request, realtimeType })),
    };

    expect(getLlmConfigForGateway(gateway as never)).toEqual({
      activeProviderId: "openai",
      options: { includeKeychainForActiveProvider: true, useCache: true },
    });
    expect(getProviderSecretStatusForGateway(gateway as never, "openai")).toEqual({
      providerId: "openai",
      hasSecret: true,
      source: "keychain",
    });

    const workspaces = createWorkspacesRoutePortForGateway(gateway as never);
    expect(workspaces.createWorkspace({ name: "Ops" } as never)).toMatchObject({ workspaceId: "workspace-1" });
    expect(workspaces.archiveWorkspace(" workspace-1 ")).toEqual({ workspaceId: "workspace-1" });
    await expect(workspaces.listGlobalGuidance()).resolves.toEqual([]);
    await expect(workspaces.listWorkspaceGuidance("workspace-1")).resolves.toEqual({
      workspaceId: "workspace-1",
      documents: [],
    });
    await expect(workspaces.updateGlobalGuidance("agents" as never, "body")).resolves.toEqual({
      docType: "agents",
      content: "body",
    });
    await expect(workspaces.updateWorkspaceGuidance("workspace-1", "agents" as never, "body")).resolves.toEqual({
      workspaceId: "workspace-1",
      docType: "agents",
      content: "body",
    });

    const runtime = createSettingsRuntimeDependenciesForGateway(gateway as never);
    expect(runtime.readFeatureFlags()).toEqual({ gateway: true });
    expect(runtime.updateFeatureFlags({ gateway: false })).toEqual({ patch: { gateway: false } });
    expect(runtime.assertDeploymentProfileUpdate({ deploymentProfile: "local" })).toEqual({
      input: { deploymentProfile: "local" },
    });
    expect(runtime.assertFirecrawlRuntimeUpdate({ enabled: true })).toEqual({ input: { enabled: true } });
    runtime.persistAssistantConfig();
    runtime.persistBudgetsConfig();
    runtime.persistLlmConfig();
    runtime.persistToolPolicyConfig();
    expect(gateway.persistAssistantConfig).toHaveBeenCalledTimes(1);
    expect(gateway.persistBudgetsConfig).toHaveBeenCalledTimes(1);
    expect(gateway.persistLlmConfig).toHaveBeenCalledTimes(1);
    expect(gateway.persistToolPolicyConfig).toHaveBeenCalledTimes(1);

    const auth = createSettingsAuthRuntimeDependenciesForGateway(gateway as never);
    expect(auth.createApproval({ kind: "runtime" } as never)).toEqual({
      input: { kind: "runtime" },
      approvalId: "approval-1",
    });
    expect(auth.resolveApproval("approval-1", { status: "approved" } as never)).toEqual({
      approvalId: "approval-1",
      input: { status: "approved" },
    });
    expect(auth.enqueueApprovalResolutionEffects({ approvalId: "approval-1" }, { actorId: "operator" })).toEqual({
      approval: { approvalId: "approval-1" },
      input: { actorId: "operator" },
    });
    expect(auth.listApprovalEffects("approval-1")).toEqual([{ approvalId: "approval-1" }]);
    expect(auth.buildApprovalRealtimeLinks({ approvalId: "approval-1" } as never)).toEqual([
      { approval: { approvalId: "approval-1" } },
    ]);
    expect(auth.recordImprovementApprovalResolutionSignal({ approvalId: "approval-1" } as never)).toEqual({
      recorded: { approvalId: "approval-1" },
    });
    expect(auth.handleActivationApprovalResolution({ approvalId: "approval-1" } as never)).toEqual({
      handled: { approvalId: "approval-1" },
    });
    expect(auth.publishRealtime("approval.updated", "settings", { approvalId: "approval-1" })).toEqual({
      eventType: "approval.updated",
      source: "settings",
      payload: { approvalId: "approval-1" },
      options: undefined,
    });

    const knowledge = createChatThreadKnowledgeDependenciesForGateway(gateway as never);
    expect(knowledge.getSession("session-1")).toEqual({ sessionId: "session-1" });
    await expect(knowledge.knowledgeDocsIngest({ docs: [] } as never)).resolves.toMatchObject({
      realtimeType: "knowledge_docs_ingest",
    });
  });
});
