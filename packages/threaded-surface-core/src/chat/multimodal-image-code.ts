import { downloadChatAttachment, generateLlmImage } from "@goatcitadel/mission-control-shared/api/client";
import type { ChatAttachmentRecord, ImageGenerationRequest } from "@goatcitadel/contracts";
import type { ChatErrorSource } from "./chat-error-copy";
import type { ChatImageRoute, ImageGenerationOptions, UploadAttachmentOptions } from "./multimodal-action-types";

export interface ImageGenerationCodeInput {
  mode: "generate" | "edit";
  prompt: string;
  primaryImageRoute: ChatImageRoute | null;
  googleFallbackImageRoute: ChatImageRoute | null;
  latestImageAttachment: ChatAttachmentRecord | null;
  options?: ImageGenerationOptions;
  isCurrent: () => boolean;
  uploadAttachments: (files: File[], options?: UploadAttachmentOptions) => Promise<boolean>;
  onCreatedSession?: UploadAttachmentOptions["onCreatedSession"];
  clearDraft: () => void;
  setError: (value: string | null, source?: ChatErrorSource) => void;
  pushLocalNotice: (message: string, tone?: "neutral" | "warning" | "critical" | "success") => void;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
  const result = reader.result;
  if (typeof result !== "string") {
    reject(new Error("Unable to read binary content."));
    return;
  }
  const comma = result.indexOf(",");
  resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = reject.bind(null, new Error("Unable to read binary content."));
    reader.readAsDataURL(blob);
  });
}

function base64ToFile(base64: string, fileName: string, mimeType = "image/png"): File {
  const bytes = atob(base64);
  const out = new Uint8Array(bytes.length);
  for (let index = 0; index < bytes.length; index += 1) {
    out[index] = bytes.charCodeAt(index);
  }
  return new File([out], fileName, { type: mimeType });
}

function shouldRetryImageGenerationWithGoogleFallback(error: string): boolean {
  const normalized = error.toLowerCase();
  return (
    normalized.includes("organization must be verified") ||
    (normalized.includes("verify organization") && normalized.includes("gpt-image-2")) ||
    (normalized.includes("403") && normalized.includes("gpt-image-2"))
  );
}

export async function runImageGeneration(input: ImageGenerationCodeInput): Promise<boolean> {
  const { mode, prompt, primaryImageRoute, googleFallbackImageRoute, latestImageAttachment, options,
    isCurrent, uploadAttachments, onCreatedSession, clearDraft, setError, pushLocalNotice } = input;
  try {
    if (!primaryImageRoute) {
      throw new Error("Image generation is unavailable on the current routes.");
    }
    if (mode === "edit" && !primaryImageRoute.supportsEdit) {
      throw new Error("Image editing is unavailable on the current image route.");
    }
    if (!isCurrent()) return false;
    let referenceImages: ImageGenerationRequest["referenceImages"];
    if (mode === "edit" && latestImageAttachment) {
      const { blob, fileName, mimeType } = await downloadChatAttachment(latestImageAttachment.attachmentId);
      if (!isCurrent()) return false;
      const bytesBase64 = await blobToBase64(blob);
      if (!isCurrent()) return false;
      referenceImages = [{ bytesBase64, fileName, mimeType }];
    }
    const runRequest = async (route: ChatImageRoute) => {
      if (!isCurrent()) throw new Error("Image request was canceled.");
      return generateLlmImage({
        providerId: route.providerId,
        model: route.model,
        prompt,
        referenceImages,
        ...(route.providerId === "openai"
          ? { outputFormat: "png" as const }
          : { responseFormat: "b64_json" as const }),
      });
    };
    let routeUsed = primaryImageRoute;
    let response;
    try {
      response = await runRequest(primaryImageRoute);
    } catch (error) {
      const message = (error as Error).message;
      if (!isCurrent()) return false;
      if (
        mode === "generate" &&
        googleFallbackImageRoute &&
        shouldRetryImageGenerationWithGoogleFallback(message)
      ) {
        routeUsed = googleFallbackImageRoute;
        pushLocalNotice(
          `OpenAI image route unavailable. Retrying via ${googleFallbackImageRoute.label}.`,
          "warning",
        );
        response = await runRequest(googleFallbackImageRoute);
      } else {
        throw error;
      }
    }
    if (!isCurrent()) return false;
    const first = response.data[0];
    if (!first?.b64Json) {
      throw new Error("Image generation returned no image payload.");
    }
    const file = base64ToFile(
      first.b64Json,
      `goatcitadel-${response.operation}-${new Date().toISOString().replace(/[:.]/g, "-")}.png`,
      "image/png",
    );
    if (!isCurrent()) return false;
    const uploadConfirmed = await uploadAttachments([file], { onCreatedSession });
    if (uploadConfirmed !== true || !isCurrent()) return false;
    if (options?.clearDraftOnSuccess) {
      clearDraft();
    }
    pushLocalNotice(
      response.operation === "edit"
        ? "Edited image added to the draft attachments."
        : options?.trigger === "auto_send"
          ? `Detected image request and generated it via ${routeUsed.label}.`
          : routeUsed.providerId === "google"
            ? `Generated image added to the draft attachments via ${routeUsed.label}.`
            : "Generated image added to the draft attachments.",
      "success",
    );
    return true;
  } catch (error) {
    if (isCurrent()) setError((error as Error).message, mode === "edit" ? "image_edit" : "image_generate");
    return false;
  }
}
