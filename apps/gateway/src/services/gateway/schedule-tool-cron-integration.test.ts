import { describe, expect, it, vi } from "vitest";
import type { CronJobRecord, ToolPolicyActorContext } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import { CronAutomationService } from "./cron-automation-service.js";
import { createTestCronSpecOwner } from "./cron-spec-owner.test-utils.js";
import {
  buildScheduleCreateActionConfig,
  parseScheduleManageArgs,
  summarizeScheduleJob,
  validateScheduleCreate,
} from "./schedule-tool-support.js";

/**
 * Integration coverage for the `schedule.manage` create → list → cancel flow the
 * gateway runtime hook drives, exercised against the real `CronAutomationService`
 * (and therefore the real `normalizeAgentTurnCronActionConfig`). Confirms:
 *  - create forces `action:"agent_turn"` and persists the creator profile, and
 *  - the persisted creator provenance round-trips so list/cancel can scope by it.
 */
describe("schedule.manage cron integration (P1-F2)", () => {
  const creatorCtx: ToolPolicyActorContext = {
    operatorId: "op-1",
    authActorId: "op-1",
    permissionProfileId: "trusted_local_power",
  };

  it("create persists an agent_turn job with the creator profile, then list + cancel round-trip", async () => {
    const cronJobs = new FakeCronJobs();
    const service = createService(cronJobs);

    // --- create (mirrors the gateway scheduleManage create branch) ---
    const validated = validateScheduleCreate({
      args: parseScheduleManageArgs({
        op: "create",
        name: "Morning briefing",
        schedule: "0 9 * * 1-5",
        prompt: "Summarize overnight updates.",
      }),
      policyContext: creatorCtx,
      existingJobs: service.listCronJobs(),
    });
    const created = await service.createCronJob({
      jobId: "morning-briefing-abc12345",
      name: validated.name,
      action: "agent_turn",
      schedule: validated.schedule,
      actionConfig: buildScheduleCreateActionConfig(validated),
    });

    // Action forced to agent_turn; creator profile persisted on the job.
    expect(created.action).toBe("agent_turn");
    expect(created.actionConfig?.agentTurn?.prompt).toBe("Summarize overnight updates.");
    expect(created.actionConfig?.agentTurn?.createdBy).toMatchObject({
      operatorId: "op-1",
      authActorId: "op-1",
      permissionProfileId: "trusted_local_power",
      depth: 0,
    });
    // agent_turn is a scheduled action → a next run is computed.
    expect(created.nextRunAt).toBeTruthy();

    // --- list (creator-scoped) ---
    const listed = service
      .listCronJobs()
      .filter((job) => job.action === "agent_turn")
      .filter((job) => job.actionConfig?.agentTurn?.createdBy?.operatorId === "op-1")
      .map((job) => summarizeScheduleJob(job));
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ jobId: "morning-briefing-abc12345", name: "Morning briefing", enabled: true });

    // --- cancel ---
    const cancelled = await service.deleteCronJob("morning-briefing-abc12345", created.revision);
    expect(cancelled).toEqual({ deleted: true, jobId: "morning-briefing-abc12345" });
    expect(service.listCronJobs()).toHaveLength(0);
  });

  it("preserves creator provenance through the real action-config normalizer", async () => {
    const cronJobs = new FakeCronJobs();
    const service = createService(cronJobs);
    const created = await service.createCronJob({
      jobId: "with-channel-xyz98765",
      name: "Channel delivery",
      action: "agent_turn",
      schedule: "30 8 * * 1",
      actionConfig: {
        agentTurn: {
          prompt: "Daily standup nudge",
          deliveryChannel: { channelKey: "slack", target: "#standup" },
          deliverMode: "always",
          createdBy: {
            operatorId: "op-2",
            permissionProfileId: "trusted_local_power",
            createdByJobId: "parent-job",
            depth: 1,
          },
        },
      },
    });
    expect(created.actionConfig?.agentTurn?.deliveryChannel).toEqual({ channelKey: "slack", target: "#standup" });
    expect(created.actionConfig?.agentTurn?.createdBy).toEqual({
      operatorId: "op-2",
      permissionProfileId: "trusted_local_power",
      createdByJobId: "parent-job",
      depth: 1,
    });
  });
});

class FakeCronJobs {
  public rows = new Map<string, CronJobRecord>();
  public list(): CronJobRecord[] {
    return [...this.rows.values()];
  }
  public get(jobId: string): CronJobRecord | undefined {
    return this.rows.get(jobId);
  }
  public upsert(job: CronJobRecord): CronJobRecord {
    this.rows.set(job.jobId, { ...job });
    return this.rows.get(job.jobId) as CronJobRecord;
  }
  public createSpec(job: Omit<CronJobRecord, "revision">): CronJobRecord {
    return this.upsert({ ...job, revision: 1 });
  }
  public mergeRuntimeTelemetry(jobId: string, patch: Partial<CronJobRecord>): CronJobRecord {
    const current = this.rows.get(jobId) as CronJobRecord;
    const next = { ...current } as Record<string, unknown>;
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete next[key];
      else next[key] = value;
    }
    return this.upsert(next as unknown as CronJobRecord);
  }
  public deleteWithRevision(jobId: string): boolean {
    return this.rows.delete(jobId);
  }
  public delete(jobId: string): boolean {
    return this.rows.delete(jobId);
  }
}

function createService(cronJobs: FakeCronJobs): CronAutomationService {
  return new CronAutomationService({
    storage: { db: { prepare: () => ({ run: () => {} }) }, cronJobs } as unknown as Storage,
    specOwner: createTestCronSpecOwner(cronJobs),
    publishRealtime: vi.fn(),
    requireFeatureEnabled: () => {},
    isFeatureEnabled: () => false,
    runHandlers: {
      task: async () => ({ taskId: "task-1" }),
      agentTurn: async () => ({ mode: "agent_turn" as const }),
      improvement: async () => {},
      backup: async () => {},
      memoryFlush: async () => {},
      memoryConsolidation: async () => {},
      costReport: async () => {},
      updateReview: async () => {},
      curator: async () => {},
      watchdog: async () => ({ status: "ok" as const, checkId: "runtime_health" as const, summary: "" }),
      noAgent: async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false }),
    },
  });
}
