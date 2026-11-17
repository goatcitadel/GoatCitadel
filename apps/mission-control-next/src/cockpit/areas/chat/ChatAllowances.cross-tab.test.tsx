// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { RealtimeEvent, ToolGrantRecord } from "@goatcitadel/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useCockpitRealtime } from "../../data/realtime";
import { __resetMinuteClockForTests } from "../inbox/use-minute-clock";
import { ChatAllowances } from "./ChatAllowances";

const api = vi.hoisted(() => ({
  fetchToolGrants: vi.fn(),
  revokeToolGrant: vi.fn(),
  connectEventStream: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/approvals", () => api);
vi.mock("@goatcitadel/mission-control-shared/api/shell-client", () => ({
  connectEventStream: api.connectEventStream,
}));
vi.mock("../../app/use-cockpit-route", () => ({ useCockpitRoute: () => ({ navigate: api.navigate }) }));

const scope = { workspaceId: "default", sessionId: "chat-1" };
const start = Date.parse("2026-11-16T23:10:00.000Z");
const memoryGrant: ToolGrantRecord = {
  grantId: "memory-grant",
  toolPattern: "memory.search",
  decision: "allow",
  scope: "session",
  scopeRef: scope.sessionId,
  grantType: "ttl",
  createdBy: "operator",
  createdAt: new Date(start).toISOString(),
  expiresAt: "2099-11-16T23:25:00Z",
};
const docsGrant: ToolGrantRecord = {
  ...memoryGrant,
  grantId: "docs-grant",
  toolPattern: "docs.search",
  grantType: "persistent",
  expiresAt: undefined,
};

const tabs: { container: HTMLDivElement; root: Root; client: QueryClient }[] = [];
let records: ToolGrantRecord[];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(start);
  __resetMinuteClockForTests();
  records = [memoryGrant, docsGrant];
  api.fetchToolGrants.mockReset().mockImplementation(async () => ({ items: structuredClone(records) }));
  api.revokeToolGrant.mockReset().mockImplementation(async (grantId: string) => {
    records = records.map((grant) =>
      grant.grantId === grantId ? { ...grant, revokedAt: new Date().toISOString() } : grant,
    );
    return { revoked: true, grantId };
  });
  api.connectEventStream.mockReset().mockImplementation(() => vi.fn());
});

afterEach(() => {
  for (const { container, root, client } of tabs.splice(0)) {
    act(() => root.unmount());
    client.clear();
    container.remove();
  }
  __resetMinuteClockForTests();
  vi.useRealTimers();
});

function Tab({ client }: { client: QueryClient }) {
  useCockpitRealtime({
    queryClient: client,
    enabled: true,
    workspaceId: scope.workspaceId,
    visibleSessionId: scope.sessionId,
    notificationPreferences: {
      toastsEnabled: false,
      soundMode: "off",
      desktopEnabled: false,
      onlyWhenUnfocused: false,
    },
  });
  return <ChatAllowances {...scope} />;
}

async function advance(ms: number) {
  await act(async () => vi.advanceTimersByTimeAsync(ms));
}

async function openTab() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false } },
  });
  tabs.push({ container, root, client });
  const streamIndex = api.connectEventStream.mock.calls.length;
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <Tab client={client} />
      </QueryClientProvider>,
    ),
  );
  const details = container.querySelector("details")!;
  await act(async () => {
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
  });
  await advance(10);
  const memory = () => details.querySelector<HTMLButtonElement>('button[aria-label*="memory" i]');
  const docs = () => details.querySelector<HTMLButtonElement>('button[aria-label*="doc" i]');
  expect(memory()).not.toBeNull();
  expect(docs()).not.toBeNull();
  const receive = api.connectEventStream.mock.calls[streamIndex]![0];
  expect(receive).toBeTypeOf("function");
  return { container, client, details, memory, docs, receive };
}

function expectOnlyDocuments(tab: Awaited<ReturnType<typeof openTab>>) {
  expect(tab.container.querySelector("details")).toBe(tab.details);
  expect(tab.details.open).toBe(true);
  expect(tab.memory()).toBeNull();
  expect(tab.docs()).not.toBeNull();
}

