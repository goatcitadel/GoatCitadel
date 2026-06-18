import { afterEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { connectorsRoutes } from "./connectors.js";
import { createConnectorsRouteService } from "../services/connectors-route-service.js";

describe("connectors routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    vi.useRealTimers();
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  it("lists connector records and forwards connectorType filters", async () => {
    const listConnectorRecords = vi.fn(() => [
      {
        connectorId: "mcp:srv-1",
        connectorType: "mcp_server",
        label: "Approval Inbox",
        sourceId: "srv-1",
        status: "active",
        capabilities: [],
      },
    ]);
    app = Fastify();
    app.decorate("services", { connectors: { listConnectorRecords } } as never);
    await app.register(connectorsRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/connectors?connectorType=mcp_server",
    });

    expect(response.statusCode).toBe(200);
    expect(listConnectorRecords).toHaveBeenCalledWith("mcp_server");
    expect(response.json()).toMatchObject({
      items: [
        {
          connectorId: "mcp:srv-1",
          connectorType: "mcp_server",
        },
      ],
    });
  });

  it("enrolls connectors with signed challenges, disabled health, and explicit activation", async () => {
    const service = createConnectorsRouteService({ listConnectorRecords: vi.fn(() => []) });
    app = Fastify();
    app.decorate("services", { connectors: service } as never);
    await app.register(connectorsRoutes);
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");

    const challengeResponse = await app.inject({
      method: "POST",
      url: "/api/v1/connectors/enrollments/challenge",
      payload: {
        connectorType: "integration_connection",
        label: "External approval bridge",
        sourceId: "bridge-1",
        publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
        capabilities: [{ id: "approvals", version: "v1", enabled: true }],
      },
    });

    expect(challengeResponse.statusCode).toBe(201);
    const challengeBody = challengeResponse.json();
    const enrollmentId = challengeBody.enrollment.enrollmentId as string;
    const signatureBase64 = sign(null, Buffer.from(challengeBody.challenge), privateKey).toString("base64");

    const failed = await app.inject({
      method: "POST",
      url: `/api/v1/connectors/enrollments/${enrollmentId}/complete`,
      payload: { signatureBase64: "not-valid" },
    });
    expect(failed.json()).toMatchObject({ status: "failed_signature" });

    const completed = await app.inject({
      method: "POST",
      url: `/api/v1/connectors/enrollments/${enrollmentId}/complete`,
      payload: { signatureBase64 },
    });
    expect(completed.json()).toMatchObject({ status: "disabled" });

    const disabledHealth = await app.inject({
      method: "POST",
      url: `/api/v1/connectors/enrollments/${enrollmentId}/health`,
    });
    expect(disabledHealth.json()).toMatchObject({
      status: "disabled",
      callable: false,
      blockers: [expect.stringContaining("explicit operator activation")],
    });

    const listedDisabled = await app.inject({ method: "GET", url: "/api/v1/connectors" });
    expect(listedDisabled.json().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          connectorId: challengeBody.enrollment.connectorId,
          status: "disabled",
          metadata: expect.objectContaining({ activationRequired: true }),
        }),
      ]),
    );

    const activated = await app.inject({
      method: "POST",
      url: `/api/v1/connectors/enrollments/${enrollmentId}/activate`,
      payload: { approvedBy: "operator" },
    });
    expect(activated.json()).toMatchObject({ status: "active", activatedBy: "operator" });

    const activeHealth = await app.inject({
      method: "POST",
      url: `/api/v1/connectors/enrollments/${enrollmentId}/health`,
    });
    expect(activeHealth.json()).toMatchObject({ status: "active", callable: true, blockers: [] });

    const replayInvalidCompletion = await app.inject({
      method: "POST",
      url: `/api/v1/connectors/enrollments/${enrollmentId}/complete`,
      payload: { signatureBase64: "not-valid" },
    });
    expect(replayInvalidCompletion.json()).toMatchObject({ status: "active" });
    expect(replayInvalidCompletion.json().lastError).toBeUndefined();

    const replayValidCompletion = await app.inject({
      method: "POST",
      url: `/api/v1/connectors/enrollments/${enrollmentId}/complete`,
      payload: { signatureBase64 },
    });
    expect(replayValidCompletion.json()).toMatchObject({ status: "active" });
    expect(replayValidCompletion.json().lastError).toBeUndefined();

    const activeHealthAfterReplay = await app.inject({
      method: "POST",
      url: `/api/v1/connectors/enrollments/${enrollmentId}/health`,
    });
    expect(activeHealthAfterReplay.json()).toMatchObject({ status: "active", callable: true, blockers: [] });
  });

  it("expires unsigned connector challenges before completion", async () => {
    const service = createConnectorsRouteService({ listConnectorRecords: vi.fn(() => []) });
    app = Fastify();
    app.decorate("services", { connectors: service } as never);
    await app.register(connectorsRoutes);
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const challengeResponse = await app.inject({
      method: "POST",
      url: "/api/v1/connectors/enrollments/challenge",
      payload: {
        connectorType: "mcp_server",
        label: "MCP sidecar",
        publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
      },
    });
    const body = challengeResponse.json();
    const signatureBase64 = sign(null, Buffer.from(body.challenge), privateKey).toString("base64");
    (
      service as unknown as {
        enrollments: Map<string, { challengeExpiresAt: string }>;
      }
    ).enrollments.get(body.enrollment.enrollmentId)!.challengeExpiresAt = "2026-06-18T00:00:00.000Z";

    const completed = await app.inject({
      method: "POST",
      url: `/api/v1/connectors/enrollments/${body.enrollment.enrollmentId}/complete`,
      payload: { signatureBase64 },
    });

    expect(completed.json()).toMatchObject({ status: "expired", lastError: expect.stringContaining("expired") });
  });
});
