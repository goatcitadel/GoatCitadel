import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { dashboardRoutes } from "./dashboard.js";
import { __internal as eventsInternal, eventsRoutes } from "./events.js";
import { agentsRoutes } from "./agents.js";
import {
  createWebhookReadRouteOptions,
  createWebhookRouteOptions,
  readConfigSecret,
  resolveLineChannelSecret,
  resolveNextcloudTalkSecret,
  resolveTelegramBotTokenEnvSecret,
  resolveTelegramWebhookSecret,
  resolveWhatsAppAppSecret,
  resolveWhatsAppVerifyToken,
} from "./integration-webhooks-shared.js";
import { llamaCppRoutes } from "./llamacpp.js";
import { registerChatDelegateRoutes } from "./chat.delegate.js";

describe("Loop 19 chat delegate and realtime route tails", () => {
  let app: FastifyInstance | null = null;
  const originalLimit = process.env.GOATCITADEL_SSE_MAX_CONNECTIONS_PER_IP;

  afterEach(async () => {
    if (originalLimit === undefined) {
      delete process.env.GOATCITADEL_SSE_MAX_CONNECTIONS_PER_IP;
    } else {
      process.env.GOATCITADEL_SSE_MAX_CONNECTIONS_PER_IP = originalLimit;
    }
    if (app) {
      await app.close();
      app = null;
    }
  });

  it("streams delegation chunks, preserves CORS SSE headers, and reports public stream errors", async () => {
    async function* successfulStream() {
      yield { type: "step_started", stepId: "step-1" };
    }
    async function* failingStream() {
      yield* [] as Iterable<never>;
      throw new Error("private failure");
    }
    const chatDelegate = {
      runChatDelegationStream: vi.fn().mockImplementationOnce(successfulStream).mockImplementationOnce(failingStream),
    };
    app = Fastify();
    app.addHook("onRequest", async (_request, reply) => {
      reply.header("Access-Control-Allow-Origin", "http://localhost:4173");
      reply.header("Access-Control-Allow-Credentials", "true");
      reply.header("Vary", "Origin");
    });
    app.decorate("services", { chatDelegate } as never);
    registerChatDelegateRoutes(app);

    const streamed = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/session-1/delegate/stream",
      payload: { objective: "Review this", roles: ["QA"] },
    });
    expect(streamed.statusCode).toBe(200);
    expect(streamed.headers["access-control-allow-origin"]).toBe("http://localhost:4173");
    expect(streamed.headers["access-control-allow-credentials"]).toBe("true");
    expect(streamed.headers.vary).toBe("Origin");
    expect(streamed.body).toContain(": connected");
    expect(streamed.body).toContain('"type":"step_started"');
    expect(chatDelegate.runChatDelegationStream).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        objective: "Review this",
        roles: ["QA"],
        mode: "sequential",
      }),
      expect.objectContaining({ abortSignal: expect.any(AbortSignal) }),
    );

    const failed = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/session-1/delegate/stream",
      payload: { objective: "Review this", roles: ["QA"] },
    });
    expect(failed.statusCode).toBe(200);
    expect(failed.body).toContain('"type":"error"');

    const invalid = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/session-1/delegate/stream",
      payload: { objective: "", roles: [] },
    });
    expect(invalid.statusCode).toBe(400);
  });

  it("closes realtime streams on replay gaps and truncated replay windows", async () => {
    const realtimeEvents = {
      getRealtimeEventSequenceBounds: vi
        .fn()
        .mockReturnValueOnce({ oldestSequence: 10, newestSequence: 40 })
        .mockReturnValueOnce({ oldestSequence: 1, newestSequence: 999 }),
      openRealtimeStreamLease: vi.fn(() => ({
        leaseId: "lease-1",
        clientId: "client-1",
        gatewayNodeId: "node-1",
      })),
      closeRealtimeStreamLease: vi.fn(),
      listRealtimeEventsAfterSequence: vi.fn(() => [{ eventId: "event-20", sequence: 20, timestamp: "now" }]),
      listRealtimeEvents: vi.fn(() => []),
      touchRealtimeStreamLease: vi.fn(),
      subscribeRealtime: vi.fn(() => vi.fn()),
    };
    app = Fastify();
    app.decorate("services", { realtimeEvents } as never);
    app.decorate("requireOperatorAuth", async () => undefined);
    await app.register(eventsRoutes);

    const stale = await app.inject({
      method: "GET",
      url: "/api/v1/events/stream?replay=1&clientId=client-1",
      headers: { "last-event-id": "5" },
    });
    expect(stale.statusCode).toBe(200);
    expect(stale.body).toContain("replay-gap");
    expect(stale.body).toContain('"requestedCursor":5');

    const truncated = await app.inject({
      method: "GET",
      url: "/api/v1/events/stream?afterCursor=10&clientId=client-2",
    });
    expect(truncated.statusCode).toBe(200);
    expect(truncated.body).toContain("replay_window_truncated");
    expect(realtimeEvents.closeRealtimeStreamLease).toHaveBeenCalledWith({
      leaseId: "lease-1",
      closeReason: "replay_gap",
    });
  });

  it("normalizes SSE limits and client keys without leaking zone identifiers", () => {
    delete process.env.GOATCITADEL_SSE_MAX_CONNECTIONS_PER_IP;
    expect(eventsInternal.resolveMaxSseConnectionsPerIp()).toBe(25);
    process.env.GOATCITADEL_SSE_MAX_CONNECTIONS_PER_IP = "0";
    expect(eventsInternal.resolveMaxSseConnectionsPerIp()).toBe(25);
    process.env.GOATCITADEL_SSE_MAX_CONNECTIONS_PER_IP = "3";
    expect(eventsInternal.resolveMaxSseConnectionsPerIp()).toBe(3);
    expect(eventsInternal.normalizeSseConnectionKey(" FE80::ABCD%eth0 ")).toBe("fe80::abcd");
  });
});

