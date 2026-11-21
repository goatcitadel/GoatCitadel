import {
  SHIPPED_FEATURE_FLAGS,
  type SHIPPED_FEATURE_SWITCHABILITY,
  type ShippedFeatureFlag,
} from "./shipped-feature-flags.js";
export { SHIPPED_FEATURE_FLAGS, isShippedFeatureFlag, type ShippedFeatureFlag } from "./shipped-feature-flags.js";

type FeatureControl = {
  label: string;
  description: string;
  usedIn: string;
  slug: string;
  legacyDefaultCouldBeOff?: boolean;
  setup?: { label: string; href: string };
};
type FeatureControls = {
  [Flag in ShippedFeatureFlag]: FeatureControl & { switchable: (typeof SHIPPED_FEATURE_SWITCHABILITY)[Flag] };
};

/** Availability defaults. Each runtime owner still checks configuration, grants and approvals. */
export const SHIPPED_FEATURE_CONTROLS = {
  memoryLifecycleAdminV1Enabled: {
    legacyDefaultCouldBeOff: true,
    setup: { label: "Open memory", href: "/library/memory" },
    label: "Memory administration",
    description: "When on, Library › Memory lists what GoatCitadel remembers and lets you edit, forget and review it.",
    usedIn: "Library › Memory",
    slug: "memory-administration",
    switchable: true,
  },
  memoryCorpusRecallV1Enabled: {
    legacyDefaultCouldBeOff: true,
    setup: { label: "Open memory", href: "/library/memory" },
    label: "Memory library search",
    description:
      "When on, Chat and memory tools can find older saved facts and approved lessons while respecting conversation and workspace access.",
    usedIn: "Chat and memory tools",
    slug: "indexed-memory-recall",
    switchable: true,
  },
  backgroundSkillDraftsV1Enabled: {
    legacyDefaultCouldBeOff: true,
    setup: { label: "Review skills", href: "/capabilities/skills" },
    label: "Background skill drafts",
    description:
      "When on, successful private conversations may produce inactive skill drafts for your review. Evaluation and activation remain separate decisions.",
    usedIn: "Chat and Capabilities › Skills",
    slug: "background-skill-drafts",
    switchable: true,
  },
  memoryMaintenanceV1Enabled: {
    legacyDefaultCouldBeOff: true,
    setup: { label: "Open memory", href: "/library/memory" },
    label: "Memory maintenance",
    description:
      "When on, Library › Memory can run maintenance passes that tidy saved memory. You review each pass before it runs.",
    usedIn: "Library › Memory",
    slug: "memory-maintenance",
    switchable: true,
  },
  chatSkillInstructionsV1Enabled: {
    legacyDefaultCouldBeOff: true,
    setup: { label: "Manage skills", href: "/capabilities/skills" },
    label: "Skills in Chat",
    description:
      "When on, Chat loads the skills that are on, and any skill you name, into its turns. When off, Chat uses no skills.",
    usedIn: "Chat, and Capabilities › Skills",
    slug: "skills-in-chat",
    switchable: true,
  },
  chatStaticMcpV1Enabled: {
    legacyDefaultCouldBeOff: true,
    setup: { label: "Set up MCP servers", href: "/capabilities/connectors/advanced#mcp-servers" },
    label: "Connectors in Chat",
    description:
      "When on, Chat can use the MCP servers you added. Every call still follows your tool rules and approvals.",
    usedIn: "Chat, and Capabilities › Connectors",
    slug: "connectors-in-chat",
    switchable: true,
  },
  connectorDiagnosticsV1Enabled: {
    legacyDefaultCouldBeOff: true,
    setup: { label: "Open connectors", href: "/capabilities/connectors" },
    label: "Connector diagnostics",
    description:
      "When on, you can run health checks on MCP servers and integrations. A check may contact the service; it sends no messages.",
    usedIn: "Capabilities › Connectors › Advanced setup",
    slug: "connector-diagnostics",
    switchable: true,
  },
  cronReviewQueueV1Enabled: {
    legacyDefaultCouldBeOff: true,
    setup: { label: "Open schedules", href: "/work/schedules" },
    label: "Scheduler review",
    description: "When on, Work › Schedules lists scheduled runs that are waiting for your review.",
    usedIn: "Work › Schedules",
    slug: "scheduler-review",
    switchable: true,
  },
  engineeringLearningsV1Enabled: {
    legacyDefaultCouldBeOff: true,
    label: "Engineering learnings",
    description: "When on, Library › Knowledge lets you turn verified work into engineering learnings.",
    usedIn: "Library › Knowledge",
    slug: "engineering-learnings",
    switchable: true,
  },
  chatProviderFallbackV1Enabled: {
    legacyDefaultCouldBeOff: true,
    label: "Provider fallback in Chat",
    description: "When on, a conversation can name one backup provider to answer when the first one fails to respond.",
    usedIn: "Each conversation's settings in Chat",
    slug: "provider-fallback",
    switchable: true,
  },
  chatDelegationControlsV1Enabled: {
    legacyDefaultCouldBeOff: true,
    label: "Subagents in Chat",
    description:
      "When on, Chat can propose a plan that starts supervised subagents. You review each plan before it starts.",
    usedIn: "Each conversation's settings in Chat",
    slug: "subagents-in-chat",
    switchable: true,
  },
  utilityModelRoutingV1Enabled: {
    legacyDefaultCouldBeOff: true,
    setup: { label: "Set up a utility model", href: "/settings/models" },
    label: "Utility model for background jobs",
    description:
      "When on, background jobs such as follow-up suggestions use the utility model you set in Settings › Models.",
    usedIn: "Background jobs",
    slug: "utility-model",
    switchable: true,
  },
  memoryConsolidationV1Enabled: {
    legacyDefaultCouldBeOff: true,
    setup: { label: "Open memory", href: "/library/memory" },
    label: "Memory consolidation",
    description: "Combines eligible saved memories during governed maintenance.",
    usedIn: "Library › Memory",
    slug: "memory-consolidation",
    switchable: true,
  },
  scheduledChatTurnsV1Enabled: {
    legacyDefaultCouldBeOff: true,
    setup: { label: "Open schedules", href: "/work/schedules" },
    label: "Scheduled Chat turns",
    description: "Lets a schedule start a Chat turn under its approved authority.",
    usedIn: "Work › Schedules",
    slug: "scheduled-chat-turns",
    switchable: true,
  },
  proactiveHeartbeatTurnsV1Enabled: {
    legacyDefaultCouldBeOff: true,
    setup: { label: "Open schedules", href: "/work/schedules" },
    label: "Heartbeat follow-ups",
    description: "Lets an enabled heartbeat check for work in its authorized conversation.",
    usedIn: "Work › Schedules",
    slug: "proactive-heartbeat-turns",
    switchable: true,
  },
  commitmentScheduledTurnsV1Enabled: {
    legacyDefaultCouldBeOff: true,
    label: "Scheduled commitments",
    description: "Lets an approved commitment schedule a follow-up in Chat.",
    usedIn: "Chat",
    slug: "commitment-scheduled-turns",
    switchable: true,
  },
  cronEvidenceV1Enabled: {
    legacyDefaultCouldBeOff: true,
    label: "Schedule evidence",
    description: "Keeps evidence of what happened during scheduled work.",
    usedIn: "Work › Schedules",
    slug: "cron-evidence",
    switchable: true,
  },
  chatContextBudgetVisibilityV1Enabled: {
    legacyDefaultCouldBeOff: true,
    label: "Chat context usage",
    description: "Shows how much of the conversation fits in the model context.",
    usedIn: "Chat",
    slug: "chat-context-budget-visibility",
    switchable: true,
  },
  boundedToolExposureV1Enabled: {
    legacyDefaultCouldBeOff: true,
    label: "Task-specific tool selection",
    description: "Selects a bounded set of eligible tools for a Chat turn.",
    usedIn: "Chat",
    slug: "bounded-tool-exposure",
    switchable: true,
  },
  durableChatFanoutV1Enabled: {
    legacyDefaultCouldBeOff: true,
    label: "Resumable delegation",
    description: "Keeps delegated Chat work in durable runs.",
    usedIn: "Chat",
    slug: "durable-chat-fanout",
    switchable: true,
  },
  chatAutomaticFanoutV1Enabled: {
    legacyDefaultCouldBeOff: true,
    label: "Automatic delegation planning",
    description: "Lets Chat plan delegated work under the conversation’s controls.",
    usedIn: "Chat",
    slug: "chat-automatic-fanout",
    switchable: true,
  },
  channelVoiceReplyV1Enabled: {
    legacyDefaultCouldBeOff: true,
    setup: { label: "Set up messaging", href: "/chat/messaging" },
    label: "Voice replies",
    description: "Makes voice replies available on channels configured for audio.",
    usedIn: "Chat › Messaging",
    slug: "channel-voice-reply",
    switchable: true,
  },
  replayOverridesV1Enabled: {
    legacyDefaultCouldBeOff: true,
    label: "Replay overrides",
    description: "Lets you review alternate inputs for a replay.",
    usedIn: "System",
    slug: "replay-overrides",
    switchable: true,
  },
  replayRegressionV1Enabled: {
    legacyDefaultCouldBeOff: true,
    label: "Replay regression checks",
    description: "Compares replay outcomes to detect changes.",
    usedIn: "System",
    slug: "replay-regression",
    switchable: true,
  },
  promptRetuneCampaignV1Enabled: {
    legacyDefaultCouldBeOff: true,
    label: "Prompt retuning campaigns",
    description: "Makes prompt retuning available where its review workflow is configured.",
    usedIn: "System",
    slug: "prompt-retune-campaign",
    switchable: true,
  },
  structuredReviewV2Enabled: {
    legacyDefaultCouldBeOff: true,
    label: "Structured reviews",
    description: "Makes structured review steps available in supported workflows.",
    usedIn: "Chat",
    slug: "structured-review",
    switchable: true,
  },
  delegationScopeExpansionV1Enabled: {
    legacyDefaultCouldBeOff: true,
    label: "Delegation scope review",
    description: "Allows a delegated task to request a reviewed scope expansion.",
    usedIn: "Chat",
    slug: "delegation-scope-expansion",
    switchable: true,
  },
  memoryLifecycleAutoForgetEnabled: {
    label: "Automatic memory expiry",
    description: "Applies configured retention rules to eligible memories.",
    usedIn: "Library › Memory",
    slug: "memory-lifecycle-auto-forget",
    switchable: true,
  },
  computerUseGuardrailsV1Enabled: {
    label: "Computer-use guardrails",
    description: "Applies additional safeguards to computer-use tasks.",
    usedIn: "Chat",
    slug: "computer-use-guardrails",
    switchable: false,
  },
  chatAsyncClarificationV1Enabled: {
    label: "Chat clarification",
    description: "Lets Chat wait for clarification during a run.",
    usedIn: "Chat",
    slug: "chat-async-clarification",
    switchable: true,
  },
  unifiedComposerPaletteV1Enabled: {
    label: "Chat command palette",
    description: "Shows available actions in the composer.",
    usedIn: "Chat",
    slug: "unified-composer-palette",
    switchable: true,
  },
  attachedContextToolsV1Enabled: {
    label: "Attached context tools",
    description: "Lets Chat inspect context you attach.",
    usedIn: "Chat",
    slug: "attached-context-tools",
    switchable: true,
  },
  chatSessionStatusV1Enabled: {
    label: "Conversation status",
    description: "Shows the status of the current conversation.",
    usedIn: "Chat",
    slug: "chat-session-status",
    switchable: true,
  },
  conversationForksV1Enabled: {
    label: "Conversation forks",
    description: "Lets you continue from a separate branch of a conversation.",
    usedIn: "Chat",
    slug: "conversation-forks",
    switchable: true,
  },
  notificationRoutingV1Enabled: {
    label: "Notification routing",
    description: "Routes notifications using your configured destinations.",
    usedIn: "Settings",
    slug: "notification-routing",
    switchable: true,
  },
  chatTimersV1Enabled: {
    label: "Chat timers",
    description: "Makes timers available in conversations.",
    usedIn: "Chat",
    slug: "chat-timers",
    switchable: true,
  },
  typedRunVariablesV1Enabled: {
    label: "Typed run variables",
    description: "Makes typed variables available in workflows.",
    usedIn: "Chat",
    slug: "typed-run-variables",
    switchable: true,
  },
  documentEditingV1Enabled: {
    label: "Document editing",
    description: "Lets you work on a document in Chat.",
    usedIn: "Chat",
    slug: "document-editing",
    switchable: true,
  },
  channelVoiceInboundV1Enabled: {
    setup: { label: "Set up messaging", href: "/chat/messaging" },
    label: "Incoming voice messages",
    description: "Makes incoming audio available on configured channels.",
    usedIn: "Chat › Messaging",
    slug: "channel-voice-inbound",
    switchable: true,
  },
  chatExplicitContextV1Enabled: {
    label: "Explicit conversation context",
    description: "Lets you select context for a conversation.",
    usedIn: "Chat",
    slug: "chat-explicit-context",
    switchable: true,
  },
  chatExplicitContextBranchesV1Enabled: {
    label: "Context branches",
    description: "Lets you review context branches for a conversation.",
    usedIn: "Chat",
    slug: "chat-explicit-context-branches",
    switchable: true,
  },
  chatWorkspaceSnapshotV1Enabled: {
    label: "Workspace snapshots",
    description: "Makes scoped workspace snapshots available as conversation context.",
    usedIn: "Chat",
    slug: "chat-workspace-snapshot",
    switchable: true,
  },
  chatModelCouncilV1Enabled: {
    label: "Model council",
    description: "Makes model council available in a conversation.",
    usedIn: "Chat",
    slug: "chat-model-council",
    switchable: true,
  },
  chatWorkPassportV1Enabled: {
    label: "Work passports",
    description: "Shows context and authority for a conversation’s work.",
    usedIn: "Chat",
    slug: "chat-work-passport",
    switchable: true,
  },
  evolutionControlPlaneV1Enabled: {
    label: "Change Plans",
    description: "Governs configuration and capability changes through reviewable plans.",
    usedIn: "Settings",
    slug: "evolution-control-plane",
    switchable: false,
  },
  improvementLocalObservationV1Enabled: {
    label: "Local improvement observations",
    description: "Records eligible local observations for review.",
    usedIn: "System",
    slug: "improvement-local-observation",
    switchable: true,
  },
  chatThinkingStreamV1Enabled: {
    legacyDefaultCouldBeOff: true,
    label: "Model reasoning in Chat",
    description:
      "When on, models that report their reasoning stream it into Chat above the answer. While the model thinks, its newest line shows beside the label; the full text stays shut unless you open it.",
    usedIn: "Chat",
    slug: "chat-thinking-stream",
    switchable: true,
  },
  codeModeV1Enabled: {
    legacyDefaultCouldBeOff: true,
    label: "Code Mode",
    description:
      "When on, Chat can ask to run code on this computer for a step no tool can do. Every run still needs your approval.",
    usedIn: "Chat",
    slug: "code-mode",
    switchable: true,
  },
  codeModeHostSandboxEnabled: {
    legacyDefaultCouldBeOff: true,
    label: "Code Mode restricted sandbox",
    description:
      "When on, approved Code Mode runs execute on this computer in a restricted sandbox. When off, runs are refused.",
    usedIn: "Chat",
    slug: "code-mode-host-sandbox",
    switchable: true,
  },
  browserErrandsEnabled: {
    legacyDefaultCouldBeOff: true,
    setup: { label: "Set up browser errands", href: "/settings/tools#browser-errands" },
    label: "Browser errands",
    description:
      "Browser errands let GoatCitadel use its own Chrome window on this PC, with your saved logins, to do tasks you ask for. It asks before spending money, sending, deleting, or changing account settings, and hands sign-ins to you. Reading and browsing don't ask, so a hostile page could try to steer it into carrying your information to another site. Sites may notice an automated browser and limit your account.",
    usedIn: "Chat",
    slug: "browser-errands",
    switchable: true,
  },
  claudeCliToolBridgeEnabled: {
    label: "Claude Code CLI: let it use GoatCitadel tools",
    description: "When on, Chat turns on the Claude Code CLI provider can ask for GoatCitadel tools.",
    usedIn: "Chat",
    slug: "claude-cli-tool-bridge",
    switchable: true,
  },
  claudeCliWarmContinuationEnabled: {
    label: "Claude Code CLI: reuse one process between tool steps",
    description:
      "When a tool step continues the previous one exactly, keeps that turn's Claude Code process running instead of starting a new one.",
    usedIn: "Chat",
    slug: "claude-cli-warm-continuation",
    switchable: true,
  },
} as const satisfies FeatureControls;

/** Earlier releases or their installer templates could supply false without an operator decision. */
export const LEGACY_FALSE_FEATURE_FLAGS: ReadonlySet<ShippedFeatureFlag> = new Set(
  SHIPPED_FEATURE_FLAGS.filter((flag) => "legacyDefaultCouldBeOff" in SHIPPED_FEATURE_CONTROLS[flag]),
);

export interface FeaturePreferenceMetadata {
  sources: Partial<Record<ShippedFeatureFlag, "default" | "profile" | "environment" | "operator" | "legacy">>;
  upgradeReview: ShippedFeatureFlag[];
  upgradeFingerprint: string;
}

export interface FeaturePreferenceReview {
  fingerprint: string;
  flags: ShippedFeatureFlag[];
  decision: "inherit" | "off";
}
