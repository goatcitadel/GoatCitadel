import { afterEach, describe, expect, it, vi } from "vitest";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import { approvalsRoutes, resolveApprovalActorId } from "./approvals.js";

const APPROVAL_ID = "3d20b7eb-efdd-42ab-a6c6-1c8cbb291c1d";
const WEBHOOK_QUERY_SECRET = "hook-short";
const BEARER_SECRET = "tiny";
const DATABASE_PASSWORD_SECRET = "db-short";

function createSensitiveApproval(status = "pending") {
  return {
    approvalId: APPROVAL_ID,
    kind: "tool.invoke",
    status,
    riskLevel: "danger",
    payload: {
      webhookUrl: `https://hooks.example.test/inbound?token=${WEBHOOK_QUERY_SECRET}`,
      command: `curl -H "Authorization: Bearer ${BEARER_SECRET}" https://example.test`,
      environment: { DATABASE_PASSWORD: DATABASE_PASSWORD_SECRET },
      tokenId: "rat_123",
      secretRef: "env:DATABASE_PASSWORD",
      status: "queued",
    },
    preview: {
      authorization: `Bearer ${BEARER_SECRET}`,
    },
    linkage: {
      tokenId: "rat_123",
      connectorId: "mission-control",
    },
    createdAt: "2026-07-09T00:00:00.000Z",
  };
}

function createSensitiveResolution(approval: ReturnType<typeof createSensitiveApproval>) {
  return {
    approval,
    effects: [
      {
        effectId: "effect-1",
        status: "pending",
        payload: {
          webhookUrl: approval.payload.webhookUrl,
          tokenId: "rat_123",
          secretRef: "env:DATABASE_PASSWORD",
        },
      },
    ],
    replay: {
      approval,
      events: [
        {
          eventId: "event-1",
          eventType: "resolved",
          payload: {
            command: approval.payload.command,
            environment: approval.payload.environment,
            tokenId: "rat_123",
            secretRef: "env:DATABASE_PASSWORD",
            status: "approved",
          },
        },
      ],
      pendingAction: {
        approvalId: APPROVAL_ID,
        status: "pending",
        result: {
          webhookUrl: approval.payload.webhookUrl,
        },
      },
    },
    durableRunId: "durable-run-42",
  };
}

function expectSecretSafeApprovalProjection(value: unknown): void {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toContain(WEBHOOK_QUERY_SECRET);
  expect(serialized).not.toContain(BEARER_SECRET);
  expect(serialized).not.toContain(DATABASE_PASSWORD_SECRET);
  expect(serialized).toContain("[REDACTED]");
}

function expectApprovalMetadataPreserved(approval: Record<string, unknown>): void {
  expect(approval).toMatchObject({
    approvalId: APPROVAL_ID,
    status: expect.any(String),
    payload: {
      tokenId: "rat_123",
      secretRef: "env:DATABASE_PASSWORD",
      status: "queued",
    },
    linkage: {
      tokenId: "rat_123",
      connectorId: "mission-control",
    },
  });
}

function expectRawApprovalUnchanged(approval: ReturnType<typeof createSensitiveApproval>): void {
  expect(approval.payload).toMatchObject({
    webhookUrl: `https://hooks.example.test/inbound?token=${WEBHOOK_QUERY_SECRET}`,
    command: `curl -H "Authorization: Bearer ${BEARER_SECRET}" https://example.test`,
    environment: { DATABASE_PASSWORD: DATABASE_PASSWORD_SECRET },
    tokenId: "rat_123",
    secretRef: "env:DATABASE_PASSWORD",
    status: "queued",
  });
}

function buildApp(approvals: Record<string, unknown>, requireOperatorAuth = vi.fn(async () => undefined)) {
  const app = Fastify();
  app.decorate("services", { approvals } as never);
  app.decorate("requireOperatorAuth", requireOperatorAuth as never);
  app.decorateRequest("idempotencyKey", "");
  app.addHook("preHandler", async (request) => {
    const value = request.headers["idempotency-key"];
    request.idempotencyKey = typeof value === "string" ? value : "";
  });
  return {
    app,
    requireOperatorAuth,
  };
}

