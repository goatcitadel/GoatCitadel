import http from "node:http";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpServerRecord } from "@goatcitadel/contracts";
import { Storage, createSqliteAsyncStorage, type AsyncStorage } from "@goatcitadel/storage";
import { GatewayMcpOAuthService, type GatewayMcpOAuthServiceOptions } from "./gateway-mcp-oauth-service.js";
import { McpOAuthTokenService } from "./mcp-oauth-token-service.js";
import { McpServerStore } from "./mcp-server-store.js";
import {
  startMcpOAuth,
  type McpAuthStateRecord,
  type McpAuthStateUpdate,
  type McpServerAdminHost,
} from "./mcp-server-admin-service.js";
import { normalizeMcpPolicy } from "./mcp-server-policy.js";

const opened = new Set<AsyncStorage>();
afterEach(async () => {
  for (const storage of opened) await storage.close();
  opened.clear();
});

describe("GatewayMcpOAuthService durable publication", () => {
  it("keeps acknowledged OAuth publication successful when retirement reconciliation fails", async () => {
    const f = await fixture();
    const cleanup = vi.fn(async () => { throw new Error("private cleanup failure"); });
    const service = new GatewayMcpOAuthService({ ...f.options, reconcileRetiredCredentials: cleanup });
    await expect(service.exchangeAuthorizationCode(f.server, "fixture-code", f.previous)).resolves.toMatchObject(f.next);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(f.retire).not.toHaveBeenCalled();
    expect((await f.runs())[0]!.status).toBe("completed");
    expect((await f.store.readAuthState())[f.server.serverId]).toMatchObject(f.next);
  });

  it("waits for canonical publication before retiring previous tokens or acknowledging exchange", async () => {
    const f = await fixture();
    let publish: (() => void) | undefined;
    f.writeAuthState.mockImplementation(async (update) => {
      if (!update.next?.tokenRequest)
        await new Promise<void>((resolve) => {
          publish = resolve;
        });
      await f.store.writeAuthState(update);
    });
    const outcome = f.service.exchangeAuthorizationCode(f.server, "fixture-code", f.previous);
    await vi.waitFor(() => expect(publish).toBeTypeOf("function"));
    expect(f.retire).not.toHaveBeenCalled();
    publish!();
    await expect(outcome).resolves.toMatchObject(f.next);
    expect(f.retire).toHaveBeenCalledOnce();
    expect((await f.runs())[0]!.status).toBe("completed");
  });

  it.each(["exchange", "refresh"] as const)(
    "preserves credentials after an uncertain %s commit acknowledgment",
    async (mode) => {
      const f = await fixture();
      let committed = false;
      let loseAcknowledgment = true;
      f.writeAuthState.mockImplementation(async (update) => {
        await f.store.writeAuthState(update);
        if (!update.next?.tokenRequest) committed = true;
      });
      const service = new GatewayMcpOAuthService({
        ...f.options,
        storage: {
          mutationIdempotency: f.storage.mutationIdempotency,
          externalSideEffectRuns: f.storage.externalSideEffectRuns,
          runImmediateTransaction: async (callback) => {
            const value = await f.storage.runImmediateTransaction(callback);
            if (committed && loseAcknowledgment) {
              loseAcknowledgment = false;
              throw new Error("publication acknowledgment lost");
            }
            return value;
          },
        },
      });
      const outcome =
        mode === "exchange"
          ? service.exchangeAuthorizationCode(f.server, "fixture-code", f.previous)
          : service.resolveAccessToken(f.server);
      await expect(outcome).rejects.toThrow("publication acknowledgment lost");
      expect((await f.store.readAuthState())[f.server.serverId]).toMatchObject(f.next);
      expect((await f.store.readAuthState())[f.server.serverId]!.tokenRequest).toBeUndefined();
      expect((await f.runs())[0]!.status).toBe("completed");
      expect(f.retire).not.toHaveBeenCalled();
      expect(f.writeAuthState.mock.calls.filter(([update]) => !update.next?.tokenRequest)).toHaveLength(1);
    },
  );

  it("binds refresh publication to copies of configuration and auth state made before the request", async () => {
    const f = await fixture();
    let finish: (() => void) | undefined;
    f.refresh.mockImplementation(async (_server, _state, boundary) => {
      await boundary!();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { accessToken: "fixture-access", state: f.next };
    });
    const configuration = structuredClone(f.server);
    const outcome = f.service.resolveAccessToken(f.server);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    f.server.url = "https://different.invalid/mcp";
    f.previous.oauthState = "different-state";
    finish!();
    await expect(outcome).resolves.toBe("fixture-access");
    expect(f.writeAuthState.mock.calls.at(-1)![0].server).toMatchObject(configuration);
  });

  it("keeps bounded redacted failures in the durable ledger and permits a proven pre-dispatch retry", async () => {
    const f = await fixture();
    const privateValue = "fixture-sensitive-access-token";
    f.exchange.mockRejectedValueOnce(new Error(`Authorization: Bearer ${privateValue}\n${"detail ".repeat(300)}`));
    await expect(f.service.exchangeAuthorizationCode(f.server, "fixture-code", f.previous)).rejects.toThrow();
    const [failed] = await f.runs();
    expect(failed!.status).toBe("failed_before_boundary");
    expect(failed!.errorText).not.toContain(privateValue);
    expect(failed!.errorText!.length).toBeLessThanOrEqual(1024);
    expect(f.retire).not.toHaveBeenCalled();
    const auth = (await f.store.readAuthState())[f.server.serverId]!;
    await expect(f.service.exchangeAuthorizationCode(f.server, "fixture-code", auth)).resolves.toMatchObject(f.next);
    expect(await f.runs()).toHaveLength(1);
    expect((await f.runs())[0]!.status).toBe("completed");
  });

  it("rolls back credential publication if the terminal external ledger write fails", async () => {
    const f = await fixture();
    const storage = {
      runImmediateTransaction: (callback: Parameters<AsyncStorage["runImmediateTransaction"]>[0]) =>
        f.storage.runImmediateTransaction(callback),
      mutationIdempotency: f.storage.mutationIdempotency,
      externalSideEffectRuns: new Proxy(f.storage.externalSideEffectRuns, {
        get(target, key) {
          if (key === "markCompleted")
            return async () => {
              throw new Error("ledger completion failure");
            };
          return Reflect.get(target, key);
        },
      }),
    } as GatewayMcpOAuthServiceOptions["storage"];
    const service = new GatewayMcpOAuthService({ ...f.options, storage });
    await expect(service.exchangeAuthorizationCode(f.server, "fixture-code", f.previous)).rejects.toThrow(
      "ledger completion failure",
    );
    expect((await f.store.readAuthState())[f.server.serverId]).toMatchObject(f.previous);
    expect((await f.store.requireServer(f.server.serverId)).configurationBindingId).toBe(
      f.server.configurationBindingId,
    );
    expect((await f.runs())[0]!.status).toBe("unknown_external_outcome");
    expect(f.retire).not.toHaveBeenCalled();
  });

  it("does not turn successful publication into failure when retired-token cleanup fails", async () => {
    const f = await fixture();
    f.retire.mockRestore();
    f.secretStore.deleteSecret = () => {
      throw new Error("fixture keychain unavailable");
    };
    await expect(f.service.exchangeAuthorizationCode(f.server, "fixture-code", f.previous)).resolves.toMatchObject(
      f.next,
    );
    expect((await f.runs())[0]!.status).toBe("completed");
  });

  it("leaves non-OAuth resolution to its owner and reads current credentials without reserving a request", async () => {
    const f = await fixture();
    await expect(f.service.resolveAccessToken({ ...f.server, authType: "token" })).resolves.toBeUndefined();
    expect(f.writeAuthState).not.toHaveBeenCalled();
    const next = { ...f.previous, tokenExpiresAt: "2099-01-01T00:00:00.000Z" };
    await f.store.writeAuthState({ server: f.server, expected: f.previous, next });
    await expect(f.service.resolveAccessToken(await f.store.requireServer(f.server.serverId))).resolves.toBe(
      "old-access-fixture",
    );
    expect(await f.runs()).toHaveLength(0);
    expect(f.refresh).not.toHaveBeenCalled();
  });

  it("rejects changed canonical configuration before sending a token request", async () => {
    const f = await fixture();
    const previous = await f.store.readServers();
    await f.store.writeServers(
      previous.map((server) =>
        server.serverId === f.server.serverId ? { ...server, url: "https://changed.invalid/mcp" } : server,
      ),
      previous,
    );
    await expect(f.service.exchangeAuthorizationCode(f.server, "fixture-code", f.previous)).rejects.toThrow(
      /configuration changed/,
    );
    expect(f.exchange).not.toHaveBeenCalled();
    expect(await f.runs()).toHaveLength(0);
  });
});

