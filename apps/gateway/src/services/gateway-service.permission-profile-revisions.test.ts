import { describe, expect, it, vi } from "vitest";
import type { PermissionProfileSnapshotRecord, PermissionSurface } from "@goatcitadel/contracts";
vi.mock("node:sqlite", () => ({ DatabaseSync: class DatabaseSync {}, StatementSync: class StatementSync {} }));
import { GatewayService } from "./gateway-service.js";

function harness(beforeDefaults: PermissionSurface[], afterDefaults: PermissionSurface[]) {
  const before: PermissionProfileSnapshotRecord = { profileId: "review", label: "Review", builtin: false,
    status: "active", scope: "operator", scopeRef: "operator-1", createdBy: "operator-1",
    approvalMode: "approve_all", toolPatterns: ["session.status"], allow: [], deny: [], defaultForSurfaces: beforeDefaults,
    createdAt: "2026-09-13T00:00:00.000Z", updatedAt: "2026-09-13T00:00:00.000Z", revision: "a".repeat(64) };
  const after = { ...before, label: "Edited label", defaultForSurfaces: afterDefaults, revision: "b".repeat(64) };
  const updateProfile = vi.fn(async () => after);
  const deactivateProfileActivations = vi.fn(async () => 1);
  const activateProfile = vi.fn();
  const activateReviewedProfile = vi.fn(async (input) => ({ ...input, activationId: "reviewed-activation" }));
  const publish = vi.fn();
  const gateway = Object.assign(Object.create(GatewayService.prototype) as GatewayService, {
    storage: { permissionProfiles: { getProfile: vi.fn(async () => before), updateProfileWithDefaults: updateProfile,
      deactivateProfileActivations, activateProfile, activateReviewedProfile },
    gatewaySql: { runImmediateTransaction: async (action: () => Promise<unknown>) => action() } },
    assertPermissionProfileApprovalModeAllowed: vi.fn(),
    publishToolConfigurationRealtimeSafely: publish,
  });
  return { gateway, before, after, updateProfile, deactivateProfileActivations, activateProfile, activateReviewedProfile, publish };
}

describe("permission profile update default-selection effects", () => {
  it.each([
    { before: ["chat"] as PermissionSurface[], after: ["chat"] as PermissionSurface[] },
    { before: ["chat", "tools"] as PermissionSurface[], after: ["tools", "chat"] as PermissionSurface[] },
    { before: [] as PermissionSurface[], after: [] as PermissionSurface[] },
  ])("does not reassert defaults during an ordinary profile edit: $before", async ({ before, after }) => {
    const h = harness(before, after);
    const input = { expectedRevision: h.before.revision, updatedBy: "operator-1", label: "Edited label", defaultForSurfaces: after };
    expect(await h.gateway.updatePermissionProfile("review", input)).toEqual(h.after);
    expect(h.updateProfile).toHaveBeenCalledExactlyOnceWith("review", input);
    expect(h.deactivateProfileActivations).not.toHaveBeenCalled();
    expect(h.activateProfile).not.toHaveBeenCalled();
    expect(h.publish).toHaveBeenCalledOnce();
  });

  it("passes a reviewed default change to its atomic storage owner", async () => {
    const h = harness(["chat"], ["tools"]);
    await h.gateway.updatePermissionProfile("review", {
      expectedRevision: h.before.revision, updatedBy: "operator-1", defaultForSurfaces: ["tools"], expectedSelectionRevision: "c".repeat(64),
    });
    expect(h.updateProfile).toHaveBeenCalledExactlyOnceWith("review", { expectedRevision: h.before.revision,
      updatedBy: "operator-1", defaultForSurfaces: ["tools"], expectedSelectionRevision: "c".repeat(64) });
    expect(h.deactivateProfileActivations).not.toHaveBeenCalled();
    expect(h.activateProfile).not.toHaveBeenCalled();
  });

  it("activates through the reviewed owner without a legacy activation call", async () => {
    const h = harness([], []);
    const input = { profileId: "review", createdBy: "operator-1", surface: "chat" as const,
      expectedProfileRevision: h.before.revision, expectedSelectionRevision: "c".repeat(64) };
    await h.gateway.activatePermissionProfile(input);
    expect(h.activateReviewedProfile).toHaveBeenCalledExactlyOnceWith(input);
    expect(h.activateProfile).not.toHaveBeenCalled();
    expect(h.publish).toHaveBeenCalledOnce();
  });

  it("does not change defaults or publish success after a rejected profile revision", async () => {
    const h = harness(["chat"], ["tools"]);
    h.updateProfile.mockRejectedValue(new Error("Revision conflict"));
    await expect(h.gateway.updatePermissionProfile("review", {
      expectedRevision: h.before.revision, updatedBy: "operator-1", defaultForSurfaces: ["tools"],
    })).rejects.toThrow("Revision conflict");
    expect(h.deactivateProfileActivations).not.toHaveBeenCalled();
    expect(h.activateProfile).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
  });
});
