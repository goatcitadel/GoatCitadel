import { afterEach, expect, it, vi } from "vitest";
import { getGatewayAccessRevision, getGatewayCallerScope, setGatewayCallerScope, subscribeGatewayCallerScope } from "./access-scope.js";
afterEach(() => setGatewayCallerScope(""));
it("notifies mounted caller-bound owners without treating identity observation as custody change", () => {
  const listener = vi.fn(); const unsubscribe = subscribeGatewayCallerScope(listener);
  const revision = getGatewayAccessRevision();
  setGatewayCallerScope("test-caller-a"); expect(listener).toHaveBeenCalledOnce();
  setGatewayCallerScope("test-caller-a"); expect(listener).toHaveBeenCalledOnce();
  setGatewayCallerScope("test-caller-b"); expect(listener).toHaveBeenCalledTimes(2);
  expect(getGatewayCallerScope()).toBe("test-caller-b"); expect(getGatewayAccessRevision()).toBe(revision);
  unsubscribe(); setGatewayCallerScope("test-caller-c"); expect(listener).toHaveBeenCalledTimes(2);
});
