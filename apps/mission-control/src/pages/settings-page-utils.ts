import type { VoiceRuntimeStatus, VoiceStatus } from "@goatcitadel/contracts";

export function describeVoiceState(state?: VoiceStatus["stt"]["state"]): string {
  if (state === "running") {
    return "Runtime is currently active.";
  }
  if (state === "error") {
    return "Runtime hit an error and needs attention.";
  }
  if (state === "stopped") {
    return "Runtime is idle.";
  }
  return "State unknown.";
}

export function describeVoiceRuntimeReadiness(readiness?: VoiceRuntimeStatus["readiness"]): string {
  if (readiness === "ready") {
    return "Ready";
  }
  if (readiness === "broken") {
    return "Installed but incomplete";
  }
  if (readiness === "missing") {
    return "Missing";
  }
  return "Unknown";
}

export function formatVoiceLanguageScope(scope: VoiceRuntimeStatus["catalog"][number]["languageScope"]): string {
  return scope === "english" ? "English" : "Multilingual";
}

export function formatTalkModeLabel(mode?: VoiceStatus["talk"]["mode"]): string {
  if (mode === "push_to_talk") {
    return "Push to talk";
  }
  if (mode === "wake") {
    return "Wake triggered";
  }
  return "Not set";
}

export function formatVoiceDate(value?: string): string {
  if (!value) {
    return "-";
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return value;
  }
  return new Date(parsed).toLocaleString();
}

export function formatDeploymentProfileLabel(value: "local_dev" | "trusted_local" | "remote_hardened"): string {
  if (value === "trusted_local") {
    return "trusted_local";
  }
  if (value === "remote_hardened") {
    return "remote_hardened";
  }
  return "local_dev";
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("Unable to read audio file."));
        return;
      }
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(new Error("Unable to read audio file."));
    reader.readAsDataURL(file);
  });
}
