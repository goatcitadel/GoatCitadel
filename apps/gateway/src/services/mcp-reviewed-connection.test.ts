import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createSqliteAsyncStorage, Storage, type AsyncStorage } from "@goatcitadel/storage";
import type { McpServerRecord } from "@goatcitadel/contracts";
import { McpServerStore } from "./mcp-server-store.js";
import { composeMcpAdministration } from "./gateway-route-composition-tools.js";
import { connectMcpServer, disconnectMcpServer } from "./mcp-server-admin-service.js";
import { McpStaticEnvironmentService, assertMcpStaticEnvironmentCurrent } from "./mcp-static-environment-service.js";

const opened: AsyncStorage[] = [];
afterEach(async () => {
  for (const storage of opened.splice(0)) await storage.close();
});
const review = (server: McpServerRecord) => ({
  expectedRevision: server.revision!,
  expectedConnectionRevision: server.connectionRevision ?? null,
});
async function fixture(empty = false) {
  const root = mkdtempSync(path.join(os.tmpdir(), "gc-mcp-connection-review-"));
  const storage = createSqliteAsyncStorage(
    new Storage({
      dbPath: ":memory:",
      transcriptsDir: path.join(root, "transcripts"),
      auditDir: path.join(root, "audit"),
    }),
  );
  opened.push(storage);
  const store = new McpServerStore({
    systemSettings: storage.systemSettings,
    approvalInbox: storage.approvalInbox,
    runImmediateTransaction: (callback) => storage.runImmediateTransaction(callback),
  });
  const original: McpServerRecord = {
    serverId: "reviewed",
    label: "Reviewed fixture",
    transport: empty ? "http" : "stdio",
    command: "node",
    url: empty ? "https://example.invalid" : undefined,
    args: ["fixture.mjs"],
    authType: "none",
    enabled: true,
    category: "development",
    trustTier: "restricted",
    costTier: "free",
    status: "disconnected",
    policy: {
      requireFirstToolApproval: true,
      redactionMode: "strict",
      allowedToolPatterns: [],
      blockedToolPatterns: [],
      allowedEnvKeys: empty ? [] : ["FIXTURE_TOKEN"],
    },
    createdAt: "2026-09-30T00:00:00Z",
    updatedAt: "2026-09-30T00:00:00Z",
  };
  await store.writeServers([original], []);
  const secrets = new Map<string, string>();
  const secretStore = {
    isWriteCustodySafe: () => true,
    getSecret: (account: string) => secrets.get(account),
    setSecret: vi.fn((account: string, value: string) => {
      secrets.set(account, value);
    }),
    deleteSecret: vi.fn((account: string) => {
      secrets.delete(account);
    }),
  };
  const environment = new McpStaticEnvironmentService({
    registry: store,
    secretStore,
    env: empty ? {} : { FIXTURE_TOKEN: "synthetic-fixture-value" },
  });
  const transport = vi.fn(async () => []);
  const close = vi.fn(() => undefined);
  const host = composeMcpAdministration(store, {
    storage,
    captureMcpServerSessionCloser: () => close,
    prepareMcpStaticEnvironment: (server, fence) => environment.enroll(server, fence),
    resolveConnectedMcpTools: async (server, _tools, fence) => {
      const handle = await environment.capture(server, fence);
      await assertMcpStaticEnvironmentCurrent(handle, server);
      return transport();
    },
    publishRealtime: async () => undefined,
  });
  return {
    store,
    storage,
    secretStore,
    environment,
    transport,
    close,
    host,
    original: await store.requireServer(original.serverId),
  };
}

it.each(["configuration", "connection"])(
  "rejects a stale %s review before environment writes, transport, or close",
  async (kind) => {
    const f = await fixture();
    if (kind === "connection") await f.store.patchServerState("reviewed", { status: "connecting" }, f.original);
    else {
      const all = await f.store.readServers();
      await f.store.writeServers(
        all.map((server) => ({ ...server, command: "peer" })),
        all,
      );
    }
    const winner = await f.store.requireServer("reviewed");
    for (const action of [connectMcpServer, disconnectMcpServer])
      await expect(action(f.host, "reviewed", review(f.original))).rejects.toMatchObject({ httpStatus: 409 });
    expect(f.secretStore.setSecret).not.toHaveBeenCalled();
    expect(f.transport).not.toHaveBeenCalled();
    expect(f.close).not.toHaveBeenCalled();
    expect(await f.store.requireServer("reviewed")).toEqual(winner);
  },
);

