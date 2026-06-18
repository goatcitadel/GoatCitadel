import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { VoiceTalkSessionRecord } from "@goatcitadel/contracts";
import { MediaVoiceService, __mediaVoiceServiceInternals } from "./media-voice-service.js";

describe("MediaVoiceService", () => {
  it("normalizes media helper inputs and maps durable media job rows", async () => {
    const row = {
      job_id: "job-1",
      session_id: "session-1",
      attachment_id: "attachment-1",
      job_type: "audio_transcribe",
      status: "ready",
      input_json: '{"language":"en"}',
      output_json: "{not-json",
      error: null,
      created_at: "2026-05-14T20:00:00.000Z",
      updated_at: "2026-05-14T20:01:00.000Z",
      completed_at: "2026-05-14T20:01:00.000Z",
    };

    expect(__mediaVoiceServiceInternals.isRecord(row)).toBe(true);
    expect(__mediaVoiceServiceInternals.isRecord([])).toBe(false);
    expect(__mediaVoiceServiceInternals.isMediaJobRow(row)).toBe(true);
    expect(__mediaVoiceServiceInternals.isMediaJobRow({ ...row, job_id: 1 })).toBe(false);
    expect(__mediaVoiceServiceInternals.toMediaJobRows([row, { bad: true }])).toEqual([row]);
    expect(__mediaVoiceServiceInternals.toMediaJobRows({ not: "rows" })).toEqual([]);
    expect(__mediaVoiceServiceInternals.mapMediaJobRow(row)).toMatchObject({
      jobId: "job-1",
      sessionId: "session-1",
      attachmentId: "attachment-1",
      type: "audio_transcribe",
      status: "ready",
      inputJson: { language: "en" },
      outputJson: {},
      completedAt: "2026-05-14T20:01:00.000Z",
    });
    expect(__mediaVoiceServiceInternals.safeJsonParse("{bad", { fallback: true })).toEqual({ fallback: true });
    expect(__mediaVoiceServiceInternals.parseVoiceCliArgs("  --threads 4   --no-gpu  ")).toEqual([
      "--threads",
      "4",
      "--no-gpu",
    ]);
    expect(__mediaVoiceServiceInternals.parseVoiceCliArgs("   ")).toEqual([]);
    expect(() => __mediaVoiceServiceInternals.decodeStrictBase64("not valid base64!")).toThrow(
      "outside the base64 alphabet",
    );
    expect(__mediaVoiceServiceInternals.validateVoiceTranscriptionPayload(wavBytes(), "audio/wav")).toBeUndefined();
    expect(() =>
      __mediaVoiceServiceInternals.validateVoiceTranscriptionPayload(Buffer.from("not-audio"), "audio/wav"),
    ).toThrow("sniffed text");
    expect(__mediaVoiceServiceInternals.extFromMimeType("audio/wav")).toBe(".wav");
    expect(__mediaVoiceServiceInternals.extFromMimeType("audio/mpeg")).toBe(".mp3");
    expect(__mediaVoiceServiceInternals.extFromMimeType("audio/ogg")).toBe(".ogg");
    expect(__mediaVoiceServiceInternals.extFromMimeType("video/mp4")).toBe(".mp4");
    expect(__mediaVoiceServiceInternals.extFromMimeType("video/webm")).toBe(".webm");
    expect(__mediaVoiceServiceInternals.extFromMimeType("application/octet-stream")).toBe(".bin");
    await expect(
      __mediaVoiceServiceInternals.normalizeAudioForWhisper({
        inputPath: "recording.wav",
        outputPath: "recording-normalized.wav",
        mimeType: "audio/wav",
      }),
    ).resolves.toBe("recording.wav");
    await expect(
      __mediaVoiceServiceInternals.normalizeAudioForWhisper({
        inputPath: "recording.mp3",
        outputPath: "recording-normalized.wav",
        mimeType: "audio/mpeg",
      }),
    ).rejects.toThrow("Audio normalization helper is not configured");
  });

  it("creates previews and reports missing media jobs without starting background work when closing", () => {
    const getChatAttachment = vi.fn(() => ({
      attachmentId: "attachment-1",
      fileName: "capture.bin",
      mimeType: "application/json",
      analysisStatus: "pending",
      extractPreview: '{"ok":true}',
    }));
    const service = new MediaVoiceService(
      createDeps({
        getChatAttachment,
        gatewaySql: {
          prepare: vi.fn(() => ({
            get: vi.fn(() => undefined),
            run: vi.fn(),
          })),
        } as never,
        isClosing: () => true,
      }),
    );

    expect(service.getChatAttachmentPreview("attachment-1")).toMatchObject({
      attachmentId: "attachment-1",
      mediaType: "text",
      analysisStatus: "queued",
    });
    expect(() => service.getMediaJob("missing")).toThrow("Unknown media job: missing");
  });

  it("issues short-lived playback tokens only for streamable chat attachments", () => {
    const getChatAttachment = vi.fn((attachmentId: string) => ({
      attachmentId,
      sessionId: "session-1",
      fileName: attachmentId === "audio-1" ? "voice.mp3" : "notes.txt",
      mimeType: attachmentId === "audio-1" ? "audio/mpeg" : "text/plain",
      mediaType: attachmentId === "audio-1" ? "audio" : "text",
      sizeBytes: 1024,
      sha256: "hash",
      storageRelPath: "chat/default/attachments/file",
      extractStatus: "ready",
      createdAt: "2026-06-18T00:00:00.000Z",
    }));
    const service = new MediaVoiceService(createDeps({ getChatAttachment }));

    const issued = service.issueMediaPlaybackToken({
      source: { kind: "chat_attachment", attachmentId: "audio-1" },
    });

    expect(issued).toMatchObject({
      source: { kind: "chat_attachment", attachmentId: "audio-1" },
      variantId: "original",
    });
    expect(issued.contentPath).toContain("/api/v1/chat/attachments/audio-1/content");
    expect(issued.contentPath).toContain("media_token=");
    expect(
      service.validateMediaPlaybackToken({
        token: issued.token,
        source: { kind: "chat_attachment", attachmentId: "audio-1" },
      }),
    ).toBe(true);
    expect(
      service.validateMediaPlaybackToken({
        token: issued.token,
        source: { kind: "chat_attachment", attachmentId: "other-attachment" },
      }),
    ).toBe(false);
    expect(() =>
      service.issueMediaPlaybackToken({
        source: { kind: "chat_attachment", attachmentId: "text-1" },
      }),
    ).toThrow(/cannot be streamed as media/i);
    expect(() =>
      service.issueMediaPlaybackToken({
        source: { kind: "media_artifact", artifactId: "artifact-1" },
      }),
    ).toThrow(/not available yet/i);
  });

  it("lists media jobs without binding unused parameters when no session filter is provided", () => {
    const all = vi.fn(() => []);
    const prepare = vi.fn((_sql: string) => ({
      all,
    }));

    const service = new MediaVoiceService({
      gatewaySql: { prepare } as never,
      storage: {
        systemSettings: {} as never,
        chatAttachments: {
          get: vi.fn(),
        },
      },
      backgroundTasks: new Set(),
      isClosing: () => false,
      publishRealtime: vi.fn(),
      recordDevDiagnostic: vi.fn(),
      readChatAttachmentContent: vi.fn(),
      getChatAttachment: vi.fn(),
    });

    expect(service.listMediaJobs()).toEqual([]);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare.mock.calls[0]?.[0]).toContain("FROM media_jobs");
    expect(prepare.mock.calls[0]?.[0]).not.toContain("@sessionId");
    expect(all).toHaveBeenCalledWith();
  });

  it("lists talk sessions without relying on SQLite-only rowid ordering", () => {
    const expected: VoiceTalkSessionRecord = {
      talkSessionId: "talk-1",
      mode: "push_to_talk",
      state: "stopped",
      createdAt: "2026-04-22T13:00:00.000Z",
      startedAt: "2026-04-22T13:00:00.000Z",
      stoppedAt: "2026-04-22T13:01:00.000Z",
    };
    const all = vi.fn(() => [{ payload_json: JSON.stringify(expected) }]);
    const prepare = vi.fn((_sql: string) => ({
      all,
    }));

    const service = new MediaVoiceService({
      gatewaySql: { prepare } as never,
      storage: {
        systemSettings: {} as never,
        chatAttachments: {
          get: vi.fn(),
        },
      },
      backgroundTasks: new Set(),
      isClosing: () => false,
      publishRealtime: vi.fn(),
      recordDevDiagnostic: vi.fn(),
      readChatAttachmentContent: vi.fn(),
      getChatAttachment: vi.fn(),
    });

    expect(service.listVoiceTalkSessions(8)).toEqual([expected]);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare.mock.calls[0]?.[0]).toContain("voice_session_id DESC");
    expect(prepare.mock.calls[0]?.[0]).not.toContain("rowid");
    expect(all).toHaveBeenCalledWith(8);
  });

  it("creates queued media jobs and completes no-attachment jobs in the background queue", async () => {
    const jobs = new Map<string, Record<string, unknown>>();
    const run = vi.fn((params: Record<string, unknown>) => {
      if ("jobType" in params) {
        jobs.set(String(params.jobId), {
          job_id: params.jobId,
          session_id: params.sessionId,
          attachment_id: params.attachmentId,
          job_type: params.jobType,
          status: params.status,
          input_json: params.inputJson,
          output_json: null,
          error: null,
          created_at: params.createdAt,
          updated_at: params.updatedAt,
          completed_at: null,
        });
        return;
      }
      const row = jobs.get(String(params.jobId));
      if (!row) {
        return;
      }
      if (String(params.outputJson ?? "").includes("No attachment supplied")) {
        row.status = "ready";
        row.output_json = params.outputJson;
        row.updated_at = params.updatedAt;
        row.completed_at = params.completedAt;
        return;
      }
      if ("updatedAt" in params) {
        row.status = "running";
        row.updated_at = params.updatedAt;
      }
    });
    const get = vi.fn((jobId: string) => jobs.get(jobId));
    const backgroundTasks = new Set<Promise<unknown>>();
    const service = new MediaVoiceService(
      createDeps({
        backgroundTasks,
        gatewaySql: {
          prepare: vi.fn(() => ({
            get,
            run,
          })),
        } as never,
      }),
    );

    const created = service.createMediaJob({
      type: "ocr",
      input: { reason: "coverage" },
    });
    expect(created).toMatchObject({
      type: "ocr",
      status: "queued",
      inputJson: { reason: "coverage" },
    });

    await Promise.allSettled([...backgroundTasks]);
    expect(service.getMediaJob(created.jobId)).toMatchObject({
      status: "ready",
      outputJson: { message: "No attachment supplied." },
    });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ status: "queued" }));
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ outputJson: expect.stringContaining("No attachment") }));
  });

  it("starts and stops voice talk and wake sessions when the managed runtime is ready", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gc-media-voice-"));
    const runtimeBin = path.join(tempDir, "whisper.exe");
    const modelPath = path.join(tempDir, "model.bin");
    await fs.writeFile(runtimeBin, "bin", "utf8");
    await fs.writeFile(modelPath, "model", "utf8");
    const env = {
      GOATCITADEL_WHISPER_CPP_BIN: process.env.GOATCITADEL_WHISPER_CPP_BIN,
      GOATCITADEL_WHISPER_CPP_MODEL_PATH: process.env.GOATCITADEL_WHISPER_CPP_MODEL_PATH,
    };
    process.env.GOATCITADEL_WHISPER_CPP_BIN = runtimeBin;
    process.env.GOATCITADEL_WHISPER_CPP_MODEL_PATH = modelPath;
    try {
      const voiceRows = new Map<string, { payload_json: string }>();
      const run = vi.fn((params: Record<string, unknown>) => {
        if ("payloadJson" in params && "voiceSessionId" in params) {
          voiceRows.set(String(params.talkSessionId), { payload_json: String(params.payloadJson) });
          return;
        }
        if ("payloadJson" in params && "talkSessionId" in params) {
          voiceRows.set(String(params.talkSessionId), { payload_json: String(params.payloadJson) });
        }
      });
      const get = vi.fn((talkSessionId: string) => voiceRows.get(talkSessionId));
      const all = vi.fn(() => [...voiceRows.values()]);
      const publishRealtime = vi.fn();
      const service = new MediaVoiceService(
        createDeps({
          publishRealtime,
          gatewaySql: {
            prepare: vi.fn((sql: string) => ({
              all,
              get,
              run: sql.includes("UPDATE voice_sessions") || sql.includes("INSERT INTO voice_sessions") ? run : vi.fn(),
            })),
          } as never,
        }),
      );

      const talk = await service.startTalkSession({ mode: "wake", sessionId: "session-1" });
      expect(talk).toMatchObject({
        mode: "wake",
        state: "running",
        sessionId: "session-1",
      });
      expect(service.listVoiceTalkSessions(5)).toHaveLength(1);
      expect(service.stopTalkSession(talk.talkSessionId)).toMatchObject({
        talkSessionId: talk.talkSessionId,
        state: "stopped",
      });

      await expect(service.startVoiceWake()).resolves.toMatchObject({
        enabled: true,
        state: "running",
      });
      expect(service.stopVoiceWake()).toMatchObject({
        enabled: false,
        state: "stopped",
      });
      expect(publishRealtime).toHaveBeenCalledWith(
        "system",
        "voice",
        expect.objectContaining({ type: "voice_talk_started" }),
      );
      expect(publishRealtime).toHaveBeenCalledWith(
        "system",
        "voice",
        expect.objectContaining({ type: "voice_wake_stopped" }),
      );
    } finally {
      process.env.GOATCITADEL_WHISPER_CPP_BIN = env.GOATCITADEL_WHISPER_CPP_BIN;
      process.env.GOATCITADEL_WHISPER_CPP_MODEL_PATH = env.GOATCITADEL_WHISPER_CPP_MODEL_PATH;
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("records voice transcription diagnostics and rejects empty or unconfigured audio", async () => {
    const recordDevDiagnostic = vi.fn();
    const systemSettings = createSystemSettings();
    const service = new MediaVoiceService(createDeps({ recordDevDiagnostic, systemSettings }));
    const env = {
      GOATCITADEL_WHISPER_CPP_BIN: process.env.GOATCITADEL_WHISPER_CPP_BIN,
    };
    process.env.GOATCITADEL_WHISPER_CPP_BIN = process.execPath;

    try {
      await expect(service.transcribeVoice({ bytesBase64: "" })).rejects.toThrow("Base64 payload is empty");
      await expect(service.transcribeVoice({ bytesBase64: "AAAA", mimeType: "text/plain" })).rejects.toThrow(
        "requires audio or video",
      );
      await expect(
        service.transcribeVoice({
          bytesBase64: wavBytes().toString("base64"),
          mimeType: "audio/wav",
          language: " en ",
        }),
      ).rejects.toThrow("Local STT failed");
    } finally {
      process.env.GOATCITADEL_WHISPER_CPP_BIN = env.GOATCITADEL_WHISPER_CPP_BIN;
    }

    expect(recordDevDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "voice",
        event: "voice.transcribe.start",
      }),
    );
    // Async execFile rejects when the (here: non-whisper) binary exits non-zero;
    // the service records an error status. We assert the stable state rather than
    // the platform-dependent underlying message (previously coupled to the
    // execFileSync "Command failed" string).
    expect(systemSettings.set).toHaveBeenCalledWith(
      "voice_status_v1",
      expect.objectContaining({
        state: "error",
        lastError: expect.any(String),
      }),
    );
  });

  it("keeps Google Meet voice sessions blocked until auth and transport prerequisites are ready", () => {
    const systemSettings = createSystemSettings();
    const publishRealtime = vi.fn();
    const recordDevDiagnostic = vi.fn();
    const service = new MediaVoiceService(createDeps({ systemSettings, publishRealtime, recordDevDiagnostic }));

    const session = service.startGoogleMeetSession({
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      displayName: "Ops Review",
      userStartConfirmed: true,
    });

    expect(session.state).toBe("blocked");
    expect(session.failureReason).toMatch(/OAuth profile/i);
    expect(session.prerequisites.find((item) => item.id === "oauth_profile")?.ready).toBe(false);
    expect(recordDevDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "meet",
        event: "meet.session",
        level: "warn",
        runtimeKind: "meet.session",
        runtimeStatus: "blocked",
        meetingSessionId: session.sessionId,
      }),
    );
    expect(publishRealtime).toHaveBeenCalledWith(
      "system",
      "voice",
      expect.objectContaining({
        type: "google_meet_session_started",
        state: "blocked",
      }),
    );
  });

  it("streams Google Meet transcript chunks, consult handoff, and cleanup state", () => {
    const systemSettings = createSystemSettings();
    const publishRealtime = vi.fn();
    const service = new MediaVoiceService(createDeps({ systemSettings, publishRealtime }));
    const env = {
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      GOATCITADEL_MEET_BROWSER_TRANSPORT: process.env.GOATCITADEL_MEET_BROWSER_TRANSPORT,
      GOATCITADEL_MEET_AUDIO_TRANSPORT: process.env.GOATCITADEL_MEET_AUDIO_TRANSPORT,
    };
    process.env.OPENAI_API_KEY = "test-key";
    process.env.GOATCITADEL_MEET_BROWSER_TRANSPORT = "ready";
    process.env.GOATCITADEL_MEET_AUDIO_TRANSPORT = "ready";
    try {
      const session = service.startGoogleMeetSession({
        meetingUrl: "https://meet.google.com/abc-defg-hij",
        accountRef: "google:operator",
        userStartConfirmed: true,
      });
      expect(session.state).toBe("running");

      const withTranscript = service.appendGoogleMeetTranscriptChunk(session.sessionId, {
        text: "We should review the dashboard plugin states.",
        final: true,
        provider: "openai-realtime",
      });
      expect(withTranscript.transcript).toHaveLength(1);

      const withHandoff = service.createGoogleMeetConsultHandoff(session.sessionId, { target: "cowork" });
      expect(withHandoff.state).toBe("consulting");
      expect(withHandoff.consultHandoff?.transcriptChunkIds).toHaveLength(1);

      const stopped = service.stopGoogleMeetSession(session.sessionId);
      expect(stopped.state).toBe("stopped");
      expect(stopped.cleanup).toMatchObject({
        stoppedTransport: true,
        releasedAudio: true,
      });
      expect(publishRealtime).toHaveBeenCalledWith(
        "system",
        "voice",
        expect.objectContaining({
          type: "google_meet_session_stopped",
          sessionId: session.sessionId,
        }),
      );
    } finally {
      process.env.OPENAI_API_KEY = env.OPENAI_API_KEY;
      process.env.GOATCITADEL_MEET_BROWSER_TRANSPORT = env.GOATCITADEL_MEET_BROWSER_TRANSPORT;
      process.env.GOATCITADEL_MEET_AUDIO_TRANSPORT = env.GOATCITADEL_MEET_AUDIO_TRANSPORT;
    }
  });

  it("reports Google Meet prerequisite status for Mission Control before start", () => {
    const service = new MediaVoiceService(createDeps());
    const env = {
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      GOATCITADEL_MEET_BROWSER_TRANSPORT: process.env.GOATCITADEL_MEET_BROWSER_TRANSPORT,
      GOATCITADEL_MEET_AUDIO_TRANSPORT: process.env.GOATCITADEL_MEET_AUDIO_TRANSPORT,
    };
    process.env.OPENAI_API_KEY = "test-key";
    process.env.GOATCITADEL_MEET_BROWSER_TRANSPORT = "ready";
    process.env.GOATCITADEL_MEET_AUDIO_TRANSPORT = "ready";
    try {
      const blocked = service.getGoogleMeetPrerequisiteStatus({
        provider: "openai-realtime",
        userStartConfirmed: false,
      });
      expect(blocked.state).toBe("blocked");
      expect(blocked.authProfile.source).toBe("missing");
      expect(blocked.prerequisites.find((item) => item.id === "oauth_profile")?.ready).toBe(false);

      const ready = service.getGoogleMeetPrerequisiteStatus({
        accountRef: "google:operator",
        provider: "openai-realtime",
        userStartConfirmed: true,
      });
      expect(ready.ready).toBe(true);
      expect(ready.authProfile).toMatchObject({
        available: true,
        source: "oauth_thread",
      });
    } finally {
      process.env.OPENAI_API_KEY = env.OPENAI_API_KEY;
      process.env.GOATCITADEL_MEET_BROWSER_TRANSPORT = env.GOATCITADEL_MEET_BROWSER_TRANSPORT;
      process.env.GOATCITADEL_MEET_AUDIO_TRANSPORT = env.GOATCITADEL_MEET_AUDIO_TRANSPORT;
    }
  });
});

