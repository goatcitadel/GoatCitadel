import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createSqliteAsyncStorage, Storage } from "@goatcitadel/storage";
import type { IntegrationConnectionCreateInput, IntegrationConnectionUpdateInput } from "@goatcitadel/contracts";
import { createIntegrationConnection, updateIntegrationConnection, deleteIntegrationConnection, type IntegrationChannelPort } from "../services/integration-channel-service.js";
import { projectIntegrationConnectionForPublicResponse } from "../services/integration-connection-public-projection.js";
import { authPlugin } from "../plugins/auth.js";
import { idempotencyHeaderPlugin } from "../plugins/idempotency.js";
import { registerIntegrationControlRoutes } from "./integrations-control-routes.js";
import { installRouteAccessTracking } from "./route-access.js";

let root: string, storage: Storage, serial = 0;
const apps: FastifyInstance[] = [];
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "gc-integration-review-routes-"));
  storage = new Storage({ dbPath: ":memory:", transcriptsDir: path.join(root, "transcripts"), auditDir: path.join(root, "audit") });
}, 60_000);
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); vi.restoreAllMocks(); });
afterAll(() => {
  storage?.close();
  if (root) { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("gc-integration-review-routes-")); fs.rmSync(root, { recursive: true, force: true }); }
});

async function createApp() {
  const repo = storage.integrationConnections;
  const connection = repo.create({ catalogId: "channel.slack", kind: "channel", key: "slack", label: "Reviewed connection", config: { botToken: "synthetic-original", channelId: "fixture-one" } });
  const deps = { storage: createSqliteAsyncStorage(storage), publishRealtime: vi.fn(async () => undefined), syncDiscordRuntime: vi.fn(async () => undefined), syncSignalInboundRuntime: vi.fn(async () => undefined) } as unknown as IntegrationChannelPort;
  const get = vi.fn(async (id: string) => deps.storage.integrationConnections.get(id));
  const app = Fastify(); apps.push(app);
  app.decorate("gatewayConfig", { assistant: { auth: { mode: "token", allowLoopbackBypass: false, token: { value: "synthetic-operator", queryParam: "access_token" }, basic: { username: "", password: "" } } } } as never);
  app.decorate("gatewayAuth", { getOnboardingStartupState: () => ({ completed: true }), validateDeviceAccessToken: () => undefined, validateCompanionAccessToken: () => undefined } as never);
  app.decorate("services", { integrations: {
    getIntegrationConnection: get,
    listIntegrationConnections: async () => deps.storage.integrationConnections.list(),
    createIntegrationConnection: (input: IntegrationConnectionCreateInput, committed?: () => Promise<void>) => createIntegrationConnection(deps, input, committed),
    updateIntegrationConnection: (id: string, input: IntegrationConnectionUpdateInput, committed?: () => Promise<void>) => updateIntegrationConnection(deps, id, input, committed),
    deleteIntegrationConnection: (id: string, revision?: string, committed?: () => Promise<void>) => deleteIntegrationConnection(deps, id, revision, committed),
  } } as never);
  installRouteAccessTracking(app);
  await app.register(authPlugin);
  await app.register(idempotencyHeaderPlugin, { mutationStore: createSqliteAsyncStorage(storage).mutationIdempotency });
  registerIntegrationControlRoutes(app);
  const committed: boolean[] = [];
  app.addHook("onSend", async (request, _reply, payload) => { committed.push(request.mutationCommitted === true); return payload; });
  const url = `/api/v1/integrations/connections/${connection.connectionId}`;
  const headers = () => ({ authorization: "Bearer synthetic-operator", "Idempotency-Key": `integration-proof-${++serial}` });
  return { app, repo, connection, deps, get, url, headers, committed };
}

