import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { voiceRoutes } from "./voice.js";

describe("voice routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  it("returns voice status and managed runtime status", async () => {
    const getVoiceStatus = vi.fn(async () => ({
      stt: {
        state: "stopped",
        provider: "whisper.cpp",
        modelId: "base.en",
        runtimeReady: false,
        updatedAt: "2026-03-08T00:00:00.000Z",
      },
      talk: {
        state: "stopped",
        updatedAt: "2026-03-08T00:00:00.000Z",
      },
      wake: {
        enabled: false,
        state: "stopped",
        model: "openwakeword",
        updatedAt: "2026-03-08T00:00:00.000Z",
      },
    }));
    const getVoiceRuntimeStatus = vi.fn(async () => ({
      provider: "whisper.cpp",
      source: "managed",
      readiness: "missing",
      binaryReady: false,
      ffmpegReady: false,
      installedModels: [],
      catalog: [],
    }));
    app = Fastify();
    app.decorate("services", {
      voice: { getVoiceStatus, getVoiceRuntimeStatus },
    } as never);
    await app.register(voiceRoutes);

    const statusResponse = await app.inject({
      method: "GET",
      url: "/api/v1/voice/status",
    });
    expect(statusResponse.statusCode).toBe(200);
    expect(getVoiceStatus).toHaveBeenCalled();

    const runtimeResponse = await app.inject({
      method: "GET",
      url: "/api/v1/voice/runtime",
    });
    expect(runtimeResponse.statusCode).toBe(200);
    expect(getVoiceRuntimeStatus).toHaveBeenCalled();
  });

  it("lists recent talk sessions", async () => {
    const listVoiceTalkSessions = vi.fn(() => [
      {
        talkSessionId: "talk-1",
        mode: "push_to_talk",
        state: "stopped",
        createdAt: "2026-03-08T00:00:00.000Z",
        startedAt: "2026-03-08T00:00:00.000Z",
        stoppedAt: "2026-03-08T00:05:00.000Z",
      },
    ]);
    app = Fastify();
    app.decorate("services", {
      voice: { listVoiceTalkSessions },
    } as never);
    await app.register(voiceRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/voice/talk/sessions?limit=5",
    });

    expect(response.statusCode).toBe(200);
    expect(listVoiceTalkSessions).toHaveBeenCalledWith(5);
    expect(response.json()).toEqual({
      items: [
        expect.objectContaining({
          talkSessionId: "talk-1",
          state: "stopped",
        }),
      ],
    });
  });

  it("rejects malformed talk session requests and query parameters", async () => {
    const startTalkSession = vi.fn();
    const listVoiceTalkSessions = vi.fn();
    app = Fastify();
    app.decorate("services", {
      voice: { listVoiceTalkSessions, startTalkSession },
    } as never);
    await app.register(voiceRoutes);

    const invalidStart = await app.inject({
      method: "POST",
      url: "/api/v1/voice/talk/sessions",
      payload: {
        mode: "always_on",
      },
    });
    const invalidList = await app.inject({
      method: "GET",
      url: "/api/v1/voice/talk/sessions?limit=0",
    });

    expect(invalidStart.statusCode).toBe(400);
    expect(invalidList.statusCode).toBe(400);
    expect(startTalkSession).not.toHaveBeenCalled();
    expect(listVoiceTalkSessions).not.toHaveBeenCalled();
  });

  it("stops the wake listener without changing the response contract", async () => {
    const stopVoiceWake = vi.fn(() => ({
      enabled: false,
      state: "stopped",
      updatedAt: "2026-03-08T00:00:00.000Z",
    }));
    app = Fastify();
    app.decorate("services", {
      voice: { stopVoiceWake },
    } as never);
    await app.register(voiceRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/voice/wake/stop",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      enabled: false,
      state: "stopped",
      updatedAt: "2026-03-08T00:00:00.000Z",
    });
    expect(stopVoiceWake).toHaveBeenCalled();
  });

  it("installs, selects, and removes managed voice models", async () => {
    const installVoiceRuntime = vi.fn(async () => ({
      provider: "whisper.cpp",
      source: "managed",
      readiness: "ready",
      binaryReady: true,
      ffmpegReady: true,
      selectedModelId: "base.en",
      installedModels: [],
      catalog: [],
    }));
    const selectVoiceRuntimeModel = vi.fn(async (modelId: string) => ({
      provider: "whisper.cpp",
      source: "managed",
      readiness: "ready",
      binaryReady: true,
      ffmpegReady: true,
      selectedModelId: modelId,
      installedModels: [],
      catalog: [],
    }));
    const removeVoiceRuntimeModel = vi.fn(async () => ({
      provider: "whisper.cpp",
      source: "managed",
      readiness: "ready",
      binaryReady: true,
      ffmpegReady: true,
      selectedModelId: "small.en",
      installedModels: [],
      catalog: [],
    }));

    app = Fastify();
    app.decorate("services", {
      voice: { installVoiceRuntime, selectVoiceRuntimeModel, removeVoiceRuntimeModel },
    } as never);
    await app.register(voiceRoutes);

    const installResponse = await app.inject({
      method: "POST",
      url: "/api/v1/voice/runtime/install",
      payload: {
        modelId: "base.en",
        activate: true,
      },
    });
    expect(installResponse.statusCode).toBe(200);
    expect(installVoiceRuntime).toHaveBeenCalledWith({
      modelId: "base.en",
      activate: true,
    });

    const selectResponse = await app.inject({
      method: "POST",
      url: "/api/v1/voice/runtime/models/base.en/select",
    });
    expect(selectResponse.statusCode).toBe(200);
    expect(selectVoiceRuntimeModel).toHaveBeenCalledWith("base.en");

    const removeResponse = await app.inject({
      method: "DELETE",
      url: "/api/v1/voice/runtime/models/base.en",
    });
    expect(removeResponse.statusCode).toBe(200);
    expect(removeVoiceRuntimeModel).toHaveBeenCalledWith("base.en");
  });

  it("returns a bad request when talk start is blocked by runtime posture", async () => {
    const startTalkSession = vi.fn(async () => {
      throw new Error("Cannot start Talk Mode while the managed voice runtime is missing.");
    });
    app = Fastify();
    app.decorate("services", {
      voice: { startTalkSession },
    } as never);
    await app.register(voiceRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/voice/talk/sessions",
      payload: {
        mode: "push_to_talk",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(startTalkSession).toHaveBeenCalledWith({
      mode: "push_to_talk",
    });
    expect(response.json()).toEqual({
      error: "Cannot start Talk Mode while the managed voice runtime is missing.",
    });
  });

  it("returns a bad request when wake start is blocked by runtime posture", async () => {
    const startVoiceWake = vi.fn(async () => {
      throw new Error("Cannot start Wake listener until a managed voice model is selected.");
    });
    app = Fastify();
    app.decorate("services", {
      voice: { startVoiceWake },
    } as never);
    await app.register(voiceRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/voice/wake/start",
    });

    expect(response.statusCode).toBe(400);
    expect(startVoiceWake).toHaveBeenCalled();
    expect(response.json()).toEqual({
      error: "Cannot start Wake listener until a managed voice model is selected.",
    });
  });

  it("transcribes voice input and reports validation or service errors", async () => {
    const transcribeVoice = vi
      .fn()
      .mockResolvedValueOnce({
        text: "hello operator",
        language: "en",
      })
      .mockRejectedValueOnce(new Error("audio decode failed"));
    app = Fastify();
    app.decorate("services", {
      voice: { transcribeVoice },
    } as never);
    await app.register(voiceRoutes);

    const invalid = await app.inject({
      method: "POST",
      url: "/api/v1/voice/transcribe",
      payload: {},
    });
    const valid = await app.inject({
      method: "POST",
      url: "/api/v1/voice/transcribe",
      payload: {
        bytesBase64: "aGVsbG8=",
        mimeType: "audio/wav",
        language: "en",
      },
    });
    const failed = await app.inject({
      method: "POST",
      url: "/api/v1/voice/transcribe",
      payload: {
        bytesBase64: "YmFk",
      },
    });

    expect(invalid.statusCode).toBe(400);
    expect(valid.statusCode).toBe(200);
    expect(valid.json()).toEqual({ text: "hello operator", language: "en" });
    expect(transcribeVoice).toHaveBeenCalledWith({
      bytesBase64: "aGVsbG8=",
      mimeType: "audio/wav",
      language: "en",
    });
    expect(failed.statusCode).toBe(400);
    expect(failed.json()).toEqual({ error: "audio decode failed" });
  });

  it("stops talk sessions and maps missing sessions to not found", async () => {
    const stopTalkSession = vi
      .fn()
      .mockReturnValueOnce({
        talkSessionId: "talk-1",
        state: "stopped",
      })
      .mockImplementationOnce(() => {
        throw new Error("Talk session missing");
      });
    app = Fastify();
    app.decorate("services", {
      voice: { stopTalkSession },
    } as never);
    await app.register(voiceRoutes);

    const stopped = await app.inject({
      method: "POST",
      url: "/api/v1/voice/talk/sessions/talk-1/stop",
    });
    const missing = await app.inject({
      method: "POST",
      url: "/api/v1/voice/talk/sessions/talk-2/stop",
    });

    expect(stopped.statusCode).toBe(200);
    expect(stopped.json()).toEqual({ talkSessionId: "talk-1", state: "stopped" });
    expect(stopTalkSession).toHaveBeenCalledWith("talk-1");
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "Talk session missing" });
  });

  it("drives Google Meet voice session lifecycle and validates malformed requests", async () => {
    const listGoogleMeetSessions = vi.fn(() => [{ sessionId: "meet-1", state: "active" }]);
    const getGoogleMeetPrerequisiteStatus = vi.fn((input: Record<string, unknown>) => ({
      ready: true,
      input,
    }));
    const startGoogleMeetSession = vi.fn((input: Record<string, unknown>) => ({
      sessionId: "meet-1",
      ...input,
    }));
    const appendGoogleMeetTranscriptChunk = vi
      .fn()
      .mockReturnValueOnce({ sessionId: "meet-1", chunks: 1 })
      .mockImplementationOnce(() => {
        throw new Error("session closed");
      });
    const createGoogleMeetConsultHandoff = vi
      .fn()
      .mockReturnValueOnce({ sessionId: "meet-1", target: "cowork" })
      .mockImplementationOnce(() => {
        throw new Error("handoff unavailable");
      });
    const stopGoogleMeetSession = vi
      .fn()
      .mockReturnValueOnce({ sessionId: "meet-1", state: "stopped" })
      .mockImplementationOnce(() => {
        throw new Error("meet session missing");
      });

    app = Fastify();
    app.decorate("services", {
      voice: {
        appendGoogleMeetTranscriptChunk,
        createGoogleMeetConsultHandoff,
        getGoogleMeetPrerequisiteStatus,
        listGoogleMeetSessions,
        startGoogleMeetSession,
        stopGoogleMeetSession,
      },
    } as never);
    await app.register(voiceRoutes);

    expect((await app.inject({ method: "GET", url: "/api/v1/voice/google-meet/sessions" })).json()).toEqual({
      items: [{ sessionId: "meet-1", state: "active" }],
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/voice/google-meet/prerequisites",
          payload: { meetingUrl: "https://meet.google.com/abc-defg-hij", provider: "local-transcription" },
        })
      ).json(),
    ).toMatchObject({ ready: true });
    expect(
      await app.inject({
        method: "POST",
        url: "/api/v1/voice/google-meet/prerequisites",
        payload: { meetingUrl: "not-a-url" },
      }),
    ).toMatchObject({ statusCode: 400 });

    const started = await app.inject({
      method: "POST",
      url: "/api/v1/voice/google-meet/sessions",
      payload: {
        meetingUrl: "https://meet.google.com/abc-defg-hij",
        displayName: "GoatCitadel",
        provider: "openai-realtime",
        userStartConfirmed: true,
      },
    });
    expect(started.statusCode).toBe(201);
    expect(startGoogleMeetSession).toHaveBeenCalledWith(
      expect.objectContaining({
        meetingUrl: "https://meet.google.com/abc-defg-hij",
        provider: "openai-realtime",
      }),
    );
    expect(
      await app.inject({
        method: "POST",
        url: "/api/v1/voice/google-meet/sessions",
        payload: {
          meetingUrl: "not-a-url",
        },
      }),
    ).toMatchObject({ statusCode: 400 });

    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/voice/google-meet/sessions/meet-1/transcript",
          payload: { text: "shipping update", provider: "local-transcription", final: true },
        })
      ).json(),
    ).toEqual({ sessionId: "meet-1", chunks: 1 });
    expect(
      await app.inject({
        method: "POST",
        url: "/api/v1/voice/google-meet/sessions/meet-1/transcript",
        payload: { text: "late", provider: "local-transcription" },
      }),
    ).toMatchObject({ statusCode: 400 });
    expect(
      await app.inject({
        method: "POST",
        url: "/api/v1/voice/google-meet/sessions/meet-1/transcript",
        payload: { provider: "local-transcription" },
      }),
    ).toMatchObject({ statusCode: 400 });

    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/voice/google-meet/sessions/meet-1/consult",
          payload: { target: "cowork", prompt: "Summarize action items" },
        })
      ).json(),
    ).toEqual({ sessionId: "meet-1", target: "cowork" });
    expect(
      await app.inject({
        method: "POST",
        url: "/api/v1/voice/google-meet/sessions/meet-1/consult",
        payload: { target: "code" },
      }),
    ).toMatchObject({ statusCode: 400 });

    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/voice/google-meet/sessions/meet-1/stop",
        })
      ).json(),
    ).toEqual({ sessionId: "meet-1", state: "stopped" });
    expect(
      await app.inject({
        method: "POST",
        url: "/api/v1/voice/google-meet/sessions/meet-1/stop",
      }),
    ).toMatchObject({ statusCode: 404 });
  });

  it("returns runtime model operation errors without changing status contracts", async () => {
    const installVoiceRuntime = vi.fn(async () => {
      throw new Error("install failed");
    });
    const selectVoiceRuntimeModel = vi.fn(async () => {
      throw new Error("select failed");
    });
    const removeVoiceRuntimeModel = vi.fn(async () => {
      throw new Error("remove failed");
    });
    app = Fastify();
    app.decorate("services", {
      voice: { installVoiceRuntime, selectVoiceRuntimeModel, removeVoiceRuntimeModel },
    } as never);
    await app.register(voiceRoutes);

    await expect(
      app.inject({ method: "POST", url: "/api/v1/voice/runtime/install", payload: { modelId: "" } }),
    ).resolves.toMatchObject({ statusCode: 400 });
    await expect(
      app.inject({ method: "POST", url: "/api/v1/voice/runtime/install", payload: { modelId: "base.en" } }),
    ).resolves.toMatchObject({ statusCode: 400 });
    await expect(
      app.inject({ method: "POST", url: "/api/v1/voice/runtime/models/base.en/select" }),
    ).resolves.toMatchObject({ statusCode: 400 });
    await expect(app.inject({ method: "DELETE", url: "/api/v1/voice/runtime/models/base.en" })).resolves.toMatchObject({
      statusCode: 400,
    });
  });
});
