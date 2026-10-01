// @vitest-environment happy-dom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LlamaCppSetupChatTestResult, LlamaCppSetupProjection } from "@goatcitadel/contracts";
import { useLlamaSetupChatTest } from "./use-llama-setup-chat-test";
import { __resetLlamaSetupForTests, useLlamaSetupState } from "./llama-setup-state";
import { deferredLlama, llamaProjectionFixture } from "./llama-setup.test-support";
const api = vi.hoisted(() => ({ fetchLlamaCppSetup: vi.fn(), testLlamaCppChat: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({
  getGatewayApiBaseUrl: () => "fixture-gateway",
}));
let root: Root,
  control: ReturnType<typeof useLlamaSetupChatTest>,
  state: ReturnType<typeof useLlamaSetupState>,
  projection: LlamaCppSetupProjection,
  workspaceId: string,
  available: boolean,
  result: LlamaCppSetupChatTestResult;
const refresh = vi.fn(async () => undefined);
function Probe() {
  control = useLlamaSetupChatTest({ workspaceId, projection, available, refresh });
  state = useLlamaSetupState("fixture-gateway", workspaceId);
  return null;
}
async function render(show = true) {
  await act(async () => root.render(<StrictMode>{show ? <Probe /> : null}</StrictMode>));
}
function review() {
  act(() => control.requestReview());
}
async function confirm() {
  await act(async () => control.confirm());
}
beforeEach(async () => {
  vi.resetAllMocks();
  __resetLlamaSetupForTests();
  workspaceId = "workspace-a";
  available = true;
  projection = {
    ...llamaProjectionFixture(),
    chatRoute: { providerId: "llamacpp", model: "served-model", thinkingLevel: "off" },
  };
  result = {
    success: true,
    providerId: "llamacpp",
    model: "served-model",
    settingsRevision: 8,
    elapsedMs: 12,
    traceRef: "trace-1",
    responseExcerpt: "fixture response",
  };
  api.fetchLlamaCppSetup.mockImplementation(async () => structuredClone(projection));
  api.testLlamaCppChat.mockImplementation(async () => structuredClone(result));
  root = createRoot(document.createElement("div"));
  await render();
});
afterEach(() => {
  act(() => root.unmount());
  __resetLlamaSetupForTests();
});
describe("separately reviewed llama Chat diagnostic", () => {
  it("cancels without dispatch and accepts only exact diagnostic plus independent owner readback", async () => {
    review();
    act(() => control.cancel());
    await confirm();
    expect(api.testLlamaCppChat).not.toHaveBeenCalled();
    review();
    await confirm();
    expect(api.testLlamaCppChat).toHaveBeenCalledExactlyOnceWith("workspace-a");
    expect(api.fetchLlamaCppSetup).toHaveBeenCalledTimes(2);
    expect(control.result).toEqual(result);
    expect(control.message).toContain("real Chat response");
    expect(state.attempt).toBeUndefined();
  });
  it("records a failed owner diagnostic as failure, never successful setup evidence", async () => {
    result = { ...result, success: false, responseExcerpt: undefined, error: "fixture provider failure" };
    review();
    await confirm();
    expect(control.result?.success).toBe(false);
    expect(control.message).toContain("did not complete successfully");
    expect(state.attempt).toBeUndefined();
  });
  it.each(["unavailable", "other-provider", "empty-model"])("withholds %s diagnostic", async (kind) => {
    if (kind === "unavailable") available = false;
    else
      projection = {
        ...projection,
        chatRoute: {
          ...projection.chatRoute,
          providerId: kind === "other-provider" ? "other" : "llamacpp",
          model: kind === "empty-model" ? "" : "served-model",
        },
      };
    await render();
    review();
    await confirm();
    expect(api.testLlamaCppChat).not.toHaveBeenCalled();
  });
  it.each(["changed-preflight", "away-back", "unmount"])("withholds write after %s", async (kind) => {
    review();
    const wait = deferredLlama<LlamaCppSetupProjection>();
    api.fetchLlamaCppSetup.mockReturnValueOnce(wait.promise);
    let run!: Promise<void>;
    act(() => {
      run = control.confirm();
    });
    if (kind === "away-back") {
      workspaceId = "other";
      await render();
      workspaceId = "workspace-a";
      await render();
    }
    if (kind === "unmount") await render(false);
    await act(async () => {
      wait.resolve(kind === "changed-preflight" ? { ...projection, settingsRevision: 9 } : projection);
      await run;
    });
    expect(api.testLlamaCppChat).not.toHaveBeenCalled();
  });
  it.each(["lost-response", "wrong-model", "wrong-revision", "missing-trace", "readback-error"])(
    "locks %s across remount",
    async (kind) => {
      if (kind === "lost-response") api.testLlamaCppChat.mockRejectedValueOnce(new Error("lost"));
      if (kind === "wrong-model") result = { ...result, model: "other" };
      if (kind === "wrong-revision") result = { ...result, settingsRevision: 99 };
      if (kind === "missing-trace") result = { ...result, traceRef: undefined };
      if (kind === "readback-error")
        api.fetchLlamaCppSetup.mockResolvedValueOnce(projection).mockRejectedValueOnce(new Error("offline"));
      review();
      await confirm();
      await render(false);
      workspaceId = "other";
      await render();
      expect(state.attempt?.state).toBe("uncertain");
      expect(control.eligible).toBe(false);
      review();
      await confirm();
      expect(api.testLlamaCppChat).toHaveBeenCalledTimes(1);
    },
  );
  it("suppresses a late result after unmount while preserving the acknowledged owner outcome", async () => {
    review();
    const wait = deferredLlama<LlamaCppSetupChatTestResult>();
    api.testLlamaCppChat.mockReturnValueOnce(wait.promise);
    let run!: Promise<void>;
    await act(async () => {
      run = control.confirm();
    });
    await render(false);
    await act(async () => {
      wait.resolve(result);
      await run;
    });
    await render();
    expect(control.result).toBeUndefined();
    expect(refresh).not.toHaveBeenCalled();
    expect(state.attempt).toBeUndefined();
  });
  it("marks completed evidence stale when the selected runtime changes", async () => {
    review();
    await confirm();
    projection = { ...projection, settingsRevision: 9 };
    await render();
    expect(control.stale).toBe(true);
    expect(control.result?.settingsRevision).toBe(8);
  });
  it("marks changed ownership readback stale even when settings revision stays equal", async () => {
    api.fetchLlamaCppSetup
      .mockResolvedValueOnce(projection)
      .mockResolvedValueOnce({ ...projection, ownership: "none" });
    review();
    await confirm();
    expect(control.stale).toBe(true);
    expect(control.message).toContain("stale");
    expect(state.attempt).toBeUndefined();
  });
});
