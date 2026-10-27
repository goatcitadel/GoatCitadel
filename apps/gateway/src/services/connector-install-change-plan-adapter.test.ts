import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConflictError,
  type ChangePlanConnectorInstallRequest,
  type ChangePlanRecord,
  type McpServerCreateInput,
  type McpServerRecord,
  type McpServerTemplateRecord,
} from "@goatcitadel/contracts";
import {
  ChangePlanRepository,
  createDatabase,
  type ChangePlanRepositoryCreateInput,
  type ChangePlanRepositoryListInput,
  type ChangePlanRepositoryTransitionInput,
} from "@goatcitadel/storage";
import {
  ConnectorInstallChangePlanAdapter,
  connectorInstallDependencies,
  type ConnectorInstallDependencies,
} from "./connector-install-change-plan-adapter.js";
import { isAutoResumeOnApprovalPlan } from "./evolution-control-plane-approval-reconciliation.js";
import { EvolutionControlPlaneAdapterRegistry } from "./evolution-control-plane-adapter.js";
import { EvolutionControlPlaneService, type EvolutionControlPlaneActor } from "./evolution-control-plane-service.js";
import type { McpServerAdminHost } from "./mcp-server-admin-service.js";

const databases: Array<ReturnType<typeof createDatabase>> = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const database of databases.splice(0)) database.close();
});

const POLICY = {
  requireFirstToolApproval: true,
  redactionMode: "basic" as const,
  allowedToolPatterns: [],
  blockedToolPatterns: [],
};

function template(overrides: Partial<McpServerTemplateRecord> & Pick<McpServerTemplateRecord, "templateId" | "label">) {
  return {
    description: `${overrides.label} for tests.`,
    transport: "http",
    url: "https://mcp.example.test/mcp",
    authType: "oauth2",
    oauth: { metadataDiscovery: true },
    category: "data",
    trustTier: "restricted",
    costTier: "unknown",
    policy: POLICY,
    enabledByDefault: false,
    ...overrides,
  } satisfies McpServerTemplateRecord;
}

const EXAMPLE = template({
  templateId: "example",
  label: "Example",
  networkHosts: ["mcp.example.test", "AUTH.example.test"],
  riskNotes: ["It can read and change your tickets."],
});
const TEMPLATES: McpServerTemplateRecord[] = [
  EXAMPLE,
  template({
    templateId: "keyed",
    label: "Keyed",
    transport: "stdio",
    url: undefined,
    command: "npx",
    args: ["-y", "keyed-mcp@1.0.0"],
    authType: "token",
    oauth: undefined,
  }),
  // Shaped like the GitHub template: OAuth with nowhere to sign in yet. It is listed only with remote transports on.
  template({ templateId: "unconfigured", label: "Unconfigured", oauth: undefined }),
  template({
    templateId: "fetch",
    label: "Fetch",
    transport: "stdio",
    url: undefined,
    command: "npx",
    oauth: undefined,
  }),
  template({ templateId: "hidden", label: "Hidden", url: undefined }),
];

const OPERATOR = { workspaceId: "default", actorId: "operator-1", surface: "capabilities" as const };

function installRequest(templateId: string, enableChatConnectors = false): ChangePlanConnectorInstallRequest {
  return { kind: "connector_install", templateId, enableChatConnectors };
}

function savedServer(label: string, overrides: Partial<McpServerRecord> = {}): McpServerRecord {
  return {
    serverId: `saved-${label}`,
    label,
    transport: "http",
    url: "https://mcp.example.test/mcp",
    authType: "oauth2",
    enabled: false,
    category: "data",
    trustTier: "restricted",
    costTier: "unknown",
    policy: POLICY,
    status: "disconnected",
    createdAt: "2026-10-27T00:00:00.000Z",
    updatedAt: "2026-10-27T00:00:00.000Z",
    ...overrides,
  };
}

