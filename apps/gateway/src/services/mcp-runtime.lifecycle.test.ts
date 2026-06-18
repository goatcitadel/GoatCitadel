import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServerRecord } from "@goatcitadel/contracts";
import { __internal } from "./mcp-runtime.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

const spawnMock = vi.mocked(spawn);
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

const {
  attachChildStdinErrorHandler,
  isChildStdinWritable,
  terminateChild,
  writeToChildStdin,
  MCP_TERMINATE_GRACE_MS,
} = __internal;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

const TEST_SERVER: McpServerRecord = {
  serverId: "srv-lifecycle",
  label: "Lifecycle MCP",
  transport: "stdio",
  command: "node",
  args: [],
  authType: "none",
  enabled: true,
  status: "connected",
  category: "browser",
  trustTier: "trusted",
  costTier: "free",
  policy: {
    requireFirstToolApproval: false,
    redactionMode: "off",
    allowedToolPatterns: [],
    blockedToolPatterns: [],
  },
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};

/** Writable-stream stand-in for a child's stdin that can flip into broken-pipe states. */
class FakeStdin extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  writable = true;
  /** When set, `write` throws this synchronously (mimics EPIPE/ERR_STREAM_DESTROYED). */
  writeError: NodeJS.ErrnoException | undefined;
  readonly writes: string[] = [];

  write(payload: string): boolean {
    if (this.writeError) {
      throw this.writeError;
    }
    this.writes.push(payload);
    return true;
  }
}

interface FakeChildOptions {
  pid?: number | undefined;
  exitCode?: number | null;
  signalCode?: NodeJS.Signals | null;
}

/** Minimal ChildProcess stand-in exposing only what the lifecycle helpers touch. */
function createFakeChild(options: FakeChildOptions = {}): {
  child: ChildProcess;
  stdin: FakeStdin;
  kill: ReturnType<typeof vi.fn>;
  emitExit: () => void;
} {
  const emitter = new EventEmitter();
  const stdin = new FakeStdin();
  const kill = vi.fn(() => true);
  const child = {
    pid: "pid" in options ? options.pid : 4242,
    exitCode: options.exitCode ?? null,
    signalCode: options.signalCode ?? null,
    stdin,
    kill,
    once: (event: string, listener: (...args: unknown[]) => void) => emitter.once(event, listener),
    on: (event: string, listener: (...args: unknown[]) => void) => emitter.on(event, listener),
  } as unknown as ChildProcess;
  return {
    child,
    stdin,
    kill,
    emitExit: () => emitter.emit("exit", 0, null),
  };
}

/** A fake taskkill process so we can drive its error/exit lifecycle. */
function createFakeKiller(): {
  killer: ChildProcess;
  emitError: (error: Error) => void;
  emitClose: (code: number | null, signal?: NodeJS.Signals | null) => void;
} {
  const emitter = new EventEmitter();
  const killer = {
    on: (event: string, listener: (...args: unknown[]) => void) => emitter.on(event, listener),
  } as unknown as ChildProcess;
  return {
    killer,
    emitError: (error: Error) => emitter.emit("error", error),
    emitClose: (code: number | null, signal: NodeJS.Signals | null = null) => emitter.emit("close", code, signal),
  };
}

afterEach(() => {
  vi.useRealTimers();
  spawnMock.mockReset();
  if (originalPlatform) {
    Object.defineProperty(process, "platform", originalPlatform);
  }
});

beforeEach(() => {
  spawnMock.mockReset();
});

