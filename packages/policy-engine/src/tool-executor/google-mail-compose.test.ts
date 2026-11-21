import { describe, expect, it } from "vitest";
import { prepareGoogleMail } from "./google-mail-compose.js";
const original = {
  kind: "message",
  full: {
    id: "m1",
    threadId: "thread-1",
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: "Alice <alice@example.com>" },
        { name: "Subject", value: "Review" },
        { name: "Message-ID", value: "<original@example.com>" },
      ],
      body: { data: Buffer.from("Original text").toString("base64url") },
    },
  },
};
describe("reviewed Gmail MIME", () => {
  it("gives independently prepared identical messages distinct Message-IDs", async () => {
    const args = { to: ["a@example.com"], subject: "Hi", bodyText: "Body" };
    const first = await prepareGoogleMail("gmail.send", args, undefined);
    const second = await prepareGoogleMail("gmail.send", args, undefined);
    expect(first.prepared.raw).not.toBe(second.prepared.raw);
    expect(first.prepared.materialHash).toBe(second.prepared.materialHash);
  });
  it("rejects duplicate saved-draft recipient headers rather than approving only one", async () => {
    const headers = [
      { name: "To", value: "a@example.com" },
      { name: "To", value: "hidden@example.com" },
    ];
    const source = {
      kind: "draft",
      draftId: "d",
      full: { message: { id: "m", payload: { headers } } },
      raw: Buffer.from("To: a@example.com\r\nTo: hidden@example.com\r\n\r\nBody").toString("base64url"),
    };
    await expect(prepareGoogleMail("gmail.send_draft", { sourceToolRunId: "r" }, undefined, source)).rejects.toThrow(
      /Duplicate/,
    );
  });
  it("keeps replies in the actual original thread and sets threading headers", async () => {
    const result = await prepareGoogleMail(
      "gmail.reply",
      { connectionId: "g", bodyText: "My reply", sourceToolRunId: "read-1" },
      undefined,
      original,
    );
    const mime = Buffer.from(result.prepared.raw, "base64url").toString();
    expect(mime).toContain("In-Reply-To: <original@example.com>");
    expect(mime).toContain("References: <original@example.com>");
    expect(result.prepared.threadId).toBe("thread-1");
    expect(result.args.to).toEqual(["Alice <alice@example.com>"]);
  });
  it("preserves CC/BCC and rejects header injection before reading attachments", async () => {
    const result = await prepareGoogleMail(
      "gmail.send",
      { to: ["to@example.com"], cc: ["cc@example.com"], bcc: ["hidden@example.com"], subject: "Hi", bodyText: "Body" },
      undefined,
    );
    const mime = Buffer.from(result.prepared.raw, "base64url").toString();
    expect(mime).toContain("Cc: cc@example.com");
    expect(mime).toContain("Bcc: hidden@example.com");
    await expect(
      prepareGoogleMail(
        "gmail.send",
        { to: ["to@example.com\r\nBcc: bad@example.com"], subject: "Hi", bodyText: "Body" },
        undefined,
      ),
    ).rejects.toThrow(/blocked/);
  });
  it("forwards the source text but never silently adds its attachments", async () => {
    const result = await prepareGoogleMail(
      "gmail.forward",
      { to: ["to@example.com"], bodyText: "FYI" },
      undefined,
      original,
    );
    expect(result.args.bodyText).toContain("Original text");
    expect(result.args.subject).toBe("Fwd: Review");
    expect(result.args.attachments).toBeUndefined();
  });
});
