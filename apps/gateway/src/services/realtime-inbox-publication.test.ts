import { afterEach, describe, expect, it, vi } from "vitest";
import type { RealtimeEvent } from "@goatcitadel/contracts";
import { createSqliteAsyncStorage, Storage } from "@goatcitadel/storage";
import { RealtimeEventService, IDEMPOTENT_REALTIME_ENVELOPE_KEY } from "./realtime-event-service.js";
import { TaskLifecycleService } from "./task-lifecycle-service.js";

const stores: Storage[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const storage of stores.splice(0)) storage.close();
});

function harness() {
  const storage = new Storage({ dbPath: ":memory:", transcriptsDir: ".", auditDir: "." });
  stores.push(storage);
  const asyncStorage = createSqliteAsyncStorage(storage);
  const originalAppend = asyncStorage.realtimeEvents.appendIdempotent.bind(asyncStorage.realtimeEvents);
  const appendIdempotent = vi.fn(originalAppend);
  const realtimeEvents = new Proxy(asyncStorage.realtimeEvents, {
    get(target, property) {
      return property === "appendIdempotent" ? appendIdempotent : Reflect.get(target, property);
    },
  });
  const service = new RealtimeEventService({ storage: { realtimeEvents, realtimeStreamLeases: asyncStorage.realtimeStreamLeases }, getGatewayNodeId: () => "test" });
  const delivered: RealtimeEvent[] = [];
  service.subscribeRealtime((event) => delivered.push(event));
  return { storage, asyncStorage, service, delivered, originalAppend, appendIdempotent };
}

const options = {
  eventClass: "domain_fact" as const, eventAuthority: "retained_stream" as const,
  links: { approvalId: "approval-a", workspaceId: "workspace-a" },
};
const payload = {
  approvalId: "approval-a",
  [IDEMPOTENT_REALTIME_ENVELOPE_KEY]: { deliveryId: "approval-a:created", occurredAt: "2026-09-30T14:00:00.000Z" },
};

