import { describe, expect, it, vi } from "vitest";
import type { ChannelSetupDraft } from "@goatcitadel/contracts";
import {
  createGatewayRouteCompositionPort,
  type GatewayRouteCompositionHost,
  type GatewayRouteCompositionPrivateDependencies,
} from "./gateway-route-composition-port.js";
import type { LlamaCppSetupService } from "./llama-cpp-setup-service.js";
import type { SecretStoreService } from "./secret-store-service.js";
import {
  createChannelSetupHostForGateway,
  createIntegrationChannelServiceForGateway,
} from "./gateway-route-composition-integrations.js";
import { ChannelSecretCustodyService } from "./channel-secret-custody-service.js";
import { setChannelSetupDraftSecrets } from "./channel-setup-service.js";
import type { IntegrationChannelPort, IntegrationChannelService } from "./integration-channel-service.js";
import type { IntegrationDiagnosticsService } from "./integration-diagnostics-service.js";

describe("Gateway channel credential custody composition", () => {
  /** The real port, built from a host whose key store says `available`, with what channel setup and channels get. */
  function compose(available: boolean) {
    const keyStore = {
      isAvailable: vi.fn(() => available),
      getSecret: vi.fn(),
      setSecret: vi.fn(),
      deleteSecret: vi.fn(),
    } as unknown as SecretStoreService;
    const draft = { draftId: "draft-1", revision: 1, catalogId: "channel.whatsapp" } as ChannelSetupDraft;
    const storage = { channelSetupDrafts: { get: vi.fn(async () => draft) } };
    const unused = vi.fn();
    const gateway = new Proxy(
      {},
      {
        get: (_target, key) => {
          if (key === "secretStore") return keyStore;
          if (key === "storage") return storage;
          return unused;
        },
      },
    ) as GatewayRouteCompositionHost;
    const privateDependencies = new Proxy({}, { get: () => unused }) as GatewayRouteCompositionPrivateDependencies;
    const port = createGatewayRouteCompositionPort(gateway, privateDependencies);
    const diagnostics = {} as IntegrationDiagnosticsService;
    const setupHost = createChannelSetupHostForGateway(port, diagnostics, {} as IntegrationChannelService);
    const channelService = createIntegrationChannelServiceForGateway(port, diagnostics);
    const channelPort = (channelService as unknown as { deps: IntegrationChannelPort }).deps;
    return { keyStore, port, setupHost, channelPort };
  }

  it("gives channel setup and channel connections the key store while the port's generic key store stays unset", () => {
    const { keyStore, port, setupHost, channelPort } = compose(true);
    // The Vault, evidence signing, notifications, replay sealing, the Ward vault and mobile push read this one.
    expect(port.secretStore).toBeUndefined();
    expect(port.channelSecretStore).toBe(keyStore);
    expect(setupHost.channelSecrets).toBeInstanceOf(ChannelSecretCustodyService);
    expect(channelPort.channelSecrets).toBeInstanceOf(ChannelSecretCustodyService);
  });

  it("gives channel setup no custody when the key store can't be used, so a pasted key gets main's sentence", async () => {
    const { keyStore, port, setupHost, channelPort } = compose(false);
    expect(port.secretStore).toBeUndefined();
    expect(port.channelSecretStore).toBeUndefined();
    expect(setupHost.channelSecrets).toBeUndefined();
    expect(channelPort.channelSecrets).toBeUndefined();
    // The secrets route answers this with a 422, the sentence the WhatsApp page reads as "no secure storage".
    await expect(
      setChannelSetupDraftSecrets(setupHost, "draft-1", { expectedRevision: 1, values: { accessToken: "EAAG-key" } }),
    ).rejects.toThrow("Secure channel credential storage is unavailable.");
    expect(keyStore.setSecret).not.toHaveBeenCalled();
  });
});

describe("Gateway setup route owner composition", () => {
  it("resolves the setup owner after early route-port construction without eagerly capturing an uninitialized service", () => {
    const unused = vi.fn();
    const owner: { setup?: LlamaCppSetupService } = {};
    const readSetup = vi.fn(() => owner.setup);
    const gateway = new Proxy(
      {},
      {
        get: (_target, key) => (key === "llamaCppSetupService" ? readSetup() : unused),
      },
    ) as GatewayRouteCompositionHost;
    const privateDependencies = new Proxy({}, { get: () => unused }) as GatewayRouteCompositionPrivateDependencies;
    const port = createGatewayRouteCompositionPort(gateway, privateDependencies);
    expect(readSetup).not.toHaveBeenCalled();
    owner.setup = { get: vi.fn() } as unknown as LlamaCppSetupService;
    expect(port.llamaCppSetupService).toBe(owner.setup);
    expect(readSetup).toHaveBeenCalledTimes(1);
    expect(port).not.toHaveProperty("llamaCppSetupSelection");
    expect(port).not.toHaveProperty("evolutionControlPlaneService");
    expect(port).not.toHaveProperty("agentSendChatMessage");
    expect(port).not.toHaveProperty("getSettings");
  });
});
