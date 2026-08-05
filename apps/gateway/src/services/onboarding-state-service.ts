import path from "node:path";
import { logger } from "@goatcitadel/gateway-core";
import type {
  AuthRuntimeSettings,
  OnboardingBootstrapInput,
  OnboardingBootstrapResult,
  OnboardingFirstRunChecklistItem,
  OnboardingSetupReadiness,
  OnboardingState,
  OnboardingStartupState,
  RealtimeEvent,
} from "@goatcitadel/contracts";
import type { GatewayRuntimeConfig } from "../config.js";
import type { LlmService } from "./llm-service.js";
import type { RuntimeSettings } from "./gateway/runtime-settings.js";
import * as onboardingMarkerHelpers from "./onboarding-marker-helpers.js";
import type * as settingsAuthService from "./settings-auth-service.js";

const log = logger.child("onboarding-state-service");
const onboardingTimingEnabled = process.env.GOATCITADEL_DEBUG_ONBOARDING_TIMING === "1";

export interface OnboardingStateHost {
  readonly config: GatewayRuntimeConfig;
  readonly llmService: Pick<LlmService, "getRuntimeConfig" | "getProviderSecretStatus" | "resolveExecutionApiStyle">;
  readonly onboardingMarkerPath: string;
  onboardingMarker: { completedAt?: string; completedBy?: string };
  getAuthRuntimeSettings(): AuthRuntimeSettings;
  readSettingsRevision?(): number;
  publishRealtime(
    eventType: string,
    source: string,
    payload: Record<string, unknown>,
    options?: Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links" | "correlationId">,
  ): Promise<unknown>;
  updateSettings(input: settingsAuthService.UpdateSettingsInput): Promise<RuntimeSettings>;
}

export function getOnboardingStartupState(runtime: OnboardingStateHost): OnboardingStartupState {
  const auth = runtime.getAuthRuntimeSettings();
  const profile = buildSetupReadinessProfile(runtime, auth);
  const summary = summarizeSetupReadiness([
    buildAuthReadinessItem(auth),
    buildRemotePostureReadinessItem(runtime, profile),
    buildCorsReadinessItem(runtime, profile),
    buildOutboundAllowlistReadinessItem(runtime),
  ]);
  return {
    completed: Boolean(runtime.onboardingMarker.completedAt),
    completedAt: runtime.onboardingMarker.completedAt,
    completedBy: runtime.onboardingMarker.completedBy,
    setupReadiness: {
      generatedAt: new Date().toISOString(),
      profile,
      summary,
    },
  };
}

