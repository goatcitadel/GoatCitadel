import fs from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { cleanupRecoveredBackgroundProcess } from "@goatcitadel/policy-engine";
import { createSqliteAsyncStorage, Storage } from "@goatcitadel/storage";
import { captureBackgroundProcessIdentity } from "../../../../packages/policy-engine/src/tool-executor/background-process-identity.js";
import {
  cleanupDelegatedChildProcesses,
  cleanupDelegatedChildResources,
  reconcileDelegatedChildProcessCleanup,
} from "./delegated-child-process-cleanup.js";

it("forgets only the settled child's volatile browser state even when retained process cleanup fails", async () => {
  const owner = { stepId: "step", childSessionId: "child", childTurnId: "turn" };
  const step = { ...owner, status: "completed" };
  const states = new Set(["child", "parent"]);
  const failure = new Error("cleanup receipt unavailable");
  const resources = {
    forgetBrowserState: vi.fn((sessionId: string) => states.delete(sessionId)),
    terminateLiveProcesses: vi.fn(() => 0),
    cleanupRetainedProcesses: vi.fn(async () => {
      throw failure;
    }),
  };
  const storage = { chatDelegationSteps: { get: async () => step } } as never;
  const closeMcp = vi.fn(() => 1);
  await expect(cleanupDelegatedChildResources(storage, owner, resources, closeMcp)).rejects.toBe(failure);
  expect(states).toEqual(new Set(["parent"]));
  expect(closeMcp).toHaveBeenCalledWith({ sessionId: "child", turnId: "turn" });
  expect(resources.terminateLiveProcesses).toHaveBeenCalledWith({ sessionId: "child", turnId: "turn" });
  step.status = "running";
  await expect(cleanupDelegatedChildResources(storage, owner, resources, closeMcp)).rejects.toThrow("exact settled");
  expect(resources.forgetBrowserState).toHaveBeenCalledTimes(1);
  expect(closeMcp).toHaveBeenCalledTimes(1);
});

it("replays cleanup only from exact settled child tool receipts and retains the native outcome", async () => {
  const owner = { stepId: "step", childSessionId: "child", childTurnId: "turn" };
  const identity = {
    version: "background-process.identity.v1",
    platform: "win32",
    host: hostname(),
    pid: 43210,
    creationFileTime: "134000000000000000",
    sessionId: "child",
    turnId: "turn",
  };
  const tool = {
    toolRunId: "tool",
    toolName: "shell.exec_background",
    sessionId: "child",
    turnId: "turn",
    status: "executed",
    result: { started: true, pid: 43210, processIdentity: identity } as Record<string, unknown>,
  };
  const step = { ...owner, status: "completed" };
  const listByTurn = vi.fn(async () => [
    tool,
    { ...tool, toolRunId: "foreign", sessionId: "parent" },
    { ...tool, toolRunId: "reused", reused: true },
    { ...tool, toolRunId: "old", result: { pid: 999 } },
  ]);
  const compareAndSwapResult = vi.fn(async (_id: string, expected: unknown, result: Record<string, unknown>) => {
    if (_id === "tool") {
      expect(expected).toBe(tool.result);
      tool.result = result;
    } else expect(result.backgroundProcessCleanup).toMatchObject({ outcome: "unavailable" });
    return tool;
  });
  const storage = {
    runImmediateTransaction: async (callback: () => Promise<unknown>) => callback(),
    chatDelegationSteps: { get: vi.fn(async () => step), getForUpdate: vi.fn(async () => step) },
    chatToolRuns: {
      listByTurn,
      compareAndSwapResult,
      get: async (id: string) => (await listByTurn()).find((item) => item.toolRunId === id),
    },
  } as never;
  const cleanup = vi.fn(async () => "terminated" as const);
  expect(await cleanupDelegatedChildProcesses(storage, owner, cleanup)).toEqual({
    tracked: 1,
    terminated: 1,
    alreadyAbsent: 0,
    unconfirmed: 1,
  });
  expect(cleanup).toHaveBeenCalledWith(identity, { sessionId: "child", turnId: "turn" });
  expect(tool.result.backgroundProcessCleanup).toMatchObject({
    stepId: "step",
    outcome: "terminated",
    descendants: "unconfirmed",
  });
  await cleanupDelegatedChildProcesses(storage, owner, cleanup);
  expect(cleanup).toHaveBeenCalledTimes(1);
  step.status = "running";
  await expect(cleanupDelegatedChildProcesses(storage, owner, cleanup)).rejects.toThrow("exact settled");
  expect(cleanup).toHaveBeenCalledTimes(1);
});

