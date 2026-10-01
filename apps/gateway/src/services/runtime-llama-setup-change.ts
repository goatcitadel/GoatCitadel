import {
  SemanticValidationError,
  type ChangePlanRecord,
  type ChangePlanRuntimeConfigurationRequest,
  type LlamaCppRuntimeStatus,
  type LlmModelPreviewResponse,
} from "@goatcitadel/contracts";
import type { RuntimeSettings } from "./gateway/runtime-settings.js";
import type { LlamaCppSetupSelection } from "./llama-cpp-setup-selection-service.js";
import type { EvolutionControlPlaneAdapterOutcome } from "./evolution-control-plane-adapter.js";
import type { UpdateSettingsInput } from "./settings-auth-service.js";

interface LlamaSetupDependencies {
  readonly updateSettings: (input: UpdateSettingsInput) => Promise<RuntimeSettings>;
  readonly previewLlamaModels?: (baseUrl: string) => Promise<LlmModelPreviewResponse>;
  readonly resolveManagedSelection?: (selectionId: string, workspaceId: string) => Promise<LlamaCppSetupSelection>;
  readonly discardManagedSelection?: (selectionId: string) => void;
  readonly refreshLlamaRuntime?: () => Promise<LlamaCppRuntimeStatus>;
}
type LlamaSetupChange = Extract<ChangePlanRuntimeConfigurationRequest["change"], { operation: "llama_cpp_setup" }>;

/** Selection custody, live model checks and the ordered runtime/Chat setting writes. */
export async function validateLlamaSetup(
  deps: LlamaSetupDependencies,
  change: LlamaSetupChange,
  workspaceId: string,
): Promise<void> {
  if (change.managementMode === "managed") {
    if (!change.selectionId || !deps.resolveManagedSelection)
      throw new SemanticValidationError("A managed GGUF selection is required.");
    const selected = await deps.resolveManagedSelection(change.selectionId, workspaceId);
    if (selected.alias !== change.model) throw new SemanticValidationError("The selected GGUF and Chat model differ.");
  } else {
    await requireLiveLlamaModel(deps, change.baseUrl, change.model);
  }
}

export function discardLlamaSetup(deps: LlamaSetupDependencies, plan: ChangePlanRecord): void {
  if (
    plan.request.kind === "runtime_configuration" &&
    plan.request.change.operation === "llama_cpp_setup" &&
    plan.request.change.selectionId
  ) {
    deps.discardManagedSelection?.(plan.request.change.selectionId);
  }
}

async function requireLiveLlamaModel(deps: LlamaSetupDependencies, baseUrl: string, model: string): Promise<void> {
  if (!deps.previewLlamaModels) throw new SemanticValidationError("The llama.cpp catalog owner is unavailable.");
  const catalog = await deps.previewLlamaModels(baseUrl);
  if (
    catalog.source !== "live" ||
    catalog.catalogStatus === "stale" ||
    !catalog.items.some((item) => item.id === model)
  ) {
    throw new SemanticValidationError(
      `The llama.cpp server did not freshly advertise ${model}. Check the URL and model, then retry.`,
    );
  }
}

export async function applyLlamaSetup(
  deps: LlamaSetupDependencies,
  plan: ChangePlanRecord,
  current: RuntimeSettings,
): Promise<EvolutionControlPlaneAdapterOutcome> {
  if (plan.request.kind !== "runtime_configuration" || plan.request.change.operation !== "llama_cpp_setup") {
    throw new SemanticValidationError("Llama setup intent drifted.");
  }
  const change = plan.request.change;
  let selection: LlamaCppSetupSelection | undefined;
  if (change.managementMode === "managed") {
    if (!change.selectionId || !deps.resolveManagedSelection)
      throw new SemanticValidationError("The managed selection is unavailable.");
    selection = await deps.resolveManagedSelection(change.selectionId, plan.origin.workspaceId);
    if (selection.alias !== change.model) throw new SemanticValidationError("The selected GGUF and Chat model differ.");
  } else {
    await requireLiveLlamaModel(deps, change.baseUrl, change.model);
  }
  const runtimeSettings = await deps.updateSettings({
    expectedRevision: current.revision,
    llamaCpp: {
      enabled: true,
      managementMode: change.managementMode,
      autoStart: change.managementMode === "managed" ? (change.autoStart ?? true) : false,
      baseUrl: change.baseUrl,
      alias: change.model,
      ...(selection ? { command: selection.command, modelPath: selection.modelPath } : {}),
    },
  });
  const status = await deps.refreshLlamaRuntime?.();
  if (!status?.healthy || (change.managementMode === "managed" && status.leaseDiagnostics?.ownership !== "owned")) {
    throw new SemanticValidationError(
      "llama.cpp runtime verification failed. The previous Chat default was retained; check the server and retry setup.",
    );
  }
  await requireLiveLlamaModel(deps, change.baseUrl, change.model);
  const routed = await deps.updateSettings({
    expectedRevision: runtimeSettings.revision,
    llm: { activeProviderId: "llamacpp", activeModel: change.model, defaultThinkingLevel: "off" },
  });
  if (change.selectionId) deps.discardManagedSelection?.(change.selectionId);
  return {
    status: "verifying",
    evidenceRefs: [`runtime_settings:revision:${routed.revision}`],
    result: { summary: `llama.cpp ${change.model} is selected for Chat.`, appliedRevision: routed.revision },
  };
}

export function matchesLlamaSetup(change: LlamaSetupChange, settings: RuntimeSettings): boolean {
  return (
    settings.llamaCpp.managementMode === change.managementMode &&
    settings.llamaCpp.baseUrl === change.baseUrl &&
    settings.llm.activeProviderId === "llamacpp" &&
    settings.llm.activeModel === change.model &&
    settings.llm.defaultThinkingLevel === "off"
  );
}

export function llamaSetupMismatchReason(
  change: Extract<ChangePlanRuntimeConfigurationRequest["change"], { operation: "llama_cpp_setup" }>,
  settings: RuntimeSettings,
): string {
  const differences = [
    settings.llamaCpp.managementMode !== change.managementMode ? "server ownership" : undefined,
    settings.llamaCpp.baseUrl !== change.baseUrl ? "server URL" : undefined,
    settings.llm.activeProviderId !== "llamacpp" ? "Chat provider" : undefined,
    settings.llm.activeModel !== change.model ? "Chat model" : undefined,
    settings.llm.defaultThinkingLevel !== "off" ? "thinking effort" : undefined,
  ].filter(Boolean);
  return `The approved llama.cpp setup differs from current settings (${differences.join(", ")}). Review the current settings and retry setup.`;
}
