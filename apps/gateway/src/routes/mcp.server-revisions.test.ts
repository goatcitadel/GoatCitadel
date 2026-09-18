import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createSqliteAsyncStorage, Storage, type AsyncStorage } from "@goatcitadel/storage";
import type { McpServerCreateInput, McpServerUpdateRequest, McpServerPolicyUpdateRequest } from "@goatcitadel/contracts";
import { McpServerStore } from "../services/mcp-server-store.js";
import * as admin from "../services/mcp-server-admin-service.js";
import { McpRouteService } from "../services/mcp-route-service.js";
import { composeMcpAdministration } from "../services/gateway-route-composition-tools.js";
import { authPlugin } from "../plugins/auth.js";
import { idempotencyHeaderPlugin } from "../plugins/idempotency.js";
import { mcpRoutes } from "./mcp.js";
import { installRouteAccessTracking } from "./route-access.js";

let storage: AsyncStorage, localStorage: Storage, serial = 0;
const apps: FastifyInstance[] = [];
beforeAll(() => {
  const root = mkdtempSync(path.join(os.tmpdir(), "gc-mcp-reviewed-routes-"));
  localStorage = new Storage({ dbPath: ":memory:", transcriptsDir: path.join(root, "transcripts"), auditDir: path.join(root, "audit") });
  storage = createSqliteAsyncStorage(localStorage);
}, 60_000);
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); vi.restoreAllMocks(); });
afterAll(async () => { await storage?.close(); });

async function fixture() {
  const store = new McpServerStore({ systemSettings: storage.systemSettings, approvalInbox: storage.approvalInbox, runImmediateTransaction: callback => storage.runImmediateTransaction(callback) });
  const closeOwned = vi.fn(() => undefined);
  const host = composeMcpAdministration(store, {
    storage, captureMcpServerSessionCloser: () => closeOwned,
    resolveConnectedMcpTools: vi.fn(async () => []),
    publishRealtime: vi.fn(async () => undefined),
  });
  const created = await admin.createMcpServer(host, { label: "Reviewed MCP", transport: "stdio", command: "node", args: ["--password", "synthetic-original"], enabled: false });
  vi.mocked(host.publishRealtime).mockClear();
  const port = {
    listMcpServers: vi.fn(() => store.readServers()),
    createMcpServer: (input: McpServerCreateInput, committed?: () => Promise<void>) => admin.createMcpServer(host, input, undefined, undefined, committed),
    updateMcpServer: (id: string, input: McpServerUpdateRequest, committed?: () => Promise<void>) => admin.updateMcpServer(host, id, input, undefined, { expectedRevision: input.expectedRevision, onCommitted: committed }),
    deleteMcpServer: (id: string, expectedRevision: string, committed?: () => Promise<void>) => admin.deleteMcpServer(host, id, { expectedRevision, onCommitted: committed }),
    updateMcpServerPolicy: (id: string, input: McpServerPolicyUpdateRequest, committed?: () => Promise<void>) => {
      const { expectedRevision, ...policy } = input;
      return admin.updateMcpServerPolicy(host, id, policy, { expectedRevision, onCommitted: committed });
    },
    connectMcpServer: (id: string) => admin.connectMcpServer(host, id), disconnectMcpServer: (id: string) => admin.disconnectMcpServer(host, id),
  };
  const app = Fastify(); apps.push(app);
  app.decorate("gatewayConfig", { assistant: { auth: { mode: "token", allowLoopbackBypass: false, token: { value: "synthetic-operator", queryParam: "access_token" }, basic: { username: "", password: "" } } } } as never);
  app.decorate("gatewayAuth", { getOnboardingStartupState: () => ({ completed: true }), validateDeviceAccessToken: () => undefined, validateCompanionAccessToken: () => undefined } as never);
  app.decorate("services", { mcp: new McpRouteService(port as never) } as never);
  installRouteAccessTracking(app);
  await app.register(authPlugin);
  await app.register(idempotencyHeaderPlugin, { mutationStore: storage.mutationIdempotency });
  await app.register(mcpRoutes);
  const committed: boolean[] = [];
  app.addHook("onSend", async (request, _reply, payload) => { committed.push(request.mutationCommitted === true); return payload; });
  const headers = () => ({ authorization: "Bearer synthetic-operator", "Idempotency-Key": `mcp-review-${++serial}` });
  return { app, store, host, port, closeOwned, created, headers, committed, url: `/api/v1/mcp/servers/${created.serverId}` };
}

