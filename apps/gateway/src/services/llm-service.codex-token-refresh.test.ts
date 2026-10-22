import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LlmConfigFile, ModelUsageAttributionContext } from "@goatcitadel/contracts";
import { ModelUsageAccountingService } from "@goatcitadel/gateway-core";
import { Storage } from "@goatcitadel/storage";
import { LlmService } from "./llm-service.js";
import type { SecretStoreService } from "./secret-store-service.js";

const OAUTH_ACCOUNT = "provider:openai-codex:oauth";
const WORKSPACE_ID = "workspace-codex-refresh-test";
const TOKEN_EXPIRED_BODY = JSON.stringify({
  error: {
    message: "Your authentication token has expired. Please try refreshing it.",
    type: "invalid_request_error",
    code: "token_expired",
    param: null,
  },
  status: 401,
  detail: { code: "token_expired", message: "Your authentication token has expired. Please try refreshing it." },
});

const storages: Storage[] = [];
const roots: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const storage of storages.splice(0)) storage.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("LlmService OpenAI Codex token_expired recovery", () => {
  it("refreshes once and resends with the new token when ChatGPT rejects a not-yet-expired token", async () => {
    const secrets = createMemorySecretStore();
    const oauthFetch = vi.fn(async () => tokenResponse("fresh-access-token"));
    const { service, storage } = createHarness(secrets, oauthFetch);
    const providerFetch = stubProviderFetch([unauthorized(TOKEN_EXPIRED_BODY), completedStream("ok")]);

    const completion = await service.chatCompletions(chatRequest(), attribution("codex-refresh-success"));

    expect(completion.choices[0]?.message?.content).toBe("ok");
    expect(oauthFetch).toHaveBeenCalledTimes(1);
    const [, oauthInit] = oauthFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect((oauthInit.body as URLSearchParams).get("grant_type")).toBe("refresh_token");
    expect(authorizationHeaders(providerFetch)).toEqual(["Bearer stale-access-token", "Bearer fresh-access-token"]);
    expect(JSON.parse(secrets.getSecret(OAUTH_ACCOUNT)!)).toMatchObject({ accessToken: "fresh-access-token" });

    const records = usageRecords(storage);
    expect(records.map((record) => [record.transportAttemptIndex, record.terminalOutcome])).toEqual([
      [0, "failed_before_usage"],
      [1, "succeeded"],
    ]);
    expect(completion.modelUsageEventIds).toEqual(records.map((record) => record.eventId));
  });

  it("recovers a streamed Codex turn before any chunk is emitted", async () => {
    const secrets = createMemorySecretStore();
    const oauthFetch = vi.fn(async () => tokenResponse("fresh-access-token"));
    const { service } = createHarness(secrets, oauthFetch);
    const providerFetch = stubProviderFetch([unauthorized(TOKEN_EXPIRED_BODY), completedStream("streamed")]);

    const chunks: Record<string, unknown>[] = [];
    for await (const chunk of service.chatCompletionsStream(chatRequest(), attribution("codex-refresh-stream"))) {
      chunks.push(chunk);
    }

    expect(JSON.stringify(chunks)).toContain("streamed");
    expect(oauthFetch).toHaveBeenCalledTimes(1);
    expect(authorizationHeaders(providerFetch)).toEqual(["Bearer stale-access-token", "Bearer fresh-access-token"]);
  });

  it("marks the credential for reconnect and keeps the original 401 when the refresh fails", async () => {
    const secrets = createMemorySecretStore();
    const oauthFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "invalid_grant", error_description: "refresh token revoked" }), {
          status: 400,
        }),
    );
    const { service, storage } = createHarness(secrets, oauthFetch);
    const providerFetch = stubProviderFetch([unauthorized(TOKEN_EXPIRED_BODY)]);

    await expect(service.chatCompletions(chatRequest(), attribution("codex-refresh-failed"))).rejects.toThrow(
      /401 Unauthorized.*token_expired/su,
    );

    expect(oauthFetch).toHaveBeenCalledTimes(1);
    expect(providerFetch).toHaveBeenCalledTimes(1);
    expect(service.getOpenAICodexOAuthStatus()).toMatchObject({ connected: false, requiresReauth: true });
    expect(usageRecords(storage).map((record) => record.terminalOutcome)).toEqual(["failed_before_usage"]);
  });

  it("refreshes only once when the refreshed token is also rejected", async () => {
    const secrets = createMemorySecretStore();
    const oauthFetch = vi.fn(async () => tokenResponse("fresh-access-token"));
    const { service, storage } = createHarness(secrets, oauthFetch);
    const providerFetch = stubProviderFetch([unauthorized(TOKEN_EXPIRED_BODY), unauthorized(TOKEN_EXPIRED_BODY)]);

    await expect(service.chatCompletions(chatRequest(), attribution("codex-refresh-twice"))).rejects.toThrow(
      /token_expired/u,
    );

    expect(oauthFetch).toHaveBeenCalledTimes(1);
    expect(providerFetch).toHaveBeenCalledTimes(2);
    expect(usageRecords(storage).map((record) => record.transportAttemptIndex)).toEqual([0, 1]);
  });

  it("stops waiting on a stalled shared refresh when the caller cancels", async () => {
    const secrets = createMemorySecretStore();
    const oauthFetch = vi.fn(() => new Promise<Response>(() => undefined));
    const { service } = createHarness(secrets, oauthFetch);
    const providerFetch = stubProviderFetch([unauthorized(TOKEN_EXPIRED_BODY)]);
    const controller = new AbortController();

    const pending = service.chatCompletions(
      { ...chatRequest(), signal: controller.signal },
      attribution("codex-refresh-cancelled"),
    );
    await vi.waitFor(() => expect(oauthFetch).toHaveBeenCalledTimes(1));
    controller.abort(new Error("caller cancelled"));

    await expect(pending).rejects.toThrow();
    expect(providerFetch).toHaveBeenCalledTimes(1);
  });

  it("keeps image attempt indexes unique and reports the expired attempt in usage lineage", async () => {
    const secrets = createMemorySecretStore();
    const oauthFetch = vi.fn(async () => tokenResponse("fresh-access-token"));
    const { service, storage } = createHarness(secrets, oauthFetch);
    const providerFetch = stubProviderFetch([unauthorized(TOKEN_EXPIRED_BODY), imageStream(), imageStream()]);

    const response = await service.generateImage(
      { providerId: "openai-codex", model: "gpt-image-2", prompt: "two goats", n: 2 },
      attribution("codex-refresh-image"),
    );

    expect(response.data).toHaveLength(2);
    expect(oauthFetch).toHaveBeenCalledTimes(1);
    expect(providerFetch).toHaveBeenCalledTimes(3);
    const records = usageRecords(storage);
    expect(records.map((record) => [record.transportAttemptIndex, record.terminalOutcome])).toEqual([
      [0, "failed_before_usage"],
      [1, "succeeded"],
      [2, "succeeded"],
    ]);
    expect(response.modelUsageEventIds).toEqual(records.map((record) => record.eventId));
  });

  it("does not refresh on a 401 that is not token_expired", async () => {
    const secrets = createMemorySecretStore();
    const oauthFetch = vi.fn(async () => tokenResponse("fresh-access-token"));
    const { service } = createHarness(secrets, oauthFetch);
    const providerFetch = stubProviderFetch([
      unauthorized(JSON.stringify({ error: { message: "bad key", code: "invalid_api_key" } })),
    ]);

    await expect(service.chatCompletions(chatRequest(), attribution("codex-other-401"))).rejects.toThrow(
      /invalid_api_key/u,
    );

    expect(oauthFetch).not.toHaveBeenCalled();
    expect(providerFetch).toHaveBeenCalledTimes(1);
    expect(service.getOpenAICodexOAuthStatus()).toMatchObject({ connected: true });
  });
});

