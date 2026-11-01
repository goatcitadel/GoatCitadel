import { describe, expect, it, vi } from "vitest";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  type ApprovalRequest,
  type CapabilitySkillOperationRequest,
  type CapabilitySkillReviewRequest,
  type DeploymentProfile,
  type SkillRuntimeState,
} from "@goatcitadel/contracts";
import {
  CapabilitySkillActionsService,
  CapabilitySkillSourceRefusedError,
  OPERATOR_SKILL_SKIP_NOTES,
  type CapabilitySkillActionSources,
  type OperatorSkillSkipReason,
} from "./capability-skill-actions-service.js";
import { ApprovalExpiredAfterCommitError } from "./approval-lifecycle-service.js";
import { hubApproval, hubItem } from "./capability-skill-install.test-support.js";
import type { SkillHubOperatorApprovalSummary } from "./skill-hub-operator-service.js";
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

type ApprovalRead = Pick<ApprovalRequest, "preview" | "status">;

/** The approval as the Inbox reads it. By default it was made while the skill was on. */
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
    reviewSkillHubSource: vi.fn(async () => ({ snapshot: { snapshotId: "skill-hub-review-1" }, replayed: false })),
    listSkillHub: vi.fn(async () => ({ items: [hubItem()] })),
    createSkillHubApproval: vi.fn(async () => ({ approval: hubApproval("install_inactive", "pending") })),
    // An ordinary check: not one a plugin brought, so no plugin record is read.
    findSkillHubSnapshot: vi.fn(async () => ({
      sourceProvider: "local",
      sourceRef: "skills/import-packs/himalaya",
      workspaceId: "default",
    })),
    listPluginRecords: vi.fn(async () => []),
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
  // already made while it waits or once it is approved; after a decline the owner makes a fresh one instead.
  describe("when the same request was already approved", () => {
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
      expect(parts.readApprovalSkipSetting).not.toHaveBeenCalled();
    });
  });
});

const review = (source: CapabilitySkillReviewRequest["source"]) => ({
  workspaceId: "default",
  source,
  idempotencyKey: "check-1",
  actorId: ACTOR,
});

