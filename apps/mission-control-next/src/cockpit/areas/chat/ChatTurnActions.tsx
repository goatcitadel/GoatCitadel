import type { ChatThreadTurnRecord } from "@goatcitadel/contracts";
import { canRetryTurn } from "@goatcitadel/mission-control-shared/components/chat/chat-display-helpers";
import { useMediaQuery } from "@goatcitadel/mission-control-shared/hooks/useMediaQuery";
import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import { MoreHorizontal } from "lucide-react";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "../../ui/Menu";

export type TurnActionHandlers = Pick<
  MissionThreadedActiveSessionSurfaceProps,
  "onRetryTurn" | "onStartNewThreadFromTurn" | "onSwitchBranch" | "onEditTurn" | "onOpenRunDetails" | "onCreateGeneratedArtifact"
>;

const INLINE = "inline-flex min-h-8 items-center px-1 text-accent hover:underline";
const PHONE = "inline-flex min-h-11 items-center rounded-md border border-line px-3 text-sm font-medium text-accent";

/**
 * Turn actions. On a phone, Retry and Copy stay as 44 px buttons and the rest move into a
 * "More" menu; wider screens keep the inline links with a real hit area.
 */
export function ChatTurnActions({
  turn,
  actions,
  streaming,
  readOnly,
  hasAnswer,
  onCopy,
}: {
  turn: ChatThreadTurnRecord;
  actions: TurnActionHandlers;
  streaming: boolean;
  readOnly: boolean;
  hasAnswer: boolean;
  onCopy: () => void;
}) {
  const phone = useMediaQuery("(max-width: 639px)");
  const canRetry = canRetryTurn(turn) && !streaming && !readOnly;
  const canBranch = !streaming && !readOnly;
  const canSave = Boolean(turn.assistantMessage) && turn.trace.status !== "failed" && !readOnly;
  const siblings = turn.branch.siblingTurnIds ?? [];
  const copyLabel = streaming ? "Copy answer so far" : "Copy answer";
  const secondary = [
    canBranch ? { label: "Fork", run: () => actions.onStartNewThreadFromTurn(turn.turnId) } : null,
    canBranch ? { label: "Edit and resend", run: () => actions.onEditTurn(turn.turnId) } : null,
    { label: "Run details", run: () => actions.onOpenRunDetails(turn.turnId) },
    canSave ? { label: "Save answer", run: () => actions.onCreateGeneratedArtifact(turn.turnId) } : null,
  ].filter((item): item is { label: string; run: () => void } => Boolean(item));

  return (
    <div className={`flex flex-wrap items-center ${phone ? "gap-2" : "gap-x-2 gap-y-1"}`}>
      {canRetry ? (
        <button type="button" onClick={() => actions.onRetryTurn(turn.turnId)} className={phone ? PHONE : `${INLINE} font-medium`}>
          Retry
        </button>
      ) : null}
      {hasAnswer ? (
        <button type="button" onClick={onCopy} className={phone ? PHONE : INLINE}>
          {copyLabel}
        </button>
      ) : null}
      {phone ? (
        <Menu>
          <MenuTrigger aria-label="More turn actions" className={PHONE}>
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
      ) : (
        secondary.map((item) => (
          <button key={item.label} type="button" onClick={item.run} className={INLINE}>
            {item.label}
          </button>
        ))
      )}
      {siblings.length > 1 ? (
        <span className="flex items-center gap-1 text-fg-muted">
          Branch {turn.branch.activeSiblingIndex + 1} of {turn.branch.siblingCount}
          {siblings.map((siblingId, index) => (
            <button
              key={siblingId}
              type="button"
              disabled={siblingId === turn.turnId}
              onClick={() => actions.onSwitchBranch(siblingId)}
              aria-label={`Switch to branch ${index + 1}`}
              className={`inline-flex items-center justify-center rounded border border-line text-accent disabled:text-fg-muted ${phone ? "min-h-11 min-w-11" : "min-h-8 min-w-8"}`}
            >
              {index + 1}
            </button>
          ))}
        </span>
      ) : null}
    </div>
  );
}
