import { describe, expect, it } from "vitest";
import { projectGoogleMessage } from "./google-mail-content.js";
describe("complete Gmail content projection", () => {
  it("marks unloaded external text as incomplete, never as a complete empty message", () => {
    expect(
      projectGoogleMessage({
        id: "m",
        payload: { mimeType: "text/plain", body: { attachmentId: "external", size: 123 } },
      }).truncated,
    ).toBe(true);
  });
  it("decodes multipart plain text and exposes attachment descriptors without binary data", () => {
    const result = projectGoogleMessage({
      id: "m1",
      threadId: "t1",
      payload: {
        headers: [{ name: "Subject", value: "Hi" }],
        parts: [
          { mimeType: "text/plain", body: { data: Buffer.from("Whole message\nSecond line").toString("base64url") } },
          {
            filename: "report.pdf",
            mimeType: "application/pdf",
            partId: "1",
            body: { attachmentId: "a1", size: 42, data: "SECRET-BINARY" },
          },
        ],
      },
    });
    expect(result.bodyText).toBe("Whole message\nSecond line");
    expect(result.attachments).toEqual([
      { attachmentId: "a1", filename: "report.pdf", contentType: "application/pdf", size: 42, partId: "1" },
    ]);
    expect(JSON.stringify(result)).not.toContain("SECRET-BINARY");
    expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });
  it("does not render HTML and bounds large decoded bodies", () => {
    const result = projectGoogleMessage({
      id: "m1",
      payload: {
        mimeType: "text/html",
        body: { data: Buffer.from("<script>steal()</script><p>Hello &amp; welcome</p>").toString("base64url") },
      },
    });
    expect(result.bodyText).toContain("Hello & welcome");
    expect(result.bodyText).not.toContain("steal");
    const huge = projectGoogleMessage({
      id: "m2",
      payload: { mimeType: "text/plain", body: { data: Buffer.from("x".repeat(150_000)).toString("base64url") } },
    });
    expect(Buffer.byteLength(String(huge.bodyText))).toBeLessThanOrEqual(131072);
    expect(huge.truncated).toBe(true);
  });
});
