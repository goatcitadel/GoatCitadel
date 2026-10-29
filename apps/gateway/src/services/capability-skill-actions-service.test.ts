import { describe, expect, it, vi } from "vitest";
import { ConflictError, type DeploymentProfile, type SkillRuntimeState } from "@goatcitadel/contracts";
import {
  CapabilitySkillActionsService,
  OPERATOR_SKILL_SKIP_NOTES,
  type CapabilitySkillActionSources,
  type OperatorSkillSkipReason,
} from "./capability-skill-actions-service.js";
import type { SkillLifecyclePendingApproval, SkillStateMutationOutcome } from "./skill-state-service.js";

const ACTOR = "operator-1";
const SKILL = "bundled:research";

function pending(status: SkillLifecyclePendingApproval["status"] = "pending"): SkillStateMutationOutcome {
  return {
    pendingApproval: {
      approvalId: "approval-1",
      status,
      kind: "skill.lifecycle",
      action: "skill_state_set",
      subjectKind: "skill",
      subjectId: SKILL,
      requestSha256: "a".repeat(64),
      expectedStateSha256: "b".repeat(64),
      createdAt: "2026-10-28T00:00:00.000Z",
      replayed: status !== "pending",
      skillIds: [SKILL],
    },
  };
}

function sources(overrides: Partial<CapabilitySkillActionSources> = {}) {
  return {
    setSkillState: vi.fn(async (): Promise<SkillStateMutationOutcome> => pending()),
    resolveApproval: vi.fn(async () => ({})),
    appendApprovalAudit: vi.fn(async () => undefined),
    deploymentProfile: vi.fn((): DeploymentProfile => "trusted_local"),
    readApprovalSkipSetting: vi.fn(async () => false),
    ...overrides,
  } satisfies CapabilitySkillActionSources;
}

const request = (state: SkillRuntimeState) => ({
  workspaceId: "default",
  skillId: SKILL,
  state,
  expectedRevision: 3,
  actorId: ACTOR,
});

