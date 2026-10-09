import { captureMutationAttempt, getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { withFreshReads } from "@goatcitadel/mission-control-shared/api/fresh-reads";
import {
  classifyMutationAttempt,
  fetchMutationAttempt,
  matchRoutePattern,
  type MutationAttemptVerdict,
} from "@goatcitadel/mission-control-shared/api/mutation-attempts";

export type AttemptMethod = "POST" | "PATCH" | "PUT" | "DELETE";
/** The identity of one owner write (never its body), enough to read the Gateway's record of that exact attempt. */
export interface TrackedAttempt {
  attemptKey: string;
  method: AttemptMethod;
  routePattern: string;
  /** The Gateway installation the attempt was sent to; its record can only be read there. */
  installation?: string;
}
const ATTEMPT_METHODS = new Set<string>(["POST", "PATCH", "PUT", "DELETE"]);

/**
 * Dispatches one owner write and reports which attempt it was. `onTracked(undefined)` runs first, so a write the
 * capture cannot identify (or one on a route outside `patterns`) never inherits an earlier write's identity.
 */
export function dispatchTrackedMutation<T>(
  patterns: readonly string[],
  dispatch: () => Promise<T>,
  onTracked: (attempt: TrackedAttempt | undefined) => void,
): Promise<T> {
  onTracked(undefined);
  return captureMutationAttempt(dispatch, (attempt) => {
    const routePattern = matchRoutePattern(attempt.path, patterns);
    onTracked(
      routePattern && ATTEMPT_METHODS.has(attempt.method)
        ? {
            attemptKey: attempt.attemptKey,
            method: attempt.method as AttemptMethod,
            routePattern,
            ...(attempt.installation ? { installation: attempt.installation } : {}),
          }
        : undefined,
    );
  });
}

/** What an owner tells the operator while a lost attempt is still unsettled. */
export const UNSETTLED_ATTEMPT_MESSAGES: Partial<Record<MutationAttemptVerdict, string>> = {
  in_progress: "The Gateway is still running this change. Changes stay locked; check again shortly.",
  unknown:
    "The Gateway's claim on this change expired without a recorded outcome. Changes stay locked in this app session; inspect the owner's activity.",
  resend_same_key:
    "The Gateway has no record of this change yet, so it may still arrive. Changes stay locked; check again shortly. If this persists, verify the current settings, then reload the app.",
};

export type AttemptSettlement = { settled: boolean; message: string };
/** Shown when a check is attempted while connected to a different Gateway than the attempt was sent to. */
export const OTHER_GATEWAY =
  "The Gateway connection changed to a different Gateway, so this outcome was not checked. Return to the original Gateway to check it.";

/**
 * Whether the app is still connected to the installation an attempt was sent to. Owners check it before the attempt
 * read and again after every await, because the operator can switch Gateway while a check is running.
 */
export function sentToConnectedGateway(attempt: { installation?: string }): boolean {
  return !attempt.installation || attempt.installation === getGatewayApiBaseUrl();
}

/**
 * Reads the Gateway's record of one lost attempt. Only a committed or released attempt settles, and only after the
 * owner's canonical `readback` succeeds; a released attempt is not proof that nothing was applied. Anything still
 * running, unknown, absent or unreadable does not settle. Messages are fixed copy, never Gateway text.
 */
export async function settleTrackedAttempt(
  transport: TrackedAttempt,
  readback: () => Promise<unknown>,
  subject: string,
): Promise<AttemptSettlement> {
  // The record of an attempt lives on the installation it was sent to; never ask, replay or read back elsewhere.
  if (!sentToConnectedGateway(transport)) return { settled: false, message: OTHER_GATEWAY };
  try {
    const verdict = classifyMutationAttempt(
      await fetchMutationAttempt(transport.attemptKey, transport.method, transport.routePattern),
    );
    if (!sentToConnectedGateway(transport)) return { settled: false, message: OTHER_GATEWAY };
    if (verdict !== "committed" && verdict !== "failed_confirm_by_readback")
      return { settled: false, message: UNSETTLED_ATTEMPT_MESSAGES[verdict] ?? "The outcome is still unknown." };
    // A readback must observe state after the write; it may not join a read that started before the commit.
    await withFreshReads(readback);
    // A readback from a Gateway the operator switched to is not evidence about this attempt.
    if (!sentToConnectedGateway(transport)) return { settled: false, message: OTHER_GATEWAY };
    return {
      settled: true,
      message:
        verdict === "committed"
          ? `The Gateway recorded this ${subject} as processed; it may be applied or still awaiting approval. Current settings were read back; review them and Settings activity before another change.`
          : `The Gateway released this ${subject} attempt after an error. Current settings were read back; review them and Settings activity before another change, because part of it may still have been applied or be awaiting approval.`,
    };
  } catch {
    return {
      settled: false,
      message: `The outcome check failed, so this ${subject} stays locked. Check again, or inspect Settings activity.`,
    };
  }
}
