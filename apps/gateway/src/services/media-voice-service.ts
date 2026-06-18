/* eslint-disable max-lines -- Media, voice, and Meet session orchestration stay grouped until their shared state model is split. */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { TAVERN_AUDIO_CAPTURE_DEFAULTS } from "@goatcitadel/contracts";
import type {
  ChatAttachmentMediaType,
  ChatAttachmentPlaybackMetadata,
  ChatAttachmentPreviewResponse,
  ChatAttachmentRecord,
  GoogleMeetCleanupResult,
  GoogleMeetConsultHandoff,
  GoogleMeetPrerequisiteStatusRequest,
  GoogleMeetPrerequisiteStatusResponse,
  GoogleMeetSessionRecord,
  GoogleMeetSessionStartRequest,
  GoogleMeetTranscriptChunk,
  MediaCreateJobRequest,
  MediaJobRecord,
  MediaPlaybackSource,
  MediaPlaybackTokenRequest,
  MediaPlaybackTokenResponse,
  MediaPlaybackQuality,
  VoiceRuntimeInstallRequest,
  VoiceRuntimeStatus,
  VoiceStatus,
  VoiceTalkSessionRecord,
  VoiceTranscribeResponse,
} from "@goatcitadel/contracts";
import {
  installManagedVoiceRuntime,
  removeManagedVoiceModel,
  selectManagedVoiceModel,
} from "../voice-runtime/installer.js";
import { getManagedVoiceRuntimeStatus } from "../voice-runtime/status.js";
import { buildVoiceControlStartFailure } from "./voice-control-guard.js";
import type { GatewaySqlRepository, SystemSettingsRepository } from "@goatcitadel/storage";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VOICE_STATUS_SETTING_KEY = "voice_status_v1";
const VOICE_WAKE_STATUS_SETTING_KEY = "voice_wake_status_v1";
const GOOGLE_MEET_SESSIONS_SETTING_KEY = "google_meet_voice_sessions_v1";
const DEFAULT_VOICE_PROVIDER: VoiceTranscribeResponse["provider"] = "whisper.cpp";

/**
 * Bound external-process work so a hung tool cannot block the request path
 * forever. ffmpeg only re-muxes a short clip to 16kHz mono WAV, so a tight
 * bound is fine; whisper transcription can legitimately run for a while, so it
 * gets a generous-but-finite ceiling. On timeout `execFile` kills the child
 * and rejects, which we surface as a clean transcription error.
 */
