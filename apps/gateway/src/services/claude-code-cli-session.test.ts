import { describe, expect, it, vi } from "vitest";
import {
  createFakeClaudeCliHarness,
  line,
  type FakeClaudeCliChild,
  type FakeClaudeCliHarness,
} from "../test/claude-code-cli-fake-spawn.js";
import { startClaudeCliSession, type ClaudeCliSession } from "./claude-code-cli-session.js";

const segmentOptions = { overallTimeoutMs: 60_000, idleTimeoutMs: 1000 };
const heartbeat = line({ type: "tool_progress", heartbeat: true });
const closedExit = { exitCode: null, stderrTail: "" };

const tick = () => new Promise((resolve) => setImmediate(resolve));

/** Starts a session on the fake CLI and hands back the child once its script has run. */
async function startSession(): Promise<{
  harness: FakeClaudeCliHarness;
  session: ClaudeCliSession;
  child: FakeClaudeCliChild;
}> {
  let captured: FakeClaudeCliChild | undefined;
  const harness = createFakeClaudeCliHarness([
    (child) => {
      captured = child;
    },
  ]);
  const session = startClaudeCliSession({
    invocation: { command: "claude", prefixArgs: [] },
    args: ["-p"],
    env: {},
    cwd: ".",
    stdinPayload: "",
    ...segmentOptions,
    spawn: harness.spawn,
    killTree: harness.killTree,
  });
  await tick();
  if (!captured) throw new Error("the fake CLI script did not run");
  return { harness, session, child: captured };
}

/** Reads one line from a fresh segment, then parks the session and closes that segment. */
async function readOneAndPark(
  session: ClaudeCliSession,
  child: FakeClaudeCliChild,
  drain: (line: string) => "ok" | "fault",
  onFault: (reason: "line" | "exit") => void,
  written = "one\n",
): Promise<void> {
  const segment = session.segment(segmentOptions);
  const first = segment.next();
  child.stdout.write(written);
  expect(await first).toEqual({ done: false, value: "one" });
  session.park(drain, onFault);
  await segment.return(closedExit);
}

async function drainRest(segment: AsyncGenerator<string, unknown>): Promise<{ lines: string[]; result: unknown }> {
  const lines: string[] = [];
  for (;;) {
    const next = await segment.next();
    if (next.done) return { lines, result: next.value };
    lines.push(next.value);
  }
}

describe("startClaudeCliSession", () => {
  it("a parked session survives its segment closing", async () => {
    const { harness, session, child } = await startSession();
    const onFault = vi.fn();
    await readOneAndPark(session, child, () => "ok", onFault);

    expect(harness.killTree).not.toHaveBeenCalled();
    expect(onFault).not.toHaveBeenCalled();
    expect(session.pid).toBe(7000);
    await session.kill();
  });

  it("a resumed segment yields lines buffered while parked, after drain accepted them", async () => {
    const { harness, session, child } = await startSession();
    const drained: string[] = [];
    const onFault = vi.fn();
    // "two" is queued before park() but never read by the closing segment: it stays for the next one.
    await readOneAndPark(
      session,
      child,
      (parkedLine) => {
        drained.push(parkedLine);
        return "ok";
      },
      onFault,
      "one\ntwo\n",
    );
    child.stdout.write(heartbeat);
    await tick();
    expect(drained).toEqual([heartbeat.trimEnd()]);

    const resumed = session.segment(segmentOptions);
    expect(await resumed.next()).toEqual({ done: false, value: "two" });
    child.stdout.write("three\n");
    expect(await resumed.next()).toEqual({ done: false, value: "three" });
    child.exit(0);
    const { lines, result } = await drainRest(resumed);

    expect(lines).toEqual([]);
    expect(result).toMatchObject({ exitCode: 0 });
    expect(drained).toEqual([heartbeat.trimEnd()]);
    expect(onFault).not.toHaveBeenCalled();
    expect(harness.killTree).not.toHaveBeenCalled();
  });

  it("a line arriving between segment() and its first next() goes to the new segment, not the drain", async () => {
    const { harness, session, child } = await startSession();
    const drain = vi.fn<(line: string) => "ok" | "fault">(() => "fault");
    const onFault = vi.fn();
    await readOneAndPark(session, child, drain, onFault);

    const resumed = session.segment(segmentOptions);
    child.stdout.write("two\n");
    await tick();
    expect(drain).not.toHaveBeenCalled();
    expect(await resumed.next()).toEqual({ done: false, value: "two" });
    expect(onFault).not.toHaveBeenCalled();
    expect(harness.killTree).not.toHaveBeenCalled();
    await resumed.return(closedExit);
  });

  it("drain fault kills the tree", async () => {
    const { harness, session, child } = await startSession();
    const onFault = vi.fn();
    await readOneAndPark(session, child, () => "fault", onFault);
    child.stdout.write(line({ type: "assistant", message: { content: [] } }));
    child.stdout.write(heartbeat);
    await session.exited;

    expect(harness.killTree).toHaveBeenCalledTimes(1);
    expect(harness.killTree).toHaveBeenCalledWith(7000);
    expect(onFault).toHaveBeenCalledTimes(1);
    expect(onFault).toHaveBeenCalledWith("line");
    await expect(session.segment(segmentOptions).next()).rejects.toMatchObject({
      reasonCode: "claude_cli_bridge_mismatch",
    });
  });

  it("exit while parked reports a fault", async () => {
    const { harness, session, child } = await startSession();
    const onFault = vi.fn();
    await readOneAndPark(session, child, () => "ok", onFault);
    child.exit(0);

    expect(await session.exited).toMatchObject({ exitCode: 0 });
    expect(onFault).toHaveBeenCalledTimes(1);
    expect(onFault).toHaveBeenCalledWith("exit");
    expect(harness.killTree).not.toHaveBeenCalled();
  });

  it("parked time does not count against the next segment's idle timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { harness, session, child } = await startSession();
      const onFault = vi.fn();
      await readOneAndPark(session, child, () => "ok", onFault);
      await vi.advanceTimersByTimeAsync(segmentOptions.idleTimeoutMs * 3);
      expect(harness.killTree).not.toHaveBeenCalled();

      const resumed = session.segment(segmentOptions);
      const next = resumed.next();
      child.stdout.write("two\n");
      expect(await next).toEqual({ done: false, value: "two" });
      expect(harness.killTree).not.toHaveBeenCalled();

      // The idle timeout applies again from resume.
      const stalled = resumed.next();
      const rejection = expect(stalled).rejects.toMatchObject({ reasonCode: "claude_cli_timeout" });
      await vi.advanceTimersByTimeAsync(segmentOptions.idleTimeoutMs);
      await rejection;
      expect(harness.killTree).toHaveBeenCalledTimes(1);
      expect(onFault).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("kill is idempotent", async () => {
    const { harness, session } = await startSession();
    await Promise.all([session.kill(), session.kill()]);
    await session.kill();

    expect(harness.killTree).toHaveBeenCalledTimes(1);
    expect(await session.exited).toMatchObject({ exitCode: null });
  });

  it("allows one segment at a time", async () => {
    const { session, child } = await startSession();
    const segment = session.segment(segmentOptions);
    const first = segment.next();
    child.stdout.write("one\n");
    await first;

    expect(() => session.segment(segmentOptions)).toThrow(/one segment at a time/);
    await segment.return(closedExit);
  });
});
