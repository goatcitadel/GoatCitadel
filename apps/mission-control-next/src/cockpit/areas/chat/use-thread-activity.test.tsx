// @vitest-environment happy-dom
import { act, useEffect, useSyncExternalStore, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChatSessionStatusResponse } from "@goatcitadel/contracts";
import { useThreadActivity } from "./use-thread-activity";
import { statusRecord } from "./thread-activity.test-support";
import type { MissionThreadedSessionRailData } from "@goatcitadel/threaded-surface-core";
import { ThreadList } from "./ThreadList";
import { SelectedThreadActivity } from "./SelectedThreadActivity";
const mocks = vi.hoisted(() => ({ width: 1280, workspace: "w", citadel: "a", base: "http://test.invalid", read: vi.fn<typeof import("@goatcitadel/mission-control-shared/api/chat").fetchChatSessionStatus>() }));
vi.mock("@goatcitadel/mission-control-shared/api/chat", () => ({ fetchChatSessionStatus: mocks.read }));
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({ getGatewayApiBaseUrl: () => mocks.base }));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({ useUiPreferences: () => ({ activeWorkspaceId: mocks.workspace, activeCitadelId: mocks.citadel }) }));
vi.mock("@goatcitadel/mission-control-shared/hooks/useMediaQuery", () => ({ useMediaQuery: (query: string) => useSyncExternalStore(
  (notify) => { window.addEventListener("resize", notify); return () => window.removeEventListener("resize", notify); },
  () => query === "(width >= 1024px)" ? mocks.width >= 1024 : query === "(width < 1024px)" && mocks.width < 1024,
) }));
vi.mock("../../ui/WindowedRecordList", () => ({ WindowedRecordList: ({ onVisibleRangeChange }: { onVisibleRangeChange: (range: {startIndex: number; endIndex: number}) => void }) => {
  useEffect(() => { onVisibleRangeChange({ startIndex: 0, endIndex: 1 }); }, [onVisibleRangeChange]); return <ul aria-label="Rendered test window" />;
} }));
vi.mock("./ChatConversationFilters", () => ({ ChatConversationFilters: () => null }));
let root: Root, host: HTMLDivElement, client: QueryClient, owner: ReturnType<typeof useThreadActivity>;
function Probe() { owner = useThreadActivity(["s"]); return <p>{owner.records.s?.label ?? "Unavailable"}</p>; }
async function render(node: ReactNode = <Probe />) { await act(async () => root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>)); }
beforeEach(() => { mocks.width = 1280; mocks.workspace = "w"; mocks.citadel = "a"; mocks.base = "http://test.invalid"; mocks.read.mockReset().mockResolvedValue(statusRecord());
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); client.clear(); host.remove(); });
it("refreshes visible activity through the existing chat topic invalidation with an independent signal", async () => {
  await render(); await vi.waitFor(() => expect(host.textContent).toBe("No recorded turns"));
  const first = mocks.read.mock.calls[0]![1];
  const next = statusRecord(); if (next.work.availability !== "available") throw new Error("Fixture work required"); next.work.value.turnCounts.running = 1;
  mocks.read.mockResolvedValue(next); await act(async () => { await client.invalidateQueries({ queryKey: ["chat"] }); });
  await vi.waitFor(() => expect(host.textContent).toBe("Working")); expect(mocks.read.mock.calls.at(-1)![1]).not.toBe(first);
});
it("rejects old workspace/Citadel ABA results and aborts old reads without displaying cached healthy state", async () => {
  let finish!: (value: ChatSessionStatusResponse) => void;
  mocks.read.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; })); await render();
  const signal = mocks.read.mock.calls[0]![1]!;
  mocks.citadel = "b"; await render(); mocks.citadel = "a"; await render();
  await act(async () => { finish(statusRecord("s", "foreign")); });
  expect(signal.aborted).toBe(true); await vi.waitFor(() => expect(host.textContent).toBe("No recorded turns"));
  mocks.read.mockRejectedValue(new Error("Owner unavailable")); await act(async () => { await owner.refresh(); });
  // A failed refresh keeps the last answer but marks it as no longer current.
  await vi.waitFor(() => expect(owner.records.s?.stale).toBe(true), { timeout: 4_000 });
  expect(host.textContent).toBe("No recorded turns");
});

it("shows Status unavailable only when no answer was ever read", async () => {
  mocks.read.mockRejectedValue(Object.assign(new Error("Not found"), { kind: "http", status: 404 }));
  await render();
  await vi.waitFor(() => expect(host.textContent).toBe("Status unavailable"), { timeout: 4_000 });
});

it("reads only the new thread when the visible list grows", async () => {
  mocks.read.mockImplementation(async (id) => statusRecord(id));
  function Grow({ ids }: { ids: string[] }) { owner = useThreadActivity(ids); return null; }
  await render(<Grow ids={["s"]} />);
  await vi.waitFor(() => expect(owner.records.s).toBeDefined());
  mocks.read.mockClear();
  await render(<Grow ids={["s", "t"]} />);
  await vi.waitFor(() => expect(owner.records.t).toBeDefined());
  expect(mocks.read.mock.calls.map(([id]) => id)).toEqual(["t"]);
  expect(owner.records.s?.label).toBe("No recorded turns");
});

it("stops hidden rail reads after desktop to tablet resize, including retained chat refresh signals", async () => {
  mocks.read.mockImplementation(async (id) => statusRecord(id));
  const rail = { missionSessions: [{ sessionId: "s" }, { sessionId: "other" }], historyView: "active", selectedSessionId: "s", creatingSession: false,
    onCreateSession: vi.fn(), onHistoryViewChange: vi.fn(), renderSessionLabel: (id: string) => id } as unknown as MissionThreadedSessionRailData;
  await render(<><ThreadList rail={rail} /><SelectedThreadActivity sessionId="s" /></>);
  await vi.waitFor(() => expect(new Set(mocks.read.mock.calls.map(([id]) => id))).toEqual(new Set(["s", "other"])));
  mocks.read.mockClear();
  await act(async () => { mocks.width = 800; window.dispatchEvent(new Event("resize")); });
  await vi.waitFor(() => expect(host.querySelector('[aria-label="Selected conversation activity"]')?.textContent).toBe("No recorded turns"));
  // The phone picker reuses the rail's cached answer for the same thread instead of reading it again.
  expect(mocks.read.mock.calls.map(([id]) => id)).toEqual([]);
  mocks.read.mockClear(); await act(async () => { await client.invalidateQueries({ queryKey: ["chat"] }); });
  expect(mocks.read.mock.calls.map(([id]) => id)).toEqual(["s"]);
});
