import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { ConflictError, NotFoundError, type OpsSavedBoardRecord } from "@goatcitadel/contracts";
import { opsSavedBoardRoutes, type OpsSavedBoardRouteService } from "./ops-boards.js";

function record(overrides: Partial<OpsSavedBoardRecord> = {}): OpsSavedBoardRecord {
  return {
    schemaVersion: "goatcitadel.ops-board.v1",
    boardId: "board-1",
    workspaceId: "workspace-1",
    name: "Operations",
    status: "active",
    placements: [
      {
        widgetId: "kanban",
        kind: "agentic_run_kanban",
        x: 0,
        y: 0,
        width: 6,
        height: 4,
      },
    ],
    revision: 1,
    createdByActorId: "operator:request",
    createdAt: "2026-07-14T12:00:00.000Z",
    updatedByActorId: "operator:request",
    updatedAt: "2026-07-14T12:00:00.000Z",
    idempotencyKey: "create-1",
    requestSha256: "a".repeat(64),
    ...overrides,
  };
}

function createService(): OpsSavedBoardRouteService {
  return {
    list: vi.fn(() => [record()]),
    get: vi.fn(() => record()),
    create: vi.fn(() => record()),
    update: vi.fn(() => record({ revision: 2, updatedAt: "2026-07-14T12:01:00.000Z" })),
    archive: vi.fn(() =>
      record({
        status: "archived",
        revision: 2,
        updatedAt: "2026-07-14T12:01:00.000Z",
        archivedByActorId: "operator:request",
        archivedAt: "2026-07-14T12:01:00.000Z",
      }),
    ),
    restore: vi.fn(() => record({ revision: 3, updatedAt: "2026-07-14T12:02:00.000Z" })),
  };
}

const operatorHeaders = {
  "x-test-auth-source": "token",
  "x-test-auth-actor": "operator:request",
};

const validCreate = {
  workspaceId: "workspace-1",
  name: "Operations",
  placements: [
    {
      widgetId: "kanban",
      kind: "agentic_run_kanban",
      x: 0,
      y: 0,
      width: 6,
      height: 4,
    },
  ],
  idempotencyKey: "create-1",
};

