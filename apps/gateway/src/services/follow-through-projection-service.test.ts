import { expect, it, vi } from "vitest";
import { FollowThroughProjectionService } from "./follow-through-projection-service.js";
function fixture() {
  const commitment = {
    commitmentId: "c",
    sessionId: "s",
    workspaceId: "A",
    revision: 3,
    status: "proposed",
    dueAt: "2027-01-02T12:00:00Z",
    suggestedText: "Check the result",
  };
  const decide = vi.fn(async () => ({ ...commitment, status: "pending", revision: 4 }));
  const deps = {
    storage: {
      chatSessionMeta: { get: async () => ({ workspaceId: "A", origin: "operator", lifecycleStatus: "active" }) },
      sessions: { getBySessionId: async () => ({ kind: "dm" }) },
      agentCommitments: { listBySession: async () => [commitment], decideSuggestion: decide },
      sessionAutonomyPrefs: { get: async () => undefined },
      heartbeatOccurrences: { findUnresolved: async () => undefined },
      cronRuns: { get: async () => undefined },
    },
    cron: {
      listCronJobs: async () => [
        {
          jobId: "j",
          revision: 2,
          action: "agent_turn",
          name: "Watch result",
          enabled: true,
          schedule: "30 9 * * * America/Los_Angeles",
          actionConfig: { agentTurn: { sessionId: "s", prompt: "Check result" } },
        },
      ],
      setCronJobEnabled: vi.fn(),
      runCronJobNow: vi.fn(),
    },
    readFlags: async () => ({
      durableKernelV1Enabled: true,
      scheduledChatTurnsV1Enabled: true,
      commitmentScheduledTurnsV1Enabled: true,
      autonomyV1Disabled: false,
    }),
    readProactiveRuns: async () => [],
  };
  return { deps, decide, service: new FollowThroughProjectionService(deps as never) };
}
it("projects scoped canonical owners without enrolling a session, preserving the selected zone and review requirement", async () => {
  const f = fixture(),
    result = await f.service.listFollowThrough("s", "A");
  expect(result.items.find((item) => item.owner.kind === "commitment")).toMatchObject({
    state: "awaiting_review",
    actions: [
      { action: "accept", label: "Accept follow-up" },
      { action: "dismiss", label: "Dismiss" },
    ],
  });
  expect(result.items.find((item) => item.owner.kind === "schedule")).toMatchObject({
    timezone: "America/Los_Angeles",
    delivery: "This conversation",
  });
  expect(f.decide).not.toHaveBeenCalled();
  expect(f.deps.cron.runCronJobNow).not.toHaveBeenCalled();
  await expect(f.service.listFollowThrough("s", "B")).rejects.toThrow();
});
it("decides one exact suggestion and rejects a stale snapshot or foreign owner", async () => {
  const f = fixture();
  await f.service.requestFollowThroughAction({
    sessionId: "s",
    workspaceId: "A",
    owner: { kind: "commitment", ownerId: "c" },
    action: "accept",
    expectedRevision: 3,
  });
  expect(f.decide).toHaveBeenCalledWith({
    commitmentId: "c",
    sessionId: "s",
    workspaceId: "A",
    expectedRevision: 3,
    decision: "accept",
  });
  await expect(
    f.service.requestFollowThroughAction({
      sessionId: "s",
      workspaceId: "A",
      owner: { kind: "schedule", ownerId: "foreign" },
      action: "run_now",
      expectedRevision: 2,
    }),
  ).rejects.toThrow();
  await expect(
    f.service.requestFollowThroughAction({
      sessionId: "s",
      workspaceId: "A",
      owner: { kind: "schedule", ownerId: "j" },
      action: "pause",
      expectedRevision: 1,
    }),
  ).rejects.toThrow();
});
it("exposes ambiguous delivery as unknown with no resend action", async () => {
  const f = fixture();
  f.deps.storage.cronRuns.get = async () => ({ status: "manual_reconciliation_required", runId: "r" }) as never;
  f.deps.cron.listCronJobs = async () =>
    [
      {
        jobId: "j",
        lastRunId: "r",
        revision: 2,
        action: "agent_turn",
        name: "Watch",
        enabled: true,
        schedule: "0 9 * * * UTC",
        actionConfig: { agentTurn: { sessionId: "s", prompt: "Check" } },
      },
    ] as never;
  const item = (await f.service.listFollowThrough("s", "A")).items.find((item) => item.owner.kind === "schedule")!;
  expect(item.state).toBe("unknown");
  expect(item.actions.some((action) => action.action === "run_now")).toBe(false);
});
it("can stop one exact approval-waiting occurrence through its owner, never a replacement or delivery", async () => {
  const f = fixture(),
    cancel = vi.fn(async () => {});
  Object.assign(f.deps, { cancelCurrentRun: cancel });
  f.deps.storage.cronRuns.get = async () =>
    ({ status: "waiting", runId: "r", phase: "chat_execution", childSessionId: "child", childTurnId: "turn" }) as never;
  f.deps.cron.listCronJobs = async () =>
    [
      {
        jobId: "j",
        activeRunId: "r",
        revision: 2,
        action: "agent_turn",
        name: "Watch",
        enabled: true,
        schedule: "0 9 * * * UTC",
        actionConfig: { agentTurn: { sessionId: "s", prompt: "Check" } },
      },
    ] as never;
  const item = (await f.service.listFollowThrough("s", "A")).items.find((item) => item.owner.kind === "schedule")!;
  expect(item.actions).toContainEqual({ action: "cancel_run", label: "Stop current run" });
  await expect(
    f.service.requestFollowThroughAction({
      sessionId: "s",
      workspaceId: "A",
      owner: item.owner,
      action: "cancel_run",
      expectedRevision: 2,
      expectedRunId: "different",
    } as never),
  ).rejects.toThrow();
  expect(cancel).not.toHaveBeenCalled();
  await f.service.requestFollowThroughAction({
    sessionId: "s",
    workspaceId: "A",
    owner: item.owner,
    action: "cancel_run",
    expectedRevision: 2,
    expectedRunId: "r",
  } as never);
  expect(cancel).toHaveBeenCalledWith({
    jobId: "j",
    runId: "r",
    expectedRevision: 2,
    workspaceId: "A",
    sessionId: "s",
    actorId: "operator",
  });
  f.deps.storage.cronRuns.get = async () =>
    ({ status: "waiting", runId: "r", phase: "delivery", childSessionId: "child", childTurnId: "turn" }) as never;
  expect(
    (await f.service.listFollowThrough("s", "A")).items
      .find((item) => item.owner.kind === "schedule")!
      .actions.some((action) => action.action === "cancel_run"),
  ).toBe(false);
});
it("a finished one-shot stays completed without Run now, while missing receipts remain unknown", async () => {
  const f = fixture();
  f.deps.cron.listCronJobs = async () =>
    [
      {
        jobId: "j",
        lastRunId: "r",
        revision: 2,
        action: "agent_turn",
        name: "One check",
        enabled: true,
        schedule: "0 0 * * * UTC",
        actionConfig: {
          agentTurn: {
            sessionId: "s",
            prompt: "Check",
            oneShot: { at: "2026-11-19T10:00:00.000Z", timezone: "America/Los_Angeles" },
          },
        },
      },
    ] as never;
  f.deps.storage.cronRuns.get = async () =>
    ({
      status: "completed",
      runId: "r",
      actionSnapshot: { actionConfig: { agentTurn: { oneShot: { at: "2026-11-19T10:00:00.000Z" } } } },
    }) as never;
  const item = (await f.service.listFollowThrough("s", "A")).items.find((item) => item.owner.kind === "schedule")!;
  expect(item).toMatchObject({ state: "completed", timezone: "America/Los_Angeles" });
  expect(item.actions.some((action) => action.action === "run_now")).toBe(false);
  f.deps.storage.cronRuns.get = async () => undefined;
  const missing = (await f.service.listFollowThrough("s", "A")).items.find((item) => item.owner.kind === "schedule")!;
  expect(missing.state).toBe("unknown");
  expect(missing.actions.some((action) => action.action === "run_now")).toBe(false);
});
it("explains an event trigger rather than inventing the placeholder clock schedule as its next check", async () => {
  const f = fixture();
  f.deps.cron.listCronJobs = async () =>
    [
      {
        jobId: "j",
        revision: 2,
        action: "agent_turn",
        name: "Watch result",
        enabled: true,
        schedule: "0 0 * * * UTC",
        actionConfig: {
          agentTurn: {
            sessionId: "s",
            prompt: "Check",
            eventWake: {
              version: 1,
              eventType: "subagent.end",
              hookId: "h",
              workspaceId: "A",
              sourceSessionId: "s",
              notBefore: "2026-11-19T10:00:00.000Z",
              timezone: "Europe/London",
            },
          },
        },
      },
    ] as never;
  const item = (await f.service.listFollowThrough("s", "A")).items.find((item) => item.owner.kind === "schedule")!;
  expect(item.timezone).toBe("Europe/London");
  expect(item.nextCheckAt).toBeUndefined();
  expect(item.reason).toContain("verified subagent completion");
});
it("returns the exact admitted run after a lost response without dispatching again, even when Run now is no longer offered", async () => {
  const f = fixture(),
    operationId = "lost-response-1234567890";
  const job = {
    jobId: "j",
    lastRunId: "r",
    executionGeneration: 1,
    revision: 2,
    action: "agent_turn",
    name: "One check",
    enabled: true,
    schedule: "0 9 * * * UTC",
    actionConfig: {
      agentTurn: { sessionId: "s", prompt: "Check", oneShot: { at: "2026-11-19T10:00:00.000Z", timezone: "UTC" } },
    },
  };
  const run = {
    status: "completed",
    runId: "r",
    jobId: "j",
    jobRevision: 2,
    executionGeneration: 1,
    actionSnapshot: {
      actionConfig: job.actionConfig,
      operatorAction: { actorId: "operator", operationId, expectedExecutionGeneration: 0 },
    },
  };
  f.deps.cron.listCronJobs = async () => [job] as never;
  f.deps.storage.cronRuns.get = async () => run as never;
  Object.assign(f.deps.storage, { cronJobs: { get: async () => job } });
  Object.assign(f.deps.storage.cronRuns, { getByAdmission: async () => run });
  const result = await f.service.requestFollowThroughAction({
    sessionId: "s",
    workspaceId: "A",
    owner: { kind: "schedule", ownerId: "j" },
    action: "run_now",
    expectedRevision: 2,
    expectedExecutionGeneration: 0,
    operationId,
  } as never);
  expect(result).toMatchObject({ actionReceipt: { operationId, runId: "r", state: "completed" } });
  expect(f.deps.cron.runCronJobNow).not.toHaveBeenCalled();
});
it("distinguishes a refused Run now from an unavailable receipt after requesting the run", async () => {
  const f = fixture();
  const [job] = await f.deps.cron.listCronJobs();
  const reviewedJob = { ...job!, executionGeneration: 0 };
  f.deps.cron.listCronJobs = async () => [reviewedJob];
  Object.assign(f.deps.storage, { cronJobs: { get: async () => reviewedJob } });
  Object.assign(f.deps.storage.cronRuns, { getByAdmission: async () => undefined });
  const request = {
    sessionId: "s",
    workspaceId: "A",
    owner: { kind: "schedule", ownerId: "j" },
    action: "run_now",
    expectedRevision: 2,
    expectedExecutionGeneration: 0,
    operationId: "missing-receipt-1234",
  } as const;
  await expect(f.service.requestFollowThroughAction({ ...request, expectedRevision: 1 })).rejects.toMatchObject({
    code: "FOLLOW_THROUGH_RUN_NOT_ADMITTED",
    httpStatus: 409,
  });
  expect(f.deps.cron.runCronJobNow).not.toHaveBeenCalled();

  await expect(f.service.requestFollowThroughAction(request)).rejects.toMatchObject({
    httpStatus: 503,
    message: expect.stringContaining("receipt is unavailable"),
  });
  expect(f.deps.cron.runCronJobNow).toHaveBeenCalledOnce();
});
it("requires the actual reviewed execution generation and explains a changed profile even for an ended one-shot", async () => {
  const f = fixture();
  Object.assign(f.deps.storage.cronRuns, { getByAdmission: async () => undefined });
  await expect(
    f.service.requestFollowThroughAction({
      sessionId: "s",
      workspaceId: "A",
      owner: { kind: "schedule", ownerId: "j" },
      action: "run_now",
      expectedRevision: 2,
      operationId: "missing-generation-1234",
    }),
  ).rejects.toThrow(/generation|execution/i);
});
it("does not claim an inert changed-profile fallback completed the one-shot's model work", async () => {
  const f = fixture();
  f.deps.cron.listCronJobs = async () =>
    [
      {
        jobId: "j",
        lastRunId: "r",
        executionGeneration: 1,
        revision: 2,
        action: "agent_turn",
        name: "One check",
        enabled: true,
        schedule: "0 9 * * * UTC",
        actionConfig: {
          agentTurn: { sessionId: "s", prompt: "Check", oneShot: { at: "2026-11-19T10:00:00.000Z", timezone: "UTC" } },
        },
      },
    ] as never;
  f.deps.storage.cronRuns.get = async () =>
    ({
      status: "completed",
      runId: "r",
      outcome: { profileWarning: "The reviewed profile changed; no model work ran." },
      actionSnapshot: { actionConfig: { agentTurn: { oneShot: { at: "2026-11-19T10:00:00.000Z" } } } },
    }) as never;
  expect(
    (await f.service.listFollowThrough("s", "A")).items.find((item) => item.owner.kind === "schedule"),
  ).toMatchObject({ state: "awaiting_review", reason: "The reviewed profile changed; no model work ran." });
});

