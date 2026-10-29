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
  chatThinkingStreamV1Enabled: {
    label: "Model reasoning in Chat",
    description:
      "When on, models that report their reasoning stream it into Chat, shown above the answer and kept shut unless you open it.",
  },
  settingsApprovalSkipEnabled: {
    label: "Apply my Settings and Capabilities changes without an Inbox approval",
    description:
      "When on, a change you save through the Settings forms, or a connector you install from Capabilities, applies right away instead of waiting for an approval in the Inbox. Credential changes and change requests from Chat still need approval.",
  },
};
