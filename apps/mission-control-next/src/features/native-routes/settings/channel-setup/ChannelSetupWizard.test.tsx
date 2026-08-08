// @vitest-environment happy-dom
import { useState, type ComponentProps } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import type { ChannelSetupDefinition, ChannelSetupDraft } from "@goatcitadel/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelSetupWizard, type ChannelSetupWizardFeedback } from "./ChannelSetupWizard";
import { ChannelsSection } from "../sections/ChannelsSection";

const channelApiMocks = vi.hoisted(() => ({
  createChannelSetupDraft: vi.fn(),
  discoverTelegramTargets: vi.fn(),
  fetchChannelSetupDefinitions: vi.fn(),
  fetchChannelSetupDrafts: vi.fn(),
  fetchIntegrationConnections: vi.fn(),
  fetchSlackOAuthStatus: vi.fn(),
  finalizeChannelSetupDraft: vi.fn(),
  startSlackOAuth: vi.fn(),
  testChannelSetupDraft: vi.fn(),
  updateChannelSetupDraft: vi.fn(),
  validateChannelSetupDraft: vi.fn(),
}));

vi.mock("@goatcitadel/mission-control-shared/api/client", () => channelApiMocks);

vi.mock("../../SettingsNativePage", () => ({
  delay: async () => undefined,
  formatDateTime: (value: string | undefined) => value ?? "Never",
  preferredChannelDefinition: (definitions: ChannelSetupDefinition[]) =>
    definitions.find((definition) => definition.catalog.catalogId === "channel.discord") ?? definitions[0],
  readConnectionConfigString: (config: Record<string, unknown> | undefined, key: string) => {
    const value = config?.[key];
    return typeof value === "string" ? value : undefined;
  },
  readDraftString: (draft: Record<string, unknown>, key: string) => {
    const value = draft[key];
    return typeof value === "string" ? value : undefined;
  },
}));

const DISCORD_STEPS = [
  ["overview", "What this connection does"],
  ["prerequisites", "Before you start"],
  ["create-bot", "Create the Discord application and bot"],
  ["install-bot", "Add the bot to your server"],
  ["webhook-path", "Optional legacy bridge-only webhook path"],
  ["collect-values", "Paste your connection values"],
  ["test", "Validate and test the connection"],
  ["finish", "Finish setup"],
] as const;

