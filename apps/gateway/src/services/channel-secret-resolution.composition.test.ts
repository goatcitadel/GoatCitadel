import { describe, expect, it, vi, type Mock } from "vitest";
import { composeIntegrationChannelRouteDependencies } from "./gateway-route-composition-integrations.js";
import type { GatewayRouteCompositionPort } from "./gateway-route-composition-port.js";

const connectionId = "conn-1";
const ownReference = `keychain:goatcitadel:channel-connection:${connectionId}:webhookSecret:00000000-0000-4000-8000-000000000001`;
const STORED_SECRET = "real-secret";

/** The webhook route port the way the Gateway composes it, over the Gateway's own secret reader. */
function composeWebhookPort(readSecret: Mock) {
  const gateway = {
    config: { rootDir: process.cwd() },
    storage: { systemSettings: { get: vi.fn(async () => ({ value: [] })) } },
    recentChannelSetupTests: new Map(),
    resolveConnectionSecret: readSecret,
  } as unknown as GatewayRouteCompositionPort;
  return composeIntegrationChannelRouteDependencies(gateway).integrationWebhooks;
}

describe("the webhook route port's saved-key reader", () => {
  it("returns the stored key for this connection's own reference", () => {
    const readSecret = vi.fn(() => STORED_SECRET);
    const port = composeWebhookPort(readSecret);

    expect(port.resolveChannelConnectionSecret(connectionId, ownReference)).toBe(STORED_SECRET);
    expect(readSecret).toHaveBeenCalledTimes(1);
    expect(readSecret).toHaveBeenCalledWith({ ref: ownReference }, "ref", "refEnv", "channel.webhook", {
      connectionId,
    });
  });

  it("trims the reference before it checks the owner and before it reads", () => {
    const readSecret = vi.fn(() => STORED_SECRET);
    const port = composeWebhookPort(readSecret);

    expect(port.resolveChannelConnectionSecret(connectionId, `  ${ownReference}\n`)).toBe(STORED_SECRET);
    expect(readSecret).toHaveBeenCalledWith({ ref: ownReference }, "ref", "refEnv", "channel.webhook", {
      connectionId,
    });
  });

  it.each([
    [
      "another connection's reference",
      "keychain:goatcitadel:channel-connection:conn-2:webhookSecret:00000000-0000-4000-8000-000000000002",
    ],
    [
      "a reference whose connection id only starts like this one",
      "keychain:goatcitadel:channel-connection:conn-10:webhookSecret:00000000-0000-4000-8000-000000000003",
    ],
    [
      "a setup draft reference",
      "keychain:goatcitadel:channel-draft:conn-1:webhookSecret:00000000-0000-4000-8000-000000000004",
    ],
    ["an approval token reference", "keychain:goatcitadel:approval-remote-action:00000000-0000-4000-8000-000000000005"],
    ["text that is not a reference", "plain-secret"],
    ["a blank value", "   "],
  ])("gives nothing for %s and never reaches the secret store", (_label, secretRef) => {
    // The store would answer for every one of these, so only the port itself can be keeping them out.
    const readSecret = vi.fn(() => STORED_SECRET);
    const port = composeWebhookPort(readSecret);

    expect(port.resolveChannelConnectionSecret(connectionId, secretRef)).toBeUndefined();
    expect(readSecret).not.toHaveBeenCalled();
  });

  it("gives nothing when the stored key is blank or the read fails", () => {
    expect(
      composeWebhookPort(vi.fn(() => "  ")).resolveChannelConnectionSecret(connectionId, ownReference),
    ).toBeUndefined();
    expect(
      composeWebhookPort(
        vi.fn(() => {
          throw new Error("keychain unavailable");
        }),
      ).resolveChannelConnectionSecret(connectionId, ownReference),
    ).toBeUndefined();
  });
});
