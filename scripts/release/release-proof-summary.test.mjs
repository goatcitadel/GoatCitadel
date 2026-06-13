import test from "node:test";
import assert from "node:assert/strict";
import { buildReleaseProofSummary, renderReleaseProofSummaryMarkdown } from "./release-proof-summary.mjs";

test("release proof summary renders artifact table from certificate projection", () => {
  const summary = buildReleaseProofSummary({
    product: "GoatCitadel",
    version: "1.0.0",
    commit: "abc123",
    releaseUrl: "https://github.com/goatcitadel/GoatCitadel/releases/tag/v1.0.0",
    releaseWorkflow: {
      name: "Release Installers and Bundles",
      runUrl: "https://github.com/goatcitadel/GoatCitadel/actions/runs/123",
    },
    requiredLanes: [{ directRun: { head_sha: "abc123" } }],
    acceptedFailures: ["unsigned Windows installer accepted for local RC proof"],
    releaseAssets: [
      {
        fileName: "GoatCitadel-win-x64.zip",
        sha256: "sha",
        sizeBytes: 123,
        browser_download_url: "https://github.com/goatcitadel/GoatCitadel/releases/download/v1.0.0/GoatCitadel-win-x64.zip",
        checksumPath: "GoatCitadel-win-x64.zip.sha256",
      },
      { fileName: "GoatCitadel-win-x64.zip.sig", sha256: "sig-sha", sizeBytes: 12 },
    ],
  });
  const markdown = renderReleaseProofSummaryMarkdown(summary);

  assert.equal(summary.exactShaStatus.status, "exact");
  assert.equal(summary.publicRelease.publicationStatus, "published_or_draft");
  assert.equal(summary.publicRelease.actionUrl, "https://github.com/goatcitadel/GoatCitadel/actions/runs/123");
  assert.equal(summary.acceptedCaveatClassifications[0].classification, "signing");
  assert.equal(summary.artifacts[0].platformArch, "windows/x64");
  assert.equal(summary.artifacts[0].signatureStatus, "signed");
  assert.equal(summary.artifacts[0].checksumRef, "GoatCitadel-win-x64.zip.sha256");
  assert.equal(summary.artifacts[0].actionUrl, "https://github.com/goatcitadel/GoatCitadel/actions/runs/123");
  assert.match(markdown, /GoatCitadel-win-x64\.zip/);
  assert.match(markdown, /Release Installers and Bundles/);
  assert.match(markdown, /Public release: published_or_draft/);
  assert.match(markdown, /signing: unsigned Windows installer accepted/);
});
