import { __resetApprovalOperationAttemptsForTests } from "../inbox/approval-operation-attempts";
import { __resetSessionViewStateForTests } from "../../../hooks/use-session-view-state";
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CommunicationsDashboardResponse } from "@goatcitadel/contracts";
import { fetchCommunicationsDashboard } from "@goatcitadel/mission-control-shared/api/personal-ops";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";
import { LibraryCommunications } from "./LibraryCommunications";

vi.mock("@goatcitadel/mission-control-shared/api/personal-ops", () => ({
  fetchCommunicationsDashboard: vi.fn(),
  createMailDraft: vi.fn(),
  sendMailDraft: vi.fn(),
}));

const dashboard: CommunicationsDashboardResponse = {
  mailAccounts: [
    {
      accountId: "acct-a",
      workspaceId: "one",
      provider: "gmail",
      label: "Fixture mail",
      address: "inbox@example.test",
      connectionId: "conn-secret-ish",
      secretRef: "gmail-primary-handle",
      syncStatus: "ready",
      lastSyncedAt: "2026-10-07T10:00:00.000Z",
      createdAt: "now",
      updatedAt: "now",
    },
    {
      accountId: "acct-foreign",
      workspaceId: "two",
      provider: "gmail",
      label: "Foreign mail",
      syncStatus: "ready",
      createdAt: "now",
      updatedAt: "now",
    },
  ],
  calendarAccounts: [
    {
      accountId: "cal-a",
      workspaceId: "one",
      provider: "google",
      label: "Fixture calendar",
      syncStatus: "degraded",
      createdAt: "now",
      updatedAt: "now",
    },
  ],
  messages: [
    {
      messageId: "m-1",
      accountId: "acct-a",
      from: "sender@example.test",
      to: ["inbox@example.test"],
      subject: "Fixture inbox readiness",
      snippet: "Deterministic preview",
      receivedAt: "2026-10-07T09:00:00.000Z",
      labels: ["INBOX"],
    },
  ],
  events: [
    {
      eventId: "e-1",
      accountId: "cal-a",
      title: "Fixture agenda",
      description: "Planning",
      startIso: "2026-10-08T16:00:00.000Z",
      endIso: "2026-10-08T16:30:00.000Z",
      attendees: ["a@example.test", "b@example.test"],
      location: "Room 1",
      createdAt: "now",
      updatedAt: "now",
    },
  ],
  contacts: [
    {
      contactId: "c-1",
      workspaceId: "one",
      displayName: "Ada Contact",
      emailAddresses: ["ada@example.test"],
      phoneNumbers: ["+1 555 0100"],
      company: "Example Co",
      role: "Lead",
      externalRefs: [],
      lifecycleStatus: "active",
      createdAt: "now",
      updatedAt: "now",
    },
  ],
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
});
afterEach(() => {
  act(() => root.unmount());
  client.clear();
  container.remove();
});

async function render(workspaceId = "one") {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <LibraryCommunications workspaceId={workspaceId} />
      </QueryClientProvider>,
    ),
  );
}
const region = (name: string) => container.querySelector<HTMLElement>(`[aria-label='${name}']`)!;

it("projects accounts, inbox, agenda and contacts for the current workspace without exposing connector custody", async () => {
  vi.mocked(fetchCommunicationsDashboard).mockResolvedValue(dashboard);
  await render();
  await vi.waitFor(() => expect(container.textContent).toContain("Fixture inbox readiness"));
  expect(fetchCommunicationsDashboard).toHaveBeenCalledExactlyOnceWith("one");
  expect(region("Mail and calendar accounts").textContent).toContain("Fixture mail");
  expect(region("Mail and calendar accounts").textContent).toContain("inbox@example.test");
  expect(region("Mail and calendar accounts").textContent).toContain("Ready");
  expect(region("Mail and calendar accounts").textContent).toContain("Fixture calendar");
  expect(region("Mail and calendar accounts").textContent).toContain("Degraded");
  expect(region("Inbox").textContent).toContain("sender@example.test");
  expect(region("Inbox").textContent).toContain("Deterministic preview");
  expect(region("Agenda").textContent).toContain("Fixture agenda");
  expect(region("Agenda").textContent).toContain("Room 1");
  expect(region("Agenda").textContent).toContain("2 attendees");
  expect(region("Contacts").textContent).toContain("Ada Contact");
  expect(region("Contacts").textContent).toContain("ada@example.test");
  expect(region("Contacts").textContent).toContain("+1 555 0100");
  expect(container.textContent).not.toContain("Foreign mail");
  expect(container.textContent).not.toContain("gmail-primary-handle");
  expect(container.textContent).not.toContain("conn-secret-ish");
  expect(container.textContent).toContain("From Fixture mail · inbox@example.test");
});

it("names empty projections instead of implying data exists", async () => {
  vi.mocked(fetchCommunicationsDashboard).mockResolvedValue({
    mailAccounts: [],
    calendarAccounts: [],
    messages: [],
    events: [],
    contacts: [],
  });
  await render();
  await vi.waitFor(() => expect(container.textContent).toContain("No inbox messages returned."));
  for (const text of [
    "No mail or calendar account is connected to this workspace.",
    "No agenda items returned.",
    "No contacts returned.",
    "No mail account is connected to this workspace.",
  ])
    expect(container.textContent).toContain(text);
});

it("shows a load failure with retry and keeps compose unavailable until the read succeeds", async () => {
  vi.mocked(fetchCommunicationsDashboard)
    .mockRejectedValueOnce(new Error("Gateway unavailable"))
    .mockResolvedValueOnce(dashboard);
  await render();
  await vi.waitFor(() => expect(container.textContent).toContain("Gateway unavailable"));
  expect(container.textContent).toContain("Mail accounts could not be read.");
  expect(container.textContent).not.toContain("Reading mail accounts…");
  const review = [...container.querySelectorAll("button")].find((item) => item.textContent === "Review send request");
  expect(review?.disabled ?? true).toBe(true);
  const refresh = [...container.querySelectorAll("button")].find(
    (item) => item.textContent === "Refresh communications",
  )!;
  await act(async () => refresh.click());
  await vi.waitFor(() => expect(container.textContent).toContain("Fixture inbox readiness"));
  expect(fetchCommunicationsDashboard).toHaveBeenCalledTimes(2);
});