describe("CapabilitySkillActionsService.checkSource", () => {
  it("checks a shipped pack the way the pack review does, and reads where it stands", async () => {
    const parts = sources();

    const checked = await new CapabilitySkillActionsService(parts).checkSource(
      review({ kind: "pack", packId: "himalaya" }),
    );

    expect(parts.reviewSkillHubSource).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "default",
      packId: "himalaya",
      idempotencyKey: "check-1",
      actorId: ACTOR,
    });
    expect(parts.listSkillHub).toHaveBeenCalledExactlyOnceWith({ workspaceId: "default", limit: 100 });
    expect(checked).toEqual({
      replayed: false,
      install: expect.objectContaining({
        snapshotId: "skill-hub-review-1",
        step: "check_passed",
        source: { kind: "pack", packId: "himalaya" },
      }),
    });
    // A check asks for nothing and approves nothing.
    expect(parts.createSkillHubApproval).not.toHaveBeenCalled();
    expect(parts.resolveApproval).not.toHaveBeenCalled();
  });

  it.each([
    "https://github.com/example/notes",
    "https://GitLab.com/example/notes",
    // An address ending in /skill.md would otherwise be read as a hosted bundle, which skips the trusted-host check.
    "https://codeberg.org/example/notes/raw/branch/main/skill.md",
  ])("reviews a Git address as git_url even when it ends in /skill.md: %s", async (sourceRef) => {
    const parts = sources({
      listSkillHub: vi.fn(async () => ({
        items: [hubItem({ snapshot: { sourceType: "git_url", sourceRef } })],
      })),
    });

    await new CapabilitySkillActionsService(parts).checkSource(review({ kind: "git", sourceRef }));

    expect(parts.reviewSkillHubSource).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "default",
      sourceRef,
      sourceType: "git_url",
      idempotencyKey: "check-1",
      actorId: ACTOR,
    });
  });

  it.each([
    "https://example.com/team/notes",
    "https://www.github.com/example/notes",
    "https://github.com:8443/example/notes",
    "http://github.com/example/notes",
    "ssh://git@github.com/example/notes",
    "git@github.com:example/notes.git",
    "github.com/example/notes",
  ])("refuses a Git host outside the trusted forges before reviewing: %s", async (sourceRef) => {
    const parts = sources();

    const refusal = await new CapabilitySkillActionsService(parts)
      .checkSource(review({ kind: "git", sourceRef }))
      .catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(CapabilitySkillSourceRefusedError);
    expect(refusal).toMatchObject({
      reason: "UNTRUSTED_GIT_HOST",
      message: "GoatCitadel installs skills only from GitHub, GitLab, Bitbucket or Codeberg.",
    });
    expect(parts.reviewSkillHubSource).not.toHaveBeenCalled();
  });

  it.each([
    ["UNKNOWN_FRONTMATTER_DIMENSION", "UNKNOWN_FRONTMATTER_DIMENSION"],
    ["BUNDLE_MANIFEST_INVALID", "BUNDLE_MANIFEST_INVALID"],
    ["PROMPT_INJECTION_DETECTED", "PROMPT_INJECTION_DETECTED"],
    // The source itself: unsafe, unreadable or not allowed, all reported on the field they came in.
    ["sourceRef", "SOURCE_REFUSED"],
    ["packId", "SOURCE_REFUSED"],
  ])("keeps the review's reason code on a rejected source (%s)", async (field, reason) => {
    const rejection = new ValidationError({ field, message: "Skill Hub review refused it." });
    const parts = sources({
      reviewSkillHubSource: vi.fn(async (): Promise<never> => {
        throw rejection;
      }),
    });

    const refusal = await new CapabilitySkillActionsService(parts)
      .checkSource(review({ kind: "pack", packId: "himalaya" }))
      .catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(CapabilitySkillSourceRefusedError);
    expect(refusal).toMatchObject({ reason, cause: rejection });
    // Plain words only: never the owner's message, which names Skill Hub.
    expect((refusal as Error).message).not.toContain("Skill Hub");
    expect(parts.listSkillHub).not.toHaveBeenCalled();
  });

  it("passes anything else the review throws through unchanged", async () => {
    const conflict = new ConflictError({ code: "WRITE_CONFLICT", message: "key bound to other material" });
    const parts = sources({
      reviewSkillHubSource: vi.fn(async (): Promise<never> => {
        throw conflict;
      }),
    });

    await expect(
      new CapabilitySkillActionsService(parts).checkSource(review({ kind: "pack", packId: "himalaya" })),
    ).rejects.toBe(conflict);
  });

  it("answers plainly when the new check can't be read back", async () => {
    const parts = sources({ listSkillHub: vi.fn(async () => ({ items: [] })) });

    await expect(
      new CapabilitySkillActionsService(parts).checkSource(review({ kind: "pack", packId: "himalaya" })),
    ).rejects.toMatchObject({ httpStatus: 503, message: "This skill's check can't be read right now." });
  });
});

const step = (operationKind: CapabilitySkillOperationRequest["operationKind"]) => ({
  workspaceId: "default",
  snapshotId: "skill-hub-review-1",
  operationKind,
  actorId: ACTOR,
});

