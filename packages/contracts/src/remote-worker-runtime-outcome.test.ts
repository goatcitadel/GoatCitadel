import { describe, expect, it } from "vitest";
import { normalizeRemoteWorkerRuntimeOutcomeExchange as normalize, normalizeRemoteWorkerRuntimeOutcomeSubmission,
  projectRemoteWorkerRuntimeOutcome, REMOTE_WORKER_RUNTIME_OUTCOME_SCHEMA } from "./remote-worker-runtime-outcome.js";
import { readRemoteWorkerRuntimeResult } from "./remote-worker-runtime-result.js";
import { runtimeResultPagesFixture } from "./remote-worker-runtime-result-pages-test-fixture.js";
function fixture() {
  const f = runtimeResultPagesFixture(2);
  return { schemaVersion: REMOTE_WORKER_RUNTIME_OUTCOME_SCHEMA, challenge: "cc".repeat(32), lookup: f.response(null, true),
    outcome: projectRemoteWorkerRuntimeOutcome(readRemoteWorkerRuntimeResult(f.resultHex, f.expectation, f.history)) };
}
describe("bounded retained native outcome", () => {
  it.each(["exited", "cancelled", "wall_limit", "output_limit", "launch_failed", "control_failed"] as const)("preserves %s without inferring success", end => {
    const f = fixture(); f.outcome = { ...f.outcome, end };
    const result = normalize(f);
    expect(result.outcome!.end).toBe(end); expect(result.outcome!.exitCode).toBe(23);
    expect(Object.isFrozen(result.outcome!.checks)).toBe(true);
  });
  it.each([{ exitCode: -1 }, { error: 0x100000000 }, { stdoutBytes: 67108864, stderrBytes: 1 },
    { stdinBytes: 1048577 }, { inventoryEntries: 20001 }, { inventoryEntries: null }, { completed: true }, { end: "success" }])("refuses invalid facts %j", patch => {
    const f = fixture(); expect(() => normalize({ ...f, outcome: { ...f.outcome, ...patch } })).toThrow();
  });
  it("requires absence to agree with the canonical receipt", () => {
    const f = fixture();
    expect(() => normalize({ ...f, outcome: null })).toThrow();
    expect(() => normalize({ ...f, lookup: { ...f.lookup, record: null } })).toThrow();
    expect(normalize({ ...f, lookup: { ...f.lookup, record: null }, outcome: null }).outcome).toBeNull();
  });
  it("refuses hidden fields and getters without invoking them", () => {
    const f = fixture(); let reads = 0;
    expect(() => normalize({ ...f, outcome: { ...f.outcome, get exitCode() { reads += 1; return 0; } } })).toThrow();
    expect(reads).toBe(0);
    expect(() => normalize(Object.assign(f, { [Symbol("extra")]: true }))).toThrow();
  });
  it("binds exact lookup fields and a fresh nonzero challenge", () => {
    const f = fixture(), submission = { kind: "runtime.outcome.read", nonce: f.lookup.nonce, requestSha256: f.lookup.requestSha256, challenge: f.challenge };
    expect(normalizeRemoteWorkerRuntimeOutcomeSubmission(submission)).toEqual(submission);
    for (const patch of [{ challenge: "00".repeat(32) }, { nonce: "00".repeat(32) }, { command: "hidden" }, { kind: "runtime.execute" }])
      expect(() => normalizeRemoteWorkerRuntimeOutcomeSubmission({ ...submission, ...patch })).toThrow();
  });
});
