import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  consumeGatewayAccessBootstrapFromLocation: vi.fn(),
  getGatewayApiBaseUrl: vi.fn(),
  preflightGatewayAccess: vi.fn(),
  fetchGatewayCurrentAccess: vi.fn(),
  rejectionListener: undefined as
    | ((rejection: { authMode: "token" | "basic"; path: string; status: 401; hadStoredAuth: boolean }) => void)
    | undefined,
  subscribeGatewayAuthRejection: vi.fn(),
}));

vi.mock("@goatcitadel/mission-control-shared/api/shell-client", () => ({
  consumeGatewayAccessBootstrapFromLocation: apiMocks.consumeGatewayAccessBootstrapFromLocation,
  getGatewayApiBaseUrl: apiMocks.getGatewayApiBaseUrl,
  preflightGatewayAccess: apiMocks.preflightGatewayAccess,
  fetchGatewayCurrentAccess: apiMocks.fetchGatewayCurrentAccess,
  subscribeGatewayAuthRejection: apiMocks.subscribeGatewayAuthRejection,
}));

import { useGatewayAccess, type UseGatewayAccessResult } from "./use-gateway-access";

function Harness({ onResult }: { onResult: (result: UseGatewayAccessResult) => void }) {
  onResult(useGatewayAccess());
  return null;
}

describe("useGatewayAccess", () => {
  beforeEach(() => {
    apiMocks.fetchGatewayCurrentAccess.mockResolvedValue({ actorId: "operator-a", actorSource: "token", operatorAccess: true, readStatusScope: "operator" });
    apiMocks.consumeGatewayAccessBootstrapFromLocation.mockReturnValue({ consumed: false });
    apiMocks.getGatewayApiBaseUrl.mockReturnValue("http://127.0.0.1:8787");
    apiMocks.preflightGatewayAccess.mockResolvedValue({
      status: "ready",
      message: "ready",
      healthDetail: "authenticated",
    });
    apiMocks.subscribeGatewayAuthRejection.mockImplementation((listener) => {
      apiMocks.rejectionListener = listener;
      return () => {
        apiMocks.rejectionListener = undefined;
      };
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    apiMocks.rejectionListener = undefined;
  });

  it("leaves ready state immediately when the Gateway rejects active credentials", async () => {
    let latest!: UseGatewayAccessResult;
    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(createElement(Harness, { onResult: (result) => (latest = result) }));
      await Promise.resolve();
    });
    expect(latest.gatewayAccess.status).toBe("ready");

    act(() => {
      apiMocks.rejectionListener?.({
        authMode: "token",
        path: "/api/v1/dashboard/state",
        status: 401,
        hadStoredAuth: true,
      });
    });

    expect(latest.gatewayAccess).toMatchObject({
      status: "needs-auth",
      authMode: "token",
      rejectedStoredAuth: true,
    });
    expect(latest.gatewayBusy).toBe(false);

    act(() => renderer!.unmount());
    expect(apiMocks.rejectionListener).toBeUndefined();
  });
});

it("asks for first sign-in without claiming missing credentials were rejected", async () => {
  apiMocks.preflightGatewayAccess.mockResolvedValue({ status: "ready", message: "ready", healthDetail: "ok" });
  let latest!: UseGatewayAccessResult; let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(createElement(Harness, { onResult: value => latest = value })); });
  const calls = apiMocks.preflightGatewayAccess.mock.calls.length;
  await act(async () => apiMocks.rejectionListener?.({ authMode: "basic", path: "/api/v1/auth/current", status: 401, hadStoredAuth: false }));
  expect(latest.gatewayAccess).toMatchObject({ status: "needs-auth", rejectedStoredAuth: false });
  expect(latest.gatewayAccess.message).toContain("required");
  expect(latest.gatewayAccess.message).not.toContain("rejected");
  expect(apiMocks.preflightGatewayAccess).toHaveBeenCalledTimes(calls);
  await act(async () => renderer.unmount());
});

it("binds recovery to server principal, preserving same-caller scope and isolating a different caller", async () => {
 apiMocks.preflightGatewayAccess.mockResolvedValue({ status: "ready", message: "ready", healthDetail: "ok" });
 apiMocks.fetchGatewayCurrentAccess.mockResolvedValue({ actorId: "operator-a", actorSource: "token", operatorAccess: true });
 let latest!: UseGatewayAccessResult; let renderer!: ReactTestRenderer;
 await act(async () => { renderer = create(createElement(Harness, { onResult: value => latest = value })); });
 const origin = latest.callerScope; expect(origin).toContain("operator-a");
 await act(async () => { await latest.retryGatewayAccess(); });
 expect(latest.callerScope).toBe(origin);
 apiMocks.fetchGatewayCurrentAccess.mockResolvedValue({ actorId: "device-b", actorSource: "device", operatorAccess: false });
 await act(async () => { await latest.retryGatewayAccess(); });
 expect(latest.callerScope).not.toBe(origin);
 expect(latest.callerScope).toContain("device-b");
 await act(async () => renderer.unmount());
});