describe("GatewayMcpOAuthService reservation fences", () => {
  it("rechecks canonical configuration immediately before crossing the boundary", async () => {
    const f = await fixture();
    f.exchange.mockImplementation(async (_server, _code, _state, boundary) => {
      const previous = await f.store.readServers();
      await f.store.writeServers(
        previous.map((server) =>
          server.serverId === f.server.serverId ? { ...server, url: "https://changed.invalid/mcp" } : server,
        ),
        previous,
      );
      await boundary!();
      return f.next;
    });
    await expect(f.service.exchangeAuthorizationCode(f.server, "fixture-code", f.previous)).rejects.toThrow(
      /configuration changed/,
    );
    expect((await f.runs())[0]).toMatchObject({ status: "failed_before_boundary" });
    expect((await f.runs())[0]!.externalCallStartedAt).toBeUndefined();
    expect(f.retire).not.toHaveBeenCalled();
  });

  it("prevents an in-flight request from publishing over an explicit reconnect", async () => {
    const f = await fixture();
    let finish: (() => void) | undefined;
    f.refresh.mockImplementation(async (_server, _state, boundary) => {
      await boundary!();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { accessToken: "fixture-access", state: f.next };
    });
    const outcome = f.service.resolveAccessToken(f.server);
    const rejected = expect(outcome).rejects.toThrow(/configuration changed/);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    const handshake = await startMcpOAuth(
      {
        requireMcpServer: (id) => f.store.requireServer(id),
        readMcpAuthState: () => f.store.readAuthState(),
        writeMcpAuthState: (update) => f.store.writeAuthState(update),
      } as McpServerAdminHost,
      f.server.serverId,
    );
    finish!();
    await rejected;
    const current = (await f.store.readAuthState())[f.server.serverId]!;
    expect(current.oauthState).toBe(handshake.state);
    expect(current.accessTokenRef).toBeUndefined();
    expect(current.tokenRequest).toBeUndefined();
    expect((await f.runs())[0]!.status).toBe("unknown_external_outcome");
    expect(f.retire).not.toHaveBeenCalled();
  });
});