describe.each(["PATCH", "DELETE"] as const)("integration reviewed %s", method => {
  it.each([undefined, null, "bad"])("rejects invalid revision %s before writing or runtime synchronization", async expectedRevision => {
    const c = await createApp();
    const response = await c.app.inject({ method, url: c.url, headers: c.headers(), payload: { expectedRevision, label: "Rejected" } });
    expect(response.statusCode).toBe(400);
    expect(c.repo.get(c.connection.connectionId)).toEqual(c.connection);
    expect(c.deps.publishRealtime).not.toHaveBeenCalled();
    expect(c.committed).toEqual([false]);
  });
  it("rejects stale credential reviews, then accepts a separate reviewed attempt", async () => {
    const c = await createApp();
    const peer = c.repo.update(c.connection.connectionId, { config: { botToken: "synthetic-peer", channelId: "fixture-two" } });
    const payload = { expectedRevision: c.connection.revision, label: "Local edit", config: { botToken: "[REDACTED]", channelId: "fixture-three" } };
    const response = await c.app.inject({ method, url: c.url, headers: c.headers(), payload });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "WRITE_CONFLICT", details: { reason: "INTEGRATION_CONNECTION_REVISION_CONFLICT" } });
    expect(c.repo.get(peer.connectionId)).toEqual(peer);
    expect(c.deps.publishRealtime).not.toHaveBeenCalled();
    expect(c.deps.syncDiscordRuntime).not.toHaveBeenCalled();
    expect(c.deps.syncSignalInboundRuntime).not.toHaveBeenCalled();
    const fresh = await c.app.inject({ method: "GET", url: c.url, headers: c.headers() });
    expect(fresh.json()).toEqual(projectIntegrationConnectionForPublicResponse(peer));
    expect(fresh.headers["cache-control"]).toBe("no-store");
    const retry = await c.app.inject({ method, url: c.url, headers: c.headers(), payload: { ...payload, expectedRevision: fresh.json().revision } });
    expect(retry.statusCode).toBe(200);
    expect(c.deps.publishRealtime).toHaveBeenCalledOnce();
    expect(c.committed).toEqual([false, false, true]);
    if (method === "PATCH") { expect(retry.json()).toEqual(projectIntegrationConnectionForPublicResponse(c.repo.get(peer.connectionId))); expect(c.repo.get(peer.connectionId).config.botToken).toBe("synthetic-peer"); }
    else expect(retry.json()).toEqual({ deleted: true });
    expect(retry.body).not.toMatch(/synthetic-original|synthetic-peer/);
  });
  it("does not retry a committed mutation after runtime synchronization fails", async () => {
    const c = await createApp();
    vi.mocked(c.deps.syncDiscordRuntime).mockRejectedValueOnce(new Error("Synthetic runtime unavailable"));
    const options = { method, url: c.url, headers: c.headers(), payload: { expectedRevision: c.connection.revision, label: "Saved" } };
    expect((await c.app.inject(options)).statusCode).toBe(500);
    expect(c.committed).toEqual([true]);
    expect((await c.app.inject(options)).statusCode).toBe(409);
    expect(c.deps.publishRealtime).toHaveBeenCalledOnce();
  });
  it("requires operator authentication before a read or mutation", async () => {
    const c = await createApp();
    expect((await c.app.inject({ method, url: c.url, payload: { expectedRevision: c.connection.revision } })).statusCode).toBe(401);
    expect((await c.app.inject({ method: "GET", url: c.url })).statusCode).toBe(401);
    expect(c.get).not.toHaveBeenCalled();
    expect(c.repo.get(c.connection.connectionId)).toEqual(c.connection);
  });
});

it("catches an intervening raw credential write between route preservation and service reads", async () => {
  const c = await createApp();
  c.get.mockImplementationOnce(async id => {
    const reviewed = c.repo.get(id);
    c.repo.update(id, { config: { botToken: "synthetic-peer", channelId: "new-peer" } });
    return reviewed;
  });
  const response = await c.app.inject({ method: "PATCH", url: c.url, headers: c.headers(), payload: { expectedRevision: c.connection.revision, config: { botToken: "[REDACTED]", channelId: "stale-local" } } });
  expect(response.statusCode).toBe(409);
  expect(c.repo.get(c.connection.connectionId).config).toEqual({ botToken: "synthetic-peer", channelId: "new-peer" });
  expect(c.deps.publishRealtime).not.toHaveBeenCalled();
});

