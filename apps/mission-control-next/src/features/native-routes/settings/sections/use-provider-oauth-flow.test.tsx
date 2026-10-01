// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { ChangePlanRecord } from "@goatcitadel/contracts";
import type {
  OpenAICodexDeviceStartResponse,
  OpenAICodexDevicePollResponse,
} from "@goatcitadel/mission-control-shared/api/client";
import { useProviderOAuthFlow } from "./use-provider-oauth-flow";
import { __resetProviderMutationStateForTests } from "./provider-mutation-state";

const api = vi.hoisted(() => ({
  createChangePlan: vi.fn(),
  fetchChangePlans: vi.fn(),
  fetchOpenAICodexOAuthStatus: vi.fn(),
  startChangePlanProviderOAuth: vi.fn(),
  pollChangePlanProviderOAuth: vi.fn(),
  completeChangePlanProviderOAuth: vi.fn(),
  cancelChangePlan: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);
const plan: ChangePlanRecord = {
  schemaVersion: 1,
  planId: "oauth-plan",
  origin: { workspaceId: "default", surface: "settings" },
  adapter: { adapterId: "provider-connection", version: 3 },
  kind: "provider_connection",
  scope: "provider",
  status: "awaiting_input",
  phase: "input",
  revision: 1,
  intentHash: "fixture-intent",
  request: { kind: "provider_connection", providerId: "openai-codex" },
  target: { ownerId: "provider_connection", resourceId: "openai-codex" },
  title: "Connect",
  summary: "Review login",
  impact: "Provider login",
  risk: "safe",
  requiredAction: {
    kind: "oauth",
    actionId: "oauth-action",
    actionNonce: "fixture-nonce",
    title: "Login",
    targetId: "openai-codex",
  },
  approvalRefs: [],
  evidenceRefs: [],
  rollbackRefs: [],
  createdAt: "2026-09-30T00:00:00Z",
  updatedAt: "2026-09-30T00:00:00Z",
};
const flow: OpenAICodexDeviceStartResponse = {
  providerId: "openai-codex",
  flowId: "fixture-flow",
  verificationUrl: "https://auth.openai.com/codex/device",
  userCode: "FIXTURE",
  expiresAt: "2099-01-01T00:00:00Z",
  pollAfterMs: 5000,
};
const pending: OpenAICodexDevicePollResponse = {
  providerId: "openai-codex",
  flowId: flow.flowId,
  status: "pending",
  retryAfterMs: 7000,
};
let owner: ReturnType<typeof useProviderOAuthFlow>, workspaceId: string, root: Root, container: HTMLDivElement;
const setNotice = vi.fn();
function Probe() {
  owner = useProviderOAuthFlow({ activeWorkspaceId: workspaceId, hasCodexOAuthProvider: true, setNotice });
  return null;
}
const render = () =>
  act(async () => {
    root.render(<Probe />);
  });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}
beforeEach(() => {
  vi.resetAllMocks();
  __resetProviderMutationStateForTests();
  workspaceId = "default";
  api.fetchOpenAICodexOAuthStatus.mockResolvedValue({ providerId: "openai-codex", available: true, connected: false });
  api.fetchChangePlans.mockResolvedValue({ items: [] });
  api.createChangePlan.mockResolvedValue(plan);
  api.startChangePlanProviderOAuth.mockResolvedValue(flow);
  api.pollChangePlanProviderOAuth.mockResolvedValue(pending);
  api.completeChangePlanProviderOAuth.mockResolvedValue({ ...plan, revision: 2, status: "awaiting_confirmation" });
  vi.stubGlobal("open", vi.fn());
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Unexpected network in OAuth fixture");
    }),
  );
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  __resetProviderMutationStateForTests();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("shared provider OAuth lifecycle", () => {
  it.each(["supplied", "list", "session"])("withholds OAuth dispatch for a foreign %s plan", async (source) => {
    const foreign = {
      ...plan,
      origin: {
        ...plan.origin,
        ...(source === "session" ? { sessionId: "foreign-session" } : { workspaceId: "other" }),
      },
    };
    if (source === "list") api.fetchChangePlans.mockResolvedValue({ items: [foreign] });
    await render();
    await act(async () => {
      await owner.handleStartCodexOAuth(true, source === "list" ? undefined : foreign);
    });
    expect(api.createChangePlan).not.toHaveBeenCalled();
    expect(api.startChangePlanProviderOAuth).not.toHaveBeenCalled();
    expect(api.pollChangePlanProviderOAuth).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(owner.mutation.uncertain).toBeUndefined();
  });
  it("cancels only the current reviewed plan and retains a lost cancellation outcome", async () => {
    api.cancelChangePlan.mockRejectedValue(new Error("Lost cancel reply"));
    await render();
    await act(async () => {
      owner.setCodexOAuthPlan(plan);
    });
    await act(async () => {
      await owner.handleCancelCodexOAuth({ ...plan });
    });
    expect(api.cancelChangePlan).not.toHaveBeenCalled();
    await act(async () => {
      await owner.handleCancelCodexOAuth(plan);
    });
    expect(api.cancelChangePlan).toHaveBeenCalledExactlyOnceWith(
      plan.planId,
      { workspaceId: "default" },
      { expectedRevision: 1, actionNonce: "fixture-nonce" },
    );
    expect(owner.mutation.uncertain).toBeTruthy();
    expect(owner.codexOAuthPlan).toEqual(plan);
  });
  it("admits only one start and cancels follow-on dispatch after away/back scope changes", async () => {
    const read = deferred<{ items: ChangePlanRecord[] }>();
    api.fetchChangePlans.mockReturnValue(read.promise);
    await render();
    let starting!: Promise<void>;
    await act(async () => {
      starting = owner.handleStartCodexOAuth(true);
      await owner.handleStartCodexOAuth(true);
    });
    expect(api.fetchChangePlans).toHaveBeenCalledOnce();
    workspaceId = "other";
    await render();
    workspaceId = "default";
    await render();
    await act(async () => {
      read.resolve({ items: [] });
      await starting;
    });
    expect(api.createChangePlan).not.toHaveBeenCalled();
    expect(api.startChangePlanProviderOAuth).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(owner.mutation.pending).toBe(false);
  });
  it("retains a lost start result lock across remount", async () => {
    api.startChangePlanProviderOAuth.mockRejectedValue(new Error("Lost reply"));
    await render();
    await act(async () => {
      await owner.handleStartCodexOAuth();
    });
    expect(owner.mutation.uncertain).toBeTruthy();
    await act(async () => root.render(<p>Other view</p>));
    await render();
    await act(async () => {
      await owner.handleStartCodexOAuth();
      await owner.handleDisconnectCodexOAuth();
    });
    expect(api.startChangePlanProviderOAuth).toHaveBeenCalledOnce();
    expect(api.createChangePlan).toHaveBeenCalledOnce();
  });
  it("does not open a late login or poll it in the new scope", async () => {
    const starting = deferred<OpenAICodexDeviceStartResponse>();
    api.startChangePlanProviderOAuth.mockReturnValue(starting.promise);
    await render();
    let task!: Promise<void>;
    await act(async () => {
      task = owner.handleStartCodexOAuth(true);
    });
    workspaceId = "other";
    await render();
    setNotice.mockClear();
    await act(async () => {
      starting.resolve(flow);
      await task;
    });
    expect(owner.codexOAuthFlow).toBeNull();
    expect(open).not.toHaveBeenCalled();
    expect(api.pollChangePlanProviderOAuth).not.toHaveBeenCalled();
    expect(setNotice).not.toHaveBeenCalled();
  });
  it("rejects a foreign poll flow before OAuth completion", async () => {
    api.pollChangePlanProviderOAuth.mockResolvedValue({ ...pending, flowId: "foreign", status: "connected" });
    await render();
    await act(async () => {
      await owner.handleStartCodexOAuth();
    });
    expect(api.completeChangePlanProviderOAuth).not.toHaveBeenCalled();
    expect(owner.mutation.uncertain).toBeTruthy();
  });
  it("keeps polling admission until settlement across rerenders and scope cleanup", async () => {
    vi.useFakeTimers();
    const read = deferred<OpenAICodexDevicePollResponse>();
    api.pollChangePlanProviderOAuth.mockReturnValue(read.promise);
    await render();
    await act(async () => {
      await owner.handleStartCodexOAuth();
    });
    expect(api.pollChangePlanProviderOAuth).toHaveBeenCalledOnce();
    await render();
    await act(async () => {
      await owner.handlePollCodexOAuth();
    });
    workspaceId = "other";
    await render();
    workspaceId = "default";
    await render();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20000);
    });
    expect(api.pollChangePlanProviderOAuth).toHaveBeenCalledOnce();
    await act(async () => {
      read.resolve({ ...pending, status: "connected" });
      await read.promise;
    });
    expect(api.completeChangePlanProviderOAuth).not.toHaveBeenCalled();
    expect(owner.mutation.pending).toBe(false);
  });
  it("does not acquire busy for a flow whose action is no longer OAuth", async () => {
    await render();
    await act(async () => {
      owner.setCodexOAuthPlan({ ...plan, requiredAction: undefined });
      owner.setCodexOAuthFlow(flow);
    });
    await act(async () => {
      await owner.handlePollCodexOAuth();
    });
    expect(api.pollChangePlanProviderOAuth).not.toHaveBeenCalled();
    expect(owner.codexOAuthBusy).toBe(false);
  });
  it("rejects a completion response for a different provider request", async () => {
    api.pollChangePlanProviderOAuth.mockResolvedValue({ ...pending, status: "connected" });
    api.completeChangePlanProviderOAuth.mockResolvedValue({
      ...plan,
      revision: 2,
      request: { kind: "provider_connection", providerId: "openai-codex", credentialAction: "remove_oauth" },
    });
    await render();
    await act(async () => {
      await owner.handleStartCodexOAuth();
    });
    expect(owner.mutation.uncertain).toBeTruthy();
    expect(owner.codexOAuthPlanDialog).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});