describe("GatewayMcpOAuthService loopback transport", () => {
  it("sends one refresh across concurrent Gateway owners and publishes the winning token", async () => {
    let requests = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await withEndpoint(
      async () => {
        requests += 1;
        await gate;
        return {
          status: 200,
          body: { access_token: "fresh-loopback-access", refresh_token: "fresh-loopback-refresh", expires_in: 3600 },
        };
      },
      async (url) => {
        const f = await fixture(url, false);
        const peer = new GatewayMcpOAuthService(f.options);
        const first = f.service.resolveAccessToken(f.server);
        try {
          await vi.waitFor(() => expect(requests).toBe(1));
          await expect(peer.resolveAccessToken(f.server)).rejects.toThrow(/did not finish/);
          expect(requests).toBe(1);
          release();
          await expect(first).resolves.toBe("fresh-loopback-access");
          expect((await f.runs())[0]!.status).toBe("completed");
          expect((await f.store.readAuthState())[f.server.serverId]!.tokenRequest).toBeUndefined();
          const ledger = JSON.stringify(await f.runs());
          for (const secret of [
            "fresh-loopback-access",
            "fresh-loopback-refresh",
            "old-refresh-fixture",
            "keychain:",
            url,
          ]) {
            expect(ledger).not.toContain(secret);
          }
        } finally {
          release();
          await Promise.allSettled([first]);
        }
      },
    );
  });

  it("blocks automatic refresh after response uncertainty and restart; explicit reconnect starts a fresh grant", async () => {
    let requests = 0;
    await withEndpoint(
      async () => {
        requests += 1;
        return requests === 1
          ? { status: 503, body: {} }
          : {
              status: 200,
              body: { access_token: "reconnected-access", refresh_token: "reconnected-refresh", expires_in: 3600 },
            };
      },
      async (url) => {
        const f = await fixture(url, false);
        await expect(f.service.resolveAccessToken(f.server)).rejects.toThrow(/Reconnect/);
        expect((await f.runs())[0]!.status).toBe("unknown_external_outcome");
        await f.storage.close();
        opened.delete(f.storage);
        const reopened = openStorage(f.storageOptions);
        const store = registry(reopened);
        const service = new GatewayMcpOAuthService({ tokenService: f.tokens, registry: store, storage: reopened });
        const current = await store.requireServer(f.server.serverId);
        await expect(service.resolveAccessToken(current)).rejects.toThrow(/did not finish/);
        expect(requests).toBe(1);
        const handshake = await startMcpOAuth(
          {
            requireMcpServer: (id) => store.requireServer(id),
            readMcpAuthState: () => store.readAuthState(),
            writeMcpAuthState: (update) => store.writeAuthState(update),
          } as McpServerAdminHost,
          current.serverId,
        );
        const auth = (await store.readAuthState())[current.serverId]!;
        expect(auth).toMatchObject({ oauthState: handshake.state });
        expect(auth.accessTokenRef).toBeUndefined();
        expect(auth.refreshTokenRef).toBeUndefined();
        expect(auth.tokenRequest).toBeUndefined();
        const fresh = await store.requireServer(current.serverId);
        expect(fresh.configurationBindingId).not.toBe(current.configurationBindingId);
        await service.exchangeAuthorizationCode(fresh, "fresh-authorization-code", auth);
        expect(requests).toBe(2);
        const runs = await reopened.externalSideEffectRuns.listByConnection(current.serverId);
        expect(runs.map((run) => run.status).sort()).toEqual(["completed", "unknown_external_outcome"]);
        expect(JSON.stringify(runs)).not.toContain("fresh-authorization-code");
      },
    );
  });
});

