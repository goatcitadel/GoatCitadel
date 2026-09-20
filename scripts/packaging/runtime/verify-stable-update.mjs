#!/usr/bin/env node
// Runs from app/runtime with the already-installed verifier; never executes downloaded code.
import { DefaultSigstoreVerificationPort } from "../gateway/dist/services/runtime-release-trust-sigstore.js";
import { buildFulcioCertificateOidPolicy } from "../gateway/dist/services/runtime-release-trust-service.js";
import { buildReleaseWorkflowIdentity, readUntrustedReleaseCertificateIdentity } from "../gateway/dist/services/runtime-release-trust-manifest.js";
import { hasCompleteReleaseCertificateEvidence } from "../gateway/dist/services/review-readiness-service.js";

try {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > 5 * 1024 * 1024) throw new Error("Oversized release proof");
    chunks.push(chunk);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const certificateBytes = Buffer.from(input.certificateText, "utf8");
  const identity = readUntrustedReleaseCertificateIdentity(certificateBytes);
  const workflowIdentity = buildReleaseWorkflowIdentity(identity.tag);
  await new DefaultSigstoreVerificationPort().verify({
    bundle: JSON.parse(input.proofText), certificateBytes,
    certificateIssuer: "https://token.actions.githubusercontent.com",
    certificateIdentityURI: workflowIdentity,
    certificateOIDs: buildFulcioCertificateOidPolicy({ ...identity, workflowIdentity }),
    // Offline pinned trust material avoids adding a second network/check-cache owner.
    tufCachePath: "", refreshTrustRoot: false,
  });
  const certificate = JSON.parse(input.certificateText);
  if (!hasCompleteReleaseCertificateEvidence(certificate)) throw new Error("Incomplete release evidence");
  const assets = {};
  for (const arch of ["x64", "arm64"]) {
    const target = "windows-" + arch;
    const name = "GoatCitadel-Setup-" + target + ".exe";
    const matches = certificate.releaseAssets.filter((asset) =>
      asset.relativePath === target + "-release-assets/" + name && asset.fileName === name);
    if (matches.length !== 1) throw new Error("Missing signed installer binding");
    const asset = matches[0];
    assets[target] = { name, sha256: asset.sha256, sizeBytes: asset.sizeBytes };
  }
  process.stdout.write(JSON.stringify({
    schemaVersion: 1, product: "GoatCitadel", repository: "goatcitadel/GoatCitadel",
    channel: "stable", publisherSigned: true, tag: identity.tag, version: identity.version,
    sourceCommit: identity.commit, buildSequence: Date.parse(certificate.generatedAt), assets,
  }));
} catch {
  process.stderr.write("Stable release proof verification failed.\n");
  process.exitCode = 1;
}