export function getOnboardingState(runtime: OnboardingStateHost): OnboardingState {
  const startedAt = Date.now();
  const auth = runtime.getAuthRuntimeSettings();
  const afterAuth = Date.now();
  const baseLlm = runtime.llmService.getRuntimeConfig({
    includeKeychainForActiveProvider: false,
    useCache: true,
  });
  const afterBaseLlm = Date.now();
  const activeProviderQuick = baseLlm.providers.find((provider) => provider.providerId === baseLlm.activeProviderId);
  const activeProviderStatus =
    activeProviderQuick && !activeProviderQuick.hasApiKey
      ? runtime.llmService.getProviderSecretStatus(baseLlm.activeProviderId, {
          includeKeychain: true,
          useCache: true,
        })
      : undefined;
  const afterActiveProviderStatus = Date.now();
  const llm = {
    ...baseLlm,
    providers: baseLlm.providers.map((provider) =>
      provider.providerId !== activeProviderStatus?.providerId
        ? provider
        : {
            ...provider,
            hasApiKey: activeProviderStatus.hasApiKey,
            apiKeySource: activeProviderStatus.apiKeySource,
            hasKeychainSecret: activeProviderStatus.hasKeychainSecret,
            apiKeyRef: activeProviderStatus.apiKeyRef,
          },
    ),
  };
  const afterLlmMap = Date.now();
  const mesh = {
    enabled: runtime.config.assistant.mesh.enabled,
    mode: runtime.config.assistant.mesh.mode,
    nodeId: runtime.config.assistant.mesh.nodeId,
    mdns: runtime.config.assistant.mesh.discovery.mdns,
    staticPeers: runtime.config.assistant.mesh.discovery.staticPeers,
    requireMtls: runtime.config.assistant.mesh.security.requireMtls,
    tailnetEnabled: runtime.config.assistant.mesh.security.tailnet.enabled,
  };
  const toolApprovalMode =
    runtime.config.toolPolicy.tools.approvalMode ??
    (runtime.config.toolPolicy.tools.profile === "danger" ? "bypass" : "approve_risky");
  const defaultToolProfile = runtime.config.toolPolicy.tools.profile ?? "";
  const budgetMode = runtime.config.budgets.mode;
  const networkAllowlist = runtime.config.toolPolicy.sandbox.networkAllowlist;
  const activeProvider = llm.providers.find((provider) => provider.providerId === llm.activeProviderId);
  const authReady = isAuthConfiguredForMode(auth);
  const llmReady = Boolean(
    activeProvider &&
    llm.activeModel.trim() &&
    (activeProvider.hasApiKey || isProviderLikelyLocal(activeProvider.baseUrl)),
  );
  const runtimeReady = Boolean(toolApprovalMode.trim()) && Boolean(budgetMode.trim());
  const meshReady = mesh.enabled
    ? Boolean(mesh.nodeId.trim()) && (mesh.mode !== "tailnet" || mesh.tailnetEnabled)
    : true;
  const afterReadiness = Date.now();

  const checklist: OnboardingState["checklist"] = [
    {
      id: "auth",
      label: "Gateway access control",
      status: authReady ? "complete" : "needs_input",
      detail: authReady
        ? `Mode ${auth.mode} is configured.`
        : "Configure token/basic credentials or explicitly choose none for local trusted use.",
    },
    {
      id: "llm",
      label: "LLM provider",
      status: llmReady ? "complete" : "needs_input",
      detail: llmReady
        ? `Provider ${llm.activeProviderId} with model ${llm.activeModel} is ready.`
        : "Select an active provider/model and configure an API key (or use a local endpoint).",
    },
    {
      id: "runtime",
      label: "Runtime defaults",
      status: runtimeReady ? "complete" : "needs_input",
      detail: runtimeReady
        ? `Tool approvals ${toolApprovalMode} / budget ${budgetMode}.`
        : "Choose a tool approval mode and budget mode.",
    },
    {
      id: "mesh",
      label: "Mesh (optional)",
      status: mesh.enabled ? (meshReady ? "complete" : "needs_input") : "optional",
      detail: mesh.enabled ? `Mesh ${mesh.mode} on node ${mesh.nodeId}.` : "Mesh disabled. You can enable this later.",
    },
  ];
  const afterChecklist = Date.now();
  const projectedProviders = llm.providers.map((provider) => ({
    providerId: provider.providerId,
    label: provider.label,
    baseUrl: provider.baseUrl,
    apiStyle: provider.apiStyle,
    resolvedApiStyle: runtime.llmService.resolveExecutionApiStyle(provider.providerId, provider.defaultModel),
    defaultModel: provider.defaultModel,
    hasApiKey: provider.hasApiKey,
    apiKeySource: provider.apiKeySource,
    hasKeychainSecret: provider.hasKeychainSecret,
    apiKeyRef: provider.apiKeyRef,
  }));
  const afterProviderProjection = Date.now();

  const response: OnboardingState = {
    completed: Boolean(runtime.onboardingMarker.completedAt),
    completedAt: runtime.onboardingMarker.completedAt,
    completedBy: runtime.onboardingMarker.completedBy,
    checklist,
    firstRunChecklist: buildFirstRunChecklist({
      providerReady: llmReady,
      runtimeReady,
      activeProviderLabel: activeProvider?.label ?? llm.activeProviderId,
      activeModel: llm.activeModel,
      localRuntimeReady: Boolean(activeProvider && isProviderLikelyLocal(activeProvider.baseUrl)),
    }),
    setupReadiness: buildSetupReadiness(runtime, {
      auth,
      providerReady: llmReady,
      runtimeReady,
      firstRunComplete: Boolean(runtime.onboardingMarker.completedAt),
      activeProviderLabel: activeProvider?.label ?? llm.activeProviderId,
      activeModel: llm.activeModel,
    }),
    settings: {
      revision: runtime.readSettingsRevision?.() ?? 1,
      toolApprovalMode,
      defaultToolProfile,
      budgetMode,
      networkAllowlist,
      auth,
      llm: {
        activeProviderId: llm.activeProviderId,
        activeModel: llm.activeModel,
        providers: projectedProviders,
      },
      mesh,
    },
  };
  const completedAt = Date.now();
  if (onboardingTimingEnabled) {
    log.info("onboarding state timing", {
      totalMs: completedAt - startedAt,
      authMs: afterAuth - startedAt,
      baseLlmMs: afterBaseLlm - afterAuth,
      activeProviderStatusMs: afterActiveProviderStatus - afterBaseLlm,
      llmMapMs: afterLlmMap - afterActiveProviderStatus,
      readinessMs: afterReadiness - afterLlmMap,
      checklistMs: afterChecklist - afterReadiness,
      providerProjectionMs: afterProviderProjection - afterChecklist,
      responseWrapMs: completedAt - afterProviderProjection,
      assembleMs: completedAt - afterLlmMap,
      providerCount: llm.providers.length,
      activeProviderId: llm.activeProviderId,
      activeProviderQuickHasApiKey: activeProviderQuick?.hasApiKey ?? null,
      activeProviderStatusSource: activeProviderStatus?.apiKeySource ?? null,
    });
  }
  return response;
}

