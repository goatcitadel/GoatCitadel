import type { ChatCompletionResponse } from "@goatcitadel/contracts";

const canonicalRouting = new WeakMap<object, NonNullable<ChatCompletionResponse["routing"]>>();

/** Only the Gateway completion owner can mark its final transport observation. */
export function bindCanonicalStreamRouting<T extends Record<string, unknown>>(
  chunk: T,
  routing: NonNullable<ChatCompletionResponse["routing"]>,
): T {
  canonicalRouting.set(chunk, structuredClone(routing));
  return chunk;
}

/** Provider JSON (including a forged routing field) cannot mint this observation. */
export function readCanonicalStreamRouting(chunk: Record<string, unknown>): ChatCompletionResponse["routing"] {
  const routing = canonicalRouting.get(chunk);
  return routing ? structuredClone(routing) : undefined;
}
