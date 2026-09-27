import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadGatewayConfig } from "../config.js";
import {
  startFakeOpenAiCompatibleServer,
  type FakeOpenAiServer,
  type FakeOpenAiRequest,
} from "../test/fake-openai-server.js";
import { GatewayService } from "./gateway-service.js";
import { LlamaCppSetupService } from "./llama-cpp-setup-service.js";

const envKeys = [
  "NODE_ENV",
  "GOATCITADEL_DATABASE_DRIVER",
  "GOATCITADEL_RATE_LIMIT_ENABLED",
  "GOATCITADEL_ROOT_DIR",
  "GOATCITADEL_SURFACE_ROUTER_JUDGE_ENABLED",
] as const;
const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
let gateway: GatewayService | undefined;
let fixture: FakeOpenAiServer | undefined;
let root: string | undefined;
afterEach(async () => {
  await gateway?.close().catch(() => undefined);
  gateway = undefined;
  await fixture?.close().catch(() => undefined);
  fixture = undefined;
  if (root) await fs.promises.rm(root, { recursive: true, force: true });
  root = undefined;
  for (const key of envKeys) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("llama.cpp setup Chat diagnostic against a task-owned server", { timeout: 120_000 }, () => {
  it("gets a real response through the Gateway Chat runner without touching any pre-existing server", async () => {
    let failCompletion = false;
    fixture = await startFakeOpenAiCompatibleServer((request: FakeOpenAiRequest) => {
      if (request.method === "GET" && request.path === "/health")
        return { body: { status: "ok", model_alias: "fixture-model" } };
      if (request.method === "GET" && request.path === "/v1/models")
        return { body: { data: [{ id: "fixture-model", object: "model" }] } };
      if (request.method === "POST" && request.path === "/v1/chat/completions") {
        if (failCompletion) return { status: 503, body: { error: { message: "fixture completion unavailable" } } };
        const body = request.body as { stream?: boolean; model?: string; tools?: unknown[] };
        expect(body.model).toBe("fixture-model");
        expect(body.tools ?? []).toHaveLength(0);
        return {
          body: {
            id: "task-owned-llama-reply",
            object: "chat.completion",
            model: "fixture-model",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "The task-owned llama.cpp fixture replied." },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
          },
        };
      }
      return { status: 404, body: { error: "unknown fixture path" } };
    });
    root = fs.mkdtempSync(path.join(os.tmpdir(), "goat-llama-setup-chat-"));
    let source = path.dirname(fileURLToPath(import.meta.url));
    while (!fs.existsSync(path.join(source, "config", "goatcitadel.example.json"))) source = path.dirname(source);
    fs.cpSync(path.join(source, "config"), path.join(root, "config"), { recursive: true });
    const base = JSON.parse(fs.readFileSync(path.join(root, "config", "goatcitadel.example.json"), "utf8")) as Record<
      string,
      any
    >;
    base.llm = {
      activeProviderId: "llamacpp",
      activeModel: "fixture-model",
      defaultThinkingLevel: "off",
      providers: [
        {
          providerId: "llamacpp",
          label: "llama.cpp",
          baseUrl: fixture.baseUrl,
          apiStyle: "openai-chat-completions",
          defaultModel: "fixture-model",
        },
      ],
    };
    base.assistant.llamaCpp.enabled = true;
    base.assistant.llamaCpp.autoStart = false;
    base.assistant.llamaCpp.managementMode = "external";
    base.assistant.llamaCpp.server.baseUrl = fixture.baseUrl;
    base.toolPolicy.sandbox.networkAllowlist = [
      ...new Set([...(base.toolPolicy.sandbox.networkAllowlist ?? []), "127.0.0.1"]),
    ];
    fs.writeFileSync(path.join(root, "config", "goatcitadel.json"), `${JSON.stringify(base, null, 2)}\n`);
    fs.writeFileSync(path.join(root, "config", "llm-providers.json"), `${JSON.stringify(base.llm, null, 2)}\n`);
    process.env.NODE_ENV = "test";
    process.env.GOATCITADEL_DATABASE_DRIVER = "sqlite";
    process.env.GOATCITADEL_RATE_LIMIT_ENABLED = "false";
    process.env.GOATCITADEL_ROOT_DIR = root;
    process.env.GOATCITADEL_SURFACE_ROUTER_JUDGE_ENABLED = "0";
    gateway = new GatewayService(await loadGatewayConfig(root));
    await gateway.initCritical();
    const service = new LlamaCppSetupService({
      getSettings: () => gateway!.getSettings(),
      runtime: gateway.llamaCppRuntime,
      selections: gateway.llamaCppSetupSelection,
      plans: gateway.evolutionControlPlaneService,
      previewModels: (baseUrl) => gateway!.llmService.previewModels({ providerId: "llamacpp", baseUrl }),
      createChatSession: (input) => gateway!.createChatSession(input),
      sendChatMessage: (sessionId, input, options) => gateway!.agentSendChatMessage(sessionId, input, options),
    });
    const result = await service.chatTest("default");
    expect(result).toMatchObject({
      success: true,
      providerId: "llamacpp",
      model: "fixture-model",
      responseExcerpt: "The task-owned llama.cpp fixture replied.",
    });
    expect(
      fixture.requests.some((request) => request.method === "POST" && request.path === "/v1/chat/completions"),
    ).toBe(true);
    failCompletion = true;
    const failed = await service.chatTest("default");
    expect(failed.success).toBe(false);
    expect(failed.error).toBeTruthy();
    expect(fixture.requests.some((request) => request.method === "GET" && request.path === "/v1/models")).toBe(true);
  });
});
