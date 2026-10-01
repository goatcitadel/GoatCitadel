import { describe, expect, it, vi } from "vitest";
import type { ChatMessageRecord } from "@goatcitadel/contracts";
import { readInboxSourceContext, sourceMessage } from "./inbox-source-context";
import { statusRecord } from "../chat/thread-activity.test-support";
const message: ChatMessageRecord = { messageId: "m", sessionId: "s", role: "assistant", actorType: "agent", actorId: "fixture", sourceAuthority: "agent_proposed", content: "Public last message", timestamp: "2026-10-01T00:00:00Z" };
describe("Inbox current source message", () => {
  it("reads only one public stored message between exact independent owner scope checks", async () => {
    const owners = { status: vi.fn().mockResolvedValue(statusRecord()), messages: vi.fn().mockResolvedValue({ items: [message] }) };
    const signal = new AbortController().signal;
    expect(await readInboxSourceContext("w", "s", signal, () => true, owners)).toEqual({ messageId: "m", role: "assistant", timestamp: message.timestamp, text: message.content, truncated: false });
    expect(owners.messages).toHaveBeenCalledExactlyOnceWith("s", 1, undefined, signal);
    expect(owners.status).toHaveBeenCalledTimes(2);
  });
  it("withholds foreign or moved source scope, foreign messages, and late obsolete reads", async () => {
    const owners = { status: vi.fn().mockResolvedValueOnce(statusRecord("s", "foreign")), messages: vi.fn().mockResolvedValue({ items: [message] }) };
    await expect(readInboxSourceContext("w", "s", new AbortController().signal, () => true, owners)).rejects.toThrow("outside"); expect(owners.messages).not.toHaveBeenCalled();
    owners.status.mockResolvedValueOnce(statusRecord()).mockResolvedValueOnce(statusRecord("s", "foreign"));
    await expect(readInboxSourceContext("w", "s", new AbortController().signal, () => true, owners)).rejects.toThrow("scope changed");
    expect(() => sourceMessage({ ...message, sessionId: "foreign" }, "s")).toThrow();
    await expect(readInboxSourceContext("w", "s", new AbortController().signal, () => false, owners)).rejects.toThrow("selection changed");
  });
  it("bounds public text without rewriting the recorded role or timestamp", () => {
    expect(sourceMessage({ ...message, content: "a".repeat(900) }, "s")).toMatchObject({ text: "a".repeat(800), truncated: true, role: "assistant", timestamp: message.timestamp });
  });
});
