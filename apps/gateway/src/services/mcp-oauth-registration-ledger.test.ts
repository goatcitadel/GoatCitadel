import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Storage, createSqliteAsyncStorage } from "@goatcitadel/storage";
import {
  createLedgeredMcpClientRegistration,
  McpClientRegistrationOutcomeError,
  type McpClientRegistrationRequest,
} from "./mcp-oauth-discovery.js";

let rootDir: string;
let storage: Storage;

beforeAll(async () => {
  rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "gc-mcp-registration-ledger-"));
  storage = new Storage({
    dbPath: path.join(rootDir, "gateway.sqlite"),
    transcriptsDir: path.join(rootDir, "transcripts"),
    auditDir: path.join(rootDir, "audit"),
  });
}, 180_000); // One full SQLite migration replay.

afterAll(async () => {
  storage?.close();
  await fs.rm(rootDir, { recursive: true, force: true });
});

const request = (serverId: string): McpClientRegistrationRequest => ({
  serverId,
  issuer: "https://auth.vendor.example",
  registrationEndpoint: "https://auth.vendor.example/register",
});

describe("ledgered MCP OAuth client registration", { timeout: 60_000 }, () => {
  it("records a completed registration with public identifiers only", async () => {
    const register = createLedgeredMcpClientRegistration(createSqliteAsyncStorage(storage));
    const registered = await register(request("server-ok"), async () => ({
      client_id: "public-client-1",
      redirect_uris: ["http://127.0.0.1:8787/api/v1/mcp/oauth/callback"],
    }));
    expect(registered.client_id).toBe("public-client-1");
    const runs = storage.externalSideEffectRuns.listByConnection("server-ok");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "completed", boundary: "mcp_oauth_client_registration" });
  });

  it("records an unknown outcome when the request was sent but no answer came back", async () => {
    const register = createLedgeredMcpClientRegistration(createSqliteAsyncStorage(storage));
    const attempt = register(request("server-lost"), async () => {
      throw new Error("socket hang up");
    });
    await expect(attempt).rejects.toBeInstanceOf(McpClientRegistrationOutcomeError);
    await expect(attempt).rejects.toMatchObject({ outcome: "unknown" });
    await expect(attempt).rejects.toThrow("may now hold an unused client");
    expect(storage.externalSideEffectRuns.listByConnection("server-lost")[0]).toMatchObject({
      status: "unknown_external_outcome",
    });
  });

  it("never writes a returned client secret to the ledger", async () => {
    const register = createLedgeredMcpClientRegistration(createSqliteAsyncStorage(storage));
    const registered = await register(request("server-secret"), async () => ({
      client_id: "confidential-client",
      client_secret: "vendor-issued-secret-value",
      redirect_uris: ["http://127.0.0.1:8787/api/v1/mcp/oauth/callback"],
    }));
    expect(registered.client_secret).toBe("vendor-issued-secret-value");
    const ledger = JSON.stringify(storage.externalSideEffectRuns.listByConnection("server-secret"));
    expect(ledger).not.toContain("vendor-issued-secret-value");
  });
});
