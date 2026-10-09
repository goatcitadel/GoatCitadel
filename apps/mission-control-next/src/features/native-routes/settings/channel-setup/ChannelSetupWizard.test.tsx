import { __resetSessionViewStateForTests } from "../../../../hooks/use-session-view-state";
import { __resetCredentialInputsForTests as __resetSessionDraftsForTests, hasCredentialInput as hasSessionDraft } from "../credential-input-owner";
import { DraftLeaveDialog } from "../../library/DraftLeaveDialog";
// @vitest-environment happy-dom
import { useState, type ComponentProps } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import type { ChannelSetupDefinition, ChannelSetupDraft } from "@goatcitadel/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelSetupWizard, type ChannelSetupWizardFeedback } from "./ChannelSetupWizard";
import { ChannelsSection } from "../sections/ChannelsSection";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { isChannelPrecommitConflict, __resetChannelMutationStateForTests } from "../sections/channel-setup-state";
import { ChannelsSettings } from "../../../../cockpit/areas/settings/ChannelsSettings";
import { ChannelDraftEditor } from "../../../../cockpit/areas/settings/ChannelDraftEditor";
import { TelegramPairingPanel } from "./TelegramPairingPanel";

const channelApiMocks = vi.hoisted(() => ({
  createChannelSetupDraft: vi.fn(),
  isApiRequestError: vi.fn(() => false),
  submitChannelSetupDraftSecrets: vi.fn(),
  createChangePlan: vi.fn(),
  discoverTelegramTargets: vi.fn(),
  fetchChannelSetupDefinitions: vi.fn(),
  fetchChannelSetupDrafts: vi.fn(),
  fetchChannelSetupDraft: vi.fn(),
  fetchIntegrationConnection: vi.fn(),
  reviewChannelSetupConnection: vi.fn(),
  fetchIntegrationConnections: vi.fn(),
  fetchSettings: vi.fn(),
  fetchSlackOAuthStatus: vi.fn(),
  startSlackOAuth: vi.fn(),
  testChannelSetupDraft: vi.fn(),
  updateChannelSetupDraft: vi.fn(),
  validateChannelSetupDraft: vi.fn(),
}));

