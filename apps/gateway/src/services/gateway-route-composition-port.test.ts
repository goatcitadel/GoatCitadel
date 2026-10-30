import { describe, expect, it, vi } from "vitest";
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
import type { IntegrationChannelPort, IntegrationChannelService } from "./integration-channel-service.js";
import type { IntegrationDiagnosticsService } from "./integration-diagnostics-service.js";

describe("Gateway channel credential custody composition", () => {
  it("gives channel setup and channel connections the key store while the port's generic key store stays unset", () => {
    const keyStore = {
      isAvailable: vi.fn(() => true),
      getSecret: vi.fn(),
      setSecret: vi.fn(),
      deleteSecret: vi.fn(),
    } as unknown as SecretStoreService;
    const storage = {};
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

    // The Vault, evidence signing, notifications, replay sealing, the Ward vault and mobile push read this one.
    expect(port.secretStore).toBeUndefined();
    expect(port.channelSecretStore).toBe(keyStore);
    const diagnostics = {} as IntegrationDiagnosticsService;
    const setupHost = createChannelSetupHostForGateway(port, diagnostics, {} as IntegrationChannelService);
    expect(setupHost.channelSecrets).toBeInstanceOf(ChannelSecretCustodyService);
    const channelService = createIntegrationChannelServiceForGateway(port, diagnostics);
    const channelPort = (channelService as unknown as { deps: IntegrationChannelPort }).deps;
    expect(channelPort.channelSecrets).toBeInstanceOf(ChannelSecretCustodyService);
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
