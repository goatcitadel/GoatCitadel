import { createHash } from "node:crypto";
const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");
import { beforeEach, expect, it, vi } from "vitest";
import { canonicalJsonString, type ApprovalRequest } from "@goatcitadel/contracts";
import { readApprovalFollowOn } from "./approval-follow-on";
const api = vi.hoisted(() => ({ replay: vi.fn(), lifecycle: vi.fn(), run: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  fetchApprovalReplay: api.replay,
  fetchRuntimeLifecycle: api.lifecycle,
  fetchDurableRun: api.run,
}));
const approval = {
  approvalId: "a",
  linkage: { workspaceId: "one", sessionId: "s", turnId: "t", durableRunId: "wait" },
} as ApprovalRequest;
const wait = { runId: "wait", workflowKey: "approval.wait", status: "completed", payload: { approvalId: "a" } };
const request = { content: "safe fixture" };
const admissionMaterialSha256 = sha256Hex(canonicalJsonString({ version: 2, request }));
const payload = {
  version: "chat.turn.execute.v2",
  admissionId: "admission",
  sessionIncarnationId: "incarnation",
  admissionMaterialSha256,
  policyRunIdDerivation: { version: 1, kind: "durable_run_id", runId: "original" },
  workspaceId: "one",
  admissionAggregateRevision: 1,
  admissionControllerGeneration: 1,
  effectiveRequestMaterialSha256: sha256Hex(canonicalJsonString({ version: 1, admissionMaterialSha256, request })),
  requestActor: { actorKind: "operator", actorId: "fixture" },
  sessionId: "s",
  turnId: "t",
  userMessageId: "u",
  assistantMessageId: "b",
  branchKind: "chat",
  threadEventType: "message",
  request,
};
const original = { runId: "original", workflowKey: "chat.turn.execute", status: "waiting", payload };
beforeEach(() => {
  vi.resetAllMocks();
  api.replay.mockResolvedValue({ approval, durableRunId: "wait", effects: [], events: [] });
  api.lifecycle.mockResolvedValue({
    approval,
    canonical: { approvalId: "a", runId: "wait" },
    resolution: { runIdSource: "approval_linkage" },
    turns: [{ sessionId: "s", turnId: "t", durableRunId: "original" }],
  });
  api.run.mockImplementation(async (id) => (id === "wait" ? wait : original));
});
it.each(["waiting", "failed"])("distinguishes completed wait settlement from original %s work", async (status) => {
  api.run.mockImplementation(async (id) => (id === "wait" ? wait : { ...original, status }));
  const value = await readApprovalFollowOn(approval, "one", () => true);
  expect(value.wait?.status).toBe("completed");
  expect(value.run?.runId).toBe("original");
  expect(value.run?.status).toBe(status);
});
it("never treats wait-only canonical lifecycle as original execution", async () => {
  api.lifecycle.mockResolvedValue({
    approval,
    canonical: { runId: "wait" },
    resolution: { runIdSource: "approval_wait_run" },
    turns: [],
  });
  const result = await readApprovalFollowOn(approval, "one", () => true);
  expect(result.run).toBeUndefined();
  expect(result.wait?.status).toBe("completed");
});
it("refuses foreign scope and malformed original Chat binding", async () => {
  api.run.mockImplementation(async (id) =>
    id === "wait" ? wait : { ...original, payload: { ...payload, workspaceId: "foreign" } },
  );
  await expect(readApprovalFollowOn(approval, "one", () => true)).rejects.toThrow("workspace");
  api.run.mockImplementation(async (id) =>
    id === "wait" ? wait : { ...original, payload: { ...payload, turnId: "different" } },
  );
  await expect(readApprovalFollowOn(approval, "one", () => true)).rejects.toThrow("admitted turn");
});
it("does not fetch work after current access changes during the lifecycle read", async () => {
  await expect(readApprovalFollowOn(approval, "one", () => false)).rejects.toThrow("access changed");
  expect(api.run).not.toHaveBeenCalled();
});
it("refuses a wait record from a different approval even with no original run", async () => {
  api.lifecycle.mockResolvedValue({
    approval,
    canonical: { runId: "wait" },
    resolution: { runIdSource: "approval_wait_run" },
    turns: [],
  });
  api.run.mockResolvedValue({ ...wait, payload: { approvalId: "foreign" } });
  await expect(readApprovalFollowOn(approval, "one", () => true)).rejects.toThrow("another request");
});
