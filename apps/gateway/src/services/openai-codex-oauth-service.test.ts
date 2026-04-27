import { createServer } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SecretStoreService } from "./secret-store-service.js";
import { OpenAICodexOAuthService } from "./openai-codex-oauth-service.js";

describe("OpenAICodexOAuthService", () => {
  let service: OpenAICodexOAuthService | null = null;

  afterEach(() => {
    service?.close();
    service = null;
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
