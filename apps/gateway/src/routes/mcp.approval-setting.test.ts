import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createSqliteAsyncStorage, Storage, type AsyncStorage } from "@goatcitadel/storage";
import { ValidationError, type McpServerPolicyUpdateRequest, type McpServerRecord } from "@goatcitadel/contracts";
import { McpServerStore } from "../services/mcp-server-store.js";
import * as admin from "../services/mcp-server-admin-service.js";
import { McpRouteService } from "../services/mcp-route-service.js";
import { composeMcpAdministration } from "../services/gateway-route-composition-tools.js";
import { authPlugin } from "../plugins/auth.js";
import { idempotencyHeaderPlugin } from "../plugins/idempotency.js";
import { mcpRoutes } from "./mcp.js";
import { installRouteAccessTracking } from "./route-access.js";

const MONEY_REFUSAL = "This connector can move money, so changes can't be set to run on their own.";

let root: string;
let storage: AsyncStorage;
let serial = 0;
const apps: FastifyInstance[] = [];

beforeAll(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "gc-mcp-approval-setting-routes-"));
  storage = createSqliteAsyncStorage(
    new Storage({
      dbPath: ":memory:",
      transcriptsDir: path.join(root, "transcripts"),
      auditDir: path.join(root, "audit"),
    }),
  );
}, 60_000);
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
afterAll(async () => {
  await storage?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

/** The real policy route, route service, admin service and store, behind the real operator auth. */
async function fixture() {
  const store = new McpServerStore({
    systemSettings: storage.systemSettings,
    approvalInbox: storage.approvalInbox,
    runImmediateTransaction: (callback) => storage.runImmediateTransaction(callback),
  });
  await storage.systemSettings.set("mcp_servers_v1", []);
  const appendApprovalsAudit = vi.fn(async (_event: Record<string, unknown>) => undefined);
  const closeSessions = vi.fn();
  const host = composeMcpAdministration(store, {
    storage,
    captureMcpServerSessionCloser: () => closeSessions,
    resolveConnectedMcpTools: vi.fn(async () => []),
    publishRealtime: vi.fn(async () => undefined),
    appendApprovalsAudit,
  });
  // The audit is the admin service's: the port only carries the route's actor to it, as the production wiring does.
  const port = {
    listMcpServers: () => store.readServers(),
    updateMcpServerPolicy: (
      id: string,
      input: McpServerPolicyUpdateRequest,
      committed?: () => Promise<void>,
      actor?: { actorId: string },
    ) => {
      const { expectedRevision, ...policy } = input;
      return admin.updateMcpServerPolicy(host, id, policy, {
        expectedRevision,
        onCommitted: committed,
        actorId: actor?.actorId,
      });
    },
  };
  const app = Fastify();
  apps.push(app);
  app.decorate("gatewayConfig", {
    assistant: {
      auth: {
        mode: "token",
        allowLoopbackBypass: false,
        token: { value: "synthetic-operator", queryParam: "access_token" },
        basic: { username: "", password: "" },
      },
    },
  } as never);
  app.decorate("gatewayAuth", {
    getOnboardingStartupState: () => ({ completed: true }),
    validateDeviceAccessToken: () => undefined,
    validateCompanionAccessToken: () => undefined,
  } as never);
  app.decorate("services", { mcp: new McpRouteService(port as never) } as never);
  installRouteAccessTracking(app);
  await app.register(authPlugin);
  await app.register(idempotencyHeaderPlugin, { mutationStore: storage.mutationIdempotency });
  await app.register(mcpRoutes);
  const patchPolicy = (serverId: string, payload: Record<string, unknown>) =>
    app.inject({
      method: "PATCH",
      url: `/api/v1/mcp/servers/${serverId}/policy`,
      headers: { authorization: "Bearer synthetic-operator", "Idempotency-Key": `mcp-approval-${++serial}` },
      payload,
    });
  const revision = async (serverId: string) => (await store.requireServer(serverId)).revision;
  /** Finishes a connection the way the Gateway does, so the server holds a tool and a first-tool approval. */
  const connect = async (server: McpServerRecord) => {
    const attempt = await store.patchServerState(server.serverId, { status: "connecting" }, server);
    const settled = await store.completeConnection(attempt, [
      { serverId: server.serverId, toolName: "read", enabled: true, updatedAt: server.updatedAt },
    ]);
    await storage.systemSettings.set("mcp_tool_first_approval_v1", { [server.serverId]: ["read"] });
    return settled;
  };
  const toolNames = async (serverId: string) =>
    (await store.readTools()).filter((tool) => tool.serverId === serverId).map((tool) => tool.toolName);
  return { store, host, appendApprovalsAudit, closeSessions, patchPolicy, revision, connect, toolNames };
}

describe("what asks first on the MCP policy route", () => {
  // R52: a server pointed at a money template's host can't let changes run on their own, whatever it is called.
  it("refuses Nothing asks on a server that can move money and saves nothing, but saves Reading is free", async () => {
    const f = await fixture();
    const wallet = await admin.createMcpServer(f.host, {
      label: "Team wallet",
      transport: "sse",
      url: "https://mcp.paypal.com/sse",
      enabled: false,
    });
    const refused = await f.patchPolicy(wallet.serverId, {
      approvalPosture: "nothing_asks",
      expectedRevision: wallet.revision,
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toBe(MONEY_REFUSAL);
    expect(await f.store.requireServer(wallet.serverId)).toEqual(wallet);
    expect(f.appendApprovalsAudit).not.toHaveBeenCalled();

    const saved = await f.patchPolicy(wallet.serverId, {
      approvalPosture: "reads_free",
      expectedRevision: wallet.revision,
    });
    expect(saved.statusCode).toBe(200);
    expect((await f.store.requireServer(wallet.serverId)).policy.approvalPosture).toBe("reads_free");

    // A connector that doesn't move money can still choose it.
    const docs = await admin.createMcpServer(f.host, {
      label: "Docs",
      transport: "stdio",
      command: "node",
      enabled: false,
    });
    const other = await f.patchPolicy(docs.serverId, {
      approvalPosture: "nothing_asks",
      expectedRevision: docs.revision,
    });
    expect(other.statusCode).toBe(200);
  });

  it("refuses it in the service itself, so every caller is covered, including a server created with it", async () => {
    const f = await fixture();
    await expect(
      admin.createMcpServer(f.host, {
        label: "PayPal",
        transport: "sse",
        url: "https://proxy.example/sse",
        enabled: false,
        policy: { approvalPosture: "nothing_asks" },
      }),
    ).rejects.toThrow(MONEY_REFUSAL);
    expect((await f.store.readServers()).some((server) => server.label === "PayPal")).toBe(false);

    const payments = await admin.createMcpServer(f.host, {
      label: "Payments",
      transport: "http",
      url: "https://mcp.stripe.com",
      enabled: false,
    });
    await expect(
      admin.updateMcpServerPolicy(f.host, payments.serverId, { approvalPosture: "nothing_asks" }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      admin.updateMcpServer(f.host, payments.serverId, { policy: { approvalPosture: "nothing_asks" } as never }),
    ).rejects.toThrow(MONEY_REFUSAL);
    // Renaming it in the same edit doesn't get around the endpoint check.
    await expect(
      admin.updateMcpServer(f.host, payments.serverId, {
        label: "Something else",
        policy: { approvalPosture: "nothing_asks" } as never,
      }),
    ).rejects.toThrow(MONEY_REFUSAL);
    expect(await f.store.requireServer(payments.serverId)).toEqual(payments);
  });

  // R50: a change to what asks first is audited after it commits, with the route's actor; no change records nothing.
  it("audits each change to what asks first once, and nothing else", async () => {
    const f = await fixture();
    const server = await admin.createMcpServer(f.host, { label: "Docs", transport: "stdio", command: "node" });
    const id = server.serverId;
    const patch = async (payload: Record<string, unknown>) =>
      (await f.patchPolicy(id, { ...payload, expectedRevision: await f.revision(id) })).statusCode;

    expect(await patch({ approvalPosture: "reads_free" })).toBe(200);
    expect(f.appendApprovalsAudit).toHaveBeenCalledExactlyOnceWith({
      event: "mcp_server_approval_posture_changed",
      serverId: id,
      from: null,
      to: "reads_free",
      actorId: expect.stringMatching(/^token:/u),
    });

    // The same value again, or another policy field, is not a change to what asks first.
    expect(await patch({ approvalPosture: "reads_free" })).toBe(200);
    expect(await patch({ redactionMode: "strict" })).toBe(200);
    expect(f.appendApprovalsAudit).toHaveBeenCalledTimes(1);

    expect(await patch({ approvalPosture: "everything_asks" })).toBe(200);
    expect(f.appendApprovalsAudit).toHaveBeenCalledTimes(2);
    expect(f.appendApprovalsAudit).toHaveBeenLastCalledWith(
      expect.objectContaining({ serverId: id, from: "reads_free", to: "everything_asks" }),
    );

    // A write against an old version never commits, so it records nothing.
    const stale = await f.patchPolicy(id, { approvalPosture: "nothing_asks", expectedRevision: server.revision });
    expect(stale.statusCode).toBe(409);
    expect(f.appendApprovalsAudit).toHaveBeenCalledTimes(2);
  });

  // R55: changing only what asks first is a reviewed edit that keeps the connection it was made on.
  describe("on a connected server", () => {
    it("keeps it connected with its tools, first-tool approvals and live sessions, and still audits the change", async () => {
      const f = await fixture();
      const created = await admin.createMcpServer(f.host, { label: "Docs", transport: "stdio", command: "node" });
      const before = await f.connect(await f.store.requireServer(created.serverId));
      expect(before.status).toBe("connected");

      const response = await f.patchPolicy(before.serverId, {
        approvalPosture: "reads_free",
        expectedRevision: before.revision,
      });

      expect(response.statusCode).toBe(200);
      const after = await f.store.requireServer(before.serverId);
      expect(after.policy.approvalPosture).toBe("reads_free");
      expect(after.revision).not.toBe(before.revision);
      expect(after).toMatchObject({
        status: "connected",
        connectionRevision: before.connectionRevision,
        configurationBindingId: before.configurationBindingId,
      });
      expect(await f.toolNames(before.serverId)).toEqual(["read"]);
      expect(await f.store.readFirstApprovals()).toMatchObject({ [before.serverId]: ["read"] });
      expect(f.closeSessions).not.toHaveBeenCalled();
      expect(f.appendApprovalsAudit).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ serverId: before.serverId, from: null, to: "reads_free" }),
      );
    });

    it("disconnects it, clears its tools and closes its sessions when another field changes in the same edit", async () => {
      const f = await fixture();
      const created = await admin.createMcpServer(f.host, { label: "Docs", transport: "stdio", command: "node" });
      const before = await f.connect(await f.store.requireServer(created.serverId));

      await admin.updateMcpServer(
        f.host,
        before.serverId,
        { args: ["other.mjs"], policy: { approvalPosture: "reads_free" } as never },
        undefined,
        { expectedRevision: before.revision },
      );

      expect(await f.store.requireServer(before.serverId)).toMatchObject({ status: "disconnected" });
      expect(await f.toolNames(before.serverId)).toEqual([]);
      expect(await f.store.readFirstApprovals()).not.toHaveProperty(before.serverId);
      expect(f.closeSessions).toHaveBeenCalledTimes(1);
    });

    it("keeps a capability pack's server connected, though the edit clears the pack bookkeeping", async () => {
      const f = await fixture();
      const created = await admin.createMcpServer(
        f.host,
        { label: "Pack docs", transport: "stdio", command: "node" },
        `pack-${"1".repeat(40)}`,
        "plan-1",
      );
      expect(created.packChange).toBeDefined();
      const before = await f.connect(await f.store.requireServer(created.serverId));

      await admin.updateMcpServer(
        f.host,
        before.serverId,
        { policy: { approvalPosture: "reads_free" } as never },
        undefined,
        { expectedRevision: before.revision },
      );

      const after = await f.store.requireServer(before.serverId);
      expect(after.packChange).toBeUndefined();
      expect(after).toMatchObject({
        status: "connected",
        connectionRevision: before.connectionRevision,
        configurationBindingId: before.configurationBindingId,
      });
      expect(await f.toolNames(before.serverId)).toEqual(["read"]);
      expect(f.closeSessions).not.toHaveBeenCalled();
    });
  });
});
