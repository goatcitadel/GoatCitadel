import { describe, expect, it } from "vitest";
import { CHAT_ATTACHMENT_PASSIVE_INLINE_MIME } from "./chat.attachments.js";

// Regression coverage for CODEX_FINDING #9: the chat attachment Open
// flow previously created a blob: URL with the uploader-supplied MIME
// type and assigned it to a new tab. text/html and image/svg+xml became
// stored XSS against the Mission Control origin. The route fix:
//   - X-Content-Type-Options: nosniff always set
//   - Content-Security-Policy: default-src 'none'; sandbox always set
//   - inline disposition restricted to a strict passive-MIME allowlist
//   - everything else forced to attachment + application/octet-stream
// This test pins the allowlist contents; the route headers themselves
// are exercised by the integration test suite that boots Fastify.

describe("CHAT_ATTACHMENT_PASSIVE_INLINE_MIME (codex #9)", () => {
  it("includes only safe passive image types and PDF", () => {
    expect([...CHAT_ATTACHMENT_PASSIVE_INLINE_MIME].sort()).toEqual(
      ["application/pdf", "image/gif", "image/jpeg", "image/jpg", "image/png", "image/webp"].sort(),
    );
  });

  it("explicitly excludes SVG (script-capable)", () => {
    expect(CHAT_ATTACHMENT_PASSIVE_INLINE_MIME.has("image/svg+xml")).toBe(false);
  });

  it("explicitly excludes HTML", () => {
    expect(CHAT_ATTACHMENT_PASSIVE_INLINE_MIME.has("text/html")).toBe(false);
  });

  it("explicitly excludes JavaScript and JSON-via-text", () => {
    expect(CHAT_ATTACHMENT_PASSIVE_INLINE_MIME.has("application/javascript")).toBe(false);
    expect(CHAT_ATTACHMENT_PASSIVE_INLINE_MIME.has("text/javascript")).toBe(false);
  });
});
