/** How many looks the letter icon has. `LetterIcon` holds the classes for each. */
export const LETTER_ICON_TONE_COUNT = 4;

/** A stable pick from the icon looks for a name, so an app keeps its colour from one visit to the next. */
export function letterIconTone(name: string): number {
  let hash = 5381;
  for (const char of name.trim().toLowerCase()) hash = (Math.imul(hash, 33) + (char.codePointAt(0) ?? 0)) >>> 0;
  return hash % LETTER_ICON_TONE_COUNT;
}
