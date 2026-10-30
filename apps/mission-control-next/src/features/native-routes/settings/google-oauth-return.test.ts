// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import {
  __resetGoogleOAuthReturnForTests,
  consumeGoogleOAuthReturnFragment,
  isGoogleOAuthReturnFragment,
  subscribeGoogleOAuthReturn,
} from "./google-oauth-return";
import { consumeMcpOAuthReturnFragment } from "./mcp-oauth-return";

afterEach(() => {
  __resetGoogleOAuthReturnForTests();
  window.history.replaceState(null, "", "/");
});

it("forwards Google's code from the fragment and clears it from the address bar", () => {
  const listener = vi.fn();
  subscribeGoogleOAuthReturn(listener);
  window.history.replaceState(null, "", "/capabilities/connectors/advanced#google-oauth-return&state=s-1&code=4%2F0Ad");
  expect(consumeGoogleOAuthReturnFragment()).toEqual({ state: "s-1", code: "4/0Ad" });
  expect(listener).toHaveBeenCalledWith({ state: "s-1", code: "4/0Ad" });
  expect(window.location.hash).toBe("#integration-connections");
  expect(window.location.href).not.toContain("0Ad");
});

it("keeps Google and MCP returns apart", () => {
  const listener = vi.fn();
  subscribeGoogleOAuthReturn(listener);
  expect(isGoogleOAuthReturnFragment("google-oauth-return&state=s&code=c")).toBe(true);
  expect(isGoogleOAuthReturnFragment("mcp-oauth-return&state=s&code=c")).toBe(false);
  window.history.replaceState(null, "", "/capabilities/connectors/advanced#mcp-oauth-return&state=s-2&code=mcp");
  expect(consumeGoogleOAuthReturnFragment()).toBeUndefined();
  expect(consumeMcpOAuthReturnFragment()).toEqual({ state: "s-2", code: "mcp" });
  expect(listener).not.toHaveBeenCalled();
});
