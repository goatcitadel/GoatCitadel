import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { approvalsRoutes } from "./approvals.js";

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

  it("blocks approval creation for non-loopback callers", async () => {
    app = Fastify();
    app.decorate("gateway", {
      createApproval: vi.fn(),
    } as never);
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

  it("allows remote approval creation when override env is enabled", async () => {
    vi.stubEnv("GOATCITADEL_ALLOW_REMOTE_APPROVAL_CREATE", "1");
    const createApproval = vi.fn(async () => ({
      approvalId: "apr_123",
      kind: "tool.invoke",
      status: "pending",
      riskLevel: "danger",
      payload: {},
      preview: {},
      createdAt: new Date().toISOString(),
    }));
    app = Fastify();
    app.decorate("gateway", {
      createApproval,
    } as never);
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

    expect(response.statusCode).toBe(201);
    expect(createApproval).toHaveBeenCalledTimes(1);
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
    app = Fastify();
    app.decorate("gateway", {
      createApprovalRemoteActionToken,
    } as never);
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
    app = Fastify();
    app.decorate("gateway", {
      resolveApprovalWithRemoteToken,
    } as never);
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
    app = Fastify();
    app.decorate("gateway", {
      resolveApprovalsBulk,
    } as never);
    await app.register(approvalsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/approvals/bulk-resolve",
      payload: {
        decision: "reject",
        status: "pending",
        resolvedBy: "operator",
        resolutionNote: "Clear pending approvals",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(resolveApprovalsBulk).toHaveBeenCalledWith({
      decision: "reject",
      status: "pending",
      resolvedBy: "operator",
      resolutionNote: "Clear pending approvals",
    });
    expect(response.json()).toMatchObject({
      resolvedCount: 6,
      skippedCount: 1,
      failedCount: 0,
    });
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
    app = Fastify();
    app.decorate("gateway", {
      getApprovalReplay,
    } as never);
    await app.register(approvalsRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/approvals/3d20b7eb-efdd-42ab-a6c6-1c8cbb291c1d/replay",
    });

    expect(response.statusCode).toBe(200);
    expect(getApprovalReplay).toHaveBeenCalledWith("3d20b7eb-efdd-42ab-a6c6-1c8cbb291c1d", "operator");
    expect(response.json()).toMatchObject({
      durableRunId: "durable-run-42",
    });
  });
});