it("admits exactly one simultaneous reviewed connect and preserves the original fence through enrollment", async () => {
  const f = await fixture(),
    committed = vi.fn();
  const results = await Promise.allSettled([
    connectMcpServer(f.host, "reviewed", { ...review(f.original), onCommitted: committed }),
    connectMcpServer(f.host, "reviewed", { ...review(f.original), onCommitted: committed }),
  ]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(committed).toHaveBeenCalledOnce();
  expect(f.transport).toHaveBeenCalledOnce();
  expect(f.secretStore.setSecret).toHaveBeenCalledOnce();
  expect(await f.store.requireServer("reviewed")).toMatchObject({ status: "connected" });
});

it.each(["empty", "new", "matching"])(
  "refuses supersession at %s environment publication without adopting the replacement generation",
  async (branch) => {
    const f = await fixture(branch === "empty");
    if (branch === "matching") await f.environment.enroll(f.original);
    const current = await f.store.requireServer("reviewed");
    let replacement: McpServerRecord | undefined;
    const prepare = f.host.prepareMcpStaticEnvironment!;
    f.host.prepareMcpStaticEnvironment = async (server, fence) => {
      replacement = await f.store.patchServerState("reviewed", { status: "disconnected" }, server);
      return prepare(server, fence);
    };
    const count = f.secretStore.setSecret.mock.calls.length;
    await expect(connectMcpServer(f.host, "reviewed", review(current))).rejects.toMatchObject({
      mutationCommitted: true,
    });
    expect(f.transport).not.toHaveBeenCalled();
    expect(f.secretStore.setSecret).toHaveBeenCalledTimes(count);
    expect(await f.store.requireServer("reviewed")).toMatchObject(JSON.parse(JSON.stringify(replacement)));
  },
);

it("keeps captured environment fenced after capture and does not accept a caller-mutated fence", async () => {
  const f = await fixture();
  const connecting = await f.store.patchServerState("reviewed", { status: "connecting" }, f.original);
  const fence = { expectedConnectionRevision: connecting.connectionRevision! };
  const enrolled = await f.environment.enroll(connecting, fence);
  const handle = await f.environment.capture(enrolled, fence);
  const replacement = await f.store.patchServerState("reviewed", { status: "connecting" }, enrolled);
  fence.expectedConnectionRevision = replacement.connectionRevision!;
  await expect(assertMcpStaticEnvironmentCurrent(handle, enrolled)).rejects.toMatchObject({ httpStatus: 409 });
  expect(await f.store.requireServer("reviewed")).toMatchObject(JSON.parse(JSON.stringify(replacement)));
});

it("does not close a replacement session installed while disconnect publication awaited", async () => {
  const f = await fixture(),
    newerClose = vi.fn();
  const patch = f.host.patchMcpServerState;
  f.host.patchMcpServerState = async (...args) => {
    const own = await patch(...args);
    f.host.captureMcpServerSessionCloser = () => newerClose;
    await f.store.patchServerState("reviewed", { status: "connecting" }, own);
    return own;
  };
  const result = await disconnectMcpServer(f.host, "reviewed", review(f.original));
  expect(result.status).toBe("disconnected");
  expect(f.close).toHaveBeenCalledOnce();
  expect(newerClose).not.toHaveBeenCalled();
  expect((await f.store.requireServer("reviewed")).status).toBe("connecting");
});

it("retains canonical admission when marking the response claim fails without preparing credentials", async () => {
  const f = await fixture();
  await expect(
    connectMcpServer(f.host, "reviewed", {
      ...review(f.original),
      onCommitted: () => {
        throw new Error("fixture marker failure");
      },
    }),
  ).rejects.toMatchObject({ mutationCommitted: true });
  expect(f.secretStore.setSecret).not.toHaveBeenCalled();
  expect(f.transport).not.toHaveBeenCalled();
  expect((await f.store.requireServer("reviewed")).connectionRevision).not.toBe(f.original.connectionRevision);
});
