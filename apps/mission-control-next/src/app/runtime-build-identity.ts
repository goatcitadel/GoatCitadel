import type { RuntimeBuildIdentity } from "@goatcitadel/contracts";

const FULL_GIT_SHA = /^[a-f0-9]{40}$/i;
const SHA256 = /^[a-f0-9]{64}$/i;

/**
 * Fail-closed display invariant for server-owned release identity. The Gateway
 * remains authoritative, but shell chrome must not paint a green trust claim
 * from a contradictory, stale, or partially downgraded response.
 */
export function isRuntimeReleaseVerified(identity: RuntimeBuildIdentity | null | undefined): boolean {
  if (!identity) return false;
  const release = identity.release;
  const buildSha = identity.buildSha?.toLowerCase();
  const certificateCommit = release.certificateCommit?.toLowerCase();
  const runningVersion = normalizeVersion(identity.version);
  const certificateVersion = normalizeVersion(release.certificateVersion);
  const attestation = release.certificateAttestation;
  const payload = release.runtimePayloadIntegrity;
  const attestationVerifiedAt = attestation?.verifiedAt;
  const payloadVerifiedAt = payload?.verifiedAt;
  return Boolean(
    release.verified === true &&
    release.certificateState === "parsed" &&
    buildSha &&
    FULL_GIT_SHA.test(buildSha) &&
    certificateCommit === buildSha &&
    runningVersion &&
    certificateVersion === runningVersion &&
    release.generatedAt &&
    Number.isFinite(Date.parse(release.generatedAt)) &&
    attestation?.status === "verified" &&
    attestationVerifiedAt &&
    Number.isFinite(Date.parse(attestationVerifiedAt)) &&
    attestation.issuer?.trim() &&
    attestation.identity?.trim() &&
    payload?.status === "verified" &&
    payloadVerifiedAt &&
    Number.isFinite(Date.parse(payloadVerifiedAt)) &&
    payload.target?.trim() &&
    payload.manifestSha256 &&
    SHA256.test(payload.manifestSha256) &&
    Number.isSafeInteger(payload.fileCount) &&
    (payload.fileCount ?? 0) > 0 &&
    Number.isSafeInteger(payload.totalBytes) &&
    (payload.totalBytes ?? 0) > 0 &&
    identity.integrity === "clean" &&
    identity.identitySource !== "unavailable" &&
    release.requiredProof.total > 0 &&
    release.requiredProof.passed === release.requiredProof.total &&
    release.requiredProof.missing === 0 &&
    release.requiredProof.failed === 0 &&
    release.requiredProof.stale === 0 &&
    release.acceptedFailureCount === 0 &&
    release.acceptedFailures.length === 0 &&
    release.reasonCodes.length === 0 &&
    release.reasons.length === 0,
  );
}

function normalizeVersion(value: string | undefined): string | undefined {
  if (!value || value === "unknown") return undefined;
  return value.replace(/^v/i, "");
}
