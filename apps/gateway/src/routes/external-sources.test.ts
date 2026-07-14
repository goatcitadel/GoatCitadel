import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EXTERNAL_SOURCE_SCHEMA_VERSION,
  type ExternalSourceDetailResponse,
  type ExternalSourcePage,
  type ExternalSourceRecord,
  type ExternalSourceScanRecord,
} from "@goatcitadel/contracts";
import type { ExternalSourceRoutePort } from "../services/external-source-route-service.js";
import { ExternalSourceServiceError } from "../services/external-source-service.js";
import { externalSourceRoutes } from "./external-sources.js";

const operatorHeaders = {
  "x-test-auth-source": "token",
  "x-test-auth-actor": "operator:request",
};

describe("HX-407 external source routes", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("keeps all routes specific-operator-only, no-store, and resolves auth before handler contract parsing", async () => {
    const service = createService();
    const next = await buildApp(service);
    const requests = [
      { method: "GET" as const, url: "/api/v1/library/external-sources?workspaceId=workspace-1" },
      { method: "GET" as const, url: "/api/v1/library/external-sources/source-1?workspaceId=workspace-1" },
      { method: "POST" as const, url: "/api/v1/library/external-sources", payload: validCreate() },
      {
        method: "PATCH" as const,
        url: "/api/v1/library/external-sources/source-1",
        payload: { workspaceId: "workspace-1", label: "Renamed", expectedRevision: 1 },
      },
      {
        method: "POST" as const,
        url: "/api/v1/library/external-sources/source-1/scans",
        payload: { workspaceId: "workspace-1", expectedRevision: 1 },
      },
      {
        method: "GET" as const,
        url: "/api/v1/library/external-sources/source-1/items?workspaceId=workspace-1&scanId=scan-1",
      },
    ];
    for (const request of requests) {
      const response = await next.inject({
        ...request,
        headers: { "x-test-auth-source": "none", "x-test-auth-actor": "auth:none" },
      });
      expect(response.statusCode).toBe(403);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers.pragma).toBe("no-cache");
      if (request.method === "GET") expect(response.headers["x-goatcitadel-execution-authority"]).toBe("none");
    }
    for (const method of Object.values(service)) expect(method).not.toHaveBeenCalled();

    const malformed = await next.inject({
      method: "POST",
      url: "/api/v1/library/external-sources",
      headers: {
        "content-type": "application/json",
        "x-test-auth-source": "none",
        "x-test-auth-actor": "auth:none",
      },
      payload: "{definitely-not-json",
    });
    // Fastify's JSON parser owns malformed transport bytes before route hooks;
    // handler-level schema parsing still remains behind actor resolution.
    expect(malformed.statusCode).toBe(400);
    expect(service.create).not.toHaveBeenCalled();
  });

  it("derives immutable ownership from the request and rejects body actor smuggling", async () => {
    const service = createService();
    const next = await buildApp(service);
    const response = await next.inject({
      method: "POST",
      url: "/api/v1/library/external-sources",
      headers: operatorHeaders,
      payload: validCreate(),
    });
    expect(response.statusCode).toBe(201);
    expect(response.headers.location).toContain("/api/v1/library/external-sources/source-1");
    expect(service.create).toHaveBeenCalledWith(
      expect.not.objectContaining({ ownerActorId: expect.anything(), authActorId: expect.anything() }),
      { actorId: "operator:request", source: "token" },
      expect.any(AbortSignal),
    );

    const forged = await next.inject({
      method: "POST",
      url: "/api/v1/library/external-sources",
      headers: operatorHeaders,
      payload: {
        ...validCreate(),
        ownerActorId: "forged-actor",
        rootGrantApprovalId: "fabricated-approval",
        ownershipAttestationSha256: "9".repeat(64),
      },
    });
    expect(forged.statusCode).toBe(400);
    expect(service.create).toHaveBeenCalledTimes(1);
  });

  it("returns a content-free workspace list while reserving the exact root for operator detail", async () => {
    const service = createService();
    const next = await buildApp(service);
    const list = await next.inject({
      method: "GET",
      url: "/api/v1/library/external-sources?workspaceId=workspace-1",
      headers: operatorHeaders,
    });
    expect(list.statusCode).toBe(200);
    expect(list.headers["x-goatcitadel-execution-authority"]).toBe("none");
    expect(list.body).not.toContain("/synthetic/codex/sessions");
    expect(list.body).not.toContain("operator:request");

    const detailResult = await next.inject({
      method: "GET",
      url: "/api/v1/library/external-sources/source-1?workspaceId=workspace-1",
      headers: operatorHeaders,
    });
    expect(detailResult.statusCode).toBe(200);
    expect(detailResult.body).toContain("/synthetic/codex/sessions");
  });

  it("passes exact CAS and sealed cursor scope without accepting extra fields", async () => {
    const service = createService();
    const next = await buildApp(service);
    const scan = await next.inject({
      method: "POST",
      url: "/api/v1/library/external-sources/source-1/scans",
      headers: operatorHeaders,
      payload: { workspaceId: "workspace-1", expectedRevision: 3 },
    });
    expect(scan.statusCode).toBe(201);
    expect(service.scan).toHaveBeenCalledWith(
      "source-1",
      { workspaceId: "workspace-1", expectedRevision: 3 },
      { actorId: "operator:request", source: "token" },
      expect.any(AbortSignal),
    );

    const page = await next.inject({
      method: "GET",
      url: "/api/v1/library/external-sources/source-1/items?workspaceId=workspace-1&scanId=scan-1&dispositions=supported&cursor=opaque-cursor&limit=25",
      headers: operatorHeaders,
    });
    expect(page.statusCode).toBe(200);
    expect(service.listCatalog).toHaveBeenCalledWith(
      "source-1",
      {
        workspaceId: "workspace-1",
        scanId: "scan-1",
        dispositions: ["supported"],
        cursor: "opaque-cursor",
        limit: 25,
      },
      { actorId: "operator:request", source: "token" },
    );

    const extra = await next.inject({
      method: "PATCH",
      url: "/api/v1/library/external-sources/source-1",
      headers: operatorHeaders,
      payload: { workspaceId: "workspace-1", expectedRevision: 1, canonicalRootPath: "/forged" },
    });
    expect(extra.statusCode).toBe(400);
    expect(service.update).not.toHaveBeenCalled();
  });

  it("maps identity, owner-scope, cursor, and repository failures to content-free errors", async () => {
    const service = createService();
    vi.mocked(service.get).mockImplementation(() => {
      throw new ExternalSourceServiceError("not_found");
    });
    vi.mocked(service.listCatalog).mockImplementation(() => {
      throw new ExternalSourceServiceError("invalid_cursor");
    });
    const next = await buildApp(service);
    const missing = await next.inject({
      method: "GET",
      url: "/api/v1/library/external-sources/foreign-source?workspaceId=foreign-workspace",
      headers: operatorHeaders,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "External source was not found.", code: "not_found" });
    expect(missing.body).not.toContain("foreign-source");
    expect(missing.body).not.toContain("foreign-workspace");

    const invalidCursor = await next.inject({
      method: "GET",
      url: "/api/v1/library/external-sources/source-1/items?workspaceId=workspace-1&scanId=scan-1&cursor=opaque-cursor",
      headers: operatorHeaders,
    });
    expect(invalidCursor.statusCode).toBe(400);
    expect(invalidCursor.json()).toEqual({
      error: "External source catalog cursor is invalid.",
      code: "invalid_cursor",
    });
  });

  async function buildApp(service: ExternalSourceRoutePort): Promise<FastifyInstance> {
    const next = Fastify();
    next.decorateRequest("authActorId", "anonymous");
    next.decorateRequest("authActorSource", "none");
    next.addHook("onRequest", async (request) => {
      const source = readHeader(request, "x-test-auth-source");
      request.authActorSource = ["token", "basic", "loopback", "device", "companion"].includes(source ?? "")
        ? (source as FastifyRequest["authActorSource"])
        : "none";
      request.authActorId = readHeader(request, "x-test-auth-actor") ?? "anonymous";
    });
    next.decorate("requireOperatorAuth", async (request: FastifyRequest, reply: FastifyReply) => {
      if (["token", "basic", "loopback"].includes(request.authActorSource)) return;
      if (request.authActorSource === "none" && request.authActorId === "auth:none") return;
      return reply.code(403).send({ error: "Operator authentication is required." });
    });
    await next.register(externalSourceRoutes, { service });
    app = next;
    return next;
  }
});

