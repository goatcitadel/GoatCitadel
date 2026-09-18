import { describe, expect, it, vi } from "vitest";
import { REMOTE_WORKER_NATIVE_CAPACITY_PAGE_EXCHANGE_SCHEMA } from "@goatcitadel/contracts";
import { exchangeRemoteWorkerNativeCapacityPage as exchange, type RemoteWorkerNativeCapacityPageAssignmentInput } from "./remote-worker-native-capacity-page-exchange.js";
function fixture() {
  const submission = { kind: "cell.native_capacity.page" as const, nonce: "11".repeat(32), bundleSha256: "22".repeat(32),
    deliverySha256: "33".repeat(32), byteLength: 65536, offset: 0, bytesHex: "7b".repeat(32768) };
  const input = { registryWorkspaceId: "default", assignmentId: "assignment", assignmentGeneration: 1, leaseRevision: 2,
    leaseTokenSha256: "44".repeat(32), submission,
    protectedAuthority: { credentialAuthority: { credentialGeneration: 1 }, meshAdmission: { admissionGeneration: 1 } } } as unknown as RemoteWorkerNativeCapacityPageAssignmentInput;
  const result = { schemaVersion: REMOTE_WORKER_NATIVE_CAPACITY_PAGE_EXCHANGE_SCHEMA, registryWorkspaceId: input.registryWorkspaceId,
    assignmentId: input.assignmentId, assignmentGeneration: input.assignmentGeneration, leaseRevision: input.leaseRevision,
    nonce: submission.nonce, bundleSha256: submission.bundleSha256, record: null, accepted: { page: { ...submission }, nextOffset: 32768 } };
  return { input, submission, result };
}
describe("native capacity protected page exchange", () => {
  it("freezes submission and authority before an asynchronous owner boundary", async () => {
    const f = fixture();
    const owner = { exchange: vi.fn(async (input: RemoteWorkerNativeCapacityPageAssignmentInput) => {
      await Promise.resolve(); f.submission.bytesHex = "7d".repeat(32768);
      expect(Object.isFrozen(input.submission)).toBe(true); expect(Object.isFrozen(input.protectedAuthority.credentialAuthority)).toBe(true);
      expect(input.submission).toEqual(f.result.accepted.page);
      return f.result;
    }) };
    expect(await exchange(owner, f.input)).toEqual(f.result);
  });
  it.each(["before", "after"])("withholds cancelled %s persistence", async stage => {
    const f = fixture(), controller = new AbortController();
    if (stage === "before") controller.abort(new Error("cancelled"));
    const owner = { exchange: vi.fn(async () => { controller.abort(new Error("cancelled")); return f.result; }) };
    await expect(exchange(owner, { ...f.input, signal: controller.signal })).rejects.toThrow(/cancelled/u);
    expect(owner.exchange).toHaveBeenCalledTimes(stage === "before" ? 0 : 1);
  });
  it("requires a lookup response without an unrelated page acknowledgement", async () => {
    const f = fixture(), input = { ...f.input, submission: { kind: "cell.native_capacity.lookup" as const, nonce: f.submission.nonce, bundleSha256: f.submission.bundleSha256 } };
    await expect(exchange({ exchange: async () => f.result }, input)).rejects.toThrow(/bind this assignment/u);
    await expect(exchange({ exchange: async () => ({ ...f.result, accepted: null }) }, input)).resolves.toMatchObject({ record: null, accepted: null });
    await expect(exchange(undefined, input)).rejects.toThrow(/unavailable/u);
  });
});
