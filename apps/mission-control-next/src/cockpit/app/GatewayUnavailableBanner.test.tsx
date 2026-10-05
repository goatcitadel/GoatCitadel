// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GatewayUnavailableBanner } from "./GatewayUnavailableBanner";
import type { GatewayReachability } from "./use-gateway-reachability";

const idle: GatewayReachability = { unavailable: true, lastConfirmedAt: null, checking: false, lastCheckedAt: null };

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
      root.render(<GatewayUnavailableBanner reachability={{ ...idle, lastConfirmedAt: 0 }} inChat />),
    );
    expect(container.textContent).toContain("Sending is paused; your draft is preserved.");
    await act(async () => root.render(<GatewayUnavailableBanner reachability={idle} inChat={false} />));
    expect(container.textContent).not.toContain("Sending is paused");
    expect(container.textContent).toContain("Reconnecting…");
  });

  it("hides the retry control when no probe handle is available", async () => {
    await act(async () => root.render(<GatewayUnavailableBanner reachability={idle} inChat />));
    expect(container.querySelector("button")).toBeNull();
  });

  it("shows a probe in flight and disables Check again while it runs", async () => {
    const retry = () => undefined;
    await act(async () =>
      root.render(<GatewayUnavailableBanner reachability={{ ...idle, checking: true, retry }} inChat />),
    );
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Checking…");
    expect(container.querySelector("button")?.disabled).toBe(true);
    expect(container.querySelector('[role="alert"] [role="status"]')).not.toBeNull();
  });

  it("says when the Gateway was last checked and is still unreachable", async () => {
    const checkedAt = new Date(2026, 9, 5, 10, 42, 13).getTime();
    await act(async () =>
      root.render(
        <GatewayUnavailableBanner
          reachability={{ ...idle, lastCheckedAt: checkedAt, retry: () => undefined }}
          inChat
        />,
      ),
    );
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      `Still unreachable · checked ${new Date(checkedAt).toLocaleTimeString()}`,
    );
    expect(container.querySelector("button")?.disabled).toBe(false);
  });
});
