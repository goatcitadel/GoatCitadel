import type { OnboardingState } from "@goatcitadel/contracts";
import type { AppRoute } from "@next/app/route-model";
import type { SettingsWizardStepState } from "../SettingsShared";
import { isLikelyLocalProviderBaseUrl } from "./provider-format";

export function deriveSetupCenterItems(onboarding: OnboardingState): Array<{
  label: string;
  description: string;
  state: SettingsWizardStepState;
}> {
  const checklistById = new Map((onboarding.checklist ?? []).map((item) => [item.id, item]));
  const providersWithKeys = (onboarding.settings?.llm?.providers ?? []).filter((provider) => provider.hasApiKey).length;
  const authMode = onboarding.settings?.auth?.mode ?? "none";
  return [
    {
      label: "Provider smoke",
      description:
        providersWithKeys > 0
          ? `${providersWithKeys} provider credential source available. Active model: ${
              onboarding.settings?.llm?.activeModel || "unset"
            }.`
          : "No provider credentials required for demo/local paths; add one before cloud sends.",
      state: wizardStateForChecklist(checklistById.get("llm")?.status),
    },
    {
      label: "Local runtime",
      description: checklistById.get("runtime")?.detail ?? "Gateway and bundled runtime health are checked locally.",
      state: wizardStateForChecklist(checklistById.get("runtime")?.status),
    },
    {
      label: "Access and auth",
      description:
        authMode === "none"
          ? "Local access is open; add gateway auth before exposing the app."
          : `${authMode} gateway auth configured.`,
      state: wizardStateForChecklist(checklistById.get("auth")?.status),
    },
    {
      label: "Channels and MCP",
      description: "Optional connectors stay off until explicitly configured and checked.",
      state: "pending",
    },
    {
      label: "Share readiness",
      description: "Unsigned builds need checksums, install checks, screenshots, and notes before sharing.",
      state: "pending",
    },
  ];
}

type OnboardingProviderSmokeEvidenceItem = {
  id: string;
  label: string;
  description: string;
  state: SettingsWizardStepState;
  meta: string;
};

type EcosystemProofLaneItem = {
  id: string;
  label: string;
  description: string;
  meta: string;
  actionLabel: string;
  route: AppRoute;
};

export function deriveEcosystemProofLaneItems(): EcosystemProofLaneItem[] {
  return [
    {
      id: "voice",
      label: "Voice Wake / Talk Mode",
      description:
        "Select/install a local voice runtime and keep wake/talk proof before claiming voice parity beyond local runtime support.",
      meta: "First follow-on lane",
      actionLabel: "Runtime",
      route: { area: "settings", section: "runtime" },
    },
    {
      id: "browser-control",
      label: "Browser control",
      description:
        "Use governed tools/MCP visibility for browser control. Remote browser automation claims need fresh proof.",
      meta: "Tool-governed",
      actionLabel: "MCP",
      route: { area: "settings", section: "mcp" },
    },
    {
      id: "extension-sdk",
      label: "Extension / plugin SDK breadth",
      description:
        "Keep extension claims aligned with installed plugin trust metadata, diagnostics, and @goatcitadel/extensions-sdk evidence.",
      meta: "Catalog-gated",
      actionLabel: "Integrations",
      route: { area: "settings", section: "integrations" },
    },
    {
      id: "packaging-remote",
      label: "Packaging and remote deployment parity",
      description:
        "Windows packaging is the shipped lane; remote, macOS, and Linux claims stay blocked until their named packaging proof passes.",
      meta: "Proof-lane required",
      actionLabel: "Ops",
      route: { area: "ops", section: "diagnostics" },
    },
    {
      id: "mobile-companion",
      label: "Mobile companion/device surfaces",
      description:
        "Use signed device grants and companion-session auth; mobile companion surfaces are not an ungoverned backend shortcut.",
      meta: "Access-gated",
      actionLabel: "Access",
      route: { area: "settings", section: "access" },
    },
    {
      id: "canvas-a2ui",
      label: "Canvas / A2UI parity",
      description:
        "Canvas/A2UI parity needs Mission Control proof and companion runtime evidence before platform-level claims are visible.",
      meta: "Last follow-on lane",
      actionLabel: "Capabilities",
      route: { area: "library", section: "capabilities" },
    },
  ];
}

