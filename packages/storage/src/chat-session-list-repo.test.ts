import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Storage } from "./index.js";

const createdRoots: string[] = [];

afterEach(() => {
  for (const root of createdRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function createStorage(): Storage {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `gc-chat-session-list-${randomUUID()}-`));
  createdRoots.push(root);
  return new Storage({
    dbPath: ":memory:",
    transcriptsDir: path.join(root, "transcripts"),
    auditDir: path.join(root, "audit"),
  });
}

function createSession(storage: Storage, input: { sessionId: string; timestamp: string; channel?: string }): void {
  storage.sessions.upsert({
    sessionId: input.sessionId,
    sessionKey: `${input.channel ?? "mission"}:operator:${input.sessionId}`,
    kind: "dm",
    channel: input.channel ?? "mission",
    account: "operator",
    displayName: input.sessionId,
    timestamp: input.timestamp,
  });
}

describe("ChatSessionListRepository", () => {
  it("applies cheap session filters before gateway hydration", () => {
    const storage = createStorage();
    try {
      const project = storage.chatProjects.create({
        workspaceId: "default",
        name: "Gateway",
        workspacePath: "apps/gateway",
      });
      createSession(storage, { sessionId: "session-code", timestamp: "2026-05-03T16:03:00.000Z" });
      createSession(storage, { sessionId: "session-search", timestamp: "2026-05-03T16:02:00.000Z" });
      createSession(storage, { sessionId: "session-hidden", timestamp: "2026-05-03T16:01:00.000Z" });
      createSession(storage, {
        sessionId: "session-external",
        timestamp: "2026-05-03T16:00:00.000Z",
        channel: "slack",
      });
      createSession(storage, { sessionId: "session-other-workspace", timestamp: "2026-05-03T15:59:00.000Z" });

      storage.chatSessionMeta.ensure("session-code", "2026-05-03T16:03:00.000Z", "default");
      storage.chatSessionMeta.patch("session-code", {
        title: "Performance review",
        folderName: "Ops Desk",
        tags: ["perf"],
      });
      storage.chatSessionPrefs.ensure("session-code");
      storage.chatSessionPrefs.patch("session-code", { mode: "code" });
      storage.chatSessionProjects.assign("session-code", project.projectId);

      storage.chatSessionMeta.ensure("session-search", "2026-05-03T16:02:00.000Z", "default");
      storage.chatSessionPrefs.ensure("session-search");
      storage.chatMessages.upsert({
        messageId: "message-search",
        sessionId: "session-search",
        role: "user",
        actorType: "user",
        actorId: "operator",
        content: "needle appears in message content",
        timestamp: "2026-05-03T16:02:01.000Z",
      });

      storage.chatSessionMeta.ensure("session-hidden", "2026-05-03T16:01:00.000Z", "default");
      storage.chatSessionMeta.patch("session-hidden", { includeInHistory: false });
      storage.chatSessionPrefs.ensure("session-hidden");
      storage.chatSessionMeta.ensure("session-external", "2026-05-03T16:00:00.000Z", "default");
      storage.chatSessionPrefs.ensure("session-external");
      storage.chatSessionMeta.ensure("session-other-workspace", "2026-05-03T15:59:00.000Z", "other");

      assert.deepEqual(
        storage.chatSessionLists
          .listCandidates({
            workspaceId: "default",
            scope: "all",
            view: "active",
            includeHidden: false,
            projectId: project.projectId,
            folderId: "ops-desk",
            tag: "PERF",
            mode: "code",
            limit: 10,
          })
          .map((item) => item.sessionId),
        ["session-code"],
      );

      assert.deepEqual(
        storage.chatSessionLists
          .listCandidates({
            workspaceId: "default",
            scope: "all",
            view: "active",
            includeHidden: false,
            q: "needle",
            limit: 10,
          })
          .map((item) => item.sessionId),
        ["session-search"],
      );
    } finally {
      storage.close();
    }
  });

  it("keeps pinned sessions first while honoring the existing composite cursor", () => {
    const storage = createStorage();
    try {
      createSession(storage, { sessionId: "session-pinned", timestamp: "2026-05-03T15:00:00.000Z" });
      createSession(storage, { sessionId: "session-new", timestamp: "2026-05-03T16:00:00.000Z" });
      createSession(storage, { sessionId: "session-old", timestamp: "2026-05-03T14:00:00.000Z" });
      for (const sessionId of ["session-pinned", "session-new", "session-old"]) {
        storage.chatSessionMeta.ensure(sessionId, "2026-05-03T13:00:00.000Z", "default");
      }
      storage.chatSessionMeta.patch("session-pinned", { pinned: true });

      const first = storage.chatSessionLists.listCandidates({ workspaceId: "default", limit: 1 });
      assert.deepEqual(
        first.map((item) => item.sessionId),
        ["session-pinned"],
      );

      const second = storage.chatSessionLists.listCandidates({
        workspaceId: "default",
        limit: 2,
        cursor: `${first[0]!.updatedAt}|${first[0]!.sessionId}`,
      });
      assert.deepEqual(
        second.map((item) => item.sessionId),
        ["session-new", "session-old"],
      );
    } finally {
      storage.close();
    }
  });
});