function createService(): ExternalSourceRoutePort {
  return {
    create: vi.fn(async () => detail()),
    list: vi.fn(() => ({
      schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
      workspaceId: "workspace-1",
      items: [
        {
          schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
          sourceId: "source-1",
          workspaceId: "workspace-1",
          kind: "codex_sessions",
          label: "Synthetic",
          adapterId: "codex.rollout-jsonl.v1",
          adapterVersion: "1.0.0",
          revision: 1,
          configSha256: "1".repeat(64),
          status: "active",
          updatedAt: "2026-07-14T10:00:00.000Z",
        },
      ],
    })),
    get: vi.fn(() => detail()),
    update: vi.fn(async () => detail()),
    scan: vi.fn(async () => scanRecord()),
    listCatalog: vi.fn(() => page()),
  };
}

function detail(): ExternalSourceDetailResponse {
  return { schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION, source: sourceRecord() };
}

function sourceRecord(): ExternalSourceRecord {
  return {
    schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
    sourceId: "source-1",
    workspaceId: "workspace-1",
    kind: "codex_sessions",
    label: "Synthetic",
    ownerActorId: "operator:request",
    authActorId: "operator:request",
    authActorSource: "token",
    canonicalRootPath: "/synthetic/codex/sessions",
    rootIdentitySha256: "1".repeat(64),
    pathBridgeSnapshotId: "snapshot-1",
    pathBridgeSnapshotSha256: "2".repeat(64),
    allowedRootsSha256: "3".repeat(64),
    inputFlavor: "windows_native",
    targetFlavor: "windows_native",
    requireGitIdentity: false,
    ownershipAttestationSha256: "4".repeat(64),
    adapterId: "codex.rollout-jsonl.v1",
    adapterVersion: "1.0.0",
    adapterPolicy: {
      unknownVariantDisposition: "block",
      followLinks: false,
      followMarkdownImports: false,
      retainRawBytes: false,
      acceptedProducerVersions: ["producer-1"],
    },
    revision: 1,
    configSha256: "5".repeat(64),
    status: "active",
    createdAt: "2026-07-14T10:00:00.000Z",
    updatedAt: "2026-07-14T10:00:00.000Z",
  };
}