function createHarness(
  secretStore: SecretStoreService,
  oauthFetch: (...args: unknown[]) => Promise<Response>,
): { service: LlmService; storage: Storage } {
  const root = path.join(os.tmpdir(), `goatcitadel-codex-refresh-${randomUUID()}`);
  fs.mkdirSync(root, { recursive: true });
  roots.push(root);
  const storage = new Storage({
    dbPath: path.join(root, "storage.db"),
    transcriptsDir: path.join(root, "transcripts"),
    auditDir: path.join(root, "audit"),
  });
  storages.push(storage);
  const accounting = new ModelUsageAccountingService(
    storage.modelUsageEvents,
    `gateway-test-${randomUUID()}`,
    60_000,
    60_000,
  );
  return {
    storage,
    service: new LlmService(
      codexConfig(),
      {},
      {
        secretStore,
        modelUsageAccounting: accounting,
        openAICodexOAuthFetch: oauthFetch as unknown as typeof fetch,
      },
    ),
  };
}

function codexConfig(): LlmConfigFile {
  return {
    activeProviderId: "openai-codex",
    activeModel: "gpt-5.5",
    providers: [
      {
        providerId: "openai-codex",
        label: "OpenAI Codex",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        apiStyle: "openai-codex-responses",
        defaultModel: "gpt-5.5",
        authMode: "codex-oauth",
      },
    ],
  };
}

