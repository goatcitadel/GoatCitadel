import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { ChatAttachmentMediaType, ChatAttachmentRecord } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import { assertExistingPathRealpathAllowed, assertWritePathInJail } from "@goatcitadel/policy-engine";
import type { GatewayRuntimeConfig } from "../config.js";
import {
  assertAttachmentBytesMatchMimeHint,
  decodeStrictBase64,
  detectAttachmentMediaType,
} from "./media-voice-service.js";

export interface ChatAttachmentHost {
  readonly config: GatewayRuntimeConfig;
  readonly storage: Pick<Storage, "chatAttachments" | "chatProjects" | "chatSessionMeta" | "chatSessionProjects">;
  getSession(sessionId: string): unknown;
  normalizeWorkspaceId(workspaceId?: string): string;
  publishRealtime(eventType: string, source: string, payload: Record<string, unknown>): void;
  createMediaJob(input: {
    type: "ocr" | "audio_transcribe" | "video_transcribe" | "analyze";
    sessionId: string;
    attachmentId: string;
  }): unknown;
}

export async function uploadChatAttachment(
  deps: ChatAttachmentHost,
  input: {
    sessionId: string;
    projectId?: string;
    fileName: string;
    mimeType: string;
    bytesBase64: string;
  },
): Promise<ChatAttachmentRecord> {
  deps.getSession(input.sessionId);
  const sessionMeta = deps.storage.chatSessionMeta.ensure(input.sessionId);
  const sessionWorkspaceId = deps.normalizeWorkspaceId(sessionMeta.workspaceId);
  const fileName = sanitizeAttachmentFileName(input.fileName);
  const mimeType = input.mimeType.trim() || "application/octet-stream";
  const bytes = decodeStrictBase64(input.bytesBase64);
  if (bytes.length === 0) {
    throw new Error("Attachment payload is empty");
  }
  if (bytes.length > 20 * 1024 * 1024) {
    throw new Error("Attachment exceeds 20MB upload limit");
  }
  assertAttachmentBytesMatchMimeHint(bytes, mimeType);

  let projectId = input.projectId;
  if (!projectId) {
    projectId = deps.storage.chatSessionProjects.get(input.sessionId)?.projectId;
  }
  const project = projectId ? deps.storage.chatProjects.get(projectId) : undefined;
  if (project && deps.normalizeWorkspaceId(project.workspaceId) !== sessionWorkspaceId) {
    throw new Error("project workspace does not match session workspace");
  }
  const rootPath = project?.workspacePath ?? "chat/default";
  const stamp = new Date();
  const year = String(stamp.getUTCFullYear());
  const month = String(stamp.getUTCMonth() + 1).padStart(2, "0");
  const attachmentId = randomUUID();
  const storageRelPath = path.posix.join(rootPath, "attachments", year, month, `${attachmentId}-${fileName}`);
  const fullPath = path.resolve(deps.config.rootDir, deps.config.assistant.workspaceDir, storageRelPath);
  assertWritePathInJail(fullPath, deps.config.toolPolicy.sandbox.writeJailRoots);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, bytes);

  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const { extractStatus, extractPreview } = extractAttachmentPreview(bytes, mimeType, fileName);
  const mediaType = detectAttachmentMediaType(mimeType);
  const analysisStatus = inferAttachmentAnalysisStatus(mediaType, extractStatus);
  const created = deps.storage.chatAttachments.create({
    attachmentId,
    sessionId: input.sessionId,
    workspaceId: sessionWorkspaceId,
    projectId,
    fileName,
    mimeType,
    mediaType,
    sizeBytes: bytes.length,
    sha256,
    storageRelPath,
    extractStatus,
    extractPreview,
    analysisStatus,
    ocrText: mediaType === "text" ? extractPreview : undefined,
  });
  if (analysisStatus === "queued") {
    deps.createMediaJob({
      type:
        mediaType === "image"
          ? "ocr"
          : mediaType === "audio"
            ? "audio_transcribe"
            : mediaType === "video"
              ? "video_transcribe"
              : "analyze",
      sessionId: input.sessionId,
      attachmentId,
    });
  }
  deps.publishRealtime("chat_message", "chat", {
    type: "chat_attachment_uploaded",
    sessionId: input.sessionId,
    attachmentId,
    fileName,
    sizeBytes: bytes.length,
  });
  return created;
}

export function getChatAttachment(deps: ChatAttachmentHost, attachmentId: string): ChatAttachmentRecord {
  return deps.storage.chatAttachments.get(attachmentId);
}

export async function readChatAttachmentContent(
  deps: Pick<ChatAttachmentHost, "config" | "storage">,
  attachmentId: string,
): Promise<{
  record: ChatAttachmentRecord;
  fullPath: string;
  bytes: Buffer;
}> {
  const { record, fullPath } = await resolveChatAttachmentContent(deps, attachmentId);
  const bytes = await fs.readFile(fullPath);
  return {
    record,
    fullPath,
    bytes,
  };
}

export async function resolveChatAttachmentContent(
  deps: Pick<ChatAttachmentHost, "config" | "storage">,
  attachmentId: string,
): Promise<{
  record: ChatAttachmentRecord;
  fullPath: string;
  sizeBytes: number;
}> {
  const record = deps.storage.chatAttachments.get(attachmentId);
  const fullPath = path.resolve(deps.config.rootDir, deps.config.assistant.workspaceDir, record.storageRelPath);
  assertExistingPathRealpathAllowed(
    fullPath,
    deps.config.toolPolicy.sandbox.writeJailRoots,
    deps.config.toolPolicy.sandbox.readOnlyRoots,
  );
  const stat = await fs.stat(fullPath);
  if (!stat.isFile()) {
    throw new Error(`Attachment content is not a regular file: ${attachmentId}`);
  }
  return {
    record,
    fullPath,
    sizeBytes: stat.size,
  };
}

function sanitizeAttachmentFileName(input: string): string {
  const normalized = input
    .trim()
    .replaceAll("\\", "/")
    .split("/")
    .pop()
    // eslint-disable-next-line no-control-regex
    ?.replace(/[<>:"|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^\.+/, "")
    .slice(0, 120);
  if (!normalized) {
    return "attachment.bin";
  }
  return normalized;
}

function extractAttachmentPreview(
  bytes: Buffer,
  mimeType: string,
  fileName: string,
): { extractStatus: "ready" | "unsupported" | "failed"; extractPreview?: string } {
  const lowerMime = mimeType.toLowerCase();
  const ext = path.extname(fileName).toLowerCase();
  const textLike =
    lowerMime.startsWith("text/") ||
    lowerMime === "application/json" ||
    lowerMime === "application/xml" ||
    ext === ".md" ||
    ext === ".txt" ||
    ext === ".log" ||
    ext === ".json" ||
    ext === ".yaml" ||
    ext === ".yml";
  if (textLike) {
    try {
      const preview = bytes.toString("utf8").slice(0, 4000);
      return { extractStatus: "ready", extractPreview: preview };
    } catch {
      return { extractStatus: "failed" };
    }
  }
  return { extractStatus: "unsupported" };
}

function inferAttachmentAnalysisStatus(
  mediaType: ChatAttachmentMediaType,
  extractStatus: "ready" | "unsupported" | "failed",
): "queued" | "ready" | "failed" | "unsupported" {
  if (extractStatus === "failed") {
    return "failed";
  }
  if (mediaType === "text") {
    return extractStatus === "ready" ? "ready" : "unsupported";
  }
  return "queued";
}
