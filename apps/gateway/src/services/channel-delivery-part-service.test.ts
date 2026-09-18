import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ToolInvokeRequest, ToolPolicyConfig } from "@goatcitadel/contracts";
import { createSqliteAsyncStorage, Storage, type AsyncStorage } from "@goatcitadel/storage";
import { ToolPolicyEngine } from "@goatcitadel/policy-engine";
import { ChannelDeliveryRuntimeService } from "./channel-delivery-runtime-service.js";
import { sendQueuedChannelDeliveryWithParts } from "./channel-delivery-part-service.js";
import type { CommsHost } from "./comms-service.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const close of cleanup.splice(0)) await close();
});

async function fixture(message = "one acknowledged message") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "goat-channel-handoff-"));
  const options = {
    dbPath: path.join(root, "index.db"),
    transcriptsDir: path.join(root, "transcripts"),
    auditDir: path.join(root, "audit"),
  };
  let storage: AsyncStorage = createSqliteAsyncStorage(new Storage(options));
  cleanup.push(async () => {
    await storage.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const connection = await storage.integrationConnections.create({
    catalogId: "telegram",
    kind: "channel",
    key: "telegram",
    label: "Test Telegram",
    config: { botToken: "synthetic-local-transport", defaultChatId: "-123456" },
  });
  const policy: ToolPolicyConfig = {
    profiles: { minimal: ["channel.send"] },
    tools: { profile: "minimal", allow: ["channel.send"], deny: [] },
    agents: {},
    sandbox: {
      writeJailRoots: [root],
      readOnlyRoots: [],
      networkAllowlist: ["api.telegram.org"],
      riskyShellPatterns: [],
      requireApprovalForRiskyShell: true,
    },
  };
  let engine = new ToolPolicyEngine(policy, storage);
  let clock = Date.now();
  const calls: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init: RequestInit) => {
      calls.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ ok: true, result: { message_id: 100 + calls.length } }), { status: 200 });
    }),
  );
  const host = {
    getIntegrationConnection: (id: string) => storage.integrationConnections.get(id),
    readChatAttachmentContent: vi.fn(),
    invokeAndUnwrap: async (request: ToolInvokeRequest) => {
      const result = await engine.invoke(request);
      return result.outcome === "executed" ? (result.result ?? {}) : result;
    },
  } as unknown as CommsHost;
  const createRuntime = () =>
    new ChannelDeliveryRuntimeService({
      repository: storage.commsDeliveries,
      parts: storage.channelDeliveryParts,
      send: (input) => sendQueuedChannelDeliveryWithParts(storage, host, input),
      now: () => new Date(clock),
    });
  let runtime = createRuntime();
  const queued = await runtime.enqueue({
    connectionId: connection.connectionId,
    channelKey: "telegram",
    target: "-123456",
    payload: { connectionId: connection.connectionId, target: "-123456", message },
    baseBackoffMs: 1_000,
  });
  async function drain() {
    const row = await storage.commsDeliveries.getById(queued.deliveryId);
    clock = Math.max(clock, Date.parse(row?.nextAttemptAt ?? new Date(clock).toISOString()));
    return runtime.drainDue();
  }
  async function approvalFor(index = 0) {
    const part = (await storage.channelDeliveryParts.list(queued.deliveryId, 1))[index];
    expect(part?.approvalId).toBeTruthy();
    return storage.pendingApprovalActions.get(part!.approvalId!);
  }
  async function executeApproved(index = 0) {
    const action = await approvalFor(index);
    await storage.approvals.resolve(action.approvalId, { decision: "approve", resolvedBy: "operator" });
    return engine.executeApprovedAction(action.approvalId);
  }
  async function restart() {
    await storage.close();
    storage = createSqliteAsyncStorage(new Storage(options));
    engine = new ToolPolicyEngine(policy, storage);
    runtime = createRuntime();
  }
  return {
    get engine() {
      return engine;
    },
    get storage() {
      return storage;
    },
    get runtime() {
      return runtime;
    },
    queued,
    calls,
    drain,
    approvalFor,
    executeApproved,
    restart,
  };
}

