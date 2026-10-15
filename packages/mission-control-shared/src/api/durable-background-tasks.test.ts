import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DurableBackgroundTaskControlRequest, DurableBackgroundTaskControlResponse, DurableBackgroundTaskRailResponse } from "@goatcitadel/contracts";

let controlDurableBackgroundTask: typeof import("./durable.js").controlDurableBackgroundTask;
let fetchDurableBackgroundTaskRail: typeof import("./durable.js").fetchDurableBackgroundTaskRail;
let accessScope: typeof import("./access-scope.js");

const apiMocks = vi.hoisted(() => ({ request: vi.fn(), getGatewayApiBaseUrl: vi.fn() }));

vi.mock("./client-core.js", () => ({ request: apiMocks.request, getGatewayApiBaseUrl: apiMocks.getGatewayApiBaseUrl }));

describe("durable background-task API", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.doUnmock("./durable-background-task-validation.js");
    apiMocks.request.mockReset();
    apiMocks.getGatewayApiBaseUrl.mockReset();
    apiMocks.getGatewayApiBaseUrl.mockReturnValue("http://127.0.0.1:8787");
    ({ controlDurableBackgroundTask, fetchDurableBackgroundTaskRail } = await import("./durable.js"));
    accessScope = await import("./access-scope.js");
  });

  it("encodes the parent scope when reading the Gateway-owned rail", async () => {
    apiMocks.request.mockResolvedValue(rail("parent/run", "workspace A", "session/1"));
    await fetchDurableBackgroundTaskRail("parent/run", {
      workspaceId: "workspace A",
      sessionId: "session/1",
    });

    expect(apiMocks.request).toHaveBeenCalledWith(
      "/api/v1/durable/runs/parent%2Frun/background-tasks?workspaceId=workspace+A&sessionId=session%2F1",
      { cache: "no-store" },
    );
  });

  it("sends scope and optimistic versions for governed child controls", async () => {
    const input = {
      workspaceId: "workspace-a",
      sessionId: "session-1",
      action: "cancel" as const,
      expectedWatcherRevision: 7,
      expectedChildVersion: 7,
      reason: "Operator cancelled from Chat",
    };
    const responseRail = rail("parent/run", "workspace-a", "session-1");
    responseRail.coverage.watchers.observedCount = 1;
    const watcherId = "delegation-child:step-1";
    responseRail.tasks = [
      {
        watcherId,
        watcherRevision: 8,
        watcherState: "attached",
        watcherUpdatedAt: "2026-07-13T00:00:00.000Z",
        childRunId: "child-1",
        canonicalStatus: "cancelled",
        childVersion: 8,
        label: "Child",
        scope: { workspaceId: "workspace-a", sessionId: "child-session", verified: true },
        tools: [],
        toolCoverage: { complete: true, observedCount: 0, limit: 200 },
        approvals: [],
        output: { availability: "missing" },
        blockers: [
          { kind: "cancelled", message: "Child run was cancelled." },
          { kind: "missing_output", message: "Terminal child has no concrete output to cite." },
        ],
        attention: {
          state: "foreground",
          reason: "watcher_attached",
          updatedAt: "2026-07-13T00:00:00.000Z",
          required: true,
          requiredReason: "missing_output",
        },
        signalIntegrity: {
          observedCount: 0,
          acceptedCount: 0,
          duplicateCount: 0,
          outOfOrderCount: 0,
          conflictingSequenceCount: 0,
          observationComplete: true,
          posture: "unobserved",
        },
        controls: {
          detach: { enabled: true },
          reattach: { enabled: false, reason: "Watcher is attached." },
          cancel: { enabled: false, reason: "Child run is already cancelled." },
        },
        links: [{ kind: "durable_run", id: "child-1", label: "Child run" }],
      },
    ];
    responseRail.synthesis.missingTerminalChildRunIds = ["child-1"];
    responseRail.synthesis.uncoveredChildRunIds = ["child-1"];
    apiMocks.request.mockResolvedValue({
      version: "durable.background_task_control.v1",
      action: "cancel",
      watcherId,
      childRunId: "child-1",
      outcome: "applied",
      rail: responseRail,
    });

    await controlDurableBackgroundTask("parent/run", watcherId, input);

    expect(apiMocks.request).toHaveBeenCalledWith(
      "/api/v1/durable/runs/parent%2Frun/background-tasks/delegation-child%3Astep-1/control",
      { method: "POST", body: JSON.stringify(input) },
    );
  });

  it("rejects a stale or cross-scope Gateway envelope", async () => {
    apiMocks.request.mockResolvedValue(rail("different-parent", "workspace-a", "session-1"));
    await expect(
      fetchDurableBackgroundTaskRail("parent", {
        workspaceId: "workspace-a",
        sessionId: "session-1",
      }),
    ).rejects.toThrow(/invalid durable background-task envelope/);
  });

  it("accepts multiline operator summaries but rejects non-display control bytes", async () => {
    const multiline = rail("parent", "workspace-a", "session-1");
    multiline.unknowns = ["Coverage is incomplete.\nRefresh to inspect the latest state."];
    apiMocks.request.mockResolvedValueOnce(multiline);
    await expect(
      fetchDurableBackgroundTaskRail("parent", {
        workspaceId: "workspace-a",
        sessionId: "session-1",
      }),
    ).resolves.toEqual(multiline);

    const invalid = rail("parent", "workspace-a", "session-1");
    invalid.unknowns = ["Unsafe\u0000summary"];
    apiMocks.request.mockResolvedValueOnce(invalid);
    await expect(
      fetchDurableBackgroundTaskRail("parent", {
        workspaceId: "workspace-a",
        sessionId: "session-1",
      }),
    ).rejects.toThrow(/invalid durable background-task envelope/);
  });

  it("rejects control envelopes with undeclared fields", async () => {
    const responseRail = rail("parent", "workspace-a", "session-1");
    apiMocks.request.mockResolvedValue({
      version: "durable.background_task_control.v1",
      action: "detach",
      watcherId: "watcher-1",
      childRunId: "child-1",
      outcome: "applied",
      rail: responseRail,
      clientCanonicalOverride: true,
    });

    await expect(
      controlDurableBackgroundTask("parent", "watcher-1", {
        workspaceId: "workspace-a",
        sessionId: "session-1",
        action: "detach",
        expectedWatcherRevision: 1,
      }),
    ).rejects.toThrow(/invalid durable background-task envelope/);
  });

  it("keeps the validator unloaded until a background-task API is called", async () => {
    const gate = deferValidation();
    let loaded = false;
    void gate.started.then(() => { loaded = true; });
    await import("./durable.js");
    await Promise.resolve();
    expect(loaded).toBe(false);
    expect(apiMocks.request).not.toHaveBeenCalled();
  });

  it("loads validation before POST and snapshots the reviewed scope, action and body", async () => {
    const gate = deferValidation();
    const input: DurableBackgroundTaskControlRequest = { workspaceId: "workspace-a", sessionId: "session-1", action: "detach", expectedWatcherRevision: 7, reason: "Reviewed reason" };
    const body = JSON.stringify(input);
    const receipt = controlReceipt();
    apiMocks.request.mockResolvedValue(receipt);
    const pending = controlDurableBackgroundTask("parent", "watcher", input);
    const accepted = expect(pending).resolves.toEqual(receipt);
    await gate.started;
    expect(apiMocks.request).not.toHaveBeenCalled();
    Object.assign(input, { workspaceId: "foreign", sessionId: "foreign-session", action: "cancel", expectedWatcherRevision: 99, reason: "Later edit" });
    gate.release();
    await accepted;
    expect(apiMocks.request).toHaveBeenCalledExactlyOnceWith(
      "/api/v1/durable/runs/parent/background-tasks/watcher/control", { method: "POST", body },
    );
  });

  it("sends no mutation when the validator module fails to load", async () => {
    const gate = deferValidation(new Error("Validator chunk could not load"));
    const rejected = expect(controlDurableBackgroundTask("parent", "watcher", controlInput())).rejects.toThrow();
    await gate.started;
    expect(apiMocks.request).not.toHaveBeenCalled();
    gate.release();
    await rejected;
    expect(apiMocks.request).not.toHaveBeenCalled();
  });

  it.each([false, true])("sends no mutation when caller custody changes during loading, including a return: %s", async (returning) => {
    accessScope.setGatewayCallerScope("caller-a");
    const gate = deferValidation();
    const rejected = expect(controlDurableBackgroundTask("parent", "watcher", controlInput())).rejects.toMatchObject({ kind: "protocol", method: "POST" });
    await gate.started;
    accessScope.setGatewayCallerScope("caller-b");
    if (returning) accessScope.setGatewayCallerScope("caller-a");
    gate.release();
    await rejected;
    expect(apiMocks.request).not.toHaveBeenCalled();
  });

  it.each(["access", "gateway"] as const)("sends no mutation when %s custody changes during loading", async (changed) => {
    const gate = deferValidation();
    const rejected = expect(controlDurableBackgroundTask("parent", "watcher", controlInput())).rejects.toMatchObject({ kind: "protocol", method: "POST" });
    await gate.started;
    if (changed === "access") accessScope.notifyGatewayAccessChanged();
    else apiMocks.getGatewayApiBaseUrl.mockReturnValue("http://127.0.0.1:9797");
    gate.release();
    await rejected;
    expect(apiMocks.request).not.toHaveBeenCalled();
  });

  it("retains the requested GET scope when the caller-owned input object is later edited", async () => {
    const input = { workspaceId: "workspace-a", sessionId: "session-1" };
    let finish!: (value: DurableBackgroundTaskRailResponse) => void;
    apiMocks.request.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const expected = rail("parent", input.workspaceId, input.sessionId);
    const pending = fetchDurableBackgroundTaskRail("parent", input);
    Object.assign(input, { workspaceId: "foreign", sessionId: "foreign-session" });
    finish(expected);
    await expect(pending).resolves.toEqual(expected);
    expect(apiMocks.request).toHaveBeenCalledExactlyOnceWith(
      "/api/v1/durable/runs/parent/background-tasks?workspaceId=workspace-a&sessionId=session-1", { cache: "no-store" },
    );
  });

  it("rejects an already-stale GET before importing validation", async () => {
    accessScope.setGatewayCallerScope("caller-a");
    const gate = deferValidation();
    let loaded = false;
    void gate.started.then(() => { loaded = true; });
    apiMocks.request.mockImplementationOnce(async () => {
      accessScope.setGatewayCallerScope("caller-b");
      return rail("parent", "workspace-a", "session-1");
    });
    await expect(fetchDurableBackgroundTaskRail("parent", { workspaceId: "workspace-a", sessionId: "session-1" })).rejects.toMatchObject({ kind: "protocol", method: "GET" });
    expect(loaded).toBe(false);
    expect(apiMocks.request).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("rejects a GET rail when caller custody changes during deferred validation, including a return: %s", async (returning) => {
    accessScope.setGatewayCallerScope("caller-a");
    apiMocks.request.mockResolvedValue(rail("parent", "workspace-a", "session-1"));
    const gate = deferValidation();
    const rejected = expect(fetchDurableBackgroundTaskRail("parent", { workspaceId: "workspace-a", sessionId: "session-1" })).rejects.toMatchObject({ kind: "protocol", method: "GET" });
    await gate.started;
    accessScope.setGatewayCallerScope("caller-b");
    if (returning) accessScope.setGatewayCallerScope("caller-a");
    gate.release();
    await rejected;
    expect(apiMocks.request).toHaveBeenCalledTimes(1);
  });

  it("preserves abort after the GET completes while validation is loading", async () => {
    apiMocks.request.mockResolvedValue(rail("parent", "workspace-a", "session-1"));
    const abort = new AbortController();
    const reason = new DOMException("Operator left the selected run", "AbortError");
    const gate = deferValidation();
    const rejected = expect(fetchDurableBackgroundTaskRail("parent", { workspaceId: "workspace-a", sessionId: "session-1" }, { signal: abort.signal })).rejects.toBe(reason);
    await gate.started;
    abort.abort(reason);
    gate.release();
    await rejected;
    expect(apiMocks.request).toHaveBeenCalledExactlyOnceWith(
      "/api/v1/durable/runs/parent/background-tasks?workspaceId=workspace-a&sessionId=session-1", { cache: "no-store", signal: abort.signal },
    );
  });

  it("rejects a returned control receipt after a scope change without issuing another mutation", async () => {
    accessScope.setGatewayCallerScope("caller-a");
    apiMocks.request.mockImplementationOnce(async () => {
      accessScope.setGatewayCallerScope("caller-b");
      return controlReceipt();
    });
    await expect(controlDurableBackgroundTask("parent", "watcher", controlInput())).rejects.toMatchObject({ kind: "protocol", method: "POST" });
    expect(apiMocks.request).toHaveBeenCalledTimes(1);
  });
});

