import React, { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useChatAgenticTreeRefresh } from "./useChatAgenticTreeRefresh";

const api = vi.hoisted(() => ({ list: vi.fn(), tree: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/agentic", () => ({
  fetchAgenticRuns: api.list,
  fetchAgenticRunTree: api.tree,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  api.list.mockReset();
  api.tree.mockReset();
});
afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
});

it("skips an obsolete automatic tree read and keeps the explicit resolver available", async () => {
  let completeOriginalList!: (value: { items: { runId: string }[] }) => void;
  const originalList = new Promise<{ items: { runId: string }[] }>((resolve) => {
    completeOriginalList = resolve;
  });
  api.list
    .mockReturnValueOnce(originalList)
    .mockResolvedValueOnce({ items: [{ runId: "current-run" }] })
    .mockResolvedValueOnce({ items: [{ runId: "explicit-run" }] });
  api.tree.mockImplementation(async (runId: string) => ({ runId }));
  const setTree = vi.fn();
  let resolveManually: ReturnType<typeof useChatAgenticTreeRefresh>["resolveAgenticRunTree"] | undefined;
  function Harness({ refreshKey }: { refreshKey: string }) {
    const owner = useChatAgenticTreeRefresh({
      selection: { selectedSessionId: "session-1" },
      workspaceId: "workspace-1",
      setAgenticRunTree: setTree,
      threadReady: true,
      refreshKey,
    });
    resolveManually = owner.resolveAgenticRunTree;
    return null;
  }

  await act(async () => {
    renderer = create(<Harness refreshKey="0:null" />);
  });
  expect(api.list).toHaveBeenCalledOnce();
  expect(api.tree).not.toHaveBeenCalled();
  await act(async () => renderer!.update(<Harness refreshKey="0:completed" />));
  expect(api.list).toHaveBeenCalledTimes(2);
  expect(api.tree).toHaveBeenCalledExactlyOnceWith("current-run", { workspaceId: "workspace-1" });
  expect(setTree).toHaveBeenCalledExactlyOnceWith({ runId: "current-run" });

  await act(async () => completeOriginalList({ items: [{ runId: "obsolete-run" }] }));
  expect(api.tree).toHaveBeenCalledExactlyOnceWith("current-run", { workspaceId: "workspace-1" });
  expect(setTree).toHaveBeenCalledExactlyOnceWith({ runId: "current-run" });

  expect(await resolveManually?.()).toEqual({ runId: "explicit-run" });
  expect(api.tree).toHaveBeenLastCalledWith("explicit-run", { workspaceId: "workspace-1" });
  expect(api.list).toHaveBeenCalledTimes(3);
});

it("loads the automatic tree once when the selected thread first hydrates", async () => {
  api.list.mockResolvedValue({ items: [{ runId: "hydrated-run" }] });
  api.tree.mockResolvedValue({ runId: "hydrated-run" });
  const setTree = vi.fn();
  function Harness({ threadReady }: { threadReady: boolean }) {
    useChatAgenticTreeRefresh({
      selection: { selectedSessionId: "session-1" },
      workspaceId: "workspace-1",
      setAgenticRunTree: setTree,
      threadReady,
      refreshKey: threadReady ? "0:completed" : "0:null",
    });
    return null;
  }
  await act(async () => {
    renderer = create(<Harness threadReady={false} />);
  });
  expect(api.list).not.toHaveBeenCalled();
  await act(async () => renderer!.update(<Harness threadReady />));
  expect(api.list).toHaveBeenCalledOnce();
  expect(api.tree).toHaveBeenCalledExactlyOnceWith("hydrated-run", { workspaceId: "workspace-1" });
  expect(setTree).toHaveBeenLastCalledWith({ runId: "hydrated-run" });
});
