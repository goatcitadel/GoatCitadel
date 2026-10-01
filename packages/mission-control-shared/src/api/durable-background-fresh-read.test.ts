// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import type { DurableBackgroundTaskRailResponse } from "@goatcitadel/contracts";
import { controlDurableBackgroundTask, fetchDurableBackgroundTaskRail } from "./durable";

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
afterEach(() => {
  vi.unstubAllGlobals();
});
function rail(): DurableBackgroundTaskRailResponse {
  return {
    version: "durable.background_task_rail.v1",
    generatedAt: "2026-10-01T00:00:00.000Z",
    scope: { workspaceId: "workspace", sessionId: "session", verified: true },
    parent: { runId: "parent", status: "completed", version: 1, links: [] },
    coverage: {
      watchers: { complete: true, observedCount: 1, limit: 500 },
      parentSignals: { complete: true, observedCount: 0, limit: 2000 },
    },
    tasks: [
      {
        watcherId: "watcher",
        watcherRevision: 1,
        watcherState: "attached",
        watcherUpdatedAt: "2026-10-01T00:00:00.000Z",
        childRunId: "child",
        childVersion: 3,
        canonicalStatus: "running",
        label: "Child",
        scope: { workspaceId: "workspace", sessionId: "child-session", verified: true },
        tools: [],
        approvals: [],
        blockers: [],
        toolCoverage: { complete: true, observedCount: 0, limit: 200 },
        output: { availability: "not_terminal" },
        attention: {
          state: "foreground",
          reason: "watcher_attached",
          required: false,
          updatedAt: "2026-10-01T00:00:00.000Z",
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
        controls: { detach: { enabled: true }, reattach: { enabled: false }, cancel: { enabled: true } },
        links: [],
      },
    ],
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

it("a fresh post-control rail read cannot adopt an older pending GET transport", async () => {
  const oldRail = rail();
  const appliedRail = rail();
  Object.assign(appliedRail.tasks[0]!, { watcherRevision: 2, watcherState: "detached" });
  Object.assign(appliedRail.tasks[0]!.attention, { state: "background", reason: "operator_continued_in_background" });
  appliedRail.tasks[0]!.controls.detach.enabled = false;
  appliedRail.tasks[0]!.controls.reattach.enabled = true;
  let finishOld!: (response: Response) => void;
  const transport = vi
    .fn<typeof fetch>()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
        }),
    )
    .mockResolvedValueOnce(
      json({
        version: "durable.background_task_control.v1",
        action: "detach",
        watcherId: "watcher",
        childRunId: "child",
        outcome: "applied",
        rail: appliedRail,
      }),
    )
    .mockResolvedValueOnce(json(appliedRail));
  vi.stubGlobal("fetch", transport);
  const scope = { workspaceId: "workspace", sessionId: "session" };
  const old = fetchDurableBackgroundTaskRail("parent", scope);
  const joined = fetchDurableBackgroundTaskRail("parent", scope);
  expect(transport).toHaveBeenCalledTimes(1);
  expect(
    (
      await controlDurableBackgroundTask("parent", "watcher", {
        ...scope,
        action: "detach",
        expectedWatcherRevision: 1,
      })
    ).rail,
  ).toEqual(appliedRail);
  const signal = new AbortController().signal;
  const fresh = fetchDurableBackgroundTaskRail("parent", scope, { signal });
  expect(transport).toHaveBeenCalledTimes(3);
  expect(transport.mock.calls[2]?.[1]).toMatchObject({ signal, cache: "no-store" });
  await expect(fresh).resolves.toEqual(appliedRail);
  finishOld(json(oldRail));
  expect(await old).toEqual(oldRail);
  expect(await joined).toEqual(oldRail);
});
