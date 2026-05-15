import { describe, expect, it } from "vitest";
import type { ChannelSetupDefinition, ChannelSetupDraft, ChannelSetupStepDefinition } from "@goatcitadel/contracts";
import {
  describeStepStatus,
  findStartStepId,
  getStepCompletionState,
  isFieldSatisfied,
  isStepVisible,
  lifecycleDescription,
} from "./channel-setup-page-helpers";

const customStep = {
  id: "custom",
  kind: "operator-review",
  title: "Operator review",
} as unknown as ChannelSetupStepDefinition;

function definition(steps: ChannelSetupStepDefinition[]): ChannelSetupDefinition {
  return {
    wizard: { steps },
  } as ChannelSetupDefinition;
}

function draft(values: Record<string, unknown>): ChannelSetupDraft {
  return {
    draftId: "draft-loop17",
    catalogId: "channel.slack",
    lifecycleMode: "create",
    draft: values,
    hydration: { fieldState: {} },
  } as ChannelSetupDraft;
}

describe("channel setup page helpers loop 17 branches", () => {
  it("keeps hidden steps pending and describes custom steps as review work", () => {
    expect(
      isStepVisible({ ...customStep, visibleWhenFieldEquals: { fieldKey: "enabled", value: true } }, undefined),
    ).toBe(false);
    expect(getStepCompletionState(customStep, null, null, null)).toBe("pending");
    expect(getStepCompletionState(customStep, draft({}), null, null)).toBe("pending");
    expect(describeStepStatus(customStep, draft({}), null, null)).toBe("Review and continue");
  });

  it("covers required missing values and fallback start/lifecycle copy", () => {
    expect(isFieldSatisfied({ key: "flag", label: "Flag", type: "boolean", required: true } as any, {})).toBe(false);
    expect(isFieldSatisfied({ key: "token", label: "Token", type: "secret", required: true } as any, {})).toBe(false);
    expect(findStartStepId(definition([]), "create")).toBe("");
    expect(findStartStepId(definition([customStep]), "rotate_secret")).toBe("custom");
    expect(lifecycleDescription("create")).toBe("Guided first-time setup");
    expect(lifecycleDescription("rotate_secret")).toBe("Focused credential replacement");
    expect(lifecycleDescription("retest")).toBe("Verification-only run");
  });
});
