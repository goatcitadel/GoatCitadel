import type { ChatAttachmentRecord, ChatWorkspaceSnapshotRequest } from "@goatcitadel/contracts";

const MAX_HYDRATED_STORAGE_BYTES = 256 * 1024;
export const MAX_HYDRATED_QUEUE_ITEMS = 64;
const MAX_HYDRATED_ATTACHMENTS = 16;
export const MAX_HYDRATED_MESSAGE_CHARS = 64 * 1024;
const MAX_HYDRATED_ATTACHMENT_TEXT_CHARS = 64 * 1024;
const MAX_HYDRATED_ATTACHMENT_SIZE_BYTES = 1024 * 1024 * 1024;
const WORKSPACE_SNAPSHOT_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SAFE_STORAGE_SEGMENT_PATTERN = /^[a-z0-9][a-z0-9._ -]{0,255}$/iu;
const WINDOWS_RESERVED_SEGMENT_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

type UnknownRecord = Record<string, unknown>;

export function isPlainRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function hasOnlyKeys(record: UnknownRecord, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(record).every((key) => allowedKeys.has(key));
}

export function hasOwn(record: UnknownRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

export function parseHydratedWorkspaceSnapshotRequest(value: unknown, action: unknown): ChatWorkspaceSnapshotRequest | null {
  if (
    action !== "send" ||
    !isPlainRecord(value) ||
    !hasOnlyKeys(value, ["capture", "requestId"]) ||
    value.capture !== true ||
    typeof value.requestId !== "string" ||
    !WORKSPACE_SNAPSHOT_REQUEST_ID.test(value.requestId)
  ) {
    return null;
  }
  return Object.freeze({ capture: true, requestId: value.requestId });
}

export function isBoundedString(value: unknown, maxLength: number, allowEmpty = false): value is string {
  return (
    typeof value === "string" &&
    value.length <= maxLength &&
    (allowEmpty || value.length > 0) &&
    !value.includes("\u0000")
  );
}

export function isSafeIdentifier(value: unknown, maxLength = 256): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    value.length <= maxLength &&
    value.trim() === value &&
    !Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
    })
  );
}

export function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 32) {
    return false;
  }
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function isSafeRelativeStoragePath(value: unknown): value is string {
  if (
    !isBoundedString(value, 1024) ||
    value.trim() !== value ||
    value.includes("\\") ||
    value.includes(":") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("//") ||
    /%(?:2e|2f|5c)/iu.test(value)
  ) {
    return false;
  }
  return value
    .split("/")
    .every(
      (segment) =>
        SAFE_STORAGE_SEGMENT_PATTERN.test(segment) &&
        !WINDOWS_RESERVED_SEGMENT_PATTERN.test(segment) &&
        !segment.endsWith(".") &&
        !segment.endsWith(" "),
    );
}

export function isWithinStorageBudget(raw: string): boolean {
  if (raw.length > MAX_HYDRATED_STORAGE_BYTES) {
    return false;
  }
  return new TextEncoder().encode(raw).byteLength <= MAX_HYDRATED_STORAGE_BYTES;
}

function parseHydratedAttachment(
  value: unknown,
  scope: { workspaceId: string; sessionId: string | null },
): ChatAttachmentRecord | null {
  if (
    !isPlainRecord(value) ||
    !hasOnlyKeys(value, [
      "attachmentId",
      "sessionId",
      "workspaceId",
      "projectId",
      "fileName",
      "mimeType",
      "mediaType",
      "sizeBytes",
      "sha256",
      "storageRelPath",
      "extractStatus",
      "extractPreview",
      "thumbnailRelPath",
      "ocrText",
      "transcriptText",
      "analysisStatus",
      "createdAt",
    ]) ||
    !isSafeIdentifier(value.attachmentId) ||
    typeof scope.sessionId !== "string" ||
    value.sessionId !== scope.sessionId ||
    value.workspaceId !== scope.workspaceId ||
    !isSafeIdentifier(value.fileName, 512) ||
    !isSafeIdentifier(value.mimeType, 256) ||
    !Number.isSafeInteger(value.sizeBytes) ||
    (value.sizeBytes as number) < 0 ||
    (value.sizeBytes as number) > MAX_HYDRATED_ATTACHMENT_SIZE_BYTES ||
    typeof value.sha256 !== "string" ||
    !SHA256_PATTERN.test(value.sha256) ||
    !isSafeRelativeStoragePath(value.storageRelPath) ||
    !["ready", "unsupported", "failed"].includes(value.extractStatus as string) ||
    !isCanonicalTimestamp(value.createdAt)
  ) {
    return null;
  }
  if (
    (hasOwn(value, "projectId") && !isSafeIdentifier(value.projectId)) ||
    (hasOwn(value, "mediaType") &&
      !["text", "image", "audio", "video", "binary"].includes(value.mediaType as string)) ||
    (hasOwn(value, "extractPreview") &&
      !isBoundedString(value.extractPreview, MAX_HYDRATED_ATTACHMENT_TEXT_CHARS, true)) ||
    (hasOwn(value, "thumbnailRelPath") && !isSafeRelativeStoragePath(value.thumbnailRelPath)) ||
    (hasOwn(value, "ocrText") && !isBoundedString(value.ocrText, MAX_HYDRATED_ATTACHMENT_TEXT_CHARS, true)) ||
    (hasOwn(value, "transcriptText") &&
      !isBoundedString(value.transcriptText, MAX_HYDRATED_ATTACHMENT_TEXT_CHARS, true)) ||
    (hasOwn(value, "analysisStatus") &&
      !["queued", "running", "pending", "ready", "failed", "unsupported"].includes(value.analysisStatus as string))
  ) {
    return null;
  }
  return Object.freeze({ ...value }) as unknown as ChatAttachmentRecord;
}

export function parseHydratedAttachmentsValue(
  value: unknown,
  scope: { workspaceId: string; sessionId: string | null },
): ChatAttachmentRecord[] | null {
  if (!Array.isArray(value) || value.length > MAX_HYDRATED_ATTACHMENTS) {
    return null;
  }
  const parsed: ChatAttachmentRecord[] = [];
  const attachmentIds = new Set<string>();
  for (const candidate of value) {
    const attachment = parseHydratedAttachment(candidate, scope);
    if (!attachment || attachmentIds.has(attachment.attachmentId)) {
      return null;
    }
    attachmentIds.add(attachment.attachmentId);
    parsed.push(attachment);
  }
  return Object.freeze(parsed) as unknown as ChatAttachmentRecord[];
}
