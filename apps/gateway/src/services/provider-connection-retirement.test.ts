import { describe, expect, it, vi } from "vitest";
import type { ChangePlanRecord } from "@goatcitadel/contracts";
import {
  ProviderConnectionChangePlanAdapter,
  type ProviderConnectionChangePlanAdapterDependencies,
} from "./provider-connection-change-plan-adapter.js";
import type { EvolutionControlPlaneAdapterContext } from "./evolution-control-plane-adapter.js";

const plan: ChangePlanRecord = {
  schemaVersion: 1,
  planId: "plan-retirement",
  origin: { surface: "settings", workspaceId: "default" },
  adapter: { adapterId: "provider-connection", version: 5 },
  kind: "provider_connection",
  scope: "provider",
  status: "verifying",
  phase: "validation",
  revision: 4,
  request: { kind: "provider_connection", providerId: "fixture-provider" },
  intentHash: "a".repeat(64),
  target: { ownerId: "provider_connection", resourceId: "fixture-provider", expectedRevision: 7 },
  title: "Verify fixture provider",
  summary: "Credential promotion was acknowledged.",
  impact: "Verify the live provider before retiring staged credentials.",
  risk: "safe",
  approvalRefs: [],
  evidenceRefs: ["fixture:promotion"],
  rollbackRefs: [],
  result: { summary: "Credential promotion was acknowledged.", appliedRevision: 8 },
  createdAt: "2026-09-30T00:00:00.000Z",
  updatedAt: "2026-09-30T00:01:00.000Z",
};
const context: EvolutionControlPlaneAdapterContext = {
  origin: plan.origin,
  actions: {
    confirmation: vi.fn(),
    publicForm: vi.fn(),
    secureInput: vi.fn(),
    oauth: vi.fn(),
    nativePathPicker: vi.fn(),
    approval: vi.fn(),
    artifactReview: vi.fn(),
  },
};
function fixture() {
  const order: string[] = [];
  const verifyProvider = vi.fn(async () => {
    order.push("verify");
    return { evidenceRefs: ["fixture:live-catalog"] };
  });
  const discardTemporarySecret = vi.fn(async () => {
    order.push("retire-key");
  });
  const discardTemporaryOAuthCredential = vi.fn(async () => {
    order.push("retire-oauth");
  });
  const promoteTemporarySecret = vi.fn();
  const promoteTemporaryOAuthCredential = vi.fn();
  const dependencies: ProviderConnectionChangePlanAdapterDependencies = {
    getSettings: vi.fn(),
    updateSettings: vi.fn(),
    hasTemporarySecret: vi.fn(),
    promoteTemporarySecret,
    promoteTemporaryOAuthCredential,
    removeProviderApiKey: vi.fn(),
    getProviderApiKeyStatus: vi.fn(() => ({ hasSecret: true, source: "keychain" })),
    verifyProvider,
    discardTemporarySecret,
    discardTemporaryOAuthCredential,
  };
  return {
    adapter: new ProviderConnectionChangePlanAdapter(dependencies),
    order,
    verifyProvider,
    discardTemporarySecret,
    discardTemporaryOAuthCredential,
    promoteTemporarySecret,
    promoteTemporaryOAuthCredential,
  };
}

describe("provider verification and staged credential retirement", () => {
  for (const method of ["verify", "reconcile"] as const) {
    it(`${method} verifies before retiring both staged owners without replaying promotion`, async () => {
      const f = fixture();
      const result = await f.adapter[method](context, plan);
      expect(f.order).toEqual(["verify", "retire-key", "retire-oauth"]);
      expect(f.verifyProvider).toHaveBeenCalledExactlyOnceWith("fixture-provider");
      expect(f.discardTemporarySecret).toHaveBeenCalledExactlyOnceWith(plan.planId, "fixture-provider");
      expect(f.discardTemporaryOAuthCredential).toHaveBeenCalledExactlyOnceWith(plan.planId, "fixture-provider");
      expect(f.promoteTemporarySecret).not.toHaveBeenCalled();
      expect(f.promoteTemporaryOAuthCredential).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        status: "completed",
        evidenceRefs: ["fixture:live-catalog"],
        result: plan.result,
      });
      if (method === "reconcile") expect(result).toHaveProperty("effectObserved", true);
    });

    it(`${method} keeps staged custody when live verification fails`, async () => {
      const f = fixture();
      f.verifyProvider.mockRejectedValueOnce(new Error("Provider is unavailable"));
      const result = await f.adapter[method](context, plan);
      expect(result).toMatchObject({
        status: "manual_required",
        result: {
          failureCode: method === "verify" ? "provider_verification_failed" : "ambiguous_recovery",
        },
      });
      expect(f.discardTemporarySecret).not.toHaveBeenCalled();
      expect(f.discardTemporaryOAuthCredential).not.toHaveBeenCalled();
      expect(f.promoteTemporarySecret).not.toHaveBeenCalled();
      expect(f.promoteTemporaryOAuthCredential).not.toHaveBeenCalled();
      if (method === "reconcile") expect(result).toHaveProperty("effectObserved", false);
    });

    for (const owner of ["api-key", "oauth"] as const) {
      it(`${method} does not claim completion when ${owner} retirement fails`, async () => {
        const f = fixture();
        const failedOwner = owner === "api-key" ? f.discardTemporarySecret : f.discardTemporaryOAuthCredential;
        failedOwner.mockRejectedValueOnce(new Error("Temporary credential owner failed"));
        const result = await f.adapter[method](context, plan);
        expect(result).toMatchObject({
          status: "manual_required",
          result: {
            failureCode: method === "verify" ? "provider_verification_failed" : "ambiguous_recovery",
          },
        });
        expect(f.verifyProvider).toHaveBeenCalledOnce();
        expect(f.discardTemporarySecret).toHaveBeenCalledOnce();
        if (owner === "api-key") expect(f.discardTemporaryOAuthCredential).not.toHaveBeenCalled();
        else expect(f.discardTemporaryOAuthCredential).toHaveBeenCalledOnce();
        if (method === "reconcile") expect(result).toHaveProperty("effectObserved", false);
      });
    }
  }

  it("explicit discard retires temporary custody without a verification or promotion", async () => {
    const f = fixture();
    await f.adapter.discard(context, plan);
    expect(f.order).toEqual(["retire-key", "retire-oauth"]);
    expect(f.verifyProvider).not.toHaveBeenCalled();
    expect(f.promoteTemporarySecret).not.toHaveBeenCalled();
    expect(f.promoteTemporaryOAuthCredential).not.toHaveBeenCalled();
  });

  it("explicit discard propagates custody failure without claiming success", async () => {
    const f = fixture();
    f.discardTemporarySecret.mockRejectedValueOnce(new Error("Temporary credential owner failed"));
    await expect(f.adapter.discard(context, plan)).rejects.toThrow("Temporary credential owner failed");
    expect(f.discardTemporaryOAuthCredential).not.toHaveBeenCalled();
  });
});
