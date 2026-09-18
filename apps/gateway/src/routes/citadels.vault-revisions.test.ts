import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createSqliteAsyncStorage, Storage } from "@goatcitadel/storage";
import { CitadelsRouteService } from "../services/citadels-route-service.js";
import { citadelsRoutes } from "./citadels.js";

let root: string;
let storage: Storage;
let serial = 0;
const apps: FastifyInstance[] = [];
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "gc-vault-routes-"));
  storage = new Storage({ dbPath: ":memory:", transcriptsDir: path.join(root, "transcripts"), auditDir: path.join(root, "audit") });
}, 60_000);
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); vi.restoreAllMocks(); });
afterAll(() => {
  storage?.close();
  if (root) {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("gc-vault-routes-"));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const sealedValue = { iv: "fixture-iv", ciphertext: "fixture-ciphertext", tag: "fixture-tag" };
const mutations = [
  { method: "POST", path: "vault-secrets", fields: { name: "Seed", value: "synthetic-route-value" }, kind: "store" },
  { method: "DELETE", path: "vault-secrets/target", fields: {}, kind: "delete" },
] as const;

async function createApp(mutation: typeof mutations[number]) {
  const citadelId = `vault-route-${serial++}`;
  const repo = storage.citadels;
  repo.createRecord({ citadelId, name: citadelId });
  const secret = repo.storeVaultSecret({ citadelId, secretName: "Seed", sealedValue });
  const path = mutation.path.replace("vault-secrets/target", `vault-secrets/${secret.secretId}`);
  const snapshot = repo.getVaultSnapshot(citadelId);
  const writes = vi.spyOn(repo, "mutateVault");
  const app = Fastify(); apps.push(app);
  app.decorate("services", { citadels: new CitadelsRouteService(createSqliteAsyncStorage(storage).citadels, undefined, () => Buffer.alloc(32, 7)) } as never);
  const auth = vi.fn(async () => undefined);
  app.decorate("requireOperatorAuth", auth);
  const committed: boolean[] = [];
  app.addHook("onSend", async (request, _reply, payload) => { committed.push(request.mutationCommitted === true); return payload; });
  await app.register(citadelsRoutes);
  const inject = (revision: unknown = snapshot.revision) => app.inject({ method: mutation.method, url: `/api/v1/citadels/${citadelId}/${path}`, payload: { ...mutation.fields, expectedRevision: revision, citadelId: "foreign", sourceCitadelId: "foreign" } });
  return { app, auth, snapshot, writes, committed, inject, citadelId };
}

describe.each(mutations)("reviewed Citadel vault $kind", (mutation) => {
  it.each([null, "invalid"])("rejects invalid review %s before writing", async (revision) => {
    const context = await createApp(mutation);
    expect((await context.inject(revision)).statusCode).toBe(400);
    expect(context.writes).not.toHaveBeenCalled();
    expect(storage.citadels.getVaultSnapshot(context.citadelId)).toEqual(context.snapshot);
    expect(context.committed).toEqual([false]);
  });
  it("writes in the URL scope and returns the owner's complete acknowledgement", async () => {
    const context = await createApp(mutation);
    const response = await context.inject();
    expect(response.statusCode).toBe(mutation.method === "POST" ? 201 : 200);
    expect(response.json()).toEqual(storage.citadels.getVaultSnapshot(context.citadelId));
    expect(response.json().revision).not.toBe(context.snapshot.revision);
    expect(context.writes).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ citadelId: context.citadelId, expectedRevision: context.snapshot.revision, change: expect.objectContaining({ type: mutation.kind }) }));
    expect(JSON.stringify(response.json())).not.toMatch(/synthetic-route-value|ciphertext|sealedValue/);
    expect(context.committed).toEqual([true]);
  });
  it("rejects a peer change without partial writes or retry", async () => {
    const context = await createApp(mutation);
    storage.citadels.storeVaultSecret({ citadelId: context.citadelId, secretName: "Seed", sealedValue });
    const peer = storage.citadels.getVaultSnapshot(context.citadelId);
    const response = await context.inject();
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "WRITE_CONFLICT", details: { reason: "CITADEL_VAULT_REVISION_CONFLICT" } });
    expect(context.writes).toHaveBeenCalledOnce();
    expect(storage.citadels.getVaultSnapshot(context.citadelId)).toEqual(peer);
    expect(context.committed).toEqual([false]);
  });
  it("requires operator vault", async () => {
    const context = await createApp(mutation);
    context.auth.mockRejectedValue(Object.assign(new Error("Forbidden"), { statusCode: 403 }));
    expect((await context.inject()).statusCode).toBe(403);
    expect(context.writes).not.toHaveBeenCalled();
  });
  it("retains committed truth when response serialization fails", async () => {
    const context = await createApp(mutation);
    context.app.addHook("preSerialization", async () => { throw new Error("Projection failed"); });
    expect((await context.inject()).statusCode).toBe(500);
    expect(context.committed).toEqual([true]);
    expect(storage.citadels.getVaultSnapshot(context.citadelId).revision).not.toBe(context.snapshot.revision);
  });
  it("awaits durable idempotency acknowledgement before sending a successful response", async () => {
    const context = await createApp(mutation);
    let persisted = false;
    context.app.addHook("onRequest", async (request) => {
      request.mutationIdempotencyCommit = async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        persisted = true;
      };
    });
    context.app.addHook("onSend", async (_request, _reply, payload) => { expect(persisted).toBe(true); return payload; });
    expect((await context.inject()).statusCode).toBe(mutation.method === "POST" ? 201 : 200);
    expect(persisted).toBe(true);
  });
});

it("reads only Vault metadata through operator auth", async () => {
  const context = await createApp(mutations[0]);
  const response = await context.app.inject({ method: "GET", url: `/api/v1/citadels/${context.citadelId}/vault-secrets` });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual(context.snapshot);
  expect(context.auth).toHaveBeenCalledOnce();
  expect(context.writes).not.toHaveBeenCalled();
});