export async function bootstrapOnboarding(
  runtime: OnboardingStateHost,
  input: OnboardingBootstrapInput,
): Promise<OnboardingBootstrapResult> {
  await runtime.updateSettings({
    expectedRevision: input.expectedRevision,
    toolApprovalMode: input.toolApprovalMode,
    defaultToolProfile: input.defaultToolProfile,
    budgetMode: input.budgetMode,
    networkAllowlist: input.networkAllowlist,
    auth: input.auth,
    llm: input.llm,
    mesh: input.mesh,
  });

  if (input.markComplete) {
    await markOnboardingComplete(runtime, input.completedBy ?? "operator");
  }

  return {
    state: getOnboardingState(runtime),
    appliedAt: new Date().toISOString(),
  };
}

export async function markOnboardingComplete(
  runtime: OnboardingStateHost,
  completedBy = "operator",
): Promise<OnboardingState> {
  runtime.onboardingMarker = {
    completedAt: new Date().toISOString(),
    completedBy: completedBy.trim() || "operator",
  };
  onboardingMarkerHelpers.persistOnboardingMarker(runtime);
  await runtime.publishRealtime("system", "onboarding", {
    type: "onboarding_completed",
    completedAt: runtime.onboardingMarker.completedAt,
    completedBy: runtime.onboardingMarker.completedBy,
  });
  return getOnboardingState(runtime);
}

