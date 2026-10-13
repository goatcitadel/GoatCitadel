import { describe, expect, it } from "vitest";
import { projectChatFeatureAvailability } from "./chat-feature-availability.js";
import type { RuntimeSettings } from "./gateway/runtime-settings.js";

const features = {
  durableKernelV1Enabled: true,
  chatExplicitContextV1Enabled: true,
  chatDelegationControlsV1Enabled: true,
  chatAutomaticFanoutV1Enabled: true,
  durableChatFanoutV1Enabled: true,
  chatProviderFallbackV1Enabled: true,
} as RuntimeSettings["features"];
describe("effective restored Chat availability", () => {
  it.each([
    { enabled: false, executionEnabled: true },
    { enabled: true, executionEnabled: false },
  ])("does not advertise disabled durable execution (%j)", (durable) => {
    expect(
      Object.values(projectChatFeatureAvailability(durable, features)).every((available) => available === false),
    ).toBe(true);
  });
  it("keeps every restoration off for historical settings, and respects the fanout kill switch", () => {
    const durable = { enabled: true, executionEnabled: true };
    expect(
      projectChatFeatureAvailability(durable, { durableKernelV1Enabled: true } as RuntimeSettings["features"]),
    ).toEqual({
      durableExecution: true,
      explicitContext: false,
      supervisedDelegation: false,
      automaticFanout: false,
      providerFallback: false,
      staticMcp: false,
    });
    expect(projectChatFeatureAvailability(durable, { ...features, subagentFanoutV1Disabled: true })).toMatchObject({
      supervisedDelegation: true,
      automaticFanout: false,
      explicitContext: true,
    });
  });
  it("advertises static MCP restoration only after explicit opt-in, independently of requester resolution", () => {
    const durable = { enabled: true, executionEnabled: true };
    expect(projectChatFeatureAvailability(durable, { ...features, chatRequesterMcpV1Enabled: true }).staticMcp).toBe(
      false,
    );
    expect(projectChatFeatureAvailability(durable, { ...features, chatStaticMcpV1Enabled: true }).staticMcp).toBe(true);
    expect(
      projectChatFeatureAvailability(
        { ...durable, executionEnabled: false },
        { ...features, chatStaticMcpV1Enabled: true },
      ).staticMcp,
    ).toBe(false);
  });
});
