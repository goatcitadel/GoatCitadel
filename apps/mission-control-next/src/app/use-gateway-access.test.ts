import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  consumeGatewayAccessBootstrapFromLocation: vi.fn(),
  getGatewayApiBaseUrl: vi.fn(),
  preflightGatewayAccess: vi.fn(),
  rejectionListener: undefined as
    | ((rejection: { authMode: "token" | "basic"; path: string; status: 401 }) => void)
    | undefined,
  subscribeGatewayAuthRejection: vi.fn(),
}));

vi.mock("@goatcitadel/mission-control-shared/api/shell-client", () => ({
  consumeGatewayAccessBootstrapFromLocation: apiMocks.consumeGatewayAccessBootstrapFromLocation,
  getGatewayApiBaseUrl: apiMocks.getGatewayApiBaseUrl,
  preflightGatewayAccess: apiMocks.preflightGatewayAccess,
  subscribeGatewayAuthRejection: apiMocks.subscribeGatewayAuthRejection,
}));

import { useGatewayAccess, type UseGatewayAccessResult } from "./use-gateway-access";

function Harness({ onResult }: { onResult: (result: UseGatewayAccessResult) => void }) {
  onResult(useGatewayAccess());
  return null;
}

describe("useGatewayAccess", () => {
  beforeEach(() => {
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
