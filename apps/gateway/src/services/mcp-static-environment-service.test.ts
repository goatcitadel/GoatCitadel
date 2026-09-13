import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { McpServerRecord } from "@goatcitadel/contracts";
import { Storage, createSqliteAsyncStorage, type AsyncStorage } from "@goatcitadel/storage";
import { McpServerStore } from "./mcp-server-store.js";
import { McpCredentialStagingStore } from "./mcp-credential-staging-store.js";
import { McpCredentialRetirementStore } from "./mcp-credential-retirement-store.js";
import { normalizeMcpPolicy } from "./mcp-server-policy.js";
import { invokeMcpRuntimeTool, type StdioClient } from "./mcp-runtime.js";
import { McpStdioSessionPool } from "./mcp-stdio-session-pool.js";
import { McpOAuthTokenService } from "./mcp-oauth-token-service.js";
import {
  McpStaticEnvironmentService,
  assertMcpStaticEnvironmentCurrent,
  buildMcpChildEnvironment,
  readMcpStaticEnvironment,
  type McpStaticEnvironmentHandle,
} from "./mcp-static-environment-service.js";

const opened: AsyncStorage[] = [];
afterEach(async () => {
  for (const storage of opened.splice(0)) await storage.close();
});

it.each([true, false])("requires captured custody for an enrolled environment: %s", async (available) => {
  const f = await fixture(), custodyId = "f".repeat(64);
  const guarded = vi.fn((account: string, value: string, expected: string) => {
    expect(expected).toBe(custodyId); f.secrets.set(account, value);
  });
  const service = new McpStaticEnvironmentService({ registry: f.store, env: f.env,
    secretStore: available ? { ...f.secretStore, setSecretForCustody: guarded } : f.secretStore,
    stageCredentials: (serverId, refs, write) => f.store.stageCredentialVersions(serverId, refs, () => write(custodyId), custodyId) });
  const pending = service.enroll(await f.store.requireServer("fixture"));
  if (available) {
    const server = await pending;
    await expect(service.capture(server)).resolves.toBeDefined();
    expect(guarded).toHaveBeenCalledOnce();
  } else await expect(pending).rejects.toThrow("OS custody owner");
  expect(f.secretStore.setSecret).not.toHaveBeenCalled();
});

it("keeps an acknowledged environment publication successful when cleanup fails", async () => {
  const f = await fixture();
  const cleanup = vi.fn(async () => { throw new Error("private cleanup failure"); });
  const service = new McpStaticEnvironmentService({ registry: f.store, secretStore: f.secretStore,
    env: f.env, reconcileRetiredCredentials: cleanup });
  const server = await service.enroll(await f.store.requireServer("fixture"));
  expect(cleanup).toHaveBeenCalledOnce();
  await expect(service.capture(server)).resolves.toBeDefined();
  expect(f.secretStore.deleteSecret).not.toHaveBeenCalled();
});

it("recovers a staged environment proof when canonical publication fails", async () => {
  const f = await fixture();
  const service = new McpStaticEnvironmentService({ secretStore: f.secretStore, env: f.env,
    stageCredentials: (...args) => f.store.stageCredentialVersions(...args),
    registry: { readEnvironmentBinding: (serverId) => f.store.readEnvironmentBinding(serverId),
      writeEnvironmentBinding: async () => { throw new Error("environment publication failed"); } } });
  await expect(service.enroll(await f.store.requireServer("fixture"))).rejects.toThrow("publication failed");
  expect(f.secrets.size).toBe(1);
  expect(f.secretStore.deleteSecret).not.toHaveBeenCalled();
  const ctx = { systemSettings: f.storage.systemSettings,
    runImmediateTransaction: f.storage.runImmediateTransaction.bind(f.storage) };
  const staging = new McpCredentialStagingStore(ctx, new McpCredentialRetirementStore(ctx), () => Date.now() + 11 * 60_000);
  expect(await staging.reconcile()).toMatchObject({ retired: 1, remaining: 0 });
  expect(await f.store.reconcileCredentialRetirements((account) => f.secretStore.deleteSecret(account)))
    .toMatchObject({ deleted: 1, remaining: 0 });
  expect(f.secrets.size).toBe(0);
  expect(await f.store.readEnvironmentBinding("fixture")).toBeUndefined();
});

