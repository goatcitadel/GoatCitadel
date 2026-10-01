import { describe, expect, it, vi } from "vitest";
import {
  createGatewayRouteCompositionPort,
  type GatewayRouteCompositionHost,
  type GatewayRouteCompositionPrivateDependencies,
} from "./gateway-route-composition-port.js";
import type { LlamaCppSetupService } from "./llama-cpp-setup-service.js";

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
