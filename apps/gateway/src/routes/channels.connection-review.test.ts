import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { ConflictError, NotFoundError } from "@goatcitadel/contracts";
import { Storage, createSqliteAsyncStorage } from "@goatcitadel/storage";
import { ChannelSecretCustodyService } from "../services/channel-secret-custody-service.js";
import { IntegrationChannelService, type IntegrationChannelPort } from "../services/integration-channel-service.js";
import * as setup from "../services/channel-setup-service.js";
import { registerChannelSetupIntegrationRoutes } from "./integrations-channel-setup-routes.js";
import { idempotencyHeaderPlugin } from "../plugins/idempotency.js";
import { authPlugin } from "../plugins/auth.js";
import { installRouteAccessTracking } from "./route-access.js";

let storage: Storage, root: string, sequence = 0;
const apps: FastifyInstance[] = [];
const oldToken = "123456:synthetic_original_token_abcdef", nextToken = "123456:synthetic_replaced_token_abcdef";
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "gc-channel-review-routes-"));
  storage = new Storage({ dbPath: ":memory:", transcriptsDir: path.join(root, "transcripts"), auditDir: path.join(root, "audit") });
}, 60_000);
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); vi.restoreAllMocks(); });
afterAll(() => { storage?.close(); });

async function fixture() {
  const secrets = new Map<string, string>();
  const custody = new ChannelSecretCustodyService({ setSecret: (key, value) => void secrets.set(key, value), getSecret: key => secrets.get(key), deleteSecret: key => void secrets.delete(key) });
  const deps = { storage: createSqliteAsyncStorage(storage), publishRealtime: vi.fn(async () => undefined), syncDiscordRuntime: vi.fn(async () => undefined), syncSignalInboundRuntime: vi.fn(async () => undefined) } as unknown as IntegrationChannelPort;
  const integrations = new IntegrationChannelService(deps);
  const host: setup.ChannelSetupHost = {
    storage: createSqliteAsyncStorage(storage), recentChannelSetupTests: new Map(), channelSecrets: custody,
    buildIntegrationConnectionChecks: vi.fn(() => []), runIntegrationConnectionLiveChecks: vi.fn(async () => ({ checks: [] })),
    recordDevDiagnostic: vi.fn(), createIntegrationConnection: input => integrations.createIntegrationConnection(input),
    updateIntegrationConnection: (id, input) => integrations.updateIntegrationConnection(id, input),
    getIntegrationConnection: async id => storage.integrationConnections.get(id),
    commitChannelSetupConnection: (id, revision, input, onCommitted) => integrations.finalizeChannelSetupConnection(id, revision, input, onCommitted),
  };
  const connection = storage.integrationConnections.create({ catalogId: "channel.telegram", kind: "channel", key: "telegram", label: "Telegram fixture", enabled: false, config: { botToken: oldToken, defaultChatId: "-1000123456" } });
  const draft = await setup.createChannelSetupDraft(host, { catalogId: connection.catalogId, connectionId: connection.connectionId, lifecycleMode: "repair" });
  const app = Fastify(); apps.push(app);
  app.decorate("gatewayConfig", { assistant: { auth: { mode: "token", allowLoopbackBypass: false, token: { value: "synthetic-operator", queryParam: "access_token" }, basic: { username: "", password: "" } } } } as never);
  app.decorate("gatewayAuth", { getOnboardingStartupState: () => ({ completed: true }), validateDeviceAccessToken: () => undefined, validateCompanionAccessToken: () => undefined } as never);
  app.decorate("services", { channelSetup: {
    getChannelSetupDraft: (id: string) => setup.getChannelSetupDraft(host, id),
    reviewChannelSetupConnection: (id: string, input: Parameters<typeof setup.reviewChannelSetupConnection>[2]) => setup.reviewChannelSetupConnection(host, id, input),
    finalizeChannelSetupDraft: (id: string, revision: number, callback?: () => Promise<void>) => setup.finalizeChannelSetupDraft(host, id, revision, callback),
    validateChannelSetupDraft: (id: string, revision: number) => setup.validateChannelSetupDraft(host, id, revision),
    testChannelSetupDraft: (id: string, revision: number) => setup.testChannelSetupDraft(host, id, revision),
  } } as never);
  installRouteAccessTracking(app); await app.register(authPlugin);
  await app.register(idempotencyHeaderPlugin, { mutationStore: createSqliteAsyncStorage(storage).mutationIdempotency });
  registerChannelSetupIntegrationRoutes(app);
  const url = `/api/v1/channels/drafts/${draft.draftId}`;
  const headers = () => ({ authorization: "Bearer synthetic-operator", "Idempotency-Key": `channel-review-${++sequence}` });
  return { app, url, host, deps, custody, secrets, connection, draft, headers };
}

