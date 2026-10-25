// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import {
  __resetMcpOAuthReturnForTests,
  consumeMcpOAuthReturnFragment,
  subscribeMcpOAuthReturn,
} from "./mcp-oauth-return";

afterEach(() => {
  __resetMcpOAuthReturnForTests();
  window.history.replaceState(null, "", "/");
});

it("forwards a provider code from the fragment and clears it from the address bar", () => {
  const listener = vi.fn();
  subscribeMcpOAuthReturn(listener);
  window.history.replaceState(null, "", "/settings/connections#mcp-oauth-return&state=s-1&code=abc%2F1");
  expect(consumeMcpOAuthReturnFragment()).toEqual({ state: "s-1", code: "abc/1" });
  expect(listener).toHaveBeenCalledWith({ state: "s-1", code: "abc/1" });
  expect(window.location.hash).toBe("#mcp-servers");
  expect(window.location.href).not.toContain("abc");
});

it("forwards provider errors and ignores unrelated or malformed fragments", () => {
  const listener = vi.fn();
  subscribeMcpOAuthReturn(listener);
  window.history.replaceState(null, "", "/settings/connections#mcp-oauth-return&state=s-2&error=access_denied");
  expect(consumeMcpOAuthReturnFragment()).toEqual({ state: "s-2", error: "access_denied" });
  window.history.replaceState(null, "", "/settings/connections#mcp-servers");
  expect(consumeMcpOAuthReturnFragment()).toBeUndefined();
  window.history.replaceState(null, "", "/settings/connections#mcp-oauth-return&state=s-3&code=c&error=e");
  expect(consumeMcpOAuthReturnFragment()).toBeUndefined();
  expect(window.location.hash).toBe("#mcp-servers");
  expect(listener).toHaveBeenCalledTimes(1);
});
