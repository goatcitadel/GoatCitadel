import { fetchOpsQualitySnapshot } from "@goatcitadel/mission-control-shared/api/client";
import { nativeLoad, nativeLoadIssues, useAsyncLoad } from "../shared/native-helpers";
import { createUnavailableQualitySnapshot, qualitySnapshotIssues } from "./QualityDashboardRoutePage.helpers";

/** Bounded installation-wide stored evidence, with section failures kept explicit. */
export function useQualityDashboardSnapshot() {
  return useAsyncLoad(async () => {
    const snapshot = await nativeLoad(
      "Ops quality snapshot",
      fetchOpsQualitySnapshot({ packLimit: 200, evalLimit: 25 }),
      createUnavailableQualitySnapshot(),
    );
    const quality = snapshot.data;
    return {
      available: !snapshot.issue,
      issues: [...nativeLoadIssues([snapshot]), ...qualitySnapshotIssues(quality)],
      quality,
      packs: quality.promptPacks.items,
      evalRuns: quality.evalProof.items,
      securityEvalPacks: quality.securityEvalPacks.items,
      securityEvalWarnings: quality.securityEvalPacks.warnings,
      securityGates: quality.securityQualityGates.items,
      securityGateWarnings: quality.securityQualityGates.warnings,
      securityExecution: quality.securityExecution.items,
      securityExecutionWarnings: quality.securityExecution.warnings,
      designQuality: quality.designQuality,
    };
  }, []);
}
