import { describe, expect, it } from "vitest";
import {
  buildCronCreatorAuthority,
  type CronAgentTurnConfig,
  type CronJobCreatorAuthorityInput,
  type CronJobRecord,
  type CronRunRecord,
} from "@goatcitadel/contracts";
import { isOwnAutonomousDelivery } from "./autonomous-delivery-ownership.js";
import { buildCronChatAdmissionIdentity } from "./scheduled-chat-authority.js";

const JOB_ID = "job-1";
const SESSION_ID = "session-1";
const CHANNEL = { channelKey: "telegram", target: "-100" };
const CREATOR = { operatorId: "operator-1", authActorId: "operator-1", permissionProfileId: "trusted_local_power" };

function scheduleConfig(overrides: Partial<CronAgentTurnConfig> = {}): CronAgentTurnConfig {
  return {
    prompt: "Send the morning summary.",
    sessionId: SESSION_ID,
    deliveryChannel: CHANNEL,
    deliverMode: "always",
    createdBy: { ...CREATOR, depth: 0 },
    ...overrides,
  };
}

const COMMITMENT = { commitmentId: "commitment-1", revision: 1, materialSha256: "a".repeat(64) };

/** One live scheduled occurrence and the reads the ownership check makes about it. */
function fixture(input: {
  config: CronAgentTurnConfig;
  receipt?: CronJobCreatorAuthorityInput["source"];
  /** The action the receipt was issued for, when it differs from the occurrence's frozen action. */
  receiptConfig?: CronAgentTurnConfig;
  runStatus?: CronRunRecord["status"];
  binding?: { connectionId: string; target: string } | null;
}) {
  const actionConfig = { agentTurn: input.config };
  const run = {
    runId: "cron-run-1",
    jobId: JOB_ID,
    executionGeneration: 1,
    action: "agent_turn",
    status: input.runStatus ?? "running",
    createdAt: "2026-10-27T00:00:00.000Z",
    actionSnapshot: { action: "agent_turn", actionConfig },
  } as unknown as CronRunRecord;
  const receiptJob = {
    jobId: JOB_ID,
    action: "agent_turn" as const,
    actionConfig: { agentTurn: input.receiptConfig ?? input.config },
  };
  const job = {
    ...receiptJob,
    actionConfig,
    activeRunId: run.runId,
    executionGeneration: 1,
    ...(input.receipt
      ? {
          creatorAuthority: buildCronCreatorAuthority(receiptJob, {
            actorId: CREATOR.operatorId,
            source: input.receipt,
          }),
        }
      : {}),
  } as unknown as CronJobRecord;
  const scheduledHost = {
    storage: {
      cronRuns: { get: async (runId: string) => (runId === run.runId ? run : undefined) },
      cronJobs: { get: async (jobId: string) => (jobId === JOB_ID ? job : undefined) },
    },
  } as never;
  const binding =
    input.binding === undefined ? { connectionId: "connection-1", target: CHANNEL.target } : input.binding;
  const autonomousDeps = {
    storage: {
      chatSessionBindings: {
        get: async () => (binding ? { transport: "integration", writable: true, ...binding } : undefined),
      },
    },
    listConnectorRecords: async () => [{ status: "active", sourceId: "connection-1", metadata: { key: "telegram" } }],
  } as never;
  const delivery = {
    sessionId: SESSION_ID,
    deliveryChannel: CHANNEL,
    systemActorId: `system:cron:${JOB_ID}`,
    cronAdmission: buildCronChatAdmissionIdentity({ runId: run.runId, jobId: JOB_ID, executionGeneration: 1 } as never),
  };
  return { scheduledHost, autonomousDeps, delivery };
}

describe("autonomous delivery ownership (P2-R19)", () => {
  it("treats an operator-made schedule's reply as GoatCitadel's own", async () => {
    const { scheduledHost, autonomousDeps, delivery } = fixture({
      config: scheduleConfig(),
      receipt: "authenticated_operator",
    });
    await expect(isOwnAutonomousDelivery(delivery, scheduledHost, autonomousDeps)).resolves.toBe(true);
  });

  it("does not treat a schedule.manage schedule's reply as own", async () => {
    const { scheduledHost, autonomousDeps, delivery } = fixture({ config: scheduleConfig(), receipt: "admitted_chat" });
    await expect(isOwnAutonomousDelivery(delivery, scheduledHost, autonomousDeps)).resolves.toBe(false);
  });

  it("does not trust an operator receipt issued for a different action", async () => {
    const { scheduledHost, autonomousDeps, delivery } = fixture({
      config: scheduleConfig({ prompt: "Changed after the receipt." }),
      receiptConfig: scheduleConfig(),
      receipt: "authenticated_operator",
    });
    await expect(isOwnAutonomousDelivery(delivery, scheduledHost, autonomousDeps)).resolves.toBe(false);
  });

  it("is not own when the source can't be resolved", async () => {
    const operator = { config: scheduleConfig(), receipt: "authenticated_operator" as const };
    const cases = [
      { ...fixture(operator), patch: { cronAdmission: undefined } },
      { ...fixture(operator), patch: { cronAdmission: { jobId: JOB_ID } } },
      { ...fixture(operator), patch: { systemActorId: "system:cron:another-job" } },
      { ...fixture(operator), patch: { deliveryChannel: { channelKey: "telegram", target: "-999" } } },
      { ...fixture({ ...operator, runStatus: "completed" }), patch: {} },
      { ...fixture({ config: scheduleConfig() }), patch: {} },
    ];
    for (const { scheduledHost, autonomousDeps, delivery, patch } of cases) {
      await expect(
        isOwnAutonomousDelivery({ ...delivery, ...patch }, scheduledHost, autonomousDeps),
        JSON.stringify(patch),
      ).resolves.toBe(false);
    }
  });

  it("treats a commitment follow-up as own only when it goes to the session's own bound channel", async () => {
    const commitment = scheduleConfig({ commitment: COMMITMENT });
    const bound = fixture({ config: commitment });
    await expect(isOwnAutonomousDelivery(bound.delivery, bound.scheduledHost, bound.autonomousDeps)).resolves.toBe(
      true,
    );

    for (const binding of [null, { connectionId: "connection-1", target: "-555" }]) {
      const elsewhere = fixture({ config: commitment, binding });
      await expect(
        isOwnAutonomousDelivery(elsewhere.delivery, elsewhere.scheduledHost, elsewhere.autonomousDeps),
        JSON.stringify(binding),
      ).resolves.toBe(false);
    }
  });

  it("treats a commitment follow-up as not own, without failing the enqueue, when its bound channel can't be read", async () => {
    const { scheduledHost, delivery } = fixture({ config: scheduleConfig({ commitment: COMMITMENT }) });
    const unreadable = {
      storage: { chatSessionBindings: { get: async () => Promise.reject(new Error("database is locked")) } },
      listConnectorRecords: async () => [],
    } as never;
    await expect(isOwnAutonomousDelivery(delivery, scheduledHost, unreadable)).resolves.toBe(false);
  });
});
