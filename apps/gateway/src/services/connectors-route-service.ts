import { createHash, randomBytes, verify } from "node:crypto";
import type {
  ConnectorEnrollmentActivateRequest,
  ConnectorEnrollmentChallengeRequest,
  ConnectorEnrollmentChallengeResponse,
  ConnectorEnrollmentCompleteRequest,
  ConnectorEnrollmentHealthResponse,
  ConnectorEnrollmentRecord,
  ConnectorRecord,
  ConnectorType,
} from "@goatcitadel/contracts";
import { filterConnectorRecords } from "./connector-registry.js";

const ENROLLMENT_CHALLENGE_TTL_MS = 10 * 60 * 1000;

export interface ConnectorsRoutePort {
  listConnectorRecords(connectorType?: ConnectorType): ConnectorRecord[];
}

export class ConnectorsRouteService {
  private readonly enrollments = new Map<string, ConnectorEnrollmentRecord & { publicKeyPem: string }>();

  public constructor(private readonly port: ConnectorsRoutePort) {}

  public listConnectorRecords(connectorType?: ConnectorType): ConnectorRecord[] {
    const projected = [...this.port.listConnectorRecords(), ...this.listEnrollmentConnectorRecords()];
    return filterConnectorRecords(projected, connectorType);
  }

  public issueConnectorEnrollmentChallenge(
    input: ConnectorEnrollmentChallengeRequest,
  ): ConnectorEnrollmentChallengeResponse {
    const now = new Date();
    const enrollmentId = `enroll_${randomBytes(12).toString("hex")}`;
    const connectorId = `enrolled:${enrollmentId}`;
    const sourceId = input.sourceId?.trim() || enrollmentId;
    const challenge = `goatcitadel.connector.enroll.${randomBytes(24).toString("base64url")}`;
    const enrollment: ConnectorEnrollmentRecord & { publicKeyPem: string } = {
      enrollmentId,
      connectorId,
      connectorType: input.connectorType,
      label: input.label.trim(),
      sourceId,
      status: "challenge_issued",
      challenge,
      challengeExpiresAt: new Date(now.getTime() + ENROLLMENT_CHALLENGE_TTL_MS).toISOString(),
      publicKeyFingerprint: fingerprintPublicKey(input.publicKeyPem),
      publicKeyPem: input.publicKeyPem,
      capabilities: input.capabilities ?? [],
      createdAt: now.toISOString(),
    };
    this.enrollments.set(enrollmentId, enrollment);
    return {
      enrollment: stripEnrollmentSecret(enrollment),
      challenge,
      signatureAlgorithm: "ed25519",
    };
  }

  public completeConnectorEnrollment(
    enrollmentId: string,
    input: ConnectorEnrollmentCompleteRequest,
  ): ConnectorEnrollmentRecord {
    const enrollment = this.requireEnrollment(enrollmentId);
    if (enrollment.status !== "challenge_issued" && enrollment.status !== "failed_signature") {
      return stripEnrollmentSecret(enrollment);
    }
    if (isEnrollmentExpired(enrollment)) {
      enrollment.status = "expired";
      enrollment.lastError = "Connector enrollment challenge expired.";
      return stripEnrollmentSecret(enrollment);
    }
    if (!verifyConnectorSignature(enrollment.publicKeyPem, enrollment.challenge, input.signatureBase64)) {
      enrollment.status = "failed_signature";
      enrollment.lastError = "Connector enrollment challenge signature did not verify.";
      return stripEnrollmentSecret(enrollment);
    }
    enrollment.status = "disabled";
    enrollment.completedAt = new Date().toISOString();
    enrollment.lastError = undefined;
    return stripEnrollmentSecret(enrollment);
  }

  public getConnectorEnrollment(enrollmentId: string): ConnectorEnrollmentRecord {
    return stripEnrollmentSecret(this.requireEnrollment(enrollmentId));
  }

