import { REASONING_BLOCK_TAGS } from "./channel-sanitizer.js";

/**
 * Local and OpenAI-compatible reasoning models (Ollama, LM Studio, llama.cpp
 * without a reasoning parser) often write their reasoning inline as
 * `<think>…</think>` at the start of the answer instead of in a separate
 * `reasoning_content` field. This splitter routes such leading blocks to
 * reasoning so they never become part of the visible answer.
 *
 * Only blocks that open the reply (after optional whitespace or a previous
 * reasoning block) count: once answer text starts, later tags pass through as
 * answer text, so a reply that discusses `<analysis>` tags stays intact.
 * Streaming-safe: a half-arrived `<thin` or `</thi` is held back until it
 * resolves, and `flush()` releases whatever is still held.
 */
export interface InlineReasoningSplit {
  answer: string;
  reasoning: string;
}

export interface InlineReasoningSplitter {
  push(text: string): InlineReasoningSplit;
  flush(): InlineReasoningSplit;
}

/** A leading `<tag …` longer than this without its `>` is treated as answer text. */
const MAX_HELD_OPENING_TAG_LENGTH = 64;
const OPENING_TAG_RE = /^<([A-Za-z_]+)(?:\s[^<>]*)?>/;

export function createInlineReasoningSplitter(tags: readonly string[] = REASONING_BLOCK_TAGS): InlineReasoningSplitter {
  let mode: "leading" | "reasoning" | "answer" = "leading";
  let pending = "";
  let closeTag = "";

  const push = (text: string): InlineReasoningSplit => {
    let answer = "";
    let reasoning = "";
    pending += text;
    for (;;) {
      if (mode === "answer") {
        answer += pending;
        pending = "";
        break;
      }
      if (mode === "reasoning") {
        const close = new RegExp(`</${closeTag}\\s*>`, "i").exec(pending);
        if (close) {
          reasoning += pending.slice(0, close.index);
          pending = pending.slice(close.index + close[0].length);
          mode = "leading";
          continue;
        }
        const heldFrom = heldClosingTagStart(pending, closeTag);
        reasoning += pending.slice(0, heldFrom);
        pending = pending.slice(heldFrom);
        break;
      }
      const start = pending.trimStart();
      if (!start) break;
      const opening = OPENING_TAG_RE.exec(start);
      const openingName = opening?.[1]?.toLowerCase();
      if (opening && openingName && tags.includes(openingName)) {
        mode = "reasoning";
        closeTag = openingName;
        pending = start.slice(opening[0].length);
        continue;
      }
      if (start.length <= MAX_HELD_OPENING_TAG_LENGTH && couldBeOpeningTag(start, tags)) break;
      mode = "answer";
      pending = start;
    }
    return { answer, reasoning };
  };

  const flush = (): InlineReasoningSplit => {
    const held = pending;
    pending = "";
    if (mode === "reasoning") return { answer: "", reasoning: held };
    return { answer: mode === "leading" ? held.trimStart() : held, reasoning: "" };
  };

  return { push, flush };
}

/** Splits a complete message: the answer without leading reasoning blocks, plus that reasoning. */
export function splitInlineReasoning(content: string): InlineReasoningSplit {
  if (!content.trimStart().startsWith("<")) return { answer: content, reasoning: "" };
  const splitter = createInlineReasoningSplitter();
  const head = splitter.push(content);
  const tail = splitter.flush();
  return { answer: head.answer + tail.answer, reasoning: head.reasoning + tail.reasoning };
}

function couldBeOpeningTag(text: string, tags: readonly string[]): boolean {
  const match = /^<([A-Za-z_]*)/.exec(text);
  if (!match) return false;
  const name = (match[1] ?? "").toLowerCase();
  const rest = text.slice(1 + name.length);
  if (!rest) return tags.some((tag) => tag.startsWith(name));
  return tags.includes(name) && /^\s[^<>]*$/.test(rest);
}

/** Index where a possibly half-arrived `</tag>` begins at the end of `text`, or `text.length`. */
function heldClosingTagStart(text: string, tag: string): number {
  const start = text.lastIndexOf("<");
  if (start === -1) return text.length;
  const suffix = text.slice(start).toLowerCase();
  const closing = `</${tag}`;
  if (closing.startsWith(suffix) || (suffix.startsWith(closing) && !suffix.slice(closing.length).trim())) {
    return start;
  }
  return text.length;
}
