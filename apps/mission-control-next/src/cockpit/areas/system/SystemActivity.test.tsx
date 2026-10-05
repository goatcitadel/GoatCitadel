// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider, type Query } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACTIVITY_FALLBACK_MS } from "../../data/activity-feed";
import { queryKeys } from "../../data/query-keys";
import { SystemActivity } from "./SystemActivity";

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

beforeEach(() => {
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
