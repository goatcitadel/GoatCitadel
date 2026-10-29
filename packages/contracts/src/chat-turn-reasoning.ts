/**
 * A turn keeps at most this many trailing characters of the model's streamed reasoning, both in the browser's
 * thread state and in the Gateway's saved copy. Unbounded reasoning streams cannot grow either without limit,
 * and the freshest (most relevant) reasoning stays visible.
 */
export const CHAT_TURN_REASONING_MAX_CHARS = 16_000;
const REASONING_TRUNCATION_MARKER = "… ";

/** Keeps the tail of over-long reasoning, prefixed with a marker so it is clear earlier text was dropped. */
export function capChatTurnReasoning(text: string): string {
  if (text.length <= CHAT_TURN_REASONING_MAX_CHARS) {
    return text;
  }
  const keepChars = CHAT_TURN_REASONING_MAX_CHARS - REASONING_TRUNCATION_MARKER.length;
  return `${REASONING_TRUNCATION_MARKER}${text.slice(text.length - keepChars)}`;
}
