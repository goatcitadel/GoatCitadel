import { describe, expect, it } from "vitest";
import { assertAttachmentBytesMatchMimeHint, decodeStrictBase64, sniffAttachmentBytes } from "./media-voice-service.js";

// Regression coverage for SECURITY_AUDIT_2026-05-15 — S12 (media byte sniff +
// strict base64). Distrust filename and MIME hints; reject malformed base64.

describe("sniffAttachmentBytes (S12)", () => {
  it("classifies PNG, JPEG, GIF, WebP, BMP, TIFF as image", () => {
    expect(sniffAttachmentBytes(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image");
    expect(sniffAttachmentBytes(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]))).toBe("image");
    expect(sniffAttachmentBytes(Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe("image");
    expect(
      sniffAttachmentBytes(Buffer.from([0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50])),
    ).toBe("image");
    expect(sniffAttachmentBytes(Buffer.from([0x42, 0x4d, 0x10, 0x00]))).toBe("image");
    expect(sniffAttachmentBytes(Buffer.from([0x49, 0x49, 0x2a, 0x00]))).toBe("image");
  });

  it("classifies WAV, OGG, MP3, FLAC as audio", () => {
    expect(
      sniffAttachmentBytes(Buffer.from([0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45])),
    ).toBe("audio");
    expect(sniffAttachmentBytes(Buffer.from([0x4f, 0x67, 0x67, 0x53]))).toBe("audio");
    expect(sniffAttachmentBytes(Buffer.from([0x49, 0x44, 0x33, 0x04]))).toBe("audio");
    expect(sniffAttachmentBytes(Buffer.from([0xff, 0xfb, 0x90, 0x44]))).toBe("audio");
    expect(sniffAttachmentBytes(Buffer.from([0x66, 0x4c, 0x61, 0x43]))).toBe("audio");
  });

  it("classifies zip as archive — even when the wrapper later claims to be a docx/xlsx", () => {
    expect(sniffAttachmentBytes(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]))).toBe("archive");
    expect(sniffAttachmentBytes(Buffer.from([0x50, 0x4b, 0x05, 0x06]))).toBe("archive");
    expect(sniffAttachmentBytes(Buffer.from([0x1f, 0x8b, 0x08, 0x00]))).toBe("archive"); // gzip
    expect(sniffAttachmentBytes(Buffer.from([0x52, 0x61, 0x72, 0x21]))).toBe("archive"); // RAR
  });

  it("classifies PDF as document", () => {
    expect(sniffAttachmentBytes(Buffer.from("%PDF-1.4\n", "ascii"))).toBe("document");
  });

  it("returns unknown on empty / too-short / opaque binary", () => {
    expect(sniffAttachmentBytes(Buffer.alloc(0))).toBe("unknown");
    expect(sniffAttachmentBytes(Buffer.from([0x00, 0xde, 0xad, 0xbe, 0xef]))).toBe("unknown");
  });

  it("classifies plain text", () => {
    expect(sniffAttachmentBytes(Buffer.from("Hello, world! This is text.\n", "utf8"))).toBe("text");
  });
});

describe("assertAttachmentBytesMatchMimeHint (S12)", () => {
  it("rejects zip bytes claiming to be a PNG", () => {
    const zipBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00]);
    expect(() => assertAttachmentBytesMatchMimeHint(zipBytes, "image/png")).toThrow(
      /do not match the declared MIME hint/,
    );
  });

  it("rejects PDF bytes claiming to be an MP4 video", () => {
    expect(() => assertAttachmentBytesMatchMimeHint(Buffer.from("%PDF-1.7\n", "ascii"), "video/mp4")).toThrow(
      /do not match the declared MIME hint/,
    );
  });

  it("rejects archive bytes claiming to be audio", () => {
    expect(() => assertAttachmentBytesMatchMimeHint(Buffer.from([0x50, 0x4b, 0x03, 0x04]), "audio/mp3")).toThrow(
      /do not match the declared MIME hint/,
    );
  });

  it("allows PNG bytes declared as image/png", () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
    expect(() => assertAttachmentBytesMatchMimeHint(pngBytes, "image/png")).not.toThrow();
  });

  it("allows SVG (text) bytes declared as image/svg+xml", () => {
    const svgBytes = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>', "utf8");
    expect(() => assertAttachmentBytesMatchMimeHint(svgBytes, "image/svg+xml")).not.toThrow();
  });

  it("skips validation for non-media classes (no false positives on text uploads)", () => {
    expect(() =>
      assertAttachmentBytesMatchMimeHint(Buffer.from([0x50, 0x4b, 0x03, 0x04]), "application/octet-stream"),
    ).not.toThrow();
  });

  it("allows unknown bytes through (uncommon legitimate formats; no false positives)", () => {
    // 4-byte payload too short to confidently classify
    expect(() => assertAttachmentBytesMatchMimeHint(Buffer.from([0x00, 0xfe, 0xed, 0xfa]), "image/png")).not.toThrow();
  });
});

describe("decodeStrictBase64 (S12)", () => {
  it("decodes valid base64", () => {
    expect(decodeStrictBase64("aGVsbG8=").toString("utf8")).toBe("hello");
    expect(decodeStrictBase64(Buffer.from("PNG-payload").toString("base64")).toString("utf8")).toBe("PNG-payload");
  });

  it("rejects an empty payload", () => {
    expect(() => decodeStrictBase64("")).toThrow(/empty/i);
    expect(() => decodeStrictBase64("   \n\t")).toThrow(/empty/i);
  });

  it("rejects characters outside the base64 alphabet", () => {
    expect(() => decodeStrictBase64("aGVsbG8$")).toThrow(/base64 alphabet/);
    expect(() => decodeStrictBase64("nope!")).toThrow(/base64 alphabet/);
  });

  it("rejects length not a multiple of 4", () => {
    expect(() => decodeStrictBase64("aGVsbG")).toThrow(/multiple of 4/);
  });

  it("rejects multi-= padding patterns that Buffer.from would silently tolerate", () => {
    // Buffer.from('a===', 'base64') decodes to 1 byte; strict rejects.
    expect(() => decodeStrictBase64("a===")).toThrow();
    // Internal `=` is not legal base64 even though Buffer.from tolerates it.
    expect(() => decodeStrictBase64("aG=sbG8=")).toThrow();
  });

  it("tolerates internal whitespace before stripping (consistent with normal base64 line wrapping)", () => {
    expect(decodeStrictBase64("aGVs\n  bG8=").toString("utf8")).toBe("hello");
  });
});
