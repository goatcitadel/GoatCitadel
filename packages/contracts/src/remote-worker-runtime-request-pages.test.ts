import { describe, expect, it } from "vitest";
import { normalizeRemoteWorkerRuntimeRequestPageSubmission as normalize, normalizeRemoteWorkerRuntimeRequestPage as page,
  REMOTE_WORKER_RUNTIME_REQUEST_PAGE_SCHEMA, REMOTE_WORKER_RUNTIME_REQUEST_MAX_BYTES } from "./remote-worker-runtime-request-pages.js";
const submission = { kind: "runtime.request.page", offset: 0, nonce: null, requestSha256: null, challenge: "11".repeat(32) };
const expectation = { nonce: "22".repeat(32), requestSha256: "33".repeat(32), checkpointSha256: "44".repeat(32), runtimeBundleSha256: "55".repeat(32),
  maxInputBytes: 1, maxOutputBytes: 10, maxInventoryEntries: 20 };
const reply = { schemaVersion: REMOTE_WORKER_RUNTIME_REQUEST_PAGE_SCHEMA, registryWorkspaceId: "registry", assignmentId: "assignment", assignmentGeneration: 1,
  leaseRevision: 1, submission, expectation, totalBytes: REMOTE_WORKER_RUNTIME_REQUEST_MAX_BYTES, jsonSha256: "66".repeat(32), bytesHex: "ab".repeat(32768) };
describe("bounded native request pages", () => {
  it("rejects every ASCII control character in scope identifiers", () => {
    for (const field of ["registryWorkspaceId", "assignmentId"]) {
      for (const code of [...Array.from({ length: 32 }, (_, index) => index), 127])
        expect(() => page({ ...reply, [field]: `scope${String.fromCharCode(code)}` })).toThrow();
      expect(page({ ...reply, [field]: "scope é" })).toHaveProperty(field, "scope é");
    }
  });
  it("requires a complete approved continuation when supplied", () => {
    const continuation = { schemaVersion: "goatcitadel.remote-worker-native-continuation.v1", assignmentGeneration: 1,
      resumeSha256: "11".repeat(32), approvalId: "approval", approvalSha256: "22".repeat(32), nativeRuntimeBindingSha256: "33".repeat(32), decision: "approved" };
    expect(normalize({ ...submission, continuation }).continuation).toEqual(continuation);
    for (const invalid of [undefined, null, {}, { ...continuation, decision: "rejected" }, { ...continuation, command: "hidden" }])
      expect(() => normalize({ ...submission, continuation: invalid })).toThrow();
  });
  it("permits discovery only on the first page and keeps responses below the unchanged envelope ceiling", () => {
    const first = page(reply); expect(Object.isFrozen(first)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(256 * 1024);
    const bound = { ...submission, offset: 32768, nonce: expectation.nonce, requestSha256: expectation.requestSha256 };
    expect(page({ ...reply, submission: bound }).submission).toEqual(bound);
  });
  it.each([{ offset: 32768 }, { offset: -1 }, { offset: 1 }, { offset: REMOTE_WORKER_RUNTIME_REQUEST_MAX_BYTES },
    { nonce: expectation.nonce }, { approved: true }, { request: {} }, { challenge: "0".repeat(64) }])("refuses malformed selectors %j", patch => {
    expect(() => normalize({ ...submission, ...patch })).toThrow();
  });
  it.each([{ totalBytes: REMOTE_WORKER_RUNTIME_REQUEST_MAX_BYTES + 1 }, { bytesHex: "ab".repeat(32769) },
    { bytesHex: "ab" }, { leaseRevision: 0 }, { jsonSha256: "bad" }])("refuses invalid page bounds %j", patch => {
    expect(() => page({ ...reply, ...patch })).toThrow();
  });
  it("requires exact bytes on the final page and the admitted binding on later pages", () => {
    const last = { ...submission, offset: 32768, nonce: expectation.nonce, requestSha256: expectation.requestSha256 };
    expect(page({ ...reply, submission: last, totalBytes: 32769, bytesHex: "ab" }).bytesHex).toBe("ab");
    expect(() => page({ ...reply, submission: { ...last, nonce: "ff".repeat(32) } })).toThrow();
    expect(() => page({ ...reply, submission: last, totalBytes: 32769, bytesHex: "abcd" })).toThrow();
  });
  it("refuses accessor-backed selectors without invoking them", () => {
    const input = { ...submission }; Object.defineProperty(input, "offset", { enumerable: true, get() { throw new Error("getter invoked"); } });
    expect(() => normalize(input)).toThrow("binding is invalid");
  });
});
