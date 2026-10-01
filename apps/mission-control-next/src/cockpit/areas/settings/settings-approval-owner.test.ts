import { describe, expect, it } from "vitest";
import type { ChangePlanRecord } from "@goatcitadel/contracts";
import { awaitingLlamaApproval, llamaPlanFixture } from "../../../features/native-routes/settings/llama-setup.test-support";
import { settingsApprovalOwnerBinding, type SettingsApprovalOwner } from "./settings-approval-owner";

const setup = () => awaitingLlamaApproval(llamaPlanFixture());
function fixture(owner: SettingsApprovalOwner): ChangePlanRecord {
  const base = setup();
  if (owner === "llama-setup") return base;
  if (owner === "gateway-auth" || owner === "managed-runtime") {
    const change = owner === "gateway-auth"
      ? { operation: "gateway_auth_configuration" as const, mode: "token" as const, allowLoopbackBypass: false }
      : { operation: "llama_cpp_configuration" as const, config: { alias: "Reviewed alias" } };
    return { ...base, origin: { surface: "settings", workspaceId: "default" },
      request: { kind: "runtime_configuration", change }, target: { ...base.target, resourceId: change.operation } };
  }
  if (owner === "provider-routing") return {
    ...base, kind: "installation_default_model", scope: "installation",
    origin: { surface: "settings", workspaceId: "default" }, adapter: { adapterId: "model-selection", version: 1 },
    request: { kind: "installation_default_model", providerId: "openai", model: "reviewed-model" },
    target: { ownerId: "runtime_settings", resourceId: "llm_defaults", expectedRevision: 8 },
  };
  return { ...base, kind: "provider_connection", scope: "provider",
    origin: { surface: "settings", workspaceId: owner === "guided-model" ? "workspace-a" : "default" },
    adapter: { adapterId: "provider-connection", version: 5 },
    request: { kind: "provider_connection", providerId: "openai", credentialAction: "remove_api_key" },
    target: { ownerId: "provider_connection", resourceId: "openai", expectedRevision: 8 } };
}
const owners: SettingsApprovalOwner[] = ["gateway-auth", "llama-setup", "managed-runtime", "provider-routing", "provider-management", "guided-model"];

describe("native Settings exact approval owner binding", () => {
  it.each(owners)("accepts %s's actual owner namespace and encoded approval, without an Inbox alias", (owner) => {
    const plan = fixture(owner);
    const id = "approval /?# exact";
    if (plan.requiredAction?.kind !== "approval") throw new Error("approval fixture missing");
    const reviewed = { ...plan, approvalRefs: [id], requiredAction: { ...plan.requiredAction, approvalId: id } };
    expect(settingsApprovalOwnerBinding(reviewed, owner, "workspace-a")?.href)
      .toBe(`/ops/approvals?approvalId=${encodeURIComponent(id)}&shell=classic`);
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
    expect(settingsApprovalOwnerBinding(plan, owner, "workspace-a", { ...plan, revision: plan.revision + 1 })).toBeNull();
    expect(settingsApprovalOwnerBinding(plan, owner, "workspace-a", { ...plan, planId: "other-plan" })).toBeNull();
    expect(settingsApprovalOwnerBinding(plan, owner, "workspace-a", { ...plan, requiredAction: undefined })).toBeNull();
  });
  it("distinguishes installation profile/key custody from explicitly workspace-owned Codex OAuth", () => {
    const base = fixture("provider-management");
    const plan: ChangePlanRecord = { ...base, origin: { surface: "settings", workspaceId: "workspace-a" },
      request: { kind: "provider_connection", providerId: "openai-codex", credentialAction: "replace_oauth" },
      target: { ...base.target, resourceId: "openai-codex" } };
    expect(settingsApprovalOwnerBinding(plan, "provider-management", "workspace-a")).not.toBeNull();
    expect(settingsApprovalOwnerBinding(plan, "provider-management", "workspace-b")).toBeNull();
    expect(settingsApprovalOwnerBinding({ ...plan, request: { ...plan.request, kind: "provider_connection", providerId: "openai-codex", profile: { label: "A profile mutation" } } }, "provider-management", "workspace-a")).toBeNull();
  });
  it("keeps GuidedModelSetup's explicit workspace origin for its installation-default model plan", () => {
    const plan: ChangePlanRecord = { ...fixture("provider-routing"), origin: { surface: "settings", workspaceId: "workspace-a" } };
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
    ]) expect(settingsApprovalOwnerBinding(changed, "llama-setup", "workspace-a")!.identity).not.toBe(identity);
  });
});
