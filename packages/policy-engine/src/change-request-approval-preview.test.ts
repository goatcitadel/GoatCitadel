import { describe, expect, it } from "vitest";
import type { ToolInvokeRequest } from "@goatcitadel/contracts";
import { changeRequestApprovalPreview } from "./change-request-approval-preview.js";

function request(args: Record<string, unknown>, toolName = "change.request"): ToolInvokeRequest {
  return { toolName, args, agentId: "assistant", sessionId: "session-1", taskId: "task-1" } as ToolInvokeRequest;
}

describe("change.request approval preview", () => {
  it("lists every requested intent field as a labelled line", () => {
    expect(
      changeRequestApprovalPreview(request({ intent: { kind: "provider_connection", providerId: "google" } })),
    ).toEqual({
      reviewKind: "change.request",
      toolName: "change.request",
      sessionId: "session-1",
      taskId: "task-1",
      requestSummary: [
        { label: "Kind", value: "provider_connection" },
        { label: "Provider id", value: "google" },
      ],
    });
  });

  it("flattens nested changes and joins list values", () => {
    const preview = changeRequestApprovalPreview(
      request({
        intent: {
          kind: "runtime_configuration",
          change: { operation: "network_allowlist", entries: ["api.example.com", "docs.example.com"] },
        },
      }),
    );
    expect(preview?.requestSummary).toEqual([
      { label: "Kind", value: "runtime_configuration" },
      { label: "Change operation", value: "network_allowlist" },
      { label: "Change entries", value: "api.example.com, docs.example.com" },
    ]);
  });

  it("redacts secret-looking fields", () => {
    const preview = changeRequestApprovalPreview(
      request({ intent: { kind: "runtime_configuration", change: { operation: "x", apiToken: "abc123" } } }),
    );
    expect(preview?.requestSummary).toContainEqual({ label: "Change api token", value: "[redacted]" });
  });

  it("keeps non-secret credential lifecycle fields readable so replace and remove differ", () => {
    const summary = (credentialAction: string) =>
      changeRequestApprovalPreview(
        request({
          intent: {
            kind: "provider_connection",
            providerId: "openai",
            credentialAction,
            credentialStorage: "env",
            credentialEnvVar: "OPENAI_API_KEY",
            profile: { apiKeyEnv: "OPENAI_API_KEY" },
          },
        }),
      )?.requestSummary;
    expect(summary("replace_api_key")).toEqual([
      { label: "Kind", value: "provider_connection" },
      { label: "Provider id", value: "openai" },
      { label: "Credential action", value: "replace_api_key" },
      { label: "Credential storage", value: "env" },
      { label: "Credential env var", value: "OPENAI_API_KEY" },
      { label: "Profile api key env", value: "OPENAI_API_KEY" },
    ]);
    expect(summary("remove_oauth")).toContainEqual({ label: "Credential action", value: "remove_oauth" });
    expect(
      changeRequestApprovalPreview(
        request({
          intent: {
            kind: "runtime_configuration",
            change: { operation: "gateway_auth_configuration", mode: "token", replaceCredential: true },
          },
        }),
      )?.requestSummary,
    ).toContainEqual({ label: "Change replace credential", value: "true" });
  });

  it("withholds the summary when the intent can't be listed exactly", () => {
    const flags = Object.fromEntries(Array.from({ length: 50 }, (_, index) => [`flag${index}`, true]));
    for (const intent of [
      undefined,
      "provider_connection",
      { kind: "runtime_configuration", change: { operation: "feature_flags", flags } },
      { kind: "capability_pack", assets: [{ id: "a" }] },
    ]) {
      const preview = changeRequestApprovalPreview(request({ intent }));
      expect(preview).toMatchObject({ reviewKind: "change.request", toolName: "change.request" });
      expect(preview).not.toHaveProperty("requestSummary");
    }
  });

  it("ignores other tools", () => {
    expect(changeRequestApprovalPreview(request({ path: "notes.md" }, "fs.read"))).toBeUndefined();
  });
});
