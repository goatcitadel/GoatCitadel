import type { ChatToolRunRecord } from "@goatcitadel/contracts";

// What the Chat Code Mode card reads from a `code_mode.request` tool call and says about it.

export const NOT_RUN = "Not run";

/** A request's arguments as the model sent them; every field is checked before use. */
export type CodeModeRequestArgs = { goal?: unknown; source?: unknown; reads?: unknown; input?: unknown };
export const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/** The files, folders and attachments the request lists in `reads`: the only ones any of its helpers may read. */
export const readEntries = (args: CodeModeRequestArgs): string[] =>
  Array.isArray(args.reads) ? args.reads.flatMap((entry) => (text(entry) ? [text(entry)] : [])) : [];

const READS_SHOWN = 3;
/** An attachment id as the Gateway mints it. */
const ATTACHMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One read as the row names it: an attachment by its file name, a path by its last part, never a raw id. */
function readName(entry: string, attachmentNames: ReadonlyMap<string, string>): string {
  const named = attachmentNames.get(entry);
  if (named) return named;
  if (ATTACHMENT_ID.test(entry)) return "an attachment";
  return entry.split(/[\\/]/).filter(Boolean).at(-1) ?? entry;
}

/** "a.pdf, b.txt, c.csv and 2 more": the first few reads by name. */
export function readsLine(entries: string[], attachmentNames: ReadonlyMap<string, string>): string {
  const names = entries.map((entry) => readName(entry, attachmentNames));
  const shown = names.slice(0, READS_SHOWN).join(", ");
  return names.length > READS_SHOWN ? `${shown} and ${names.length - READS_SHOWN} more` : shown;
}

const REASON_MAX_CHARS = 140;

/**
 * The reason's first sentence in plain words: a leading machine code ("WRAPPER_EXECUTION_FAILED: ") is dropped, a dot
 * inside a name such as docs.extract_text does not end the sentence, a chained cause after ": " is left to Details,
 * and a long reason is cut short.
 */
function firstSentence(message: string): string {
  const plain = message.trim().replace(/^[A-Z][A-Z0-9_]+:\s*/, "");
  const clause = /^[^\n]*?(?:[.!?](?=\s|$)|(?=:\s))/.exec(plain)?.[0] ?? plain.split("\n")[0] ?? "";
  const trimmed = clause.trim();
  const sentence = trimmed && !/[.!?]$/.test(trimmed) ? `${trimmed}.` : trimmed;
  if (!sentence) return NOT_RUN;
  return sentence.length > REASON_MAX_CHARS ? `${sentence.slice(0, REASON_MAX_CHARS - 1).trimEnd()}…` : sentence;
}

/**
 * A refusal for a read outside the approved `reads` (the Gateway's wording): a target not in the list, a helper call
 * that names no target, or a helper the run leaves out, such as one that searches.
 */
const UNAPPROVED_READ =
  /is not in the files approved for this run|must name a file or folder approved for this run|is not available in this run, which can read only the files approved for it/;
/** A failed call from the code to one of its helpers; file-reading helpers are named docs.*, fs.* and file.*. */
const HELPER_FAILED = /^(?:WRAPPER_EXECUTION_FAILED:|Wrapper \S+ did not execute)/;
const FILE_HELPER = /\b(?:docs|fs|file)\.[a-z_]+/;

/** Why a request that ran did not finish, as recorded; empty for one that finished or never ran. */
export function failureReason(run: ChatToolRunRecord): string {
  const failed = run.status === "failed" || (run.status === "executed" && run.result?.status === "failed");
  return failed ? text(run.result?.error) || text(run.error) : "";
}

/** The row's failure line: a helper failure in plain words, anything else by its first sentence. */
export function failureLine(message: string): string {
  if (UNAPPROVED_READ.test(message)) return "The code tried to read a file that wasn't approved.";
  if (HELPER_FAILED.test(message.trim())) {
    return FILE_HELPER.test(message) ? "The code couldn't read a file." : "A helper the code called failed.";
  }
  return firstSentence(message);
}
