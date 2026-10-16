import { createVerify, generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GOOGLE_CHAT_BOT_SCOPE,
  GOOGLE_CHAT_MESSAGE_NAME_PATTERN,
  deleteGoogleChatAppMessage,
  getGoogleChatAccessToken,
  readGoogleChatMessageThread,
  resetGoogleChatAccessTokenCache,
  sendGoogleChatAppMessage,
} from "./google-chat-service-account.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const NOW_MS = Date.UTC(2026, 9, 16, 12, 0, 0);

function keyJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "service_account",
    client_email: "goatcitadel-chat@example-project.iam.gserviceaccount.com",
    private_key_id: "key-id-1",
    private_key: PRIVATE_PEM,
    token_uri: "https://oauth2.googleapis.com/token",
    ...overrides,
  });
}

function tokenResponse(accessToken = "ya29.test-token", expiresIn = 3600): Response {
  return new Response(JSON.stringify({ access_token: accessToken, expires_in: expiresIn, token_type: "Bearer" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("getGoogleChatAccessToken", () => {
  afterEach(() => {
    resetGoogleChatAccessTokenCache();
  });

  it("posts a signed jwt-bearer grant for the chat.bot scope and caches the token", async () => {
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) => tokenResponse());

    await expect(getGoogleChatAccessToken(keyJson(), fetcher, () => NOW_MS)).resolves.toBe("ya29.test-token");
    await expect(getGoogleChatAccessToken(keyJson(), fetcher, () => NOW_MS + 60_000)).resolves.toBe("ya29.test-token");
    expect(fetcher).toHaveBeenCalledTimes(1);

    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://oauth2.googleapis.com/token");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("content-type")).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(String(init.body));
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const assertion = form.get("assertion") ?? "";
    const [header, payload, signature] = assertion.split(".");
    expect(JSON.parse(Buffer.from(header ?? "", "base64url").toString("utf8"))).toMatchObject({
      alg: "RS256",
      typ: "JWT",
      kid: "key-id-1",
    });
    expect(JSON.parse(Buffer.from(payload ?? "", "base64url").toString("utf8"))).toEqual({
      iss: "goatcitadel-chat@example-project.iam.gserviceaccount.com",
      scope: GOOGLE_CHAT_BOT_SCOPE,
      aud: "https://oauth2.googleapis.com/token",
      iat: NOW_MS / 1000,
      exp: NOW_MS / 1000 + 3600,
    });
    const verified = createVerify("RSA-SHA256")
      .update(`${header}.${payload}`)
      .verify(publicKey, Buffer.from(signature ?? "", "base64url"));
    expect(verified).toBe(true);
  });

  it("refreshes the token once it is within 60 seconds of expiry", async () => {
    const fetcher = vi
      .fn(async (_url: string, _init: RequestInit) => tokenResponse("second"))
      .mockResolvedValueOnce(tokenResponse("first", 300));

    await expect(getGoogleChatAccessToken(keyJson(), fetcher, () => NOW_MS)).resolves.toBe("first");
    await expect(getGoogleChatAccessToken(keyJson(), fetcher, () => NOW_MS + 239_000)).resolves.toBe("first");
    await expect(getGoogleChatAccessToken(keyJson(), fetcher, () => NOW_MS + 241_000)).resolves.toBe("second");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("defaults the token audience when the key has no token_uri", async () => {
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) => tokenResponse());
    await getGoogleChatAccessToken(keyJson({ token_uri: undefined }), fetcher, () => NOW_MS);
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://oauth2.googleapis.com/token");
  });

  it("throws a key-free error for malformed key JSON and never fetches", async () => {
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) => tokenResponse());
    for (const bad of [
      "not json",
      JSON.stringify({ client_email: "x@example.com" }),
      keyJson({ private_key: "-----BEGIN PRIVATE KEY-----\nAAAA-secret-material\n-----END PRIVATE KEY-----\n" }),
    ]) {
      const error = await getGoogleChatAccessToken(bad, fetcher, () => NOW_MS).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("Google Chat service-account key is malformed");
      expect((error as Error).message).not.toContain("secret-material");
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reports a failed token exchange by status only", async () => {
    const fetcher = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(JSON.stringify({ error: "invalid_grant", error_description: "leaky detail" }), { status: 400 }),
    );
    await expect(getGoogleChatAccessToken(keyJson(), fetcher, () => NOW_MS)).rejects.toThrow(
      /^Google Chat service-account token request failed \(400\)$/,
    );
  });

  it("drains a failed token response body before throwing", async () => {
    const failed = new Response("upstream error", { status: 503 });
    await expect(
      getGoogleChatAccessToken(
        keyJson(),
        async () => failed,
        () => NOW_MS,
      ),
    ).rejects.toThrow(/token request failed \(503\)/);
    expect(failed.bodyUsed).toBe(true);
  });

  it("exposes the message resource-name pattern used to gate unsend", () => {
    expect(GOOGLE_CHAT_MESSAGE_NAME_PATTERN.test("spaces/S/messages/M")).toBe(true);
    expect(GOOGLE_CHAT_MESSAGE_NAME_PATTERN.test("spaces/S/messages/M/extra")).toBe(false);
    expect(GOOGLE_CHAT_MESSAGE_NAME_PATTERN.test("../spaces/S/messages/M")).toBe(false);
  });
});

