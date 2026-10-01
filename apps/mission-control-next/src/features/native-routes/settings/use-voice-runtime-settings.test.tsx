// @vitest-environment happy-dom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceRuntimeStatus } from "@goatcitadel/contracts";
import { useVoiceRuntimeSettings } from "./use-voice-runtime-settings";
import { __resetVoiceAttemptsForTests } from "./voice-runtime-state";
import { selectedVoiceRuntime, voiceRuntimeFixture } from "./voice-runtime.test-support";
const api = vi.hoisted(() => ({
  fetchVoiceRuntimeStatus: vi.fn(),
  installVoiceRuntime: vi.fn(),
  selectVoiceRuntimeModel: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({
  getGatewayApiBaseUrl: () => "fixture-gateway",
}));
let status: VoiceRuntimeStatus,
  active: boolean,
  available: boolean,
  root: Root,
  control: ReturnType<typeof useVoiceRuntimeSettings>;
const reload = vi.fn(async () => undefined);
function Probe() {
  control = useVoiceRuntimeSettings({ status, active, available, reload });
  return null;
}
async function render(show = true) {
  await act(async () => root.render(<StrictMode>{show ? <Probe /> : null}</StrictMode>));
}
function review(kind: "install" | "select" = "select") {
  act(() => control.requestReview({ kind, modelId: "base" }));
}
async function confirm() {
  await act(async () => control.confirm());
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
beforeEach(async () => {
  vi.resetAllMocks();
  status = voiceRuntimeFixture();
  active = available = true;
  api.fetchVoiceRuntimeStatus.mockImplementation(async () => structuredClone(status));
  const select = async (modelId: string) => {
    status = selectedVoiceRuntime(status, modelId);
    return structuredClone(status);
  };
  api.selectVoiceRuntimeModel.mockImplementation(select);
  api.installVoiceRuntime.mockImplementation(async (input: { modelId: string }) => select(input.modelId));
  root = createRoot(document.createElement("div"));
  await render();
});
afterEach(() => {
  act(() => root.unmount());
  __resetVoiceAttemptsForTests();
});
describe("shared voice runtime owner", () => {
  it.each(["install", "select"] as const)(
    "requires explicit cancellable review and confirms exact %s readback",
    async (kind) => {
      review(kind);
      expect(api.installVoiceRuntime).not.toHaveBeenCalled();
      expect(api.selectVoiceRuntimeModel).not.toHaveBeenCalled();
      act(() => control.cancel());
      await confirm();
      expect(api.fetchVoiceRuntimeStatus).not.toHaveBeenCalled();
      review(kind);
      await confirm();
      if (kind === "install")
        expect(api.installVoiceRuntime).toHaveBeenCalledExactlyOnceWith({ modelId: "base", activate: true });
      else expect(api.selectVoiceRuntimeModel).toHaveBeenCalledExactlyOnceWith("base");
      expect(api.fetchVoiceRuntimeStatus).toHaveBeenCalledTimes(2);
      expect(control.attempt).toBeUndefined();
      expect(control.message).toContain("confirmed");
    },
  );
  it.each(["environment", "unknown-model", "missing-installed", "unavailable"])("withholds %s action", async (kind) => {
    if (kind === "environment") status.source = "env_override";
    if (kind === "missing-installed") status.installedModels = [];
    if (kind === "unavailable") available = false;
    await render();
    act(() => control.requestReview({ kind: "select", modelId: kind === "unknown-model" ? "foreign" : "base" }));
    expect(control.review).toBeNull();
    await confirm();
    expect(api.selectVoiceRuntimeModel).not.toHaveBeenCalled();
  });
  it("withholds stale preflight without dispatch", async () => {
    review();
    api.fetchVoiceRuntimeStatus.mockResolvedValue({ ...status, binaryPath: "/other/runtime" });
    await confirm();
    expect(api.selectVoiceRuntimeModel).not.toHaveBeenCalled();
    expect(control.attempt).toBeUndefined();
    expect(control.message).toContain("changed");
  });
  it.each(["unmount", "leave-return", "owner-restore"])("cancels late preflight after %s", async (kind) => {
    review();
    const wait = deferred<VoiceRuntimeStatus>();
    api.fetchVoiceRuntimeStatus.mockReturnValue(wait.promise);
    let pending!: Promise<void>;
    await act(async () => {
      pending = control.confirm();
    });
    if (kind === "unmount") await render(false);
    if (kind === "leave-return") {
      active = false;
      await render();
      active = true;
      await render();
    }
    if (kind === "owner-restore") {
      status = { ...status, binaryPath: "changed" };
      await render();
      status = voiceRuntimeFixture();
      await render();
    }
    await act(async () => {
      wait.resolve(status);
      await pending;
    });
    expect(api.selectVoiceRuntimeModel).not.toHaveBeenCalled();
  });
  it.each(["lost-response", "route-400", "wrong-model", "readback"])(
    "retains uncertainty after %s through remount",
    async (kind) => {
      if (kind === "lost-response") api.selectVoiceRuntimeModel.mockRejectedValue(Error("lost response"));
      if (kind === "route-400")
        api.selectVoiceRuntimeModel.mockRejectedValue({ status: 400, body: { error: "postcommit failure" } });
      if (kind === "wrong-model") api.selectVoiceRuntimeModel.mockResolvedValue(status);
      if (kind === "readback") api.selectVoiceRuntimeModel.mockResolvedValue(selectedVoiceRuntime(status, "base"));
      review();
      await confirm();
      await render(false);
      await render();
      expect(control.attempt?.state).toBe("uncertain");
      expect(control.canRequest({ kind: "install", modelId: "base" })).toBe(false);
      review("install");
      await confirm();
      expect(api.selectVoiceRuntimeModel).toHaveBeenCalledOnce();
      expect(api.installVoiceRuntime).not.toHaveBeenCalled();
    },
  );
  it("retains pending admission across remount and suppresses late view effects", async () => {
    const wait = deferred<VoiceRuntimeStatus>();
    api.selectVoiceRuntimeModel.mockReturnValue(wait.promise);
    review();
    let pending!: Promise<void>;
    await act(async () => {
      pending = control.confirm();
    });
    await render(false);
    await render();
    expect(control.attempt?.state).toBe("pending");
    review("install");
    await confirm();
    status = selectedVoiceRuntime(status, "base");
    await act(async () => {
      wait.resolve(status);
      await pending;
    });
    expect(control.attempt).toBeUndefined();
    expect(control.message).toBeNull();
    expect(reload).not.toHaveBeenCalled();
    expect(api.installVoiceRuntime).not.toHaveBeenCalled();
  });
});
