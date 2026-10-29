import { describe, expect, it, vi } from "vitest";
import {
  APPROVAL_EXPIRY_ACTOR_ID,
  ConflictError,
  type ApprovalRequest,
  type DeploymentProfile,
  type SkillRuntimeState,
} from "@goatcitadel/contracts";
import {
  CapabilitySkillActionsService,
  OPERATOR_SKILL_SKIP_NOTES,
  type CapabilitySkillActionSources,
  type OperatorSkillSkipReason,
} from "./capability-skill-actions-service.js";
import { ApprovalExpiredAfterCommitError } from "./approval-lifecycle-service.js";
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

type ApprovalRead = Pick<ApprovalRequest, "status" | "resolvedBy" | "preview">;

/** The approval as the Inbox reads it. By default it waits, made while the skill was on. */
const approvalRead = (overrides: Partial<ApprovalRead> = {}): ApprovalRead => ({
  status: "pending",
  preview: { title: "Approve skill state change", skillId: SKILL, currentState: "enabled" },
  ...overrides,
});

function sources(overrides: Partial<CapabilitySkillActionSources> = {}) {
  return {
    setSkillState: vi.fn(async (): Promise<SkillStateMutationOutcome> => pending()),
    resolveApproval: vi.fn(async () => ({})),
    readApproval: vi.fn(async (): Promise<ApprovalRead> => approvalRead()),
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

  // Pausing gives power back when the skill is off, since a paused skill can still be used when it is named or matched
  // confidently. The state it is in comes from the approval the owner just made (Ruling R10).
  describe("pausing with the setting off", () => {
    it.each([
      ["on", "approved", "enabled"],
      ["off", "waiting", "disabled"],
    ] as const)("pausing a skill that is %s is %s", async (_label, status, currentState) => {
      const parts = sources({ readApproval: vi.fn(async () => approvalRead({ preview: { currentState } })) });

      const outcome = await new CapabilitySkillActionsService(parts).setState(request("sleep"));

      expect(outcome).toEqual({ status, approvalId: "approval-1" });
      expect(parts.readApproval).toHaveBeenCalledExactlyOnceWith("approval-1");
      if (status === "approved") {
        expect(parts.resolveApproval).toHaveBeenCalledExactlyOnceWith("approval-1", {
          decision: "approve",
          resolvedBy: ACTOR,
          resolutionNote: OPERATOR_SKILL_SKIP_NOTES.tightening,
        });
      } else {
        expect(parts.resolveApproval).not.toHaveBeenCalled();
        expect(parts.appendApprovalAudit).not.toHaveBeenCalled();
      }
    });

    it("waits when the approval doesn't say what state the skill was in", async () => {
      const parts = sources({ readApproval: vi.fn(async () => approvalRead({ preview: {} })) });

      const outcome = await new CapabilitySkillActionsService(parts).setState(request("sleep"));

      expect(outcome).toEqual({ status: "waiting", approvalId: "approval-1" });
      expect(parts.resolveApproval).not.toHaveBeenCalled();
    });

    it("waits, and logs why, when the approval can't be read", async () => {
      const failure = new Error("approval store locked");
      const reportFailure = vi.fn();
      const parts = sources({
        readApproval: vi.fn(async (): Promise<ApprovalRead> => {
          throw failure;
        }),
      });

      const outcome = await new CapabilitySkillActionsService(parts, reportFailure).setState(request("sleep"));

      expect(outcome).toEqual({ status: "waiting", approvalId: "approval-1" });
      expect(reportFailure).toHaveBeenCalledExactlyOnceWith("current_state", failure);
      expect(parts.resolveApproval).not.toHaveBeenCalled();
      expect(parts.appendApprovalAudit).not.toHaveBeenCalled();
    });

    it("never needs the state to turn a skill off", async () => {
      const parts = sources({ readApproval: vi.fn(async () => approvalRead({ preview: { currentState: "sleep" } })) });

      const outcome = await new CapabilitySkillActionsService(parts).setState(request("disabled"));

      expect(outcome).toEqual({ status: "approved", approvalId: "approval-1" });
      expect(parts.readApproval).not.toHaveBeenCalled();
    });

    it("never reads it with the setting on, or on a remote_hardened install", async () => {
      const withSetting = sources({
        readApprovalSkipSetting: vi.fn(async () => true),
        readApproval: vi.fn(async () => approvalRead({ preview: { currentState: "disabled" } })),
      });
      const hardened = sources({ deploymentProfile: vi.fn((): DeploymentProfile => "remote_hardened") });

      // The setting covers pausing an off skill too: with it on, every switch from here applies without asking.
      expect(await new CapabilitySkillActionsService(withSetting).setState(request("sleep"))).toEqual({
        status: "approved",
        approvalId: "approval-1",
      });
      expect(await new CapabilitySkillActionsService(hardened).setState(request("sleep"))).toEqual({
        status: "waiting",
        approvalId: "approval-1",
      });
      expect(withSetting.readApproval).not.toHaveBeenCalled();
      expect(hardened.readApproval).not.toHaveBeenCalled();
    });
  });

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

  it("answers declined and expired when the approval ran out of time as the skip approved it", async () => {
    const reportFailure = vi.fn();
    const parts = sources({
      readApprovalSkipSetting: vi.fn(async () => true),
      // The approval owner committed the expiry check's rejection, then says so.
      resolveApproval: vi.fn(async () => {
        throw new ApprovalExpiredAfterCommitError("approval-1");
      }),
    });

    const outcome = await new CapabilitySkillActionsService(parts, reportFailure).setState(request("enabled"));

    expect(outcome).toEqual({ status: "declined", approvalId: "approval-1", expired: true });
    expect(parts.appendApprovalAudit).not.toHaveBeenCalled();
    expect(reportFailure).not.toHaveBeenCalled();
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

  // The owner's approval ids follow from the request, so asking again for the same change hands back the approval it
  // already made. A decided one is never resolved again, and no second skip is recorded.
  describe("when the same request was already decided", () => {
    it("answers declined for a replayed rejected approval", async () => {
      const parts = sources({
        setSkillState: vi.fn(async (): Promise<SkillStateMutationOutcome> => pending("rejected")),
        readApproval: vi.fn(async () => approvalRead({ status: "rejected", resolvedBy: ACTOR })),
        readApprovalSkipSetting: vi.fn(async () => true),
      });

      const outcome = await new CapabilitySkillActionsService(parts).setState(request("enabled"));

      expect(outcome).toEqual({ status: "declined", approvalId: "approval-1", expired: false });
      expect(parts.readApproval).toHaveBeenCalledExactlyOnceWith("approval-1");
      expect(parts.readApprovalSkipSetting).not.toHaveBeenCalled();
      expect(parts.resolveApproval).not.toHaveBeenCalled();
      expect(parts.appendApprovalAudit).not.toHaveBeenCalled();
    });

    it("answers declined and expired for a replayed approval the expiry check rejected", async () => {
      const parts = sources({
        setSkillState: vi.fn(async (): Promise<SkillStateMutationOutcome> => pending("rejected")),
        readApproval: vi.fn(async () => approvalRead({ status: "rejected", resolvedBy: APPROVAL_EXPIRY_ACTOR_ID })),
      });

      const outcome = await new CapabilitySkillActionsService(parts).setState(request("disabled"));

      // Switching off would skip as tightening, but this request skipped nothing.
      expect(outcome).toEqual({ status: "declined", approvalId: "approval-1", expired: true });
      expect(parts.resolveApproval).not.toHaveBeenCalled();
      expect(parts.appendApprovalAudit).not.toHaveBeenCalled();
    });

    it("answers approved for a replayed approved approval, with no second audit line", async () => {
      const parts = sources({
        setSkillState: vi.fn(async (): Promise<SkillStateMutationOutcome> => pending("approved")),
        readApprovalSkipSetting: vi.fn(async () => true),
      });

      const outcome = await new CapabilitySkillActionsService(parts).setState(request("enabled"));

      expect(outcome).toEqual({ status: "approved", approvalId: "approval-1" });
      expect(parts.resolveApproval).not.toHaveBeenCalled();
      expect(parts.appendApprovalAudit).not.toHaveBeenCalled();
      expect(parts.readApproval).not.toHaveBeenCalled();
    });

    it("answers declined for a replayed edited approval, which never applies", async () => {
      // An edit withdraws a skill approval: its effect runs only on approve, so the change never happens.
      const parts = sources({
        setSkillState: vi.fn(async (): Promise<SkillStateMutationOutcome> => pending("edited")),
        readApprovalSkipSetting: vi.fn(async () => true),
      });

      const outcome = await new CapabilitySkillActionsService(parts).setState(request("enabled"));

      expect(outcome).toEqual({ status: "declined", approvalId: "approval-1", expired: false });
      expect(parts.resolveApproval).not.toHaveBeenCalled();
      expect(parts.appendApprovalAudit).not.toHaveBeenCalled();
    });

    it("fails the request rather than guess when a rejected approval can't be read", async () => {
      const failure = new Error("approval store locked");
      const parts = sources({
        setSkillState: vi.fn(async (): Promise<SkillStateMutationOutcome> => pending("rejected")),
        readApproval: vi.fn(async (): Promise<ApprovalRead> => {
          throw failure;
        }),
      });

      await expect(new CapabilitySkillActionsService(parts).setState(request("enabled"))).rejects.toBe(failure);
      expect(parts.resolveApproval).not.toHaveBeenCalled();
    });
  });
});
