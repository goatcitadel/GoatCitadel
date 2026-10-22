import { describeThreadedUiError } from "../../features/threaded-surface/threaded-error-copy";

export interface PresentedError {
  /** One plain line an operator can read. */
  summary: string;
  /** The recorded text, for technical details; absent when the summary already is that text. */
  detail?: string;
}

/** Neutral: technical details may be switched off, and the site may be a run, a step, a delivery or an add-on. */
const UNREADABLE_SUMMARY = "The recorded error isn't in a readable form.";

/*
 * The chat copy turns any text mentioning approval, user input, run data or checkpoints into a run-state sentence
 * ("The run is waiting for approval…"). That fits a live Chat turn, not a recorded failure, so those are ignored here.
 */
const RUN_STATE_SUMMARIES = new Set([
  "The run is waiting for approval before it can continue.",
  "The run is waiting for operator input before it can continue.",
  "Run state refresh failed.",
  "Checkpoint refresh failed.",
]);

/** A bare "Error:" / "ERROR" label in front of a sentence adds nothing an operator needs. */
const ERROR_LABEL = /^error\s*:?\s+(?=\S)/iu;

/*
 * Text that isn't operator copy: addresses, URLs, file paths, stack frames ("at fn (file:12"), error class names
 * ("TypeError:"), errno codes and JSON. Clock times, bracketed words and capitalised words are left alone.
 */
const TECHNICAL_TEXT = new RegExp(
  [
    String.raw`\b\d{1,3}(?:\.\d{1,3}){3}\b`,
    String.raw`\blocalhost:\d+`,
    String.raw`https?:\/\/`,
    String.raw`[A-Za-z]:\\`,
    String.raw`(?:^|\s)\/[\w.-]+\/`,
    String.raw`\bat\s+[\w.<>$]+\s*\([^)]*:\d+`,
    String.raw`\b[A-Z][A-Za-z]*Error:`,
    String.raw`\bE(?:CONNREFUSED|CONNRESET|NOENT|ACCES|TIMEDOUT|PIPE|NOTFOUND|ADDRINUSE|PERM|HOSTUNREACH)\b`,
    String.raw`[{}]`,
  ].join("|"),
  "u",
);

/**
 * Presents a server-recorded error (run.lastError, step.error) for operators. Known messages are worded by the shared
 * chat error copy; plain sentences pass through (first line only, without a bare "Error:" label); anything else
 * becomes a neutral line, with the raw text kept as detail for TechnicalDetails.
 */
export function presentErrorText(raw: string | null | undefined): PresentedError {
  const text = raw?.trim();
  if (!text) return { summary: "No error details were recorded." };
  const described = describeThreadedUiError(text)?.summary ?? text;
  if (described !== text && !RUN_STATE_SUMMARIES.has(described)) return { summary: described, detail: text };
  const firstLine = text.split(/\r?\n/u)[0]!.trim();
  if (TECHNICAL_TEXT.test(firstLine)) return { summary: UNREADABLE_SUMMARY, detail: text };
  const unlabelled = firstLine.replace(ERROR_LABEL, "");
  const summary = unlabelled.charAt(0).toUpperCase() + unlabelled.slice(1);
  return summary === text ? { summary } : { summary, detail: text };
}
