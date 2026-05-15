import { describe, expect, it } from "vitest";
import { formatFileSize, isAbortError, isImageFile } from "./files-page-helpers";

describe("files-page helpers", () => {
  it.each([
    [Number.NaN, "-"],
    [-1, "-"],
    [512, "512 B"],
    [1536, "1.50 KB"],
    [12 * 1024, "12.0 KB"],
    [5 * 1024 * 1024, "5.00 MB"],
    [12 * 1024 * 1024 * 1024, "12.0 GB"],
    [2 * 1024 * 1024 * 1024 * 1024, "2.00 TB"],
  ])("formats %s bytes as %s", (input, expected) => {
    expect(formatFileSize(input)).toBe(expected);
  });

  it.each([
    ["diagram.svg", undefined, true],
    ["README.md", "image/png", true],
    ["photo.TIFF", undefined, true],
    ["notes/image.txt", "text/plain", false],
    ["no-extension", undefined, false],
  ])("detects image files for %s and %s", (path, contentType, expected) => {
    expect(isImageFile(path, contentType)).toBe(expected);
  });

  it("recognizes only DOM abort errors", () => {
    expect(isAbortError(new DOMException("cancelled", "AbortError"))).toBe(true);
    expect(isAbortError(new DOMException("network", "NetworkError"))).toBe(false);
    expect(isAbortError(new Error("AbortError"))).toBe(false);
    expect(isAbortError("AbortError")).toBe(false);
  });
});