const discordDefinition: ChannelSetupDefinition = {
  catalog: {
    catalogId: "channel.discord",
    key: "discord",
    label: "Discord",
    description: "Connect GoatCitadel to Discord.",
    kind: "channel",
    capabilities: ["send", "receive"],
    maturity: "native",
    supportedModes: ["guided", "manual"],
  },
  wizard: {
    archetype: "bot_token_target",
    contentVersion: "2026.08.discord.v3",
    estimatedMinutes: 10,
    difficulty: "intermediate",
    manualModePolicy: "available-secondary",
    introSummary: "Create, install, test, and finalize a first-class Discord bot connection.",
    prerequisites: ["A Discord account", "Access to a sandbox server"],
    steps: [
      {
        id: "overview",
        kind: "intro",
        title: "What this connection does",
        body: [{ kind: "paragraph", text: "The bot can receive messages and send replies." }],
      },
      {
        id: "prerequisites",
        kind: "prerequisites",
        title: "Before you start",
        checklist: [
          { id: "account", label: "Discord account signed in" },
          { id: "sandbox", label: "Sandbox channel selected" },
        ],
      },
      {
        id: "create-bot",
        kind: "instruction",
        title: "Create the Discord application and bot",
        body: [
          { kind: "paragraph", text: "Create an application and add its bot user." },
          {
            kind: "link",
            label: "Discord Developer Portal",
            href: "https://discord.com/developers/applications",
            external: true,
          },
        ],
        checklist: [{ id: "bot-added", label: "Bot user added" }],
      },
      {
        id: "install-bot",
        kind: "instruction",
        title: "Add the bot to your server",
        body: [{ kind: "paragraph", text: "Install the bot with the minimum channel permissions." }],
        checklist: [{ id: "bot-installed", label: "Bot installed in the sandbox server" }],
      },
      {
        id: "webhook-path",
        kind: "instruction",
        title: "Optional legacy bridge-only webhook path",
        body: [{ kind: "paragraph", text: "Webhook mode is an advanced outbound-only fallback." }],
      },
      {
        id: "collect-values",
        kind: "field-collection",
        title: "Paste your connection values",
        fields: [
          {
            key: "botTokenEnv",
            label: "Bot token env var",
            type: "text",
            required: false,
            explanation: "Name of the environment variable that stores the bot token.",
            placeholder: "DISCORD_BOT_TOKEN",
          },
          {
            key: "botToken",
            label: "Bot token (manual fallback)",
            type: "secret",
            required: false,
            explanation: "Direct token entry for a manual fallback.",
            sensitive: true,
          },
          {
            key: "defaultChannelId",
            label: "Default channel ID",
            type: "id",
            required: true,
            explanation: "The default Discord destination.",
          },
          {
            key: "defaultGuildId",
            label: "Optional server (guild) ID",
            type: "id",
            required: false,
            explanation: "An optional server id for routing.",
          },
          {
            key: "webhookUrl",
            label: "Optional bridge webhook URL",
            type: "url",
            required: false,
            explanation: "An advanced legacy webhook path.",
            sensitive: true,
          },
          {
            key: "inboundDmPolicy",
            label: "Gateway DM policy",
            type: "select",
            required: false,
            defaultValue: "pairing",
            explanation: "Controls inbound direct messages.",
            options: [
              { value: "pairing", label: "pairing" },
              { value: "open", label: "open" },
              { value: "disabled", label: "disabled" },
            ],
          },
          {
            key: "guildPolicy",
            label: "Gateway guild policy",
            type: "select",
            required: false,
            defaultValue: "allowlist",
            explanation: "Controls inbound guild traffic.",
            options: [
              { value: "allowlist", label: "allowlist" },
              { value: "off", label: "off" },
            ],
          },
        ],
      },
      {
        id: "test",
        kind: "test",
        title: "Validate and test the connection",
        body: [{ kind: "paragraph", text: "Probe auth, channel access, and sandbox delivery." }],
        troubleshooting: [
          {
            id: "bad-token",
            title: "Discord rejected the token",
            body: "Rotate the bot token and run the live test again.",
          },
        ],
      },
      {
        id: "finish",
        kind: "confirm",
        title: "Finish setup",
        body: [{ kind: "paragraph", text: "Create the durable connection and start its runtime." }],
        successCriteria: ["Token auth passed", "Default channel is reachable"],
      },
    ],
  },
  adapter: {
    adapterVersion: "2026.03.discord.v2",
    secretFieldKeys: ["botToken", "webhookUrl"],
  },
  validation: {
    validationVersion: "2026.03.discord.v2",
    levels: ["structural", "semantic", "live-auth"],
  },
  testing: {
    testVersion: "2026.08.discord.v3",
    levels: ["live-auth", "live-send", "manual-confirm"],
    safePreFinalize: true,
    supportsManualConfirmation: true,
  },
  troubleshooting: { commonFailures: [] },
  telemetry: { tier: "tier_1", namespace: "channel_setup.discord" },
  lifecycle: {
    supportedModes: ["create", "edit", "repair", "rotate_secret", "retest"],
    supportsDrafts: true,
    supportsEdit: true,
    supportsRepair: true,
    supportsRotateSecret: true,
    supportsRetest: true,
  },
  volatility: {
    officialDocsUrl: "https://discord.com/developers/applications",
    lastReviewedAt: "2026-08-07",
    volatility: "medium",
    deprecationRisk: "low",
  },
};

