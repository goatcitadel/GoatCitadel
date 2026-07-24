import type { ReleaseIdentityReasonCode } from "@goatcitadel/contracts";
import { MAX_RUNTIME_PAYLOAD_BYTES, MAX_RUNTIME_PAYLOAD_FILES } from "./runtime-release-trust-filesystem.js";
import type { RuntimeReleaseTrustSnapshot } from "./runtime-release-trust-service.js";

const SHA256 = /^[a-f0-9]{64}$/i;
const FIXED_SIGSTORE_ISSUER = "https://token.actions.githubusercontent.com";
const FIXED_RELEASE_WORKFLOW_IDENTITY =
  /^https:\/\/github\.com\/goatcitadel\/GoatCitadel\/\.github\/workflows\/release-installers\.yml@refs\/tags\/[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$/;

export function releaseAttestationReasonCode(
  releaseTrust: RuntimeReleaseTrustSnapshot,
): ReleaseIdentityReasonCode | undefined {
  switch (releaseTrust.certificate.status) {
    case "verified":
      return hasCompleteVerifiedAttestation(releaseTrust) ? undefined : "certificate_attestation_unavailable";
    case "missing":
      return "certificate_attestation_missing";
    case "pending":
      return "certificate_attestation_pending";
    case "unavailable":
      return "certificate_attestation_unavailable";
    case "invalid":
    case "not_applicable":
      return "certificate_attestation_invalid";
  }
}

export function releasePayloadReasonCode(
  releaseTrust: RuntimeReleaseTrustSnapshot,
): ReleaseIdentityReasonCode | undefined {
  switch (releaseTrust.payload.status) {
    case "verified":
      return hasCompleteVerifiedPayload(releaseTrust) ? undefined : "runtime_payload_integrity_unavailable";
    case "pending":
      return "runtime_payload_integrity_pending";
    case "mismatch":
      return "runtime_payload_integrity_mismatch";
    case "unavailable":
      return "runtime_payload_integrity_unavailable";
    case "unverified":
    case "not_applicable":
      return "runtime_payload_integrity_unverified";
  }
}

function hasCompleteVerifiedAttestation(releaseTrust: RuntimeReleaseTrustSnapshot): boolean {
  return Boolean(
    readValidIsoTimestamp(releaseTrust.checkedAt) &&
    readValidIsoTimestamp(releaseTrust.verifiedAt) &&
    releaseTrust.certificate.issuer === FIXED_SIGSTORE_ISSUER &&
    releaseTrust.certificate.identity &&
    FIXED_RELEASE_WORKFLOW_IDENTITY.test(releaseTrust.certificate.identity),
  );
}

export function hasCompleteVerifiedPayload(releaseTrust: RuntimeReleaseTrustSnapshot): boolean {
  const { target, manifestSha256, fileCount, totalBytes } = releaseTrust.payload;
  return Boolean(
    readValidIsoTimestamp(releaseTrust.checkedAt) &&
    readValidIsoTimestamp(releaseTrust.verifiedAt) &&
    (target === "windows-x64" || target === "windows-arm64") &&
    manifestSha256 &&
    SHA256.test(manifestSha256) &&
    Number.isSafeInteger(fileCount) &&
    fileCount! > 0 &&
    fileCount! <= MAX_RUNTIME_PAYLOAD_FILES &&
    Number.isSafeInteger(totalBytes) &&
    totalBytes! > 0 &&
    totalBytes! <= MAX_RUNTIME_PAYLOAD_BYTES,
  );
}

export function describeReleaseIdentityReason(code: ReleaseIdentityReasonCode): string {
  switch (code) {
    case "certificate_absent":
      return "No release certificate is available to the running Gateway.";
    case "certificate_malformed":
      return "The release certificate could not be parsed or did not match the supported schema.";
    case "certificate_attestation_missing":
      return "The release certificate has no cryptographically verified publisher attestation.";
    case "certificate_attestation_invalid":
      return "The supplied release-certificate attestation was not cryptographically verified.";
    case "certificate_attestation_pending":
      return "Publisher attestation verification is still running.";
    case "certificate_attestation_unavailable":
      return "Publisher attestation verification is unavailable or its trust root could not be loaded.";
    case "identity_sha_unavailable":
      return "The running checkout or packaged build SHA could not be proven.";
    case "identity_integrity_unavailable":
      return "The running source integrity could not be proven clean.";
    case "runtime_payload_integrity_unverified":
      return "The installed immutable runtime payload has not been verified against publisher-authenticated hashes.";
    case "runtime_payload_integrity_pending":
      return "Installed immutable runtime payload verification is still running.";
    case "runtime_payload_integrity_mismatch":
      return "The installed immutable runtime payload does not match the publisher-authenticated manifest.";
    case "runtime_payload_integrity_unavailable":
      return "Installed immutable runtime payload verification is currently unavailable.";
    case "source_modified":
      return "The running source or packaged build was produced from modified source.";
    case "certificate_sha_mismatch":
      return "The certificate commit does not match the running build identity.";
    case "certificate_version_mismatch":
      return "The certificate version does not match the running application version.";
    case "certificate_timestamp_invalid":
      return "The certificate generation time is missing or invalid.";
    case "accepted_failures_present":
      return "The certificate records accepted failures, so public release trust is not green.";
    case "required_proof_missing":
      return "One or more required release proof lanes are missing.";
    case "required_proof_failed":
      return "One or more required release proof lanes failed.";
    case "required_proof_stale":
      return "One or more required release proof lanes are bound to a different commit.";
    case "release_assets_missing":
      return "The certificate does not include release artifact evidence.";
    case "release_assets_invalid":
      return "One or more release artifact evidence records are invalid.";
    case "release_asset_evidence_missing":
      return "One or more certificate-bound release artifact files are unavailable to the running Gateway.";
    case "release_asset_evidence_mismatch":
      return "One or more release artifact files do not match the certificate size and SHA-256 digest.";
    case "release_evidence_path_invalid":
      return "Release evidence contains an unsafe path, symlink, junction, or path escape.";
    case "proof_bundle_missing":
      return "The certificate does not include a valid proof-bundle digest.";
    case "proof_bundle_evidence_missing":
      return "The certificate-bound proof bundle file is unavailable to the running Gateway.";
    case "proof_bundle_evidence_mismatch":
      return "The proof bundle file does not match the certificate size and SHA-256 digest.";
    case "certificate_exact_sha_invalid":
      return "The certificate exact-SHA summary is missing, incomplete, or inconsistent.";
  }
}

function readValidIsoTimestamp(value: unknown): string | undefined {
  const raw = typeof value === "string" && value.trim() ? value.trim() : undefined;
  if (!raw || raw.length > 64 || !Number.isFinite(Date.parse(raw))) {
    return undefined;
  }
  return raw;
}