function installCompanionIdentity(app: FastifyInstance): void {
  app.addHook("onRequest", async (request) => {
    const source = request.headers["x-auth-source"];
    request.authActorSource = typeof source === "string" ? source : "none";
    const purpose = request.headers["x-auth-purpose"];
    request.authPrincipalPurpose = typeof purpose === "string" ? purpose : undefined;
    const sessionId = request.headers["x-companion-session-id"];
    request.authCompanionSessionId = typeof sessionId === "string" ? sessionId : undefined;
  });
}

const COMPANION_HEADERS = {
  "x-auth-source": "companion",
  "x-auth-purpose": "general_companion",
  "x-companion-session-id": "comp-sess-1",
} as const;

describe("approvals routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  it("forwards the workspaceId query filter to the approvals service", async () => {
    const listApprovalsPage = vi.fn(() => ({ items: [], nextCursor: "cursor-next" }));
    const built = buildApp({ listApprovalsPage });
    app = built.app;
    await app.register(approvalsRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/approvals?status=pending&workspaceId=workspace-a&limit=25&cursor=cursor-1",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [], nextCursor: "cursor-next" });
    expect(listApprovalsPage).toHaveBeenCalledWith({
      status: "pending",
      limit: 25,
      cursor: "cursor-1",
      workspaceId: "workspace-a",
    });
  });

  it("allows a paired general companion to review the redacted pending queue without operator auth", async () => {
    const rawApproval = createSensitiveApproval();
    const listApprovalsPage = vi.fn(async () => ({ items: [rawApproval] }));
    const requireOperatorAuth = vi.fn(
      async (_request: unknown, reply: { code: (status: number) => { send: (body: unknown) => unknown } }) =>
        reply.code(403).send({ error: "operator only" }),
    );
    const built = buildApp({ listApprovalsPage }, requireOperatorAuth);
    app = built.app;
    installCompanionIdentity(app);
    await app.register(approvalsRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/approvals?status=pending",
      headers: COMPANION_HEADERS,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(requireOperatorAuth).not.toHaveBeenCalled();
    expectSecretSafeApprovalProjection(response.json());
    expectRawApprovalUnchanged(rawApproval);
  });

  it("allows a signed companion route principal to reject but never approve or edit", async () => {
    const resolveApproval = vi.fn(async (_approvalId: string, input: { decision: "approve" | "reject" | "edit" }) => ({
      approval: { approvalId: APPROVAL_ID, status: input.decision === "reject" ? "rejected" : "approved" },
    }));
    const requireOperatorAuth = vi.fn(
      async (_request: unknown, reply: { code: (status: number) => { send: (body: unknown) => unknown } }) =>
        reply.code(403).send({ error: "operator only" }),
    );
    const built = buildApp({ resolveApproval }, requireOperatorAuth);
    app = built.app;
    installCompanionIdentity(app);
    await app.register(approvalsRoutes);

    const rejected = await app.inject({
      method: "POST",
      url: `/api/v1/approvals/${APPROVAL_ID}/resolve`,
      headers: COMPANION_HEADERS,
      payload: { decision: "reject", resolutionNote: "Rejected from paired mobile review." },
    });
    expect(rejected.statusCode).toBe(200);
    expect(resolveApproval).toHaveBeenCalledWith(APPROVAL_ID, {
      decision: "reject",
      resolutionNote: "Rejected from paired mobile review.",
      resolvedBy: "companion:comp-sess-1",
    });

    for (const decision of ["approve", "edit"] as const) {
      const blocked = await app.inject({
        method: "POST",
        url: `/api/v1/approvals/${APPROVAL_ID}/resolve`,
        headers: COMPANION_HEADERS,
        payload: { decision, ...(decision === "edit" ? { editedPayload: { safe: true } } : {}) },
      });
      expect(blocked.statusCode).toBe(403);
      expect(blocked.json()).toMatchObject({
        error: expect.stringContaining("server-verifiable device approval key"),
      });
    }
    expect(resolveApproval).toHaveBeenCalledTimes(1);
    expect(requireOperatorAuth).not.toHaveBeenCalled();
  });

  it("projects approval creation responses without mutating executable approval truth", async () => {
    const rawApproval = createSensitiveApproval();
    const createApproval = vi.fn(async () => rawApproval);
    const built = buildApp({ createApproval });
    app = built.app;
    installCompanionIdentity(app);
    await app.register(approvalsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/approvals",
      headers: { "idempotency-key": "approval-secret-projection-create", "x-auth-source": "loopback" },
      payload: {
        kind: rawApproval.kind,
        riskLevel: rawApproval.riskLevel,
        payload: rawApproval.payload,
        preview: rawApproval.preview,
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json<Record<string, unknown>>();
    expectSecretSafeApprovalProjection(body);
    expectApprovalMetadataPreserved(body);
    expect(createApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          webhookUrl: rawApproval.payload.webhookUrl,
          command: rawApproval.payload.command,
          environment: rawApproval.payload.environment,
        }),
      }),
    );
    expectRawApprovalUnchanged(rawApproval);
  });

  it("projects paged approval list responses without mutating stored approval truth", async () => {
    const rawApproval = createSensitiveApproval();
    const listApprovalsPage = vi.fn(() => ({ items: [rawApproval], nextCursor: "cursor-next" }));
    const built = buildApp({ listApprovalsPage });
    app = built.app;
    await app.register(approvalsRoutes);

    const response = await app.inject({ method: "GET", url: "/api/v1/approvals?limit=25" });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ items: Array<Record<string, unknown>>; nextCursor: string }>();
    expectSecretSafeApprovalProjection(body);
    expectApprovalMetadataPreserved(body.items[0]!);
    expect(body.nextCursor).toBe("cursor-next");
    expectRawApprovalUnchanged(rawApproval);
  });

  it("removes delegated scope host paths from public approval projections without mutating approval truth", async () => {
    const rootPath = "F:\\private\\workspace";
    const rawApproval = {
      ...createSensitiveApproval(),
      kind: "delegation_scope_expansion",
      payload: {
        schemaVersion: "delegation.scope-expansion.v1",
        rootPath,
        requestedPaths: ["docs"],
        resolvedPaths: [`${rootPath}\\docs`],
        scopeHash: "a".repeat(64),
      },
      preview: {
        requestedPaths: ["docs"],
        resolvedPaths: ["docs"],
      },
    };
    const listApprovalsPage = vi.fn(() => ({ items: [rawApproval] }));
    const built = buildApp({ listApprovalsPage });
    app = built.app;
    await app.register(approvalsRoutes);

    const response = await app.inject({ method: "GET", url: "/api/v1/approvals" });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      items: Array<{ payload: Record<string, unknown>; preview: Record<string, unknown> }>;
    }>();
    expect(body.items[0]?.payload).toMatchObject({
      schemaVersion: "delegation.scope-expansion.v1",
      requestedPaths: ["docs"],
      scopeHash: "a".repeat(64),
    });
    expect(body.items[0]?.payload).not.toHaveProperty("rootPath");
    expect(body.items[0]?.payload).not.toHaveProperty("resolvedPaths");
    expect(body.items[0]?.preview).toMatchObject({ requestedPaths: ["docs"], resolvedPaths: ["docs"] });
    expect(JSON.stringify(body)).not.toContain(rootPath);
    expect(rawApproval.payload).toMatchObject({
      rootPath,
      resolvedPaths: [`${rootPath}\\docs`],
    });
  });

  it("blocks approval creation for non-loopback callers", async () => {
    const built = buildApp({
      createApproval: vi.fn(),
    });
    app = built.app;
    await app.register(approvalsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/approvals",
      headers: {
        "x-forwarded-for": "100.64.0.9",
      },
      payload: {
        kind: "tool.invoke",
        riskLevel: "danger",
        payload: {},
        preview: {},
      },
    });

    expect(response.statusCode).toBe(403);
  });

  it("does not treat a raw loopback socket as approval-creation authority without authenticated loopback identity", async () => {
    const createApproval = vi.fn();
    const built = buildApp({ createApproval });
    app = built.app;
    await app.register(approvalsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/approvals",
      headers: { "idempotency-key": "approval-create-untrusted-loopback" },
      payload: {
        kind: "tool.invoke",
        riskLevel: "danger",
        payload: {},
        preview: {},
      },
    });

    expect(response.statusCode).toBe(403);
    expect(createApproval).not.toHaveBeenCalled();
  });

  it.each([
    ["Forwarded", { forwarded: "for=100.64.0.9;proto=https" }],
    ["empty X-Forwarded-For", { "x-forwarded-for": "" }],
    ["X-Real-IP", { "x-real-ip": "100.64.0.9" }],
  ])("does not treat proxy-marked loopback approval creation as local: %s", async (_label, headers) => {
    const createApproval = vi.fn();
    const built = buildApp({
      createApproval,
    });
    app = built.app;
    await app.register(approvalsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/approvals",
      headers: {
        "idempotency-key": "approval-create-proxy-marked",
        ...headers,
      },
      payload: {
        kind: "tool.invoke",
        riskLevel: "danger",
        payload: {},
        preview: {},
      },
    });

    expect(response.statusCode).toBe(403);
    expect(createApproval).not.toHaveBeenCalled();
  });

  it("allows remote approval creation with a scoped token and source metadata", async () => {
    vi.stubEnv("GOATCITADEL_REMOTE_APPROVAL_CREATE_TOKEN", "remote-create-token");
    const createApproval = vi.fn(async () => ({
      approvalId: "apr_123",
      kind: "tool.invoke",
      status: "pending",
      riskLevel: "danger",
      payload: {},
      preview: {},
      createdAt: new Date().toISOString(),
    }));
    const built = buildApp({
      createApproval,
    });
    app = built.app;
    await app.register(approvalsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/approvals",
      headers: {
        "idempotency-key": "approval-create-1",
        "x-goatcitadel-approval-create-token": "remote-create-token",
        "x-forwarded-for": "100.64.0.9",
      },
      payload: {
        kind: "tool.invoke",
        riskLevel: "danger",
        payload: {},
        preview: {},
        linkage: {
          workspaceId: "workspace-1",
          runId: "run-1",
          originSurface: "chat",
          toolName: "browser.search",
          actionType: "tool.invoke",
          permissionProfileId: "profile-safe",
          localOperatorOverrideId: "override-1",
        },
        sourceConnectorId: "slack",
        sourceTraceId: "evt-123",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(createApproval).toHaveBeenCalledTimes(1);
    expect(createApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        linkage: expect.objectContaining({
          workspaceId: "workspace-1",
          runId: "run-1",
          originSurface: "chat",
          toolName: "browser.search",
          actionType: "tool.invoke",
          permissionProfileId: "profile-safe",
          localOperatorOverrideId: "override-1",
          connectorId: "slack",
          traceId: "evt-123",
        }),
      }),
    );
  });

  it("rejects remote approval creation with a bad scoped token", async () => {
    vi.stubEnv("GOATCITADEL_REMOTE_APPROVAL_CREATE_TOKEN", "remote-create-token");
    const createApproval = vi.fn();
    const built = buildApp({
      createApproval,
    });
    app = built.app;
    await app.register(approvalsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/approvals",
      headers: {
        "idempotency-key": "approval-create-1",
        "x-goatcitadel-approval-create-token": "wrong",
        "x-forwarded-for": "100.64.0.9",
      },
      payload: {
        kind: "tool.invoke",
        riskLevel: "danger",
        payload: {},
        preview: {},
        sourceConnectorId: "slack",
        sourceTraceId: "evt-123",
      },
    });

    expect(response.statusCode).toBe(401);
    expect(createApproval).not.toHaveBeenCalled();
  });

  it("rejects oversized remote approval creation tokens before comparison", async () => {
    vi.stubEnv("GOATCITADEL_REMOTE_APPROVAL_CREATE_TOKEN", "remote-create-token");
    const createApproval = vi.fn();
    const built = buildApp({
      createApproval,
    });
    app = built.app;
    await app.register(approvalsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/approvals",
      headers: {
        "idempotency-key": "approval-create-oversized",
        "x-goatcitadel-approval-create-token": "x".repeat(4097),
        "x-forwarded-for": "100.64.0.9",
      },
      payload: {
        kind: "tool.invoke",
        riskLevel: "danger",
        payload: {},
        preview: {},
        sourceConnectorId: "slack",
        sourceTraceId: "evt-123",
      },
    });

    expect(response.statusCode).toBe(401);
    expect(createApproval).not.toHaveBeenCalled();
  });

  it("issues remote action tokens for approval resolution", async () => {
    const createApprovalRemoteActionToken = vi.fn(() => ({
      approvalId: "apr_123",
      connectorId: "mission-control",
      tokenId: "rat_123",
      token: "grat_token",
      actionType: "approval.resolve",
      mutation: { approvalId: "apr_123" },
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      state: "pending",
    }));
    const built = buildApp({
      createApprovalRemoteActionToken,
    });
    app = built.app;
    await app.register(approvalsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/approvals/3d20b7eb-efdd-42ab-a6c6-1c8cbb291c1d/remote-token",
      payload: {
        connectorId: "  mission-control  ",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.json()).toMatchObject({
      tokenId: "rat_123",
      token: "grat_token",
      state: "pending",
    });
    expect(createApprovalRemoteActionToken).toHaveBeenCalledTimes(1);
    expect(createApprovalRemoteActionToken).toHaveBeenCalledWith(
      "3d20b7eb-efdd-42ab-a6c6-1c8cbb291c1d",
      expect.objectContaining({
        connectorId: "browser:mission-control",
      }),
    );
  });

  it("resolves approvals via remote action token", async () => {
    const resolveApprovalWithRemoteToken = vi.fn(async () => ({
      approval: {
        approvalId: "apr_123",
        kind: "tool.invoke",
        status: "approved",
        riskLevel: "danger",
        payload: {},
        preview: {},
        createdAt: new Date().toISOString(),
      },
    }));
    const built = buildApp({
      resolveApprovalWithRemoteToken,
    });
    app = built.app;
    await app.register(approvalsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/approvals/remote-resolve",
      payload: {
        token: "grat_token",
        decision: "approve",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(resolveApprovalWithRemoteToken).toHaveBeenCalledWith({
      token: "grat_token",
      decision: "approve",
      connectorId: "browser:mission-control",
    });
    expect(built.requireOperatorAuth).not.toHaveBeenCalled();
  });

  it("rejects oversized remote action tokens before service lookup", async () => {
    const resolveApprovalWithRemoteToken = vi.fn();
    const built = buildApp({ resolveApprovalWithRemoteToken });
    app = built.app;
    await app.register(approvalsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/approvals/remote-resolve",
      payload: { token: "x".repeat(4097), decision: "approve" },
    });

    expect(response.statusCode).toBe(400);
    expect(resolveApprovalWithRemoteToken).not.toHaveBeenCalled();
  });

  it("enforces the public remote-resolution limit even when a global allowlist would exempt the caller", async () => {
    const resolveApprovalWithRemoteToken = vi.fn(async () => ({ approval: { approvalId: APPROVAL_ID } }));
    const built = buildApp({ resolveApprovalWithRemoteToken });
    app = built.app;
    await app.register(rateLimit, {
      global: false,
      allowList: () => true,
    });
    await app.register(approvalsRoutes);

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/approvals/remote-resolve",
        payload: { token: "grat_token", decision: "approve" },
      });
      expect(response.statusCode).toBe(200);
    }
    const limited = await app.inject({
      method: "POST",
      url: "/api/v1/approvals/remote-resolve",
      payload: { token: "grat_token", decision: "approve" },
    });

    expect(limited.statusCode).toBe(429);
    expect(resolveApprovalWithRemoteToken).toHaveBeenCalledTimes(20);
  });

  it("projects remote approval resolution responses while preserving internal executable truth", async () => {
    const rawApproval = createSensitiveApproval("approved");
    const rawResolution = createSensitiveResolution(rawApproval);
    const resolveApprovalWithRemoteToken = vi.fn(async () => rawResolution);
    const built = buildApp({ resolveApprovalWithRemoteToken });
    app = built.app;
    await app.register(approvalsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/approvals/remote-resolve",
      payload: { token: "grat_token", decision: "approve" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ approval: Record<string, unknown>; durableRunId: string }>();
    expectSecretSafeApprovalProjection(body);
    expectApprovalMetadataPreserved(body.approval);
    expect(body.durableRunId).toBe("durable-run-42");
    expectRawApprovalUnchanged(rawApproval);
    expect(rawResolution.replay.events[0]!.payload.command).toBe(rawApproval.payload.command);
  });

  it("bulk resolves pending approvals through the gateway", async () => {
    const rawApproval = createSensitiveApproval("rejected");
    const rawResolution = createSensitiveResolution(rawApproval);
    const resolveApprovalsBulk = vi.fn(async () => ({
      decision: "reject",
      status: "pending",
      resolvedCount: 6,
      skippedCount: 1,
      failedCount: 0,
      results: [rawResolution],
    }));
    const built = buildApp({
      resolveApprovalsBulk,
    });
    app = built.app;
    await app.register(approvalsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/approvals/bulk-resolve",
      payload: {
        decision: "reject",
        status: "pending",
        resolvedBy: "spoofed-client",
        resolutionNote: "Clear pending approvals",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(resolveApprovalsBulk).toHaveBeenCalledWith({
      decision: "reject",
      status: "pending",
      resolvedBy: "ip:127.0.0.1",
      resolutionNote: "Clear pending approvals",
    });
    expect(response.json()).toMatchObject({
      resolvedCount: 6,
      skippedCount: 1,
      failedCount: 0,
    });
    expectSecretSafeApprovalProjection(response.json());
    expectRawApprovalUnchanged(rawApproval);
  });

  it("server-stamps single approval resolution actor", async () => {
    const resolveApproval = vi.fn(async () => ({
      approval: {
        approvalId: "3d20b7eb-efdd-42ab-a6c6-1c8cbb291c1d",
        status: "approved",
      },
    }));
    const built = buildApp({
      resolveApproval,
    });
    app = built.app;
    await app.register(approvalsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/approvals/3d20b7eb-efdd-42ab-a6c6-1c8cbb291c1d/resolve",
      payload: {
        decision: "approve",
        resolvedBy: "spoofed-client",
      },
      remoteAddress: "127.0.0.1",
    });

    expect(response.statusCode).toBe(200);
    expect(resolveApproval).toHaveBeenCalledWith("3d20b7eb-efdd-42ab-a6c6-1c8cbb291c1d", {
      decision: "approve",
      resolvedBy: "ip:127.0.0.1",
    });
  });

  it("projects direct approval resolution and replay fields without mutating service results", async () => {
    const rawApproval = createSensitiveApproval("approved");
    const rawResolution = createSensitiveResolution(rawApproval);
    const resolveApproval = vi.fn(async () => rawResolution);
    const built = buildApp({ resolveApproval });
    app = built.app;
    await app.register(approvalsRoutes);

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/approvals/${APPROVAL_ID}/resolve`,
      payload: { decision: "approve" },
      remoteAddress: "127.0.0.1",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      approval: Record<string, unknown>;
      replay: { events: Array<{ eventType: string; payload: Record<string, unknown> }> };
      durableRunId: string;
    }>();
    expectSecretSafeApprovalProjection(body);
    expectApprovalMetadataPreserved(body.approval);
    expect(body.replay.events[0]).toMatchObject({
      eventType: "resolved",
      payload: {
        tokenId: "rat_123",
        secretRef: "env:DATABASE_PASSWORD",
        status: "approved",
      },
    });
    expect(body.durableRunId).toBe("durable-run-42");
    expectRawApprovalUnchanged(rawApproval);
    expect(rawResolution.effects[0]!.payload.webhookUrl).toBe(rawApproval.payload.webhookUrl);
  });

  it("uses request actor fallback when bulk-resolve omits resolvedBy", async () => {
    const resolveApprovalsBulk = vi.fn(async () => ({
      decision: "reject",
      status: "pending",
      resolvedCount: 1,
      skippedCount: 0,
      failedCount: 0,
      results: [],
    }));
    const built = buildApp({
      resolveApprovalsBulk,
    });
    app = built.app;
    await app.register(approvalsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/approvals/bulk-resolve",
      payload: {
        decision: "reject",
      },
      remoteAddress: "127.0.0.1",
    });

    expect(response.statusCode).toBe(200);
    expect(resolveApprovalsBulk).toHaveBeenCalledWith({
      decision: "reject",
      resolvedBy: "ip:127.0.0.1",
    });
  });

  // SECURITY (codex finding #21): bulk-resolve no longer accepts
  // decision: "approve"; per-id explicit approval is required. See
  // docs/review/codex-security-findings-2026-05-18.md.
  it("rejects decision=approve at the bulk-resolve route (codex #21)", async () => {
    const resolveApprovalsBulk = vi.fn();
    const built = buildApp({ resolveApprovalsBulk });
    app = built.app;
    await app.register(approvalsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/approvals/bulk-resolve",
      payload: { decision: "approve" },
    });

    expect(response.statusCode).toBe(400);
    expect(resolveApprovalsBulk).not.toHaveBeenCalled();
  });

  it("uses request actor fallback when issuing remote action tokens", async () => {
    const createApprovalRemoteActionToken = vi.fn(() => ({
      approvalId: "apr_123",
      connectorId: "mission-control",
      tokenId: "rat_123",
      token: "grat_token",
      actionType: "approval.resolve",
      mutation: { approvalId: "apr_123" },
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      state: "pending",
    }));
    const built = buildApp({
      createApprovalRemoteActionToken,
    });
    app = built.app;
    await app.register(approvalsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/approvals/3d20b7eb-efdd-42ab-a6c6-1c8cbb291c1d/remote-token",
      payload: {
        connectorId: "mission-control",
      },
      remoteAddress: "127.0.0.1",
    });

    expect(response.statusCode).toBe(201);
    expect(createApprovalRemoteActionToken).toHaveBeenCalledWith(
      "3d20b7eb-efdd-42ab-a6c6-1c8cbb291c1d",
      expect.objectContaining({
        connectorId: "browser:mission-control",
        issuedBy: "ip:127.0.0.1",
      }),
    );
  });

  it("returns replay snapshots with an explicit durable run id", async () => {
    const getApprovalReplay = vi.fn(() => ({
      approval: {
        approvalId: "3d20b7eb-efdd-42ab-a6c6-1c8cbb291c1d",
        kind: "tool.invoke",
        status: "pending",
        riskLevel: "danger",
        payload: {},
        preview: {},
        createdAt: new Date().toISOString(),
      },
      events: [],
      durableRunId: "durable-run-42",
    }));
    const built = buildApp({
      getApprovalReplay,
    });
    app = built.app;
    await app.register(approvalsRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/approvals/3d20b7eb-efdd-42ab-a6c6-1c8cbb291c1d/replay?replayedBy=spoofed-client",
      remoteAddress: "127.0.0.1",
    });

    expect(response.statusCode).toBe(200);
    expect(getApprovalReplay).toHaveBeenCalledWith("3d20b7eb-efdd-42ab-a6c6-1c8cbb291c1d", "ip:127.0.0.1");
    expect(response.json()).toMatchObject({
      durableRunId: "durable-run-42",
    });
    expect(built.requireOperatorAuth).toHaveBeenCalledTimes(1);
  });

  it("projects approval replay snapshots without hiding safe lineage metadata", async () => {
    const rawApproval = createSensitiveApproval("approved");
    const rawReplay = createSensitiveResolution(rawApproval).replay;
    const getApprovalReplay = vi.fn(() => ({ ...rawReplay, durableRunId: "durable-run-42" }));
    const built = buildApp({ getApprovalReplay });
    app = built.app;
    await app.register(approvalsRoutes);

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/approvals/${APPROVAL_ID}/replay`,
      remoteAddress: "127.0.0.1",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      approval: Record<string, unknown>;
      events: Array<{ eventType: string; payload: Record<string, unknown> }>;
      durableRunId: string;
    }>();
    expectSecretSafeApprovalProjection(body);
    expectApprovalMetadataPreserved(body.approval);
    expect(body.events[0]).toMatchObject({
      eventType: "resolved",
      payload: {
        tokenId: "rat_123",
        secretRef: "env:DATABASE_PASSWORD",
        status: "approved",
      },
    });
    expect(body.durableRunId).toBe("durable-run-42");
    expectRawApprovalUnchanged(rawApproval);
  });
});