describe("ops saved board routes", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function buildApp(service: OpsSavedBoardRouteService): Promise<FastifyInstance> {
    const next = Fastify();
    next.decorateRequest("authActorId", "anonymous");
    next.decorateRequest("authActorSource", "none");
    next.addHook("onRequest", async (request) => {
      const source = readHeader(request, "x-test-auth-source");
      request.authActorSource = ["token", "basic", "loopback", "device"].includes(source ?? "")
        ? (source as FastifyRequest["authActorSource"])
        : "none";
      request.authActorId = readHeader(request, "x-test-auth-actor") ?? "anonymous";
    });
    next.decorate("requireOperatorAuth", async (request: FastifyRequest, reply: FastifyReply) => {
      if (["token", "basic", "loopback"].includes(request.authActorSource)) return;
      if (request.authActorSource === "none" && request.authActorId === "auth:none") return;
      return reply.code(403).send({ error: "Operator authentication is required." });
    });
    await next.register(opsSavedBoardRoutes, { service });
    app = next;
    return next;
  }

  it("keeps every endpoint operator-only and marks even rejected responses no-store", async () => {
    const service = createService();
    const next = await buildApp(service);
    const requests = [
      { method: "GET", url: "/api/v1/ops/boards?workspaceId=workspace-1" },
      { method: "GET", url: "/api/v1/ops/boards/board-1?workspaceId=workspace-1" },
      { method: "POST", url: "/api/v1/ops/boards", payload: validCreate },
      {
        method: "PATCH",
        url: "/api/v1/ops/boards/board-1",
        payload: { workspaceId: "workspace-1", name: "New", expectedRevision: 1 },
      },
      {
        method: "POST",
        url: "/api/v1/ops/boards/board-1/archive",
        payload: { workspaceId: "workspace-1", expectedRevision: 1 },
      },
      {
        method: "POST",
        url: "/api/v1/ops/boards/board-1/restore",
        payload: { workspaceId: "workspace-1", expectedRevision: 2 },
      },
    ] as const;

    for (const request of requests) {
      const response = await next.inject(request);
      expect(response.statusCode).toBe(403);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers.pragma).toBe("no-cache");
      if (request.method === "GET") {
        expect(response.headers["x-goatcitadel-execution-authority"]).toBe("none");
      }
    }
    for (const method of Object.values(service)) expect(method).not.toHaveBeenCalled();
  });

  it("rejects auth:none, companion, and device access before parsing or service dispatch", async () => {
    const service = createService();
    const next = await buildApp(service);
    const requests = [
      {
        method: "GET" as const,
        url: "/api/v1/ops/boards?workspaceId=workspace-1",
        headers: { "x-test-auth-source": "none", "x-test-auth-actor": "auth:none" },
      },
      {
        method: "POST" as const,
        url: "/api/v1/ops/boards",
        headers: { "x-test-auth-source": "none", "x-test-auth-actor": "auth:none" },
        payload: { ...validCreate, script: "must-not-be-parsed" },
      },
      {
        method: "GET" as const,
        url: "/api/v1/ops/boards?workspaceId=workspace-1",
        headers: { "x-test-auth-source": "companion", "x-test-auth-actor": "companion:1" },
      },
      {
        method: "POST" as const,
        url: "/api/v1/ops/boards",
        headers: { "x-test-auth-source": "device", "x-test-auth-actor": "device:1" },
        payload: validCreate,
      },
    ];

    for (const request of requests) {
      const response = await next.inject(request);
      expect(response.statusCode).toBe(403);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers.pragma).toBe("no-cache");
    }
    const malformedJson = await next.inject({
      method: "POST",
      url: "/api/v1/ops/boards",
      headers: {
        "content-type": "application/json",
        "x-test-auth-source": "none",
        "x-test-auth-actor": "auth:none",
      },
      payload: '{"malformed"',
    });
    expect(malformedJson.statusCode).toBe(403);
    expect(malformedJson.headers["cache-control"]).toBe("no-store");
    for (const method of Object.values(service)) expect(method).not.toHaveBeenCalled();
  });

  it("lists and gets only the requested workspace with read-only response authority", async () => {
    const service = createService();
    const next = await buildApp(service);

    const list = await next.inject({
      method: "GET",
      url: "/api/v1/ops/boards?workspaceId=workspace-1&includeArchived=true",
      headers: operatorHeaders,
    });
    const get = await next.inject({
      method: "GET",
      url: "/api/v1/ops/boards/board-1?workspaceId=workspace-1",
      headers: operatorHeaders,
    });

    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({ workspaceId: "workspace-1", items: [{ boardId: "board-1" }] });
    expect(get.statusCode).toBe(200);
    expect(service.list).toHaveBeenCalledWith("workspace-1", true);
    expect(service.get).toHaveBeenCalledWith("workspace-1", "board-1");
    for (const response of [list, get]) {
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers.pragma).toBe("no-cache");
      expect(response.headers["x-goatcitadel-execution-authority"]).toBe("none");
    }
  });

  it("derives the mutation actor from authentication and rejects spoofed or extra fields", async () => {
    const service = createService();
    const next = await buildApp(service);

    const created = await next.inject({
      method: "POST",
      url: "/api/v1/ops/boards",
      headers: operatorHeaders,
      payload: validCreate,
    });
    expect(created.statusCode).toBe(201);
    expect(created.headers.location).toBe("/api/v1/ops/boards/board-1?workspaceId=workspace-1");
    expect(service.create).toHaveBeenCalledWith(validCreate, "operator:request");

    for (const payload of [
      { ...validCreate, actorId: "operator:forged" },
      { ...validCreate, script: "alert(1)" },
      { ...validCreate, placements: [{ ...validCreate.placements[0], props: { url: "https://example.com" } }] },
    ]) {
      const rejected = await next.inject({
        method: "POST",
        url: "/api/v1/ops/boards",
        headers: operatorHeaders,
        payload,
      });
      expect(rejected.statusCode).toBe(400);
    }
    expect(service.create).toHaveBeenCalledTimes(1);

    for (const request of [
      {
        method: "PATCH" as const,
        url: "/api/v1/ops/boards/board-1",
        payload: {
          workspaceId: "workspace-1",
          name: "Changed",
          expectedRevision: 1,
          actorId: "operator:forged",
        },
      },
      {
        method: "POST" as const,
        url: "/api/v1/ops/boards/board-1/archive",
        payload: { workspaceId: "workspace-1", expectedRevision: 1, actorId: "operator:forged" },
      },
    ]) {
      const rejected = await next.inject({ ...request, headers: operatorHeaders });
      expect(rejected.statusCode).toBe(400);
    }
    expect(service.update).not.toHaveBeenCalled();
    expect(service.archive).not.toHaveBeenCalled();

    const missingActor = await next.inject({
      method: "POST",
      url: "/api/v1/ops/boards",
      headers: { "x-test-auth-source": "token" },
      payload: validCreate,
    });
    expect(missingActor.statusCode).toBe(401);
    expect(service.create).toHaveBeenCalledTimes(1);

    const extraQuery = await next.inject({
      method: "GET",
      url: "/api/v1/ops/boards?workspaceId=workspace-1&limit=1000",
      headers: operatorHeaders,
    });
    expect(extraQuery.statusCode).toBe(400);
    expect(extraQuery.headers["cache-control"]).toBe("no-store");
    expect(extraQuery.headers.pragma).toBe("no-cache");
    expect(extraQuery.headers["x-goatcitadel-execution-authority"]).toBe("none");
    expect(service.list).not.toHaveBeenCalled();
  });

  it("requires a canonical specific actor and enforces normalized text and placement bounds", async () => {
    const service = createService();
    const next = await buildApp(service);

    for (const actor of [" operator:request ", "auth:none", "anonymous", "operator\nrequest", "operator:\uff41"]) {
      const response = await next.inject({
        method: "POST",
        url: "/api/v1/ops/boards",
        headers: { "x-test-auth-source": "token", "x-test-auth-actor": actor },
        payload: validCreate,
      });
      expect(response.statusCode).toBe(401);
    }
    expect(service.create).not.toHaveBeenCalled();

    const accepted = await next.inject({
      method: "POST",
      url: "/api/v1/ops/boards",
      headers: operatorHeaders,
      payload: { ...validCreate, name: "  \u212b Operations  ", description: "  Trusted status  " },
    });
    expect(accepted.statusCode).toBe(201);
    expect(service.create).toHaveBeenCalledWith(
      { ...validCreate, name: "\u00c5 Operations", description: "Trusted status" },
      "operator:request",
    );

    const invalidPayloads = [
      { ...validCreate, name: "n".repeat(121) },
      { ...validCreate, name: "\nOperations" },
      { ...validCreate, description: "d".repeat(501) },
      {
        ...validCreate,
        placements: [validCreate.placements[0], { ...validCreate.placements[0] }],
      },
      {
        ...validCreate,
        placements: [{ ...validCreate.placements[0], kind: "custom_script_widget" }],
      },
      {
        ...validCreate,
        placements: [{ ...validCreate.placements[0], x: 11, width: 2 }],
      },
      {
        ...validCreate,
        placements: [{ ...validCreate.placements[0], html: "<script>alert(1)</script>" }],
      },
    ];
    for (const payload of invalidPayloads) {
      const response = await next.inject({
        method: "POST",
        url: "/api/v1/ops/boards",
        headers: operatorHeaders,
        payload,
      });
      expect(response.statusCode).toBe(400);
    }
    expect(service.create).toHaveBeenCalledTimes(1);
  });

  it("passes exact update, archive, and restore calls with the request actor", async () => {
    const service = createService();
    const next = await buildApp(service);

    const update = await next.inject({
      method: "PATCH",
      url: "/api/v1/ops/boards/board-1",
      headers: operatorHeaders,
      payload: { workspaceId: "workspace-1", description: null, expectedRevision: 1 },
    });
    const archive = await next.inject({
      method: "POST",
      url: "/api/v1/ops/boards/board-1/archive",
      headers: operatorHeaders,
      payload: { workspaceId: "workspace-1", expectedRevision: 2 },
    });
    const restore = await next.inject({
      method: "POST",
      url: "/api/v1/ops/boards/board-1/restore",
      headers: operatorHeaders,
      payload: { workspaceId: "workspace-1", expectedRevision: 3 },
    });

    expect([update.statusCode, archive.statusCode, restore.statusCode]).toEqual([200, 200, 200]);
    expect(service.update).toHaveBeenCalledWith(
      "board-1",
      { workspaceId: "workspace-1", description: null, expectedRevision: 1 },
      "operator:request",
    );
    expect(service.archive).toHaveBeenCalledWith(
      "board-1",
      { workspaceId: "workspace-1", expectedRevision: 2 },
      "operator:request",
    );
    expect(service.restore).toHaveBeenCalledWith(
      "board-1",
      { workspaceId: "workspace-1", expectedRevision: 3 },
      "operator:request",
    );
    for (const response of [update, archive, restore]) {
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers.pragma).toBe("no-cache");
      expect(response.headers["x-goatcitadel-execution-authority"]).toBeUndefined();
    }
  });

  it("returns identical 404 projections for foreign and missing boards", async () => {
    const service = createService();
    vi.mocked(service.get)
      .mockImplementationOnce(() => {
        throw new NotFoundError({ entity: "Ops saved board", id: "board-1" });
      })
      .mockImplementationOnce(() => {
        throw new NotFoundError({ entity: "Ops saved board", id: "board-1" });
      });
    const next = await buildApp(service);

    const foreign = await next.inject({
      method: "GET",
      url: "/api/v1/ops/boards/board-1?workspaceId=workspace-foreign",
      headers: operatorHeaders,
    });
    const missing = await next.inject({
      method: "GET",
      url: "/api/v1/ops/boards/board-1?workspaceId=workspace-1",
      headers: operatorHeaders,
    });

    expect([foreign.statusCode, missing.statusCode]).toEqual([404, 404]);
    expect(foreign.json()).toEqual(missing.json());
    for (const response of [foreign, missing]) {
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers.pragma).toBe("no-cache");
      expect(response.headers["x-goatcitadel-execution-authority"]).toBe("none");
    }
  });

  it("maps create replay, request conflict, stale revision, and archived mutation through domain errors", async () => {
    const service = createService();
    vi.mocked(service.create)
      .mockReturnValueOnce(record())
      .mockReturnValueOnce(record())
      .mockImplementationOnce(() => {
        throw new ConflictError({ code: "STATE_CONFLICT", message: "Different request bytes." });
      });
    vi.mocked(service.update).mockImplementationOnce(() => {
      throw new ConflictError({ code: "WRITE_CONFLICT", message: "Stale revision." });
    });
    vi.mocked(service.archive).mockImplementationOnce(() => {
      throw new ConflictError({ code: "STATE_CONFLICT", message: "Board is archived." });
    });
    const next = await buildApp(service);

    const create = () =>
      next.inject({ method: "POST", url: "/api/v1/ops/boards", headers: operatorHeaders, payload: validCreate });
    expect((await create()).statusCode).toBe(201);
    expect((await create()).statusCode).toBe(201);
    const requestConflict = await create();
    expect(requestConflict.statusCode).toBe(409);
    expect(requestConflict.headers["cache-control"]).toBe("no-store");
    expect(
      (
        await next.inject({
          method: "PATCH",
          url: "/api/v1/ops/boards/board-1",
          headers: operatorHeaders,
          payload: { workspaceId: "workspace-1", name: "Changed", expectedRevision: 1 },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await next.inject({
          method: "POST",
          url: "/api/v1/ops/boards/board-1/archive",
          headers: operatorHeaders,
          payload: { workspaceId: "workspace-1", expectedRevision: 2 },
        })
      ).statusCode,
    ).toBe(409);
  });
});

function readHeader(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}
