// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OperatorInboxResponse, RealtimeEvent } from "@goatcitadel/contracts";
import type { UiNotificationPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { useCockpitRealtime } from "./realtime";
import { queryKeys } from "./query-keys";
import { setGatewayCallerScope } from "@goatcitadel/mission-control-shared/api/access-scope";

const mocks = vi.hoisted(() => ({
  installation: "http://owner-a.invalid",
  accessRevision: 0,
  connect: vi.fn(),
  read: vi.fn(),
  show: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  navigate: vi.fn(),
  sound: vi.fn(),
  desktop: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@goatcitadel/mission-control-shared/api/client-core")>()),
  getGatewayApiBaseUrl: () => mocks.installation,
  getGatewayAccessRevision: () => mocks.accessRevision,
}));
vi.mock("@goatcitadel/mission-control-shared/api/shell-client", () => ({ connectEventStream: mocks.connect }));
vi.mock("@goatcitadel/mission-control-shared/api/operator-inbox", () => ({ fetchOperatorInbox: mocks.read }));
vi.mock("sonner", () => ({ toast: Object.assign(mocks.show, { warning: mocks.warning, error: mocks.error }) }));
vi.mock("../app/use-cockpit-route", () => ({ useCockpitRoute: () => ({ navigate: mocks.navigate }) }));
vi.mock("@goatcitadel/mission-control-shared/state/operator-attention", () => ({
  playOperatorAttentionSound: mocks.sound,
}));
vi.mock("../../app/browser-notification", () => ({ showBrowserNotification: mocks.desktop }));
const item = {
  id: "approval:a",
  kind: "approval",
  group: "needs_decision",
  title: "Review exact write",
  summary: "Gateway record",
  source: { workspaceId: "w", approvalId: "a" },
  href: "/ops/approvals",
  createdAt: "2026-09-30T00:00:00Z",
} as const;
const projection = {
  authority: "derived_projection",
  workspaceId: "w",
  items: [item],
} as unknown as OperatorInboxResponse;
const event: RealtimeEvent = {
  eventId: "e",
  sequence: 1,
  eventType: "approval_created",
  source: "approvals",
  timestamp: "2026-09-30T00:00:00Z",
  eventClass: "domain_fact",
  eventAuthority: "retained_stream",
  links: { approvalId: "a" },
  payload: {},
};
let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
let onEvent: (event: RealtimeEvent, delivery: { replayed: boolean }) => void;
const disconnect = vi.fn();
const defaultPreferences: UiNotificationPreferences = {
  toastsEnabled: true,
  soundMode: "off",
  desktopEnabled: false,
  onlyWhenUnfocused: false,
};
function Harness({
  workspaceId = "w",
  visibleSessionId,
  enabled = true,
  notificationPreferences = defaultPreferences,
}: {
  workspaceId?: string;
  visibleSessionId?: string;
  enabled?: boolean;
  notificationPreferences?: UiNotificationPreferences;
}) {
  useCockpitRealtime({ queryClient: client, enabled, workspaceId, visibleSessionId, notificationPreferences });
  return null;
}
async function render(props = {}) {
  await act(async () => {
    root.render(<Harness {...props} />);
  });
}
async function emit(value = event, replayed = false) {
  await act(async () => {
    onEvent(value, { replayed });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.installation = "http://owner-a.invalid";
  mocks.accessRevision = 0;
  setGatewayCallerScope("");
  mocks.connect.mockImplementation((callback) => {
    onEvent = callback;
    return disconnect;
  });
  mocks.read.mockResolvedValue(projection);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  client.clear();
  container.remove();
  vi.restoreAllMocks();
});
it("retains four distinct live targets through repeated cancellation and active owner refetch", async () => {
  const records = Array.from({ length: 4 }, (_, index) => ({
    ...item,
    id: `approval:burst-${index}`,
    title: `Current approval ${index}`,
    source: { workspaceId: "w", approvalId: `burst-${index}` },
  }));
  const reads: Array<{ signal: AbortSignal; resolve: (value: OperatorInboxResponse) => void }> = [];
  mocks.read.mockImplementation(
    (_workspace, { signal }: { signal: AbortSignal }) =>
      new Promise((resolve, reject) => {
        reads.push({ signal, resolve });
        signal.addEventListener("abort", () => reject(new DOMException("Replaced", "AbortError")), { once: true });
      }),
  );
  const key = queryKeys.inbox("w");
  client.setQueryData(key, { ...projection, items: [] });
  const observer = new QueryObserver(client, {
    queryKey: key,
    staleTime: Infinity,
    queryFn: ({ signal }) => mocks.read("w", { signal }) as Promise<OperatorInboxResponse>,
  });
  const unsubscribe = observer.subscribe(() => undefined);
  try {
    await render();
    for (let index = 0; index < records.length; index++) {
      await emit({
        ...event,
        eventId: `burst-event-${index}`,
        sequence: index + 1,
        links: { workspaceId: "w", approvalId: records[index]!.source.approvalId },
      });
      // Both broad and exact invalidation are production paths. Leave their reads in flight.
      await act(async () => {
        void client.invalidateQueries({ queryKey: ["approvals"] });
        void client.invalidateQueries({ queryKey: key });
      });
    }
    expect(reads.filter((read) => read.signal.aborted).length).toBeGreaterThanOrEqual(4);
    expect(mocks.warning).not.toHaveBeenCalled();
    await act(async () => {
      reads.at(-1)!.resolve({ ...projection, items: records });
    });
    expect(mocks.warning.mock.calls.map(([title]) => title).sort()).toEqual(
      records.map((record) => record.title).sort(),
    );
    expect(mocks.warning).toHaveBeenCalledTimes(4);
    await emit({ ...event, eventId: "repeat", links: { approvalId: "burst-0" } });
    await act(async () => {
      reads.at(-1)!.resolve({ ...projection, items: records });
    });
    expect(mocks.warning).toHaveBeenCalledTimes(4);
    for (const [, options] of mocks.warning.mock.calls) options.action.onClick();
    expect(mocks.navigate.mock.calls.map(([url]) => url).sort()).toEqual(
      records.map((record) => `/inbox?approvalId=${record.source.approvalId}&workspaceId=w`).sort(),
    );
  } finally {
    unsubscribe();
  }
});
it("retires pending reads and shown actions immediately on caller revision change", async () => {
  await render();
  await emit();
  const action = mocks.warning.mock.calls[0]![1].action;
  let finish!: (value: OperatorInboxResponse) => void;
  mocks.read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await emit({ ...event, eventId: "pending", links: { approvalId: "b" } });
  mocks.accessRevision++;
  action.onClick();
  await act(async () =>
    finish({ ...projection, items: [{ ...item, id: "approval:b", source: { workspaceId: "w", approvalId: "b" } }] }),
  );
  expect(mocks.navigate).not.toHaveBeenCalled();
  expect(mocks.warning).toHaveBeenCalledTimes(1);
});
it("withholds permission failures without polling or retrying", async () => {
  mocks.read.mockRejectedValue(Object.assign(new Error("Forbidden"), { status: 403 }));
  await render();
  await emit();
  await new Promise((resolve) => setTimeout(resolve, 160));
  expect(mocks.read).toHaveBeenCalledTimes(1);
  expect(mocks.warning).not.toHaveBeenCalled();
});
it("retires old pending signals across a same-render caller away-and-back change", async () => {
  let finish!: (value: OperatorInboxResponse) => void;
  mocks.read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await render();
  const previousEvent = onEvent;
  await emit();
  await act(async () => {
    setGatewayCallerScope("other");
    setGatewayCallerScope("");
  });
  await act(async () => finish(projection));
  await act(async () => previousEvent(event, { replayed: false }));
  expect(mocks.warning).not.toHaveBeenCalled();
  expect(mocks.read).toHaveBeenCalledTimes(1);
  mocks.read.mockResolvedValue(projection);
  await emit();
  expect(mocks.warning).toHaveBeenCalledOnce();
});
it("does not promote manual cache writes into notification authority", async () => {
  let finish!: (value: OperatorInboxResponse) => void;
  mocks.read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await render();
  await emit();
  await act(async () => {
    client.setQueryData(queryKeys.inbox("w"), projection);
  });
  expect(mocks.warning).not.toHaveBeenCalled();
  await act(async () => finish(projection));
  expect(mocks.warning).toHaveBeenCalledOnce();
});
it.each(["missing", "ambiguous", "expired", "foreign"])(
  "withholds %s owner records after a replaced read",
  async (kind) => {
    const finish: Array<(value: OperatorInboxResponse) => void> = [];
    mocks.read.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish.push(resolve);
        }),
    );
    await render();
    await emit();
    await emit({ ...event, eventId: "replacement" });
    const items =
      kind === "missing"
        ? []
        : kind === "ambiguous"
          ? [item, { ...item, id: "duplicate" }]
          : kind === "expired"
            ? [{ ...item, expiresAt: "2000-01-01" }]
            : [{ ...item, source: { ...item.source, workspaceId: "foreign" } }];
    await act(async () => finish.at(-1)!({ ...projection, items }));
    expect(mocks.warning).not.toHaveBeenCalled();
  },
);
describe("cockpit owner-backed notifications", () => {
  it("reads the current Inbox, groups repeats, and opens the exact item", async () => {
    await render();
    await emit();
    await emit();
    expect(mocks.read).toHaveBeenCalledWith("w", { signal: expect.any(AbortSignal) });
    expect(mocks.warning).toHaveBeenCalledTimes(1);
    const call = mocks.warning.mock.calls[0];
    if (!call) throw new Error("Expected a current Inbox notification");
    const [title, options] = call;
    expect(title).toBe(item.title);
    expect(options.description).toBe(item.summary);
    expect(options.duration).toBe(6000);
    options.action.onClick();
    expect(mocks.navigate).toHaveBeenCalledWith("/inbox?approvalId=a&workspaceId=w");
  });
  it("uses current reviewed navigation without reconnecting the stream or replaying a shown toast", async () => {
    await render();
    await emit();
    const original = mocks.navigate;
    const action = mocks.warning.mock.calls[0]![1].action;
    const current = vi.fn();
    mocks.navigate = current;
    try {
      await render();
      action.onClick();
      expect(mocks.connect).toHaveBeenCalledTimes(1);
      expect(disconnect).not.toHaveBeenCalled();
      expect(mocks.warning).toHaveBeenCalledTimes(1);
      expect(original).not.toHaveBeenCalled();
      expect(current).toHaveBeenCalledWith("/inbox?approvalId=a&workspaceId=w");
      await render({ workspaceId: "foreign" });
      action.onClick();
      expect(current).toHaveBeenCalledTimes(1);
    } finally {
      mocks.navigate = original;
    }
  });
  it("never sends a retained installation A notification through installation B navigation", async () => {
    await render();
    await emit();
    const oldEvent = onEvent;
    const oldAction = mocks.warning.mock.calls[0]![1].action;
    mocks.installation = "http://owner-b.invalid";
    await act(async () => {
      oldAction.onClick();
      oldEvent(event, { replayed: false });
    });
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(mocks.read).toHaveBeenCalledTimes(1);
    await render();
    oldAction.onClick();
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(mocks.connect).toHaveBeenCalledTimes(2);
    expect(mocks.warning).toHaveBeenCalledTimes(1);
  });

  it("silences replay frames without an owner fetch", async () => {
    await render();
    await emit(event, true);
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.warning).not.toHaveBeenCalled();
  });
  it("does not reuse an Inbox request begun before the live signal", async () => {
    let finish!: (value: OperatorInboxResponse) => void;
    const oldRead = client.fetchQuery({
      queryKey: queryKeys.inbox("w"),
      queryFn: () =>
        new Promise<OperatorInboxResponse>((resolve) => {
          finish = resolve;
        }),
    });
    await render();
    await emit();
    expect(mocks.read).toHaveBeenCalledWith("w", { signal: expect.any(AbortSignal) });
    expect(mocks.warning).toHaveBeenCalledOnce();
    finish({ ...projection, items: [] });
    await oldRead;
  });
  it("withholds a failed or foreign owner response", async () => {
    await render();
    mocks.read.mockRejectedValueOnce(new Error("offline"));
    await emit();
    mocks.read.mockResolvedValueOnce({ ...projection, workspaceId: "foreign" });
    await emit();
    expect(mocks.warning).not.toHaveBeenCalled();
  });
  it("ignores an old workspace read after navigating away and back, without reconnecting", async () => {
    let finish!: (value: OperatorInboxResponse) => void;
    mocks.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await render();
    await emit();
    await render({ workspaceId: "other" });
    await render();
    await act(async () => {
      finish(projection);
      await Promise.resolve();
    });
    expect(mocks.warning).not.toHaveBeenCalled();
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(disconnect).not.toHaveBeenCalled();
  });
  it("replaces a read begun before a later live signal and ignores late results once disabled", async () => {
    const finish: Array<(value: OperatorInboxResponse) => void> = [];
    mocks.read.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish.push(resolve);
        }),
    );
    await render();
    await emit();
    await emit({ ...event, eventId: "second", sequence: 2 });
    const signals = mocks.read.mock.calls.map((call) => call[1].signal as AbortSignal);
    expect(signals).toHaveLength(2);
    expect(signals[0]?.aborted).toBe(true);
    await render({ enabled: false });
    expect(disconnect).toHaveBeenCalledTimes(1);
    await act(async () => {
      for (const resolve of finish) resolve(projection);
      await Promise.resolve();
    });
    expect(mocks.warning).not.toHaveBeenCalled();
  });
  it("shares one Inbox read between toast-worthy events delivered in the same tick (GL-63)", async () => {
    await render();
    await act(async () => {
      onEvent(event, { replayed: false });
      onEvent({ ...event, eventId: "second", sequence: 2 }, { replayed: false });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mocks.read).toHaveBeenCalledTimes(1);
    expect(mocks.warning).toHaveBeenCalledTimes(1);
  });
  it("keeps the stream connected when the workspace changes (GL-64)", async () => {
    await render();
    await render({ workspaceId: "other" });
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(disconnect).not.toHaveBeenCalled();
  });
  it("publishes stream status for the shared Chat controller", async () => {
    await render();
    expect(mocks.connect).toHaveBeenCalledWith(expect.any(Function), expect.any(Function), expect.any(Function));
  });
  it("does not open a previously shown toast after its workspace changes", async () => {
    await render();
    await emit();
    const call = mocks.warning.mock.calls[0];
    if (!call) throw new Error("Expected a current Inbox notification");
    const action = call[1].action;
    await render({ workspaceId: "other" });
    action.onClick();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });
  it("rechecks the visible conversation when an owner read finishes", async () => {
    let finish!: (value: OperatorInboxResponse) => void;
    mocks.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    await render();
    await emit();
    await render({ visibleSessionId: "s" });
    await act(async () => {
      finish({ ...projection, items: [{ ...item, source: { ...item.source, sessionId: "s" } }] });
      await Promise.resolve();
    });
    expect(mocks.warning).not.toHaveBeenCalled();
  });
  it("honors updated preferences without reconnecting the stream", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await render();
    await render({
      notificationPreferences: {
        ...defaultPreferences,
        toastsEnabled: false,
        soundMode: "subtle",
        desktopEnabled: true,
      },
    });
    await emit();
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(mocks.warning).not.toHaveBeenCalled();
    expect(mocks.sound).toHaveBeenCalledWith("waiting", "subtle");
    expect(mocks.desktop).toHaveBeenCalledWith(
      item.title,
      "warning",
      expect.objectContaining({ tag: "inbox:w:approval:a" }),
    );
  });
  it("does not send desktop attention from a visible but unfocused document", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    await render({ notificationPreferences: { ...defaultPreferences, desktopEnabled: true } });
    await emit();
    expect(mocks.warning).toHaveBeenCalledOnce();
    expect(mocks.desktop).not.toHaveBeenCalled();
  });
  it("honors only-when-unfocused for every attention channel", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    await render({
      notificationPreferences: {
        ...defaultPreferences,
        onlyWhenUnfocused: true,
        desktopEnabled: true,
        soundMode: "normal",
      },
    });
    await emit();
    expect(mocks.warning).not.toHaveBeenCalled();
    expect(mocks.sound).not.toHaveBeenCalled();
    expect(mocks.desktop).not.toHaveBeenCalled();
  });
});
