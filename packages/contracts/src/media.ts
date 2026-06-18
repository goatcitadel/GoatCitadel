export type MediaJobType = "ocr" | "vision" | "audio_transcribe" | "video_transcribe" | "analyze";
export type MediaJobStatus = "queued" | "running" | "ready" | "failed" | "unsupported";
export type MediaPlaybackQuality = "original" | "standard" | "data_saver" | "poster";

export type MediaPlaybackSource =
  | {
      kind: "chat_attachment";
      attachmentId: string;
    }
  | {
      kind: "media_artifact";
      artifactId: string;
    };

export interface MediaPlaybackVariant {
  variantId: MediaPlaybackQuality;
  label: string;
  source: MediaPlaybackSource;
  mimeType: string;
  sizeBytes?: number;
  width?: number;
  height?: number;
  bitrateKbps?: number;
  status?: "available" | "pending" | "unavailable";
}

export interface MediaPlaybackPoster {
  source?: MediaPlaybackSource;
  thumbnailRelPath?: string;
  mimeType?: string;
  sizeBytes?: number;
  status: "available" | "pending" | "unavailable";
}

export interface ChatAttachmentPlaybackMetadata {
  variants: MediaPlaybackVariant[];
  poster?: MediaPlaybackPoster;
}

export interface MediaPlaybackTokenRequest {
  source: MediaPlaybackSource;
  variantId?: MediaPlaybackQuality;
}

export interface MediaPlaybackTokenResponse {
  token: string;
  expiresAt: string;
  source: MediaPlaybackSource;
  variantId: MediaPlaybackQuality;
  contentPath: string;
}

export interface MediaJobRecord {
  jobId: string;
  sessionId?: string;
  attachmentId?: string;
  type: MediaJobType;
  status: MediaJobStatus;
  inputJson?: Record<string, unknown>;
  outputJson?: Record<string, unknown>;
  error?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface MediaArtifactRecord {
  artifactId: string;
  jobId: string;
  attachmentId?: string;
  kind: "thumbnail" | "ocr_text" | "transcript" | "analysis";
  storageRelPath?: string;
  textPreview?: string;
  mimeType?: string;
  sizeBytes?: number;
  createdAt: string;
}

export interface MediaCreateJobRequest {
  type: MediaJobType;
  sessionId?: string;
  attachmentId?: string;
  input?: Record<string, unknown>;
}

export interface ChatAttachmentPreviewResponse {
  attachmentId: string;
  fileName: string;
  mimeType: string;
  mediaType: "text" | "image" | "audio" | "video" | "binary";
  thumbnailRelPath?: string;
  extractPreview?: string;
  ocrText?: string;
  transcriptText?: string;
  analysisStatus: MediaJobStatus;
  playback?: ChatAttachmentPlaybackMetadata;
}
