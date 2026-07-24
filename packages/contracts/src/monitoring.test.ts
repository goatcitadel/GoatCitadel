import { describe, expect, it } from "vitest";
import type {
  CronJobAction,
  CronJobActionConfig,
  CronJobRecord,
  RealtimeEventLinks,
  RealtimeEventType,
} from "./monitoring.js";

describe("RealtimeEventType remote-worker invalidations", () => {
  it("includes the content-free remote-worker change signals", () => {
    const worker: RealtimeEventType = "remote_worker_changed";
    const assignment: RealtimeEventType = "remote_worker_assignment_changed";
    expect(worker).toBe("remote_worker_changed");
    expect(assignment).toBe("remote_worker_assignment_changed");
  });

  it("carries optional worker/assignment invalidation links", () => {
    const links: RealtimeEventLinks = { workspaceId: "workspace-a", workerId: "worker-a", assignmentId: "assign-a" };
    expect(links.workerId).toBe("worker-a");
    expect(links.assignmentId).toBe("assign-a");
  });
});

describe("CronJobAction", () => {
  it("includes no_agent", () => {
    const action: CronJobAction = "no_agent";
    expect(action).toBe("no_agent");
  });

  it("includes agent_turn", () => {
    const action: CronJobAction = "agent_turn";
    expect(action).toBe("agent_turn");
  });
});

describe("CronJobActionConfig", () => {
  it("accepts noAgent configuration", () => {
    const config: CronJobActionConfig = {
      noAgent: {
        command: "echo",
        args: ["alert"],
        timeoutMs: 5_000,
        deliveryChannel: { channelKey: "ops" },
      },
    };
    expect(config.noAgent?.command).toBe("echo");
  });

  it("accepts agentTurn configuration", () => {
    const config: CronJobActionConfig = {
      agentTurn: {
        sessionId: "sess_cron",
        prompt: "Summarize overnight alerts.",
        deliveryChannel: { channelKey: "telegram", target: "123" },
        deliverMode: "on_notify",
        inertInboxFallback: false,
      },
    };
    expect(config.agentTurn?.prompt).toBe("Summarize overnight alerts.");
    expect(config.agentTurn?.deliverMode).toBe("on_notify");
  });
});

describe("CronJobRecord", () => {
  it("carries workdir, contextFrom, lastRunOutput, lastRunId, and backoff evidence", () => {
    const record: CronJobRecord = {
      jobId: "id",
      revision: 1,
      name: "n",
      action: "no_agent",
      schedule: "*/5 * * * *",
      enabled: true,
      workdir: "/tmp/x",
      contextFrom: "other-job",
      lastRunOutput: "alert",
      lastRunId: "run-1",
      lastRunStatus: "failed",
      lastFailureAt: "2026-05-15T12:03:00.000Z",
      lastFailure: { message: "downstream refused", code: "Error" },
      failureCount: 2,
      backoffUntil: "2026-05-15T12:05:00.000Z",
    };
    expect(record.workdir).toBe("/tmp/x");
    expect(record.contextFrom).toBe("other-job");
    expect(record.lastRunOutput).toBe("alert");
    expect(record.lastRunId).toBe("run-1");
    expect(record.lastRunStatus).toBe("failed");
    expect(record.failureCount).toBe(2);
    expect(record.backoffUntil).toBe("2026-05-15T12:05:00.000Z");
  });
});
