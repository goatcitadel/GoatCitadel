/**
 * What the paired phone shows for a waiting errand approval: one plain line, the page, and the spotlight screenshot.
 * Built only for `browser.errand.action` approvals that are still pending; the approvals route adds it only to a
 * companion's read. The line carries no ids, risk levels, kinds or expiry times.
 */

import { createHash } from "node:crypto";
import type { ApprovalRequest, ChatAttachmentRecord } from "@goatcitadel/contracts";
import { ERRAND_APPROVAL_KIND } from "./errand-constants.js";

/** The largest spotlight screenshot sent inline to the phone. A larger one is left out, and the line still goes. */
export const ERRAND_PHONE_SCREENSHOT_MAX_BYTES = 4 * 1024 * 1024;
const LINE_PREFIX = "GoatCitadel wants to: ";
const SUMMARY_MAX_LENGTH = 600;

export interface ErrandPhoneApprovalView {
  line: string;
  /** The page's origin and path, as the errand stored it. */
  page?: string;
  screenshot?: { mimeType: "image/png"; sha256: string; dataBase64: string };
}

/** Reads of a stored chat attachment: its record first, then its bytes once the record checks out. */
export interface ErrandScreenshotReads {
  record(attachmentId: string): Promise<Pick<ChatAttachmentRecord, "sessionId" | "mimeType" | "sizeBytes" | "sha256">>;
  bytes(attachmentId: string): Promise<Buffer>;
}

export async function buildErrandPhoneApprovalView(
  approval: Pick<ApprovalRequest, "kind" | "status" | "preview" | "linkage">,
  screenshots: ErrandScreenshotReads,
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
  const screenshot = await readOwnScreenshot(approval, screenshots);
  return {
    line: `${LINE_PREFIX}${shorten(summary, SUMMARY_MAX_LENGTH)}`,
    ...(page ? { page } : {}),
    ...(screenshot ? { screenshot } : {}),
  };
}

/**
 * The approval's own spotlight screenshot, or undefined: it must be a PNG in the approval's chat session, within the
 * size limit, with the sha256 the approval recorded. A failed read leaves the screenshot out and logs one line.
 */
async function readOwnScreenshot(
  approval: Pick<ApprovalRequest, "preview" | "linkage">,
  screenshots: ErrandScreenshotReads,
): Promise<ErrandPhoneApprovalView["screenshot"]> {
  const attachmentId = readText(approval.preview?.screenshotAttachmentId);
  const expectedSha256 = readText(approval.preview?.screenshotSha256);
  const sessionId = approval.linkage?.sessionId;
  if (!attachmentId || !expectedSha256 || !sessionId) {
    return undefined;
  }
  try {
    const record = await screenshots.record(attachmentId);
    if (
      record.sessionId !== sessionId ||
      record.mimeType !== "image/png" ||
      record.sha256 !== expectedSha256 ||
      record.sizeBytes > ERRAND_PHONE_SCREENSHOT_MAX_BYTES
    ) {
      return undefined;
    }
    const bytes = await screenshots.bytes(attachmentId);
    if (
      bytes.byteLength > ERRAND_PHONE_SCREENSHOT_MAX_BYTES ||
      createHash("sha256").update(bytes).digest("hex") !== expectedSha256
    ) {
      return undefined;
    }
    return { mimeType: "image/png", sha256: expectedSha256, dataBase64: bytes.toString("base64") };
  } catch (error) {
    // eslint-disable-next-line no-console -- bounded diagnostic; the phone still gets the line.
    console.warn("[goatcitadel] errand screenshot for the phone could not be read", {
      detail: (error instanceof Error ? error.message : String(error)).slice(0, 500),
    });
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
