import {
  CHANGE_PLAN_RUNTIME_FEATURE_FLAG_LABELS,
  ConflictError,
  SemanticValidationError,
  type ChangePlanRecord,
  type ChangePlanRuntimeFeatureFlag,
  type ChangePlanRuntimeConfigurationRequest,
  type LlmModelRecord,
  type LlmModelPreviewResponse,
} from "@goatcitadel/contracts";
import type { RuntimeSettings } from "./gateway/runtime-settings.js";
import {
  applyLlamaSetup,
  discardLlamaSetup,
  llamaSetupMismatchReason,
  matchesLlamaSetup,
  validateLlamaSetup,
} from "./runtime-llama-setup-change.js";
import type { UpdateSettingsInput } from "./settings-auth-service.js";
import {
  describeGlobalToolAccessChange,
  describeOperatorWriteRootChange,
  matchesGlobalToolAccessChange,
  matchesOperatorWriteRootChange,
} from "./runtime-write-access-change.js";
import type { LlamaCppSetupSelection } from "./llama-cpp-setup-selection-service.js";
import {
  applyWebSearchCredential,
  describeWebSearchCredential,
  isWebSearchCredentialChange,
  observeWebSearchCredential,
  prepareWebSearchCredential,
  resumeWebSearchCredential,
  type WebSearchCredentialChangeOwner,
} from "./web-search-credential-change.js";
import type { LlamaCppRuntimeStatus } from "@goatcitadel/contracts";
import type {
  EvolutionControlPlaneAdapter,
  EvolutionControlPlaneAdapterContext,
  EvolutionControlPlaneAdapterOutcome,
  EvolutionControlPlaneOwnerInputReceipt,
} from "./evolution-control-plane-adapter.js";

export interface RuntimeConfigurationChangePlanAdapterDependencies {
  readonly getSettings: () => Promise<RuntimeSettings>;
  readonly updateSettings: (input: UpdateSettingsInput) => Promise<RuntimeSettings>;
  readonly listModels?: (providerId: string) => Promise<readonly LlmModelRecord[]>;
  readonly previewLlamaModels?: (baseUrl: string) => Promise<LlmModelPreviewResponse>;
  readonly resolveManagedSelection?: (selectionId: string, workspaceId: string) => Promise<LlamaCppSetupSelection>;
  readonly discardManagedSelection?: (selectionId: string) => void;
  readonly refreshLlamaRuntime?: () => Promise<LlamaCppRuntimeStatus>;
  /** Dry-runs a settings mutation against an isolated candidate; throws the owner validation error. */
  readonly validateSettingsUpdate?: (input: UpdateSettingsInput) => Promise<void>;
  readonly hasTemporaryAuthCredential: (planId: string) => boolean | Promise<boolean>;
  readonly consumeTemporaryAuthCredential: (planId: string) => string | Promise<string>;
  readonly discardTemporaryAuthCredential: (planId: string) => void | Promise<void>;
  /** OS-keychain owner for Firecrawl, Brave, and Parallel keys. */
  readonly webSearchCredentials?: WebSearchCredentialChangeOwner;
}

/** Registered typed runtime operations only; this adapter never accepts raw setting keys. */
export class RuntimeConfigurationChangePlanAdapter implements EvolutionControlPlaneAdapter<ChangePlanRuntimeConfigurationRequest> {
  public readonly adapterId = "runtime-configuration";
  public readonly version = 2;
  public readonly kinds = ["runtime_configuration"] as const;

  /** Every Web & Search phase delegates to this one keychain owner, read once at construction. */
  private readonly webSearchCredentials: WebSearchCredentialChangeOwner | undefined;

  public constructor(private readonly deps: RuntimeConfigurationChangePlanAdapterDependencies) {
    this.webSearchCredentials = deps.webSearchCredentials;
  }

