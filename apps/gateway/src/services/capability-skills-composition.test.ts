import { describe, expect, it, vi } from "vitest";
import type { ApprovalListResponse, ApprovalRequest, SkillListItem } from "@goatcitadel/contracts";
import type { SkillUseCount } from "@goatcitadel/storage";
import { composeCapabilitySkills, type CapabilitySkillsOwners } from "./capability-skills-composition.js";
import {
  buildSkillLifecycleApprovalBinding,
  buildSkillLifecycleApprovalPayload,
} from "./skill-governance-journey-producer.js";
import type { SkillStateMutationOutcome } from "./skill-state-service.js";

const RESEARCH: SkillListItem = {
  skillId: "bundled:research",
  name: "research",
  description: "Research with citations.",
  source: "bundled",
  dir: "skills/bundled/research",
  declaredTools: [],
  requires: [],
  keywords: [],
  instructionBody: "# Research",
  mtime: "2026-10-01T00:00:00.000Z",
  revision: 1,
  state: "enabled",
  callable: true,
};

function stateApproval(approvalId: string, skillId: string): ApprovalRequest {
  return {
    approvalId,
    kind: "skill.lifecycle",
    riskLevel: "danger",
    status: "pending",
    payload: buildSkillLifecycleApprovalPayload({
      binding: buildSkillLifecycleApprovalBinding({
        subjectKind: "skill",
        subjectId: skillId,
        action: "skill_state_set",
        mutation: { skillId, state: "sleep" },
        expectedState: { skillId, revision: 1 },
      }),
      requesterId: "operator",
      mutation: { skillId, state: "sleep" },
    }),
    preview: {},
    createdAt: "2026-10-28T00:00:00.000Z",
    explanationStatus: "not_requested",
  };
}

const WAITING: SkillStateMutationOutcome = {
  pendingApproval: {
    approvalId: "approval-research",
    status: "pending",
    kind: "skill.lifecycle",
    action: "skill_state_set",
    subjectKind: "skill",
    subjectId: "bundled:research",
    requestSha256: "a".repeat(64),
    expectedStateSha256: "b".repeat(64),
    createdAt: "2026-10-28T00:00:00.000Z",
    replayed: false,
    skillIds: ["bundled:research"],
  },
};

function owners(overrides: Partial<CapabilitySkillsOwners> = {}): CapabilitySkillsOwners {
  return {
    chatTurnCapabilityProfiles: { countSkillUsesSince: vi.fn(async (): Promise<SkillUseCount[]> => []) },
    skills: {
      listSkills: vi.fn(async () => [RESEARCH]),
      setSkillState: vi.fn(async (): Promise<SkillStateMutationOutcome> => WAITING),
    },
    capabilityScope: { resolveEffectiveSkills: vi.fn(async () => "ALL" as const) },
    capabilities: { listCapabilityCatalog: vi.fn(async () => []) },
    approvals: {
      listApprovalsPage: vi.fn(async (): Promise<ApprovalListResponse> => ({ items: [] })),
      getApproval: vi.fn(async () => stateApproval("approval-research", "bundled:research")),
      resolveApproval: vi.fn(async () => ({})),
    },
    audit: { append: vi.fn(async () => undefined) },
    features: { isFeatureEnabled: vi.fn(async () => false) },
    deploymentProfile: () => "trusted_local",
    ...overrides,
  };
}

