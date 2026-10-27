import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  ConflictError,
  type CapabilityConnectorsResponse,
  type ChangePlanRecord,
  type McpServerRecord,
} from "@goatcitadel/contracts";
import {
  ChangePlanRepository,
  createDatabase,
  type ChangePlanRepositoryCreateInput,
  type ChangePlanRepositoryListInput,
  type ChangePlanRepositoryTransitionInput,
} from "@goatcitadel/storage";
import { ConnectorInstallChangePlanAdapter } from "../services/connector-install-change-plan-adapter.js";
import { EvolutionControlPlaneAdapterRegistry } from "../services/evolution-control-plane-adapter.js";
import { EvolutionControlPlaneService } from "../services/evolution-control-plane-service.js";
import { MCP_SERVER_TEMPLATES } from "../services/mcp-server-templates.js";
import { capabilityConnectorsRoutes } from "./capability-connectors.js";

const RESPONSE: CapabilityConnectorsResponse = {
  workspaceId: "default",
  items: [
    {
      id: "web-search:search.brave",
      name: "Brave Search",
      description: "Search the web with your Brave Search key.",
      kind: "built_in",
      source: "web_search",
      category: "search",
      state: "connected",
      reason: "ready",
      group: "connected",
      auth: "api_key",
      runsOnThisDevice: false,
      networkHosts: [],
      chat: { available: true },
      hiddenInWorkspace: false,
    },
  ],
  issues: [],
  approvalReliefAvailable: true,
  generatedAt: "2026-10-25T00:00:00.000Z",
};

