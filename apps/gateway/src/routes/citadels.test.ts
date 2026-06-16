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

  it("lists council members", async () => {
    const listCouncil = vi.fn(() => [{ memberId: "m1", name: "CoS" }]);
    const built = buildApp({ listCouncil });
    app = built.app;
    await app.register(citadelsRoutes);

    const response = await app.inject({ method: "GET", url: "/api/v1/citadels/ws-1/council" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [{ memberId: "m1", name: "CoS" }] });
    expect(listCouncil).toHaveBeenCalledWith("ws-1");
  });

  it("adds a council member scoped to the citadel", async () => {
    const addCouncilMember = vi.fn((input: Record<string, unknown>) => ({ memberId: "m1", ...input }));
    const built = buildApp({ addCouncilMember });
    app = built.app;
    await app.register(citadelsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/citadels/ws-1/council",
      payload: { name: "Chief of Staff", archetype: "chief_of_staff", role: "coordinate" },
    });
    expect(response.statusCode).toBe(201);
    expect(addCouncilMember).toHaveBeenCalledWith(
      expect.objectContaining({ citadelId: "ws-1", name: "Chief of Staff", archetype: "chief_of_staff" }),
    );
  });

  it("rejects a council member with an invalid archetype", async () => {
    const addCouncilMember = vi.fn();
    const built = buildApp({ addCouncilMember });
    app = built.app;
    await app.register(citadelsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/citadels/ws-1/council",
      payload: { name: "X", archetype: "wizard", role: "y" },
    });
    expect(response.statusCode).toBe(400);
    expect(addCouncilMember).not.toHaveBeenCalled();
  });

  it("returns 404 when removing a missing council member", async () => {
    const removeCouncilMember = vi.fn(() => false);
    const built = buildApp({ removeCouncilMember });
    app = built.app;
    await app.register(citadelsRoutes);

    const response = await app.inject({ method: "DELETE", url: "/api/v1/citadels/ws-1/council/m9" });
    expect(response.statusCode).toBe(404);
    expect(removeCouncilMember).toHaveBeenCalledWith("m9");
  });

  it("lists and creates missions scoped to a citadel", async () => {
    const listMissions = vi.fn(() => [{ missionId: "m1", title: "Plan" }]);
    const createMission = vi.fn((input: Record<string, unknown>) => ({ missionId: "m2", state: "draft", ...input }));
    const built = buildApp({ listMissions, createMission });
    app = built.app;
    await app.register(citadelsRoutes);

    const list = await app.inject({ method: "GET", url: "/api/v1/citadels/ws-1/missions" });
    expect(list.statusCode).toBe(200);
    expect(listMissions).toHaveBeenCalledWith("ws-1");

    const create = await app.inject({
      method: "POST",
      url: "/api/v1/citadels/ws-1/missions",
      payload: { title: "Plan week", objective: "plan" },
    });
    expect(create.statusCode).toBe(201);
    expect(createMission).toHaveBeenCalledWith(
      expect.objectContaining({ citadelId: "ws-1", title: "Plan week", objective: "plan" }),
    );
  });

  it("transitions a mission state", async () => {
    const updateMissionState = vi.fn((missionId: string, state: string) => ({ missionId, state }));
    const built = buildApp({ updateMissionState });
    app = built.app;
    await app.register(citadelsRoutes);

    const response = await app.inject({ method: "PATCH", url: "/api/v1/missions/m1", payload: { state: "running" } });
    expect(response.statusCode).toBe(200);
    expect(updateMissionState).toHaveBeenCalledWith("m1", "running");
  });

  it("rejects an invalid mission state", async () => {
    const updateMissionState = vi.fn();
    const built = buildApp({ updateMissionState });
    app = built.app;
    await app.register(citadelsRoutes);

    const response = await app.inject({ method: "PATCH", url: "/api/v1/missions/m1", payload: { state: "bogus" } });
    expect(response.statusCode).toBe(400);
    expect(updateMissionState).not.toHaveBeenCalled();
  });

  it("returns 404 for a missing mission on patch", async () => {
    const updateMissionState = vi.fn(() => undefined);
    const built = buildApp({ updateMissionState });
    app = built.app;
    await app.register(citadelsRoutes);

    const response = await app.inject({ method: "PATCH", url: "/api/v1/missions/m9", payload: { state: "running" } });
    expect(response.statusCode).toBe(404);
  });
});
