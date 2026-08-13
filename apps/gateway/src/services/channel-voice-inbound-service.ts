import {
  BoundedResponseReadError,
  readBoundedResponseBytes,
  readBoundedResponseJson,
} from "./bounded-response-reader.js";
import { detectAttachmentMediaType, sniffAttachmentBytes } from "./media-voice-service.js";

/**
 * Channel voice inbound (competitive-gap phase B2a): per-channel media download
 * + transcription for inbound Telegram voice notes and WhatsApp audio messages.
 *
 * Security posture (this service pulls bytes from provider-controlled URLs):
 * - Media references are validated against strict shape allowlists before any
 *   URL is constructed from them (no traversal / injection via file ids).
 * - Every constructed URL must pass the connection outbound allowlist, and the
 *   WhatsApp CDN URL returned by the Graph API must additionally resolve to a
 *   known Meta media host (or loopback for local test rigs). Redirects are
 *   refused so an allowlisted host can never bounce us elsewhere.
 * - Downloads are size-capped (8MB, matching the channel inline-attachment
 *   limit) and time-bounded.
 * - Downloaded bytes are sniffed before transcription; clearly non-audio bytes
 *   are rejected without ever reaching the transcriber (which re-validates).
 *
 * All failures are typed — callers fall back to placeholder ingestion so an
 * inbound voice message is never silently dropped.
 */

/** Mirrors the channel inline-attachment cap in channel-attachment-payload.ts. */
export const MAX_CHANNEL_VOICE_MEDIA_BYTES = 8 * 1024 * 1024;

const MEDIA_METADATA_MAX_BYTES = 64 * 1024;
const MEDIA_METADATA_TIMEOUT_MS = 10_000;
const MEDIA_DOWNLOAD_TIMEOUT_MS = 60_000;

const TELEGRAM_API_HOST = "https://api.telegram.org";
const DEFAULT_WHATSAPP_API_VERSION = "v23.0";

/** Telegram file ids are opaque base64url-ish tokens. */
const TELEGRAM_FILE_ID_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;
/** Telegram getFile file_path values look like "voice/file_123.oga". */
const TELEGRAM_FILE_PATH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$/;
/** WhatsApp Cloud API media ids are opaque tokens (usually numeric). */
const WHATSAPP_MEDIA_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export type ChannelVoiceInboundRequest =
  | {
      channel: "telegram";
      connectionConfig: Record<string, unknown>;
      fileId: string;
      mimeType?: string;
    }
  | {
      channel: "whatsapp";
      connectionConfig: Record<string, unknown>;
      mediaId: string;
      mimeType?: string;
    };

export type ChannelVoiceTranscriptionFailureReason =
  | "missing_credentials"
  | "invalid_media_reference"
  | "url_not_allowlisted"
  | "download_failed"
  | "media_too_large"
  | "unsupported_media"
  | "transcription_failed"
  | "empty_transcript";

export type ChannelVoiceTranscriptionResult =
  | { ok: true; transcript: string }
  | { ok: false; reason: ChannelVoiceTranscriptionFailureReason; detail?: string };

export interface ChannelVoiceInboundDeps {
  /** Outbound fetch with the gateway's diagnostics timeout wrapper. */
  fetchWithTimeout: (url: string, init?: RequestInit) => Promise<Response>;
  /** MediaVoiceService.transcribeVoice (bounded ffmpeg/whisper subprocesses). */
  transcribeVoice: (input: { bytesBase64: string; mimeType?: string; language?: string }) => Promise<{ text: string }>;
  /** Gateway connection outbound-URL allowlist. */
  isConnectionUrlAllowlisted: (urlValue: string) => boolean;
  /** Connection-config secret resolver (direct value or allowlisted env name). */
  resolveConnectionSecret: (
    config: Record<string, unknown>,
    directKey: string,
    envKey: string,
    catalogId: string,
  ) => string | undefined;
}

export class ChannelVoiceInboundService {
  public constructor(private readonly deps: ChannelVoiceInboundDeps) {}

  public async transcribe(request: ChannelVoiceInboundRequest): Promise<ChannelVoiceTranscriptionResult> {
    try {
      const media =
        request.channel === "telegram"
          ? await this.downloadTelegramVoiceMedia(request)
          : await this.downloadWhatsAppVoiceMedia(request);
      if (!media.ok) {
        return media;
      }
      return await this.transcribeDownloadedBytes(media.bytes, media.mimeType);
    } catch (error) {
      return failure("download_failed", error);
    }
  }

