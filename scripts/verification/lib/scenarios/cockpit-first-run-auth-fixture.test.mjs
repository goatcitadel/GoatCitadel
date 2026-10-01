import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertFirstRunAuthFixture, setFirstRunFixtureAuthBypass } from "./cockpit-first-run-auth-fixture.mjs";

function fixture() {
  const before = {
    revision: 7,
    auth: {
      mode: "token",
      tokenConfigured: true,
      basicConfigured: false,
      allowLoopbackBypass: true,
      plan: { token: { source: "env", configured: true } },
    },
    llm: { activeProviderId: "fixture", activeModel: "fixture" },
    features: { evolutionControlPlaneV1Enabled: true },
  };
  const request = { expectedRevision: 7, allowLoopbackBypass: false };
  const after = { ...before, revision: 8, auth: { ...before.auth, allowLoopbackBypass: false } };
  const plan = {
    planId: "auth-plan",
    revision: 4,
    status: "completed",
    origin: { surface: "settings", workspaceId: "default" },
    scope: "runtime",
    kind: "runtime_configuration",
    adapter: { adapterId: "runtime-configuration", version: 2 },
    target: { ownerId: "runtime_settings", resourceId: "gateway_auth_configuration", expectedRevision: 7 },
    request: {
      kind: "runtime_configuration",
      change: { operation: "gateway_auth_configuration", mode: "token", allowLoopbackBypass: false },
    },
    result: { appliedRevision: 8 },
    appliedAt: "2026-09-30T00:00:00Z",
  };
  const receipt = {
    revision: 8,
    ...after.auth,
    changePlanReceipt: { planId: "auth-plan", revision: 4, status: "completed" },
  };
  return { before, request, receipt, authReceipt: { revision: 8, ...after.auth }, after, plan };
}

