import { describe, expect, it, vi } from "vitest";
import { buildCompanionBootstrapArtifactPath, buildCompanionBootstrapBrief } from "./companion-bootstrap-brief.js";

describe("companion bootstrap brief", () => {
  it("builds a current-proof brief when companion artifacts are fresh", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T12:34:56.789Z"));
    const draft = buildCompanionBootstrapBrief(report({ hasContract: true, proofCurrent: true }));
    vi.useRealTimers();

    expect(draft.generatedAt).toBe("2026-05-14T12:34:56.789Z");
    expect(draft.summary).toContain("contract-1 now has current Android runtime/UI proof");
    expect(draft.markdown).toContain("## Current Proof Focus");
    expect(draft.markdown).toContain("- Platform targets: Android (beta)");
    expect(draft.markdown).toContain("- Blocking issues: none");
    expect(buildCompanionBootstrapArtifactPath(draft)).toBe(
      "artifacts/follow-on-parity/companion/2026-05-14/companion-bootstrap-brief-2026-05-14T12-34-56-789Z.md",
    );
  });

  it("calls out the first proof gap when artifacts are not current", () => {
    const draft = buildCompanionBootstrapBrief(report({ hasContract: true, proofCurrent: false }));

    expect(draft.summary).toContain("remaining proof gap is the Android runtime/UI bundle");
    expect(draft.markdown).toContain("## Expected First Proof");
    expect(draft.markdown).toContain("- Blocking issues: android proof missing");
  });

  it("blocks bootstrap when the companion contract is missing", () => {
    const draft = buildCompanionBootstrapBrief(report({ hasContract: false, proofCurrent: false }));

    expect(draft.summary).toContain("blocked until the live companion contract is resolved");
    expect(draft.markdown).toContain("- Contract id: missing");
    expect(draft.markdown).toContain("- Transport lanes: missing");
  });
});

function report(input: { hasContract: boolean; proofCurrent: boolean }) {
  return {
    deploymentProfile: "local",
    authMode: "token",
    companion: {
      paritySummary: "ready",
      platformTargets: [{ label: "Android", maturity: "beta" }],
      blockingIssues: input.proofCurrent ? [] : ["android proof missing"],
      artifactStatus: {
        hasArtifact: input.proofCurrent,
        freshness: input.proofCurrent ? "current" : "missing",
      },
      contract: input.hasContract
        ? {
            contractId: "contract-1",
            primaryTarget: "Android",
            bootstrapRepo: "GoatCitadel-mobile",
            repoStrategy: "separate",
            bootstrapStatus: "ready",
            transportLanes: ["http", "sse"],
            bootstrapFeatures: ["approval", "resume"],
          }
        : undefined,
      authReadiness: [{ label: "Device approval", state: "ready", note: "covered" }],
      prerequisiteReadiness: [{ label: "Gateway", state: "ready", note: "healthy" }],
      recommendedActions: ["Run Android proof"],
    },
  } as never;
}
