// @vitest-environment happy-dom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ChannelSetupDefinition } from "@goatcitadel/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MessagingView } from "../../app/routes";
import { ChatMainColumn } from "./ChatMainColumn";
import { settingsChannelSetupHref } from "./channel-setup/channel-picker-model";

const api = vi.hoisted(() => ({ fetchChannelSetupDefinitions: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({ activeWorkspaceId: "workspace-a" }),
}));
vi.mock("./ChannelPage", () => ({
  ChannelPage: ({ connectionId, workspaceId }: { connectionId: string; workspaceId: string }) => (
    <h1>
      Channel page {connectionId} in {workspaceId}
    </h1>
  ),
}));

const DEFINITIONS = [
  {
    catalog: { catalogId: "channel.slack", key: "slack", label: "Slack" },
    wizard: { estimatedMinutes: 10, picker: { group: "quickest", order: 0 } },
  },
] as unknown as ChannelSetupDefinition[];

const live = { effects: 0 };
function Conversation() {
  useEffect(() => {
    live.effects += 1;
    return () => {
      live.effects -= 1;
    };
  }, []);
  return <input aria-label="Draft" defaultValue="" />;
}

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
async function render(messaging: MessagingView | null) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <ChatMainColumn messaging={messaging}>
          <Conversation />
        </ChatMainColumn>
      </QueryClientProvider>,
    );
  });
  // The views are lazy chunks and the definitions are a query: wait until nothing still says it is loading.
  for (let attempt = 0; attempt < 100 && container.textContent?.includes("Loading channel"); attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
}

function link(text: string): URL {
  const found = [...container.querySelectorAll<HTMLAnchorElement>("a")].find((candidate) =>
    candidate.textContent?.includes(text),
  );
  if (!found) throw new Error(`No link contains "${text}"`);
  return new URL(found.getAttribute("href")!, "http://cockpit.invalid");
}

function conversationHidden() {
  return container.querySelector<HTMLElement>('input[aria-label="Draft"]')?.closest<HTMLElement>("[style]")?.style
    .display;
}

beforeEach(() => {
  live.effects = 0;
  api.fetchChannelSetupDefinitions.mockReset();
  api.fetchChannelSetupDefinitions.mockResolvedValue({ items: DEFINITIONS });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  client.clear();
});

it("shows the channel page in place of the conversation, keeping the conversation but suspending it", async () => {
  await render(null);
  const draft = container.querySelector<HTMLInputElement>('input[aria-label="Draft"]')!;
  draft.value = "Keep this draft";
  expect(live.effects).toBe(1);
  expect(container.querySelector("h1")).toBeNull();

  await render({ kind: "channel", connectionId: "conn-1" });
  expect(container.querySelector("h1")?.textContent).toBe("Channel page conn-1 in workspace-a");
  // Same element, same draft: only hidden and no longer running effects (such as marking messages read).
  expect(container.querySelector('input[aria-label="Draft"]')).toBe(draft);
  expect(draft.value).toBe("Keep this draft");
  expect(draft.closest<HTMLElement>("[style]")?.style.display).toBe("none");
  expect(live.effects).toBe(0);

  await render(null);
  expect(container.querySelector("h1")).toBeNull();
  expect(live.effects).toBe(1);
  expect(draft.value).toBe("Keep this draft");
  expect(draft.closest<HTMLElement>("[style]")?.style.display ?? "").not.toBe("none");
});

it("shows the channel picker in place of the conversation", async () => {
  await render(null);
  const draft = container.querySelector<HTMLInputElement>('input[aria-label="Draft"]')!;
  draft.value = "Keep this draft";

  await render({ kind: "picker" });
  expect(container.querySelector("h1")?.textContent).toBe("Add a channel");
  expect(container.textContent).toContain("Slack");
  expect(container.querySelector('input[aria-label="Draft"]')).toBe(draft);
  expect(draft.value).toBe("Keep this draft");
  expect(conversationHidden()).toBe("none");
  expect(live.effects).toBe(0);

  await render(null);
  expect(container.querySelector("h1")).toBeNull();
  expect(live.effects).toBe(1);
});

it("sends a channel without its own setup page to Settings", async () => {
  await render({ kind: "setup", channelKey: "slack" });
  expect(container.querySelector("h1")?.textContent).toBe("Add Slack");
  expect(container.textContent).toContain("Set up Slack in Settings");
  const target = link("Set up Slack in Settings");
  const expected = new URL(settingsChannelSetupHref("channel.slack"), "http://cockpit.invalid");
  expect(target.pathname).toBe(expected.pathname);
  expect(target.searchParams.get("channel")).toBe("channel.slack");
  expect(target.hash).toBe("#channels");
  expect(link("Back to channels").pathname).toBe("/chat/messaging/add");
  expect(conversationHidden()).toBe("none");
});

it("says a channel that is not offered is not available, with a way back to the picker", async () => {
  await render({ kind: "setup", channelKey: "carrier-pigeon" });
  expect(container.textContent).toContain("This channel isn't available.");
  expect(container.textContent).not.toContain("Settings");
  expect(link("Back to channels").pathname).toBe("/chat/messaging/add");
});

it("shows a placeholder for a key change, with a way back to the channel page", async () => {
  await render({ kind: "change_key", connectionId: "conn-1" });
  expect(container.querySelector("h1")?.textContent).toBe("Change this channel's key");
  expect(link("Back to channel").pathname).toBe("/chat/messaging/conn-1");
  expect(link("Change the key in Settings").pathname).toBe("/settings/connections");
  expect(conversationHidden()).toBe("none");
});
