import { describe, expect, it } from "vitest";
import {
  providerSaveInput,
  matchesProviderSave,
  matchesProviderSavePlan,
  matchesProviderTargetRevision,
  providerProfilePlanRequest,
} from "./provider-save-contract";
import { buildProviderEditorDraft, createEmptyProviderEditorDraft } from "../../SettingsNativePage";
import { createEmptyLlmTransportDraft } from "@goatcitadel/mission-control-shared/components/LlmTransportFields";
import type { ChangePlanRecord } from "@goatcitadel/contracts";
import type { LlmRuntimeConfigResponse } from "@goatcitadel/mission-control-shared/api/client";

const basePlan: ChangePlanRecord = {
  schemaVersion: 1,
  planId: "provider-plan",
  origin: { workspaceId: "default", surface: "settings" },
  adapter: { adapterId: "provider-connection", version: 3 },
  kind: "provider_connection",
  scope: "provider",
  status: "awaiting_input",
  phase: "input",
  revision: 3,
  request: { kind: "provider_connection", providerId: "fixture" },
  intentHash: "a".repeat(64),
  target: { ownerId: "provider_connection", resourceId: "fixture", expectedRevision: 7 },
  title: "Create provider profile",
  summary: "Create profile",
  impact: "Adds the installation provider profile.",
  risk: "safe",
  approvalRefs: [],
  evidenceRefs: [],
  rollbackRefs: [],
  createdAt: "2026-09-30T12:00:00.000Z",
  updatedAt: "2026-09-30T12:01:00.000Z",
};
describe("provider save evidence", () => {
  const draft = {
    provider: {
      ...createEmptyProviderEditorDraft(),
      providerId: "fixture",
      baseUrl: "https://fixture.example/v1",
      label: "Fixture",
      defaultModel: "fixture-model",
      apiKeyEnv: "FIXTURE_API_KEY",
    },
    transport: createEmptyLlmTransportDraft(),
  };
  const input = providerSaveInput(draft);
  it("requires the exact provider profile and transport fields", () => {
    const config = { revision: 2, providerConfigs: [input] } as LlmRuntimeConfigResponse;
    expect(matchesProviderSave(config, draft)).toBe(true);
    expect(
      matchesProviderSave(
        { ...config, providerConfigs: [{ ...input, baseUrl: "https://other.example" }] } as LlmRuntimeConfigResponse,
        draft,
      ),
    ).toBe(false);
    expect(matchesProviderSave({ ...config, providerConfigs: [] }, draft)).toBe(false);
    expect(buildProviderEditorDraft(input as Parameters<typeof buildProviderEditorDraft>[0]).apiKeyEnv).toBe(
      "FIXTURE_API_KEY",
    );
  });
  it("rejects a plan for a different provider or profile", () => {
    const { providerId, request: _request, ...profile } = input;
    const plan: ChangePlanRecord = {
      ...basePlan,
      kind: "provider_connection",
      target: { ownerId: "provider_connection", resourceId: providerId },
      request: { kind: "provider_connection", providerId, profile },
    };
    expect(matchesProviderSavePlan(plan, draft)).toBe(true);
    expect(matchesProviderSavePlan({ ...plan, target: { ...plan.target, resourceId: "other" } }, draft)).toBe(false);
    expect(
      matchesProviderSavePlan(
        {
          ...plan,
          request: { kind: "provider_connection", providerId, profile: { ...profile, defaultModel: "other" } },
        },
        draft,
      ),
    ).toBe(false);
  });
  it("binds advanced target revisions only to the exact acknowledged profile and original review", () => {
    const reviewed = { ...draft, governedCreation: true, credentialStorage: "env" as const };
    const request = providerProfilePlanRequest(reviewed);
    const checkpoint = {
      version: "provider_profile_checkpoint.v1" as const,
      providerId: "fixture",
      originalRevision: 7,
      appliedRevision: 8,
      intentHash: "a".repeat(64),
    };
    const plan: ChangePlanRecord = {
      ...basePlan,
      kind: "provider_connection",
      request,
      intentHash: checkpoint.intentHash,
      origin: { workspaceId: "default", surface: "settings" },
      target: { ownerId: "provider_connection", resourceId: "fixture", expectedRevision: 8 },
      result: { summary: "Committed profile", providerProfileCheckpoint: checkpoint },
      evidenceRefs: ["provider_profile:fixture:settings_revision:8"],
    };
    expect(matchesProviderTargetRevision(plan, reviewed, 7)).toBe(true);
    for (const bad of [
      { ...plan, result: undefined },
      { ...plan, evidenceRefs: [] },
      { ...plan, intentHash: "b".repeat(64) },
      { ...plan, origin: { ...plan.origin, sessionId: "foreign" } },
      { ...plan, request: { ...request, credentialStorage: "keychain" as const } },
      { ...plan, result: { ...plan.result!, providerProfileCheckpoint: { ...checkpoint, originalRevision: 6 } } },
    ])
      expect(matchesProviderTargetRevision(bad, reviewed, 7)).toBe(false);
    expect(providerProfilePlanRequest({ ...reviewed, credentialStorage: "keychain" }).credentialEnvVar).toBeUndefined();
    expect(() =>
      providerProfilePlanRequest({ ...reviewed, provider: { ...reviewed.provider, apiKeyEnv: "" } }),
    ).toThrow(/environment variable/);
  });
});