const discordDraft: ChannelSetupDraft = {
  draftId: "discord-draft-1",
  catalogId: "channel.discord",
  lifecycleMode: "create",
  label: "Discord sandbox",
  enabled: true,
  draft: {
    botTokenEnv: "DISCORD_BOT_TOKEN",
    defaultChannelId: "123456789012345678",
    inboundDmPolicy: "pairing",
    guildPolicy: "allowlist",
  },
  contentVersion: discordDefinition.wizard.contentVersion,
  adapterVersion: discordDefinition.adapter.adapterVersion,
  validationVersion: discordDefinition.validation.validationVersion,
  testVersion: discordDefinition.testing.testVersion,
  createdAt: "2026-08-07T12:00:00.000Z",
  updatedAt: "2026-08-07T12:00:00.000Z",
};

const passingTestFeedback: ChannelSetupWizardFeedback = {
  kind: "test",
  status: "ok",
  issues: [],
  recommendedNextAction: "Finalize the connection to start the persistent Discord gateway.",
  probe: {
    kind: "discord",
    mode: "gateway",
    checkedAt: "2026-08-07T12:10:00.000Z",
    steps: [
      { key: "auth", label: "Bot token authentication", status: "pass", message: "Discord accepted the bot token." },
      {
        key: "channel",
        label: "Default channel access",
        status: "pass",
        message: "The bot can reach the sandbox channel.",
      },
      { key: "runtime", label: "Runtime readiness", status: "skipped", message: "Checked after finalization." },
    ],
  },
};

const validationResponse = {
  draftId: discordDraft.draftId,
  status: "ok" as const,
  levels: ["structural", "semantic"] as const,
  issues: [],
  checkedAt: "2026-08-07T12:09:00.000Z",
};

const testResponse = {
  draftId: discordDraft.draftId,
  status: passingTestFeedback.status,
  levels: ["live-auth", "live-send"] as const,
  issues: passingTestFeedback.issues,
  checkedAt: passingTestFeedback.probe?.checkedAt ?? "2026-08-07T12:10:00.000Z",
  recommendedNextAction: passingTestFeedback.recommendedNextAction,
  probe: passingTestFeedback.probe,
};

let currentApiDraft: ChannelSetupDraft = discordDraft;

function configureChannelApiMocks(): void {
  currentApiDraft = discordDraft;
  channelApiMocks.fetchChannelSetupDefinitions.mockImplementation(async () => ({ items: [discordDefinition] }));
  channelApiMocks.fetchChannelSetupDrafts.mockImplementation(async () => ({ items: [currentApiDraft] }));
  channelApiMocks.fetchIntegrationConnections.mockImplementation(async () => ({ items: [] }));
  channelApiMocks.fetchSlackOAuthStatus.mockImplementation(async () => ({ configured: false }));
  channelApiMocks.validateChannelSetupDraft.mockImplementation(async () => validationResponse);
  channelApiMocks.testChannelSetupDraft.mockImplementation(async () => testResponse);
  channelApiMocks.updateChannelSetupDraft.mockImplementation(
    async (_draftId: string, input: { label?: string; enabled?: boolean; draft?: Record<string, unknown> }) => {
      currentApiDraft = {
        ...currentApiDraft,
        label: input.label ?? currentApiDraft.label,
        enabled: input.enabled ?? currentApiDraft.enabled,
        draft: input.draft ?? currentApiDraft.draft,
        updatedAt: "2026-08-07T12:08:00.000Z",
      };
      return currentApiDraft;
    },
  );
  channelApiMocks.finalizeChannelSetupDraft.mockImplementation(async () => ({
    connection: {
      connectionId: "connection-discord-1",
      catalogId: "channel.discord",
      label: currentApiDraft.label ?? "Discord",
      kind: "channel",
      status: "connected",
      enabled: currentApiDraft.enabled,
      config: currentApiDraft.draft,
      createdAt: "2026-08-07T12:11:00.000Z",
      updatedAt: "2026-08-07T12:11:00.000Z",
    },
    validation: validationResponse,
    test: testResponse,
  }));
}

type WizardProps = ComponentProps<typeof ChannelSetupWizard>;

