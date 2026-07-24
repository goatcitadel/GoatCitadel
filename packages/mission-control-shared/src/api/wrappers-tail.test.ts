import { beforeEach, describe, expect, it, vi } from "vitest";

import * as approvals from "./approvals";
import * as diagnostics from "./diagnostics";
import * as mcp from "./mcp";
import * as operatorsAgentsFiles from "./operators-agents-files";
import * as settings from "./settings";
import * as skills from "./skills";
import * as system from "./system";
import * as voice from "./voice";

const apiMocks = vi.hoisted(() => ({
  request: vi.fn(),
  buildGatewayUrl: vi.fn((path: string) => `http://localhost:8787${path}`),
  clearGatewayAuthState: vi.fn(),
  readStoredGatewayAuthState: vi.fn(),
  issueSseBridgeToken: vi.fn(),
  isSseBridgeNotNeededError: vi.fn(),
  isApiRequestError: vi.fn(),
  recordClientDiagnostic: vi.fn(),
  setDevDiagnosticsGatewayReachable: vi.fn(),
}));

vi.mock("./client-core.js", () => ({
  request: apiMocks.request,
  buildGatewayUrl: apiMocks.buildGatewayUrl,
  clearGatewayAuthState: apiMocks.clearGatewayAuthState,
  readStoredGatewayAuthState: apiMocks.readStoredGatewayAuthState,
}));

vi.mock("./sse-bridge.js", () => ({
  computeReconnectDelay: () => 1,
  issueSseBridgeToken: apiMocks.issueSseBridgeToken,
  isSseBridgeNotNeededError: apiMocks.isSseBridgeNotNeededError,
}));

vi.mock("./http-internal", () => ({
  isApiRequestError: apiMocks.isApiRequestError,
}));

vi.mock("../state/dev-diagnostics-store", () => ({
  recordClientDiagnostic: apiMocks.recordClientDiagnostic,
  setDevDiagnosticsGatewayReachable: apiMocks.setDevDiagnosticsGatewayReachable,
}));

async function expectCall(operation: Promise<unknown>, path: string, init?: Partial<RequestInit>) {
  await operation;
  const [actualPath, actualInit] = apiMocks.request.mock.calls.at(-1) ?? [];
  expect(actualPath).toBe(path);
  if (init) {
    expect(actualInit).toMatchObject(init);
  }
}

