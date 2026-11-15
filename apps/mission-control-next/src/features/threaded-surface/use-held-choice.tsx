import { useEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";

/**
 * A choice made in a control that applies it later, so stepping through a select applies nothing on the way. The pick
 * is held as a draft until the operator applies it: the Apply button, focus leaving the control, or the control being
 * closed (`apply`). Escape inside the control discards it. A new `scope` (another conversation) or the control going
 * away discards a held pick and never applies it, so it can't land on a different conversation.
 *
 * `resolve` turns the draft into the change to send, or `null` when the draft says nothing new.
 */
export function useHeldChoice<Draft extends object, Change>({
  resolve,
  send,
  scope,
}: {
  resolve: (draft: Draft) => Change | null;
  send: (change: Change) => void;
  scope: unknown;
}) {
  const [draft, setDraftState] = useState<Draft>({} as Draft);
  // The same draft in a ref, so a close that is reported twice sends it once.
  const held = useRef<Draft>(draft);
  const latest = useRef({ resolve, send });
  latest.current = { resolve, send };

  const discard = () => {
    if (Object.keys(held.current).length === 0) return;
    held.current = {} as Draft;
    setDraftState(held.current);
  };
  const hold = (update: (current: Draft) => Draft) => {
    held.current = update(held.current);
    setDraftState(held.current);
  };
  const apply = () => {
    const change = latest.current.resolve(held.current);
    discard();
    if (change !== null) latest.current.send(change);
  };

  // A new scope starts clean.
  useEffect(() => {
    discard();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `discard` only touches refs and state setters.
  }, [scope]);
  // A control that goes away applies nothing.
  useEffect(
    () => () => {
      held.current = {} as Draft;
    },
    [],
  );

  return {
    draft,
    dirty: resolve(draft) !== null,
    hold,
    apply,
    discard,
    /** Put on the element that wraps the control: focus leaving it applies, Escape inside it discards. */
    wrapperProps: {
      onBlur: (event: FocusEvent<HTMLElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) apply();
      },
      onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
        if (event.key !== "Escape" || latest.current.resolve(held.current) === null) return;
        event.preventDefault();
        event.stopPropagation();
        discard();
      },
    },
  };
}

/** Says a held pick is not applied yet and offers Apply. Plain text: it adds no live region. */
export function HeldChoiceNotice({ onApply }: { onApply: () => void }) {
  return (
    <span className="mc-next-held-choice">
      <span>Not applied yet.</span>{" "}
      <button type="button" onClick={onApply}>
        Apply
      </button>
    </span>
  );
}
