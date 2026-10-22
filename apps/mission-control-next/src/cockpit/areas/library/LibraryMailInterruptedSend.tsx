import type { ReactNode } from "react";
import type { MailDraftRecord } from "@goatcitadel/contracts";
import { releaseMailDraft } from "@goatcitadel/mission-control-shared/api/personal-ops";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { plural } from "@goatcitadel/mission-control-shared/content/format";
import { useSessionViewState } from "../../../hooks/use-session-view-state";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";

const INTERRUPTED_SEND =
  "This send request was interrupted before its approval was recorded. Nothing was sent. After a short safety wait, GoatCitadel can check for a recorded approval and release this draft so you can request one again.";
const NOTHING_TO_RELEASE =
  "Nothing to release: this draft is no longer waiting on an interrupted send request. Check Inbox for its approval.";

/** What the compose does next after asking the Gateway to release an interrupted draft. */
export type InterruptedSendStep =
  | { kind: "wait"; text: string }
  | { kind: "review"; draft: MailDraftRecord; text: string }
  | { kind: "receipt"; draft: MailDraftRecord }
  | { kind: "nothing"; text: string };

/**
 * Asks the Gateway to recover an interrupted send. It re-links an approval that did persist, or
 * releases the draft for one new request only when none exists; it never sends anything.
 */
export async function releaseInterruptedSend(
  record: MailDraftRecord,
  workspaceId: string,
): Promise<InterruptedSendStep> {
  const result = await releaseMailDraft(record.draftId, workspaceId);
  if (result.draft.draftId !== record.draftId) throw new Error("The release names a different draft.");
  if (result.outcome === "too_recent") {
    const minutes = Math.max(1, Math.ceil((result.retryAfterSeconds ?? 60) / 60));
    return {
      kind: "wait",
      text: `The interrupted request may still be finishing. Try again in about ${plural(minutes, "minute")}.`,
    };
  }
  // A draft already back in "draft" (this release, or an earlier one whose response was lost) is reviewable.
  if (result.draft.status === "draft") {
    return {
      kind: "review",
      draft: result.draft,
      text: "No send approval was recorded for this draft, so it was released. Review it and request send approval again.",
    };
  }
  if (result.draft.status === "approval_required" && result.draft.approvalId) {
    return { kind: "receipt", draft: result.draft };
  }
  return { kind: "nothing", text: NOTHING_TO_RELEASE };
}

type Outcome = { error: boolean; text: string };

type Options<T extends { record: MailDraftRecord }> = {
  stateKey: string;
  workspaceId: string;
  available: boolean;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  current: () => boolean;
  setOutcome: (outcome: Outcome | undefined) => void;
  /** The draft is back in `draft`: reopen review so one new approval can be requested. */
  onReleased: (target: T, draft: MailDraftRecord) => void;
  /** The approval that did persist is now linked: show its receipt. */
  onRelinked: (target: T, draft: MailDraftRecord) => Promise<unknown>;
};

/**
 * Holds a send request interrupted before its approval id was recorded (session view state) and
 * recovers it only on an explicit operator release. Returns `interrupt` and the panel to render.
 */
export function useInterruptedSend<T extends { record: MailDraftRecord }>(options: Options<T>) {
  const [interrupted, setInterrupted] = useSessionViewState<T | undefined>(options.stateKey, undefined);
  const { busy, available, current, setBusy, setOutcome } = options;

  async function release() {
    const target = interrupted;
    if (!target || busy || !available || !current()) return;
    setBusy(true);
    setOutcome(undefined);
    try {
      const step = await releaseInterruptedSend(target.record, options.workspaceId);
      if (!current()) return;
      if (step.kind !== "wait") setInterrupted(undefined);
      if (step.kind === "receipt") {
        await options.onRelinked(target, step.draft);
        return;
      }
      setOutcome({ error: false, text: step.text });
      if (step.kind === "review") options.onReleased(target, step.draft);
    } catch (cause) {
      // A failed request may still have reached the Gateway, so neither outcome is claimed.
      if (current())
        setOutcome({
          error: true,
          text: `${describeApiError(cause).summary} The release was not confirmed. Check again to see where this draft stands.`,
        });
    } finally {
      if (current()) setBusy(false);
    }
  }

  const panel: ReactNode = interrupted ? (
    <section className="grid min-w-0 grid-cols-1 gap-2" aria-label="Interrupted send request">
      <Callout tone="warning">{INTERRUPTED_SEND}</Callout>
      <p className="wrap-anywhere text-sm">
        To {interrupted.record.to.join(", ")} · {interrupted.record.subject}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy || !available} onClick={() => void release()}>
          Check and release draft
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => setInterrupted(undefined)}>
          Dismiss
        </Button>
      </div>
    </section>
  ) : null;

  return { interrupt: (target: T) => setInterrupted(target), panel };
}
