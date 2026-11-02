/**
 * What the paired phone shows for a waiting errand approval: one plain line, the page, and the spotlight screenshot.
 * Built only for `browser.errand.action` approvals that are still pending; the approvals route adds it only to a
 * companion's read. The line carries no ids, risk levels, kinds or expiry times.
 */

import { createHash } from "node:crypto";
import type { ApprovalRequest, ChatAttachmentRecord, ErrandPhoneApprovalView } from "@goatcitadel/contracts";
import { ERRAND_APPROVAL_KIND } from "./errand-constants.js";
export type { ErrandPhoneApprovalView } from "@goatcitadel/contracts";

/** The largest spotlight screenshot available to the phone. Larger images are omitted. */
export const ERRAND_PHONE_SCREENSHOT_MAX_BYTES = 4 * 1024 * 1024;
const LINE_PREFIX = "GoatCitadel wants to: ";
const SUMMARY_MAX_LENGTH = 600;
const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");
type ErrandApproval = Pick<ApprovalRequest, "kind" | "status" | "preview" | "linkage">;

/** Reads of a stored chat attachment: its record first, then its bytes once the record checks out. */
export interface ErrandScreenshotReads {
  record(attachmentId: string): Promise<Pick<ChatAttachmentRecord, "sessionId" | "mimeType" | "sizeBytes" | "sha256">>;
  bytes(attachmentId: string, options: { sessionId: string; maxBytes: number }): Promise<Buffer>;
}

export async function buildErrandPhoneApprovalView(
  approval: ErrandApproval & Pick<ApprovalRequest, "approvalId">,
  screenshots: ErrandScreenshotReads,
  workspaceId?: string,
): Promise<ErrandPhoneApprovalView | undefined> {
  if (approval.kind !== ERRAND_APPROVAL_KIND || approval.status !== "pending") {
    return undefined;
  }
  const preview = approval.preview ?? {};
  const summary = readText(preview.summary);
  if (!summary) {
    return undefined;
  }
  const page = readText(preview.url);
  // The normal approval read consults metadata only; the authenticated image route reads bytes separately.
  const screenshot = await readOwnScreenshotMetadata(approval, screenshots);
  const query = new URLSearchParams(workspaceId === undefined ? {} : { workspaceId });
  const url = `/api/v1/approvals/${encodeURIComponent(approval.approvalId)}/errand-screenshot${query.size ? `?${query}` : ""}`;
  return {
    line: `${LINE_PREFIX}${shorten(summary, SUMMARY_MAX_LENGTH)}`,
    ...(page ? { page } : {}),
    ...(screenshot ? { screenshot: { mimeType: "image/png" as const, sha256: screenshot.sha256, url } } : {}),
  };
}

/**
 * The approval's own spotlight screenshot, or undefined: it must be a PNG in the approval's chat session, within the
 * size limit, with the sha256 the approval recorded. No bytes are read for this projection.
 */
async function readOwnScreenshotMetadata(
  approval: ErrandApproval,
  screenshots: ErrandScreenshotReads,
): Promise<{ attachmentId: string; sessionId: string; sha256: string; sizeBytes: number } | undefined> {
  if (approval.kind !== ERRAND_APPROVAL_KIND || approval.status !== "pending") return undefined;
  const attachmentId = readText(approval.preview?.screenshotAttachmentId);
  const expectedSha256 = readText(approval.preview?.screenshotSha256);
  const sessionId = readText(approval.linkage?.sessionId);
  if (!attachmentId || !expectedSha256 || !/^[a-f0-9]{64}$/u.test(expectedSha256) || !sessionId) {
    return undefined;
  }
  try {
    const record = await screenshots.record(attachmentId);
    if (
      record.sessionId !== sessionId ||
      record.mimeType !== "image/png" ||
      record.sha256 !== expectedSha256 ||
      !Number.isSafeInteger(record.sizeBytes) ||
      record.sizeBytes < PNG_SIGNATURE.byteLength ||
      record.sizeBytes > ERRAND_PHONE_SCREENSHOT_MAX_BYTES
    ) {
      return undefined;
    }
    return { attachmentId, sessionId, sha256: expectedSha256, sizeBytes: record.sizeBytes };
  } catch {
    // An absent or unreadable attachment is unavailable; owner error details can contain private paths.
    return undefined;
  }
}

/** Fetches only the approval's bound screenshot, revalidating metadata and bounded exact PNG bytes. */
export async function readErrandPhoneScreenshot(
  approval: ErrandApproval,
  screenshots: ErrandScreenshotReads,
): Promise<Buffer | undefined> {
  const screenshot = await readOwnScreenshotMetadata(approval, screenshots);
  if (!screenshot) return undefined;
  try {
    const bytes = await screenshots.bytes(screenshot.attachmentId, {
      sessionId: screenshot.sessionId,
      maxBytes: ERRAND_PHONE_SCREENSHOT_MAX_BYTES,
    });
    if (
      bytes.byteLength !== screenshot.sizeBytes ||
      bytes.byteLength > ERRAND_PHONE_SCREENSHOT_MAX_BYTES ||
      !bytes.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE) ||
      createHash("sha256").update(bytes).digest("hex") !== screenshot.sha256
    )
      return undefined;
    return bytes;
  } catch {
    return undefined;
  }
}

function readText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Shortens to at most `room` UTF-16 code units, ending in `…`, without splitting a surrogate pair. */
function shorten(text: string, room: number): string {
  if (text.length <= room) {
    return text;
  }
  let kept = "";
  for (const character of text) {
    if (kept.length + character.length > room - 1) {
      break;
    }
    kept += character;
  }
  return `${kept.trimEnd()}…`;
}
