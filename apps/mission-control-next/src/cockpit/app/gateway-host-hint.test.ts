// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { currentGatewayHost, gatewayStartHint } from "./gateway-host-hint";

const core = vi.hoisted(() => ({ base: "http://127.0.0.1:8787" }));
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({ getGatewayApiBaseUrl: () => core.base }));

afterEach(() => {
  core.base = "http://127.0.0.1:8787";
  delete (window as Window & { chrome?: unknown }).chrome;
});

describe("gatewayStartHint", () => {
  it("never tells a remote browser to run a developer command", () => {
    const hint = gatewayStartHint({ desktopApp: false, hostname: "goat.tailnet.example" });
    expect(hint).not.toMatch(/pnpm|source checkout/);
    expect(hint).toMatch(/another computer/);
  });
  it("names the local start paths on the same machine", () => {
    expect(gatewayStartHint({ desktopApp: false, hostname: "127.0.0.1" })).toMatch(/goatcitadel up/);
    expect(gatewayStartHint({ desktopApp: false, hostname: "localhost" })).toMatch(/goatcitadel up/);
    expect(gatewayStartHint({ desktopApp: false, hostname: "[::1]" })).toMatch(/goatcitadel up/);
  });
  it("points the desktop app at itself", () => {
    expect(gatewayStartHint({ desktopApp: true, hostname: "tauri.localhost" })).toMatch(/desktop app/);
  });
});

describe("currentGatewayHost", () => {
  it("reads the Gateway host, not the page host", () => {
    core.base = "https://goat.tailnet.example/api";
    expect(currentGatewayHost()).toEqual({ desktopApp: false, hostname: "goat.tailnet.example" });
  });
  it("recognises the desktop app's embedded browser", () => {
    (window as Window & { chrome?: unknown }).chrome = { webview: { postMessage: () => undefined } };
    expect(currentGatewayHost().desktopApp).toBe(true);
  });
});
