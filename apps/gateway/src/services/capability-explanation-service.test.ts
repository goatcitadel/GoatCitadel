import { describe, expect, it, vi } from "vitest";
import type {
  CapabilityCatalogEntry,
  CapabilityConnectorItem,
  ChatTurnCapabilityProfileRecord,
  ToolInvokeRequest,
} from "@goatcitadel/contracts";
import { CapabilityExplanationService } from "./capability-explanation-service.js";

function fixture() {
  const entries: CapabilityCatalogEntry[] = [
    {
      capabilityId: "tool:gmail.send",
      kind: "tool",
      category: "built_in",
      title: "gmail.send",
      summary: "Send email through Gmail",
      toolName: "gmail.send",
      callable: true,
    },
    {
      capabilityId: "tool:fs.read",
      kind: "tool",
      category: "built_in",
      title: "fs.read",
      summary: "Read local files",
      toolName: "fs.read",
      callable: true,
    },
  ];
  const connector = {
    id: "integration:google",
    name: "Gmail and Google Calendar",
    description: "Email and calendar",
    source: "integration",
    kind: "built_in",
    category: "productivity",
    state: "connected",
    reason: "ready",
    group: "connected",
    auth: "google",
    googleGrantedCapabilities: ["gmail.send"],
    runsOnThisDevice: false,
    networkHosts: [],
    chat: { available: true },
    hiddenInWorkspace: false,
    command: "secret-command",
    lastError: "secret-error",
    connectionId: "private-account",
  } as CapabilityConnectorItem;
  const host = {
    requireSession: vi.fn(async () => ({ sessionId: "session", workspaceId: "workspace" })),
    listCatalog: vi.fn(async () => entries),
    listConnectors: vi.fn(async () => ({
      workspaceId: "workspace",
      items: [connector],
      issues: [],
      generatedAt: "2026-11-18T12:00:00Z",
      approvalReliefAvailable: false,
    })),
    inspectToolAccess: vi.fn(async () => ({ allowed: true, requiresApproval: false, reasonCodes: [] })),
    getSessionPrefs: vi.fn(async () => ({ toolAutonomy: "safe_auto", planningMode: "off" })),
    getCodeModeReadiness: vi.fn(async () => ({
      canRun: true,
      enabled: true,
      sandboxEnabled: true,
      sandboxSupported: true,
    })),
    getTurnProfile: vi.fn(async (): Promise<ChatTurnCapabilityProfileRecord | undefined> => undefined),
    getSearchBackend: vi.fn(
      async (): Promise<{ backend: "native" | "firecrawl"; fallbackToNative: boolean }> => ({
        backend: "native",
        fallbackToNative: false,
      }),
    ),
    now: () => "2026-11-18T12:00:01Z",
  };
  const request: ToolInvokeRequest = {
    toolName: "capabilities.explain",
    sessionId: "session",
    agentId: "assistant",
    workspaceId: "workspace",
    args: { query: "email" },
    policyContext: { workspaceId: "workspace", authActorId: "operator", authActorSource: "token" },
  };
  return { host, entries, connector, request, service: new CapabilityExplanationService(host) };
}

