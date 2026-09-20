import { afterEach, expect, it, vi } from "vitest";
import { readPackagedGatewayOrigin } from "./client-core";
afterEach(() => vi.unstubAllGlobals());
it("selects only a validated loopback gateway from the packaged document", () => {
  vi.stubGlobal("window", { location: new URL("http://127.0.0.1:5175") });
  for (const origin of ["http://127.0.0.1:8788", "http://[::1]:8788"]) {
    vi.stubGlobal("document", { querySelector: () => ({ getAttribute: () => origin }) });
    expect(readPackagedGatewayOrigin()).toBe(origin);
  }
  for (const origin of [
    "https://example.com",
    "http://user:pass@127.0.0.1:8788",
    "http://127.0.0.1:8788/path",
    "not a url",
  ]) {
    vi.stubGlobal("document", { querySelector: () => ({ getAttribute: () => origin }) });
    expect(readPackagedGatewayOrigin()).toBeUndefined();
  }
  vi.stubGlobal("document", { querySelector: () => ({ getAttribute: () => "http://127.0.0.1:8788" }) });
  vi.stubGlobal("window", { location: new URL("https://example.com") });
  expect(readPackagedGatewayOrigin()).toBeUndefined();
});
