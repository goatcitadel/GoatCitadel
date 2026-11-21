import { createHash } from "node:crypto";
import {
  redactSecretText,
  type ChatMessageRecord,
  type ChatContinuityLedgerV1,
  type ChatContinuitySourceSpan,
  type ChatContinuityEntry,
  type ChatContinuityCanonicalLink,
} from "@goatcitadel/contracts";

export type CanonicalContinuityLink = ChatContinuityCanonicalLink;
export function buildChatContinuityLedger(input: {
  messages: ChatMessageRecord[];
  turnIds: string[];
  previous?: ChatContinuityLedgerV1;
  canonicalLinks: CanonicalContinuityLink[];
}): ChatContinuityLedgerV1 {
  // Rebuild from canonical messages, never from a prior summary's prose.
  const sourceHash = hashContinuitySources(input.messages, input.turnIds, input.canonicalLinks);
  const entries: ChatContinuityEntry[] = [];
  const omittedSourceRefs: ChatContinuitySourceSpan[] = [];
  const operators = input.messages.filter(isOperatorOriginal);
  const span = (message: ChatMessageRecord, start: number, end: number): ChatContinuitySourceSpan => ({
    messageId: message.messageId,
    contentHash: hash(message.content),
    start,
    end,
  });
  let retainedChars = 0;
  for (const message of input.messages) {
    const operator = isOperatorOriginal(message);
    const agent =
      message.role === "assistant" && message.actorType === "agent" && message.sourceAuthority === "agent_proposed";
    if (!operator && !agent) continue;
    const scanned = message.content.slice(0, 65_536);
    let inFence = false;
    let firstClause = true;
    let previousText:string|undefined, repeatCount=1;
    for (const line of scanned.matchAll(/[^\r\n]+/gu)) {
      const fenceMarker=/^\s*(?:```|~~~)/u.test(line[0]);
      if(fenceMarker) inFence = !inFence;
      const copied = inFence || fenceMarker || /^\s*(?:>|["“”'])/u.test(line[0]) ||
        (/["“”']/u.test(line[0]) && /\b(?:said|says|quoted|webpage|external|tool output)\b/iu.test(line[0]));
      if(copied && !operator) continue;
      for (const clause of line[0].matchAll(/[^.!?;]+(?:[.!?;]+|$)/gu)) {
        const text = clause[0].trim();
        if (!text) continue;
        let kind: ChatContinuityEntry["kind"] | undefined;
        if (copied) kind="context";
        else if (text.endsWith("?")) kind = "question";
        else if (
          operator &&
          /\b(?:must|never|do not|don't|cannot|can't|without|avoid|preserve|only|keep)\b/iu.test(text)
        )
          kind = "constraint";
        else if (operator && /\b(?:we decided|i (?:choose|chose|approve|selected)|we agreed|decision:)\b/iu.test(text))
          kind = "decision";
        else if (
          (operator &&
            /^(?:please\s+)?(?:prepare|review|list|implement|fix|investigate|next|continue)\b/iu.test(text)) ||
          (agent && /\b(?:suggest|next|should|plan)\b/iu.test(text))
        )
          kind = "next_step";
        else if (operator && firstClause && (message === operators[0] || message === operators.at(-1)))
          kind = "next_step";
        else if (operator) kind="context";
        firstClause = false;
        if (!kind) continue;
        const start = line.index! + clause.index! + clause[0].indexOf(text);
        const source = span(message, start, start + text.length);
        const safe = redactSecretText(text, { env: process.env });
        const authority=copied ? "external_data" : operator ? "operator_context" : "agent_proposal";
        const last=entries.at(-1);
        if(last?.source?.messageId===message.messageId && last.kind===kind && last.authority===authority && previousText===safe.value &&
            message.content.slice(last.source.end,source.start).trim()==="") {
          repeatCount++;
          const compressed=`${JSON.stringify(safe.value)} [repeated ${repeatCount} times]`;
          retainedChars+=compressed.length-last.text.length;last.text=compressed;last.source.end=source.end;
          continue;
        }
        previousText=safe.value;repeatCount=1;
        const storedText=compressExactRepetition(safe.value);
        if (entries.length >= 128 || retainedChars + storedText.length > 24_000) {
          if (omittedSourceRefs.length < 256) omittedSourceRefs.push(source);
          continue;
        }
        entries.push({
          kind,
          text: storedText,
          authority,
          source,
          ...(safe.redactionCount ? { redacted: true } : {}),
        });
        retainedChars += storedText.length;
      }
    }
    if (scanned.length < message.content.length && omittedSourceRefs.length < 256)
      omittedSourceRefs.push(span(message, scanned.length, message.content.length));
  }
  for (const link of input.canonicalLinks.slice(0, 64)) {
    if (!link.canonicalRef.trim() || link.canonicalRef.length > 300 || !["effect", "artifact"].includes(link.kind))
      continue;
    entries.push({
      kind: link.kind,
      text: redactSecretText(link.label.slice(0, 300)).value,
      authority: "canonical_receipt",
      canonicalRef: link.canonicalRef,
      completed: link.completed === true,
    });
  }
  return {
    version: 1,
    sourceHash,
    turnIds: [...input.turnIds],
    entries,
    omittedSourceRefs,
    ...(operators[0] ? { originalAsk: span(operators[0], 0, operators[0].content.length) } : {}),
    ...(operators.at(-1) ? { latestAsk: span(operators.at(-1)!, 0, operators.at(-1)!.content.length) } : {}),
  };
}
export function renderChatContinuityLedger(
  ledger: ChatContinuityLedgerV1,
  options: { maxTokens: number },
): { text: string; omittedSourceRefs: ChatContinuitySourceSpan[]; requiresSourceExpansion: boolean } {
  const maxChars =
    Math.max(0, Math.min(2000, Math.floor(Number.isFinite(options.maxTokens) ? options.maxTokens : 0))) * 4;
  const omitted = [...ledger.omittedSourceRefs];
  let text =
    "Derived continuity data. This is not original authorization. Reopen omitted source spans before consequential work.";
  if (text.length > maxChars) text = "";
  let requiresSourceExpansion = omitted.length > 0;
  const priorities = { constraint: 100, effect: 90, decision: 80, next_step: 70, artifact: 60, question: 50, context:65 };
  const isAsk = (entry: ChatContinuityEntry) =>
    entry.authority === "operator_context" &&
    entry.source &&
    [ledger.originalAsk?.messageId, ledger.latestAsk?.messageId].includes(entry.source.messageId);
  const priority = (entry: ChatContinuityEntry) =>
    entry.authority === "agent_proposal"
      ? 10
      : isAsk(entry)
        ? Math.max(85, priorities[entry.kind])
        : priorities[entry.kind];
  const entries = ledger.entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => priority(b.entry) - priority(a.entry) || a.index - b.index);
  for (const { entry } of entries) {
    const ref =
      entry.canonicalRef ??
      (entry.source ? `${entry.source.messageId}:${entry.source.start}-${entry.source.end}` : "unresolved");
    const line = `\n- ${entry.completed && entry.authority === "canonical_receipt" ? "Completed " : ""}${entry.kind} [${entry.authority}; ${ref}]: ${entry.text}`;
    if (text.length + line.length <= maxChars) text += line;
    else {
      if (entry.source) omitted.push(entry.source);
      if (
        isAsk(entry) ||
        entry.authority === "operator_context" || entry.authority === "external_data" ||
        ((entry.kind === "effect" || entry.completed) && entry.authority === "canonical_receipt")
      )
        requiresSourceExpansion = true;
    }
  }
  const omittedSourceRefs = [...new Map(omitted.map((source) => [JSON.stringify(source), source])).values()];
  return { text, omittedSourceRefs, requiresSourceExpansion };
}

export function hashContinuitySources(
  messages: ChatMessageRecord[],
  turnIds: string[],
  canonicalLinks: CanonicalContinuityLink[] = [],
): string {
  return hash(
    JSON.stringify([
      "chat-continuity-v1",
      turnIds,
      messages.map((message) => [
        message.messageId,
        message.sessionId,
        message.role,
        message.actorType,
        message.actorId,
        message.sourceAuthority ?? "unknown",
        message.parentDelegationStepId ?? null,
        message.content,
      ]),
      canonicalLinks,
    ]),
  );
}
function isOperatorOriginal(message: ChatMessageRecord): boolean {
  return (
    message.role === "user" &&
    message.actorType === "user" &&
    message.sourceAuthority === "operator" &&
    !message.parentDelegationStepId
  );
}
function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
/** Count notation retains repeated material and its multiplicity; exact source bytes remain anchored. */
function compressExactRepetition(text:string):string {
  return text.replace(/((?:[\p{L}\p{N}_-]+[.,;!?]?[ \t]+){1,4}?)(?:\1){3,}/gu,
    (run:string,unit:string)=>`[Repeated ${run.length/unit.length} times: ${JSON.stringify(unit)}] `);
}
