import { describe, expect, it } from "vitest";
import type { ChannelSetupDefinition, ChannelSetupDraft, ChannelSetupStepDefinition } from "@goatcitadel/contracts";
import {
  describeStepStatus,
  findResumeStepId,
  findStartStepId,
  getStepCompletionState,
  isFieldSatisfied,
  isStepVisible,
  lifecycleDescription,
  titleCaseLifecycle,
} from "./channel-setup-page-helpers";
import { formatConnectionTargetSummary, readConnectionString } from "../ChannelSetupPage";

const collectStep: ChannelSetupStepDefinition = {
  id: "collect",
  kind: "field-collection",
  title: "Collect values",
  fields: [
    { key: "token", label: "Token", explanation: "Workspace bot token.", type: "secret", required: true },
    {
      key: "enabled",
      label: "Enabled",
      explanation: "Whether the connection is active.",
      type: "boolean",
      required: true,
    },
  ],
};

const testStep: ChannelSetupStepDefinition = {
  id: "test",
  kind: "test",
  title: "Test connection",
};

const finishStep: ChannelSetupStepDefinition = {
  id: "finish",
  kind: "confirm",
  title: "Finish",
  visibleWhenFieldEquals: { fieldKey: "enabled", value: true },
};

function makeDraft(overrides: Partial<ChannelSetupDraft> = {}): ChannelSetupDraft {
  return {
    draftId: "draft-1",
    catalogId: "channel.slack",
    lifecycleMode: "create",
    label: "Slack",
    enabled: true,
    draft: {},
    contentVersion: "content.v1",
    adapterVersion: "adapter.v1",
    validationVersion: "validation.v1",
    testVersion: "test.v1",
    createdAt: "2026-05-14T00:00:00.000Z",
    updatedAt: "2026-05-14T00:00:00.000Z",
    ...overrides,
  } as ChannelSetupDraft;
}

function makeDefinition(
  steps: ChannelSetupStepDefinition[] = [collectStep, testStep, finishStep],
): ChannelSetupDefinition {
  return {
    catalog: {
      catalogId: "channel.slack",
      key: "slack",
      label: "Slack",
      description: "Slack",
      kind: "channel",
      capabilities: [],
      maturity: "beta",
      supportedModes: ["guided"],
    },
    wizard: {
      archetype: "workspace_server_token",
      contentVersion: "content.v1",
      estimatedMinutes: 10,
      difficulty: "intermediate",
      manualModePolicy: "available-secondary",
      introSummary: "Slack setup",
      prerequisites: [],
      steps,
    },
    adapter: { adapterVersion: "adapter.v1", secretFieldKeys: [] },
    validation: { validationVersion: "validation.v1", levels: ["structural"] },
    testing: {
      testVersion: "test.v1",
      levels: ["manual-confirm"],
      safePreFinalize: true,
      supportsManualConfirmation: true,
    },
    troubleshooting: { commonFailures: [] },
    telemetry: { tier: "tier_1", namespace: "channel_setup.test" },
    lifecycle: {
      supportedModes: ["create", "edit", "repair", "rotate_secret", "retest"],
      supportsDrafts: true,
      supportsEdit: true,
      supportsRepair: true,
      supportsRotateSecret: true,
      supportsRetest: true,
    },
    volatility: { lastReviewedAt: "2026-05-14", volatility: "low", deprecationRisk: "low" },
  } as ChannelSetupDefinition;
}

describe("channel setup helper behavior", () => {
  it("evaluates field completion with hydration-aware required values", () => {
    expect(isFieldSatisfied({ key: "flag", label: "Flag", type: "boolean", required: true } as any, {})).toBe(false);
    expect(
      isFieldSatisfied({ key: "flag", label: "Flag", type: "boolean", required: true } as any, { flag: false }),
    ).toBe(true);
    expect(
      isFieldSatisfied({ key: "token", label: "Token", type: "secret", required: true } as any, {}, "configured"),
    ).toBe(true);
    expect(isFieldSatisfied({ key: "note", label: "Note", type: "text", required: false } as any, {})).toBe(true);
    expect(
      isFieldSatisfied({ key: "token", label: "Token", type: "secret", required: true } as any, { token: "  " }),
    ).toBe(false);
  });

  it("tracks visible steps, resume points, and completion status", () => {
    const draft = makeDraft({
      draft: { token: "xoxb-token", enabled: true },
      hydration: { fieldState: { token: "configured", enabled: "unknown" } },
    } as any);

    expect(isStepVisible(finishStep, draft.draft)).toBe(true);
    expect(getStepCompletionState(collectStep, draft, null, null)).toBe("complete");
    expect(getStepCompletionState(testStep, draft, null, { status: "ok" } as any)).toBe("complete");
    expect(getStepCompletionState(finishStep, draft, { status: "ok" } as any, { status: "ok" } as any)).toBe(
      "complete",
    );
    expect(findResumeStepId(makeDefinition(), draft)).toBe("test");
  });

  it("describes step status and lifecycle modes for operator-facing copy", () => {
    expect(describeStepStatus(collectStep, null, null, null)).toBe("Values and context");
    expect(describeStepStatus(testStep, makeDraft(), null, null)).toBe("Run validation and live checks");
    expect(describeStepStatus(testStep, makeDraft(), null, { status: "failed" } as any)).toBe("Re-run after changes");
    expect(describeStepStatus(finishStep, makeDraft(), null, null)).toBe("Finalize when validation and tests pass");
    expect(titleCaseLifecycle("rotate_secret")).toBe("Rotate Secret");
    expect(titleCaseLifecycle("retest")).toBe("Re-test");
    expect(lifecycleDescription("repair")).toBe("Diagnostics-forward recovery path");
    expect(lifecycleDescription("edit")).toBe("Selective edit of an existing connection");
    expect(findStartStepId(makeDefinition([testStep]), "repair")).toBe("test");
    expect(findStartStepId(makeDefinition([]), "retest")).toBe("");
  });

  it("summarizes configured connection targets defensively", () => {
    expect(readConnectionString({ defaultChatId: "  C123  " }, "defaultChatId")).toBe("C123");
    expect(readConnectionString({ defaultChatId: "" }, "defaultChatId")).toBeUndefined();
    expect(
      formatConnectionTargetSummary({
        connectionId: "conn-1",
        catalogId: "channel.telegram",
        label: "Telegram",
        status: "connected",
        config: {
          targets: [
            { label: "Ops", chatId: "100" },
            { channel: "#alerts", default: true },
          ],
        },
      } as any),
    ).toBe("channel.telegram · 2 targets · default #alerts");
    expect(
      formatConnectionTargetSummary({
        connectionId: "conn-2",
        catalogId: "channel.discord",
        label: "Discord",
        status: "connected",
        config: { defaultChannel: "#ops" },
      } as any),
    ).toBe("channel.discord · default #ops");
  });
});
