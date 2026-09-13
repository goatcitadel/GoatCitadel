import { describe, expect, it, vi } from "vitest";
import type { CandidateSkillDetailRecord, ChangePlanRecord, ChangePlanRequest } from "@goatcitadel/contracts";
import { compensatePack, type PackCompensationDependencies } from "./capability-pack-compensation.js";
import { resolvePackAssetBinding } from "./capability-pack-bindings.js";
import { packCandidateIds } from "./capability-pack-candidate-service.js";

function fixture() {
  const binding = resolvePackAssetBinding("browser-qa-operator", { id: "browser-qa-operator", kind: "skill" })!;
  const ids = packCandidateIds("workspace", "browser-qa-operator", binding);
  const asset = { id: "browser-qa-operator", binding };
  const parent = {
    planId: "parent",
    origin: { workspaceId: "workspace" },
    request: { kind: "capability_pack", packId: "browser-qa-operator" },
    evidenceRefs: [],
    rollbackRefs: ["pack_compensate_candidate:browser-qa-operator"],
  } as unknown as ChangePlanRecord;
  const original = {
    planId: "original",
    status: "completed",
    approvalRefs: ["original-approval"],
    evidenceRefs: [`capability_candidate:${ids.candidateId}:revision:4`],
  } as unknown as ChangePlanRecord;
  const children = new Map<string, ChangePlanRecord>([["pack:parent:browser-qa-operator", original]]);
  const detail = { revision: 4, activeVersion: { versionId: ids.versionId } } as CandidateSkillDetailRecord;
  const getCandidateDetail = vi.fn(async () => detail);
  const createChild = vi.fn(async (_plan: ChangePlanRecord, request: ChangePlanRequest, key: string) => {
    const child = {
      planId: "reversal",
      status: "awaiting_confirmation",
      target: { expectedRevision: 4 },
      request,
    } as ChangePlanRecord;
    children.set(key, child);
    return child;
  });
  const cancelChild = vi.fn(async (_parent: ChangePlanRecord, child: ChangePlanRecord) => ({
    ...child,
    status: "cancelled" as const,
  }));
  const deps = {
    storage: { changePlans: { findByIdempotency: async (_workspace: string, key: string) => children.get(key) } },
    readMcpServers: async () => [],
    readSettingsSnapshot: async () => ({ revision: 1, features: {} }),
    getCandidateDetail,
    createChild,
    cancelChild,
    compensateMcp: vi.fn(),
  } as unknown as PackCompensationDependencies;
  return { asset, ids, parent, original, detail, children, deps, createChild, cancelChild, getCandidateDetail };
}

describe("pack child compensation authority", () => {
  it("prepares an exact revoke review and observes it without replaying or granting approval", async () => {
    const f = fixture();
    const result = await compensatePack(f.deps, f.parent, [f.asset], true);
    expect(result.status).toBe("monitoring");
    expect(f.createChild).toHaveBeenCalledWith(
      f.parent,
      {
        kind: "capability_candidate",
        action: "revoke",
        proposalId: f.ids.proposalId,
        versionId: f.ids.versionId,
      },
      "pack:parent:compensate:browser-qa-operator",
    );
    expect(f.detail.activeVersion?.versionId).toBe(f.ids.versionId);
    expect((await compensatePack(f.deps, f.parent, [f.asset], false)).status).toBe("monitoring");
    expect(f.createChild).toHaveBeenCalledTimes(1);
    const reversal = f.children.get("pack:parent:compensate:browser-qa-operator")!;
    f.children.set("pack:parent:compensate:browser-qa-operator", { ...reversal, status: "completed" });
    expect((await compensatePack(f.deps, f.parent, [f.asset], false)).status).toBe("rolled_back");
    expect(f.cancelChild).not.toHaveBeenCalled();
  });

  it.each(["new_revision", "new_active_version", "missing_revision", "preexisting_skill"])(
    "preserves a skill when ownership cannot be proven: %s",
    async (condition) => {
      const f = fixture();
      if (condition === "new_revision") f.getCandidateDetail.mockResolvedValue({ ...f.detail, revision: 5 });
      if (condition === "new_active_version")
        f.getCandidateDetail.mockResolvedValue({
          ...f.detail,
          activeVersion: { ...f.detail.activeVersion!, versionId: "later-version" },
        });
      if (condition === "missing_revision")
        f.children.set("pack:parent:browser-qa-operator", { ...f.original, evidenceRefs: [] });
      if (condition === "preexisting_skill") f.parent = { ...f.parent, rollbackRefs: [] };
      expect((await compensatePack(f.deps, f.parent, [f.asset], true)).status).toBe("manual_required");
      expect(f.createChild).not.toHaveBeenCalled();
      expect(f.cancelChild).not.toHaveBeenCalled();
    },
  );

  it("cancels a stale prepared reversal if the owner changes during preparation", async () => {
    const f = fixture();
    f.createChild.mockResolvedValue({
      planId: "stale-reversal",
      target: { expectedRevision: 5 },
      status: "awaiting_confirmation",
    } as ChangePlanRecord);
    expect((await compensatePack(f.deps, f.parent, [f.asset], true)).status).toBe("manual_required");
    expect(f.cancelChild.mock.calls[0]?.[1].planId).toBe("stale-reversal");
  });

  it("does not cancel a child whose approval already has its own owner", async () => {
    const f = fixture();
    f.children.set("pack:parent:browser-qa-operator", { ...f.original, status: "awaiting_approval" });
    expect((await compensatePack(f.deps, f.parent, [f.asset], true)).status).toBe("manual_required");
    expect(f.cancelChild).not.toHaveBeenCalled();
    expect(f.createChild).not.toHaveBeenCalled();
  });

  it("cancels only an unapproved pre-effect review, and never during reconciliation", async () => {
    const f = fixture();
    f.children.set("pack:parent:browser-qa-operator", {
      ...f.original,
      status: "awaiting_confirmation",
      approvalRefs: [],
    });
    expect((await compensatePack(f.deps, f.parent, [f.asset], false)).status).toBe("manual_required");
    expect(f.cancelChild).not.toHaveBeenCalled();
    expect((await compensatePack(f.deps, f.parent, [f.asset], true)).status).toBe("rolled_back");
    expect(f.cancelChild).toHaveBeenCalledTimes(1);
    expect(f.createChild).not.toHaveBeenCalled();
  });
});