function buildSetupReadiness(
  runtime: OnboardingStateHost,
  input: {
    auth: AuthRuntimeSettings;
    providerReady: boolean;
    runtimeReady: boolean;
    firstRunComplete: boolean;
    activeProviderLabel: string;
    activeModel: string;
  },
): OnboardingSetupReadiness {
  const profile = buildSetupReadinessProfile(runtime, input.auth);
  const items: OnboardingSetupReadiness["items"] = [
    buildGatewayUrlReadinessItem(profile.gatewayUrl),
    buildAuthReadinessItem(input.auth),
    buildRemotePostureReadinessItem(runtime, profile),
    buildCorsReadinessItem(runtime, profile),
    buildTailnetReadinessItem(runtime, profile),
    buildOutboundAllowlistReadinessItem(runtime),
    buildStorageRootReadinessItem(runtime),
    {
      id: "provider",
      label: "Provider and model",
      status: input.providerReady ? "ready" : "needs_input",
      value: input.providerReady
        ? `${input.activeProviderLabel || "Provider"} / ${input.activeModel || "model"}`
        : "not ready",
      detail: input.providerReady
        ? "Active provider, model, and credential/local endpoint posture are sufficient for a first send."
        : "Configure a provider key, OAuth credential, or local endpoint before public readiness claims.",
      proofRefs: [{ kind: "route", label: "Providers", ref: "/settings/providers" }],
    },
    {
      id: "desktop_credentials",
      label: "Desktop credentials",
      status: "unknown",
      value: "desktop host evidence required",
      detail:
        "Mission Control must use the desktop launcher/SSE bridge credential path; Gateway does not expose bearer tokens to browser storage.",
      proofRefs: [
        { kind: "route", label: "Access", ref: "/settings/access" },
        { kind: "verification_lane", label: "Desktop verification", ref: "pnpm verify:desktop" },
      ],
    },
    {
      id: "first_run",
      label: "First-run path",
      status: input.firstRunComplete ? "ready" : input.runtimeReady ? "needs_input" : "blocked",
      value: input.firstRunComplete ? "complete" : "open",
      detail: input.firstRunComplete
        ? "Onboarding completion is recorded in the Gateway-owned marker."
        : "Complete the guided Chat, Cowork, Code, and Run Detail path before claiming setup parity.",
      proofRefs: [{ kind: "route", label: "Onboarding", ref: "/settings/onboarding" }],
    },
    {
      id: "release_proof",
      label: "Release proof",
      status: "unknown",
      value: "exact-SHA certificate required",
      detail:
        "A parity-ready release claim requires exact commit, lane, workflow, installer, and caveat evidence in the release certificate.",
      proofRefs: [
        {
          kind: "verification_lane",
          label: "Release certificate",
          ref: "scripts/release/write-release-certificate.mjs",
        },
        { kind: "verification_lane", label: "1.0 evidence", ref: "docs/1_0_RELEASE_EVIDENCE.md" },
      ],
    },
  ];

  return {
    generatedAt: new Date().toISOString(),
    profile,
    summary: summarizeSetupReadiness(items),
    items,
  };
}

function buildSetupReadinessProfile(
  runtime: OnboardingStateHost,
  auth: AuthRuntimeSettings,
): OnboardingSetupReadiness["profile"] {
  const deploymentProfile = runtime.config.assistant.deploymentProfile;
  const gatewayUrl = resolveGatewayUrl();
  const host = resolveGatewayHost(gatewayUrl);
  const nonLoopback = host ? !isLoopbackHost(host) : false;
  const deploymentPosture =
    deploymentProfile === "remote_hardened" ? "remote_hardened" : nonLoopback ? "local_network" : "local_trusted";
  const mesh = runtime.config.assistant.mesh;
  const tailnetMode = mesh.security.tailnet.enabled ? "enabled" : mesh.mode === "tailnet" ? "disabled" : "not_required";
  return {
    gatewayUrl,
    authMode: auth.mode,
    deploymentPosture,
    tailnetMode,
  };
}

function buildGatewayUrlReadinessItem(gatewayUrl: string): OnboardingSetupReadiness["items"][number] {
  const host = resolveGatewayHost(gatewayUrl);
  return {
    id: "gateway_url",
    label: "Gateway URL",
    status: host ? "ready" : "unknown",
    value: gatewayUrl,
    detail: host
      ? `Mission Control should connect to ${gatewayUrl}; tokens stay on Gateway/desktop credential paths.`
      : "Gateway URL could not be parsed from environment defaults.",
  };
}

function buildAuthReadinessItem(auth: AuthRuntimeSettings): OnboardingSetupReadiness["items"][number] {
  const configured = isAuthConfiguredForMode(auth);
  return {
    id: "auth_mode",
    label: "Auth mode",
    status: configured ? "ready" : "blocked",
    value: auth.mode,
    detail: configured
      ? `Gateway auth mode ${auth.mode} is configured for this profile.`
      : "Configure token/basic credentials, or explicitly choose none for a local trusted profile.",
    proofRefs: [{ kind: "route", label: "Access", ref: "/settings/access" }],
  };
}

function buildRemotePostureReadinessItem(
  runtime: OnboardingStateHost,
  profile: OnboardingSetupReadiness["profile"],
): OnboardingSetupReadiness["items"][number] {
  const profileName = runtime.config.assistant.deploymentProfile;
  const ready = profileName === "remote_hardened" || profile.deploymentPosture === "local_trusted";
  return {
    id: "remote_posture",
    label: "Local/remote posture",
    status: ready ? "ready" : "needs_input",
    value: profile.deploymentPosture,
    detail:
      profileName === "remote_hardened"
        ? "Remote Hardened profile is active; prompt-skipping defaults remain unavailable."
        : profile.deploymentPosture === "local_network"
          ? "Gateway appears reachable beyond loopback; review auth, CORS, allowlist, and tailnet posture."
          : "Loopback/local trusted posture is active.",
    proofRefs: [{ kind: "route", label: "Runtime", ref: "/settings/runtime" }],
  };
}

