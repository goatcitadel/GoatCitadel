import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConflictError } from "@goatcitadel/contracts";
import { citadelsRoutes } from "./citadels.js";

const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });
const revision = "b".repeat(64);
const templateRevision = "d".repeat(64);
const mutations = [
  { method: "PUT", path: "/charter", owner: "upsertCharter", fields: { purpose: "Reviewed", kind: "custom" } },
  { method: "POST", path: "/chambers", owner: "createChamber", fields: { name: "Reviewed" } },
  { method: "POST", path: "/from-template", owner: "createFromTemplate", fields: { templateId: "company-co-founder", expectedTemplateRevision: templateRevision } },
  { method: "POST", path: "/from-blueprint", owner: "createFromBlueprint", fields: { blueprint: { schemaVersion: "fixture" } } },
  { method: "POST", path: "/mason/stage", owner: "stageBlueprint", fields: { blueprint: { schemaVersion: "fixture" } } },
] as const;

async function createApp() {
  const snapshot = { citadelId: "reviewed", revision: "c".repeat(64), charter: null, chambers: [] };
  const citadels = {
    getStructureSnapshot: vi.fn(async () => snapshot),
    upsertCharter: vi.fn(async () => snapshot), createChamber: vi.fn(async () => snapshot), createFromTemplate: vi.fn(async () => snapshot),
    createFromBlueprint: vi.fn(async () => ({ ok: true, citadel: snapshot })),
    stageBlueprint: vi.fn(async () => ({ ok: true, citadel: snapshot, review: { summary: "Reviewed" } })),
  };
  const app = Fastify(); apps.push(app); const committed: boolean[] = [];
  app.decorate("services", { citadels } as never);
  const requireOperatorAuth = vi.fn(async () => undefined);
  app.decorate("requireOperatorAuth", requireOperatorAuth);
  app.addHook("onSend", async (request, _reply, payload) => { committed.push(request.mutationCommitted === true); return payload; });
  await app.register(citadelsRoutes);
  return { app, citadels, committed, snapshot, requireOperatorAuth };
}

describe.each(mutations)("Citadel structure $owner revision", (mutation) => {
  it.each([undefined, null, "", "bad", "z".repeat(64), 7])("rejects %s before the owner runs", async (expectedRevision) => {
    const { app, citadels, committed } = await createApp();
    const response = await app.inject({ method: mutation.method, url: `/api/v1/citadels/reviewed${mutation.path}`, payload: { ...mutation.fields, expectedRevision } });
    expect(response.statusCode).toBe(400);
    expect(citadels[mutation.owner]).not.toHaveBeenCalled();
    expect(committed).toEqual([false]);
  });

  it("forwards the exact review and URL scope, then marks the owner acknowledgement committed", async () => {
    const { app, citadels, committed, snapshot, requireOperatorAuth } = await createApp();
    const response = await app.inject({ method: mutation.method, url: `/api/v1/citadels/reviewed${mutation.path}`, payload: { ...mutation.fields, expectedRevision: revision, citadelId: "foreign" } });
    expect(response.statusCode).toBe(mutation.method === "PUT" ? 200 : 201);
    expect(requireOperatorAuth).toHaveBeenCalledOnce();
    const args = mutation.owner === "upsertCharter" || mutation.owner === "createChamber"
      ? [{ ...mutation.fields, expectedRevision: revision, citadelId: "reviewed" }]
      : mutation.owner === "createFromTemplate" ? ["reviewed", mutation.fields.templateId, revision, templateRevision]
      : ["reviewed", mutation.fields.blueprint, revision];
    expect(citadels[mutation.owner]).toHaveBeenCalledExactlyOnceWith(...args);
    expect(mutation.owner === "stageBlueprint" ? response.json().citadel : response.json()).toEqual(snapshot);
    expect(committed).toEqual([true]);
  });

  it("does not run without operator access", async () => {
    const { app, citadels, requireOperatorAuth } = await createApp();
    requireOperatorAuth.mockRejectedValue(Object.assign(new Error("Forbidden"), { statusCode: 403 }));
    const response = await app.inject({ method: mutation.method, url: `/api/v1/citadels/reviewed${mutation.path}`, payload: { ...mutation.fields, expectedRevision: revision } });
    expect(response.statusCode).toBe(403);
    expect(citadels[mutation.owner]).not.toHaveBeenCalled();
  });

  it("returns a typed conflict without committing or retrying", async () => {
    const { app, citadels, committed } = await createApp();
    citadels[mutation.owner].mockRejectedValue(new ConflictError({ code: "WRITE_CONFLICT", message: "Citadel changed", details: { reason: "CITADEL_STRUCTURE_REVISION_CONFLICT" } }));
    const response = await app.inject({ method: mutation.method, url: `/api/v1/citadels/reviewed${mutation.path}`, payload: { ...mutation.fields, expectedRevision: revision } });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "WRITE_CONFLICT", details: { reason: "CITADEL_STRUCTURE_REVISION_CONFLICT" } });
    expect(citadels[mutation.owner]).toHaveBeenCalledOnce();
    expect(committed).toEqual([false]);
  });

  it("preserves commit truth if response serialization fails", async () => {
    const { app, committed } = await createApp();
    app.addHook("preSerialization", async () => { throw new Error("response projection failed"); });
    const response = await app.inject({ method: mutation.method, url: `/api/v1/citadels/reviewed${mutation.path}`, payload: { ...mutation.fields, expectedRevision: revision } });
    expect(response.statusCode).toBe(500);
    expect(committed).toEqual([true]);
  });
});

it.each([undefined, null, "", "bad", "z".repeat(64), 7])("also requires the reviewed template revision (%s)", async (expectedTemplateRevision) => {
  const { app, citadels } = await createApp();
  const response = await app.inject({ method: "POST", url: "/api/v1/citadels/reviewed/from-template", payload: { templateId: "company-co-founder", expectedRevision: revision, expectedTemplateRevision } });
  expect(response.statusCode).toBe(400);
  expect(citadels.createFromTemplate).not.toHaveBeenCalled();
});

it("returns an empty but reviewable structure to operators", async () => {
  const { app, citadels, snapshot, requireOperatorAuth } = await createApp();
  const response = await app.inject({ method: "GET", url: "/api/v1/citadels/reviewed/structure" });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual(snapshot);
  expect(citadels.getStructureSnapshot).toHaveBeenCalledExactlyOnceWith("reviewed");
  expect(requireOperatorAuth).toHaveBeenCalledOnce();
});
