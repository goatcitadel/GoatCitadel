import { getChatModePreset } from "@goatcitadel/contracts";
import type { ModeOrchestrationPolicy } from "../types.js";

const preset = getChatModePreset("cowork");

export const COWORK_MODE_POLICY: ModeOrchestrationPolicy = {
  mode: "cowork",
  maxVisibleVisibility: "explicit",
  defaultVisibility: preset.defaultPrefs.orchestrationVisibility ?? "expandable",
  defaultIntensity: preset.defaultPrefs.orchestrationIntensity ?? "balanced",
  maxSteps: 7,
  maxParallelAgents: 3,
  allowHiddenOrchestration: false,
  allowParallelWorkers: true,
  defaultCodeAutoApply: preset.defaultPrefs.codeAutoApply ?? "manual",
};
