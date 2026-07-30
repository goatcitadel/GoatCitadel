import path from "node:path";

import { assertArtifactRedactionGate } from "../../../verify-artifact-redaction.mjs";
import { writeJson } from "../shared.mjs";
import {
  assertUsabilitySourceState,
  assertUsabilitySourceStateUnchanged,
  snapshotUsabilitySourceState,
} from "./usability-source-state.mjs";

export function beginUsabilitySourceGuard(repoRoot, requestedMode, deps = {}) {
  const snapshotSourceState = deps.snapshotUsabilitySourceState ?? snapshotUsabilitySourceState;
  const sourceState = snapshotSourceState(repoRoot, requestedMode);
  assertUsabilitySourceState(sourceState);
  return sourceState;
}

export async function completeUsabilityFinalIntegrity(context, startedSourceState, deps = {}) {
  const scanArtifactRoot = deps.assertArtifactRedactionGate ?? assertArtifactRedactionGate;
  const snapshotSourceState = deps.snapshotUsabilitySourceState ?? snapshotUsabilitySourceState;
  const persistJson = deps.writeJson ?? writeJson;
  const sourceRepoRoot = deps.repoRoot ?? context.repoRoot;
  if (typeof context?.artifactRoot !== "string" || context.artifactRoot.trim().length === 0) {
    throw new Error("usability final integrity requires the exact artifact root");
  }
  if (typeof sourceRepoRoot !== "string" || sourceRepoRoot.trim().length === 0) {
    throw new Error("usability final integrity requires the source repository root");
  }
  assertUsabilitySourceState(startedSourceState);

  const completedSourceState = snapshotSourceState(sourceRepoRoot, startedSourceState.mode);
  const sourceStatePath = path.join(context.artifactRoot, "diagnostics", "usability-source-state.json");
  await persistJson(sourceStatePath, {
    schemaVersion: 1,
    started: startedSourceState,
    completed: completedSourceState,
  });

  // Bind the leak check to this run's immutable context instead of the mutable
  // latest-run pointer. Persist the completed source proof first so the exact
  // artifact tree handed off is the tree inspected by the final redaction gate.
  await scanArtifactRoot(context.artifactRoot);

  assertUsabilitySourceStateUnchanged(startedSourceState, completedSourceState);

  return {
    artifactRoot: context.artifactRoot,
    completedSourceState,
    sourceStatePath,
  };
}

export function combineUsabilityPrimaryAndIntegrityErrors(primaryError, integrityError) {
  const primary = primaryError instanceof Error ? primaryError : new Error(String(primaryError));
  const safeIntegrityMessage = classifyUsabilityIntegrityFailure(integrityError);
  const safeIntegrityError = new Error(safeIntegrityMessage);
  return new AggregateError(
    [primary, safeIntegrityError],
    `${primary.message}\nSecondary usability final-integrity failure: ${safeIntegrityMessage}`,
    { cause: primary },
  );
}

function classifyUsabilityIntegrityFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/artifact redaction/iu.test(message)) {
    return "artifact redaction gate failed";
  }
  if (/usability source|source changed|final usability verification requires a clean source tree/iu.test(message)) {
    return "usability source integrity gate failed";
  }
  return "usability final integrity gate failed";
}