it("publishes only an opaque reference and captures immutable values without exposing them in the handle", async () => {
  const f = await fixture();
  const original = await f.store.requireServer("fixture");
  const server = await f.service.enroll(original);
  expect(server.configurationBindingId).not.toBe(original.configurationBindingId);
  const privateRow = await f.store.readEnvironmentBinding(server.serverId);
  expect(Object.keys(privateRow!)).toEqual(["credentialRef"]);
  const proof = [...f.secrets.values()][0]!;
  expect(proof).not.toContain(f.env.MCP_FIXTURE_SECRET);
  expect(JSON.stringify(await f.store.readServers())).not.toContain("credentialRef");
  expect(JSON.stringify(privateRow)).not.toContain(JSON.parse(proof).digest);
  const handle = await f.service.capture(server);
  expect(JSON.stringify(handle)).toBe("{}");
  const captured = readMcpStaticEnvironment(handle, server);
  expect(captured.MCP_FIXTURE_SECRET).toBe("private-fixture-secret");
  expect(Object.isFrozen(captured)).toBe(true);
  expect(() => readMcpStaticEnvironment({ ...handle } as McpStaticEnvironmentHandle, server)).toThrow(/server-owned/);
  expect(() => readMcpStaticEnvironment(handle, { ...server, url: "https://other.invalid" })).toThrow(/server-owned/);
  f.env.MCP_FIXTURE_SECRET = "changed-fixture-secret";
  expect(captured.MCP_FIXTURE_SECRET).toBe("private-fixture-secret");
  await expect(assertMcpStaticEnvironmentCurrent(handle, server)).rejects.toThrow(/reconnect/);
  await expect(f.service.capture(server)).rejects.toThrow(/reconnect/);
  expect(await f.store.readEnvironmentBinding(server.serverId)).toEqual(privateRow);
});

it("keeps identical enrollment stable and requires explicit reconnect to replace changed values", async () => {
  const f = await fixture();
  const enrolled = await f.service.enroll(await f.store.requireServer("fixture"));
  const original = await f.store.readEnvironmentBinding("fixture");
  const staleHandle = await f.service.capture(enrolled);
  expect((await f.service.enroll(enrolled)).configurationBindingId).toBe(enrolled.configurationBindingId);
  expect(f.secretStore.setSecret).toHaveBeenCalledTimes(1);
  f.env.MCP_FIXTURE_SECRET = "replacement-fixture-secret";
  const replaced = await f.service.enroll(enrolled);
  expect(replaced.configurationBindingId).not.toBe(enrolled.configurationBindingId);
  expect(f.secrets.has(original!.credentialRef.slice("keychain:goatcitadel:".length))).toBe(false);
  await expect(assertMcpStaticEnvironmentCurrent(staleHandle, enrolled)).rejects.toThrow();
  expect(readMcpStaticEnvironment(await f.service.capture(replaced), replaced).MCP_FIXTURE_SECRET).toBe(
    f.env.MCP_FIXTURE_SECRET,
  );
});

it("never enrolls ambient values through capture or changes legacy inventory on read", async () => {
  const f = await fixture();
  await expect(f.service.capture(await f.store.requireServer("fixture"))).rejects.toThrow(/reconnect/);
  expect(f.secretStore.setSecret).not.toHaveBeenCalled();
  const legacy = { ...(await f.store.requireServer("fixture")), configurationBindingId: undefined };
  await f.storage.systemSettings.set("mcp_servers_v1", [legacy]);
  const before = await f.storage.systemSettings.get("mcp_servers_v1");
  await f.store.readServers();
  await expect(f.service.capture(legacy)).rejects.toThrow(/reconnect/);
  expect(await f.storage.systemSettings.get("mcp_servers_v1")).toEqual(before);
  expect((await f.service.enroll(legacy)).configurationBindingId).toBeTypeOf("string");
});

