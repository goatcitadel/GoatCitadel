import TestRenderer from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeBuildIdentity } from "@goatcitadel/contracts";
import { ShellStatusStrip, formatRuntimeIdentityChip } from "./MissionControlShellChrome";

const releaseScope = {
  area: "chat",
  section: "root",
  status: "ship",
  releaseAction: "none",
  verification: "verify:surface:regression",
  note: "Canonical Chat route.",
} as const;

describe("shell build identity chip", () => {
  it("is always an accessible action that opens detailed Ops proof", () => {
    const navigateBuildProof = vi.fn();
    const renderer = TestRenderer.create(
      <ShellStatusStrip
        approvalsPill={{ value: "0 pending" }}
        buildIdentity={buildIdentity({ verified: true })}
        buildIdentityError={null}
        currentReleaseScope={releaseScope}
        currentReleaseStatusLabel="Ship"
        daemonStatusValue="Serving"
        gatewayMessage="Gateway ready"
        navigateApprovals={vi.fn()}
        navigateBuildProof={navigateBuildProof}
        realtimeValue="Live"
        sessionsPill={{ value: "1 visible" }}
        spendPill={{ value: "$0.00" }}
      />,
    );

    const chip = renderer.root.findByProps({
      "aria-label": "Build identity: Packaged · v1.0.0 · aaaaaaaa · installed payload verified",
    });
    expect(chip.type).toBe("button");
    expect(chip.props["data-identity-status"]).toBe("verified");
    expect(chip.props.className).toContain("mc-next-status-pill-action");
    expect(chip.props.type).toBe("button");
    expect(chip.props.disabled).toBeUndefined();

    const pinnedAnchor = renderer.root.findByProps({ "data-shell-identity-anchor": "pinned" });
    expect(pinnedAnchor.parent?.props.className).toBe("mc-next-status-strip");
    const scrollingMetrics = renderer.root.findByProps({ className: "mc-next-status-strip-primary" });
    expect(scrollingMetrics.findAllByProps({ "aria-label": chip.props["aria-label"] })).toHaveLength(0);

    TestRenderer.act(() => chip.props.onClick());
    expect(navigateBuildProof).toHaveBeenCalledOnce();
  });

  it("never upgrades absent, malformed, or unavailable proof to release verified", () => {
    const absent = formatRuntimeIdentityChip(buildIdentity({ verified: false, certificateState: "absent" }), null);
    const malformed = formatRuntimeIdentityChip(
      buildIdentity({ verified: false, certificateState: "malformed" }),
      null,
    );
    const unavailable = formatRuntimeIdentityChip(null, "identity endpoint unavailable");

    expect(absent).toEqual({
      value: "Packaged · v1.0.0 · aaaaaaaa · proof unverified",
      compactValue: "unverified/Pkg/v1.0.0/aaaaaaaa",
      status: "unverified",
    });
    expect(malformed.value).toContain("proof unverified");
    expect(malformed.value).not.toContain("installed payload verified");
    expect(unavailable).toEqual({
      value: "Identity unavailable",
      compactValue: "Build ID unavailable",
      status: "unavailable",
    });

    const contradictory = formatRuntimeIdentityChip(
      buildIdentity({ verified: true, certificateState: "absent" }),
      null,
    );
    expect(contradictory).toMatchObject({ status: "unverified" });
    expect(contradictory.value).toContain("proof unverified");
    expect(contradictory.value).not.toContain("installed payload verified");

    const missingPayloadProof = buildIdentity({ verified: true });
    missingPayloadProof.release.runtimePayloadIntegrity.status = "unverified";
    expect(formatRuntimeIdentityChip(missingPayloadProof, null)).toMatchObject({ status: "unverified" });

    const missingPublisherProof = buildIdentity({ verified: true });
    missingPublisherProof.release.certificateAttestation.status = "unavailable";
    expect(formatRuntimeIdentityChip(missingPublisherProof, null)).toMatchObject({ status: "unverified" });

    const anonymousPublisherProof = buildIdentity({ verified: true });
    anonymousPublisherProof.release.certificateAttestation.identity = "";
    expect(formatRuntimeIdentityChip(anonymousPublisherProof, null)).toMatchObject({ status: "unverified" });

    const unscopedPayloadProof = buildIdentity({ verified: true });
    unscopedPayloadProof.release.runtimePayloadIntegrity.target = "";
    expect(formatRuntimeIdentityChip(unscopedPayloadProof, null)).toMatchObject({ status: "unverified" });
  });

  it("exposes modified development source truth in the compact value used at mobile widths", () => {
    const value = formatRuntimeIdentityChip(
      {
        ...buildIdentity({ verified: false }),
        kind: "development",
        integrity: "modified",
      },
      null,
    );
    expect(value).toEqual({
      value: "Dev · v1.0.0 · aaaaaaaa · modified · proof unverified",
      compactValue: "unverified/Dev/v1.0.0/aaaaaaaa/modified",
      status: "unverified",
    });
  });
});

function buildIdentity(input: {
  verified: boolean;
  certificateState?: "absent" | "malformed" | "parsed";
}): RuntimeBuildIdentity {
  return {
    schemaVersion: 1,
    kind: "packaged",
    version: "1.0.0",
    buildSha: "a".repeat(40),
    shortSha: "a".repeat(8),
    integrity: "clean",
    identitySource: "packaged_manifest",
    release: {
      verified: input.verified,
      certificateState: input.certificateState ?? "parsed",
      certificateCommit: "a".repeat(40),
      certificateVersion: "1.0.0",
      generatedAt: "2026-07-13T12:00:00.000Z",
      requiredProof: { total: 1, passed: input.verified ? 1 : 0, missing: input.verified ? 0 : 1, failed: 0, stale: 0 },
      acceptedFailureCount: 0,
      acceptedFailures: [],
      certificateAttestation: input.verified
        ? {
            status: "verified",
            verifiedAt: "2026-07-13T12:01:00.000Z",
            issuer: "https://token.actions.githubusercontent.com",
            identity: "release-installers.yml",
          }
        : { status: "missing" },
      runtimePayloadIntegrity: input.verified
        ? {
            status: "verified",
            verifiedAt: "2026-07-13T12:02:00.000Z",
            target: "app/bin",
            manifestSha256: "b".repeat(64),
            fileCount: 3,
            totalBytes: 1_024,
          }
        : { status: "unverified" },
      reasonCodes: input.verified ? [] : ["certificate_absent"],
      reasons: input.verified ? [] : ["No release certificate is available to the running Gateway."],
    },
  };
}
