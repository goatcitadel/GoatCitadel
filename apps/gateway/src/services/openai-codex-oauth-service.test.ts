import { createServer } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SecretStoreService } from "./secret-store-service.js";
import { OpenAICodexOAuthService } from "./openai-codex-oauth-service.js";

describe("OpenAICodexOAuthService", () => {
  let service: OpenAICodexOAuthService | null = null;

  afterEach(() => {
    service?.close();
    service = null;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("starts the current OpenAI Codex browser OAuth flow instead of the retired device-code endpoints", async () => {
    const port = await getFreePort();
    const fetchMock = vi.fn();
    service = new OpenAICodexOAuthService(createMemorySecretStore(), fetchMock as unknown as typeof fetch, {
      port,
      redirectUri: `http://localhost:${port}/auth/callback`,
    });

    const flow = await service.startDeviceFlow();
    const authorizationUrl = new URL(flow.verificationUrl);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(flow.userCode).toBeUndefined();
    expect(authorizationUrl.origin).toBe("https://auth.openai.com");
    expect(authorizationUrl.pathname).toBe("/oauth/authorize");
    expect(authorizationUrl.searchParams.get("response_type")).toBe("code");
    expect(authorizationUrl.searchParams.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(`http://localhost:${port}/auth/callback`);
    expect(authorizationUrl.searchParams.get("scope")).toBe("openid profile email offline_access");
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizationUrl.searchParams.get("codex_cli_simplified_flow")).toBe("true");
    expect(authorizationUrl.searchParams.get("originator")).toBe("pi");
  });

  it("exchanges the localhost OAuth callback code and persists the ChatGPT OAuth credential", async () => {
    const port = await getFreePort();
    const secretStore = createMemorySecretStore();
    const accessToken = createJwt({
      exp: Math.trunc(Date.now() / 1000) + 3600,
      "https://api.openai.com/profile": { email: "user@example.com" },
      "https://api.openai.com/auth": { chatgpt_account_id: "account-1" },
    });
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            access_token: accessToken,
            refresh_token: "refresh-token",
            expires_in: 3600,
          }),
          { status: 200 },
        ),
    );
    service = new OpenAICodexOAuthService(secretStore, fetchMock as unknown as typeof fetch, {
      port,
      redirectUri: `http://localhost:${port}/auth/callback`,
    });

    const flow = await service.startDeviceFlow();
    const authorizationUrl = new URL(flow.verificationUrl);
    const state = authorizationUrl.searchParams.get("state");
    expect(state).toBeTruthy();

    const callbackResponse = await fetch(`http://127.0.0.1:${port}/auth/callback?state=${state}&code=auth-code`);
    expect(callbackResponse.status).toBe(200);

    const poll = await service.pollDeviceFlow(flow.flowId);

    expect(poll).toMatchObject({
      flowId: flow.flowId,
      providerId: "openai-codex",
      status: "connected",
      accountLabel: "user@example.com",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [tokenUrl, tokenInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(tokenUrl).toBe("https://auth.openai.com/oauth/token");
    expect(tokenInit.method).toBe("POST");
    const body = tokenInit.body as URLSearchParams;
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("auth-code");
    expect(body.get("redirect_uri")).toBe(`http://localhost:${port}/auth/callback`);
    expect(body.get("code_verifier")).toBeTruthy();
    expect(service.getStatus()).toMatchObject({
      providerId: "openai-codex",
      connected: true,
      accountLabel: "user@example.com",
    });
  });

  it("keeps plan-bound OAuth credentials staged until exact promotion", async () => {
    const port = await getFreePort();
    const secretStore = createMemorySecretStore();
    const temporaryAccount = "evolution:provider-oauth:plan-1:openai-codex";
    const accessToken = createJwt({
      exp: Math.trunc(Date.now() / 1000) + 3600,
      "https://api.openai.com/profile": { email: "staged@example.com" },
    });
    service = new OpenAICodexOAuthService(
      secretStore,
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              access_token: accessToken,
              refresh_token: "refresh-plan-1",
              expires_in: 3600,
            }),
            { status: 200 },
          ),
      ) as unknown as typeof fetch,
      { port, redirectUri: `http://localhost:${port}/auth/callback` },
    );

    const flow = await service.startDeviceFlow({
      credentialAccount: temporaryAccount,
      idempotencyKey: "plan-1:revision-2:action-3",
    });
    await expect(
      service.startDeviceFlow({
        credentialAccount: temporaryAccount,
        idempotencyKey: "plan-1:revision-2:action-3",
      }),
    ).resolves.toEqual(flow);
    const state = new URL(flow.verificationUrl).searchParams.get("state");
    await fetch(`http://127.0.0.1:${port}/auth/callback?state=${state}&code=staged-code`);

    await expect(
      service.pollDeviceFlow(flow.flowId, {
        expectedCredentialAccount: "evolution:provider-oauth:another-plan:openai-codex",
      }),
    ).rejects.toMatchObject({ code: "WRITE_CONFLICT" });
    await expect(
      service.pollDeviceFlow(flow.flowId, {
        expectedCredentialAccount: temporaryAccount,
      }),
    ).resolves.toMatchObject({ status: "connected", accountLabel: "staged@example.com" });

    expect(service.getStatus()).toMatchObject({ connected: false });
    expect(service.getStatus(temporaryAccount)).toMatchObject({ connected: true, accountLabel: "staged@example.com" });
    expect(service.promoteCredential(temporaryAccount)).toMatchObject({
      connected: true,
      accountLabel: "staged@example.com",
    });
    expect(service.getStatus(temporaryAccount)).toMatchObject({ connected: false });
  });

  it("reports pending, callback-denied, missing-code, missing-flow, and expired flow states", async () => {
    const port = await getFreePort();
    const secretStore = createMemorySecretStore();
    service = new OpenAICodexOAuthService(secretStore, vi.fn() as unknown as typeof fetch, {
      port,
      redirectUri: `http://localhost:${port}/auth/callback`,
    });

    const flow = await service.startDeviceFlow();
    const state = new URL(flow.verificationUrl).searchParams.get("state");
    expect(await service.pollDeviceFlow(flow.flowId)).toMatchObject({
      status: "pending",
      retryAfterMs: expect.any(Number),
    });
    expect(await fetch(`http://127.0.0.1:${port}/missing?state=${state}&code=auth-code`)).toMatchObject({
      status: 404,
    });
    expect(await fetch(`http://127.0.0.1:${port}/auth/callback?state=unknown&code=auth-code`)).toMatchObject({
      status: 400,
    });

    const missingCodeResponse = await fetch(`http://127.0.0.1:${port}/auth/callback?state=${state}`);
    expect(missingCodeResponse.status).toBe(400);
    expect(await service.pollDeviceFlow(flow.flowId)).toMatchObject({
      status: "failed",
      error: "OpenAI callback did not include an authorization code.",
      requiresReauth: true,
    });

    const deniedFlow = await service.startDeviceFlow();
    const deniedState = new URL(deniedFlow.verificationUrl).searchParams.get("state");
    const deniedResponse = await fetch(
      `http://127.0.0.1:${port}/auth/callback?state=${deniedState}&error=access_denied&error_description=Nope`,
    );
    expect(deniedResponse.status).toBe(400);
    expect(await service.pollDeviceFlow(deniedFlow.flowId)).toMatchObject({
      status: "failed",
      error: "access_denied: Nope",
      requiresReauth: true,
    });

    const expiredFlow = await service.startDeviceFlow();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(expiredFlow.expiresAt).getTime() + 1);
    expect(await service.pollDeviceFlow(expiredFlow.flowId)).toMatchObject({
      status: "expired",
      requiresReauth: true,
    });
  });

  it("clears pending OAuth flows when the service is closed", async () => {
    const port = await getFreePort();
    service = new OpenAICodexOAuthService(createMemorySecretStore(), vi.fn() as unknown as typeof fetch, {
      port,
      redirectUri: `http://localhost:${port}/auth/callback`,
    });

    const flow = await service.startDeviceFlow();
    service.close();

    await expect(service.pollDeviceFlow(flow.flowId)).resolves.toMatchObject({
      status: "expired",
      requiresReauth: true,
    });
  });

  it("refreshes near-expired credentials and marks reauth when refresh fails", async () => {
    const secretStore = createMemorySecretStore();
    const staleToken = createJwt({ exp: Math.trunc(Date.now() / 1000) + 1, sub: "stale-user" });
    secretStore.setSecret(
      "provider:openai-codex:oauth",
      JSON.stringify({
        accessToken: staleToken,
        refreshToken: "refresh-token",
        expiresAt: Date.now() + 1,
        updatedAt: Date.now(),
      }),
    );
    const freshToken = createJwt({
      exp: Math.trunc(Date.now() / 1000) + 7200,
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-refresh" },
    });
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            access_token: freshToken,
            expires_in: "7200",
          }),
          { status: 200 },
        ),
    );
    service = new OpenAICodexOAuthService(secretStore, fetchMock as unknown as typeof fetch);

    await expect(service.resolveAccessToken()).resolves.toBe(freshToken);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.body as URLSearchParams).get("grant_type")).toBe("refresh_token");
    expect(service.getStatus()).toMatchObject({
      connected: true,
      accountLabel: expect.stringMatching(/^chatgpt-/),
    });

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "invalid_grant", error_description: "expired refresh" }), {
        status: 400,
      }),
    );
    secretStore.setSecret(
      "provider:openai-codex:oauth",
      JSON.stringify({
        accessToken: staleToken,
        refreshToken: "refresh-token",
        expiresAt: Date.now() + 1,
        updatedAt: Date.now(),
      }),
    );

    await expect(service.resolveAccessToken()).rejects.toThrow("token refresh failed");
    expect(service.getStatus()).toMatchObject({
      connected: false,
      requiresReauth: true,
    });
  });

  it("surfaces token exchange response errors and invalid successful payloads", async () => {
    const port = await getFreePort();
    const secretStore = createMemorySecretStore();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(" plain text failure with   extra whitespace ", {
          status: 502,
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "missing-refresh" }), { status: 200 }));
    service = new OpenAICodexOAuthService(secretStore, fetchMock as unknown as typeof fetch, {
      port,
      redirectUri: `http://localhost:${port}/auth/callback`,
    });

    const failedFlow = await service.startDeviceFlow();
    const failedState = new URL(failedFlow.verificationUrl).searchParams.get("state");
    expect(await fetch(`http://127.0.0.1:${port}/auth/callback?state=${failedState}&code=bad-code`)).toMatchObject({
      status: 200,
    });
    expect(await service.pollDeviceFlow(failedFlow.flowId)).toMatchObject({
      status: "failed",
      error: expect.stringContaining("HTTP 502 plain text failure with extra whitespace"),
    });

    const invalidPayloadFlow = await service.startDeviceFlow();
    const invalidState = new URL(invalidPayloadFlow.verificationUrl).searchParams.get("state");
    expect(
      await fetch(`http://127.0.0.1:${port}/auth/callback?state=${invalidState}&code=invalid-payload`),
    ).toMatchObject({ status: 200 });
    expect(await service.pollDeviceFlow(invalidPayloadFlow.flowId)).toMatchObject({
      status: "failed",
      error: "OpenAI Codex token exchange succeeded but did not return OAuth tokens.",
    });
  });

  it("handles unavailable or malformed stored credentials and deletion", async () => {
    const secretStore = createMemorySecretStore();
    secretStore.setSecret("provider:openai-codex:oauth", "{bad json");
    service = new OpenAICodexOAuthService(secretStore);

    expect(service.getStatus()).toMatchObject({
      available: true,
      connected: false,
    });
    expect(() => service.deleteCredential()).not.toThrow();
    expect(service.getStatus()).toMatchObject({ connected: false });

    const unavailable = createMemorySecretStore();
    unavailable.isAvailable = () => false;
    service.close();
    service = new OpenAICodexOAuthService(unavailable);

    expect(service.getStatus()).toMatchObject({
      available: false,
      connected: false,
    });
    await expect(service.startDeviceFlow()).rejects.toThrow("OS keychain backend is required");
  });

  it("reports disconnected credentials and tolerates keychain read failures", async () => {
    const missing = new OpenAICodexOAuthService(createMemorySecretStore());
    service = missing;
    await expect(service.resolveAccessToken()).rejects.toThrow(
      "OpenAI Codex OAuth is not connected. Connect ChatGPT OAuth in Settings first.",
    );

    const reauthStore = createMemorySecretStore();
    reauthStore.setSecret(
      "provider:openai-codex:oauth",
      JSON.stringify({
        accessToken: "access-token",
        refreshToken: "refresh-token",
        requiresReauth: true,
        updatedAt: Date.now(),
      }),
    );
    service = new OpenAICodexOAuthService(reauthStore);
    await expect(service.resolveAccessToken()).rejects.toThrow("OpenAI Codex OAuth is not connected");

    const throwingStore = createMemorySecretStore();
    throwingStore.getSecret = () => {
      throw new Error("keychain read failed");
    };
    service = new OpenAICodexOAuthService(throwingStore);
    expect(service.getStatus()).toMatchObject({
      available: true,
      connected: false,
    });
  });

  it("surfaces callback server bind failures when the OAuth port is already in use", async () => {
    const port = await getFreePort();
    const blocker = createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(port, "127.0.0.1", () => resolve());
    });

    service = new OpenAICodexOAuthService(createMemorySecretStore(), fetch as typeof fetch, {
      port,
      redirectUri: `http://localhost:${port}/auth/callback`,
    });

    try {
      await expect(service.startDeviceFlow()).rejects.toThrow(
        `OpenAI Codex OAuth could not start the local callback server at http://127.0.0.1:${port}/auth/callback`,
      );
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it("handles expired callbacks and token identity fallbacks", async () => {
    const port = await getFreePort();
    const secretStore = createMemorySecretStore();
    const accountToken = createJwt({
      exp: String(Math.trunc(Date.now() / 1000) + 3600),
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-fallback" },
    });
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            access_token: accountToken,
            refresh_token: "refresh-token",
          }),
          { status: 200 },
        ),
    );
    service = new OpenAICodexOAuthService(secretStore, fetchMock as unknown as typeof fetch, {
      port,
      redirectUri: `http://localhost:${port}/auth/callback`,
    });

    const expiredFlow = await service.startDeviceFlow();
    const expiredState = new URL(expiredFlow.verificationUrl).searchParams.get("state");
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(expiredFlow.expiresAt).getTime() + 1);
    const expiredResponse = await fetch(`http://127.0.0.1:${port}/auth/callback?state=${expiredState}&code=late`);
    expect(expiredResponse.status).toBe(400);
    vi.useRealTimers();

    const connectedFlow = await service.startDeviceFlow();
    const state = new URL(connectedFlow.verificationUrl).searchParams.get("state");
    expect(await fetch(`http://127.0.0.1:${port}/auth/callback?state=${state}&code=auth-code`)).toMatchObject({
      status: 200,
    });
    expect(await service.pollDeviceFlow(connectedFlow.flowId)).toMatchObject({
      status: "connected",
      accountLabel: expect.stringMatching(/^chatgpt-/),
      expiresAt: expect.any(String),
    });

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: createJwt({ sub: "subject-only" }),
          refresh_token: "refresh-token",
        }),
        { status: 200 },
      ),
    );
    const subjectFlow = await service.startDeviceFlow();
    const subjectState = new URL(subjectFlow.verificationUrl).searchParams.get("state");
    expect(await fetch(`http://127.0.0.1:${port}/auth/callback?state=${subjectState}&code=subject-code`)).toMatchObject(
      {
        status: 200,
      },
    );
    expect(await service.pollDeviceFlow(subjectFlow.flowId)).toMatchObject({
      status: "connected",
      accountLabel: expect.stringMatching(/^id-/),
    });
  });

  it("covers missing-flow polling, fresh-token reuse, unavailable reads, and refresh payload errors", async () => {
    const missingService = new OpenAICodexOAuthService(createMemorySecretStore());
    service = missingService;
    await expect(service.pollDeviceFlow("missing-flow")).resolves.toMatchObject({
      flowId: "missing-flow",
      status: "expired",
      requiresReauth: true,
    });

    const freshStore = createMemorySecretStore();
    freshStore.setSecret(
      "provider:openai-codex:oauth",
      JSON.stringify({
        accessToken: "fresh-access-token",
        refreshToken: "refresh-token",
        expiresAt: Date.now() + 5 * 60_000,
        updatedAt: Date.now(),
      }),
    );
    const fetchMock = vi.fn();
    service = new OpenAICodexOAuthService(freshStore, fetchMock as unknown as typeof fetch);
    await expect(service.resolveAccessToken()).resolves.toBe("fresh-access-token");
    expect(fetchMock).not.toHaveBeenCalled();

    const unavailableReadStore = createMemorySecretStore();
    unavailableReadStore.getSecret = () => {
      throw new Error("SecretStoreUnavailable: unavailable");
    };
    service = new OpenAICodexOAuthService(unavailableReadStore);
    expect(service.getStatus()).toMatchObject({ connected: false });

    const refreshStore = createMemorySecretStore();
    refreshStore.setSecret(
      "provider:openai-codex:oauth",
      JSON.stringify({
        accessToken: createJwt({ exp: Math.trunc(Date.now() / 1000) + 1 }),
        refreshToken: "refresh-token",
        expiresAt: Date.now() + 1,
        updatedAt: Date.now(),
      }),
    );
    service = new OpenAICodexOAuthService(
      refreshStore,
      vi.fn(
        async () => new Response(JSON.stringify({ refresh_token: "refresh-only" }), { status: 200 }),
      ) as unknown as typeof fetch,
    );
    await expect(service.resolveAccessToken()).rejects.toThrow(
      "OpenAI Codex OAuth token refresh failed. Reconnect ChatGPT OAuth in Settings.",
    );

    const port = await getFreePort();
    const plainErrorFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "invalid_request" }), {
          status: 400,
        }),
    );
    service = new OpenAICodexOAuthService(createMemorySecretStore(), plainErrorFetch as unknown as typeof fetch, {
      port,
      redirectUri: `http://localhost:${port}/auth/callback`,
    });
    const flow = await service.startDeviceFlow();
    const state = new URL(flow.verificationUrl).searchParams.get("state");
    expect(await fetch(`http://127.0.0.1:${port}/auth/callback?state=${state}&code=bad`)).toMatchObject({
      status: 200,
    });
    await expect(service.pollDeviceFlow(flow.flowId)).resolves.toMatchObject({
      status: "failed",
      error: "OpenAI Codex OAuth token exchange failed: invalid_request",
    });

    const numericExpiryToken = createJwt({ exp: Math.trunc(Date.now() / 1000) + 1800 });
    plainErrorFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: numericExpiryToken,
          refresh_token: "refresh-token",
        }),
        { status: 200 },
      ),
    );
    service.close();
    service = new OpenAICodexOAuthService(createMemorySecretStore(), plainErrorFetch as unknown as typeof fetch, {
      port,
      redirectUri: `http://localhost:${port}/auth/callback`,
    });
    const numericFlow = await service.startDeviceFlow();
    const numericState = new URL(numericFlow.verificationUrl).searchParams.get("state");
    expect(await fetch(`http://127.0.0.1:${port}/auth/callback?state=${numericState}&code=numeric`)).toMatchObject({
      status: 200,
    });
    await expect(service.pollDeviceFlow(numericFlow.flowId)).resolves.toMatchObject({
      status: "connected",
    });
    expect(service.getStatus()).toMatchObject({
      connected: true,
      expiresAt: expect.any(String),
    });
  });
});

function createMemorySecretStore(): SecretStoreService {
  const secrets = new Map<string, string>();
  return {
    isAvailable: () => true,
    setProviderApiKey: (providerId: string, apiKey: string) => {
      secrets.set(providerId, apiKey);
    },
    getProviderApiKey: (providerId: string) => secrets.get(providerId),
    deleteProviderApiKey: (providerId: string) => {
      secrets.delete(providerId);
    },
    setSecret: (account: string, secret: string) => {
      secrets.set(account, secret);
    },
    getSecret: (account: string) => secrets.get(account),
    deleteSecret: (account: string) => {
      secrets.delete(account);
    },
    status: (providerId: string) => ({
      providerId,
      hasSecret: secrets.has(providerId),
      source: secrets.has(providerId) ? "keychain" : "none",
    }),
  } as unknown as SecretStoreService;
}

function createJwt(payload: Record<string, unknown>): string {
  return [base64Url(JSON.stringify({ alg: "none", typ: "JWT" })), base64Url(JSON.stringify(payload)), "signature"].join(
    ".",
  );
}

function base64Url(value: string): string {
  return Buffer.from(value).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}
