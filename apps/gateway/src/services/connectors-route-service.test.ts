import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createConnectorsRouteService } from "./connectors-route-service.js";

describe("ConnectorsRouteService", () => {
  it("does not let replayed completion downgrade an active enrollment", () => {
    const service = createConnectorsRouteService({ listConnectorRecords: vi.fn(() => []) });
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const issued = service.issueConnectorEnrollmentChallenge({
      connectorType: "mcp_server",
      label: "MCP sidecar",
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
      capabilities: [{ id: "health_checks", version: "v1", enabled: true }],
    });
    const signatureBase64 = sign(null, Buffer.from(issued.challenge), privateKey).toString("base64");

    expect(service.completeConnectorEnrollment(issued.enrollment.enrollmentId, { signatureBase64 })).toMatchObject({
      status: "disabled",
    });
    expect(
      service.activateConnectorEnrollment(issued.enrollment.enrollmentId, { approvedBy: "operator" }),
    ).toMatchObject({
      status: "active",
      activatedBy: "operator",
    });

    expect(
      service.completeConnectorEnrollment(issued.enrollment.enrollmentId, { signatureBase64: "not-valid" }),
    ).toMatchObject({ status: "active", lastError: undefined });
    expect(service.completeConnectorEnrollment(issued.enrollment.enrollmentId, { signatureBase64 })).toMatchObject({
      status: "active",
      lastError: undefined,
    });
    expect(service.checkConnectorEnrollmentHealth(issued.enrollment.enrollmentId)).toMatchObject({
      status: "active",
      callable: true,
      blockers: [],
    });
  });
});
