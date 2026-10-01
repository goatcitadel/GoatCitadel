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
  directory = await mkdtemp(path.join(os.tmpdir(), "goat-ntfy-grant-"));
  storage = createSqliteAsyncStorage(
    new Storage({
      dbPath: ":memory:",
      transcriptsDir: path.join(directory, "transcripts"),
      auditDir: path.join(directory, "audit"),
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  await storage?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function fixture(options: { baseUrl?: string; unbound?: boolean; deny?: boolean } = {}) {
  const workspace = await storage.workspaces.create({ name: `ntfy grant fixture ${++sequence}` });
  const connection = await storage.integrationConnections.create({
    catalogId: "channel.ntfy",
    kind: "channel",
    key: "ntfy",
    label: "Task fixture",
    enabled: true,
    workspaceId: options.unbound ? undefined : workspace.workspaceId,
    config: { ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }), topic: "opaque-topic" },
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
    tools: {
      approvalMode: "approve_risky",
      allow: ["channel.send", "http.get"],
      deny: options.deny ? ["channel.send"] : [],
    },
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
    args: { connectionId: connection.connectionId, target: "opaque-topic", message: "Synthetic test notice." },
  };
  const fetch = vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ id: "synthetic-provider-message" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetch);
  const readGrant = async () =>
    (await storage.toolGrants.list("workspace", workspace.workspaceId)).find((item) => item.grantId === grant.grantId);
  return { connection, grant, config, request, fetch, readGrant, engine: new ToolPolicyEngine(config, storage) };
}

describe("canonical ntfy endpoint host constraints", () => {
  it.each([false, true])(
    "admits the actual endpoint and consumes exactly one scoped grant (unbound=%s)",
    async (unbound) => {
      const f = await fixture({ baseUrl: "http://127.0.0.1:12345", unbound });
      const inspected = await f.engine.inspectAccess(f.request);
      expect(inspected.allowed).toBe(true);
      expect(inspected.matchedGrantId).toBe(f.grant.grantId);
      expect((await f.readGrant())?.usesRemaining).toBe(1);
      const result = await f.engine.invoke(f.request);
      expect(result.outcome).toBe("executed");
      expect(result.result).toMatchObject({
        status: "sent",
        deliveryStatus: "sent",
        providerMessageId: "synthetic-provider-message",
      });
      expect(f.fetch).toHaveBeenCalledTimes(1);
      expect(String(f.fetch.mock.calls[0]?.[0])).toBe("http://127.0.0.1:12345/opaque-topic");
      expect((await f.readGrant())?.usesRemaining).toBe(0);
    },
  );

  it.each([undefined, "https://foreign.example", "file://127.0.0.1/config", "malformed endpoint"])(
    "rejects an ungranted or invalid canonical endpoint without consuming the grant (%s)",
    async (baseUrl) => {
      const f = await fixture({ baseUrl });
      // A URL-shaped topic is encoded by ntfy; it cannot replace its configured origin.
      f.request.args.target = "http://127.0.0.1/pretend-origin";
      const result = await f.engine.invoke(f.request);
      expect(result.outcome).toBe("blocked");
      expect(result.policyReason).toContain("grant host constraints");
      expect(f.fetch).not.toHaveBeenCalled();
      expect((await f.readGrant())?.usesRemaining).toBe(1);
    },
  );

  it.each(["attachments", "files", "cookies"])("retains foreign %s host restrictions", async (collection) => {
    const f = await fixture({ baseUrl: "http://127.0.0.1:12345" });
    f.request.args[collection] = [{ url: "https://foreign.example/private" }];
    const result = await f.engine.invoke(f.request);
    expect(result.outcome).toBe("blocked");
    expect(result.policyReason).toContain("grant host constraints");
    expect(f.fetch).not.toHaveBeenCalled();
    expect((await f.readGrant())?.usesRemaining).toBe(1);
  });

  it("encodes a URL-looking topic on the original allowed endpoint", async () => {
    const f = await fixture({ baseUrl: "http://127.0.0.1:12345" });
    f.request.args.target = "https://foreign.example/path";
    expect((await f.engine.invoke(f.request)).outcome).toBe("executed");
    expect(String(f.fetch.mock.calls[0]?.[0])).toBe("http://127.0.0.1:12345/https%3A%2F%2Fforeign.example%2Fpath");
  });

  it.each(["foreign", "missing", "invalid-kind"])(
    "does not exempt a %s connection even with a loopback-looking topic",
    async (kind) => {
      const f = await fixture({ baseUrl: "http://127.0.0.1:12345" });
      if (kind === "foreign")
        await storage.integrationConnections.update(f.connection.connectionId, {
          expectedRevision: f.connection.revision,
          workspaceId: "other-workspace",
        });
      else if (kind === "missing") f.request.args.connectionId = "absent-connection";
      else {
        const other = await storage.integrationConnections.create({
          catalogId: "automation.ntfy",
          kind: "automation",
          key: "ntfy",
          label: "Invalid ntfy kind",
          config: { baseUrl: "http://127.0.0.1:12345" },
        });
        f.request.args.connectionId = other.connectionId;
      }
      f.request.args.target = "http://127.0.0.1/topic";
      const result = await f.engine.invoke(f.request);
      expect(result.outcome).toBe("blocked");
      expect(result.policyReason).toContain("grant host constraints");
      expect(f.fetch).not.toHaveBeenCalled();
      expect((await f.readGrant())?.usesRemaining).toBe(1);
    },
  );

  it("preserves deny-wins despite a matching endpoint grant", async () => {
    const f = await fixture({ baseUrl: "http://127.0.0.1:12345", deny: true });
    expect((await f.engine.invoke(f.request)).outcome).toBe("blocked");
    expect(f.fetch).not.toHaveBeenCalled();
    expect((await f.readGrant())?.usesRemaining).toBe(1);
  });

  it("keeps generic URL/target constraints for non-ntfy tools", async () => {
    const f = await fixture({ baseUrl: "http://127.0.0.1:12345" });
    await storage.toolGrants.create({
      toolPattern: "http.get",
      decision: "allow",
      scope: "workspace",
      scopeRef: f.request.workspaceId,
      grantType: "persistent",
      createdBy: "operator",
      constraints: { allowedHosts: ["127.0.0.1"] },
    });
    const result = await f.engine.inspectAccess({
      ...f.request,
      toolName: "http.get",
      args: { url: "http://127.0.0.1/data", target: "foreign.example" },
    });
    expect(result.allowed).toBe(false);
    expect(result.reasonCodes).toEqual(["grant_constraints_block"]);
  });

  it("rechecks the grant against a canonical endpoint changed after policy admission", async () => {
    const f = await fixture({ baseUrl: "http://127.0.0.1:12345" });
    const result = await f.engine.invoke(f.request, {
      beforeExecute: async () => {
        await storage.integrationConnections.update(f.connection.connectionId, {
          expectedRevision: f.connection.revision,
          config: { ...f.connection.config, baseUrl: "https://foreign.example" },
        });
      },
    });
    expect(f.fetch).not.toHaveBeenCalled();
    expect(result.result).toMatchObject({ status: "failed", deliveryStatus: "blocked" });
    expect((await f.readGrant())?.usesRemaining).toBe(0);
  });

  it.each(["workspace", "kind"])(
    "withholds dispatch when canonical ntfy %s changes after admission",
    async (change) => {
      const f = await fixture({ baseUrl: "http://127.0.0.1:12345" });
      const result = await f.engine.invoke(f.request, {
        beforeExecute: async () => {
          if (change === "workspace") {
            await storage.integrationConnections.update(f.connection.connectionId, {
              expectedRevision: f.connection.revision,
              workspaceId: "other-workspace",
            });
          } else {
            // Kind is immutable through public updates. Inject corrupt retained
            // owner evidence in this disposable SQLite store at the same boundary.
            await storage.db
              .prepare("UPDATE integration_connections SET kind = ? WHERE connection_id = ?")
              .run("automation", f.connection.connectionId);
          }
        },
      });
      expect(result.outcome).toBe("blocked");
      expect(result.policyReason).toContain("ntfy connection scope");
      expect(f.fetch).not.toHaveBeenCalled();
      expect(await storage.commsDeliveries.list(f.connection.connectionId)).toEqual([]);
      // Admission consumes the one-use grant; a rejected dispatch cannot reuse it.
      expect((await f.readGrant())?.usesRemaining).toBe(0);
    },
  );
});