  public checkConnectorEnrollmentHealth(enrollmentId: string): ConnectorEnrollmentHealthResponse {
    const enrollment = this.requireEnrollment(enrollmentId);
    const checkedAt = new Date().toISOString();
    enrollment.lastHealthCheckAt = checkedAt;
    if (isEnrollmentExpired(enrollment) && enrollment.status === "challenge_issued") {
      enrollment.status = "expired";
      enrollment.lastError = "Connector enrollment challenge expired.";
    }
    const blockers = buildEnrollmentBlockers(enrollment);
    return {
      enrollmentId: enrollment.enrollmentId,
      connectorId: enrollment.connectorId,
      status: enrollment.status,
      callable: enrollment.status === "active" && blockers.length === 0,
      checkedAt,
      blockers,
    };
  }

  public activateConnectorEnrollment(
    enrollmentId: string,
    input: ConnectorEnrollmentActivateRequest,
  ): ConnectorEnrollmentRecord {
    const enrollment = this.requireEnrollment(enrollmentId);
    if (enrollment.status !== "disabled") {
      enrollment.lastError = `Connector enrollment is ${enrollment.status}; only disabled verified connectors can be activated.`;
      return stripEnrollmentSecret(enrollment);
    }
    enrollment.status = "active";
    enrollment.activatedAt = new Date().toISOString();
    enrollment.activatedBy = input.approvedBy.trim() || "operator";
    enrollment.lastError = undefined;
    return stripEnrollmentSecret(enrollment);
  }

  private requireEnrollment(enrollmentId: string): ConnectorEnrollmentRecord & { publicKeyPem: string } {
    const enrollment = this.enrollments.get(enrollmentId);
    if (!enrollment) {
      throw new Error(`Connector enrollment ${enrollmentId} was not found.`);
    }
    return enrollment;
  }

  private listEnrollmentConnectorRecords(): ConnectorRecord[] {
    return [...this.enrollments.values()].map((enrollment) => ({
      connectorId: enrollment.connectorId,
      connectorType: enrollment.connectorType,
      label: enrollment.label,
      sourceId: enrollment.sourceId,
      status: enrollment.status === "active" ? "active" : enrollment.status === "disabled" ? "disabled" : "degraded",
      capabilities: enrollment.capabilities.map((capability) => ({
        ...capability,
        enabled: enrollment.status === "active" && capability.enabled,
      })),
      metadata: {
        enrollmentId: enrollment.enrollmentId,
        enrollmentStatus: enrollment.status,
        publicKeyFingerprint: enrollment.publicKeyFingerprint,
        activationRequired: enrollment.status !== "active",
        policyBoundary:
          "Enrollment does not bypass Gateway auth, policy, audit, network allowlists, or approval requirements.",
      },
      lastSeenAt: enrollment.lastHealthCheckAt ?? enrollment.completedAt ?? enrollment.createdAt,
      lastError: enrollment.lastError,
    }));
  }
}

export function createConnectorsRouteService(port: ConnectorsRoutePort): ConnectorsRouteService {
  return new ConnectorsRouteService(port);
}

function fingerprintPublicKey(publicKeyPem: string): string {
  return createHash("sha256").update(publicKeyPem).digest("hex").slice(0, 16);
}

function verifyConnectorSignature(publicKeyPem: string, challenge: string, signatureBase64: string): boolean {
  try {
    return verify(null, Buffer.from(challenge), publicKeyPem, Buffer.from(signatureBase64, "base64"));
  } catch {
    return false;
  }
}

function isEnrollmentExpired(enrollment: ConnectorEnrollmentRecord): boolean {
  return Date.parse(enrollment.challengeExpiresAt) <= Date.now();
}

function buildEnrollmentBlockers(enrollment: ConnectorEnrollmentRecord): string[] {
  if (enrollment.status === "active") {
    return [];
  }
  if (enrollment.status === "challenge_issued") {
    return ["Challenge has not been signed by the connector."];
  }
  if (enrollment.status === "disabled") {
    return ["Connector is verified but disabled until explicit operator activation."];
  }
  return [enrollment.lastError ?? `Connector enrollment is ${enrollment.status}.`];
}

function stripEnrollmentSecret(
  enrollment: ConnectorEnrollmentRecord & { publicKeyPem?: string },
): ConnectorEnrollmentRecord {
  const { publicKeyPem: _publicKeyPem, ...publicRecord } = enrollment;
  return publicRecord;
}
