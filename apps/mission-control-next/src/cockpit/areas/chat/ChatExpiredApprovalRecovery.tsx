import { useId, useRef, useState } from "react";
import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import { Button } from "../../ui/Button";

export type DraftControls = Partial<
  Pick<MissionThreadedActiveSessionSurfaceProps, "composerRef" | "thread" | "onDraftChange" | "draft">
>;

export function ChatExpiredApprovalRecovery({ props, turnId, allowAskAgain=true, notice="This approval expired." }: { props: DraftControls; turnId?: string;allowAskAgain?:boolean;notice?:string }) {
  const [askBlocked, setAskBlocked] = useState(false);
  // The text Ask again itself put in the box: it is the request, not something the operator typed.
  const restored = useRef<string | undefined>(undefined);
  const blockedNoteId = useId();
  const draftHasText = Boolean(props.draft?.trim()) && props.draft !== restored.current;
  const originalRequest = props.thread?.turns.find((turn) => turn.turnId === turnId)?.userMessage.content;
  function askAgain() {
    // Never replace what the operator has already typed.
    if (draftHasText) {
      setAskBlocked(true);
      return;
    }
    setAskBlocked(false);
    if (originalRequest && props.draft !== originalRequest) {
      restored.current = originalRequest;
      props.onDraftChange?.(originalRequest);
    }
    props.composerRef?.current?.focus();
  }
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <p>
        {notice}
        {originalRequest && allowAskAgain ? " Ask again to put your request back in the message box." : ""}
        {askBlocked && draftHasText ? (
          <span id={blockedNoteId}> Your message box already has text. Clear it to ask again.</span>
        ) : null}
      </p>
      {originalRequest && allowAskAgain ? (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          aria-describedby={askBlocked && draftHasText ? blockedNoteId : undefined}
          onClick={askAgain}
        >
          Ask again
        </Button>
      ) : null}
    </div>
  );
}
