import { RESPONSIVE_QUERIES } from "@goatcitadel/mission-control-shared/hooks/responsive-breakpoints";
import type { ChatThreadTurnRecord } from "@goatcitadel/contracts";
import { canRetryTurn } from "@goatcitadel/mission-control-shared/components/chat/chat-display-helpers";
import { useMediaQuery } from "@goatcitadel/mission-control-shared/hooks/useMediaQuery";
import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import { Check, MoreHorizontal } from "lucide-react";
import { useState } from "react";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "../../ui/Menu";

export type TurnActionHandlers = Pick<
  MissionThreadedActiveSessionSurfaceProps,
  | "onRetryTurn"
  | "onStartNewThreadFromTurn"
  | "onSwitchBranch"
  | "onEditTurn"
  | "onOpenRunDetails"
  | "onCreateGeneratedArtifact"
>;

const INLINE = "inline-flex min-h-8 items-center px-1 text-accent hover:underline";
const PHONE =
  "inline-flex min-h-11 items-center rounded-md border border-line-control px-3 text-sm font-medium text-accent";

/**
 * Turn actions. On a phone, Retry and Copy stay as 44 px buttons and the rest move into a
 * "More" menu; wider screens use the same compressed action menu.
 */
export function ChatTurnActions({
  turn,
  actions,
  streaming,
  readOnly,
  hasAnswer,
  copied = false,
  onCopy,
}: {
  turn: ChatThreadTurnRecord;
  actions: TurnActionHandlers;
  streaming: boolean;
  readOnly: boolean;
  hasAnswer: boolean;
  /** The answer was just copied; the button briefly reads "Copied". */
  copied?: boolean;
  onCopy: () => void;
}) {
  const phone = useMediaQuery(RESPONSIVE_QUERIES.phone);
  const [confirmRetry, setConfirmRetry] = useState(false);
  const canRetry = canRetryTurn(turn) && !streaming && !readOnly;
  // Only a tool recorded as a read ("none") retries without asking. One that may write ("unknown"), has no recorded
  // potential, or did or might have changed something can change things again on retry, so that retry is confirmed.
  const effectfulTools = (turn.toolRuns ?? []).filter(
    (run) =>
      run.effectPotential !== "none" || run.effectOutcomeKind === "concrete" || run.effectOutcomeKind === "uncertain",
  ).length;
  const retry = () => actions.onRetryTurn(turn.turnId);
  const canBranch = !streaming && !readOnly;
  const canSave = Boolean(turn.assistantMessage) && turn.trace.status !== "failed" && !readOnly;
  const siblings = turn.branch.siblingTurnIds ?? [];
  const copyLabel = streaming ? "Copy answer so far" : "Copy answer";
  const secondary = [
    canBranch
      ? { label: "New conversation from here", run: () => actions.onStartNewThreadFromTurn(turn.turnId) }
      : null,
    canBranch ? { label: "Edit and resend", run: () => actions.onEditTurn(turn.turnId) } : null,
    { label: "Run details", run: () => actions.onOpenRunDetails(turn.turnId) },
    canSave ? { label: "Save answer", run: () => actions.onCreateGeneratedArtifact(turn.turnId) } : null,
  ].filter((item): item is { label: string; run: () => void } => Boolean(item));

  return (
    <div className={`flex flex-wrap items-center ${phone ? "gap-2" : "gap-x-2 gap-y-1"}`}>
      {canRetry ? (
        <button
          type="button"
          onClick={() => (effectfulTools ? setConfirmRetry(true) : retry())}
          className={phone ? PHONE : `${INLINE} font-medium`}
        >
          Retry
        </button>
      ) : null}
      {effectfulTools ? (
        <Dialog open={confirmRetry && canRetry} onOpenChange={setConfirmRetry} title="Retry this answer?">
          <p className="mb-3 text-sm text-fg-secondary">
            {effectfulTools === 1
              ? "1 tool in this answer may change things outside the chat."
              : `${effectfulTools} tools in this answer may change things outside the chat.`}{" "}
            Retrying may run them again. Approvals still apply.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              onClick={() => {
                setConfirmRetry(false);
                // Retry eligibility can change while the dialog is open; never dispatch a stale retry.
                if (canRetry) retry();
              }}
            >
              Retry answer
            </Button>
            <Button onClick={() => setConfirmRetry(false)}>Cancel</Button>
          </div>
        </Dialog>
      ) : null}
      {hasAnswer ? (
        <button type="button" onClick={onCopy} className={phone ? PHONE : INLINE}>
          {copied ? (
            <>
              <Check aria-hidden="true" className="size-4" />
              <span className="ml-1">Copied</span>
            </>
          ) : (
            copyLabel
          )}
        </button>
      ) : null}
      {secondary.length ? (
        <Menu scopeKey={JSON.stringify([turn.trace.sessionId, turn.turnId])}>
          <MenuTrigger aria-label="More message actions" className={phone ? PHONE : INLINE}>
            <MoreHorizontal aria-hidden="true" className="size-4" />
            <span className="ml-1">More</span>
          </MenuTrigger>
          <MenuContent align="start">
            {secondary.map((item) => (
              <MenuItem key={item.label} className="min-h-11" onSelect={item.run}>
                {item.label}
              </MenuItem>
            ))}
          </MenuContent>
        </Menu>
      ) : null}
      {siblings.length > 1 ? (
        <span className="flex items-center gap-1 text-fg-muted">
          Version {turn.branch.activeSiblingIndex + 1} of {turn.branch.siblingCount}
          {siblings.map((siblingId, index) => (
            <button
              key={siblingId}
              type="button"
              disabled={siblingId === turn.turnId}
              aria-current={siblingId === turn.turnId ? "true" : undefined}
              onClick={() => actions.onSwitchBranch(siblingId)}
              aria-label={`Switch to version ${index + 1}`}
              className={`inline-flex items-center justify-center rounded-sm border border-line-control text-accent disabled:text-fg-muted ${phone ? "min-h-11 min-w-11" : "min-h-8 min-w-8"}`}
            >
              {index + 1}
            </button>
          ))}
        </span>
      ) : null}
    </div>
  );
}
