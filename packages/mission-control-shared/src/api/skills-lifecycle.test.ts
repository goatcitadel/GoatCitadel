import { beforeEach, describe, expect, it, vi } from "vitest";

import * as skills from "./skills";

const apiMocks = vi.hoisted(() => ({
  request: vi.fn(),
  buildGatewayUrl: vi.fn((path: string) => `http://localhost:8787${path}`),
  clearGatewayAuthState: vi.fn(),
  readStoredGatewayAuthState: vi.fn(),
}));

vi.mock("./client-core.js", () => ({
  request: apiMocks.request,
  buildGatewayUrl: apiMocks.buildGatewayUrl,
  clearGatewayAuthState: apiMocks.clearGatewayAuthState,
  readStoredGatewayAuthState: apiMocks.readStoredGatewayAuthState,
}));

const PENDING_APPROVAL: skills.SkillLifecyclePendingApproval = {
  approvalId: "11111111-2222-3333-4444-555555555555",
  status: "pending",
  kind: "skill.lifecycle",
  action: "skill_state_set",
  subjectKind: "skill",
  subjectId: "skill-a",
  requestSha256: "a".repeat(64),
  expectedStateSha256: "b".repeat(64),
  createdAt: "2026-07-23T00:00:00.000Z",
  replayed: false,
  skillIds: ["skill-a"],
};

// HX-402 P2: the operator skill mutation surface is approval-first. These
// tests pin the wire shape of each request AND both response envelopes
// (pending approval vs pure no-op) so UI consumers discriminate honestly.
describe("shared skills lifecycle API", () => {
  beforeEach(() => {
    apiMocks.request.mockReset();
  });

  it("requests a skill state change and surfaces the pending skill.lifecycle approval", async () => {
    apiMocks.request.mockResolvedValue({ pendingApproval: PENDING_APPROVAL });
    const outcome = await skills.updateSkillState("skill-a", {
      expectedRevision: 4,
      state: "disabled",
      note: "Pause",
    });
    const [path, init] = apiMocks.request.mock.calls.at(-1) ?? [];
    expect(path).toBe("/api/v1/skills/by-id/state");
    expect(init).toMatchObject({ method: "PATCH" });
    expect(JSON.parse((init as { body: string }).body)).toEqual({
      expectedRevision: 4,
      state: "disabled",
      note: "Pause",
      skillId: "skill-a",
    });
    expect(outcome.pendingApproval).toMatchObject({
      kind: "skill.lifecycle",
      action: "skill_state_set",
      approvalId: PENDING_APPROVAL.approvalId,
    });
  });

  it("surfaces the no-op envelope when the reviewed state already matches", async () => {
    apiMocks.request.mockResolvedValue({
      pendingApproval: null,
      noMutationRequired: true,
      skillState: { skillId: "skill-a", state: "disabled", revision: 4, updatedAt: "2026-07-23T00:00:00.000Z" },
    });
    const outcome = await skills.updateSkillState("skill-a", { expectedRevision: 4, state: "disabled" });
    expect(outcome.pendingApproval).toBeNull();
    if (outcome.pendingApproval === null) {
      expect(outcome.noMutationRequired).toBe(true);
      expect(outcome.skillState).toMatchObject({ skillId: "skill-a", state: "disabled" });
    }
  });

  it("requests bulk state changes against the bulk-state route with the full revision map", async () => {
    apiMocks.request.mockResolvedValue({ pendingApproval: { ...PENDING_APPROVAL, subjectKind: "skill_batch" } });
    const outcome = await skills.bulkUpdateSkillState({
      skillIds: ["skill-a", "skill-b"],
      expectedRevisionsBySkillId: { "skill-a": 4, "skill-b": 9 },
      state: "disabled",
    });
    const [path, init] = apiMocks.request.mock.calls.at(-1) ?? [];
    expect(path).toBe("/api/v1/skills/bulk-state");
    expect(JSON.parse((init as { body: string }).body)).toMatchObject({
      skillIds: ["skill-a", "skill-b"],
      expectedRevisionsBySkillId: { "skill-a": 4, "skill-b": 9 },
    });
    expect(outcome.pendingApproval?.subjectKind).toBe("skill_batch");
  });

  it("requests activation-policy updates and surfaces the pending approval", async () => {
    apiMocks.request.mockResolvedValue({
      pendingApproval: {
        ...PENDING_APPROVAL,
        action: "activation_policy_updated",
        subjectKind: "skill_activation_policy",
      },
    });
    const outcome = await skills.patchSkillActivationPolicies({ expectedRevision: 2, guardedAutoThreshold: 0.9 });
    const [path, init] = apiMocks.request.mock.calls.at(-1) ?? [];
    expect(path).toBe("/api/v1/skills/activation-policies");
    expect(init).toMatchObject({ method: "PATCH" });
    expect(outcome.pendingApproval?.action).toBe("activation_policy_updated");
  });

  it("returns the governed Skill Hub redirect for the retired install endpoint", async () => {
    const redirect: skills.SkillImportRedirectResult = {
      disposition: "redirected_to_skill_hub",
      validation: { valid: true } as never,
      redirect: {
        owner: "skill_hub",
        reviewRoute: "/api/v1/skills/hub/reviews",
        sourceRef: "https://github.com/example/skill",
        sourceType: "git_url",
        eligible: true,
      },
    };
    apiMocks.request.mockResolvedValue(redirect);
    const outcome = await skills.installSkillImport({ sourceRef: "https://github.com/example/skill" });
    const [path, init] = apiMocks.request.mock.calls.at(-1) ?? [];
    expect(path).toBe("/api/v1/skills/import/install");
    expect(init).toMatchObject({ method: "POST" });
    expect(outcome.disposition).toBe("redirected_to_skill_hub");
    expect(outcome.redirect).toMatchObject({ owner: "skill_hub", eligible: true });
    // The retired surface never claims installed truth.
    expect("installedPath" in outcome).toBe(false);
    expect("installedSkillId" in outcome).toBe(false);
  });
});
