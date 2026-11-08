import type { ChatSessionRecord } from "@goatcitadel/contracts";

export interface ChatImageRoute {
  providerId: "openai" | "openai-codex" | "google";
  model: string;
  label: string;
  supportsEdit: boolean;
}

export interface ImageGenerationOptions {
  /** Internal notification of this action's independently confirmed first session. */
  onCreatedSession?: (session: CreatedChatSessionIdentity) => boolean;
  clearDraftOnSuccess?: boolean;
  trigger?: "button" | "auto_send";
}

export interface CreatedChatSessionIdentity { workspaceId: string; sessionId: string; }
export interface UploadAttachmentOptions {
  onCreatedSession?: (session: ChatSessionRecord) => boolean;
}
