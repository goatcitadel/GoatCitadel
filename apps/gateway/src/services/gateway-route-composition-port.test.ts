import { describe, expect, it, vi } from "vitest";
import {
  createGatewayRouteCompositionPort,
  type GatewayRouteCompositionHost,
  type GatewayRouteCompositionPrivateDependencies,
} from "./gateway-route-composition-port.js";
import type { LlamaCppSetupService } from "./llama-cpp-setup-service.js";
import type { SecretStoreService } from "./secret-store-service.js";

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

describe("Gateway route port OS key store", () => {
  function portOver(secretStore: unknown) {
    const unused = vi.fn();
    const readStore = vi.fn(() => secretStore);
    const gateway = new Proxy(
      {},
      { get: (_target, key) => (key === "secretStore" ? readStore() : unused) },
    ) as GatewayRouteCompositionHost;
    const privateDependencies = new Proxy({}, { get: () => unused }) as GatewayRouteCompositionPrivateDependencies;
    return { port: createGatewayRouteCompositionPort(gateway, privateDependencies), readStore };
  }

  it("hands route readers the gateway's own key store while the OS keychain can be used", () => {
    const store = { isAvailable: vi.fn(() => true) } as unknown as SecretStoreService;
    const { port, readStore } = portOver(store);

    expect(readStore).not.toHaveBeenCalled();
    expect(port.secretStore).toBe(store);
  });

  it("hands route readers no key store when the OS keychain cannot be used", () => {
    const store = { isAvailable: vi.fn(() => false) } as unknown as SecretStoreService;

    expect(portOver(store).port.secretStore).toBeUndefined();
    expect(portOver(undefined).port.secretStore).toBeUndefined();
  });
});
