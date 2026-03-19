import { getChatModePreset } from "@goatcitadel/contracts";
import type { ModeOrchestrationPolicy } from "../types.js";

const preset = getChatModePreset("code");

export const CODE_MODE_POLICY: ModeOrchestrationPolicy = {
  mode: "code",
  maxVisibleVisibility: "explicit",
  defaultVisibility: preset.defaultPrefs.orchestrationVisibility ?? "expandable",
  defaultIntensity: preset.defaultPrefs.orchestrationIntensity ?? "balanced",
  maxSteps: 5,
  maxParallelAgents: 2,
  allowHiddenOrchestration: false,
  allowParallelWorkers: true,
  defaultCodeAutoApply: preset.defaultPrefs.codeAutoApply ?? "manual",
};
