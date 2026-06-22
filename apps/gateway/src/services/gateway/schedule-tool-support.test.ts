import { describe, expect, it } from "vitest";
import type { CronJobRecord, ToolPolicyActorContext } from "@goatcitadel/contracts";
import { SCHEDULED_TURN_PERMISSION_PROFILE_ID } from "@goatcitadel/contracts";
import {
  buildScheduleCreateActionConfig,
  deriveScheduleCreator,
  isAgentTurnJobOwnedBy,
  isScheduledTurnContext,
  MAX_AGENT_TURN_JOBS_PER_CREATOR,
  parseScheduleManageArgs,
  resolveScheduleCreatorKey,
  summarizeScheduleJob,
  validateScheduleCreate,
} from "./schedule-tool-support.js";

const interactiveCtx: ToolPolicyActorContext = {
  operatorId: "op-1",
  authActorId: "op-1",
  permissionProfileId: "trusted_local_power",
};

describe("parseScheduleManageArgs", () => {
  it("parses each op and trims string fields", () => {
    expect(parseScheduleManageArgs({ op: "list" })).toEqual({ op: "list" });
    expect(
      parseScheduleManageArgs({ op: "create", name: "  Morning  ", schedule: "0 9 * * 1", prompt: "  Brief me  " }),
    ).toEqual({ op: "create", name: "Morning", schedule: "0 9 * * 1", prompt: "Brief me" });
    expect(parseScheduleManageArgs({ op: "cancel", jobId: " job-1 " })).toEqual({ op: "cancel", jobId: "job-1" });
  });

  it("rejects an unknown or missing op", () => {
    expect(() => parseScheduleManageArgs({})).toThrow(/op to be one of/i);
    expect(() => parseScheduleManageArgs({ op: "delete" })).toThrow(/op to be one of/i);
  });

  it("normalizes a delivery channel object", () => {
    expect(
      parseScheduleManageArgs({ op: "create", deliveryChannel: { channelKey: "slack", target: "#ops" } }).deliveryChannel,
    ).toEqual({ channelKey: "slack", target: "#ops" });
    expect(parseScheduleManageArgs({ op: "create", deliveryChannel: { target: "#ops" } }).deliveryChannel).toBeUndefined();
  });
});

describe("deriveScheduleCreator", () => {
  it("stamps the creator actor + profile at depth 0 for interactive callers", () => {
    expect(deriveScheduleCreator(interactiveCtx, undefined)).toEqual({
      operatorId: "op-1",
      authActorId: "op-1",
      permissionProfileId: "trusted_local_power",
      depth: 0,
    });
  });

  it("marks depth 1 when the caller is a scheduled turn that owns a parent job", () => {
    const scheduledCtx: ToolPolicyActorContext = {
      operatorId: "system-cron",
      authActorId: "system-cron",
      permissionProfileId: SCHEDULED_TURN_PERMISSION_PROFILE_ID,
    };
    expect(deriveScheduleCreator(scheduledCtx, "parent-job")).toMatchObject({
      createdByJobId: "parent-job",
      depth: 2,
    });
  });
});

describe("isScheduledTurnContext / resolveScheduleCreatorKey", () => {
  it("detects the restricted scheduled profile", () => {
    expect(isScheduledTurnContext(interactiveCtx)).toBe(false);
    expect(isScheduledTurnContext({ permissionProfileId: SCHEDULED_TURN_PERMISSION_PROFILE_ID })).toBe(true);
  });

  it("prefers operatorId, then authActorId, for the creator key", () => {
    expect(resolveScheduleCreatorKey(interactiveCtx)).toBe("op-1");
    expect(resolveScheduleCreatorKey({ authActorId: "actor-2" })).toBe("actor-2");
    expect(resolveScheduleCreatorKey(undefined)).toBeUndefined();
  });
});

