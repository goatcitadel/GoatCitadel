import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { expect, it } from "vitest";
import { createSqliteAsyncStorage, Storage } from "@goatcitadel/storage";
import type { McpServerRecord } from "@goatcitadel/contracts";
import { McpServerStore } from "./mcp-server-store.js";
import { normalizeMcpPolicy } from "./mcp-server-policy.js";

it("serializes reviewed saves and deletes across independent SQLite Gateway owners", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "gc-mcp-review-races-"));
  const options = { dbPath: path.join(root, "fixture.db"), transcriptsDir: path.join(root, "transcripts"), auditDir: path.join(root, "audit") };
  const storage = createSqliteAsyncStorage(new Storage(options));
  const store = new McpServerStore({ systemSettings: storage.systemSettings, approvalInbox: storage.approvalInbox, runImmediateTransaction: callback => storage.runImmediateTransaction(callback) });
  try {
    for (const actions of [["save", "save"], ["save", "delete"], ["delete", "save"], ["delete", "delete"]]) {
      const server: McpServerRecord = { serverId: randomUUID(), label: "Original", transport: "stdio", command: "node", authType: "none", enabled: false, status: "disconnected", category: "development", trustTier: "restricted", costTier: "free", policy: normalizeMcpPolicy(), createdAt: "2026-09-13T00:00:00.000Z", updatedAt: "2026-09-13T00:00:00.000Z" };
      const previous = await store.readServers(); await store.writeServers([...previous, server], previous);
      const base = await store.requireServer(server.serverId);
      const gate = new SharedArrayBuffer(4);
      const workers = actions.map((action, index) => new Worker(SOURCE, { eval: true, workerData: { options, action, index, base, gate,
        tsx: pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm/api")).href,
        owner: new URL("./mcp-server-store.ts", import.meta.url).href,
        storage: new URL("../../../../packages/storage/src/index.ts", import.meta.url).href,
      } }));
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const channels = workers.map(worker => {
          let readyResolve!: () => void, readyReject!: (cause: Error) => void, doneResolve!: (value: { status: string; server?: McpServerRecord }) => void, doneReject!: (cause: Error) => void;
          const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
          const done = new Promise<{ status: string; server?: McpServerRecord }>((resolve, reject) => { doneResolve = resolve; doneReject = reject; });
          void ready.catch(() => undefined); void done.catch(() => undefined);
          const fail = (cause: Error) => { readyReject(cause); doneReject(cause); };
          worker.on("error", fail); worker.on("exit", code => { if (code !== 0) fail(new Error(`MCP writer exited ${code}`)); });
          worker.on("message", message => { if (message.kind === "ready") readyResolve(); else if (message.kind === "done") doneResolve(message.result); else fail(new Error(message.error)); });
          return { ready, done, fail };
        });
        timeout = setTimeout(() => channels.forEach(channel => channel.fail(new Error("MCP writer race timed out"))), 45_000);
        await Promise.all(channels.map(channel => channel.ready));
        Atomics.store(new Int32Array(gate), 0, 1); Atomics.notify(new Int32Array(gate), 0);
        const results = await Promise.all(channels.map(channel => channel.done));
        expect(results.filter(result => result.status === "saved")).toHaveLength(1);
        expect(results.filter(result => result.status === "conflict")).toHaveLength(1);
        const winner = results.find(result => result.status === "saved")!;
        if (winner.server) expect(await store.requireServer(server.serverId)).toMatchObject(JSON.parse(JSON.stringify(winner.server)));
        else await expect(store.requireServer(server.serverId)).rejects.toMatchObject({ httpStatus: 404 });
      } finally {
        clearTimeout(timeout); Atomics.store(new Int32Array(gate), 0, 1); Atomics.notify(new Int32Array(gate), 0);
        await Promise.all(workers.map(worker => worker.terminate()));
      }
    }
  } finally { await storage.close(); }
}, 180_000);

const SOURCE = String.raw`
const { parentPort, workerData: d } = require("node:worker_threads");
void (async () => {
  const { tsImport } = await import(d.tsx);
  const { Storage, createSqliteAsyncStorage } = await tsImport(d.storage, d.owner);
  const { McpServerStore } = await tsImport(d.owner, d.owner);
  const storage = createSqliteAsyncStorage(new Storage(d.options));
  try {
    const owner = new McpServerStore({ systemSettings: storage.systemSettings, approvalInbox: storage.approvalInbox, runImmediateTransaction: callback => storage.runImmediateTransaction(callback) });
    const previous = await owner.readServers();
    if (previous.find(server => server.serverId === d.base.serverId)?.revision !== d.base.revision) throw new Error("MCP writers reviewed different revisions");
    parentPort.postMessage({ kind: "ready" });
    if (Atomics.wait(new Int32Array(d.gate), 0, 0, 40_000) === "timed-out") throw new Error("MCP writer start timed out");
    let result;
    try {
      const desired = d.action === "delete" ? previous.filter(server => server.serverId !== d.base.serverId)
        : previous.map(server => server.serverId === d.base.serverId ? { ...server, label: "Writer " + d.index } : server);
      const saved = await owner.writeServers(desired, previous, { serverId: d.base.serverId, expectedRevision: d.base.revision });
      result = { status: "saved", server: saved.find(server => server.serverId === d.base.serverId) };
    } catch (error) { if ([404, 409].includes(error.httpStatus)) result = { status: "conflict" }; else throw error; }
    await storage.close(); parentPort.postMessage({ kind: "done", result });
  } catch (error) { await storage.close(); throw error; }
})().catch(error => { parentPort.postMessage({ kind: "error", error: error.stack || error.message }); });
`;