describe("resolveApprovalActorId", () => {
  it("prefers the companion session id over a generic auth:none actor", () => {
    expect(
      resolveApprovalActorId({
        authActorId: "auth:none",
        authCompanionSessionId: "comp-sess-1",
        authDeviceId: "dev-1",
        ip: "127.0.0.1",
      }),
    ).toBe("companion:comp-sess-1");
  });

  it("prefers the device id when no companion session is present", () => {
    expect(
      resolveApprovalActorId({
        authActorId: "auth:none",
        authDeviceId: "dev-1",
        ip: "127.0.0.1",
      }),
    ).toBe("device:dev-1");
  });

  it("keeps a specific authActorId untouched", () => {
    expect(resolveApprovalActorId({ authActorId: "token:abc123", ip: "127.0.0.1" })).toBe("token:abc123");
  });

  it("falls back to auth:none before the IP when that is all that is present", () => {
    expect(resolveApprovalActorId({ authActorId: "auth:none", ip: "127.0.0.1" })).toBe("auth:none");
  });

  it("falls back to the request IP only when no actor identity exists", () => {
    expect(resolveApprovalActorId({ ip: "127.0.0.1" })).toBe("ip:127.0.0.1");
    expect(resolveApprovalActorId({})).toBe("ip:unknown");
  });
});
