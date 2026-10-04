// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GatewayUnavailableBanner } from "./GatewayUnavailableBanner";

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

describe("Gateway unavailable banner", () => {
  it("says sending is paused only in Chat", async () => {
    await act(async () =>
      root.render(<GatewayUnavailableBanner reachability={{ unavailable: true, lastConfirmedAt: 0 }} inChat />),
    );
    expect(container.textContent).toContain("Sending is paused; your draft is preserved.");
    await act(async () =>
      root.render(<GatewayUnavailableBanner reachability={{ unavailable: true, lastConfirmedAt: null }} inChat={false} />),
    );
    expect(container.textContent).not.toContain("Sending is paused");
    expect(container.textContent).toContain("Reconnecting…");
  });

  it("hides the retry control when no probe handle is available", async () => {
    await act(async () =>
      root.render(<GatewayUnavailableBanner reachability={{ unavailable: true, lastConfirmedAt: null }} inChat />),
    );
    expect(container.querySelector("button")).toBeNull();
  });
});
