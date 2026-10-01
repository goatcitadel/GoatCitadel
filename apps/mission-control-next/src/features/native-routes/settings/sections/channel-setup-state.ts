import { useSyncExternalStore } from "react";
import type { ChannelSetupDraft } from "@goatcitadel/contracts";
import { isApiRequestError } from "@goatcitadel/mission-control-shared/api/client";

type MutationState = { pending: boolean; uncertain?: string };
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
    async write<T>(dispatch: () => Promise<T>, validate: (value: T) => void, draftId?: string): Promise<T> {
      try {
        const result = await dispatch();
        validate(result);
        return result;
      } catch (cause) {
        if (!isChannelPrecommitConflict(cause, draftId))
          publish({
            pending: true,
            uncertain:
              "Outcome uncertain. Channel changes are locked in this app session. Refresh the Gateway records and inspect activity before another attempt. Your input is retained.",
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
export function isChannelPrecommitConflict(cause: unknown, draftId?: string) {
  if (!draftId || !isApiRequestError(cause) || cause.status !== 409 || !cause.body || typeof cause.body !== "object")
    return false;
  const body = cause.body as Record<string, unknown>;
  const details = body.details as Record<string, unknown> | undefined;
  return (
    body.code === "WRITE_CONFLICT" &&
    details?.draftId === draftId &&
    details.reason === "CHANNEL_DRAFT_REVISION_CONFLICT" &&
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
