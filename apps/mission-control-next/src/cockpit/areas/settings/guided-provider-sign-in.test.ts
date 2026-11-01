import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChangePlanRecord } from "@goatcitadel/contracts";
import { runProviderSignIn } from "./guided-provider-sign-in";

const mocks = vi.hoisted(() => ({ start: vi.fn(), poll: vi.fn(), complete: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  startChangePlanProviderOAuth: mocks.start,
  pollChangePlanProviderOAuth: mocks.poll,
  completeChangePlanProviderOAuth: mocks.complete,
}));

const plan = {
  planId: "plan-oauth",
  revision: 1,
  origin: { workspaceId: "default", surface: "settings" },
  requiredAction: { kind: "oauth", actionId: "oauth-1", actionNonce: "nonce-1", title: "Sign in" },
} as unknown as ChangePlanRecord;
const completedPlan = { ...plan, revision: 2 } as ChangePlanRecord;

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.stubGlobal("open", vi.fn());
  mocks.start.mockResolvedValue({
    flowId: "flow-1",
    verificationUrl: "https://auth.example.com/device",
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    pollAfterMs: 1_000,
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("runProviderSignIn onCompleting", () => {
  it("fires once, just before complete, and returns the completed record", async () => {
    const order: string[] = [];
    mocks.poll.mockResolvedValue({ flowId: "flow-1", status: "connected" });
    mocks.complete.mockImplementation(async () => {
      order.push("complete");
      return completedPlan;
    });
    const onCompleting = vi.fn(() => order.push("completing"));
    const controller = new AbortController();
    const run = runProviderSignIn(plan, "default", controller.signal, { onCompleting });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(run).resolves.toBe(completedPlan);
    expect(onCompleting).toHaveBeenCalledOnce();
    expect(order).toEqual(["completing", "complete"]);
  });
  it("does not abort or throw when cancelled while completing", async () => {
    mocks.poll.mockResolvedValue({ flowId: "flow-1", status: "connected" });
    const controller = new AbortController();
    mocks.complete.mockImplementation(async () => {
      controller.abort();
      return completedPlan;
    });
    const run = runProviderSignIn(plan, "default", controller.signal, { onCompleting: vi.fn() });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(run).resolves.toBe(completedPlan);
  });
  it("never fires when aborted during polling", async () => {
    mocks.poll.mockResolvedValue({ flowId: "flow-1", status: "pending", retryAfterMs: 1_000 });
    const onCompleting = vi.fn();
    const controller = new AbortController();
    const run = runProviderSignIn(plan, "default", controller.signal, { onCompleting });
    const settled = expect(run).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort();
    await vi.advanceTimersByTimeAsync(5_000);
    await settled;
    expect(onCompleting).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });
});