describe("Google Chat service-account bounded response reads", () => {
  afterEach(() => {
    resetGoogleChatAccessTokenCache();
  });

  const tokenFetch = vi.fn(async () => tokenResponse());

  it("rejects an oversized token response instead of buffering it", async () => {
    const oversized = new Response(JSON.stringify({ access_token: "t", padding: "x".repeat(70 * 1024) }), {
      status: 200,
    });
    await expect(
      getGoogleChatAccessToken(
        keyJson(),
        async () => oversized,
        () => NOW_MS,
      ),
    ).rejects.toThrow(/exceeded 65536 bytes/);
  });

  it("treats an unparseable token body as an invalid token response", async () => {
    await expect(
      getGoogleChatAccessToken(
        keyJson(),
        async () => new Response("not json", { status: 200 }),
        () => NOW_MS,
      ),
    ).rejects.toThrow("Google Chat service-account token response is invalid");
  });

  it("reads the sent message name, fails closed on an oversized send response, and drains failures", async () => {
    const send = (apiFetch: (url: string, init: RequestInit) => Promise<Response>) =>
      sendGoogleChatAppMessage({ keyJson: keyJson(), space: "spaces/S", body: { text: "hi" }, tokenFetch, apiFetch });
    await expect(send(async () => new Response(JSON.stringify({ name: "spaces/S/messages/M" })))).resolves.toBe(
      "spaces/S/messages/M",
    );
    await expect(
      send(async () => new Response(JSON.stringify({ name: "spaces/S/messages/M", pad: "x".repeat(70 * 1024) }))),
    ).rejects.toThrow(/exceeded 65536 bytes/);
    await expect(send(async () => new Response("denied", { status: 403 }))).rejects.toThrow(
      /^google-chat\.send failed \(403\)$/,
    );
  });

  it("deletes and reads threads without buffering unneeded bodies", async () => {
    const input = { keyJson: keyJson(), messageName: "spaces/S/messages/M", tokenFetch };
    await expect(
      deleteGoogleChatAppMessage({ ...input, apiFetch: async () => new Response("{}", { status: 200 }) }),
    ).resolves.toBe("spaces/S/messages/M");
    await expect(
      deleteGoogleChatAppMessage({ ...input, apiFetch: async () => new Response("gone", { status: 404 }) }),
    ).rejects.toThrow(/^google-chat\.unsend failed \(404\)$/);
    await expect(
      readGoogleChatMessageThread({
        ...input,
        apiFetch: async () => new Response(JSON.stringify({ thread: { name: "spaces/S/threads/T" } })),
      }),
    ).resolves.toBe("spaces/S/threads/T");
    const missing = new Response("nope", { status: 404 });
    await expect(readGoogleChatMessageThread({ ...input, apiFetch: async () => missing })).rejects.toThrow(
      /^google-chat\.send could not read the reply message thread \(404\)$/,
    );
    expect(missing.bodyUsed).toBe(true);
    await expect(
      readGoogleChatMessageThread({ ...input, apiFetch: async () => new Response(JSON.stringify({ thread: {} })) }),
    ).rejects.toThrow(/could not resolve the reply message thread/);
  });
});