describe.each(["edit", "delete", "policy"] as const)("MCP %s reviews", action => {
  const method = action === "delete" ? "DELETE" : "PATCH";
  const body = (revision?: string) => ({ expectedRevision: revision, ...(action === "edit" ? { label: "Local edit", args: ["--password", "[REDACTED]"] } : action === "policy" ? { redactionMode: "strict" } : {}) });
  it.each([undefined, "bad"])("rejects missing or invalid review %s", async revision => {
    const f = await fixture();
    expect((await f.app.inject({ method, url: f.url + (action === "policy" ? "/policy" : ""), headers: f.headers(), payload: body(revision) })).statusCode).toBe(400);
    expect(await f.store.requireServer(f.created.serverId)).toEqual(f.created);
    expect(f.closeOwned).not.toHaveBeenCalled();
  });
  it("retains a newer credential change, supports a fresh read and a separate reviewed attempt", async () => {
    const f = await fixture();
    const winner = await admin.updateMcpServer(f.host, f.created.serverId, { args: ["--password", "synthetic-peer"] });
    f.closeOwned.mockClear();
    const url = f.url + (action === "policy" ? "/policy" : "");
    expect((await f.app.inject({ method, url, headers: f.headers(), payload: body(f.created.revision) })).statusCode).toBe(409);
    expect(await f.store.requireServer(f.created.serverId)).toEqual(winner);
    expect(f.closeOwned).not.toHaveBeenCalled();
    const current = await f.app.inject({ method: "GET", url: f.url, headers: f.headers() });
    expect(current.headers["cache-control"]).toBe("no-store");
    expect(current.json().revision).toBe(winner.revision);
    expect(current.body).not.toMatch(/synthetic-original|synthetic-peer/);
    const saved = await f.app.inject({ method, url, headers: f.headers(), payload: body(current.json().revision) });
    expect(saved.statusCode).toBe(200);
    expect(f.committed).toEqual([false, false, true]);
    if (action !== "delete") expect((await f.store.requireServer(f.created.serverId)).args).toEqual(["--password", "synthetic-peer"]);
    else expect(saved.json()).toEqual({ deleted: true });
  });
  it("keeps committed failures completed for idempotency", async () => {
    const f = await fixture();
    f.closeOwned.mockImplementationOnce(() => { throw new Error("Fixture session cleanup failed"); });
    const request = { method, url: f.url + (action === "policy" ? "/policy" : ""), headers: f.headers(), payload: body(f.created.revision) };
    expect((await f.app.inject(request)).statusCode).toBe(500);
    expect(f.committed).toEqual([true]);
    expect((await f.app.inject(request)).statusCode).toBe(409);
    expect(f.closeOwned).toHaveBeenCalledOnce();
  });
});

it("does not carry raw credentials from a stale facade read into a new edit", async () => {
  const f = await fixture();
  f.port.listMcpServers.mockImplementationOnce(async () => {
    const stale = await f.store.readServers();
    await admin.updateMcpServer(f.host, f.created.serverId, { args: ["--password", "synthetic-winner"] });
    return stale;
  });
  const response = await f.app.inject({ method: "PATCH", url: f.url, headers: f.headers(), payload: { expectedRevision: f.created.revision, args: ["--password", "[REDACTED]"] } });
  expect(response.statusCode).toBe(409);
  expect((await f.store.requireServer(f.created.serverId)).args).toEqual(["--password", "synthetic-winner"]);
});

it("awaits the durable marker and returns its own acknowledgement before a later edit", async () => {
  const f = await fixture();
  const mark = vi.spyOn(localStorage.mutationIdempotency, "markCompleted");
  let cleanupPromise: Promise<unknown> | undefined;
  f.closeOwned.mockImplementationOnce(() => {
    expect(mark).toHaveBeenCalled();
    cleanupPromise = admin.updateMcpServer(f.host, f.created.serverId, { label: "Later peer" });
  });
  const response = await f.app.inject({ method: "PATCH", url: f.url, headers: f.headers(), payload: { expectedRevision: f.created.revision, label: "Own response" } });
  await cleanupPromise;
  expect(response.statusCode).toBe(200);
  expect(response.json().label).toBe("Own response");
  expect((await f.store.requireServer(f.created.serverId)).label).toBe("Later peer");
});

it("requires authentication for current reads and edits and blocks duplicate committed creation", async () => {
  const f = await fixture();
  expect((await f.app.inject({ method: "GET", url: f.url })).statusCode).toBe(401);
  expect((await f.app.inject({ method: "PATCH", url: f.url, payload: { expectedRevision: f.created.revision } })).statusCode).toBe(401);
  vi.mocked(f.host.publishRealtime).mockRejectedValueOnce(new Error("Fixture realtime failed"));
  const request = { method: "POST" as const, url: "/api/v1/mcp/servers", headers: f.headers(), payload: { label: "Committed creation", transport: "stdio", command: "node", enabled: false } };
  const before = (await f.store.readServers()).length;
  expect((await f.app.inject(request)).statusCode).toBe(500);
  expect((await f.app.inject(request)).statusCode).toBe(409);
  expect((await f.store.readServers()).length).toBe(before + 1);
});

it.each(["edit", "disconnect", "delete"])("fences discovery that completes after %s", async action => {
  const f = await fixture();
  vi.mocked(f.host.resolveConnectedMcpTools).mockImplementationOnce(async () => {
    if (action === "edit") await admin.updateMcpServer(f.host, f.created.serverId, { command: "peer-node" });
    else if (action === "disconnect") await admin.disconnectMcpServer(f.host, f.created.serverId);
    else await admin.deleteMcpServer(f.host, f.created.serverId);
    return [{ serverId: f.created.serverId, toolName: "late.tool", enabled: true, updatedAt: f.created.updatedAt }];
  });
  const response = await f.app.inject({ method: "POST", url: `${f.url}/connect`, headers: f.headers(), payload: {} });
  expect([404, 409]).toContain(response.statusCode);
  expect((await f.store.readTools()).some(tool => tool.serverId === f.created.serverId)).toBe(false);
  if (action !== "delete") expect((await f.store.requireServer(f.created.serverId)).status).toBe("disconnected");
});