describe("validateScheduleCreate", () => {
  it("accepts a valid create and stamps creator provenance + derived name", () => {
    const result = validateScheduleCreate({
      args: parseScheduleManageArgs({ op: "create", schedule: "0 9 * * 1-5", prompt: "Summarize overnight updates." }),
      policyContext: interactiveCtx,
      existingJobs: [],
    });
    expect(result.schedule).toBe("0 9 * * 1-5");
    expect(result.prompt).toBe("Summarize overnight updates.");
    expect(result.name).toBe("Summarize overnight updates.");
    expect(result.createdBy).toMatchObject({ operatorId: "op-1", permissionProfileId: "trusted_local_power", depth: 0 });
  });

  it("rejects a missing prompt or schedule", () => {
    expect(() =>
      validateScheduleCreate({
        args: parseScheduleManageArgs({ op: "create", schedule: "0 9 * * 1" }),
        policyContext: interactiveCtx,
        existingJobs: [],
      }),
    ).toThrow(/requires a non-empty "prompt"/i);
    expect(() =>
      validateScheduleCreate({
        args: parseScheduleManageArgs({ op: "create", prompt: "do a thing" }),
        policyContext: interactiveCtx,
        existingJobs: [],
      }),
    ).toThrow(/requires a "schedule"/i);
  });

  it("enforces the ~15 minute interval floor (every-minute schedule rejected)", () => {
    expect(() =>
      validateScheduleCreate({
        args: parseScheduleManageArgs({ op: "create", schedule: "* * * * *", prompt: "too often" }),
        policyContext: interactiveCtx,
        existingJobs: [],
      }),
    ).toThrow(/fires too often/i);
    // A wildcard-minute hour-step schedule also breaches the floor.
    expect(() =>
      validateScheduleCreate({
        args: parseScheduleManageArgs({ op: "create", schedule: "* */2 * * *", prompt: "still too often" }),
        policyContext: interactiveCtx,
        existingJobs: [],
      }),
    ).toThrow(/fires too often/i);
    // A pinned-minute hourly schedule clears the floor.
    expect(
      validateScheduleCreate({
        args: parseScheduleManageArgs({ op: "create", schedule: "0 * * * *", prompt: "hourly is fine" }),
        policyContext: interactiveCtx,
        existingJobs: [],
      }).schedule,
    ).toBe("0 * * * *");
  });

  it("refuses a depth-2 chain (scheduled turn creating from inside a scheduled job)", () => {
    const scheduledCtx: ToolPolicyActorContext = {
      operatorId: "system-cron",
      permissionProfileId: SCHEDULED_TURN_PERMISSION_PROFILE_ID,
    };
    expect(() =>
      validateScheduleCreate({
        args: parseScheduleManageArgs({ op: "create", schedule: "0 9 * * 1", prompt: "nest deeper" }),
        policyContext: scheduledCtx,
        existingJobs: [],
        createdByJobId: "parent-job",
      }),
    ).toThrow(/chain depth/i);
  });

  it("enforces the per-creator job cap", () => {
    const ownedJobs: CronJobRecord[] = Array.from({ length: MAX_AGENT_TURN_JOBS_PER_CREATOR }, (_unused, index) =>
      agentTurnJob(`job-${index}`, { operatorId: "op-1" }),
    );
    expect(() =>
      validateScheduleCreate({
        args: parseScheduleManageArgs({ op: "create", schedule: "0 9 * * 1", prompt: "one too many" }),
        policyContext: interactiveCtx,
        existingJobs: ownedJobs,
      }),
    ).toThrow(/already own/i);
  });

  it("does not count another creator's jobs toward the cap", () => {
    const otherJobs: CronJobRecord[] = Array.from({ length: MAX_AGENT_TURN_JOBS_PER_CREATOR }, (_unused, index) =>
      agentTurnJob(`other-${index}`, { operatorId: "someone-else" }),
    );
    expect(
      validateScheduleCreate({
        args: parseScheduleManageArgs({ op: "create", schedule: "0 9 * * 1", prompt: "still allowed" }),
        policyContext: interactiveCtx,
        existingJobs: otherJobs,
      }).name,
    ).toBeTruthy();
  });
});

describe("ownership + projection helpers", () => {
  it("matches agent_turn job ownership by operator or actor id", () => {
    expect(isAgentTurnJobOwnedBy(agentTurnJob("a", { operatorId: "op-1" }), "op-1")).toBe(true);
    expect(isAgentTurnJobOwnedBy(agentTurnJob("a", { authActorId: "op-1" }), "op-1")).toBe(true);
    expect(isAgentTurnJobOwnedBy(agentTurnJob("a", { operatorId: "op-2" }), "op-1")).toBe(false);
    const nonAgentTurn = { ...agentTurnJob("a", { operatorId: "op-1" }), action: "task" as const };
    expect(isAgentTurnJobOwnedBy(nonAgentTurn, "op-1")).toBe(false);
  });

  it("forces action_turn config with creator provenance", () => {
    const result = validateScheduleCreate({
      args: parseScheduleManageArgs({ op: "create", schedule: "0 9 * * 1", prompt: "Brief me" }),
      policyContext: interactiveCtx,
      existingJobs: [],
    });
    const config = buildScheduleCreateActionConfig(result);
    expect(config.agentTurn.prompt).toBe("Brief me");
    expect(config.agentTurn.deliverMode).toBe("always");
    expect(config.agentTurn.createdBy).toMatchObject({ operatorId: "op-1", depth: 0 });
  });

  it("summarizes a schedule job for the model-facing list", () => {
    const job = agentTurnJob("morning", { operatorId: "op-1" });
    expect(summarizeScheduleJob(job)).toMatchObject({
      jobId: "morning",
      name: "Morning",
      schedule: "0 9 * * 1",
      enabled: true,
      prompt: "Brief me",
    });
  });
});

function agentTurnJob(
  jobId: string,
  createdBy: { operatorId?: string; authActorId?: string },
): CronJobRecord {
  return {
    jobId,
    name: "Morning",
    action: "agent_turn",
    schedule: "0 9 * * 1",
    enabled: true,
    actionConfig: {
      agentTurn: {
        prompt: "Brief me",
        deliverMode: "always",
        createdBy: { ...createdBy, depth: 0 },
      },
    },
  };
}