describe("retained Inbox invalidation publication", () => {
  it("retains and emits one derivative for repeated committed owner delivery without changing the original", async () => {
    const { service, storage, delivered } = harness();
    const original = await service.publishRealtime("approval_created", "approvals", payload, options);
    const replayed = await service.publishRealtime("approval_created", "approvals", payload, options);
    expect(replayed).toEqual(original);
    expect(original.eventType).toBe("approval_created");
    expect(delivered.map((event) => event.eventType)).toEqual(["approval_created", "inbox.changed"]);
    const [owner, invalidation] = storage.realtimeEvents.listAfterSequence(0, 10);
    expect(owner).toEqual(original);
    expect(invalidation).toMatchObject({
      eventId: `inbox.changed:${original.eventId}`, source: "operator_inbox", eventType: "inbox.changed",
      eventClass: "operational_signal", eventAuthority: "retained_stream", links: { workspaceId: "workspace-a" },
      timestamp: original.timestamp, payload: { sourceEventId: original.eventId, family: "approvals", scope: "workspace" },
    });
    expect(invalidation!.sequence).toBeGreaterThan(original.sequence);
    expect(Object.keys(invalidation!.payload).sort()).toEqual(["deliveryId", "family", "scope", "sourceEventId"]);
  });

  it("does not append or emit a derivative until the source append completes", async () => {
    const { service, originalAppend, appendIdempotent, delivered } = harness();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const calls: string[] = [];
    appendIdempotent.mockImplementation(async (...args) => {
      calls.push(args[0]);
      if (args[0] === "approval_created") await gate;
      return originalAppend(...args);
    });
    const pending = service.publishRealtime("approval_created", "approvals", payload, options);
    await Promise.resolve();
    expect(calls).toEqual(["approval_created"]);
    expect(delivered).toEqual([]);
    release();
    await pending;
    expect(calls).toEqual(["approval_created", "inbox.changed"]);
    expect(delivered.map((event) => event.eventType)).toEqual(calls);
  });

  it("does not emit either event when original persistence fails", async () => {
    const { service, appendIdempotent, delivered, storage } = harness();
    const append = appendIdempotent.mockRejectedValue(new Error("source failed"));
    await expect(service.publishRealtime("approval_created", "approvals", payload, options)).rejects.toThrow("source failed");
    expect(append).toHaveBeenCalledOnce();
    expect(delivered).toEqual([]);
    expect(storage.realtimeEvents.list(10)).toEqual([]);
  });

  it("preserves committed success when derivative persistence fails and repairs it on the same owner delivery", async () => {
    const { service, originalAppend, appendIdempotent, delivered } = harness();
    let failDerivative = true;
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    appendIdempotent.mockImplementation(async (...args) => {
      if (args[0] === "inbox.changed" && failDerivative) throw new Error("private database details");
      return originalAppend(...args);
    });
    const original = await service.publishRealtime("approval_created", "approvals", payload, options);
    expect(delivered.map((event) => event.eventType)).toEqual(["approval_created"]);
    expect(console.warn).toHaveBeenCalledWith(expect.any(String), { eventId: original.eventId });
    failDerivative = false;
    await expect(service.publishRealtime("approval_created", "approvals", payload, options)).resolves.toEqual(original);
    await service.publishRealtime("approval_created", "approvals", payload, options);
    expect(delivered.map((event) => event.eventType)).toEqual(["approval_created", "inbox.changed"]);
  });

  it("preserves committed owner success when both derivative persistence and its diagnostic sink fail", async () => {
    const { service, storage, originalAppend, appendIdempotent, delivered } = harness();
    let failDerivative = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {
      throw new Error("diagnostic sink unavailable");
    });
    appendIdempotent.mockImplementation(async (...args) => {
      if (args[0] === "inbox.changed" && failDerivative) throw new Error("private database details");
      return originalAppend(...args);
    });

    const original = await service.publishRealtime("approval_created", "approvals", payload, options);
    expect(original.eventId).toBe("approval-a:created");
    expect(storage.realtimeEvents.listAfterSequence(0, 10)).toEqual([original]);
    expect(delivered).toEqual([original]);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "[goatcitadel] Inbox invalidation failed after retained owner event",
      { eventId: original.eventId },
    );

    failDerivative = false;
    await expect(service.publishRealtime("approval_created", "approvals", payload, options)).resolves.toEqual(original);
    await expect(service.publishRealtime("approval_created", "approvals", payload, options)).resolves.toEqual(original);
    expect(storage.realtimeEvents.listAfterSequence(0, 10).map((event) => event.eventId)).toEqual([
      original.eventId, `inbox.changed:${original.eventId}`,
    ]);
    expect(delivered.map((event) => event.eventId)).toEqual([
      original.eventId, `inbox.changed:${original.eventId}`,
    ]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("does not republish while replaying/listing or recursively derive another invalidation", async () => {
    const { service, storage, delivered } = harness();
    await service.publishRealtime("approval_created", "approvals", payload, options);
    const before = storage.realtimeEvents.listAfterSequence(0, 10);
    const listenerCount = delivered.length;
    expect(await service.listRealtimeEventsAfterSequence(0)).toEqual(before);
    await service.listRealtimeEvents();
    expect(storage.realtimeEvents.listAfterSequence(0, 10)).toEqual(before);
    expect(delivered).toHaveLength(listenerCount);
    const invalidation = before[1]!;
    await service.publishRealtime(invalidation.eventType, invalidation.source, {
      ...invalidation.payload,
      [IDEMPOTENT_REALTIME_ENVELOPE_KEY]: { deliveryId: invalidation.eventId, occurredAt: invalidation.timestamp },
    }, { eventClass: invalidation.eventClass, eventAuthority: invalidation.eventAuthority, links: invalidation.links });
    expect(storage.realtimeEvents.listAfterSequence(0, 10)).toEqual(before);
    expect(delivered).toHaveLength(listenerCount);
  });

  it("isolates throwing subscribers without exposing the derivative to the approval-token channel", async () => {
    const { service, delivered } = harness();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    service.subscribeRealtime(() => { throw new Error("broken subscriber"); });
    const tokenListener = vi.fn();
    service.subscribeRealtime(tokenListener, { includeApprovalActionTokens: true });
    await service.publishRealtime("approval_created", "approvals", { ...payload, token: "synthetic-secret" }, options);
    expect(delivered.map((event) => event.eventType)).toEqual(["approval_created", "inbox.changed"]);
    expect(tokenListener).toHaveBeenCalledTimes(2);
    expect(tokenListener.mock.calls[1]![0].payload).not.toHaveProperty("token");
  });

  it("observes the canonical task/deliverable before its live Inbox signal", async () => {
    const { service, storage, asyncStorage, delivered } = harness();
    const owner = new TaskLifecycleService({ storage: asyncStorage, publishRealtime: service.publishRealtime.bind(service) });
    const task = await owner.createTask({ workspaceId: "default", title: "Inbox committed deliverable" });
    const observations: number[] = [];
    service.subscribeRealtime((event) => {
      if (event.eventType === "inbox.changed") observations.push(storage.taskDeliverables.listByTask(task.taskId, 10).length);
    });
    const deliverable = await owner.appendTaskDeliverable(task.taskId, { title: "Ready", deliverableType: "file", path: "report.txt" });
    expect(observations).toEqual([1]);
    expect(storage.taskDeliverables.listByTask(task.taskId, 10)[0]?.deliverableId).toBe(deliverable.deliverableId);
    const source = delivered.find((event) => event.eventType === "deliverable_added")!;
    expect(delivered.find((event) => event.eventId === `inbox.changed:${source.eventId}`)?.links?.workspaceId).toBe("default");
  });
});
