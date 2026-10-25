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
};