describe("shared API wrapper tail coverage", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    apiMocks.request.mockReset();
    apiMocks.request.mockResolvedValue({ ok: true });
    apiMocks.buildGatewayUrl.mockClear();
    apiMocks.clearGatewayAuthState.mockClear();
    apiMocks.readStoredGatewayAuthState.mockReset();
    apiMocks.issueSseBridgeToken.mockReset();
    apiMocks.issueSseBridgeToken.mockResolvedValue({ token: "bridge-token", scope: "dev:diagnostics:stream" });
    apiMocks.isSseBridgeNotNeededError.mockReset();
    apiMocks.isSseBridgeNotNeededError.mockReturnValue(false);
    apiMocks.isApiRequestError.mockReset();
    apiMocks.isApiRequestError.mockReturnValue(false);
    apiMocks.recordClientDiagnostic.mockClear();
    apiMocks.setDevDiagnosticsGatewayReachable.mockClear();
  });

  it("routes skills, approvals, MCP, operators, files, settings, system, and voice calls", async () => {
    await expectCall(skills.fetchSkills(), "/api/v1/skills");
    await expectCall(skills.reloadSkills(), "/api/v1/skills/reload", { method: "POST" });
    await expectCall(skills.fetchSkillSources({ q: " code ", limit: 500 }), "/api/v1/skills/sources?q=code&limit=100");
    await expectCall(skills.fetchSkillSources(), "/api/v1/skills/sources");
    await expectCall(skills.fetchSkillLookup({ q: " qa ", limit: 0 }), "/api/v1/skills/lookup?q=qa");
    await expectCall(skills.fetchSkillLookup({ q: " qa ", limit: 2 }), "/api/v1/skills/lookup?q=qa&limit=2");
    await expectCall(skills.validateSkillImport({ sourceRef: "skill" }), "/api/v1/skills/import/validate", {
      method: "POST",
    });
    await expectCall(skills.installSkillImport({ sourceRef: "skill", force: true }), "/api/v1/skills/import/install", {
      method: "POST",
    });
    await expectCall(skills.fetchSkillImportHistory(999), "/api/v1/skills/import/history?limit=300");
    await expectCall(
      skills.previewSkillEvaluation("skill/1", { prompt: "hi" } as never),
      "/api/v1/skills/by-id/evaluations/preview",
      {
        method: "POST",
      },
    );
    await expectCall(skills.runSkillEvaluation("skill/1"), "/api/v1/skills/by-id/evaluations/run", {
      method: "POST",
    });
    await expectCall(skills.fetchSkillEvaluations("skill/1"), "/api/v1/skills/by-id/evaluations?skillId=skill%2F1");
    await expectCall(skills.fetchSkillEvaluationRun("run/1"), "/api/v1/skills/evaluations/run%2F1");
    await expectCall(skills.createSkillEvaluationProposal("run/1"), "/api/v1/skills/evaluations/run%2F1/proposal", {
      method: "POST",
    });
    await expectCall(
      skills.updateSkillState("skill/1", { expectedRevision: 4, state: "enabled" as never }),
      "/api/v1/skills/by-id/state",
      {
        method: "PATCH",
      },
    );
    expect(apiMocks.request.mock.calls.at(-1)?.[1]?.body).toBe(
      JSON.stringify({ expectedRevision: 4, state: "enabled", skillId: "skill/1" }),
    );
    await expectCall(
      skills.bulkUpdateSkillState({
        skillIds: ["a"],
        expectedRevisionsBySkillId: { a: 3 },
        state: "disabled" as never,
      }),
      "/api/v1/skills/bulk-state",
      {
        method: "POST",
      },
    );
    expect(apiMocks.request.mock.calls.at(-1)?.[1]?.body).toBe(
      JSON.stringify({ skillIds: ["a"], expectedRevisionsBySkillId: { a: 3 }, state: "disabled" }),
    );
    await expectCall(skills.fetchSkillActivationPolicies(), "/api/v1/skills/activation-policies");
    await expectCall(
      skills.patchSkillActivationPolicies({ expectedRevision: 7, guardedAutoThreshold: 0.8 }),
      "/api/v1/skills/activation-policies",
      {
        method: "PATCH",
      },
    );
    expect(apiMocks.request.mock.calls.at(-1)?.[1]?.body).toBe(
      JSON.stringify({ expectedRevision: 7, guardedAutoThreshold: 0.8 }),
    );

    await expectCall(approvals.fetchApprovals("pending"), "/api/v1/approvals?status=pending");
    await expectCall(
      approvals.fetchApprovals({ status: "pending", limit: 500, cursor: "cursor next" }),
      "/api/v1/approvals?status=pending&limit=200&cursor=cursor+next",
    );
    await expectCall(approvals.fetchApprovals(), "/api/v1/approvals");
    await expectCall(approvals.resolveApproval("approval/1", "approve"), "/api/v1/approvals/approval/1/resolve", {
      method: "POST",
    });
    await expectCall(approvals.resolveApprovalsBulk({ decision: "reject" }), "/api/v1/approvals/bulk-resolve", {
      method: "POST",
    });
    await expect(apiMocks.request.mock.calls.at(-1)?.[1]?.body).toBe(JSON.stringify({ decision: "reject" }));
    await expectCall(
      approvals.resolveApprovalWithRemoteToken("remote-token", "approve"),
      "/api/v1/approvals/remote-resolve",
      { method: "POST" },
    );
    await expectCall(approvals.fetchApprovalReplay("approval/1"), "/api/v1/approvals/approval/1/replay");
    await expectCall(approvals.fetchToolCatalog(), "/api/v1/tools/catalog");
    await expectCall(approvals.evaluateToolAccess({ toolName: "fs.read" } as never), "/api/v1/tools/access/evaluate", {
      method: "POST",
    });
    await expectCall(
      approvals.fetchToolGrants({ scope: "workspace", scopeRef: "workspace 1", limit: 7 }),
      "/api/v1/tools/grants?scope=workspace&scopeRef=workspace+1&limit=7",
    );
    await expectCall(approvals.fetchToolGrants(), "/api/v1/tools/grants?limit=300");
    await expectCall(
      approvals.fetchEffectivePermissionProfile({ workspaceId: "workspace 1", surface: "code" }),
      "/api/v1/tools/permission-profiles/effective?workspaceId=workspace+1&surface=code",
    );
    await expectCall(approvals.fetchActiveLocalOperatorOverrides(), "/api/v1/tools/local-operator-overrides");
    await expectCall(
      approvals.createToolGrant({
        toolPattern: "fs.read",
        decision: "allow",
        scope: "workspace",
        scopeRef: "workspace-1",
      }),
      "/api/v1/tools/grants",
      {
        method: "POST",
      },
    );
    await expect(apiMocks.request.mock.calls.at(-1)?.[1]?.body).toBe(
      JSON.stringify({
        toolPattern: "fs.read",
        decision: "allow",
        scope: "workspace",
        scopeRef: "workspace-1",
      }),
    );
    await expectCall(approvals.revokeToolGrant("grant/1"), "/api/v1/tools/grants/grant%2F1/revoke", {
      method: "POST",
    });
    await expectCall(
      approvals.invokeTool({ toolName: "fs.read", args: {}, agentId: "agent", sessionId: "session" }),
      "/api/v1/tools/invoke",
      { method: "POST" },
    );

    await expectCall(mcp.fetchMcpServers(), "/api/v1/mcp/servers");
    await expectCall(mcp.fetchMcpTemplates(), "/api/v1/mcp/templates");
    await expectCall(mcp.fetchMcpTemplateDiscovery(), "/api/v1/mcp/templates/discovery");
    await expectCall(mcp.fetchMcpRemotePreview(), "/api/v1/mcp/remote-preview");
    await expectCall(mcp.fetchMcpServerModeManifest(), "/api/v1/mcp/server-mode/manifest");
    await expectCall(
      mcp.fetchMcpElicitations({ status: "pending", serverId: "server/1" }),
      "/api/v1/mcp/elicitations?status=pending&serverId=server%2F1",
    );
    await expectCall(
      mcp.createMcpElicitation({ prompt: "Pick a repo", requestedSchema: { type: "object" } }),
      "/api/v1/mcp/elicitations",
      { method: "POST" },
    );
    await expectCall(
      mcp.respondMcpElicitation("elicit/1", { action: "accept", content: { repo: "GoatCitadel" } }),
      "/api/v1/mcp/elicitations/elicit%2F1/respond",
      { method: "POST" },
    );
    await expectCall(
      mcp.callMcpServerModePreview({
        descriptorName: "goatcitadel.fs.read",
        args: {},
        agentId: "agent",
        sessionId: "session",
      }),
      "/api/v1/mcp/server-mode/call",
      { method: "POST" },
    );
    await expectCall(mcp.createMcpServer({ label: "Local", transport: "stdio" }), "/api/v1/mcp/servers", {
      method: "POST",
    });
    await expectCall(mcp.updateMcpServer("server/1", { enabled: true }), "/api/v1/mcp/servers/server%2F1", {
      method: "PATCH",
    });
    await expectCall(
      mcp.updateMcpServerPolicy("server/1", { scopes: ["read"] } as never),
      "/api/v1/mcp/servers/server%2F1/policy",
      {
        method: "PATCH",
      },
    );
    await expectCall(mcp.deleteMcpServer("server/1"), "/api/v1/mcp/servers/server%2F1", { method: "DELETE" });
    await expectCall(mcp.connectMcpServer("server/1"), "/api/v1/mcp/servers/server%2F1/connect", { method: "POST" });
    await expectCall(mcp.disconnectMcpServer("server/1"), "/api/v1/mcp/servers/server%2F1/disconnect", {
      method: "POST",
    });
    await expectCall(mcp.startMcpOAuth("server/1"), "/api/v1/mcp/servers/server%2F1/oauth/start", { method: "POST" });
    await expectCall(
      mcp.completeMcpOAuth("server/1", { code: "code" }),
      "/api/v1/mcp/servers/server%2F1/oauth/complete",
      {
        method: "POST",
      },
    );
    await expectCall(mcp.fetchMcpTools("server/1"), "/api/v1/mcp/servers/server%2F1/tools");
    await expectCall(mcp.invokeMcpTool({ serverId: "server/1", toolName: "search" }), "/api/v1/mcp/invoke", {
      method: "POST",
    });
    await expectCall(mcp.runMcpServerHealthCheck("server/1"), "/api/v1/mcp/servers/server%2F1/health-check", {
      method: "POST",
    });

    await expectCall(operatorsAgentsFiles.fetchOperators(), "/api/v1/operators");
    await expectCall(operatorsAgentsFiles.fetchAgents("all", 10), "/api/v1/agents?view=all&limit=10");
    await expectCall(operatorsAgentsFiles.fetchAgents(), "/api/v1/agents?view=active&limit=300");
    await expectCall(operatorsAgentsFiles.fetchAgent("agent/1"), "/api/v1/agents/agent%2F1");
    await expectCall(operatorsAgentsFiles.createAgentProfile({ name: "Agent" } as never), "/api/v1/agents", {
      method: "POST",
    });
    await expectCall(
      operatorsAgentsFiles.updateAgentProfile("agent/1", { name: "Agent 2" } as never),
      "/api/v1/agents/agent%2F1",
      {
        method: "PATCH",
      },
    );
    await expectCall(operatorsAgentsFiles.archiveAgentProfile("agent/1"), "/api/v1/agents/agent%2F1/archive", {
      method: "POST",
    });
    await expectCall(operatorsAgentsFiles.restoreAgentProfile("agent/1"), "/api/v1/agents/agent%2F1/restore", {
      method: "POST",
    });
    await expectCall(operatorsAgentsFiles.hardDeleteAgentProfile("agent/1"), "/api/v1/agents/agent%2F1?mode=hard", {
      method: "DELETE",
    });
    await expectCall(operatorsAgentsFiles.fetchFilesList("docs", 20), "/api/v1/files/list?dir=docs&limit=20");
    await expectCall(
      operatorsAgentsFiles.fetchFilesList("docs", 20, { citadelId: "company", workspaceId: "engineering" }),
      "/api/v1/files/list?dir=docs&limit=20&citadelId=company&workspaceId=engineering",
    );
    await expectCall(
      operatorsAgentsFiles.fetchPathSuggestions("root", 999),
      "/api/v1/files/path-suggestions?root=root&limit=500",
    );
    await expectCall(operatorsAgentsFiles.fetchFileTemplates(), "/api/v1/files/templates");
    await expectCall(
      operatorsAgentsFiles.createFileFromTemplate("tpl/1", "out.md"),
      "/api/v1/files/templates/tpl%2F1/create",
      {
        method: "POST",
      },
    );
    await expectCall(
      operatorsAgentsFiles.createFileFromTemplate("tpl/1", "out.md", {
        citadelId: "company",
        workspaceId: "engineering",
      }),
      "/api/v1/files/templates/tpl%2F1/create",
      {
        method: "POST",
        body: JSON.stringify({ targetPath: "out.md", citadelId: "company", workspaceId: "engineering" }),
      },
    );
    await expectCall(operatorsAgentsFiles.uploadFile("out.md", "body"), "/api/v1/files/upload", { method: "POST" });
    await expectCall(operatorsAgentsFiles.downloadFile("out.md"), "/api/v1/files/download?relativePath=out.md");
    await expectCall(
      operatorsAgentsFiles.downloadFile("out.md", { citadelId: "company", workspaceId: "engineering" }),
      "/api/v1/files/download?relativePath=out.md&citadelId=company&workspaceId=engineering",
    );

    await expectCall(settings.fetchSettings(), "/api/v1/settings");
    await expectCall(settings.fetchDeviceAccessGrants(), "/api/v1/auth/devices?view=active");
    await expectCall(settings.fetchDeviceAccessGrants("all"), "/api/v1/auth/devices?view=all");
    await expectCall(settings.revokeDeviceAccessGrant("grant/1"), "/api/v1/auth/devices/grant%2F1/revoke", {
      method: "POST",
    });
    await expectCall(settings.fetchOnboardingState(), "/api/v1/onboarding/state");
    await expectCall(
      settings.bootstrapOnboarding({ completedBy: "operator" } as never),
      "/api/v1/onboarding/bootstrap",
      {
        method: "POST",
      },
    );
    await expectCall(settings.completeOnboarding(), "/api/v1/onboarding/complete", { method: "POST" });
    await expectCall(settings.resolveGatewayInstallToken(), "/api/v1/auth/install-token", { method: "POST" });
    await expectCall(settings.patchSettings({ expectedRevision: 17, budgetMode: "saver" }), "/api/v1/settings", {
      method: "PATCH",
      body: JSON.stringify({ expectedRevision: 17, budgetMode: "saver" }),
    });
    await expectCall(settings.fetchPersonalities(), "/api/v1/personalities");
    await expectCall(settings.createPersonality({ label: "Calm" } as never), "/api/v1/personalities", {
      method: "POST",
    });
    await expectCall(
      settings.updatePersonality("personality/1", { label: "Sharp" } as never),
      "/api/v1/personalities/personality%2F1",
      {
        method: "PATCH",
      },
    );
    await expectCall(settings.deletePersonality("personality/1"), "/api/v1/personalities/personality%2F1", {
      method: "DELETE",
    });
    await expectCall(settings.setDefaultPersonality("personality/1"), "/api/v1/personalities/default", {
      method: "PATCH",
    });

    await expectCall(system.createMediaJob({ kind: "image" } as never), "/api/v1/media/jobs", { method: "POST" });
    await expectCall(system.fetchMediaJob("job/1"), "/api/v1/media/jobs/job%2F1");
    await expectCall(system.fetchMediaJobs("session/1"), "/api/v1/media/jobs?sessionId=session%2F1");
    await expectCall(system.fetchMediaJobs(), "/api/v1/media/jobs");
    await expectCall(system.fetchRetentionPolicy(), "/api/v1/admin/retention");
    await expectCall(system.updateRetentionPolicy({ maxAgeDays: 30 } as never), "/api/v1/admin/retention", {
      method: "PATCH",
    });
    await expectCall(system.pruneRetention(), "/api/v1/admin/retention/prune", { method: "POST" });
    await expectCall(system.pruneRetention(false), "/api/v1/admin/retention/prune", { method: "POST" });
    await expectCall(system.listBackups(4), "/api/v1/admin/backups?limit=4");
    await expectCall(system.createBackup(), "/api/v1/admin/backups/create", { method: "POST" });
    await expectCall(system.verifyBackup("backup.zip"), "/api/v1/admin/backups/verify", { method: "POST" });
    await expectCall(system.fetchCostSummary(), "/api/v1/costs/summary?scope=day");
    await expectCall(system.fetchCostSummary("agent"), "/api/v1/costs/summary?scope=agent");
    await expectCall(system.runCheaper(), "/api/v1/costs/run-cheaper", { method: "POST" });
    await expectCall(system.fetchRealtimeEvents(20, " cursor "), "/api/v1/events?limit=20&cursor=cursor");
    await expectCall(system.fetchDashboardState(), "/api/v1/dashboard/state");
    await expectCall(system.fetchSystemVitals(), "/api/v1/system/vitals");
    await expectCall(system.fetchTimelineSummary(), "/api/v1/observe/timeline");
    await expectCall(system.fetchHealthSummary(), "/api/v1/observe/health");

    apiMocks.request.mockResolvedValueOnce({ items: [{ id: "talk-1" }] });
    await expect(voice.fetchVoiceTalkSessions(3)).resolves.toEqual([{ id: "talk-1" }]);
    expect(apiMocks.request.mock.calls.at(-1)?.[0]).toBe("/api/v1/voice/talk/sessions?limit=3");
    apiMocks.request.mockResolvedValueOnce({
      items: Array.from({ length: 3 }, (_, index) => ({ id: `meet-${index}` })),
    });
    await expect(voice.fetchGoogleMeetSessions(2)).resolves.toEqual([{ id: "meet-0" }, { id: "meet-1" }]);
    expect(apiMocks.request.mock.calls.at(-1)?.[0]).toBe("/api/v1/voice/google-meet/sessions?limit=2");
    await expectCall(voice.transcribeVoice({ bytesBase64: "abc" }), "/api/v1/voice/transcribe", { method: "POST" });
    await expectCall(voice.fetchVoiceStatus(), "/api/v1/voice/status");
    await expectCall(voice.fetchVoiceRuntimeStatus(), "/api/v1/voice/runtime");
    await expectCall(voice.fetchGoogleMeetPrerequisiteStatus(), "/api/v1/voice/google-meet/prerequisites", {
      method: "POST",
    });
    await expectCall(
      voice.startGoogleMeetSession({
        meetingUrl: "https://meet.google.com/abc-defg-hij",
        provider: "openai-realtime",
        userStartConfirmed: true,
        browserTransportReady: true,
        audioTransportReady: true,
      }),
      "/api/v1/voice/google-meet/sessions",
      { method: "POST" },
    );
    await expectCall(
      voice.appendGoogleMeetTranscriptChunk("meet/1", {
        text: "decision path",
        final: true,
        provider: "openai-realtime",
      }),
      "/api/v1/voice/google-meet/sessions/meet%2F1/transcript",
      { method: "POST" },
    );
    await expectCall(
      voice.createGoogleMeetConsultHandoff("meet/1", { target: "cowork" }),
      "/api/v1/voice/google-meet/sessions/meet%2F1/consult",
      { method: "POST" },
    );
    await expectCall(voice.stopGoogleMeetSession("meet/1"), "/api/v1/voice/google-meet/sessions/meet%2F1/stop", {
      method: "POST",
    });
    await expectCall(voice.stopRealtimeVoiceSession("voice/1"), "/api/v1/voice/realtime/sessions/voice%2F1/stop", {
      method: "POST",
    });
    await expectCall(voice.installVoiceRuntime(), "/api/v1/voice/runtime/install", { method: "POST" });
    await expectCall(voice.selectVoiceRuntimeModel("model/1"), "/api/v1/voice/runtime/models/model%2F1/select", {
      method: "POST",
    });
    await expectCall(voice.removeVoiceRuntimeModel("model/1"), "/api/v1/voice/runtime/models/model%2F1", {
      method: "DELETE",
    });
    await expectCall(voice.startVoiceTalkSession(), "/api/v1/voice/talk/sessions", { method: "POST" });
    await expectCall(voice.stopVoiceTalkSession("talk/1"), "/api/v1/voice/talk/sessions/talk%2F1/stop", {
      method: "POST",
    });
    await expectCall(voice.startVoiceWake(), "/api/v1/voice/wake/start", { method: "POST" });
    await expectCall(voice.stopVoiceWake(), "/api/v1/voice/wake/stop", { method: "POST" });
  });

  it("routes diagnostics queries and handles diagnostic stream lifecycle", async () => {
    await expectCall(
      diagnostics.fetchDevDiagnostics({
        level: "warn",
        category: "runtime",
        correlationId: "corr/1",
        limit: 25,
      }),
      "/api/v1/dev/diagnostics?level=warn&category=runtime&correlationId=corr%2F1&limit=25",
    );
    await expectCall(diagnostics.fetchDevDiagnostics(), "/api/v1/dev/diagnostics");

    const instances: Array<{
      url: string;
      onopen?: () => void;
      onmessage?: (event: { data: string }) => void;
      onerror?: () => void;
      close: ReturnType<typeof vi.fn>;
    }> = [];
    class FakeEventSource {
      url: string;
      onopen?: () => void;
      onmessage?: (event: { data: string }) => void;
      onerror?: () => void;
      close = vi.fn();

      constructor(url: string) {
        this.url = url;
        instances.push(this);
      }
    }
    const timers = new Set<number>();
    const fakeWindow = {
      setTimeout: vi.fn((callback: () => void) => {
        const id = timers.size + 1;
        timers.add(id);
        callback();
        return id;
      }),
      clearTimeout: vi.fn((id: number) => {
        timers.delete(id);
      }),
    };
    vi.stubGlobal("window", fakeWindow);
    vi.stubGlobal("EventSource", FakeEventSource);

    const received: unknown[] = [];
    const disconnect = diagnostics.connectDevDiagnosticsStream((event) => received.push(event));
    await Promise.resolve();

    expect(instances[0]?.url).toBe("http://localhost:8787/api/v1/dev/diagnostics/stream?replay=50");
    instances[0]?.onopen?.();
    expect(apiMocks.setDevDiagnosticsGatewayReachable).toHaveBeenLastCalledWith(true);
    instances[0]?.onmessage?.({ data: JSON.stringify({ id: "event-1", level: "info" }) });
    instances[0]?.onmessage?.({ data: "not json" });
    expect(received).toEqual([{ id: "event-1", level: "info" }]);
    instances[0]?.onerror?.();
    expect(instances[0]?.close).toHaveBeenCalled();
    expect(apiMocks.setDevDiagnosticsGatewayReachable).toHaveBeenCalledWith(false);
    disconnect();
    expect(fakeWindow.clearTimeout).toHaveBeenCalled();
  });

  it("bridges auth for diagnostic streams and clears stale auth when the bridge is unnecessary", async () => {
    const instances: Array<{ url: string; close: ReturnType<typeof vi.fn> }> = [];
    class FakeEventSource {
      url: string;
      close = vi.fn();

      constructor(url: string) {
        this.url = url;
        instances.push(this);
      }
    }
    vi.stubGlobal("window", {
      setTimeout: vi.fn(() => 1),
      clearTimeout: vi.fn(),
    });
    vi.stubGlobal("EventSource", FakeEventSource);

    apiMocks.readStoredGatewayAuthState.mockReturnValue({ mode: "token", token: "secret" });
    const disconnectWithBridge = diagnostics.connectDevDiagnosticsStream(() => undefined);
    await Promise.resolve();
    await Promise.resolve();
    expect(instances.at(-1)?.url).toContain("sse_token=bridge-token");
    disconnectWithBridge();

    apiMocks.issueSseBridgeToken.mockRejectedValueOnce(new Error("not needed"));
    apiMocks.isSseBridgeNotNeededError.mockReturnValueOnce(true);
    const disconnectWithoutBridge = diagnostics.connectDevDiagnosticsStream(() => undefined);
    await Promise.resolve();
    await Promise.resolve();
    expect(apiMocks.clearGatewayAuthState).toHaveBeenCalled();
    expect(instances.at(-1)?.url).not.toContain("sse_token=");
    disconnectWithoutBridge();
  });

  it("returns a no-op diagnostics disconnect when window is unavailable", () => {
    vi.stubGlobal("window", undefined);

    expect(diagnostics.connectDevDiagnosticsStream(() => undefined)()).toBeUndefined();
  });
});
