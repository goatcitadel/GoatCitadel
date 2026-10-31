import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { PayloadTooLargeError, type ChatAttachmentMediaType, type ChatAttachmentRecord } from "@goatcitadel/contracts";
import type { AsyncStorage as Storage } from "@goatcitadel/storage";
import { assertExistingPathRealpathAllowed, assertWritePathInJail } from "@goatcitadel/policy-engine";
import type { GatewayRuntimeConfig } from "../config.js";
import {
  assertAttachmentBytesMatchMimeHint,
  decodeStrictBase64,
  detectAttachmentMediaType,
} from "./media-voice-service.js";
import { UPLOAD_STAGING_DIR_NAME, commitStagedUpload, receiveUpload } from "./streamed-upload.js";

export interface ChatAttachmentHost {
  readonly config: GatewayRuntimeConfig;
  readonly storage: Pick<Storage, "chatAttachments" | "chatProjects" | "chatSessionMeta" | "chatSessionProjects">;
  getSession(sessionId: string): Promise<unknown>;
  normalizeWorkspaceId(workspaceId?: string): string;
  publishRealtime(eventType: string, source: string, payload: Record<string, unknown>): Promise<unknown>;
  createMediaJob(input: {
    type: "ocr" | "audio_transcribe" | "video_transcribe" | "analyze";
    sessionId: string;
    attachmentId: string;
  }): unknown;
}

export const MAX_CHAT_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** An attachment's bytes: base64 (the JSON route), a Buffer (Gateway callers) or a request body streamed to disk. */
export type ChatAttachmentBytes =
  | { bytesBase64: string }
  | { bytes: Buffer }
  | { stream: { body: Readable; declaredBytes: number; contentSha256?: string } };

export type ChatAttachmentUploadInput = {
  sessionId: string;
  projectId?: string;
  fileName: string;
  mimeType: string;
  /** `skip` stores the bytes as evidence without queuing OCR/transcription (artifact renders). */
  analysis?: "skip";
} & ChatAttachmentBytes;

