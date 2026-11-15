import { describe, expect, it } from "vitest";
import {
  CHAT_ATTACHMENT_PROMPT_PREVIEW_CHARS,
  chatAttachmentIsTextLike,
  chatAttachmentPromptIsPartial,
} from "./chat.js";

describe("chat attachment preview rules", () => {
  it("never labels a text file of 1,600 bytes or fewer as cut", () => {
    expect(CHAT_ATTACHMENT_PROMPT_PREVIEW_CHARS).toBe(1600);
    expect(chatAttachmentPromptIsPartial({ fileName: "a.md", mimeType: "text/markdown", sizeBytes: 1600 })).toBe(false);
    expect(chatAttachmentPromptIsPartial({ fileName: "a.md", mimeType: "text/markdown", sizeBytes: 1601 })).toBe(true);
  });

  it("never labels a file that is not read as text", () => {
    expect(chatAttachmentPromptIsPartial({ fileName: "a.png", mimeType: "image/png", sizeBytes: 9999 })).toBe(false);
  });

  it("keeps the text-like rule: text types, json, xml and known extensions", () => {
    expect(chatAttachmentIsTextLike({ fileName: "a", mimeType: "text/plain" })).toBe(true);
    expect(chatAttachmentIsTextLike({ fileName: "a", mimeType: "application/json" })).toBe(true);
    expect(chatAttachmentIsTextLike({ fileName: "a", mimeType: "application/xml" })).toBe(true);
    expect(chatAttachmentIsTextLike({ fileName: "a.YML", mimeType: "application/octet-stream" })).toBe(true);
    expect(chatAttachmentIsTextLike({ fileName: "a.pdf", mimeType: "application/pdf" })).toBe(false);
  });
});
