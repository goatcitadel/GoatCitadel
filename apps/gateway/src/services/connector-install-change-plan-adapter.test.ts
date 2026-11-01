import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConflictError,
  type ChangePlanConnectorInstallRequest,
  type ChangePlanRecord,
  type DeploymentProfile,
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
import type { McpServerCreateOptions } from "./mcp-server-admin-service.js";
import { isAutoResumeOnApprovalPlan } from "./evolution-control-plane-approval-reconciliation.js";
import { EvolutionControlPlaneAdapterRegistry } from "./evolution-control-plane-adapter.js";
import { EvolutionControlPlaneService, type EvolutionControlPlaneActor } from "./evolution-control-plane-service.js";
import type { McpServerAdminHost } from "./mcp-server-admin-service.js";
import { MCP_SERVER_TEMPLATES } from "./mcp-server-templates.js";

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
  template({
    templateId: "plain",
    label: "Plain",
    authType: "none",
    oauth: undefined,
    networkHosts: ["mcp.plain.test"],
  }),
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
    // Saved now, so a server a test saves after making its plan counts as saved after it.
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** In-memory owners. Settings writes are fenced by revision, as the real settings owner fences them. */
function owners(
  input: {
    servers?: McpServerRecord[];
    allowlist?: string[];
    chat?: boolean;
    profile?: DeploymentProfile;
    templates?: readonly McpServerTemplateRecord[];
  } = {},
) {
  const state = {
    servers: [...(input.servers ?? [])],
    settings: {
      revision: 1,
      networkAllowlist: [...(input.allowlist ?? [])],
      features: { chatStaticMcpV1Enabled: input.chat ?? false },
    },
  };
  const deps = {
    templates: input.templates ?? TEMPLATES,
    readMcpServers: vi.fn(async () => [...state.servers]),
    readSettings: vi.fn(async () => ({
      revision: state.settings.revision,
      deploymentProfile: input.profile ?? ("local_dev" as const),
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
    createMcpServer: vi.fn(async (create: McpServerCreateInput, options?: McpServerCreateOptions) => {
      // The real owner runs this against the list it reads inside the write, in the same step as the save.
      options?.assertUnique?.(state.servers);
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
    expect(h.deps.createMcpServer).toHaveBeenCalledExactlyOnceWith(
      {
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
      },
      { assertUnique: expect.any(Function) },
    );
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

  // R92: the one-button install switches the app on and connects it after approval, so the approval says so.
  it("says what happens after approval: saved switched off, then switched on and connected", async () => {
    const h = harness({ allowlist: ["*.example.test"] });
    const signsIn = await h.service.create({ actor: OPERATOR, request: installRequest("example") });
    expect(signsIn.summary).toBe("Save Example, switched off, set to Reading is free.");
    expect(signsIn.impact).toBe(
      "After you approve, Example is saved switched off. Once you sign in, Capabilities switches it on and connects " +
        "it, unless you stop it. It can read and change your tickets.",
    );
    expect(signsIn.impact).not.toContain("stays switched off");

    const plain = await harness().service.create({ actor: OPERATOR, request: installRequest("plain") });
    expect(plain.impact).toBe(
      "Any tool can reach an allowed host, not only this connector. After you approve, Plain is saved switched off, " +
        "then Capabilities switches it on and connects it, unless you stop it.",
    );
  });

  // R49: a remote_hardened install never lets a connector's call run on its own, so the plan doesn't promise it.
  it("says every action asks first on a remote_hardened install instead of Reading is free", async () => {
    const h = harness({ allowlist: ["*.example.test"], profile: "remote_hardened" });

    const plan = await h.service.create({ actor: OPERATOR, request: installRequest("example") });

    expect(plan.summary).toBe("Save Example, switched off. On this install every action it takes asks you first.");
    expect(plan.requiredAction).toMatchObject({ kind: "confirmation", confirmationText: plan.summary });
    expect(plan.requiredAction).not.toMatchObject({ confirmationText: expect.stringContaining("Reading is free") });
  });

  // The connection goes through the allowlist, so an install that left its endpoint out couldn't connect.
  it("allows a shipped remote template's own endpoint", async () => {
    const h = harness({ templates: MCP_SERVER_TEMPLATES });
    const plan = await h.service.create({ actor: OPERATOR, request: installRequest("microsoft-learn") });

    expect(plan.summary).toContain("Allow learn.microsoft.com.");
    await h.confirm(plan);
    expect(h.state.settings.networkAllowlist).toEqual(["learn.microsoft.com"]);
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

  it("saves a connector once when two installs of it run at the same time", async () => {
    // Hosts already allowed, so the settings revision fence is not what stops the second install.
    const h = harness({ allowlist: ["*.example.test"] });
    const first = await h.service.create({ actor: OPERATOR, request: installRequest("example") });
    // One active plan per target and workspace, so the second operator installs from another workspace.
    const otherWorkspace = { ...OPERATOR, workspaceId: "other" };
    const second = await h.service.create({ actor: otherWorkspace, request: installRequest("example") });
    // Both installs read the saved servers (empty) before either one writes.
    const real = h.deps.readMcpServers.getMockImplementation()!;
    let reads = 0;
    let release!: () => void;
    const bothRead = new Promise<void>((resolve) => (release = resolve));
    h.deps.readMcpServers.mockImplementation(async () => {
      const snapshot = await real();
      if (++reads <= 2) {
        if (reads === 2) release();
        await bothRead;
      }
      return snapshot;
    });

    const settled = await Promise.all([h.confirm(first), h.confirm(second, otherWorkspace)]);

    expect(h.state.servers.filter((server) => server.label === "Example")).toHaveLength(1);
    const completed = settled.filter((plan) => plan.status === "completed");
    expect(completed).toHaveLength(1);
    const other = settled.find((plan) => plan.status !== "completed")!;
    expect(other.evidenceRefs).toContain(`mcp_server:${h.state.servers[0]!.serverId}`);
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

  // R79: the summary is plain sentences only, ending with what to do next; the owner's own error text is kept apart.
  describe("when a step fails", () => {
    it("says nothing changed and that trying again is safe when the hosts can't be allowed", async () => {
      const h = harness();
      h.deps.updateSettings.mockRejectedValueOnce(new Error("The settings file is locked."));

      const settled = await h.install(installRequest("example", true));

      expect(settled.status).toBe("failed");
      expect(settled.result).toEqual({
        summary: "Couldn't allow mcp.example.test, auth.example.test. Nothing was changed, so trying again is safe.",
        failureCode: "connector_install_allowlist_failed",
        failureDetail: "The settings file is locked.",
      });
      expect(h.deps.createMcpServer).not.toHaveBeenCalled();
    });

    it("names each finished step and says trying again is safe when the save fails", async () => {
      const h = harness();
      h.deps.createMcpServer.mockRejectedValueOnce(new Error("MCP configuration changed."));

      const settled = await h.install(installRequest("example", true));

      expect(settled.status).toBe("manual_required");
      expect(settled.result).toEqual({
        summary: "Allowed mcp.example.test, auth.example.test. Couldn't save Example. Trying again is safe.",
        failureCode: "connector_install_save_failed",
        failureDetail: "MCP configuration changed.",
      });
      expect(h.deps.setReadsFree).not.toHaveBeenCalled();
      expect(h.state.settings.features.chatStaticMcpV1Enabled).toBe(false);
    });

    it("says everything still asks, and where to change it, when Reading is free couldn't be saved", async () => {
      const h = harness({ allowlist: ["*.example.test"] });
      h.deps.setReadsFree.mockRejectedValueOnce(new Error("MCP configuration changed."));

      const settled = await h.install(installRequest("example"));

      expect(settled.status).toBe("manual_required");
      expect(settled.result).toEqual({
        summary:
          "Saved Example, switched off. Couldn't set Example to Reading is free, so everything it does asks you first. " +
          "You can choose Reading is free under What asks first in its panel.",
        failureCode: "connector_install_posture_failed",
        failureDetail: "MCP configuration changed.",
      });
      // M3: the saved server is named, so Capabilities hands the panel to it instead of offering Install again.
      expect(settled.evidenceRefs).toEqual(["mcp_template:example", "mcp_server:server-1"]);
    });

    it("says Chat can't use it yet, and where to look, when connectors in Chat couldn't be turned on", async () => {
      const h = harness({ allowlist: ["*.example.test"] });
      h.deps.updateSettings.mockRejectedValueOnce(new Error("Settings changed elsewhere."));

      const settled = await h.install(installRequest("example", true));

      expect(settled.status).toBe("manual_required");
      expect(settled.result).toEqual({
        summary:
          "Saved Example, switched off. Couldn't let Chat use connectors, so Chat can't use Example yet. " +
          "Its panel links to Chat access in Settings.",
        failureCode: "connector_install_chat_flag_failed",
        failureDetail: "Settings changed elsewhere.",
      });
      expect(settled.evidenceRefs).toEqual(["mcp_template:example", "mcp_server:server-1"]);
      expect(h.state.servers).toEqual([
        expect.objectContaining({ policy: { ...POLICY, approvalPosture: "reads_free" } }),
      ]);
    });

    // A save can report a failed follow-up after it landed, or be rolled back with its transaction: what the owner
    // holds afterwards decides what the summary says.
    it("goes by what was saved, not by the step's error", async () => {
      const rolledBack = harness({ allowlist: ["*.example.test"] });
      rolledBack.deps.createMcpServer.mockRejectedValueOnce(
        Object.assign(new Error("MCP configuration committed but follow-up work failed."), { mutationCommitted: true }),
      );
      const notSaved = await rolledBack.install(installRequest("example"));
      expect(notSaved.result).toEqual({
        summary: "Couldn't save Example. Trying again is safe.",
        failureCode: "connector_install_save_failed",
        failureDetail: "MCP configuration committed but follow-up work failed.",
      });
      // Nothing is saved, so there is no server to name and the template can be installed again.
      expect(notSaved.evidenceRefs).toEqual(["mcp_template:example"]);

      const landed = harness({ allowlist: ["*.example.test"] });
      landed.deps.createMcpServer.mockImplementationOnce(async (create: McpServerCreateInput) => {
        landed.state.servers = [savedServer(create.label)];
        throw new Error("Realtime publish failed.");
      });
      const settled = await landed.install(installRequest("example"));
      expect(settled.status).toBe("manual_required");
      expect(settled.result).toMatchObject({
        summary:
          "Saved Example, switched off. Couldn't set Example to Reading is free, so everything it does asks you first. " +
          "You can choose Reading is free under What asks first in its panel.",
        failureCode: "connector_install_save_failed",
      });
      expect(settled.evidenceRefs).toEqual(["mcp_template:example", "mcp_server:saved-Example"]);
      expect(landed.deps.setReadsFree).not.toHaveBeenCalled();
    });

    it("names the saved server from the step it reached when the read after a failure fails too", async () => {
      const h = harness({ allowlist: ["*.example.test"] });
      const plan = await h.service.create({ actor: OPERATOR, request: installRequest("example") });
      h.deps.setReadsFree.mockRejectedValueOnce(new Error("MCP configuration changed."));
      // Apply's own check reads the list, then the read after the failure can't.
      h.deps.readMcpServers
        .mockImplementationOnce(async () => [...h.state.servers])
        .mockRejectedValueOnce(new Error("The MCP list is unreadable."));

      const settled = await h.confirm(plan);

      expect(settled.status).toBe("manual_required");
      expect(settled.evidenceRefs).toEqual(["mcp_template:example", "mcp_server:server-1"]);
    });

    it("keeps the owner's error text out of the summary, redacted and bounded", async () => {
      const h = harness({ allowlist: ["*.example.test"] });
      const secret = "abc123def456ghi789jkl0123";
      h.deps.createMcpServer.mockRejectedValueOnce(
        new Error(
          ["SQLITE_BUSY: database is locked (gateway.db)", `Authorization: Bearer ${secret}`, "x".repeat(400)].join(
            "\n",
          ),
        ),
      );

      const result = (await h.install(installRequest("example"))).result!;

      expect(result.summary).toBe("Couldn't save Example. Trying again is safe.");
      expect(result.failureDetail).toMatch(/^SQLITE_BUSY: database is locked \(gateway\.db\) Authorization: /u);
      expect(result.failureDetail).not.toContain(secret);
      expect(result.failureDetail).not.toMatch(/[\r\n]/u);
      expect(result.failureDetail!.length).toBeLessThanOrEqual(300);
    });

    it("leaves the detail out when the failure carries no message", async () => {
      const h = harness({ allowlist: ["*.example.test"] });
      h.deps.createMcpServer.mockRejectedValueOnce("not an error");

      const result = (await h.install(installRequest("example"))).result!;

      expect(result).toEqual({
        summary: "Couldn't save Example. Trying again is safe.",
        failureCode: "connector_install_save_failed",
      });
    });
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
    expect(missing.evidenceRefs).toBeUndefined();

    h.state.servers = [savedServer("Example")];
    const unrelaxed = await h.adapter.reconcile({} as never, plan);
    expect(unrelaxed).toMatchObject({ effectObserved: false, status: "manual_required" });
    expect(unrelaxed.result?.summary).toContain(
      "Example is saved, switched off, and everything it does asks you first.",
    );
    // M3: the saved server is named so Capabilities hands its panel over to it.
    expect(unrelaxed.evidenceRefs).toEqual(["mcp_template:example", "mcp_server:saved-Example"]);

    h.state.servers = [savedServer("Example", { policy: { ...POLICY, approvalPosture: "reads_free" } })];
    expect(await h.adapter.reconcile({} as never, plan)).toMatchObject({
      effectObserved: true,
      status: "completed",
      result: { summary: "Saved Example, switched off." },
    });
    expect(h.writes()).toEqual([]);
  });

  // A matching label is no authority: a server saved some other way would otherwise be reported as this install's
  // effect, and Capabilities would switch it on and connect it.
  it.each([
    ["a different endpoint", { url: "https://elsewhere.test/mcp" }],
    ["a different command", { transport: "stdio" as const, url: undefined, command: "npx", args: ["-y", "other"] }],
    ["a different sign-in kind", { authType: "none" as const }],
    ["a save from before the plan was made", { createdAt: "2026-01-01T00:00:00.000Z" }],
  ])("doesn't take a same-named server with %s as this install's", async (_name, overrides) => {
    const h = harness({ allowlist: ["*.example.test"], chat: true });
    const plan = await h.service.create({ actor: OPERATOR, request: installRequest("example") });
    h.state.servers = [savedServer("example", { ...overrides, policy: { ...POLICY, approvalPosture: "reads_free" } })];

    const settled = await h.adapter.reconcile({} as never, plan);

    expect(settled).toMatchObject({ effectObserved: false, status: "manual_required" });
    expect(settled.result?.summary).toBe(
      "The install stopped before it finished. Another connector named Example is saved, so this install didn't save one.",
    );
    expect(settled.evidenceRefs).toBeUndefined();
    expect(h.writes()).toEqual([]);
  });

  it("takes a server saved with the template's configuration, however a save trims it", async () => {
    const h = harness({ allowlist: ["*.example.test"] });
    const plan = await h.service.create({ actor: OPERATOR, request: installRequest("example") });
    h.state.servers = [
      savedServer("EXAMPLE", { serverId: "ours", policy: { ...POLICY, approvalPosture: "reads_free" }, args: [] }),
    ];

    expect(await h.adapter.reconcile({} as never, plan)).toMatchObject({
      effectObserved: true,
      status: "completed",
      evidenceRefs: ["mcp_template:example", "mcp_server:ours"],
    });
  });

  it("names no server after a failed save when only someone else's same-named server is there", async () => {
    const h = harness({ allowlist: ["*.example.test"] });
    h.deps.createMcpServer.mockImplementationOnce(async () => {
      h.state.servers = [savedServer("Example", { url: "https://elsewhere.test/mcp" })];
      throw new Error("Realtime publish failed.");
    });

    const settled = await h.install(installRequest("example"));

    expect(settled.result).toMatchObject({
      summary: "Couldn't save Example. Trying again is safe.",
      failureCode: "connector_install_save_failed",
    });
    expect(settled.evidenceRefs).toEqual(["mcp_template:example"]);
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