/** In-memory owners. Settings writes are fenced by revision, as the real settings owner fences them. */
function owners(input: { servers?: McpServerRecord[]; allowlist?: string[]; chat?: boolean } = {}) {
  const state = {
    servers: [...(input.servers ?? [])],
    settings: {
      revision: 1,
      networkAllowlist: [...(input.allowlist ?? [])],
      features: { chatStaticMcpV1Enabled: input.chat ?? false },
    },
  };
  const deps = {
    templates: TEMPLATES,
    readMcpServers: vi.fn(async () => [...state.servers]),
    readSettings: vi.fn(async () => ({
      revision: state.settings.revision,
      networkAllowlist: [...state.settings.networkAllowlist],
      features: { ...state.settings.features },
    })),
    updateSettings: vi.fn(
      async (update: {
        expectedRevision: number;
        networkAllowlist?: string[];
        features?: { chatStaticMcpV1Enabled: boolean };
      }) => {
        if (update.expectedRevision !== state.settings.revision) {
          throw new ConflictError({ code: "WRITE_CONFLICT", message: "Settings changed elsewhere." });
        }
        state.settings = {
          revision: state.settings.revision + 1,
          networkAllowlist: update.networkAllowlist ?? state.settings.networkAllowlist,
          features: { ...state.settings.features, ...update.features },
        };
      },
    ),
    createMcpServer: vi.fn(async (create: McpServerCreateInput) => {
      const server = savedServer(create.label, {
        ...create,
        serverId: `server-${state.servers.length + 1}`,
        authType: create.authType ?? "none",
        enabled: create.enabled ?? true,
        policy: { ...POLICY, ...create.policy },
      });
      state.servers = [server, ...state.servers];
      return server;
    }),
    setReadsFree: vi.fn(async (server: McpServerRecord, _actorId: string) => {
      const updated = { ...server, policy: { ...server.policy, approvalPosture: "reads_free" as const } };
      state.servers = state.servers.map((item) => (item.serverId === server.serverId ? updated : item));
      return updated;
    }),
  } satisfies ConnectorInstallDependencies;
  return { state, deps };
}

/** The real control plane and adapter on a migrated SQLite ledger, with the approval owner faked. */
function harness(input: Parameters<typeof owners>[0] & { skip?: boolean } = {}) {
  const database = createDatabase({ dbPath: ":memory:" });
  databases.push(database);
  const sync = new ChangePlanRepository(database);
  const { state, deps } = owners(input);
  const adapter = new ConnectorInstallChangePlanAdapter(deps);
  let disposition: "approved" | "pending" = "pending";
  const createApproval = vi.fn(async () => "approval-install");
  const service = new EvolutionControlPlaneService({
    repository: {
      create: async (create: ChangePlanRepositoryCreateInput) => sync.create(create),
      get: async (planId: string) => sync.get(planId),
      list: async (query: ChangePlanRepositoryListInput) => sync.list(query),
      listActive: async (limit?: number) => sync.listActive(limit),
      listAwaitingApproval: async (approvalId: string, limit?: number) => sync.listAwaitingApproval(approvalId, limit),
      transition: async (planId: string, transition: ChangePlanRepositoryTransitionInput) =>
        sync.transition(planId, transition),
    },
    adapters: new EvolutionControlPlaneAdapterRegistry([adapter]),
    allowsOperatorApprovalSkip: async () => input.skip ?? true,
    createApproval,
    getApprovalDisposition: async () => disposition,
  });
  const confirm = (plan: ChangePlanRecord, actor: EvolutionControlPlaneActor = OPERATOR) =>
    service.confirm(actor, plan.planId, plan.revision, plan.requiredAction!.actionNonce, {
      operatorSettingsSave: true,
    });
  const install = async (request: ChangePlanConnectorInstallRequest) =>
    confirm(await service.create({ actor: OPERATOR, request }));
  const writes = () => [deps.updateSettings, deps.createMcpServer, deps.setReadsFree].flatMap((fn) => fn.mock.calls);
  return {
    sync,
    state,
    deps,
    adapter,
    service,
    createApproval,
    confirm,
    install,
    writes,
    approve: () => {
      disposition = "approved";
    },
  };
}

