import { describe, expect, it } from "vitest";
import { browserApprovalPreview } from "./browser-approval-preview.js";

describe("browser approval previews", () => {
  it("shows the search query, backend and result limit", () => {
    expect(
      browserApprovalPreview("browser.search", { query: "launch notes", backend: "native", maxResults: 3 }),
    ).toMatchObject({ target: "native", input: "launch notes", optionsSummary: "Maximum results: 3" });
  });

  it("shows the scope of reads and clears, even without a filter", () => {
    expect(browserApprovalPreview("browser.cookies.clear", {})?.input).toBe("All cookies within the allowed scope");
    expect(browserApprovalPreview("browser.storage.get", { origin: "https://example.test" })?.input).toBe(
      "Origin: https://example.test\nStorage: both",
    );
  });

  it("shows browser state targets without echoing values", () => {
    const cookie = browserApprovalPreview("browser.cookies.set", {
      cookies: [{ name: "session", domain: "example.test", value: "cookie-value" }],
    });
    const storage = browserApprovalPreview("browser.storage.set", {
      origin: "https://example.test",
      entries: { session: "storage-value" },
    });
    const context = browserApprovalPreview("browser.context.configure", {
      httpCredentials: { username: "account", password: "credential-value" },
    });
    expect(cookie?.input).toContain("Cookie name: session");
    expect(storage?.input).toContain("Entry: session");
    expect(context?.input).toBe("HTTP credentials: Update");
    expect(JSON.stringify([cookie, storage, context])).not.toMatch(/cookie-value|storage-value|credential-value/);
  });
});