const operationApiMocks = vi.hoisted(() => ({ discoverTelegramSetupTargets: vi.fn(), fetchChannelSetupDraftEvidence: vi.fn(), acknowledgeChannelSetupTest: vi.fn(), fetchChannelSetupJourney: vi.fn(), fetchTelegramChannelPairings: vi.fn(), approveTelegramChannelPairing: vi.fn(), revokeTelegramChannelPairing: vi.fn() }));
const oauthApiMocks = vi.hoisted(() => ({ startStagedSlackOAuth: vi.fn(), fetchChannelOAuthAttempt: vi.fn(), adoptSlackOAuthInstall: vi.fn(), cancelChannelOAuthAttempt: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/channel-setup-operations", () => operationApiMocks);
vi.mock("@goatcitadel/mission-control-shared/api/channel-oauth", () => oauthApiMocks);
const settingsNavigate = vi.fn();
vi.mock("../../../../cockpit/app/use-cockpit-route", () => ({ useCockpitRoute: () => ({ navigate: settingsNavigate }) }));
vi.mock("../../../../cockpit/ui/Dialog", () => ({ Dialog: ({ open, children, title, description }: { open: boolean; children: import("react").ReactNode; title: string; description?: string }) => open ? <div role="dialog" aria-label={title}><p>{description}</p>{children}</div> : null }));

vi.mock("@goatcitadel/mission-control-shared/api/client", () => channelApiMocks);

vi.mock("@goatcitadel/mission-control-shared/components/ConfirmModal", () => ({
  ConfirmModal: ({
    open,
    title,
    confirmLabel,
    cancelLabel,
    onConfirm,
    onCancel,
  }: {
    open: boolean;
    title: string;
    confirmLabel: string;
    cancelLabel: string;
    onConfirm: () => void;
    onCancel: () => void;
  }) =>
    open ? (
      <div>
        <h2>{title}</h2>
        <button type="button" onClick={onConfirm}>
          {confirmLabel}
        </button>
        <button type="button" onClick={onCancel}>
          {cancelLabel}
        </button>
      </div>
    ) : null,
}));

// Browser focus/portal behavior is covered by the browser lane; keep this renderer in one tree.
vi.mock("@goatcitadel/mission-control-shared/components/ui/GCModal", () => ({
  GCModal: ({ open, children, title }: { open: boolean; children: import("react").ReactNode; title: string }) =>
    open ? (
      <div role="dialog" aria-label={title}>
        {children}
      </div>
    ) : null,
}));

vi.mock("../../SettingsNativePage", () => ({
  delay: async () => undefined,
  formatDateTime: (value: string | undefined) => value ?? "Never",
  formatJson: (value: unknown) => JSON.stringify(value, null, 2),
  parseJsonObject: (value: string) => {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Object required");
    return parsed;
  },
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
            inputMode: "numeric",
            required: true,
            explanation: "The default Discord destination.",
          },
          {
            key: "defaultGuildId",
            label: "Optional server (guild) ID",
            type: "id",
            inputMode: "numeric",
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
  revision: 1,
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
  secretState: {},
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
  draftRevision: discordDraft.revision,
  status: "ok" as const,
  levels: ["structural", "semantic"] as const,
  issues: [],
  checkedAt: "2026-08-07T12:09:00.000Z",
};

const testResponse = {
  draftId: discordDraft.draftId,
  draftRevision: discordDraft.revision,
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
  channelApiMocks.isApiRequestError.mockReturnValue(false);
  channelApiMocks.fetchChannelSetupDraft.mockImplementation(async () => currentApiDraft);
  channelApiMocks.fetchChannelSetupDefinitions.mockImplementation(async () => ({ items: [discordDefinition] }));
  channelApiMocks.fetchChannelSetupDrafts.mockImplementation(async () => ({ items: [currentApiDraft] }));
  channelApiMocks.fetchIntegrationConnections.mockImplementation(async () => ({ items: [] }));
  channelApiMocks.fetchSettings.mockResolvedValue({ features: { connectorDiagnosticsV1Enabled: false } });
  channelApiMocks.fetchSlackOAuthStatus.mockImplementation(async () => ({ configured: false }));
  operationApiMocks.fetchChannelSetupDraftEvidence.mockImplementation(async (draftId: string, draftRevision: number) => {
    const checked = [channelApiMocks.testChannelSetupDraft, operationApiMocks.acknowledgeChannelSetupTest]
      .flatMap((mock) => mock.mock.results.map((result, index) => ({ result, order: mock.mock.invocationCallOrder[index] ?? 0 })))
      .sort((left, right) => right.order - left.order)[0];
    let result: typeof testResponse & { evidenceId?: string; finalizationEligibility?: ChannelSetupWizardFeedback["finalizationEligibility"] } | undefined;
    try { if (checked?.result.type === "return") result = await checked.result.value; } catch { result = undefined; }
    if (!result || result.draftId !== draftId) return { draftId, draftRevision, items: [] };
    const evidenceId = result.evidenceId ?? "fixture-stored-" + draftRevision;
    const currentTest = { ...result, evidenceId, proofExpiresAt: new Date(Date.now() + 300_000).toISOString(), finalizationEligibility: { allowed: result.status === "ok", blockingReasons: [], ...result.finalizationEligibility, evidenceId } };
    return { draftId, draftRevision, currentTest: result.draftRevision === draftRevision ? currentTest : undefined, items: [{ ...currentTest, catalogId: currentApiDraft.catalogId, phase: "test", createdAt: currentTest.checkedAt }] };
  });
  channelApiMocks.validateChannelSetupDraft.mockImplementation(async () => {
    currentApiDraft = { ...currentApiDraft, revision: currentApiDraft.revision + 1 };
    return { ...validationResponse, draftRevision: currentApiDraft.revision };
  });
  channelApiMocks.testChannelSetupDraft.mockImplementation(async () => {
    currentApiDraft = { ...currentApiDraft, revision: currentApiDraft.revision + 2 };
    return { ...testResponse, draftRevision: currentApiDraft.revision };
  });
  channelApiMocks.updateChannelSetupDraft.mockImplementation(
    async (_draftId: string, input: { label?: string; enabled?: boolean; draft?: Record<string, unknown> }) => {
      currentApiDraft = {
        ...currentApiDraft,
        revision: currentApiDraft.revision + 1,
        label: input.label ?? currentApiDraft.label,
        enabled: input.enabled ?? currentApiDraft.enabled,
        draft: input.draft ?? currentApiDraft.draft,
        updatedAt: "2026-08-07T12:08:00.000Z",
      };
      return currentApiDraft;
    },
  );
  channelApiMocks.createChangePlan.mockImplementation(async () => ({
    planId: "plan-channel-1",
    status: "awaiting_confirmation",
    revision: 1,
    origin: { workspaceId: "default", surface: "settings" },
    request: { kind: "channel_connection", channelKind: currentApiDraft.catalogId, draftId: currentApiDraft.draftId },
    target: { ownerId: "channel_setup_draft", resourceId: currentApiDraft.draftId, expectedRevision: currentApiDraft.revision },
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

function findDraftButton(root: ReactTestInstance, label: string): ReactTestInstance {
  const button = root.findAllByType("button").find((node) => textOf(node).startsWith(label + " "));
  if (!button) throw new Error("Draft row not found: " + label);
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

async function renderChannelsSection(label = "Discord sandbox"): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <ChannelsSection
        {...({
          activeWorkspaceId: "default",
          activeWorkspaceName: "Default",
          setActiveWorkspaceId: vi.fn(),
          navigate: settingsNavigate,
          route: { area: "settings", section: "channels", theme: "light" },
          section: "channels",
        } as ComponentProps<typeof ChannelsSection>)}
      />,
    );
    await Promise.resolve();
  });
  await flushWork();
  await click(findDraftButton(renderer.root, label));
  return renderer;
}

beforeEach(() => {
  __resetChannelMutationStateForTests();
  __resetSessionViewStateForTests();
  __resetSessionDraftsForTests();
  vi.clearAllMocks();
  configureChannelApiMocks();
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Channel fixture must never reach a live Gateway."); }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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
    expect(textOf(probe)).toContain("Bot token authentication · Passed Discord accepted the bot token.");
    expect(textOf(probe)).toContain("Runtime readiness · Not tested Checked after finalization.");
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
    expect(onValuesChange).not.toHaveBeenCalled();
    expect(onSave).toHaveBeenLastCalledWith(nextValues);

    renderer.unmount();
  });
});

describe("ChannelsSection Discord setup lifecycle", () => {
  it("preserves unsaved input through a failed connection refresh and explicitly reviews before retrying", async () => {
    currentApiDraft = { ...discordDraft, connectionId: "connection-fixture", connectionRevision: "a".repeat(64) };
    const connection = { connectionId: "connection-fixture", revision: "a".repeat(64), catalogId: "channel.discord", kind: "channel", key: "discord", label: "Saved connection", enabled: true, status: "connected", config: { botToken: "[REDACTED]" }, createdAt: discordDraft.createdAt, updatedAt: discordDraft.updatedAt };
    channelApiMocks.fetchIntegrationConnections.mockResolvedValue({ items: [connection] });
    channelApiMocks.fetchIntegrationConnection.mockRejectedValueOnce(new Error("Read unavailable")).mockResolvedValue({ ...connection, revision: "b".repeat(64), label: "Peer connection", enabled: false });
    channelApiMocks.isApiRequestError.mockReturnValue(true);
    channelApiMocks.updateChannelSetupDraft.mockRejectedValueOnce(new ApiRequestError("Changed", { kind: "http", method: "PATCH", path: "/fixture", status: 409,
      body: { code: "WRITE_CONFLICT", details: { reason: "CHANNEL_DRAFT_REVISION_CONFLICT", draftId: discordDraft.draftId } } }));
    channelApiMocks.reviewChannelSetupConnection.mockImplementation(async (_id, input) => {
      currentApiDraft = { ...currentApiDraft, revision: 2, connectionRevision: input.expectedConnectionRevision };
      return currentApiDraft;
    });
    const renderer = await renderChannelsSection();
    await click(findButton(renderer.root, "Advanced JSON"));
    await changeValue(renderer.root.findByType("textarea"), JSON.stringify({ ...discordDraft.draft, defaultChannelId: "retained-channel" }));
    await click(findButton(renderer.root, "Save draft"));
    expect(textOf(renderer.root)).toContain("Current settings could not be loaded");
    expect(renderer.root.findByType("textarea").props.value).toContain("retained-channel");
    expect(findButton(renderer.root, "Run live test").props.disabled).toBe(true);
    await click(findButton(renderer.root, "Reload connection review"));
    expect(textOf(renderer.root)).toContain("Peer connection");
    expect(channelApiMocks.reviewChannelSetupConnection).not.toHaveBeenCalled();
    await click(findButton(renderer.root, "Use current connection review"));
    expect(channelApiMocks.reviewChannelSetupConnection).toHaveBeenCalledExactlyOnceWith(discordDraft.draftId, { expectedRevision: 1, expectedConnectionRevision: "b".repeat(64) });
    expect(renderer.root.findByType("textarea").props.value).toContain("retained-channel");
    expect(channelApiMocks.updateChannelSetupDraft).toHaveBeenCalledTimes(1);
    expect(channelApiMocks.testChannelSetupDraft).not.toHaveBeenCalled();
    await click(findButton(renderer.root, "Save draft"));
    expect(channelApiMocks.updateChannelSetupDraft).toHaveBeenLastCalledWith(discordDraft.draftId, expect.objectContaining({ expectedRevision: 2, draft: expect.objectContaining({ defaultChannelId: "retained-channel" }) }));
    renderer.unmount();
  });

  it("blocks a deleted connection while retaining the channel draft", async () => {
    currentApiDraft = { ...discordDraft, connectionId: "deleted-connection", connectionRevision: "a".repeat(64) };
    channelApiMocks.isApiRequestError.mockReturnValue(true);
    channelApiMocks.fetchIntegrationConnection.mockRejectedValueOnce(new ApiRequestError("Deleted", { kind: "http", method: "GET", path: "/fixture", status: 404 }));
    const renderer = await renderChannelsSection();
    await click(findButton(renderer.root, "Advanced JSON"));
    expect(textOf(renderer.root)).toContain("This connection was deleted. Your draft is retained.");
    expect(renderer.root.findByType("textarea").props.value).toContain(discordDraft.draft.defaultChannelId);
    expect(findButton(renderer.root, "Run live test").props.disabled).toBe(true);
    expect(channelApiMocks.updateChannelSetupDraft).not.toHaveBeenCalled();
    renderer.unmount();
  });

  it("ignores a late accepted review after switching workspace and back", async () => {
    currentApiDraft = { ...discordDraft, connectionId: "connection-fixture", connectionRevision: "a".repeat(64) };
    const connection = { connectionId: "connection-fixture", revision: "b".repeat(64), catalogId: "channel.discord", kind: "channel", key: "discord", label: "Current connection", enabled: true, status: "connected", config: {}, createdAt: discordDraft.createdAt, updatedAt: discordDraft.updatedAt };
    channelApiMocks.fetchIntegrationConnections.mockResolvedValue({ items: [connection] });
    channelApiMocks.fetchIntegrationConnection.mockResolvedValue(connection);
    let resolve!: (draft: ChannelSetupDraft) => void;
    channelApiMocks.reviewChannelSetupConnection.mockReturnValueOnce(new Promise<ChannelSetupDraft>(yes => { resolve = yes; }));
    const renderer = await renderChannelsSection();
    await click(findButton(renderer.root, "Use current connection review"));
    const props = renderer.root.findByType(ChannelsSection).props as ComponentProps<typeof ChannelsSection>;
    await act(async () => { renderer.update(<ChannelsSection {...props} activeWorkspaceId="other" />); });
    await act(async () => { renderer.update(<ChannelsSection {...props} />); });
    await act(async () => { resolve({ ...currentApiDraft, label: "Late response", revision: 2, connectionRevision: connection.revision }); });
    await click(findDraftButton(renderer.root, "Discord sandbox"));
    expect(textOf(renderer.root)).not.toContain("Late response");
    expect(renderer.root.findByType(ChannelSetupWizard).props.busyAction).toBe(null);
    expect(channelApiMocks.updateChannelSetupDraft).not.toHaveBeenCalled();
    renderer.unmount();
  });
  it("retains incomplete advanced JSON through close and reopen and failed saves", async () => {
    const renderer = await renderChannelsSection();
    await click(findButton(renderer.root, "Advanced JSON"));
    await changeValue(renderer.root.findByType("textarea"), '{ "unfinished":');
    await click(findButton(renderer.root, "Back to list"));
    await act(async () => renderer.root.findByType(DraftLeaveDialog).props.onContinue());
    expect(textOf(findDraftButton(renderer.root, "Discord sandbox"))).toContain("Unsaved");
    await click(findDraftButton(renderer.root, "Discord sandbox"));
    expect(renderer.root.findByType("textarea").props.value).toBe('{ "unfinished":');
    await click(findButton(renderer.root, "Save draft"));
    expect(channelApiMocks.updateChannelSetupDraft).not.toHaveBeenCalled();
    expect(renderer.root.findByType("textarea").props.value).toBe('{ "unfinished":');
    await changeValue(
      renderer.root.findByType("textarea"),
      JSON.stringify({ ...discordDraft.draft, defaultChannelId: "retained-input" }),
    );
    channelApiMocks.updateChannelSetupDraft.mockRejectedValueOnce(new Error("Save unavailable"));
    await click(findButton(renderer.root, "Save draft"));
    await flushWork();
    expect(textOf(renderer.root)).toContain("Save unavailable");
    expect(renderer.root.findByType("textarea").props.value).toContain("retained-input");
    renderer.unmount();
  });

  it("requires a new live test when a refresh returns a newer revision", async () => {
    channelApiMocks.testChannelSetupDraft.mockImplementation(async () => {
      const draftRevision = currentApiDraft.revision + 2;
      currentApiDraft = { ...currentApiDraft, revision: draftRevision + 1, label: "Changed elsewhere" };
      return { ...testResponse, draftRevision };
    });
    const renderer = await renderChannelsSection();
    await click(findStepButton(renderer.root, "Validate and test the connection"));
    await click(findButton(renderer.root, "Run live test"));
    await click(findButton(renderer.root, "Run reviewed live test"));
    await flushWork();
    await click(findStepButton(renderer.root, "Finish setup"));
    expect(findButton(renderer.root, "Finalize connection").props.disabled).toBe(true);
    expect(textOf(renderer.root)).toContain("No fresh test proof is available for this saved revision");
    expect(channelApiMocks.createChangePlan).not.toHaveBeenCalled();
    renderer.unmount();
  });

  it("preserves unsaved setup edits until a draft switch is confirmed", async () => {
    const secondDraft: ChannelSetupDraft = {
      ...discordDraft,
      draftId: "discord-draft-2",
      label: "Discord backup",
      draft: { ...discordDraft.draft, defaultChannelId: "222222222222222222" },
    };
    channelApiMocks.fetchChannelSetupDrafts.mockResolvedValue({ items: [discordDraft, secondDraft] });
    const renderer = await renderChannelsSection();
    const labelInput = renderer.root.findAllByType("input").find((input) => input.props.placeholder === "Discord")!;
    await changeValue(labelInput, "Unsaved primary");

    await click(findButton(renderer.root, "Back to list"));
    let dialog = renderer.root.findByType(DraftLeaveDialog);
    expect(dialog.props.open).toBe(true);
    await act(async () => dialog.props.onCancel());
    expect(
      renderer.root.findAllByType("input").find((input) => input.props.placeholder === "Discord")?.props.value,
    ).toBe("Unsaved primary");
    await click(findButton(renderer.root, "Back to list"));
    dialog = renderer.root.findByType(DraftLeaveDialog);
    await act(async () => dialog.props.onContinue());
    await click(findDraftButton(renderer.root, "Discord backup"));
    expect(
      renderer.root.findAllByType("input").find((input) => input.props.placeholder === "Discord")?.props.value,
    ).toBe("Discord backup");
    await click(findButton(renderer.root, "Back to list"));
    await click(findDraftButton(renderer.root, "Discord sandbox"));
    expect(
      renderer.root.findAllByType("input").find((input) => input.props.placeholder === "Discord")?.props.value,
    ).toBe("Unsaved primary");

    renderer.unmount();
  });

  it("persists dirty values, runs the live probe, and creates a governed finalization plan", async () => {
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
      expectedRevision: 1,
      label: "Discord sandbox",
      enabled: true,
      draft: expect.objectContaining({ defaultChannelId: "987654321098765432" }),
    });
    expect(channelApiMocks.validateChannelSetupDraft).toHaveBeenCalledTimes(1);
    expect(channelApiMocks.updateChannelSetupDraft.mock.invocationCallOrder[0]).toBeLessThan(
      channelApiMocks.validateChannelSetupDraft.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );

    await click(findButton(renderer.root, "Run live test"));
    await click(findButton(renderer.root, "Run reviewed live test"));
    await flushWork();
    expect(channelApiMocks.validateChannelSetupDraft).toHaveBeenCalledTimes(2);
    expect(channelApiMocks.testChannelSetupDraft).toHaveBeenCalledWith("discord-draft-1", 4);
    expect(channelApiMocks.validateChannelSetupDraft.mock.invocationCallOrder[1]).toBeLessThan(
      channelApiMocks.testChannelSetupDraft.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(textOf(renderer.root.findByProps({ "aria-label": "Live connection probe" }))).toContain(
      "Default channel access · Passed The bot can reach the sandbox channel.",
    );
    expect(textOf(renderer.root)).toContain("Next: Finalize the connection to start the persistent Discord gateway.");

    await click(findStepButton(renderer.root, "Finish setup"));
    expect(findButton(renderer.root, "Finalize connection").props.disabled).toBe(false);
    await click(findButton(renderer.root, "Finalize connection"));
    await flushWork();

    expect(channelApiMocks.createChangePlan).toHaveBeenCalledWith({
      workspaceId: "default",
      surface: "settings",
      request: {
        kind: "channel_connection",
        channelKind: "channel.discord",
        draftId: "discord-draft-1",
      },
      idempotencyKey: expect.stringContaining("settings-channel-finalize:discord-draft-1:"),
    });
    expect(channelApiMocks.updateChannelSetupDraft).toHaveBeenCalledTimes(1);
    expect(settingsNavigate).toHaveBeenCalledWith({ area: "chat", theme: "light", channelPlan: "plan-channel-1", channelDraft: "discord-draft-1", channelRevision: 1, channelWorkspace: "default" });
    expect(textOf(renderer.root)).toContain("has not been finalized yet");

    renderer.unmount();
  });

  it("clears a passing test when the operator edits the draft and requires save plus retest", async () => {
    const renderer = await renderChannelsSection();
    await click(findStepButton(renderer.root, "Validate and test the connection"));
    await click(findButton(renderer.root, "Run live test"));
    await click(findButton(renderer.root, "Run reviewed live test"));
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
    await click(findButton(renderer.root, "Run reviewed live test"));
    await flushWork();
    await click(findStepButton(renderer.root, "Finish setup"));
    expect(findButton(renderer.root, "Finalize connection").props.disabled).toBe(false);

    renderer.unmount();
  });

  it("keeps the operator on the active step across the post-action reload", async () => {
    const renderer = await renderChannelsSection();

    await click(findStepButton(renderer.root, "Paste your connection values"));
    await changeValue(
      findHostControl(renderer.root, "input", "channel-discord-draft-1-defaultChannelId"),
      "987654321098765432",
    );
    await click(findButton(renderer.root, "Save draft"));
    await flushWork();

    expect(channelApiMocks.updateChannelSetupDraft).toHaveBeenCalledTimes(1);
    // The save handler reloads section data; the wizard must stay mounted on the
    // step the operator was working in instead of resetting to the first step.
    expect(findStepButton(renderer.root, "Paste your connection values").props["aria-current"]).toBe("step");
    expect(findHostControl(renderer.root, "input", "channel-discord-draft-1-defaultChannelId").props.value).toBe(
      "987654321098765432",
    );

    renderer.unmount();
  });
});

describe("shared channel setup safety and native controls", () => {
  it("keeps an unconfirmed save locked across remount and admits only one dispatch", async () => {
    let reject!: (error: Error) => void;
    channelApiMocks.updateChannelSetupDraft.mockReturnValueOnce(new Promise((_yes, no) => { reject = no; }));
    const renderer = await renderChannelsSection();
    const label = renderer.root.findAllByType("input").find((input) => input.props.placeholder === "Discord")!;
    await changeValue(label, "Reviewed replacement");
    const save = findButton(renderer.root, "Save draft");
    await act(async () => { save.props.onClick(); save.props.onClick(); });
    await flushWork();
    expect(channelApiMocks.updateChannelSetupDraft).toHaveBeenCalledTimes(1);
    renderer.unmount();
    await act(async () => reject(new Error("Response lost after dispatch")));
    await flushWork();
    const remounted = await renderChannelsSection();
    expect(textOf(remounted.root)).toContain("Outcome uncertain");
    expect(findButton(remounted.root, "Save draft").props.disabled).toBe(true);
    await click(findButton(remounted.root, "Advanced JSON"));
    expect(remounted.root.findByType("textarea").props.disabled).toBe(false);
    await changeValue(remounted.root.findByType("textarea"), '{"local":"still editable"}');
    expect(findButton(remounted.root, "Save draft").props.disabled).toBe(true);
    await click(findButton(remounted.root, "Save draft"));
    expect(channelApiMocks.updateChannelSetupDraft).toHaveBeenCalledTimes(1);
    remounted.unmount();
  });

  it("cancels a delayed preflight when the workspace changes away and back", async () => {
    const renderer = await renderChannelsSection();
    await changeValue(renderer.root.findAllByType("input").find((input) => input.props.placeholder === "Discord")!, "Never dispatch");
    let resolve!: (draft: ChannelSetupDraft) => void;
    channelApiMocks.fetchChannelSetupDraft.mockReturnValueOnce(new Promise<ChannelSetupDraft>((yes) => { resolve = yes; }));
    await click(findButton(renderer.root, "Save draft"));
    const props = renderer.root.findByType(ChannelsSection).props as ComponentProps<typeof ChannelsSection>;
    await act(async () => renderer.update(<ChannelsSection {...props} activeWorkspaceId="other" />));
    await act(async () => renderer.update(<ChannelsSection {...props} />));
    await act(async () => resolve(discordDraft));
    await flushWork();
    expect(channelApiMocks.updateChannelSetupDraft).not.toHaveBeenCalled();
    renderer.unmount();
  });

  it("never classifies a committed conflict marker as permission to retry", async () => {
    channelApiMocks.isApiRequestError.mockReturnValue(true);
    channelApiMocks.updateChannelSetupDraft.mockRejectedValueOnce(new ApiRequestError("Audit failed after commit", {
      kind: "http", method: "PATCH", path: "/fixture", status: 409,
      body: { code: "WRITE_CONFLICT", mutationCommitted: true, details: { reason: "CHANNEL_DRAFT_REVISION_CONFLICT", draftId: discordDraft.draftId } },
    }));
    const renderer = await renderChannelsSection();
    await changeValue(renderer.root.findAllByType("input").find((input) => input.props.placeholder === "Discord")!, "Commit receipt missing");
    await click(findButton(renderer.root, "Save draft"));
    expect(textOf(renderer.root)).toContain("Outcome uncertain");
    expect(channelApiMocks.updateChannelSetupDraft).toHaveBeenCalledTimes(1);
    renderer.unmount();
  });

  it("uses the native editor to cancel a live test without any validation or test mutation", async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<ChannelsSettings workspaceId="default" />); });
    await flushWork();
    await click(findButton(renderer.root, "Edit Discord sandbox"));
    expect(textOf(renderer.root)).toContain("belong to this installation");
    expect(renderer.root.findByType(ChannelDraftEditor)).toBeDefined();
    await click(findStepButton(renderer.root, "Validate and test the connection"));
    await click(findButton(renderer.root, "Review live test"));
    expect(textOf(renderer.root)).toContain("may send a sandbox message");
    await click(findButton(renderer.root, "Cancel test"));
    expect(channelApiMocks.validateChannelSetupDraft).not.toHaveBeenCalled();
    expect(channelApiMocks.testChannelSetupDraft).not.toHaveBeenCalled();
    renderer.unmount();
  });

  it("withholds a live test if input changes while its native review is open", async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<ChannelsSettings workspaceId="default" />); });
    await flushWork();
    await click(findButton(renderer.root, "Edit Discord sandbox"));
    await click(findStepButton(renderer.root, "Validate and test the connection"));
    await click(findButton(renderer.root, "Review live test"));
    await changeValue(renderer.root.findByProps({ "aria-label": "Connection label" }), "Newer input");
    expect(findButton(renderer.root, "Run reviewed live test").props.disabled).toBe(true);
    expect(channelApiMocks.testChannelSetupDraft).not.toHaveBeenCalled();
    renderer.unmount();
  });
});

