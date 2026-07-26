import Fastify, { type FastifyInstance } from "fastify";
import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sharedHostLifecyclePlugin, __internal } from "./shared-host-lifecycle.js";
import { sharedHostLifecycleRoutes } from "../routes/shared-host-lifecycle.js";

const apps: FastifyInstance[] = [];
const originalEnabled = process.env.GOATCITADEL_SHARED_HOST_DRAIN_ENABLED;

afterEach(async () => {
  while (apps.length > 0) await apps.pop()?.close();
  if (originalEnabled === undefined) delete process.env.GOATCITADEL_SHARED_HOST_DRAIN_ENABLED;
  else process.env.GOATCITADEL_SHARED_HOST_DRAIN_ENABLED = originalEnabled;
});

describe("sharedHostLifecyclePlugin", () => {
  it("keeps local mode default-off and exposes an explicit opt-in conflict", async () => {
    delete process.env.GOATCITADEL_SHARED_HOST_DRAIN_ENABLED;
    const { app } = await createHarness();
    await app.register(sharedHostLifecycleRoutes);

    expect((await app.inject({ method: "GET", url: "/api/v1/ops/shared-host" })).json()).toMatchObject({
      lifecycle: { enabled: false, mode: "local_always_available", admission: "open" },
    });
    const drain = await app.inject({
      method: "POST",
      url: "/api/v1/ops/shared-host/drain",
      payload: { mode: "pause", timeoutMs: 10, reason: "test" },
    });
    expect(drain.statusCode).toBe(409);
    expect(drain.json()).toMatchObject({ code: "SHARED_HOST_DRAIN_DISABLED" });
  });

  it("lets an authenticated operator start a bounded pause drain and continue reading its state", async () => {
    process.env.GOATCITADEL_SHARED_HOST_DRAIN_ENABLED = "true";
    const { app } = await createHarness();
    await app.register(sharedHostLifecycleRoutes);

    const drain = await app.inject({
      method: "POST",
      url: "/api/v1/ops/shared-host/drain",
      payload: { mode: "pause", timeoutMs: 10, reason: "operator_scale_down" },
    });
    expect(drain.statusCode).toBe(200);
    expect(drain.json()).toMatchObject({
      outcome: "quiesced",
      requiresProcessTermination: false,
      snapshot: {
        state: "quiesced",
        admission: "closed",
        drain: { actorId: "operator-1", reason: "operator_scale_down", mode: "pause" },
      },
    });
    const status = await app.inject({ method: "GET", url: "/api/v1/ops/shared-host" });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ lifecycle: { state: "quiesced", admission: "closed" } });
  });

  it("reserves API work before the handler and rejects a late request synchronously", async () => {
    process.env.GOATCITADEL_SHARED_HOST_DRAIN_ENABLED = "true";
    const { app } = await createHarness();
    let unblock!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => (started = resolve));
    const block = new Promise<void>((resolve) => (unblock = resolve));
    app.get("/api/v1/example-work", async (request) => {
      started();
      await block;
      return { kind: request.sharedHostWorkReservation?.kind };
    });

    const firstResponse = app.inject({ method: "GET", url: "/api/v1/example-work" });
    await startedPromise;
    const draining = app.sharedHostLifecycle.drain({
      mode: "pause",
      timeoutMs: 100,
      reason: "scale_down",
      actorId: "ops",
    });
    expect(app.sharedHostLifecycle.snapshot()).toMatchObject({ state: "draining", activeByKind: { api: 1 } });

    const late = await app.inject({ method: "GET", url: "/api/v1/example-work" });
    expect(late.statusCode).toBe(503);
    expect(late.headers["retry-after"]).toBe("1");
    expect(late.json()).toMatchObject({ code: "SHARED_HOST_ADMISSION_CLOSED", lifecycleState: "draining" });

    unblock();
    expect((await firstResponse).json()).toEqual({ kind: "api" });
    await expect(draining).resolves.toMatchObject({ outcome: "quiesced" });
  });

  it("classifies Chat ingress as agent work and force-aborts its reservation after the bound", async () => {
    process.env.GOATCITADEL_SHARED_HOST_DRAIN_ENABLED = "true";
    const { app, auditAppend, publishRealtime } = await createHarness();
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => (started = resolve));
    const aborted = vi.fn();
    app.post("/api/v1/chat/test-turn", async (request) => {
      const reservation = request.sharedHostWorkReservation;
      started();
      await new Promise<void>((resolve) => {
        reservation?.signal.addEventListener("abort", () => {
          aborted();
          resolve();
        });
      });
      return { kind: reservation?.kind, aborted: reservation?.signal.aborted };
    });

    const response = app.inject({ method: "POST", url: "/api/v1/chat/test-turn" });
    await startedPromise;
    await expect(
      app.sharedHostLifecycle.drain({ mode: "force", timeoutMs: 10, reason: "terminate", actorId: "ops" }),
    ).resolves.toMatchObject({ outcome: "closing", snapshot: { state: "closing" } });
    expect((await response).json()).toEqual({ kind: "agent", aborted: true });
    expect(aborted).toHaveBeenCalledTimes(1);
    await app.sharedHostLifecycle.flushSignals();
    expect(auditAppend).toHaveBeenCalled();
    expect(publishRealtime).toHaveBeenCalled();
  });

  it("releases a reservation when the client disconnects before any response is sent", async () => {
    process.env.GOATCITADEL_SHARED_HOST_DRAIN_ENABLED = "true";
    const { app } = await createHarness();
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => (started = resolve));
    app.get("/api/v1/disconnected-work", async (request) => {
      started();
      await new Promise<void>((resolve) => request.raw.once("aborted", resolve));
      return { unreachable: true };
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("expected an ephemeral TCP address");
    const client = httpRequest({ host: "127.0.0.1", port: address.port, path: "/api/v1/disconnected-work" });
    client.on("error", () => undefined);
    client.end();
    await startedPromise;
    expect(app.sharedHostLifecycle.snapshot().activeCount).toBe(1);

    client.destroy();
    await waitUntil(() => app.sharedHostLifecycle.snapshot().activeCount === 0);
    expect(app.sharedHostLifecycle.snapshot()).toMatchObject({ state: "accepting", activeCount: 0 });
  });

  it("keeps health, readiness, and lifecycle control requests available during drain", async () => {
    expect(__internal.isAlwaysAvailableRequest({ method: "GET", url: "/health?probe=1" } as never)).toBe(true);
    expect(__internal.isAlwaysAvailableRequest({ method: "GET", url: "/api/v1/ops/shared-host" } as never)).toBe(true);
    expect(__internal.classifyRequestKind("/api/v1/orchestration/runs")).toBe("agent");
    expect(__internal.classifyRequestKind("/api/v1/settings")).toBe("api");
  });

  it.each(["audit", "realtime"] as const)(
    "keeps %s evidence failure independent, reports degraded, and replays it",
    async (failedSink) => {
      process.env.GOATCITADEL_SHARED_HOST_DRAIN_ENABLED = "true";
      let fail = true;
      const auditAppend = vi.fn(async () => {
        if (failedSink === "audit" && fail) throw new Error("audit down");
      });
      const publishRealtime = vi.fn(() => {
        if (failedSink === "realtime" && fail) throw new Error("realtime down");
        return { eventId: "event-1" };
      });
      const { app } = await createHarness({ auditAppend, publishRealtime });

      await expect(app.sharedHostLifecycle.flushSignals()).rejects.toThrow(/evidence signals failed/i);
      expect(app.sharedHostLifecycle.snapshot()).toMatchObject({
        readiness: "degraded",
        evidence: { state: "degraded", failedCount: 1 },
      });
      const survivingSink = failedSink === "audit" ? publishRealtime : auditAppend;
      expect(
        survivingSink.mock.calls.some((call) =>
          call.some(
            (value) =>
              Boolean(value) &&
              typeof value === "object" &&
              (value as { eventType?: string }).eventType === "shared_host.lifecycle.evidence_degraded",
          ),
        ),
      ).toBe(true);

      fail = false;
      await app.sharedHostLifecycle.replayFailedSignals();
      expect(app.sharedHostLifecycle.snapshot()).toMatchObject({ readiness: "ready", evidence: { state: "healthy" } });
      expect(auditAppend).toHaveBeenCalled();
      expect(publishRealtime).toHaveBeenCalled();
    },
  );

  it("persists terminal lifecycle evidence before storage closes", async () => {
    process.env.GOATCITADEL_SHARED_HOST_DRAIN_ENABLED = "true";
    let storageOpen = true;
    let lateDeliveryCount = 0;
    const assertStorageOpen = () => {
      if (storageOpen) return;
      lateDeliveryCount += 1;
      throw new Error("storage already closed");
    };
    const auditAppend = vi.fn(async () => assertStorageOpen());
    const publishRealtime = vi.fn(() => {
      assertStorageOpen();
      return { eventId: "event-1" };
    });
    const { app } = await createHarness({ auditAppend, publishRealtime });
    app.addHook("onClose", async () => {
      storageOpen = false;
    });

    await app.close();
    apps.splice(apps.indexOf(app), 1);

    expect(lateDeliveryCount).toBe(0);
    expect(storageOpen).toBe(false);
    expect(auditAppend).toHaveBeenCalledWith(
      "hooks",
      expect.objectContaining({ eventType: "shared_host.lifecycle.transition", to: "closed" }),
      expect.any(Object),
    );
    expect(publishRealtime).toHaveBeenCalledWith(
      "shared_host_lifecycle",
      "gateway",
      expect.objectContaining({ eventType: "shared_host.lifecycle.transition", to: "closed" }),
      expect.any(Object),
    );
    expect(app.sharedHostLifecycle.snapshot()).toMatchObject({
      state: "closed",
      evidence: { state: "healthy", pendingCount: 0, failedCount: 0 },
    });
  });
});

async function createHarness(
  overrides: {
    auditAppend?: ReturnType<typeof vi.fn>;
    publishRealtime?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const app = Fastify();
  apps.push(app);
  const auditAppend = overrides.auditAppend ?? vi.fn(async () => undefined);
  const publishRealtime = overrides.publishRealtime ?? vi.fn(() => ({ eventId: "event-1" }));
  app.decorate("services", {
    devVerification: {
      storage: { audit: { append: auditAppend } },
      publishRealtime,
    },
  } as never);
  app.decorate("requireOperatorAuth", async (request) => {
    request.authActorId = "operator-1";
    request.authActorSource = "token";
  });
  await app.register(sharedHostLifecyclePlugin);
  return { app, auditAppend, publishRealtime };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for lifecycle condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