function openStorage(options: ConstructorParameters<typeof Storage>[0]): AsyncStorage {
  const storage = createSqliteAsyncStorage(new Storage(options));
  opened.add(storage);
  return storage;
}

function registry(storage: AsyncStorage): McpServerStore {
  return new McpServerStore({
    systemSettings: storage.systemSettings,
    runImmediateTransaction: (callback) => storage.runImmediateTransaction(callback),
  });
}

async function fixture(tokenUrl = "https://example.invalid/token", mockRequests = true) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "gc-mcp-oauth-reservation-"));
  const storageOptions = {
    dbPath: path.join(directory, "fixture.db"),
    transcriptsDir: path.join(directory, "transcripts"),
    auditDir: path.join(directory, "audit"),
  };
  const storage = openStorage(storageOptions);
  const store = registry(storage);
  const seed: McpServerRecord = {
    serverId: "server-1",
    label: "OAuth fixture",
    transport: "http",
    url: "https://example.invalid/mcp",
    authType: "oauth2",
    oauth: { authorizationUrl: "https://example.invalid/authorize", tokenUrl },
    enabled: true,
    status: "connected",
    policy: normalizeMcpPolicy(),
    category: "development",
    trustTier: "restricted",
    costTier: "unknown",
    createdAt: "2026-09-11T00:00:00.000Z",
    updatedAt: "2026-09-11T00:00:00.000Z",
  };
  await store.writeServers([seed], []);
  const previous: McpAuthStateRecord = {
    accessTokenRef: "keychain:goatcitadel:mcp:server-1:access-token",
    refreshTokenRef: "keychain:goatcitadel:mcp:server-1:refresh-token",
    tokenExpiresAt: "2020-01-01T00:00:00.000Z",
    oauthState: "fixture-state",
    updatedAt: "2026-09-11T00:00:00.000Z",
  };
  await store.writeAuthState({ server: await store.requireServer(seed.serverId), expected: undefined, next: previous });
  const server = await store.requireServer(seed.serverId);
  const next: McpAuthStateRecord = JSON.parse(
    JSON.stringify({
      ...previous,
      accessTokenRef: "keychain:goatcitadel:mcp:server-1:access-token:11111111-1111-4111-8111-111111111111",
      refreshTokenRef: "keychain:goatcitadel:mcp:server-1:refresh-token:11111111-1111-4111-8111-111111111111",
      oauthState: undefined,
      tokenExpiresAt: "2099-01-01T00:00:00.000Z",
    }),
  );
  const secrets = new Map<string, string>([
    ["mcp:server-1:access-token", "old-access-fixture"],
    ["mcp:server-1:refresh-token", "old-refresh-fixture"],
  ]);
  const secretStore = {
    getSecret: (account: string) => secrets.get(account),
    setSecret: (account: string, value: string) => {
      secrets.set(account, value);
    },
    deleteSecret: (account: string) => {
      secrets.delete(account);
    },
  };
  const tokens = new McpOAuthTokenService({ secretStore, networkAllowlist: [new URL(tokenUrl).host] });
  const exchange = vi.spyOn(tokens, "exchangeAuthorizationCode");
  const refresh = vi.spyOn(tokens, "resolveAccessToken");
  if (mockRequests) {
    exchange.mockImplementation(async (_server, _code, _state, boundary) => {
      await boundary!();
      return next;
    });
    refresh.mockImplementation(async (_server, _state, boundary) => {
      await boundary!();
      return { accessToken: "fixture-access", state: next };
    });
  }
  const retire = vi.spyOn(tokens, "retireReplacedTokens");
  const writeAuthState = vi.fn((update: McpAuthStateUpdate) => store.writeAuthState(update));
  const options: GatewayMcpOAuthServiceOptions = {
    tokenService: tokens,
    storage,
    registry: {
      readAuthState: () => store.readAuthState(),
      writeAuthState,
      reserveAuthRequest: (...args) => store.reserveAuthRequest(...args),
    },
  };
  return {
    storage,
    storageOptions,
    store,
    server,
    previous,
    next,
    tokens,
    secretStore,
    exchange,
    refresh,
    retire,
    writeAuthState,
    options,
    service: new GatewayMcpOAuthService(options),
    runs: () => storage.externalSideEffectRuns.listByConnection(server.serverId),
  };
}

async function withEndpoint(
  reply: () => Promise<{ status: number; body: Record<string, unknown> }>,
  run: (url: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer((request, response) => {
    request.resume();
    void reply()
      .then((result) => {
        response.writeHead(result.status, { "Content-Type": "application/json" });
        response.end(JSON.stringify(result.body));
      })
      .catch(() => {
        response.writeHead(500);
        response.end();
      });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing loopback fixture address");
  try {
    await run(`http://127.0.0.1:${address.port}/token`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}
