/**
 * Plain names for stored check keys whose words would read as internal terms on screen. The keys stay as they are,
 * because stored results and tests refer to them; only the words an operator reads change.
 */
const PLAIN_CHECK_NAMES: ReadonlyMap<string, string> = new Map([
  ["delivery_posture", "how sending and receiving work"],
]);

/** The plain name for a check key, or undefined when the key has none and the caller shows its own wording. */
export function plainCheckName(key: string): string | undefined {
  return PLAIN_CHECK_NAMES.get(key);
}
