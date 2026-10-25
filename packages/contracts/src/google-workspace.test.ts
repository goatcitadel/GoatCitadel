import { describe, expect, it } from "vitest";
import {
  googleWorkspaceCapabilityForTool,
  googleWorkspaceScopesFor,
  isGoogleWorkspaceCapabilityGranted,
  readEnabledGoogleWorkspaceCapabilities,
  summarizeGmailMessage,
} from "./google-workspace.js";

describe("Google Workspace capabilities", () => {
  it("maps each tool to one capability and each capability to one requested scope", () => {
    expect(googleWorkspaceCapabilityForTool("gmail.read")).toBe("gmail.read");
    expect(googleWorkspaceCapabilityForTool("gmail.send")).toBe("gmail.send");
    expect(googleWorkspaceCapabilityForTool("calendar.list")).toBe("calendar.read");
    expect(googleWorkspaceCapabilityForTool("calendar.create_event")).toBe("calendar.write");
    expect(googleWorkspaceCapabilityForTool("slack.send")).toBeUndefined();
    expect(googleWorkspaceScopesFor(["calendar.write", "gmail.read"])).toEqual([
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/calendar.events",
    ]);
  });

  it("counts a broader grant but never lets a read scope stand in for a write", () => {
    const readonly = ["https://www.googleapis.com/auth/gmail.readonly"];
    expect(isGoogleWorkspaceCapabilityGranted("gmail.read", readonly)).toBe(true);
    expect(isGoogleWorkspaceCapabilityGranted("gmail.send", readonly)).toBe(false);
    const events = ["https://www.googleapis.com/auth/calendar.events"];
    expect(isGoogleWorkspaceCapabilityGranted("calendar.read", events)).toBe(true);
    expect(
      isGoogleWorkspaceCapabilityGranted("calendar.write", [
        "https://www.googleapis.com/auth/calendar.events.readonly",
      ]),
    ).toBe(false);
  });

  it("treats only an explicit true as a switched-on capability", () => {
    expect(
      readEnabledGoogleWorkspaceCapabilities({
        gmailRead: true,
        gmailSend: "true",
        calendarRead: "yes",
        calendarWrite: 1,
      }),
    ).toEqual(["gmail.read", "gmail.send"]);
    expect(readEnabledGoogleWorkspaceCapabilities(JSON.parse('{"__proto__": {"gmailRead": true}}'))).toEqual([]);
  });
});

describe("summarizeGmailMessage", () => {
  it("keeps bounded single-line metadata and decodes Gmail's escaped snippet", () => {
    const summary = summarizeGmailMessage({
      id: "18c2f",
      threadId: "18c2e",
      internalDate: "1761400000000",
      snippet: "Fish &amp; chips &#39;tonight&#39; &#x1F41F;",
      labelIds: ["INBOX", 7, "UNREAD"],
      payload: {
        headers: [
          { name: "subject", value: `Line one\r\nBcc: someone@example.com ${"x".repeat(500)}` },
          { name: "FROM", value: "A ‮B <a@example.com>" },
          { name: "To", value: "me@example.com" },
          { name: "Date", value: "Sat, 25 Oct 2026 10:00:00 +0000" },
        ],
      },
    });
    expect(summary).toMatchObject({
      id: "18c2f",
      threadId: "18c2e",
      from: "A B <a@example.com>",
      to: "me@example.com",
      date: "Sat, 25 Oct 2026 10:00:00 +0000",
      receivedAt: new Date(1761400000000).toISOString(),
      snippet: "Fish & chips 'tonight' \u{1F41F}",
      labelIds: ["INBOX", "UNREAD"],
    });
    expect(summary!.subject!.length).toBe(300);
    expect(summary!.subject).toMatch(/^Line one Bcc: someone@example\.com x+…$/);
  });

  it("returns nothing without a message id and drops fields it cannot read", () => {
    expect(summarizeGmailMessage({ snippet: "no id" })).toBeUndefined();
    expect(summarizeGmailMessage("nope")).toBeUndefined();
    expect(summarizeGmailMessage({ id: "m1", payload: { headers: "bad" }, snippet: 5 })).toEqual({ id: "m1" });
  });
});
