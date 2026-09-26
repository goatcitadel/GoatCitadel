import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJsonString, ConflictError } from "@goatcitadel/contracts";
import { createSqliteAsyncStorage, Storage } from "@goatcitadel/storage";
import { assertCallerPolicyScopeBound, type ChatPolicyScopeStorage } from "./chat-policy-scope-service.js";

const resources: Array<{ root: string; storage: Storage }> = [];

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    resource.storage.close();
    await fs.rm(resource.root, { recursive: true, force: true });
  }
});

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** A durable Chat turn payload that passes readDurableChatTurnExecutionPayloadAuthority. */
function chatTurnPayload(runId: string, sessionId: string, workspaceId: string): Record<string, unknown> {
  const request = { content: "Continue the review." };
  const admissionMaterialSha256 = sha256(canonicalJsonString({ version: 2, request }));
  return {
    version: "chat.turn.execute.v2",
    admissionId: `admission-${runId}`,
    sessionIncarnationId: `incarnation-${sessionId}`,
    admissionMaterialSha256,
    workspaceId,
    admissionAggregateRevision: 1,
    admissionControllerGeneration: 1,
    effectiveRequestMaterialSha256: sha256(canonicalJsonString({ version: 1, admissionMaterialSha256, request })),
    policyRunIdDerivation: { version: 1, kind: "durable_run_id", runId },
    requestActor: { actorKind: "operator", actorId: "operator-1", operatorId: "operator-1" },
    sessionId,
    turnId: `turn-${runId}`,
    userMessageId: `user-${runId}`,
    assistantMessageId: `assistant-${runId}`,
    branchKind: "append",
    threadEventType: "chat_thread_turn_appended",
    request,
  };
}

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
  const durable = (runId: string, workflowKey: string, payload: Record<string, unknown>) =>
    storage.durableRuns.createRun({ runId, workflowKey, payload, now });
  durable("durable-a", "chat.turn.execute", chatTurnPayload("durable-a", "session-a", "workspace-a"));
  durable("durable-b", "chat.turn.execute", chatTurnPayload("durable-b", "session-b", "workspace-a"));
  // Runs whose payload names session A without being its Chat turn authority.
  durable("durable-api-a", "connector.delivery", { sessionId: "session-a" });
  durable("durable-bare-chat-a", "chat.turn.execute", { version: "chat.turn.execute.v2", sessionId: "session-a" });
  durable(
    "durable-other-workspace-a",
    "chat.turn.execute",
    chatTurnPayload("durable-other-workspace-a", "session-a", "workspace-other"),
  );
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

  it("rejects a durable run whose payload names the session without being its Chat turn authority", async () => {
    const { storage } = await harness();

    // Any payload can be written through the durable API; only a verified
    // chat.turn.execute payload for the session's workspace counts.
    for (const policyRunId of ["durable-api-a", "durable-bare-chat-a", "durable-other-workspace-a"]) {
      await expect(assertCallerPolicyScopeBound(storage, "session-a", { policyRunId })).rejects.toMatchObject({
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

  it("accepts a pair only when it is one delegation run and that run's own task", async () => {
    const { storage } = await harness();

    for (const [policyRunId, policyTaskId] of [
      ["delegation-a", "task-delegated-a"],
      ["turn-orchestration-a", "chat-orchestration:turn-a"],
    ]) {
      await expect(
        assertCallerPolicyScopeBound(storage, "session-a", { policyRunId, policyTaskId }),
      ).resolves.toBeUndefined();
    }
    // Each id belongs to session A on its own, but the task is not the run's own task.
    for (const [policyRunId, policyTaskId] of [
      ["delegation-a", "chat-orchestration:turn-a"],
      ["delegation-a", "task-agentic-a"],
      ["durable-a", "task-delegated-a"],
      ["delegation-a", "task-delegated-b"],
    ]) {
      await expect(
        assertCallerPolicyScopeBound(storage, "session-a", { policyRunId, policyTaskId }),
      ).rejects.toMatchObject({
        message: `policyTaskId ${policyTaskId} is not the task of policyRunId ${policyRunId}.`,
        httpStatus: 409,
      });
    }
    await expect(
      assertCallerPolicyScopeBound(storage, "session-a", {
        policyRunId: "delegation-b",
        policyTaskId: "task-delegated-b",
      }),
    ).rejects.toMatchObject({ message: "policyRunId delegation-b does not belong to Chat session session-a." });
  });

  it("finds the task of an older delegation run behind many newer ones", async () => {
    const { storage } = await harness();
    for (let index = 0; index < 510; index += 1) {
      await storage.chatDelegationRuns.create({
        runId: `newer-${index}`,
        sessionId: "session-a",
        taskId: `task-newer-${index}`,
        objective: "Newer delegation",
        roles: ["QA"],
        mode: "sequential",
        startedAt: new Date(Date.parse("2026-09-27T00:00:00.000Z") + index * 1000).toISOString(),
      });
    }

    await expect(
      assertCallerPolicyScopeBound(storage, "session-a", { policyTaskId: "task-delegated-a" }),
    ).resolves.toBeUndefined();
  });

  it("reads nothing when no id is given and trims ids before checking them", async () => {
    const read = vi.fn(async () => {
      throw new Error("should not read");
    });
    const unreadable: ChatPolicyScopeStorage = {
      chatSessionMeta: { get: read },
      chatDelegationRuns: { get: read, findLatestBySessionAndTask: read },
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
      chatDelegationRuns: { get: vi.fn(async () => Promise.reject(failure)), findLatestBySessionAndTask: vi.fn() },
      durableRuns: { getRun: vi.fn() },
      tasks: { get: vi.fn() },
    };

    await expect(assertCallerPolicyScopeBound(failing, "session-a", { policyRunId: "run-1" })).rejects.toBe(failure);
  });
});