describe("installing a connector through one Change Plan", () => {
  it("adds only missing hosts, creates the server switched off, and sets Reading is free", async () => {
    const h = harness({ allowlist: ["api.openai.com", "auth.example.test"] });
    const plan = await h.service.create({ actor: OPERATOR, request: installRequest("example") });
    expect(plan).toMatchObject({
      kind: "connector_install",
      scope: "capability",
      risk: "danger",
      status: "awaiting_confirmation",
      title: "Install Example",
      target: { ownerId: "capability_connector_install", resourceId: "mcp_template:example" },
    });
    expect(plan.summary).toContain("Allow mcp.example.test.");
    expect(plan.summary).not.toContain("AUTH.example.test");
    expect(plan.impact).toContain("It can read and change your tickets.");
    expect(h.writes()).toEqual([]);

    // Another save lands between review and apply: the install appends to that list, not to the one it reviewed.
    h.state.settings = {
      ...h.state.settings,
      revision: 2,
      networkAllowlist: [...h.state.settings.networkAllowlist, "other.example.org"],
    };
    const settled = await h.confirm(plan);

    expect(settled.status).toBe("completed");
    expect(settled.result?.summary).toBe("Allowed mcp.example.test. Saved Example, switched off.");
    expect(h.state.settings.networkAllowlist).toEqual([
      "api.openai.com",
      "auth.example.test",
      "other.example.org",
      "mcp.example.test",
    ]);
    expect(h.deps.createMcpServer).toHaveBeenCalledExactlyOnceWith({
      label: "Example",
      transport: "http",
      url: "https://mcp.example.test/mcp",
      authType: "oauth2",
      oauth: { metadataDiscovery: true },
      category: "data",
      trustTier: "restricted",
      costTier: "unknown",
      policy: POLICY,
      enabled: false,
    });
    // "Reading is free" goes through the audited policy write, naming the operator who asked for the install.
    expect(h.deps.setReadsFree).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ serverId: "server-1" }),
      "operator-1",
    );
    expect(h.state.servers).toEqual([
      expect.objectContaining({
        label: "Example",
        enabled: false,
        policy: { ...POLICY, approvalPosture: "reads_free" },
      }),
    ]);
    expect(h.deps.updateSettings).toHaveBeenCalledTimes(1);
  });

  it("writes no allowed host when a wildcard already covers every one", async () => {
    const h = harness({ allowlist: ["*.example.test"] });

    const settled = await h.install(installRequest("example"));

    expect(settled.status).toBe("completed");
    expect(settled.result?.summary).toBe("Saved Example, switched off.");
    expect(h.deps.updateSettings).not.toHaveBeenCalled();
  });

  it("turns on MCP in Chat only when asked and currently off", async () => {
    for (const { asked, on, writes } of [
      { asked: true, on: false, writes: true },
      { asked: true, on: true, writes: false },
      { asked: false, on: false, writes: false },
    ]) {
      const h = harness({ chat: on });

      const settled = await h.install(installRequest("example", asked));

      expect(settled.status).toBe("completed");
      expect(h.state.settings.features.chatStaticMcpV1Enabled).toBe(on || writes);
      const flagWrites = h.deps.updateSettings.mock.calls.filter(([update]) => update.features);
      if (writes) {
        // The allowed-host write bumped the revision, so the flag write had to re-read it.
        expect(flagWrites).toEqual([[{ expectedRevision: 2, features: { chatStaticMcpV1Enabled: true } }]]);
        expect(settled.result?.summary).toBe(
          "Allowed mcp.example.test, auth.example.test. Saved Example, switched off. Let Chat use connectors.",
        );
      } else {
        expect(flagWrites).toEqual([]);
        expect(settled.result?.summary).not.toContain("Chat");
      }
    }
  });

  it("refuses an API-key template and changes nothing", async () => {
    const h = harness();

    await expect(h.service.create({ actor: OPERATOR, request: installRequest("keyed", true) })).rejects.toMatchObject({
      httpStatus: 409,
      message: "Keyed needs an API key. Set it up in Settings.",
      details: { field: "needsApiKey" },
    });

    expect(h.writes()).toEqual([]);
    expect(await h.service.list(OPERATOR)).toEqual([]);
  });

  it("refuses a template already saved under a different letter case", async () => {
    const h = harness({ servers: [savedServer("EXAMPLE")] });

    await expect(h.service.create({ actor: OPERATOR, request: installRequest("example") })).rejects.toMatchObject({
      httpStatus: 409,
      message: "Example is already saved.",
      details: { field: "alreadyInstalled" },
    });

    expect(h.writes()).toEqual([]);
    expect(await h.service.list(OPERATOR)).toEqual([]);
  });

  it.each([
    ["an excluded template", "fetch"],
    ["an unknown template", "missing"],
    ["a template this install can't run", "hidden"],
  ])("refuses %s by its template id and changes nothing", async (_label, templateId) => {
    const h = harness();

    await expect(h.service.create({ actor: OPERATOR, request: installRequest(templateId) })).rejects.toMatchObject({
      httpStatus: 409,
      message: "This app can't be installed from Capabilities.",
      details: { field: "templateId" },
    });
    expect(h.writes()).toEqual([]);
  });

  it("refuses an OAuth template with nowhere to sign in and changes nothing", async () => {
    vi.stubEnv("GOATCITADEL_EXPERIMENTAL_REMOTE_MCP_TRANSPORTS", "1");
    const h = harness();

    await expect(h.service.create({ actor: OPERATOR, request: installRequest("unconfigured") })).rejects.toMatchObject({
      httpStatus: 409,
      message: "Unconfigured's sign-in isn't set up yet. Set it up in Settings.",
      details: { field: "needsSignInSetup" },
    });
    expect(h.writes()).toEqual([]);
  });

  // A model's `change.request` arrives as a Chat plan with its session and turn, so it is refused here too.
  it.each([
    ["a Chat turn", { ...OPERATOR, surface: "chat" as const, sessionId: "session-1", turnId: "turn-1" }],
    ["Settings", { ...OPERATOR, surface: "settings" as const }],
    ["the system", { ...OPERATOR, surface: "system" as const }],
    ["Capabilities with Chat linkage", { ...OPERATOR, sessionId: "session-1" }],
  ])("refuses an install plan that starts from %s", async (_label, actor) => {
    const h = harness();

    await expect(h.service.create({ actor, request: installRequest("example") })).rejects.toMatchObject({
      httpStatus: 403,
      details: { diagnosticCode: "connector_install_untrusted_origin" },
    });
    expect(h.writes()).toEqual([]);
  });

  it("checks again at apply and changes nothing when the app was saved after review", async () => {
    const h = harness();
    const plan = await h.service.create({ actor: OPERATOR, request: installRequest("example", true) });
    h.state.servers = [savedServer("example")];

    const settled = await h.confirm(plan);

    expect(settled.status).toBe("failed");
    expect(settled.result).toEqual({ summary: "Example is already saved.", failureCode: "connector_install_refused" });
    expect(h.writes()).toEqual([]);
  });

  it("reports nothing changed when the first write fails", async () => {
    const h = harness();
    h.deps.updateSettings.mockRejectedValueOnce(new Error("The settings file is locked."));

    const settled = await h.install(installRequest("example", true));

    expect(settled.status).toBe("failed");
    expect(settled.result).toEqual({
      summary: "Couldn't allow mcp.example.test, auth.example.test. The settings file is locked.",
      failureCode: "connector_install_allow_failed",
    });
    expect(h.deps.createMcpServer).not.toHaveBeenCalled();
  });

  it("names each finished step when a later step fails, and stops there", async () => {
    const h = harness();
    h.deps.createMcpServer.mockRejectedValueOnce(new Error("MCP configuration changed."));

    const settled = await h.install(installRequest("example", true));

    expect(settled.status).toBe("manual_required");
    expect(settled.result).toEqual({
      summary: "Allowed mcp.example.test, auth.example.test. Couldn't save Example. MCP configuration changed.",
      failureCode: "connector_install_save_failed",
    });
    expect(h.deps.setReadsFree).not.toHaveBeenCalled();
    expect(h.state.settings.features.chatStaticMcpV1Enabled).toBe(false);
  });

  it("says everything still asks when Reading is free couldn't be saved", async () => {
    const h = harness({ allowlist: ["*.example.test"] });
    h.deps.setReadsFree.mockRejectedValueOnce(new Error("MCP configuration changed."));

    const settled = await h.install(installRequest("example"));

    expect(settled.status).toBe("manual_required");
    expect(settled.result).toEqual({
      summary:
        "Saved Example, switched off. Couldn't set Example to Reading is free, so everything it does asks you first. " +
        "MCP configuration changed.",
      failureCode: "connector_install_reads_free_failed",
    });
  });

  it("counts a save whose write committed before a follow-up failed", async () => {
    const h = harness({ allowlist: ["*.example.test"] });
    h.deps.createMcpServer.mockRejectedValueOnce(
      Object.assign(new Error("MCP configuration committed but follow-up work failed."), { mutationCommitted: true }),
    );

    const settled = await h.install(installRequest("example"));

    expect(settled.status).toBe("manual_required");
    expect(settled.result?.summary).toMatch(/^Saved Example, switched off\. The install stopped before it finished\./u);
    expect(h.deps.setReadsFree).not.toHaveBeenCalled();
  });

  it("keeps no staging step, so the operator's own confirmation reaches the approval skip", () => {
    const { adapter } = harness();
    expect("stage" in adapter).toBe(false);
    expect("shouldStage" in adapter).toBe(false);
  });

  it("waits in Inbox when the skip setting is off, and approving it there applies it", async () => {
    const h = harness({ skip: false });
    const plan = await h.service.create({ actor: OPERATOR, request: installRequest("example") });

    const waiting = await h.confirm(plan);

    expect(waiting.status).toBe("awaiting_approval");
    expect(waiting.requiredAction).toMatchObject({ kind: "approval", approvalId: "approval-install", risk: "danger" });
    expect(h.writes()).toEqual([]);

    h.approve();
    expect(await h.service.reconcileApproval("approval-install")).toBe(1);

    const applied = await h.service.get(OPERATOR, plan.planId);
    expect(applied.status).toBe("completed");
    expect(h.deps.setReadsFree).toHaveBeenCalledExactlyOnceWith(expect.anything(), "operator-1");
  });
});

