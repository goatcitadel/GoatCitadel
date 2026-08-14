import { describe, expect, it } from "vitest";
import {
  CHANGE_PLAN_KINDS,
  changePlanPhaseForStatus,
  changePlanScopeForKind,
  isChangePlanKind,
  isChangePlanRequest,
  isChangePlanStatus,
} from "./change-plan.js";

describe("Evolution Control Plane Change Plan contract", () => {
  it("keeps model-requested evolution to the frozen allowlist", () => {
    expect(CHANGE_PLAN_KINDS).toEqual([
      "session_model",
      "installation_default_model",
      "provider_connection",
      "runtime_configuration",
      "channel_connection",
      "runtime_remediation",
      "capability_candidate",
      "improvement_candidate",
      "managed_source_registration",
      "product_source_update",
    ]);
    expect(isChangePlanKind("arbitrary_settings")).toBe(false);
    expect(isChangePlanStatus("awaiting_confirmation")).toBe(true);
    expect(isChangePlanStatus("running_shell_command")).toBe(false);
  });

  it("maps every kind and lifecycle status to explicit scope and phase", () => {
    expect(changePlanScopeForKind("session_model")).toBe("current_chat");
    expect(changePlanScopeForKind("installation_default_model")).toBe("installation");
    expect(changePlanScopeForKind("provider_connection")).toBe("provider");
    expect(changePlanScopeForKind("runtime_configuration")).toBe("runtime");
    expect(changePlanScopeForKind("channel_connection")).toBe("channel");
    expect(changePlanScopeForKind("runtime_remediation")).toBe("remediation");
    expect(changePlanScopeForKind("capability_candidate")).toBe("capability");
    expect(changePlanScopeForKind("improvement_candidate")).toBe("improvement");
    expect(changePlanScopeForKind("managed_source_registration")).toBe("product_source");
    expect(changePlanScopeForKind("product_source_update")).toBe("product_source");
    expect(changePlanPhaseForStatus("awaiting_approval")).toBe("authorization");
    expect(changePlanPhaseForStatus("rolling_back")).toBe("recovery");
    expect(changePlanPhaseForStatus("completed")).toBe("terminal");
  });

  it("accepts only bounded typed intents", () => {
    expect(isChangePlanRequest({ kind: "session_model", model: "gpt-5.5", thinkingLevel: "extended" })).toBe(true);
    expect(
      isChangePlanRequest({
        kind: "installation_default_model",
        providerId: "openai",
        model: "gpt-5.5",
        thinkingLevel: "deep",
      }),
    ).toBe(true);
    expect(
      isChangePlanRequest({ kind: "runtime_configuration", change: { operation: "budget_mode", mode: "balanced" } }),
    ).toBe(true);
    expect(
      isChangePlanRequest({
        kind: "runtime_configuration",
        change: {
          operation: "memory_configuration",
          config: { enabled: true, qmdMaxContextTokens: 8_192 },
        },
      }),
    ).toBe(true);
    expect(
      isChangePlanRequest({
        kind: "runtime_configuration",
        change: { operation: "network_allowlist", entries: ["api.openai.com", "127.0.0.1"] },
      }),
    ).toBe(true);
    expect(
      isChangePlanRequest({
        kind: "runtime_configuration",
        change: { operation: "feature_flag", flag: "codeModeV1Enabled", enabled: true },
      }),
    ).toBe(true);
    expect(isChangePlanRequest({ kind: "managed_source_registration" })).toBe(true);
    expect(
      isChangePlanRequest({
        kind: "provider_connection",
        providerId: "compatible",
        profile: {
          label: "Compatible",
          baseUrl: "https://models.example.test/v1",
          apiStyle: "openai-responses",
          authMode: "api-key",
          defaultModel: "model-1",
          apiKeyEnv: "COMPATIBLE_API_KEY",
        },
      }),
    ).toBe(true);
    expect(
      isChangePlanRequest({
        kind: "provider_connection",
        providerId: "compatible",
        credentialAction: "replace_api_key",
        credentialStorage: "env",
        credentialEnvVar: "COMPATIBLE_API_KEY",
      }),
    ).toBe(true);
    expect(
      isChangePlanRequest({
        kind: "provider_connection",
        providerId: "openai-codex",
        credentialAction: "replace_oauth",
      }),
    ).toBe(true);
    expect(
      isChangePlanRequest({
        kind: "provider_connection",
        providerId: "openai-codex",
        credentialAction: "remove_oauth",
      }),
    ).toBe(true);
    expect(
      isChangePlanRequest({
        kind: "product_source_update",
        sourceInstallId: "goatcitadel-source-1",
        changeSummary: "Add the reviewed status badge to Change Plan receipts.",
        codeModeRunId: "code-run-1",
      }),
    ).toBe(true);
    expect(isChangePlanRequest({ kind: "session_model", rawSettings: { apiKey: "nope" } })).toBe(false);
    expect(isChangePlanRequest({ kind: "runtime_configuration", change: { operation: "raw", key: "anything" } })).toBe(
      false,
    );
  });

  it("rejects credentials, paths, patches, and extra fields from persisted intent", () => {
    expect(isChangePlanRequest({ kind: "provider_connection", providerId: "openai", apiKey: "secret" })).toBe(false);
    expect(
      isChangePlanRequest({
        kind: "provider_connection",
        providerId: "openai",
        profile: { baseUrl: "https://operator:secret@example.test/v1" },
      }),
    ).toBe(false);
    expect(
      isChangePlanRequest({
        kind: "provider_connection",
        providerId: "openai",
        profile: { apiKey: "secret" },
      }),
    ).toBe(false);
    expect(
      isChangePlanRequest({
        kind: "provider_connection",
        providerId: "openai",
        credentialAction: "remove_api_key",
        credentialStorage: "keychain",
      }),
    ).toBe(false);
    expect(
      isChangePlanRequest({
        kind: "provider_connection",
        providerId: "openai-codex",
        credentialAction: "replace_oauth",
        profile: { label: "unexpected mutation" },
      }),
    ).toBe(false);
    expect(
      isChangePlanRequest({
        kind: "provider_connection",
        providerId: "openai-codex",
        credentialAction: "remove_oauth",
        profile: { label: "unexpected mutation" },
      }),
    ).toBe(false);
    expect(isChangePlanRequest({ kind: "managed_source_registration", path: "C:/repo" })).toBe(false);
    expect(isChangePlanRequest({ kind: "product_source_update", sourceInstallId: "C:/unsafe/path" })).toBe(false);
    expect(
      isChangePlanRequest({ kind: "product_source_update", sourceInstallId: "goatcitadel-source-1", patch: "diff" }),
    ).toBe(false);
    expect(
      isChangePlanRequest({
        kind: "runtime_configuration",
        change: { operation: "llama_cpp_configuration", config: { modelPath: "C:/models/private.gguf" } },
      }),
    ).toBe(false);
    expect(
      isChangePlanRequest({
        kind: "runtime_configuration",
        change: { operation: "web_firecrawl_configuration", config: { baseUrl: "https://user:secret@example.test" } },
      }),
    ).toBe(false);
    expect(
      isChangePlanRequest({
        kind: "product_source_update",
        sourceInstallId: "goatcitadel-source-1",
        changeSummary: "diff --git a/a.ts b/a.ts",
        codeModeRunId: "code-run-1",
      }),
    ).toBe(false);
  });
});
