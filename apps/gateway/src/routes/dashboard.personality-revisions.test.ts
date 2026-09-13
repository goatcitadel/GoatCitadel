import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConflictError } from "@goatcitadel/contracts";
import { dashboardRoutes } from "./dashboard.js";

const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });
const revision = "b".repeat(64);
const mutations = [
  { method: "POST", path: "", owner: "createPersonality", fields: { label: "Draft" } },
  { method: "PATCH", path: "/operator", owner: "updatePersonality", fields: { label: "Draft" } },
  { method: "DELETE", path: "/operator", owner: "deletePersonality", fields: {} },
  { method: "PATCH", path: "/default", owner: "setDefaultPersonality", fields: { personalityId: "teacher" } },
] as const;

async function createApp() {
  const catalog = { revision: "c".repeat(64), items: [], defaultPersonalityId: "teacher" };
  const settings = { getPersonalityCatalog: vi.fn(async () => catalog), createPersonality: vi.fn(async () => catalog),
    updatePersonality: vi.fn(async () => catalog), deletePersonality: vi.fn(async () => catalog), setDefaultPersonality: vi.fn(async () => catalog) };
  const app = Fastify(); apps.push(app); const committed: boolean[] = [];
  app.decorate("services", { settings } as never);
  app.addHook("onSend", async (request, _reply, payload) => { committed.push(request.mutationCommitted === true); return payload; });
  await app.register(dashboardRoutes);
  return { app, settings, committed, catalog };
}

describe.each(mutations)("personality $owner revision", (mutation) => {
  it.each([undefined, null, "", "bad", "z".repeat(64), 7])("rejects %s before the owner runs", async (expectedRevision) => {
    const { app, settings, committed } = await createApp();
    const response = await app.inject({ method: mutation.method, url: `/api/v1/personalities${mutation.path}`,
      payload: { ...mutation.fields, expectedRevision } });
    expect(response.statusCode).toBe(400);
    expect(settings[mutation.owner]).not.toHaveBeenCalled();
    expect(committed).toEqual([false]);
  });

  it("forwards the reviewed revision and marks only a successful owner result committed", async () => {
    const { app, settings, committed, catalog } = await createApp();
    const response = await app.inject({ method: mutation.method, url: `/api/v1/personalities${mutation.path}`,
      payload: { ...mutation.fields, expectedRevision: revision } });
    expect(response.statusCode).toBe(mutation.method === "POST" ? 201 : 200);
    expect(response.json()).toEqual(catalog);
    const args = mutation.owner === "createPersonality" ? [{ ...mutation.fields, expectedRevision: revision }]
      : mutation.owner === "updatePersonality" ? ["operator", { ...mutation.fields, expectedRevision: revision }]
      : mutation.owner === "deletePersonality" ? ["operator", revision] : ["teacher", revision];
    expect(settings[mutation.owner]).toHaveBeenCalledExactlyOnceWith(...args);
    expect(settings.getPersonalityCatalog).not.toHaveBeenCalled();
    expect(committed).toEqual([true]);
  });

  it("returns a structured 409 without marking a rejected mutation committed", async () => {
    const { app, settings, committed } = await createApp();
    settings[mutation.owner].mockRejectedValue(new ConflictError({ code: "WRITE_CONFLICT", message: "Catalog changed",
      details: { reason: "PERSONALITY_CATALOG_REVISION_CONFLICT" } }));
    const response = await app.inject({ method: mutation.method, url: `/api/v1/personalities${mutation.path}`,
      payload: { ...mutation.fields, expectedRevision: revision } });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "WRITE_CONFLICT", details: { reason: "PERSONALITY_CATALOG_REVISION_CONFLICT" } });
    expect(committed).toEqual([false]);
  });

  it("keeps commit truth when response projection fails", async () => {
    const { app, committed } = await createApp();
    app.addHook("preSerialization", async () => { throw new Error("response projection failed"); });
    const response = await app.inject({ method: mutation.method, url: `/api/v1/personalities${mutation.path}`,
      payload: { ...mutation.fields, expectedRevision: revision } });
    expect(response.statusCode).toBe(500);
    expect(committed).toEqual([true]);
  });
});