describe("Loop 19 llama.cpp and dashboard route tails", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = null;
    }
  });

  it("reports llama.cpp start/stop/refresh failures and degraded install/download posture", async () => {
    const llamaCpp = {
      refreshLlamaCppRuntime: vi
        .fn()
        .mockResolvedValueOnce({ status: "running" })
        .mockRejectedValueOnce(new Error("refresh failed")),
      detectLlamaCppInstall: vi.fn(async () => {
        throw new Error("install probe failed");
      }),
      listLlamaCppModels: vi.fn(async () => [{ modelId: "local-model" }]),
      startLlamaCppRuntime: vi.fn(async () => {
        throw new Error("start failed");
      }),
      stopLlamaCppRuntime: vi.fn(async () => {
        throw new Error("stop failed");
      }),
      adviseLlamaCppRuntime: vi.fn(async () => ({ ok: true })),
      startLlamaCppHuggingFaceDownload: vi.fn(async () => {
        throw new Error("download blocked");
      }),
      getLlamaCppHuggingFaceDownload: vi.fn(() => {
        throw new Error("job not found");
      }),
      cancelLlamaCppHuggingFaceDownload: vi.fn(() => {
        throw new Error("job not found");
      }),
    };
    app = Fastify();
    app.decorate("services", { llamaCpp } as never);
    await app.register(llamaCppRoutes);

    await expect(app.inject({ method: "GET", url: "/api/v1/llamacpp/status" })).resolves.toMatchObject({
      statusCode: 200,
    });
    await expect(app.inject({ method: "GET", url: "/api/v1/llamacpp/install" })).resolves.toMatchObject({
      statusCode: 500,
    });
    const models = await app.inject({ method: "GET", url: "/api/v1/llamacpp/models" });
    expect(models.statusCode).toBe(200);
    expect(models.json()).toEqual({ items: [{ modelId: "local-model" }] });
    await expect(app.inject({ method: "POST", url: "/api/v1/llamacpp/start" })).resolves.toMatchObject({
      statusCode: 400,
    });
    await expect(app.inject({ method: "POST", url: "/api/v1/llamacpp/stop" })).resolves.toMatchObject({
      statusCode: 400,
    });
    await expect(app.inject({ method: "POST", url: "/api/v1/llamacpp/refresh" })).resolves.toMatchObject({
      statusCode: 400,
    });
    llamaCpp.adviseLlamaCppRuntime.mockRejectedValueOnce(new Error("advisor failed"));
    await expect(
      app.inject({
        method: "POST",
        url: "/api/v1/llamacpp/advisor",
        payload: { modelId: "local-model" },
      }),
    ).resolves.toMatchObject({ statusCode: 400 });
    await expect(
      app.inject({
        method: "POST",
        url: "/api/v1/llamacpp/huggingface/download",
        payload: { repo: "ab", filename: "" },
      }),
    ).resolves.toMatchObject({ statusCode: 400 });
    await expect(
      app.inject({
        method: "POST",
        url: "/api/v1/llamacpp/huggingface/download",
        payload: {
          repo: "org/model",
          filename: "model.gguf",
          sha256: "a".repeat(64),
          mmprojFilename: "mmproj.gguf",
          mmprojSha256: "b".repeat(64),
        },
      }),
    ).resolves.toMatchObject({ statusCode: 400 });
    await expect(
      app.inject({ method: "GET", url: "/api/v1/llamacpp/huggingface/downloads/job-404" }),
    ).resolves.toMatchObject({ statusCode: 404 });
    await expect(
      app.inject({ method: "POST", url: "/api/v1/llamacpp/huggingface/downloads/job-404/cancel" }),
    ).resolves.toMatchObject({ statusCode: 404 });
  });

  it("maps dashboard cron errors to the public route contract", async () => {
    const cron = {
      listCronJobs: vi.fn(() => []),
      getCronJob: vi.fn(() => {
        throw new Error("Cron job not found");
      }),
      createCronJob: vi.fn(() => {
        throw new Error("bad schedule");
      }),
      updateCronJob: vi
        .fn()
        .mockImplementationOnce(() => {
          throw new Error("Cron job not found");
        })
        .mockImplementationOnce(() => {
          throw new Error("bad update");
        }),
      setCronJobEnabled: vi
        .fn()
        .mockImplementationOnce(() => {
          throw new Error("Cron job not found");
        })
        .mockImplementationOnce(() => {
          throw new Error("bad state");
        }),
      runCronJobNow: vi
        .fn()
        .mockRejectedValueOnce(new Error("no runnable handler"))
        .mockRejectedValueOnce(new Error("Cron job not found"))
        .mockRejectedValueOnce(new Error("bad run")),
      deleteCronJob: vi
        .fn()
        .mockReturnValueOnce({ deleted: false, jobId: "missing" })
        .mockImplementationOnce(() => {
          throw new Error("cannot be deleted");
        })
        .mockImplementationOnce(() => {
          throw new Error("Cron job not found");
        }),
      listCronReviewQueue: vi.fn(() => {
        throw new Error("queue offline");
      }),
      retryCronReviewQueueItem: vi
        .fn()
        .mockImplementationOnce(() => {
          throw new Error("item not found");
        })
        .mockImplementationOnce(() => {
          throw new Error("retry blocked");
        }),
      getCronRunDiff: vi
        .fn()
        .mockImplementationOnce(() => {
          throw new Error("run not found");
        })
        .mockImplementationOnce(() => {
          throw new Error("diff unavailable");
        }),
    };
    app = Fastify();
    app.decorate("services", {
      cron,
      dashboard: {},
      daemon: {},
      settings: {},
    } as never);
    await app.register(dashboardRoutes);

    await expect(app.inject({ method: "GET", url: "/api/v1/cron/jobs/job-1" })).resolves.toMatchObject({
      statusCode: 404,
    });
    await expect(
      app.inject({
        method: "POST",
        url: "/api/v1/cron/jobs",
        payload: { jobId: "ab", name: "", schedule: "" },
      }),
    ).resolves.toMatchObject({ statusCode: 400 });
    await expect(
      app.inject({
        method: "POST",
        url: "/api/v1/cron/jobs",
        payload: { jobId: "job-1", name: "Job", schedule: "* * * * *" },
      }),
    ).resolves.toMatchObject({ statusCode: 400 });
    await expect(app.inject({ method: "PATCH", url: "/api/v1/cron/jobs/job-1", payload: {} })).resolves.toMatchObject({
      statusCode: 400,
    });
    await expect(
      app.inject({ method: "PATCH", url: "/api/v1/cron/jobs/job-1", payload: { name: "New" } }),
    ).resolves.toMatchObject({ statusCode: 404 });
    await expect(
      app.inject({ method: "PATCH", url: "/api/v1/cron/jobs/job-1", payload: { name: "New" } }),
    ).resolves.toMatchObject({ statusCode: 400 });
    await expect(app.inject({ method: "POST", url: "/api/v1/cron/jobs/job-1/start" })).resolves.toMatchObject({
      statusCode: 404,
    });
    await expect(app.inject({ method: "POST", url: "/api/v1/cron/jobs/job-1/pause" })).resolves.toMatchObject({
      statusCode: 400,
    });
    await expect(app.inject({ method: "POST", url: "/api/v1/cron/jobs/job-1/run" })).resolves.toMatchObject({
      statusCode: 409,
    });
    await expect(app.inject({ method: "POST", url: "/api/v1/cron/jobs/job-1/run" })).resolves.toMatchObject({
      statusCode: 404,
    });
    await expect(app.inject({ method: "POST", url: "/api/v1/cron/jobs/job-1/run" })).resolves.toMatchObject({
      statusCode: 400,
    });
    await expect(app.inject({ method: "DELETE", url: "/api/v1/cron/jobs/missing" })).resolves.toMatchObject({
      statusCode: 404,
    });
    await expect(app.inject({ method: "DELETE", url: "/api/v1/cron/jobs/job-1" })).resolves.toMatchObject({
      statusCode: 409,
    });
    await expect(app.inject({ method: "DELETE", url: "/api/v1/cron/jobs/job-1" })).resolves.toMatchObject({
      statusCode: 404,
    });
    await expect(app.inject({ method: "GET", url: "/api/v1/cron/review-queue?limit=0" })).resolves.toMatchObject({
      statusCode: 400,
    });
    await expect(app.inject({ method: "GET", url: "/api/v1/cron/review-queue" })).resolves.toMatchObject({
      statusCode: 409,
    });
    await expect(app.inject({ method: "POST", url: "/api/v1/cron/review-queue/item-1/retry" })).resolves.toMatchObject({
      statusCode: 404,
    });
    await expect(app.inject({ method: "POST", url: "/api/v1/cron/review-queue/item-1/retry" })).resolves.toMatchObject({
      statusCode: 409,
    });
    await expect(app.inject({ method: "GET", url: "/api/v1/cron/runs/run-1/diff" })).resolves.toMatchObject({
      statusCode: 404,
    });
    await expect(app.inject({ method: "GET", url: "/api/v1/cron/runs/run-1/diff" })).resolves.toMatchObject({
      statusCode: 409,
    });
  });

  it("maps imported-agent facade failures through the shared route error handler", async () => {
    const agents = {
      listAgents: vi.fn(() => []),
      listImportedAgentCatalog: vi.fn(() => {
        throw new Error("catalog offline");
      }),
      getImportedAgentCatalogEntry: vi.fn(() => {
        throw new Error("entry missing");
      }),
      importAgencyAgentCatalog: vi.fn(async () => {
        throw new Error("import failed");
      }),
      patchImportedAgentCatalogEntryState: vi.fn(() => {
        throw new Error("patch failed");
      }),
      activateImportedAgentCatalogEntryForSession: vi.fn(() => {
        throw new Error("activation failed");
      }),
      getAgent: vi.fn(() => ({ roleId: "agent-1" })),
      createAgentProfile: vi.fn(() => {
        throw new Error("create failed");
      }),
      updateAgentProfile: vi.fn(() => {
        throw new Error("update failed");
      }),
      archiveAgentProfile: vi.fn(() => {
        throw new Error("archive failed");
      }),
      restoreAgentProfile: vi.fn(() => {
        throw new Error("restore failed");
      }),
      hardDeleteAgentProfile: vi.fn(() => true),
    };
    app = Fastify();
    app.decorate("services", { agents } as never);
    await app.register(agentsRoutes);

    for (const request of [
      { method: "GET", url: "/api/v1/agents/catalog" },
      { method: "GET", url: "/api/v1/agents/catalog/entry-1" },
      {
        method: "POST",
        url: "/api/v1/agents/catalog/import/agency-agents",
        payload: { workspaceId: "default" },
      },
      {
        method: "PATCH",
        url: "/api/v1/agents/catalog/entry-1/state",
        payload: { state: "approved" },
      },
      {
        method: "POST",
        url: "/api/v1/agents/catalog/entry-1/activate-session",
        payload: { sessionId: "session-1" },
      },
      {
        method: "POST",
        url: "/api/v1/agents",
        payload: { roleId: "agent-1", name: "Agent", title: "Agent", summary: "Agent summary" },
      },
      {
        method: "PATCH",
        url: "/api/v1/agents/agent-1",
        payload: { title: "Updated" },
      },
      {
        method: "POST",
        url: "/api/v1/agents/agent-1/archive",
        payload: {},
      },
      { method: "POST", url: "/api/v1/agents/agent-1/restore" },
    ] as const) {
      await expect(app.inject(request)).resolves.toMatchObject({ statusCode: 500 });
    }
  });
});