it("serializes competing environment enrollment without overwriting another Gateway's winner", async () => {
  const f = await fixture();
  const server = await f.store.requireServer("fixture");
  const peer = new McpStaticEnvironmentService({
    registry: f.store,
    secretStore: f.secretStore,
    env: { MCP_FIXTURE_SECRET: "peer-fixture-secret" },
  });
  const results = await Promise.allSettled([f.service.enroll(server), peer.enroll(server)]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  const current = await f.store.requireServer("fixture");
  const captures = await Promise.allSettled([f.service.capture(current), peer.capture(current)]);
  expect(captures.filter((result) => result.status === "fulfilled")).toHaveLength(1);
});

it("invalidates existing OAuth grants and first-use approvals atomically with environment authority", async () => {
  const f = await fixture("oauth2");
  const initial = await f.store.requireServer("fixture");
  await f.store.writeAuthState({
    server: initial,
    expected: undefined,
    next: {
      accessTokenRef: "keychain:goatcitadel:mcp:fixture:access-token",
      updatedAt: "2026-09-11T00:00:00.000Z",
    },
  });
  await f.storage.systemSettings.set("mcp_tool_first_approval_v1", { fixture: ["read"], peer: ["read"] });
  const server = await f.service.enroll(await f.store.requireServer("fixture"));
  expect((await f.store.readAuthState()).fixture).toBeUndefined();
  expect(await f.store.readFirstApprovals()).toEqual({ peer: ["read"] });
  const environment = readMcpStaticEnvironment(await f.service.capture(server), server);
  expect(environment.MCP_CLIENT_SECRET).toBe("private-client-secret");
  expect(buildMcpChildEnvironment(server, environment).MCP_CLIENT_SECRET).toBeUndefined();
});

it("rolls back environment publication and auth invalidation when cache invalidation fails", async () => {
  const f = await fixture("oauth2");
  const auth = {
    accessTokenRef: "keychain:goatcitadel:mcp:fixture:access-token",
    updatedAt: "2026-09-11T00:00:00.000Z",
  };
  await f.store.writeAuthState({ server: await f.store.requireServer("fixture"), expected: undefined, next: auth });
  const original = await f.store.requireServer("fixture");
  const settings = new Proxy(f.storage.systemSettings, {
    get(target, key) {
      if (key === "compareAndSet")
        return async (...args: Parameters<AsyncStorage["systemSettings"]["compareAndSet"]>) => {
          if (args[0] === "mcp_tool_first_approval_v1") throw new Error("approval publication failure");
          return target.compareAndSet(...args);
        };
      return Reflect.get(target, key);
    },
  });
  await f.storage.systemSettings.set("mcp_tool_first_approval_v1", { fixture: ["read"] });
  const store = new McpServerStore({
    systemSettings: settings,
    runImmediateTransaction: (callback) => f.storage.runImmediateTransaction(callback),
  });
  const service = new McpStaticEnvironmentService({ registry: store, secretStore: f.secretStore, env: f.env });
  await expect(service.enroll(original)).rejects.toThrow("approval publication failure");
  expect(await f.store.readEnvironmentBinding("fixture")).toBeUndefined();
  expect((await f.store.requireServer("fixture")).configurationBindingId).toBe(original.configurationBindingId);
  expect(await f.store.readFirstApprovals()).toEqual({ fixture: ["read"] });
  expect((await f.store.readAuthState()).fixture).toEqual(auth);
});

it("retains proof versions after an uncertain publication acknowledgment", async () => {
  const f = await fixture();
  const original = await f.service.enroll(await f.store.requireServer("fixture"));
  f.env.MCP_FIXTURE_SECRET = "replacement-fixture-secret";
  const service = new McpStaticEnvironmentService({
    env: f.env,
    secretStore: f.secretStore,
    registry: {
      readEnvironmentBinding: (id) => f.store.readEnvironmentBinding(id),
      writeEnvironmentBinding: async (...args) => {
        await f.store.writeEnvironmentBinding(...args);
        throw new Error("publication acknowledgment lost");
      },
    },
  });
  await expect(service.enroll(original)).rejects.toThrow("publication acknowledgment lost");
  expect(f.secrets.size).toBe(2);
  const current = await f.store.requireServer("fixture");
  await expect(f.service.capture(current)).resolves.toBeDefined();
});

it("refuses unsafe custody and cleans only its unpublished entry after a staging failure", async () => {
  const f = await fixture();
  f.secretStore.isWriteCustodySafe.mockReturnValueOnce(false);
  await expect(f.service.enroll(await f.store.requireServer("fixture"))).rejects.toThrow(/custody/);
  expect(f.secretStore.setSecret).not.toHaveBeenCalled();
  f.secrets.set("unrelated", "preserved-fixture");
  f.secretStore.setSecret.mockImplementationOnce((account, value) => {
    f.secrets.set(account, value);
    throw new Error("partial staging failure");
  });
  await expect(f.service.enroll(await f.store.requireServer("fixture"))).rejects.toThrow("partial staging failure");
  expect([...f.secrets.keys()]).toEqual(["unrelated"]);
});

it("never cleans credentials outside the server scope and needs no keychain for an empty HTTP environment", async () => {
  const f = await fixture("none");
  const foreignAccount = `mcp:peer:environment:${randomUUID()}`;
  f.secrets.set(foreignAccount, "preserved-peer-proof");
  await f.storage.systemSettings.set("mcp_environment_bindings_v1", {
    fixture: { credentialRef: `keychain:goatcitadel:${foreignAccount}` },
  });
  const server = await f.service.enroll(await f.store.requireServer("fixture"));
  await expect(f.service.capture(server)).resolves.toBeDefined();
  expect(f.secretStore.setSecret).not.toHaveBeenCalled();
  expect(f.secretStore.getSecret).not.toHaveBeenCalled();
  expect(f.secretStore.deleteSecret).not.toHaveBeenCalled();
  expect(f.secrets.get(foreignAccount)).toBe("preserved-peer-proof");
});

it("removes environment references on deletion and refuses the old handle after recreation", async () => {
  const f = await fixture();
  const server = await f.service.enroll(await f.store.requireServer("fixture"));
  const handle = await f.service.capture(server);
  await f.store.writeServers([], await f.store.readServers());
  expect(await f.store.readEnvironmentBinding("fixture")).toBeUndefined();
  await f.store.writeServers([server], []);
  await expect(assertMcpStaticEnvironmentCurrent(handle, server)).rejects.toThrow();
  await expect(f.service.capture(await f.store.requireServer("fixture"))).rejects.toThrow(/reconnect/);
});

it("repairs a corrupt private proof only through explicit reconnect and preserves keychain errors", async () => {
  const f = await fixture();
  const original = await f.service.enroll(await f.store.requireServer("fixture"));
  const binding = (await f.store.readEnvironmentBinding("fixture"))!;
  f.secrets.set(binding.credentialRef.slice("keychain:goatcitadel:".length), "malformed-proof");
  await expect(f.service.capture(original)).rejects.toThrow(/reconnect/);
  const repaired = await f.service.enroll(original);
  expect(repaired.configurationBindingId).not.toBe(original.configurationBindingId);
  await expect(f.service.capture(repaired)).resolves.toBeDefined();
  f.secretStore.getSecret.mockImplementationOnce(() => {
    throw new Error("keychain unavailable");
  });
  await expect(f.service.enroll(repaired)).rejects.toThrow("keychain unavailable");
  expect(f.secretStore.setSecret).toHaveBeenCalledTimes(2);
});

it("uses captured HTTP bearer credentials and stops before tools/call if they change during initialization", async () => {
  const seen: Array<{ method: unknown; authorization: string | undefined }> = [];
  let onInitialize = () => {};
  await withLoopbackServer(
    (request, response, raw) => {
      const message = JSON.parse(raw) as { id?: number; method: string };
      seen.push({ method: message.method, authorization: request.headers.authorization });
      if (message.method === "initialize") onInitialize();
      if (message.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: message.method === "tools/call" ? { content: [{ type: "text", text: "fixture success" }] } : {},
        }),
      );
    },
    async (url) => {
      const f = await fixture("token", { url });
      const server = await f.service.enroll(await f.store.requireServer("fixture"));
      const options = {
        networkAllowlist: [new URL(url).host],
        staticEnvironmentResolver: (current: McpServerRecord) => f.service.capture(current),
      };
      const result = await invokeMcpRuntimeTool(server, { toolName: "fixture.read" }, 5000, options);
      expect(result.ok, result.error).toBe(true);
      expect(seen.some((item) => item.method === "tools/call")).toBe(true);
      expect(seen.every((item) => item.authorization === "Bearer private-fixture-secret")).toBe(true);
      seen.length = 0;
      onInitialize = () => {
        f.env.MCP_FIXTURE_SECRET = "changed-fixture-secret";
      };
      const blocked = await invokeMcpRuntimeTool(server, { toolName: "fixture.read" }, 5000, options);
      expect(blocked.ok).toBe(false);
      expect(blocked.error).toMatch(/reconnect/);
      expect(blocked.externalOutcome).toBeUndefined();
      expect(seen.some((item) => item.method === "tools/call")).toBe(false);
      const requests = seen.length;
      await invokeMcpRuntimeTool(server, { toolName: "fixture.read" }, 5000, options);
      expect(seen).toHaveLength(requests);
    },
  );
});