function buildCorsReadinessItem(
  runtime: OnboardingStateHost,
  profile: OnboardingSetupReadiness["profile"],
): OnboardingSetupReadiness["items"][number] {
  const allowedOrigins = splitCsvEnv(process.env.GOATCITADEL_ALLOWED_ORIGINS);
  const needsExplicitOrigins =
    runtime.config.assistant.deploymentProfile === "remote_hardened" || profile.deploymentPosture === "local_network";
  return {
    id: "cors",
    label: "CORS origins",
    status: !needsExplicitOrigins || allowedOrigins.length > 0 ? "ready" : "needs_input",
    value: allowedOrigins.length ? String(allowedOrigins.length) : "default loopback",
    detail:
      allowedOrigins.length > 0
        ? `Allowed origins are explicitly configured for ${allowedOrigins.join(", ")}.`
        : needsExplicitOrigins
          ? "Remote or LAN profiles should pin browser origins before exposing Mission Control."
          : "Default loopback developer origins are sufficient for this local profile.",
  };
}

function buildTailnetReadinessItem(
  runtime: OnboardingStateHost,
  profile: OnboardingSetupReadiness["profile"],
): OnboardingSetupReadiness["items"][number] {
  const mesh = runtime.config.assistant.mesh;
  const remote = profile.deploymentPosture === "remote_hardened" || profile.deploymentPosture === "local_network";
  return {
    id: "tailnet",
    label: "Tailnet posture",
    status: profile.tailnetMode === "enabled" || !remote ? "ready" : "needs_input",
    value: profile.tailnetMode,
    detail:
      profile.tailnetMode === "enabled"
        ? "Tailnet mesh security is enabled for this runtime profile."
        : remote
          ? `Mesh mode is ${mesh.mode}; enable tailnet or document the private-network boundary before remote use.`
          : "Tailnet is not required for loopback/local trusted use.",
    proofRefs: [{ kind: "route", label: "Runtime", ref: "/settings/runtime" }],
  };
}

function buildOutboundAllowlistReadinessItem(runtime: OnboardingStateHost): OnboardingSetupReadiness["items"][number] {
  const allowlist = runtime.config.toolPolicy.sandbox.networkAllowlist.map((item) => item.trim()).filter(Boolean);
  const hasWildcard = allowlist.includes("*");
  const remoteHardened = runtime.config.assistant.deploymentProfile === "remote_hardened";
  return {
    id: "outbound_allowlist",
    label: "Outbound allowlist",
    status: hasWildcard && remoteHardened ? "blocked" : allowlist.length > 0 ? "ready" : "needs_input",
    value: allowlist.length ? `${allowlist.length} host${allowlist.length === 1 ? "" : "s"}` : "empty",
    detail: hasWildcard
      ? "Wildcard outbound host allowlists are not acceptable for Remote Hardened release posture."
      : allowlist.length > 0
        ? "Gateway network tools are constrained by an explicit outbound host allowlist."
        : "Add outbound hosts before remote/provider setup claims that rely on network tools.",
    proofRefs: [{ kind: "route", label: "Trust policy", ref: "/settings/trust-policy" }],
  };
}

function buildStorageRootReadinessItem(runtime: OnboardingStateHost): OnboardingSetupReadiness["items"][number] {
  const root = path.resolve(runtime.config.rootDir, runtime.config.assistant.dataDir);
  return {
    id: "storage_root",
    label: "Storage root",
    status: "ready",
    value: root,
    detail: "Gateway owns runtime storage under this root; Mission Control must remain an API client.",
    proofRefs: [{ kind: "route", label: "Runtime", ref: "/settings/runtime" }],
  };
}

