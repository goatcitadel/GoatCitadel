// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AssignmentInspector } from "./AssignmentInspector";
import { assignment } from "./workers.test-data";

const preferences = vi.hoisted(() => ({ showTechnicalDetails: false }));
const runtime = vi.hoisted(() => ({ value: { data: null as unknown, error: null as string | null, reload: vi.fn() } }));
const api = vi.hoisted(() => ({ fetchRemoteWorkerAssignmentEvents: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({ useUiPreferences: () => preferences }));
vi.mock("@goatcitadel/mission-control-shared/api/remote-workers", () => api);
vi.mock("../../../../features/remote-workers/useRemoteWorkerAssignmentRuntime", () => ({
  useRemoteWorkerAssignmentRuntime: () => runtime.value,
}));
vi.mock("../../../../features/remote-workers/NativeOutputDownloads", () => ({ NativeOutputDownloads: () => null }));
vi.mock("../../../ui/Sheet", () => ({
  Sheet: ({ open, title, children }: { open: boolean; title: string; children: ReactNode }) =>
    open ? (
      <div role="dialog" aria-label={title}>
        {children}
      </div>
    ) : null,
}));

const coverage = (complete: boolean) => ({ knownAttemptCount: 3, unknownAttemptCount: complete ? 0 : 1, complete });
const runtimeData = {
  assignmentId: "assignment-1",
  assignmentGeneration: 2,
  workerId: "w1",
  workerGeneration: 3,
  observedAt: "2026-10-23T08:00:00.000Z",
  connectionHealth: {
    value: {
      freshness: "recent",
      lastAuthenticatedAt: "2026-10-23T07:59:00.000Z",
      evaluatedAt: "2026-10-23T08:00:00.000Z",
      recentWindowMs: 60000,
      basis: "authenticated_request",
      retention: "bounded",
    },
    authorityClass: "retained_signal",
    owner: "o",
    observedAt: "2026-10-23T08:00:00.000Z",
  },
  usageAndCost: {
    value: {
      usage: {
        attemptCount: 4,
        uncertainDispatchCount: 0,
        trackedAttemptCount: 3,
        unknownAttemptCount: 1,
        inputTokens: 100,
        outputTokens: 50,
        cachedInputTokens: 0,
        costUsd: 0.000001,
        metricAvailability: {
          inputTokens: coverage(true),
          outputTokens: coverage(true),
          cachedInputTokens: coverage(true),
          costUsd: coverage(false),
        },
      },
      pendingReservations: 1,
      reservedRequests: 2,
      reservedCostMicrousd: 5,
    },
    authorityClass: "canonical_record",
    owner: "o",
    observedAt: "2026-10-23T08:00:00.000Z",
  },
  resourceCell: { value: null, authorityClass: "unavailable", owner: "o", observedAt: "2026-10-23T08:00:00.000Z" },
  artifactAndEffects: {
    value: null,
    authorityClass: "unavailable",
    owner: "o",
    observedAt: "2026-10-23T08:00:00.000Z",
  },
};
const eventPage = {
  workspaceId: "ws",
  assignmentId: "assignment-1",
  assignmentGeneration: 2,
  items: [{ eventId: "e1", sequence: 1, eventType: "turn_started", workerSentThrough: 1 }],
  omitted: { transcriptDeltas: 0, terminalOutputs: 0, diagnostics: 0 },
};
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  runtime.value = { data: runtimeData, error: null, reload: vi.fn() };
  api.fetchRemoteWorkerAssignmentEvents.mockResolvedValue(eventPage);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
const render = async (assignments = [assignment("assignment-1")], assignmentId = "assignment-1") => {
  await act(async () =>
    root.render(
      <AssignmentInspector
        workspaceId="ws"
        assignments={assignments}
        assignmentId={assignmentId}
        refreshKey="now"
        onClose={() => undefined}
      />,
    ),
  );
};
const text = () => host.textContent ?? "";

it("reads events once for the bookmarked assignment and shows usage honestly", async () => {
  await render();
  expect(api.fetchRemoteWorkerAssignmentEvents).toHaveBeenCalledWith("ws", "assignment-1", { limit: 50 });
  expect(text()).toContain("incomplete");
  expect(text()).toContain("Outstanding holds");
  expect(text()).toContain("does not establish an open connection");
  expect(text()).toContain("Resource cell unavailable");
  expect(text()).toContain("<$0.01");
  expect(text()).not.toContain("$0.00");
  expect(text()).not.toContain("Worker healthy");
  expect(text()).not.toMatch(/evidence|Canonical/i);
});

it("says the assignment changed instead of showing another generation", async () => {
  runtime.value = {
    data: null,
    error: "Assignment identity changed. Refresh the worker before inspecting this generation.",
    reload: vi.fn(),
  };
  await render();
  expect(text()).toContain("Assignment identity changed");
});

it("does not infer anything when the runtime read fails", async () => {
  runtime.value = {
    data: null,
    error: "Assignment runtime evidence is unavailable. No health, usage, or settlement was inferred.",
    reload: vi.fn(),
  };
  await render();
  expect(text()).toContain("Assignment runtime is unavailable");
  expect(text()).not.toContain("evidence");
});

it("says a bookmarked assignment is not loaded and reads no events for it", async () => {
  await render([assignment("other")], "assignment-1");
  expect(text()).toContain("This assignment is not in the loaded records.");
  expect(api.fetchRemoteWorkerAssignmentEvents).not.toHaveBeenCalled();
});

it("says events are unavailable when the assignment's version was not reported, instead of loading forever", async () => {
  const unversioned = assignment("assignment-1");
  await render([{ ...unversioned, identity: { ...unversioned.identity, value: null } }]);
  expect(text()).toContain("this assignment's version was not reported");
  expect(text()).not.toContain("Loading events");
  expect(api.fetchRemoteWorkerAssignmentEvents).not.toHaveBeenCalled();
});