export function deriveOnboardingProviderSmokeEvidenceItems(
  onboarding: OnboardingState,
): OnboardingProviderSmokeEvidenceItem[] {
  const llmSettings = onboarding.settings?.llm;
  const activeProvider = (llmSettings?.providers ?? []).find(
    (provider) => provider.providerId === llmSettings?.activeProviderId,
  );
  const activeProviderLabel = activeProvider?.label ?? ((llmSettings?.activeProviderId ?? "").trim() || "No provider");
  const activeModel = (llmSettings?.activeModel ?? "").trim();
  const providerCredentialReady = Boolean(
    activeProvider && (activeProvider.hasApiKey || isLikelyLocalProviderBaseUrl(activeProvider.baseUrl)),
  );
  const smokeReady = Boolean(activeProvider && activeModel && providerCredentialReady);

  return [
    {
      id: "configured",
      label: "Provider configured",
      description: providerCredentialReady
        ? `${activeProviderLabel} has a credential source or reachable local endpoint configured.`
        : describeProviderReadinessFailure(onboarding),
      state: providerCredentialReady ? "complete" : "active",
      meta: providerCredentialReady ? "Configured" : "Needs setup",
    },
    {
      id: "smoke-ready",
      label: "Smoke ready",
      description: smokeReady
        ? `${activeProviderLabel} can be smoke-checked with selected model ${activeModel}.`
        : "Choose a provider, model, and credential or local endpoint before running provider smoke.",
      state: smokeReady ? "complete" : providerCredentialReady ? "active" : "pending",
      meta: smokeReady ? "Ready to run" : "Blocked",
    },
    {
      id: "passed-evidence",
      label: "Passed with evidence",
      description: smokeReady
        ? "No live provider smoke evidence is implied here; run the live install lane with real credentials to record pass/fail proof."
        : "Live provider proof is blocked until the provider is configured and smoke-ready.",
      state: smokeReady ? "active" : "pending",
      meta: "GOATCITADEL_VERIFY_INSTALL_LIVE_PROVIDER=1",
    },
  ];
}

export function describeProviderReadinessFailure(onboarding: OnboardingState): string {
  const llmSettings = onboarding.settings?.llm;
  const activeProviderId = (llmSettings?.activeProviderId ?? "").trim();
  const activeModel = (llmSettings?.activeModel ?? "").trim();
  if (!activeProviderId) {
    return "Choose an active provider before sending cloud-backed work.";
  }
  const activeProvider = (llmSettings?.providers ?? []).find((provider) => provider.providerId === activeProviderId);
  if (!activeProvider) {
    return `Provider ${activeProviderId} is selected but is not present in the provider catalog.`;
  }
  if (!activeModel) {
    return `Provider ${activeProvider.label} is selected, but no model is active.`;
  }
  if (!activeProvider.hasApiKey && !isLikelyLocalProviderBaseUrl(activeProvider.baseUrl)) {
    return `Provider ${activeProvider.label} needs an API key or a reachable local endpoint before smoke checks can run.`;
  }
  return `Provider ${activeProvider.label} needs a model smoke check before release claims.`;
}

export function wizardStateForChecklist(
  status?: OnboardingState["checklist"][number]["status"],
): SettingsWizardStepState {
  if (status === "complete") {
    return "complete";
  }
  return status === "needs_input" ? "active" : "pending";
}

export function setupMeta(status?: OnboardingState["checklist"][number]["status"]): string {
  if (status === "complete") {
    return "Pass";
  }
  if (status === "needs_input") {
    return "Needs repair";
  }
  return "Optional";
}