  public async prepare(context: EvolutionControlPlaneAdapterContext, request: ChangePlanRuntimeConfigurationRequest) {
    assertNotRetiredToolProfileChange(request);
    const settings = await this.deps.getSettings();
    await this.validateOwnerSelection(request, settings, context.origin.workspaceId);
    if (isWebSearchCredentialChange(request)) {
      return prepareWebSearchCredential(context, request.change, settings, this.webSearchCredentials);
    }
    if (request.change.operation === "gateway_auth_configuration") {
      const change = request.change;
      const configured =
        change.mode === "token"
          ? settings.auth.tokenConfigured
          : change.mode === "basic"
            ? settings.auth.basicConfigured
            : true;
      const needsCredential = change.mode !== "none" && (change.replaceCredential === true || !configured);
      const description = describe(request, settings);
      return {
        target: {
          ownerId: "runtime_settings",
          resourceId: "gateway_auth_configuration",
          expectedRevision: settings.revision,
        },
        title: description.title,
        summary: description.summary,
        impact: description.impact,
        risk: description.risk,
        status: needsCredential ? ("awaiting_input" as const) : ("awaiting_confirmation" as const),
        requiredAction: needsCredential
          ? context.actions.secureInput({
              targetId: "gateway-auth",
              title: change.mode === "token" ? "Enter Gateway access token" : "Enter Gateway basic-auth password",
              expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
              fields: [
                {
                  fieldId: change.mode === "token" ? "token" : "password",
                  label: change.mode === "token" ? "Access token" : "Password",
                  required: true,
                  description:
                    "Captured by the Gateway credential owner and excluded from the Change Plan, Chat, and audit payloads.",
                },
              ],
            })
          : context.actions.confirmation({
              title: `Confirm ${description.title.toLowerCase()}`,
              confirmationText: description.summary,
            }),
      };
    }
    const description = describe(request, settings);
    return {
      target: {
        ownerId: "runtime_settings",
        resourceId: targetResourceId(request),
        expectedRevision: settings.revision,
      },
      title: description.title,
      summary: description.summary,
      impact: description.impact,
      risk: description.risk,
      status: "awaiting_confirmation" as const,
      requiredAction: context.actions.confirmation({
        title: `Confirm ${description.title.toLowerCase()}`,
        confirmationText: description.summary,
      }),
    };
  }

  public async apply(
    _context: EvolutionControlPlaneAdapterContext,
    plan: ChangePlanRecord,
  ): Promise<EvolutionControlPlaneAdapterOutcome> {
    if (plan.request.kind !== "runtime_configuration") {
      throw new SemanticValidationError("Runtime configuration Change Plan kind drifted.");
    }
    assertNotRetiredToolProfileChange(plan.request);
    const { getSettings, updateSettings } = this.deps;
    const current = await getSettings();
    assertRevision(plan, current.revision);
    if (plan.request.change.operation === "gateway_auth_configuration") {
      const change = plan.request.change;
      const configured =
        change.mode === "token"
          ? current.auth.tokenConfigured
          : change.mode === "basic"
            ? current.auth.basicConfigured
            : true;
      const needsCredential = change.mode !== "none" && (change.replaceCredential === true || !configured);
      let credential: string | undefined;
      if (needsCredential) {
        if (!(await this.deps.hasTemporaryAuthCredential(plan.planId))) {
          throw new SemanticValidationError("The temporary Gateway credential is unavailable. Enter it again.");
        }
        credential = await this.deps.consumeTemporaryAuthCredential(plan.planId);
      }
      const updated = await updateSettings({
        expectedRevision: current.revision,
        auth: {
          mode: change.mode,
          allowLoopbackBypass: change.allowLoopbackBypass,
          ...(change.basicUsername !== undefined ? { basicUsername: change.basicUsername } : {}),
          ...(change.mode === "token" && credential ? { token: credential } : {}),
          ...(change.mode === "basic" && credential ? { basicPassword: credential } : {}),
        },
      });
      return {
        status: "verifying",
        evidenceRefs: [`runtime_settings:gateway_auth:revision:${updated.revision}`],
        result: {
          summary: `Gateway authentication now uses ${change.mode} mode with the reviewed loopback posture.`,
          appliedRevision: updated.revision,
        },
      };
    }
    if (plan.request.change.operation === "llama_cpp_setup") {
      return await applyLlamaSetup(this.deps, plan, current);
    }
    if (isWebSearchCredentialChange(plan.request)) {
      return await applyWebSearchCredential(plan, plan.request.change, this.webSearchCredentials);
    }
    const updated = await updateSettings({
      expectedRevision: current.revision,
      ...settingsPatch(plan.request),
    });
    return {
      status: "verifying",
      evidenceRefs: [`runtime_settings:revision:${updated.revision}`],
      result: {
        summary: describe(plan.request, current).completedSummary,
        appliedRevision: updated.revision,
      },
    };
  }

