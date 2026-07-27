export const OPEN_CHAT_COMPOSER_PALETTE_EVENT = "goatcitadel:open-chat-composer-palette";

/**
 * Offers the Chat composer first refusal for the shell-wide Ctrl/Cmd+K
 * shortcut. A feature-gated composer cancels the event after opening; when no
 * eligible composer is mounted the caller can fall back to shell navigation.
 */
export function requestChatComposerPaletteOpen(
  target: Partial<Pick<Window, "dispatchEvent">> | undefined = typeof window === "undefined" ? undefined : window,
): boolean {
  if (typeof target?.dispatchEvent !== "function") {
    return false;
  }
  const event = new Event(OPEN_CHAT_COMPOSER_PALETTE_EVENT, { cancelable: true });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}