function createWizardProps(overrides: Partial<WizardProps> = {}): WizardProps {
  return {
    definition: discordDefinition,
    draft: discordDraft,
    values: discordDraft.draft,
    label: discordDraft.label ?? "",
    enabled: discordDraft.enabled,
    dirty: false,
    busyAction: null,
    feedback: null,
    onValuesChange: vi.fn(),
    onLabelChange: vi.fn(),
    onEnabledChange: vi.fn(),
    onDirty: vi.fn(),
    onSave: vi.fn(async () => true),
    onValidate: vi.fn(async () => undefined),
    onTest: vi.fn(async () => undefined),
    onFinalize: vi.fn(async () => undefined),
    ...overrides,
  };
}

function textOf(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === "string" ? child : textOf(child)))
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();
}

function findButton(root: ReactTestInstance, label: string): ReactTestInstance {
  const button = root.findAllByType("button").find((candidate) => textOf(candidate) === label);
  if (!button) {
    throw new Error(`Button not found: ${label}. Available: ${root.findAllByType("button").map(textOf).join(" | ")}`);
  }
  return button;
}

function findStepButton(root: ReactTestInstance, title: string): ReactTestInstance {
  const nav = root.findByProps({ "aria-label": "Setup steps" });
  const button = nav.findAllByType("button").find((candidate) => textOf(candidate).includes(title));
  if (!button) {
    throw new Error(`Step not found: ${title}`);
  }
  return button;
}

function findHostControl(
  root: ReactTestInstance,
  type: "input" | "select" | "textarea",
  id: string,
): ReactTestInstance {
  const control = root.findAllByType(type).find((candidate) => candidate.props.id === id);
  if (!control) {
    throw new Error(`Control not found: ${id}`);
  }
  return control;
}

async function click(node: ReactTestInstance): Promise<void> {
  await act(async () => {
    node.props.onClick?.({ preventDefault: vi.fn() });
    await Promise.resolve();
  });
}

async function changeValue(node: ReactTestInstance, value: string): Promise<void> {
  await act(async () => {
    node.props.onChange?.({ target: { value } });
    await Promise.resolve();
  });
}

async function renderWizard(props: WizardProps): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<ChannelSetupWizard {...props} />);
    await Promise.resolve();
  });
  return renderer;
}

async function flushWork(rounds = 5): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function renderChannelsSection(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<ChannelsSection {...({} as ComponentProps<typeof ChannelsSection>)} />);
    await Promise.resolve();
  });
  await flushWork();
  return renderer;
}

