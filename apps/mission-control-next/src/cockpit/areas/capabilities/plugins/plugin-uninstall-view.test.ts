import type { CapabilityPluginDetail, CapabilityPluginDetailPiece } from "@goatcitadel/contracts";
import { describe, expect, it } from "vitest";
import { uninstallApproval, uninstallConfirmLines } from "./plugin-uninstall-view";

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

describe("uninstallConfirmLines", () => {
  const PLAYWRIGHT: CapabilityPluginDetailPiece = {
    pieceId: "browser",
    kind: "connector",
    label: "Playwright Browser",
    asksFirst: "Changes ask first in Chat.",
    check: { status: "ready" },
    hosts: ["registry.npmjs.org"],
    state: "added",
  };
  const QA: CapabilityPluginDetailPiece = { ...NOTES, pieceId: "browser-qa", label: "browser-qa", state: "added" };

  it("says the hosts its connector allowed stay, by name", () => {
    expect(uninstallConfirmLines([PLAYWRIGHT, QA])).toEqual([
      "Removes: Playwright Browser and browser-qa",
      "Stays: the hosts it allowed (registry.npmjs.org)",
    ]);
  });

  it("names each host once, after what was already there", () => {
    const hook: CapabilityPluginDetailPiece = {
      pieceId: "watch",
      kind: "hook",
      label: "After a tool call",
      asksFirst: "Sends event details.",
      check: { status: "ready" },
      hosts: ["hooks.example.com", "registry.npmjs.org"],
      state: "added",
    };
    const git: CapabilityPluginDetailPiece = {
      pieceId: "no-git",
      kind: "tool_group_off",
      label: "Git",
      asksFirst: "Already off.",
      check: { status: "already_there" },
      state: "kept",
    };
    expect(uninstallConfirmLines([PLAYWRIGHT, hook, git])).toEqual([
      "Removes: Playwright Browser and After a tool call",
      "Stays: Git, and the hosts it allowed (registry.npmjs.org and hooks.example.com)",
    ]);
  });

  it("has no Stays line when nothing stays", () => {
    expect(uninstallConfirmLines([{ ...PLAYWRIGHT, hosts: undefined }, QA])).toEqual([
      "Removes: Playwright Browser and browser-qa",
    ]);
  });
});

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
