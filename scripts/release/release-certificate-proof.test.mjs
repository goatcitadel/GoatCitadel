import test from "node:test";
import assert from "node:assert/strict";
import { resolveLaneProof } from "./release-certificate-proof.mjs";

const spec = {
  name: "verify:runtime:truth",
  workflowFile: "verification-truth-lanes.yml",
  required: true,
  releaseProofCovered: true,
};

const releaseProofRun = {
  status: "success",
  conclusion: "success",
  html_url: "https://example.test/release-proof",
  id: 10,
  head_sha: "abc123",
};

test("does not hide an exact-SHA direct lane failure behind umbrella release proof", () => {
  const lane = resolveLaneProof({
    spec,
    directRun: {
      status: "failure",
      conclusion: "failure",
      html_url: "https://example.test/direct-failure",
      id: 11,
      head_sha: "abc123",
    },
    releaseProofRun,
    releaseProofWorkflowFile: "verification-1-0-release-proof.yml",
    targetCommit: "abc123",
  });

  assert.equal(lane.status, "failure");
  assert.equal(lane.proofSource, "lane-workflow");
  assert.equal(lane.substitutedByReleaseProof, false);
  assert.equal(lane.directRun.workflowRunUrl, "https://example.test/direct-failure");
});

test("allows exact-SHA umbrella proof to cover an unavailable direct lane", () => {
  const lane = resolveLaneProof({
    spec,
    directRun: {
      status: "missing",
      conclusion: null,
      html_url: null,
      id: null,
      head_sha: null,
    },
    releaseProofRun,
    releaseProofWorkflowFile: "verification-1-0-release-proof.yml",
    targetCommit: "abc123",
  });

  assert.equal(lane.status, "success");
  assert.equal(lane.proofSource, "release-proof");
  assert.equal(lane.substitutedByReleaseProof, true);
  assert.equal(lane.releaseProofRun.workflowRunUrl, "https://example.test/release-proof");
});

test("does not use an umbrella proof from a different commit", () => {
  const lane = resolveLaneProof({
    spec,
    directRun: {
      status: "missing",
      conclusion: null,
      html_url: null,
      id: null,
      head_sha: null,
    },
    releaseProofRun: {
      ...releaseProofRun,
      head_sha: "other-sha",
    },
    releaseProofWorkflowFile: "verification-1-0-release-proof.yml",
    targetCommit: "abc123",
  });

  assert.equal(lane.status, "missing");
  assert.equal(lane.proofSource, "lane-workflow");
  assert.equal(lane.substitutedByReleaseProof, false);
});
