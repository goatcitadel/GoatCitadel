import { describe, expect, it } from "vitest";
import type { ChangePlanRecord } from "@goatcitadel/contracts";
import {
  awaitingLlamaApproval,
  llamaPlanFixture,
} from "../../../features/native-routes/settings/llama-setup.test-support";
import { settingsApprovalOwnerBinding, type SettingsApprovalOwner } from "./settings-approval-owner";

const setup = () => awaitingLlamaApproval(llamaPlanFixture());
function fixture(owner: SettingsApprovalOwner): ChangePlanRecord {
  const base = setup();
  if (owner === "llama-setup") return base;
  if (owner === "gateway-auth" || owner === "managed-runtime" || owner === "tool-approval" || owner === "budget-mode") {
    const change =
      owner === "gateway-auth"
        ? { operation: "gateway_auth_configuration" as const, mode: "token" as const, allowLoopbackBypass: false }
        : owner === "managed-runtime"
          ? { operation: "llama_cpp_configuration" as const, config: { alias: "Reviewed alias" } }
          : owner === "tool-approval"
            ? { operation: "tool_approval_mode" as const, mode: "approve_risky" as const }
            : { operation: "budget_mode" as const, mode: "saver" as const };
    return {
      ...base,
      origin: { surface: "settings", workspaceId: "default" },
      request: { kind: "runtime_configuration", change },
      target: { ...base.target, resourceId: change.operation },
    };
  }
  if (owner === "filesystem-write-access")
    return {
      ...base,
      origin: { surface: "settings", workspaceId: "default" },
      request: {
        kind: "runtime_configuration",
        change: { operation: "tool_global_access", toolName: "fs.delete", posture: "available" },
      },
      target: { ...base.target, resourceId: "tool_global_access:fs.delete" },
    };
  if (owner === "provider-routing")
    return {
      ...base,
      kind: "installation_default_model",
      scope: "installation",
      origin: { surface: "settings", workspaceId: "default" },
      adapter: { adapterId: "model-selection", version: 1 },
      request: { kind: "installation_default_model", providerId: "openai", model: "reviewed-model" },
      target: { ownerId: "runtime_settings", resourceId: "llm_defaults", expectedRevision: 8 },
    };
  return {
    ...base,
    kind: "provider_connection",
    scope: "provider",
    origin: { surface: "settings", workspaceId: owner === "guided-model" ? "workspace-a" : "default" },
    adapter: { adapterId: "provider-connection", version: 5 },
    request: { kind: "provider_connection", providerId: "openai", credentialAction: "remove_api_key" },
    target: { ownerId: "provider_connection", resourceId: "openai", expectedRevision: 8 },
  };
}
const owners: SettingsApprovalOwner[] = [
  "gateway-auth",
  "llama-setup",
  "managed-runtime",
  "provider-routing",
  "provider-management",
  "guided-model",
  "tool-approval",
  "budget-mode",
  "filesystem-write-access",
];

