import { EventEmitter } from "node:events";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class FakeWorker extends EventEmitter {
  public readonly stdin = new PassThrough();
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public killed = false;
  public readonly kill = vi.fn(() => {
    this.killed = true;
    return true;
  });
  public readonly requestLines: string[] = [];

  public constructor() {
    super();
    this.stdin.setEncoding("utf8");
    this.stdin.on("data", (chunk: string) => {
      this.requestLines.push(...chunk.split("\n").filter(Boolean));
    });
  }

  public requestId(index: number): string {
    return this.requestLines[index]!.split("|")[0]!;
  }
}

const workers: FakeWorker[] = [];
vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  }),
}));

const { PowerShellSkillHubWindowsSecurityProtocol, SkillHubWindowsSecurityError } =
  await import("./skill-hub-windows-security.js");

const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;

describe("PowerShellSkillHubWindowsSecurityProtocol cancellation", () => {
  beforeEach(() => {
    workers.length = 0;
    // The worker only runs on Windows; the spawned process is a fake, so pin the platform for this test.
    Object.defineProperty(process, "platform", { value: "win32" });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", realPlatform);
  });

  it("cancels only the aborted request and keeps the shared worker serving the others", async () => {
    const protocol = new PowerShellSkillHubWindowsSecurityProtocol({ idleShutdownMs: Number.POSITIVE_INFINITY });
    const target = path.resolve("skill-hub-cancel-fixture");
    const cancelled = new AbortController();
    const first = protocol.request("attributes", target, "file", cancelled.signal);
    const second = protocol.request("acl", target, "file", new AbortController().signal);
    const worker = workers[0]!;
    await vi.waitFor(() => expect(worker.requestLines).toHaveLength(2));

    cancelled.abort();
    await expect(first).rejects.toEqual(new SkillHubWindowsSecurityError("cancelled"));

    // The worker may still finish the cancelled request; its late response is ignored, not fatal.
    worker.stdout.write(`${worker.requestId(0)}|OK|1024\n`);
    worker.stdout.write(`${worker.requestId(1)}|OK|S-1-5-21-1\n`);

    await expect(second).resolves.toBe("S-1-5-21-1");
    expect(worker.kill).not.toHaveBeenCalled();
    protocol.dispose();
  });
});
