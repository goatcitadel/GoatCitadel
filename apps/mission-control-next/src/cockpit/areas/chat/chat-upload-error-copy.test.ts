import { GATEWAY_UNREACHABLE_SUMMARY } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { formatBytes } from "@goatcitadel/mission-control-shared/content/format";
import { describe, expect, it } from "vitest";
import { attachmentUploadErrorText } from "./chat-upload-error-copy";

describe("attachmentUploadErrorText", () => {
  it("names the limit when the Gateway sent one", () => {
    expect(
      attachmentUploadErrorText(
        'API error 413: {"error":"Attachment exceeds 20MB upload limit","details":{"limitBytes":20971520}}',
      ),
    ).toBe(`That file is larger than ${formatBytes(20971520)}, the most Chat can attach. Choose a smaller file.`);
  });

  it("says too large without a limit when none was sent", () => {
    expect(attachmentUploadErrorText('API error 413: {"error":"too big"}')).toBe(
      "That file is too large to attach. Choose a smaller file.",
    );
  });

  it("keeps the Gateway's plain reason for other refusals", () => {
    expect(attachmentUploadErrorText('API error 400: {"error":"Attachment payload is empty"}')).toBe(
      "Attachment payload is empty",
    );
  });

  it("says the Gateway is unreachable for a network failure", () => {
    expect(attachmentUploadErrorText("Network error: Failed to fetch")).toBe(GATEWAY_UNREACHABLE_SUMMARY);
  });

  it("falls back to the retry sentence for empty text", () => {
    expect(attachmentUploadErrorText("")).toBe("The attachment didn’t upload. Select the file again to retry.");
  });
});
