import { describe, expect, it } from "vitest";
import {
  CHANGE_PLAN_KINDS,
  changePlanPhaseForStatus,
  changePlanScopeForKind,
  isChangePlanKind,
  isChangePlanRequest,
  isChangePlanResult,
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
      "capability_pack",
      "connector_install",
      "plugin_install",
      "plugin_uninstall",
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
    expect(changePlanScopeForKind("capability_pack")).toBe("capability");
    expect(changePlanScopeForKind("connector_install")).toBe("capability");
    expect(changePlanScopeForKind("plugin_install")).toBe("capability");
    expect(changePlanScopeForKind("plugin_uninstall")).toBe("capability");
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
    for (const enabled of [true, false]) {
      expect(
        isChangePlanRequest({
          kind: "runtime_configuration",
          change: { operation: "feature_flag", flag: "claudeCliToolBridgeEnabled", enabled },
        }),
      ).toBe(true);
    }
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

  it("accepts only bounded operator write-root and curated tool-posture intents", () => {
    const runtime = (change: Record<string, unknown>) => isChangePlanRequest({ kind: "runtime_configuration", change });
    expect(runtime({ operation: "operator_write_root", action: "add", path: "D:\\scratch\\out" })).toBe(true);
    expect(runtime({ operation: "operator_write_root", action: "add", path: "\\\\host\\share\\out" })).toBe(true);
    expect(
      runtime({
        operation: "operator_write_root",
        action: "add",
        path: "/srv/scratch",
        allowDelete: true,
        label: "Out",
      }),
    ).toBe(true);
    expect(runtime({ operation: "operator_write_root", action: "add", preset: "os_temp" })).toBe(true);
    expect(runtime({ operation: "operator_write_root", action: "remove", preset: "os_temp" })).toBe(true);

    expect(runtime({ operation: "operator_write_root", action: "add" })).toBe(false);
    expect(runtime({ operation: "operator_write_root", action: "add", path: "/srv", preset: "os_temp" })).toBe(false);
    expect(runtime({ operation: "operator_write_root", action: "add", path: "relative/dir" })).toBe(false);
    expect(runtime({ operation: "operator_write_root", action: "add", path: "/srv/a\nb" })).toBe(false);
    expect(runtime({ operation: "operator_write_root", action: "add", path: `/${"a".repeat(1_024)}` })).toBe(false);
    expect(runtime({ operation: "operator_write_root", action: "add", preset: "home" })).toBe(false);
    expect(runtime({ operation: "operator_write_root", action: "remove", path: "/srv", allowDelete: true })).toBe(
      false,
    );
    expect(runtime({ operation: "operator_write_root", action: "rename", path: "/srv" })).toBe(false);
    expect(runtime({ operation: "operator_write_root", action: "add", path: "/srv", extra: true })).toBe(false);

    expect(runtime({ operation: "tool_global_access", toolName: "fs.delete", posture: "available" })).toBe(true);
    expect(runtime({ operation: "tool_global_access", toolName: "fs.patch", posture: "unlisted" })).toBe(true);
    expect(runtime({ operation: "tool_global_access", toolName: "shell.exec", posture: "available" })).toBe(false);
    expect(runtime({ operation: "tool_global_access", toolName: "fs.*", posture: "denied" })).toBe(false);
    expect(runtime({ operation: "tool_global_access", toolName: "fs.write", posture: "allowed" })).toBe(false);

    expect(runtime({ operation: "tool_group_access", groupId: "files", enabled: false })).toBe(true);
    expect(runtime({ operation: "tool_group_access", groupId: "messaging", enabled: true })).toBe(true);
    expect(runtime({ operation: "tool_group_access", groupId: "core", enabled: false })).toBe(false);
    expect(runtime({ operation: "tool_group_access", groupId: "nope", enabled: false })).toBe(false);
    expect(runtime({ operation: "tool_group_access", groupId: "files", enabled: "off" })).toBe(false);
    expect(runtime({ operation: "tool_group_access", groupId: "files" })).toBe(false);
    expect(runtime({ operation: "tool_group_access", groupId: "files", enabled: false, extra: true })).toBe(false);

    expect(runtime({ operation: "outside_root_write_policy", mode: "approval_required" })).toBe(true);
    expect(runtime({ operation: "outside_root_write_policy", mode: "deny" })).toBe(true);
    expect(runtime({ operation: "outside_root_write_policy", mode: "full_disk" })).toBe(false);
    expect(runtime({ operation: "outside_root_write_policy", mode: "deny", extra: true })).toBe(false);
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

  // R79: the owner's own error text travels beside the plain summary, bounded, for technical details only.
  it("accepts a bounded failure detail beside the summary", () => {
    const result = {
      summary: "Couldn't save Example. Trying again is safe.",
      failureCode: "connector_install_save_failed",
    };
    expect(isChangePlanResult(result)).toBe(true);
    expect(isChangePlanResult({ ...result, failureDetail: "MCP configuration changed." })).toBe(true);
    expect(isChangePlanResult({ ...result, failureDetail: "x".repeat(300) })).toBe(true);

    expect(isChangePlanResult({ ...result, failureDetail: "x".repeat(301) })).toBe(false);
    expect(isChangePlanResult({ ...result, failureDetail: 42 })).toBe(false);
    expect(isChangePlanResult({ ...result, failureDetail: "" })).toBe(false);
    expect(isChangePlanResult({ ...result, failureDetail: "bad\0byte" })).toBe(false);
    expect(isChangePlanResult({ ...result, failureMessage: "not a known field" })).toBe(false);
  });

  it("accepts a connector install only as a template id and the Chat choice", () => {
    const install = (value: Record<string, unknown>) => isChangePlanRequest({ kind: "connector_install", ...value });
    expect(install({ templateId: "linear", enableChatConnectors: true })).toBe(true);
    expect(install({ templateId: "context7", enableChatConnectors: false })).toBe(true);

    expect(install({ templateId: "linear" })).toBe(false);
    expect(install({ enableChatConnectors: true })).toBe(false);
    expect(install({ templateId: "linear", enableChatConnectors: "yes" })).toBe(false);
    expect(install({ templateId: "C:/templates/linear", enableChatConnectors: true })).toBe(false);
    expect(install({ templateId: "../linear", enableChatConnectors: true })).toBe(false);
    expect(install({ templateId: "linear", enableChatConnectors: true, url: "https://example.test/mcp" })).toBe(false);
    expect(
      install({ templateId: "linear", enableChatConnectors: true, policy: { approvalPosture: "nothing_asks" } }),
    ).toBe(false);
  });

  describe("plugin install and uninstall requests", () => {
    const hashA = "a".repeat(64);
    const hashB = "0123456789abcdef".repeat(4);
    const ref = (uuid = "123e4567-e89b-42d3-a456-426614174000") => `keychain:goatcitadel:hook:${uuid}`;
    const install = (overrides: Record<string, unknown> = {}) => ({
      kind: "plugin_install",
      inspectionId: "inspection-1",
      manifestSha256: hashA,
      snapshotTreeSha256: hashB,
      workspaceId: "default",
      ...overrides,
    });
    const uninstall = (overrides: Record<string, unknown> = {}) => ({
      kind: "plugin_uninstall",
      pluginId: "acme-helper",
      installPlanId: "plan-1",
      ...overrides,
    });
    const without = (value: Record<string, unknown>, key: string) =>
      Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
    const refsOfSize = (count: number) =>
      Object.fromEntries(
        Array.from({ length: count }, (_, index) => [
          `hook-${index}`,
          ref(`123e4567-e89b-42d3-a456-${String(index).padStart(12, "0")}`),
        ]),
      );

    it.each([
      ["an install without hooks", install()],
      ["an install with one hook secret ref", install({ hookSecretRefs: { "audit-hook": ref() } })],
      ["an install with the most hook secret refs", install({ hookSecretRefs: refsOfSize(32) })],
      ["an install with a one-character piece id", install({ hookSecretRefs: { a: ref() } })],
      ["an uninstall", uninstall()],
      ["an uninstall of a two-character plugin id", uninstall({ pluginId: "ab" })],
      ["an uninstall of the longest plugin id", uninstall({ pluginId: `a${"b".repeat(47)}` })],
    ])("accepts %s", (_name, request) => {
      expect(isChangePlanRequest(request)).toBe(true);
    });

    it.each([
      ["an install with no manifest hash", without(install(), "manifestSha256")],
      ["an install with no tree hash", without(install(), "snapshotTreeSha256")],
      ["an install with no inspection id", without(install(), "inspectionId")],
      ["an install with no workspace id", without(install(), "workspaceId")],
      ["an install with an uppercase manifest hash", install({ manifestSha256: "A".repeat(64) })],
      ["an install with an uppercase tree hash", install({ snapshotTreeSha256: hashB.toUpperCase() })],
      ["an install with a short manifest hash", install({ manifestSha256: "a".repeat(63) })],
      ["an install with a long tree hash", install({ snapshotTreeSha256: "a".repeat(65) })],
      ["an install with a non-hex hash", install({ manifestSha256: "g".repeat(64) })],
      ["an install with a hash that is not text", install({ manifestSha256: 42 })],
      ["an install with an extra field", install({ sourceUrl: "https://example.test/plugin.git" })],
      ["an install with a policy field", install({ policy: { approvalPosture: "nothing_asks" } })],
      ["an install with a path as the inspection id", install({ inspectionId: "C:/plugins/acme" })],
      ["an install with a dotted inspection id", install({ inspectionId: "../acme" })],
      ["an install with a path as the workspace id", install({ workspaceId: "../default" })],
      ["an install with hook secret refs that are null", install({ hookSecretRefs: null })],
      ["an install with hook secret refs as a list", install({ hookSecretRefs: [ref()] })],
      ["an install with an empty hook secret refs object", install({ hookSecretRefs: {} })],
      ["an install with 33 hook secret refs", install({ hookSecretRefs: refsOfSize(33) })],
      [
        "an install with a raw secret where a ref belongs",
        install({ hookSecretRefs: { "audit-hook": "whsec_live_0123456789abcdef" } }),
      ],
      [
        "an install with a key-store ref for a different namespace",
        install({
          hookSecretRefs: { "audit-hook": "keychain:goatcitadel:provider:123e4567-e89b-42d3-a456-426614174000" },
        }),
      ],
      [
        "an install with a ref that has no id",
        install({ hookSecretRefs: { "audit-hook": "keychain:goatcitadel:hook:" } }),
      ],
      [
        "an install with an uppercase ref id",
        install({ hookSecretRefs: { "audit-hook": ref("123E4567-E89B-42D3-A456-426614174000") } }),
      ],
      ["an install with a ref id that is not a uuid", install({ hookSecretRefs: { "audit-hook": ref("not-a-uuid") } })],
      ["an install with a ref that has trailing text", install({ hookSecretRefs: { "audit-hook": `${ref()} extra` } })],
      ["an install with a ref that is not text", install({ hookSecretRefs: { "audit-hook": 42 } })],
      ["an install with an uppercase piece id key", install({ hookSecretRefs: { "Audit-Hook": ref() } })],
      ["an install with an underscore piece id key", install({ hookSecretRefs: { audit_hook: ref() } })],
      ["an install with an empty piece id key", install({ hookSecretRefs: { "": ref() } })],
      ["an install with a 49-character piece id key", install({ hookSecretRefs: { [`a${"b".repeat(48)}`]: ref() } })],
      [
        "an install with a hook secret refs object holding a raw value field",
        install({ hookSecretRefs: { "audit-hook": { value: "secret" } } }),
      ],
      ["an uninstall with no plugin id", without(uninstall(), "pluginId")],
      ["an uninstall with no install plan id", without(uninstall(), "installPlanId")],
      ["an uninstall with an extra field", uninstall({ removeFiles: true })],
      ["an uninstall with an uppercase plugin id", uninstall({ pluginId: "Acme-Helper" })],
      ["an uninstall with a one-character plugin id", uninstall({ pluginId: "a" })],
      ["an uninstall with a 49-character plugin id", uninstall({ pluginId: `a${"b".repeat(48)}` })],
      ["an uninstall with a plugin id that starts with a hyphen", uninstall({ pluginId: "-acme" })],
      ["an uninstall with an underscore plugin id", uninstall({ pluginId: "acme_helper" })],
      ["an uninstall with a path as the plugin id", uninstall({ pluginId: "../acme" })],
      ["an uninstall with a path as the install plan id", uninstall({ installPlanId: "C:/plans/1" })],
      ["an uninstall with a dotted install plan id", uninstall({ installPlanId: "plan..1" })],
      ["an uninstall with an install plan id that is not text", uninstall({ installPlanId: 7 })],
      ["an uninstall that carries install fields", uninstall({ manifestSha256: hashA })],
    ])("rejects %s", (_name, request) => {
      expect(isChangePlanRequest(request)).toBe(false);
    });

    it("keeps the install request to ids, hashes and refs, never a source or a secret value", () => {
      const request = install({ hookSecretRefs: { "audit-hook": ref() } });
      expect(Object.keys(request).sort()).toEqual([
        "hookSecretRefs",
        "inspectionId",
        "kind",
        "manifestSha256",
        "snapshotTreeSha256",
        "workspaceId",
      ]);
      expect(isChangePlanRequest(request)).toBe(true);
    });
  });

  it("accepts the public web address operation as a string to set or null to clear", () => {
    const publicWebAddress = (config: unknown, extra: Record<string, unknown> = {}) =>
      isChangePlanRequest({
        kind: "runtime_configuration",
        change: { operation: "public_web_address_configuration", config, ...extra },
      });
    expect(publicWebAddress({ publicWebAddress: "https://example.com" })).toBe(true);
    expect(publicWebAddress({ publicWebAddress: null })).toBe(true);

    expect(publicWebAddress({})).toBe(false);
    expect(publicWebAddress(null)).toBe(false);
    expect(publicWebAddress({ publicWebAddress: undefined })).toBe(false);
    expect(publicWebAddress({ publicWebAddress: 42 })).toBe(false);
    expect(publicWebAddress({ publicWebAddress: "" })).toBe(false);
    expect(publicWebAddress({ publicWebAddress: "x".repeat(401) })).toBe(false);
    expect(publicWebAddress({ publicWebAddress: "bad\0byte" })).toBe(false);
    expect(publicWebAddress({ publicWebAddress: "https://example.com", baseUrl: "https://example.com" })).toBe(false);
    expect(publicWebAddress({ publicWebAddress: "https://example.com" }, { enabled: true })).toBe(false);
    expect(
      isChangePlanRequest({
        kind: "runtime_configuration",
        change: { operation: "public_web_address_configuration", publicWebAddress: "https://example.com" },
      }),
    ).toBe(false);
  });
});
