import { describe, expect, it, vi } from "vitest";
import { runCronCli, type CronCliPort } from "./cron-cli.js";

function makePort(overrides: Partial<CronCliPort> = {}): CronCliPort {
  return {
    runCronJobNow: vi.fn().mockResolvedValue({ jobId: "j", runId: "r1", status: "ok" }),
    findCronRunById: vi.fn().mockReturnValue({ runId: "r1", jobId: "j", status: "ok", output: "alert" }),
    ...overrides,
  };
}

describe("runCronCli", () => {
  it("invokes runCronJobNow and prints the result for `cron run <jobId>`", async () => {
    const port = makePort();
    const writes: string[] = [];
    await runCronCli(["run", "j"], { port, write: (line) => writes.push(line) });
    expect(port.runCronJobNow).toHaveBeenCalledWith("j");
    expect(writes.join("\n")).toContain('"runId": "r1"');
  });

  it("blocks via findCronRunById when --wait is set, polling until a result resolves", async () => {
    let calls = 0;
    const port = makePort({
      runCronJobNow: vi.fn().mockResolvedValue({ jobId: "j", runId: "r1", status: "ok" }),
      findCronRunById: vi.fn().mockImplementation(() => {
        calls += 1;
        return calls >= 2 ? { runId: "r1", jobId: "j", status: "ok", output: "alert" } : undefined;
      }),
    });
    const writes: string[] = [];
    await runCronCli(["run", "j", "--wait", "--timeout", "5000", "--poll-interval", "1"], {
      port,
      write: (line) => writes.push(line),
    });
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(writes.join("\n")).toContain('"output": "alert"');
  });

  it("exits with timeout error when --wait elapses without a result", async () => {
    const port = makePort({
      runCronJobNow: vi.fn().mockResolvedValue({ jobId: "j", runId: "r1", status: "ok" }),
      findCronRunById: vi.fn().mockReturnValue(undefined),
    });
    const writes: string[] = [];
    await expect(
      runCronCli(["run", "j", "--wait", "--timeout", "20", "--poll-interval", "1"], {
        port,
        write: (line) => writes.push(line),
      }),
    ).rejects.toThrow(/timed out/i);
  });

  it("prints `cron runs --run-id` lookup result", async () => {
    const port = makePort();
    const writes: string[] = [];
    await runCronCli(["runs", "--run-id", "r1"], { port, write: (line) => writes.push(line) });
    expect(port.findCronRunById).toHaveBeenCalledWith("r1");
    expect(writes.join("\n")).toContain('"output": "alert"');
  });
});
