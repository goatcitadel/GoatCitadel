import { describe, expect, it, vi } from "vitest";

import {
  SESSION_CONTROL_CLIENT_INSTANCE_HEADER,
  SESSION_CONTROL_GENERATION_HEADER,
  SESSION_CONTROL_TOKEN_HEADER,
} from "@goatcitadel/contracts";

import { ApiRequestError } from "./http-internal.js";
import {
  buildSessionControlSecretHeaders,
  createSessionControlClient,
  type SessionControlAuthorize,
  type SessionControlSignableRequest,
} from "./session-control.js";

// A distinctive plaintext control secret. Every test asserts this exact string
// never appears in a URL, query string, or request body — only in the frozen
// `X-GoatCitadel-Session-Control-Token` header value.
const SECRET = "control-secret-DO-NOT-LEAK-0123456789abcdef0123456789abcdef00";
const NEW_SECRET_HASH = "b".repeat(64);
const BASE_URL = "http://127.0.0.1:8787";
const CLIENT_INSTANCE = "cli-instance-01";

interface RecordedCall {
  readonly url: string;
  readonly init: RequestInit;
}

function headerValue(headers: HeadersInit | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers as Record<string, string>)) {
    if (key.toLowerCase() === target) return value;
  }
  return undefined;
}

function bodyString(init: RequestInit): string {
  return typeof init.body === "string" ? init.body : init.body ? String(init.body) : "";
}

function makeClient(
  options: {
    response?: { status?: number; body?: unknown; text?: string };
    authorize?: SessionControlAuthorize;
    clientInstanceId?: string | undefined;
  } = {},
) {
  const calls: RecordedCall[] = [];
  const authorizeCalls: SessionControlSignableRequest[] = [];
  const status = options.response?.status ?? 200;
  const text = options.response?.text ?? JSON.stringify(options.response?.body ?? { ok: true });
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(text, { status });
  });
  const authorize: SessionControlAuthorize =
    options.authorize ??
    ((request) => {
      authorizeCalls.push(request);
      return { Authorization: "Bearer companion-access-token" };
    });
  const client = createSessionControlClient({
    baseUrl: BASE_URL,
    fetch: fetchImpl as unknown as typeof fetch,
    authorize,
    clientInstanceId: "clientInstanceId" in options ? options.clientInstanceId : CLIENT_INSTANCE,
  });
  return { client, calls, authorizeCalls, fetchImpl };
}

function assertSecretAbsentFromWire(calls: RecordedCall[]): void {
  for (const call of calls) {
    expect(call.url).not.toContain(SECRET);
    expect(new URL(call.url).search).not.toContain(SECRET);
    expect(bodyString(call.init)).not.toContain(SECRET);
  }
}

describe("buildSessionControlSecretHeaders", () => {
  it("places the plaintext secret ONLY in the frozen token header", () => {
    const headers = buildSessionControlSecretHeaders({
      clientInstanceId: CLIENT_INSTANCE,
      generation: 4,
      controlSecret: SECRET,
    });
    const carriers = Object.entries(headers)
      .filter(([, value]) => value === SECRET)
      .map(([key]) => key);
    expect(carriers).toEqual([SESSION_CONTROL_TOKEN_HEADER]);
    expect(headerValue(headers, SESSION_CONTROL_CLIENT_INSTANCE_HEADER)).toBe(CLIENT_INSTANCE);
    expect(headerValue(headers, SESSION_CONTROL_GENERATION_HEADER)).toBe("4");
  });

  it("omits headers for absent inputs and never emits an empty token header", () => {
    const headers = buildSessionControlSecretHeaders({ clientInstanceId: CLIENT_INSTANCE });
    expect(headerValue(headers, SESSION_CONTROL_TOKEN_HEADER)).toBeUndefined();
    expect(headerValue(headers, SESSION_CONTROL_GENERATION_HEADER)).toBeUndefined();
    expect(headerValue(headers, SESSION_CONTROL_CLIENT_INSTANCE_HEADER)).toBe(CLIENT_INSTANCE);
  });

  it("serializes the generation as a canonical positive decimal", () => {
    expect(headerValue(buildSessionControlSecretHeaders({ generation: 12 }), SESSION_CONTROL_GENERATION_HEADER)).toBe(
      "12",
    );
  });

  it("rejects an empty control secret rather than sending a blank token header", () => {
    expect(() => buildSessionControlSecretHeaders({ controlSecret: "" })).toThrow(TypeError);
  });

  it("rejects a non-positive or unsafe generation", () => {
    expect(() => buildSessionControlSecretHeaders({ generation: 0 })).toThrow(TypeError);
    expect(() => buildSessionControlSecretHeaders({ generation: -1 })).toThrow(TypeError);
    expect(() => buildSessionControlSecretHeaders({ generation: 1.5 })).toThrow(TypeError);
  });

  it("rejects a blank client instance id", () => {
    expect(() => buildSessionControlSecretHeaders({ clientInstanceId: "   " })).toThrow(TypeError);
  });
});