describe("channel confirmed receipts and OAuth scope", () => {
  it("acknowledges a confirmed late public save in the originating retained draft", async () => {
    let resolve!: (draft: ChannelSetupDraft) => void;
    channelApiMocks.updateChannelSetupDraft.mockReturnValueOnce(new Promise<ChannelSetupDraft>((yes) => { resolve = yes; }));
    const renderer = await renderChannelsSection();
    await changeValue(renderer.root.findAllByType("input").find((input) => input.props.placeholder === "Discord")!, "Saved after leave");
    await click(findButton(renderer.root, "Save draft"));
    renderer.unmount();
    currentApiDraft = { ...discordDraft, label: "Saved after leave", revision: 2 };
    await act(async () => resolve(currentApiDraft));
    await flushWork();
    expect(hasSessionDraft("channel:default:discord-draft-1:setup")).toBe(false);
    const next = await renderChannelsSection("Saved after leave");
    expect(next.root.findAllByType("input").find((input) => input.props.placeholder === "Discord")?.props.value).toBe("Saved after leave");
    next.unmount();
  });
  it("acknowledges public fields but retains an unsent secret when navigation interrupts its second write", async () => {
    let resolve!: (draft: ChannelSetupDraft) => void;
    channelApiMocks.updateChannelSetupDraft.mockReturnValueOnce(new Promise<ChannelSetupDraft>((yes) => { resolve = yes; }));
    const renderer = await renderChannelsSection();
    await click(findStepButton(renderer.root, "Paste your connection values"));
    await changeValue(findHostControl(renderer.root, "input", "channel-discord-draft-1-botToken"), "synthetic-unsent-token");
    await click(findButton(renderer.root, "Save draft"));
    expect(channelApiMocks.updateChannelSetupDraft.mock.lastCall?.[1].draft).not.toHaveProperty("botToken");
    renderer.unmount();
    currentApiDraft = { ...discordDraft, revision: 2 };
    await act(async () => resolve(currentApiDraft));
    await flushWork();
    expect(channelApiMocks.submitChannelSetupDraftSecrets).not.toHaveBeenCalled();
    expect(hasSessionDraft("channel:default:discord-draft-1:setup")).toBe(true);
    const next = await renderChannelsSection();
    await click(findStepButton(next.root, "Paste your connection values"));
    expect(findHostControl(next.root, "input", "channel-discord-draft-1-botToken").props.value).toBe("synthetic-unsent-token");
    next.unmount();
  });
  it("withholds staged Slack OAuth start when the workspace changes during saved-draft preflight", async () => {
    const slack = { ...discordDefinition, catalog: { ...discordDefinition.catalog, catalogId: "channel.slack", label: "Slack" } };
    const slackDraft = { ...discordDraft, draftId: "slack-draft", catalogId: "channel.slack", label: "Slack sandbox" };
    channelApiMocks.fetchChannelSetupDefinitions.mockResolvedValue({ items: [discordDefinition, slack] });
    channelApiMocks.fetchChannelSetupDrafts.mockResolvedValue({ items: [discordDraft, slackDraft] });
    const renderer = await renderChannelsSection();
    await click(findButton(renderer.root, "Back to list"));
    await click(findDraftButton(renderer.root, "Slack sandbox"));
    await click(findStepButton(renderer.root, "Paste your connection values"));
    let resolve!: (draft: ChannelSetupDraft) => void;
    channelApiMocks.fetchChannelSetupDraft.mockReturnValueOnce(new Promise<ChannelSetupDraft>((yes) => { resolve = yes; }));
    await click(findButton(renderer.root, "Connect Slack with OAuth"));
    const props = renderer.root.findByType(ChannelsSection).props as ComponentProps<typeof ChannelsSection>;
    await act(async () => renderer.update(<ChannelsSection {...props} activeWorkspaceId="other" />));
    await act(async () => resolve(slackDraft));
    await flushWork();
    expect(oauthApiMocks.startStagedSlackOAuth).not.toHaveBeenCalled();
    renderer.unmount();
  });});


