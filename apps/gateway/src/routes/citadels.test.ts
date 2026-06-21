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

  it("lists Citadel identity records with bounded query parameters", async () => {
    const listRecords = vi.fn(() => [{ citadelId: "personal", name: "Personal" }]);
    const built = buildApp({ listRecords });
    app = built.app;
    await app.register(citadelsRoutes);

    const response = await app.inject({ method: "GET", url: "/api/v1/citadels?view=all&limit=999" });

    expect(response.statusCode).toBe(400);

    const ok = await app.inject({ method: "GET", url: "/api/v1/citadels?view=all&limit=500" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ items: [{ citadelId: "personal", name: "Personal" }], view: "all" });
    expect(listRecords).toHaveBeenCalledWith("all", 500);
  });

  it("creates, updates, archives, and restores Citadel identity records", async () => {
    const createRecord = vi.fn((input: Record<string, unknown>) => ({ citadelId: "client", ...input }));
    const updateRecord = vi.fn((citadelId: string, input: Record<string, unknown>) => ({ citadelId, ...input }));
    const archiveRecord = vi.fn((citadelId: string) => ({ citadelId, lifecycleStatus: "archived" }));
    const restoreRecord = vi.fn((citadelId: string) => ({ citadelId, lifecycleStatus: "active" }));
    const built = buildApp({ createRecord, updateRecord, archiveRecord, restoreRecord });
    app = built.app;
    await app.register(citadelsRoutes);

    const createResponse = await app.inject({
      method: "POST",
      url: "/api/v1/citadels",
      payload: { citadelId: "client", name: "Client", kind: "client", defaultWorkspaceId: "delivery" },
    });
    const updateResponse = await app.inject({
      method: "PATCH",
      url: "/api/v1/citadels/client",
      payload: { name: "Client One" },
    });
    const archiveResponse = await app.inject({ method: "POST", url: "/api/v1/citadels/client/archive" });
    const restoreResponse = await app.inject({ method: "POST", url: "/api/v1/citadels/client/restore" });

    expect(createResponse.statusCode).toBe(201);
    expect(updateResponse.statusCode).toBe(200);
    expect(archiveResponse.statusCode).toBe(200);
    expect(restoreResponse.statusCode).toBe(200);
    expect(createRecord).toHaveBeenCalledWith({
      citadelId: "client",
      name: "Client",
      kind: "client",
      defaultWorkspaceId: "delivery",
    });
    expect(updateRecord).toHaveBeenCalledWith("client", { name: "Client One" });
    expect(archiveRecord).toHaveBeenCalledWith("client");
    expect(restoreRecord).toHaveBeenCalledWith("client");
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
    const createFromTemplate = vi.fn((citadelId: string) => ({
      citadelId,
      charter: { kind: "company" },
      chambers: [],
    }));
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

  it("stores and lists vault secrets (metadata only)", async () => {
    const listVaultSecrets = vi.fn(() => [{ secretId: "s1", secretName: "stripe", createdAt: "t", updatedAt: "t" }]);
    const storeVaultSecret = vi.fn(() => ({
      ok: true as const,
      secret: { secretId: "s1", secretName: "stripe", createdAt: "t", updatedAt: "t" },
    }));
    const built = buildApp({ listVaultSecrets, storeVaultSecret });
    app = built.app;
    await app.register(citadelsRoutes);

    const list = await app.inject({ method: "GET", url: "/api/v1/citadels/ws-1/vault-secrets" });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({ items: [{ secretId: "s1", secretName: "stripe", createdAt: "t", updatedAt: "t" }] });

    const create = await app.inject({
      method: "POST",
      url: "/api/v1/citadels/ws-1/vault-secrets",
      payload: { name: "stripe", value: "sk-live-123" },
    });
    expect(create.statusCode).toBe(201);
    expect(storeVaultSecret).toHaveBeenCalledWith("ws-1", "stripe", "sk-live-123");
    // The response never carries the value.
    expect(JSON.stringify(create.json())).not.toContain("sk-live-123");
  });

  it("returns 503 when the vault is unavailable", async () => {
    const storeVaultSecret = vi.fn(() => ({ ok: false as const, reason: "unavailable" as const }));
    const built = buildApp({ storeVaultSecret });
    app = built.app;
    await app.register(citadelsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/citadels/ws-1/vault-secrets",
      payload: { name: "stripe", value: "sk-live-123" },
    });
    expect(response.statusCode).toBe(503);
  });

  it("reveals a vault secret, and 404s a missing one", async () => {
    const revealVaultSecret = vi.fn((_cid: string, secretId: string) =>
      secretId === "s1"
        ? { ok: true as const, value: "sk-live-123" }
        : { ok: false as const, reason: "not_found" as const },
    );
    const built = buildApp({ revealVaultSecret });
    app = built.app;
    await app.register(citadelsRoutes);

    const ok = await app.inject({ method: "GET", url: "/api/v1/citadels/ws-1/vault-secrets/s1/reveal" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ value: "sk-live-123" });

    const missing = await app.inject({ method: "GET", url: "/api/v1/citadels/ws-1/vault-secrets/nope/reveal" });
    expect(missing.statusCode).toBe(404);
  });

  it("deletes a vault secret and 404s a missing one", async () => {
    const deleteVaultSecret = vi.fn((_cid: string, secretId: string) => secretId === "s1");
    const built = buildApp({ deleteVaultSecret });
    app = built.app;
    await app.register(citadelsRoutes);

    const ok = await app.inject({ method: "DELETE", url: "/api/v1/citadels/ws-1/vault-secrets/s1" });
    expect(ok.statusCode).toBe(204);
    expect(deleteVaultSecret).toHaveBeenCalledWith("ws-1", "s1");

    const missing = await app.inject({ method: "DELETE", url: "/api/v1/citadels/ws-1/vault-secrets/nope" });
    expect(missing.statusCode).toBe(404);
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
      expect.objectContaining({
        sourceCitadelId: "ws-1",
        destinationCitadelId: "ws-2",
        allowedFields: ["availability"],
      }),
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

  it("lists the Mason setup questions", async () => {
    const getMasonSetupQuestions = vi.fn(() => ["q1", "q2"]);
    const built = buildApp({ getMasonSetupQuestions });
    app = built.app;
    await app.register(citadelsRoutes);

    const response = await app.inject({ method: "GET", url: "/api/v1/mason/setup-questions" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: ["q1", "q2"] });
  });

  it("reviews a valid blueprint via the Mason", async () => {
    const reviewBlueprint = vi.fn(() => ({ ok: true, review: { name: "Co", chamberCount: 2 } }));
    const built = buildApp({ reviewBlueprint });
    app = built.app;
    await app.register(citadelsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/mason/review",
      payload: { schemaVersion: "goatcitadel.blueprint.v1" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ name: "Co", chamberCount: 2 });
  });

  it("rejects reviewing an invalid blueprint", async () => {
    const reviewBlueprint = vi.fn(() => ({ ok: false, errors: ["bad"] }));
    const built = buildApp({ reviewBlueprint });
    app = built.app;
    await app.register(citadelsRoutes);

    const response = await app.inject({ method: "POST", url: "/api/v1/mason/review", payload: {} });
    expect(response.statusCode).toBe(400);
  });

  it("evaluates an action against the citadel's wards", async () => {
    const evaluateGatehouseAction = vi.fn(() => "require_approval");
    const built = buildApp({ evaluateGatehouseAction });
    app = built.app;
    await app.register(citadelsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/citadels/ws-1/gatehouse/evaluate",
      payload: { action: "email.send" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ action: "email.send", effect: "require_approval" });
    expect(evaluateGatehouseAction).toHaveBeenCalledWith("ws-1", "email.send");
  });

  it("rejects a gatehouse evaluation without an action", async () => {
    const evaluateGatehouseAction = vi.fn();
    const built = buildApp({ evaluateGatehouseAction });
    app = built.app;
    await app.register(citadelsRoutes);

    const response = await app.inject({ method: "POST", url: "/api/v1/citadels/ws-1/gatehouse/evaluate", payload: {} });
    expect(response.statusCode).toBe(400);
    expect(evaluateGatehouseAction).not.toHaveBeenCalled();
  });

  it("stages a citadel from a blueprint via the Mason", async () => {
    const stageBlueprint = vi.fn((citadelId: string) => ({
      ok: true,
      citadel: { citadelId, charter: {}, chambers: [] },
      review: { name: "Co" },
    }));
    const built = buildApp({ stageBlueprint });
    app = built.app;
    await app.register(citadelsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/citadels/ws-1/mason/stage",
      payload: { schemaVersion: "goatcitadel.blueprint.v1" },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      citadel: { citadelId: "ws-1", charter: {}, chambers: [] },
      review: { name: "Co" },
    });
    expect(stageBlueprint).toHaveBeenCalledWith("ws-1", { schemaVersion: "goatcitadel.blueprint.v1" });
  });

  it("rejects staging an invalid blueprint via the Mason", async () => {
    const stageBlueprint = vi.fn(() => ({ ok: false, errors: ["bad"] }));
    const built = buildApp({ stageBlueprint });
    app = built.app;
    await app.register(citadelsRoutes);

    const response = await app.inject({ method: "POST", url: "/api/v1/citadels/ws-1/mason/stage", payload: {} });
    expect(response.statusCode).toBe(400);
  });

  it("drafts a blueprint from Mason answers", async () => {
    const draftBlueprint = vi.fn((answers: Record<string, unknown>) => ({
      schemaVersion: "goatcitadel.blueprint.v1",
      charter: { kind: answers.kind },
    }));
    const built = buildApp({ draftBlueprint });
    app = built.app;
    await app.register(citadelsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/mason/draft",
      payload: { kind: "company", purpose: "Run the company", sensitiveAreas: ["Payroll"] },
    });
    expect(response.statusCode).toBe(200);
    expect(draftBlueprint).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "company", purpose: "Run the company", sensitiveAreas: ["Payroll"] }),
    );
  });

  it("rejects a Mason draft with an invalid kind", async () => {
    const draftBlueprint = vi.fn();
    const built = buildApp({ draftBlueprint });
    app = built.app;
    await app.register(citadelsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/mason/draft",
      payload: { kind: "wizard", purpose: "x" },
    });
    expect(response.statusCode).toBe(400);
    expect(draftBlueprint).not.toHaveBeenCalled();
  });

  it("creates a mason session, accumulates answers, and drafts", async () => {
    const createMasonSession = vi.fn(() => ({ sessionId: "s1", answers: {}, status: "collecting" }));
    const updateMasonSessionAnswers = vi.fn((sessionId: string, patch: Record<string, unknown>) => ({
      sessionId,
      answers: patch,
      status: "collecting",
    }));
    const getMasonSession = vi.fn(() => ({
      sessionId: "s1",
      answers: { kind: "company", purpose: "x" },
      status: "collecting",
    }));
    const draftFromSession = vi.fn(() => ({ ok: true, blueprint: { schemaVersion: "goatcitadel.blueprint.v1" } }));
    const built = buildApp({ createMasonSession, updateMasonSessionAnswers, getMasonSession, draftFromSession });
    app = built.app;
    await app.register(citadelsRoutes);

    const create = await app.inject({ method: "POST", url: "/api/v1/mason/sessions" });
    expect(create.statusCode).toBe(201);
    expect(create.json()).toEqual({ sessionId: "s1", answers: {}, status: "collecting" });

    const get = await app.inject({ method: "GET", url: "/api/v1/mason/sessions/s1" });
    expect(get.statusCode).toBe(200);
    expect(getMasonSession).toHaveBeenCalledWith("s1");

    const answers = await app.inject({
      method: "POST",
      url: "/api/v1/mason/sessions/s1/answers",
      payload: { kind: "company" },
    });
    expect(answers.statusCode).toBe(200);
    expect(updateMasonSessionAnswers).toHaveBeenCalledWith("s1", { kind: "company" });

    const draft = await app.inject({ method: "POST", url: "/api/v1/mason/sessions/s1/draft" });
    expect(draft.statusCode).toBe(200);
    expect(draftFromSession).toHaveBeenCalledWith("s1");
  });

  it("returns 400 drafting an incomplete mason session", async () => {
    const draftFromSession = vi.fn(() => ({ ok: false, reason: "incomplete" }));
    const built = buildApp({ draftFromSession });
    app = built.app;
    await app.register(citadelsRoutes);

    const response = await app.inject({ method: "POST", url: "/api/v1/mason/sessions/s1/draft" });
    expect(response.statusCode).toBe(400);
  });

  it("returns 404 for a missing mason session", async () => {
    const getMasonSession = vi.fn(() => undefined);
    const built = buildApp({ getMasonSession });
    app = built.app;
    await app.register(citadelsRoutes);

    const response = await app.inject({ method: "GET", url: "/api/v1/mason/sessions/nope" });
    expect(response.statusCode).toBe(404);
  });

  it("lists and creates integration grants for a citadel", async () => {
    const listIntegrations = vi.fn(() => [{ grantId: "g1", provider: "stripe" }]);
    const addIntegration = vi.fn((input: Record<string, unknown>) => ({ grantId: "g2", ...input }));
    const built = buildApp({ listIntegrations, addIntegration });
    app = built.app;
    await app.register(citadelsRoutes);

    const list = await app.inject({ method: "GET", url: "/api/v1/citadels/ws-1/integrations" });
    expect(list.statusCode).toBe(200);
    expect(listIntegrations).toHaveBeenCalledWith("ws-1");

    const create = await app.inject({
      method: "POST",
      url: "/api/v1/citadels/ws-1/integrations",
      payload: { provider: "google_calendar", capabilities: ["calendar.events.read"], mode: "read" },
    });
    expect(create.statusCode).toBe(201);
    expect(addIntegration).toHaveBeenCalledWith(
      expect.objectContaining({ citadelId: "ws-1", provider: "google_calendar", mode: "read" }),
    );
  });

  it("rejects an integration grant with an invalid mode", async () => {
    const addIntegration = vi.fn();
    const built = buildApp({ addIntegration });
    app = built.app;
    await app.register(citadelsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/citadels/ws-1/integrations",
      payload: { provider: "x", capabilities: ["y"], mode: "nuke" },
    });
    expect(response.statusCode).toBe(400);
    expect(addIntegration).not.toHaveBeenCalled();
  });

  it("returns 404 when removing a missing integration grant", async () => {
    const removeIntegration = vi.fn(() => false);
    const built = buildApp({ removeIntegration });
    app = built.app;
    await app.register(citadelsRoutes);

    const response = await app.inject({ method: "DELETE", url: "/api/v1/citadels/ws-1/integrations/g9" });
    expect(response.statusCode).toBe(404);
    expect(removeIntegration).toHaveBeenCalledWith("ws-1", "g9");
  });

  it("interprets a mason session message via the model", async () => {
    const interpretSessionMessage = vi.fn(async () => ({
      ok: true,
      session: { sessionId: "s1", answers: { kind: "company" }, status: "collecting" },
    }));
    const built = buildApp({ interpretSessionMessage });
    app = built.app;
    await app.register(citadelsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/mason/sessions/s1/message",
      payload: { message: "I run a startup" },
    });
    expect(response.statusCode).toBe(200);
    expect(interpretSessionMessage).toHaveBeenCalledWith("s1", "I run a startup");
  });

  it("returns 503 when no model is configured for the mason", async () => {
    const interpretSessionMessage = vi.fn(async () => ({ ok: false, reason: "no_interpreter" }));
    const built = buildApp({ interpretSessionMessage });
    app = built.app;
    await app.register(citadelsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/mason/sessions/s1/message",
      payload: { message: "x" },
    });
    expect(response.statusCode).toBe(503);
  });
});