  private async downloadTelegramVoiceMedia(request: Extract<ChannelVoiceInboundRequest, { channel: "telegram" }>) {
    const botToken =
      this.deps.resolveConnectionSecret(request.connectionConfig, "botToken", "botTokenEnv", "channel.telegram") ??
      this.deps.resolveConnectionSecret(request.connectionConfig, "token", "tokenEnv", "channel.telegram");
    if (!botToken) {
      return failure("missing_credentials", "Telegram connection is missing a bot token.");
    }
    if (!TELEGRAM_FILE_ID_PATTERN.test(request.fileId)) {
      return failure("invalid_media_reference", "Telegram voice file id has an unexpected shape.");
    }

    const getFileUrl = `${TELEGRAM_API_HOST}/bot${botToken}/getFile?file_id=${encodeURIComponent(request.fileId)}`;
    if (!this.deps.isConnectionUrlAllowlisted(getFileUrl)) {
      return failure("url_not_allowlisted", "Telegram API host is not in the current outbound allowlist.");
    }
    const metadataResponse = await this.deps.fetchWithTimeout(getFileUrl, { redirect: "error" });
    if (!metadataResponse.ok) {
      return failure("download_failed", `Telegram getFile failed (${metadataResponse.status}).`);
    }
    const metadata = await readBoundedResponseJson<{
      ok?: boolean;
      result?: { file_path?: unknown; file_size?: unknown };
    }>(metadataResponse, {
      maxBytes: MEDIA_METADATA_MAX_BYTES,
      timeoutMs: MEDIA_METADATA_TIMEOUT_MS,
      label: "Telegram getFile",
    });
    const filePath = typeof metadata.result?.file_path === "string" ? metadata.result.file_path : undefined;
    if (metadata.ok !== true || !filePath) {
      return failure("download_failed", "Telegram getFile returned no file path.");
    }
    if (!TELEGRAM_FILE_PATH_PATTERN.test(filePath) || filePath.includes("..")) {
      return failure("invalid_media_reference", "Telegram getFile returned an unsafe file path.");
    }
    const fileSize = metadata.result?.file_size;
    if (typeof fileSize === "number" && fileSize > MAX_CHANNEL_VOICE_MEDIA_BYTES) {
      return failure("media_too_large", `Telegram voice media is ${fileSize} bytes.`);
    }

    const downloadUrl = `${TELEGRAM_API_HOST}/file/bot${botToken}/${filePath}`;
    if (!this.deps.isConnectionUrlAllowlisted(downloadUrl)) {
      return failure("url_not_allowlisted", "Telegram file host is not in the current outbound allowlist.");
    }
    const bytes = await this.downloadBoundedBytes(downloadUrl, undefined, "Telegram voice media");
    if (!bytes.ok) {
      return bytes;
    }
    return { ok: true as const, bytes: bytes.bytes, mimeType: request.mimeType ?? "audio/ogg" };
  }

