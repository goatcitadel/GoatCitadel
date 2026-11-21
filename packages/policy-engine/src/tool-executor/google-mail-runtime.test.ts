import { describe, expect, it, vi } from "vitest";
import { prepareGoogleMail } from "./google-mail-compose.js";
import { executeGoogleMailAction } from "./google-mail-runtime.js";

const message = {
  id: "m",
  threadId: "t",
  payload: {
    mimeType: "text/plain",
    headers: [
      { name: "To", value: "a@example.com" },
      { name: "Subject", value: "Hi" },
    ],
    body: { data: Buffer.from("Body").toString("base64url") },
  },
};
const source = {
  kind: "draft",
  draftId: "d",
  full: { id: "d", message },
  raw: Buffer.from("To: a@example.com\r\nSubject: Hi\r\n\r\nBody").toString("base64url"),
};
describe("native Gmail provider execution", () => {
  it("loads an externalized text body without downloading binary attachments", async () => {
    const external = {
      ...message,
      payload: { mimeType: "text/plain", body: { attachmentId: "text-part", size: 12, data: "" } },
    };
    const http = vi.fn(async (url: string) =>
      url.includes("/attachments/") ? { data: Buffer.from("Full content").toString("base64url") } : external,
    );
    const result = await executeGoogleMailAction("gmail.get_message", { messageId: "m" }, { identity: "a", http });
    expect(result.message).toMatchObject({ bodyText: "Full content", truncated: false });
    expect(http).toHaveBeenCalledTimes(2);
  });
  it("sends frozen draft MIME with its original thread and refuses a concurrent edit", async () => {
    const frozen = await prepareGoogleMail(
      "gmail.send_draft",
      { connectionId: "g", sourceToolRunId: "r" },
      undefined,
      source,
    );
    const http = vi.fn(async (_url: string, options?: { method?: string }) =>
      options?.method === "POST" ? { id: "sent" } : source.full,
    );
    const result = await executeGoogleMailAction(
      "gmail.send_draft",
      frozen.args,
      { identity: "account", http },
      frozen.prepared,
    );
    expect(result.sent).toBe(true);
    expect(http).toHaveBeenLastCalledWith(expect.stringContaining("drafts/send"), {
      method: "POST",
      body: { id: "d", message: { raw: source.raw, threadId: "t" } },
    });
    const changed = vi.fn(async () => ({ id: "d", message: { ...message, id: "replacement" } }));
    await expect(
      executeGoogleMailAction("gmail.send_draft", frozen.args, { identity: "account", http: changed }, frozen.prepared),
    ).rejects.toThrow(/changed/);
    expect(changed).toHaveBeenCalledTimes(1);
  });
  it("binds continuation to account/query and skips a removed search result", async () => {
    const http = vi.fn(async (url: string) =>
      url.includes("format=metadata") ? {} : { messages: [{ id: "gone" }], nextPageToken: "provider-page" },
    );
    const first = await executeGoogleMailAction("gmail.read", { query: "important" }, { identity: "a", http });
    expect(first.records).toEqual([]);
    await expect(
      executeGoogleMailAction(
        "gmail.read",
        { query: "different", pageToken: first.nextPageToken },
        { identity: "a", http },
      ),
    ).rejects.toThrow(/another Google account or query/);
    await expect(
      executeGoogleMailAction(
        "gmail.read",
        { query: "important", pageToken: first.nextPageToken },
        { identity: "b", http },
      ),
    ).rejects.toThrow(/another Google account or query/);
    expect(http).toHaveBeenCalledTimes(2);
  });
  it("uses Trash, never the permanent message-delete endpoint", async () => {
    const http = vi.fn(async () => ({ id: "m" }));
    await executeGoogleMailAction(
      "gmail.modify_message",
      { messageId: "m", operation: "trash" },
      { identity: "a", http },
    );
    expect(http).toHaveBeenCalledWith(expect.stringMatching(/messages\/m\/trash$/), { method: "POST", body: {} });
  });
  it("refuses modified outgoing review fields before any provider call", async () => {
    const frozen = await prepareGoogleMail("gmail.send", { to: ["a@example.com"], bodyText: "Hi" }, undefined);
    const http = vi.fn();
    await expect(
      executeGoogleMailAction(
        "gmail.send",
        { ...frozen.args, bcc: ["hidden@example.com"] },
        { identity: "a", http },
        frozen.prepared,
      ),
    ).rejects.toThrow(/immutable message review/);
    expect(http).not.toHaveBeenCalled();
  });
});