it("rejects stale connection reviews before credentials, live checks, and finalization", async () => {
  const f = await fixture();
  expect(f.draft.connectionRevision).toBe(f.connection.revision);
  const peer = storage.integrationConnections.update(f.connection.connectionId, { config: { botToken: nextToken, defaultChatId: "-1000999999" } });
  for (const action of ["validate", "test", "finalize"]) {
    const response = await f.app.inject({ method: "POST", url: `${f.url}/${action}`, headers: f.headers(), payload: { expectedRevision: f.draft.revision } });
    expect(response.statusCode).toBe(409); expect(response.json().details.reason).toBe("CHANNEL_CONNECTION_REVIEW_REQUIRED");
  }
  expect(f.host.runIntegrationConnectionLiveChecks).not.toHaveBeenCalled();
  expect(f.deps.publishRealtime).not.toHaveBeenCalled();
  expect(storage.integrationConnections.get(peer.connectionId)).toEqual(peer);
  expect(storage.channelSetupDrafts.get(f.draft.draftId)).toEqual(f.draft);
});

it("requires explicit authenticated review, preserves local fields and replacement credentials, and invalidates cached tests", async () => {
  const f = await fixture();
  const edited = await setup.updateChannelSetupDraft(f.host, f.draft.draftId, { expectedRevision: f.draft.revision, label: "Retained label" });
  const secured = await setup.setChannelSetupDraftSecrets(f.host, edited.draftId, { expectedRevision: edited.revision, values: { botToken: nextToken } });
  const peer = storage.integrationConnections.update(f.connection.connectionId, { label: "Peer", config: { botToken: "123456:peer_token_1234567890123456", defaultChatId: "-1000111111" } });
  f.host.recentChannelSetupTests.set(edited.draftId, {} as never);
  const payload = { expectedRevision: secured.revision, expectedConnectionRevision: peer.revision };
  expect((await f.app.inject({ method: "POST", url: `${f.url}/connection-review`, payload })).statusCode).toBe(401);
  expect((await f.app.inject({ method: "GET", url: f.url })).statusCode).toBe(401);
  for (const token of [undefined, "bad", f.connection.revision]) {
    expect((await f.app.inject({ method: "POST", url: `${f.url}/connection-review`, headers: f.headers(), payload: { ...payload, expectedConnectionRevision: token } })).statusCode).toBe(token === f.connection.revision ? 409 : 400);
  }
  const response = await f.app.inject({ method: "POST", url: `${f.url}/connection-review`, headers: f.headers(), payload });
  expect(response.statusCode).toBe(200); expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.body).not.toContain(nextToken); expect(response.body).not.toContain("keychain:");
  const current = storage.channelSetupDrafts.get(secured.draftId);
  expect(current.label).toBe("Retained label"); expect(current.connectionRevision).toBe(peer.revision);
  expect(current.secretState.botToken).toEqual(secured.secretState.botToken);
  expect(f.host.recentChannelSetupTests.has(secured.draftId)).toBe(false);
  expect(f.host.runIntegrationConnectionLiveChecks).not.toHaveBeenCalled();
  const get = await f.app.inject({ method: "GET", url: f.url, headers: f.headers() });
  expect(get.json().revision).toBe(current.revision); expect(get.body).not.toContain(nextToken);
});