describe("canonical channel approval handoff", () => {
  it("keeps a provider request in progress pending until its single acknowledgement commits", async () => {
    const f = await fixture();
    await f.drain();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const send = vi.fn(async () => {
      await gate;
      return new Response(JSON.stringify({ ok: true, result: { message_id: 201 } }), { status: 200 });
    });
    vi.stubGlobal("fetch", send);
    const execution = f.executeApproved();
    try {
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
      expect((await f.drain())[0]).toMatchObject({ status: "waiting_approval", attempts: 1 });
      expect((await f.storage.channelDeliveryParts.list(f.queued.deliveryId, 1))[0]?.status).toBe("dispatching");
    } finally {
      release();
    }
    await execution;
    expect((await f.drain())[0]).toMatchObject({ status: "sent", providerMessageId: "201", attempts: 1 });
    expect(send).toHaveBeenCalledTimes(1);
  }, 60_000);

  it("rejects an unregistered part and rolls back its approval and pending action", async () => {
    const f = await fixture();
    await expect(
      f.engine.invoke({
        toolName: "channel.send",
        agentId: "operator",
        sessionId: "session",
        toolRunId: `channel-part-${"a".repeat(64)}`,
        args: { connectionId: f.queued.connectionId, target: "-123456", message: "unregistered" },
      }),
    ).rejects.toThrow(/identity is missing/);
    expect(await f.storage.gatewaySql.prepare("SELECT COUNT(*) AS n FROM approvals").get()).toMatchObject({ n: 0 });
    expect(
      await f.storage.gatewaySql.prepare("SELECT COUNT(*) AS n FROM pending_approval_actions").get(),
    ).toMatchObject({ n: 0 });
    expect(f.calls).toHaveLength(0);
  }, 25_000);

  it("cannot use a queued part approval after stripping its server-owned tool identity", async () => {
    const f = await fixture();
    await f.drain();
    const action = await f.approvalFor();
    await f.storage.approvals.resolve(action.approvalId, { decision: "approve", resolvedBy: "operator" });
    const result = await f.engine.invoke({
      ...(action.request as unknown as ToolInvokeRequest),
      toolRunId: undefined,
      consentContext: { source: "ui", reason: `approval:${action.approvalId}` },
    });
    expect(result.outcome).toBe("approval_required");
    expect(f.calls).toHaveLength(0);
    expect((await f.storage.channelDeliveryParts.list(f.queued.deliveryId, 1))[0]?.status).toBe("waiting_approval");
  }, 25_000);

  it("waits, executes one approved send, and settles the original queue after reopening storage", async () => {
    const f = await fixture();
    expect((await f.drain())[0]).toMatchObject({ status: "waiting_approval", attempts: 1 });
    expect(f.calls).toHaveLength(0);
    expect(await f.executeApproved()).toMatchObject({ outcome: "executed", result: { status: "sent" } });
    const diagnostics = (await f.storage.commsDeliveries.getById(f.queued.deliveryId))?.deliveryDiagnostics;
    expect(diagnostics?.chunking?.partCount).toBe(1);
    await f.restart();
    expect((await f.storage.commsDeliveries.getById(f.queued.deliveryId))?.deliveryDiagnostics).toEqual(diagnostics);
    expect((await f.drain())[0]).toMatchObject({
      deliveryId: f.queued.deliveryId,
      status: "sent",
      attempts: 1,
      providerMessageId: "101",
    });
    expect(await f.drain()).toEqual([]);
    expect(f.calls).toHaveLength(1);
    const [part] = await f.storage.channelDeliveryParts.list(f.queued.deliveryId, 1);
    expect(part).toMatchObject({ status: "sent" });
    expect(await f.storage.commsDeliveries.getById(part!.providerDeliveryId!)).toMatchObject({
      status: "sent",
      providerMessageId: "101",
    });
    expect((await f.storage.commsDeliveries.list()).map((row) => row.deliveryId)).toEqual([f.queued.deliveryId]);
  }, 25_000);

  it("resumes a split message through separate approvals without repeating acknowledged parts", async () => {
    const f = await fixture("a".repeat(5_000));
    expect((await f.drain())[0]?.status).toBe("waiting_approval");
    await f.executeApproved(0);
    await f.restart();
    expect((await f.drain())[0]).toMatchObject({ status: "waiting_approval", attempts: 1 });
    expect(f.calls).toHaveLength(1);
    const second = await f.approvalFor(1);
    expect((second.request.args as Record<string, unknown>).replyToMessageId).toBe("101");
    await f.executeApproved(1);
    await f.restart();
    expect((await f.drain())[0]).toMatchObject({ status: "sent", providerMessageId: "102", attempts: 1 });
    expect(await f.drain()).toEqual([]);
    expect(f.calls).toHaveLength(2);
    expect(f.calls.map((call) => String(call.text)).join("")).toBe("a".repeat(5_000));
  }, 25_000);

  it.each(["rejected", "expired"])(
    "settles a %s approval with no provider dispatch",
    async (state) => {
      const f = await fixture();
      await f.drain();
      const action = await f.approvalFor();
      if (state === "rejected")
        await f.storage.approvals.resolve(action.approvalId, { decision: "reject", resolvedBy: "operator" });
      else
        await f.storage.gatewaySql
          .prepare("UPDATE approvals SET expires_at = ? WHERE approval_id = ?")
          .run(new Date(Date.now() - 1_000).toISOString(), action.approvalId);
      await f.restart();
      expect((await f.drain())[0]).toMatchObject({ status: "failed", deliveryStatus: "blocked", attempts: 1 });
      expect(f.calls).toHaveLength(0);
      expect(await f.drain()).toEqual([]);
    },
    25_000,
  );

  it("retains partial-send evidence when a later part is rejected", async () => {
    const f = await fixture("b".repeat(5_000));
    await f.drain();
    await f.executeApproved(0);
    await f.drain();
    const action = await f.approvalFor(1);
    await f.storage.approvals.resolve(action.approvalId, { decision: "reject", resolvedBy: "operator" });
    await f.restart();
    expect((await f.drain())[0]).toMatchObject({ status: "manual_reconciliation_required", providerMessageId: "101" });
    expect(f.calls).toHaveLength(1);
    expect(await f.drain()).toEqual([]);
  }, 25_000);

  it("quarantines an unknown provider outcome without retrying after restart", async () => {
    const f = await fixture();
    await f.drain();
    let sends = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        sends++;
        throw new Error("socket closed after request");
      }),
    );
    await f.executeApproved();
    await f.restart();
    expect((await f.drain())[0]?.status).toBe("manual_reconciliation_required");
    expect(sends).toBe(1);
    expect(await f.drain()).toEqual([]);
  }, 25_000);

  it("refuses approved dispatch when the original delivery has already been finalized", async () => {
    const f = await fixture();
    await f.drain();
    await f.storage.commsDeliveries.markFailed(f.queued.deliveryId, "cancelled", undefined, "blocked");
    await f.executeApproved();
    expect(f.calls).toHaveLength(0);
    expect(await f.storage.commsDeliveries.getById(f.queued.deliveryId)).toMatchObject({
      status: "failed",
      error: "cancelled",
    });
    expect(await f.storage.commsDeliveries.list()).toHaveLength(1);
  }, 25_000);
});
