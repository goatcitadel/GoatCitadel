/**
 * Byte-bounded UTF-8 truncation that never splits a multibyte character.
 * Callers redact BEFORE truncating so a secret straddling a cut is already
 * masked (see remote-worker-cell-terminal-capture for the originating rule).
 */

export type Utf8TruncationMode = "keepStart" | "keepEnd";

/** Truncate text to a byte bound, keeping the requested end of the string. */
export function truncateUtf8Bytes(text: string, maxBytes: number, mode: Utf8TruncationMode): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) {
    return text;
  }
  return mode === "keepStart"
    ? decodeUtf8DropTrailingPartial(buffer.subarray(0, maxBytes))
    : decodeUtf8DropLeadingPartial(buffer.subarray(buffer.length - maxBytes));
}

export interface Utf8HeadTailSplit {
  /** Whether anything was omitted; when false, `head` is the whole text. */
  readonly truncated: boolean;
  readonly head: string;
  readonly tail: string;
  /** Bytes omitted between head and tail (0 when untruncated). */
  readonly omittedBytes: number;
}

/**
 * Bound text to `headBytes` from the start plus `tailBytes` from the end.
 * The caller owns joining the parts with its own omission marker so byte
 * accounting here stays exact and marker text is never itself truncated.
 */
export function splitUtf8HeadTail(text: string, headBytes: number, tailBytes: number): Utf8HeadTailSplit {
  const totalBytes = Buffer.byteLength(text, "utf8");
  if (totalBytes <= headBytes + tailBytes) {
    return { truncated: false, head: text, tail: "", omittedBytes: 0 };
  }
  const head = truncateUtf8Bytes(text, headBytes, "keepStart");
  const tail = truncateUtf8Bytes(text, tailBytes, "keepEnd");
  const retainedBytes = Buffer.byteLength(head, "utf8") + Buffer.byteLength(tail, "utf8");
  return {
    truncated: true,
    head,
    tail,
    omittedBytes: totalBytes - retainedBytes,
  };
}

/** Decode bytes to UTF-8, dropping a trailing partial multibyte sequence so a character is never split. */
function decodeUtf8DropTrailingPartial(buffer: Buffer): string {
  let end = buffer.length;
  let lead = buffer.length - 1;
  while (lead >= 0 && (buffer[lead]! & 0b1100_0000) === 0b1000_0000) {
    lead -= 1;
  }
  if (lead >= 0) {
    const leadByte = buffer[lead]!;
    const sequenceLength = leadByte >= 0b1111_0000 ? 4 : leadByte >= 0b1110_0000 ? 3 : leadByte >= 0b1100_0000 ? 2 : 1;
    if (end - lead < sequenceLength) {
      end = lead;
    }
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(buffer.subarray(0, end));
}

/** Decode bytes to UTF-8, dropping a leading partial multibyte sequence so a character is never split. */
function decodeUtf8DropLeadingPartial(buffer: Buffer): string {
  let start = 0;
  while (start < buffer.length && (buffer[start]! & 0b1100_0000) === 0b1000_0000) {
    start += 1;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(buffer.subarray(start));
}
