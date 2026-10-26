// @vitest-environment happy-dom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChatMainColumn } from "./ChatMainColumn";

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
async function render(channelPageId: string | null) {
  await act(async () => {
    root.render(
      <ChatMainColumn channelPageId={channelPageId}>
        <Conversation />
      </ChatMainColumn>,
    );
  });
  // The page is a lazy chunk: let it load.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  live.effects = 0;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("shows the channel page in place of the conversation, keeping the conversation but suspending it", async () => {
  await render(null);
  const draft = container.querySelector<HTMLInputElement>('input[aria-label="Draft"]')!;
  draft.value = "Keep this draft";
  expect(live.effects).toBe(1);
  expect(container.querySelector("h1")).toBeNull();

  await render("conn-1");
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
