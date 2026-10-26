import { describe, expect, it } from "vitest";
import { attachRetryAfter, parseRetryAfterMs, readRetryAfterMs } from "./provider-retry-after.js";

describe("provider Retry-After", () => {
  it("parses delta-seconds and HTTP-dates, rejecting junk", () => {
    const now = Date.parse("2026-10-25T12:00:00Z");
    expect(parseRetryAfterMs("3", now)).toBe(3000);
    expect(parseRetryAfterMs("1.5", now)).toBe(1500);
    expect(parseRetryAfterMs("Sun, 25 Oct 2026 12:00:07 GMT", now)).toBe(7000);
    expect(parseRetryAfterMs("Sun, 25 Oct 2026 11:00:00 GMT", now)).toBe(0);
    expect(parseRetryAfterMs("soon", now)).toBeUndefined();
    expect(parseRetryAfterMs("", now)).toBeUndefined();
    expect(parseRetryAfterMs(null, now)).toBeUndefined();
    expect(parseRetryAfterMs("-5", now)).toBeUndefined();
  });

  it("attaches the header value to the error when present", () => {
    const withHeader = attachRetryAfter(
      new Error("429"),
      new Response("", { status: 429, headers: { "retry-after": "2" } }),
    );
    expect(readRetryAfterMs(withHeader)).toBe(2000);
    expect(readRetryAfterMs(attachRetryAfter(new Error("500"), new Response("", { status: 500 })))).toBeUndefined();
    expect(readRetryAfterMs("not an error")).toBeUndefined();
  });
});
