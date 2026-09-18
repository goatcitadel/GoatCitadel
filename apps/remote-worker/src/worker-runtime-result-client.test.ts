import { beforeEach, describe, expect, it, vi } from "vitest";
import { runtimeResultPagesFixture } from "../../../packages/contracts/src/remote-worker-runtime-result-pages-test-fixture.js";
import type { RemoteWorkerRuntimeResultPage } from "@goatcitadel/contracts";
import { exchangeWorkerRuntimeResult, uploadWorkerRuntimeResult } from "./worker-runtime-result-client.js";
import { callProtectedRoute } from "./worker-protected-route-client.js";
import type { RouteContext } from "./connected-worker-routes.js";
vi.mock("./worker-protected-route-client.js", () => ({ callProtectedRoute: vi.fn() }));
const context = {} as RouteContext;
function fixture() {
  const value = runtimeResultPagesFixture(), lease = { registryWorkspaceId: value.history.registryWorkspaceId, assignmentId: value.history.assignmentId,
    assignmentGeneration: value.history.assignmentGeneration, leaseRevision: value.history.leaseRevision, leaseToken: "private-lease-token" };
  const reply = (page: RemoteWorkerRuntimeResultPage | null, complete?: boolean) => ({ status: 200, body: {
    schemaVersion: "goatcitadel.remote-worker-assignment-execution-response.v1", operation: "assignment.settlement.submit", disposition: "runtime_result",
    registryWorkspaceId: lease.registryWorkspaceId, runtimeResult: value.response(page, complete) } });
  return { ...value, lease, reply };
}
describe("protected worker runtime result delivery", () => {
  beforeEach(() => vi.clearAllMocks());
  it("uploads all 31 pages with frozen binding and exact receipts", async () => {
    const f = fixture(), assignmentId = f.lease.assignmentId;
    vi.mocked(callProtectedRoute).mockImplementation(async input => {
      expect(Buffer.byteLength(JSON.stringify(input.payload))).toBeLessThan(256 * 1024);
      expect(input.payload.assignmentId).toBe(assignmentId); expect(input.idempotencyKey).not.toContain(f.lease.leaseToken);
      f.lease.assignmentId = "caller-mutated"; f.expectation.maxInputBytes = 0;
      return f.reply(input.payload.submission as RemoteWorkerRuntimeResultPage);
    });
    const result = await uploadWorkerRuntimeResult(context, f.lease, f.resultHex, f.expectation, f.history);
    expect(result.record?.resultSha256).toBe(f.resultSha256); expect(callProtectedRoute).toHaveBeenCalledTimes(31);
    expect(new Set(vi.mocked(callProtectedRoute).mock.calls.map(([value]) => value.idempotencyKey)).size).toBe(31);
  });
  it.each(["scope", "lease", "nonce", "bytes", "operation", "lost", "cancel"])("stops without automatic retry after %s", async mode => {
    const f = fixture(), controller = new AbortController();
    vi.mocked(callProtectedRoute).mockImplementation(async input => {
      const response = f.reply(input.payload.submission as RemoteWorkerRuntimeResultPage), result = response.body.runtimeResult;
      if (mode === "scope") response.body.runtimeResult = { ...result, assignmentId: "foreign" };
      if (mode === "lease") response.body.runtimeResult = { ...result, leaseRevision: 2 };
      if (mode === "nonce") response.body.runtimeResult = { ...result, nonce: "ff".repeat(32) };
      if (mode === "bytes") response.body.runtimeResult = { ...result, accepted: { ...result.accepted!, page: { ...result.accepted!.page, bytesHex: "ff" + result.accepted!.page.bytesHex.slice(2) } } };
      if (mode === "operation") response.body.operation = "assignment.inference";
      if (mode === "lost") throw new Error("Controlled lost acknowledgment after possible commit");
      if (mode === "cancel") controller.abort(); return response;
    });
    await expect(uploadWorkerRuntimeResult(context, f.lease, f.resultHex, f.expectation, f.history, controller.signal)).rejects.toThrow();
    expect(callProtectedRoute).toHaveBeenCalledTimes(1);
  });
  it("recovers an exact receipt through lookup without resubmitting execution", async () => {
    const f = fixture(); vi.mocked(callProtectedRoute).mockResolvedValueOnce(f.reply(null, true));
    const result = await exchangeWorkerRuntimeResult(context, f.lease, { kind: "runtime.result.lookup", nonce: f.expectation.nonce, requestSha256: f.expectation.requestSha256 });
    expect(result.record?.resultSha256).toBe(f.resultSha256); expect(callProtectedRoute).toHaveBeenCalledTimes(1);
    expect(vi.mocked(callProtectedRoute).mock.calls[0]![0].payload.submission).toMatchObject({ kind: "runtime.result.lookup" });
  });
  it("refuses changed request authority or malformed terminal bytes before transport", async () => {
    const f = fixture();
    await expect(uploadWorkerRuntimeResult(context, f.lease, f.resultHex, { ...f.expectation, requestSha256: "ff".repeat(32) }, f.history)).rejects.toThrow();
    await expect(uploadWorkerRuntimeResult(context, f.lease, f.resultHex.slice(0, -2), f.expectation, f.history)).rejects.toThrow();
    expect(callProtectedRoute).not.toHaveBeenCalled();
  });
});
