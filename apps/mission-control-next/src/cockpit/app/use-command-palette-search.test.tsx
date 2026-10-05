// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "../data/query-keys";
import { useCommandPaletteSearch } from "./use-command-palette-search";

const api = vi.hoisted(() => ({
  workspaces: vi.fn(),
  sessions: vi.fn(),
  inbox: vi.fn(),
  catalog: vi.fn(),
  resources: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/workspaces", () => ({ fetchWorkspaces: api.workspaces }));
vi.mock("@goatcitadel/mission-control-shared/api/chat", () => ({ fetchChatSessionSearch: api.sessions }));
vi.mock("@goatcitadel/mission-control-shared/api/operator-inbox", () => ({ fetchOperatorInbox: api.inbox }));
vi.mock("../areas/library/capability-catalog", async (original) => ({
  ...(await original<typeof import("../areas/library/capability-catalog")>()),
  loadCapabilityCatalog: api.catalog,
}));
vi.mock("../areas/library/library-resources", async (original) => ({
  ...(await original<typeof import("../areas/library/library-resources")>()),
  loadLibraryResources: api.resources,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
const conversation = (text: string, workspaceId = "a") => ({
  query: text,
  items: [
    {
      session: {
        sessionId: `${workspaceId}-${text}`,
        workspaceId,
        scope: "mission",
        includeInHistory: true,
        title: `Match for ${text}`,
        lifecycleStatus: "active",
      },
      hits: [],
    },
  ],
});
const threads = () => owner.groups.find((group) => group.id === "threads");

let root: Root, element: HTMLDivElement, client: QueryClient, owner: ReturnType<typeof useCommandPaletteSearch>;
function Probe({
  workspaceId = "a",
  query = "needle",
  open = true,
}: {
  workspaceId?: string;
  query?: string;
  open?: boolean;
}) {
  owner = useCommandPaletteSearch(open, { workspaceId, citadelId: "citadel" }, query);
  return null;
}
async function render(props: Parameters<typeof Probe>[0] = {}) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <Probe {...props} />
      </QueryClientProvider>,
    );
  });
}
/** Past the debounce, then let queries settle and reach React. */
async function settle(ms = 301) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  for (let pass = 0; pass < 4; pass += 1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  api.workspaces.mockImplementation(async (_view: string, _limit: number, citadelId: string) => ({
    items: ["a", "b"].map((workspaceId) => ({ workspaceId, citadelId, lifecycleStatus: "active" })),
  }));
  api.sessions.mockImplementation(async (input: { query: string; workspaceId: string }) =>
    conversation(input.query, input.workspaceId),
  );
  api.resources.mockResolvedValue({ items: [], coverage: "Bounded window." });
  api.catalog.mockResolvedValue({ items: [], issues: [], callableKnown: true, skillsKnown: true, skillsById: {} });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queryKeys.inbox("a"), {
    workspaceId: "a",
    items: [
      { id: "approval:1", kind: "approval", title: "Needle approval", summary: "Review", source: { workspaceId: "a" } },
    ],
    counts: {},
    coverage: [],
  });
  client.setQueryData(queryKeys.capabilities(), {
    items: [],
    issues: [],
    callableKnown: true,
    skillsKnown: true,
    skillsById: {},
  });
  element = document.createElement("div");
  root = createRoot(element);
});
afterEach(() => {
  act(() => root.unmount());
  client.clear();
  vi.useRealTimers();
});

describe("cancellable cached palette search (NV-12)", () => {
  it("does nothing while closed and searches nothing before a meaningful query", async () => {
    await render({ open: false });
    await settle();
    expect(api.workspaces).not.toHaveBeenCalled();
    await render({ query: "n" });
    await settle();
    expect(api.workspaces).toHaveBeenCalledTimes(1);
    expect(api.sessions).not.toHaveBeenCalled();
    expect(api.resources).not.toHaveBeenCalled();
    expect(owner.groups).toEqual([]);
  });

  it("cancels superseded keystrokes and never empties the list between waves", async () => {
    await render({ query: "ab" });
    await settle();
    expect(threads()?.items[0]?.label).toBe("Match for ab");
    const abc = deferred<ReturnType<typeof conversation>>();
    const abcd = deferred<ReturnType<typeof conversation>>();
    api.sessions.mockReturnValueOnce(abc.promise).mockReturnValueOnce(abcd.promise);

    await render({ query: "abc" });
    await settle();
    console.log(
      "DEBUG2",
      JSON.stringify(threads()),
      api.sessions.mock.calls.map((c) => c[0].query),
    );
    const abcSignal = api.sessions.mock.calls.at(-1)?.[1]?.signal as AbortSignal;
    expect(api.sessions.mock.calls.at(-1)?.[0]).toMatchObject({ query: "abc" });
    expect(threads()?.items[0]?.label).toBe("Match for ab");

    await render({ query: "abcd" });
    await settle();
    expect(abcSignal.aborted).toBe(true);
    expect(threads()?.items[0]?.label).toBe("Match for ab");
    expect(owner.loading).toBe(true);

    await act(async () => abcd.resolve(conversation("abcd")));
    await settle(0);
    expect(threads()?.items[0]?.label).toBe("Match for abcd");
    expect(owner.loading).toBe(false);
  });

  it("filters the cached Inbox and capability catalog without reading them", async () => {
    await render({ query: "needle" });
    await settle();
    expect(owner.groups.find((group) => group.id === "inbox")?.items[0]?.label).toBe("Needle approval");
    expect(owner.groups.find((group) => group.id === "capabilities")?.error).toBeUndefined();
    expect(api.inbox).not.toHaveBeenCalled();
    expect(api.catalog).not.toHaveBeenCalled();
  });

  it("checks the workspace once per opening, and withholds earlier matches until the new check passes", async () => {
    await render({ query: "needle" });
    await settle();
    await render({ query: "needles" });
    await settle();
    await render({ query: "needle" });
    await settle();
    expect(api.workspaces).toHaveBeenCalledTimes(1);
    expect(threads()?.items[0]?.label).toBe("Match for needle");

    await render({ open: false });
    const check = deferred<{ items: unknown[] }>();
    api.workspaces.mockReturnValueOnce(check.promise);
    await render({ query: "needle" });
    await settle(0);
    expect(api.workspaces).toHaveBeenCalledTimes(2);
    expect(owner.groups).toEqual([]);
    expect(owner.loading).toBe(true);
    await act(async () =>
      check.resolve({ items: [{ workspaceId: "a", citadelId: "citadel", lifecycleStatus: "active" }] }),
    );
    await settle();
    expect(threads()?.items[0]?.label).toBe("Match for needle");
  });

  it("never keeps another workspace's matches while the new workspace is searched", async () => {
    await render({ query: "needle" });
    await settle();
    const other = deferred<ReturnType<typeof conversation>>();
    api.sessions.mockReturnValueOnce(other.promise);
    await render({ workspaceId: "b", query: "needle" });
    await settle();
    expect(threads()?.items).toEqual([]);
    expect(threads()?.searching).toBe(true);
    await act(async () => other.resolve(conversation("needle", "b")));
    await settle(0);
    expect(threads()?.items[0]?.id).toBe("b-needle");
  });

  it("shows a failed workspace check once instead of per group", async () => {
    api.workspaces.mockResolvedValue({ items: [] });
    await render({ query: "needle" });
    await settle();
    expect(owner.error).toContain("could not be verified");
    expect(owner.groups).toEqual([]);
    expect(api.sessions).not.toHaveBeenCalled();
  });
});
