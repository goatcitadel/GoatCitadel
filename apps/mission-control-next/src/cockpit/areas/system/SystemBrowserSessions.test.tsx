import { __resetApprovalOperationAttemptsForTests } from "../inbox/approval-operation-attempts";
import { __resetSessionViewStateForTests } from "../../../hooks/use-session-view-state";
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BrowserSessionRecord } from "@goatcitadel/contracts";
import {
  closeBrowserSession,
  createBrowserSession,
  fetchBrowserSession,
  fetchBrowserSessionEvents,
  fetchBrowserSessionGrants,
  fetchBrowserSessions,
  fetchBrowserSessionState,
} from "@goatcitadel/mission-control-shared/api/browser-sessions";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";
import { CockpitNavigationProvider } from "../../app/CockpitNavigationProvider";
import { SystemBrowserSessions } from "./SystemBrowserSessions";

vi.mock("@goatcitadel/mission-control-shared/api/browser-sessions", () => ({
  closeBrowserSession: vi.fn(),
  createBrowserSession: vi.fn(),
  createBrowserSessionGrant: vi.fn(),
  fetchBrowserSession: vi.fn(),
  fetchBrowserSessionEvents: vi.fn(),
  fetchBrowserSessionGrants: vi.fn(),
  fetchBrowserSessions: vi.fn(),
  fetchBrowserSessionState: vi.fn(),
  revokeBrowserSessionGrant: vi.fn(),
  rotateBrowserSessionGrant: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({ activeWorkspaceId: "one", activeCitadelId: "personal", showTechnicalDetails: false }),
}));

const session: BrowserSessionRecord = {
  sessionId: "s-1",
  workspaceId: "one",
  label: "Research",
  status: "active",
  createdBy: "operator",
  createdAt: "2026-10-07T10:00:00.000Z",
  updatedAt: "2026-10-07T10:00:00.000Z",
};
let root: Root, container: HTMLDivElement, client: QueryClient;

beforeEach(() => {
  vi.resetAllMocks();
  __resetApprovalOperationAttemptsForTests();
  __resetSessionViewStateForTests();
  __resetSessionDraftsForTests();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(fetchBrowserSessions).mockResolvedValue([
    session,
    { ...session, sessionId: "s-foreign", workspaceId: "two", label: "Foreign" },
  ]);
  vi.mocked(fetchBrowserSession).mockResolvedValue(session);
  vi.mocked(fetchBrowserSessionGrants).mockResolvedValue([]);
  vi.mocked(fetchBrowserSessionEvents).mockResolvedValue([
    {
      eventId: "e-1",
      sessionId: "s-1",
      eventType: "grant_created",
      payload: { grantId: "g-1", cookieValue: "x" },
      createdAt: "2026-10-07T10:00:00.000Z",
    },
  ]);
  vi.mocked(fetchBrowserSessionState).mockResolvedValue({
    session,
    state: {
      availability: "present",
      source: "policy_engine_memory",
      retention: "volatile",
      valuesHidden: true,
      cookies: { count: 2, domains: ["example.com"] },
      localStorage: { originCount: 1, keyCount: 3, origins: ["https://example.com"] },
      sessionStorage: { originCount: 0, keyCount: 0, origins: [] },
      context: { geolocationConfigured: false, extraHTTPHeadersCount: 0, httpCredentialsConfigured: false },
    },
    eventSummary: { recentEventCount: 1, guardBlockCount: 0, grantedAccessCount: 0 },
  });
});
afterEach(() => {
  act(() => root.unmount());
  client.clear();
  container.remove();
});

