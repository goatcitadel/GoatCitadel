import { getChatModePreset } from "@goatcitadel/contracts";
import type { ModeOrchestrationPolicy } from "../types.js";

const preset = getChatModePreset("chat");

export const CHAT_MODE_POLICY: ModeOrchestrationPolicy = {
  mode: "chat",
  maxVisibleVisibility: "explicit",
  defaultVisibility: preset.defaultPrefs.orchestrationVisibility ?? "summarized",
  defaultIntensity: preset.defaultPrefs.orchestrationIntensity ?? "minimal",
  maxSteps: 7,
  maxParallelAgents: 3,
  allowHiddenOrchestration: true,
  allowParallelWorkers: true,
  defaultCodeAutoApply: preset.defaultPrefs.codeAutoApply ?? "manual",
};
