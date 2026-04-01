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
    app.decorate("gateway", {
      getVoiceStatus,
      getVoiceRuntimeStatus,
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
    const listVoiceTalkSessions = vi.fn(() => ([
      {
        talkSessionId: "talk-1",
        mode: "push_to_talk",
        state: "stopped",
        createdAt: "2026-03-08T00:00:00.000Z",
        startedAt: "2026-03-08T00:00:00.000Z",
        stoppedAt: "2026-03-08T00:05:00.000Z",
      },
    ]));
    app = Fastify();
    app.decorate("gateway", {
      listVoiceTalkSessions,
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
    app.decorate("gateway", {
      installVoiceRuntime,
      selectVoiceRuntimeModel,
      removeVoiceRuntimeModel,
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
    app.decorate("gateway", {
      startTalkSession,
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
    app.decorate("gateway", {
      startVoiceWake,
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
});