describe("createSessionControlClient.createExternalRequest", () => {
  it("POSTs the signed request with only the token hash in the body — never the secret", async () => {
    const { client, calls, authorizeCalls } = makeClient({ response: { body: { request: { requestId: "req-1" } } } });
    const input = {
      expectedGeneration: 1,
      clientInstanceId: CLIENT_INSTANCE,
      tokenHashSha256: "a".repeat(64),
      capabilities: ["send", "read"] as const,
      idempotencyKey: "idem-req-1",
    };
    const result = await client.createExternalRequest("sess-1", input);

    expect(result).toEqual({ request: { requestId: "req-1" } });
    expect(calls).toHaveLength(1);
    const [{ url, init }] = calls;
    expect(init.method).toBe("POST");
    expect(url).toBe(`${BASE_URL}/api/v1/chat/sessions/sess-1/control/requests`);
    // The request registers only the hash; the plaintext secret is not involved.
    expect(headerValue(init.headers, SESSION_CONTROL_TOKEN_HEADER)).toBeUndefined();
    expect(headerValue(init.headers, SESSION_CONTROL_CLIENT_INSTANCE_HEADER)).toBe(CLIENT_INSTANCE);
    expect(headerValue(init.headers, "Idempotency-Key")).toBe("idem-req-1");
    expect(headerValue(init.headers, "Content-Type")).toBe("application/json");
    expect(init.cache).toBe("no-store");
    expect(JSON.parse(bodyString(init))).toEqual(input);
    // The companion signature is produced over the parsed body object.
    expect(authorizeCalls).toHaveLength(1);
    expect(authorizeCalls[0]).toMatchObject({
      method: "POST",
      path: "/api/v1/chat/sessions/sess-1/control/requests",
    });
    assertSecretAbsentFromWire(calls);
  });

  it("encodes path segments and never leaks the secret in the URL", async () => {
    const { client, calls } = makeClient();
    await client.createExternalRequest("a/b?c", {
      expectedGeneration: 1,
      clientInstanceId: CLIENT_INSTANCE,
      tokenHashSha256: "a".repeat(64),
      capabilities: ["send"],
      idempotencyKey: "idem-2",
    });
    expect(calls[0]?.url).toBe(`${BASE_URL}/api/v1/chat/sessions/a%2Fb%3Fc/control/requests`);
  });
});

describe("createSessionControlClient.getControl", () => {
  it("GETs the content-free status with the client-instance header and no body/secret", async () => {
    const detail = { control: { ownerKind: "operator", generation: 1 }, pendingRequests: [] };
    const { client, calls, authorizeCalls } = makeClient({ response: { body: detail } });
    const result = await client.getControl("sess-1");

    expect(result).toEqual(detail);
    const [{ url, init }] = calls;
    expect(init.method ?? "GET").toBe("GET");
    expect(url).toBe(`${BASE_URL}/api/v1/chat/sessions/sess-1/control`);
    expect(init.body ?? undefined).toBeUndefined();
    expect(headerValue(init.headers, SESSION_CONTROL_CLIENT_INSTANCE_HEADER)).toBe(CLIENT_INSTANCE);
    expect(headerValue(init.headers, SESSION_CONTROL_TOKEN_HEADER)).toBeUndefined();
    expect(headerValue(init.headers, "Idempotency-Key")).toBeUndefined();
    expect(init.cache).toBe("no-store");
    // A GET read is not a signed mutation.
    expect(authorizeCalls[0]).toMatchObject({ method: "GET", body: undefined });
    assertSecretAbsentFromWire(calls);
  });
});

describe("createSessionControlClient.heartbeat", () => {
  it("carries the plaintext secret only in the token header, generation in the header + body", async () => {
    const { client, calls } = makeClient({ response: { body: { generation: 2, control: {} } } });
    const input = { expectedGeneration: 2, idempotencyKey: "idem-hb" };
    await client.heartbeat("sess-1", input, SECRET);

    const [{ url, init }] = calls;
    expect(init.method).toBe("POST");
    expect(url).toBe(`${BASE_URL}/api/v1/chat/sessions/sess-1/control/heartbeat`);
    expect(headerValue(init.headers, SESSION_CONTROL_TOKEN_HEADER)).toBe(SECRET);
    expect(headerValue(init.headers, SESSION_CONTROL_GENERATION_HEADER)).toBe("2");
    expect(headerValue(init.headers, SESSION_CONTROL_CLIENT_INSTANCE_HEADER)).toBe(CLIENT_INSTANCE);
    expect(headerValue(init.headers, "Idempotency-Key")).toBe("idem-hb");
    expect(JSON.parse(bodyString(init))).toEqual(input);
    assertSecretAbsentFromWire(calls);
  });
});