function scanRecord(): ExternalSourceScanRecord {
  const source = sourceRecord();
  return {
    schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
    scanId: "scan-1",
    workspaceId: source.workspaceId,
    sourceId: source.sourceId,
    configRevision: source.revision,
    configSha256: source.configSha256,
    rootIdentitySha256: source.rootIdentitySha256,
    pathBridgeSnapshotSha256: source.pathBridgeSnapshotSha256,
    adapterId: source.adapterId,
    adapterVersion: source.adapterVersion,
    manifestSha256: "6".repeat(64),
    examinedEntryCount: 0,
    itemCount: 0,
    supportedItemCount: 0,
    quarantinedItemCount: 0,
    blockerCodes: [],
    status: "sealed",
    startedAt: "2026-07-14T10:01:00.000Z",
    completedAt: "2026-07-14T10:01:00.000Z",
  };
}

function page(): ExternalSourcePage {
  return {
    schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
    workspaceId: "workspace-1",
    sourceId: "source-1",
    scanId: "scan-1",
    items: [],
  };
}

function validCreate() {
  return {
    workspaceId: "workspace-1",
    expectedWorkspaceRevision: 1,
    kind: "codex_sessions",
    label: "Synthetic",
    canonicalRootPath: "/synthetic/codex/sessions",
    pathBridgeSnapshotId: "snapshot-1",
    pathBridgeSnapshotSha256: "2".repeat(64),
    inputFlavor: "windows_native",
    targetFlavor: "windows_native",
    requireGitIdentity: false,
    acceptedProducerVersions: ["synthetic-codex.v1"],
  };
}

function readHeader(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
}
