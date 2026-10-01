// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChangePlanRecord } from "@goatcitadel/contracts";
import { __resetAuthAttemptsForTests, useAuthAttempt } from "./gateway-auth-state";
import { useGatewayAuthContinuation } from "./use-gateway-auth-continuation";
const api = vi.hoisted(() => ({
  fetchSettings: vi.fn(),
  fetchChangePlan: vi.fn(),
  confirmChangePlan: vi.fn(),
  submitChangePlanGatewayAuthCredential: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({ getGatewayApiBaseUrl: () => "owner" }));
const key = "access:owner:auth";
const submitted = { mode: "token", allowLoopbackBypass: false, basicUsername: "", replaceCredential: true };
function initial(): ChangePlanRecord {
  return {
    schemaVersion: 1,
    planId: "auth-plan",
    revision: 2,
    status: "awaiting_input",
    kind: "runtime_configuration",
    adapter: { adapterId: "runtime_configuration", version: 1 },
    scope: "runtime",
    phase: "input",
    title: "Configure Gateway authentication",
    summary: "Replace the installation token",
    impact: "Changes access for every workspace",
    risk: "danger",
    approvalRefs: [],
    evidenceRefs: [],
    rollbackRefs: [],
    createdAt: "2026-09-30T00:00:00.000Z",
    updatedAt: "2026-09-30T00:00:00.000Z",
    intentHash: "auth-intent",
    origin: { workspaceId: "default", surface: "settings" },
    target: { ownerId: "runtime_settings", resourceId: "gateway_auth_configuration", expectedRevision: 41 },
    request: {
      kind: "runtime_configuration",
      change: {
        operation: "gateway_auth_configuration",
        mode: "token",
        allowLoopbackBypass: false,
        replaceCredential: true,
      },
    },
    requiredAction: {
      kind: "secure_input",
      actionId: "secure-action",
      actionNonce: "secure-nonce",
      targetId: "gateway-auth",
      title: "Enter token",
      expiresAt: "2099-01-01T00:00:00.000Z",
      fields: [{ fieldId: "token", required: true, label: "Token" }],
    },
  };
}
let plan: ChangePlanRecord, root: Root, hook: ReturnType<typeof useGatewayAuthContinuation>;
const refresh = vi.fn(async () => true);
let attempt: ReturnType<typeof useAuthAttempt>;
function Probe() {
  attempt = useAuthAttempt(key);
  hook = useGatewayAuthContinuation({
    key,
    attempt,
    change: { change: { plan, submitted, baseRevision: 41 }, refresh },
  });
  return null;
}
async function render(show = true) {
  await act(async () => root.render(show ? <Probe /> : null));
}
async function review() {
  act(() => hook.setCredential("synthetic-direct-secret"));
  act(() => hook.requestReview());
}
async function confirm() {
  await act(async () => hook.confirm());
}
beforeEach(async () => {
  vi.resetAllMocks();
  plan = initial();
  api.fetchChangePlan.mockImplementation(async () => structuredClone(plan));
  api.fetchSettings.mockResolvedValue({ revision: 41 });
  api.submitChangePlanGatewayAuthCredential.mockImplementation(async () => ({
    ...plan,
    revision: 3,
    status: "awaiting_confirmation",
    requiredAction: {
      kind: "confirmation",
      actionId: "confirm",
      actionNonce: "confirm-nonce",
      title: "Confirm",
      confirmationText: "Confirm auth",
    },
  }));
  api.confirmChangePlan.mockImplementation(async () => ({
    ...plan,
    revision: plan.revision + 1,
    status: "awaiting_approval",
    requiredAction: { kind: "approval", actionId: "approval", actionNonce: "approval-nonce" },
  }));
  root = createRoot(document.createElement("div"));
  await render();
});
afterEach(() => {
  act(() => root.unmount());
  __resetAuthAttemptsForTests();
});
describe("required Gateway authentication action", () => {
  it("submits a secure value only after review with exact plan/revision/action/nonce", async () => {
    await review();
    expect(api.submitChangePlanGatewayAuthCredential).not.toHaveBeenCalled();
    await confirm();
    expect(api.submitChangePlanGatewayAuthCredential).toHaveBeenCalledExactlyOnceWith(
      "auth-plan",
      { workspaceId: "default" },
      {
        expectedRevision: 2,
        actionId: "secure-action",
        actionNonce: "secure-nonce",
        credential: "synthetic-direct-secret",
      },
    );
    expect(refresh).toHaveBeenCalledOnce();
    expect(hook.credential).toBe("");
    expect(attempt).toBeUndefined();
  });
  it("routes an exact confirmation through the existing owner", async () => {
    plan = {
      ...plan,
      status: "awaiting_confirmation",
      requiredAction: {
        kind: "confirmation",
        actionId: "confirm",
        actionNonce: "confirm-nonce",
        title: "Confirm",
        confirmationText: "Confirm auth",
      },
    };
    await render();
    act(() => hook.requestReview());
    await confirm();
    expect(api.confirmChangePlan).toHaveBeenCalledExactlyOnceWith(
      "auth-plan",
      { workspaceId: "default" },
      { expectedRevision: 2, actionNonce: "confirm-nonce" },
    );
    expect(api.submitChangePlanGatewayAuthCredential).not.toHaveBeenCalled();
  });
  it.each(["expired", "foreign-target", "unsupported-field"])("withholds %s secure action", async (kind) => {
    const action = plan.requiredAction!;
    if (action.kind !== "secure_input") throw Error("fixture");
    plan = {
      ...plan,
      requiredAction: {
        ...action,
        ...(kind === "expired"
          ? { expiresAt: "2020-01-01" }
          : kind === "foreign-target"
            ? { targetId: "provider" }
            : { fields: [{ fieldId: "other", required: true, label: "Other" }] }),
      },
    };
    await render();
    await review();
    await confirm();
    expect(hook.action).toBeUndefined();
    expect(api.submitChangePlanGatewayAuthCredential).not.toHaveBeenCalled();
  });
  it.each(["plan-change", "settings-change", "unmount"])("cancels preflight for %s", async (kind) => {
    await review();
    let resolve!: (value: ChangePlanRecord) => void;
    api.fetchChangePlan.mockReturnValue(
      new Promise<ChangePlanRecord>((done) => {
        resolve = done;
      }),
    );
    let pending!: Promise<void>;
    await act(async () => {
      pending = hook.confirm();
    });
    if (kind === "settings-change") api.fetchSettings.mockResolvedValue({ revision: 42 });
    if (kind === "unmount") await render(false);
    await act(async () => {
      resolve(kind === "plan-change" ? { ...plan, revision: 3 } : plan);
      await pending;
    });
    expect(api.submitChangePlanGatewayAuthCredential).not.toHaveBeenCalled();
  });
  it("retains an unknown response lock after remount and clears transient secret", async () => {
    api.submitChangePlanGatewayAuthCredential.mockRejectedValue(new Error("lost response"));
    await review();
    await confirm();
    await render(false);
    await render();
    expect(attempt?.state).toBe("uncertain");
    expect(hook.credential).toBe("");
    await review();
    await confirm();
    expect(api.submitChangePlanGatewayAuthCredential).toHaveBeenCalledOnce();
  });
  it("withholds settlement for a substituted owner receipt", async () => {
    api.submitChangePlanGatewayAuthCredential.mockResolvedValue({
      ...plan,
      revision: 3,
      intentHash: "foreign-intent",
      requiredAction: undefined,
    });
    await review();
    await confirm();
    expect(attempt?.state).toBe("uncertain");
    expect(refresh).not.toHaveBeenCalled();
  });
});
