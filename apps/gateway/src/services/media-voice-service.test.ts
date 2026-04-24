import { describe, expect, it, vi } from "vitest";
import type { VoiceTalkSessionRecord } from "@goatcitadel/contracts";
import { MediaVoiceService } from "./media-voice-service.js";

describe("MediaVoiceService", () => {
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
  } = {},
) {
  return {
    gatewaySql: { prepare: vi.fn() } as never,
    storage: {
      systemSettings: overrides.systemSettings ?? createSystemSettings(),
      chatAttachments: {
        get: vi.fn(),
      },
    },
    backgroundTasks: new Set(),
    isClosing: () => false,
    publishRealtime: overrides.publishRealtime ?? vi.fn(),
    recordDevDiagnostic: overrides.recordDevDiagnostic ?? vi.fn(),
    readChatAttachmentContent: vi.fn(),
    getChatAttachment: vi.fn(),
  };
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
