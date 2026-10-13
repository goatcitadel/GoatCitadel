import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import type { ChatThreadResponse, RoutingPreflightResult } from "@goatcitadel/contracts";
import { buildApp } from "./app.js";
import { startFakeOpenAiCompatibleServer } from "./test/fake-openai-server.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it("uses one saved fallback through fresh authenticated Chat and records the actual route", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gc-chat-fallback-"));
  const primary = await startFakeOpenAiCompatibleServer((request) =>
    request.path === "/v1/models"
      ? { body: { data: [{ id: "primary-model", object: "model" }] } }
      : { status: 503, body: { error: { message: "Controlled primary unavailable", type: "server_error" } } },
  );
  const backup = await startFakeOpenAiCompatibleServer((request) => {
    if (request.path === "/v1/models") return { body: { data: [{ id: "backup-model", object: "model" }] } };
    if (request.path !== "/v1/chat/completions") return { status: 404 };
    const body = request.body as { stream?: boolean; model?: string };
    expect(body.model).toBe("backup-model");
    return body.stream
      ? {
          sseFrames: [
            JSON.stringify({
              model: "backup-model",
              choices: [
                {
                  index: 0,
                  delta: {
                    role: "assistant",
                    content:
                      "Hello! The backup provider completed this greeting successfully. I am ready to help with your next request. FALLBACK_PUBLIC_CHAT_COMPLETE.",
                  },
                  finish_reason: "stop",
                },
              ],
              usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
            }),
            "[DONE]",
          ],
        }
      : {
          body: {
            model: "backup-model",
            choices: [
              {
                message: {
                  role: "assistant",
                  content:
                    "Hello! The backup provider completed this greeting successfully. I am ready to help with your next request. FALLBACK_PUBLIC_CHAT_COMPLETE.",
                },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
          },
        };
  });
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    const configDir = path.join(root, "config");
    await fs.mkdir(configDir);
    const examples = fileURLToPath(new URL("../../../config/", import.meta.url));
    for (const name of [
      "assistant.config.example.json",
      "tool-policy.example.json",
      "budgets.example.json",
      "cron-jobs.example.json",
    ])
      await fs.copyFile(path.join(examples, name), path.join(configDir, name));
    const config = JSON.parse(await fs.readFile(path.join(examples, "goatcitadel.example.json"), "utf8"));
    config.llm = {
      activeProviderId: "fixture-primary",
      activeModel: "primary-model",
      providers: [
        {
          providerId: "fixture-primary",
          label: "Primary fixture",
          baseUrl: primary.baseUrl,
          apiStyle: "openai-chat-completions",
          defaultModel: "primary-model",
        },
        {
          providerId: "fixture-backup",
          label: "Backup fixture",
          baseUrl: backup.baseUrl,
          apiStyle: "openai-chat-completions",
          defaultModel: "backup-model",
        },
      ],
    };
    config.assistant.approvalExplainer.enabled = false;
    await fs.writeFile(path.join(configDir, "goatcitadel.json"), JSON.stringify(config));
    await fs.writeFile(
      path.join(configDir, "llm-model-metadata.json"),
      JSON.stringify({
        version: 1,
        entries: {
          "fixture-primary/primary-model": { contextWindow: 64_000, outputTokenLimit: 4096 },
          "fixture-backup/backup-model": { contextWindow: 64_000, outputTokenLimit: 4096 },
        },
      }),
    );
    const token = "fallback-test-operator-1234567890";
    for (const [key, value] of Object.entries({
      GATEWAY_HOST: "127.0.0.1",
      NODE_ENV: "test",
      GOATCITADEL_ROOT_DIR: root,
      GOATCITADEL_ALLOWED_ORIGINS: "http://localhost:5173",
      GOATCITADEL_ALLOW_TAILNET_DEV_ORIGINS: "false",
      GOATCITADEL_AUTH_MODE: "token",
      GOATCITADEL_AUTH_TOKEN: token,
      GOATCITADEL_AUTH_ALLOW_LOOPBACK_BYPASS: "false",
      GOATCITADEL_DATABASE_DRIVER: "sqlite",
      GOATCITADEL_RATE_LIMIT_ENABLED: "false",
      GOATCITADEL_FEATURE_DURABLE_KERNEL_V1_ENABLED: "true",
      GOATCITADEL_FEATURE_CHAT_PROVIDER_FALLBACK_V1_ENABLED: "true",
    }))
      vi.stubEnv(key, value);
    let sequence = 0;
    const headers = () => ({ authorization: `Bearer ${token}`, "idempotency-key": `fallback-proof-${++sequence}` });
    app = await buildApp();
    const session = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions",
      headers: headers(),
      payload: { title: "Fallback proof" },
    });
    expect(session.statusCode, session.body).toBe(201);
    const url = `/api/v1/chat/sessions/${session.json().sessionId}`;
    const content = "Reply briefly to this greeting.";
    const preflight = () =>
      app!.inject({
        method: "POST",
        url: `${url}/route-preflight`,
        headers: headers(),
        payload: { action: "send", content, subagentPolicy: "off" },
      });
    const initial = await preflight();
    expect(initial.statusCode, initial.body).toBe(200);
    expect(initial.json().fallbackPolicy).toBe("off");
    expect(backup.requests.filter((request) => request.path === "/v1/chat/completions")).toHaveLength(0);
    const prefs = await app.inject({ method: "GET", url: `${url}/prefs`, headers: headers() });
    expect(prefs.statusCode, prefs.body).toBe(200);
    const saved = await app.inject({
      method: "PATCH",
      url: `${url}/prefs`,
      headers: headers(),
      payload: {
        expectedRevision: prefs.json().revision,
        providerFallback: { providerId: "fixture-backup", model: "backup-model", allowLocalToCloud: false },
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const armed = await preflight();
    expect(armed.statusCode, armed.body).toBe(200);
    expect(armed.json().fallbackPolicy).toBe("armed");
    const { decision, blockedReason } = armed.json() as RoutingPreflightResult;
    expect(blockedReason).toBeUndefined();
    const sent = await app.inject({
      method: "POST",
      url: `${url}/agent-send/stream`,
      headers: headers(),
      payload: {
        content,
        subagentPolicy: "off",
        providerId: decision.effectiveProviderId,
        model: decision.effectiveModel,
        routeDecision: decision,
      },
    });
    expect(sent.statusCode, sent.body.slice(0, 2000)).toBe(200);
    const thread = await app.inject({ method: "GET", url: `${url}/thread`, headers: headers() });
    expect(thread.statusCode, thread.body).toBe(200);
    const turn = (thread.json() as ChatThreadResponse).turns.at(-1)!;
    expect(turn.trace.status, JSON.stringify(turn.trace)).toBe("completed");
    expect(turn.assistantMessage?.content).toContain("FALLBACK_PUBLIC_CHAT_COMPLETE");
    expect(turn.trace.capabilityProfileId).toBeUndefined();
    expect(turn.trace.routing).toMatchObject({
      fallbackUsed: true,
      effectiveProviderId: "fixture-backup",
      effectiveModel: "backup-model",
    });
    expect(primary.requests.some((request) => request.path === "/v1/chat/completions")).toBe(true);
    expect(backup.requests.filter((request) => request.path === "/v1/chat/completions")).toHaveLength(1);
  } finally {
    await app?.close();
    await primary.close();
    await backup.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}, 180_000);
