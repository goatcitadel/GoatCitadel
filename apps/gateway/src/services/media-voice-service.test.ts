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
});