it("passes captured values to a real stdio child and replaces the retained child after reconnect", async () => {
  const script = `
    require('node:readline').createInterface({input: process.stdin}).on('line', line => {
      const request = JSON.parse(line);
      if (request.id === undefined) return;
      const result = request.method === 'tools/call' ? {
        content: [{type:'text', text:'fixture success'}],
        structuredContent: {pid:process.pid, secret:process.env.MCP_FIXTURE_SECRET}
      } : {};
      process.stdout.write(JSON.stringify({jsonrpc:'2.0', id:request.id, result})+'\\n');
    });
  `;
  const f = await fixture("none", {
    transport: "stdio",
    command: process.execPath,
    args: ["-e", script],
    url: undefined,
  });
  let server = await f.service.enroll(await f.store.requireServer("fixture"));
  const pool = new McpStdioSessionPool<StdioClient>();
  const options = {
    staticEnvironmentResolver: (current: McpServerRecord) => f.service.capture(current),
    stdioSession: { pool, scopeKey: "environment-fixture-conversation" },
  };
  try {
    const first = await invokeMcpRuntimeTool(server, { toolName: "fixture.read" }, 5000, options);
    expect(first.ok, first.error).toBe(true);
    expect(first.output?.structuredContent).toMatchObject({ secret: "private-fixture-secret" });
    f.env.MCP_FIXTURE_SECRET = "replacement-fixture-secret";
    const blocked = await invokeMcpRuntimeTool(server, { toolName: "fixture.read" }, 5000, options);
    expect(blocked.ok).toBe(false);
    expect(blocked.externalOutcome).toBeUndefined();
    server = await f.service.enroll(server);
    const second = await invokeMcpRuntimeTool(server, { toolName: "fixture.read" }, 5000, options);
    expect(second.ok, second.error).toBe(true);
    expect(second.output?.structuredContent).toMatchObject({ secret: "replacement-fixture-secret" });
    expect((second.output?.structuredContent as { pid: number }).pid).not.toBe(
      (first.output?.structuredContent as { pid: number }).pid,
    );
  } finally {
    pool.close();
  }
});

