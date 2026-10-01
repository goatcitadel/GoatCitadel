import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChangePlanRecord } from "@goatcitadel/contracts";
import { confirmReviewedSettingsPlan, submitReviewedProviderCredential } from "./provider-connection-actions";

const api = vi.hoisted(() => ({ confirmChangePlan: vi.fn(), submitChangePlanProviderSecret: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);
const plan = {
  planId: "plan-a",
  revision: 2,
  kind: "provider_connection",
  status: "awaiting_confirmation",
  origin: { workspaceId: "default", surface: "settings" },
  request: { kind: "provider_connection", providerId: "provider-a" },
  target: { ownerId: "provider_connection", resourceId: "provider-a", expectedRevision: 3 },
  requiredAction: { kind: "confirmation", actionId: "action-a", actionNonce: "nonce-a" },
} as ChangePlanRecord;

beforeEach(() => vi.resetAllMocks());

describe("shared provider change actions", () => {
  it("confirms only the exact reviewed plan revision and nonce", async () => {
    api.confirmChangePlan.mockResolvedValue({ ...plan, revision: 3, status: "completed" });
    await confirmReviewedSettingsPlan(plan);
    expect(api.confirmChangePlan).toHaveBeenCalledWith(
      "plan-a",
      { workspaceId: "default", sessionId: undefined, turnId: undefined },
      { expectedRevision: 2, actionNonce: "nonce-a" },
    );
  });
  it.each(["workspace", "provider", "revision"])("rejects a %s response mismatch", async (field) => {
    api.confirmChangePlan.mockResolvedValue({
      ...plan,
      revision: field === "revision" ? 2 : 3,
      ...(field === "workspace" ? { origin: { ...plan.origin, workspaceId: "foreign" } } : {}),
      ...(field === "provider" ? { target: { ...plan.target, resourceId: "foreign" } } : {}),
    });
    await expect(confirmReviewedSettingsPlan(plan)).rejects.toThrow(/did not confirm/);
  });
  it("routes credential input only to the dedicated revision-bound secret API", async () => {
    const secure = {
      ...plan,
      requiredAction: {
        kind: "secure_input",
        targetId: "provider-a",
        actionId: "secret-action",
        actionNonce: "secret-nonce",
      },
    } as ChangePlanRecord;
    api.submitChangePlanProviderSecret.mockResolvedValue({ ...plan, revision: 3 });
    await submitReviewedProviderCredential(secure, "synthetic-test-credential");
    expect(api.submitChangePlanProviderSecret).toHaveBeenCalledWith(
      "plan-a",
      expect.objectContaining({ workspaceId: "default" }),
      {
        expectedRevision: 2,
        actionId: "secret-action",
        actionNonce: "secret-nonce",
        apiKey: "synthetic-test-credential",
      },
    );
    expect(api.confirmChangePlan).not.toHaveBeenCalled();
  });
  it("refuses foreign secure-input targets before sending the value", async () => {
    const secure = {
      ...plan,
      requiredAction: {
        kind: "secure_input",
        targetId: "foreign",
        actionId: "secret-action",
        actionNonce: "secret-nonce",
      },
    } as ChangePlanRecord;
    await expect(submitReviewedProviderCredential(secure, "synthetic-test-credential")).rejects.toThrow(
      /secure credential instructions/,
    );
    expect(api.submitChangePlanProviderSecret).not.toHaveBeenCalled();
  });
  it("accepts only the exact committed profile checkpoint when the target advances", async () => {
    const reviewed = {
      ...plan,
      intentHash: "a".repeat(64),
      request: {
        kind: "provider_connection" as const,
        providerId: "provider-a",
        profile: { label: "A" },
        credentialStorage: "env" as const,
        credentialEnvVar: "PROVIDER_A_KEY",
      },
    };
    const checkpoint = {
      version: "provider_profile_checkpoint.v1" as const,
      providerId: "provider-a",
      originalRevision: 3,
      appliedRevision: 4,
      intentHash: reviewed.intentHash,
    };
    const advanced = {
      ...reviewed,
      revision: 3,
      status: "awaiting_input",
      target: { ...reviewed.target, expectedRevision: 4 },
      result: { summary: "Profile committed", providerProfileCheckpoint: checkpoint },
      evidenceRefs: ["provider_profile:provider-a:settings_revision:4"],
    };
    api.confirmChangePlan.mockResolvedValue(advanced);
    await expect(confirmReviewedSettingsPlan(reviewed)).resolves.toMatchObject({ target: { expectedRevision: 4 } });
    for (const bad of [
      { ...advanced, result: undefined },
      { ...advanced, evidenceRefs: [] },
      { ...advanced, request: { ...reviewed.request, credentialStorage: "keychain" } },
      {
        ...advanced,
        result: { ...advanced.result, providerProfileCheckpoint: { ...checkpoint, originalRevision: 2 } },
      },
    ]) {
      api.confirmChangePlan.mockResolvedValue(bad);
      await expect(confirmReviewedSettingsPlan(reviewed)).rejects.toThrow(/did not confirm/);
    }
  });
});
