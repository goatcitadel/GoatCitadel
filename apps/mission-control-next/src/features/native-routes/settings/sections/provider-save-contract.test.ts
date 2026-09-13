import { describe, expect, it } from "vitest";
import { providerSaveInput, matchesProviderSave, matchesProviderSavePlan } from "./provider-save-contract";
import { buildProviderEditorDraft, createEmptyProviderEditorDraft } from "../../SettingsNativePage";
import { createEmptyLlmTransportDraft } from "@goatcitadel/mission-control-shared/components/LlmTransportFields";
import type { ChangePlanRecord } from "@goatcitadel/contracts";
import type { LlmRuntimeConfigResponse } from "@goatcitadel/mission-control-shared/api/client";
describe("provider save evidence", () => {
  const draft = { provider: { ...createEmptyProviderEditorDraft(), providerId: "fixture", baseUrl: "https://fixture.example/v1", label: "Fixture", defaultModel: "fixture-model", apiKeyEnv: "FIXTURE_API_KEY" }, transport: createEmptyLlmTransportDraft() };
  const input = providerSaveInput(draft);
  it("requires the exact provider profile and transport fields", () => {
    const config = { revision: 2, providerConfigs: [input] } as LlmRuntimeConfigResponse;
    expect(matchesProviderSave(config, draft)).toBe(true);
    expect(matchesProviderSave({ ...config, providerConfigs: [{ ...input, baseUrl: "https://other.example" }] } as LlmRuntimeConfigResponse, draft)).toBe(false);
    expect(matchesProviderSave({ ...config, providerConfigs: [] }, draft)).toBe(false);
    expect(buildProviderEditorDraft(input as Parameters<typeof buildProviderEditorDraft>[0]).apiKeyEnv).toBe("FIXTURE_API_KEY");
  });
  it("rejects a plan for a different provider or profile", () => {
    const { providerId, request: _request, ...profile } = input;
    const plan = { kind: "provider_connection", target: { ownerId: "provider_connection", resourceId: providerId }, request: { kind: "provider_connection", providerId, profile } } as unknown as ChangePlanRecord;
    expect(matchesProviderSavePlan(plan, draft)).toBe(true);
    expect(matchesProviderSavePlan({ ...plan, target: { ...plan.target, resourceId: "other" } }, draft)).toBe(false);
    expect(matchesProviderSavePlan({ ...plan, request: { kind: "provider_connection", providerId, profile: { ...profile, defaultModel: "other" } } }, draft)).toBe(false);
  });
});
