import { describe, expect, it } from "vitest";

import { splitUtf8HeadTail, truncateUtf8Bytes } from "./utf8-truncation.js";

describe("truncateUtf8Bytes", () => {
  it("returns the identical string when under the byte limit", () => {
    const text = "short output";
    expect(truncateUtf8Bytes(text, 1024, "keepStart")).toBe(text);
    expect(truncateUtf8Bytes(text, 1024, "keepEnd")).toBe(text);
  });

  it("keeps the start of the text in keepStart mode", () => {
    const text = "abcdefghij";
    expect(truncateUtf8Bytes(text, 4, "keepStart")).toBe("abcd");
  });

  it("keeps the end of the text in keepEnd mode", () => {
    const text = "abcdefghij";
    expect(truncateUtf8Bytes(text, 4, "keepEnd")).toBe("ghij");
  });

  it("never splits a multibyte character at the trailing cut", () => {
    // "é" is 2 bytes in UTF-8; a 3-byte keepStart cut lands mid-character.
    const truncated = truncateUtf8Bytes("aéé", 3, "keepStart");
    expect(truncated).toBe("aé");
    expect(truncated.includes("�")).toBe(false);
  });

  it("never splits a multibyte character at the leading cut", () => {
    const truncated = truncateUtf8Bytes("ééa", 3, "keepEnd");
    expect(truncated).toBe("éa");
    expect(truncated.includes("�")).toBe(false);
  });

  it("handles four-byte characters without emitting replacement characters", () => {
    const emoji = "😀😀😀"; // 4 bytes each
    for (const bound of [1, 2, 3, 4, 5, 6, 7, 8]) {
      expect(truncateUtf8Bytes(emoji, bound, "keepStart").includes("�")).toBe(false);
      expect(truncateUtf8Bytes(emoji, bound, "keepEnd").includes("�")).toBe(false);
    }
  });
});

describe("splitUtf8HeadTail", () => {
  it("passes short text through untruncated", () => {
    const result = splitUtf8HeadTail("small", 16, 16);
    expect(result).toEqual({ truncated: false, head: "small", tail: "", omittedBytes: 0 });
  });

  it("treats text exactly at the combined bound as untruncated", () => {
    const text = "x".repeat(32);
    const result = splitUtf8HeadTail(text, 16, 16);
    expect(result).toEqual({ truncated: false, head: text, tail: "", omittedBytes: 0 });
  });

  it("keeps head and tail with accurate omitted byte count", () => {
    const text = `HEAD-MARK${"m".repeat(100)}TAIL-MARK`;
    const result = splitUtf8HeadTail(text, 10, 10);
    expect(result.truncated).toBe(true);
    expect(result.head.startsWith("HEAD-MARK")).toBe(true);
    expect(result.tail.endsWith("TAIL-MARK")).toBe(true);
    const retained = Buffer.byteLength(result.head, "utf8") + Buffer.byteLength(result.tail, "utf8");
    expect(result.omittedBytes).toBe(Buffer.byteLength(text, "utf8") - retained);
    expect(result.omittedBytes).toBeGreaterThan(0);
  });

  it("does not split multibyte characters at either cut", () => {
    const text = "é".repeat(50);
    const result = splitUtf8HeadTail(text, 5, 5);
    expect(result.truncated).toBe(true);
    expect(result.head.includes("�")).toBe(false);
    expect(result.tail.includes("�")).toBe(false);
    expect(Buffer.byteLength(result.head, "utf8")).toBeLessThanOrEqual(5);
    expect(Buffer.byteLength(result.tail, "utf8")).toBeLessThanOrEqual(5);
  });
});