  public async verify(
    _context: EvolutionControlPlaneAdapterContext,
    plan: ChangePlanRecord,
  ): Promise<EvolutionControlPlaneAdapterOutcome> {
    const observed = await this.observe(plan);
    return observed.applied
      ? {
          status: "completed",
          evidenceRefs: observed.evidenceRefs,
          result: plan.result ?? { summary: "The runtime setting owner matches the approved plan." },
        }
      : {
          status: "manual_required",
          result: { summary: observed.reason, failureCode: "owner_verification_failed" },
        };
  }

  public async reconcile(_context: EvolutionControlPlaneAdapterContext, plan: ChangePlanRecord) {
    const observed = await this.observe(plan);
    return observed.applied
      ? {
          effectObserved: true,
          status: "completed" as const,
          evidenceRefs: observed.evidenceRefs,
          result: plan.result ?? { summary: "Owner state proves the approved runtime setting is active." },
        }
      : {
          effectObserved: false,
          status: "manual_required" as const,
          result: {
            summary: `${observed.reason} The Gateway did not replay the configuration write during recovery.`,
            failureCode: "ambiguous_recovery",
          },
        };
  }

  public async resumeOwnerInput(
    context: EvolutionControlPlaneAdapterContext,
    plan: ChangePlanRecord,
    receipt: EvolutionControlPlaneOwnerInputReceipt,
  ): Promise<EvolutionControlPlaneAdapterOutcome> {
    if (plan.request.kind === "runtime_configuration" && isWebSearchCredentialChange(plan.request)) {
      return resumeWebSearchCredential(context, plan, plan.request.change, receipt, this.webSearchCredentials);
    }
    if (
      plan.request.kind !== "runtime_configuration" ||
      plan.request.change.operation !== "gateway_auth_configuration" ||
      receipt.actionKind !== "secure_input" ||
      receipt.ownerId !== "gateway_auth_temporary_secret" ||
      receipt.ownerResourceId !== "gateway-auth"
    ) {
      throw new ConflictError({ message: "Gateway auth secure-input receipt does not match this Change Plan." });
    }
    if (!(await this.deps.hasTemporaryAuthCredential(plan.planId))) {
      throw new SemanticValidationError("The temporary Gateway credential is unavailable. Enter it again.");
    }
    return {
      status: "awaiting_confirmation",
      evidenceRefs: receipt.evidenceRefs,
      requiredAction: context.actions.confirmation({
        title: "Confirm Gateway authentication change",
        confirmationText: `Apply the reviewed ${plan.request.change.mode} authentication posture using only the dedicated credential-owner reference.`,
      }),
      result: { summary: "The Gateway credential is in temporary secure custody and ready for exact confirmation." },
    };
  }

  public async discard(_context: EvolutionControlPlaneAdapterContext, plan: ChangePlanRecord): Promise<void> {
    if (
      plan.request.kind === "runtime_configuration" &&
      plan.request.change.operation === "gateway_auth_configuration"
    ) {
      await this.deps.discardTemporaryAuthCredential(plan.planId);
    }
    if (plan.request.kind === "runtime_configuration" && isWebSearchCredentialChange(plan.request)) {
      this.webSearchCredentials?.discardTemporary(plan.planId);
    }
    discardLlamaSetup(this.deps, plan);
  }

  private async observe(plan: ChangePlanRecord) {
    if (plan.request.kind !== "runtime_configuration") {
      return {
        applied: false,
        reason: "The runtime configuration intent is unavailable.",
        evidenceRefs: [] as string[],
      };
    }
    assertNotRetiredToolProfileChange(plan.request);
    if (isWebSearchCredentialChange(plan.request)) {
      return observeWebSearchCredential(plan.request.change, this.webSearchCredentials);
    }
    const current = await this.deps.getSettings();
    const applied = matches(plan.request, current);
    return {
      applied,
      reason: applied
        ? "The runtime setting owner matches the plan."
        : plan.request.change.operation === "llama_cpp_setup"
          ? llamaSetupMismatchReason(plan.request.change, current)
          : "The runtime setting owner does not match the approved plan.",
      evidenceRefs: applied ? [`runtime_settings:revision:${current.revision}`] : [],
    };
  }