export async function uploadChatAttachment(
  deps: ChatAttachmentHost,
  input: ChatAttachmentUploadInput,
): Promise<ChatAttachmentRecord> {
  const { config, storage } = deps;
  await deps.getSession(input.sessionId);
  const sessionMeta = await storage.chatSessionMeta.ensure(input.sessionId);
  const sessionWorkspaceId = deps.normalizeWorkspaceId(sessionMeta.workspaceId);
  const fileName = sanitizeAttachmentFileName(input.fileName);
  const mimeType = input.mimeType.trim() || "application/octet-stream";
  // In-memory bytes are checked before anything else, as before; a stream is checked as it lands.
  const inMemory =
    "stream" in input ? undefined : "bytes" in input ? input.bytes : decodeStrictBase64(input.bytesBase64);
  if (inMemory) {
    assertAttachmentSize(inMemory.length);
    assertAttachmentBytesMatchMimeHint(inMemory, mimeType);
  } else if ("stream" in input && input.stream.declaredBytes === 0) {
    assertAttachmentSize(0);
  }

  let projectId = input.projectId;
  if (!projectId) {
    projectId = (await storage.chatSessionProjects.get(input.sessionId))?.projectId;
  }
  const project = projectId ? await storage.chatProjects.get(projectId) : undefined;
  if (project && deps.normalizeWorkspaceId(project.workspaceId) !== sessionWorkspaceId) {
    throw new Error("project workspace does not match session workspace");
  }
  const rootPath = project?.workspacePath ?? "chat/default";
  const stamp = new Date();
  const year = String(stamp.getUTCFullYear());
  const month = String(stamp.getUTCMonth() + 1).padStart(2, "0");
  const attachmentId = randomUUID();
  const storageRelPath = path.posix.join(rootPath, "attachments", year, month, `${attachmentId}-${fileName}`);
  const workspaceRoot = path.resolve(config.rootDir, config.assistant.workspaceDir);
  const writeJailRoots = config.toolPolicy.sandbox.writeJailRoots;
  const fullPath = path.resolve(workspaceRoot, storageRelPath);
  assertWritePathInJail(fullPath, writeJailRoots);

  let stored: { sizeBytes: number; sha256: string; head: Buffer };
  if (inMemory) {
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, inMemory);
    stored = {
      sizeBytes: inMemory.length,
      sha256: createHash("sha256").update(inMemory).digest("hex"),
      head: inMemory,
    };
  } else if ("stream" in input) {
    const stagingDir = path.resolve(workspaceRoot, UPLOAD_STAGING_DIR_NAME);
    assertWritePathInJail(stagingDir, writeJailRoots);
    stored = await storeStreamedAttachment(input.stream, mimeType, stagingDir, fullPath, () =>
      assertWritePathInJail(fullPath, writeJailRoots),
    );
  } else {
    throw new Error("Attachment payload is missing");
  }

  const { extractStatus, extractPreview } = extractAttachmentPreview(stored.head, mimeType, fileName);
  const mediaType = detectAttachmentMediaType(mimeType);
  const analysisStatus =
    input.analysis === "skip" ? ("skipped" as const) : inferAttachmentAnalysisStatus(mediaType, extractStatus);
  const sizeBytes = stored.sizeBytes;
  const sha256 = stored.sha256;
  const created = await storage.chatAttachments.create({
    attachmentId,
    sessionId: input.sessionId,
    workspaceId: sessionWorkspaceId,
    projectId,
    fileName,
    mimeType,
    mediaType,
    sizeBytes,
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
  await deps.publishRealtime("chat_message", "chat", {
    type: "chat_attachment_uploaded",
    sessionId: input.sessionId,
    attachmentId,
    fileName,
    sizeBytes,
  });
  return created;
}

function assertAttachmentSize(bytes: number): void {
  if (bytes === 0) {
    throw new Error("Attachment payload is empty");
  }
  if (bytes > MAX_CHAT_ATTACHMENT_BYTES) {
    throw new PayloadTooLargeError("Attachment exceeds 20MB upload limit", {
      limitBytes: MAX_CHAT_ATTACHMENT_BYTES,
      receivedBytes: bytes,
    });
  }
}

/**
 * Streams an attachment into the staging folder, checks its type from the first bytes, then moves it to `fullPath`,
 * re-checking the write jail at the move. Only the first 16 KB stay in memory, for the type check and text preview.
 */
async function storeStreamedAttachment(
  stream: { body: Readable; declaredBytes: number; contentSha256?: string },
  mimeType: string,
  stagingDir: string,
  fullPath: string,
  assertTarget: () => void,
): Promise<{ sizeBytes: number; sha256: string; head: Buffer }> {
  assertAttachmentSize(stream.declaredBytes);
  const staged = await receiveUpload(stream.body, {
    stagingDir,
    maxBytes: MAX_CHAT_ATTACHMENT_BYTES,
    declaredBytes: stream.declaredBytes,
    ...(stream.contentSha256 ? { expectedSha256: stream.contentSha256 } : {}),
  });
  try {
    assertAttachmentBytesMatchMimeHint(staged.head, mimeType);
  } catch (error) {
    await fs.rm(staged.stagingPath, { force: true });
    throw error;
  }
  // A fresh UUID names the target, so "exists" would mean something else took the path; never replace it.
  if ((await commitStagedUpload(staged.stagingPath, fullPath, { expectAbsent: true, assertTarget })) === "exists") {
    throw new Error("Attachment path is already taken");
  }
  return { sizeBytes: staged.bytes, sha256: staged.sha256, head: staged.head };
}

export async function getChatAttachment(deps: ChatAttachmentHost, attachmentId: string): Promise<ChatAttachmentRecord> {
  return await deps.storage.chatAttachments.get(attachmentId);
}

export async function readChatAttachmentContent(
  deps: Pick<ChatAttachmentHost, "config" | "storage">,
  attachmentId: string,
  options: {
    maxBytes?: number;
    /** Refuse, before reading any bytes, an attachment uploaded to another session. */
    sessionId?: string;
    /** Read only up to `maxBytes` from `start` with a positioned read, not the whole file. */
    window?: { start: number; maxBytes: number };
  } = {},
): Promise<{
  record: ChatAttachmentRecord;
  fullPath: string;
  bytes: Buffer;
}> {
  const record = await deps.storage.chatAttachments.get(attachmentId);
  if (options.sessionId !== undefined && record.sessionId !== options.sessionId) {
    throw new Error("Attachment is not part of this session.");
  }
  const maxBytes = options.maxBytes;
  if (maxBytes !== undefined) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw new Error("Attachment read maxBytes must be a non-negative safe integer.");
    }
    if (record.sizeBytes > maxBytes) {
      throw new Error(`Attachment ${attachmentId} exceeds the server read limit.`);
    }
  }
  const fullPath = path.resolve(deps.config.rootDir, deps.config.assistant.workspaceDir, record.storageRelPath);
  assertExistingPathRealpathAllowed(
    fullPath,
    deps.config.toolPolicy.sandbox.writeJailRoots,
    deps.config.toolPolicy.sandbox.readOnlyRoots,
  );
  const bytes = options.window
    ? await readFileWindow(fullPath, options.window)
    : maxBytes === undefined
      ? await fs.readFile(fullPath)
      : await readFileBounded(fullPath, maxBytes, attachmentId);
  return {
    record,
    fullPath,
    bytes,
  };
}

/** Up to `maxBytes` of the file from `start`, read in place; past the end it is empty. */
async function readFileWindow(fullPath: string, window: { start: number; maxBytes: number }): Promise<Buffer> {
  if (![window.start, window.maxBytes].every((value) => Number.isSafeInteger(value) && value >= 0)) {
    throw new Error("Attachment read window must use non-negative safe integers.");
  }
  const handle = await fs.open(fullPath, "r");
  try {
    const size = (await handle.stat()).size;
    const start = Math.min(window.start, size);
    const buffer = Buffer.alloc(Math.min(size - start, window.maxBytes));
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, start + offset);
      if (bytesRead === 0) {
        break;
      }
      offset += bytesRead;
    }
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

async function readFileBounded(fullPath: string, maxBytes: number, attachmentId: string): Promise<Buffer> {
  const handle = await fs.open(fullPath, "r");
  try {
    const stat = await handle.stat();
    if (stat.size > maxBytes) {
      throw new Error(`Attachment ${attachmentId} exceeds the server read limit.`);
    }
    const buffer = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) {
        break;
      }
      offset += bytesRead;
    }
    if (offset > maxBytes) {
      throw new Error(`Attachment ${attachmentId} exceeds the server read limit.`);
    }
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
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
