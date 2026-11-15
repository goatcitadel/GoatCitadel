import { describeApiErrorText } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { formatBytes } from "@goatcitadel/mission-control-shared/content/format";

const UPLOAD_FALLBACK = "The attachment didn’t upload. Select the file again to retry.";
const LIMIT_PATTERN = /"limitBytes"\s*:\s*(\d+)/u;

/** The sentence Chat shows when an attachment upload fails; the raw text stays in Technical details. */
export function attachmentUploadErrorText(error: string): string {
  if (/^API error 413\b/u.test(error.trim())) {
    const limit = LIMIT_PATTERN.exec(error)?.[1];
    return limit
      ? `That file is larger than ${formatBytes(Number(limit))}, the most Chat can attach. Choose a smaller file.`
      : "That file is too large to attach. Choose a smaller file.";
  }
  return describeApiErrorText(error, UPLOAD_FALLBACK).summary;
}
