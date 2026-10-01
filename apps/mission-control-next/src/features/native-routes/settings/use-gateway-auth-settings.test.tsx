// @vitest-environment happy-dom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetSessionDraftsForTests } from "../library/session-drafts";
import { __resetSettingsChangesForTests } from "./use-settings-change";
import { __resetAuthAttemptsForTests } from "./gateway-auth-state";
import { useGatewayAuthSettings } from "./use-gateway-auth-settings";
import { gatewayAuthSettingsFixture } from "./gateway-auth.test-support";

const api = vi.hoisted(() => ({
  fetchSettings: vi.fn(),
  patchGatewayAuthSettings: vi.fn(),
  fetchChangePlan: vi.fn(),
  baseUrl: "http://gateway-a",
}));
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({ getGatewayApiBaseUrl: () => api.baseUrl }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  ...api,
  isApiRequestError: (error: unknown) => Boolean(error && typeof error === "object" && "status" in error),
}));
const initial = gatewayAuthSettingsFixture();
let owner: typeof initial, active: boolean, available: boolean, root: Root, container: HTMLDivElement;
let hook: ReturnType<typeof useGatewayAuthSettings>;
const reload = vi.fn(async () => undefined);
function Probe() {
  hook = useGatewayAuthSettings({ settings: owner, active, available, reload });
  return null;
}
async function render(show = true) {
  await act(async () => root.render(<StrictMode>{show ? <Probe /> : null}</StrictMode>));
}
async function review(secret = false) {
  act(() => {
    hook.draft.setValue((value) => ({ ...value, allowLoopbackBypass: true }));
    if (secret) hook.updateCredential("synthetic-auth-credential");
  });
  act(() => hook.requestReview());
}
async function confirm() {
  await act(async () => {
    await hook.confirm();
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function plan() {
  return {
    schemaVersion: 1,
    planId: "auth-plan",
    revision: 2,
    status: "awaiting_approval",
    kind: "runtime_configuration",
    intentHash: "exact-intent",
    origin: { workspaceId: "default", surface: "settings" },
    target: { ownerId: "runtime_settings", resourceId: "gateway_auth_configuration", expectedRevision: 41 },
    request: {
      kind: "runtime_configuration",
      change: { operation: "gateway_auth_configuration", mode: "token", allowLoopbackBypass: true },
    },
  };
}
beforeEach(async () => {
  vi.resetAllMocks();
  api.baseUrl = "http://gateway-a";
  owner = structuredClone(initial);
  active = true;
  available = true;
  api.fetchSettings.mockImplementation(async () => structuredClone(owner));
  api.patchGatewayAuthSettings.mockImplementation(async (input: { allowLoopbackBypass: boolean }) => {
    owner = { ...owner, revision: 42, auth: { ...owner.auth, allowLoopbackBypass: input.allowLoopbackBypass } };
    return { ...owner.auth, revision: owner.revision };
  });
  reload.mockResolvedValue(undefined);
  container = document.createElement("div");
  root = createRoot(container);
  await render();
});
afterEach(() => {
  act(() => root.unmount());
  __resetSessionDraftsForTests();
  __resetSettingsChangesForTests();
  __resetAuthAttemptsForTests();
});
describe("shared Gateway authentication owner", () => {
  it("requires explicit review and sends exact revision with canonical readback", async () => {
    await review();
    expect(api.patchGatewayAuthSettings).not.toHaveBeenCalled();
    act(() => hook.cancel());
    await confirm();
    expect(api.patchGatewayAuthSettings).not.toHaveBeenCalled();
    act(() => hook.requestReview());
    await confirm();
    expect(api.patchGatewayAuthSettings).toHaveBeenCalledExactlyOnceWith({
      expectedRevision: 41,
      mode: "token",
      allowLoopbackBypass: true,
    });
    expect(hook.draft.isDirty).toBe(false);
    expect(hook.notice).toContain("saved and confirmed");
    expect(api.fetchSettings).toHaveBeenCalledTimes(2);
  });
  it("sends transient credentials only to the custody endpoint and clears them after submission", async () => {
    await review(true);
    expect(JSON.stringify(hook.draft.value)).not.toContain("synthetic-auth-credential");
    expect(JSON.stringify(hook.review)).not.toContain("synthetic-auth-credential");
    await confirm();
    expect(api.patchGatewayAuthSettings).toHaveBeenCalledWith(
      expect.objectContaining({ token: "synthetic-auth-credential" }),
    );
    expect(hook.credential).toBe("");
    expect(JSON.stringify(hook.change.change ?? null)).not.toContain("synthetic-auth-credential");
  });
  it("retains only the public draft when remounted in the other shell", async () => {
    await review(true);
    await render(false);
    await render();
    expect(hook.credential).toBe("");
    expect(hook.draft.value.replaceCredential).toBe(true);
    expect(hook.inputError).toContain("Enter the new credential");
  });
  it.each(["revision", "posture", "unavailable"])(
    "withholds writes when %s changes before review confirmation",
    async (kind) => {
      await review();
      if (kind === "revision") owner.revision++;
      else if (kind === "posture") owner.auth.allowLoopbackBypass = true;
      else available = false;
      await render();
      await confirm();
      expect(api.patchGatewayAuthSettings).not.toHaveBeenCalled();
    },
  );
  it("rejects fresh owner drift and preserves the public draft", async () => {
    await review();
    api.fetchSettings.mockResolvedValue({ ...owner, revision: 42 });
    await confirm();
    expect(api.patchGatewayAuthSettings).not.toHaveBeenCalled();
    expect(hook.draft.isDirty).toBe(true);
  });
  it.each(["unmount", "leave-return", "draft-restore"])("cancels late preflight after %s", async (kind) => {
    await review();
    const wait = deferred<typeof owner>();
    api.fetchSettings.mockReturnValue(wait.promise);
    let pending!: Promise<boolean>;
    await act(async () => {
      pending = hook.confirm();
    });
    if (kind === "unmount") await render(false);
    if (kind === "leave-return") {
      active = false;
      await render();
      active = true;
      await render();
    }
    if (kind === "draft-restore") {
      act(() => hook.draft.setValue((value) => ({ ...value, allowLoopbackBypass: false })));
      act(() => hook.draft.setValue((value) => ({ ...value, allowLoopbackBypass: true })));
    }
    await act(async () => {
      wait.resolve(owner);
      await pending;
    });
    expect(api.patchGatewayAuthSettings).not.toHaveBeenCalled();
  });
  it("keeps pending and unknown locks through remount and rejects duplicate dispatch", async () => {
    await review();
    const wait = deferred<never>();
    api.patchGatewayAuthSettings.mockReturnValue(wait.promise);
    let pending!: Promise<boolean>;
    await act(async () => {
      pending = hook.confirm();
    });
    await render(false);
    await render();
    expect(hook.locked).toBe(true);
    await confirm();
    expect(api.patchGatewayAuthSettings).toHaveBeenCalledOnce();
    await act(async () => {
      wait.reject(new Error("lost response"));
      await pending;
    });
    await render(false);
    await render();
    expect(hook.attempt?.state).toBe("uncertain");
    expect(hook.locked).toBe(true);
  });
  it("acknowledges a late committed receipt without refreshing the replacement view", async () => {
    await review();
    const wait = deferred<{ revision: number } & typeof initial.auth>();
    api.patchGatewayAuthSettings.mockReturnValue(wait.promise);
    let pending!: Promise<boolean>;
    await act(async () => {
      pending = hook.confirm();
    });
    await render(false);
    owner = { ...owner, revision: 42, auth: { ...owner.auth, allowLoopbackBypass: true } };
    await act(async () => {
      wait.resolve({ ...owner.auth, revision: 42 });
      await pending;
    });
    expect(reload).not.toHaveBeenCalled();
    await render();
    expect(hook.draft.isDirty).toBe(false);
    expect(hook.locked).toBe(false);
  });
  it.each(["plan", "readback"])(
    "rejects foreign settlement after installation changes during %s and preserves both drafts",
    async (stage) => {
      const planWait = deferred<ReturnType<typeof plan>>();
      const ownerWait = deferred<typeof initial>();
      const record = {
        ...plan(),
        request: { ...plan().request, change: { ...plan().request.change, replaceCredential: true } },
      };
      api.patchGatewayAuthSettings.mockResolvedValue(
        stage === "plan"
          ? {
              ...owner.auth,
              revision: 41,
              changePlanReceipt: { planId: record.planId, revision: record.revision, status: record.status },
            }
          : { ...owner.auth, revision: 42, allowLoopbackBypass: true },
      );
      if (stage === "plan") api.fetchChangePlan.mockReturnValue(planWait.promise);
      else api.fetchSettings.mockResolvedValueOnce(structuredClone(owner)).mockReturnValueOnce(ownerWait.promise);
      await review(true);
      let pending!: Promise<boolean>;
      await act(async () => {
        pending = hook.confirm();
      });
      expect(api.patchGatewayAuthSettings).toHaveBeenCalledOnce();
      api.baseUrl = "http://gateway-b";
      await render();
      expect(hook.credential).toBe("");
      act(() => {
        hook.draft.setValue((value) => ({ ...value, allowLoopbackBypass: true }));
        hook.updateCredential("synthetic-gateway-b-credential");
      });
      await act(async () => {
        if (stage === "plan") planWait.resolve(record);
        else ownerWait.resolve({ ...owner, revision: 42, auth: { ...owner.auth, allowLoopbackBypass: true } });
        await pending;
      });
      expect(hook.credential).toBe("synthetic-gateway-b-credential");
      expect(hook.draft.isDirty).toBe(true);
      expect(hook.change.change).toBeUndefined();
      expect(reload).not.toHaveBeenCalled();
      api.baseUrl = "http://gateway-a";
      await render();
      expect(hook.credential).toBe("");
      expect(hook.draft.isDirty).toBe(true);
      expect(hook.draft.value.replaceCredential).toBe(true);
      expect(hook.attempt?.state).toBe("uncertain");
      expect(hook.change.change).toBeUndefined();
      expect(JSON.stringify(hook.draft.value)).not.toContain("synthetic-");
      expect(api.patchGatewayAuthSettings).toHaveBeenCalledOnce();
    },
  );
  it("requires matching plan origin, target, revision and public request before accepting a pending receipt", async () => {
    const record = plan();
    api.fetchChangePlan.mockResolvedValue(record);
    api.patchGatewayAuthSettings.mockResolvedValue({
      ...owner.auth,
      revision: 41,
      changePlanReceipt: { planId: record.planId, revision: record.revision, status: record.status },
    });
    await review();
    await confirm();
    expect(hook.change.change?.blocking).toBe(true);
    expect(hook.change.change?.plan?.planId).toBe("auth-plan");
    await render(false);
    await render();
    expect(hook.locked).toBe(true);
  });
  it.each(["workspace", "operation", "base revision", "receipt action", "readback"])(
    "locks on substituted %s evidence",
    async (kind) => {
      if (kind === "readback")
        api.patchGatewayAuthSettings.mockResolvedValue({ ...owner.auth, revision: 42, allowLoopbackBypass: true });
      else {
        const record = plan();
        if (kind === "workspace") record.origin.workspaceId = "foreign";
        if (kind === "operation") record.request.change.operation = "budget_mode";
        if (kind === "base revision") record.target.expectedRevision = 40;
        api.fetchChangePlan.mockResolvedValue(record);
        api.patchGatewayAuthSettings.mockResolvedValue({
          ...owner.auth,
          revision: 41,
          changePlanReceipt: {
            planId: record.planId,
            revision: 2,
            status: record.status,
            ...(kind === "receipt action" ? { requiredAction: { kind: "confirmation", actionNonce: "foreign" } } : {}),
          },
        });
      }
      await review();
      await confirm();
      expect(hook.attempt?.state).toBe("uncertain");
      expect(hook.draft.isDirty).toBe(true);
    },
  );
  it.each([false, true])("classifies only bound, uncommitted revision conflict (committed %s)", async (committed) => {
    api.patchGatewayAuthSettings.mockRejectedValue({
      status: 409,
      path: "/api/v1/auth/settings",
      method: "PATCH",
      body: {
        code: "STATE_CONFLICT",
        mutationCommitted: committed,
        details: { expectedRevision: 41, currentRevision: 42 },
      },
    });
    await review();
    await confirm();
    expect(hook.attempt?.state).toBe(committed ? "uncertain" : undefined);
  });
});