it("does not accept a live test after the connection changes while it runs", async () => {
  const f = await fixture();
  vi.mocked(f.host.runIntegrationConnectionLiveChecks).mockImplementationOnce(async () => {
    storage.integrationConnections.update(f.connection.connectionId, { enabled: false, label: "Revoked" });
    return { checks: [] };
  });
  await expect(setup.testChannelSetupDraft(f.host, f.draft.draftId, f.draft.revision)).rejects.toBeInstanceOf(ConflictError);
  expect(f.host.recentChannelSetupTests.has(f.draft.draftId)).toBe(false);
  expect(f.deps.publishRealtime).not.toHaveBeenCalled();
});

it.each(["connection", "draft"] as const)("rejects a %s change during promotion without changing or deleting existing credentials", async kind => {
  const f = await fixture();
  const temporary = f.custody.storeTemporary("source", "botToken", oldToken);
  const original = f.custody.copyToConnection(temporary, f.connection.connectionId, "botToken");
  const peer = storage.integrationConnections.update(f.connection.connectionId, { config: { ...f.connection.config, botToken: original } });
  let draft = await setup.reviewChannelSetupConnection(f.host, f.draft.draftId, { expectedRevision: f.draft.revision, expectedConnectionRevision: peer.revision });
  draft = await setup.setChannelSetupDraftSecrets(f.host, draft.draftId, { expectedRevision: draft.revision, values: { botToken: nextToken } });
  const copy = f.custody.copyToConnection.bind(f.custody);
  let attempted: string | undefined;
  vi.spyOn(f.custody, "copyToConnection").mockImplementationOnce((...args) => {
    attempted = copy(...args);
    if (kind === "connection") storage.integrationConnections.update(peer.connectionId, { label: "Peer during promotion" });
    else storage.channelSetupDrafts.update(draft.draftId, { expectedRevision: storage.channelSetupDrafts.get(draft.draftId).revision, label: "Peer draft" });
    return attempted;
  });
  await expect(setup.finalizeChannelSetupDraft(f.host, draft.draftId, draft.revision)).rejects.toBeInstanceOf(ConflictError);
  expect(f.custody.resolve(original)).toBe(oldToken); expect(() => f.custody.resolve(attempted!)).toThrow(/unavailable/);
  expect(storage.integrationConnections.get(peer.connectionId).config.botToken).toBe(original);
  expect(storage.channelSetupDrafts.get(draft.draftId).secretState.botToken?.secretRef).toBe(draft.secretState.botToken?.secretRef);
  expect(f.deps.publishRealtime).not.toHaveBeenCalled();
});

it("commits one connection version, reuses the exact passing test, and returns its own acknowledgement", async () => {
  const f = await fixture();
  const draft = await setup.setChannelSetupDraftSecrets(f.host, f.draft.draftId, { expectedRevision: f.draft.revision, values: { botToken: nextToken } });
  const tested = await setup.testChannelSetupDraft(f.host, draft.draftId, draft.revision);
  expect(tested.status).toBe("ok");
  const mark = vi.spyOn(storage.mutationIdempotency, "markCompleted");
  vi.mocked(f.deps.publishRealtime).mockImplementationOnce(async () => {
    expect(mark).toHaveBeenCalled();
    expect(() => storage.channelSetupDrafts.get(draft.draftId)).toThrow(NotFoundError);
    storage.integrationConnections.update(f.connection.connectionId, { label: "Later peer" });
  });
  const response = await f.app.inject({ method: "POST", url: `${f.url}/finalize`, headers: f.headers(), payload: { expectedRevision: tested.draftRevision } });
  expect(response.statusCode).toBe(200); expect(response.json().connection.label).toBe("Telegram fixture");
  expect(storage.integrationConnections.get(f.connection.connectionId).label).toBe("Later peer");
  expect(f.host.runIntegrationConnectionLiveChecks).toHaveBeenCalledOnce();
  const reference = storage.integrationConnections.get(f.connection.connectionId).config.botToken as string;
  expect(f.custody.resolve(reference)).toBe(nextToken); expect(response.body).not.toContain(nextToken);
});

