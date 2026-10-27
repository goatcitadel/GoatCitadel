// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UiPreferencesProvider } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import type { MissionThreadedSessionRailData } from "@goatcitadel/threaded-surface-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CockpitNavigationProvider } from "../../app/CockpitNavigationProvider";
import { ChatConversationsSheet } from "./ChatConversationsSheet";

vi.unmock("vaul");
const api = vi.hoisted(() => ({ fetchChatMessaging: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/chat", () => ({ fetchChatMessaging: api.fetchChatMessaging }));
vi.mock("./use-thread-activity", () => ({ useThreadActivity: () => ({}) }));

const start = "/chat?shell=cockpit";
const here = () => window.location.pathname + window.location.search + window.location.hash;
const dialogOpen = () => document.querySelector('[role="dialog"][data-state="open"]') !== null;

const rail = {
  missionSessions: [],
  externalSessions: [],
  availableFolders: [],
  selectedSessionId: null,
  selectedFolderId: "all",
  selectedProjectId: "all",
  search: "",
  historyView: "active",
  renderSessionLabel: (id: string) => id,
  onSelectSession: vi.fn(),
  onSearchChange: vi.fn(),
  onHistoryViewChange: vi.fn(),
  onSelectProjectId: vi.fn(),
  onCreateSession: vi.fn(),
} as unknown as MissionThreadedSessionRailData;

function Harness({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open sheet
      </button>
      <ChatConversationsSheet
        open={open}
        onOpenChange={(next) => {
          onOpenChange(next);
          setOpen(next);
        }}
        rail={rail}
        messaging={{ workspaceId: "default", onOpenChannel: vi.fn() }}
      />
    </>
  );
}

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
const onOpenChange = vi.fn();

const addLinks = () => [...document.querySelectorAll<HTMLAnchorElement>('a[aria-label="Add a channel"]')];
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
async function openSheet(channels: unknown[]) {
  api.fetchChatMessaging.mockResolvedValue({ workspaceId: "default", channels });
  await act(async () => {
    [...document.querySelectorAll("button")].find((button) => button.textContent === "Open sheet")!.click();
  });
  await vi.waitFor(() => expect(document.querySelector('[data-vaul-drawer][data-state="open"]')).toBeTruthy());
  await settle();
  expect(addLinks().length).toBeGreaterThan(0);
}

beforeEach(async () => {
  onOpenChange.mockReset();
  api.fetchChatMessaging.mockReset();
  window.history.replaceState(null, "", "/work");
  window.history.pushState(null, "", start);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <UiPreferencesProvider>
          <CockpitNavigationProvider>
            <Harness onOpenChange={onOpenChange} />
          </CockpitNavigationProvider>
        </UiPreferencesProvider>
      </QueryClientProvider>,
    ),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  client.clear();
});

// The Conversations sheet is a modal over the page at phone width. "+ Add" now stays inside Chat, so the sheet must
// not be left open over the picker it opened.
it.each([
  ["the heading's Add link", [], 0],
  ["the empty state's Add link", [], 1],
])("closes the sheet when %s opens the channel picker", async (_label, channels, index) => {
  await openSheet(channels);
  expect(addLinks()).toHaveLength(2);
  expect(dialogOpen()).toBe(true);
  await act(async () => addLinks()[index]!.click());
  await vi.waitFor(() => expect(here()).toBe("/chat/messaging/add?shell=cockpit"));
  await vi.waitFor(() => expect(dialogOpen()).toBe(false));
  expect(onOpenChange).toHaveBeenLastCalledWith(false);
});

// Navigation closes an open sheet only when it moves somewhere else. Already at the picker, "+ Add" goes nowhere, so
// the link itself must close the sheet or it stays over the page it just "opened".
it("closes the sheet when Add is chosen while the picker is already showing", async () => {
  window.history.pushState(null, "", "/chat/messaging/add?shell=cockpit");
  await openSheet([]);
  expect(dialogOpen()).toBe(true);
  await act(async () => addLinks()[0]!.click());
  await vi.waitFor(() => expect(dialogOpen()).toBe(false));
  expect(onOpenChange).toHaveBeenLastCalledWith(false);
  expect(here()).toBe("/chat/messaging/add?shell=cockpit");
});

it("leaves the sheet open when the Add link is opened in a new tab", async () => {
  await openSheet([]);
  const link = addLinks()[0]!;
  const guard = (event: Event) => event.preventDefault();
  document.addEventListener("click", guard);
  try {
    await act(async () => {
      link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ctrlKey: true }));
    });
  } finally {
    document.removeEventListener("click", guard);
  }
  expect(here()).toBe(start);
  expect(dialogOpen()).toBe(true);
  expect(onOpenChange).not.toHaveBeenCalled();
});
