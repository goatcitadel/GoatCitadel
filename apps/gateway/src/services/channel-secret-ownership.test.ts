import { afterEach, describe, expect, it, vi } from "vitest";
import type { IntegrationConnection } from "@goatcitadel/contracts";
import { createMatrixStreamAdapter } from "./channel-stream-adapters/matrix-stream-adapter.js";
import { createMattermostStreamAdapter } from "./channel-stream-adapters/mattermost-stream-adapter.js";
import { ChannelStreamAuthError, type ChannelStreamRunContext } from "./channel-stream-runtime-service.js";
import { emitProviderTypingWithDeps } from "./channel-typing-adapters.js";
import { GatewayService } from "./gateway-service.js";
import {
  runIntegrationConnectionLiveChecks,
  type IntegrationDiagnosticsPort,
} from "./integration-diagnostics-service.js";
import { runConfiguredMatrixChecks } from "./matrix-live-probes.js";

/**
 * A saved key is read only for the connection that owns it. Every adapter below runs over the Gateway's own shared
 * read (the real `GatewayService.resolveConnectionSecret` over an in-memory key store), so these tests fail if that
 * read, or an adapter's hand-off of its owner to it, stops keeping one connection out of another's key.
 */

const NONCE_MINE = "00000000-0000-4000-8000-0000000000a1";
const NONCE_THEIRS = "00000000-0000-4000-8000-0000000000b1";
const MY_ID = "conn-mine";
const THEIR_ID = "conn-theirs";
const MY_SECRET = "synthetic-key-saved-by-the-reader-0001";
const THEIR_SECRET = "synthetic-key-saved-by-another-connection-0002";
const MY_REFERENCE = `keychain:goatcitadel:channel-connection:${MY_ID}:accessToken:${NONCE_MINE}`;
const THEIR_REFERENCE = `keychain:goatcitadel:channel-connection:${THEIR_ID}:accessToken:${NONCE_THEIRS}`;

const keyStore = new Map<string, string>();
function resetKeyStore(): void {
  keyStore.clear();
  keyStore.set(`channel-connection:${MY_ID}:accessToken:${NONCE_MINE}`, MY_SECRET);
  keyStore.set(`channel-connection:${THEIR_ID}:accessToken:${NONCE_THEIRS}`, THEIR_SECRET);
}

/** The Gateway's shared read, bound to the in-memory key store: the real method on a real prototype. */
const gateway = Object.assign(Object.create(GatewayService.prototype) as GatewayService, {
  secretStore: { getSecret: (account: string) => keyStore.get(account) },
});
const sharedRead = (
  config: Record<string, unknown>,
  directKey: string,
  envKey: string,
  catalogId: string | undefined,
  owner: { connectionId: string; draftId?: string },
) => gateway.resolveConnectionSecret(config, directKey, envKey, catalogId as string, owner);
const readConfigValue = (config: Record<string, unknown>, key: string) =>
  GatewayService.prototype.readConnectionConfigValue.call(gateway, config, key);

