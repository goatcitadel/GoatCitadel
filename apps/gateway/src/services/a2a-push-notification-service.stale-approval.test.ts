import { afterEach, describe, expect, it, vi } from "vitest";
import type { A2ABridgeTask, A2ABridgeTaskEvent, ApprovalCreateInput, ApprovalRequest } from "@goatcitadel/contracts";
import { createSqliteAsyncStorage, Storage } from "@goatcitadel/storage";
import type { GatewayRuntimeConfig } from "../config.js";
import { A2APushNotificationService } from "./a2a-push-notification-service.js";
import { buildCitadelWardApprovalEffectDeps } from "./citadel-ward-approval-effect-service.js";

const PEER = { peerId: "peer-1", scopes: ["a2a:jsonrpc"] };
const TASK_ID = "a2a-task-stale";
const PUSH_URL = "https://peer.example/a2a/push";

interface PushRequest {
  taskId: string;
  peerId: string;
  eventSequence: number;
  configCreatedAt?: string;
}

describe("A2APushNotificationService stale push approvals", () => {
  let storage: Storage | undefined;

  afterEach(() => {
    storage?.close();
    storage = undefined;
  });

  function event(sequence: number): A2ABridgeTaskEvent {
    return {
      sequence,
      kind: "task.status",
      timestamp: `2026-06-01T00:00:0${sequence}.000Z`,
    } as A2ABridgeTaskEvent;
  }

  /** Defers event 5 behind approval A on the original config. */
  async function createPush(afterConfigRead?: () => Promise<void>) {
    storage = new Storage({ dbPath: ":memory:", transcriptsDir: ".", auditDir: "." });
    const sync = storage;
    const asyncStorage = createSqliteAsyncStorage(sync);
    const pushConfigs = asyncStorage.a2aTaskPushConfigs;
    const observedPushConfigs = new Proxy(pushConfigs, {
      get(target, property, receiver) {
        if (property === "find" && afterConfigRead) {
          return async (...args: Parameters<typeof target.find>) => {
            const config = await target.find(...args);
            await afterConfigRead();
            return config;
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    sync.a2aTaskBindings.createOrGet(
      { a2aTaskId: TASK_ID, contextId: "ctx-stale", peerId: PEER.peerId, idempotencyKey: "stale-1" },
      "2026-06-01T00:00:00.000Z",
    );
    sync.citadels.addWard({
      citadelId: "personal",
      name: "Push approval",
      actionPattern: "a2a.outbound.push",
      effect: "require_approval",
    });
    let events = [event(5)];
    let approvalNumber = 0;
    const approvals = new Map<string, ApprovalCreateInput>();
    const createApproval = vi.fn(async (input: ApprovalCreateInput) => {
      const approvalId = `approval-${String.fromCharCode(65 + approvalNumber++)}`;
      approvals.set(approvalId, input);
      return { approvalId, kind: input.kind, status: "pending" } as ApprovalRequest;
    });
    const pushDeliveryFetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 202 }));
    const service = new A2APushNotificationService({
      config: { toolPolicy: { sandbox: { networkAllowlist: ["peer.example"] } } } as unknown as GatewayRuntimeConfig,
      storage: new Proxy(asyncStorage, {
        get(target, property, receiver) {
          return property === "a2aTaskPushConfigs" ? observedPushConfigs : Reflect.get(target, property, receiver);
        },
      }),
      tasks: { appendTaskActivity: vi.fn() } as never,
      mutationIdempotencyStore: asyncStorage.mutationIdempotency,
      pushDeliveryFetch: pushDeliveryFetch as never,
      buildTaskFromBinding: (binding) => ({ id: binding.a2aTaskId }) as A2ABridgeTask,
      buildEventsForTask: (_task, since) => events.filter((item) => item.sequence > since),
      createApproval,
    });
    const setConfig = (checkedAt: string) =>
      service.setTaskPushNotificationConfig(
        PEER,
        { taskId: TASK_ID, pushNotificationConfig: { url: PUSH_URL, events: ["task.status"] } },
        checkedAt,
      );

    await setConfig("2026-06-01T00:00:01.000Z");
    async function recreate() {
      await service.deleteTaskPushNotificationConfig(PEER, { taskId: TASK_ID }, "2026-06-01T00:00:02.000Z");
      events = [event(1)];
      await setConfig("2026-06-01T00:00:03.000Z");
    }

    const requestOf = (approvalId: string) => {
      const input = approvals.get(approvalId);
      return { input: input!, request: (input!.payload as { request: PushRequest & { urlHash: string } }).request };
    };
    return { sync, asyncStorage, service, createApproval, pushDeliveryFetch, requestOf, recreate };
  }

  async function createRecreatedPush() {
    const harness = await createPush();
    await harness.recreate();
    return harness;
  }

  function approve(harness: Awaited<ReturnType<typeof createRecreatedPush>>, approvalId: string) {
    const { request, input } = harness.requestOf(approvalId);
    const payload = input.payload as { citadelId: string; workspaceId?: string };
    return harness.service.deliverApprovedPush(
      {
        approvalId,
        wardAction: "a2a.outbound.push",
        taskId: request.taskId,
        peerId: request.peerId,
        eventSequence: request.eventSequence,
        urlHash: request.urlHash,
        citadelId: payload.citadelId,
        ...(payload.workspaceId !== undefined ? { workspaceId: payload.workspaceId } : {}),
        ...(request.configCreatedAt !== undefined ? { configCreatedAt: request.configCreatedAt } : {}),
      },
      "2026-06-01T00:00:05.000Z",
    );
  }

  it("opens approval A for event 5 and approval B for event 1 of the re-created config", async () => {
    const harness = await createRecreatedPush();

    expect(harness.createApproval).toHaveBeenCalledTimes(2);
    expect(harness.requestOf("approval-A").request).toMatchObject({
      eventSequence: 5,
      configCreatedAt: "2026-06-01T00:00:01.000Z",
    });
    expect(harness.requestOf("approval-B").request).toMatchObject({
      eventSequence: 1,
      configCreatedAt: "2026-06-01T00:00:03.000Z",
    });
  });

  it("a refusal of the stale approval leaves the re-created config deferred at event 0", async () => {
    const harness = await createRecreatedPush();
    const stale = harness.requestOf("approval-A").request;

    await harness.service.recordRefusedPushApproval(
      {
        approvalId: "approval-A",
        taskId: stale.taskId,
        peerId: stale.peerId,
        eventSequence: stale.eventSequence,
        disposition: "rejected",
        ...(stale.configCreatedAt !== undefined ? { configCreatedAt: stale.configCreatedAt } : {}),
      },
      "2026-06-01T00:00:04.000Z",
    );

    expect(harness.sync.a2aTaskPushConfigs.get(TASK_ID, PEER.peerId)).toMatchObject({
      lastDeliveryStatus: "deferred_pending_approval",
      lastEventSequence: 0,
    });
    const results = await approve(harness, "approval-B");
    expect(results[0]).toMatchObject({ status: "delivered", eventSequence: 1 });
    expect(harness.pushDeliveryFetch).toHaveBeenCalledTimes(1);
    expect(harness.sync.a2aTaskPushConfigs.get(TASK_ID, PEER.peerId)).toMatchObject({
      lastDeliveryStatus: "delivered",
      lastEventSequence: 1,
    });
  });

  it("does not advance a replacement config after reading the original for a refusal", async () => {
    let holdNextRead = false;
    let notifyRead!: () => void;
    let releaseRead!: () => void;
    const read = new Promise<void>((resolve) => {
      notifyRead = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const harness = await createPush(async () => {
      if (!holdNextRead) return;
      holdNextRead = false;
      notifyRead();
      await release;
    });
    const { configCreatedAt, taskId, peerId, eventSequence } = harness.requestOf("approval-A").request;
    expect(configCreatedAt).toBe("2026-06-01T00:00:01.000Z");
    holdNextRead = true;
    const refusal = harness.service.recordRefusedPushApproval(
      { approvalId: "approval-A", taskId, peerId, eventSequence, disposition: "rejected", configCreatedAt },
      "2026-06-01T00:00:04.000Z",
    );
    try {
      await Promise.race([
        read,
        refusal.then(() => {
          throw new Error("The refusal settled before the original config was read.");
        }),
      ]);
      await harness.recreate();
      expect(harness.sync.a2aTaskPushConfigs.get(TASK_ID, PEER.peerId)).toMatchObject({
        createdAt: "2026-06-01T00:00:03.000Z",
        lastDeliveryStatus: "deferred_pending_approval",
        lastEventSequence: 0,
      });
    } finally {
      releaseRead();
      await refusal;
    }

    expect(harness.sync.a2aTaskPushConfigs.get(TASK_ID, PEER.peerId)).toMatchObject({
      createdAt: "2026-06-01T00:00:03.000Z",
      lastDeliveryStatus: "deferred_pending_approval",
      lastEventSequence: 0,
    });
    expect(harness.pushDeliveryFetch).not.toHaveBeenCalled();
  });

  it("a refusal from an approval opened before configCreatedAt was recorded keeps today's behavior", async () => {
    const harness = await createRecreatedPush();
    const { configCreatedAt: _configCreatedAt, ...legacy } = harness.requestOf("approval-A").request;

    await harness.service.recordRefusedPushApproval(
      { approvalId: "approval-A", ...legacy, disposition: "rejected" },
      "2026-06-01T00:00:04.000Z",
    );

    expect(harness.sync.a2aTaskPushConfigs.get(TASK_ID, PEER.peerId)).toMatchObject({
      lastDeliveryStatus: "blocked",
      lastEventSequence: 5,
    });
  });

  it("approving the stale approval through the effect service fails and leaves the config unchanged", async () => {
    const harness = await createRecreatedPush();
    const before = harness.sync.a2aTaskPushConfigs.get(TASK_ID, PEER.peerId);
    const staleInput = harness.requestOf("approval-A").input;
    const approval = {
      approvalId: "approval-A",
      kind: staleInput.kind,
      riskLevel: "caution",
      status: "approved",
      payload: staleInput.payload,
      preview: {},
      createdAt: "2026-06-01T00:00:01.000Z",
      explanationStatus: "not_requested",
    } as ApprovalRequest;
    const executors = buildCitadelWardApprovalEffectDeps({
      requestVault: () => undefined,
      storage: {
        approvals: { get: async () => approval },
        a2aTaskPushConfigs: harness.asyncStorage.a2aTaskPushConfigs,
      } as never,
      integrationHost: () => {
        throw new Error("no integration host in this test");
      },
      a2a: () => harness.service as never,
    });

    await expect(executors.executeApprovedCitadelWardAction({ approvalId: "approval-A" })).rejects.toMatchObject({
      code: "blocked",
    });

    expect(harness.sync.a2aTaskPushConfigs.get(TASK_ID, PEER.peerId)).toEqual(before);
    expect(harness.pushDeliveryFetch).not.toHaveBeenCalled();
    const results = await approve(harness, "approval-B");
    expect(results[0]).toMatchObject({ status: "delivered", eventSequence: 1 });
    expect(harness.pushDeliveryFetch).toHaveBeenCalledTimes(1);
  });
});
