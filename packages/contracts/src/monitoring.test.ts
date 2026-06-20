import { describe, expect, it } from "vitest";
import type { CronJobAction, CronJobActionConfig, CronJobRecord } from "./monitoring.js";

describe("CronJobAction", () => {
  it("includes no_agent", () => {
    const action: CronJobAction = "no_agent";
    expect(action).toBe("no_agent");
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
});

describe("CronJobRecord", () => {
  it("carries workdir, contextFrom, lastRunOutput, lastRunId, and backoff evidence", () => {
    const record: CronJobRecord = {
      jobId: "id",
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
