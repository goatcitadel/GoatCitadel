import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Storage, createSqliteAsyncStorage } from "@goatcitadel/storage";
import {
  assertChatTurnToolUseOpen,
  claimArtifactRetry,
  closeChatTurnToolUse,
  readChatTurnControl,
} from "./chat-turn-control.js";
import {
  resolveConfirmedDelegation,
  suggestActiveTurnDelegationRoles,
  reconcileWaitingConfirmedDelegations,
  CONFIRMED_DELEGATION_WORKFLOW,
  CONFIRMED_DELEGATION_WAKE_EVENT,
} from "./chat-confirmed-delegation-service.js";
import type { ChatTurnAgentRunnerInput } from "./chat-turn-agent-runner.js";
import { commitDurableWakeTransition } from "./durable-wake-transition-service.js";

const opened: { root: string; db: Storage }[] = [];
afterEach(() => {
  for (const { root, db } of opened.splice(0)) {
    db.close();
    if (!path.basename(root).startsWith("gc-chat-control-")) throw new Error("Unexpected test cleanup path");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gc-chat-control-"));
  const options = {
    dbPath: path.join(root, "test.sqlite"),
    transcriptsDir: path.join(root, "transcripts"),
    auditDir: path.join(root, "audit"),
  };
  const db = new Storage(options);
  const resource = { root, db };
  opened.push(resource);
  let storage = createSqliteAsyncStorage(db);
  function seed(turnId = "parent", parentDelegationStepId?: string) {
    const sessionId = `session-${turnId}`;
    db.chatMessages.upsert({
      messageId: `user-${turnId}`,
      sessionId,
      role: "user",
      sourceAuthority: "operator",
      actorType: "user",
      actorId: "operator",
      content: "test task",
      timestamp: new Date().toISOString(),
      parentDelegationStepId,
    });
    const run = db.durableRuns.createRun({
      workflowKey: "chat.turn.execute",
      status: "running",
      payload: { sessionId, turnId },
      metadata: { unrelated: "preserve" },
    });
    db.chatTurnTraces.create({
      turnId,
      sessionId,
      userMessageId: `user-${turnId}`,
      status: "running",
      mode: "chat",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      startedAt: new Date().toISOString(),
      durable: { runId: run.runId, status: "running" },
    });
    return { sessionId, turnId, runId: run.runId };
  }
  const parent = seed();
  return {
    db,
    get storage() {
      return storage;
    },
    parent,
    seed,
    reopen() {
      resource.db.close();
      resource.db = new Storage(options);
      storage = createSqliteAsyncStorage(resource.db);
    },
  };
}
const denial = {
  outcome: "denied" as const,
  approvalId: "approval-deny",
  actorId: "operator",
  closedAt: "2026-09-19T00:00:00.000Z",
};

describe("durable turn consent", () => {
  it("claims one artifact retry across concurrent attempts and process reopen", async () => {
    const h = fixture();
    const { sessionId, turnId, runId } = h.parent;
    expect(
      await Promise.all([
        claimArtifactRetry(h.storage, sessionId, turnId),
        claimArtifactRetry(h.storage, sessionId, turnId),
      ]),
    ).toEqual([true, false]);
    expect((await h.storage.durableRuns.getRun(runId)).metadata?.unrelated).toBe("preserve");
    h.reopen();
    expect(await claimArtifactRetry(h.storage, sessionId, turnId)).toBe(false);
  });
  it("rolls back retry and denial together when the enclosing lifecycle commit fails", async () => {
    const h = fixture();
    const { sessionId, turnId } = h.parent;
    await expect(
      h.storage.runImmediateTransaction(async () => {
        await claimArtifactRetry(h.storage, sessionId, turnId);
        await closeChatTurnToolUse(h.storage, sessionId, turnId, denial);
        throw new Error("persistence failed");
      }),
    ).rejects.toThrow("persistence failed");
    expect(await readChatTurnControl(h.storage, sessionId, turnId)).toEqual({});
  });
  it("propagates a child denial to its parent and sibling, across reopen, but not a new turn", async () => {
    const h = fixture();
    h.db.chatDelegationRuns.create({
      runId: "delegation",
      parentRunId: h.parent.runId,
      sessionId: h.parent.sessionId,
      taskId: "task",
      objective: "two children",
      roles: ["qa", "researcher"],
      mode: "sequential",
    });
    const child = h.seed("child", "child-step"),
      sibling = h.seed("sibling", "sibling-step");
    for (const [index, turn] of [child, sibling].entries())
      h.db.chatDelegationSteps.create({
        stepId: `${turn.turnId}-step`,
        runId: "delegation",
        role: "qa",
        index,
        status: "running",
        childSessionId: turn.sessionId,
        childTurnId: turn.turnId,
        durableRunId: turn.runId,
      });
    await closeChatTurnToolUse(h.storage, child.sessionId, child.turnId, denial);
    h.reopen();
    for (const turn of [h.parent, child, sibling]) {
      await expect(assertChatTurnToolUseOpen(h.storage, turn.sessionId, turn.turnId)).rejects.toThrow("You denied");
    }
    expect((await readChatTurnControl(h.storage, h.parent.sessionId, h.parent.turnId)).toolClosure).toEqual(denial);
    await expect(assertChatTurnToolUseOpen(h.storage, "new-session", "new-turn")).resolves.toBeUndefined();
  });
  it("rejects mismatched session ownership and inherits canonical Stop without text inference", async () => {
    const h = fixture();
    await expect(assertChatTurnToolUseOpen(h.storage, "wrong-session", h.parent.turnId)).rejects.toThrow(
      "another session",
    );
    await h.storage.chatTurnTraces.patch(h.parent.turnId, { status: "cancelled" });
    expect((await readChatTurnControl(h.storage, h.parent.sessionId, h.parent.turnId)).toolClosure?.outcome).toBe(
      "withdrawn",
    );
  });
});

describe("active-turn delegation confirmation", () => {
  function input(h: ReturnType<typeof fixture>): ChatTurnAgentRunnerInput {
    return {
      ...h.parent,
      userMessageId: "user-parent",
      content: "Use one QA specialist to check this plan.",
      mode: "chat",
      providerId: "provider",
      model: "model",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      subagentPolicy: "ask_when_useful",
      historyMessages: [],
      capabilityProfile: { hashes: { profileHash: "frozen" } } as never,
    };
  }
  it("does not plan a simple answer, an off turn, or explicit no-agents work", async () => {
    expect(suggestActiveTurnDelegationRoles("What is 17 + 25?")).toEqual([]);
    expect(suggestActiveTurnDelegationRoles("Use a researcher. Do not use subagents.")).toEqual([]);
    const h = fixture();
    const runDelegation = vi.fn();
    expect(
      await resolveConfirmedDelegation({ storage: h.storage, runDelegation }, { ...input(h), subagentPolicy: "off" }),
    ).toBeUndefined();
    expect(runDelegation).not.toHaveBeenCalled();
  });
  it("persists a single-specialist plan and resumes only its exact confirmation", async () => {
    const h = fixture();
    const request = input(h);
    const runDelegation = vi.fn(
      async () => ({ runId: "delegation", steps: [], citations: [], stitchedOutput: "QA result" }) as never,
    );
    const host = { storage: h.storage, runDelegation };
    const first = await resolveConfirmedDelegation(host, request);
    expect(first).toMatchObject({ prompt: { title: "Delegate this task?" } });
    if (!first || !("prompt" in first)) throw new Error("missing prompt");
    const proposalId = first.prompt.promptId;
    expect(await resolveConfirmedDelegation(host, request)).toEqual(first);
    expect(runDelegation).not.toHaveBeenCalled();
    const run = await h.storage.durableRuns.getRun(h.parent.runId);
    await h.storage.durableRuns.updateRun({
      runId: run.runId,
      status: run.status,
      payload: {
        ...run.payload,
        userInputResponses: [{ promptId: proposalId, response: { kind: "single_select", optionId: "run_plan" } }],
      },
    });
    h.reopen();
    await resolveConfirmedDelegation({ ...host, storage: h.storage }, request);
    await resolveConfirmedDelegation({ ...host, storage: h.storage }, request);
    expect(runDelegation).toHaveBeenCalledWith(
      request.sessionId,
      expect.objectContaining({ roles: ["qa"], objective: request.content }),
      expect.objectContaining({
        stableRunKey: proposalId,
        executionPlanId: proposalId,
        admittedProfile: request.capabilityProfile,
      }),
    );
    expect(runDelegation.mock.calls[0]?.[2]).toMatchObject({ stableRunKey: proposalId });
    await expect(
      resolveConfirmedDelegation({ ...host, storage: h.storage }, { ...request, model: "changed" }),
    ).rejects.toThrow("admitted turn");
    await closeChatTurnToolUse(h.storage, request.sessionId, request.turnId, denial);
    await expect(resolveConfirmedDelegation({ ...host, storage: h.storage }, request)).rejects.toThrow("You denied");
  });
  it("declining the stored plan resumes direct chat without dispatch", async () => {
    const h = fixture();
    const request = input(h);
    const runDelegation = vi.fn();
    const host = { storage: h.storage, runDelegation };
    const first = await resolveConfirmedDelegation(host, request);
    if (!first || !("prompt" in first)) throw new Error("missing prompt");
    const run = await h.storage.durableRuns.getRun(h.parent.runId);
    await h.storage.durableRuns.updateRun({
      runId: run.runId,
      status: run.status,
      payload: {
        ...run.payload,
        userInputResponses: [
          { promptId: first.prompt.promptId, response: { kind: "single_select", optionId: "answer_directly" } },
        ],
      },
    });
    expect(await resolveConfirmedDelegation(host, request)).toBeUndefined();
    expect((await readChatTurnControl(h.storage, request.sessionId, request.turnId)).delegationProposal?.declined).toBe(
      true,
    );
    expect(runDelegation).not.toHaveBeenCalled();
  });

  it("commits the confirmed parent trace and wake together, rejecting stale or failed wakes", async () => {
    const h = fixture();
    const prompt = await resolveConfirmedDelegation({ storage: h.storage, runDelegation: vi.fn() }, input(h));
    if (!prompt || !("prompt" in prompt)) throw new Error("missing prompt");
    h.db.chatDelegationRuns.create({
      runId: "confirmed-run",
      parentRunId: h.parent.runId,
      sessionId: h.parent.sessionId,
      taskId: "confirmed-task",
      objective: input(h).content,
      roles: ["qa"],
      mode: "sequential",
      workflowTemplate: CONFIRMED_DELEGATION_WORKFLOW,
      executionPlanId: prompt.prompt.promptId,
    });
    const parent = await h.storage.durableRuns.getRun(h.parent.runId);
    const current = await h.storage.durableRuns.updateRun({
      runId: parent.runId,
      status: "waiting",
      payload: {
        ...parent.payload,
        version: "chat.turn.execute.v2",
        userInputResponses: [
          { promptId: prompt.prompt.promptId, response: { kind: "single_select", optionId: "run_plan" } },
        ],
      },
      metadata: {
        ...parent.metadata,
        waitForEvent: { eventKey: CONFIRMED_DELEGATION_WAKE_EVENT, correlationId: "confirmed-run" },
      },
    });
    await h.storage.chatTurnTraces.patch(h.parent.turnId, {
      status: "waiting_for_tool",
      routing: { confirmedDelegation: { runId: "confirmed-run", proposalId: prompt.prompt.promptId, waiting: true } },
    });
    const port = {
      prepareMetadata: vi.fn(async () => ({ ...parent.metadata })),
      recordTimeline: vi.fn(async () => {}),
    };
    const event = { eventKey: CONFIRMED_DELEGATION_WAKE_EVENT, correlationId: "confirmed-run" };
    const wake = (wakeEvent = event) =>
      commitDurableWakeTransition(h.storage, port, current, current.runId, wakeEvent, new Date().toISOString());
    await expect(wake({ ...event, correlationId: "other-plan" })).rejects.toThrow("stored plan");
    port.recordTimeline.mockRejectedValueOnce(new Error("timeline persistence failed"));
    await expect(wake()).rejects.toThrow("timeline persistence failed");
    expect((await h.storage.chatTurnTraces.get(h.parent.turnId)).status).toBe("waiting_for_tool");
    expect((await h.storage.durableRuns.getRun(current.runId)).status).toBe("waiting");
    await expect(wake()).resolves.toMatchObject({ status: "queued" });
    h.reopen();
    expect((await h.storage.chatTurnTraces.get(h.parent.turnId)).status).toBe("queued");
    expect((await h.storage.durableRuns.getRun(current.runId)).status).toBe("queued");
    await expect(wake()).rejects.toThrow("stored plan");
  });

  it("recovers a child completed before its parent parked, without waking an unsettled generation", async () => {
    const h = fixture();
    const prompt = await resolveConfirmedDelegation({ storage: h.storage, runDelegation: vi.fn() }, input(h));
    if (!prompt || !("prompt" in prompt)) throw new Error("missing prompt");
    h.db.chatDelegationRuns.create({
      runId: "confirmed-run",
      parentRunId: h.parent.runId,
      sessionId: h.parent.sessionId,
      taskId: "confirmed-task",
      objective: input(h).content,
      roles: ["qa"],
      mode: "sequential",
      workflowTemplate: CONFIRMED_DELEGATION_WORKFLOW,
      executionPlanId: prompt.prompt.promptId,
    });
    const child = h.seed("confirmed-child", "confirmed-step");
    h.db.chatDelegationSteps.create({
      stepId: "confirmed-step",
      runId: "confirmed-run",
      role: "qa",
      index: 0,
      status: "running",
      childSessionId: child.sessionId,
      childTurnId: child.turnId,
      durableRunId: child.runId,
    });
    await h.storage.chatTurnTraces.patch(child.turnId, { status: "completed" });
    const parent = await h.storage.durableRuns.getRun(h.parent.runId);
    await h.storage.durableRuns.updateRun({
      runId: parent.runId,
      status: "waiting",
      metadata: {
        ...parent.metadata,
        waitForEvent: { eventKey: CONFIRMED_DELEGATION_WAKE_EVENT, correlationId: "confirmed-run" },
      },
    });
    h.reopen();
    const materialize = vi.fn(async (value) => {
      expect(value).toMatchObject({
        delegationRunId: "confirmed-run",
        stepId: "confirmed-step",
        childSessionId: child.sessionId,
        childTurnId: child.turnId,
        durableRunId: child.runId,
      });
      await h.storage.chatDelegationSteps.patch("confirmed-step", { status: "completed", output: "QA result" });
      return { outcome: "materialized" } as never;
    });
    const reconcileWaiting = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const wake = vi.fn(async (runId) => {
      await h.storage.durableRuns.updateRun({ runId, status: "queued" });
    });
    const host = { storage: h.storage, materialize, reconcileWaiting, wake };
    await reconcileWaitingConfirmedDelegations(host);
    expect(materialize).toHaveBeenCalledOnce();
    expect(wake).not.toHaveBeenCalled();
    await reconcileWaitingConfirmedDelegations(host);
    expect(wake).toHaveBeenCalledExactlyOnceWith(h.parent.runId, {
      eventKey: CONFIRMED_DELEGATION_WAKE_EVENT,
      correlationId: "confirmed-run",
      payload: { delegationRunId: "confirmed-run", recovered: true },
    });
    await reconcileWaitingConfirmedDelegations(host);
    expect(materialize).toHaveBeenCalledOnce();
    expect(wake).toHaveBeenCalledOnce();
  });
});
