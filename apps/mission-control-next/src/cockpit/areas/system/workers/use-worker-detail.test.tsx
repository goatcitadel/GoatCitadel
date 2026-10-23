// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAssignmentEvents } from "./use-assignment-events";
import { useWorkerDetail } from "./use-worker-detail";

const api = vi.hoisted(() => ({
  fetchRemoteWorkerDetail: vi.fn(),
  fetchRemoteWorkerAssignments: vi.fn(),
  fetchRemoteWorkerReconciliation: vi.fn(),
  fetchRemoteWorkerAssignmentEvents: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/remote-workers", () => api);
vi.mock("../../../../app/remote-worker-realtime", () => ({
  REMOTE_WORKER_REALTIME_COALESCE_MS: 25,
  RemoteWorkerRealtimeCursor: class {
    decide() {
      return { reload: false };
    }
    reset() {}
  },
  subscribeRemoteWorkerRealtime: () => () => undefined,
}));

type Detail = ReturnType<typeof useWorkerDetail>;
const seen: { current: Detail | null } = { current: null };
function DetailProbe({ workspaceId, workerId }: { workspaceId: string; workerId?: string }) {
  seen.current = useWorkerDetail(workspaceId, workerId, () => undefined);
  return null;
}
const events: { current: ReturnType<typeof useAssignmentEvents> | null } = { current: null };
function EventsProbe({ generation }: { generation: number }) {
  events.current = useAssignmentEvents("ws", { assignmentId: "a1", generation });
  return null;
}

const detail = (workerId: string) => ({ item: { workerId } });
const page = (ids: string[], nextCursor?: string) => ({
  items: ids.map((assignmentId) => ({ assignmentId })),
  nextCursor,
  observedAt: "now",
});
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  seen.current = null;
  api.fetchRemoteWorkerDetail.mockImplementation(async (_ws: string, id: string) => detail(id));
  api.fetchRemoteWorkerAssignments.mockResolvedValue(page(["a1"]));
  api.fetchRemoteWorkerReconciliation.mockResolvedValue({});
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

it("reads nothing until a worker is selected, then reads its detail with exact arguments", async () => {
  await act(async () => root.render(<DetailProbe workspaceId="ws" />));
  expect(api.fetchRemoteWorkerDetail).not.toHaveBeenCalled();
  await act(async () => root.render(<DetailProbe workspaceId="ws" workerId="w1" />));
  expect(api.fetchRemoteWorkerDetail).toHaveBeenCalledWith("ws", "w1");
  expect(api.fetchRemoteWorkerAssignments).toHaveBeenCalledWith("ws", { workerId: "w1", limit: 50 });
  expect(api.fetchRemoteWorkerReconciliation).toHaveBeenCalledWith("ws", "w1");
  expect(seen.current?.detail).toEqual(detail("w1"));
});

it("ignores a late detail for the previous worker and hides its assignments while the next loads", async () => {
  let finishFirst!: (value: unknown) => void;
  api.fetchRemoteWorkerDetail.mockImplementationOnce(() => new Promise((resolve) => (finishFirst = resolve)));
  await act(async () => root.render(<DetailProbe workspaceId="ws" workerId="w1" />));
  let finishSecond!: (value: unknown) => void;
  api.fetchRemoteWorkerAssignments.mockImplementationOnce(() => new Promise((resolve) => (finishSecond = resolve)));
  await act(async () => root.render(<DetailProbe workspaceId="ws" workerId="w2" />));
  expect(seen.current?.assignments).toBeNull();
  await act(async () => finishFirst(detail("w1")));
  expect(seen.current?.detail).toBeNull();
  await act(async () => finishSecond(page(["b1"])));
  expect(seen.current?.detail).toEqual(detail("w2"));
  expect(seen.current?.assignments?.items.map((item) => item.assignmentId)).toEqual(["b1"]);
});

it("stops paging assignments when the cursor repeats", async () => {
  api.fetchRemoteWorkerAssignments.mockResolvedValueOnce(page(["a1"], "c1")).mockResolvedValueOnce(page(["a2"], "c1"));
  await act(async () => root.render(<DetailProbe workspaceId="ws" workerId="w1" />));
  await act(async () => seen.current!.loadMoreAssignments());
  expect(seen.current?.moreError).toContain("Additional assignments are unavailable");
  expect(seen.current?.assignments?.items.map((item) => item.assignmentId)).toEqual(["a1"]);
});

it("withholds an event page whose generation differs from the selected assignment", async () => {
  api.fetchRemoteWorkerAssignmentEvents.mockResolvedValue({
    workspaceId: "ws",
    assignmentId: "a1",
    assignmentGeneration: 9,
    items: [],
    omitted: { transcriptDeltas: 0, terminalOutputs: 0, diagnostics: 0 },
  });
  await act(async () => root.render(<EventsProbe generation={2} />));
  expect(api.fetchRemoteWorkerAssignmentEvents).toHaveBeenCalledWith("ws", "a1", { limit: 50 });
  expect(events.current?.page).toBeNull();
  expect(events.current?.error).toBe("Events for this assignment are unavailable.");
});

it("keeps the loaded assignments on screen while the same worker reloads", async () => {
  await act(async () => root.render(<DetailProbe workspaceId="ws" workerId="w1" />));
  expect(seen.current?.assignments?.items).toHaveLength(1);
  let finish!: (value: unknown) => void;
  api.fetchRemoteWorkerAssignments.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
  let reload!: Promise<unknown>;
  act(() => {
    reload = seen.current!.refresh();
  });
  expect(seen.current?.assignments?.items.map((item) => item.assignmentId)).toEqual(["a1"]);
  await act(async () => {
    finish(page(["a1", "a2"]));
    await reload;
  });
  expect(seen.current?.assignments?.items).toHaveLength(2);
});

it("keeps the last loaded assignments and says so when a refresh of them fails", async () => {
  await act(async () => root.render(<DetailProbe workspaceId="ws" workerId="w1" />));
  api.fetchRemoteWorkerAssignments.mockRejectedValueOnce(new Error("timeout"));
  await act(async () => {
    await seen.current!.refresh();
  });
  expect(seen.current?.assignments?.items.map((item) => item.assignmentId)).toEqual(["a1"]);
  expect(seen.current?.stale).toBe(
    "Some of this worker's records could not be refreshed. The last loaded ones are shown.",
  );
  expect(seen.current?.error).toBeNull();
});
