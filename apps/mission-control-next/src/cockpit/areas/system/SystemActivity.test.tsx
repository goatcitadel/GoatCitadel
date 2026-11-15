// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider, type Query } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACTIVITY_FALLBACK_MS } from "../../data/activity-feed";
import { queryKeys } from "../../data/query-keys";
import { SHOW_BACKGROUND_KEY, SystemActivity } from "./SystemActivity";

const stream = vi.hoisted(() => ({ state: "open" }));
const api = vi.hoisted(() => ({ fetchRealtimeEvents: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/hooks/useEventStreamStatus", () => ({
  useEventStreamStatus: () => ({ state: stream.state, reconnectAttempts: 0 }),
}));
vi.mock("@goatcitadel/mission-control-shared/api/system", () => ({ fetchRealtimeEvents: api.fetchRealtimeEvents }));
const prefs = vi.hoisted(() => ({ workspace: "workspace-a" }));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@goatcitadel/mission-control-shared/state/ui-preferences")>();
  return { ...actual, useUiPreferences: () => ({ ...actual.useUiPreferences(), activeWorkspaceId: prefs.workspace }) };
});
vi.mock("./RecentSessions", () => ({ RecentSessions: () => <p>Recent sessions owner</p> }));

let root: Root, container: HTMLDivElement, client: QueryClient;
const interval = () => {
  const query = client.getQueryCache().find({ queryKey: queryKeys.systemActivity() }) as Query | undefined;
  // refetchInterval is an observer option, so the cached query's options type omits it.
  return (query?.options as { refetchInterval?: number | false } | undefined)?.refetchInterval;
};

const signal = (id: string, kind: string, at: string, extra: Record<string, unknown> = {}) => ({
  eventId: id,
  sequence: 1,
  eventType: kind.startsWith("llamacpp_") ? "system" : kind,
  source: "gateway",
  timestamp: at,
  payload: kind.startsWith("llamacpp_") ? { type: kind } : {},
  ...extra,
});

beforeEach(() => {
  prefs.workspace = "workspace-a";
  window.sessionStorage.clear();
  api.fetchRealtimeEvents.mockReset().mockResolvedValue({ items: [] });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  client.clear();
});

async function render() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <SystemActivity />
      </QueryClientProvider>,
    ),
  );
}

describe("System activity polling (WK-13)", () => {
  it("shows recent sessions beside the activity feed", async () => {
    await render();
    expect(document.body.textContent).toContain("Recent sessions owner");
  });

  it("does not poll while live events extend the feed", async () => {
    stream.state = "open";
    await render();
    expect(interval()).toBe(false);
  });

  it("falls back to a slow poll while the stream is not open", async () => {
    stream.state = "retrying";
    await render();
    expect(interval()).toBe(ACTIVITY_FALLBACK_MS);
  });
});

describe("System activity reads as sentences (SY-01)", () => {
  const refreshes = Array.from({ length: 96 }, (_, index) =>
    signal(
      `refresh-${index}`,
      "llamacpp_refreshed",
      new Date(Date.parse("2026-10-05T10:02:00.000Z") - index * 1250).toISOString(),
      { eventClass: "operational_signal" },
    ),
  );
  const items = [
    signal("message", "chat_message", "2026-10-05T10:03:00.000Z", {
      eventClass: "domain_fact",
      payload: { title: "Backup plan" },
      links: { sessionId: "session-a", workspaceId: "w" },
    }),
    ...refreshes,
    signal("approval", "approval_created", "2026-10-05T09:59:00.000Z", { eventClass: "domain_fact" }),
  ];

  async function settle() {
    for (let pass = 0; pass < 5; pass += 1)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
  }

  it("hides background signals by default and shows them collapsed when asked", async () => {
    stream.state = "open";
    api.fetchRealtimeEvents.mockResolvedValue({ items });
    await render();
    await settle();
    const rows = () => [...container.querySelectorAll("ol > li")].map((node) => node.textContent ?? "");
    expect(rows()).toHaveLength(2);
    expect(rows()[0]).toContain("New message in “Backup plan”");
    expect(rows()[0]).toContain("Record");
    expect(rows()[0]).toContain("Open source");
    expect(rows()[1]).toContain("An approval is waiting for you");
    expect(container.textContent).toContain("Showing 2 entries.");
    expect(container.textContent).toContain("96 background signals are hidden.");
    // Identifiers live only in technical details, and the retention caveat is stated once for the list.
    expect(rows()[0]).not.toContain("session-a");
    expect(rows()[0]).not.toContain("Workspace");
    expect(rows()[0]).not.toContain("does not show its current health");
    expect(container.textContent?.split("does not show its current health")).toHaveLength(2);
    for (const text of rows()) expect(text).not.toContain("_");

    const toggle = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(toggle.checked).toBe(false);
    await act(async () => toggle.click());
    expect(rows()).toHaveLength(3);
    expect(rows()[1]).toContain("Local model status changed");
    expect(rows()[1]).toContain("×96 in 2 min");
    expect(rows()[1]).toContain("System signal");
    expect(window.sessionStorage.getItem(SHOW_BACKGROUND_KEY)).toBe("true");
    for (const text of rows()) expect(text).not.toContain("_");
  });

  it("remembers the choice for this browser session", async () => {
    window.sessionStorage.setItem(SHOW_BACKGROUND_KEY, "true");
    api.fetchRealtimeEvents.mockResolvedValue({ items });
    await render();
    await settle();
    expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(true);
    expect(container.querySelectorAll("ol > li")).toHaveLength(3);
  });
});