function rail(parentRunId: string, workspaceId: string, sessionId: string): DurableBackgroundTaskRailResponse {
  return {
    version: "durable.background_task_rail.v1",
    generatedAt: "2026-07-13T00:00:00.000Z",
    scope: { workspaceId, sessionId, verified: true },
    parent: {
      runId: parentRunId,
      status: "completed",
      version: 1,
      links: [{ kind: "durable_run", id: parentRunId, label: "Parent run" }],
    },
    coverage: {
      watchers: { complete: true, observedCount: 0, limit: 500 },
      parentSignals: { complete: true, observedCount: 0, limit: 2_000 },
    },
    tasks: [],
    synthesis: {
      availability: "missing",
      lineage: [],
      missingTerminalChildRunIds: [],
      uncoveredChildRunIds: [],
      uncoveredStepIds: [],
    },
    unknowns: [],
  };
}


function deferValidation(failure?: Error) {
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  const loading = new Promise<void>((resolve) => { started = resolve; });
  vi.doMock("./durable-background-task-validation.js", async () => {
    started();
    await ready;
    if (failure) throw failure;
    return vi.importActual<typeof import("./durable-background-task-validation.js")>("./durable-background-task-validation.js");
  });
  return { started: loading, release: () => release() };
}

function controlInput(): DurableBackgroundTaskControlRequest {
  return { workspaceId: "workspace-a", sessionId: "session-1", action: "detach", expectedWatcherRevision: 7 };
}