describe("createSessionControlClient.reconnect", () => {
  it("presents the OLD secret in the token header while the body carries only the new token hash", async () => {
    const { client, calls } = makeClient({ response: { body: { supersededGeneration: 2, control: {} } } });
    const input = { expectedGeneration: 2, newTokenHashSha256: NEW_SECRET_HASH, idempotencyKey: "idem-rc" };
    await client.reconnect("sess-1", input, SECRET);

    const [{ url, init }] = calls;
    expect(url).toBe(`${BASE_URL}/api/v1/chat/sessions/sess-1/control/reconnect`);
    expect(headerValue(init.headers, SESSION_CONTROL_TOKEN_HEADER)).toBe(SECRET);
    expect(headerValue(init.headers, SESSION_CONTROL_GENERATION_HEADER)).toBe("2");
    const parsedBody = JSON.parse(bodyString(init));
    expect(parsedBody).toEqual(input);
    expect(parsedBody.newTokenHashSha256).toBe(NEW_SECRET_HASH);
    assertSecretAbsentFromWire(calls);
  });
});

describe("createSessionControlClient.release", () => {
  it("presents the secret in the token header and returns to operator", async () => {
    const { client, calls } = makeClient({ response: { body: { releasedGeneration: 2, control: {} } } });
    const input = { expectedGeneration: 2, idempotencyKey: "idem-rel" };
    await client.release("sess-1", input, SECRET);

    const [{ url, init }] = calls;
    expect(url).toBe(`${BASE_URL}/api/v1/chat/sessions/sess-1/control/release`);
    expect(headerValue(init.headers, SESSION_CONTROL_TOKEN_HEADER)).toBe(SECRET);
    expect(headerValue(init.headers, "Idempotency-Key")).toBe("idem-rel");
    assertSecretAbsentFromWire(calls);
  });
});

describe("createSessionControlClient.openEventStream", () => {
  it("opens a read-only cursor-resumed stream with no secret in the URL or headers", async () => {
    const { client, calls, authorizeCalls } = makeClient({ response: { text: "" } });
    const response = await client.openEventStream("sess-1", { afterCursor: 42, clientId: "reader-1" });
    expect(response).toBeInstanceOf(Response);

    const [{ url, init }] = calls;
    expect(init.method ?? "GET").toBe("GET");
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/api/v1/chat/sessions/sess-1/control/events/stream");
    expect(parsed.searchParams.get("afterCursor")).toBe("42");
    expect(parsed.searchParams.get("clientId")).toBe("reader-1");
    expect(headerValue(init.headers, SESSION_CONTROL_CLIENT_INSTANCE_HEADER)).toBe(CLIENT_INSTANCE);
    expect(headerValue(init.headers, SESSION_CONTROL_TOKEN_HEADER)).toBeUndefined();
    expect(authorizeCalls[0]).toMatchObject({ method: "GET" });
    assertSecretAbsentFromWire(calls);
  });
});

describe("createSessionControlClient error mapping", () => {
  it("maps a non-2xx response to a typed ApiRequestError with the parsed body", async () => {
    const { client } = makeClient({
      response: {
        status: 409,
        text: JSON.stringify({ error: { code: "STATE_CONFLICT", sessionControlCode: "SESSION_CONTROL_STALE" } }),
      },
    });
    const error = await client
      .heartbeat("sess-1", { expectedGeneration: 2, idempotencyKey: "idem" }, SECRET)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect((error as ApiRequestError).status).toBe(409);
    expect((error as ApiRequestError).method).toBe("POST");
    expect((error as ApiRequestError).path).toBe("/api/v1/chat/sessions/sess-1/control/heartbeat");
  });

  it("never includes the plaintext secret in a thrown error", async () => {
    const { client } = makeClient({ response: { status: 500, text: "server exploded" } });
    const error = (await client
      .release("sess-1", { expectedGeneration: 2, idempotencyKey: "idem" }, SECRET)
      .catch((caught: unknown) => caught)) as ApiRequestError;
    expect(JSON.stringify({ message: error.message, body: error.body, bodyText: error.bodyText })).not.toContain(
      SECRET,
    );
  });
});