describe("System activity older signals and counts (22.4)", () => {
  async function settle() {
    for (let pass = 0; pass < 5; pass += 1)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
  }
  const background = (id: string, at: string) =>
    signal(id, "llamacpp_refreshed", at, { eventClass: "operational_signal" });

  it("counts the entries listed, and says repeated background signals were merged", async () => {
    window.sessionStorage.setItem(SHOW_BACKGROUND_KEY, "true");
    api.fetchRealtimeEvents.mockResolvedValue({
      items: [background("a", "2026-10-05T10:02:00.000Z"), background("b", "2026-10-05T10:01:30.000Z")],
    });
    await render();
    await settle();
    expect(container.textContent).toContain("Showing 1 entry from 2 signals; repeated background signals are merged.");
  });

  it("loads older signals with the cursor, lists them once, and ends with a Work history link", async () => {
    const first = signal("n1", "approval_created", "2026-10-05T10:00:00.000Z", { eventClass: "domain_fact" });
    const old = signal("o1", "approval_created", "2026-10-04T10:00:00.000Z", { eventClass: "domain_fact" });
    api.fetchRealtimeEvents
      .mockResolvedValueOnce({ items: [first], nextCursor: "c1" })
      .mockResolvedValueOnce({ items: [first, old] });
    await render();
    await settle();
    expect(container.textContent).not.toContain("Open Work history");
    const load = [...container.querySelectorAll("button")].find((node) =>
      node.textContent?.includes("Load older signals"),
    )!;
    await act(async () => load.click());
    await settle();
    expect(api.fetchRealtimeEvents).toHaveBeenLastCalledWith(100, "c1");
    expect(container.querySelectorAll("ol > li")).toHaveLength(2);
    expect(container.textContent).toContain("Showing 2 entries.");
    expect(container.textContent).toContain("That is everything this installation keeps.");
    expect(container.textContent).toContain("Open Work history");
    expect(container.textContent).not.toContain("Load older signals");
  });

  it("drops loaded older pages when the workspace changes, and ignores a late answer for the old one", async () => {
    const first = signal("n1", "approval_created", "2026-10-05T10:00:00.000Z", { eventClass: "domain_fact" });
    const old = signal("o1", "chat_message", "2026-10-04T10:00:00.000Z", {
      eventClass: "domain_fact",
      payload: { title: "Old thread" },
    });
    const late = signal("o2", "chat_message", "2026-10-03T10:00:00.000Z", {
      eventClass: "domain_fact",
      payload: { title: "Late thread" },
    });
    let answerLate!: (value: unknown) => void;
    api.fetchRealtimeEvents
      .mockResolvedValueOnce({ items: [first], nextCursor: "c1" })
      .mockResolvedValueOnce({ items: [old], nextCursor: "c2" })
      .mockImplementationOnce(() => new Promise((resolve) => (answerLate = resolve)));
    await render();
    await settle();
    const loadButton = () =>
      [...container.querySelectorAll("button")].find((node) => node.textContent?.includes("Load older signals"))!;
    await act(async () => loadButton().click());
    await settle();
    expect(container.textContent).toContain("Old thread");
    await act(async () => loadButton().click());
    await settle();
    prefs.workspace = "workspace-b";
    await render();
    await settle();
    expect(container.textContent).not.toContain("Old thread");
    await act(async () => answerLate({ items: [late] }));
    await settle();
    expect(container.textContent).not.toContain("Late thread");
    expect(container.querySelectorAll("ol > li")).toHaveLength(1);
  });

  it("drops loaded older pages when the operator refreshes the list", async () => {
    const first = signal("n1", "approval_created", "2026-10-05T10:00:00.000Z", { eventClass: "domain_fact" });
    const old = signal("o1", "chat_message", "2026-10-04T10:00:00.000Z", {
      eventClass: "domain_fact",
      payload: { title: "Old thread" },
    });
    api.fetchRealtimeEvents
      .mockResolvedValueOnce({ items: [first], nextCursor: "c1" })
      .mockResolvedValueOnce({ items: [old] })
      .mockResolvedValue({ items: [first], nextCursor: "c1" });
    await render();
    await settle();
    const byText = (text: string) =>
      [...container.querySelectorAll("button")].find((node) => node.textContent?.includes(text))!;
    await act(async () => byText("Load older signals").click());
    await settle();
    expect(container.textContent).toContain("Old thread");
    await act(async () => byText("Refresh").click());
    await settle();
    expect(container.textContent).not.toContain("Old thread");
  });

  it("shows the Work history link when no older signals exist from the start", async () => {
    api.fetchRealtimeEvents.mockResolvedValue({
      items: [signal("n1", "approval_created", "2026-10-05T10:00:00.000Z", { eventClass: "domain_fact" })],
    });
    await render();
    await settle();
    expect(container.textContent).toContain("Open Work history");
  });

  it("says older signals could not be loaded, and keeps the button to try again", async () => {
    api.fetchRealtimeEvents
      .mockResolvedValueOnce({
        items: [signal("n1", "approval_created", "2026-10-05T10:00:00.000Z", { eventClass: "domain_fact" })],
        nextCursor: "c1",
      })
      .mockRejectedValueOnce(new Error("boom"));
    await render();
    await settle();
    const load = [...container.querySelectorAll("button")].find((node) =>
      node.textContent?.includes("Load older signals"),
    )!;
    await act(async () => load.click());
    await settle();
    expect(container.textContent).toContain("Could not load older signals.");
    expect(
      [...container.querySelectorAll("button")].some((node) => node.textContent?.includes("Load older signals")),
    ).toBe(true);
  });
});
