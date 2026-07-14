import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DurableBackgroundTaskRailResponse } from "@goatcitadel/contracts";
import { controlDurableBackgroundTask, fetchDurableBackgroundTaskRail } from "./durable.js";

const apiMocks = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock("./client-core.js", () => ({ request: apiMocks.request }));

describe("durable background-task API", () => {
  beforeEach(() => {
    apiMocks.request.mockReset();
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
    responseRail.tasks = [
      {
        watcherId: "watcher/1",
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
      watcherId: "watcher/1",
      childRunId: "child-1",
      outcome: "applied",
      rail: responseRail,
    });

    await controlDurableBackgroundTask("parent/run", "watcher/1", input);

    expect(apiMocks.request).toHaveBeenCalledWith(
      "/api/v1/durable/runs/parent%2Frun/background-tasks/watcher%2F1/control",
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
