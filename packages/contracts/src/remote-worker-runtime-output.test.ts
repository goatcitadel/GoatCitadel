import { describe, expect, it } from "vitest";
import { sha256Hex } from "./sha256.js";
import { runtimeResultPagesFixture } from "./remote-worker-runtime-result-pages-test-fixture.js";
import { readRemoteWorkerRuntimeResult } from "./remote-worker-runtime-result.js";
import { projectRemoteWorkerRuntimeOutcome } from "./remote-worker-runtime-outcome.js";
import { REMOTE_WORKER_RUNTIME_OUTPUT_SCHEMA, normalizeRemoteWorkerRuntimeOutputEvidence,
  verifyRemoteWorkerRuntimeOutputEvidence, remoteWorkerRuntimeOutputEvidenceSha256 } from "./remote-worker-runtime-output.js";

function fixture() {
  const f = runtimeResultPagesFixture(2), receipt = f.response(null, true).record!;
  const outcome = { ...projectRemoteWorkerRuntimeOutcome(readRemoteWorkerRuntimeResult(f.resultHex, f.expectation, f.history)), stdoutBytes: 3 };
  const evidence = { schemaVersion: REMOTE_WORKER_RUNTIME_OUTPUT_SCHEMA, nonce: f.expectation.nonce,
    requestSha256: f.expectation.requestSha256, resultSha256: receipt.resultSha256,
    streams: { stdout: { bytes: 3, sha256: sha256Hex("ok\n"), text: "ok\n", truncated: false, provenance: "native_stream_local_diagnostic" as const },
      stderr: { bytes: 0, sha256: sha256Hex(""), text: "", truncated: false, provenance: "native_stream_local_diagnostic" as const } } };
  return { ...f, receipt, outcome, evidence };
}
describe("native output evidence", () => {
  it("binds immutable diagnostics to independently supplied result facts without changing nonzero exit status", () => {
    const f = fixture(), normalized = verifyRemoteWorkerRuntimeOutputEvidence(f.evidence, f.expectation, f.receipt, f.outcome);
    expect(normalized).toEqual(f.evidence); expect(f.outcome.exitCode).toBe(23);
    expect(Object.isFrozen(normalized.streams.stdout)).toBe(true);
    const hash = remoteWorkerRuntimeOutputEvidenceSha256(normalized);
    f.evidence.streams.stdout.text = "changed";
    expect(normalized.streams.stdout.text).toBe("ok\n");
    expect(remoteWorkerRuntimeOutputEvidenceSha256(normalized)).toBe(hash);
    expect(remoteWorkerRuntimeOutputEvidenceSha256(f.evidence)).not.toBe(hash);
  });
  it.each(["nonce", "request", "result", "stdout", "stderr", "limit", "capture", "drain", "quiescence"])("rejects mismatched %s authority", mode => {
    const f = fixture();
    if (mode === "nonce") f.evidence.nonce = "ff".repeat(32);
    if (mode === "request") f.evidence.requestSha256 = "ff".repeat(32);
    if (mode === "result") f.evidence.resultSha256 = "ff".repeat(32);
    if (mode === "stdout") f.outcome.stdoutBytes = 4;
    if (mode === "stderr") f.outcome.stderrBytes = 1;
    if (mode === "limit") f.expectation.maxOutputBytes = 2;
    const checks = { ...f.outcome.checks, ...(mode === "capture" ? { captureVerified: false } : {}),
      ...(mode === "drain" ? { outputDrained: false } : {}), ...(mode === "quiescence" ? { zeroProcessesVerified: false } : {}) };
    expect(() => verifyRemoteWorkerRuntimeOutputEvidence(f.evidence, f.expectation, f.receipt, { ...f.outcome, checks })).toThrow();
  });
  it.each(["extra", "partial", "getter", "bytes", "utf8", "empty-hash", "empty-text", "empty-truncation"])("rejects malformed %s evidence", mode => {
    const f = fixture();
    if (mode === "extra") Object.assign(f.evidence, { approved: true });
    if (mode === "partial") Reflect.deleteProperty(f.evidence.streams, "stderr");
    if (mode === "getter") Object.defineProperty(f.evidence.streams.stdout, "text", { get: () => { throw new Error("must not invoke getter"); }, enumerable: true });
    if (mode === "bytes") f.evidence.streams.stdout.bytes = -1;
    if (mode === "utf8") f.evidence.streams.stdout.text = "é".repeat(16385);
    if (mode === "empty-hash") f.evidence.streams.stderr.sha256 = "ff".repeat(32);
    if (mode === "empty-text") f.evidence.streams.stderr.text = "invented";
    if (mode === "empty-truncation") f.evidence.streams.stderr.truncated = true;
    expect(() => normalizeRemoteWorkerRuntimeOutputEvidence(f.evidence)).toThrow("output evidence");
  });
});
