import test from "node:test";
import assert from "node:assert/strict";
import { buildReleaseProofSummary, renderReleaseProofSummaryMarkdown } from "./release-proof-summary.mjs";

test("release proof summary renders artifact table from certificate projection", () => {
  const summary = buildReleaseProofSummary({
    product: "GoatCitadel",
    version: "1.0.0",
    commit: "abc123",
    releaseWorkflow: { name: "Release Installers and Bundles" },
    requiredLanes: [{ directRun: { head_sha: "abc123" } }],
    acceptedFailures: ["manual caveat"],
    releaseAssets: [
      {
        fileName: "GoatCitadel-win-x64.zip",
        sha256: "sha",
        sizeBytes: 123,
      },
      { fileName: "GoatCitadel-win-x64.zip.sig", sha256: "sig-sha", sizeBytes: 12 },
    ],
  });
  const markdown = renderReleaseProofSummaryMarkdown(summary);

  assert.equal(summary.exactShaStatus.status, "exact");
  assert.equal(summary.artifacts[0].platformArch, "windows/x64");
  assert.equal(summary.artifacts[0].signatureStatus, "signed");
  assert.match(markdown, /GoatCitadel-win-x64\.zip/);
  assert.match(markdown, /Release Installers and Bundles/);
  assert.match(markdown, /manual caveat/);
});