  private async validateOwnerSelection(
    request: ChangePlanRuntimeConfigurationRequest,
    settings: RuntimeSettings,
    workspaceId: string,
  ): Promise<void> {
    if (request.change.operation === "llama_cpp_setup") {
      await validateLlamaSetup(this.deps, request.change, workspaceId);
      return;
    }
    if (
      request.change.operation === "operator_write_root" ||
      request.change.operation === "tool_global_access" ||
      request.change.operation === "web_firecrawl_configuration"
    ) {
      // The settings owner canonicalizes folders, checks tool posture, and
      // requires an allowlisted Firecrawl URL; a plan is never prepared (or
      // sent for approval) for a change the owner would refuse at apply.
      const validateSettingsUpdate = this.deps.validateSettingsUpdate;
      if (!validateSettingsUpdate) {
        throw new SemanticValidationError("The runtime write-access settings owner is unavailable.");
      }
      await validateSettingsUpdate({ expectedRevision: settings.revision, ...settingsPatch(request) });
      return;
    }
    if (request.change.operation !== "utility_model") return;
    const change = request.change;
    const provider = settings.llm.providers.find((item) => item.providerId === change.providerId);
    if (!provider || provider.authReadiness?.status === "unavailable") {
      throw new SemanticValidationError(`Utility-model provider ${change.providerId} is unavailable.`);
    }
    const listModels = this.deps.listModels;
    if (!listModels) {
      throw new SemanticValidationError("The utility-model catalog owner is unavailable.");
    }
    let models: readonly LlmModelRecord[];
    try {
      models = await listModels(provider.providerId);
    } catch {
      throw new SemanticValidationError(`Unable to verify models for ${provider.label}.`);
    }
    if (!models.some((model) => model.id === change.model)) {
      throw new SemanticValidationError(`${change.model} is not available from ${provider.label}.`, {
        alternatives: models.slice(0, 8).map((model) => model.id),
      });
    }
  }
}

function assertNotRetiredToolProfileChange(request: ChangePlanRuntimeConfigurationRequest): void {
  if ((request.change.operation as string) === "default_tool_profile") {
    throw new SemanticValidationError("Named tool profile changes are retired. Review permission profiles instead.");
  }
}

function settingsPatch(request: ChangePlanRuntimeConfigurationRequest): Omit<UpdateSettingsInput, "expectedRevision"> {
  switch (request.change.operation) {
    case "tool_approval_mode":
      return { toolApprovalMode: request.change.mode };
    case "budget_mode":
      return { budgetMode: request.change.mode };
    case "deployment_profile":
      return { deploymentProfile: request.change.profile };
    case "read_access_policy":
      return { readAccessMode: request.change.mode };
    case "outside_root_write_policy":
      return { outsideRootWriteMode: request.change.mode };
    case "network_allowlist":
      return { networkAllowlist: [...request.change.entries] };
    case "utility_model":
      return { llm: { utilityProviderId: request.change.providerId, utilityModel: request.change.model } };
    case "gateway_auth_configuration":
      throw new SemanticValidationError("Gateway auth configuration requires its dedicated credential owner path.");
    case "memory_configuration":
      return { memory: { ...request.change.config } };
    case "web_firecrawl_configuration":
      return { web: { firecrawl: { ...request.change.config } } };
    case "web_search_configuration":
      return { web: { search: { engineOrder: [...request.change.config.engineOrder] } } };
    case "web_search_credential":
      throw new SemanticValidationError("Web-search keys use the dedicated OS-keychain owner path.");
    case "mesh_configuration": {
      const { staticPeers, ...config } = request.change.config;
      return { mesh: { ...config, ...(staticPeers !== undefined ? { staticPeers: [...staticPeers] } : {}) } };
    }
    case "npu_configuration":
      return { npu: { ...request.change.config } };
    case "llama_cpp_configuration":
      return { llamaCpp: { ...request.change.config } };
    case "llama_cpp_setup":
      throw new SemanticValidationError("llama.cpp setup uses its dedicated validated owner path.");
    case "operator_write_root": {
      const { operation: _operation, ...change } = request.change;
      return { operatorWriteRootChange: change };
    }
    case "tool_global_access":
      return { globalToolAccessChange: { toolName: request.change.toolName, posture: request.change.posture } };
    case "feature_flag":
      return { features: { [request.change.flag]: request.change.enabled } };
    case "feature_flags":
      return { features: { ...request.change.flags } };
  }
}

