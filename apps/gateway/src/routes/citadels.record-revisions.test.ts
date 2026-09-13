import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConflictError } from "@goatcitadel/contracts";
import { citadelsRoutes } from "./citadels.js";

const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });
const revision = "b".repeat(64);
const mutations = [
  { method: "PATCH", path: "", owner: "updateRecord", fields: { name: "Draft" } },
  { method: "POST", path: "/archive", owner: "archiveRecord", fields: {} },
  { method: "POST", path: "/restore", owner: "restoreRecord", fields: {} },
] as const;

async function createApp() {
  const record = { citadelId: "reviewed", name: "Saved Citadel", revision: "c".repeat(64) };
  const citadels = { updateRecord: vi.fn(async () => record), archiveRecord: vi.fn(async () => record), restoreRecord: vi.fn(async () => record) };
  const app = Fastify(); apps.push(app); const committed: boolean[] = [];
  app.decorate("services", { citadels } as never);
  const requireOperatorAuth = vi.fn(async () => undefined);
  app.decorate("requireOperatorAuth", requireOperatorAuth);
  app.addHook("onSend", async (request, _reply, payload) => { committed.push(request.mutationCommitted === true); return payload; });
  await app.register(citadelsRoutes);
  return { app, citadels, committed, record, requireOperatorAuth };
}

describe.each(mutations)("Citadel profile $owner revision", (mutation) => {
  it.each([undefined, null, "", "bad", "z".repeat(64), 7])("rejects %s before the owner runs", async (expectedRevision) => {
    const { app, citadels, committed } = await createApp();
    const response = await app.inject({ method: mutation.method, url: `/api/v1/citadels/reviewed${mutation.path}`,
      payload: { ...mutation.fields, expectedRevision } });
    expect(response.statusCode).toBe(400);
    expect(citadels[mutation.owner]).not.toHaveBeenCalled();
    expect(committed).toEqual([false]);
  });

  it("requires operator access and forwards the reviewed revision exactly once", async () => {
    const { app, citadels, committed, record, requireOperatorAuth } = await createApp();
    const response = await app.inject({ method: mutation.method, url: `/api/v1/citadels/reviewed${mutation.path}`,
      payload: { ...mutation.fields, expectedRevision: revision } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(record);
    expect(requireOperatorAuth).toHaveBeenCalledOnce();
    expect(citadels[mutation.owner]).toHaveBeenCalledExactlyOnceWith("reviewed",
      mutation.owner === "updateRecord" ? { ...mutation.fields, expectedRevision: revision } : revision);
    expect(committed).toEqual([true]);
  });

  it("returns a structured conflict without marking the rejected mutation committed", async () => {
    const { app, citadels, committed } = await createApp();
    citadels[mutation.owner].mockRejectedValue(new ConflictError({ code: "WRITE_CONFLICT", message: "Citadel changed",
      details: { reason: "CITADEL_RECORD_REVISION_CONFLICT" } }));
    const response = await app.inject({ method: mutation.method, url: `/api/v1/citadels/reviewed${mutation.path}`,
      payload: { ...mutation.fields, expectedRevision: revision } });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "WRITE_CONFLICT", details: { reason: "CITADEL_RECORD_REVISION_CONFLICT" } });
    expect(committed).toEqual([false]);
  });

  it("preserves commit truth when serializing the response fails", async () => {
    const { app, committed } = await createApp();
    app.addHook("preSerialization", async () => { throw new Error("response projection failed"); });
    const response = await app.inject({ method: mutation.method, url: `/api/v1/citadels/reviewed${mutation.path}`,
      payload: { ...mutation.fields, expectedRevision: revision } });
    expect(response.statusCode).toBe(500);
    expect(committed).toEqual([true]);
  });
});