it("removes the ended allowance from both open details lists after the Gateway event", async () => {
  const first = await openTab();
  const second = await openTab();
  expect(first.client).not.toBe(second.client);
  expect(api.connectEventStream).toHaveBeenCalledTimes(2);

  await act(async () => first.memory()!.click());
  await advance(10);
  expectOnlyDocuments(first);
  expect(api.revokeToolGrant).toHaveBeenCalledExactlyOnceWith(memoryGrant.grantId);
  expect(second.memory()).not.toBeNull();
  const readsBeforeEvent = api.fetchToolGrants.mock.calls.length;

  const event: RealtimeEvent = {
    eventId: "grant-revoked",
    sequence: 1,
    eventType: "system",
    source: "tools",
    timestamp: new Date().toISOString(),
    eventAuthority: "retained_stream",
    eventClass: "operational_signal",
    payload: { type: "tool_grant_revoked", grantId: memoryGrant.grantId, revokedBy: "operator" },
  };
  await act(async () => {
    first.receive(event, { replayed: false });
    second.receive(event, { replayed: false });
  });
  await advance(250);
  expectOnlyDocuments(second);
  expect(api.fetchToolGrants.mock.calls.length).toBeGreaterThan(readsBeforeEvent);
  expect(api.revokeToolGrant).toHaveBeenCalledTimes(1);
});

it("removes the expired allowance from both open lists without a Gateway event or another read", async () => {
  const expiry = start + 20_000;
  records = [{ ...memoryGrant, expiresAt: new Date(expiry).toISOString() }, docsGrant];
  const first = await openTab();
  const second = await openTab();
  const readsBeforeExpiry = api.fetchToolGrants.mock.calls.length;

  await advance(expiry - Date.now() - 1);
  expect(first.memory()).not.toBeNull();
  expect(second.memory()).not.toBeNull();
  // The deadline timer fires one millisecond after the boundary, before the minute tick.
  await advance(2);
  expectOnlyDocuments(first);
  expectOnlyDocuments(second);
  expect(api.fetchToolGrants).toHaveBeenCalledTimes(readsBeforeExpiry);
  expect(api.revokeToolGrant).not.toHaveBeenCalled();
});

it("reconciles two End clicks against one revocation without losing the other grant", async () => {
  api.revokeToolGrant.mockImplementation(async (grantId: string) => {
    if (records.some((grant) => grant.grantId === grantId && grant.revokedAt)) throw new Error("Already revoked");
    records = records.map((grant) =>
      grant.grantId === grantId ? { ...grant, revokedAt: new Date().toISOString() } : grant,
    );
    return { revoked: true, grantId };
  });
  const first = await openTab();
  const second = await openTab();
  await act(async () => {
    first.memory()!.click();
    second.memory()!.click();
  });
  await advance(50);
  expectOnlyDocuments(first);
  expectOnlyDocuments(second);
  expect(first.details.textContent).toContain("Allowance ended");
  expect(second.details.textContent).toContain("already ended");
  expect(second.details.querySelector('[role="alert"]')).toBeNull();
  expect(api.revokeToolGrant.mock.calls).toEqual([[memoryGrant.grantId], [memoryGrant.grantId]]);
});

it("refreshes spent one-use allowances only for the Chat whose tool ran", async () => {
  const oneUse: ToolGrantRecord = { ...memoryGrant, grantType: "one_time", expiresAt: undefined, usesRemaining: 1 };
  records = [oneUse, docsGrant];
  const first = await openTab();
  const second = await openTab();
  const reads = api.fetchToolGrants.mock.calls.length;
  const invocation: RealtimeEvent = {
    eventId: "tool-invoked",
    sequence: 1,
    eventType: "tool_invoked",
    source: "policy",
    timestamp: new Date().toISOString(),
    eventAuthority: "retained_stream",
    eventClass: "operational_signal",
    links: { sessionId: scope.sessionId },
    payload: { outcome: "executed" },
  };
  const deliver = async (event: RealtimeEvent) => {
    await act(async () => {
      first.receive(event, { replayed: false });
      second.receive(event, { replayed: false });
    });
    await advance(250);
  };
  await deliver({ ...invocation, links: { sessionId: "another-chat" } });
  await deliver({ ...invocation, payload: { outcome: "approval_required" } });
  expect(api.fetchToolGrants).toHaveBeenCalledTimes(reads);
  records = [{ ...oneUse, usesRemaining: 0 }, docsGrant];

  await deliver(invocation);
  expectOnlyDocuments(first);
  expectOnlyDocuments(second);
  expect(api.fetchToolGrants).toHaveBeenCalledTimes(reads + 2);
  expect(api.revokeToolGrant).not.toHaveBeenCalled();
});