describe("CapabilitySkillActionsService", () => {
  it.each([
    ["remote_hardened", "on", "enabled", "waiting", undefined],
    ["remote_hardened", "on", "disabled", "waiting", undefined],
    ["remote_hardened", "off", "sleep", "waiting", undefined],
    ["trusted_local", "on", "enabled", "approved", "setting"],
    ["trusted_local", "on", "disabled", "approved", "setting"],
    ["local_dev", "on", "sleep", "approved", "setting"],
    ["trusted_local", "off", "disabled", "approved", "tightening"],
    ["local_dev", "off", "sleep", "approved", "tightening"],
    ["trusted_local", "off", "enabled", "waiting", undefined],
    ["local_dev", "off", "enabled", "waiting", undefined],
  ] as const)(
    "%s with the setting %s, switching to %s, is %s",
    async (profile, setting, state, status, reason: OperatorSkillSkipReason | undefined) => {
      const parts = sources({
        deploymentProfile: vi.fn((): DeploymentProfile => profile),
        readApprovalSkipSetting: vi.fn(async () => setting === "on"),
      });

      const outcome = await new CapabilitySkillActionsService(parts).setState(request(state));

      expect(outcome).toEqual({ status, approvalId: "approval-1" });
      // The owner is always asked first, with the operator as the requester and no note.
      expect(parts.setSkillState).toHaveBeenCalledWith(SKILL, state, { expectedRevision: 3, requesterId: ACTOR });
      if (reason) {
        expect(parts.resolveApproval).toHaveBeenCalledExactlyOnceWith("approval-1", {
          decision: "approve",
          resolvedBy: ACTOR,
          resolutionNote: OPERATOR_SKILL_SKIP_NOTES[reason],
        });
      } else {
        expect(parts.resolveApproval).not.toHaveBeenCalled();
        expect(parts.appendApprovalAudit).not.toHaveBeenCalled();
      }
      // remote_hardened always asks, so its setting is never even read.
      expect(parts.readApprovalSkipSetting).toHaveBeenCalledTimes(profile === "remote_hardened" ? 0 : 1);
    },
  );

  it("returns unchanged when the skill is already in that state", async () => {
    const parts = sources({
      setSkillState: vi.fn(
        async (): Promise<SkillStateMutationOutcome> => ({
          pendingApproval: null,
          noMutationRequired: true,
          skillState: { skillId: SKILL, state: "disabled", revision: 3, updatedAt: "2026-10-28T00:00:00.000Z" },
        }),
      ),
      readApprovalSkipSetting: vi.fn(async () => true),
    });

    const outcome = await new CapabilitySkillActionsService(parts).setState(request("disabled"));

    expect(outcome).toEqual({ status: "unchanged" });
    expect(parts.readApprovalSkipSetting).not.toHaveBeenCalled();
    expect(parts.resolveApproval).not.toHaveBeenCalled();
    expect(parts.appendApprovalAudit).not.toHaveBeenCalled();
  });

  it("passes the owner's refusal through unchanged and resolves nothing", async () => {
    const refusal = new ConflictError({
      code: "WRITE_CONFLICT",
      message: "runtime_skill bundled:research changed since revision 3",
    });
    const parts = sources({
      setSkillState: vi.fn(async (): Promise<SkillStateMutationOutcome> => {
        throw refusal;
      }),
      readApprovalSkipSetting: vi.fn(async () => true),
    });

    await expect(new CapabilitySkillActionsService(parts).setState(request("enabled"))).rejects.toBe(refusal);
    expect(parts.resolveApproval).not.toHaveBeenCalled();
    expect(parts.appendApprovalAudit).not.toHaveBeenCalled();
  });

  it("keeps waiting when resolving fails", async () => {
    const failure = new Error("Approval approval-1 is already resolved");
    const reportFailure = vi.fn();
    const parts = sources({
      readApprovalSkipSetting: vi.fn(async () => true),
      resolveApproval: vi.fn(async () => {
        throw failure;
      }),
    });

    const outcome = await new CapabilitySkillActionsService(parts, reportFailure).setState(request("enabled"));

    // The approval is still in the Inbox for the operator; the real error goes to the server log.
    expect(outcome).toEqual({ status: "waiting", approvalId: "approval-1" });
    expect(reportFailure).toHaveBeenCalledExactlyOnceWith("resolve", failure);
    expect(parts.appendApprovalAudit).not.toHaveBeenCalled();
  });

  it("records operator_approval_skipped with the reason", async () => {
    const parts = sources();

    await new CapabilitySkillActionsService(parts).setState(request("sleep"));

    expect(parts.appendApprovalAudit).toHaveBeenCalledExactlyOnceWith("operator_approval_skipped", {
      approvalId: "approval-1",
      kind: "skill.lifecycle",
      reason: "tightening",
      actorId: ACTOR,
    });
    // The audit line follows the approval it describes.
    expect(parts.resolveApproval.mock.invocationCallOrder[0]).toBeLessThan(
      parts.appendApprovalAudit.mock.invocationCallOrder[0]!,
    );
  });

  it("still reports the change approved when the audit line can't be written", async () => {
    const failure = new Error("disk full");
    const reportFailure = vi.fn();
    const parts = sources({
      appendApprovalAudit: vi.fn(async () => {
        throw failure;
      }),
    });

    const outcome = await new CapabilitySkillActionsService(parts, reportFailure).setState(request("disabled"));

    // The approval itself records who approved it and why; the audit line is a second record.
    expect(outcome).toEqual({ status: "approved", approvalId: "approval-1" });
    expect(reportFailure).toHaveBeenCalledExactlyOnceWith("audit", failure);
  });

  it("counts a setting it can't read as off", async () => {
    const failure = new Error("settings store locked");
    const reportFailure = vi.fn();
    const unreadable = vi.fn(async (): Promise<boolean> => {
      throw failure;
    });
    const service = new CapabilitySkillActionsService(sources({ readApprovalSkipSetting: unreadable }), reportFailure);

    expect(await service.setState(request("enabled"))).toEqual({ status: "waiting", approvalId: "approval-1" });
    // Switching off only takes power away, so it applies whatever the setting says.
    expect(await service.setState(request("disabled"))).toEqual({ status: "approved", approvalId: "approval-1" });
    expect(reportFailure).toHaveBeenCalledWith("approval_skip", failure);
  });

  it.each(["approved", "rejected", "edited"] as const)(
    "leaves an approval that is already %s as it is",
    async (status) => {
      const parts = sources({
        setSkillState: vi.fn(async (): Promise<SkillStateMutationOutcome> => pending(status)),
        readApprovalSkipSetting: vi.fn(async () => true),
      });

      const outcome = await new CapabilitySkillActionsService(parts).setState(request("enabled"));

      expect(outcome).toEqual({ status: "waiting", approvalId: "approval-1" });
      expect(parts.resolveApproval).not.toHaveBeenCalled();
    },
  );
});
