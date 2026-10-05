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
    expect(container.textContent).toContain("96 background signals are hidden.");
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
