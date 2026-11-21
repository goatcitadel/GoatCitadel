import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import type { PromptPackRunRecord } from "@goatcitadel/contracts";
import { selectPromptPackWatchBinding } from "./prompt-pack-watch-evidence.js";
const binding = {
  activationId: "watch",
  revisionId: "revision",
  changeHash: "a".repeat(64),
  workspaceId: "prompt-lab",
  fingerprint: "prompt-lab|routing|pack:routing",
  capability: "routing",
  capturedAt: "2026-11-19T00:00:02.000Z",
};
function run(id: string, startedAt: string, finishedAt: string): PromptPackRunRecord {
  return {
    runId: id,
    packId: "pack",
    testId: "test",
    status: "completed",
    providerId: "provider",
    model: "model",
    startedAt,
    finishedAt,
    responseText: "Verified source result",
    trace: {
      status: "completed",
      completion: { status: "complete", providerCallCount: 1, repaired: false },
    } as PromptPackRunRecord["trace"],
    integrity: {
      validationStatus: "valid",
      signals: [],
      responseChecksumSha256: createHash("sha256").update("Verified source result").digest("hex"),
    },
  };
}
function fixture() {
  const baseline = run("before", "2026-11-19T00:00:00.000Z", "2026-11-19T00:00:01.000Z"),
    current = {
      ...run("after", "2026-11-19T00:00:03.000Z", "2026-11-19T00:00:04.000Z"),
      improvementWatchBindings: [binding],
    };
  return { baseline, current, capability: "routing", workspaceId: "prompt-lab", fingerprint: binding.fingerprint };
}
it("uses only the exact saved pre-work binding and full response integrity from an independent matched run pair", () => {
  expect(selectPromptPackWatchBinding(fixture())).toEqual(binding);
});
it.each([
  "legacy",
  "post_work",
  "changed_hash",
  "same_run",
  "foreign_test",
  "foreign_scope",
  "model_mismatch",
  "fallback_model",
  "failed",
  "partial",
  "corrupt_output",
  "baseline_not_finished",
])("does not attribute %s work to a change", (reason) => {
  const f = fixture();
  if (reason === "legacy") f.current.improvementWatchBindings = [];
  if (reason === "post_work")
    f.current.improvementWatchBindings = [{ ...binding, capturedAt: "2026-11-19T00:00:05.000Z" }];
  if (reason === "changed_hash") f.current.improvementWatchBindings = [{ ...binding, changeHash: "partial" }];
  if (reason === "same_run") f.baseline.runId = f.current.runId;
  if (reason === "foreign_test") f.baseline.testId = "foreign";
  if (reason === "foreign_scope") f.workspaceId = "foreign";
  if (reason === "model_mismatch") f.baseline.model = "other";
  if (reason === "fallback_model")
    f.current.trace = {
      ...f.current.trace!,
      routing: { effectiveProviderId: "other", effectiveModel: "other" } as never,
    };
  if (reason === "failed") f.current.status = "failed";
  if (reason === "partial")
    f.current.trace = { ...f.current.trace!, completion: { status: "partial", providerCallCount: 1, repaired: false } };
  if (reason === "corrupt_output") f.current.responseText = "Changed after scoring";
  if (reason === "baseline_not_finished") f.baseline.finishedAt = "2026-11-19T00:00:03.500Z";
  expect(selectPromptPackWatchBinding(f)).toBeUndefined();
});
