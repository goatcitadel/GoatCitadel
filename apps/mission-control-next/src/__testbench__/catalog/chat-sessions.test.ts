import { beforeEach, describe, expect, it, vi } from "vitest";
import { findCheck, makeTestContext } from "../test-support/context";
import { chatSessionChecks } from "./chat-sessions";
import { sha256Hex } from "./context";

const mocks = vi.hoisted(() => ({
  createChatSession: vi.fn(),
  updateChatSession: vi.fn(),
  archiveChatSession: vi.fn(),
  restoreChatSession: vi.fn(),
  uploadChatAttachment: vi.fn(),
  fetchChatAttachment: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/chat", () => mocks);

const ATTACHMENT_TEXT = "GoatCitadel test bench attachment.\n";
const SESSION = { sessionId: "s-1", revision: 1, lifecycleStatus: "active", title: "Test bench: lifecycle" };

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockReset();
  }
  mocks.createChatSession.mockResolvedValue(SESSION);
});

describe("sha256Hex", () => {
  it("matches the standard test vector", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("session lifecycle", () => {
  it("creates, renames, archives, and restores with the latest revision each time", async () => {
    const renamedTitle = "Test bench: lifecycle (renamed)";
    mocks.updateChatSession.mockResolvedValueOnce({ ...SESSION, title: renamedTitle, revision: 2 });
    mocks.archiveChatSession.mockResolvedValueOnce({
      ...SESSION,
      title: renamedTitle,
      revision: 3,
      lifecycleStatus: "archived",
    });
    mocks.restoreChatSession.mockResolvedValueOnce({ ...SESSION, title: renamedTitle, revision: 4 });
    const check = findCheck(chatSessionChecks, "chat.session-lifecycle");
    await expect(check.run(makeTestContext())).resolves.toMatchObject({ status: "pass" });
    expect(mocks.createChatSession).toHaveBeenCalledWith({
      workspaceId: "ws-testbench",
      title: "Test bench: lifecycle",
    });
    expect(mocks.updateChatSession).toHaveBeenCalledWith("s-1", { expectedRevision: 1, title: renamedTitle });
    expect(mocks.archiveChatSession).toHaveBeenCalledWith("s-1", 2);
    expect(mocks.restoreChatSession).toHaveBeenCalledWith("s-1", 3);
  });

  it("fails when the archive does not archive", async () => {
    mocks.updateChatSession.mockResolvedValueOnce({
      ...SESSION,
      title: "Test bench: lifecycle (renamed)",
      revision: 2,
    });
    mocks.archiveChatSession.mockResolvedValueOnce({ ...SESSION, revision: 3 });
    await expect(findCheck(chatSessionChecks, "chat.session-lifecycle").run(makeTestContext())).rejects.toThrow(
      "The session did not archive.",
    );
  });

  it("needs the seeded workspace", async () => {
    await expect(
      findCheck(chatSessionChecks, "chat.session-lifecycle").run(makeTestContext({ workspaceId: undefined })),
    ).rejects.toThrow("needs the seeded test workspace");
  });
});

describe("attachment round trip", () => {
  it("passes when the stored SHA-256 and size match the upload", async () => {
    const sha256 = await sha256Hex(ATTACHMENT_TEXT);
    const stored = { attachmentId: "att-1", sha256, sizeBytes: new TextEncoder().encode(ATTACHMENT_TEXT).byteLength };
    mocks.uploadChatAttachment.mockResolvedValueOnce(stored);
    mocks.fetchChatAttachment.mockResolvedValueOnce(stored);
    await expect(
      findCheck(chatSessionChecks, "chat.attachment-roundtrip").run(makeTestContext()),
    ).resolves.toMatchObject({
      status: "pass",
    });
    const upload = mocks.uploadChatAttachment.mock.calls[0]?.[0] as { sessionId: string; file: File };
    expect(upload.sessionId).toBe("s-1");
    expect(await upload.file.text()).toBe(ATTACHMENT_TEXT);
  });

  it("fails when the gateway records a different SHA-256", async () => {
    mocks.uploadChatAttachment.mockResolvedValueOnce({ attachmentId: "att-1", sha256: "0".repeat(64), sizeBytes: 35 });
    await expect(findCheck(chatSessionChecks, "chat.attachment-roundtrip").run(makeTestContext())).rejects.toThrow(
      "different SHA-256",
    );
  });
});