function matches(request: ChangePlanRuntimeConfigurationRequest, settings: RuntimeSettings): boolean {
  switch (request.change.operation) {
    case "tool_approval_mode":
      return settings.toolApprovalMode === request.change.mode;
    case "budget_mode":
      return settings.budgetMode === request.change.mode;
    case "deployment_profile":
      return settings.deploymentProfile === request.change.profile;
    case "read_access_policy":
      return settings.readAccessMode === request.change.mode;
    case "outside_root_write_policy":
      return (settings.outsideRootWriteMode ?? "deny") === request.change.mode;
    case "network_allowlist":
      return sameList(settings.networkAllowlist, request.change.entries);
    case "utility_model":
      return (
        settings.llm.utilityProviderId === request.change.providerId &&
        settings.llm.utilityModel === request.change.model
      );
    case "gateway_auth_configuration":
      return (
        settings.auth.mode === request.change.mode &&
        settings.auth.allowLoopbackBypass === request.change.allowLoopbackBypass &&
        (request.change.mode === "none" ||
          (request.change.mode === "token" ? settings.auth.tokenConfigured : settings.auth.basicConfigured))
      );
    case "memory_configuration":
      return matchesMemory(settings, request.change.config);
    case "web_firecrawl_configuration":
      return matchesPartial(settings.web.firecrawl, request.change.config);
    case "web_search_configuration":
      return sameList(settings.web.search.engineOrder, request.change.config.engineOrder);
    case "web_search_credential":
      // Observed through the credential owner, never the settings projection.
      return false;
    case "mesh_configuration":
      return matchesPartial(settings.mesh, request.change.config);
    case "npu_configuration":
      return matchesPartial(settings.npu, request.change.config);
    case "llama_cpp_configuration":
      return matchesPartial(settings.llamaCpp, request.change.config, true);
    case "llama_cpp_setup":
      return matchesLlamaSetup(request.change, settings);
    case "operator_write_root":
      return matchesOperatorWriteRootChange(request.change, settings);
    case "tool_global_access":
      return matchesGlobalToolAccessChange(request.change, settings);
    case "feature_flag":
      return settings.features[request.change.flag] === request.change.enabled;
    case "feature_flags":
      return Object.entries(request.change.flags).every(
        ([flag, enabled]) => settings.features[flag as keyof RuntimeSettings["features"]] === enabled,
      );
  }
}

function targetResourceId(request: ChangePlanRuntimeConfigurationRequest): string {
  switch (request.change.operation) {
    case "feature_flag":
      return `feature:${request.change.flag}`;
    case "operator_write_root":
      return `operator_write_root:${request.change.preset ?? "path"}`;
    case "tool_global_access":
      return `tool_global_access:${request.change.toolName}`;
    default:
      return request.change.operation;
  }
}

