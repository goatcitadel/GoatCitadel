import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { notificationRoutes } from "./notifications.js";

describe("notification routes", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("wires revisioned target/rule CRUD, presence, tests, and delivery truth", async () => {
    const integrations = service();
    app = Fastify();
    app.decorate("services", { integrations } as never);
    await app.register(notificationRoutes);

    const target = await app.inject({
      method: "POST",
      url: "/api/v1/notifications/targets",
      payload: {
        workspaceId: "workspace-1",
        target: {
          label: "Ops",
          kind: "https_webhook",
          webhookUrlSecretRef: "keychain:goatcitadel:notification-webhook:ops",
        },
      },
    });
    expect(target.statusCode).toBe(201);
    expect(target.json()).toEqual({ targetId: "target-1" });
    expect(integrations.createNotificationTarget).toHaveBeenCalledWith(
      "workspace-1",
      expect.objectContaining({ label: "Ops" }),
    );

    const updated = await app.inject({
      method: "PATCH",
      url: "/api/v1/notifications/targets/target-1",
      payload: {
        workspaceId: "workspace-1",
        expectedRevision: 1,
        target: { label: "Ops", kind: "channel_connection", channelConnectionId: "channel-1" },
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toEqual({ targetId: "target-1", revision: 2 });
    expect(integrations.updateNotificationTarget).toHaveBeenCalledWith(
      "workspace-1",
      "target-1",
      1,
      expect.objectContaining({ channelConnectionId: "channel-1" }),
    );

    await expect(
      app.inject({
        method: "POST",
        url: "/api/v1/notifications/rules",
        payload: {
          workspaceId: "workspace-1",
          rule: {
            label: "Failures",
            eventTypes: ["turn.failed"],
            targetIds: ["target-1"],
            deliveryPolicy: "when_away",
          },
        },
      }),
    ).resolves.toMatchObject({ statusCode: 201 });

    await expect(
      app.inject({
        method: "PUT",
        url: "/api/v1/notifications/presence",
        payload: {
          workspaceId: "workspace-1",
          clientId: "client-1",
          focused: true,
          visible: true,
          ttlMs: 90_000,
        },
      }),
    ).resolves.toMatchObject({ statusCode: 200 });

    await expect(
      app.inject({
        method: "POST",
        url: "/api/v1/notifications/targets/target-1/test",
        payload: { workspaceId: "workspace-1" },
      }),
    ).resolves.toMatchObject({ statusCode: 200 });
    const deliveries = await app.inject({
      method: "GET",
      url: "/api/v1/notifications/deliveries?workspaceId=workspace-1&limit=25",
    });
    expect(deliveries.json()).toEqual({ items: [] });
    expect(integrations.listNotificationDeliveries).toHaveBeenCalledWith("workspace-1", 25);
  });

  it("settles async list reads into real arrays instead of serialized promises", async () => {
    const integrations = service();
    integrations.listNotificationTargets.mockResolvedValue([{ targetId: "target-1" }] as never);
    integrations.listNotificationRules.mockResolvedValue([{ ruleId: "rule-1" }] as never);
    integrations.listNotificationDeliveries.mockResolvedValue([{ deliveryId: "delivery-1" }] as never);
    app = Fastify();
    app.decorate("services", { integrations } as never);
    await app.register(notificationRoutes);

    for (const [url, expected] of [
      ["/api/v1/notifications/targets?workspaceId=workspace-1", { targetId: "target-1" }],
      ["/api/v1/notifications/rules?workspaceId=workspace-1", { ruleId: "rule-1" }],
      ["/api/v1/notifications/deliveries?workspaceId=workspace-1", { deliveryId: "delivery-1" }],
    ] as const) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(200);
      // An unawaited handler serializes the pending promise to `{}`, which the
      // Mission Control panels then crash on with "items.filter is not a function".
      expect(Array.isArray(response.json().items)).toBe(true);
      expect(response.json()).toEqual({ items: [expected] });
    }
  });

  it("propagates async port rejections instead of answering 200 with an empty body", async () => {
    const integrations = service();
    integrations.listNotificationTargets.mockRejectedValue(
      new Error("notificationRoutingV1Enabled is disabled") as never,
    );
    app = Fastify();
    app.decorate("services", { integrations } as never);
    await app.register(notificationRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/notifications/targets?workspaceId=workspace-1",
    });
    expect(response.statusCode).toBe(500);
  });

  it("rejects raw target injection and unsupported events at the public boundary", async () => {
    app = Fastify();
    app.decorate("services", { integrations: service() } as never);
    await app.register(notificationRoutes);
    const rawTarget = await app.inject({
      method: "POST",
      url: "/api/v1/notifications/targets",
      payload: {
        target: { label: "Unsafe", kind: "https_webhook", url: "https://example.test/hook" },
      },
    });
    expect(rawTarget.statusCode).toBe(400);
    const invalidEvent = await app.inject({
      method: "POST",
      url: "/api/v1/notifications/requests",
      payload: { eventType: "arbitrary.event", title: "No", message: "No" },
    });
    expect(invalidEvent.statusCode).toBe(400);
  });
});

// The composed integrations port is async (every method awaits a feature gate
// before touching notification routing). Stubbing it synchronously hides
// unawaited handlers: a Promise serializes to `{}`, so the route still answers
// 200 while the body is empty and the feature gate's rejection is unhandled.
function service() {
  return {
    listNotificationTargets: vi.fn(async () => []),
    createNotificationTarget: vi.fn(async () => ({ targetId: "target-1" })),
    updateNotificationTarget: vi.fn(async () => ({ targetId: "target-1", revision: 2 })),
    sendTestNotification: vi.fn(async () => ({ event: { eventId: "event-1" }, deliveries: [] })),
    listNotificationRules: vi.fn(async () => []),
    createNotificationRule: vi.fn(async () => ({ ruleId: "rule-1" })),
    updateNotificationRule: vi.fn(async () => ({ ruleId: "rule-1", revision: 2 })),
    upsertNotificationPresence: vi.fn(async (input) => ({ ...input, leaseId: "lease-1" })),
    listNotificationDeliveries: vi.fn(async () => []),
    requestNotification: vi.fn(async () => ({ event: { eventId: "event-1" }, deliveries: [] })),
  };
}