function createDeps(
  overrides: {
    systemSettings?: ReturnType<typeof createSystemSettings>;
    publishRealtime?: ReturnType<typeof vi.fn>;
    recordDevDiagnostic?: ReturnType<typeof vi.fn>;
    getChatAttachment?: ReturnType<typeof vi.fn>;
    backgroundTasks?: Set<Promise<unknown>>;
    gatewaySql?: never;
    isClosing?: () => boolean;
  } = {},
) {
  return {
    gatewaySql: overrides.gatewaySql ?? ({ prepare: vi.fn() } as never),
    storage: {
      systemSettings: overrides.systemSettings ?? createSystemSettings(),
      chatAttachments: {
        get: vi.fn(),
      },
    },
    backgroundTasks: overrides.backgroundTasks ?? new Set(),
    isClosing: overrides.isClosing ?? (() => false),
    publishRealtime: overrides.publishRealtime ?? vi.fn(),
    recordDevDiagnostic: overrides.recordDevDiagnostic ?? vi.fn(),
    readChatAttachmentContent: vi.fn(),
    getChatAttachment: overrides.getChatAttachment ?? vi.fn(),
  };
}

function wavBytes() {
  return Buffer.from("524946462400000057415645666d7420", "hex");
}

function createSystemSettings() {
  const values = new Map<string, unknown>();
  return {
    get: vi.fn((key: string) => {
      if (!values.has(key)) {
        return undefined;
      }
      return { value: values.get(key) };
    }),
    set: vi.fn((key: string, value: unknown) => {
      values.set(key, value);
    }),
  };
}