function describe(request: ChangePlanRuntimeConfigurationRequest, settings: RuntimeSettings) {
  switch (request.change.operation) {
    case "tool_approval_mode": {
      const risk = request.change.mode === "bypass" ? ("danger" as const) : ("caution" as const);
      return {
        title: "Change tool approval mode",
        summary: `Change tool approval mode from ${settings.toolApprovalMode} to ${request.change.mode}.`,
        completedSummary: `Tool approval mode is now ${request.change.mode}.`,
        impact: "Future tool invocations use the selected approval posture; deny-wins policy remains authoritative.",
        risk,
      };
    }
    case "budget_mode":
      return {
        title: "Change runtime budget mode",
        summary: `Change runtime budget mode from ${settings.budgetMode} to ${request.change.mode}.`,
        completedSummary: `Runtime budget mode is now ${request.change.mode}.`,
        impact: "Future routing and execution use the selected cost posture.",
        risk: "safe" as const,
      };
    case "deployment_profile":
      return {
        title: "Change deployment profile",
        summary: `Change the deployment profile from ${settings.deploymentProfile} to ${request.change.profile}.`,
        completedSummary: `Deployment profile is now ${request.change.profile}.`,
        impact: "Authentication, network, and runtime safeguards are revalidated for the selected deployment posture.",
        risk: request.change.profile === "remote_hardened" ? ("caution" as const) : ("danger" as const),
      };
    case "read_access_policy":
      return {
        title: "Change filesystem read policy",
        summary: `Change filesystem read access from ${settings.readAccessMode} to ${request.change.mode}.`,
        completedSummary: `Filesystem read access is now ${request.change.mode}.`,
        impact:
          "Future file reads use the new policy; write access (the workspace jail and operator write roots) and deny-wins policy remain unchanged.",
        risk: request.change.mode === "roots_only" ? ("caution" as const) : ("danger" as const),
      };
    case "outside_root_write_policy":
      return request.change.mode === "approval_required"
        ? {
            title: "Let Chat ask to write outside the write roots",
            summary: "Writes outside every write root raise an approval instead of a hard block.",
            completedSummary: "Chat can now ask to write outside the write roots.",
            impact:
              "An approval can admit one exact write or open one folder for 15 minutes to 8 hours, for the approved tool and session or workspace only. Deletes outside the roots, protected runtime paths, network shares and delegated sessions stay blocked; deny-wins and Citadel Wards still apply.",
            risk: "danger" as const,
          }
        : {
            title: "Block writes outside the write roots",
            summary: "Writes outside every write root are blocked again.",
            completedSummary: "Writes outside the write roots are blocked; existing folder grants stop working.",
            impact:
              "Existing outside-root folder grants become inert immediately. Writes inside the write roots are unchanged.",
            risk: "safe" as const,
          };
    case "network_allowlist":
      return {
        title: "Change the network allowlist",
        summary: `Replace the network allowlist with ${request.change.entries.length} reviewed entr${request.change.entries.length === 1 ? "y" : "ies"}.`,
        completedSummary: "The network allowlist now matches the reviewed entries.",
        impact: "Provider and tool egress is recalculated from the exact reviewed list.",
        risk: "danger" as const,
      };
    case "utility_model":
      return {
        title: "Change the utility model",
        summary: `Use ${request.change.providerId} / ${request.change.model} for future utility-model work.`,
        completedSummary: `Utility-model routing now uses ${request.change.providerId} / ${request.change.model}.`,
        impact: "Future background evaluations and classifiers may use this selection when utility routing is enabled.",
        risk: "safe" as const,
      };
    case "gateway_auth_configuration": {
      const loosensAccess = request.change.mode === "none" || request.change.allowLoopbackBypass;
      return {
        title: "Change Gateway authentication",
        summary: `Use ${request.change.mode} Gateway authentication with loopback bypass ${request.change.allowLoopbackBypass ? "enabled" : "disabled"}.`,
        completedSummary: `Gateway authentication now uses ${request.change.mode} mode.`,
        impact:
          "Future Gateway requests use the reviewed authentication posture; credentials stay in the dedicated owner.",
        risk: loosensAccess ? ("danger" as const) : ("caution" as const),
      };
    }
    case "memory_configuration":
      return typedConfigurationDescription(
        "memory configuration",
        request.change.config,
        "Future memory context and maintenance behavior use the reviewed values.",
        "caution",
      );
    case "web_firecrawl_configuration":
      return typedConfigurationDescription(
        "Firecrawl configuration",
        request.change.config,
        "Future web reads may use the reviewed external service posture.",
        "caution",
      );
    case "web_search_configuration": {
      const [defaultEngine, ...backups] = request.change.config.engineOrder;
      const order = request.change.config.engineOrder.join(" → ");
      return {
        title: "Change web search engines",
        summary: `Search with ${defaultEngine}${backups.length ? `, then ${backups.join(", then ")}` : " only"}.`,
        completedSummary: `Native web search now uses ${order}.`,
        impact: "browser.search and the Chat search fallback use only these engines, in this order.",
        risk: "safe" as const,
      };
    }
    case "web_search_credential":
      return describeWebSearchCredential(request.change);
    case "mesh_configuration":
      return typedConfigurationDescription(
        "mesh configuration",
        request.change.config,
        "Peer discovery and mesh exposure use the reviewed values.",
        "danger",
      );
    case "npu_configuration":
      return typedConfigurationDescription(
        "NPU sidecar configuration",
        request.change.config,
        "The optional local sidecar lifecycle uses the reviewed values.",
        "caution",
      );
    case "llama_cpp_configuration":
      return typedConfigurationDescription(
        "llama.cpp runtime configuration",
        request.change.config,
        "The local inference runtime uses only the reviewed non-path settings.",
        "caution",
      );
    case "llama_cpp_setup":
      return {
        title: "Set up llama.cpp for Chat",
        summary: `Use ${request.change.model} from the reviewed ${request.change.managementMode} server at ${request.change.baseUrl}.`,
        completedSummary: `llama.cpp ${request.change.model} is selected for Chat.`,
        impact:
          "Gateway validates the runtime before changing the Chat default. Managed files remain in Gateway custody.",
        risk: "caution" as const,
      };
    case "operator_write_root":
      return describeOperatorWriteRootChange(request.change);
    case "tool_global_access":
      return describeGlobalToolAccessChange(request.change, settings);
    case "feature_flag":
      return describeFeatureFlagChange(request.change.flag, request.change.enabled);
    case "feature_flags": {
      const description = Object.entries(request.change.flags)
        .map(([flag, enabled]) => `${featureFlagName(flag)}: ${enabled ? "on" : "off"}`)
        .join("; ");
      return {
        title: "Apply reviewed runtime presets",
        summary: description,
        completedSummary: `Runtime presets now match: ${description}`,
        impact:
          "The selected registered flags change together at one settings revision. Tool and memory governance remain authoritative.",
        risk:
          request.change.flags.productSourceEvolutionV1Enabled || request.change.flags.settingsApprovalSkipEnabled
            ? ("danger" as const)
            : ("caution" as const),
      };
    }
  }
}

