import { ComparisonDispatchBudget, summarizeComparison } from "./agent-comparison.mjs";
import { verifyComparisonEvidence } from "./agent-comparison-verifiers.mjs";

/** Record only a freshly verified cell. Provider measurements come from the
 * complete campaign budget journal, not a model's claimed token count or cost.
 * Native receipts and the journal must remain in the adapter/operator's custody. */
export async function recordComparisonCell({
  manifest,
  taskId,
  trial,
  workspaceRoot,
  evidenceRoot,
  journal,
  measurements,
}) {
  summarizeComparison(manifest, []);
  if (journal?.manifestSha256 !== manifest.manifestSha256 || !Array.isArray(journal.events))
    throw new Error("The complete budget journal must bind the pinned campaign.");
  const knownCells = new Set(manifest.cells.map(cellKey));
  if (journal.events.some((event) => !knownCells.has(event.cellId)))
    throw new Error("Budget journal contains an unknown campaign cell.");
  const budget = new ComparisonDispatchBudget({
    maxRequests: manifest.maxRequests,
    maxCostUsd: manifest.maxCostUsd,
    persist: async () => {
      throw new Error("Recording evidence cannot dispatch or mutate the budget.");
    },
    events: journal.events,
  });
  const verification = await verifyComparisonEvidence({ taskId, workspaceRoot, evidenceRoot });
  const cell = manifest.cells.find(
    (item) => item.product === verification.product && item.task === taskId && item.trial === trial,
  );
  if (!cell) throw new Error("Verification does not match a declared comparison cell.");
  if (
    measurements?.manifestSha256 !== manifest.manifestSha256 ||
    measurements?.cellId !== cellKey(cell) ||
    measurements?.revision !== manifest.products[cell.product].revision ||
    measurements?.effectiveConfigSha256 !== cell.effectiveConfigSha256 ||
    measurements?.fixtureSha256 !== cell.fixtureSha256
  )
    throw new Error("Retained measurements must bind this revision, configuration, fixture, and trial.");
  if (
    !/^[A-Za-z0-9._:-]{1,128}$/u.test(verification.executionBinding.executionId ?? "") ||
    ["executionId", "manifestSha256", "cellId", "revision", "effectiveConfigSha256", "fixtureSha256"].some(
      (key) => verification.executionBinding[key] !== measurements[key],
    )
  )
    throw new Error("Measurements do not match the verified native execution binding.");
  const calls = budget.snapshot().receipts.filter((entry) => entry.cellId === cellKey(cell));
  const costUsd = calls.every((call) => call.state === "settled")
    ? calls.reduce((total, call) => total + call.costUsd, 0)
    : null;
  const receipt = {
    ...cell,
    manifestSha256: manifest.manifestSha256,
    revision: manifest.products[cell.product].revision,
    evidenceKind: verification.evidenceKind,
    outcome:
      verification.outcome === "passed" && (!calls.length || costUsd === null) ? "blocked" : verification.outcome,
    durationMs: measurements.durationMs,
    requests: calls.length,
    costUsd,
    manualInterventions: measurements.manualInterventions,
    timeToUsefulOutputMs: measurements.timeToUsefulOutputMs ?? null,
    inputTokens: measurements.inputTokens ?? null,
    outputTokens: measurements.outputTokens ?? null,
    repeatedCorrections: measurements.repeatedCorrections ?? null,
    permissionEvidence: verification.permissionEvidence,
    verifier: verification.verifier,
    verifierSha256: verification.verifierSha256,
    checks: verification.checks,
  };
  // Apply the exact same telemetry and evidence validation as the final report.
  summarizeComparison(manifest, [receipt]);
  return { receipt, verification, budgetSequences: calls.map((call) => call.sequence) };
}

function cellKey(cell) {
  return `${cell.product}:${cell.task}:${cell.trial}`;
}
