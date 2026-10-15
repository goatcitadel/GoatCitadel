import type { PromptPackRunRecord, PromptPackTestRecord } from "@goatcitadel/contracts";
import type { AsyncStorage as Storage } from "@goatcitadel/storage";
export interface PromptPackFocusedReportReadContext {
  readonly storage: Pick<
    Storage,
    "promptPackRuns" | "promptPacks" | "promptPackAutoScoresV2" | "promptPackHumanReviewsV2" | "promptPackScores"
  >;
}
export async function loadPromptPackReportFocus(
  ctx: PromptPackFocusedReportReadContext,
  packId: string,
  focus: { runId: string; sessionId?: string } | undefined,
): Promise<{ focusedRunRecord?: PromptPackRunRecord; focusedTest?: PromptPackTestRecord }> {
  const focusedRunRecord = focus ? await ctx.storage.promptPackRuns.get(focus.runId) : undefined;
  if (focus && !focusedRunRecord) throw new Error("Requested run is unavailable for this prompt pack and session.");
  if (
    focusedRunRecord &&
    (focusedRunRecord.packId !== packId ||
      (focus?.sessionId !== undefined && focusedRunRecord.sessionId !== focus.sessionId))
  ) {
    throw new Error("Requested run is unavailable for this prompt pack and session.");
  }
  const focusedTest = focusedRunRecord ? await ctx.storage.promptPacks.getTest(focusedRunRecord.testId) : undefined;
  if (focusedRunRecord && !focusedTest)
    throw new Error("Requested run is unavailable for this prompt pack and session.");
  if (focusedTest && (focusedTest.packId !== packId || focusedTest.testId !== focusedRunRecord!.testId)) {
    throw new Error("Requested run is unavailable for this prompt pack and session.");
  }
  return { focusedRunRecord, focusedTest };
}
export function loadPromptPackFocusedAssessmentEvidence(
  ctx: PromptPackFocusedReportReadContext,
  focusedRunRecord: PromptPackRunRecord,
) {
  return Promise.all([
    ctx.storage.promptPackAutoScoresV2.listByRun(focusedRunRecord.runId, 1),
    ctx.storage.promptPackHumanReviewsV2.listByRun(focusedRunRecord.runId, 1),
    ctx.storage.promptPackScores.listByRun(focusedRunRecord.runId, 1),
  ]);
}