describe("composeCapabilitySkills", () => {
  it("reads the use counts from the chat turn capability profiles", async () => {
    const countSkillUsesSince = vi.fn(
      async (): Promise<SkillUseCount[]> => [{ skillId: "research", uses: 2, lastUsedAt: "2026-10-20T00:00:00.000Z" }],
    );

    const { usage } = composeCapabilitySkills(owners({ chatTurnCapabilityProfiles: { countSkillUsesSince } }));
    const response = await usage.read({ refresh: false });

    expect(countSkillUsesSince).toHaveBeenCalledTimes(1);
    expect(countSkillUsesSince).toHaveBeenCalledWith(response.since);
    expect(response.skills).toEqual([{ skillId: "research", uses: 2, lastUsedAt: "2026-10-20T00:00:00.000Z" }]);
  });

  it("turns a failure in the profile history into a failed read, never an empty list", async () => {
    // The history query throws on a profile it can't parse; the Gateway's storage hands that back as a rejection.
    const countSkillUsesSince = vi.fn(async (): Promise<SkillUseCount[]> => {
      throw new Error("malformed JSON");
    });

    const { usage } = composeCapabilitySkills(owners({ chatTurnCapabilityProfiles: { countSkillUsesSince } }));

    await expect(usage.read({ refresh: false })).rejects.toThrow("malformed JSON");
    await expect(usage.read({ refresh: false })).rejects.toThrow("malformed JSON");
    expect(countSkillUsesSince).toHaveBeenCalledTimes(2);
  });

  it("also fails the read when the history throws before it returns a promise", async () => {
    const countSkillUsesSince = vi.fn((): Promise<SkillUseCount[]> => {
      throw new Error("malformed JSON");
    });

    const { usage } = composeCapabilitySkills(owners({ chatTurnCapabilityProfiles: { countSkillUsesSince } }));

    await expect(usage.read({ refresh: false })).rejects.toThrow("malformed JSON");
  });

  it("reads the workspace's skills, its choices and the whole inspectable catalog through their owners", async () => {
    const parts = owners();

    const response = await composeCapabilitySkills(parts).skills.list("workspace-a");

    // Every skill whatever the workspace's choices, with that workspace's approved self-authored skills.
    expect(parts.skills.listSkills).toHaveBeenCalledWith("ALL", "workspace-a");
    expect(parts.capabilityScope.resolveEffectiveSkills).toHaveBeenCalledWith("workspace-a");
    // Every skill, hidden ones included, so a hidden skill's details still have their catalog entry.
    expect(parts.capabilities.listCapabilityCatalog).toHaveBeenCalledWith("inspectable", "ALL", "workspace-a");
    expect(parts.features.isFeatureEnabled).toHaveBeenCalledWith("settingsApprovalSkipEnabled");
    expect(response.items.map((item) => item.skillId)).toEqual(["bundled:research"]);
  });

  it("reads every page of waiting approvals, so no skill's wait is cut off", async () => {
    const listApprovalsPage = vi.fn(
      async (input: { cursor?: string }): Promise<ApprovalListResponse> =>
        input.cursor === undefined
          ? { items: [stateApproval("approval-other", "extra:pdf-tools")], nextCursor: "page-2" }
          : { items: [stateApproval("approval-research", "bundled:research")] },
    );

    const response = await composeCapabilitySkills(
      owners({ approvals: { listApprovalsPage, getApproval: vi.fn(), resolveApproval: vi.fn() } }),
    ).skills.list("workspace-a");

    expect(listApprovalsPage.mock.calls.map(([input]) => input)).toEqual([
      { status: "pending", limit: 200 },
      { status: "pending", limit: 200, cursor: "page-2" },
    ]);
    expect(response.items[0]?.pendingApprovalId).toBe("approval-research");
    expect(response.issues).toEqual([]);
  });

  it("says waiting approvals couldn't be read rather than reading a part of an endless list", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const listApprovalsPage = vi.fn(async (): Promise<ApprovalListResponse> => ({ items: [], nextCursor: "more" }));

      const response = await composeCapabilitySkills(
        owners({ approvals: { listApprovalsPage, getApproval: vi.fn(), resolveApproval: vi.fn() } }),
      ).skills.list("workspace-a");

      expect(listApprovalsPage).toHaveBeenCalledTimes(25);
      expect(response.issues).toEqual(["Waiting approvals couldn't be read right now."]);
      const logged = stderr.mock.calls
        .map(([chunk]) => String(chunk))
        .filter((line) => line.includes("a Capabilities skills source could not be read"));
      expect(logged).toHaveLength(1);
      expect(JSON.parse(logged[0] ?? "{}")).toMatchObject({ level: "error", source: "approvals" });
    } finally {
      stderr.mockRestore();
    }
  });

  it("writes a failed read to the server log with secrets redacted, and shows only plain wording", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const resolveEffectiveSkills = vi.fn(async (): Promise<"ALL"> => {
        throw new Error("upstream rejected Authorization: Bearer sk-live-abcdefghijklmnopqrstuvwxyz0123456789");
      });

      const response = await composeCapabilitySkills(
        owners({ capabilityScope: { resolveEffectiveSkills } }),
      ).skills.list("workspace-a");

      const logged = stderr.mock.calls
        .map(([chunk]) => String(chunk))
        .filter((line) => line.includes("a Capabilities skills source could not be read"));
      expect(logged).toHaveLength(1);
      expect(logged[0]).toContain("upstream rejected");
      expect(logged[0]).not.toContain("sk-live-abcdefghijklmnopqrstuvwxyz0123456789");
      expect(JSON.stringify(response)).not.toContain("upstream rejected");
      expect(response.issues).toEqual(["Workspace skill choices couldn't be read right now."]);
    } finally {
      stderr.mockRestore();
    }
  });

  it("never reads the skip setting on a remote_hardened install", async () => {
    const parts = owners({ deploymentProfile: () => "remote_hardened" });

    const response = await composeCapabilitySkills(parts).skills.list("workspace-a");

    expect(response.operatorApprovalSkip).toBe(false);
    expect(parts.features.isFeatureEnabled).not.toHaveBeenCalled();
  });

  it("switches a skill through its owners: the skill state owner asks, the Inbox's resolve approves", async () => {
    const parts = owners({ features: { isFeatureEnabled: vi.fn(async () => true) } });

    const outcome = await composeCapabilitySkills(parts).actions.setState({
      workspaceId: "workspace-a",
      skillId: "bundled:research",
      state: "enabled",
      expectedRevision: 4,
      actorId: "operator-1",
    });

    expect(outcome).toEqual({ status: "approved", approvalId: "approval-research" });
    // No note: the switch has none, and the owner's own approval is the one resolved.
    expect(parts.skills.setSkillState).toHaveBeenCalledExactlyOnceWith("bundled:research", "enabled", undefined, {
      expectedRevision: 4,
      requesterId: "operator-1",
    });
    expect(parts.features.isFeatureEnabled).toHaveBeenCalledWith("settingsApprovalSkipEnabled");
    expect(parts.approvals.resolveApproval).toHaveBeenCalledExactlyOnceWith("approval-research", {
      decision: "approve",
      resolvedBy: "operator-1",
      resolutionNote: "Applied without asking: your setting to skip approvals for your own changes is on.",
    });
    // The approvals audit stream, as the Change Plan skip writes it.
    expect(parts.audit.append).toHaveBeenCalledExactlyOnceWith("approvals", {
      event: "operator_approval_skipped",
      approvalId: "approval-research",
      kind: "skill.lifecycle",
      reason: "setting",
      actorId: "operator-1",
    });
  });

  it("never reads the skip setting for a switch on a remote_hardened install", async () => {
    const parts = owners({ deploymentProfile: () => "remote_hardened" });

    const outcome = await composeCapabilitySkills(parts).actions.setState({
      workspaceId: "workspace-a",
      skillId: "bundled:research",
      state: "disabled",
      expectedRevision: 4,
      actorId: "operator-1",
    });

    expect(outcome).toEqual({ status: "waiting", approvalId: "approval-research" });
    expect(parts.features.isFeatureEnabled).not.toHaveBeenCalled();
    expect(parts.approvals.resolveApproval).not.toHaveBeenCalled();
  });

  it("writes a failed resolve to the server log with secrets redacted", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const resolveApproval = vi.fn(async () => {
        throw new Error("approval store rejected Authorization: Bearer sk-live-abcdefghijklmnopqrstuvwxyz0123456789");
      });
      const parts = owners({
        approvals: {
          listApprovalsPage: vi.fn(async (): Promise<ApprovalListResponse> => ({ items: [] })),
          getApproval: vi.fn(),
          resolveApproval,
        },
      });

      const outcome = await composeCapabilitySkills(parts).actions.setState({
        workspaceId: "workspace-a",
        skillId: "bundled:research",
        state: "disabled",
        expectedRevision: 4,
        actorId: "operator-1",
      });

      expect(outcome).toEqual({ status: "waiting", approvalId: "approval-research" });
      const logged = stderr.mock.calls
        .map(([chunk]) => String(chunk))
        .filter((line) => line.includes("a Capabilities skill switch step failed"));
      expect(logged).toHaveLength(1);
      expect(JSON.parse(logged[0] ?? "{}")).toMatchObject({ level: "error", step: "resolve" });
      expect(logged[0]).toContain("approval store rejected");
      expect(logged[0]).not.toContain("sk-live-abcdefghijklmnopqrstuvwxyz0123456789");
    } finally {
      stderr.mockRestore();
    }
  });

  it("tells who turned an earlier request down by reading the approval through the Inbox's owner", async () => {
    const rejected: ApprovalRequest = {
      ...stateApproval("approval-research", "bundled:research"),
      status: "rejected",
      resolvedBy: "system:approval-expiry",
    };
    const parts = owners({
      skills: {
        listSkills: vi.fn(async () => [RESEARCH]),
        setSkillState: vi.fn(
          async (): Promise<SkillStateMutationOutcome> => ({
            pendingApproval: { ...WAITING.pendingApproval!, status: "rejected", replayed: true },
          }),
        ),
      },
      approvals: {
        listApprovalsPage: vi.fn(async (): Promise<ApprovalListResponse> => ({ items: [] })),
        getApproval: vi.fn(async () => rejected),
        resolveApproval: vi.fn(),
      },
    });

    const outcome = await composeCapabilitySkills(parts).actions.setState({
      workspaceId: "workspace-a",
      skillId: "bundled:research",
      state: "enabled",
      expectedRevision: 4,
      actorId: "operator-1",
    });

    expect(outcome).toEqual({ status: "declined", approvalId: "approval-research", expired: true });
    expect(parts.approvals.getApproval).toHaveBeenCalledExactlyOnceWith("approval-research");
    expect(parts.approvals.resolveApproval).not.toHaveBeenCalled();
    expect(parts.audit.append).not.toHaveBeenCalled();
  });
});