it("awaits commit acknowledgement before runtime sync and preserves its own response", async () => {
  const c = await createApp();
  const markCompleted = vi.spyOn(storage.mutationIdempotency, "markCompleted");
  vi.mocked(c.deps.publishRealtime).mockImplementation(async () => {
    expect(markCompleted).toHaveBeenCalled();
    c.repo.update(c.connection.connectionId, { label: "Later peer" });
  });
  const response = await c.app.inject({ method: "PATCH", url: c.url, headers: c.headers(), payload: { expectedRevision: c.connection.revision, label: "Own response" } });
  expect(response.statusCode).toBe(200);
  expect(response.json().label).toBe("Own response");
  expect(c.repo.get(c.connection.connectionId).label).toBe("Later peer");
  expect(response.json().revision).not.toBe(c.repo.get(c.connection.connectionId).revision);
});

it("blocks duplicate creation after a post-commit failure", async () => {
  const c = await createApp();
  const count = c.repo.list().length;
  vi.mocked(c.deps.publishRealtime).mockRejectedValueOnce(new Error("Synthetic signal unavailable"));
  const options = { method: "POST" as const, url: "/api/v1/integrations/connections", headers: c.headers(), payload: { catalogId: "channel.slack", config: { botTokenEnv: "SLACK_BOT_TOKEN" } } };
  expect((await c.app.inject(options)).statusCode).toBe(500);
  expect(c.repo.list()).toHaveLength(count + 1);
  expect((await c.app.inject(options)).statusCode).toBe(409);
  expect(c.repo.list()).toHaveLength(count + 1);
});
it("rejects ordinary credential creation and replacement without persistence or runtime sync", async () => {
  const c = await createApp();
  const count = c.repo.list().length;
  const create = await c.app.inject({ method: "POST", url: "/api/v1/integrations/connections", headers: c.headers(), payload: { catalogId: "channel.slack", config: { botToken: "disposable-input" } } });
  expect(create.statusCode).toBe(400);
  const replace = await c.app.inject({ method: "PATCH", url: c.url, headers: c.headers(), payload: { expectedRevision: c.connection.revision, config: { botToken: "disposable-input" } } });
  expect(replace.statusCode).toBe(400);
  expect(create.body + replace.body).not.toContain("disposable-input");
  expect(c.repo.list()).toHaveLength(count);
  expect(c.repo.get(c.connection.connectionId)).toEqual(c.connection);
  expect(c.deps.publishRealtime).not.toHaveBeenCalled();
});

