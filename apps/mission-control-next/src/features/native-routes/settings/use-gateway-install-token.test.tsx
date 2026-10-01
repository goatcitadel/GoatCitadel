// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeSettingsResponse } from "@goatcitadel/mission-control-shared/api/client";
import { __resetAuthAttemptsForTests, useAuthAttempt } from "./gateway-auth-state";
import { useGatewayInstallToken } from "./use-gateway-install-token";
import { gatewayAuthSettingsFixture } from "./gateway-auth.test-support";
const api = vi.hoisted(() => ({ fetchSettings: vi.fn(), resolveGatewayInstallToken: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({ getGatewayApiBaseUrl: () => "owner" }));
const key = "access:owner:auth";
let settings: RuntimeSettingsResponse,
  active: boolean,
  root: Root,
  hook: ReturnType<typeof useGatewayInstallToken>,
  attempt: ReturnType<typeof useAuthAttempt>;
const reload = vi.fn(async () => undefined);
function Probe() {
  attempt = useAuthAttempt(key);
  hook = useGatewayInstallToken({ key, settings, active, available: true, locked: Boolean(attempt), reload });
  return null;
}
async function render(show = true) {
  await act(async () => root.render(show ? <Probe /> : null));
}
async function confirm() {
  await act(async () => hook.confirm());
}
beforeEach(async () => {
  vi.resetAllMocks();
  settings = gatewayAuthSettingsFixture();
  active = true;
  api.fetchSettings.mockImplementation(async () => structuredClone(settings));
  api.resolveGatewayInstallToken.mockResolvedValue({
    token: "synthetic-install-secret",
    source: "runtime",
    persistedToEnv: false,
    warnings: [],
  });
  root = createRoot(document.createElement("div"));
  await render();
});
afterEach(() => {
  act(() => root.unmount());
  __resetAuthAttemptsForTests();
  vi.useRealTimers();
});
describe("Gateway installation token owner", () => {
  it("requires review, checks before and after, and never persists the token to env", async () => {
    act(() => hook.requestReview());
    expect(api.resolveGatewayInstallToken).not.toHaveBeenCalled();
    act(() => hook.cancel());
    await confirm();
    expect(api.resolveGatewayInstallToken).not.toHaveBeenCalled();
    act(() => hook.requestReview());
    await confirm();
    expect(api.resolveGatewayInstallToken).toHaveBeenCalledExactlyOnceWith({
      generateWhenMissing: true,
      persistToEnv: false,
    });
    expect(api.fetchSettings).toHaveBeenCalledTimes(2);
    expect(hook.token).toBe("synthetic-install-secret");
  });
  it("clears the revealed value after 30 seconds, close and remount", async () => {
    vi.useFakeTimers();
    act(() => hook.requestReview());
    await confirm();
    act(() => vi.advanceTimersByTime(30_000));
    expect(hook.token).toBe("");
    act(() => hook.requestReview());
    await confirm();
    active = false;
    await render();
    expect(hook.token).toBe("");
    await render(false);
    active = true;
    await render();
    expect(hook.token).toBe("");
  });
  it("withholds token resolution outside Token mode", async () => {
    settings = { ...settings, auth: { ...settings.auth, mode: "none" } };
    await render();
    act(() => hook.requestReview());
    await confirm();
    expect(api.resolveGatewayInstallToken).not.toHaveBeenCalled();
  });
  it("rejects stale owner posture before the non-atomic token request", async () => {
    act(() => hook.requestReview());
    api.fetchSettings.mockResolvedValue({ ...settings, revision: 42 });
    await confirm();
    expect(api.resolveGatewayInstallToken).not.toHaveBeenCalled();
  });
  it("does not write after leaving and returning during preflight", async () => {
    act(() => hook.requestReview());
    let resolve!: (value: RuntimeSettingsResponse) => void;
    api.fetchSettings.mockReturnValue(
      new Promise<RuntimeSettingsResponse>((done) => {
        resolve = done;
      }),
    );
    let pending!: Promise<void>;
    await act(async () => {
      pending = hook.confirm();
    });
    active = false;
    await render();
    active = true;
    await render();
    await act(async () => {
      resolve(settings);
      await pending;
    });
    expect(api.resolveGatewayInstallToken).not.toHaveBeenCalled();
  });
  it.each(["lost-response", "changed-posture", "invalid-receipt"])(
    "withholds secret and retains uncertainty for %s",
    async (kind) => {
      if (kind === "lost-response") api.resolveGatewayInstallToken.mockRejectedValue(new Error("lost"));
      if (kind === "changed-posture")
        api.fetchSettings.mockResolvedValueOnce(settings).mockResolvedValueOnce({ ...settings, revision: 42 });
      if (kind === "invalid-receipt")
        api.resolveGatewayInstallToken.mockResolvedValue({
          token: "synthetic",
          source: "runtime",
          persistedToEnv: true,
          warnings: [],
        });
      act(() => hook.requestReview());
      await confirm();
      expect(hook.token).toBe("");
      await render(false);
      await render();
      expect(attempt?.state).toBe("uncertain");
      expect(hook.eligible).toBe(false);
    },
  );
});