describe("capability connectors route", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  async function build(services: Record<string, unknown>) {
    app = Fastify();
    app.decorateRequest("authActorId", "operator-test");
    app.decorate("services", services as never);
    await app.register(capabilityConnectorsRoutes);
    return app;
  }

  it("returns the connector list for a workspace", async () => {
    const list = vi.fn(async () => RESPONSE);
    const server = await build({ capabilityConnectors: { list } });

    const response = await server.inject({ method: "GET", url: "/api/v1/capabilities/connectors?workspaceId=default" });

    expect(response.statusCode).toBe(200);
    expect(response.json().items).toHaveLength(1);
    expect(response.json()).toEqual(RESPONSE);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(list).toHaveBeenCalledWith("default");
  });

  it("rejects unknown query fields", async () => {
    const list = vi.fn(async () => RESPONSE);
    const server = await build({ capabilityConnectors: { list } });

    const response = await server.inject({
      method: "GET",
      url: "/api/v1/capabilities/connectors?workspaceId=default&live=1",
    });

    expect(response.statusCode).toBe(400);
    expect(list).not.toHaveBeenCalled();
  });

  it.each([
    ["a missing workspace id", "/api/v1/capabilities/connectors"],
    ["an empty workspace id", "/api/v1/capabilities/connectors?workspaceId="],
    ["an overlong workspace id", `/api/v1/capabilities/connectors?workspaceId=${"w".repeat(201)}`],
  ])("rejects %s", async (_label, url) => {
    const list = vi.fn(async () => RESPONSE);
    const server = await build({ capabilityConnectors: { list } });

    const response = await server.inject({ method: "GET", url });

    expect(response.statusCode).toBe(400);
    expect(list).not.toHaveBeenCalled();
  });

  it("answers 503 when the connector list is not composed", async () => {
    const server = await build({});

    const response = await server.inject({ method: "GET", url: "/api/v1/capabilities/connectors?workspaceId=default" });

    expect(response.statusCode).toBe(503);
  });

  it("answers 500 without echoing an unexpected failure", async () => {
    const list = vi.fn(async () => {
      throw new Error("db password hunter2");
    });
    const server = await build({ capabilityConnectors: { list } });

    const response = await server.inject({ method: "GET", url: "/api/v1/capabilities/connectors?workspaceId=default" });

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("hunter2");
  });

  describe("installing a connector", () => {
    const INSTALL = "/api/v1/capabilities/connectors/install";
    const CONFIRMATION = { kind: "confirmation", actionId: "action-1", actionNonce: "nonce-install-1234" };

    /** A control plane that prepares a plan for confirmation and settles it as `settled` says. */
    function mockedEvolution(settled: Partial<ChangePlanRecord>) {
      return {
        isEnabled: vi.fn(async () => true),
        create: vi.fn(async () => ({ planId: "plan-install", revision: 1, requiredAction: CONFIRMATION })),
        confirm: vi.fn(async () => ({
          planId: "plan-install",
          revision: 3,
          risk: "danger",
          summary: "Allow mcp.linear.app. Save Linear, switched off.",
          ...settled,
        })),
      };
    }

    it("returns a receipt that waits in Inbox when the skip setting is off", async () => {
      const approval = { kind: "approval", actionId: "action-2", actionNonce: "n", title: "Approve", risk: "danger" };
      const evolution = mockedEvolution({
        status: "awaiting_approval",
        requiredAction: { ...approval, approvalId: "approval-1" } as ChangePlanRecord["requiredAction"],
      });
      const server = await build({ evolution });

      const response = await server.inject({
        method: "POST",
        url: INSTALL,
        payload: { templateId: "linear", enableChatConnectors: true },
      });

      expect(response.statusCode).toBe(202);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).toEqual({
        templateId: "linear",
        changePlanReceipt: {
          planId: "plan-install",
          status: "awaiting_approval",
          revision: 3,
          risk: "danger",
          requiredAction: { ...approval, approvalId: "approval-1" },
          summary: "Allow mcp.linear.app. Save Linear, switched off.",
        },
      });
      const actor = expect.objectContaining({
        workspaceId: "default",
        actorId: "operator-test",
        surface: "capabilities",
      });
      expect(evolution.create).toHaveBeenCalledWith(
        expect.objectContaining({
          actor,
          request: { kind: "connector_install", templateId: "linear", enableChatConnectors: true },
        }),
      );
      // The install is the operator's own action, so it may ask for the opt-in approval skip.
      expect(evolution.confirm).toHaveBeenCalledWith(actor, "plan-install", 1, "nonce-install-1234", {
        operatorSettingsSave: true,
      });
    });

    it("completes when the skip setting is on", async () => {
      const evolution = mockedEvolution({
        status: "completed",
        result: { summary: "Allowed mcp.linear.app. Saved Linear, switched off." },
      });
      const server = await build({ evolution });

      const response = await server.inject({
        method: "POST",
        url: INSTALL,
        payload: { templateId: "linear", enableChatConnectors: false },
      });

      expect(response.statusCode).toBe(202);
      expect(response.json().changePlanReceipt).toEqual({
        planId: "plan-install",
        status: "completed",
        revision: 3,
        risk: "danger",
        summary: "Allowed mcp.linear.app. Saved Linear, switched off.",
      });
    });

    it("rejects extra body fields", async () => {
      const evolution = mockedEvolution({ status: "completed" });
      const server = await build({ evolution });

      for (const payload of [
        { templateId: "linear", enableChatConnectors: true, approvalPosture: "nothing_asks" },
        { templateId: "linear", enableChatConnectors: true, workspaceId: "other" },
        { templateId: "linear" },
        { templateId: "", enableChatConnectors: true },
        { templateId: "t".repeat(201), enableChatConnectors: true },
        { templateId: "linear", enableChatConnectors: "yes" },
      ]) {
        const response = await server.inject({ method: "POST", url: INSTALL, payload });
        expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      }
      expect(evolution.create).not.toHaveBeenCalled();
    });

    it("refuses a body over 20 KiB before reading it, like the other operator saves", async () => {
      const evolution = mockedEvolution({ status: "completed" });
      const server = await build({ evolution });

      const response = await server.inject({
        method: "POST",
        url: INSTALL,
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ templateId: "linear", enableChatConnectors: true, padding: "x".repeat(21 * 1_024) }),
      });

      expect(response.statusCode).toBe(413);
      expect(evolution.create).not.toHaveBeenCalled();
    });

    it("passes a refusal through as a 409 naming its field", async () => {
      const evolution = mockedEvolution({ status: "completed" });
      evolution.create.mockRejectedValueOnce(
        new ConflictError({
          message: "Keyed needs an API key. Set it up in Settings.",
          details: { field: "needsApiKey" },
        }),
      );
      const server = await build({ evolution });

      const response = await server.inject({
        method: "POST",
        url: INSTALL,
        payload: { templateId: "keyed", enableChatConnectors: false },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: "Keyed needs an API key. Set it up in Settings.",
        details: { field: "needsApiKey" },
      });
      expect(evolution.confirm).not.toHaveBeenCalled();
    });

    it("answers 503 when Change Plans are off or not composed", async () => {
      const evolution = mockedEvolution({ status: "completed" });
      evolution.isEnabled.mockResolvedValueOnce(false);
      for (const services of [{ evolution }, {}]) {
        const server = await build(services);
        const response = await server.inject({
          method: "POST",
          url: INSTALL,
          payload: { templateId: "linear", enableChatConnectors: false },
        });
        expect(response.statusCode).toBe(503);
        await server.close();
        app = null;
      }
      expect(evolution.create).not.toHaveBeenCalled();
    });

    describe("through the real control plane", () => {
      const databases: Array<ReturnType<typeof createDatabase>> = [];
      afterEach(() => {
        for (const database of databases.splice(0)) database.close();
      });

      /** The real service and install adapter on a migrated SQLite ledger; only the owners and approvals are faked. */
      function controlPlane(skip: boolean, saveFailure?: Error) {
        const database = createDatabase({ dbPath: ":memory:" });
        databases.push(database);
        const sync = new ChangePlanRepository(database);
        const servers: McpServerRecord[] = [];
        let settings = {
          revision: 1,
          deploymentProfile: "local_dev" as const,
          networkAllowlist: ["api.openai.com"],
          features: { chatStaticMcpV1Enabled: false },
        };
        const relaxedBy = vi.fn((_actorId: string) => undefined);
        const adapter = new ConnectorInstallChangePlanAdapter({
          templates: MCP_SERVER_TEMPLATES,
          readMcpServers: async () => [...servers],
          readSettings: async () => settings,
          updateSettings: async (update) => {
            settings = {
              ...settings,
              revision: settings.revision + 1,
              networkAllowlist: update.networkAllowlist ?? settings.networkAllowlist,
              features: { ...settings.features, ...update.features },
            };
          },
          createMcpServer: async (input) => {
            if (saveFailure) throw saveFailure;
            const server = {
              ...input,
              serverId: "server-1",
              authType: input.authType ?? "none",
              enabled: input.enabled ?? true,
              category: input.category ?? "other",
              trustTier: input.trustTier ?? "restricted",
              costTier: input.costTier ?? "unknown",
              policy: {
                requireFirstToolApproval: true,
                redactionMode: "basic",
                allowedToolPatterns: [],
                blockedToolPatterns: [],
              },
              status: "disconnected",
              createdAt: "2026-10-27T00:00:00.000Z",
              updatedAt: "2026-10-27T00:00:00.000Z",
            } satisfies McpServerRecord;
            servers.push(server);
            return server;
          },
          setReadsFree: async (server, actorId) => {
            relaxedBy(actorId);
            const relaxed = { ...server, policy: { ...server.policy, approvalPosture: "reads_free" as const } };
            servers.splice(servers.indexOf(server), 1, relaxed);
            return relaxed;
          },
        });
        let disposition: "approved" | "pending" = "pending";
        const service = new EvolutionControlPlaneService({
          repository: {
            create: async (create: ChangePlanRepositoryCreateInput) => sync.create(create),
            get: async (planId: string) => sync.get(planId),
            list: async (query: ChangePlanRepositoryListInput) => sync.list(query),
            listActive: async (limit?: number) => sync.listActive(limit),
            listAwaitingApproval: async (approvalId: string, limit?: number) =>
              sync.listAwaitingApproval(approvalId, limit),
            transition: async (planId: string, transition: ChangePlanRepositoryTransitionInput) =>
              sync.transition(planId, transition),
          },
          adapters: new EvolutionControlPlaneAdapterRegistry([adapter]),
          allowsOperatorApprovalSkip: async () => skip,
          createApproval: async () => "approval-install",
          getApprovalDisposition: async () => disposition,
        });
        return {
          service,
          sync,
          servers,
          relaxedBy,
          settings: () => settings,
          approve: () => {
            disposition = "approved";
          },
        };
      }

      const install = (server: FastifyInstance) =>
        server.inject({ method: "POST", url: INSTALL, payload: { templateId: "linear", enableChatConnectors: true } });

      it("completes the install, and records the skipped approval, when the skip setting is on", async () => {
        const plane = controlPlane(true);
        const server = await build({ evolution: plane.service });

        const response = await install(server);

        expect(response.statusCode).toBe(202);
        const receipt = response.json().changePlanReceipt;
        expect(receipt).toMatchObject({
          status: "completed",
          risk: "danger",
          summary: "Allowed mcp.linear.app. Saved Linear, switched off. Let Chat use connectors.",
        });
        expect(plane.sync.listEvents(receipt.planId)).toContainEqual(
          expect.objectContaining({
            eventType: "operator_approval_skipped",
            actorId: "operator-test",
            payload: { risk: "danger", reason: "settings_approval_skip_enabled" },
          }),
        );
        expect(plane.settings()).toMatchObject({
          networkAllowlist: ["api.openai.com", "mcp.linear.app"],
          features: { chatStaticMcpV1Enabled: true },
        });
        expect(plane.servers).toEqual([
          expect.objectContaining({
            label: "Linear",
            enabled: false,
            policy: expect.objectContaining({ approvalPosture: "reads_free" }),
          }),
        ]);
        expect(plane.relaxedBy).toHaveBeenCalledExactlyOnceWith("operator-test");
      });

      it("waits in Inbox when the skip setting is off, then applies once approved there", async () => {
        const plane = controlPlane(false);
        const server = await build({ evolution: plane.service });

        const response = await install(server);

        expect(response.statusCode).toBe(202);
        const receipt = response.json().changePlanReceipt;
        expect(receipt).toMatchObject({
          status: "awaiting_approval",
          requiredAction: { kind: "approval", approvalId: "approval-install", risk: "danger" },
        });
        expect(plane.servers).toEqual([]);
        expect(plane.settings().revision).toBe(1);

        plane.approve();
        expect(await plane.service.reconcileApproval("approval-install")).toBe(1);

        const actor = { workspaceId: "default", actorId: "operator-test", surface: "capabilities" as const };
        expect(await plane.service.get(actor, receipt.planId)).toMatchObject({
          status: "completed",
          result: { summary: "Allowed mcp.linear.app. Saved Linear, switched off. Let Chat use connectors." },
        });
        expect(plane.servers).toEqual([expect.objectContaining({ label: "Linear", enabled: false })]);
        // The operator who asked for the install is named, not the approval resolution that resumed it.
        expect(plane.relaxedBy).toHaveBeenCalledExactlyOnceWith("operator-test");
      });

      // R79: the receipt's summary stays plain; the owner's error text is only on the plan, for technical details.
      it("keeps a failed step's error text out of the receipt", async () => {
        const plane = controlPlane(true, new Error("SQLITE_BUSY: database is locked"));
        const server = await build({ evolution: plane.service });

        const response = await install(server);

        expect(response.statusCode).toBe(202);
        const receipt = response.json().changePlanReceipt;
        expect(receipt).toMatchObject({
          status: "manual_required",
          summary: "Allowed mcp.linear.app. Couldn't save Linear. Trying again is safe.",
        });
        expect(response.body).not.toContain("SQLITE_BUSY");
        const actor = { workspaceId: "default", actorId: "operator-test", surface: "capabilities" as const };
        expect((await plane.service.get(actor, receipt.planId)).result).toEqual({
          summary: "Allowed mcp.linear.app. Couldn't save Linear. Trying again is safe.",
          failureCode: "connector_install_save_failed",
          failureDetail: "SQLITE_BUSY: database is locked",
        });
      });
    });
  });
});
