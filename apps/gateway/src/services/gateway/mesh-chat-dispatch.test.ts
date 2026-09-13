import { describe, expect, it, vi } from "vitest";
import type { ToolInvokeRequest, ToolInvokeResult } from "@goatcitadel/contracts";
import { createMeshChatCatalogFixture } from "./mesh-chat-catalog-test-fixtures.js";
import { resolveMeshChatToolSchemas } from "./mesh-chat-catalog.js";
import { dispatchMeshChatTool, type MeshChatDispatchPort } from "./mesh-chat-dispatch.js";
import type { MeshCapabilityInvocationDispatchOutcome } from "../mesh-capability-invocation-service.js";

async function fixture() {
  const catalog = createMeshChatCatalogFixture();
  const [schema] = await resolveMeshChatToolSchemas(catalog.deps, { workspaceId: catalog.workspaceId, entries: [catalog.entry] });
  const request: ToolInvokeRequest = { toolName: catalog.capabilityId, agentId: "assistant", sessionId: "session",
    workspaceId: catalog.workspaceId, turnId: "turn", toolRunId: "tool-run", runId: "run", args: {
      query: "status", nodeId: "body-node", toolName: "body-target", approvalId: "body-approval",
    } };
  const policy: ToolInvokeResult = { outcome: "executed", policyReason: "allowed", auditEventId: "audit", wardEffect: "redact" };
  const outcome: MeshCapabilityInvocationDispatchOutcome = {
    invocationId: "invocation", disposition: "succeeded", settled: true, deliveryUncertain: false,
    manualReconciliationRequired: false, output: { status: "ok" },
    receipt: { invocationId: "invocation", capabilityId: catalog.capabilityId, nodeId: catalog.binding.nodeId,
      activationId: catalog.binding.activationId, activationRevision: catalog.binding.activationRevision,
      publisherGeneration: catalog.binding.publisherGeneration, publicationLeaseFencingToken: catalog.binding.publicationLeaseFencingToken,
      inputSha256: "1".repeat(64), deadlineAt: "2099-01-01T00:00:00.000Z" },
  };
  const binding = { schema: schema!, executionProfileSha256: "9".repeat(64) };
  const order: string[] = [];
  const resolveBinding = vi.fn<MeshChatDispatchPort["resolveBinding"]>(async () => {
    order.push("binding");
    return binding;
  });
  const append = vi.fn(() => order.push("append"));
  const dispatch = vi.fn<MeshChatDispatchPort["dispatch"]>(async (_input, options) => {
    await options?.executionFence?.();
    append();
    return outcome;
  });
  return { catalog, request, policy, outcome, binding, order, append, port: { resolveBinding, dispatch } };
}

describe("mesh Chat canonical dispatch adapter", () => {
  it("binds exact invocation and approval identity and rechecks authority after both fences", async () => {
    const f = await fixture();
    const result = await dispatchMeshChatTool(f.port, f.request, f.policy, {
      approvalId: "canonical-approval", executionFence: async () => { f.order.push("execution-fence"); },
      markExternalCallStarted: async () => { f.order.push("effect-fence"); },
    });
    expect(f.order).toEqual(["binding", "execution-fence", "effect-fence", "binding", "append"]);
    expect(f.port.dispatch).toHaveBeenCalledWith({ workspaceId: f.catalog.workspaceId, capabilityId: f.catalog.capabilityId,
      binding: f.catalog.binding, args: f.request.args, toolRunId: "tool-run", sessionId: "session", turnId: "turn", runId: "run",
      approvalId: "canonical-approval", executionProfileSha256: f.binding.executionProfileSha256 }, expect.any(Object));
    expect(result).toMatchObject({ outcome: "executed", auditEventId: "audit", wardEffect: "redact",
      result: { ok: true, output: { status: "ok" }, meshInvocation: { settled: true } } });
    expect(f.append).toHaveBeenCalledOnce();
  });

  it.each(["blocked", "approval_required", "dry-run"])("does not create an intent for %s policy", async (outcome) => {
    const f = await fixture();
    const policy: ToolInvokeResult = outcome === "dry-run" ? { ...f.policy, result: { dryRun: true } }
      : { ...f.policy, outcome: outcome as "blocked" | "approval_required" };
    expect(await dispatchMeshChatTool(f.port, f.request, policy, {})).toBe(policy);
    expect(f.port.resolveBinding).not.toHaveBeenCalled();
    expect(f.port.dispatch).not.toHaveBeenCalled();
  });

  it.each(["workspaceId", "turnId", "toolRunId"] as const)("requires the canonical %s before reaching the owner", async (field) => {
    const f = await fixture();
    await expect(dispatchMeshChatTool(f.port, { ...f.request, [field]: undefined }, f.policy, {})).rejects.toThrow("canonical Chat correlation");
    expect(f.port.dispatch).not.toHaveBeenCalled();
  });

  it.each(["missing", "profile", "activation", "alias"])("rejects %s authority drift while a fence is pending", async (change) => {
    const f = await fixture();
    await expect(dispatchMeshChatTool(f.port, f.request, f.policy, { markExternalCallStarted: async () => {
      f.port.resolveBinding.mockResolvedValue(change === "missing" ? undefined : {
        ...f.binding, ...(change === "profile" ? { executionProfileSha256: "0".repeat(64) } : {}),
        schema: { ...f.binding.schema, ...(change === "alias" ? { modelName: "changed_alias" } : {}),
          publication: { ...f.binding.schema.publication,
            ...(change === "activation" ? { activationRevision: 99 } : {}) } },
      });
    } })).rejects.toThrow("authority drifted before dispatch");
    expect(f.append).not.toHaveBeenCalled();
  });

  it("suppresses output and retains uncertain-delivery truth", async () => {
    const f = await fixture();
    Object.assign(f.outcome, { disposition: "unknown", deliveryUncertain: true,
      manualReconciliationRequired: true, errorCode: "mesh_capability_dispatch_transport_failed" });
    const result = await dispatchMeshChatTool(f.port, f.request, f.policy, {});
    expect(result).toMatchObject({ outcome: "executed", result: { ok: false, externalOutcome: "unknown_after_send",
      manualReconciliationRequired: true, error: "mesh_capability_dispatch_transport_failed" } });
    expect(result.result).not.toHaveProperty("output");
    expect(f.append).toHaveBeenCalledOnce();
  });

  it("does not expose input after cancellation during the canonical effect fence", async () => {
    const f = await fixture();
    const controller = new AbortController();
    await expect(dispatchMeshChatTool(f.port, { ...f.request, signal: controller.signal }, f.policy, {
      markExternalCallStarted: () => controller.abort(),
    })).rejects.toThrow();
    expect(f.append).not.toHaveBeenCalled();
  });
});
