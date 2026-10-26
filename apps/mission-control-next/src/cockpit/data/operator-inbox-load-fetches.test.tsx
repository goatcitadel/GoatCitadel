// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OperatorInboxResponse, RealtimeEvent } from "@goatcitadel/contracts";
import type { UiNotificationPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { useCockpitRealtime } from "./realtime";
import { useCachedInboxItem, useOperatorInbox } from "./use-operator-inbox";
import { createCockpitQueryClient } from "./query-client";
import { queryKeys } from "./query-keys";

const mocks = vi.hoisted(() => ({ connect: vi.fn(), read: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/shell-client", () => ({ connectEventStream: mocks.connect }));
vi.mock("@goatcitadel/mission-control-shared/api/operator-inbox", () => ({ fetchOperatorInbox: mocks.read }));
vi.mock("../app/use-cockpit-route", () => ({ useCockpitRoute: () => ({ navigate: vi.fn() }) }));

/** `generatedAt` is the Gateway clock time the snapshot was built, the reference for replayed events. */
const projectionAt = (generatedAt: string) =>
  ({ authority: "derived_projection", workspaceId: "w", items: [], generatedAt }) as unknown as OperatorInboxResponse;
const projection = projectionAt(new Date().toISOString());
const preferences: UiNotificationPreferences = {
  toastsEnabled: true,
  soundMode: "off",
  desktopEnabled: false,
  onlyWhenUnfocused: false,
};
const replayedEvent = (id: string, timestamp: string): RealtimeEvent => ({
  eventId: id,
  sequence: 1,
  eventType: "approval_created",
  source: "approvals",
  timestamp,
  eventClass: "domain_fact",
  eventAuthority: "retained_stream",
  payload: {},
});

/** The consumers that mount together on the Inbox route: sidebar, tab bar, area and a detail pane. */
function InboxRoute({ client }: { client: QueryClient }) {
  useOperatorInbox("w");
  useOperatorInbox("w");
  useOperatorInbox("w");
  useCachedInboxItem("w", "x");
  useCockpitRealtime({ queryClient: client, enabled: true, workspaceId: "w", notificationPreferences: preferences });
  return null;
}

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
let onEvent: (event: RealtimeEvent, delivery: { replayed: boolean }) => void;

async function settle(ms = 400) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.connect.mockImplementation((callback) => {
    onEvent = callback;
    return () => undefined;
  });
  mocks.read.mockImplementation(async () => projectionAt(new Date().toISOString()));
  client = createCockpitQueryClient();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  client.clear();
  container.remove();
});

async function mount() {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <InboxRoute client={client} />
      </QueryClientProvider>,
    );
  });
}

describe("Inbox route load", () => {
  it("fetches the operator inbox once for simultaneous mounts", async () => {
    await mount();
    await settle();
    expect(mocks.read).toHaveBeenCalledTimes(1);
  });

  it("does not refetch for stream-replayed history the loaded snapshot already covers", async () => {
    await mount();
    await settle(50);
    const old = new Date(Date.now() - 60_000).toISOString();
    await act(async () => {
      for (let i = 0; i < 5; i++) onEvent(replayedEvent(`e${i}`, old), { replayed: true });
    });
    await settle();
    expect(mocks.read).toHaveBeenCalledTimes(1);
  });

  it("does not cancel and restart the first load for replayed history that predates it", async () => {
    let resolveFirst!: (value: OperatorInboxResponse) => void;
    mocks.read.mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)));
    await mount();
    const old = new Date(Date.now() - 60_000).toISOString();
    await act(async () => {
      onEvent(replayedEvent("e1", old), { replayed: true });
    });
    await settle(250);
    await act(async () => resolveFirst(projection));
    await settle();
    expect(mocks.read).toHaveBeenCalledTimes(1);
  });

  it("still refetches for a live inbox-changing event", async () => {
    await mount();
    await settle(50);
    await act(async () => {
      onEvent(replayedEvent("live", new Date().toISOString()), { replayed: false });
    });
    await settle();
    // A live approval also starts the notification reader's own owner read, so this may exceed two.
    expect(mocks.read.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("still refetches for a replayed event newer than the loaded snapshot", async () => {
    await mount();
    await settle(50);
    await act(async () => {
      onEvent(replayedEvent("later", new Date(Date.now() + 60_000).toISOString()), { replayed: true });
    });
    await settle();
    expect(mocks.read).toHaveBeenCalledTimes(2);
  });

  it("compares a replayed event with the snapshot's Gateway time, not the browser clock", async () => {
    // The browser fetched just now, but the Gateway (another machine) stamped the snapshot an hour earlier.
    const gatewaySnapshot = new Date(Date.now() - 3_600_000);
    mocks.read.mockImplementation(async () => projectionAt(gatewaySnapshot.toISOString()));
    await mount();
    await settle(50);
    // On the Gateway clock this event is newer than the snapshot, though it is older than the browser fetch.
    const eventAt = new Date(gatewaySnapshot.getTime() + 5_000).toISOString();
    await act(async () => {
      onEvent(replayedEvent("skewed", eventAt), { replayed: true });
    });
    await settle();
    expect(mocks.read).toHaveBeenCalledTimes(2);
  });

  it("refetches for replayed history when the snapshot carries no Gateway time", async () => {
    mocks.read.mockImplementation(async () => ({ authority: "derived_projection", workspaceId: "w", items: [] }));
    await mount();
    await settle(50);
    await act(async () => {
      onEvent(replayedEvent("old", new Date(Date.now() - 60_000).toISOString()), { replayed: true });
    });
    await settle();
    expect(mocks.read).toHaveBeenCalledTimes(2);
  });

  it("still refetches on an explicit operator refresh", async () => {
    await mount();
    await settle(50);
    await act(async () => {
      await client.invalidateQueries({ queryKey: queryKeys.inbox("w") });
    });
    expect(mocks.read).toHaveBeenCalledTimes(2);
  });
});
