import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { citadelsRoutes } from "./citadels.js";

function buildApp(citadels: Record<string, unknown>, requireOperatorAuth = vi.fn(async () => undefined)) {
  const app = Fastify();
  app.decorate("services", { citadels } as never);
  app.decorate("requireOperatorAuth", requireOperatorAuth as never);
  return { app, requireOperatorAuth };
}

describe("citadels routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  it("returns 404 when the citadel has no charter", async () => {
    const built = buildApp({ getCitadel: vi.fn(() => undefined) });
    app = built.app;
    await app.register(citadelsRoutes);

    const response = await app.inject({ method: "GET", url: "/api/v1/citadels/ws-1" });
    expect(response.statusCode).toBe(404);
  });

  it("upserts a charter scoped to the citadel id from the path", async () => {
    const upsertCharter = vi.fn((input: Record<string, unknown>) => ({ ...input, createdAt: "t", updatedAt: "t" }));
    const built = buildApp({ upsertCharter });
    app = built.app;
    await app.register(citadelsRoutes);

    const response = await app.inject({
      method: "PUT",
      url: "/api/v1/citadels/ws-1/charter",
      payload: { purpose: "Run the company", kind: "company", goals: ["ship 1.0"] },
    });

    expect(response.statusCode).toBe(200);
    expect(upsertCharter).toHaveBeenCalledWith(
      expect.objectContaining({ citadelId: "ws-1", purpose: "Run the company", kind: "company", goals: ["ship 1.0"] }),
    );
  });

  it("rejects an invalid charter kind", async () => {
    const upsertCharter = vi.fn();
    const built = buildApp({ upsertCharter });
    app = built.app;
    await app.register(citadelsRoutes);

    const response = await app.inject({
      method: "PUT",
      url: "/api/v1/citadels/ws-1/charter",
      payload: { purpose: "x", kind: "not-a-kind" },
    });

    expect(response.statusCode).toBe(400);
    expect(upsertCharter).not.toHaveBeenCalled();
  });

  it("creates a chamber scoped to the citadel", async () => {
    const createChamber = vi.fn((input: Record<string, unknown>) => ({
      chamberId: "ch-1",
      ...input,
      sealed: Boolean(input.sealed),
      createdAt: "t",
      updatedAt: "t",
    }));
    const built = buildApp({ createChamber });
    app = built.app;
    await app.register(citadelsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/citadels/ws-1/chambers",
      payload: { name: "Finance", sensitivity: "restricted", sealed: true },
    });

    expect(response.statusCode).toBe(201);
    expect(createChamber).toHaveBeenCalledWith(
      expect.objectContaining({ citadelId: "ws-1", name: "Finance", sensitivity: "restricted", sealed: true }),
    );
  });

  it("lists chambers for a citadel", async () => {
    const listChambers = vi.fn(() => [{ chamberId: "ch-1", name: "General" }]);
    const built = buildApp({ listChambers });
    app = built.app;
    await app.register(citadelsRoutes);

    const response = await app.inject({ method: "GET", url: "/api/v1/citadels/ws-1/chambers" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [{ chamberId: "ch-1", name: "General" }] });
    expect(listChambers).toHaveBeenCalledWith("ws-1");
  });

  it("returns a gatehouse summary for an existing citadel", async () => {
    const getGatehouse = vi.fn(() => ({ citadelId: "ws-1", chamberCount: 2, sealedChamberCount: 1 }));
    const built = buildApp({ getGatehouse });
    app = built.app;
    await app.register(citadelsRoutes);

    const response = await app.inject({ method: "GET", url: "/api/v1/citadels/ws-1/gatehouse" });
    expect(response.statusCode).toBe(200);
    expect(getGatehouse).toHaveBeenCalledWith("ws-1");
  });

  it("returns 404 for a gatehouse summary on a missing citadel", async () => {
    const getGatehouse = vi.fn(() => undefined);
    const built = buildApp({ getGatehouse });
    app = built.app;
    await app.register(citadelsRoutes);

    const response = await app.inject({ method: "GET", url: "/api/v1/citadels/ws-1/gatehouse" });
    expect(response.statusCode).toBe(404);
  });

  it("lists citadel templates", async () => {
    const listTemplates = vi.fn(() => [{ id: "t1", name: "T1" }]);
    const built = buildApp({ listTemplates });
    app = built.app;
    await app.register(citadelsRoutes);

    const response = await app.inject({ method: "GET", url: "/api/v1/citadel-templates" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [{ id: "t1", name: "T1" }] });
  });

  it("creates a citadel from a template", async () => {
    const createFromTemplate = vi.fn((citadelId: string) => ({ citadelId, charter: { kind: "company" }, chambers: [] }));
    const built = buildApp({ createFromTemplate });
    app = built.app;
    await app.register(citadelsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/citadels/ws-1/from-template",
      payload: { templateId: "company-co-founder" },
    });
    expect(response.statusCode).toBe(201);
    expect(createFromTemplate).toHaveBeenCalledWith("ws-1", "company-co-founder");
  });

  it("returns 404 for an unknown template", async () => {
    const createFromTemplate = vi.fn(() => undefined);
    const built = buildApp({ createFromTemplate });
    app = built.app;
    await app.register(citadelsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/citadels/ws-1/from-template",
      payload: { templateId: "nope" },
    });
    expect(response.statusCode).toBe(404);
  });

  it("exports a blueprint for an existing citadel", async () => {
    const exportBlueprint = vi.fn(() => ({ schemaVersion: "goatcitadel.blueprint.v1" }));
    const built = buildApp({ exportBlueprint });
    app = built.app;
    await app.register(citadelsRoutes);

    const response = await app.inject({ method: "GET", url: "/api/v1/citadels/ws-1/blueprint" });
    expect(response.statusCode).toBe(200);
    expect(exportBlueprint).toHaveBeenCalledWith("ws-1");
  });

  it("validates a blueprint via the route", async () => {
    const validateBlueprint = vi.fn(() => ({ ok: true, errors: [] }));
    const built = buildApp({ validateBlueprint });
    app = built.app;
    await app.register(citadelsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/blueprints/validate",
      payload: { schemaVersion: "x" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, errors: [] });
  });

  it("rejects importing an invalid blueprint", async () => {
    const createFromBlueprint = vi.fn(() => ({ ok: false, errors: ["bad"] }));
    const built = buildApp({ createFromBlueprint });
    app = built.app;
    await app.register(citadelsRoutes);

    const response = await app.inject({ method: "POST", url: "/api/v1/citadels/ws-1/from-blueprint", payload: {} });
    expect(response.statusCode).toBe(400);
  });

  it("imports a valid blueprint", async () => {
    const createFromBlueprint = vi.fn((citadelId: string) => ({
      ok: true,
      citadel: { citadelId, charter: {}, chambers: [] },
    }));
    const built = buildApp({ createFromBlueprint });
    app = built.app;
    await app.register(citadelsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/citadels/ws-1/from-blueprint",
      payload: { schemaVersion: "goatcitadel.blueprint.v1" },
    });
    expect(response.statusCode).toBe(201);
    expect(createFromBlueprint).toHaveBeenCalledWith("ws-1", { schemaVersion: "goatcitadel.blueprint.v1" });
  });

  it("lists the council (agent assignments) for a citadel", async () => {
    const listCouncil = vi.fn(() => [{ assignmentId: "a1", agentId: "agent-architect" }]);
    const built = buildApp({ listCouncil });
    app = built.app;
    await app.register(citadelsRoutes);

    const response = await app.inject({ method: "GET", url: "/api/v1/citadels/ws-1/council" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [{ assignmentId: "a1", agentId: "agent-architect" }] });
    expect(listCouncil).toHaveBeenCalledWith("ws-1");
  });

  it("assigns an existing agent to the council", async () => {
    const assignAgent = vi.fn((input: Record<string, unknown>) => ({ assignmentId: "a1", ...input }));
    const built = buildApp({ assignAgent });
    app = built.app;
    await app.register(citadelsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/citadels/ws-1/council",
      payload: { agentId: "agent-architect" },
    });
    expect(response.statusCode).toBe(201);
    expect(assignAgent).toHaveBeenCalledWith({ citadelId: "ws-1", agentId: "agent-architect" });
  });

  it("rejects a council assignment without an agentId", async () => {
    const assignAgent = vi.fn();
    const built = buildApp({ assignAgent });
    app = built.app;
    await app.register(citadelsRoutes);

    const response = await app.inject({ method: "POST", url: "/api/v1/citadels/ws-1/council", payload: {} });
    expect(response.statusCode).toBe(400);
    expect(assignAgent).not.toHaveBeenCalled();
  });

  it("returns 404 when unassigning an agent that is not on the council", async () => {
    const unassignAgent = vi.fn(() => false);
    const built = buildApp({ unassignAgent });
    app = built.app;
    await app.register(citadelsRoutes);

    const response = await app.inject({ method: "DELETE", url: "/api/v1/citadels/ws-1/council/agent-x" });
    expect(response.statusCode).toBe(404);
    expect(unassignAgent).toHaveBeenCalledWith("ws-1", "agent-x");
  });

  it("lists and creates wards for a citadel", async () => {
    const listWards = vi.fn(() => [{ wardId: "w1", name: "No email" }]);
    const addWard = vi.fn((input: Record<string, unknown>) => ({ wardId: "w2", ...input }));
    const built = buildApp({ listWards, addWard });
    app = built.app;
    await app.register(citadelsRoutes);

    const list = await app.inject({ method: "GET", url: "/api/v1/citadels/ws-1/wards" });
    expect(list.statusCode).toBe(200);
    expect(listWards).toHaveBeenCalledWith("ws-1");

    const create = await app.inject({
      method: "POST",
      url: "/api/v1/citadels/ws-1/wards",
      payload: { name: "No email", actionPattern: "email.send", effect: "deny" },
    });
    expect(create.statusCode).toBe(201);
    expect(addWard).toHaveBeenCalledWith(
      expect.objectContaining({ citadelId: "ws-1", actionPattern: "email.send", effect: "deny" }),
    );
  });

  it("rejects a ward with an invalid effect", async () => {
    const addWard = vi.fn();
    const built = buildApp({ addWard });
    app = built.app;
    await app.register(citadelsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/citadels/ws-1/wards",
      payload: { name: "x", actionPattern: "y", effect: "bogus" },
    });
    expect(response.statusCode).toBe(400);
    expect(addWard).not.toHaveBeenCalled();
  });

  it("returns 404 when removing a missing ward", async () => {
    const removeWard = vi.fn(() => false);
    const built = buildApp({ removeWard });
    app = built.app;
    await app.register(citadelsRoutes);

    const response = await app.inject({ method: "DELETE", url: "/api/v1/citadels/ws-1/wards/w9" });
    expect(response.statusCode).toBe(404);
    expect(removeWard).toHaveBeenCalledWith("ws-1", "w9");
  });

  it("lists and creates passages for a citadel", async () => {
    const listPassages = vi.fn(() => [{ passageId: "p1", destinationCitadelId: "ws-2" }]);
    const createPassage = vi.fn((input: Record<string, unknown>) => ({ passageId: "p2", ...input }));
    const built = buildApp({ listPassages, createPassage });
    app = built.app;
    await app.register(citadelsRoutes);

    const list = await app.inject({ method: "GET", url: "/api/v1/citadels/ws-1/passages" });
    expect(list.statusCode).toBe(200);
    expect(listPassages).toHaveBeenCalledWith("ws-1");

    const create = await app.inject({
      method: "POST",
      url: "/api/v1/citadels/ws-1/passages",
      payload: { destinationCitadelId: "ws-2", allowedFields: ["availability"] },
    });
    expect(create.statusCode).toBe(201);
    expect(createPassage).toHaveBeenCalledWith(
      expect.objectContaining({ sourceCitadelId: "ws-1", destinationCitadelId: "ws-2", allowedFields: ["availability"] }),
    );
  });

  it("rejects a passage without allowedFields", async () => {
    const createPassage = vi.fn();
    const built = buildApp({ createPassage });
    app = built.app;
    await app.register(citadelsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/citadels/ws-1/passages",
      payload: { destinationCitadelId: "ws-2" },
    });
    expect(response.statusCode).toBe(400);
    expect(createPassage).not.toHaveBeenCalled();
  });

  it("returns 404 when removing a missing passage", async () => {
    const removePassage = vi.fn(() => false);
    const built = buildApp({ removePassage });
    app = built.app;
    await app.register(citadelsRoutes);

    const response = await app.inject({ method: "DELETE", url: "/api/v1/citadels/ws-1/passages/p9" });
    expect(response.statusCode).toBe(404);
    expect(removePassage).toHaveBeenCalledWith("ws-1", "p9");
  });

  it("lists and upserts members for a citadel", async () => {
    const listMembers = vi.fn(() => [{ memberId: "m1", subjectId: "alice", role: "operator" }]);
    const upsertMember = vi.fn((input: Record<string, unknown>) => ({ memberId: "m2", ...input }));
    const built = buildApp({ listMembers, upsertMember });
    app = built.app;
    await app.register(citadelsRoutes);

    const list = await app.inject({ method: "GET", url: "/api/v1/citadels/ws-1/members" });
    expect(list.statusCode).toBe(200);
    expect(listMembers).toHaveBeenCalledWith("ws-1");

    const create = await app.inject({
      method: "POST",
      url: "/api/v1/citadels/ws-1/members",
      payload: { subjectId: "alice", role: "operator" },
    });
    expect(create.statusCode).toBe(201);
    expect(upsertMember).toHaveBeenCalledWith(
      expect.objectContaining({ citadelId: "ws-1", subjectId: "alice", role: "operator" }),
    );
  });

  it("rejects a member with an invalid role", async () => {
    const upsertMember = vi.fn();
    const built = buildApp({ upsertMember });
    app = built.app;
    await app.register(citadelsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/citadels/ws-1/members",
      payload: { subjectId: "x", role: "wizard" },
    });
    expect(response.statusCode).toBe(400);
    expect(upsertMember).not.toHaveBeenCalled();
  });

  it("returns 404 when removing a missing member", async () => {
    const removeMember = vi.fn(() => false);
    const built = buildApp({ removeMember });
    app = built.app;
    await app.register(citadelsRoutes);

    const response = await app.inject({ method: "DELETE", url: "/api/v1/citadels/ws-1/members/ghost" });
    expect(response.statusCode).toBe(404);
    expect(removeMember).toHaveBeenCalledWith("ws-1", "ghost");
  });
});
