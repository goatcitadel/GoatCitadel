import { readFileSync } from "node:fs";
import TestRenderer from "react-test-renderer";
import type { ComponentProps } from "react";
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

function renderStatusStrip(overrides: Partial<ComponentProps<typeof ShellStatusStrip>> = {}) {
  return TestRenderer.create(
    <ShellStatusStrip
      approvalsPill={{ value: "0 pending" }}
      buildIdentity={null}
      buildIdentityError={null}
      currentReleaseScope={releaseScope}
      currentReleaseStatusLabel="Ship"
      daemonDegraded={false}
      daemonStatusValue="Serving"
      gatewayMessage="Gateway ready"
      navigateApprovals={vi.fn()}
      navigateBuildProof={vi.fn()}
      realtimeDegraded={false}
      realtimeValue="Streaming"
      sessionsPill={{ value: "1 visible" }}
      spendPill={{ value: "$0.00" }}
      {...overrides}
    />,
  );
}

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
        daemonDegraded={false}
        daemonStatusValue="Serving"
        gatewayMessage="Gateway ready"
        navigateApprovals={vi.fn()}
        navigateBuildProof={navigateBuildProof}
        realtimeDegraded={false}
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

    const systemControl = renderer.root.findByProps({ className: "mc-next-status-details mc-next-status-system" });
    expect(systemControl.parent?.props.className).toBe("mc-next-status-strip");
    expect(
      systemControl
        .findByType("summary")
        .findAllByType("span")
        .map((node) => node.children.join("")),
    ).toContain("System");
    expect(renderer.root.findAllByProps({ className: "mc-next-status-strip-primary" })).toHaveLength(0);

    TestRenderer.act(() => chip.props.onClick());
    expect(navigateBuildProof).toHaveBeenCalledOnce();
  });

  it("keeps unloaded dashboard approvals non-blocking while System is still checking", () => {
    const renderer = renderStatusStrip({ approvalsPill: { value: "—" } });
    const footer = renderer.root.findByProps({ "aria-label": "Mission Control status strip" });
    const summary = renderer.root.findByType("summary");

    expect(footer.props["data-status"]).toBe("checking");
    expect(summary.findByType("strong").children).toEqual(["Checking"]);
    expect(summary.children.join("")).not.toContain("Approval needed");
  });

  it("promotes realtime, daemon, and gateway degradation into the compact System status", () => {
    const cases = [
      {
        props: { realtimeDegraded: true, realtimeValue: "Polling fallback" },
        detailLabel: "Live updates: Polling fallback (unavailable)",
      },
      {
        props: { daemonDegraded: true, daemonStatusValue: "Needs intervention" },
        detailLabel: "Daemon: Needs intervention (unavailable)",
      },
      {
        props: { gatewayMessage: "Gateway unavailable" },
        detailLabel: "Gateway: Gateway unavailable (unavailable)",
      },
    ];

    for (const { props, detailLabel } of cases) {
      const renderer = renderStatusStrip(props);
      const footer = renderer.root.findByProps({ "aria-label": "Mission Control status strip" });
      const summary = renderer.root.findByType("summary");

      expect(footer.props["data-status"]).toBe("attention");
      expect(summary.findByType("strong").children).toEqual(["Needs attention"]);
      expect(renderer.root.findByProps({ "aria-label": detailLabel }).props["data-status"]).toBe("degraded");
      renderer.unmount();
    }
  });

  it("keeps the closed System details popover out of layout", () => {
    const css = readFileSync(new URL("../styles/mission-control-next.css", import.meta.url), "utf8");

    expect(css).toContain(".mc-next-status-details:not([open]) > .mc-next-status-details-popover");
    expect(css).toMatch(
      /\.mc-next-status-details:not\(\[open\]\) > \.mc-next-status-details-popover\s*\{[^}]*display:\s*none;/,
    );
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