const FFMPEG_CONVERT_TIMEOUT_MS = 30_000;
const WHISPER_TRANSCRIBE_TIMEOUT_MS = 120_000;
const VIDEO_DERIVATIVE_TIMEOUT_MS = 120_000;
const EXTERNAL_PROCESS_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const MEDIA_PLAYBACK_TOKEN_TTL_MS = 2 * 60 * 1000;
const MEDIA_PLAYBACK_TOKEN_MAX_RECORDS = 300;

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface MediaJobRow {
  job_id: string;
  session_id: string | null;
  attachment_id: string | null;
  job_type: MediaJobRecord["type"];
  status: MediaJobRecord["status"];
  input_json: string | null;
  output_json: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface MediaArtifactRow {
  artifact_id: string;
  job_id: string;
  attachment_id: string | null;
  kind: "thumbnail" | "video_variant" | "ocr_text" | "transcript" | "analysis";
  storage_rel_path: string | null;
  text_preview: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  created_at: string;
}

interface DevDiagnosticInput {
  level: "debug" | "info" | "warn" | "error";
  category: string;
  event: string;
  message: string;
  context?: Record<string, unknown>;
  meetingSessionId?: string;
  durationMs?: number;
  runtimeKind?: string;
  runtimeStatus?: "started" | "running" | "completed" | "failed" | "cancelled" | "blocked" | "degraded";
  runtimeError?: {
    name?: string;
    message: string;
    code?: string;
    retryable?: boolean;
  };
}

interface MediaPlaybackTokenRecord {
  token: string;
  source: MediaPlaybackSource;
  variantId: MediaPlaybackQuality;
  expiresAtMs: number;
}

// ---------------------------------------------------------------------------
// Dependencies injected by GatewayService
// ---------------------------------------------------------------------------

export interface MediaVoiceDeps {
  readonly gatewaySql: GatewaySqlRepository;
  readonly storage: {
    readonly systemSettings: SystemSettingsRepository;
    readonly chatAttachments: {
      get(attachmentId: string): ChatAttachmentRecord;
    };
  };
  readonly backgroundTasks: Set<Promise<unknown>>;
  readonly isClosing: () => boolean;
  readonly publishRealtime: (eventType: string, source: string, payload: Record<string, unknown>) => void;
  readonly recordDevDiagnostic: (input: DevDiagnosticInput) => void;
  readonly readChatAttachmentContent: (attachmentId: string) => Promise<{
    record: ChatAttachmentRecord;
    fullPath: string;
    bytes: Buffer;
  }>;
  readonly getChatAttachment: (attachmentId: string) => ChatAttachmentRecord;
}

// ---------------------------------------------------------------------------
// Helpers (moved from gateway-service.ts module scope)
// ---------------------------------------------------------------------------

function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export const __mediaVoiceServiceInternals = {
  decodeStrictBase64,
  extFromMimeType,
  isMediaJobRow,
  isRecord,
  mapMediaJobRow,
  normalizeAudioForWhisper,
  parseVoiceCliArgs,
  validateVoiceTranscriptionPayload,
  safeJsonParse,
  toMediaJobRows,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mapMediaJobRow(row: MediaJobRow): MediaJobRecord {
  return {
    jobId: row.job_id,
    sessionId: row.session_id ?? undefined,
    attachmentId: row.attachment_id ?? undefined,
    type: row.job_type,
    status: row.status,
    inputJson: row.input_json ? safeJsonParse<Record<string, unknown>>(row.input_json, {}) : undefined,
    outputJson: row.output_json ? safeJsonParse<Record<string, unknown>>(row.output_json, {}) : undefined,
    error: row.error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? undefined,
  };
}

function isMediaJobRow(value: unknown): value is MediaJobRow {
  return (
    isRecord(value) &&
    typeof value.job_id === "string" &&
    (typeof value.session_id === "string" || value.session_id === null) &&
    (typeof value.attachment_id === "string" || value.attachment_id === null) &&
    typeof value.job_type === "string" &&
    typeof value.status === "string" &&
    (typeof value.input_json === "string" || value.input_json === null) &&
    (typeof value.output_json === "string" || value.output_json === null) &&
    (typeof value.error === "string" || value.error === null) &&
    typeof value.created_at === "string" &&
    typeof value.updated_at === "string" &&
    (typeof value.completed_at === "string" || value.completed_at === null)
  );
}

function toMediaJobRows(value: unknown): MediaJobRow[] {
  return Array.isArray(value) ? value.filter(isMediaJobRow) : [];
}

function isMediaArtifactRow(value: unknown): value is MediaArtifactRow {
  return (
    isRecord(value) &&
    typeof value.artifact_id === "string" &&
    typeof value.job_id === "string" &&
    (typeof value.attachment_id === "string" || value.attachment_id === null) &&
    (value.kind === "thumbnail" ||
      value.kind === "video_variant" ||
      value.kind === "ocr_text" ||
      value.kind === "transcript" ||
      value.kind === "analysis") &&
    (typeof value.storage_rel_path === "string" || value.storage_rel_path === null) &&
    (typeof value.text_preview === "string" || value.text_preview === null) &&
    (typeof value.mime_type === "string" || value.mime_type === null) &&
    (typeof value.size_bytes === "number" || value.size_bytes === null) &&
    typeof value.created_at === "string"
  );
}

function toMediaArtifactRows(value: unknown): MediaArtifactRow[] {
  return Array.isArray(value) ? value.filter(isMediaArtifactRow) : [];
}

function parseVideoVariantId(value: string | null): "standard" | "data_saver" | null {
  return value === "standard" || value === "data_saver" ? value : null;
}

function buildVoiceTransportStatus(input: {
  runtime: VoiceRuntimeStatus;
  stt: VoiceStatus["stt"];
  now: string;
}): VoiceStatus["transport"] {
  const transcriptionState =
    input.runtime.readiness === "ready" ? "ready" : input.runtime.readiness === "broken" ? "degraded" : "unavailable";
  const transcriptionMessage =
    transcriptionState === "ready"
      ? input.stt.state === "error" && input.stt.lastError
        ? `Local transcription runtime is ready. Last transcription error: ${input.stt.lastError}`
        : "Local transcription runtime is ready for uploaded audio and voice capture."
      : transcriptionState === "degraded"
        ? (input.stt.lastError ?? input.runtime.lastError ?? "Local transcription runtime needs attention.")
        : "Local transcription runtime is not configured yet.";
  return {
    playback: {
      state: "ready",
      updatedAt: input.now,
      message: "Uploaded audio previews use tokenized range streaming.",
    },
    capture: {
      state: "degraded",
      updatedAt: input.now,
      constraints: TAVERN_AUDIO_CAPTURE_DEFAULTS,
      message:
        "Browser capture constraints are defined; device support and microphone permission are checked client-side.",
    },
    transcription: {
      state: transcriptionState,
      provider: input.stt.provider,
      updatedAt: input.now,
      message: transcriptionMessage,
    },
  };
}

export function detectAttachmentMediaType(mimeType: string): ChatAttachmentMediaType {
  const normalized = mimeType.toLowerCase();
  if (normalized.startsWith("image/")) {
    return "image";
  }
  if (normalized.startsWith("audio/")) {
    return "audio";
  }
  if (normalized.startsWith("video/")) {
    return "video";
  }
  if (
    normalized.startsWith("text/") ||
    normalized === "application/json" ||
    normalized === "application/xml" ||
    normalized === "application/javascript"
  ) {
    return "text";
  }
  return "binary";
}

export type SniffedMediaClass = "image" | "audio" | "video" | "archive" | "document" | "text" | "unknown";

/**
 * Magic-number sniff for attachment bytes. Distrust the declared filename and
 * MIME hint; sniff a small prefix and surface the actual content class. Used
 * to catch zip-as-png and other label-vs-bytes mismatches before staging.
 */
export function sniffAttachmentBytes(bytes: Buffer): SniffedMediaClass {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    return "unknown";
  }
  const head = bytes.subarray(0, Math.min(bytes.length, 32));

  // Image formats
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return "image"; // JPEG
  }
  if (
    head.length >= 8 &&
    head[0] === 0x89 &&
    head[1] === 0x50 &&
    head[2] === 0x4e &&
    head[3] === 0x47 &&
    head[4] === 0x0d &&
    head[5] === 0x0a &&
    head[6] === 0x1a &&
    head[7] === 0x0a
  ) {
    return "image"; // PNG
  }
  if (head.length >= 6 && head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x38) {
    return "image"; // GIF
  }
  if (head.length >= 2 && head[0] === 0x42 && head[1] === 0x4d) {
    return "image"; // BMP
  }
  if (
    head.length >= 4 &&
    ((head[0] === 0x49 && head[1] === 0x49 && head[2] === 0x2a && head[3] === 0x00) ||
      (head[0] === 0x4d && head[1] === 0x4d && head[2] === 0x00 && head[3] === 0x2a))
  ) {
    return "image"; // TIFF
  }
  // WebP: "RIFF" .... "WEBP"
  if (
    head.length >= 12 &&
    head[0] === 0x52 &&
    head[1] === 0x49 &&
    head[2] === 0x46 &&
    head[3] === 0x46 &&
    head[8] === 0x57 &&
    head[9] === 0x45 &&
    head[10] === 0x42 &&
    head[11] === 0x50
  ) {
    return "image"; // WebP
  }
  // HEIC: 00 00 00 ?? "ftyp" then "heic" / "heix" / "mif1" / "msf1"
  if (head.length >= 12 && head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70) {
    const brand = head.subarray(8, 12).toString("ascii");
    if (brand === "heic" || brand === "heix" || brand === "mif1" || brand === "msf1" || brand === "avif") {
      return "image";
    }
    if (
      brand === "qt  " ||
      brand === "mp41" ||
      brand === "mp42" ||
      brand === "isom" ||
      brand === "M4V " ||
      brand === "M4VP"
    ) {
      return "video";
    }
    if (brand === "M4A " || brand === "M4B ") {
      return "audio";
    }
    return "video"; // Default for unknown ftyp brands; still treats as media not zip
  }

  // Audio formats
  if (
    head.length >= 12 &&
    head[0] === 0x52 &&
    head[1] === 0x49 &&
    head[2] === 0x46 &&
    head[3] === 0x46 &&
    head[8] === 0x57 &&
    head[9] === 0x41 &&
    head[10] === 0x56 &&
    head[11] === 0x45
  ) {
    return "audio"; // WAV (RIFF...WAVE)
  }
  if (head.length >= 4 && head[0] === 0x4f && head[1] === 0x67 && head[2] === 0x67 && head[3] === 0x53) {
    return "audio"; // OGG
  }
  if (head.length >= 3 && head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) {
    return "audio"; // MP3 with ID3
  }
  if (
    head.length >= 2 &&
    head[0] === 0xff &&
    (head[1] === 0xfb || head[1] === 0xf3 || head[1] === 0xf2 || head[1] === 0xe3)
  ) {
    return "audio"; // MP3 framesync
  }
  if (head.length >= 4 && head[0] === 0x66 && head[1] === 0x4c && head[2] === 0x61 && head[3] === 0x43) {
    return "audio"; // FLAC
  }

  // Document formats
  if (head.length >= 4 && head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46) {
    return "document"; // PDF
  }

  // Archive (zip / docx / xlsx / pptx / odf — bytes look like zip)
  if (
    head.length >= 4 &&
    head[0] === 0x50 &&
    head[1] === 0x4b &&
    (head[2] === 0x03 || head[2] === 0x05 || head[2] === 0x07)
  ) {
    return "archive";
  }
  if (head.length >= 6 && head[0] === 0x37 && head[1] === 0x7a && head[2] === 0xbc && head[3] === 0xaf) {
    return "archive"; // 7z
  }
  if (head.length >= 4 && head[0] === 0x52 && head[1] === 0x61 && head[2] === 0x72 && head[3] === 0x21) {
    return "archive"; // RAR
  }
  if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) {
    return "archive"; // gzip
  }

  // Text: pragmatic check on the prefix (UTF-8 BOM + printable / control whitespace)
  let printable = 0;
  for (const byte of head) {
    if (byte === 0) {
      return "unknown";
    }
    if (byte === 0x09 || byte === 0x0a || byte === 0x0d || (byte >= 0x20 && byte < 0x7f) || byte >= 0xa0) {
      printable += 1;
    }
  }
  if (printable === head.length && head.length >= 8) {
    return "text";
  }

  return "unknown";
}

/**
 * Reject malformed base64 BEFORE Buffer.from(..., 'base64') silently mangles
 * the input. Buffer.from with base64 input silently strips invalid bytes,
 * which means a malicious payload can smuggle bytes past validation.
 */
export function decodeStrictBase64(value: string): Buffer {
  const stripped = value.trim().replace(/\s+/g, "");
  if (stripped.length === 0) {
    throw new Error("Base64 payload is empty.");
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(stripped)) {
    throw new Error("Base64 payload contains characters outside the base64 alphabet.");
  }
  if (stripped.length % 4 !== 0) {
    throw new Error("Base64 payload length is not a multiple of 4.");
  }
  const decoded = Buffer.from(stripped, "base64");
  // Round-trip check: Buffer.from('base64') is lenient. Re-encode and confirm.
  const reEncoded = decoded.toString("base64");
  if (reEncoded.replace(/=+$/, "") !== stripped.replace(/=+$/, "")) {
    throw new Error("Base64 payload failed strict round-trip validation.");
  }
  return decoded;
}

/**
 * Compare a declared MIME hint against the sniffed media class. Throws when
 * the declared class is "image"/"audio"/"video" but the bytes look like zip,
 * a different media class, or unknown opaque bytes — the exact label-vs-bytes
 * mismatch that lets a "PNG" payload smuggle a zip into the workspace.
 *
 * Permissive when the bytes legitimately classify as text (e.g. an SVG image
 * declared as image/svg+xml correctly sniffs as text and is allowed through
 * the image class).
 */
export function assertAttachmentBytesMatchMimeHint(bytes: Buffer, declaredMimeType: string): void {
  const declared = detectAttachmentMediaType(declaredMimeType);
  if (declared !== "image" && declared !== "audio" && declared !== "video") {
    return;
  }
  const sniffed = sniffAttachmentBytes(bytes);
  if (sniffed === "unknown") {
    // Allow uncommon-but-legitimate formats not in our sniff table; the
    // bytes don't carry a known mismatch signal.
    return;
  }
  if (sniffed === declared) {
    return;
  }
  if (declared === "image" && sniffed === "text") {
    return; // SVG and friends
  }
  throw new Error(
    `Attachment bytes do not match the declared MIME hint (${declaredMimeType} → ${declared}, sniffed ${sniffed}).`,
  );
}

