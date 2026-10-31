/**
 * The input a Chat Code Mode request (`code_mode.request`) hands its code, as compact JSON; undefined when it hands
 * none. The input decides what the code reads (`input.path`), so every review of the request shows it.
 */
export function codeModeRequestInput(input: unknown): string | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input === "object" && !Array.isArray(input) && Object.keys(input).length === 0) return undefined;
  return JSON.stringify(input);
}