function connection(key: string, config: Record<string, unknown>, connectionId = MY_ID): IntegrationConnection {
  return {
    connectionId,
    revision: "r1",
    catalogId: `channel.${key}`,
    kind: "channel",
    key,
    label: key,
    enabled: true,
    status: "connected",
    config,
    createdAt: "2026-10-28T00:00:00.000Z",
    updatedAt: "2026-10-28T00:00:00.000Z",
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Everything a request could carry: its address, headers and body. */
function requestText(call: unknown[]): string {
  const [url, init] = call as [unknown, RequestInit | undefined];
  return `${String(url)} ${JSON.stringify(init?.headers ?? {})} ${String(init?.body ?? "")}`;
}

function probePort(fetcher: ReturnType<typeof vi.fn>): IntegrationDiagnosticsPort {
  return {
    config: { toolPolicy: { tools: { profile: "default" }, sandbox: { networkAllowlist: [] } } },
    fetchWithDiagnosticsTimeout: fetcher,
    getDiscordRuntimeStatus: vi.fn(),
    isConnectionUrlAllowlisted: vi.fn(() => true),
    readConnectionConfigValue: readConfigValue,
    resolveConnectionSecret: sharedRead,
  } as unknown as IntegrationDiagnosticsPort;
}

afterEach(() => {
  resetKeyStore();
});
resetKeyStore();

describe("a live probe reads only its own connection's saved key", () => {
  const matrix = (accessToken: string) =>
    connection("matrix", { homeserverUrl: "https://matrix.attacker.example.test", accessToken });

  it("Matrix: another connection's reference is a missing token and no request is made", async () => {
    const fetcher = vi.fn(async () => json({ user_id: "@bot:example.test" }));

    const result = await runConfiguredMatrixChecks(probePort(fetcher), matrix(THEIR_REFERENCE), true);

    expect(result.checks[0]).toMatchObject({ key: "matrix_input", status: "fail" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(THEIR_SECRET);
    expect(JSON.stringify(result)).not.toContain(THEIR_REFERENCE);
  });

  it("Matrix: the connection's own reference still reaches its homeserver as its own key", async () => {
    const fetcher = vi.fn(async (url: string) =>
      url.endsWith("/account/whoami") ? json({ user_id: "@bot:example.test" }) : json({ joined_rooms: [] }),
    );

    await runConfiguredMatrixChecks(probePort(fetcher), matrix(MY_REFERENCE), false);

    expect(fetcher).toHaveBeenCalled();
    for (const call of fetcher.mock.calls) {
      expect(requestText(call)).toContain(`Bearer ${MY_SECRET}`);
      expect(requestText(call)).not.toContain(THEIR_SECRET);
    }
  });

  it("Telegram, through the live checks: another connection's reference makes no request, and its own does", async () => {
    const fetcher = vi.fn(async () => json({ ok: true, result: { id: 1, username: "bot" } }));
    const telegram = (botToken: string) => connection("telegram", { botToken, defaultChatId: "123" });
    keyStore.set(`channel-connection:${MY_ID}:botToken:${NONCE_MINE}`, MY_SECRET);
    keyStore.set(`channel-connection:${THEIR_ID}:botToken:${NONCE_THEIRS}`, THEIR_SECRET);

    await runIntegrationConnectionLiveChecks(
      probePort(fetcher),
      telegram(`keychain:goatcitadel:channel-connection:${THEIR_ID}:botToken:${NONCE_THEIRS}`),
      { includeSandboxSend: true },
    );
    expect(fetcher).not.toHaveBeenCalled();

    await runIntegrationConnectionLiveChecks(
      probePort(fetcher),
      telegram(`keychain:goatcitadel:channel-connection:${MY_ID}:botToken:${NONCE_MINE}`),
      { includeSandboxSend: false },
    );
    expect(fetcher).toHaveBeenCalled();
    for (const call of fetcher.mock.calls) {
      expect(requestText(call)).toContain(MY_SECRET);
      expect(requestText(call)).not.toContain(THEIR_SECRET);
    }
  });
});

describe("a typing indicator reads only its own connection's saved key", () => {
  const room = "!room:example.test";
  const typingDeps = (fetcher: ReturnType<typeof vi.fn>) => ({
    resolveConnectionSecret: sharedRead,
    isConnectionUrlAllowlisted: () => true,
    fetchWithDiagnosticsTimeout: fetcher,
  });

  it("Matrix: another connection's reference is reported as a missing token, with no request", async () => {
    const fetcher = vi.fn(async () => json({ user_id: "@bot:example.test" }));
    const conn = connection("matrix", {
      homeserverUrl: "https://matrix.attacker.example.test",
      accessToken: THEIR_REFERENCE,
    });

    const result = await emitProviderTypingWithDeps(typingDeps(fetcher), conn, { connectionId: MY_ID, target: room });

    expect(result.status).toBe("unsupported");
    expect(result.reason).toContain("missing a Matrix access token");
    expect(fetcher).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(THEIR_SECRET);
    expect(JSON.stringify(result)).not.toContain(THEIR_REFERENCE);
  });

  it("Matrix: its own reference sends the typing request with its own key", async () => {
    const fetcher = vi.fn(async (url: string) =>
      url.endsWith("/account/whoami") ? json({ user_id: "@bot:example.test" }) : json({}),
    );
    const conn = connection("matrix", { homeserverUrl: "https://matrix.example.test", accessToken: MY_REFERENCE });

    const result = await emitProviderTypingWithDeps(typingDeps(fetcher), conn, { connectionId: MY_ID, target: room });

    expect(result.status).toBe("sent");
    for (const call of fetcher.mock.calls) {
      expect(requestText(call)).toContain(`Bearer ${MY_SECRET}`);
    }
  });
});

describe("a stream reads only its own connection's saved key", () => {
  function streamContext(conn: IntegrationConnection): ChannelStreamRunContext {
    return {
      connection: conn,
      signal: new AbortController().signal,
      cursor: undefined,
      markReady: vi.fn(),
      touch: vi.fn(),
      emit: vi.fn(),
      diagnostic: vi.fn(),
    } as unknown as ChannelStreamRunContext;
  }

  it("Matrix: another connection's reference stops the stream with an auth error and no request", async () => {
    const fetcher = vi.fn(async () => json({}));
    const adapter = createMatrixStreamAdapter({
      fetch: fetcher as unknown as typeof fetch,
      resolveSecret: sharedRead,
      isUrlAllowlisted: () => true,
      cursorStore: { read: async () => undefined, write: async () => undefined },
    });
    const conn = connection("matrix", {
      homeserverUrl: "https://matrix.attacker.example.test",
      accessToken: THEIR_REFERENCE,
      inboundStreamEnabled: true,
    });

    await expect(adapter.run(streamContext(conn))).rejects.toBeInstanceOf(ChannelStreamAuthError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("Mattermost: another connection's reference stops the stream before any request or socket", async () => {
    const fetcher = vi.fn(async () => json({ id: "bot" }));
    const createWebSocket = vi.fn();
    const adapter = createMattermostStreamAdapter({
      fetch: fetcher as unknown as typeof fetch,
      resolveSecret: sharedRead,
      isUrlAllowlisted: () => true,
      createWebSocket,
    });
    const conn = connection("mattermost", {
      serverUrl: "https://mattermost.attacker.example.test",
      botToken: THEIR_REFERENCE.replace(":accessToken:", ":botToken:"),
      inboundStreamEnabled: true,
    });
    keyStore.set(`channel-connection:${THEIR_ID}:botToken:${NONCE_THEIRS}`, THEIR_SECRET);

    await expect(adapter.run(streamContext(conn))).rejects.toBeInstanceOf(ChannelStreamAuthError);
    expect(fetcher).not.toHaveBeenCalled();
    expect(createWebSocket).not.toHaveBeenCalled();
  });
});