describe("approving an install in Inbox", () => {
  const plan = (overrides: Partial<ChangePlanRecord> = {}) =>
    ({
      kind: "connector_install",
      request: installRequest("example"),
      origin: { surface: "capabilities", workspaceId: "default", actorId: "operator-1" },
      ...overrides,
    }) as ChangePlanRecord;

  // R59: the approval is the operator's last word on their own click, so it applies the install.
  it("applies a Capabilities install once approved, but nothing tied to a chat or a pending rollback", () => {
    expect(isAutoResumeOnApprovalPlan(plan())).toBe(true);
    expect(
      isAutoResumeOnApprovalPlan(
        plan({ origin: { surface: "capabilities", workspaceId: "default", sessionId: "session-1" } }),
      ),
    ).toBe(false);
    expect(
      isAutoResumeOnApprovalPlan(plan({ origin: { surface: "capabilities", workspaceId: "default", turnId: "t-1" } })),
    ).toBe(false);
    expect(
      isAutoResumeOnApprovalPlan(
        plan({ result: { summary: "Rollback waits.", failureCode: "rollback_approval_pending" } }),
      ),
    ).toBe(false);
    expect(isAutoResumeOnApprovalPlan(plan({ origin: { surface: "chat", workspaceId: "default" } }))).toBe(false);
  });
});