describe("CapabilitySkillActionsService.requestStep", () => {
  it.each([
    ["trusted_local", "on", "approved"],
    ["local_dev", "on", "approved"],
    ["trusted_local", "off", "waiting"],
    ["remote_hardened", "on", "waiting"],
    ["remote_hardened", "off", "waiting"],
  ] as const)("%s with the setting %s is %s", async (profile, setting, status) => {
    const parts = sources({
      deploymentProfile: vi.fn((): DeploymentProfile => profile),
      readApprovalSkipSetting: vi.fn(async () => setting === "on"),
    });

    const outcome = await new CapabilitySkillActionsService(parts).requestStep(step("install_inactive"));

    expect(outcome).toEqual({ status, approvalId: "approval-install_inactive" });
    // The Hub's own approval owner is always asked first, with the operator as the requester.
    expect(parts.createSkillHubApproval).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "default",
      snapshotId: "skill-hub-review-1",
      operationKind: "install_inactive",
      actorId: ACTOR,
    });
    if (status === "approved") {
      expect(parts.resolveApproval).toHaveBeenCalledExactlyOnceWith("approval-install_inactive", {
        decision: "approve",
        resolvedBy: ACTOR,
        resolutionNote: OPERATOR_SKILL_SKIP_NOTES.setting,
      });
      expect(parts.appendApprovalAudit).toHaveBeenCalledExactlyOnceWith("operator_approval_skipped", {
        approvalId: "approval-install_inactive",
        kind: "skill_hub.lifecycle",
        reason: "setting",
        actorId: ACTOR,
      });
    } else {
      expect(parts.resolveApproval).not.toHaveBeenCalled();
      expect(parts.appendApprovalAudit).not.toHaveBeenCalled();
    }
    // remote_hardened always asks, so its setting is never even read.
    expect(parts.readApprovalSkipSetting).toHaveBeenCalledTimes(profile === "remote_hardened" ? 0 : 1);
  });

  it("always asks under remote_hardened, for either step", async () => {
    for (const operationKind of ["install_inactive", "activate"] as const) {
      const parts = sources({
        deploymentProfile: vi.fn((): DeploymentProfile => "remote_hardened"),
        readApprovalSkipSetting: vi.fn(async () => true),
        createSkillHubApproval: vi.fn(async () => ({ approval: hubApproval(operationKind, "pending") })),
      });

      const outcome = await new CapabilitySkillActionsService(parts).requestStep(step(operationKind));

      expect(outcome).toEqual({ status: "waiting", approvalId: `approval-${operationKind}` });
      expect(parts.resolveApproval).not.toHaveBeenCalled();
      expect(parts.readApprovalSkipSetting).not.toHaveBeenCalled();
    }
  });

  it("answers approved for an approval the owner already approved, with no second skip", async () => {
    const parts = sources({
      readApprovalSkipSetting: vi.fn(async () => true),
      createSkillHubApproval: vi.fn(async () => ({ approval: hubApproval("activate", "approved") })),
    });

    const outcome = await new CapabilitySkillActionsService(parts).requestStep(step("activate"));

    expect(outcome).toEqual({ status: "approved", approvalId: "approval-activate" });
    expect(parts.resolveApproval).not.toHaveBeenCalled();
    expect(parts.appendApprovalAudit).not.toHaveBeenCalled();
    expect(parts.readApprovalSkipSetting).not.toHaveBeenCalled();
  });

  it("keeps waiting, and logs why, when resolving fails", async () => {
    const failure = new Error("approval store locked");
    const reportFailure = vi.fn();
    const parts = sources({
      readApprovalSkipSetting: vi.fn(async () => true),
      resolveApproval: vi.fn(async () => {
        throw failure;
      }),
    });

    const outcome = await new CapabilitySkillActionsService(parts, reportFailure).requestStep(step("install_inactive"));

    expect(outcome).toEqual({ status: "waiting", approvalId: "approval-install_inactive" });
    expect(reportFailure).toHaveBeenCalledExactlyOnceWith("resolve", failure);
    expect(parts.appendApprovalAudit).not.toHaveBeenCalled();
  });

  it("passes the owner's guard refusal through, with its blockers, and resolves nothing", async () => {
    const refusal = new ConflictError({
      code: "STATE_CONFLICT",
      message: "Skill Hub install_inactive is blocked: SOURCE_ALREADY_INSTALLED.",
      details: { blockers: ["SOURCE_ALREADY_INSTALLED"], snapshotId: "skill-hub-review-1" },
    });
    const parts = sources({
      readApprovalSkipSetting: vi.fn(async () => true),
      createSkillHubApproval: vi.fn(async (): Promise<{ approval: SkillHubOperatorApprovalSummary }> => {
        throw refusal;
      }),
    });

    await expect(new CapabilitySkillActionsService(parts).requestStep(step("install_inactive"))).rejects.toBe(refusal);
    expect(parts.resolveApproval).not.toHaveBeenCalled();
    expect(parts.appendApprovalAudit).not.toHaveBeenCalled();
  });
});