it("keeps committed credentials and blocks a duplicate after runtime synchronization fails", async () => {
  const f = await fixture();
  const draft = await setup.setChannelSetupDraftSecrets(f.host, f.draft.draftId, { expectedRevision: f.draft.revision, values: { botToken: nextToken } });
  vi.mocked(f.deps.syncDiscordRuntime).mockRejectedValueOnce(new Error("Synthetic sync failure"));
  const request = { method: "POST" as const, url: `${f.url}/finalize`, headers: f.headers(), payload: { expectedRevision: draft.revision } };
  expect((await f.app.inject(request)).statusCode).toBe(500);
  expect(f.custody.resolve(storage.integrationConnections.get(f.connection.connectionId).config.botToken as string)).toBe(nextToken);
  expect(() => storage.channelSetupDrafts.get(draft.draftId)).toThrow(NotFoundError);
  expect((await f.app.inject(request)).statusCode).toBe(409);
  expect(f.host.runIntegrationConnectionLiveChecks).toHaveBeenCalledOnce();
  expect(f.deps.publishRealtime).toHaveBeenCalledOnce();
});

it("retains existing credentials when the draft save conflicts", async () => {
  const f = await fixture();
  const original = f.custody.storeTemporary(f.draft.draftId, "webhookSecret", oldToken);
  f.draft = storage.channelSetupDrafts.update(f.draft.draftId, { expectedRevision: f.draft.revision, secretState: { webhookSecret: { configured: true, custody: "temporary", source: "inherited", secretRef: original } } });
  const peer = storage.integrationConnections.update(f.connection.connectionId, { config: { ...f.connection.config, botToken: nextToken } });
  const before = new Map(f.secrets);
  vi.spyOn(storage.channelSetupDrafts, "update").mockImplementationOnce(() => { throw new ConflictError({ code: "WRITE_CONFLICT", message: "Peer draft update" }); });
  await expect(setup.reviewChannelSetupConnection(f.host, f.draft.draftId, {
    expectedRevision: f.draft.revision, expectedConnectionRevision: peer.revision,
  })).rejects.toBeInstanceOf(ConflictError);
  expect(storage.channelSetupDrafts.get(f.draft.draftId)).toEqual(f.draft);
  expect(f.secrets).toEqual(before);
  expect(f.custody.resolve(original)).toBe(oldToken);
});

it("preserves saved review credentials when retiring the old credential fails", async () => {
  const f = await fixture();
  const original = f.custody.storeTemporary(f.draft.draftId, "webhookSecret", oldToken);
  f.draft = storage.channelSetupDrafts.update(f.draft.draftId, { expectedRevision: f.draft.revision, secretState: { webhookSecret: { configured: true, custody: "temporary", source: "inherited", secretRef: original } } });
  const peer = storage.integrationConnections.update(f.connection.connectionId, { config: { ...f.connection.config, botToken: nextToken } });
  f.draft = await setup.setChannelSetupDraftSecrets(f.host, f.draft.draftId, { expectedRevision: f.draft.revision, values: { botToken: nextToken } });
  vi.spyOn(f.custody, "deleteTemporary").mockImplementationOnce(() => { throw new Error("Synthetic custody failure"); });
  await expect(setup.reviewChannelSetupConnection(f.host, f.draft.draftId, {
    expectedRevision: f.draft.revision, expectedConnectionRevision: peer.revision,
  })).rejects.toMatchObject({ mutationCommitted: true });
  const saved = storage.channelSetupDrafts.get(f.draft.draftId);
  expect(saved.revision).toBe(f.draft.revision + 1);
  expect(saved.connectionRevision).toBe(peer.revision);
  expect(f.custody.resolve(saved.secretState.botToken!.secretRef!)).toBe(nextToken);
  expect(f.custody.resolve(original)).toBe(oldToken);
});
