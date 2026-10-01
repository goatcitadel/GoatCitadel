import { renderToStaticMarkup } from "react-dom/server";
import type { CapabilityCatalogEntry } from "@goatcitadel/contracts";
import { describe, expect, it } from "vitest";
import { CapabilityPolicyEvidence, CapabilitySourceEvidence, readWorkspacePolicyEvidence } from "./CapabilityEvidence";
import { CapabilityLastUsed, CapabilityUsageEvidence } from "./CapabilityUsageEvidence";

const entry: CapabilityCatalogEntry = {
  capabilityId: "tool:review", kind: "tool", category: "mesh_published", title: "Review", summary: "Review work",
  callable: true, lifecycleState: "trusted", declaredTools: ["fs.read"], requires: ["workspace_scope"],
  wrapperVisibility: { readOnly: true, deterministic: true, codeModeAllowed: false },
  effectPotential: { version: "goatcitadel.tool-effect.v1", potential: "unknown", sourceKind: "remote", reason: "remote_runtime_may_cross_boundary" },
  sourceProvider: "local_registry", sourceRef: "skills/review/SKILL.md",
  mesh: { nodeId: "publisher-a", admissionGeneration: 1, publisherGeneration: 2,
    manifestSha256: "a".repeat(64), entrySha256: "b".repeat(64), localId: "review", capabilityKind: "tool",
    status: "review_required", reasons: ["publisher_offline"], effectPosture: "unknown" },
};

describe("capability detail evidence", () => {
  it("separates declared facts from effective policy and preserves unknown callability", () => {
    const html = renderToStaticMarkup(<CapabilityPolicyEvidence item={entry} callableKnown={false} />);
    expect(html).toContain("Callability could not be verified");
    expect(html).toContain("Declared tools, not grants");
    expect(html).toContain("Fs read");
    expect(html).toContain("outside effect unknown");
    expect(html).toContain("These flags are not a grant");
    expect(html).toContain("Effective policy depends on the workspace");
    expect(html).not.toContain("Listed as callable");
  });

  it("shows owner-provided provenance and distinguishes a missing source", () => {
    const html = renderToStaticMarkup(<CapabilitySourceEvidence item={entry} />);
    expect(html).toContain("skills/review/SKILL.md");
    expect(html).toContain("publisher-a");
    expect(html).toContain("a".repeat(64));
    expect(html).toContain("b".repeat(64));
    const missing = renderToStaticMarkup(<CapabilitySourceEvidence item={{ ...entry, sourceProvider: undefined, sourceRef: undefined, mesh: undefined }} />);
    expect(missing).toContain("No version hash or source reference is present");
  });

  it("shows only a scoped Gateway profile and withholds stale or foreign policy", () => {
    const response = { workspaceId: "workspace-a", surface: "tools", permissionProfile: { label: "Review first", approvalMode: "approve_all" }, localOperatorOverrideId: "override-a" };
    const policy = readWorkspacePolicyEvidence(response, "workspace-a");
    expect(policy).toEqual({ profileLabel: "Review first", approvalMode: "approve_all", localOverride: true });
    expect(readWorkspacePolicyEvidence(response, "workspace-b")).toBeNull();
    expect(readWorkspacePolicyEvidence({ ...response, surface: "chat" }, "workspace-a")).toBeNull();
    const html = renderToStaticMarkup(<CapabilityPolicyEvidence item={entry} callableKnown workspacePolicy={policy} workspacePolicyState="ready" />);
    expect(html).toContain("Current workspace tools profile: Review first");
    expect(html).toContain("Approval posture: Approve all");
    expect(html).toContain("Local operator override active");
    expect(html).toContain("current grants");
    expect(renderToStaticMarkup(<CapabilityPolicyEvidence item={entry} callableKnown workspacePolicyState="unavailable" />)).toContain("could not be verified");
  });

  it("shows recorded skill use without turning missing evidence into zero", () => {
    const recorded = renderToStaticMarkup(<CapabilityUsageEvidence usage={{ status: "recorded", usageCount: 3, lastUsedAt: "2026-09-28T12:00:00.000Z" }} />);
    expect(recorded).toContain("Recorded uses: 3");
    expect(recorded).toContain('dateTime="2026-09-28T12:00:00.000Z"');
    expect(recorded).toContain("not a complete history");
    expect(renderToStaticMarkup(<CapabilityLastUsed usage={{ status: "unavailable" }} />)).toContain("could not be checked");
    expect(renderToStaticMarkup(<CapabilityUsageEvidence usage={{ status: "unsupported" }} />)).toContain("not provided for this capability type");
  });
});