beforeEach(() => {
  vi.clearAllMocks();
  configureChannelApiMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ChannelSetupWizard", () => {
  it("renders and navigates the complete eight-step Discord definition", async () => {
    const renderer = await renderWizard(createWizardProps());
    const nav = renderer.root.findByProps({ "aria-label": "Setup steps" });
    const stepButtons = nav.findAllByType("button");

    expect(stepButtons).toHaveLength(8);
    expect(stepButtons.map(textOf)).toEqual(
      expect.arrayContaining(DISCORD_STEPS.map(([, title]) => expect.stringContaining(title))),
    );

    for (const [stepId, title] of DISCORD_STEPS) {
      await click(findStepButton(renderer.root, title));
      expect(findStepButton(renderer.root, title).props["aria-current"]).toBe("step");
      expect(textOf(renderer.root.findByProps({ id: `channel-step-${stepId}` }))).toBe(title);
    }

    await click(findStepButton(renderer.root, "Create the Discord application and bot"));
    const docsLink = renderer.root.findByProps({ href: "https://discord.com/developers/applications" });
    expect(docsLink.props.target).toBe("_blank");
    expect(docsLink.props.rel).toBe("noreferrer noopener");

    renderer.unmount();
  });

  it("uses typed fields and preserves redacted secrets until an explicit replacement is entered", async () => {
    const onValuesChange = vi.fn();
    const onSave = vi.fn(async () => true);
    const redactedValues = {
      botTokenEnv: "DISCORD_BOT_TOKEN",
      botToken: "[REDACTED]",
      defaultChannelId: "123456789012345678",
      webhookUrl: "[REDACTED]",
      inboundDmPolicy: "pairing",
      guildPolicy: "allowlist",
    };
    const editDraft: ChannelSetupDraft = {
      ...discordDraft,
      lifecycleMode: "edit",
      connectionId: "connection-discord-1",
      draft: redactedValues,
      hydration: {
        status: "opaque-secret",
        fieldState: {
          botTokenEnv: "configured",
          botToken: "configured",
          defaultChannelId: "configured",
          defaultGuildId: "unknown",
          webhookUrl: "configured",
          inboundDmPolicy: "configured",
          guildPolicy: "configured",
        },
        warnings: ["Saved secrets are intentionally not rehydrated."],
      },
    };
    let props = createWizardProps({
      draft: editDraft,
      values: redactedValues,
      onValuesChange,
      onSave,
    });
    const renderer = await renderWizard(props);
    await click(findStepButton(renderer.root, "Paste your connection values"));

    const tokenEnv = findHostControl(renderer.root, "input", "channel-discord-draft-1-botTokenEnv");
    const token = findHostControl(renderer.root, "input", "channel-discord-draft-1-botToken");
    const channelId = findHostControl(renderer.root, "input", "channel-discord-draft-1-defaultChannelId");
    const guildId = findHostControl(renderer.root, "input", "channel-discord-draft-1-defaultGuildId");
    const webhook = findHostControl(renderer.root, "input", "channel-discord-draft-1-webhookUrl");
    const dmPolicy = findHostControl(renderer.root, "select", "channel-discord-draft-1-inboundDmPolicy");
    const guildPolicy = findHostControl(renderer.root, "select", "channel-discord-draft-1-guildPolicy");

    expect(tokenEnv.props.type).toBe("text");
    expect(token.props).toMatchObject({
      type: "password",
      autoComplete: "new-password",
      value: "",
      placeholder: "Configured — enter a replacement to rotate",
    });
    expect(webhook.props).toMatchObject({ type: "password", value: "" });
    expect(channelId.props).toMatchObject({ type: "text", inputMode: "numeric", required: true });
    expect(guildId.props).toMatchObject({ type: "text", inputMode: "numeric", required: false });
    expect(dmPolicy.props.value).toBe("pairing");
    expect(guildPolicy.props.value).toBe("allowlist");

    await click(findButton(renderer.root, "Save draft"));
    expect(onSave).toHaveBeenLastCalledWith(redactedValues);

    await changeValue(token, "replacement-token");
    const replacementValues = onValuesChange.mock.lastCall?.[0] as Record<string, unknown>;
    expect(replacementValues).toMatchObject({
      botToken: "replacement-token",
      webhookUrl: "[REDACTED]",
    });

    props = { ...props, values: replacementValues };
    await act(async () => {
      renderer.update(<ChannelSetupWizard {...props} />);
    });
    const replacementInput = findHostControl(renderer.root, "input", "channel-discord-draft-1-botToken");
    expect(replacementInput.props.value).toBe("replacement-token");

    await changeValue(replacementInput, "");
    expect(onValuesChange.mock.lastCall?.[0]).toMatchObject({ botToken: "[REDACTED]" });

    renderer.unmount();
  });

  it("gates finalization on a clean passing live test and renders the full probe report", async () => {
    const onFinalize = vi.fn(async () => undefined);
    let props = createWizardProps({
      feedback: { kind: "validate", status: "ok", issues: [] },
      onFinalize,
    });
    const renderer = await renderWizard(props);
    await click(findStepButton(renderer.root, "Finish setup"));

    expect(findButton(renderer.root, "Finalize connection").props).toMatchObject({
      disabled: true,
      title: "Run the live test before finalizing this connection.",
    });

    props = {
      ...props,
      feedback: {
        kind: "test",
        status: "warn",
        issues: [{ key: "permission", level: "warn", message: "The bot cannot send in the sandbox." }],
      },
    };
    await act(async () => renderer.update(<ChannelSetupWizard {...props} />));
    expect(findButton(renderer.root, "Finalize connection").props).toMatchObject({
      disabled: true,
      title: "Resolve the live test results and rerun the test before finalizing.",
    });

    props = { ...props, feedback: passingTestFeedback, dirty: false };
    await act(async () => renderer.update(<ChannelSetupWizard {...props} />));
    const probe = renderer.root.findByProps({ "aria-label": "Live connection probe" });
    expect(textOf(probe)).toContain("Bot token authentication Discord accepted the bot token.");
    expect(textOf(probe)).toContain("Runtime readiness Checked after finalization.");
    expect(textOf(renderer.root)).toContain("Next: Finalize the connection to start the persistent Discord gateway.");
    expect(findButton(renderer.root, "Finalize connection").props.disabled).toBe(false);

    await click(findButton(renderer.root, "Finalize connection"));
    expect(onFinalize).toHaveBeenCalledWith(discordDraft.draft);

    props = { ...props, dirty: true };
    await act(async () => renderer.update(<ChannelSetupWizard {...props} />));
    expect(findButton(renderer.root, "Finalize connection").props).toMatchObject({
      disabled: true,
      title: "Save these changes and run the live test again before finalizing.",
    });

    renderer.unmount();
  });

  it("invalidates a passing test as soon as a guided value is edited", async () => {
    function DirtyHarness() {
      const [values, setValues] = useState<Record<string, unknown>>(discordDraft.draft);
      const [dirty, setDirty] = useState(false);
      const [feedback, setFeedback] = useState<ChannelSetupWizardFeedback | null>(passingTestFeedback);
      return (
        <ChannelSetupWizard
          {...createWizardProps()}
          values={values}
          dirty={dirty}
          feedback={feedback}
          onValuesChange={(next) => {
            setValues(next);
            setDirty(true);
            setFeedback(null);
          }}
        />
      );
    }

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<DirtyHarness />);
      await Promise.resolve();
    });
    await click(findStepButton(renderer.root, "Finish setup"));
    expect(findButton(renderer.root, "Finalize connection").props.disabled).toBe(false);

    await click(findStepButton(renderer.root, "Paste your connection values"));
    await changeValue(
      findHostControl(renderer.root, "input", "channel-discord-draft-1-defaultChannelId"),
      "987654321098765432",
    );
    await click(findStepButton(renderer.root, "Finish setup"));
    expect(findButton(renderer.root, "Finalize connection").props).toMatchObject({
      disabled: true,
      title: "Save these changes and run the live test again before finalizing.",
    });

    renderer.unmount();
  });

  it("keeps advanced JSON as an explicit fallback and blocks malformed objects", async () => {
    const onDirty = vi.fn();
    const onValuesChange = vi.fn();
    const onSave = vi.fn(async () => true);
    const onValidate = vi.fn(async () => undefined);
    const renderer = await renderWizard(createWizardProps({ onDirty, onValuesChange, onSave, onValidate }));

    await click(findButton(renderer.root, "Advanced JSON"));
    const textarea = renderer.root.findByType("textarea");
    expect(textarea.props.value).toContain('"defaultChannelId": "123456789012345678"');

    await changeValue(textarea, "{ definitely-not-json");
    expect(onDirty).toHaveBeenCalledTimes(1);
    await click(findButton(renderer.root, "Validate"));
    expect(onValidate).not.toHaveBeenCalled();
    expect(textOf(renderer.root)).toContain("Advanced JSON is invalid:");

    const nextValues = { ...discordDraft.draft, defaultChannelId: "222222222222222222" };
    await changeValue(renderer.root.findByType("textarea"), JSON.stringify(nextValues));
    await click(findButton(renderer.root, "Save draft"));
    expect(onValuesChange).toHaveBeenLastCalledWith(nextValues);
    expect(onSave).toHaveBeenLastCalledWith(nextValues);

    renderer.unmount();
  });
});

