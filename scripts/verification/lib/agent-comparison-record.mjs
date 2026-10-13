import { ComparisonDispatchBudget, sha256, summarizeComparison } from "./agent-comparison.mjs";
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
  pilotJournal,
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
    allowZeroCost: manifest.transportProfile?.kind === "local",
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
  if (["unsupported", "blocked"].includes(verification.outcome) && calls.length > 0)
    throw new Error("A no-call acceptance disposition cannot hide already dispatched provider attempts.");
  const pilotAccounting = manifest.pilotBudget || manifest.localPilotBudget
    ? verifyPilotAccounting(manifest, pilotJournal, cellKey(cell), calls)
    : undefined;
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
    ...(pilotAccounting ? { pilotAccounting } : {}),
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

export function verifyPilotAccounting(manifest, journal, cellId, calls) {
  const policy = manifest.pilotBudget ?? manifest.localPilotBudget;
  if (
    !policy ||
    journal?.pilotId !== policy.pilotId ||
    (manifest.localPilotBudget && journal.budgetTrack !== "local") ||
    journal.pilotBudgetSha256 !== sha256(policy) ||
    !Array.isArray(journal.events)
  )
    throw new Error("The complete shared pilot journal must bind the declared track.");
  if (
    journal.events.some(
      (event) => !/^[a-f0-9]{64}:(?:goatcitadel|openclaw|hermes):[a-z_]+:[1-9][0-9]*$/u.test(event.cellId),
    )
  )
    throw new Error("Shared pilot journal contains an invalid campaign cell.");
  const budget = new ComparisonDispatchBudget({
    ...policy,
    allowZeroCost: Boolean(manifest.localPilotBudget),
    events: journal.events,
    persist: async () => {
      throw new Error("Evidence verification cannot dispatch.");
    },
  });
  const snapshot = budget.snapshot();
  const matching = snapshot.receipts.filter((entry) => entry.cellId === `${manifest.manifestSha256}:${cellId}`);
  if (
    matching.length !== calls.length ||
    matching.some((entry, index) =>
      ["role", "maximumCostUsd", "costUsd", "state"].some((key) => entry[key] !== calls[index][key]),
    )
  )
    throw new Error("Cell accounting does not match the shared pilot reservations and settlements.");
  return {
    pilotId: policy.pilotId,
    pilotBudgetSha256: sha256(policy),
    journalSha256: sha256(journal),
    requests: snapshot.requests,
    committedOrReservedUsd: snapshot.committedOrReservedUsd,
    unsettledRequests: snapshot.receipts.filter((entry) => entry.state !== "settled").length,
  };
}

function cellKey(cell) {
  return `${cell.product}:${cell.task}:${cell.trial}`;
}
