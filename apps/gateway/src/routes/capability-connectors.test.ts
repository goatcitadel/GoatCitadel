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
  MutationIdempotencyRepository,
  type ChangePlanRepositoryCreateInput,
  type ChangePlanRepositoryListInput,
  type ChangePlanRepositoryTransitionInput,
} from "@goatcitadel/storage";
import { idempotencyHeaderPlugin } from "../plugins/idempotency.js";
import type { MutationIdempotencyStore } from "../services/mutation-idempotency-store.js";
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

  /**
   * `idempotency` adds the Gateway's Idempotency-Key plugin, so a retry names its first try; with a `store`, the
   * plugin records each attempt as the Gateway does.
   */
  async function build(
    services: Record<string, unknown>,
    options: { idempotency?: { store?: MutationIdempotencyStore } } = {},
  ) {
    app = Fastify();
    app.decorateRequest("authActorId", "operator-test");
    app.decorate("services", services as never);
    if (options.idempotency) {
      await app.register(idempotencyHeaderPlugin, { mutationStore: options.idempotency.store });
    }
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
        findByIdempotencyKey: vi.fn(async () => undefined),
        create: vi.fn(async () => ({
          planId: "plan-install",
          status: "awaiting_confirmation",
          revision: 1,
          requiredAction: CONFIRMATION,
        })),
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

    it("confirms a plan an earlier try made only while it still waits for its own apply confirmation", async () => {
      const replay = (requiredAction: Record<string, unknown>, status = "awaiting_confirmation") => ({
        planId: "plan-install",
        revision: 2,
        risk: "danger",
        status,
        summary: "Allow mcp.linear.app. Save Linear, switched off.",
        request: { kind: "connector_install", templateId: "linear", enableChatConnectors: true },
        origin: { workspaceId: "default", surface: "capabilities", actorId: "operator-test" },
        requiredAction,
      });
      const send = (server: FastifyInstance) =>
        server.inject({ method: "POST", url: INSTALL, payload: { templateId: "linear", enableChatConnectors: true } });

      const rollback = mockedEvolution({ status: "completed" });
      rollback.findByIdempotencyKey.mockResolvedValueOnce(replay({ ...CONFIRMATION, purpose: "rollback" }) as never);
      const refused = await send(await build({ evolution: rollback }));
      expect(refused.statusCode).toBe(202);
      expect(refused.json().changePlanReceipt).toMatchObject({
        planId: "plan-install",
        status: "awaiting_confirmation",
      });
      expect(rollback.confirm).not.toHaveBeenCalled();
      expect(rollback.create).not.toHaveBeenCalled();
      await app?.close();

      const pending = mockedEvolution({ status: "completed" });
      pending.findByIdempotencyKey.mockResolvedValueOnce(replay({ ...CONFIRMATION, purpose: "apply" }) as never);
      const confirmed = await send(await build({ evolution: pending }));
      expect(confirmed.statusCode).toBe(202);
      expect(pending.confirm).toHaveBeenCalledOnce();
      expect(pending.create).not.toHaveBeenCalled();
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

    it("answers 503 naming its own reason when Change Plans are off or not composed (M5)", async () => {
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
        // The reason is data, so Capabilities can say so plainly instead of showing a generic error.
        expect(response.json()).toMatchObject({ details: { reason: "change_plans_off" } });
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
        const createApproval = vi.fn(async () => "approval-install");
        const service = new EvolutionControlPlaneService({
          repository: {
            create: async (create: ChangePlanRepositoryCreateInput) => sync.create(create),
            get: async (planId: string) => sync.get(planId),
            list: async (query: ChangePlanRepositoryListInput) => sync.list(query),
            listActive: async (limit?: number) => sync.listActive(limit),
            listAwaitingApproval: async (approvalId: string, limit?: number) =>
              sync.listAwaitingApproval(approvalId, limit),
            findByIdempotency: async (workspaceId: string, key: string) => sync.findByIdempotency(workspaceId, key),
            transition: async (planId: string, transition: ChangePlanRepositoryTransitionInput) =>
              sync.transition(planId, transition),
          },
          adapters: new EvolutionControlPlaneAdapterRegistry([adapter]),
          allowsOperatorApprovalSkip: async () => skip,
          createApproval,
          getApprovalDisposition: async () => disposition,
        });
        // The Gateway's own record of each HTTP attempt, on the same ledger database.
        const attempts = new MutationIdempotencyRepository(database);
        const attemptStore: MutationIdempotencyStore = {
          claim: async (input) => attempts.claim(input),
          markCompleted: async (input) => attempts.markCompleted(input),
          markFailed: async (input) => attempts.markFailed(input),
        };
        return {
          service,
          sync,
          servers,
          relaxedBy,
          createApproval,
          attemptStore,
          settings: () => settings,
          approve: () => {
            disposition = "approved";
          },
        };
      }

      const install = (server: FastifyInstance) =>
        server.inject({ method: "POST", url: INSTALL, payload: { templateId: "linear", enableChatConnectors: true } });
      /** One attempt under the Idempotency-Key a client keeps for it; sending it again is a retry of that attempt. */
      const attempt = (server: FastifyInstance, key: string, enableChatConnectors = true) =>
        server.inject({
          method: "POST",
          url: INSTALL,
          headers: { "idempotency-key": key },
          payload: { templateId: "linear", enableChatConnectors },
        });

      // M8: a retry of a request whose answer was lost gets that answer, never a refusal or a second install. The
      // Gateway's attempt record passes an exact retry of a finished attempt on to this route, which answers it.
      describe("a retried request", () => {
        it("gets the receipt its first try got while the install waits in Inbox", async () => {
          const plane = controlPlane(false);
          const server = await build({ evolution: plane.service }, { idempotency: { store: plane.attemptStore } });

          const first = await attempt(server, "attempt-inbox");
          const retried = await attempt(server, "attempt-inbox");

          expect(first.statusCode).toBe(202);
          expect(first.json().changePlanReceipt).toMatchObject({ status: "awaiting_approval" });
          expect(retried.statusCode).toBe(202);
          expect(retried.json()).toEqual(first.json());
          expect(plane.createApproval).toHaveBeenCalledOnce();
          expect(plane.sync.list({ workspaceId: "default" })).toHaveLength(1);
        });

        it("gets its receipt once the install finished, rather than being refused as already saved", async () => {
          const plane = controlPlane(true);
          const server = await build({ evolution: plane.service }, { idempotency: { store: plane.attemptStore } });

          const first = await attempt(server, "attempt-done");
          const retried = await attempt(server, "attempt-done");

          expect(first.json().changePlanReceipt).toMatchObject({ status: "completed" });
          expect(retried.statusCode).toBe(202);
          expect(retried.json()).toEqual(first.json());
          expect(plane.servers).toHaveLength(1);
          expect(plane.relaxedBy).toHaveBeenCalledOnce();
        });

        it("is refused when it asks for a different install under the same key", async () => {
          const plane = controlPlane(false);
          const server = await build({ evolution: plane.service }, { idempotency: { store: plane.attemptStore } });

          await attempt(server, "attempt-changed", true);
          const changed = await attempt(server, "attempt-changed", false);

          expect(changed.statusCode).toBe(409);
          expect(changed.json()).toEqual({ error: "Idempotency-Key was reused with a different payload" });
          expect(plane.createApproval).toHaveBeenCalledOnce();
          expect(plane.sync.list({ workspaceId: "default" })).toHaveLength(1);
        });

        it("is refused by the route too when a reused key asks for a different install", async () => {
          const plane = controlPlane(false);
          // Without the attempt record, the route's own check of the plan the key made still holds.
          const server = await build({ evolution: plane.service }, { idempotency: {} });

          await attempt(server, "attempt-unrecorded", true);
          const changed = await attempt(server, "attempt-unrecorded", false);

          expect(changed.statusCode).toBe(409);
          expect(plane.createApproval).toHaveBeenCalledOnce();
          expect(plane.sync.list({ workspaceId: "default" })).toHaveLength(1);
        });
      });

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