function featureFlagName(flag: string): string {
  return CHANGE_PLAN_RUNTIME_FEATURE_FLAG_LABELS[flag as ChangePlanRuntimeFeatureFlag]?.label ?? flag;
}

/** One switch, named the way Settings names it; a flag without a Settings name keeps its key (#496). */
function describeFeatureFlagChange(flag: ChangePlanRuntimeFeatureFlag, enabled: boolean) {
  const named = CHANGE_PLAN_RUNTIME_FEATURE_FLAG_LABELS[flag];
  const name = named?.label ?? flag;
  const state = enabled ? "on" : "off";
  return {
    title: `Turn ${state} ${name}`,
    summary: named
      ? `${named.description} This turns it ${state}.`
      : `${enabled ? "Enable" : "Disable"} the registered ${flag} rollout gate.`,
    completedSummary: `${name} is now ${state}.`,
    impact: `Only ${named ? "this setting" : `this setting (${flag})`} changes. You can turn it ${enabled ? "off" : "on"} again the same way.`,
    risk:
      (flag === "productSourceEvolutionV1Enabled" || flag === "settingsApprovalSkipEnabled") && enabled
        ? ("danger" as const)
        : ("caution" as const),
  };
}

function typedConfigurationDescription(label: string, config: object, impact: string, risk: "caution" | "danger") {
  const count = Object.keys(config).length;
  return {
    title: `Change ${label}`,
    summary: `Apply ${count} reviewed typed ${label} field${count === 1 ? "" : "s"}.`,
    completedSummary: `The ${label} now matches the reviewed values.`,
    impact,
    risk,
  };
}

function matchesMemory(
  settings: RuntimeSettings,
  config: Extract<ChangePlanRuntimeConfigurationRequest["change"], { operation: "memory_configuration" }>["config"],
): boolean {
  const observed = {
    enabled: settings.memory.enabled,
    qmdEnabled: settings.memory.qmd.enabled,
    qmdApplyToChat: settings.memory.qmd.applyToChat,
    qmdApplyToOrchestration: settings.memory.qmd.applyToOrchestration,
    qmdMaxContextTokens: settings.memory.qmd.maxContextTokens,
    qmdMinPromptChars: settings.memory.qmd.minPromptChars,
    qmdCacheTtlSeconds: settings.memory.qmd.cacheTtlSeconds,
    qmdDistillerProviderId: settings.memory.qmd.distillerProviderId,
    qmdDistillerModel: settings.memory.qmd.distillerModel,
  };
  return matchesPartial(observed, config);
}

function matchesPartial(observed: object, expected: object, nullClears = false): boolean {
  const owner = observed as Record<string, unknown>;
  return Object.entries(expected).every(([key, value]) => {
    const actual = owner[key];
    if (nullClears && value === null) return actual === undefined || actual === null;
    if (Array.isArray(value)) return Array.isArray(actual) && sameList(actual, value);
    return actual === value;
  });
}

function sameList(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function assertRevision(plan: ChangePlanRecord, currentRevision: number): void {
  if (plan.target.expectedRevision === currentRevision) return;
  throw new ConflictError({
    code: "WRITE_CONFLICT",
    message: "Runtime settings changed after this Change Plan was prepared.",
    details: {
      resourceKind: plan.target.ownerId,
      resourceId: plan.target.resourceId,
      expectedRevision: plan.target.expectedRevision,
      currentRevision,
    },
  });
}

export function runtimeTemporaryAuthAccount(planId: string): string {
  return `evolution:gateway-auth:${planId}`;
}