it.runIf(process.platform === "win32").each([false, true])(
  "discovers committed terminal-step cleanup after SQLite reopen and recovers a lost ACK (%s)",
  async (loseAcknowledgement) => {
    const root = await fs.mkdtemp(path.join(tmpdir(), "gc-child-process-recovery-"));
    const options = {
      dbPath: path.join(root, "gateway.db"),
      transcriptsDir: path.join(root, "transcripts"),
      auditDir: path.join(root, "audit"),
    };
    const owner = { stepId: "recovered-step", childSessionId: "recovered-child", childTurnId: "recovered-turn" };
    let raw: Storage | undefined;
    let child: ChildProcess | undefined;
    try {
      raw = new Storage(options);
      const storage = createSqliteAsyncStorage(raw);
      await storage.chatDelegationSteps.create({
        ...owner,
        runId: "recovered-parent",
        role: "Coder",
        index: 0,
        status: "completed",
      });
      // Replay cleanup proves the recorded process, not a shell's descendants.
      // Keep a direct fixture handle for finally cleanup if any assertion fails.
      child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", root], {
        cwd: root,
        stdio: "ignore",
        windowsHide: true,
      });
      await once(child, "spawn");
      const processIdentity = await captureBackgroundProcessIdentity(child, {
        sessionId: owner.childSessionId,
        turnId: owner.childTurnId,
      });
      const result = {
        started: true,
        pid: child.pid,
        restartCleanup: processIdentity ? "identity_bound_process_only" : "unavailable",
        processIdentity,
      };
      expect(result).toMatchObject({
        started: true,
        restartCleanup: "identity_bound_process_only",
        processIdentity: { pid: child.pid, sessionId: owner.childSessionId, turnId: owner.childTurnId },
      });
      await storage.chatToolRuns.create({
        toolRunId: "recovered-tool",
        sessionId: owner.childSessionId,
        turnId: owner.childTurnId,
        toolName: "shell.exec_background",
        status: "executed",
        result,
      });
      raw.close();
      raw = undefined;

      raw = new Storage(options);
      const lostAck = loseAcknowledgement
        ? vi.spyOn(raw.chatToolRuns, "compareAndSwapResult").mockImplementationOnce(() => {
            throw new Error("Crash after native termination before cleanup ACK");
          })
        : undefined;
      const recoveredStorage = createSqliteAsyncStorage(raw);
      expect((await recoveredStorage.chatToolRuns.get("recovered-tool")).result).toEqual(result);
      // Maintenance discovers the terminal row itself. No explicit settlement
      // replay, watcher callback, or process-local kill registry is invoked.
      const nativeCleanup = vi.fn(cleanupRecoveredBackgroundProcess);
      expect(await reconcileDelegatedChildProcessCleanup(recoveredStorage, nativeCleanup)).toEqual({
        attempted: 1,
        failed: loseAcknowledgement ? 1 : 0,
      });
      expect(nativeCleanup).toHaveBeenCalledTimes(1);
      expect(await nativeCleanup.mock.results[0]?.value).toBe("terminated");
      if (loseAcknowledgement)
        expect(
          (await recoveredStorage.chatToolRuns.get("recovered-tool")).result?.backgroundProcessCleanup,
        ).toBeUndefined();
      lostAck?.mockRestore();
      raw.close();
      raw = undefined;

      raw = new Storage(options);
      const retryStorage = createSqliteAsyncStorage(raw);
      for (let tick = 0; tick < 4; tick += 1) await reconcileDelegatedChildProcessCleanup(retryStorage, nativeCleanup);
      expect(nativeCleanup).toHaveBeenCalledTimes(loseAcknowledgement ? 2 : 1);
      expect((await retryStorage.chatToolRuns.get("recovered-tool")).result?.backgroundProcessCleanup).toMatchObject({
        stepId: owner.stepId,
        outcome: loseAcknowledgement ? "missing" : "terminated",
        scope: "recorded_process_only",
        descendants: "unconfirmed",
      });
      const replayCleanup = vi.fn(async () => "unavailable" as const);
      expect(await cleanupDelegatedChildProcesses(retryStorage, owner, replayCleanup)).toEqual({
        tracked: 1,
        terminated: loseAcknowledgement ? 0 : 1,
        alreadyAbsent: loseAcknowledgement ? 1 : 0,
        unconfirmed: 0,
      });
      expect(replayCleanup).not.toHaveBeenCalled();
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exit = once(child, "exit");
        child.kill();
        await exit;
      }
      raw?.close();
      await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  },
  90_000,
);

