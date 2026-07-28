import { afterEach, describe, expect, it, vi } from "vitest";
import { Storage } from "@goatcitadel/storage";
import {
  NotificationRoutingService,
  accountFromNotificationSecretRef,
  parseAllowedNotificationWebhookUrl,
} from "./notification-routing-service.js";

const openStorage: Storage[] = [];

afterEach(() => {
  for (const storage of openStorage.splice(0)) storage.close();
});

function harness(statuses: Array<"delivered" | "failed" | "unknown_after_send"> = ["delivered"]) {
  const storage = new Storage({ dbPath: ":memory:", transcriptsDir: "data/transcripts", auditDir: "data/audit" });
  openStorage.push(storage);
  let id = 0;
  let nowMs = Date.parse("2026-07-27T20:00:00.000Z");
  const deliver = vi.fn(async () => ({ status: statuses.shift() ?? "delivered", attemptCount: 1 }));
  const publishRealtime = vi.fn();
  const service = new NotificationRoutingService({
    repository: storage.notificationRouting,
    normalizeWorkspaceId: (workspaceId) => workspaceId?.trim() || "default",
    getIntegrationConnection: (connectionId) => ({
      connectionId,
      catalogId: "channel.slack",
      kind: "channel",
      key: "slack",
      label: "Slack",
      enabled: true,
      status: "connected",
      workspaceId: "workspace-1",
      config: { target: "ops" },
      createdAt: new Date(nowMs).toISOString(),
      updatedAt: new Date(nowMs).toISOString(),
    }),
    deliver,
    publishRealtime,
    randomId: () => `id-${++id}`,
    now: () => new Date(nowMs),
  });
  return { storage, service, deliver, publishRealtime, advance: (ms: number) => (nowMs += ms) };
}

describe("NotificationRoutingService", () => {
  it("filters rules, suppresses when present, and treats expired presence as away", async () => {
    const { service, deliver, advance } = harness();
    const target = service.createTarget("workspace-1", {
      label: "Ops webhook",
      kind: "https_webhook",
      webhookUrlSecretRef: "keychain:goatcitadel:notification-webhook:ops",
    });
    service.createRule("workspace-1", {
      label: "Failures away",
      eventTypes: ["turn.failed"],
      targetIds: [target.targetId],
      deliveryPolicy: "when_away",
    });
    service.upsertPresence({ workspaceId: "workspace-1", clientId: "client-1", focused: true, visible: true });

    const suppressed = await service.dispatch("workspace-1", {
      eventId: "event-present",
      eventType: "turn.failed",
      title: "Failed",
      message: "Inspect trace",
      source: "chat.turn",
    });
    expect(suppressed.deliveries[0]?.status).toBe("suppressed_present");
    expect(deliver).not.toHaveBeenCalled();

    advance(91_000);
    const delivered = await service.dispatch("workspace-1", {
      eventId: "event-away",
      eventType: "turn.failed",
      title: "Failed",
      message: "Inspect trace",
      source: "chat.turn",
    });
    expect(delivered.deliveries[0]?.status).toBe("delivered");
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("rejects cross-workspace and model-selected target injection", async () => {
    const { service } = harness();
    const target = service.createTarget("workspace-1", {
      label: "Workspace one",
      kind: "https_webhook",
      webhookUrlSecretRef: "keychain:goatcitadel:notification-webhook:one",
    });
    expect(() =>
      service.createRule("workspace-2", {
        label: "Forged",
        eventTypes: ["turn.failed"],
        targetIds: [target.targetId],
      }),
    ).toThrow(/another workspace/i);
    await expect(
      service.request("workspace-1", {
        eventType: "durable.attention_required",
        title: "Look",
        message: "Review this",
        targetIds: [target.targetId],
      }),
    ).rejects.toThrow(/cannot select external targets/i);
  });

  it("keeps partial and unknown-after-send delivery truth visible and idempotent", async () => {
    const { service, deliver } = harness(["delivered", "unknown_after_send"]);
    const first = service.createTarget("workspace-1", {
      label: "First",
      kind: "https_webhook",
      webhookUrlSecretRef: "keychain:goatcitadel:notification-webhook:first",
    });
    const second = service.createTarget("workspace-1", {
      label: "Second",
      kind: "https_webhook",
      webhookUrlSecretRef: "keychain:goatcitadel:notification-webhook:second",
    });
    service.createRule("workspace-1", {
      label: "Both",
      eventTypes: ["turn.completed"],
      targetIds: [first.targetId, second.targetId],
      deliveryPolicy: "always",
    });
    const input = {
      eventId: "event-1",
      eventType: "turn.completed" as const,
      title: "Done",
      message: "Results are ready",
      source: "chat.turn",
    };
    const result = await service.dispatch("workspace-1", input);
    expect(result.deliveries.map((item) => item.status)).toEqual(["delivered", "unknown_after_send"]);
    expect(result.status).toBe("unknown_after_send");
    const replay = await service.dispatch("workspace-1", input);
    expect(replay.deliveries.map((item) => item.deliveryId)).toEqual(result.deliveries.map((item) => item.deliveryId));
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it("summarizes mixed success and failure as partially delivered", async () => {
    const { service } = harness(["delivered", "failed"]);
    const targets = ["first", "second"].map((label) =>
      service.createTarget("workspace-1", {
        label,
        kind: "https_webhook",
        webhookUrlSecretRef: `keychain:goatcitadel:notification-webhook:${label}`,
      }),
    );
    service.createRule("workspace-1", {
      label: "Mixed",
      eventTypes: ["turn.failed"],
      targetIds: targets.map((target) => target.targetId),
      deliveryPolicy: "always",
    });
    const result = await service.dispatch("workspace-1", {
      eventType: "turn.failed",
      title: "Failure",
      message: "One destination is degraded.",
      source: "chat.turn",
    });
    expect(result.status).toBe("partially_delivered");
  });

  it("accepts only opaque GoatCitadel keychain references", () => {
    expect(accountFromNotificationSecretRef("keychain:goatcitadel:notification-webhook:primary")).toBe(
      "notification-webhook:primary",
    );
    expect(() => accountFromNotificationSecretRef("https://example.test/raw-secret")).toThrow(/keychain/i);
  });

  it("rejects SSRF destinations before network transport", () => {
    const allow = vi.fn(() => true);
    expect(() => parseAllowedNotificationWebhookUrl("http://example.test/hook", allow)).toThrow(/public HTTPS/i);
    expect(() => parseAllowedNotificationWebhookUrl("https://127.0.0.1/hook", allow)).toThrow(/public HTTPS/i);
    expect(() => parseAllowedNotificationWebhookUrl("https://10.0.0.2/hook", allow)).toThrow(/public HTTPS/i);
    expect(() => parseAllowedNotificationWebhookUrl("https://host.local/hook", allow)).toThrow(/public HTTPS/i);
    expect(parseAllowedNotificationWebhookUrl("https://hooks.example.test/goat", allow).hostname).toBe(
      "hooks.example.test",
    );
    expect(allow).toHaveBeenCalledTimes(1);
  });
});
