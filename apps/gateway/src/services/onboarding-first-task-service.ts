import type { OnboardingFirstTaskEvidence, OnboardingState } from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";

/** Bounded, read-only projection. No client, demo, or catalog result can mark a task verified. */
export async function readOnboardingFirstTaskEvidence(
  storage: Pick<AsyncStorage, "chatTurnTraces" | "chatMessages">,
  state: OnboardingState,
): Promise<OnboardingFirstTaskEvidence> {
  const checkedAt = new Date().toISOString();
  if (!state.completedAt) return { status: "not_observed", checkedAt };
  let after: { startedAt: string; turnId: string } | undefined;
  for (;;) {
    const traces = after
      ? await storage.chatTurnTraces.listCompletedSince(state.completedAt, 1000, after)
      : await storage.chatTurnTraces.listCompletedSince(state.completedAt, 1000);
    for (const trace of traces) {
      const providerId = trace.routing.effectiveProviderId;
      const model = trace.routing.effectiveModel ?? trace.model;
      if (
        trace.status !== "completed" ||
        trace.completion?.status !== "complete" ||
        !(Number(trace.completion.providerCallCount) > 0) ||
        trace.failure ||
        trace.completion.failedFileMutations?.length ||
        !trace.finishedAt ||
        !trace.assistantMessageId ||
        !providerId ||
        !model
      )
        continue;
      const message = await storage.chatMessages.get(trace.assistantMessageId);
      if (message?.role !== "assistant" || message.sessionId !== trace.sessionId || !message.content.trim()) continue;
      return {
        status: "verified",
        checkedAt,
        completedAt: trace.finishedAt,
        sessionId: trace.sessionId,
        turnId: trace.turnId,
        providerId,
        model,
      };
    }
    if (traces.length < 1000) break;
    const last = traces[traces.length - 1]!;
    after = { startedAt: last.startedAt, turnId: last.turnId };
  }
  return { status: "not_observed", checkedAt };
}