  private async downloadWhatsAppVoiceMedia(request: Extract<ChannelVoiceInboundRequest, { channel: "whatsapp" }>) {
    const accessToken =
      this.deps.resolveConnectionSecret(
        request.connectionConfig,
        "accessToken",
        "accessTokenEnv",
        "channel.whatsapp",
      ) ?? this.deps.resolveConnectionSecret(request.connectionConfig, "token", "tokenEnv", "channel.whatsapp");
    if (!accessToken) {
      return failure("missing_credentials", "WhatsApp connection is missing an access token.");
    }
    if (!WHATSAPP_MEDIA_ID_PATTERN.test(request.mediaId)) {
      return failure("invalid_media_reference", "WhatsApp media id has an unexpected shape.");
    }

    const baseUrl = resolveWhatsAppApiBaseUrl(request.connectionConfig);
    if (!baseUrl.ok) {
      return baseUrl;
    }
    const metadataUrl = `${baseUrl.url}/${encodeURIComponent(request.mediaId)}`;
    if (!this.deps.isConnectionUrlAllowlisted(metadataUrl)) {
      return failure("url_not_allowlisted", "WhatsApp API host is not in the current outbound allowlist.");
    }
    const metadataResponse = await this.deps.fetchWithTimeout(metadataUrl, {
      redirect: "error",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!metadataResponse.ok) {
      return failure("download_failed", `WhatsApp media lookup failed (${metadataResponse.status}).`);
    }
    const metadata = await readBoundedResponseJson<{
      url?: unknown;
      mime_type?: unknown;
      file_size?: unknown;
    }>(metadataResponse, {
      maxBytes: MEDIA_METADATA_MAX_BYTES,
      timeoutMs: MEDIA_METADATA_TIMEOUT_MS,
      label: "WhatsApp media lookup",
    });
    const mediaUrl = typeof metadata.url === "string" ? metadata.url : undefined;
    if (!mediaUrl) {
      return failure("download_failed", "WhatsApp media lookup returned no download URL.");
    }
    // SSRF gate: the Graph API response body is attacker-influencable in the
    // worst case, so the returned URL must independently prove it points at a
    // known Meta media host before we attach the bearer token and fetch it.
    if (!isAllowedWhatsAppMediaUrl(mediaUrl)) {
      return failure("url_not_allowlisted", "WhatsApp media URL does not resolve to an allowed Meta media host.");
    }
    const fileSize = metadata.file_size;
    if (typeof fileSize === "number" && fileSize > MAX_CHANNEL_VOICE_MEDIA_BYTES) {
      return failure("media_too_large", `WhatsApp voice media is ${fileSize} bytes.`);
    }

    const bytes = await this.downloadBoundedBytes(mediaUrl, accessToken, "WhatsApp voice media");
    if (!bytes.ok) {
      return bytes;
    }
    const metadataMime = typeof metadata.mime_type === "string" ? metadata.mime_type : undefined;
    return { ok: true as const, bytes: bytes.bytes, mimeType: metadataMime ?? request.mimeType ?? "audio/ogg" };
  }

  private async downloadBoundedBytes(
    url: string,
    bearerToken: string | undefined,
    label: string,
  ): Promise<{ ok: true; bytes: Buffer } | Extract<ChannelVoiceTranscriptionResult, { ok: false }>> {
    const response = await this.deps.fetchWithTimeout(url, {
      redirect: "error",
      ...(bearerToken ? { headers: { Authorization: `Bearer ${bearerToken}` } } : {}),
    });
    if (!response.ok) {
      return failure("download_failed", `${label} download failed (${response.status}).`);
    }
    try {
      const bytes = await readBoundedResponseBytes(response, {
        maxBytes: MAX_CHANNEL_VOICE_MEDIA_BYTES,
        timeoutMs: MEDIA_DOWNLOAD_TIMEOUT_MS,
        label,
      });
      if (bytes.byteLength === 0) {
        return failure("download_failed", `${label} download was empty.`);
      }
      return { ok: true, bytes: Buffer.from(bytes) };
    } catch (error) {
      if (error instanceof BoundedResponseReadError && error.code === "body_limit") {
        return failure("media_too_large", error.message);
      }
      return failure("download_failed", error);
    }
  }

  private async transcribeDownloadedBytes(bytes: Buffer, mimeType: string): Promise<ChannelVoiceTranscriptionResult> {
    // Defense-in-depth sniff before handing bytes to the transcriber (which
    // re-validates via validateVoiceTranscriptionPayload). Distrust the
    // provider-declared MIME hint: clearly non-audio bytes never reach ffmpeg.
    const declared = detectAttachmentMediaType(mimeType);
    if (declared !== "audio" && declared !== "video") {
      return failure("unsupported_media", `Declared MIME type ${mimeType} is not audio or video.`);
    }
    const sniffed = sniffAttachmentBytes(bytes);
    if (sniffed !== "audio" && sniffed !== "video" && sniffed !== "unknown") {
      return failure("unsupported_media", `Downloaded bytes sniffed as ${sniffed}, not audio.`);
    }
    try {
      const result = await this.deps.transcribeVoice({
        bytesBase64: bytes.toString("base64"),
        mimeType,
      });
      const transcript = result.text.trim();
      if (!transcript) {
        return failure("empty_transcript", "Transcription produced no text.");
      }
      return { ok: true, transcript };
    } catch (error) {
      return failure("transcription_failed", error);
    }
  }
}

function resolveWhatsAppApiBaseUrl(
  config: Record<string, unknown>,
): { ok: true; url: string } | Extract<ChannelVoiceTranscriptionResult, { ok: false }> {
  const configured = readConfigString(config, "baseUrl");
  const apiVersion = readConfigString(config, "apiVersion") ?? DEFAULT_WHATSAPP_API_VERSION;
  const url = configured
    ? configured.replace(/\/+$/, "")
    : `https://graph.facebook.com/${apiVersion.replace(/^\/+/, "").replace(/\/+$/, "")}`;
  if (!isAllowedWhatsAppMediaUrl(url)) {
    return failure("url_not_allowlisted", `WhatsApp baseUrl host is not an allowed Meta or loopback host: ${url}`);
  }
  return { ok: true, url };
}

/**
 * Host allowlist for WhatsApp Cloud API + media CDN URLs. Mirrors the outbound
 * validateWhatsAppBaseUrl posture (Meta domains + loopback for test rigs) and
 * adds the CDN hosts the media endpoint actually returns (lookaside.fbsbx.com,
 * *.fbcdn.net, *.whatsapp.net).
 */
export function isAllowedWhatsAppMediaUrl(urlValue: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(urlValue);
  } catch {
    return false;
  }
  const hostname = parsed.hostname.toLowerCase();
  const isLoopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  if (isLoopback) {
    // Loopback mirrors validateWhatsAppBaseUrl (local test rigs); plain http allowed.
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  }
  if (parsed.protocol !== "https:") {
    return false;
  }
  return (
    hostname === "graph.facebook.com" ||
    hostname === "facebook.com" ||
    hostname.endsWith(".facebook.com") ||
    hostname === "meta.com" ||
    hostname.endsWith(".meta.com") ||
    hostname.endsWith(".fbcdn.net") ||
    hostname === "lookaside.fbsbx.com" ||
    hostname.endsWith(".fbsbx.com") ||
    hostname.endsWith(".whatsapp.net")
  );
}

function readConfigString(config: Record<string, unknown>, key: string): string | undefined {
  const value = config[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function failure(
  reason: ChannelVoiceTranscriptionFailureReason,
  detail?: unknown,
): Extract<ChannelVoiceTranscriptionResult, { ok: false }> {
  return {
    ok: false,
    reason,
    ...(detail !== undefined ? { detail: detail instanceof Error ? detail.message : String(detail) } : {}),
  };
}
