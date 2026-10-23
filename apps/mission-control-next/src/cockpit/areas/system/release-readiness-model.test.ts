import { describe, expect, it } from "vitest";
import type { ReviewReadinessSummary } from "@goatcitadel/contracts";
import { releaseReadinessSummary } from "./release-readiness-model";

function summary(
  overrides: Partial<ReviewReadinessSummary["runtimeIdentity"]["release"]> = {},
): ReviewReadinessSummary {
  return {
    branch: "main",
    sha: "abcdef1234567890",
    generatedAt: "2026-10-23T08:00:00Z",
    lanes: [
      { lane: "verify:surface:regression", status: "current", rerunHint: "pnpm verify:surface:regression" },
      { lane: "docs:check", status: "stale", rerunHint: "pnpm docs:check" },
    ],
    openFindings: 2,
    linkedTasks: [],
    runtimeIdentity: {
      schemaVersion: 1,
      kind: "packaged",
      version: "1.0.0",
      integrity: "clean",
      identitySource: "packaged_manifest",
      release: {
        verified: false,
        certificateState: "parsed",
        requiredProof: { total: 14, passed: 12, missing: 1, failed: 1, stale: 0 },
        acceptedFailureCount: 0,
        acceptedFailures: [],
        certificateAttestation: { status: "missing" },
        runtimePayloadIntegrity: { status: "unverified" },
        reasonCodes: ["required_proof_failed", "certificate_attestation_missing"],
        reasons: ["One required check failed.", "The certificate has no attestation."],
        ...overrides,
      },
    },
  } as ReviewReadinessSummary;
}

describe("releaseReadinessSummary", () => {
  it("reads a release with reasons as Blocked, one blocker per reason, in plain words", () => {
    const result = releaseReadinessSummary(summary());
    expect(result.status).toEqual({ label: "Blocked", tone: "failed" });
    expect(result.blockers.map((item) => item.detail)).toEqual([
      "One required check failed.",
      "The certificate has no attestation.",
    ]);
    expect(result.blockers.every((item) => !item.title.includes("_"))).toBe(true);
    expect(result.sentence).toContain("12 of 14 required checks passed");
  });

  it("reads a verified release as Verified", () => {
    const result = releaseReadinessSummary(summary({ verified: true, reasonCodes: [], reasons: [] }));
    expect(result.status).toEqual({ label: "Verified", tone: "done" });
    expect(result.blockers).toEqual([]);
  });

  it("reads a build without a release certificate as Not certified, not Blocked", () => {
    const result = releaseReadinessSummary(
      summary({ certificateState: "absent", reasonCodes: ["certificate_absent"], reasons: ["No certificate."] }),
    );
    expect(result.status).toEqual({ label: "Not certified", tone: "neutral" });
  });

  it("names review checks without script names and presents their state", () => {
    const result = releaseReadinessSummary(summary());
    expect(result.checks).toEqual([
      { key: "verify:surface:regression", title: "Surface regression", status: { label: "Current", tone: "done" } },
      { key: "docs:check", title: "Docs check", status: { label: "Stale", tone: "waiting" } },
    ]);
  });
});
