import { describe, expect, it } from "vitest";
import { chatListPreview } from "./chat-list-preview.js";
describe("conversation discovery preview", () => {
  it("redacts before truncation and excludes private/tool/markup bytes", () => {
    expect(chatListPreview("<think>private thought</think><tool_result>private tool</tool_result>Hello **world** [source](https://private.example/path)" )).toBe("Hello world source");
    expect(chatListPreview("Bearer preview-secret-abcdefghij" )).not.toContain("preview-secret");
    expect(chatListPreview("<analysis>private unfinished")).toBeUndefined();
    expect(chatListPreview("<!-- private -->")).toBeUndefined();
  });
  it("bounds visible Unicode characters and handles empty and captured messages", () => {
    expect(Array.from(chatListPreview("😀".repeat(200))!)).toHaveLength(160);
    expect(chatListPreview("a".repeat(200))).toHaveLength(160);
    expect(chatListPreview("  ")).toBeUndefined();
    expect(chatListPreview(undefined)).toBeUndefined();
    expect(chatListPreview("header<workflow_evidence>private envelope")).toBe("Captured workflow for review");
  });
});
