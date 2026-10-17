import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createSqliteAsyncStorage, Storage, type AsyncStorage } from "@goatcitadel/storage";
import type { ToolInvokeRequest, ToolPolicyConfig } from "@goatcitadel/contracts";
import { ToolPolicyEngine } from "./engine.js";

let storage: AsyncStorage;
let directory: string;
let sequence = 0;
beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "goat-matrix-grant-"));
  storage = createSqliteAsyncStorage(
    new Storage({
      dbPath: ":memory:",
      transcriptsDir: path.join(directory, "transcripts"),
      auditDir: path.join(directory, "audit"),
    }),
  );
  process.env.MATRIX_GRANT_TEST_TOKEN = "synthetic-matrix-token";
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  delete process.env.MATRIX_GRANT_TEST_TOKEN;
  await storage?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function fixture(options: { homeserverUrl?: string } = {}) {
  const workspace = await storage.workspaces.create({ name: `matrix grant fixture ${++sequence}` });
  const connection = await storage.integrationConnections.create({
    catalogId: "channel.matrix",
    kind: "channel",
    key: "matrix",
    label: "Matrix fixture",
    enabled: true,
    workspaceId: workspace.workspaceId,
    config: {
      ...(options.homeserverUrl === undefined ? {} : { homeserverUrl: options.homeserverUrl }),
      accessTokenEnv: "MATRIX_GRANT_TEST_TOKEN",
    },
  });
  const grant = await storage.toolGrants.create({
    toolPattern: "channel.send",
    decision: "allow",
    scope: "workspace",
    scopeRef: workspace.workspaceId,
    grantType: "one_time",
    usesRemaining: 1,
    createdBy: "operator",
    constraints: { allowedHosts: ["127.0.0.1"], mutationAllowed: true },
  });
  const config: ToolPolicyConfig = {
    tools: { approvalMode: "approve_risky", allow: ["channel.send", "http.get"], deny: [] },
    agents: {},
    sandbox: {
      writeJailRoots: [],
      readOnlyRoots: [],
      networkAllowlist: ["127.0.0.1", "foreign.example"],
      riskyShellPatterns: [],
      requireApprovalForRiskyShell: true,
    },
  };
  const request: ToolInvokeRequest = {
    toolName: "channel.send",
    agentId: "operator",
    sessionId: "session:operator:comms",
    workspaceId: workspace.workspaceId,
    surface: "tools",
    args: { connectionId: connection.connectionId, target: "!room:foreign.example", message: "Synthetic test notice." },
  };
  const fetch = vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ event_id: "$synthetic" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetch);
  const readGrant = async () =>
    (await storage.toolGrants.list("workspace", workspace.workspaceId)).find((item) => item.grantId === grant.grantId);
  return { grant, request, fetch, readGrant, engine: new ToolPolicyEngine(config, storage) };
}

describe("canonical Matrix homeserver host constraints", () => {
  it("admits the configured homeserver, ignores the room id as an origin, and consumes one grant", async () => {
    const f = await fixture({ homeserverUrl: "http://127.0.0.1:12345" });
    const result = await f.engine.invoke(f.request);
    expect(result.outcome).toBe("executed");
    expect(result.result).toMatchObject({ status: "sent", providerMessageId: "$synthetic" });
    expect(String(f.fetch.mock.calls[0]?.[0])).toContain("http://127.0.0.1:12345/_matrix/client/v3/rooms/");
    expect((await f.readGrant())?.usesRemaining).toBe(0);
  });

  it.each([undefined, "https://foreign.example", "file://127.0.0.1/config", "malformed homeserver"])(
    "rejects an ungranted or invalid homeserver without consuming the grant (%s)",
    async (homeserverUrl) => {
      const f = await fixture({ homeserverUrl });
      const result = await f.engine.invoke(f.request);
      expect(result.outcome).toBe("blocked");
      expect(result.policyReason).toContain("grant host constraints");
      expect(f.fetch).not.toHaveBeenCalled();
      expect((await f.readGrant())?.usesRemaining).toBe(1);
    },
  );
});