it("persists sub-page progress, skips ineligible steps, retries failed cleanup after wrap and bounds each maintenance tick", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "gc-child-cleanup-cursor-"));
  const raw = new Storage({
    dbPath: path.join(root, "gateway.db"),
    transcriptsDir: path.join(root, "transcripts"),
    auditDir: path.join(root, "audit"),
  });
  const storage = createSqliteAsyncStorage(raw);
  try {
    for (const [stepId, status] of [
      ["00-running", "running"],
      ["01-skipped", "skipped"],
      ["10-many", "completed"],
      ["20-failed", "failed"],
    ] as const) {
      await storage.chatDelegationSteps.create({
        stepId,
        status,
        runId: "parent",
        role: "Coder",
        index: 0,
        childSessionId: `session-${stepId}`,
        childTurnId: `turn-${stepId}`,
      });
    }
    for (const [stepId, count] of [
      ["10-many", 40],
      ["20-failed", 1],
    ] as const) {
      for (let index = 0; index < count; index += 1) {
        const native = stepId === "20-failed" || index >= 31;
        await storage.chatToolRuns.create({
          toolRunId: `${stepId}-${String(index).padStart(3, "0")}`,
          sessionId: `session-${stepId}`,
          turnId: `turn-${stepId}`,
          toolName: native ? "shell.exec_background" : "time.now",
          status: "executed",
          startedAt: "2026-10-11T00:00:00.000Z",
          result: native
            ? {
                processIdentity: {
                  version: "background-process.identity.v1",
                  platform: "win32",
                  host: hostname(),
                  pid: 40_000 + index,
                  creationFileTime: "134000000000000000",
                  sessionId: `session-${stepId}`,
                  turnId: `turn-${stepId}`,
                },
              }
            : {},
        });
      }
    }
    const steps = vi.spyOn(raw.chatDelegationSteps, "listResourceCleanupPage");
    const tools = vi.spyOn(raw.chatToolRuns, "listByTurnPage");
    let refusedOnce = false;
    const cleanup = vi.fn(async (identity: unknown) => {
      if ((identity as { pid: number }).pid === 40_031 && !refusedOnce) {
        refusedOnce = true;
        throw new Error("Temporary cleanup failure");
      }
      return "terminated" as const;
    });
    let attempted = 0;
    for (let tick = 0; tick < 28; tick += 1) {
      const previousCalls = cleanup.mock.calls.length;
      const result = await reconcileDelegatedChildProcessCleanup(storage, cleanup);
      expect(cleanup.mock.calls.length - previousCalls).toBeLessThanOrEqual(1);
      expect(result.attempted).toBeLessThanOrEqual(1);
      attempted += result.attempted;
    }
    expect(attempted).toBe(11); // Ten distinct receipts, one retried after cursor wrap.
    expect(cleanup).toHaveBeenCalledTimes(11);
    for (const call of steps.mock.calls) expect(call[1]).toBe(32);
    for (const call of tools.mock.calls) expect(call[2]).toBe(32);
    expect((await storage.chatToolRuns.get("10-many-031")).result?.backgroundProcessCleanup).toMatchObject({
      outcome: "terminated",
    });
    expect((await storage.chatToolRuns.get("20-failed-000")).result?.backgroundProcessCleanup).toMatchObject({
      outcome: "terminated",
    });
    expect(cleanup.mock.calls.some(([identity]) => (identity as { turnId: string }).turnId === "turn-20-failed")).toBe(
      true,
    );
  } finally {
    raw.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}, 60_000);

it.each(["before-native", "before-ack"])("rejects canonical child drift %s", async (phase) => {
  const owner = { stepId: "step", childSessionId: "child", childTurnId: "turn" };
  const step = { ...owner, status: "completed" };
  const tool = {
    toolRunId: "tool",
    sessionId: "child",
    turnId: "turn",
    toolName: "shell.exec_background",
    status: "executed",
    result: {
      processIdentity: {
        version: "background-process.identity.v1",
        platform: "win32",
        host: hostname(),
        pid: 54321,
        creationFileTime: "134000000000000000",
        sessionId: "child",
        turnId: "turn",
      },
    },
  };
  let reads = 0;
  const get = async () => {
    reads += 1;
    if (phase === "before-native" && reads > 1) step.childTurnId = "changed";
    return step;
  };
  const acknowledge = vi.fn();
  const storage = {
    runImmediateTransaction: async (callback: () => Promise<unknown>) => callback(),
    chatDelegationSteps: { get, getForUpdate: get },
    chatToolRuns: { get: async () => tool, listByTurn: async () => [tool], compareAndSwapResult: acknowledge },
  } as never;
  const cleanup = vi.fn(async () => {
    if (phase === "before-ack") step.childTurnId = "changed";
    return "terminated" as const;
  });
  await expect(cleanupDelegatedChildProcesses(storage, owner, cleanup)).rejects.toThrow(
    "owner or process receipt changed",
  );
  expect(cleanup).toHaveBeenCalledTimes(phase === "before-native" ? 0 : 1);
  expect(acknowledge).not.toHaveBeenCalled();
});
