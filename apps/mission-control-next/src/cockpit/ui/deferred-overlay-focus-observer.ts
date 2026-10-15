interface FocusTicket<Owner> {
  owner: Owner;
  cancelled: boolean;
  restore: boolean;
  lastFocused: HTMLElement | null;
  trigger: HTMLElement | null;
  pointerInFlight: boolean;
}
interface ObserverOwner<Owner, Ticket> {
  runtime: unknown;
  ownsTarget: (target: Node | null) => boolean;
  commit: (ticket: Ticket) => void;
  cancel: (restore?: boolean) => void;
  isCurrent: (owner?: Owner) => boolean;
  intent: { current: Ticket | null };
  ownsFocus: (ticket: Ticket) => boolean;
  recoveryActive: () => boolean;
  close: (restore?: boolean, notify?: boolean, revoke?: boolean) => void;
}
export function observeDeferredOverlayFocus<Owner, Ticket extends FocusTicket<Owner>>(
  ticket: Ticket,
  {
    runtime,
    ownsTarget,
    commit,
    cancel,
    isCurrent,
    intent,
    ownsFocus,
    recoveryActive,
    close,
  }: ObserverOwner<Owner, Ticket>,
) {
  let blurTimer: ReturnType<typeof setTimeout> | undefined;
  const clearBlurTimer = () => {
    if (blurTimer !== undefined) {
      clearTimeout(blurTimer);
      blurTimer = undefined;
    }
  };
  const focus = (event: FocusEvent) => {
    clearBlurTimer();
    const target = event.target as HTMLElement | null;
    if (target && ownsTarget(target)) {
      ticket.lastFocused = target;
      commit(ticket);
      return;
    }
    if (runtime) ticket.restore = false;
    else cancel(false);
  };
  const blur = () => {
    if (runtime) return;
    clearBlurTimer();
    // Native Tab briefly focuses BODY before reaching the next owned control.
    blurTimer = setTimeout(() => {
      blurTimer = undefined;
      if (isCurrent(ticket.owner) && intent.current === ticket && !ticket.cancelled && !ownsFocus(ticket))
        cancel(false);
    }, 0);
  };
  document.addEventListener("focusin", focus);
  document.addEventListener("focusout", blur);
  if (runtime)
    return () => {
      clearBlurTimer();
      document.removeEventListener("focusin", focus);
      document.removeEventListener("focusout", blur);
    };
  const key = (event: KeyboardEvent) => {
    if (event.defaultPrevented || recoveryActive()) return;
    if (event.key === "Escape") {
      event.preventDefault();
      close(true);
    }
    // Pending Tab keeps its native default. Focus departure, rather than the
    // key alone, revokes this opening; READY Tab belongs to the public SDK.
  };
  const outside = (event: Event) => {
    if (recoveryActive()) return;
    const target = event.target as Node | null;
    if (ownsTarget(target)) return;
    cancel(false);
  };
  const pointerEnd = (event: PointerEvent) => {
    if (recoveryActive()) return;
    if (ticket.pointerInFlight && !ticket.trigger?.contains(event.target as Node)) cancel(false);
  };
  const pointerCancel = () => {
    if (!recoveryActive()) cancel(false);
  };
  document.addEventListener("keydown", key);
  document.addEventListener("pointerdown", outside);
  document.addEventListener("pointerup", pointerEnd);
  document.addEventListener("pointercancel", pointerCancel);
  return () => {
    clearBlurTimer();
    document.removeEventListener("keydown", key);
    document.removeEventListener("focusin", focus);
    document.removeEventListener("focusout", blur);
    document.removeEventListener("pointerdown", outside);
    document.removeEventListener("pointerup", pointerEnd);
    document.removeEventListener("pointercancel", pointerCancel);
  };
}
