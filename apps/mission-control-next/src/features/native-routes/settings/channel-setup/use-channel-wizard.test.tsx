// @vitest-environment happy-dom
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelSetupDefinition, ChannelSetupDraft, ChannelSetupStepDefinition } from "@goatcitadel/contracts";
import { __resetSessionViewStateForTests } from "../../../../hooks/use-session-view-state";
import type { ChannelSetupWizardProps } from "./channel-wizard-model";
import { useChannelWizard } from "./use-channel-wizard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const intro: ChannelSetupStepDefinition = { id: "intro", kind: "intro", title: "Intro" };
const prerequisites: ChannelSetupStepDefinition = {
  id: "prerequisites",
  kind: "prerequisites",
  title: "Before you start",
  createOnly: true,
};
const createBot: ChannelSetupStepDefinition = {
  id: "create-bot",
  kind: "instruction",
  title: "Create the bot",
  createOnly: true,
};
const collect: ChannelSetupStepDefinition = {
  id: "collect",
  kind: "field-collection",
  title: "Paste your values",
};
const test: ChannelSetupStepDefinition = { id: "test", kind: "test", title: "Test it" };

function definitionWith(steps: ChannelSetupStepDefinition[]): ChannelSetupDefinition {
  return {
    catalog: {
      catalogId: "channel.fixture",
      key: "fixture",
      label: "Fixture",
      description: "A fixture channel.",
      kind: "channel",
      capabilities: ["send"],
      maturity: "native",
      supportedModes: ["guided", "manual"],
    },
    wizard: {
      archetype: "bot_token_target",
      contentVersion: "fixture.v1",
      estimatedMinutes: 5,
      difficulty: "beginner",
      manualModePolicy: "available-secondary",
      introSummary: "A fixture.",
      prerequisites: [],
      steps,
    },
    adapter: { adapterVersion: "fixture.v1", secretFieldKeys: [] },
    validation: { validationVersion: "fixture.v1", levels: ["structural"] },
    testing: {
      testVersion: "fixture.v1",
      levels: ["structural"],
      safePreFinalize: true,
      supportsManualConfirmation: true,
    },
    troubleshooting: { commonFailures: [] },
    telemetry: { tier: "tier_1", namespace: "channel_setup.fixture" },
    lifecycle: {
      supportedModes: ["create", "edit"],
      supportsDrafts: true,
      supportsEdit: true,
      supportsRepair: false,
      supportsRotateSecret: false,
      supportsRetest: false,
    },
    volatility: {
      officialDocsUrl: "https://example.com/docs",
      lastReviewedAt: "2026-10-27",
      volatility: "low",
      deprecationRisk: "low",
    },
  };
}

function draftFor(lifecycleMode: ChannelSetupDraft["lifecycleMode"]): ChannelSetupDraft {
  return {
    draftId: `draft-${lifecycleMode}`,
    revision: 1,
    catalogId: "channel.fixture",
    lifecycleMode,
    enabled: true,
    draft: {},
    secretState: {},
    contentVersion: "fixture.v1",
    adapterVersion: "fixture.v1",
    validationVersion: "fixture.v1",
    testVersion: "fixture.v1",
    createdAt: "2026-10-27T00:00:00.000Z",
    updatedAt: "2026-10-27T00:00:00.000Z",
  };
}

function propsFor(definition: ChannelSetupDefinition, draft: ChannelSetupDraft): ChannelSetupWizardProps {
  return {
    definition,
    draft,
    values: {},
    label: "Fixture",
    enabled: true,
    dirty: false,
    onValuesChange: vi.fn(),
    onLabelChange: vi.fn(),
    onEnabledChange: vi.fn(),
    onDirty: vi.fn(),
    onSave: vi.fn(async () => true),
    onValidate: vi.fn(async () => undefined),
    onTest: vi.fn(async () => undefined),
    onFinalize: vi.fn(async () => undefined),
  };
}

let renderer: ReactTestRenderer | undefined;

function stepsShown(definition: ChannelSetupDefinition, draft: ChannelSetupDraft) {
  let latest: ReturnType<typeof useChannelWizard> | undefined;
  function Probe() {
    latest = useChannelWizard(propsFor(definition, draft));
    return null;
  }
  act(() => {
    renderer = create(<Probe />);
  });
  if (!latest) throw new Error("The hook did not render.");
  return { ids: latest.visibleSteps.map((step) => step.id), activeStepId: latest.activeStep?.id };
}

describe("useChannelWizard step filtering", () => {
  beforeEach(() => {
    __resetSessionViewStateForTests();
  });

  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = undefined;
    __resetSessionViewStateForTests();
  });

  it("hides setup-only steps for an edit draft and shows them for a create draft", () => {
    const definition = definitionWith([intro, prerequisites, createBot, collect, test]);
    expect(stepsShown(definition, draftFor("edit")).ids).toEqual(["intro", "collect", "test"]);
    act(() => renderer?.unmount());
    expect(stepsShown(definition, draftFor("create")).ids).toEqual([
      "intro",
      "prerequisites",
      "create-bot",
      "collect",
      "test",
    ]);
  });

  it("still has visible steps for an edit draft whose only non-test steps are setup-only", () => {
    const definition = definitionWith([prerequisites, createBot, test]);
    const shown = stepsShown(definition, draftFor("edit"));
    expect(shown.ids).toEqual(["test"]);
    expect(shown.activeStepId).toBe("test");
  });

  it("falls back to every allowed step when an edit draft would otherwise have none", () => {
    const definition = definitionWith([prerequisites, createBot]);
    const shown = stepsShown(definition, draftFor("edit"));
    expect(shown.ids).toEqual(["prerequisites", "create-bot"]);
    expect(shown.activeStepId).toBe("prerequisites");
  });
});
