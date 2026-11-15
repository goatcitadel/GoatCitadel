import type { ChangePlanRuntimeFeatureFlag } from "./change-plan.js";

/**
 * Plain-language names for the flags an operator switches from Settings, shared by the Settings controls and the
 * change plan, approval and completion text, so none of them shows the raw key (#496). A flag without an entry keeps
 * its key.
 */
export const CHANGE_PLAN_RUNTIME_FEATURE_FLAG_LABELS: Partial<
  Record<ChangePlanRuntimeFeatureFlag, { readonly label: string; readonly description: string }>
> = {
  claudeCliToolBridgeEnabled: {
    label: "Claude Code CLI: let it use GoatCitadel tools",
    description: "When on, Chat turns on the Claude Code CLI provider can ask for GoatCitadel tools.",
  },
  claudeCliWarmContinuationEnabled: {
    label: "Claude Code CLI: reuse one process between tool steps",
    description:
      "When a tool step continues the previous one exactly, keeps that turn's Claude Code process running instead of starting a new one.",
  },
  browserErrandsEnabled: {
    label: "Browser errands",
    description:
      "Browser errands let GoatCitadel use its own Chrome window on this PC, with your saved logins, to do tasks you ask for. It asks before spending money, sending, deleting, or changing account settings, and hands sign-ins to you. Reading and browsing don't ask, so a hostile page could try to steer it into carrying your information to another site. Sites may notice an automated browser and limit your account.",
  },
  codeModeV1Enabled: {
    label: "Code Mode",
    description:
      "When on, Chat can ask to run code on this computer for a step no tool can do. Every run still needs your approval.",
  },
  codeModeHostSandboxEnabled: {
    label: "Code Mode restricted sandbox",
    description:
      "When on, approved Code Mode runs execute on this computer in a restricted sandbox. When off, runs are refused.",
  },
  chatThinkingStreamV1Enabled: {
    label: "Model reasoning in Chat",
    description:
      "When on, models that report their reasoning stream it into Chat above the answer. While the model thinks, its newest line shows beside the label; the full text stays shut unless you open it.",
  },
  memoryLifecycleAdminV1Enabled: {
    label: "Memory administration",
    description: "When on, Library › Memory lists what GoatCitadel remembers and lets you edit, forget and review it.",
  },
  memoryMaintenanceV1Enabled: {
    label: "Memory maintenance",
    description:
      "When on, Library › Memory can run maintenance passes that tidy saved memory. You review each pass before it runs.",
  },
  chatSkillInstructionsV1Enabled: {
    label: "Skills in Chat",
    description:
      "When on, Chat loads the skills that are on, and any skill you name, into its turns. When off, Chat uses no skills.",
  },
  chatStaticMcpV1Enabled: {
    label: "Connectors in Chat",
    description:
      "When on, Chat can use the MCP servers you added. Every call still follows your tool rules and approvals.",
  },
  connectorDiagnosticsV1Enabled: {
    label: "Connector diagnostics",
    description:
      "When on, you can run health checks on MCP servers and integrations. A check may contact the service; it sends no messages.",
  },
  cronReviewQueueV1Enabled: {
    label: "Scheduler review",
    description: "When on, Work › Schedules lists scheduled runs that are waiting for your review.",
  },
  engineeringLearningsV1Enabled: {
    label: "Engineering learnings",
    description: "When on, Library › Knowledge lets you turn verified work into engineering learnings.",
  },
  chatProviderFallbackV1Enabled: {
    label: "Provider fallback in Chat",
    description: "When on, a conversation can name one backup provider to answer when the first one fails to respond.",
  },
  chatDelegationControlsV1Enabled: {
    label: "Subagents in Chat",
    description:
      "When on, Chat can propose a plan that starts supervised subagents. You review each plan before it starts.",
  },
  utilityModelRoutingV1Enabled: {
    label: "Utility model for background jobs",
    description:
      "When on, background jobs such as follow-up suggestions use the utility model you set in Settings › Models.",
  },
  settingsApprovalSkipEnabled: {
    label: "Apply my Settings and Capabilities changes without asking first",
    description:
      "When on, a change you save through the Settings forms, a connector you install from Capabilities, or a skill you switch on from Capabilities applies right away instead of waiting for your approval, and a skill you install from Capabilities installs and switches on without asking. Credential changes and change requests from Chat still need approval. Turning a skill off, or pausing one that is on, from Capabilities applies right away even when this is off.",
  },
};
