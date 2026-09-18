import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalJsonString, normalizeRemoteWorkerNativeContinuation, type RemoteWorkerRuntimeRequestPageSubmission } from "@goatcitadel/contracts";
import { prepareWindowsRuntimeDispatch } from "@goatcitadel/contracts/remote-worker-runtime-node";
import { windowsRuntimeDispatchFixture } from "../../../remote-worker/src/worker-windows-runtime-dispatch-test-fixture.js";
import { downloadWorkerRuntimeRequest } from "../../../remote-worker/src/worker-runtime-request-client.js";
import { callProtectedRoute } from "../../../remote-worker/src/worker-protected-route-client.js";
import { readRemoteWorkerRuntimeRequestPage } from "./remote-worker-runtime-request-pages.js";
import type { RouteContext } from "../../../remote-worker/src/connected-worker-routes.js";
vi.mock("../../../remote-worker/src/worker-protected-route-client.js", () => ({ callProtectedRoute: vi.fn() }));
function fixture() {
  const request = windowsRuntimeDispatchFixture(); request.launch.commandLine += " " + "漢".repeat(10500);
  request.launch.environment.SystemRoot = "C:\\Windows" + "x".repeat(3000);
  const expected = prepareWindowsRuntimeDispatch(request).expectation;
  const lease = { registryWorkspaceId: "registry", assignmentId: "assignment", assignmentGeneration: 1, leaseRevision: 1, leaseToken: "private-token" };
  const context = { credential: {} } as RouteContext, selectAdmittedForAssignment = vi.fn(async () => ({ request, expectation: expected }));
  const reply = async (submission: RemoteWorkerRuntimeRequestPageSubmission) => ({ status: 200, body: {
    schemaVersion: "goatcitadel.remote-worker-assignment-execution-response.v1", operation: "assignment.settlement.submit", disposition: "runtime_request_page",
    registryWorkspaceId: lease.registryWorkspaceId, runtimeRequestPage: await readRemoteWorkerRuntimeRequestPage({ selectAdmittedForAssignment }, {
      registryWorkspaceId: lease.registryWorkspaceId, assignmentId: lease.assignmentId, assignmentGeneration: lease.assignmentGeneration,
      leaseRevision: lease.leaseRevision, leaseTokenSha256: "b".repeat(64), protectedAuthority: { credentialAuthority: {}, meshAdmission: {} } as never, submission }) } });
  return { request, expected, lease, context, selectAdmittedForAssignment, reply };
}
describe("protected native request download", () => {
  beforeEach(() => vi.clearAllMocks());
  it.each(["exact", "removed", "changed"])("carries the %s continuation on every page", async mode => {
    const f = fixture(), continuation = normalizeRemoteWorkerNativeContinuation({ schemaVersion: "goatcitadel.remote-worker-native-continuation.v1",
      assignmentGeneration: 1, resumeSha256: "11".repeat(32), approvalId: "approval", approvalSha256: "22".repeat(32),
      nativeRuntimeBindingSha256: "33".repeat(32), decision: "approved" });
    vi.mocked(callProtectedRoute).mockImplementation(async input => {
      const response = await f.reply(input.payload.submission as RemoteWorkerRuntimeRequestPageSubmission), page = response.body.runtimeRequestPage;
      expect(f.selectAdmittedForAssignment).toHaveBeenLastCalledWith(expect.objectContaining({ continuation }));
      if (mode === "removed") { const { continuation: _route, ...submission } = page.submission; response.body.runtimeRequestPage = { ...page, submission }; }
      if (mode === "changed") response.body.runtimeRequestPage = { ...page, submission: { ...page.submission, continuation: { ...continuation, approvalId: "foreign" } } };
      return response;
    });
    const pending = downloadWorkerRuntimeRequest(f.context, f.lease, undefined, continuation);
    if (mode === "exact") { expect((await pending).request).toEqual(f.request); expect(callProtectedRoute).toHaveBeenCalledTimes(2); }
    else { await expect(pending).rejects.toThrow(); expect(callProtectedRoute).toHaveBeenCalledTimes(1); }
  });
  it("reassembles UTF-8 across pages from the Gateway adapter with fresh selection per page", async () => {
    const f = fixture(); vi.mocked(callProtectedRoute).mockImplementation(async input => {
      const response = await f.reply(input.payload.submission as RemoteWorkerRuntimeRequestPageSubmission);
      expect(Buffer.byteLength(JSON.stringify(response.body))).toBeLessThan(256 * 1024);
      expect(input.idempotencyKey).not.toContain(f.lease.leaseToken); return response;
    });
    const result = await downloadWorkerRuntimeRequest(f.context, f.lease);
    expect(result.request).toEqual(f.request); expect(result.expected).toEqual(f.expected);
    expect(callProtectedRoute).toHaveBeenCalledTimes(2); expect(f.selectAdmittedForAssignment).toHaveBeenCalledTimes(2);
    const requests = vi.mocked(callProtectedRoute).mock.calls;
    expect(requests[0]![0].payload.submission).toMatchObject({ offset: 0, nonce: null });
    expect(requests[1]![0].payload.submission).toMatchObject({ offset: 32768, nonce: f.expected.nonce, requestSha256: f.expected.requestSha256 });
    expect(requests[0]![0].idempotencyKey).not.toBe(requests[1]![0].idempotencyKey);
  });
  it.each(["scope", "generation", "lease", "challenge", "offset", "bytes", "metadata", "cancel", "lost", "revoked"])("refuses %s without retry", async mode => {
    const f = fixture(), stop = new AbortController(); let calls = 0;
    vi.mocked(callProtectedRoute).mockImplementation(async input => {
      calls += 1;
      if (mode === "lost") throw new Error("lost response");
      if (mode === "revoked") f.selectAdmittedForAssignment.mockRejectedValue(new Error("revoked"));
      const response = await f.reply(input.payload.submission as RemoteWorkerRuntimeRequestPageSubmission), page = response.body.runtimeRequestPage;
      if (mode === "scope") response.body.runtimeRequestPage = { ...page, assignmentId: "foreign" };
      if (mode === "generation") response.body.runtimeRequestPage = { ...page, assignmentGeneration: 2 };
      if (mode === "lease") response.body.runtimeRequestPage = { ...page, leaseRevision: 2 };
      if (mode === "challenge") response.body.runtimeRequestPage = { ...page, submission: { ...page.submission, challenge: "ff".repeat(32) } };
      if (mode === "offset") response.body.runtimeRequestPage = { ...page, submission: { ...page.submission, offset: 32768 } };
      if (mode === "bytes") response.body.runtimeRequestPage = { ...page, bytesHex: "00" + page.bytesHex.slice(2) };
      if (mode === "metadata" && calls === 2) response.body.runtimeRequestPage = { ...page, jsonSha256: "ff".repeat(32) };
      if (mode === "cancel") stop.abort(); return response;
    });
    await expect(downloadWorkerRuntimeRequest(f.context, f.lease, stop.signal)).rejects.toThrow();
    expect(callProtectedRoute).toHaveBeenCalledTimes(["bytes", "metadata"].includes(mode) ? 2 : 1);
  });
  it("refuses a coherent JSON transfer whose executable hash differs from admission", async () => {
    const f = fixture(), changed = structuredClone(f.request); changed.launch.commandLine = changed.launch.commandLine.replace("serve", "other");
    const bytes = Buffer.from(canonicalJsonString(changed));
    vi.mocked(callProtectedRoute).mockImplementation(async input => {
      const submission = input.payload.submission as RemoteWorkerRuntimeRequestPageSubmission, response = await f.reply(submission);
      response.body.runtimeRequestPage = { ...response.body.runtimeRequestPage, jsonSha256: createHash("sha256").update(bytes).digest("hex"),
        totalBytes: bytes.length, bytesHex: bytes.subarray(submission.offset, submission.offset + 32768).toString("hex") }; return response;
    });
    await expect(downloadWorkerRuntimeRequest(f.context, f.lease)).rejects.toThrow("admitted expectation");
  });
});