function validateVoiceTranscriptionPayload(bytes: Buffer, declaredMimeType?: string): void {
  const normalizedMime = declaredMimeType?.trim().toLowerCase();
  if (!normalizedMime) {
    throw new Error("Voice transcription requires an audio or video MIME type.");
  }
  const declared = detectAttachmentMediaType(normalizedMime);
  if (declared !== "audio" && declared !== "video") {
    throw new Error(`Voice transcription requires audio or video bytes, got ${declaredMimeType}.`);
  }

  const sniffed = sniffAttachmentBytes(bytes);
  if (sniffed === "unknown" || sniffed === "audio" || sniffed === "video") {
    return;
  }
  throw new Error(
    `Voice transcription bytes do not match the declared MIME hint (${declaredMimeType} -> ${declared}, sniffed ${sniffed}).`,
  );
}

function extFromMimeType(mimeType?: string): string {
  const normalized = mimeType?.toLowerCase() ?? "";
  if (normalized.includes("wav")) {
    return ".wav";
  }
  if (normalized.includes("mpeg")) {
    return ".mp3";
  }
  if (normalized.includes("ogg")) {
    return ".ogg";
  }
  if (normalized.includes("mp4")) {
    return ".mp4";
  }
  if (normalized.includes("webm")) {
    return ".webm";
  }
  return ".bin";
}

/**
 * Node's `execFile`/`promisify(execFile)` rejects with `killed === true` when
 * the `timeout` option fires (the child is sent the kill signal). Detect that
 * shape so callers can surface an explicit timeout message instead of a raw
 * "Command failed" / signal string.
 */
function isProcessTimeoutError(error: unknown): boolean {
  return (
    isRecord(error) &&
    (error as { killed?: unknown }).killed === true &&
    typeof (error as { signal?: unknown }).signal === "string"
  );
}

