// @vitest-environment happy-dom
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { uploadChatAttachment } from "./chat";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("uploadChatAttachment", () => {
  it("sends the File as raw bytes with its details in the query and a SHA-256 the Gateway can check", async () => {
    const record = { attachmentId: "attachment-1" };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(record), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const file = new File(["hello"], "note.txt", { type: "text/plain" });

    await expect(uploadChatAttachment({ sessionId: "session-1", file })).resolves.toEqual(record);

    const [url, init] = fetchMock.mock.calls[0]!;
    const sent = new URL(String(url));
    expect(sent.pathname).toBe("/api/v1/chat/attachments");
    expect(Object.fromEntries(sent.searchParams)).toEqual({
      sessionId: "session-1",
      fileName: "note.txt",
      mimeType: "text/plain",
    });
    expect(init?.body).toBe(file);
    const headers = new Headers(init?.headers);
    expect(headers.get("content-type")).toBe("application/octet-stream");
    expect(headers.get("idempotency-key")).toBeTruthy();
    expect(headers.get("x-content-sha256")).toBe(createHash("sha256").update("hello").digest("hex"));
  });
});
