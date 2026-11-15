import { useCallback, useEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";

/**
 * A choice made in a control that applies it later, so stepping through a select applies nothing on the way. The pick
 * is held as a draft until the operator applies it: the Apply button, focus leaving the control, or the control being
 * closed (`apply`). Escape inside the control discards it. The whole window losing focus (Alt-Tab, another app) is not
 * the operator leaving the control, so it keeps the pick held. A new `scope` (another conversation) or the control going
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
  const [heldDraft, setDraftState] = useState<Draft>({} as Draft);
  // The same draft in a ref, so a close that is reported twice sends it once.
  const held = useRef<Draft>(heldDraft);
  const latest = useRef({ resolve, send });
  latest.current = { resolve, send };
  // The scope the held pick was made in, and the scope now. A pick is only ever sent in the scope it was made in,
  // even in the gap before the effect below has cleared it.
  const heldScope = useRef<unknown>(scope);
  const currentScope = useRef<unknown>(scope);
  currentScope.current = scope;
  const draft = heldScope.current === scope ? heldDraft : ({} as Draft);

  const discard = useCallback(() => {
    if (Object.keys(held.current).length === 0) return;
    held.current = {} as Draft;
    setDraftState(held.current);
  }, []);
  const hold = (update: (current: Draft) => Draft) => {
    if (heldScope.current !== currentScope.current) {
      held.current = {} as Draft;
      heldScope.current = currentScope.current;
    }
    held.current = update(held.current);
    setDraftState(held.current);
  };
  const apply = () => {
    const sameScope = heldScope.current === currentScope.current;
    const change = sameScope ? latest.current.resolve(held.current) : null;
    discard();
    if (change !== null) latest.current.send(change);
  };

  // A new scope starts clean.
  useEffect(() => {
    discard();
  }, [scope, discard]);
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
        const next = event.relatedTarget as Node | null;
        if (event.currentTarget.contains(next)) return;
        // Focus going nowhere while the window itself lost focus is Alt-Tab, not the operator leaving the control.
        if (next === null && !document.hasFocus()) return;
        apply();
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
export function HeldChoiceNotice({
  onApply,
  focusTarget,
}: {
  onApply: () => void;
  /** Where focus goes once Apply is pressed, since the button goes away with the notice. */
  focusTarget?: () => HTMLElement | null;
}) {
  return (
    <span className="mc-next-held-choice">
      <span>Not applied yet.</span>{" "}
      <button
        type="button"
        onClick={() => {
          onApply();
          focusTarget?.()?.focus();
        }}
      >
        Apply
      </button>
    </span>
  );
}