it("uses the enrolled OAuth client secret and rejects drift before its durable HTTP boundary", async () => {
  const bodies: URLSearchParams[] = [];
  await withLoopbackServer(
    (_request, response, raw) => {
      bodies.push(new URLSearchParams(raw));
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ access_token: "fixture-access-token" }));
    },
    async (url) => {
      const f = await fixture("oauth2", {
        oauth: {
          authorizationUrl: "https://example.invalid/authorize",
          tokenUrl: url,
          clientSecretEnv: "MCP_CLIENT_SECRET",
        },
      });
      const server = await f.service.enroll(await f.store.requireServer("fixture"));
      const service = new McpOAuthTokenService({
        secretStore: f.secretStore,
        networkAllowlist: [new URL(url).host],
        env: { MCP_CLIENT_SECRET: "must-not-be-used" },
        environmentResolver: async (current) => readMcpStaticEnvironment(await f.service.capture(current), current),
      });
      const boundary = vi.fn(async () => {});
      const state = { updatedAt: "2026-09-11T00:00:00.000Z" };
      await service.exchangeAuthorizationCode(server, "fixture-code", state, boundary);
      expect(bodies[0]!.get("client_secret")).toBe("private-client-secret");
      f.env.MCP_CLIENT_SECRET = "changed-client-secret";
      await expect(service.exchangeAuthorizationCode(server, "fixture-code", state, boundary)).rejects.toThrow(
        /reconnect/,
      );
      expect(boundary).toHaveBeenCalledTimes(1);
      expect(bodies).toHaveLength(1);
    },
  );
});