function controlReceipt(): DurableBackgroundTaskControlResponse {
  const responseRail = rail("parent", "workspace-a", "session-1");
  responseRail.coverage.watchers.observedCount = 1;
  responseRail.tasks = [{
    watcherId: "watcher", watcherRevision: 8, watcherState: "detached", watcherUpdatedAt: "2026-07-13T00:00:00.000Z",
    childRunId: "child", childVersion: 8, canonicalStatus: "running", label: "Child",
    scope: { workspaceId: "workspace-a", sessionId: "child-session", verified: true },
    tools: [], toolCoverage: { complete: true, observedCount: 0, limit: 200 }, approvals: [], output: { availability: "not_terminal" }, blockers: [],
    attention: { state: "background", reason: "operator_continued_in_background", updatedAt: "2026-07-13T00:00:00.000Z", required: false },
    signalIntegrity: { observedCount: 0, acceptedCount: 0, duplicateCount: 0, outOfOrderCount: 0, conflictingSequenceCount: 0, observationComplete: true, posture: "unobserved" },
    controls: { detach: { enabled: false }, reattach: { enabled: true }, cancel: { enabled: true } },
    links: [{ kind: "durable_run", id: "child", label: "Child run" }],
  }];
  return { version: "durable.background_task_control.v1", action: "detach", watcherId: "watcher", childRunId: "child", outcome: "applied", rail: responseRail };
}
