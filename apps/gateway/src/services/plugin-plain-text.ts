// Text a plugin plan or a plugin refusal shows, cleaned of what a label read from a plugin's own files may carry. Kept
// apart, with no imports, so every owner that names a plugin can use it.

/** C0 and C1 controls (a NUL, a tab, a line break) and the line and paragraph separators. */
const CONTROLS_AND_SEPARATORS = /[\p{Cc}\u2028\u2029]+/gu;
/** Bidi marks, embeddings, overrides and isolates, which can make approval text read in another order than it runs. */
const BIDI_CONTROLS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;
const REPEATED_SPACES = / {2,}/gu;

/**
 * Text with every control character a label brought along taken out: bidi controls are dropped, each run of C0 or C1
 * controls, line breaks and separators becomes one space, repeated spaces become one, and the ends are trimmed.
 */
export function withoutControls(text: string): string {
  return text.replace(BIDI_CONTROLS, "").replace(CONTROLS_AND_SEPARATORS, " ").replace(REPEATED_SPACES, " ").trim();
}
