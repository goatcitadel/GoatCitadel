// Pure helpers for lazy, settled-only syntax highlighting of assistant code blocks.
//
// This module intentionally never imports lowlight/highlight.js at the top level — the
// only runtime import of those packages lives in `assistant-code-highlight-languages.ts`,
// which is loaded lazily via `loadAssistantCodeHighlighter()` below. That keeps the
// highlight.js grammar registry (and its ~11.11 runtime) out of the main bundle; it is
// fetched as an async chunk the first time a settled code block actually needs it.
//
// `HastRoot` is imported type-only, which erases at compile time and carries no runtime
// module (hast ships no JS to import — it is a types-only package), so this stays safe.
import type { Root as HastRoot } from "hast";

export const HIGHLIGHT_MAX_CODE_CHARS = 20_000;

const HIGHLIGHT_DISABLED_STORAGE_KEY = "goatcitadel.chat.code_highlight.disabled";

/**
 * The kill-switch is opt-out: highlighting is enabled by default. It is disabled only
 * when localStorage is available AND explicitly holds the string "true" for the kill
 * switch key. Any error reading localStorage (disabled storage, private browsing,
 * non-DOM environment) falls back to enabled rather than silently degrading the UI.
 */
export function isAssistantCodeHighlightEnabled(): boolean {
  if (typeof window === "undefined") {
    return true;
  }
  try {
    return window.localStorage.getItem(HIGHLIGHT_DISABLED_STORAGE_KEY) !== "true";
  } catch {
    // Fallback: localStorage access may be denied (private mode) or unavailable;
    // default to enabled rather than crash or silently disable highlighting.
    return true;
  }
}

const REGISTERED_LANGUAGES = new Set([
  "typescript",
  "javascript",
  "json",
  "bash",
  "python",
  "css",
  "xml",
  "markdown",
  "yaml",
  "sql",
  "diff",
  "go",
  "rust",
  "java",
  "csharp",
  "powershell",
]);

const LANGUAGE_ALIASES: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescript",
  jsx: "typescript",
  sh: "bash",
  zsh: "bash",
  shell: "bash",
  html: "xml",
  svg: "xml",
  vue: "xml",
  yml: "yaml",
  ps: "powershell",
  ps1: "powershell",
  "c#": "csharp",
  cs: "csharp",
  golang: "go",
  py: "python",
  md: "markdown",
  patch: "diff",
};

/**
 * Normalize a fence language tag to one of the 16 registered lowlight grammar names, or
 * `null` when the language is unknown/unregistered. Lowercased before matching; the 16
 * canonical names map to themselves (identity).
 */
export function normalizeHighlightLanguage(language: string | undefined): string | null {
  const trimmed = language?.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }
  const canonical = LANGUAGE_ALIASES[trimmed] ?? trimmed;
  return REGISTERED_LANGUAGES.has(canonical) ? canonical : null;
}

export type AssistantHighlighter = {
  highlight(lang: string, code: string): HastRoot;
  listLanguages(): string[];
};

let highlighterPromise: Promise<AssistantHighlighter | null> | null = null;

/**
 * Lazily loads the language-registry chunk and returns a memoized singleton promise for
 * an `AssistantHighlighter`. The dynamic import is the ONLY place lowlight/highlight.js
 * enters the runtime graph; every call before/after resolution shares the same promise,
 * so the highlighter is constructed at most once regardless of how many code blocks ask
 * for it. Resolves `null` (never rejects) on load failure so a bad chunk load degrades
 * to plain text instead of crashing the message renderer.
 */
export function loadAssistantCodeHighlighter(): Promise<AssistantHighlighter | null> {
  highlighterPromise ??= import("./assistant-code-highlight-languages")
    .then((module) => module.createAssistantHighlighter())
    .catch(() => null);
  return highlighterPromise;
}

/** Test-only: clears the memoized loader singleton so each test starts from a clean slate. */
export function resetAssistantCodeHighlighterForTests(): void {
  highlighterPromise = null;
}

/**
 * Highlights `code` in `language` using an already-loaded `AssistantHighlighter`. Returns
 * `null` (never throws) when: the code exceeds `HIGHLIGHT_MAX_CODE_CHARS`, the language is
 * not among the highlighter's registered languages, or the underlying `highlight()` call
 * throws for any reason (malformed input, grammar edge case, etc.) — callers should treat
 * a `null` result as "render plain text".
 */
export function highlightCodeToHast(h: AssistantHighlighter, code: string, language: string): HastRoot | null {
  if (code.length > HIGHLIGHT_MAX_CODE_CHARS) {
    return null;
  }
  if (!h.listLanguages().includes(language)) {
    return null;
  }
  try {
    return h.highlight(language, code);
  } catch {
    return null;
  }
}
