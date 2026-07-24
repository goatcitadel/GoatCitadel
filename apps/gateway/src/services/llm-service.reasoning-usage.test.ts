import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LlmConfigFile } from "@goatcitadel/contracts";
import { ModelUsageAccountingService } from "@goatcitadel/gateway-core";
import { Storage } from "@goatcitadel/storage";
import { createNoopSecretStore } from "../test/llm-fixtures.js";
import { LlmService } from "./llm-service.js";

const roots: string[] = [];
const storages: Storage[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const storage of storages.splice(0)) storage.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("LlmService reasoning attribution persistence", () => {
  it("persists requested ultra and the explicitly mapped Fireworks max wire effort", async () => {
    const root = mkdtempSync(join(tmpdir(), "goatcitadel-reasoning-usage-"));
    roots.push(root);
    const metadataPath = join(root, "metadata.json");
    writeFileSync(
      metadataPath,
      JSON.stringify({
        version: 1,
        entries: {
          "fireworks/accounts/goat/models/reasoner": {
            contextWindow: 262_144,
            outputTokenLimit: 32_768,
            reasoning: { supportedEfforts: ["ultra"], providerEffortMap: { ultra: "max" } },
          },
        },
      }),
    );
    const storage = new Storage({
      dbPath: join(root, "storage.db"),
      transcriptsDir: join(root, "transcripts"),
      auditDir: join(root, "audit"),
    });
    storages.push(storage);
    const accounting = new ModelUsageAccountingService(
      storage.modelUsageEvents,
      `reasoning-test-${randomUUID()}`,
      60_000,
      60_000,
    );
    let payload: Record<string, unknown> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            id: "fireworks-reasoning-usage",
            model: "accounts/goat/models/reasoner",
            choices: [{ index: 0, message: { role: "assistant", content: "answer" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 12, completion_tokens: 3 },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch,
    );
    const service = new LlmService(
      fireworksConfig(),
      { FIREWORKS_API_KEY: "secret-api-key" },
      {
        secretStore: createNoopSecretStore(),
        modelMetadataPath: metadataPath,
        modelUsageAccounting: accounting,
        enforceNetworkAllowlist: false,
      },
    );

    await service.chatCompletions(
      {
        providerId: "fireworks",
        model: "accounts/goat/models/reasoner",
        messages: [{ role: "user", content: "think" }],
        reasoning: { effort: "ultra" },
      },
      {
        operationId: "reasoning-profile-operation",
        dispatchGeneration: "reasoning-profile-generation-1",
        callKind: "chat_initial",
        requestedProviderId: "fireworks",
        requestedModelId: "accounts/goat/models/reasoner",
        workspaceId: "reasoning-profile-workspace",
        sessionId: "reasoning-profile-session",
        turnId: "reasoning-profile-turn",
      },
    );

    expect(payload).toMatchObject({
      reasoning_effort: "max",
      context_length_exceeded_behavior: "error",
    });
    const records = storage.modelUsageEvents.list({ workspaceId: "reasoning-profile-workspace" }).items;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      callKind: "chat_initial",
      requestedProviderId: "fireworks",
      requestedModelId: "accounts/goat/models/reasoner",
      requestedReasoningLevel: "ultra",
      dispatchedReasoningEffort: "max",
      reasoningDisposition: "honored",
      reasoningReasonCode: "requested_reasoning_supported",
      effectiveProviderId: "fireworks",
      effectiveModelId: "accounts/goat/models/reasoner",
      credentialType: "api_key",
      usagePool: "standard",
      credentialSource: "env",
      terminalOutcome: "succeeded",
      inputTokens: 12,
      outputTokens: 3,
    });
    expect(records[0]?.credentialConfigFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(records[0])).not.toContain("secret-api-key");
  });
});

function fireworksConfig(): LlmConfigFile {
  return {
    activeProviderId: "fireworks",
    activeModel: "accounts/goat/models/reasoner",
    providers: [
      {
        providerId: "fireworks",
        label: "Fireworks",
        baseUrl: "https://api.fireworks.ai/inference/v1",
        apiStyle: "openai-chat-completions",
        defaultModel: "accounts/goat/models/reasoner",
        apiKeyEnv: "FIREWORKS_API_KEY",
      },
    ],
  };
}
