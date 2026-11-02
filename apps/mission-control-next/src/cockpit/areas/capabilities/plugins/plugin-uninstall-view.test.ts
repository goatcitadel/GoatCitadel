import type { CapabilityPluginDetail, CapabilityPluginDetailPiece } from "@goatcitadel/contracts";
import { describe, expect, it } from "vitest";
import { uninstallApproval } from "./plugin-uninstall-view";

const NOTES: CapabilityPluginDetailPiece = {
  pieceId: "notes",
  kind: "skill",
  label: "Meeting notes",
  asksFirst: "Follows your tool rules.",
  check: { status: "ready" },
  skillSnapshotId: "snap-notes",
  state: "waiting_for_approval",
  pendingApprovalId: "approval-step",
};

function uninstalling(piece: CapabilityPluginDetailPiece): CapabilityPluginDetail {
  return {
    pluginId: "meeting-tools",
    name: "Meeting tools",
    description: "Notes and agendas for meetings.",
    version: "1.2.0",
    trust: "unverified",
    sourceDisplay: "github.com/acme/meeting-tools",
    state: "uninstalling",
    pieceCounts: { skill: 1 },
    workspaceId: "ws-plugin",
    sourceKind: "git",
    pin: { kind: "commit", commit: "c".repeat(40) },
    manifestSha256: "a".repeat(64),
    installPlanId: "plan-install",
    installedAt: "2026-10-30T00:00:00.000Z",
    pieces: [piece],
  };
}

describe("uninstallApproval", () => {
  it("titles each skill step's approval by the step the detail names", () => {
    const title = (pendingStep: CapabilityPluginDetailPiece["pendingStep"]) =>
      uninstallApproval(undefined, uninstalling({ ...NOTES, pendingStep }), new Set())?.title;

    expect(title("install_inactive")).toBe("Approve installing Meeting notes?");
    expect(title("activate")).toBe("Approve switching on Meeting notes?");
    expect(title("revoke")).toBe("Approve removing Meeting notes?");
    // A step the detail doesn't name never reads as a removal.
    expect(title(undefined)).toBe("Approve this step for Meeting notes?");
  });

  it("titles the plan's own approval when it waits on no skill step", () => {
    const detail = uninstalling({ ...NOTES, state: "added", pendingApprovalId: undefined });
    const approval = uninstallApproval(
      { phase: "following", workspaceId: "ws-plugin", approvalId: "approval-plan" },
      { ...detail, state: "installed" },
      new Set(),
    );
    expect(approval).toEqual({ approvalId: "approval-plan", title: "Approve uninstalling Meeting tools?" });
  });
});