describe("bound channel setup operations", () => {
  it("saves and tests the exact reviewed advanced JSON without a preliminary client value rewrite", async () => {
    const renderer = await renderChannelsSection();
    await click(findButton(renderer.root, "Advanced JSON"));
    const revised = { ...discordDraft.draft, defaultChannelId: "987654321098765432" };
    await changeValue(renderer.root.findByType("textarea"), JSON.stringify(revised));
    await click(findButton(renderer.root, "Run live test"));
    expect(channelApiMocks.updateChannelSetupDraft).not.toHaveBeenCalled();
    await click(findButton(renderer.root, "Run reviewed live test"));
    await flushWork();
    expect(channelApiMocks.updateChannelSetupDraft).toHaveBeenCalledTimes(1);
    expect(channelApiMocks.updateChannelSetupDraft.mock.lastCall?.[1].draft).toMatchObject(revised);
    expect(channelApiMocks.testChannelSetupDraft).toHaveBeenCalledTimes(1);
    renderer.unmount();
  });

  it("acknowledges optional cleanup on the same draft revision and keeps warn visible", async () => {
    channelApiMocks.testChannelSetupDraft.mockImplementation(async () => {
      currentApiDraft = { ...currentApiDraft, revision: currentApiDraft.revision + 2 };
      return { ...testResponse, status: "warn", evidenceId: "evidence-original", draftRevision: currentApiDraft.revision,
        finalizationEligibility: { allowed: false, blockingReasons: ["Acknowledge cleanup"], requiresAcknowledgement: true },
        probe: { ...testResponse.probe, steps: [{ key: "cleanup", label: "Cleanup", status: "warn", disposition: "advisory", cleanupStatus: "manual_required", providerMessageId: "provider-receipt", message: "Delete the test message manually" }] } };
    });
    operationApiMocks.acknowledgeChannelSetupTest.mockImplementation(async (_id, input) => ({ ...testResponse,
      draftRevision: input.expectedRevision, evidenceId: "evidence-ack", status: "warn",
      finalizationEligibility: { allowed: true, blockingReasons: [], evidenceId: "evidence-ack" } }));
    const renderer = await renderChannelsSection();
    await click(findStepButton(renderer.root, "Validate and test the connection"));
    await click(findButton(renderer.root, "Run live test"));
    await click(findButton(renderer.root, "Run reviewed live test"));
    await flushWork();
    const testedRevision = currentApiDraft.revision;
    await click(findButton(renderer.root, "Review test message cleanup"));
    expect(operationApiMocks.acknowledgeChannelSetupTest).not.toHaveBeenCalled();
    await click(findButton(renderer.root, "Acknowledge reviewed cleanup warning"));
    await flushWork();
    expect(operationApiMocks.acknowledgeChannelSetupTest).toHaveBeenCalledWith("discord-draft-1", { expectedRevision: testedRevision, evidenceId: "evidence-original", acknowledgement: "cleanup" });
    expect(currentApiDraft.revision).toBe(testedRevision);
    expect(textOf(renderer.root)).toContain("Connection test · Warning");
    await click(findStepButton(renderer.root, "Finish setup"));
    expect(findButton(renderer.root, "Finalize connection").props.disabled).toBe(false);
    renderer.unmount();
  });

  it("leaves unrelated warnings blocking after a valid cleanup acknowledgement", async () => {
    channelApiMocks.testChannelSetupDraft.mockImplementation(async () => {
      currentApiDraft = { ...currentApiDraft, revision: currentApiDraft.revision + 2 };
      return { ...testResponse, status: "warn", evidenceId: "evidence-original", draftRevision: currentApiDraft.revision,
        finalizationEligibility: { allowed: false, blockingReasons: ["Unverified transport", "Acknowledge cleanup"], requiresAcknowledgement: true },
        probe: { ...testResponse.probe, steps: [{ key: "cleanup", label: "Cleanup", status: "warn", disposition: "advisory", cleanupStatus: "manual_required", message: "Delete manually" }] } };
    });
    operationApiMocks.acknowledgeChannelSetupTest.mockImplementation(async (_id, input) => ({ ...testResponse,
      status: "warn", draftRevision: input.expectedRevision, evidenceId: "evidence-ack",
      finalizationEligibility: { allowed: false, blockingReasons: ["Unverified transport"] } }));
    const renderer = await renderChannelsSection();
    await click(findStepButton(renderer.root, "Validate and test the connection"));
    await click(findButton(renderer.root, "Run live test"));
    await click(findButton(renderer.root, "Run reviewed live test"));
    await click(findButton(renderer.root, "Review test message cleanup"));
    await click(findButton(renderer.root, "Acknowledge reviewed cleanup warning"));
    await click(findStepButton(renderer.root, "Finish setup"));
    expect(findButton(renderer.root, "Finalize connection").props).toMatchObject({ disabled: true, title: "Unverified transport" });
    expect(channelApiMocks.createChangePlan).not.toHaveBeenCalled();
    renderer.unmount();
  });

  it("stores discovered Telegram candidates until explicit selection, preserving manual targets and their default", async () => {
    const telegram = { ...discordDefinition, catalog: { ...discordDefinition.catalog, catalogId: "channel.telegram", key: "telegram", label: "Telegram" }, wizard: { ...discordDefinition.wizard, steps: discordDefinition.wizard.steps.map((step) => step.id === "collect-values" ? { ...step, fields: [{ key: "targets", label: "Destinations", type: "target-list" as const, targetAddressKey: "chatId" as const, required: true, explanation: "Choose chats" }] } : step) } };
    const manual = { id: "manual", label: "Manual home", chatId: "-1000000000000001", default: true, customRoute: "retain" };
    currentApiDraft = { ...discordDraft, draftId: "telegram-draft", catalogId: "channel.telegram", label: "Telegram sandbox", draft: { botToken: "[REDACTED]", targets: [manual] } };
    channelApiMocks.fetchChannelSetupDefinitions.mockResolvedValue({ items: [telegram] });
    operationApiMocks.discoverTelegramSetupTargets.mockResolvedValue({ items: [{ id: "candidate", label: "New chat", chatId: "-1000000000000002", kind: "group", source: "recent_update" }], warnings: ["Only recent chats appear"], webhookActive: false });
    const renderer = await renderChannelsSection("Telegram sandbox");
    await click(findStepButton(renderer.root, "Paste your connection values"));
    await click(findButton(renderer.root, "Detect Telegram chats"));
    await flushWork();
    expect(operationApiMocks.discoverTelegramSetupTargets).toHaveBeenCalledWith({ source: "draft", draftId: "telegram-draft", expectedRevision: 1, setupCode: undefined });
    expect(renderer.root.findByType(ChannelSetupWizard).props.values.targets).toEqual([manual]);
    expect(findButton(renderer.root, "Add selected chats without replacing destinations").props.disabled).toBe(true);
    const candidates = renderer.root.findByProps({ "aria-label": "Discover Telegram destinations" }).findAllByType("input");
    await act(async () => candidates[0]!.props.onChange({ target: { checked: true } }));
    await click(findButton(renderer.root, "Add selected chats without replacing destinations"));
    expect(renderer.root.findByType(ChannelSetupWizard).props.values.targets).toEqual([manual, { id: "candidate", label: "New chat", chatId: "-1000000000000002", kind: "group", default: false }]);
    expect(channelApiMocks.updateChannelSetupDraft).not.toHaveBeenCalled();
    renderer.unmount();
  });

  it("withholds a staged OAuth mutation if draft input changes during canonical preflight", async () => {
    const slack = { ...discordDefinition, catalog: { ...discordDefinition.catalog, catalogId: "channel.slack", key: "slack", label: "Slack" } };
    currentApiDraft = { ...discordDraft, draftId: "slack-draft", catalogId: "channel.slack", label: "Slack sandbox" };
    channelApiMocks.fetchChannelSetupDefinitions.mockResolvedValue({ items: [slack] });
    const renderer = await renderChannelsSection("Slack sandbox");
    await click(findStepButton(renderer.root, "Paste your connection values"));
    let resolve!: (draft: ChannelSetupDraft) => void;
    channelApiMocks.fetchChannelSetupDraft.mockReturnValueOnce(new Promise<ChannelSetupDraft>((yes) => { resolve = yes; }));
    await click(findButton(renderer.root, "Connect Slack with OAuth"));
    await changeValue(renderer.root.findAllByType("input").find((input) => input.props.placeholder === "Slack")!, "Changed during preflight");
    await act(async () => resolve(currentApiDraft));
    await flushWork();
    expect(oauthApiMocks.startStagedSlackOAuth).not.toHaveBeenCalled();
    expect(renderer.root.findAllByType("input").find((input) => input.props.placeholder === "Slack")?.props.value).toBe("Changed during preflight");
    renderer.unmount();
  });

  it("requires exact Slack workspace/app adoption and never selects a global OAuth connection", async () => {
    const slack = { ...discordDefinition, catalog: { ...discordDefinition.catalog, catalogId: "channel.slack", key: "slack", label: "Slack" } };
    const targets = [{ id: "home", label: "Ops", channel: "#ops", default: true }];
    currentApiDraft = { ...discordDraft, draftId: "slack-draft", catalogId: "channel.slack", label: "Slack sandbox", draft: { targets } };
    channelApiMocks.fetchChannelSetupDefinitions.mockResolvedValue({ items: [slack] });
    const attempt = { provider: "slack", workspaceId: "default", draftId: "slack-draft", draftRevision: 1, attemptId: "attempt-exact", revision: 1, status: "pending", expiresAt: "2099-01-01T00:00:00Z", createdAt: "2026-10-08T10:00:00Z", updatedAt: "2026-10-08T10:00:00Z" };
    const install = { installId: "slack:TEXACT:AEXACT", teamId: "TEXACT", teamName: "Reviewed workspace", appId: "AEXACT", botUserId: "BEXACT", scopes: ["chat:write"] };
    oauthApiMocks.startStagedSlackOAuth.mockResolvedValue({ configured: true, mode: "self_owned", scopes: ["chat:write"], missing: [], authorizationUrl: "https://slack.com/oauth/v2/authorize?state=opaque", state: "opaque", attempt });
    oauthApiMocks.fetchChannelOAuthAttempt.mockResolvedValue({ ...attempt, revision: 2, status: "ready", install });
    oauthApiMocks.adoptSlackOAuthInstall.mockImplementation(async () => {
      currentApiDraft = { ...currentApiDraft, revision: 2, draft: { targets, authMode: "oauth", slackTeamId: "TEXACT", slackAppId: "AEXACT" } };
      return { draft: currentApiDraft, attempt: { ...attempt, revision: 3, status: "adopted", install, adoptedDraftRevision: 2 } };
    });
    vi.spyOn(window, "open").mockReturnValue(null);
    const renderer = await renderChannelsSection("Slack sandbox");
    await click(findStepButton(renderer.root, "Paste your connection values"));
    await click(findButton(renderer.root, "Connect Slack with OAuth"));
    await flushWork();
    expect(oauthApiMocks.startStagedSlackOAuth).toHaveBeenCalledWith({ workspaceId: "default", draftId: "slack-draft", expectedRevision: 1 });
    expect(textOf(renderer.root)).toContain("Reviewed workspace");
    expect(textOf(renderer.root)).toContain("AEXACT");
    expect(oauthApiMocks.adoptSlackOAuthInstall).not.toHaveBeenCalled();
    expect(channelApiMocks.fetchSlackOAuthStatus).not.toHaveBeenCalled();
    await click(findButton(renderer.root, "Use this reviewed workspace and app"));
    await flushWork();
    expect(oauthApiMocks.adoptSlackOAuthInstall).toHaveBeenCalledWith({ workspaceId: "default", draftId: "slack-draft", expectedRevision: 1, attemptId: "attempt-exact" });
    expect(renderer.root.findByType(ChannelSetupWizard).props.values).toMatchObject({ targets, authMode: "oauth", slackTeamId: "TEXACT", slackAppId: "AEXACT" });
    expect(channelApiMocks.createChangePlan).not.toHaveBeenCalled();
    renderer.unmount();
  });

  it("does not dispatch Telegram pairing approval after leaving during fresh evidence preflight", async () => {
    const connection = { connectionId: "telegram-connection", revision: "a".repeat(64), catalogId: "channel.telegram", kind: "channel" as const, key: "telegram", label: "Telegram home", enabled: true, status: "connected" as const, config: {}, createdAt: discordDraft.createdAt, updatedAt: discordDraft.updatedAt };
    const snapshot = { connectionId: connection.connectionId, connectionRevision: connection.revision, inboundAccessMode: "allowlist", allowedSenders: [], items: [{ actorId: "actor-exact", status: "pending", code: "paired-code", chatId: "123" }] };
    operationApiMocks.fetchTelegramChannelPairings.mockResolvedValue(snapshot);
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<TelegramPairingPanel connection={connection} />); });
    await flushWork();
    await click(findButton(renderer.root, "Review Telegram approval"));
    expect(operationApiMocks.approveTelegramChannelPairing).not.toHaveBeenCalled();
    let resolve!: (value: typeof connection) => void;
    channelApiMocks.fetchIntegrationConnection.mockReturnValueOnce(new Promise((yes) => { resolve = yes; }));
    await click(findButton(renderer.root, "Apply reviewed Telegram access change"));
    await act(async () => renderer.unmount());
    await act(async () => resolve(connection));
    await flushWork();
    expect(operationApiMocks.approveTelegramChannelPairing).not.toHaveBeenCalled();
  });
});