function parseVoiceCliArgs(rawValue?: string): string[] {
  if (!rawValue?.trim()) {
    return [];
  }
  return rawValue
    .split(/\s+/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

async function normalizeAudioForWhisper(input: {
  inputPath: string;
  outputPath: string;
  mimeType?: string;
  ffmpegPath?: string;
}): Promise<string> {
  const normalized = input.mimeType?.toLowerCase() ?? "";
  if (normalized.includes("wav") || input.inputPath.toLowerCase().endsWith(".wav")) {
    return input.inputPath;
  }
  if (!input.ffmpegPath) {
    throw new Error("Audio normalization helper is not configured for non-WAV input.");
  }
  try {
    await execFileAsync(
      input.ffmpegPath,
      ["-y", "-i", input.inputPath, "-ac", "1", "-ar", "16000", "-f", "wav", input.outputPath],
      { timeout: FFMPEG_CONVERT_TIMEOUT_MS, windowsHide: true, maxBuffer: EXTERNAL_PROCESS_MAX_BUFFER_BYTES },
    );
  } catch (error) {
    if (isProcessTimeoutError(error)) {
      throw new Error(`Audio normalization timed out after ${FFMPEG_CONVERT_TIMEOUT_MS}ms and was terminated.`, {
        cause: error,
      });
    }
    throw error;
  }
  return input.outputPath;
}

async function transcodeVideoDerivative(input: {
  ffmpegPath: string;
  inputPath: string;
  outputPath: string;
  kind: "poster" | "standard" | "data_saver";
}): Promise<void> {
  const args =
    input.kind === "poster"
      ? ["-y", "-i", input.inputPath, "-vf", "thumbnail,scale='min(1280,iw)':-2", "-frames:v", "1", input.outputPath]
      : [
          "-y",
          "-i",
          input.inputPath,
          "-vf",
          input.kind === "standard" ? "scale='min(1280,iw)':-2" : "scale='min(640,iw)':-2",
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-crf",
          input.kind === "standard" ? "26" : "32",
          "-c:a",
          "aac",
          "-b:a",
          input.kind === "standard" ? "128k" : "64k",
          "-movflags",
          "+faststart",
          input.outputPath,
        ];
  try {
    await execFileAsync(input.ffmpegPath, args, {
      timeout: VIDEO_DERIVATIVE_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: EXTERNAL_PROCESS_MAX_BUFFER_BYTES,
    });
  } catch (error) {
    if (isProcessTimeoutError(error)) {
      throw new Error(`Video derivative ${input.kind} timed out after ${VIDEO_DERIVATIVE_TIMEOUT_MS}ms.`, {
        cause: error,
      });
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// MediaVoiceService
// ---------------------------------------------------------------------------

export class MediaVoiceService {
  private readonly mediaPlaybackTokens = new Map<string, MediaPlaybackTokenRecord>();

  public constructor(private readonly deps: MediaVoiceDeps) {}

  // ── Media jobs ──────────────────────────────────────────────────────────

  public createMediaJob(input: MediaCreateJobRequest): MediaJobRecord {
    const now = new Date().toISOString();
    const jobId = randomUUID();
    this.deps.gatewaySql
      .prepare(
        `
      INSERT INTO media_jobs (
        job_id, session_id, attachment_id, job_type, status, input_json, output_json, error, created_at, updated_at, completed_at
      ) VALUES (
        @jobId, @sessionId, @attachmentId, @jobType, @status, @inputJson, NULL, NULL, @createdAt, @updatedAt, NULL
      )
    `,
      )
      .run({
        jobId,
        sessionId: input.sessionId ?? null,
        attachmentId: input.attachmentId ?? null,
        jobType: input.type,
        status: "queued",
        inputJson: input.input ? JSON.stringify(input.input) : null,
        createdAt: now,
        updatedAt: now,
      });
    const created = this.getMediaJob(jobId);
    this.processMediaJob(jobId);
    return created;
  }

  public getMediaJob(jobId: string): MediaJobRecord {
    const row = this.deps.gatewaySql
      .prepare(
        `
      SELECT * FROM media_jobs
      WHERE job_id = ?
    `,
      )
      .get(jobId) as MediaJobRow | undefined;
    if (!row) {
      throw new Error(`Unknown media job: ${jobId}`);
    }
    return mapMediaJobRow(row);
  }

  public listMediaJobs(sessionId?: string): MediaJobRecord[] {
    const rows = toMediaJobRows(
      sessionId
        ? this.deps.gatewaySql
            .prepare(
              `
      SELECT * FROM media_jobs
      WHERE session_id = @sessionId
      ORDER BY created_at DESC
      LIMIT 500
    `,
            )
            .all({ sessionId })
        : this.deps.gatewaySql
            .prepare(
              `
      SELECT * FROM media_jobs
      ORDER BY created_at DESC
      LIMIT 500
    `,
            )
            .all(),
    );
    return rows.map(mapMediaJobRow);
  }

  public getChatAttachmentPreview(attachmentId: string): ChatAttachmentPreviewResponse {
    const record = this.deps.getChatAttachment(attachmentId);
    const mediaType = record.mediaType ?? detectAttachmentMediaType(record.mimeType);
    return {
      attachmentId: record.attachmentId,
      fileName: record.fileName,
      mimeType: record.mimeType,
      mediaType,
      thumbnailRelPath: record.thumbnailRelPath,
      extractPreview: record.extractPreview,
      ocrText: record.ocrText,
      transcriptText: record.transcriptText,
      analysisStatus: record.analysisStatus === "pending" ? "queued" : (record.analysisStatus ?? "queued"),
      playback: this.buildAttachmentPlaybackMetadata(record, mediaType),
    };
  }

  public issueMediaPlaybackToken(input: MediaPlaybackTokenRequest): MediaPlaybackTokenResponse {
    let variantId: MediaPlaybackQuality = input.variantId ?? "original";
    let source: MediaPlaybackSource;
    let contentPath: string;
    if (input.source.kind === "chat_attachment") {
      if (variantId !== "original") {
        throw new Error(`Media playback variant is not available for original attachment source: ${variantId}`);
      }
      const attachment = this.deps.getChatAttachment(input.source.attachmentId);
      const mediaType = attachment.mediaType ?? detectAttachmentMediaType(attachment.mimeType);
      if (mediaType !== "audio" && mediaType !== "video") {
        throw new Error(`Attachment ${attachment.attachmentId} is ${mediaType} and cannot be streamed as media.`);
      }
      source = {
        kind: "chat_attachment",
        attachmentId: attachment.attachmentId,
      };
      contentPath = `/api/v1/chat/attachments/${encodeURIComponent(
        attachment.attachmentId,
      )}/content?disposition=inline&media_token=`;
    } else {
      const artifact = this.getMediaArtifactRow(input.source.artifactId);
      if (artifact.kind !== "video_variant" && artifact.kind !== "thumbnail") {
        throw new Error(`Media artifact ${artifact.artifact_id} is ${artifact.kind} and cannot be streamed as media.`);
      }
      const artifactVariantId = artifact.kind === "thumbnail" ? "poster" : parseVideoVariantId(artifact.text_preview);
      if (!artifactVariantId) {
        throw new Error(`Media artifact ${artifact.artifact_id} does not identify a playable media variant.`);
      }
      if (input.variantId && input.variantId !== artifactVariantId) {
        throw new Error(`Media artifact ${artifact.artifact_id} is ${artifactVariantId}, not ${input.variantId}.`);
      }
      variantId = artifactVariantId;
      source = {
        kind: "media_artifact",
        artifactId: artifact.artifact_id,
      };
      contentPath = `/api/v1/media/artifacts/${encodeURIComponent(artifact.artifact_id)}/content?media_token=`;
    }
    this.pruneMediaPlaybackTokens();
    const token = randomBytes(32).toString("base64url");
    const expiresAtMs = Date.now() + MEDIA_PLAYBACK_TOKEN_TTL_MS;
    this.mediaPlaybackTokens.set(token, {
      token,
      source,
      variantId,
      expiresAtMs,
    });
    this.enforceMediaPlaybackTokenCapacity();
    return {
      token,
      expiresAt: new Date(expiresAtMs).toISOString(),
      source,
      variantId,
      contentPath: `${contentPath}${encodeURIComponent(token)}`,
    };
  }

  public validateMediaPlaybackToken(input: {
    token: string;
    source: MediaPlaybackSource;
    variantId?: MediaPlaybackQuality;
  }): boolean {
    this.pruneMediaPlaybackTokens();
    const record = this.mediaPlaybackTokens.get(input.token);
    if (!record || record.expiresAtMs <= Date.now()) {
      return false;
    }
    return (
      (input.variantId === undefined || record.variantId === input.variantId) &&
      record.source.kind === input.source.kind &&
      ((record.source.kind === "chat_attachment" &&
        input.source.kind === "chat_attachment" &&
        record.source.attachmentId === input.source.attachmentId) ||
        (record.source.kind === "media_artifact" &&
          input.source.kind === "media_artifact" &&
          record.source.artifactId === input.source.artifactId))
    );
  }

  public async resolveMediaArtifactContent(artifactId: string): Promise<{
    artifactId: string;
    attachmentId?: string;
    mimeType: string;
    fullPath: string;
    sizeBytes: number;
  }> {
    const artifact = this.getMediaArtifactRow(artifactId);
    if (!artifact.storage_rel_path) {
      throw new Error(`Media artifact ${artifactId} has no stored content.`);
    }
    if (!artifact.attachment_id) {
      throw new Error(`Media artifact ${artifactId} is not linked to an attachment.`);
    }
    const attachment = this.deps.getChatAttachment(artifact.attachment_id);
    const attachmentContent = await this.deps.readChatAttachmentContent(artifact.attachment_id);
    if (path.posix.dirname(artifact.storage_rel_path) !== path.posix.dirname(attachment.storageRelPath)) {
      throw new Error(`Media artifact ${artifactId} is outside the attachment media directory.`);
    }
    const fullPath = path.join(
      path.dirname(attachmentContent.fullPath),
      path.posix.basename(artifact.storage_rel_path),
    );
    const stat = await fs.stat(fullPath);
    if (!stat.isFile()) {
      throw new Error(`Media artifact ${artifactId} content is not a regular file.`);
    }
    return {
      artifactId,
      attachmentId: artifact.attachment_id,
      mimeType: artifact.mime_type ?? "application/octet-stream",
      fullPath,
      sizeBytes: stat.size,
    };
  }

  // ── Voice transcription ─────────────────────────────────────────────────

  public async transcribeVoice(input: {
    bytesBase64: string;
    mimeType?: string;
    language?: string;
  }): Promise<VoiceTranscribeResponse> {
    const bytes = decodeStrictBase64(input.bytesBase64);
    if (bytes.length === 0) {
      throw new Error("Audio payload is empty.");
    }
    validateVoiceTranscriptionPayload(bytes, input.mimeType);
    this.deps.recordDevDiagnostic({
      level: "info",
      category: "voice",
      event: "voice.transcribe.start",
      message: "Starting voice transcription",
      context: {
        bytes: bytes.length,
        mimeType: input.mimeType,
        language: input.language,
      },
    });
    return this.transcribeAudioBytes(bytes, input.mimeType, input.language);
  }

  // ── Voice status & runtime ──────────────────────────────────────────────

  public async getVoiceStatus(): Promise<VoiceStatus> {
    const now = new Date().toISOString();
    const runtime = await getManagedVoiceRuntimeStatus(this.deps.storage.systemSettings);
    const stt = this.deps.storage.systemSettings.get<VoiceStatus["stt"]>(VOICE_STATUS_SETTING_KEY)?.value ?? {
      state: "stopped",
      provider: DEFAULT_VOICE_PROVIDER,
      runtimeReady: runtime.readiness === "ready",
      modelId: runtime.selectedModelId,
      updatedAt: now,
    };
    const wake = this.deps.storage.systemSettings.get<VoiceStatus["wake"]>(VOICE_WAKE_STATUS_SETTING_KEY)?.value ?? {
      enabled: false,
      state: "stopped",
      model: "openwakeword",
      updatedAt: now,
    };
    const talkRecord = this.deps.storage.systemSettings.get<{
      activeSessionId?: string;
      state: "stopped" | "running" | "error";
      mode?: "push_to_talk" | "wake";
      updatedAt: string;
    }>("voice_talk_status_v1")?.value ?? {
      activeSessionId: undefined,
      state: "stopped",
      mode: undefined,
      updatedAt: now,
    };
    return {
      stt: {
        ...stt,
        runtimeReady: runtime.readiness === "ready",
        modelId: runtime.selectedModelId,
      },
      talk: talkRecord,
      wake,
      transport: buildVoiceTransportStatus({
        runtime,
        stt,
        now,
      }),
    };
  }

  public async getVoiceRuntimeStatus(): Promise<VoiceRuntimeStatus> {
    return getManagedVoiceRuntimeStatus(this.deps.storage.systemSettings);
  }

  public async installVoiceRuntime(input: VoiceRuntimeInstallRequest = {}): Promise<VoiceRuntimeStatus> {
    this.deps.recordDevDiagnostic({
      level: "info",
      category: "voice",
      event: "voice.runtime.install.start",
      message: "Installing managed voice runtime",
      context: {
        modelId: input.modelId,
        activate: input.activate,
        repair: input.repair,
      },
    });
    const status = await installManagedVoiceRuntime(this.deps.storage.systemSettings, input);
    this.deps.recordDevDiagnostic({
      level: status.readiness === "ready" ? "info" : "warn",
      category: "voice",
      event: "voice.runtime.install.complete",
      message: "Managed voice runtime install finished",
      context: {
        readiness: status.readiness,
        selectedModelId: status.selectedModelId,
        lastError: status.lastError,
      },
    });
    this.deps.storage.systemSettings.set(VOICE_STATUS_SETTING_KEY, {
      ...(this.deps.storage.systemSettings.get<VoiceStatus["stt"]>(VOICE_STATUS_SETTING_KEY)?.value ?? {
        state: "stopped" as const,
        provider: DEFAULT_VOICE_PROVIDER,
        updatedAt: new Date().toISOString(),
      }),
      provider: DEFAULT_VOICE_PROVIDER,
      runtimeReady: status.readiness === "ready",
      modelId: status.selectedModelId,
      lastError: status.lastError,
      updatedAt: new Date().toISOString(),
    });
    return status;
  }

  public async selectVoiceRuntimeModel(modelId: string): Promise<VoiceRuntimeStatus> {
    const status = await selectManagedVoiceModel(this.deps.storage.systemSettings, modelId);
    this.deps.storage.systemSettings.set(VOICE_STATUS_SETTING_KEY, {
      ...(this.deps.storage.systemSettings.get<VoiceStatus["stt"]>(VOICE_STATUS_SETTING_KEY)?.value ?? {
        state: "stopped" as const,
        provider: DEFAULT_VOICE_PROVIDER,
        updatedAt: new Date().toISOString(),
      }),
      provider: DEFAULT_VOICE_PROVIDER,
      runtimeReady: status.readiness === "ready",
      modelId: status.selectedModelId,
      lastError: status.lastError,
      updatedAt: new Date().toISOString(),
    });
    return status;
  }

  public async removeVoiceRuntimeModel(modelId: string): Promise<VoiceRuntimeStatus> {
    const status = await removeManagedVoiceModel(this.deps.storage.systemSettings, modelId);
    this.deps.storage.systemSettings.set(VOICE_STATUS_SETTING_KEY, {
      ...(this.deps.storage.systemSettings.get<VoiceStatus["stt"]>(VOICE_STATUS_SETTING_KEY)?.value ?? {
        state: "stopped" as const,
        provider: DEFAULT_VOICE_PROVIDER,
        updatedAt: new Date().toISOString(),
      }),
      provider: DEFAULT_VOICE_PROVIDER,
      runtimeReady: status.readiness === "ready",
      modelId: status.selectedModelId,
      lastError: status.lastError,
      updatedAt: new Date().toISOString(),
    });
    return status;
  }

  // ── Talk sessions ───────────────────────────────────────────────────────

  public async startTalkSession(input?: {
    mode?: "push_to_talk" | "wake";
    sessionId?: string;
  }): Promise<VoiceTalkSessionRecord> {
    const now = new Date().toISOString();
    const [runtime, voiceStatus] = await Promise.all([
      getManagedVoiceRuntimeStatus(this.deps.storage.systemSettings),
      this.getVoiceStatus(),
    ]);
    const failure = buildVoiceControlStartFailure({
      action: "talk",
      now,
      runtime,
      status: voiceStatus,
    });
    if (failure) {
      this.deps.storage.systemSettings.set(VOICE_STATUS_SETTING_KEY, failure.stt);
      if (failure.talk) {
        this.deps.storage.systemSettings.set("voice_talk_status_v1", failure.talk);
      }
      throw new Error(failure.message);
    }
    const record: VoiceTalkSessionRecord = {
      talkSessionId: randomUUID(),
      mode: input?.mode ?? "push_to_talk",
      state: "running",
      createdAt: now,
      startedAt: now,
      sessionId: input?.sessionId,
    };
    this.deps.gatewaySql
      .prepare(
        `
      INSERT INTO voice_sessions (
        voice_session_id, talk_session_id, mode, state, session_id, payload_json, created_at, updated_at
      ) VALUES (
        @voiceSessionId, @talkSessionId, @mode, @state, @sessionId, @payloadJson, @createdAt, @updatedAt
      )
    `,
      )
      .run({
        voiceSessionId: record.talkSessionId,
        talkSessionId: record.talkSessionId,
        mode: record.mode,
        state: record.state,
        sessionId: record.sessionId ?? null,
        payloadJson: JSON.stringify(record),
        createdAt: now,
        updatedAt: now,
      });
    this.deps.storage.systemSettings.set("voice_talk_status_v1", {
      activeSessionId: record.talkSessionId,
      state: "running",
      mode: record.mode,
      updatedAt: now,
    });
    this.deps.storage.systemSettings.set(VOICE_STATUS_SETTING_KEY, {
      ...voiceStatus.stt,
      state: "stopped",
      provider: runtime.provider,
      modelId: runtime.selectedModelId,
      runtimeReady: runtime.readiness === "ready",
      lastError: undefined,
      updatedAt: now,
    });
    this.deps.publishRealtime("system", "voice", {
      type: "voice_talk_started",
      talkSessionId: record.talkSessionId,
      mode: record.mode,
    });
    return record;
  }

  public listVoiceTalkSessions(limit = 20): VoiceTalkSessionRecord[] {
    const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit) || 20));
    const rows = this.deps.gatewaySql
      .prepare(
        `
      SELECT payload_json
      FROM voice_sessions
      ORDER BY COALESCE(updated_at, created_at) DESC, voice_session_id DESC
      LIMIT ?
    `,
      )
      .all(safeLimit) as Array<{ payload_json: string }>;
    return rows.map((row) =>
      safeJsonParse<VoiceTalkSessionRecord>(row.payload_json, {
        talkSessionId: randomUUID(),
        mode: "push_to_talk",
        state: "stopped",
        createdAt: new Date().toISOString(),
      }),
    );
  }

  public stopTalkSession(talkSessionId: string): VoiceTalkSessionRecord {
    const now = new Date().toISOString();
    const row = this.deps.gatewaySql
      .prepare(
        `
      SELECT payload_json FROM voice_sessions WHERE talk_session_id = ?
    `,
      )
      .get(talkSessionId) as { payload_json: string } | undefined;
    if (!row) {
      throw new Error(`Unknown talk session: ${talkSessionId}`);
    }
    const payload = safeJsonParse<VoiceTalkSessionRecord>(row.payload_json, {
      talkSessionId,
      mode: "push_to_talk",
      state: "running",
      createdAt: now,
    });
    const stopped: VoiceTalkSessionRecord = {
      ...payload,
      state: "stopped",
      stoppedAt: now,
    };
    this.deps.gatewaySql
      .prepare(
        `
      UPDATE voice_sessions
      SET state = 'stopped', payload_json = @payloadJson, updated_at = @updatedAt
      WHERE talk_session_id = @talkSessionId
    `,
      )
      .run({
        payloadJson: JSON.stringify(stopped),
        updatedAt: now,
        talkSessionId,
      });
    this.deps.storage.systemSettings.set("voice_talk_status_v1", {
      activeSessionId: undefined,
      state: "stopped",
      mode: stopped.mode,
      updatedAt: now,
    });
    this.deps.publishRealtime("system", "voice", {
      type: "voice_talk_stopped",
      talkSessionId,
    });
    return stopped;
  }

  // ── Wake word ───────────────────────────────────────────────────────────

  public async startVoiceWake(): Promise<VoiceStatus["wake"]> {
    const now = new Date().toISOString();
    const [runtime, voiceStatus] = await Promise.all([
      getManagedVoiceRuntimeStatus(this.deps.storage.systemSettings),
      this.getVoiceStatus(),
    ]);
    const failure = buildVoiceControlStartFailure({
      action: "wake",
      now,
      runtime,
      status: voiceStatus,
    });
    if (failure) {
      this.deps.storage.systemSettings.set(VOICE_STATUS_SETTING_KEY, failure.stt);
      if (failure.wake) {
        this.deps.storage.systemSettings.set(VOICE_WAKE_STATUS_SETTING_KEY, failure.wake);
      }
      throw new Error(failure.message);
    }
    const status: VoiceStatus["wake"] = {
      enabled: true,
      state: "running",
      model: "openwakeword",
      updatedAt: now,
    };
    this.deps.storage.systemSettings.set(VOICE_WAKE_STATUS_SETTING_KEY, status);
    this.deps.storage.systemSettings.set(VOICE_STATUS_SETTING_KEY, {
      ...voiceStatus.stt,
      state: "stopped",
      provider: runtime.provider,
      modelId: runtime.selectedModelId,
      runtimeReady: runtime.readiness === "ready",
      lastError: undefined,
      updatedAt: now,
    });
    this.deps.publishRealtime("system", "voice", {
      type: "voice_wake_started",
    });
    return status;
  }

  public stopVoiceWake(): VoiceStatus["wake"] {
    const status: VoiceStatus["wake"] = {
      enabled: false,
      state: "stopped",
      model: "openwakeword",
      updatedAt: new Date().toISOString(),
    };
    this.deps.storage.systemSettings.set(VOICE_WAKE_STATUS_SETTING_KEY, status);
    this.deps.publishRealtime("system", "voice", {
      type: "voice_wake_stopped",
    });
    return status;
  }

  // ── Google Meet realtime voice ──────────────────────────────────────────

  public listGoogleMeetSessions(limit = 20): GoogleMeetSessionRecord[] {
    return this.readGoogleMeetSessions()
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, Math.max(1, Math.min(100, Math.trunc(limit) || 20)));
  }

  public getGoogleMeetPrerequisiteStatus(
    input: GoogleMeetPrerequisiteStatusRequest = {},
  ): GoogleMeetPrerequisiteStatusResponse {
    const provider = input.provider ?? "openai-realtime";
    const prerequisites = this.resolveGoogleMeetPrerequisites({
      meetingUrl: input.meetingUrl ?? "https://meet.google.com/placeholder",
      displayName: input.displayName,
      accountRef: input.accountRef,
      provider,
      userStartConfirmed: input.userStartConfirmed,
    });
    const blocked = prerequisites.find((item) => !item.ready);
    return {
      ready: !blocked,
      state: blocked ? "blocked" : "ready",
      provider,
      checkedAt: new Date().toISOString(),
      failureReason: blocked?.message,
      authProfile: {
        accountRef: input.accountRef?.trim() || undefined,
        available: Boolean(input.accountRef?.trim()),
        source: input.accountRef?.trim() ? "oauth_thread" : "missing",
      },
      prerequisites,
    };
  }

  public startGoogleMeetSession(input: GoogleMeetSessionStartRequest): GoogleMeetSessionRecord {
    const now = new Date().toISOString();
    const prerequisites = this.resolveGoogleMeetPrerequisites(input);
    const blocked = prerequisites.find((item) => !item.ready);
    const record: GoogleMeetSessionRecord = {
      sessionId: randomUUID(),
      meetingUrl: input.meetingUrl.trim(),
      displayName: input.displayName?.trim() || undefined,
      accountRef: input.accountRef?.trim() || undefined,
      state: blocked ? "blocked" : "running",
      provider: input.provider ?? "openai-realtime",
      createdAt: now,
      updatedAt: now,
      startedAt: blocked ? undefined : now,
      failureReason: blocked?.message,
      prerequisites,
      transcript: [],
    };
    this.writeGoogleMeetSession(record);
    this.recordGoogleMeetDiagnostic(record, blocked ? "blocked" : "started", blocked?.message);
    this.deps.publishRealtime("system", "voice", {
      type: "google_meet_session_started",
      sessionId: record.sessionId,
      state: record.state,
      failureReason: record.failureReason,
    });
    return record;
  }

  public appendGoogleMeetTranscriptChunk(
    sessionId: string,
    input: Pick<GoogleMeetTranscriptChunk, "text" | "speaker" | "final" | "provider">,
  ): GoogleMeetSessionRecord {
    const record = this.requireGoogleMeetSession(sessionId);
    if (record.state !== "running" && record.state !== "consulting") {
      throw new Error(`Google Meet session ${sessionId} is ${record.state} and cannot accept transcript chunks.`);
    }
    const chunk: GoogleMeetTranscriptChunk = {
      chunkId: randomUUID(),
      sessionId,
      timestamp: new Date().toISOString(),
      speaker: input.speaker,
      text: input.text,
      final: input.final,
      provider: input.provider,
    };
    const updated = this.writeGoogleMeetSession({
      ...record,
      updatedAt: chunk.timestamp,
      transcript: [...record.transcript, chunk],
    });
    this.deps.publishRealtime("system", "voice", {
      type: "google_meet_transcript_chunk",
      sessionId,
      chunk,
    });
    this.recordGoogleMeetDiagnostic(updated, "running", "Google Meet transcript chunk appended");
    return updated;
  }

  public createGoogleMeetConsultHandoff(
    sessionId: string,
    input: { target?: GoogleMeetConsultHandoff["target"]; prompt?: string },
  ): GoogleMeetSessionRecord {
    const record = this.requireGoogleMeetSession(sessionId);
    const now = new Date().toISOString();
    const handoff: GoogleMeetConsultHandoff = {
      handoffId: randomUUID(),
      sessionId,
      createdAt: now,
      target: input.target ?? "cowork",
      prompt: input.prompt?.trim() || "Review this meeting transcript and suggest the next operator action.",
      transcriptChunkIds: record.transcript.map((chunk) => chunk.chunkId),
    };
    const updated = this.writeGoogleMeetSession({
      ...record,
      state: "consulting",
      updatedAt: now,
      consultHandoff: handoff,
    });
    this.deps.publishRealtime("system", "voice", {
      type: "google_meet_consult_handoff",
      sessionId,
      handoff,
    });
    this.recordGoogleMeetDiagnostic(updated, "running", "Google Meet consult handoff created");
    return updated;
  }

  public stopGoogleMeetSession(sessionId: string): GoogleMeetSessionRecord {
    const record = this.requireGoogleMeetSession(sessionId);
    const now = new Date().toISOString();
    const cleanup: GoogleMeetCleanupResult = {
      sessionId,
      cleanedAt: now,
      stoppedTransport: record.state === "running" || record.state === "consulting",
      releasedAudio: record.state === "running" || record.state === "consulting",
    };
    const updated = this.writeGoogleMeetSession({
      ...record,
      state: "stopped",
      updatedAt: now,
      stoppedAt: now,
      cleanup,
    });
    this.deps.publishRealtime("system", "voice", {
      type: "google_meet_session_stopped",
      sessionId,
      cleanup,
    });
    this.recordGoogleMeetDiagnostic(updated, "completed", "Google Meet voice session stopped");
    return updated;
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  private resolveGoogleMeetPrerequisites(
    input: GoogleMeetSessionStartRequest,
  ): GoogleMeetSessionRecord["prerequisites"] {
    const provider = input.provider ?? "openai-realtime";
    return [
      {
        id: "oauth_profile",
        ready: Boolean(input.accountRef?.trim()),
        message: input.accountRef?.trim()
          ? "OAuth profile reference is selected."
          : "Google Meet OAuth profile is required before joining.",
      },
      {
        id: "provider_key",
        ready: provider === "local-transcription" || Boolean(process.env.OPENAI_API_KEY?.trim()),
        message:
          provider === "local-transcription" || process.env.OPENAI_API_KEY?.trim()
            ? "Realtime provider prerequisite is available."
            : "OpenAI Realtime requires OPENAI_API_KEY before meeting voice can start.",
      },
      {
        id: "browser_transport",
        ready: process.env.GOATCITADEL_MEET_BROWSER_TRANSPORT === "ready",
        message: "Browser transport must report ready before Google Meet join is enabled.",
      },
      {
        id: "audio_transport",
        ready: process.env.GOATCITADEL_MEET_AUDIO_TRANSPORT === "ready",
        message: "Audio capture transport must report ready before Google Meet join is enabled.",
      },
      {
        id: "user_start",
        ready: input.userStartConfirmed === true,
        message: "The operator must explicitly start the meeting session.",
      },
    ];
  }

  private readGoogleMeetSessions(): GoogleMeetSessionRecord[] {
    return (
      this.deps.storage.systemSettings.get<GoogleMeetSessionRecord[]>(GOOGLE_MEET_SESSIONS_SETTING_KEY)?.value ?? []
    );
  }

  private writeGoogleMeetSession(record: GoogleMeetSessionRecord): GoogleMeetSessionRecord {
    const sessions = this.readGoogleMeetSessions();
    const next = [record, ...sessions.filter((item) => item.sessionId !== record.sessionId)].slice(0, 100);
    this.deps.storage.systemSettings.set(GOOGLE_MEET_SESSIONS_SETTING_KEY, next);
    return record;
  }

  private requireGoogleMeetSession(sessionId: string): GoogleMeetSessionRecord {
    const record = this.readGoogleMeetSessions().find((item) => item.sessionId === sessionId);
    if (!record) {
      throw new Error(`Unknown Google Meet session: ${sessionId}`);
    }
    return record;
  }

  private recordGoogleMeetDiagnostic(
    record: GoogleMeetSessionRecord,
    status: "started" | "running" | "completed" | "blocked",
    message?: string,
  ): void {
    this.deps.recordDevDiagnostic({
      level: status === "blocked" ? "warn" : "info",
      category: "meet",
      event: "meet.session",
      message: message ?? "Google Meet voice session updated",
      meetingSessionId: record.sessionId,
      runtimeKind: "meet.session",
      runtimeStatus: status,
      context: {
        state: record.state,
        provider: record.provider,
        failureReason: record.failureReason,
      },
    });
  }

  private pruneMediaPlaybackTokens(now = Date.now()): void {
    for (const [token, record] of this.mediaPlaybackTokens.entries()) {
      if (record.expiresAtMs <= now) {
        this.mediaPlaybackTokens.delete(token);
      }
    }
  }

  private enforceMediaPlaybackTokenCapacity(): void {
    while (this.mediaPlaybackTokens.size > MEDIA_PLAYBACK_TOKEN_MAX_RECORDS) {
      const oldestToken = this.mediaPlaybackTokens.keys().next().value;
      if (typeof oldestToken !== "string") {
        return;
      }
      this.mediaPlaybackTokens.delete(oldestToken);
    }
  }

  private buildAttachmentPlaybackMetadata(
    record: ChatAttachmentRecord,
    mediaType: ChatAttachmentMediaType,
  ): ChatAttachmentPlaybackMetadata | undefined {
    if (mediaType !== "audio" && mediaType !== "video") {
      return undefined;
    }
    const artifacts = this.listMediaArtifactsForAttachment(record.attachmentId);
    const thumbnailArtifact = artifacts.find((artifact) => artifact.kind === "thumbnail");
    const videoVariantArtifacts = artifacts.filter((artifact) => artifact.kind === "video_variant");
    return {
      variants: [
        {
          variantId: "original",
          label: "Original upload",
          source: {
            kind: "chat_attachment",
            attachmentId: record.attachmentId,
          },
          mimeType: record.mimeType,
          sizeBytes: record.sizeBytes,
          status: "available",
        },
        ...videoVariantArtifacts.flatMap((artifact) => {
          const variantId = parseVideoVariantId(artifact.text_preview);
          if (!variantId) {
            return [];
          }
          return [
            {
              variantId,
              label: variantId === "standard" ? "Standard" : "Data saver",
              source: {
                kind: "media_artifact" as const,
                artifactId: artifact.artifact_id,
              },
              mimeType: artifact.mime_type ?? "video/mp4",
              sizeBytes: artifact.size_bytes ?? undefined,
              status: "available" as const,
            },
          ];
        }),
      ],
      poster:
        thumbnailArtifact || record.thumbnailRelPath
          ? {
              source: thumbnailArtifact
                ? {
                    kind: "media_artifact" as const,
                    artifactId: thumbnailArtifact.artifact_id,
                  }
                : undefined,
              thumbnailRelPath: thumbnailArtifact?.storage_rel_path ?? record.thumbnailRelPath,
              mimeType: thumbnailArtifact?.mime_type ?? undefined,
              sizeBytes: thumbnailArtifact?.size_bytes ?? undefined,
              status: "available",
            }
          : undefined,
    };
  }

  private listMediaArtifactsForAttachment(attachmentId: string): MediaArtifactRow[] {
    try {
      const statement = this.deps.gatewaySql.prepare(
        `
      SELECT * FROM media_artifacts
      WHERE attachment_id = ?
      ORDER BY created_at DESC
      LIMIT 20
    `,
      );
      if (typeof statement.all !== "function") {
        return [];
      }
      return toMediaArtifactRows(statement.all(attachmentId));
    } catch {
      return [];
    }
  }

  private getMediaArtifactRow(artifactId: string): MediaArtifactRow {
    const candidate = this.deps.gatewaySql
      .prepare(
        `
      SELECT * FROM media_artifacts
      WHERE artifact_id = ?
    `,
      )
      .get(artifactId);
    if (!isMediaArtifactRow(candidate)) {
      throw new Error(`Unknown media artifact: ${artifactId}`);
    }
    return candidate;
  }

  private processMediaJob(jobId: string): void {
    if (typeof jobId !== "string" || !jobId.trim()) {
      return;
    }
    if (this.deps.isClosing()) {
      return;
    }
    const task = this.runMediaJob(jobId)
      .catch((error) => {
        const now = new Date().toISOString();
        const errorMessage =
          error instanceof Error ? error.message : typeof error === "string" ? error : JSON.stringify(error);
        this.deps.gatewaySql
          .prepare(
            `
          UPDATE media_jobs
          SET status = 'failed', error = @error, updated_at = @updatedAt, completed_at = @completedAt
          WHERE job_id = @jobId
        `,
          )
          .run({
            error: errorMessage,
            updatedAt: now,
            completedAt: now,
            jobId,
          });
      })
      .finally(() => {
        this.deps.backgroundTasks.delete(task);
      });
    this.deps.backgroundTasks.add(task);
    void task;
  }

  private async runMediaJob(jobId: string): Promise<void> {
    if (typeof jobId !== "string" || !jobId.trim()) {
      return;
    }
    const now = new Date().toISOString();
    this.deps.gatewaySql
      .prepare(
        `
      UPDATE media_jobs
      SET status = 'running', updated_at = @updatedAt
      WHERE job_id = @jobId
    `,
      )
      .run({
        updatedAt: now,
        jobId,
      });
    const job = this.getMediaJob(jobId);
    const attachmentId = job.attachmentId;
    if (!attachmentId) {
      this.deps.gatewaySql
        .prepare(
          `
        UPDATE media_jobs
        SET status = 'ready', output_json = @outputJson, updated_at = @updatedAt, completed_at = @completedAt
        WHERE job_id = @jobId
      `,
        )
        .run({
          outputJson: JSON.stringify({ message: "No attachment supplied." }),
          updatedAt: now,
          completedAt: now,
          jobId,
        });
      return;
    }

    const attachment = this.deps.storage.chatAttachments.get(attachmentId);
    if (job.type === "video_derivatives") {
      await this.runVideoDerivativeJob(job.jobId, attachment);
      return;
    }

    if (job.type === "audio_transcribe" || job.type === "video_transcribe") {
      const content = await this.deps.readChatAttachmentContent(attachmentId);
      const transcript = await this.transcribeAudioBytes(content.bytes, content.record.mimeType);
      const completedAt = new Date().toISOString();
      this.deps.gatewaySql
        .prepare(
          `
        UPDATE media_jobs
        SET status = 'ready', output_json = @outputJson, updated_at = @updatedAt, completed_at = @completedAt
        WHERE job_id = @jobId
      `,
        )
        .run({
          outputJson: JSON.stringify({ transcriptText: transcript.text, provider: transcript.provider }),
          updatedAt: completedAt,
          completedAt,
          jobId,
        });
      this.deps.gatewaySql
        .prepare(
          `
        UPDATE chat_attachments
        SET transcript_text = @transcriptText, analysis_status = 'ready'
        WHERE attachment_id = @attachmentId
      `,
        )
        .run({
          transcriptText: transcript.text,
          attachmentId,
        });
      return;
    }

    if (job.type === "ocr" && attachment.mediaType === "image") {
      const completedAt = new Date().toISOString();
      this.deps.gatewaySql
        .prepare(
          `
        UPDATE media_jobs
        SET status = 'unsupported', output_json = @outputJson, updated_at = @updatedAt, completed_at = @completedAt
        WHERE job_id = @jobId
      `,
        )
        .run({
          outputJson: JSON.stringify({
            message: "OCR worker is not installed. Configure sidecar OCR in a follow-up step.",
          }),
          updatedAt: completedAt,
          completedAt,
          jobId,
        });
      this.deps.gatewaySql
        .prepare(
          `
        UPDATE chat_attachments
        SET analysis_status = 'unsupported'
        WHERE attachment_id = @attachmentId
      `,
        )
        .run({
          attachmentId,
        });
      return;
    }

    const completedAt = new Date().toISOString();
    this.deps.gatewaySql
      .prepare(
        `
      UPDATE media_jobs
      SET status = 'ready', output_json = @outputJson, updated_at = @updatedAt, completed_at = @completedAt
      WHERE job_id = @jobId
    `,
      )
      .run({
        outputJson: JSON.stringify({
          mediaType: attachment.mediaType ?? detectAttachmentMediaType(attachment.mimeType),
          extractPreview: attachment.extractPreview,
        }),
        updatedAt: completedAt,
        completedAt,
        jobId,
      });
    this.deps.gatewaySql
      .prepare(
        `
      UPDATE chat_attachments
      SET ocr_text = COALESCE(ocr_text, @ocrText), analysis_status = 'ready'
      WHERE attachment_id = @attachmentId
    `,
      )
      .run({
        ocrText: attachment.extractPreview ?? null,
        attachmentId,
      });
  }

  private async runVideoDerivativeJob(jobId: string, attachment: ChatAttachmentRecord): Promise<void> {
    const mediaType = attachment.mediaType ?? detectAttachmentMediaType(attachment.mimeType);
    if (mediaType !== "video") {
      this.markMediaJobUnsupported(jobId, {
        message: `Video derivatives require a video attachment, got ${mediaType}.`,
      });
      return;
    }
    const runtime = await getManagedVoiceRuntimeStatus(this.deps.storage.systemSettings);
    const ffmpegPath = process.env.GOATCITADEL_FFMPEG_BIN?.trim() || runtime.ffmpegPath;
    if (!ffmpegPath) {
      this.markMediaJobUnsupported(jobId, {
        message: "ffmpeg is not configured; original video playback remains available.",
      });
      return;
    }
    const content = await this.deps.readChatAttachmentContent(attachment.attachmentId);
    const outputDir = path.dirname(content.fullPath);
    const relDir = path.posix.dirname(attachment.storageRelPath);
    const baseName = attachment.attachmentId;
    const posterPath = path.join(outputDir, `${baseName}-poster.jpg`);
    const standardPath = path.join(outputDir, `${baseName}-standard.mp4`);
    const dataSaverPath = path.join(outputDir, `${baseName}-data-saver.mp4`);

    await transcodeVideoDerivative({
      ffmpegPath,
      inputPath: content.fullPath,
      outputPath: posterPath,
      kind: "poster",
    });
    await transcodeVideoDerivative({
      ffmpegPath,
      inputPath: content.fullPath,
      outputPath: standardPath,
      kind: "standard",
    });
    await transcodeVideoDerivative({
      ffmpegPath,
      inputPath: content.fullPath,
      outputPath: dataSaverPath,
      kind: "data_saver",
    });

    const posterStat = await fs.stat(posterPath);
    const standardStat = await fs.stat(standardPath);
    const dataSaverStat = await fs.stat(dataSaverPath);
    const posterArtifactId = this.insertMediaArtifact({
      jobId,
      attachmentId: attachment.attachmentId,
      kind: "thumbnail",
      storageRelPath: path.posix.join(relDir, path.basename(posterPath)),
      mimeType: "image/jpeg",
      sizeBytes: posterStat.size,
    });
    const standardArtifactId = this.insertMediaArtifact({
      jobId,
      attachmentId: attachment.attachmentId,
      kind: "video_variant",
      storageRelPath: path.posix.join(relDir, path.basename(standardPath)),
      mimeType: "video/mp4",
      sizeBytes: standardStat.size,
      textPreview: "standard",
    });
    const dataSaverArtifactId = this.insertMediaArtifact({
      jobId,
      attachmentId: attachment.attachmentId,
      kind: "video_variant",
      storageRelPath: path.posix.join(relDir, path.basename(dataSaverPath)),
      mimeType: "video/mp4",
      sizeBytes: dataSaverStat.size,
      textPreview: "data_saver",
    });
    const completedAt = new Date().toISOString();
    this.deps.gatewaySql
      .prepare(
        `
      UPDATE media_jobs
      SET status = 'ready', output_json = @outputJson, updated_at = @updatedAt, completed_at = @completedAt
      WHERE job_id = @jobId
    `,
      )
      .run({
        outputJson: JSON.stringify({
          posterArtifactId,
          variants: [
            { variantId: "standard", artifactId: standardArtifactId },
            { variantId: "data_saver", artifactId: dataSaverArtifactId },
          ],
        }),
        updatedAt: completedAt,
        completedAt,
        jobId,
      });
  }

  private markMediaJobUnsupported(jobId: string, output: Record<string, unknown>): void {
    const completedAt = new Date().toISOString();
    this.deps.gatewaySql
      .prepare(
        `
      UPDATE media_jobs
      SET status = 'unsupported', output_json = @outputJson, updated_at = @updatedAt, completed_at = @completedAt
      WHERE job_id = @jobId
    `,
      )
      .run({
        outputJson: JSON.stringify(output),
        updatedAt: completedAt,
        completedAt,
        jobId,
      });
  }

  private insertMediaArtifact(input: {
    jobId: string;
    attachmentId: string;
    kind: MediaArtifactRow["kind"];
    storageRelPath: string;
    mimeType: string;
    sizeBytes: number;
    textPreview?: string;
  }): string {
    const artifactId = randomUUID();
    this.deps.gatewaySql
      .prepare(
        `
      INSERT INTO media_artifacts (
        artifact_id, job_id, attachment_id, kind, storage_rel_path, text_preview, mime_type, size_bytes, created_at
      ) VALUES (
        @artifactId, @jobId, @attachmentId, @kind, @storageRelPath, @textPreview, @mimeType, @sizeBytes, @createdAt
      )
    `,
      )
      .run({
        artifactId,
        jobId: input.jobId,
        attachmentId: input.attachmentId,
        kind: input.kind,
        storageRelPath: input.storageRelPath,
        textPreview: input.textPreview ?? null,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        createdAt: new Date().toISOString(),
      });
    return artifactId;
  }

  private async transcribeAudioBytes(
    bytes: Buffer,
    mimeType?: string,
    language?: string,
  ): Promise<VoiceTranscribeResponse> {
    const started = Date.now();
    const runtime = await getManagedVoiceRuntimeStatus(this.deps.storage.systemSettings);
    const binPath = process.env.GOATCITADEL_WHISPER_CPP_BIN?.trim() || runtime.binaryPath;
    const modelPath = process.env.GOATCITADEL_WHISPER_CPP_MODEL_PATH?.trim() || runtime.selectedModelPath;
    const ffmpegPath = process.env.GOATCITADEL_FFMPEG_BIN?.trim() || runtime.ffmpegPath;
    const extraArgs = parseVoiceCliArgs(process.env.GOATCITADEL_WHISPER_CPP_ARGS);
    if (!binPath) {
      const now = new Date().toISOString();
      this.deps.storage.systemSettings.set(VOICE_STATUS_SETTING_KEY, {
        state: "error",
        provider: DEFAULT_VOICE_PROVIDER,
        modelId: runtime.selectedModelId,
        runtimeReady: false,
        lastError: "No whisper.cpp runtime is configured.",
        updatedAt: now,
      });
      throw new Error(
        "Local STT is not configured. Install the managed voice runtime or set GOATCITADEL_WHISPER_CPP_BIN.",
      );
    }

    const tempBase = path.join(os.tmpdir(), `goatcitadel-whisper-${randomUUID()}`);
    const ext = extFromMimeType(mimeType);
    const inputPath = `${tempBase}${ext}`;
    const normalizedInputPath = `${tempBase}-normalized.wav`;
    const outputBase = `${tempBase}-out`;
    const outputPath = `${outputBase}.txt`;

    this.deps.storage.systemSettings.set(VOICE_STATUS_SETTING_KEY, {
      state: "running",
      provider: DEFAULT_VOICE_PROVIDER,
      modelId: runtime.selectedModelId,
      runtimeReady: Boolean(binPath && (modelPath || process.env.GOATCITADEL_WHISPER_CPP_BIN?.trim())),
      updatedAt: new Date().toISOString(),
    });

    try {
      await fs.writeFile(inputPath, bytes);
      const whisperInputPath = await normalizeAudioForWhisper({
        inputPath,
        outputPath: normalizedInputPath,
        mimeType,
        ffmpegPath,
      });
      const args = [...extraArgs];
      if (modelPath) {
        args.push("-m", modelPath);
      }
      args.push("-f", whisperInputPath, "-otxt", "-of", outputBase);
      if (language?.trim()) {
        args.push("-l", language.trim());
      }
      await execFileAsync(binPath, args, {
        timeout: WHISPER_TRANSCRIBE_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: EXTERNAL_PROCESS_MAX_BUFFER_BYTES,
      });
      const text = (await fs.readFile(outputPath, "utf8")).trim();
      const now = new Date().toISOString();
      this.deps.storage.systemSettings.set(VOICE_STATUS_SETTING_KEY, {
        state: "stopped",
        provider: DEFAULT_VOICE_PROVIDER,
        modelId: runtime.selectedModelId,
        runtimeReady: true,
        updatedAt: now,
      });
      return {
        text,
        language: language?.trim() || undefined,
        provider: DEFAULT_VOICE_PROVIDER,
        durationMs: Date.now() - started,
      };
    } catch (error) {
      const now = new Date().toISOString();
      const detail = isProcessTimeoutError(error)
        ? `Transcription timed out after ${WHISPER_TRANSCRIBE_TIMEOUT_MS}ms and was terminated.`
        : (error as Error).message;
      this.deps.storage.systemSettings.set(VOICE_STATUS_SETTING_KEY, {
        state: "error",
        provider: DEFAULT_VOICE_PROVIDER,
        modelId: runtime.selectedModelId,
        runtimeReady: false,
        lastError: detail,
        updatedAt: now,
      });
      throw new Error(`Local STT failed: ${detail}`, { cause: error });
    } finally {
      await Promise.allSettled([
        fs.rm(inputPath, { force: true }),
        fs.rm(normalizedInputPath, { force: true }),
        fs.rm(outputPath, { force: true }),
      ]);
    }
  }
}
