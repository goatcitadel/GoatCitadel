import { describe, expect, it } from "vitest";
import { resolveOutboundDraftContent } from "./useChatSurfaceOrchestration";

describe("resolveOutboundDraftContent", () => {
  it("preserves normal draft content", () => {
    expect(resolveOutboundDraftContent(" ship it ", 0)).toBe("ship it");
  });

  it("creates a valid attachment-only send payload", () => {
    expect(resolveOutboundDraftContent("   ", 2)).toBe("Please review the attached files and continue.");
  });

  it("keeps attachment-only edits disabled", () => {
    expect(resolveOutboundDraftContent("   ", 2, "edit")).toBe("");
  });

  it("keeps the send path disabled when there is no text or attachment", () => {
    expect(resolveOutboundDraftContent("   ", 0)).toBe("");
  });
});
