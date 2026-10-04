import {
  archiveChatSession,
  fetchChatAttachment,
  restoreChatSession,
  updateChatSession,
  uploadChatAttachment,
} from "@goatcitadel/mission-control-shared/api/chat";
import { ensure, pass } from "../runner/assert";
import type { CheckDef } from "../runner/types";
import { createScratchSession, sha256Hex } from "./context";

const ATTACHMENT_TEXT = "GoatCitadel test bench attachment.\n";

export const chatSessionChecks: readonly CheckDef[] = [
  {
    id: "chat.session-lifecycle",
    kind: "journey",
    domain: "chat",
    title: "Session lifecycle",
    tier: "mutate",
    needsWorkspace: true,
    routes: [
      "POST /api/v1/chat/sessions",
      "PATCH /api/v1/chat/sessions/:sessionId",
      "POST /api/v1/chat/sessions/:sessionId/archive",
      "POST /api/v1/chat/sessions/:sessionId/restore",
    ],
    steps: ["Create session", "Rename session", "Archive session", "Restore session"],
    async run(ctx) {
      const created = await ctx.step("Create session", () => createScratchSession(ctx, "lifecycle"));
      ensure(created.lifecycleStatus === "active", "A new session is not active.", created);
      const title = `${created.title ?? "Test bench session"} (renamed)`;
      const renamed = await ctx.step("Rename session", () =>
        updateChatSession(created.sessionId, { expectedRevision: created.revision, title }),
      );
      ensure(
        renamed.title === title && renamed.revision > created.revision,
        "The rename did not apply with a new revision.",
        renamed,
      );
      const archived = await ctx.step("Archive session", () => archiveChatSession(created.sessionId, renamed.revision));
      ensure(archived.lifecycleStatus === "archived", "The session did not archive.", archived);
      const restored = await ctx.step("Restore session", () =>
        restoreChatSession(created.sessionId, archived.revision),
      );
      ensure(restored.lifecycleStatus === "active", "The session did not restore.", restored);
      return pass(`Session ${created.sessionId} went through create, rename, archive, and restore.`);
    },
  },
  {
    id: "chat.attachment-roundtrip",
    kind: "journey",
    domain: "chat",
    title: "Attachment upload and SHA-256 round trip",
    tier: "mutate",
    needsWorkspace: true,
    routes: [
      "POST /api/v1/chat/sessions",
      "POST /api/v1/chat/attachments",
      "GET /api/v1/chat/attachments/:attachmentId",
    ],
    steps: ["Create session", "Upload attachment", "Read attachment back"],
    async run(ctx) {
      const session = await ctx.step("Create session", () => createScratchSession(ctx, "attachment"));
      const expectedSha = await sha256Hex(ATTACHMENT_TEXT);
      const expectedBytes = new TextEncoder().encode(ATTACHMENT_TEXT).byteLength;
      const file = new File([ATTACHMENT_TEXT], "testbench.txt", { type: "text/plain" });
      const uploaded = await ctx.step("Upload attachment", () =>
        uploadChatAttachment({ sessionId: session.sessionId, file }),
      );
      ensure(
        uploaded.sha256 === expectedSha,
        "The gateway recorded a different SHA-256 than the uploaded bytes.",
        uploaded,
      );
      const fetched = await ctx.step("Read attachment back", () => fetchChatAttachment(uploaded.attachmentId));
      ensure(
        fetched.sha256 === expectedSha && fetched.sizeBytes === expectedBytes,
        "The stored attachment does not match the upload.",
        fetched,
      );
      return pass(`Stored ${fetched.sizeBytes} bytes with a matching SHA-256.`, fetched);
    },
  },
];