function chatRequest() {
  return {
    providerId: "openai-codex",
    model: "gpt-5.5",
    messages: [{ role: "user" as const, content: "hello" }],
  };
}

function attribution(operationId: string): ModelUsageAttributionContext {
  return {
    operationId,
    dispatchGeneration: `${operationId}:generation-1`,
    workspaceId: WORKSPACE_ID,
    sessionId: "session-codex-refresh-test",
    turnId: "turn-codex-refresh-test",
  };
}

/** The stored expiry is hours away, as in the live incident: only the upstream 401 says otherwise. */
function createMemorySecretStore(): SecretStoreService {
  const secrets = new Map<string, string>([
    [
      OAUTH_ACCOUNT,
      JSON.stringify({
        accessToken: "stale-access-token",
        refreshToken: "codex-refresh-token",
        expiresAt: Date.now() + 6 * 60 * 60_000,
        updatedAt: Date.now(),
      }),
    ],
  ]);
  return {
    isAvailable: () => true,
    setProviderApiKey: () => undefined,
    getProviderApiKey: () => undefined,
    deleteProviderApiKey: () => undefined,
    setSecret: (account: string, secret: string) => {
      secrets.set(account, secret);
    },
    getSecret: (account: string) => secrets.get(account),
    deleteSecret: (account: string) => {
      secrets.delete(account);
    },
    status: (providerId: string) => ({ providerId, hasSecret: false, source: "none" }),
  } as unknown as SecretStoreService;
}

function stubProviderFetch(responses: Response[]) {
  const queue = [...responses];
  const providerFetch = vi.fn(async () => {
    const next = queue.shift();
    if (!next) throw new Error("unexpected extra provider request");
    return next;
  });
  vi.stubGlobal("fetch", providerFetch as unknown as typeof fetch);
  return providerFetch;
}

function authorizationHeaders(providerFetch: ReturnType<typeof vi.fn>): string[] {
  return providerFetch.mock.calls.map(([, init]) => new Headers((init as RequestInit).headers).get("authorization")!);
}

function tokenResponse(accessToken: string): Response {
  return new Response(JSON.stringify({ access_token: accessToken, expires_in: 3600 }), { status: 200 });
}

function unauthorized(body: string): Response {
  return new Response(body, {
    status: 401,
    statusText: "Unauthorized",
    headers: { "content-type": "application/json" },
  });
}

function completedStream(text: string): Response {
  return new Response(
    [
      `data: {"type":"response.output_text.delta","delta":"${text}","response_id":"resp_codex_refresh"}`,
      "",
      `data: {"type":"response.completed","response":{"id":"resp_codex_refresh","model":"gpt-5.5","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"${text}"}]}],"usage":{"input_tokens":11,"output_tokens":2,"total_tokens":13}}}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n"),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function imageStream(): Response {
  return new Response(
    [
      'data: {"type":"response.output_item.done","item":{"type":"image_generation_call","result":"aW1hZ2U="}}',
      'data: {"type":"response.completed","response":{"model":"gpt-image-2","output":[],"usage":{"input_tokens":10,"output_tokens":2}}}',
      "data: [DONE]",
      "",
    ].join("\n\n"),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function usageRecords(storage: Storage) {
  return storage.modelUsageEvents
    .list({ workspaceId: WORKSPACE_ID })
    .items.slice()
    .sort((left, right) => left.transportAttemptIndex - right.transportAttemptIndex);
}