describe("native Settings exact approval owner binding", () => {
  it.each(owners)("accepts %s's actual owner namespace and exact Inbox query selection", (owner) => {
    const plan = fixture(owner);
    const id = "approval /?# exact";
    if (plan.requiredAction?.kind !== "approval") throw new Error("approval fixture missing");
    const reviewed = { ...plan, approvalRefs: [id], requiredAction: { ...plan.requiredAction, approvalId: id } };
    expect(settingsApprovalOwnerBinding(reviewed, owner, "workspace-a")?.href).toBe(
      "/inbox?" + new URLSearchParams({ workspaceId: plan.origin.workspaceId, approvalId: id }),
    );
  });
  it.each(owners)("withholds foreign, malformed, terminal or superseded %s evidence", (owner) => {
    const plan = fixture(owner);
    const changed: ChangePlanRecord[] = [
      { ...plan, origin: { ...plan.origin, workspaceId: "foreign" } },
      { ...plan, origin: { ...plan.origin, sessionId: "foreign-session" } },
      { ...plan, origin: { ...plan.origin, turnId: "foreign-turn" } },
      { ...plan, status: "completed", requiredAction: undefined },
      { ...plan, phase: "validation" },
      { ...plan, revision: 0 },
      { ...plan, approvalRefs: [] },
      { ...plan, target: { ...plan.target, resourceId: "foreign-target" } },
    ];
    for (const value of changed) expect(settingsApprovalOwnerBinding(value, owner, "workspace-a")).toBeNull();
    expect(
      settingsApprovalOwnerBinding(plan, owner, "workspace-a", { ...plan, revision: plan.revision + 1 }),
    ).toBeNull();
    expect(settingsApprovalOwnerBinding(plan, owner, "workspace-a", { ...plan, planId: "other-plan" })).toBeNull();
    expect(settingsApprovalOwnerBinding(plan, owner, "workspace-a", { ...plan, requiredAction: undefined })).toBeNull();
  });
  it.each(["tool-approval", "budget-mode", "filesystem-write-access"] as const)(
    "rejects another runtime operation for %s even with the expected target",
    (owner) => {
      const plan = fixture(owner);
      const foreign: ChangePlanRecord = {
        ...plan,
        request: { kind: "runtime_configuration", change: { operation: "network_allowlist", entries: ["127.0.0.1"] } },
      };
      expect(settingsApprovalOwnerBinding(foreign, owner, "workspace-a")).toBeNull();
    },
  );
  it("distinguishes installation profile/key custody from explicitly workspace-owned Codex OAuth", () => {
    const base = fixture("provider-management");
    const plan: ChangePlanRecord = {
      ...base,
      origin: { surface: "settings", workspaceId: "workspace-a" },
      request: { kind: "provider_connection", providerId: "openai-codex", credentialAction: "replace_oauth" },
      target: { ...base.target, resourceId: "openai-codex" },
    };
    expect(settingsApprovalOwnerBinding(plan, "provider-management", "workspace-a")).not.toBeNull();
    expect(settingsApprovalOwnerBinding(plan, "provider-management", "workspace-b")).toBeNull();
    expect(
      settingsApprovalOwnerBinding(
        {
          ...plan,
          request: {
            ...plan.request,
            kind: "provider_connection",
            providerId: "openai-codex",
            profile: { label: "A profile mutation" },
          },
        },
        "provider-management",
        "workspace-a",
      ),
    ).toBeNull();
  });
  it("keeps GuidedModelSetup's explicit workspace origin for its installation-default model plan", () => {
    const plan: ChangePlanRecord = {
      ...fixture("provider-routing"),
      origin: { surface: "settings", workspaceId: "workspace-a" },
    };
    expect(settingsApprovalOwnerBinding(plan, "guided-model", "workspace-a")).not.toBeNull();
    expect(settingsApprovalOwnerBinding(plan, "guided-model", "workspace-b")).toBeNull();
    expect(settingsApprovalOwnerBinding(plan, "provider-routing", "workspace-a")).toBeNull();
    expect(settingsApprovalOwnerBinding(fixture("provider-routing"), "guided-model", "workspace-a")).toBeNull();
  });
  it("binds review identity to revision, nonce and exact immutable intent even if the approval ID is unchanged", () => {
    const plan = setup();
    if (plan.requiredAction?.kind !== "approval") throw new Error("approval fixture missing");
    const identity = settingsApprovalOwnerBinding(plan, "llama-setup", "workspace-a")!.identity;
    for (const changed of [
      { ...plan, revision: plan.revision + 1 },
      { ...plan, requiredAction: { ...plan.requiredAction, actionNonce: "new-nonce" } },
      { ...plan, intentHash: "new-intent" },
    ])
      expect(settingsApprovalOwnerBinding(changed, "llama-setup", "workspace-a")!.identity).not.toBe(identity);
  });
  it("retains independent run/session/query/hash while the validated record and workspace override stale targets", () => {
    const plan = fixture("provider-management");
    const context = {
      search:
        "?workspaceId=foreign&approvalId=old&runId=run%2Fone&sessionId=session%3Aone&source=settings&shell=classic&shellScope=visit",
      hash: "#connection-evidence",
    };
    const original = { ...context };
    const binding = settingsApprovalOwnerBinding(plan, "provider-management", "workspace-a", undefined, context)!;
    const target = new URL(binding.href, "http://cockpit.invalid");
    expect(target.pathname).toBe("/inbox");
    expect(target.searchParams.get("workspaceId")).toBe("default");
    expect(target.searchParams.getAll("approvalId")).toEqual([
      plan.requiredAction?.kind === "approval" ? plan.requiredAction.approvalId! : "",
    ]);
    expect(target.searchParams.get("runId")).toBe("run/one");
    expect(target.searchParams.get("sessionId")).toBe("session:one");
    expect(target.searchParams.get("source")).toBe("settings");
    expect(target.searchParams.has("shell")).toBe(false);
    expect(target.searchParams.has("shellScope")).toBe(false);
    expect(target.hash).toBe(context.hash);
    expect(context).toEqual(original);
    expect(binding.identity).toBe(settingsApprovalOwnerBinding(plan, "provider-management", "workspace-a")!.identity);
  });
});
