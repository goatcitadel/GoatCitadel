import { describe, expect, it } from "vitest";
import type { IntegrationOperatorAction } from "@goatcitadel/contracts";
import { buildLocalBridgeActionTargets, isLocalBridgeExternalSideEffectAction } from "./local-bridge-action-policy.js";

function action(capability: string): IntegrationOperatorAction {
  return {
    actionId: capability,
    label: capability,
    description: `${capability} bridge action`,
    capability,
  };
}

describe("local-bridge-action-policy", () => {
  it.each(["read", "tray"])("keeps %s explicitly read-only", (capability) => {
    expect(isLocalBridgeExternalSideEffectAction(action(capability))).toBe(false);
  });

  it.each(["write", "control", "capture", "camera", "canvas", "voice", "future_capability"])(
    "defaults %s to governed external-side-effect behavior",
    (capability) => {
      expect(isLocalBridgeExternalSideEffectAction(action(capability))).toBe(true);
    },
  );

  it("pins canonical and legacy routes without adding a post-send probe", () => {
    expect(buildLocalBridgeActionTargets("http://127.0.0.1:4040/", undefined)).toEqual([
      "http://127.0.0.1:4040/v1/integrations/actions",
      "http://127.0.0.1:4040/api/v1/integrations/actions",
    ]);
    expect(buildLocalBridgeActionTargets("http://127.0.0.1:4040", "api_v1")).toEqual([
      "http://127.0.0.1:4040/api/v1/integrations/actions",
      "http://127.0.0.1:4040/v1/integrations/actions",
    ]);
  });
});