describe("advanced first-run real auth fixture", () => {
  it("uses the flat dedicated owner request and independently reads exact terminal governance", async () => {
    const value = fixture(),
      calls = [];
    let settingsRead = false,
      onboardingRead = false;
    const api = async (route, init) => {
      calls.push({ route, init });
      if (route === "/api/v1/auth/settings") return init ? value.receipt : value.authReceipt;
      if (route.startsWith("/api/v1/change-plans/")) return value.plan;
      if (route === "/api/v1/onboarding/state") {
        const revision = onboardingRead ? 8 : 7;
        onboardingRead = true;
        return {
          settings: { revision },
          completed: false,
          firstTask: {
            status: "not_observed",
            checkedAt: revision === 7 ? "2026-09-30T00:00:00Z" : "2026-09-30T00:01:00Z",
          },
        };
      }
      const current = settingsRead ? value.after : value.before;
      settingsRead = true;
      return current;
    };
    await setFirstRunFixtureAuthBypass(api, false);
    assert.deepEqual(calls, [
      { route: "/api/v1/settings", init: undefined },
      { route: "/api/v1/onboarding/state", init: undefined },
      { route: "/api/v1/auth/settings", init: { method: "PATCH", body: value.request } },
      { route: "/api/v1/change-plans/auth-plan?workspaceId=default", init: undefined },
      { route: "/api/v1/settings", init: undefined },
      { route: "/api/v1/auth/settings", init: undefined },
      { route: "/api/v1/onboarding/state", init: undefined },
    ]);
  });
  it("does not write when the actual requested posture is already present", async () => {
    const value = fixture(),
      calls = [];
    await setFirstRunFixtureAuthBypass(async (route) => {
      calls.push(route);
      return value.after;
    }, false);
    assert.deepEqual(calls, ["/api/v1/settings"]);
  });
  it("uses the exact real approval and continuation before accepting the independent auth read", async () => {
    const value = fixture();
    const initial = {
      ...structuredClone(value.plan),
      revision: 2,
      status: "awaiting_approval",
      intentHash: "intent",
      approvalRefs: ["auth-approval"],
      requiredAction: { kind: "approval", approvalId: "auth-approval", actionId: "continue", actionNonce: "nonce" },
    };
    delete initial.result;
    delete initial.appliedAt;
    const approved = { ...structuredClone(initial), revision: 3 };
    value.plan.approvalRefs = ["auth-approval"];
    const initialReceipt = {
      revision: 7,
      ...value.before.auth,
      changePlanReceipt: {
        planId: initial.planId,
        revision: 2,
        status: initial.status,
        requiredAction: initial.requiredAction,
      },
    };
    const approval = {
      approvalId: "auth-approval",
      kind: "change_plan_effect",
      status: "pending",
      linkage: { workspaceId: "default" },
      payload: {
        planId: initial.planId,
        kind: initial.kind,
        scope: initial.scope,
        intentHash: initial.intentHash,
        targetOwnerId: initial.target.ownerId,
        targetResourceId: initial.target.resourceId,
        targetRevision: initial.target.expectedRevision,
        adapterId: initial.adapter.adapterId,
        adapterVersion: initial.adapter.version,
      },
    };
    const calls = [];
    let resolved = false,
      applied = false;
    const api = async (route, init) => {
      calls.push({ route, init });
      if (route === "/api/v1/settings") return applied ? value.after : value.before;
      if (route === "/api/v1/onboarding/state") return { settings: { revision: applied ? 8 : 7 }, completed: false };
      if (route === "/api/v1/auth/settings") return init ? initialReceipt : value.authReceipt;
      if (route.endsWith("/replay")) return { approval };
      if (route.endsWith("/resolve")) {
        assert.equal(route, "/api/v1/approvals/auth-approval/resolve");
        assert.equal(init.method, "POST");
        assert.equal(init.body.decision, "approve");
        resolved = true;
        return { approval: { ...approval, status: "approved" } };
      }
      if (route.endsWith("/responses")) {
        assert.equal(resolved, true);
        assert.equal(applied, false);
        assert.equal(route, "/api/v1/change-plans/auth-plan/responses");
        assert.deepEqual(init, {
          method: "POST",
          body: { workspaceId: "default", expectedRevision: 3, actionId: "continue", actionNonce: "nonce", values: {} },
        });
        applied = true;
        return value.plan;
      }
      assert.equal(route, "/api/v1/change-plans/auth-plan?workspaceId=default");
      return applied ? value.plan : resolved ? approved : initial;
    };
    const result = await setFirstRunFixtureAuthBypass(api, false);
    assert.equal(result.receipt, initialReceipt);
    assert.equal(result.plan, value.plan);
    assert.equal(result.authReceipt, value.authReceipt);
    assert.equal(calls.filter((call) => call.init?.method === "POST").length, 2);
    assert.equal(calls.filter((call) => call.init?.method === "PATCH").length, 1);
    const foreignApproval = structuredClone(approval);
    foreignApproval.payload.targetResourceId = "other";
    let foreignWrites = 0;
    await assert.rejects(
      setFirstRunFixtureAuthBypass(async (route, init) => {
        if (init?.method === "POST") foreignWrites++;
        if (route === "/api/v1/settings") return value.before;
        if (route === "/api/v1/onboarding/state") return { settings: { revision: 7 } };
        if (route === "/api/v1/auth/settings") return initialReceipt;
        if (route.endsWith("/replay")) return { approval: foreignApproval };
        return initial;
      }, false),
    );
    assert.equal(foreignWrites, 0, "Foreign approval reached resolution or continuation.");
  });
  it("ignores only the retired NPU observation timestamp and retains every config/status field", () => {
    const value = fixture();
    value.before.npu = { enabled: false, status: { healthy: false, updatedAt: "2026-09-30T00:00:00Z" } };
    value.after.npu = { enabled: false, status: { healthy: false, updatedAt: "2026-09-30T00:01:00Z" } };
    assertFirstRunAuthFixture(value);
    for (const mutate of [
      (data) => {
        data.after.npu.enabled = true;
      },
      (data) => {
        data.after.npu.status.healthy = true;
      },
      (data) => {
        data.after.npu.status.updatedAt = "invalid";
      },
    ]) {
      const data = structuredClone(value);
      mutate(data);
      assert.throws(() => assertFirstRunAuthFixture(data));
    }
  });
  it("rejects unrelated settings/credentials, incomplete governance, and foreign plans", () => {
    assertFirstRunAuthFixture(fixture());
    for (const mutate of [
      (value) => {
        value.request.token = "replacement";
      },
      (value) => {
        value.after.llm = { ...value.after.llm, activeModel: "other" };
      },
      (value) => {
        value.receipt.tokenConfigured = false;
      },
      (value) => {
        value.plan.status = "awaiting_confirmation";
      },
      (value) => {
        value.plan.origin.workspaceId = "foreign";
      },
      (value) => {
        value.plan.origin.sessionId = "chat";
      },
      (value) => {
        value.plan.target.expectedRevision++;
      },
      (value) => {
        value.plan.request.change.replaceCredential = true;
      },
      (value) => {
        value.plan.result.appliedRevision++;
      },
      (value) => {
        delete value.receipt.changePlanReceipt;
      },
    ]) {
      const value = fixture();
      mutate(value);
      assert.throws(() => assertFirstRunAuthFixture(value));
    }
  });
});
