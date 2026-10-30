import { describe, expect, it, vi } from "vitest";
import type { NotificationEventRecord, NotificationTarget } from "@goatcitadel/contracts";
import {
  createGatewayRouteCompositionPort,
  type GatewayRouteCompositionPort,
} from "./gateway-route-composition-port.js";
import {
  buildCitadelWardRequestVaultForGateway,
  buildIntegrationActionHostForGateway,
  deliverNotificationToWebhook,
} from "./gateway-route-composition-integrations.js";
import { composeMemoryKnowledgeRouteDependencies } from "./gateway-route-composition-memory.js";
import { EvidenceReceiptSigningKeyUnavailableError } from "./evidence-receipt-signing-key.js";

/**
 * Every route-side reader of the OS key store, composed through the port exactly as GatewayService
 * builds it. A reader that is switched on must reach the gateway's store; a held reader must never
 * touch it, even though the port now carries one.
 */
describe("OS key store readers through the real route port", () => {
  it("delivers notification webhooks from notification keychain entries only", async () => {
    const { port, store } = realRoutePort();

    await expect(deliverNotificationToWebhook(port, webhookTarget(), notificationEvent(), "notify:1")).resolves.toEqual(
      {
        status: "failed",
        lastError: "Webhook destination secret is unavailable.",
      },
    );
    expect(store.getSecret).toHaveBeenCalledWith("notification-webhook:ops");
  });

  it("never reads a keychain entry a notification target does not own", async () => {
    const { port, store } = realRoutePort();
    const target = webhookTarget({ credentialSecretRef: "keychain:goatcitadel:provider:anthropic" });

    await expect(deliverNotificationToWebhook(port, target, notificationEvent(), "notify:2")).rejects.toThrow(
      /notification keychain entry/i,
    );
    expect(store.getSecret).not.toHaveBeenCalled();
  });

  it("holds integration replay sealing out of the OS keychain", async () => {
    const { port, store, externalSideEffectRuns } = realRoutePort();
    const host = buildIntegrationActionHostForGateway(port);

    await expect(host.replayRecords!.seal({ runId: "run-1", payloadHash: "hash-1", payload: { a: 1 } })).resolves.toBe(
      false,
    );
    await expect(host.replayRecords!.open({ runId: "run-1", payloadHash: "hash-1" })).resolves.toBeUndefined();
    expect(externalSideEffectRuns.attachReplayRecord).not.toHaveBeenCalled();
    expectStoreUntouched(store);
  });

  it("holds the Citadel Ward request vault out of the OS keychain, so Ward-gated actions stay blocked", async () => {
    const { port, store } = realRoutePort();
    const vault = buildCitadelWardRequestVaultForGateway(port);

    await expect(
      vault.seal("citadel_ward.integration_action", {
        wardAction: "integration.action",
        citadelId: "citadel-1",
        workspaceId: "workspace-1",
        request: { connectionId: "connection-1" },
      }),
    ).resolves.toBeUndefined();
    expectStoreUntouched(store);
  });

  it("holds the Evidence Receipt signing key out of the OS keychain", () => {
    const { port, store } = realRoutePort();
    const deps = composeMemoryKnowledgeRouteDependencies(port);

    expect(() => deps.evidenceReceipts!.signingKeys.getSigningKeyPair()).toThrow(
      EvidenceReceiptSigningKeyUnavailableError,
    );
    expect(() => deps.compliance!.signingKeys.getSigningKeyPair()).toThrow(/no key store on this host yet/u);
    expectStoreUntouched(store);
  });
});

function realRoutePort(): {
  port: GatewayRouteCompositionPort;
  store: ReturnType<typeof createSecretStore>;
  externalSideEffectRuns: { hasReplayRecords: ReturnType<typeof vi.fn>; attachReplayRecord: ReturnType<typeof vi.fn> };
} {
  const store = createSecretStore();
  const externalSideEffectRuns = {
    hasReplayRecords: vi.fn(() => false),
    attachReplayRecord: vi.fn(() => true),
    getReplayRecord: vi.fn(() => undefined),
  };
  const host = { secretStore: store, storage: { externalSideEffectRuns } };
  const fallback = new Map<PropertyKey, unknown>();
  const gateway = new Proxy(host, {
    get: (target, key) => {
      if (key in target) return Reflect.get(target, key);
      if (!fallback.has(key)) fallback.set(key, vi.fn());
      return fallback.get(key);
    },
  });
  return {
    port: createGatewayRouteCompositionPort(gateway as never, gateway as never),
    store,
    externalSideEffectRuns,
  };
}

function createSecretStore() {
  return {
    isAvailable: vi.fn(() => true),
    isWriteCustodySafe: vi.fn(() => true),
    getSecret: vi.fn((_account: string): string | undefined => undefined),
    setSecret: vi.fn(),
    deleteSecret: vi.fn(),
  };
}

function expectStoreUntouched(store: ReturnType<typeof createSecretStore>): void {
  expect(store.getSecret).not.toHaveBeenCalled();
  expect(store.setSecret).not.toHaveBeenCalled();
  expect(store.deleteSecret).not.toHaveBeenCalled();
}

function webhookTarget(overrides: Partial<NotificationTarget> = {}): NotificationTarget {
  return {
    targetId: "target-1",
    workspaceId: "workspace-1",
    revision: 1,
    label: "Ops webhook",
    kind: "https_webhook",
    webhookUrlSecretRef: "keychain:goatcitadel:notification-webhook:ops",
    lifecycleState: "active",
    createdAt: "2026-10-29T00:00:00.000Z",
    updatedAt: "2026-10-29T00:00:00.000Z",
    ...overrides,
  } as NotificationTarget;
}

function notificationEvent(): NotificationEventRecord {
  return {
    eventId: "event-1",
    workspaceId: "workspace-1",
    eventType: "turn.failed",
    title: "Failure",
    message: "A turn failed.",
    createdAt: "2026-10-29T00:00:00.000Z",
  } as NotificationEventRecord;
}