describe("CapabilitySkillActionsService.revokeForPluginUninstall", () => {
  const revoke = { workspaceId: "default", snapshotId: "plugin-check-1", pluginId: "meeting-tools", actorId: ACTOR };
  const revokeSources = (overrides: Partial<CapabilitySkillActionSources> = {}) =>
    sources({
      createSkillHubApproval: vi.fn(async () => ({ approval: hubApproval("revoke", "pending") })),
      ...overrides,
    });

  it.each(["trusted_local", "local_dev"] as const)(
    "revokes a plugin's skill on %s without asking, as the operator, whatever the setting says",
    async (profile) => {
      const parts = revokeSources({ deploymentProfile: vi.fn((): DeploymentProfile => profile) });

      const outcome = await new CapabilitySkillActionsService(parts).revokeForPluginUninstall(revoke);

      expect(outcome).toEqual({ status: "approved", approvalId: "approval-revoke" });
      // Skill Hub's own approval owner is asked for the revoke, with the plugin's pass and the operator as requester.
      expect(parts.createSkillHubApproval).toHaveBeenCalledExactlyOnceWith(
        { workspaceId: "default", snapshotId: "plugin-check-1", operationKind: "revoke", actorId: ACTOR },
        { pluginPass: { pluginId: "meeting-tools" } },
      );
      expect(parts.resolveApproval).toHaveBeenCalledExactlyOnceWith("approval-revoke", {
        decision: "approve",
        resolvedBy: ACTOR,
        resolutionNote: OPERATOR_SKILL_SKIP_NOTES.plugin_uninstall,
      });
      expect(parts.appendApprovalAudit).toHaveBeenCalledExactlyOnceWith("operator_approval_skipped", {
        approvalId: "approval-revoke",
        kind: "skill_hub.lifecycle",
        reason: "plugin_uninstall",
        actorId: ACTOR,
      });
      // Revoking only takes power away, so the skip setting (off here) is never read.
      expect(parts.readApprovalSkipSetting).not.toHaveBeenCalled();
    },
  );

  it("waits on remote_hardened, and resolves nothing", async () => {
    const parts = revokeSources({
      deploymentProfile: vi.fn((): DeploymentProfile => "remote_hardened"),
      readApprovalSkipSetting: vi.fn(async () => true),
    });

    const outcome = await new CapabilitySkillActionsService(parts).revokeForPluginUninstall(revoke);

    expect(outcome).toEqual({ status: "waiting", approvalId: "approval-revoke" });
    expect(parts.resolveApproval).not.toHaveBeenCalled();
    expect(parts.appendApprovalAudit).not.toHaveBeenCalled();
    expect(parts.readApprovalSkipSetting).not.toHaveBeenCalled();
  });

  it("reuses the revoke it already asked for while that one waits, and asks again only once it is gone", async () => {
    const hardened = vi.fn((): DeploymentProfile => "remote_hardened");
    const waiting = revokeSources({ deploymentProfile: hardened });
    await expect(
      new CapabilitySkillActionsService(waiting).revokeForPluginUninstall({
        ...revoke,
        knownApprovalId: "approval-old",
      }),
    ).resolves.toEqual({ status: "waiting", approvalId: "approval-old" });
    expect(waiting.readApproval).toHaveBeenCalledExactlyOnceWith("approval-old");
    // Never a second revoke while the first still waits, however far back in the approvals it sits.
    expect(waiting.createSkillHubApproval).not.toHaveBeenCalled();

    const approved = revokeSources({ readApproval: vi.fn(async () => approvalRead({ status: "approved" })) });
    await expect(
      new CapabilitySkillActionsService(approved).revokeForPluginUninstall({
        ...revoke,
        knownApprovalId: "approval-old",
      }),
    ).resolves.toEqual({ status: "approved", approvalId: "approval-old" });
    expect(approved.createSkillHubApproval).not.toHaveBeenCalled();
    expect(approved.resolveApproval).not.toHaveBeenCalled();

    for (const gone of [
      vi.fn(async () => approvalRead({ status: "rejected" })),
      vi.fn(async (): Promise<ApprovalRead> => {
        throw new NotFoundError("Approval not found.");
      }),
    ]) {
      const parts = revokeSources({ readApproval: gone });
      await expect(
        new CapabilitySkillActionsService(parts).revokeForPluginUninstall({
          ...revoke,
          knownApprovalId: "approval-old",
        }),
      ).resolves.toEqual({ status: "approved", approvalId: "approval-revoke" });
      expect(parts.createSkillHubApproval).toHaveBeenCalledOnce();
    }
  });

  it("never resolves a revoke the owner already approved, and keeps waiting when resolving fails", async () => {
    const approved = revokeSources({
      createSkillHubApproval: vi.fn(async () => ({ approval: hubApproval("revoke", "approved") })),
    });
    await expect(new CapabilitySkillActionsService(approved).revokeForPluginUninstall(revoke)).resolves.toEqual({
      status: "approved",
      approvalId: "approval-revoke",
    });
    expect(approved.resolveApproval).not.toHaveBeenCalled();

    const failure = new Error("approval store locked");
    const reportFailure = vi.fn();
    const failing = revokeSources({
      resolveApproval: vi.fn(async () => {
        throw failure;
      }),
    });
    await expect(
      new CapabilitySkillActionsService(failing, reportFailure).revokeForPluginUninstall(revoke),
    ).resolves.toEqual({ status: "waiting", approvalId: "approval-revoke" });
    expect(reportFailure).toHaveBeenCalledExactlyOnceWith("resolve", failure);
    expect(failing.appendApprovalAudit).not.toHaveBeenCalled();
  });
});