describe("capability explanations", () => {
  it.each([
    ["gmail.send", "ready", "setup_needed"],
    ["calendar.read", "setup_needed", "ready"],
  ] as const)("uses the Google grant for %s only", async (capability, gmail, calendar) => {
    const { service, request, entries, connector } = fixture();
    connector.googleGrantedCapabilities = [capability];
    entries.push({
      ...entries[0]!,
      capabilityId: "tool:calendar.list",
      title: "calendar.list",
      toolName: "calendar.list",
      summary: "List calendar events",
    });
    request.args = { query: "gmail.send", additionalTopics: ["calendar.list"] };
    const result = await service.explain(request);
    expect(result.capabilities).toContainEqual(expect.objectContaining({ toolName: "gmail.send", state: gmail }));
    expect(result.capabilities).toContainEqual(expect.objectContaining({ toolName: "calendar.list", state: calendar }));
  });

  it("answers email capability questions with scoped evidence, without copying connector secrets", async () => {
    const { service, request, host } = fixture();
    const result = await service.explain(request);
    expect(result).toMatchObject({
      informationalOnly: true,
      permissionsGranted: false,
      workspaceId: "workspace",
      observedAt: "2026-11-18T12:00:01Z",
    });
    expect(result.capabilities).toContainEqual(expect.objectContaining({ toolName: "gmail.send", state: "ready" }));
    expect(host.inspectToolAccess).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session", workspaceId: "workspace", policyContext: request.policyContext }),
    );
    expect(JSON.stringify(result)).not.toMatch(/secret-command|secret-error|private-account/);
  });

  it("explains approval requirements without treating them as grants", async () => {
    const { service, request, host } = fixture();
    host.inspectToolAccess.mockResolvedValue({ allowed: true, requiresApproval: true, reasonCodes: [] });
    expect((await service.explain(request)).capabilities).toContainEqual(
      expect.objectContaining({ state: "approval_needed" }),
    );
  });

  it.each(["needs_sign_in", "sign_in_expired", "available", "turned_off", "broken"] as const)(
    "explains %s connectors instead of claiming email works",
    async (state) => {
      const { service, request, connector } = fixture();
      connector.state = state;
      const result = await service.explain(request);
      expect(result.capabilities.find((item) => item.toolName === "gmail.send")?.state).toBe(
        state === "broken" ? "blocked" : "setup_needed",
      );
      expect(result.capabilities.find((item) => item.toolName === "gmail.send")?.nextStep).toBeTruthy();
    },
  );

  it("keeps policy denials authoritative even when sign-in is missing", async () => {
    const { service, request, connector, host } = fixture();
    connector.state = "needs_sign_in";
    host.inspectToolAccess.mockResolvedValue({ allowed: false, requiresApproval: false, reasonCodes: ["policy_deny"] });
    const result = await service.explain(request);
    const item = result.capabilities.find((entry) => entry.toolName === "gmail.send");
    expect(item?.state).toBe("blocked");
    expect(item?.reason).toMatch(/policy/i);
    expect(item?.nextStep).not.toMatch(/sign in|turn.*on/i);
  });

  it("does not confuse disabled tools or skills with available execution", async () => {
    const { service, request, entries } = fixture();
    entries[0]!.callable = false;
    entries.push({
      capabilityId: "skill:email",
      kind: "skill",
      category: "built_in",
      title: "Email helper",
      summary: "Email workflow",
      skillId: "email",
      callable: false,
      lifecycleState: "revoked",
    });
    const result = await service.explain(request);
    expect(
      result.capabilities
        .filter((entry) => entry.kind === "tool" || entry.kind === "skill")
        .every((entry) => entry.state !== "ready"),
    ).toBe(true);
  });

  it("reports failed source reads as unknown and never includes raw exceptions", async () => {
    const { service, request, host } = fixture();
    host.listConnectors.mockRejectedValue(new Error("sk-secret-url"));
    const result = await service.explain(request);
    expect(result.capabilities.find((entry) => entry.toolName === "gmail.send")?.state).toBe("unknown");
    expect(result.issues.length).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain("sk-secret-url");
  });

  it("treats partial connector evidence and hidden connectors conservatively", async () => {
    const { service, request, connector, host } = fixture();
    connector.hiddenInWorkspace = true;
    expect((await service.explain(request)).capabilities.find((entry) => entry.toolName === "gmail.send")?.state).toBe(
      "blocked",
    );
    connector.hiddenInWorkspace = false;
    host.listConnectors.mockResolvedValue({
      workspaceId: "workspace",
      items: [connector],
      issues: [{ source: "integration", message: "Couldn't check sign-in." }],
      generatedAt: "2026-11-18T12:00:00Z",
      approvalReliefAvailable: false,
    });
    expect((await service.explain(request)).capabilities.find((entry) => entry.toolName === "gmail.send")?.state).toBe(
      "unknown",
    );
  });

  it("explains manual autonomy without advertising tools as executable", async () => {
    const { service, request, host } = fixture();
    host.getSessionPrefs.mockResolvedValue({ toolAutonomy: "manual", planningMode: "off" });
    expect(
      (await service.explain(request)).capabilities.find((entry) => entry.toolName === "gmail.send"),
    ).toMatchObject({ state: "blocked", reason: expect.stringMatching(/manual/i) });
  });

  it.each(["workspace", "policy", "session"])(
    "rejects a mismatched %s scope before any capability read",
    async (scope) => {
      const { service, request, host } = fixture();
      if (scope === "workspace") request.workspaceId = "other";
      if (scope === "policy") request.policyContext!.workspaceId = "other";
      if (scope === "session") request.policyContext!.sessionId = "other";
      await expect(service.explain(request)).rejects.toThrow(/scope|workspace|session/i);
      expect(host.listCatalog).not.toHaveBeenCalled();
    },
  );

  it("bounds reads and results, and no match never means unsupported", async () => {
    const { service, request, host } = fixture();
    request.args = { query: "unmatchedzzzz", limit: 1 };
    expect(await service.explain(request)).toMatchObject({ capabilities: [], coverage: "no_match" });
    request.args = { query: "email", limit: 1 };
    const result = await service.explain(request);
    expect(result.capabilities).toHaveLength(1);
    expect(result.coverage).toBe("partial");
    request.args = { query: "email", workspaceId: "other" };
    const calls = host.listCatalog.mock.calls.length;
    await expect(service.explain(request)).rejects.toThrow(/bounded/);
    expect(host.listCatalog.mock.calls).toHaveLength(calls);
  });

  it("reserves results for each topic in a single scoped inspection and reports mixed coverage", async () => {
    const { service, request, host } = fixture();
    request.args = { query: "gmail email", additionalTopics: ["fs.read", "unmatchedzzzz"], limit: 1 };
    const result = await service.explain(request);
    expect(result.coverage).toBe("partial");
    expect(result.capabilities.map((entry) => entry.capabilityId)).toEqual(["tool:gmail.send", "tool:fs.read"]);
    expect(result.topics).toEqual([
      { query: "gmail email", coverage: "partial", capabilityIds: ["tool:gmail.send"] },
      { query: "fs.read", coverage: "complete", capabilityIds: ["tool:fs.read"] },
      { query: "unmatchedzzzz", coverage: "no_match", capabilityIds: [] },
    ]);
    expect(result.permissionsGranted).toBe(false);
    expect(host.listCatalog).toHaveBeenCalledTimes(1);
    expect(host.listConnectors).toHaveBeenCalledTimes(1);
    expect(host.inspectToolAccess).toHaveBeenCalledTimes(2);
  });

  it("reuses the same observation when a capability matches several topics", async () => {
    const { service, request, host } = fixture();
    request.args = { query: "gmail.send", additionalTopics: ["gmail email"], limit: 1 };
    const result = await service.explain(request);
    expect(result.capabilities.map((entry) => entry.capabilityId)).toEqual(["tool:gmail.send"]);
    expect(result.topics?.map((topic) => topic.capabilityIds)).toEqual([["tool:gmail.send"], ["tool:gmail.send"]]);
    expect(host.inspectToolAccess).toHaveBeenCalledTimes(1);
  });

  it("does not claim readiness when the turn profile cannot be read", async () => {
    const { service, request, host } = fixture();
    request.turnId = "turn";
    host.getTurnProfile.mockRejectedValue(new Error("private failure"));
    expect((await service.explain(request)).capabilities.find((entry) => entry.toolName === "gmail.send")?.state).toBe(
      "unknown",
    );
  });

  it("honors a frozen turn selection without treating new live tools as admitted", async () => {
    const { service, request, host } = fixture();
    request.turnId = "turn";
    host.getTurnProfile.mockResolvedValue({
      identity: { turnId: "turn", sessionId: "session", workspaceId: "workspace" },
      selection: { toolAutonomy: "safe_auto", tools: [] },
    } as unknown as ChatTurnCapabilityProfileRecord);
    expect(
      (await service.explain(request)).capabilities.find((entry) => entry.toolName === "gmail.send"),
    ).toMatchObject({ state: "blocked", reason: expect.stringContaining("frozen") });
  });

  it("reports policy and session read failures as unknown", async () => {
    const { service, request, host } = fixture();
    host.inspectToolAccess.mockRejectedValue(new Error("private failure"));
    expect((await service.explain(request)).capabilities.find((entry) => entry.toolName === "gmail.send")?.state).toBe(
      "unknown",
    );
    host.getSessionPrefs.mockRejectedValue(new Error("private failure"));
    expect((await service.explain(request)).capabilities.find((entry) => entry.toolName === "gmail.send")?.state).toBe(
      "unknown",
    );
  });

  it("redacts secret-like metadata instead of copying a credential in a description", async () => {
    const { service, request, entries } = fixture();
    entries[0]!.summary = "Send email using https://example.test/?api_key=metadata-secret";
    expect(JSON.stringify(await service.explain(request))).not.toContain("metadata-secret");
  });

  it("uses Code Mode readiness and keeps unsupported execution blocked", async () => {
    const { service, request, host, entries } = fixture();
    entries.push({
      capabilityId: "tool:code_mode.request",
      kind: "tool",
      category: "built_in",
      title: "code_mode.request",
      summary: "Run code",
      toolName: "code_mode.request",
      callable: true,
    });
    request.args = { query: "code_mode.request" };
    host.getCodeModeReadiness.mockResolvedValue({
      canRun: false,
      enabled: false,
      sandboxEnabled: true,
      sandboxSupported: false,
      reason: "sandbox_unsupported",
    } as Awaited<ReturnType<typeof host.getCodeModeReadiness>>);
    expect((await service.explain(request)).capabilities[0]).toMatchObject({ state: "blocked" });
  });

  it.each(["companion", "a2a_peer", "mesh_node"] as const)(
    "does not advertise Code Mode to a %s actor",
    async (authActorSource) => {
      const { service, request, entries } = fixture();
      entries.push({
        capabilityId: "tool:code_mode.request",
        kind: "tool",
        category: "built_in",
        title: "code_mode.request",
        summary: "Run code",
        toolName: "code_mode.request",
        callable: true,
      });
      request.args = { query: "code_mode.request" };
      request.policyContext!.authActorSource = authActorSource;
      expect((await service.explain(request)).capabilities[0]?.state).toBe("blocked");
    },
  );

  it("keeps restricted Code Mode blocked and profile-free turn eligibility unknown", async () => {
    const { service, request, entries } = fixture();
    entries.push({
      capabilityId: "tool:code_mode.request",
      kind: "tool",
      category: "built_in",
      title: "code_mode.request",
      summary: "Run code",
      toolName: "code_mode.request",
      callable: true,
    });
    request.args = { query: "code_mode.request" };
    expect((await service.explain(request)).capabilities[0]?.state).toBe("unknown");
    request.permissionProfileId = "scheduled-restricted";
    expect((await service.explain(request)).capabilities[0]?.state).toBe("blocked");
  });

  it.each(["native", "fallback", "firecrawl"])(
    "uses the %s search backend rather than requiring optional keys for every search",
    async (backend) => {
      const { service, request, entries, host, connector } = fixture();
      entries.push({
        capabilityId: "tool:browser.search",
        kind: "tool",
        category: "built_in",
        title: "browser.search",
        summary: "Search the web",
        toolName: "browser.search",
        callable: true,
      });
      request.args = { query: "browser.search" };
      connector.id = "web-search:search.firecrawl";
      connector.source = "web_search";
      connector.state = "available";
      connector.reason = "needs_api_key";
      host.getSearchBackend.mockResolvedValue({
        backend: backend === "native" ? "native" : "firecrawl",
        fallbackToNative: backend === "fallback",
      });
      expect((await service.explain(request)).capabilities[0]?.state).toBe(
        backend === "firecrawl" ? "setup_needed" : "ready",
      );
    },
  );

  it("does not broaden a frozen approval requirement when live policy becomes less restrictive", async () => {
    const { service, request, host } = fixture();
    request.turnId = "turn";
    host.getTurnProfile.mockResolvedValue({
      identity: { turnId: "turn", sessionId: "session", workspaceId: "workspace" },
      selection: { toolAutonomy: "safe_auto", tools: [{ canonicalName: "gmail.send" }] },
      governance: {
        policyDecisions: [{ toolName: "gmail.send", allowed: true, requiresApproval: true }],
        authReadiness: [],
      },
    } as unknown as ChatTurnCapabilityProfileRecord);
    expect(
      (await service.explain(request)).capabilities.find((entry) => entry.toolName === "gmail.send"),
    ).toMatchObject({ state: "blocked", reason: expect.stringMatching(/frozen approval/i) });
  });

  it("answers a general blocker question with observed disabled capabilities", async () => {
    const { service, request, entries } = fixture();
    entries[1]!.callable = false;
    request.args = { query: "Which capabilities are blocked?", limit: 1 };
    expect((await service.explain(request)).capabilities[0]).toMatchObject({ toolName: "fs.read", state: "blocked" });
  });

  it.each([
    "agent.fanout",
    "browser.errand",
    "capabilities.search",
    "skills.read",
    "user_input.request",
    "context.list",
  ])("does not promise profile-free availability of %s from policy alone", async (toolName) => {
    const { service, request, entries } = fixture();
    entries.push({
      capabilityId: `tool:${toolName}`,
      kind: "tool",
      category: "built_in",
      title: toolName,
      summary: "Turn-gated tool",
      toolName,
      callable: true,
    });
    request.args = { query: toolName };
    expect((await service.explain(request)).capabilities.find((entry) => entry.toolName === toolName)?.state).toBe(
      "unknown",
    );
  });
});
