import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { canonicalJsonString } from "@goatcitadel/contracts";
import { assertChatFeatureBindingCurrent } from "./chat-feature-binding-current.js";

const hash = (value: unknown) => createHash("sha256").update(canonicalJsonString(value)).digest("hex");
function fixture() {
  const references = { version: "chat.turn.feature-references.v1" as const };
  const featureAdmission = { references, referenceSha256: hash(references) };
  const request = { content: "Complete the child task", parentDelegationStepId: "step", policyRunId: "delegation" };
  const admissionMaterialSha256 = hash({ version: 2, request });
  const run = {
    workflowKey: "chat.turn.execute",
    status: "running",
    payload: {
      version: "chat.turn.execute.v2",
      admissionId: "admission",
      sessionIncarnationId: "incarnation",
      workspaceId: "workspace",
      sessionId: "session",
      turnId: "turn",
      admissionAggregateRevision: 1,
      admissionControllerGeneration: 1,
      admissionMaterialSha256,
      effectiveRequestMaterialSha256: hash({ version: 1, admissionMaterialSha256, request }),
      requestActor: { actorKind: "operator", actorId: "operator", operatorId: "operator" },
      userMessageId: "user",
      assistantMessageId: "assistant",
      branchKind: "append",
      threadEventType: "chat_thread_turn_appended",
      featureReferenceSha256: featureAdmission.referenceSha256,
      request,
    },
  };
  const storage = {
    durableRuns: { getRun: vi.fn(async () => run) },
    sessionMutationAdmissions: {
      findFeatureReferences: vi.fn(async () => featureAdmission),
      findDurableRunBinding: vi.fn(async () => ({ durableRunId: "child-run" })),
    },
  };
  const input = {
    featureAdmission,
    workspaceId: "workspace",
    sessionId: "session",
    turnId: "turn",
    policyRunId: "delegation",
    canonicalDurableRunId: "child-run",
    canonicalWriteFence: async <T>(work: () => T | Promise<T>): Promise<Awaited<T>> => await work(),
  };
  return { storage, input, run };
}

describe("current feature admission binding", () => {
  it("uses the canonical child run while retaining its distinct delegation policy identity", async () => {
    const f = fixture();
    await assertChatFeatureBindingCurrent(f.storage as never, f.input);
    expect(f.storage.durableRuns.getRun).toHaveBeenCalledWith("child-run");
    expect(f.storage.durableRuns.getRun).not.toHaveBeenCalledWith("delegation");
  });
  it.each(["run", "binding", "scope", "material"])("rejects %s drift under the live write fence", async (drift) => {
    const f = fixture();
    if (drift === "run") f.run.status = "cancelled";
    if (drift === "binding")
      f.storage.sessionMutationAdmissions.findDurableRunBinding.mockResolvedValue({ durableRunId: "other" });
    if (drift === "scope") f.run.payload.sessionId = "other";
    if (drift === "material") f.run.payload.featureReferenceSha256 = "0".repeat(64);
    await expect(assertChatFeatureBindingCurrent(f.storage as never, f.input)).rejects.toThrow();
  });
  it("fails closed when the durable identity is replaced with a delegation aggregate", async () => {
    const f = fixture();
    await expect(
      assertChatFeatureBindingCurrent(f.storage as never, { ...f.input, canonicalDurableRunId: "delegation" }),
    ).rejects.toThrow();
  });
});
