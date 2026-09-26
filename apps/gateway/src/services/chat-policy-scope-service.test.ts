import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConflictError } from "@goatcitadel/contracts";
import { createSqliteAsyncStorage, Storage } from "@goatcitadel/storage";
import { assertCallerPolicyScopeBound, type ChatPolicyScopeStorage } from "./chat-policy-scope-service.js";

const resources: Array<{ root: string; storage: Storage }> = [];

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    resource.storage.close();
    await fs.rm(resource.root, { recursive: true, force: true });
  }
});

async function harness() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gc-policy-scope-"));
  const storage = new Storage({
    dbPath: ":memory:",
    transcriptsDir: path.join(root, "transcripts"),
    auditDir: path.join(root, "audit"),
  });
  resources.push({ root, storage });
  const now = "2026-09-26T00:00:00.000Z";
  storage.chatSessionMeta.ensure("session-a", now, "workspace-a");
  storage.chatSessionMeta.ensure("session-b", now, "workspace-a");
  const delegation = (runId: string, sessionId: string, taskId: string) =>
    storage.chatDelegationRuns.create({
      runId,
      sessionId,
      taskId,
      objective: "Review the release",
      roles: ["QA"],
      mode: "sequential",
      startedAt: now,
    });
  // A delegation run and a turn orchestration run (itself a delegation run) in session A.
  delegation("delegation-a", "session-a", "task-delegated-a");
  delegation("turn-orchestration-a", "session-a", "chat-orchestration:turn-a");
  delegation("delegation-b", "session-b", "task-delegated-b");
  storage.durableRuns.createRun({
    runId: "durable-a",
    workflowKey: "chat.turn",
    payload: { sessionId: "session-a" },
    now,
  });
  storage.durableRuns.createRun({
    runId: "durable-b",
    workflowKey: "chat.turn",
    payload: { sessionId: "session-b" },
    now,
  });
  storage.tasks.create(
    {
      workspaceId: "workspace-a",
      title: "Child task for session A",
      agenticContext: { parentSessionId: "session-a", childSessionId: "session-a-child" },
    },
    now,
    { taskId: "task-agentic-a" },
  );
  storage.tasks.create(
    {
      workspaceId: "workspace-other",
      title: "Names session A from another workspace",
      agenticContext: { parentSessionId: "session-a" },
    },
    now,
    { taskId: "task-other-workspace" },
  );
  storage.tasks.create({ workspaceId: "workspace-a", title: "Unlinked task" }, now, { taskId: "task-unlinked" });
  // Wrapped: the async storage proxy is thenable, so an async function cannot return it bare.
  return { storage: createSqliteAsyncStorage(storage) };
}

describe("assertCallerPolicyScopeBound", () => {
  it("accepts the session's own delegation run, turn orchestration run, and durable run", async () => {
    const { storage } = await harness();

    for (const policyRunId of ["delegation-a", "turn-orchestration-a", "durable-a"]) {
      await expect(assertCallerPolicyScopeBound(storage, "session-a", { policyRunId })).resolves.toBeUndefined();
    }
  });

  it("rejects a run of another session and a run that does not exist with the same conflict", async () => {
    const { storage } = await harness();

    for (const policyRunId of ["delegation-b", "durable-b", "missing-run"]) {
      const rejection = assertCallerPolicyScopeBound(storage, "session-a", { policyRunId });
      await expect(rejection).rejects.toBeInstanceOf(ConflictError);
      await expect(rejection).rejects.toMatchObject({
        message: `policyRunId ${policyRunId} does not belong to Chat session session-a.`,
        httpStatus: 409,
      });
    }
  });

  it("accepts a task of the session's delegation runs or a same-workspace task linked to the session", async () => {
    const { storage } = await harness();

    for (const policyTaskId of ["task-delegated-a", "chat-orchestration:turn-a", "task-agentic-a"]) {
      await expect(assertCallerPolicyScopeBound(storage, "session-a", { policyTaskId })).resolves.toBeUndefined();
    }
    // The child session named by the task's agentic context may use it too.
    await storage.chatSessionMeta.ensure("session-a-child", "2026-09-26T00:00:00.000Z", "workspace-a");
    await expect(
      assertCallerPolicyScopeBound(storage, "session-a-child", { policyTaskId: "task-agentic-a" }),
    ).resolves.toBeUndefined();
  });

  it("rejects a task of another session, another workspace, no link, or no record", async () => {
    const { storage } = await harness();

    for (const policyTaskId of ["task-delegated-b", "task-other-workspace", "task-unlinked", "missing-task"]) {
      await expect(assertCallerPolicyScopeBound(storage, "session-a", { policyTaskId })).rejects.toMatchObject({
        message: `policyTaskId ${policyTaskId} does not belong to Chat session session-a.`,
        httpStatus: 409,
      });
    }
  });

  it("checks both ids and rejects when either is foreign", async () => {
    const { storage } = await harness();

    await expect(
      assertCallerPolicyScopeBound(storage, "session-a", {
        policyRunId: "delegation-a",
        policyTaskId: "task-delegated-a",
      }),
    ).resolves.toBeUndefined();
    await expect(
      assertCallerPolicyScopeBound(storage, "session-a", {
        policyRunId: "delegation-a",
        policyTaskId: "task-delegated-b",
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      assertCallerPolicyScopeBound(storage, "session-a", {
        policyRunId: "delegation-b",
        policyTaskId: "task-delegated-a",
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("reads nothing when no id is given and trims ids before checking them", async () => {
    const read = vi.fn(async () => {
      throw new Error("should not read");
    });
    const unreadable: ChatPolicyScopeStorage = {
      chatSessionMeta: { get: read },
      chatDelegationRuns: { get: read, listBySession: read },
      durableRuns: { getRun: read },
      tasks: { get: read },
    };
    await expect(
      assertCallerPolicyScopeBound(unreadable, "session-a", { policyRunId: "  ", policyTaskId: "" }),
    ).resolves.toBeUndefined();
    expect(read).not.toHaveBeenCalled();

    const { storage } = await harness();
    await expect(
      assertCallerPolicyScopeBound(storage, "session-a", { policyRunId: " delegation-a " }),
    ).resolves.toBeUndefined();
  });

  it("surfaces a storage failure instead of treating it as a missing record", async () => {
    const failure = new Error("storage unavailable");
    const failing: ChatPolicyScopeStorage = {
      chatSessionMeta: { get: vi.fn() },
      chatDelegationRuns: { get: vi.fn(async () => Promise.reject(failure)), listBySession: vi.fn() },
      durableRuns: { getRun: vi.fn() },
      tasks: { get: vi.fn() },
    };

    await expect(assertCallerPolicyScopeBound(failing, "session-a", { policyRunId: "run-1" })).rejects.toBe(failure);
  });
});
