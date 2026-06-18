import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { approvalsRoutes, resolveApprovalActorId } from "./approvals.js";

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
    const listApprovals = vi.fn(() => []);
    const built = buildApp({ listApprovals });
    app = built.app;
    await app.register(approvalsRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/approvals?status=pending&workspaceId=workspace-a",
    });

    expect(response.statusCode).toBe(200);
    expect(listApprovals).toHaveBeenCalledWith("pending", 100, "workspace-a");
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

  it.each([
    ["Forwarded", { forwarded: "for=100.64.0.9;proto=https" }],
    ["empty X-Forwarded-For", { "x-forwarded-for": "" }],
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
          originSurface: "cowork",
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
          originSurface: "cowork",
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
        connectorId: "mission-control",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(createApprovalRemoteActionToken).toHaveBeenCalledTimes(1);
    expect(createApprovalRemoteActionToken).toHaveBeenCalledWith(
      "3d20b7eb-efdd-42ab-a6c6-1c8cbb291c1d",
      expect.objectContaining({
        connectorId: "mission-control",
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
    });
    expect(built.requireOperatorAuth).not.toHaveBeenCalled();
  });

  it("bulk resolves pending approvals through the gateway", async () => {
    const resolveApprovalsBulk = vi.fn(async () => ({
      decision: "reject",
      status: "pending",
      resolvedCount: 6,
      skippedCount: 1,
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
        connectorId: "mission-control",
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
