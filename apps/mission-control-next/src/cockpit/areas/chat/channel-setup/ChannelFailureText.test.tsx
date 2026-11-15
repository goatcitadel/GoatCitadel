// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChannelFailureText } from "./ChannelFailureText";
import { TELEGRAM_NO_KEY_STORE } from "./no-key-store";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const show = (error: string) =>
  act(async () =>
    root.render(
      <ChannelFailureText error={error} channelName="Telegram" catalogId="channel.telegram" workspaceId="w" />,
    ),
  );

describe("ChannelFailureText", () => {
  it("links the channel's guide inside the no key store sentence", async () => {
    await show(TELEGRAM_NO_KEY_STORE);
    expect(container.textContent).toBe(TELEGRAM_NO_KEY_STORE);
    const links = container.querySelectorAll("a");
    expect(links).toHaveLength(1);
    expect(links[0]!.textContent).toBe("Telegram's guide in Advanced channel setup");
    expect(links[0]!.getAttribute("href")).toContain("channel.telegram");
  });

  it("leaves any other sentence as plain text", async () => {
    await show("Telegram didn't accept that key.");
    expect(container.textContent).toBe("Telegram didn't accept that key.");
    expect(container.querySelector("a")).toBeNull();
  });
});