async function open(path: string) {
  await act(async () => {
    window.history.replaceState(null, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
    root.render(
      <QueryClientProvider client={client}>
        <CockpitNavigationProvider>
          <SystemBrowserSessions />
        </CockpitNavigationProvider>
      </QueryClientProvider>,
    );
  });
}
const button = (name: string) =>
  [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === name);
async function click(name: string) {
  await vi.waitFor(() => expect(button(name), name).toBeDefined());
  await act(async () => button(name)!.click());
}
const dialog = () => document.body.querySelector<HTMLElement>("[role=dialog]");

it("lists only this workspace's sessions and opens a deep-linked session with its posture", async () => {
  await open("/system/browser-sessions?sessionId=s-1");
  await vi.waitFor(() => expect(container.textContent).toContain("Session posture"));
  expect(fetchBrowserSessions).toHaveBeenCalledWith({ workspaceId: "one", status: "active", limit: 200 });
  expect(container.textContent).not.toContain("Foreign");
  expect(container.textContent).toContain("does not show that a browser is open, bound or active");
});

it("creates an inert session with a request ID and replays only that ID after a lost response", async () => {
  vi.mocked(createBrowserSession)
    .mockRejectedValueOnce(new Error("socket closed"))
    .mockResolvedValueOnce({ ...session, sessionId: "s-new" });
  await open("/system/browser-sessions");
  const input = [...container.querySelectorAll("input")][0]!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Research");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("Create session");
  expect(button("Create session")).toBeUndefined();
  expect(container.textContent).toContain("Pending request: a session labelled “Research” in workspace one.");
  expect(input.readOnly).toBe(true);
  await click("Replay exact session request");
  const calls = vi.mocked(createBrowserSession).mock.calls;
  expect(calls).toHaveLength(2);
  expect(calls[0]![0]).toMatchObject({ workspaceId: "one", label: "Research" });
  expect(calls[1]![0].requestId).toBe(calls[0]![0].requestId);
  await vi.waitFor(() => expect(new URLSearchParams(window.location.search).get("sessionId")).toBe("s-new"));
});

it("refuses to manage a deep-linked session from another workspace", async () => {
  vi.mocked(fetchBrowserSession).mockResolvedValue({ ...session, workspaceId: "two" });
  await open("/system/browser-sessions?sessionId=s-1");
  await vi.waitFor(() => expect(container.textContent).toContain("belongs to workspace two, not workspace one"));
  expect(fetchBrowserSessionGrants).not.toHaveBeenCalled();
});

it("closes a session only after review: Cancel sends nothing, Confirm sends one close", async () => {
  await open("/system/browser-sessions?sessionId=s-1");
  await click("Review closing this session");
  expect(dialog()!.textContent).toContain("revokes its 0 active grants");
  await click("Cancel");
  expect(closeBrowserSession).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Cancelled. The session stays open.");
  vi.mocked(closeBrowserSession).mockResolvedValue({
    ...session,
    status: "closed",
    closedAt: "2026-10-07T12:00:00.000Z",
  });
  await click("Review closing this session");
  await click("Close session and revoke grants");
  expect(closeBrowserSession).toHaveBeenCalledExactlyOnceWith("s-1");
  await vi.waitFor(() => expect(container.textContent).toContain("Session closed"));
});

it("does not claim revocation when an active grant is still recorded after close", async () => {
  await open("/system/browser-sessions?sessionId=s-1");
  vi.mocked(closeBrowserSession).mockResolvedValue({
    ...session,
    status: "closed",
    closedAt: "2026-10-07T12:00:00.000Z",
  });
  vi.mocked(fetchBrowserSessionGrants).mockResolvedValue([
    {
      grantId: "g-1",
      sessionId: "s-1",
      actorId: "agent",
      scopes: ["read"],
      allowedHosts: [],
      createdAt: "2026-10-07T10:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
    },
  ]);
  await click("Review closing this session");
  expect(dialog()!.textContent).toContain("calls already admitted are not interrupted");
  await click("Close session and revoke grants");
  await vi.waitFor(() => expect(container.textContent).toContain("but an active grant is still recorded"));
  expect(container.textContent).not.toContain("No active grant remains");
});

it("still refreshes and says grants are unverified when the post-close check fails", async () => {
  await open("/system/browser-sessions?sessionId=s-1");
  await vi.waitFor(() => expect(container.textContent).toContain("Session posture"));
  vi.mocked(closeBrowserSession).mockResolvedValue({
    ...session,
    status: "closed",
    closedAt: "2026-10-07T12:00:00.000Z",
  });
  vi.mocked(fetchBrowserSessionGrants).mockRejectedValue(new Error("grants unavailable"));
  const listReads = vi.mocked(fetchBrowserSessions).mock.calls.length;
  await click("Review closing this session");
  await click("Close session and revoke grants");
  await vi.waitFor(() => expect(container.textContent).toContain("Session closed"));
  expect(container.textContent).toContain("could not confirm whether any grant is still active");
  await vi.waitFor(() => expect(vi.mocked(fetchBrowserSessions).mock.calls.length).toBeGreaterThan(listReads));
});

it("does not state tool posture while grants are unknown", async () => {
  vi.mocked(fetchBrowserSessionGrants).mockReturnValue(new Promise(() => undefined));
  await open("/system/browser-sessions?sessionId=s-1");
  await click("State");
  await vi.waitFor(() => expect(container.textContent).toContain("3 keys · https://example.com"));
  expect(container.textContent).toContain("Reading grants…");
  expect(container.textContent).not.toContain("No active grant");
  expect(container.textContent).not.toContain("No active hosts");
});

it("surfaces a grants error in the State view instead of an empty posture", async () => {
  vi.mocked(fetchBrowserSessionGrants).mockRejectedValue(new Error("grants unavailable"));
  await open("/system/browser-sessions?sessionId=s-1");
  await click("State");
  await vi.waitFor(() => expect(container.textContent).toContain("3 keys · https://example.com"));
  await vi.waitFor(() => expect(container.textContent).toContain("grants unavailable"));
  expect(container.textContent).not.toContain("No active grant");
});

it("shows counts but never browser state values, and hides state keys in events", async () => {
  await open("/system/browser-sessions?sessionId=s-1");
  await click("State");
  await vi.waitFor(() => expect(container.textContent).toContain("3 keys · https://example.com"));
  // Classic parity: tool posture and context are shown, still without any state values.
  expect(container.textContent).toContain("No active grant: tools cannot use this session");
  expect(container.textContent).toContain("No browser context overrides");
  expect(container.textContent).toContain("Cookie, storage and page values are never shown.");
  await click("Events");
  await vi.waitFor(() => expect(container.textContent).toContain("1 browser state value hidden"));
  expect(container.textContent).not.toContain("cookieValue");
});
