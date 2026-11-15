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
  readStoredGatewayAuthState: vi.fn(),
}));

vi.mock("@goatcitadel/mission-control-shared/api/shell-client", () => ({
  consumeGatewayAccessBootstrapFromLocation: apiMocks.consumeGatewayAccessBootstrapFromLocation,
  readStoredGatewayAuthState: apiMocks.readStoredGatewayAuthState,
  getGatewayApiBaseUrl: apiMocks.getGatewayApiBaseUrl,
  preflightGatewayAccess: apiMocks.preflightGatewayAccess,
  fetchGatewayCurrentAccess: apiMocks.fetchGatewayCurrentAccess,
  subscribeGatewayAuthRejection: apiMocks.subscribeGatewayAuthRejection,
}));

import { clearGatewayAuthState } from "@goatcitadel/mission-control-shared/api/client-core";

import { describeRefusedCredential, useGatewayAccess, type UseGatewayAccessResult } from "./use-gateway-access";

function Harness({ onResult }: { onResult: (result: UseGatewayAccessResult) => void }) {
  onResult(useGatewayAccess());
  return null;
}

describe("useGatewayAccess", () => {
  beforeEach(() => {
    apiMocks.fetchGatewayCurrentAccess.mockResolvedValue({
      actorId: "operator-a",
      actorSource: "token",
      operatorAccess: true,
      readStatusScope: "operator",
    });
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

  it("uses current request authority from the startup response without a second identity read", async () => {
    apiMocks.preflightGatewayAccess.mockResolvedValueOnce({
      status: "ready",
      message: "ready",
      onboardingState: {
        completed: true,
        currentAccess: {
          actorId: "operator-b",
          actorSource: "basic",
          operatorAccess: true,
          readStatusScope: "operator",
        },
      },
    });
    let latest!: UseGatewayAccessResult;
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        createElement(Harness, {
          onResult: (result) => {
            latest = result;
          },
        }),
      );
      await Promise.resolve();
    });
    expect(latest.gatewayAccess.status).toBe("ready");
    expect(JSON.parse(latest.callerScope!)).toContain("operator-b");
    expect(apiMocks.fetchGatewayCurrentAccess).not.toHaveBeenCalled();
    act(() => renderer.unmount());
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
  let latest!: UseGatewayAccessResult;
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(Harness, { onResult: (value) => (latest = value) }));
  });
  const calls = apiMocks.preflightGatewayAccess.mock.calls.length;
  await act(async () =>
    apiMocks.rejectionListener?.({
      authMode: "basic",
      path: "/api/v1/auth/current",
      status: 401,
      hadStoredAuth: false,
    }),
  );
  expect(latest.gatewayAccess).toMatchObject({ status: "needs-auth", rejectedStoredAuth: false });
  expect(latest.gatewayAccess.message).toContain("required");
  expect(latest.gatewayAccess.message).not.toContain("rejected");
  expect(apiMocks.preflightGatewayAccess).toHaveBeenCalledTimes(calls);
  await act(async () => renderer.unmount());
});

it("binds recovery to server principal, preserving same-caller scope and isolating a different caller", async () => {
  apiMocks.preflightGatewayAccess.mockResolvedValue({ status: "ready", message: "ready", healthDetail: "ok" });
  apiMocks.fetchGatewayCurrentAccess.mockResolvedValue({
    actorId: "operator-a",
    actorSource: "token",
    operatorAccess: true,
  });
  let latest!: UseGatewayAccessResult;
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(Harness, { onResult: (value) => (latest = value) }));
  });
  const origin = latest.callerScope;
  expect(origin).toContain("operator-a");
  await act(async () => {
    await latest.retryGatewayAccess();
  });
  expect(latest.callerScope).toBe(origin);
  apiMocks.fetchGatewayCurrentAccess.mockResolvedValue({
    actorId: "device-b",
    actorSource: "device",
    operatorAccess: false,
  });
  await act(async () => {
    await latest.retryGatewayAccess();
  });
  expect(latest.callerScope).not.toBe(origin);
  expect(latest.callerScope).toContain("device-b");
  await act(async () => renderer.unmount());
});

