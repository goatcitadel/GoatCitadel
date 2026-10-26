// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ChatMessagingOverview } from "@goatcitadel/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "../../data/query-keys";
import type { ChannelConversationContext } from "./channel-conversation";
import { useSelectedChannelConversation } from "./use-channel-conversation";

const api = vi.hoisted(() => ({ fetchChatMessaging: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/chat", () => ({ fetchChatMessaging: api.fetchChatMessaging }));

const overview: ChatMessagingOverview = {
  workspaceId: "default",
  channels: [
    {
      connectionId: "conn-1",
      channelKey: "telegram",
      label: "Telegram",
      status: "on",
      conversations: [
        { sessionId: "channel-1", title: "You", kind: "direct", own: true, lastActivityAt: "2026-10-25T10:00:00Z" },
      ],
    },
  ],
};

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
let seen: Array<ChannelConversationContext | undefined>;

function Probe(props: {
  session?: { scope?: "mission" | "external"; channelConnectionId?: string };
  selectedSessionId?: string;
}) {
  seen.push(useSelectedChannelConversation("default", props.session, props.selectedSessionId));
  return null;
}

async function mount(props: React.ComponentProps<typeof Probe>) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <Probe {...props} />
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  seen = [];
  api.fetchChatMessaging.mockReset();
  api.fetchChatMessaging.mockResolvedValue(overview);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  client.clear();
});

describe("useSelectedChannelConversation", () => {
  it("reads the Messaging overview for a conversation a channel carries and describes it", async () => {
    await mount({ session: { scope: "external", channelConnectionId: "conn-1" }, selectedSessionId: "channel-1" });
    expect(api.fetchChatMessaging).toHaveBeenCalledExactlyOnceWith("default", expect.anything());
    expect(seen.at(-1)).toMatchObject({ sessionId: "channel-1", channelLabel: "Telegram", own: true });
  });

  it("does not fetch the overview for an ordinary conversation", async () => {
    await mount({ session: {}, selectedSessionId: "session-1" });
    expect(api.fetchChatMessaging).not.toHaveBeenCalled();
    expect(seen.at(-1)).toBeUndefined();
  });

  it("does not fetch the overview for a mission chat bound to a channel", async () => {
    // Binding a chat to a channel in the context dock keeps it an ordinary chat under Chats.
    await mount({ session: { scope: "mission", channelConnectionId: "conn-1" }, selectedSessionId: "session-1" });
    expect(api.fetchChatMessaging).not.toHaveBeenCalled();
    expect(seen.at(-1)).toBeUndefined();
  });

  it("uses an overview the sidebar already loaded without asking for it again", async () => {
    client.setQueryData(queryKeys.chatMessaging("default"), overview);
    await mount({ session: undefined, selectedSessionId: "channel-1" });
    expect(api.fetchChatMessaging).not.toHaveBeenCalled();
    expect(seen.at(-1)).toMatchObject({ connectionId: "conn-1" });
  });

  it("keeps the same context object while nothing it describes changed", async () => {
    await mount({ session: { scope: "external", channelConnectionId: "conn-1" }, selectedSessionId: "channel-1" });
    const first = seen.at(-1);
    const [channel] = overview.channels;
    const publish = async (conversations: ChatMessagingOverview["channels"][number]["conversations"]) => {
      const renders = seen.length;
      await act(async () => {
        client.setQueryData(queryKeys.chatMessaging("default"), {
          ...overview,
          channels: [{ ...channel!, conversations }],
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      // The hook did run again for the new overview, so what follows is not a missed render.
      expect(seen.length).toBeGreaterThan(renders);
    };
    // Another conversation gets a message: the overview is a new object, but this conversation is as it was.
    await publish([
      ...channel!.conversations,
      { sessionId: "other", title: "Anna", kind: "direct", own: false, lastActivityAt: "2026-10-25T11:00:00Z" },
    ]);
    expect(seen.at(-1)).toBe(first);
    // Its own read marker moving is a change it describes.
    await publish([{ ...channel!.conversations[0]!, lastReadAt: "2026-10-25T10:00:00Z" }]);
    expect(seen.at(-1)).not.toBe(first);
    expect(seen.at(-1)?.lastReadAt).toBe("2026-10-25T10:00:00Z");
  });
});
