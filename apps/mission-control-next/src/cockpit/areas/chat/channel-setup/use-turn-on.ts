import { useCallback, useEffect, useRef, useState } from "react";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { acknowledgeCleanupAndTurnOn, turnOnChannelDraft, type TurnOnOutcome } from "./turn-on-channel";

export type TurnOnPhase = "idle" | "working" | "done" | "cleanup" | "blocked" | "elsewhere" | "failed";

export interface TurnOnInput {
  draftId: string;
  catalogId: string;
  requiredHosts: readonly string[];
  /** The missing hosts the step listed: Turn on adds no other. */
  shownHosts: readonly string[];
}

export interface TurnOnState {
  state: TurnOnPhase;
  /** Why it failed, in plain words. */
  message?: string;
  /** The approval to decide in Inbox, when that is the next step. */
  approvalId?: string;
  /** The change to review in Inbox, when this page didn't make it and it waits on no approval. */
  reviewPlanId?: string;
  /** What stops the setup being turned on, one reason each. */
  reasons: readonly string[];
  turnOn(input: TurnOnInput): Promise<void>;
  /** The operator said the test message left in their chat is fine: go on without testing again. */
  acknowledgeCleanup(): Promise<void>;
}

type Shown = Pick<TurnOnState, "state" | "message" | "approvalId" | "reviewPlanId" | "reasons">;
type Target = Pick<TurnOnInput, "draftId" | "catalogId">;

const IDLE: Shown = { state: "idle", reasons: [] };
const WORKING: Shown = { state: "working", reasons: [] };
const CLEANUP: Shown = { state: "cleanup", reasons: [] };

/** What the page shows for an outcome that ended the click. */
function shown(outcome: Exclude<TurnOnOutcome, { kind: "needs_cleanup_ack" }>): Shown {
  switch (outcome.kind) {
    case "completed":
      return { state: "done", reasons: [] };
    case "elsewhere":
      if (outcome.approvalId) return { state: "elsewhere", reasons: [], approvalId: outcome.approvalId };
      return { state: "elsewhere", reasons: [], ...(outcome.inInbox ? { reviewPlanId: outcome.plan.planId } : {}) };
    case "failed":
      return { state: "failed", message: outcome.message, reasons: [] };
    case "blocked":
      return { state: "blocked", reasons: outcome.reasons };
  }
}

/**
 * Turning a finished setup on, one click at a time. A click while one is working is ignored, an answer that arrives
 * after the page has gone or the workspace has changed is dropped, and a test message that could not be removed waits
 * for the operator to say it is fine before the change goes ahead. `setupId` names the setup being turned on: a
 * different one starts clean, so what happened to the last one is never shown against the next.
 */
export function useTurnOn(workspaceId: string, setupId?: string): TurnOnState {
  const [view, setView] = useState<Shown>(IDLE);
  // Read between renders: two clicks in one moment must both see "it is working".
  const working = useRef(false);
  // The test message waiting to be called fine, and what it was sent for.
  const waiting = useRef<(Target & { evidenceId: string }) | null>(null);
  // Counts workspaces and unmounts, so an answer to a call made earlier is dropped.
  const epoch = useRef(0);

  useEffect(() => {
    epoch.current += 1;
    working.current = false;
    waiting.current = null;
    setView(IDLE);
    return () => {
      epoch.current += 1;
    };
  }, [workspaceId, setupId]);

  /** Runs one call to its end: "working" meanwhile and the outcome after, unless the page has moved on. */
  const run = useCallback(async (target: Target, call: () => Promise<TurnOnOutcome>) => {
    const mine = epoch.current;
    working.current = true;
    setView(WORKING);
    let outcome: TurnOnOutcome;
    try {
      outcome = await call();
    } catch (error) {
      outcome = { kind: "failed", message: describeApiError(error).summary };
    }
    if (epoch.current !== mine) return;
    working.current = false;
    if (outcome.kind === "needs_cleanup_ack") {
      waiting.current = { ...target, evidenceId: outcome.evidenceId };
      setView(CLEANUP);
      return;
    }
    waiting.current = null;
    setView(shown(outcome));
  }, []);

  const turnOn = useCallback(
    async ({ draftId, catalogId, requiredHosts, shownHosts }: TurnOnInput) => {
      if (working.current) return;
      await run({ draftId, catalogId }, () =>
        turnOnChannelDraft({ workspaceId, draftId, catalogId, requiredHosts, shownHosts }),
      );
    },
    [run, workspaceId],
  );

  const acknowledgeCleanup = useCallback(async () => {
    const pending = waiting.current;
    if (!pending || working.current) return;
    const { evidenceId, ...target } = pending;
    await run(target, () => acknowledgeCleanupAndTurnOn({ workspaceId, ...target, evidenceId }));
  }, [run, workspaceId]);

  return { ...view, turnOn, acknowledgeCleanup };
}