describe("reconciling an interrupted install", () => {
  it("reports what it finds and never writes", async () => {
    const h = harness({ allowlist: ["*.example.test"] });
    const plan = { ...(await h.service.create({ actor: OPERATOR, request: installRequest("example") })) };

    const missing = await h.adapter.reconcile({} as never, plan);
    expect(missing).toMatchObject({
      effectObserved: false,
      status: "manual_required",
      result: { failureCode: "connector_install_interrupted" },
    });
    expect(missing.result?.summary).toContain("Example isn't saved.");

    h.state.servers = [savedServer("Example")];
    const unrelaxed = await h.adapter.reconcile({} as never, plan);
    expect(unrelaxed).toMatchObject({ effectObserved: false, status: "manual_required" });
    expect(unrelaxed.result?.summary).toContain(
      "Example is saved, switched off, and everything it does asks you first.",
    );

    h.state.servers = [savedServer("Example", { policy: { ...POLICY, approvalPosture: "reads_free" } })];
    expect(await h.adapter.reconcile({} as never, plan)).toMatchObject({
      effectObserved: true,
      status: "completed",
      result: { summary: "Saved Example, switched off." },
    });
    expect(h.writes()).toEqual([]);
  });
});

describe("connectorInstallDependencies", () => {
  it("installs through the real MCP write owner and records Reading is free under the operator's name", async () => {
    const servers: McpServerRecord[] = [];
    const appendApprovalsAudit = vi.fn(async (_event: Record<string, unknown>) => undefined);
    const administration = {
      readMcpServers: async () => servers,
      writeMcpServers: async (next: McpServerRecord[]) => {
        servers.splice(0, servers.length, ...next);
        return [...servers];
      },
      publishRealtime: async () => undefined,
      appendApprovalsAudit,
    } as unknown as McpServerAdminHost;
    let settings = { revision: 4, networkAllowlist: ["api.openai.com"], features: {} };
    const gateway = {
      storage: { runImmediateTransaction: vi.fn(async <R>(work: () => R | Promise<R>) => await work()) },
      getSettings: vi.fn(async () => settings),
      updateSettings: vi.fn(async (update: { expectedRevision?: number; networkAllowlist?: string[] }) => {
        settings = { ...settings, revision: settings.revision + 1, ...update };
        return settings;
      }),
      listMcpServers: async () => servers,
    };
    const database = createDatabase({ dbPath: ":memory:" });
    databases.push(database);
    const sync = new ChangePlanRepository(database);
    const service = new EvolutionControlPlaneService({
      repository: {
        create: async (create: ChangePlanRepositoryCreateInput) => sync.create(create),
        get: async (planId: string) => sync.get(planId),
        list: async (query: ChangePlanRepositoryListInput) => sync.list(query),
        listActive: async (limit?: number) => sync.listActive(limit),
        transition: async (planId: string, transition: ChangePlanRepositoryTransitionInput) =>
          sync.transition(planId, transition),
      },
      adapters: new EvolutionControlPlaneAdapterRegistry([
        new ConnectorInstallChangePlanAdapter(connectorInstallDependencies(gateway as never, administration)),
      ]),
      allowsOperatorApprovalSkip: async () => true,
    });
    const actor = { ...OPERATOR, actorId: "token:ab12" };
    const plan = await service.create({ actor, request: installRequest("linear") });

    const settled = await service.confirm(actor, plan.planId, plan.revision, plan.requiredAction!.actionNonce, {
      operatorSettingsSave: true,
    });

    expect(settled.status).toBe("completed");
    expect(gateway.updateSettings).toHaveBeenCalledExactlyOnceWith({
      expectedRevision: 4,
      networkAllowlist: ["api.openai.com", "mcp.linear.app"],
    });
    expect(gateway.storage.runImmediateTransaction).toHaveBeenCalledTimes(1);
    expect(servers).toEqual([
      expect.objectContaining({
        label: "Linear",
        enabled: false,
        policy: expect.objectContaining({ approvalPosture: "reads_free" }),
      }),
    ]);
    expect(appendApprovalsAudit).toHaveBeenCalledExactlyOnceWith({
      event: "mcp_server_approval_posture_changed",
      serverId: servers[0]!.serverId,
      from: null,
      to: "reads_free",
      actorId: "token:ab12",
    });
  });
});