function summarizeSetupReadiness(
  items: Array<Pick<OnboardingSetupReadiness["items"][number], "status">>,
): OnboardingSetupReadiness["summary"] {
  return items.reduce(
    (summary, item) => {
      if (item.status === "ready") {
        summary.ready += 1;
      } else if (item.status === "blocked") {
        summary.blocked += 1;
      } else if (item.status === "needs_input") {
        summary.needsInput += 1;
      } else {
        summary.unknown += 1;
      }
      return summary;
    },
    { ready: 0, needsInput: 0, blocked: 0, unknown: 0 },
  );
}

function resolveGatewayUrl(): string {
  const explicit = process.env.GOATCITADEL_GATEWAY_URL?.trim();
  if (explicit) {
    return explicit;
  }
  const host = process.env.GATEWAY_HOST?.trim() || "127.0.0.1";
  const port = process.env.GATEWAY_PORT?.trim() || "8787";
  return `http://${host}:${port}`;
}

function resolveGatewayHost(gatewayUrl: string): string | undefined {
  try {
    return new URL(gatewayUrl).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function splitCsvEnv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildFirstRunChecklist(input: {
  providerReady: boolean;
  runtimeReady: boolean;
  localRuntimeReady: boolean;
  activeProviderLabel: string;
  activeModel: string;
}): OnboardingFirstRunChecklistItem[] {
  const providerDetail = input.providerReady
    ? `${input.activeProviderLabel || "Provider"} is ready with ${input.activeModel || "the selected model"}.`
    : "Configure a provider key or local OpenAI-compatible runtime before cloud-backed sends.";
  const setupStatus = input.providerReady || input.localRuntimeReady ? "complete" : "needs_input";
  const taskStatus = input.runtimeReady ? "needs_input" : "optional";
  return [
    {
      id: "provider_or_local_runtime",
      label: "Provider or local runtime setup",
      status: setupStatus,
      detail: providerDetail,
      proofRefs: [
        { kind: "route", label: "Providers", ref: "/settings/providers" },
        { kind: "route", label: "Runtime", ref: "/settings/runtime" },
        { kind: "verification_lane", label: "Install verification", ref: "scripts/verify-install.mjs" },
      ],
    },
    {
      id: "first_chat",
      label: "First Chat",
      status: input.providerReady ? "needs_input" : "optional",
      detail: input.providerReady
        ? "Send a low-risk Chat message and confirm model, cost, latency, and runtime status are inspectable."
        : "Use the safe demo path until provider or local runtime setup is complete.",
      proofRefs: [
        { kind: "route", label: "Chat", ref: "/chat" },
        { kind: "runtime_evidence", label: "Chat turn trace", ref: "chat.turn_trace" },
      ],
    },
    {
      id: "first_cowork",
      label: "First Cowork task",
      status: taskStatus,
      detail:
        "Run one supervised Cowork task so approvals, checkpoints, durable state, and delegation truth can be inspected.",
      proofRefs: [
        { kind: "route", label: "Cowork", ref: "/cowork" },
        { kind: "runtime_evidence", label: "Durable run", ref: "durable.run" },
      ],
    },
    {
      id: "first_code",
      label: "First Code task",
      status: taskStatus,
      detail:
        "Run one governed Code task with explicit approval and retained artifacts; this remains trusted-code execution, not hostile-code sandboxing proof.",
      proofRefs: [
        { kind: "route", label: "Code", ref: "/code" },
        { kind: "runtime_evidence", label: "Code artifact trace", ref: "code_mode.artifact" },
      ],
    },
    {
      id: "run_detail",
      label: "Run Detail inspection",
      status: "needs_input",
      detail:
        "Open Run Detail after the first governed task and confirm tools, approvals, artifacts, and failures match runtime truth.",
      proofRefs: [
        { kind: "route", label: "Run Detail", ref: "/ops/run-detail" },
        { kind: "runtime_evidence", label: "Runtime lifecycle export", ref: "runtime.lifecycle.export.v1" },
      ],
    },
  ];
}

function isAuthConfiguredForMode(auth: RuntimeSettings["auth"]): boolean {
  if (auth.mode === "none") {
    return true;
  }
  if (auth.mode === "token") {
    return auth.tokenConfigured;
  }
  return auth.basicConfigured;
}

function isProviderLikelyLocal(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}
