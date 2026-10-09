import { useSyncExternalStore } from "react";
import type { ChannelSetupDraft } from "@goatcitadel/contracts";
import { isApiRequestError } from "@goatcitadel/mission-control-shared/api/client";
import { dispatchTrackedMutation, settleTrackedAttempt, type TrackedAttempt } from "../mutation-attempt-tracking";

/** `transport` identifies a lost write (key, method, route; never its body or credentials) so it can be settled. */
type MutationState = { pending: boolean; uncertain?: string; transport?: TrackedAttempt; checking?: boolean };
/** The Gateway routes the channel owners write through; a lost write on any other route is not checkable. */
export const CHANNEL_ROUTE_PATTERNS = [
  "/api/v1/channels/drafts",
  "/api/v1/channels/drafts/:draftId",
  "/api/v1/channels/drafts/:draftId/connection-review",
  "/api/v1/channels/drafts/:draftId/finalize",
  "/api/v1/channels/drafts/:draftId/test",
  "/api/v1/channels/drafts/:draftId/validate",
  "/api/v1/channels/drafts/:draftId/secure-fields",
  "/api/v1/channels/connections/:connectionId/repair-draft",
  "/api/v1/channels/connections/:connectionId/retest",
  "/api/v1/channels/connections/:connectionId/rotate-secret-draft",
  "/api/v1/integrations/connections/:connectionId",
  "/api/v1/integrations/connections/:connectionId/discord/reconnect",
  "/api/v1/integrations/connections/:connectionId/discord/pairings/:pairingId/approve",
  "/api/v1/integrations/connections/:connectionId/discord/pairings/:pairingId/revoke",
  "/api/v1/integrations/slack/oauth/start",
  "/api/v1/change-plans",
] as const;
const UNCERTAIN =
  "Outcome uncertain. Channel changes are locked in this app session. Refresh only inspects Gateway records; it cannot unlock an action without its receipt. Your input is retained.";
const idle: MutationState = { pending: false };
let state = idle;
let owner: symbol | undefined;
const listeners = new Set<() => void>();
function publish(next: MutationState) {
  state = next;
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Installation-wide, app-session admission shared by both shells. Never retains credentials. */
export function useChannelMutationState() {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => idle,
  );
}
export function beginChannelOperation() {
  if (state.pending || state.uncertain) return undefined;
  const token = Symbol("channel-operation");
  owner = token;
  publish({ pending: true });
  return {
    async write<T>(
      dispatch: () => Promise<T>,
      validate: (value: T) => void | Promise<void>,
      draftId?: string,
      connectionId?: string,
      expectedRevision?: number,
    ): Promise<T> {
      let transport: TrackedAttempt | undefined;
      try {
        const result = await dispatchTrackedMutation(CHANNEL_ROUTE_PATTERNS, dispatch, (tracked) => {
          transport = tracked;
        });
        await validate(result);
        return result;
      } catch (cause) {
        if (!isChannelPrecommitConflict(cause, draftId, connectionId, expectedRevision))
          publish({
            pending: true,
            uncertain: transport
              ? `${UNCERTAIN} Check its outcome to settle it from the Gateway's record of this attempt.`
              : UNCERTAIN,
            ...(transport ? { transport } : {}),
          });
        throw cause;
      }
    },
    finish() {
      if (owner === token) {
        owner = undefined;
        publish({ ...state, pending: false });
      }
    },
  };
}
export function readChannelMutationState() {
  return state;
}
/**
 * Settles the installation-wide channel lock from the Gateway's record of the lost write and the canonical channel
 * `readback` (drafts and connections). Only a committed or released attempt unlocks; anything else keeps the lock.
 */
export async function checkChannelOutcome(readback: () => Promise<unknown>) {
  const current = state;
  if (!current.uncertain || !current.transport || current.checking || current.pending) return undefined;
  const checking = { ...current, checking: true };
  publish(checking);
  const result = await settleTrackedAttempt(current.transport, readback, "channel change");
  if (state !== checking) return undefined;
  publish(result.settled ? idle : { ...current, uncertain: result.message });
  return result.settled ? result.message : undefined;
}
export function isChannelPrecommitConflict(cause: unknown, draftId?: string, connectionId?: string, expectedRevision?: number) {
  if (!draftId || !isApiRequestError(cause) || cause.status !== 409 || !cause.body || typeof cause.body !== "object")
    return false;
  const body = cause.body as Record<string, unknown>;
  const details = body.details as Record<string, unknown> | undefined;
  return (
    body.code === "WRITE_CONFLICT" &&
    ((details?.draftId === draftId && details.reason === "CHANNEL_DRAFT_REVISION_CONFLICT") ||
      (Boolean(connectionId) && Number.isSafeInteger(expectedRevision) &&
        details?.mutationPhase === "before_side_effects" && details.draftId === draftId &&
        details.draftRevision === expectedRevision && details.connectionId === connectionId &&
        details.reason === "CHANNEL_CONNECTION_REVIEW_REQUIRED")) &&
    body.committed !== true &&
    body.mutationCommitted !== true &&
    details.committed !== true &&
    details.mutationCommitted !== true
  );
}
export function assertChannelDraft(
  draft: ChannelSetupDraft,
  expected: { draftId?: string; catalogId: string; connectionId?: string },
  afterRevision?: number,
) {
  if (
    !draft?.draftId ||
    (expected.draftId && draft.draftId !== expected.draftId) ||
    draft.catalogId !== expected.catalogId ||
    draft.connectionId !== expected.connectionId ||
    !Number.isSafeInteger(draft.revision) ||
    draft.revision < 1 ||
    (afterRevision !== undefined && draft.revision <= afterRevision)
  )
    throw new Error(
      "The Gateway response did not identify the exact channel draft and revision. Refresh its owner evidence.",
    );
}
export function __resetChannelMutationStateForTests() {
  owner = undefined;
  publish(idle);
}
