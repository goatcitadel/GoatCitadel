import type { ChangePlanRecord, LlamaCppSetupProjection } from "@goatcitadel/contracts";
import type { LlamaSetupChange } from "./llama-setup-state";
export function llamaProjectionFixture(): LlamaCppSetupProjection {
  return {
    settingsRevision: 8,
    managementMode: "external",
    baseUrl: "http://127.0.0.1:8080/v1",
    runtime: {
      enabled: true,
      desiredState: "running",
      processState: "running",
      healthy: true,
      baseUrl: "http://127.0.0.1:8080/v1",
      updatedAt: "2026-09-30T00:00:00.000Z",
    },
    ownership: "external",
    binary: { found: true, label: "llama-server.exe" },
    models: [{ modelId: "Local Model.gguf", label: "Local Model.gguf", source: "filesystem" }],
    catalog: { status: "fresh", modelIds: ["served-model"] },
    chatRoute: { providerId: "openai", model: "old-model", thinkingLevel: "standard" },
  };
}
export function llamaPlanFixture(
  change: LlamaSetupChange = {
    operation: "llama_cpp_setup",
    managementMode: "external",
    baseUrl: "http://127.0.0.1:8080/v1",
    model: "served-model",
  },
  workspaceId = "workspace-a",
): ChangePlanRecord {
  return {
    schemaVersion: 1,
    planId: "plan-1",
    revision: 1,
    status: "awaiting_confirmation",
    phase: "confirmation",
    kind: "runtime_configuration",
    adapter: { adapterId: "runtime-configuration", version: 2 },
    scope: "runtime",
    origin: { workspaceId, surface: "settings" },
    intentHash: "reviewed-runtime-intent",
    target: { ownerId: "runtime_settings", resourceId: "llama_cpp_setup", expectedRevision: 8 },
    request: { kind: "runtime_configuration", change },
    title: "Configure llama.cpp",
    summary: "Use the selected server and model.",
    impact: "Change the installation Chat default after verification.",
    risk: "danger",
    approvalRefs: [],
    evidenceRefs: [],
    rollbackRefs: [],
    requiredAction: {
      kind: "confirmation",
      actionId: "confirm-1",
      actionNonce: "nonce-1",
      title: "Confirm setup",
      confirmationText: "Confirm exact setup",
    },
    createdAt: "2026-09-30T00:00:00.000Z",
    updatedAt: "2026-09-30T00:00:00.000Z",
  };
}
export function awaitingLlamaApproval(plan: ChangePlanRecord): ChangePlanRecord {
  return {
    ...plan,
    revision: plan.revision + 2,
    phase: "authorization",
    status: "awaiting_approval",
    approvalRefs: ["approval-1"],
    requiredAction: {
      kind: "approval",
      actionId: "approval-action",
      actionNonce: "nonce-approval",
      title: "Approve setup",
      risk: "danger",
      approvalId: "approval-1",
    },
  };
}
export function deferredLlama<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