describe("a refused credential", () => {
  beforeEach(() => {
    apiMocks.consumeGatewayAccessBootstrapFromLocation.mockReturnValue({ consumed: false });
    apiMocks.getGatewayApiBaseUrl.mockReturnValue("http://127.0.0.1:8787");
    apiMocks.subscribeGatewayAuthRejection.mockImplementation(() => () => undefined);
  });

  async function renderHarness() {
    let latest!: UseGatewayAccessResult;
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(createElement(Harness, { onResult: (value) => (latest = value) }));
      await Promise.resolve();
    });
    return { latest: () => latest, unmount: () => act(() => renderer.unmount()) };
  }

  const refusal = (authMode: "token" | "basic") => ({
    status: "needs-auth",
    message: "Stored gateway credentials were rejected. Re-enter them to continue.",
    healthDetail: "401",
    authMode,
    rejectedStoredAuth: true,
  });

  it("says the token was refused even though the client cleared it during the check (U-GL-053)", async () => {
    apiMocks.preflightGatewayAccess.mockResolvedValueOnce({ status: "ready", message: "ready", healthDetail: "ok" });
    apiMocks.fetchGatewayCurrentAccess.mockResolvedValue({
      actorId: "operator-a",
      actorSource: "token",
      operatorAccess: true,
    });
    const harness = await renderHarness();
    apiMocks.preflightGatewayAccess.mockImplementation(async () => {
      clearGatewayAuthState(); // the real client-core function: bumps the access revision
      return refusal("token");
    });
    await act(async () => harness.latest().retryGatewayAccess({ submittedMode: "token" }));
    expect(harness.latest().gatewayAccess).toMatchObject({
      status: "needs-auth",
      message: "That token was refused. Check it and try again.",
    });
    expect(harness.latest().gatewayBusy).toBe(false);
    await harness.unmount();
  });

  it("words a Basic refusal for a username and password", async () => {
    expect(describeRefusedCredential("basic")).toBe(
      "That username and password were refused. Check them and try again.",
    );
    expect(describeRefusedCredential(undefined)).toBe("That token was refused. Check it and try again.");
    expect(describeRefusedCredential("none")).toBe("That token was refused. Check it and try again.");
    expect(describeRefusedCredential("token", "saved")).toBe("Your saved token was refused. Enter it again.");
    expect(describeRefusedCredential("basic", "saved")).toBe(
      "Your saved username and password were refused. Enter them again.",
    );
  });

  async function refuseWith(options: { stored?: unknown; gatewayMode: "token" | "basic"; submission?: unknown }) {
    apiMocks.preflightGatewayAccess.mockResolvedValueOnce({ status: "ready", message: "ready", healthDetail: "ok" });
    apiMocks.fetchGatewayCurrentAccess.mockResolvedValue({
      actorId: "operator-a",
      actorSource: "token",
      operatorAccess: true,
    });
    const harness = await renderHarness();
    apiMocks.readStoredGatewayAuthState.mockReturnValue(options.stored);
    apiMocks.preflightGatewayAccess.mockImplementation(async () => {
      clearGatewayAuthState();
      return refusal(options.gatewayMode);
    });
    await act(async () => harness.latest().retryGatewayAccess(options.submission as never));
    const message = harness.latest().gatewayAccess.message;
    await harness.unmount();
    return message;
  }

  it("says a saved token was refused when nothing was typed this time", async () => {
    expect(await refuseWith({ stored: { mode: "token", token: "x" }, gatewayMode: "token" })).toBe(
      "Your saved token was refused. Enter it again.",
    );
  });

  it("says a saved username and password were refused", async () => {
    expect(await refuseWith({ stored: { mode: "basic", username: "u", password: "p" }, gatewayMode: "token" })).toBe(
      "Your saved username and password were refused. Enter them again.",
    );
  });

  it("follows the credential that was submitted, not the mode the Gateway reports (U-GL-053)", async () => {
    expect(
      await refuseWith({
        stored: { mode: "basic", username: "u", password: "p" },
        gatewayMode: "token",
        submission: { submittedMode: "basic" },
      }),
    ).toBe("That username and password were refused. Check them and try again.");
  });

  it("falls back to the Gateway's mode when nothing is known, and ignores a click event as a submission", async () => {
    expect(await refuseWith({ gatewayMode: "basic", submission: { type: "click" } })).toBe(
      "Your saved username and password were refused. Enter them again.",
    );
  });

  it("does not call anything else a refusal, and lets a newer attempt win", async () => {
    apiMocks.preflightGatewayAccess.mockResolvedValueOnce({ status: "ready", message: "ready", healthDetail: "ok" });
    apiMocks.fetchGatewayCurrentAccess.mockResolvedValue({
      actorId: "operator-a",
      actorSource: "token",
      operatorAccess: true,
    });
    const harness = await renderHarness();
    let releaseFirst: (value: unknown) => void = () => undefined;
    apiMocks.preflightGatewayAccess.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseFirst = resolve;
        }),
    );
    apiMocks.preflightGatewayAccess.mockResolvedValueOnce({ status: "ready", message: "ready", healthDetail: "ok" });
    let first!: Promise<void>;
    await act(async () => {
      first = harness.latest().retryGatewayAccess();
    });
    await act(async () => harness.latest().retryGatewayAccess());
    await act(async () => {
      releaseFirst(refusal("token"));
      await first;
    });
    expect(harness.latest().gatewayAccess.status).toBe("ready");
    await harness.unmount();
  });

  it("keeps an unreachable gateway reported as unreachable", async () => {
    apiMocks.preflightGatewayAccess.mockResolvedValueOnce({ status: "ready", message: "ready", healthDetail: "ok" });
    apiMocks.fetchGatewayCurrentAccess.mockResolvedValue({
      actorId: "operator-a",
      actorSource: "token",
      operatorAccess: true,
    });
    const harness = await renderHarness();
    apiMocks.preflightGatewayAccess.mockResolvedValueOnce({
      status: "unreachable",
      message: "Gateway is unreachable. Start the gateway and try again.",
      healthDetail: "x",
      rejectedStoredAuth: false,
    });
    await act(async () => harness.latest().retryGatewayAccess());
    expect(harness.latest().gatewayAccess).toMatchObject({ status: "unreachable" });
    expect(harness.latest().gatewayAccess.message).not.toMatch(/refused/);
    await harness.unmount();
  });
});