describe("mcp runtime stdin write hardening (INFRA-002)", () => {
  it("treats a writable stdin as available and forwards the payload", () => {
    const { child, stdin } = createFakeChild();

    expect(isChildStdinWritable(child)).toBe(true);
    expect(writeToChildStdin(child, TEST_SERVER, "{}\n")).toBe(true);
    expect(stdin.writes).toEqual(["{}\n"]);
  });

  it("does not throw and reports disconnect when stdin write emits EPIPE", () => {
    const { child, stdin } = createFakeChild();
    const epipe: NodeJS.ErrnoException = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    stdin.writeError = epipe;

    let result = true;
    expect(() => {
      result = writeToChildStdin(child, TEST_SERVER, "{}\n");
    }).not.toThrow();
    expect(result).toBe(false);
    expect(stdin.writes).toEqual([]);
  });

  it("skips writing to a destroyed stdin and reports disconnect", () => {
    const { child, stdin } = createFakeChild();
    stdin.destroyed = true;

    expect(isChildStdinWritable(child)).toBe(false);
    expect(writeToChildStdin(child, TEST_SERVER, "{}\n")).toBe(false);
    expect(stdin.writes).toEqual([]);
  });

  it("skips writing to an ended/non-writable stdin", () => {
    const { child, stdin } = createFakeChild();
    stdin.writableEnded = true;

    expect(isChildStdinWritable(child)).toBe(false);
    expect(writeToChildStdin(child, TEST_SERVER, "{}\n")).toBe(false);
  });

  it("absorbs an asynchronous stdin 'error' event without rethrowing", () => {
    const { child, stdin } = createFakeChild();
    attachChildStdinErrorHandler(child, TEST_SERVER);
    const epipe: NodeJS.ErrnoException = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });

    // Without a listener this would crash the process as an unhandled 'error'.
    expect(() => stdin.emit("error", epipe)).not.toThrow();
  });
});

describe("mcp runtime child termination (INFRA-001)", () => {
  it("kills the full process tree via taskkill on win32", () => {
    setPlatform("win32");
    const { killer } = createFakeKiller();
    spawnMock.mockReturnValue(killer);
    const { child, kill } = createFakeChild({ pid: 9182 });

    terminateChild(child, TEST_SERVER);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith(
      "taskkill",
      ["/pid", "9182", "/T", "/F"],
      expect.objectContaining({ windowsHide: true, stdio: "ignore" }),
    );
    expect(kill).not.toHaveBeenCalled();
  });

  it("falls back to child.kill when taskkill cannot run on win32", () => {
    setPlatform("win32");
    const { killer, emitError } = createFakeKiller();
    spawnMock.mockReturnValue(killer);
    const { child, kill } = createFakeChild({ pid: 9182 });

    terminateChild(child, TEST_SERVER);
    emitError(new Error("ENOENT taskkill"));

    expect(kill).toHaveBeenCalledTimes(1);
  });

  it("falls back to child.kill when taskkill exits non-zero on win32", () => {
    setPlatform("win32");
    const { killer, emitClose } = createFakeKiller();
    spawnMock.mockReturnValue(killer);
    const { child, kill } = createFakeChild({ pid: 9182 });

    terminateChild(child, TEST_SERVER);
    emitClose(5);

    expect(kill).toHaveBeenCalledTimes(1);
  });

  it("falls back to child.kill when spawning taskkill throws synchronously on win32", () => {
    setPlatform("win32");
    spawnMock.mockImplementation(() => {
      throw new Error("spawn taskkill ENOENT");
    });
    const { child, kill } = createFakeChild({ pid: 9182 });

    expect(() => terminateChild(child, TEST_SERVER)).not.toThrow();
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it("escalates SIGTERM to SIGKILL after the grace period on posix", () => {
    setPlatform("linux");
    vi.useFakeTimers();
    const { child, kill } = createFakeChild({ pid: 7777 });

    terminateChild(child, TEST_SERVER);

    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(spawnMock).not.toHaveBeenCalled();

    vi.advanceTimersByTime(MCP_TERMINATE_GRACE_MS);

    expect(kill).toHaveBeenCalledTimes(2);
    expect(kill).toHaveBeenNthCalledWith(2, "SIGKILL");
  });

  it("does not send SIGKILL when the child exits within the grace period on posix", () => {
    setPlatform("linux");
    vi.useFakeTimers();
    const { child, kill, emitExit } = createFakeChild({ pid: 7777 });

    terminateChild(child, TEST_SERVER);
    expect(kill).toHaveBeenNthCalledWith(1, "SIGTERM");

    // Child exits cleanly -> the escalation timer must be cleared (no leak, no SIGKILL).
    emitExit();
    vi.advanceTimersByTime(MCP_TERMINATE_GRACE_MS * 2);

    expect(kill).toHaveBeenCalledTimes(1);
  });

  it("is a no-op for a child that has already exited", () => {
    setPlatform("linux");
    const { child, kill } = createFakeChild({ pid: 7777, exitCode: 0 });

    terminateChild(child, TEST_SERVER);

    expect(kill).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("is a no-op when the child has no pid", () => {
    setPlatform("win32");
    const { child, kill } = createFakeChild({ pid: undefined });

    terminateChild(child, TEST_SERVER);

    expect(kill).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