it("does not advertise a next one-shot check while paused or awaiting outcome inspection", async () => {
  const f = fixture();
  const job = {
    jobId: "paused-once",
    revision: 1,
    executionGeneration: 0,
    name: "Paused one-shot",
    action: "agent_turn",
    enabled: false,
    schedule: "0 0 * * * UTC",
    actionConfig: {
      agentTurn: { sessionId: "s", prompt: "Check", oneShot: { at: "2026-11-19T10:00:00.000Z", timezone: "UTC" } },
    },
  };
  f.deps.cron.listCronJobs = async () => [job] as never;
  let item = (await f.service.listFollowThrough("s", "A")).items.find((item) => item.owner.kind === "schedule")!;
  expect(item.state).toBe("paused");
  expect(item.nextCheckAt).toBeUndefined();
  f.deps.cron.listCronJobs = async () => [{ ...job, enabled: true, lastRunId: "missing" }] as never;
  f.deps.storage.cronRuns.get = async () => undefined;
  item = (await f.service.listFollowThrough("s", "A")).items.find((item) => item.owner.kind === "schedule")!;
  expect(item.state).toBe("unknown");
  expect(item.nextCheckAt).toBeUndefined();
});
it("shows an armed heartbeat waiting out a pricing refusal as waiting, with no next check", async () => {
  const f = fixture();
  const deps = {
    ...f.deps,
    readFlags: async () => ({ ...(await f.deps.readFlags()), proactiveHeartbeatTurnsV1Enabled: true }),
    readHeartbeatStatus: async () => "waiting_for_priced_model",
    updateHeartbeat: vi.fn(),
  };
  const result = await new FollowThroughProjectionService(deps as never).listFollowThrough("s", "A");
  const item = result.items.find((entry) => entry.owner.kind === "heartbeat");
  expect(item).toMatchObject({ state: "waiting_on_you", nextCheckAt: undefined });
  expect(item?.reason).toContain("no per-token price");
  expect(item?.actions.map((action) => action.action)).toContain("pause");
});
