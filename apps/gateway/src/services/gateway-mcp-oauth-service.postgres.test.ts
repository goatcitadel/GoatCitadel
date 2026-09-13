import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { expect, it, vi } from "vitest";
import type { McpServerRecord } from "@goatcitadel/contracts";
import { createPostgresRemoteStorage, type AsyncStorage } from "@goatcitadel/storage";
import { GatewayMcpOAuthService } from "./gateway-mcp-oauth-service.js";
import { McpOAuthTokenService } from "./mcp-oauth-token-service.js";
import { McpServerStore } from "./mcp-server-store.js";
import { normalizeMcpPolicy } from "./mcp-server-policy.js";

it.skipIf(!process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim())(
  "reserves one actual token request across PostgreSQL RPC workers and retains uncertainty after reopen",
  async () => {
    const url = process.env.GOATCITADEL_TEST_POSTGRES_URL!.trim();
    const schemaName = `mcp_oauth_${randomUUID().replaceAll("-", "")}`;
    const directory = mkdtempSync(path.join(os.tmpdir(), "gc-mcp-oauth-pg-"));
    const admin = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 10_000 });
    const scopedUrl = new URL(url);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
    const options = {
      connection: {
        connectionString: scopedUrl.toString(),
        database: decodeURIComponent(scopedUrl.pathname.slice(1)),
        pool: { max: 1, connectionTimeoutMs: 10_000 },
      },
      migrationsTable: "schema_migrations",
      transcriptsDir: path.join(directory, "transcripts"),
      auditDir: path.join(directory, "audit"),
      startupWaitTimeoutMs: 60_000,
    };
    const clients: AsyncStorage[] = [];
    let schemaCreated = false;
    let requests = 0;
    let failRequest = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const endpoint = http.createServer((request, response) => {
      request.resume();
      requests += 1;
      void gate.then(() => {
        response.writeHead(failRequest ? 503 : 200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify(
            failRequest
              ? {}
              : {
                  access_token: "pg-loopback-access",
                  refresh_token: "pg-loopback-refresh",
                  expires_in: 3600,
                },
          ),
        );
      });
    });
    await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
    let activeRequest: Promise<unknown> | undefined;
    try {
      const address = endpoint.address();
      if (!address || typeof address === "string") throw new Error("Missing loopback fixture address");
      const tokenUrl = `http://127.0.0.1:${address.port}/token`;
      await admin.query(`CREATE SCHEMA ${schemaName}`);
      schemaCreated = true;
      const left = createPostgresRemoteStorage(options);
      clients.push(left);
      await left.waitUntilReady();
      const right = createPostgresRemoteStorage(options);
      clients.push(right);
      await right.waitUntilReady();
      const a = registry(left);
      const b = registry(right);
      const seed: McpServerRecord = {
        serverId: "pg-oauth",
        label: "PostgreSQL OAuth fixture",
        transport: "http",
        url: "https://example.invalid/mcp",
        authType: "oauth2",
        oauth: { authorizationUrl: "https://example.invalid/authorize", tokenUrl },
        enabled: true,
        status: "connected",
        category: "development",
        trustTier: "restricted",
        costTier: "unknown",
        policy: normalizeMcpPolicy(),
        createdAt: "2026-09-11T00:00:00.000Z",
        updatedAt: "2026-09-11T00:00:00.000Z",
      };
      await a.writeServers([seed], []);
      await a.writeAuthState({
        server: await a.requireServer(seed.serverId),
        expected: undefined,
        next: {
          accessTokenRef: "keychain:goatcitadel:mcp:pg-oauth:access-token",
          refreshTokenRef: "keychain:goatcitadel:mcp:pg-oauth:refresh-token",
          tokenExpiresAt: "2020-01-01T00:00:00.000Z",
          updatedAt: "2026-09-11T00:00:00.000Z",
        },
      });
      const secrets = new Map<string, string>([
        ["mcp:pg-oauth:access-token", "pg-old-access"],
        ["mcp:pg-oauth:refresh-token", "pg-old-refresh"],
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
      const tokens = () => new McpOAuthTokenService({ secretStore, networkAllowlist: [new URL(tokenUrl).host] });
      const owner = new GatewayMcpOAuthService({ registry: a, storage: left, tokenService: tokens() });
      const peer = new GatewayMcpOAuthService({ registry: b, storage: right, tokenService: tokens() });
      const original = await a.requireServer(seed.serverId);
      activeRequest = owner.resolveAccessToken(original);
      try {
        await vi.waitFor(() => expect(requests).toBe(1), { timeout: 15_000 });
        await expect(peer.resolveAccessToken(await b.requireServer(seed.serverId))).rejects.toThrow(/did not finish/);
        expect(requests).toBe(1);
      } finally {
        release();
      }
      await expect(activeRequest).resolves.toBe("pg-loopback-access");
      activeRequest = undefined;
      expect((await right.externalSideEffectRuns.listByConnection(seed.serverId))[0]!.status).toBe("completed");
      const current = await b.requireServer(seed.serverId);
      expect(current.configurationBindingId).not.toBe(original.configurationBindingId);
      const auth = (await b.readAuthState())[seed.serverId]!;
      expect(auth.tokenRequest).toBeUndefined();
      await b.writeAuthState({
        server: current,
        expected: auth,
        next: { ...auth, tokenExpiresAt: "2020-01-01T00:00:00.000Z" },
      });
      failRequest = true;
      await expect(peer.resolveAccessToken(await b.requireServer(seed.serverId))).rejects.toThrow(/Reconnect/);
      expect(requests).toBe(2);
      await left.close();
      await right.close();
      clients.length = 0;
      const fresh = createPostgresRemoteStorage(options);
      clients.push(fresh);
      await fresh.waitUntilReady();
      const reopened = registry(fresh);
      const recovered = new GatewayMcpOAuthService({ registry: reopened, storage: fresh, tokenService: tokens() });
      await expect(recovered.resolveAccessToken(await reopened.requireServer(seed.serverId))).rejects.toThrow(
        /did not finish/,
      );
      expect(requests).toBe(2);
      const runs = await fresh.externalSideEffectRuns.listByConnection(seed.serverId);
      expect(runs.map((run) => run.status).sort()).toEqual(["completed", "unknown_external_outcome"]);
      const serialized = JSON.stringify(runs);
      for (const secret of ["pg-loopback-access", "pg-loopback-refresh", "pg-old-refresh", "keychain:", tokenUrl]) {
        expect(serialized).not.toContain(secret);
      }
    } finally {
      release();
      if (activeRequest) await Promise.allSettled([activeRequest]);
      await new Promise<void>((resolve, reject) => endpoint.close((error) => (error ? reject(error) : resolve())));
      const closed = await Promise.allSettled(clients.map((client) => client.close()));
      try {
        if (schemaCreated) await admin.query(`DROP SCHEMA ${schemaName} CASCADE`);
      } finally {
        await admin.end();
      }
      expect(closed.filter((result) => result.status === "rejected")).toEqual([]);
    }
  },
  120_000,
);

function registry(storage: AsyncStorage): McpServerStore {
  return new McpServerStore({
    systemSettings: storage.systemSettings,
    runImmediateTransaction: (callback) => storage.runImmediateTransaction(callback),
  });
}