describe("local channel editing while owner writes are blocked", () => {
  it("retains editable advanced text through a phase-bound stale validation and failed review read, then reviews before saving", async () => {
    currentApiDraft = { ...discordDraft, connectionId: "connection-fixture", connectionRevision: "a".repeat(64) };
    const connection = { connectionId: "connection-fixture", revision: "a".repeat(64), catalogId: "channel.discord", kind: "channel", key: "discord", label: "Base connection", enabled: true, status: "connected", config: {}, createdAt: discordDraft.createdAt, updatedAt: discordDraft.updatedAt };
    channelApiMocks.fetchIntegrationConnections.mockResolvedValue({ items: [connection] });
    channelApiMocks.fetchIntegrationConnection.mockRejectedValueOnce(new Error("Read unavailable")).mockResolvedValue({ ...connection, revision: "b".repeat(64), label: "Peer connection" });
    channelApiMocks.isApiRequestError.mockReturnValue(true);
    channelApiMocks.validateChannelSetupDraft.mockRejectedValueOnce(new ApiRequestError("Review required", { kind: "http", method: "POST", path: "/fixture/validate", status: 409, body: { code: "WRITE_CONFLICT", details: { reason: "CHANNEL_CONNECTION_REVIEW_REQUIRED", mutationPhase: "before_side_effects", draftId: discordDraft.draftId, draftRevision: 2, connectionId: connection.connectionId } } }));
    channelApiMocks.reviewChannelSetupConnection.mockImplementation(async (_id, input) => {
      currentApiDraft = { ...currentApiDraft, revision: currentApiDraft.revision + 1, connectionRevision: input.expectedConnectionRevision }; return currentApiDraft;
    });
    const renderer = await renderChannelsSection();
    await click(findButton(renderer.root, "Advanced JSON"));
    await changeValue(renderer.root.findByType("textarea"), JSON.stringify({ ...discordDraft.draft, defaultChannelId: "initial-edit" }));
    await click(findButton(renderer.root, "Validate"));
    await flushWork();
    expect(textOf(renderer.root)).toContain("Current settings could not be loaded");
    expect(textOf(renderer.root)).not.toContain("Outcome uncertain");
    expect(renderer.root.findByType("textarea").props.disabled).toBe(false);
    await changeValue(renderer.root.findByType("textarea"), JSON.stringify({ ...discordDraft.draft, defaultChannelId: "edit-after-review-read-failed" }));
    expect(findButton(renderer.root, "Save draft").props.disabled).toBe(true);
    expect(findButton(renderer.root, "Run live test").props.disabled).toBe(true);
    await click(findButton(renderer.root, "Reload connection review"));
    expect(channelApiMocks.reviewChannelSetupConnection).not.toHaveBeenCalled();
    await click(findButton(renderer.root, "Use current connection review"));
    expect(renderer.root.findByType("textarea").props.value).toContain("edit-after-review-read-failed");
    expect(channelApiMocks.testChannelSetupDraft).not.toHaveBeenCalled();
    await click(findButton(renderer.root, "Save draft"));
    expect(channelApiMocks.updateChannelSetupDraft).toHaveBeenLastCalledWith(discordDraft.draftId, expect.objectContaining({ expectedRevision: 3, draft: expect.objectContaining({ defaultChannelId: "edit-after-review-read-failed" }) }));
    renderer.unmount();
  });

  // Only the Classic wizard offers Advanced JSON; the cockpit editor accepts typed fields only so credentials
  // always travel through the secure-input owner (allowAdvancedInput: false).
  for (const Component of [ChannelSetupWizard]) {
    it("keeps advanced text editable while review/unknown outcomes block writes in " + Component.name, async () => {
      const props = createWizardProps({ reviewRequired: true, mutationBlocked: true });
      let renderer!: ReactTestRenderer;
      await act(async () => { renderer = create(<Component {...props} />); });
      await click(findButton(renderer.root, "Advanced JSON"));
      expect(renderer.root.findByType("textarea").props.disabled).toBe(false);
      await changeValue(renderer.root.findByType("textarea"), '{"retained":"editable"}');
      expect(renderer.root.findByType("textarea").props.value).toBe('{"retained":"editable"}');
      expect(findButton(renderer.root, "Save draft").props.disabled).toBe(true);
      expect(findButton(renderer.root, "Run live test").props.disabled).toBe(true);
      await click(findButton(renderer.root, "Save draft"));
      expect(props.onSave).not.toHaveBeenCalled();
      renderer.unmount();
    });
  }
  it("recognizes only explicitly before-side-effects connection review conflicts for the exact owner", () => {
    channelApiMocks.isApiRequestError.mockReturnValue(true);
    const details = { reason: "CHANNEL_CONNECTION_REVIEW_REQUIRED", mutationPhase: "before_side_effects", draftId: "draft-exact", draftRevision: 7, connectionId: "connection-exact" };
    const error = (changes = {}, markers = {}) => new ApiRequestError("Review required", { kind: "http", method: "POST", path: "/api/v1/channels/drafts/draft-exact/validate", status: 409, body: { code: "WRITE_CONFLICT", details: { ...details, ...changes }, ...markers } });
    expect(isChannelPrecommitConflict(error(), "draft-exact", "connection-exact", 7)).toBe(true);
    expect(isChannelPrecommitConflict(error({ mutationPhase: undefined }), "draft-exact", "connection-exact", 7)).toBe(false);
    expect(isChannelPrecommitConflict(error({ mutationPhase: "after_side_effects" }), "draft-exact", "connection-exact", 7)).toBe(false);
    expect(isChannelPrecommitConflict(error(), "draft-exact", "foreign", 7)).toBe(false);
    expect(isChannelPrecommitConflict(error(), "draft-exact", "connection-exact", 8)).toBe(false);
    expect(isChannelPrecommitConflict(error(), "foreign", "connection-exact", 7)).toBe(false);
    expect(isChannelPrecommitConflict(error({}, { mutationCommitted: true }), "draft-exact", "connection-exact", 7)).toBe(false);
    expect(isChannelPrecommitConflict(error({ committed: true }), "draft-exact", "connection-exact", 7)).toBe(false);
  });
});