describe("ChannelsSection Discord setup lifecycle", () => {
  it("persists dirty values before validation, runs the live probe, and finalizes without another write", async () => {
    const renderer = await renderChannelsSection();
    expect(renderer.root.findByProps({ "aria-label": "Discord guided setup" })).toBeDefined();

    await click(findStepButton(renderer.root, "Paste your connection values"));
    await changeValue(
      findHostControl(renderer.root, "input", "channel-discord-draft-1-defaultChannelId"),
      "987654321098765432",
    );
    await click(findStepButton(renderer.root, "Validate and test the connection"));
    await click(findButton(renderer.root, "Validate"));
    await flushWork();

    expect(channelApiMocks.updateChannelSetupDraft).toHaveBeenCalledTimes(1);
    expect(channelApiMocks.updateChannelSetupDraft).toHaveBeenCalledWith("discord-draft-1", {
      label: "Discord sandbox",
      enabled: true,
      draft: expect.objectContaining({ defaultChannelId: "987654321098765432" }),
    });
    expect(channelApiMocks.validateChannelSetupDraft).toHaveBeenCalledTimes(1);
    expect(channelApiMocks.updateChannelSetupDraft.mock.invocationCallOrder[0]).toBeLessThan(
      channelApiMocks.validateChannelSetupDraft.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );

    await click(findButton(renderer.root, "Run live test"));
    await flushWork();
    expect(channelApiMocks.validateChannelSetupDraft).toHaveBeenCalledTimes(2);
    expect(channelApiMocks.testChannelSetupDraft).toHaveBeenCalledWith("discord-draft-1");
    expect(channelApiMocks.validateChannelSetupDraft.mock.invocationCallOrder[1]).toBeLessThan(
      channelApiMocks.testChannelSetupDraft.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(textOf(renderer.root.findByProps({ "aria-label": "Live connection probe" }))).toContain(
      "Default channel access The bot can reach the sandbox channel.",
    );
    expect(textOf(renderer.root)).toContain("Next: Finalize the connection to start the persistent Discord gateway.");

    await click(findStepButton(renderer.root, "Finish setup"));
    expect(findButton(renderer.root, "Finalize connection").props.disabled).toBe(false);
    await click(findButton(renderer.root, "Finalize connection"));
    await flushWork();

    expect(channelApiMocks.finalizeChannelSetupDraft).toHaveBeenCalledWith("discord-draft-1");
    expect(channelApiMocks.updateChannelSetupDraft).toHaveBeenCalledTimes(1);

    renderer.unmount();
  });

  it("clears a passing test when the operator edits the draft and requires save plus retest", async () => {
    const renderer = await renderChannelsSection();
    await click(findStepButton(renderer.root, "Validate and test the connection"));
    await click(findButton(renderer.root, "Run live test"));
    await flushWork();
    await click(findStepButton(renderer.root, "Finish setup"));
    expect(findButton(renderer.root, "Finalize connection").props.disabled).toBe(false);

    const connectionLabel = renderer.root.findAllByType("input").find((input) => input.props.placeholder === "Discord");
    expect(connectionLabel).toBeDefined();
    await changeValue(connectionLabel!, "Discord production");

    expect(findButton(renderer.root, "Finalize connection").props).toMatchObject({
      disabled: true,
      title: "Save these changes and run the live test again before finalizing.",
    });
    expect(renderer.root.findAllByProps({ "aria-label": "Live connection probe" })).toHaveLength(0);

    await click(findButton(renderer.root, "Save draft"));
    await flushWork();
    expect(channelApiMocks.updateChannelSetupDraft).toHaveBeenLastCalledWith(
      "discord-draft-1",
      expect.objectContaining({ label: "Discord production" }),
    );
    await click(findStepButton(renderer.root, "Finish setup"));
    expect(findButton(renderer.root, "Finalize connection").props).toMatchObject({
      disabled: true,
      title: "Run the live test before finalizing this connection.",
    });

    await click(findStepButton(renderer.root, "Validate and test the connection"));
    await click(findButton(renderer.root, "Run live test"));
    await flushWork();
    await click(findStepButton(renderer.root, "Finish setup"));
    expect(findButton(renderer.root, "Finalize connection").props.disabled).toBe(false);

    renderer.unmount();
  });
});