async function withLoopbackServer(
  handler: (request: http.IncomingMessage, response: http.ServerResponse, raw: string) => void,
  run: (url: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => handler(request, response, Buffer.concat(chunks).toString("utf8")));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture did not bind a loopback port.");
    await run(`http://127.0.0.1:${address.port}/mcp`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

async function fixture(authType: McpServerRecord["authType"] = "token", patch: Partial<McpServerRecord> = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "gc-mcp-environment-"));
  const storage = createSqliteAsyncStorage(
    new Storage({
      dbPath: ":memory:",
      transcriptsDir: path.join(directory, "transcripts"),
      auditDir: path.join(directory, "audit"),
    }),
  );
  opened.push(storage);
  const store = new McpServerStore({
    systemSettings: storage.systemSettings,
    runImmediateTransaction: (callback) => storage.runImmediateTransaction(callback),
  });
  const env: NodeJS.ProcessEnv = {
    MCP_FIXTURE_SECRET: "private-fixture-secret",
    MCP_CLIENT_SECRET: "private-client-secret",
  };
  const server: McpServerRecord = {
    serverId: "fixture",
    label: "Environment fixture",
    transport: "http",
    authType,
    url: "https://example.invalid/mcp",
    oauth:
      authType === "oauth2"
        ? {
            authorizationUrl: "https://example.invalid/authorize",
            tokenUrl: "https://example.invalid/token",
            clientSecretEnv: "MCP_CLIENT_SECRET",
          }
        : undefined,
    enabled: true,
    status: "connected",
    category: "development",
    trustTier: "restricted",
    costTier: "unknown",
    policy: normalizeMcpPolicy({ allowedEnvKeys: ["MCP_FIXTURE_SECRET"] }),
    createdAt: "2026-09-11T00:00:00.000Z",
    updatedAt: "2026-09-11T00:00:00.000Z",
    ...patch,
  };
  await store.writeServers([server], []);
  const secrets = new Map<string, string>();
  const secretStore = {
    isWriteCustodySafe: vi.fn(() => true),
    getSecret: vi.fn((account: string) => secrets.get(account)),
    setSecret: vi.fn((account: string, value: string) => {
      secrets.set(account, value);
    }),
    deleteSecret: vi.fn((account: string) => {
      secrets.delete(account);
    }),
  };
  const service = new McpStaticEnvironmentService({ registry: store, secretStore, env });
  return { storage, store, env, secretStore, secrets, service };
}
