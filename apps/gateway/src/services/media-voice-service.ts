import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type {
  ChatAttachmentMediaType,
  ChatAttachmentPreviewResponse,
  ChatAttachmentRecord,
  MediaCreateJobRequest,
  MediaJobRecord,
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
const DEFAULT_VOICE_PROVIDER: VoiceTranscribeResponse["provider"] = "whisper.cpp";

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

interface DevDiagnosticInput {
  level: "debug" | "info" | "warn" | "error";
  category: string;
  event: string;
  message: string;
  context?: Record<string, unknown>;
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
  execFileSync(
    input.ffmpegPath,
    ["-y", "-i", input.inputPath, "-ac", "1", "-ar", "16000", "-f", "wav", input.outputPath],
    { stdio: "pipe" },
  );
  return input.outputPath;
}

// ---------------------------------------------------------------------------
// MediaVoiceService
// ---------------------------------------------------------------------------

export class MediaVoiceService {
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
      this.deps.gatewaySql
        .prepare(
          sessionId
            ? `
      SELECT * FROM media_jobs
      WHERE session_id = @sessionId
      ORDER BY created_at DESC
      LIMIT 500
    `
            : `
      SELECT * FROM media_jobs
      ORDER BY created_at DESC
      LIMIT 500
    `,
        )
        .all({
          sessionId,
        }),
    );
    return rows.map(mapMediaJobRow);
  }

  public getChatAttachmentPreview(attachmentId: string): ChatAttachmentPreviewResponse {
    const record = this.deps.getChatAttachment(attachmentId);
    return {
      attachmentId: record.attachmentId,
      fileName: record.fileName,
      mimeType: record.mimeType,
      mediaType: record.mediaType ?? detectAttachmentMediaType(record.mimeType),
      thumbnailRelPath: record.thumbnailRelPath,
      extractPreview: record.extractPreview,
      ocrText: record.ocrText,
      transcriptText: record.transcriptText,
      analysisStatus: record.analysisStatus === "pending" ? "queued" : (record.analysisStatus ?? "queued"),
    };
  }

  // ── Voice transcription ─────────────────────────────────────────────────

  public async transcribeVoice(input: {
    bytesBase64: string;
    mimeType?: string;
    language?: string;
  }): Promise<VoiceTranscribeResponse> {
    const bytes = Buffer.from(input.bytesBase64, "base64");
    if (bytes.length === 0) {
      throw new Error("Audio payload is empty.");
    }
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

  // ── Private helpers ─────────────────────────────────────────────────────

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
      execFileSync(binPath, args, { stdio: "pipe" });
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
      this.deps.storage.systemSettings.set(VOICE_STATUS_SETTING_KEY, {
        state: "error",
        provider: DEFAULT_VOICE_PROVIDER,
        modelId: runtime.selectedModelId,
        runtimeReady: false,
        lastError: (error as Error).message,
        updatedAt: now,
      });
      throw new Error(`Local STT failed: ${(error as Error).message}`, { cause: error });
    } finally {
      await Promise.allSettled([
        fs.rm(inputPath, { force: true }),
        fs.rm(normalizedInputPath, { force: true }),
        fs.rm(outputPath, { force: true }),
      ]);
    }
  }
}
