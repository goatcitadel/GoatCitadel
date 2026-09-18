import { describe, expect, it } from "vitest";
import { normalizeRemoteWorkerRuntimeAuthorizationSubmission as normalize, normalizeRemoteWorkerRuntimeAuthorizationReceipt as receipt,
  REMOTE_WORKER_RUNTIME_AUTHORIZATION_SCHEMA_VERSION } from "./remote-worker-runtime-authorization.js";
const submission = { kind: "runtime.authorize", nonce: "11".repeat(32), requestSha256: "22".repeat(32), phase: "execution", challenge: "33".repeat(32) };
const expectation = { nonce: submission.nonce, requestSha256: submission.requestSha256, checkpointSha256: "44".repeat(32), runtimeBundleSha256: "55".repeat(32),
  maxInputBytes: 0, maxOutputBytes: 1000, maxInventoryEntries: 20 };
describe("native runtime authority wire contract", () => {
  it("rejects every ASCII control character in scope identifiers", () => {
    const valid = { schemaVersion: REMOTE_WORKER_RUNTIME_AUTHORIZATION_SCHEMA_VERSION, registryWorkspaceId: "registry", assignmentId: "assignment",
      assignmentGeneration: 1, leaseRevision: 1, submission, expectation };
    for (const field of ["registryWorkspaceId", "assignmentId"]) {
      for (const code of [...Array.from({ length: 32 }, (_, index) => index), 127])
        expect(() => receipt({ ...valid, [field]: `scope${String.fromCharCode(code)}` })).toThrow();
      expect(receipt({ ...valid, [field]: "scope é" })).toHaveProperty(field, "scope é");
    }
  });
  it("copies and freezes a bounded observation with no executable or approval input", () => {
    const input = { schemaVersion: REMOTE_WORKER_RUNTIME_AUTHORIZATION_SCHEMA_VERSION, registryWorkspaceId: "registry", assignmentId: "assignment",
      assignmentGeneration: 1, leaseRevision: 2, submission: { ...submission }, expectation: { ...expectation } };
    const result = receipt(input); input.expectation.maxOutputBytes = 2000;
    expect(result.expectation.maxOutputBytes).toBe(1000);
    expect(Object.isFrozen(result.submission)).toBe(true); expect(Object.isFrozen(result)).toBe(true);
    expect(JSON.stringify(result).length).toBeLessThan(2048);
  });
  it.each([{ approvalId: "approved" }, { approved: true }, { request: "executable" }, { challenge: "0".repeat(64) },
    { phase: "retain_and_execute" }, { nonce: "bad" }])("rejects unsupported authority fields %j", patch => {
    expect(() => normalize({ ...submission, ...patch })).toThrow();
  });
  it("never invokes accessors or accepts inherited fields", () => {
    const getter = () => { throw new Error("getter invoked"); };
    const input = { ...submission }; Object.defineProperty(input, "challenge", { enumerable: true, get: getter });
    expect(() => normalize(input)).toThrow("binding is invalid");
    expect(() => normalize(Object.create(submission))).toThrow();
  });
  it("refuses a receipt for different retained bytes", () => {
    expect(() => receipt({ schemaVersion: REMOTE_WORKER_RUNTIME_AUTHORIZATION_SCHEMA_VERSION, registryWorkspaceId: "registry", assignmentId: "assignment",
      assignmentGeneration: 1, leaseRevision: 1, submission, expectation: { ...expectation, requestSha256: "ff".repeat(32) } })).toThrow();
  });
});