describe("Loop 19 webhook shared secret resolution tails", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("builds write/read route options with rate limits and optional raw-body pre-parsing", () => {
    expect(createWebhookRouteOptions()).toMatchObject({
      bodyLimit: expect.any(Number),
      config: { rateLimit: { max: 500 } },
    });
    const withRawBody = createWebhookRouteOptions("rawBody");
    expect(withRawBody).toMatchObject({
      bodyLimit: expect.any(Number),
      config: { rateLimit: { max: 500 } },
    });
    expect(withRawBody.preParsing).toEqual(expect.any(Function));
    expect(createWebhookReadRouteOptions()).toEqual({ config: { rateLimit: { max: 500 } } });
  });

  it("prefers direct configured secrets, then allowlisted env references, and rejects unsafe env names", () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = " env-telegram ";
    process.env.WHATSAPP_APP_SECRET = " env-whatsapp ";
    process.env.WHATSAPP_VERIFY_TOKEN = " env-verify ";
    process.env.NEXTCLOUD_TALK_TOKEN = " env-nextcloud ";
    process.env.LINE_CHANNEL_SECRET = " env-line ";
    process.env.GOATCITADEL_POSTGRES_PASSWORD = "do-not-send-to-telegram";
    process.env.GOATCITADEL_TELEGRAM_BOT_TOKEN = " env-telegram-bot ";
    process.env.NOT_ALLOWED_SECRET = "do-not-read";
    process.env.telegram_webhook_secret = "do-not-read-through-case-folding";

    expect(readConfigSecret({ token: " direct " }, "token", "tokenEnv")).toBe("direct");
    expect(readConfigSecret({ tokenEnv: "NOT_ALLOWED_SECRET" }, "token", "tokenEnv")).toBeUndefined();
    expect(readConfigSecret({ tokenEnv: "GOATCITADEL_POSTGRES_PASSWORD" }, "token", "tokenEnv")).toBeUndefined();
    expect(readConfigSecret({ tokenEnv: "TELEGRAM_WEBHOOK_SECRET" }, "token", "tokenEnv")).toBe("env-telegram");
    expect(readConfigSecret({ tokenEnv: "TELEGRAM_MISSING" }, "token", "tokenEnv")).toBeUndefined();
    expect(readConfigSecret({ tokenEnv: "telegram_webhook_secret" }, "token", "tokenEnv")).toBeUndefined();
    expect(resolveTelegramBotTokenEnvSecret("GOATCITADEL_POSTGRES_PASSWORD")).toBeUndefined();
    expect(resolveTelegramBotTokenEnvSecret("GOATCITADEL_TELEGRAM_BOT_TOKEN")).toBe("env-telegram-bot");
    expect(resolveTelegramWebhookSecret({ webhookSecretEnv: "TELEGRAM_WEBHOOK_SECRET" })).toBe("env-telegram");
    expect(resolveTelegramWebhookSecret({ secretToken: "direct-telegram" })).toBe("direct-telegram");
    expect(resolveTelegramWebhookSecret({ botSecret: "bot-telegram" })).toBe("bot-telegram");
    expect(resolveWhatsAppAppSecret({ appSecretEnv: "WHATSAPP_APP_SECRET" })).toBe("env-whatsapp");
    expect(resolveWhatsAppAppSecret({ webhookSecret: "direct-whatsapp-webhook" })).toBe("direct-whatsapp-webhook");
    expect(resolveWhatsAppVerifyToken({ webhookVerifyTokenEnv: "WHATSAPP_VERIFY_TOKEN" })).toBe("env-verify");
    expect(resolveWhatsAppVerifyToken({ verifyToken: "direct-verify" })).toBe("direct-verify");
    expect(resolveNextcloudTalkSecret({ tokenEnv: "NEXTCLOUD_TALK_TOKEN" })).toBe("env-nextcloud");
    expect(resolveNextcloudTalkSecret({ botSecret: "bot-nextcloud" })).toBe("bot-nextcloud");
    expect(resolveNextcloudTalkSecret({ secret: "secret-nextcloud" })).toBe("secret-nextcloud");
    expect(resolveLineChannelSecret({ channelSecretEnv: "LINE_CHANNEL_SECRET" })).toBe("env-line");
    expect(resolveLineChannelSecret({ secret: "direct-line" })).toBe("direct-line");
  });
});