it.each([
  ["automation.webhooks", "baseUrl", "signingSecretEnv"],
  ["automation.activepieces", "webhookUrl", "authTokenEnv"],
])("preserves %s URL semantics and validates true ENV references through the route", async (catalogId, field, envField) => {
  const c = await createApp();
  const create = await c.app.inject({ method: "POST", url: "/api/v1/integrations/connections", headers: c.headers(), payload: {
    catalogId, config: { [field]: "https://public.invalid/receive", [envField]: "CONNECTOR_AUTH" },
  } });
  expect(create.statusCode).toBe(201);
  const record = c.repo.get(create.json().connectionId), url = `/api/v1/integrations/connections/${record.connectionId}`;
  expect(record.config[field]).toBe("https://public.invalid/receive");
  const edit = await c.app.inject({ method: "PATCH", url, headers: c.headers(), payload: {
    expectedRevision: record.revision, config: { [field]: "https://public.invalid/changed", [envField]: "OTHER_AUTH" },
  } });
  expect(edit.statusCode).toBe(200);
  const edited = c.repo.get(record.connectionId);
  expect(edited.config).toEqual({ [field]: "https://public.invalid/changed", [envField]: "OTHER_AUTH" });
  expect((await c.app.inject({ method: "GET", url, headers: c.headers() })).json()).toEqual(projectIntegrationConnectionForPublicResponse(edited));
  for (const config of [{ [envField]: "not-an-env" }, { [field]: "https://public.invalid/?token=synthetic-private" }]) {
    const response = await c.app.inject({ method: "PATCH", url, headers: c.headers(), payload: { expectedRevision: edited.revision, config } });
    expect(response.statusCode).toBe(400);
    expect(c.repo.get(record.connectionId)).toEqual(edited);
    expect(response.body).not.toContain("synthetic-private");
  }
});
it("roundtrips only this connection's exact unchanged webhook mask and rejects invented masks and raw replacements", async () => {
  const c = await createApp();
  for (const suffix of ["first", "second"]) {
    const record = c.repo.create({ catalogId: "automation.activepieces", kind: "automation", key: "activepieces", label: suffix,
      config: { webhookUrl: `https://cloud.activepieces.com/api/v1/webhooks/synthetic-${suffix}`, authTokenEnv: "CONNECTOR_AUTH" } });
    const url = `/api/v1/integrations/connections/${record.connectionId}`;
    const publicRecord = (await c.app.inject({ method: "GET", url, headers: c.headers() })).json();
    expect(publicRecord.config.webhookUrl).toBe("[REDACTED]");
    const edit = await c.app.inject({ method: "PATCH", url, headers: c.headers(), payload: { expectedRevision: record.revision, label: "Changed ordinary label", config: publicRecord.config } });
    expect(edit.statusCode).toBe(200);
    const edited = c.repo.get(record.connectionId);
    expect(edited.config).toEqual(record.config);
    expect(edited.label).toBe("Changed ordinary label");
    for (const config of [{ webhookUrl: "https://other.invalid/?token=synthetic-replacement" }, { newToken: "[REDACTED]" }]) {
      expect((await c.app.inject({ method: "PATCH", url, headers: c.headers(), payload: { expectedRevision: edited.revision, config } })).statusCode).toBe(400);
      expect(c.repo.get(record.connectionId)).toEqual(edited);
    }
  }
  const count = c.repo.list().length;
  expect((await c.app.inject({ method: "POST", url: "/api/v1/integrations/connections", headers: c.headers(), payload: { catalogId: "automation.activepieces", config: { webhookUrl: "[REDACTED]" } } })).statusCode).toBe(400);
  expect((await c.app.inject({ method: "POST", url: "/api/v1/integrations/connections", headers: c.headers(), payload: { catalogId: "channel.slack", config: { botToken: "[REDACTED]" } } })).statusCode).toBe(400);
  expect(c.repo.list()).toHaveLength(count);
});

describe.each([["automation.webhooks", "baseUrl"], ["automation.activepieces", "webhookUrl"]])("normalized URL custody for %s", (catalogId, field) => {
  it.each(["POST", "PATCH"] as const)("rejects normalized credential forms on %s before any write or exposure", async method => {
    const c = await createApp();
    const record = c.repo.create({ catalogId, kind: "automation", key: catalogId.split(".")[1]!, label: "Safe endpoint", config: { [field]: "https://public.invalid/receive" } });
    const count = c.repo.list().length, url = `/api/v1/integrations/connections/${record.connectionId}`;
    const secret = "synthetic-normalization-private";
    const candidates = [
      `https:\t//operator:${secret}@public.invalid/receive`,
      `https:\n//operator:${secret}@public.invalid/receive`,
      `https:\\public.invalid\\webhooks\\${secret}`,
      `https://public.invalid/?to\tken=${secret}`,
      `https://public.invalid/web\nhooks/${secret}`,
      `https://public.invalid/public/../webhooks/${secret}`,
      `https://public.invalid/?%74oken=${secret}`,
    ];
    for (const candidate of candidates) {
      const response = await c.app.inject({ method, url: method === "POST" ? "/api/v1/integrations/connections" : url, headers: c.headers(),
        payload: method === "POST" ? { catalogId, config: { [field]: candidate } } : { expectedRevision: record.revision, config: { [field]: candidate } } });
      expect(response.statusCode).toBe(400);
      expect(response.body.includes(secret)).toBe(false);
      expect(c.repo.list()).toHaveLength(count);
      expect(c.repo.get(record.connectionId)).toEqual(record);
      const read = await c.app.inject({ method: "GET", url, headers: c.headers() });
      expect(read.body.includes(secret)).toBe(false);
      expect(c.deps.publishRealtime).not.toHaveBeenCalled();
    }
  });
});
