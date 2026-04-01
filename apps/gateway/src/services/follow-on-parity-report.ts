import type {
  CompanionAuthRequirement,
  CompanionServerPrerequisite,
  FollowOnParityEpicRecord,
  FollowOnParityEpicState,
  FollowOnProofLaneArtifactRecord,
  FollowOnProofLaneArtifactIndex,
  FollowOnParityReadinessRecord,
  FollowOnParityReport,
  FollowOnParityTargetRecord,
  IntegrationCatalogEntry,
  IntegrationPluginRecord,
  ToolCatalogEntry,
  VoiceRuntimeStatus,
  VoiceStatus,
  AddonCatalogEntry,
  AddonInstalledRecord,
  DeploymentProfile,
  AuthMode,
} from "@goatcitadel/contracts";
import { buildVoiceOperatorGuidance, FOLLOW_ON_PROOF_LANE_SPECS } from "@goatcitadel/contracts";
import { buildA2UIContract } from "./a2ui-contract.js";
import { buildCompanionContract } from "./companion-contract.js";
import { evaluateDeploymentProfileToolAccess, isRestrictedBrowserStateTool } from "../tool-runtime-guardrails.js";

interface BuildFollowOnParityReportInput {
  generatedAt?: string;
  deploymentProfile: DeploymentProfile;
  authMode: AuthMode;
  allowLoopbackBypass: boolean;
  networkAllowlistCount: number;
  toolCatalog: ToolCatalogEntry[];
  integrationCatalog: IntegrationCatalogEntry[];
  integrationPlugins: IntegrationPluginRecord[];
  addonsCatalog: AddonCatalogEntry[];
  installedAddons: AddonInstalledRecord[];
  voiceStatus: VoiceStatus;
  voiceRuntime: VoiceRuntimeStatus;
  latestArtifacts?: FollowOnProofLaneArtifactIndex;
}

const PACKAGING_PROOF_FRESHNESS_WINDOW_DAYS = 7;
const REFERENCE_INTEGRATION_PLUGIN_ID = "reference-integration-plugin";
const REFERENCE_INTEGRATION_PLUGIN_SOURCE = "templates/integration-plugins/reference-integration-plugin";

const BROWSER_READ_TOOLS = new Set([
  "browser.search",
  "browser.navigate",
  "browser.extract",
  "browser.screenshot",
]);

const BROWSER_CONTROL_TOOLS = new Set([
  "browser.interact",
  "browser.context.configure",
  "browser.cookies.get",
  "browser.cookies.set",
  "browser.cookies.clear",
  "browser.storage.get",
  "browser.storage.set",
  "browser.storage.clear",
]);

export function buildFollowOnParityReport(input: BuildFollowOnParityReportInput): FollowOnParityReport {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const browserTools = input.toolCatalog.filter((tool) => tool.toolName.startsWith("browser."));
  const readToolCount = browserTools.filter((tool) => BROWSER_READ_TOOLS.has(tool.toolName)).length;
  const controlToolCount = browserTools.filter((tool) => BROWSER_CONTROL_TOOLS.has(tool.toolName)).length;
  const hasInteractionTool = browserTools.some((tool) => tool.toolName === "browser.interact");
  const registeredBrowserStateTools = browserTools
    .map((tool) => tool.toolName)
    .filter(isRestrictedBrowserStateTool);
  const allowedBrowserStateTools = registeredBrowserStateTools.filter((toolName) =>
    !evaluateDeploymentProfileToolAccess(input.deploymentProfile, toolName, {}));
  const blockedBrowserStateTools = registeredBrowserStateTools.filter((toolName) =>
    Boolean(evaluateDeploymentProfileToolAccess(input.deploymentProfile, toolName, {})));
  const browserCatalog = asTargetRecord(findCatalogEntry(input.integrationCatalog, "automation.browser-chrome-control"));
  const canvasCatalog = asTargetRecord(findCatalogEntry(input.integrationCatalog, "automation.canvas-a2ui"));
  const voiceCatalog = asTargetRecord(findCatalogEntry(input.integrationCatalog, "automation.voice-wake-talk"));
  const companionTargets = input.integrationCatalog
    .filter((entry) => entry.kind === "platform" && (
      entry.catalogId === "platform.android-canvas-camera-screen"
      || entry.catalogId === "platform.ios-canvas-camera-voice"
      || entry.catalogId === "platform.macos-menubar-voice"
    ))
    .map(asTargetRecord)
    .filter((entry): entry is FollowOnParityTargetRecord => Boolean(entry));
  const canvasPlatformTargets = companionTargets.filter((entry) =>
    entry.catalogId === "platform.android-canvas-camera-screen"
    || entry.catalogId === "platform.ios-canvas-camera-voice");
  const a2uiContract = buildA2UIContract(canvasCatalog, canvasPlatformTargets);
  const companionContract = buildCompanionContract(companionTargets);
  const companionAuthReadiness = buildCompanionAuthReadiness(input.authMode);
  const companionPrerequisiteReadiness = buildCompanionPrerequisiteReadiness();
  const runningAddonCount = input.installedAddons.filter((addon) => addon.runtimeStatus === "running").length;
  const enabledPluginCount = input.integrationPlugins.filter((plugin) => plugin.enabled).length;
  const browserGuidance = buildBrowserGuidance(
    input.deploymentProfile,
    readToolCount,
    controlToolCount,
    hasInteractionTool,
    browserCatalog?.maturity,
    registeredBrowserStateTools,
    blockedBrowserStateTools,
  );
  const voiceGuidance = buildVoiceOperatorGuidance(input.voiceStatus, input.voiceRuntime);
  const voiceRecoveryActions = buildVoiceRecoveryNotes(input.voiceStatus, input.voiceRuntime);
  const packagingGuidance = buildPackagingGuidance(
    input.deploymentProfile,
    input.authMode,
    input.allowLoopbackBypass,
    input.networkAllowlistCount,
  );
  const canvasGuidance = buildCanvasGuidance(canvasCatalog, canvasPlatformTargets, a2uiContract);
  const companionGuidance = buildCompanionGuidance(companionTargets, companionContract);
  const pluginGuidance = buildPluginGuidance(
    input.addonsCatalog.length,
    input.installedAddons.length,
    runningAddonCount,
    input.integrationPlugins,
    enabledPluginCount,
  );
  const packagingProofStatus = buildPackagingProofStatus(
    generatedAt,
    input.deploymentProfile,
    input.latestArtifacts?.packaging,
  );
  packagingGuidance.recommendedActions.push(...buildPackagingProofRecommendations(packagingProofStatus, input.deploymentProfile));

  return {
    generatedAt,
    deploymentProfile: input.deploymentProfile,
    authMode: input.authMode,
    packaging: {
      allowLoopbackBypass: input.allowLoopbackBypass,
      networkAllowlistCount: input.networkAllowlistCount,
      postureSummary: packagingGuidance.postureSummary,
      proofStatus: packagingProofStatus,
      blockingIssues: packagingGuidance.blockingIssues,
      recommendedActions: packagingGuidance.recommendedActions,
      latestArtifact: input.latestArtifacts?.packaging,
    },
    browser: {
      totalToolCount: browserTools.length,
      readToolCount,
      controlToolCount,
      guardrailSummary: browserGuidance.guardrailSummary,
      stateToolRuntime: {
        restrictedToProfile: "trusted_local",
        registeredTools: registeredBrowserStateTools,
        allowedTools: allowedBrowserStateTools,
        blockedTools: blockedBrowserStateTools,
      },
      blockingIssues: browserGuidance.blockingIssues,
      recommendedActions: browserGuidance.recommendedActions,
      automationCatalog: browserCatalog,
      latestArtifact: input.latestArtifacts?.browser,
    },
    voice: {
      runtimeReadiness: input.voiceRuntime.readiness,
      selectedModelId: input.voiceRuntime.selectedModelId,
      talkState: input.voiceStatus.talk.state,
      wakeState: input.voiceStatus.wake.state,
      wakeEnabled: input.voiceStatus.wake.enabled,
      lastError: input.voiceRuntime.lastError ?? input.voiceStatus.stt.lastError,
      blockingIssues: voiceGuidance.blockingIssues,
      recoveryActions: voiceRecoveryActions,
      recommendedActions: voiceGuidance.recommendedActions,
      automationCatalog: voiceCatalog,
      latestArtifact: input.latestArtifacts?.voice,
    },
    addons: {
      catalogCount: input.addonsCatalog.length,
      installedCount: input.installedAddons.length,
      runningCount: runningAddonCount,
    },
    plugins: {
      totalCount: input.integrationPlugins.length,
      enabledCount: enabledPluginCount,
      sdkSummary: pluginGuidance.sdkSummary,
      referenceLifecycle: pluginGuidance.referenceLifecycle,
      blockingIssues: pluginGuidance.blockingIssues,
      recommendedActions: pluginGuidance.recommendedActions,
      latestArtifact: input.latestArtifacts?.extensions,
    },
    canvas: {
      automationCatalog: canvasCatalog,
      platformTargets: canvasPlatformTargets,
      contract: a2uiContract,
      paritySummary: canvasGuidance.paritySummary,
      blockingIssues: canvasGuidance.blockingIssues,
      recommendedActions: canvasGuidance.recommendedActions,
      latestArtifact: input.latestArtifacts?.a2ui,
    },
    companion: {
      platformTargets: companionTargets,
      contract: companionContract,
      authReadiness: companionAuthReadiness,
      prerequisiteReadiness: companionPrerequisiteReadiness,
      paritySummary: companionGuidance.paritySummary,
      blockingIssues: companionGuidance.blockingIssues,
      recommendedActions: companionGuidance.recommendedActions,
      latestArtifact: input.latestArtifacts?.companion,
    },
    epics: [
      buildEpicRecord({
        epicId: "GC-P0-06",
        label: "Browser control parity",
        state: browserTools.length > 0 && controlToolCount > 0 ? "partial" : "missing",
        summary: `${browserTools.length} browser tools are registered (${readToolCount} read, ${controlToolCount} control) and catalog maturity is ${browserCatalog?.maturity ?? "missing"}.`,
        nextSlice: "Use the System page browser proof-lane draft to collect repeatable operator evidence and keep the lane honest as guardrails evolve.",
      }),
      buildEpicRecord({
        epicId: "GC-P0-07",
        label: "Canvas / A2UI parity",
        state: canvasCatalog || canvasPlatformTargets.length > 0 ? "partial" : "missing",
        summary: a2uiContract
          ? `A2UI contract ${a2uiContract.contractId} defines ${a2uiContract.scopes.join(" + ")} scope across ${canvasPlatformTargets.length} declared canvas-capable platform target(s); catalog maturity is ${canvasCatalog?.maturity ?? "missing"}.`
          : `Canvas/A2UI catalog maturity is ${canvasCatalog?.maturity ?? "missing"} with ${canvasPlatformTargets.length} canvas-capable platform targets currently declared.`,
        nextSlice: "Export the System-page A2UI proof artifact for the Office Lab handoff and directed-move pass, then use the first filed run to drive deeper canvas proof before extending the contract to companion sessions.",
      }),
      buildEpicRecord({
        epicId: "GC-P1-09",
        label: "Packaging and remote deployment parity",
        state: "partial",
        summary: `Deployment is running in ${input.deploymentProfile} with auth mode ${input.authMode}, loopback bypass ${input.allowLoopbackBypass ? "enabled" : "disabled"}, and ${input.networkAllowlistCount} allowlisted hosts.`,
        nextSlice: "Use the System page packaging proof-lane draft to collect repeatable install, hardened-run, and rollback evidence.",
      }),
      buildEpicRecord({
        epicId: "GC-P1-08",
        label: "Companion apps / nodes / device surfaces",
        state: companionTargets.length > 0 ? "partial" : "missing",
        summary: companionContract
          ? `${companionTargets.length} companion-capable platform targets exist in the catalog, and ${companionContract.contractId} now defines the Android-first bootstrap lane against the existing ${companionContract.bootstrapRepo} repo; live gateway session proof is complete, but Android UI/runtime proof is still open.`
          : `${companionTargets.length} companion-capable platform targets exist in the catalog, but there is no proven companion.android.v1 runtime lane yet.`,
        nextSlice: "Use companion.android.v1 to align the existing GoatCitadel-mobile repo with the current device approval/auth plumbing and capture Android-resident UI/runtime proof on top of the already-proven gateway session path.",
      }),
      buildEpicRecord({
        epicId: "GC-P1-10",
        label: "Long-tail parity register",
        state: "have_foundation",
        summary: "Follow-on parity now resolves to a live runtime report instead of existing only as placeholder rows.",
        nextSlice: "Keep this report and the markdown register aligned when future follow-on tranches move.",
      }),
      buildEpicRecord({
        epicId: "GC-P2-11",
        label: "Extension / plugin SDK breadth",
        state: input.addonsCatalog.length > 0 || input.integrationPlugins.length > 0 ? "partial" : "missing",
        summary: `${input.addonsCatalog.length} add-ons are cataloged, ${input.installedAddons.length} are installed, and ${input.integrationPlugins.length} integration plugins are registered (${enabledPluginCount} enabled).`,
        nextSlice: "Keep the local workspace SDK package, the reference integration plugin lifecycle, and the exported starter-pack handoff green while the published SDK/runtime-contract decision matures.",
      }),
      buildEpicRecord({
        epicId: "GC-P2-12",
        label: "Voice Wake / Talk Mode parity",
        state: "partial",
        summary: `Voice runtime is ${input.voiceRuntime.readiness}, talk is ${input.voiceStatus.talk.state}, and wake is ${input.voiceStatus.wake.enabled ? input.voiceStatus.wake.state : "disabled"}.`,
        nextSlice: "Generate the System-page voice proof lane, run the transcription + talk + wake cycle, and use the first recorded bundle to tighten operator recovery workflows.",
      }),
    ],
  };
}

function buildPackagingGuidance(
  deploymentProfile: DeploymentProfile,
  authMode: AuthMode,
  allowLoopbackBypass: boolean,
  networkAllowlistCount: number,
): {
  postureSummary: string;
  blockingIssues: string[];
  recommendedActions: string[];
} {
  const blockingIssues: string[] = [];
  const recommendedActions: string[] = [];

  if (authMode === "none") {
    blockingIssues.push("Auth mode is set to none, which is not a safe packaging or remote-share default.");
  }
  if (allowLoopbackBypass) {
    blockingIssues.push("Loopback bypass is enabled, so auth and remote-share proof is weaker than the hardened target.");
  }
  if (networkAllowlistCount === 0 && deploymentProfile !== "trusted_local") {
    blockingIssues.push("No network allowlist entries are configured for a non-trusted deployment profile.");
  }

  let postureSummary = `Packaging is currently aligned to ${deploymentProfile} with ${authMode} auth.`;
  if (deploymentProfile === "remote_hardened") {
    postureSummary = "Packaging is aligned to remote_hardened posture, but parity still requires clean-install, auth, and policy proof.";
    recommendedActions.push("Capture a clean install/startup proof run under remote_hardened before claiming deployment parity.");
  } else if (deploymentProfile === "trusted_local") {
    postureSummary = "Packaging is currently operating in trusted_local posture, which is useful for operator validation but not the full hardened deployment lane.";
    recommendedActions.push("Generate the packaging proof-lane draft from System, run a trusted_local smoke pass, then rerun the same install/startup path under remote_hardened.");
  } else {
    postureSummary = "Packaging is still in local_dev posture, so deployment claims should stay limited to development and installer smoke proof.";
    recommendedActions.push("Generate the packaging proof-lane draft from System, then promote the current setup into trusted_local and remote_hardened proof runs before expanding parity claims.");
  }

  recommendedActions.push(`Record each packaging parity run with ${FOLLOW_ON_PROOF_LANE_SPECS.packaging.templatePath}.`);

  return {
    postureSummary,
    blockingIssues,
    recommendedActions: Array.from(new Set(recommendedActions)),
  };
}

function buildPackagingProofStatus(
  generatedAt: string,
  deploymentProfile: DeploymentProfile,
  latestArtifact?: FollowOnProofLaneArtifactRecord,
): FollowOnParityReport["packaging"]["proofStatus"] {
  if (!latestArtifact) {
    return {
      hasArtifact: false,
      freshness: "missing",
      matchedCurrentProfile: false,
    };
  }

  const artifactProfile = parsePackagingArtifactDeploymentProfile(latestArtifact);
  const artifactGeneratedAtMs = Date.parse(latestArtifact.generatedAt);
  const reportGeneratedAtMs = Date.parse(generatedAt);
  const ageDays = Number.isFinite(artifactGeneratedAtMs) && Number.isFinite(reportGeneratedAtMs)
    ? Math.max(0, Math.floor((reportGeneratedAtMs - artifactGeneratedAtMs) / (24 * 60 * 60 * 1000)))
    : undefined;
  const freshness = typeof ageDays === "number" && ageDays > PACKAGING_PROOF_FRESHNESS_WINDOW_DAYS
    ? "stale"
    : "current";

  return {
    hasArtifact: true,
    freshness,
    latestArtifactDeploymentProfile: artifactProfile,
    matchedCurrentProfile: artifactProfile === deploymentProfile,
    ageDays,
  };
}

function buildPackagingProofRecommendations(
  proofStatus: FollowOnParityReport["packaging"]["proofStatus"],
  deploymentProfile: DeploymentProfile,
): string[] {
  const actions: string[] = [];
  if (!proofStatus.hasArtifact) {
    actions.push("No packaging proof artifact is recorded yet; export the next clean install/startup bundle from System before expanding deployment claims.");
    return actions;
  }
  if (proofStatus.freshness === "stale") {
    actions.push(`Latest packaging proof artifact is ${proofStatus.ageDays ?? "an unknown number of"} day(s) old; refresh it with a new clean install/startup pass before relying on it.`);
  }
  if (proofStatus.latestArtifactDeploymentProfile && !proofStatus.matchedCurrentProfile) {
    actions.push(`Latest packaging proof artifact targets ${proofStatus.latestArtifactDeploymentProfile}; rerun the packaging proof lane under ${deploymentProfile} so proof matches current runtime truth.`);
  }
  return actions;
}

function parsePackagingArtifactDeploymentProfile(
  artifact: FollowOnProofLaneArtifactRecord,
): DeploymentProfile | undefined {
  const match = artifact.relativePath.match(/packaging-deployment-proof-bundle-(local_dev|trusted_local|remote_hardened)-/);
  const parsed = match?.[1];
  if (parsed === "local_dev" || parsed === "trusted_local" || parsed === "remote_hardened") {
    return parsed;
  }
  return undefined;
}

function buildBrowserGuidance(
  deploymentProfile: DeploymentProfile,
  readToolCount: number,
  controlToolCount: number,
  hasInteractionTool: boolean,
  maturity?: FollowOnParityTargetRecord["maturity"],
  registeredStateTools: string[] = [],
  blockedStateTools: string[] = [],
): {
  guardrailSummary: string;
  blockingIssues: string[];
  recommendedActions: string[];
} {
  const blockingIssues: string[] = [];
  const recommendedActions: string[] = [];

  if (readToolCount === 0) {
    blockingIssues.push("No browser read tools are currently registered.");
  }
  if (controlToolCount === 0) {
    blockingIssues.push("No browser control tools are currently registered.");
  }
  if (!hasInteractionTool) {
    blockingIssues.push("No browser interaction tool is currently registered.");
  }
  if (maturity === "planned" || maturity === "disabled" || !maturity) {
    blockingIssues.push("Browser control catalog maturity is not yet at a shipped operator-ready level.");
  }

  let guardrailSummary = "Browser control uses step verification and deployment-profile guardrails.";
  if (deploymentProfile === "remote_hardened") {
    guardrailSummary = "Remote-hardened posture blocks browser cookie/storage state tools and requires explicit confirm-before-submit for mutating browser control.";
    recommendedActions.push("Use browser.interact with verifyStep=true and confirmBeforeSubmit=true when testing mutating browser flows.");
    if (blockedStateTools.length > 0) {
      recommendedActions.push(`Do not expect ${blockedStateTools.join(", ")} to work in remote_hardened; browser state tools are restricted to trusted_local.`);
    }
  } else if (deploymentProfile === "trusted_local") {
    guardrailSummary = "Trusted-local posture allows the full browser family, including cookie and storage tools, with normal guardrails.";
    recommendedActions.push("Generate the browser proof-lane draft from System, then run the operator pass from Mission Control or the tool surface.");
  } else {
    guardrailSummary = "Local-dev posture allows browser read/control flows with guardrails, but cookie/storage state tools are still restricted to trusted_local.";
    recommendedActions.push("Generate the browser proof-lane draft from System, run browser read/control proof in local_dev if needed, then switch to trusted_local for cookie/storage validation and remote_hardened for blocked-policy proof.");
    if (blockedStateTools.length > 0) {
      recommendedActions.push(`Do not expect ${blockedStateTools.join(", ")} to work in local_dev; browser state tools are restricted to trusted_local.`);
    }
  }

  if (controlToolCount > 0 && readToolCount > 0) {
    recommendedActions.push(`Record browser parity runs with ${FOLLOW_ON_PROOF_LANE_SPECS.browser.templatePath}.`);
  }
  if (!hasInteractionTool) {
    recommendedActions.push("Expose browser.interact before treating the browser proof lane as ready for click/input validation.");
  }
  if (registeredStateTools.length === 0) {
    recommendedActions.push("Keep browser proof claims limited to read/control flows until cookie/storage state tools are actually registered.");
  }

  return {
    guardrailSummary,
    blockingIssues,
    recommendedActions,
  };
}

function buildVoiceRecoveryNotes(
  voiceStatus: VoiceStatus,
  voiceRuntime: VoiceRuntimeStatus,
): string[] {
  const notes: string[] = [];
  const lastError = voiceRuntime.lastError ?? voiceStatus.stt.lastError;

  if (voiceRuntime.readiness !== "ready") {
    notes.push("Repair or install the managed voice runtime from Settings before attempting transcription, talk, or wake validation.");
  }
  if (!voiceRuntime.selectedModelId) {
    notes.push("Install or activate a local voice model so the proof lane is not blocked on model selection.");
  }
  if (lastError?.trim()) {
    notes.push(`Capture and clear the last runtime error after recovery: ${lastError}`);
  }
  if (voiceStatus.talk.state === "running") {
    notes.push("Stop the stale talk session before starting the proof run so the talk-cycle evidence is clean.");
  }
  if (voiceStatus.wake.enabled) {
    notes.push("Disable the current wake listener first, then re-enable it during the proof run to capture a clean state transition.");
  }

  return Array.from(new Set(notes));
}

function buildCanvasGuidance(
  canvasCatalog: FollowOnParityTargetRecord | undefined,
  canvasPlatformTargets: FollowOnParityTargetRecord[],
  a2uiContract: FollowOnParityReport["canvas"]["contract"],
): {
  paritySummary: string;
  blockingIssues: string[];
  recommendedActions: string[];
} {
  const blockingIssues: string[] = [];
  const recommendedActions: string[] = [];

  if (!canvasCatalog) {
    blockingIssues.push("No first-class canvas/A2UI automation catalog entry is registered.");
  } else if (canvasCatalog.maturity === "planned" || canvasCatalog.maturity === "disabled") {
    blockingIssues.push(`Canvas/A2UI catalog maturity is ${canvasCatalog.maturity}, which is still below an operator-ready surface.`);
  }
  if (!a2uiContract) {
    blockingIssues.push("A2UI contract resolution is missing, so operators still cannot distinguish Mission Control canvas work from companion canvas work.");
  } else {
    blockingIssues.push("A2UI contract v1 exists and the gateway session path is proven, but the Android/companion runtime lane still lacks platform proof.");
  }

  const paritySummary = a2uiContract
    ? `A2UI contract ${a2uiContract.contractId} now defines ${a2uiContract.scopes.join(" + ")} scope for ${canvasCatalog?.label ?? "canvas automation"} via ${a2uiContract.operatorSurface}, with ${canvasPlatformTargets.length} declared canvas-capable platform target(s).`
    : canvasCatalog
    ? `Canvas parity currently rests on ${canvasCatalog.label} (${canvasCatalog.maturity}) plus ${canvasPlatformTargets.length} declared canvas-capable platform target(s).`
    : "Canvas parity currently relies on UI/canvas primitives and placeholder platform tracks, not a shipped A2UI runtime.";

  recommendedActions.push("Use docs/A2UI_CONTRACT.md and packages/contracts/src/a2ui.ts as the source of truth for a2ui.v1.");
  recommendedActions.push("Keep the Canvas + A2UI catalog entry aligned with a2ui.v1 capability naming instead of treating it as a generic visual-workspace placeholder.");
  recommendedActions.push("Generate or export the A2UI proof lane from System, then use it for a Mission-Control-first Office Lab handoff and directed-move pass before broadening to companion sessions.");

  return {
    paritySummary,
    blockingIssues,
    recommendedActions,
  };
}

function buildCompanionGuidance(
  companionTargets: FollowOnParityTargetRecord[],
  companionContract: FollowOnParityReport["companion"]["contract"],
): {
  paritySummary: string;
  blockingIssues: string[];
  recommendedActions: string[];
} {
  const blockingIssues: string[] = [];
  const recommendedActions: string[] = [];

  if (companionTargets.length === 0) {
    blockingIssues.push("No companion-capable platform targets are declared in the integration catalog.");
  } else if (!companionContract) {
    blockingIssues.push("Companion targets are declared, but there is still no Android bootstrap contract tying them to a real separate-repo plan.");
  } else {
    blockingIssues.push(`Gateway session/signing proof is complete, but the existing ${companionContract.bootstrapRepo} runtime still needs Android UI/runtime proof on companion.android.v1.`);
  }

  const paritySummary = companionContract
    ? `${companionContract.contractId} defines an Android-first ${companionContract.repoStrategy} bootstrap lane for ${companionTargets.length} declared companion-capable platform target(s), and the gateway now has live session/signing proof while the existing ${companionContract.bootstrapRepo} runtime still lacks Android UI/runtime proof.`
    : companionTargets.length > 0
    ? `${companionTargets.length} companion-capable platform target(s) are declared, but companion work is still docs/catalog-first.`
    : "Companion parity does not yet have a declared runtime target lane.";

  recommendedActions.push("Use docs/COMPANION_CONTRACT.md and docs/ANDROID_NATIVE_SPEC.md as the current companion bootstrap baseline.");
  recommendedActions.push("Keep Android as the first bootstrap target and align the separate GoatCitadel-mobile repo to companion.android.v1.");
  recommendedActions.push("Use the companion session exchange/refresh contract plus the gateway companion session/audit admin routes to keep the server-side lane truthful while Android runtime proof is completed.");

  return {
    paritySummary,
    blockingIssues,
    recommendedActions,
  };
}

function buildCompanionAuthReadiness(
  authMode: AuthMode,
): FollowOnParityReadinessRecord<CompanionAuthRequirement>[] {
  return [
    readinessRecord(
      "device_identity",
      "Device identity",
      "have_foundation",
      "Gateway auth already supports device access requests, approvals, grants, and revocation for named devices.",
    ),
    readinessRecord(
      "short_lived_access_token",
      "Short-lived access tokens",
      "have_foundation",
      `Current gateway auth mode is ${authMode}; the gateway now issues dedicated short-lived companion access tokens through the companion session exchange route.`,
    ),
    readinessRecord(
      "rotating_refresh_token",
      "Rotating refresh tokens",
      "have_foundation",
      "The gateway now rotates companion refresh tokens and revokes companion sessions when the parent device grant is revoked.",
    ),
    readinessRecord(
      "request_signing",
      "Signed mutating requests",
      "have_foundation",
      "Companion-authenticated mutating requests now require an Ed25519 signature over method, path, timestamp, nonce, and canonical body hash.",
    ),
    readinessRecord(
      "replay_protection",
      "Replay protection",
      "have_foundation",
      "Signed companion mutations now write nonce-scoped replay records with bounded TTL enforcement on the gateway.",
    ),
  ];
}

function buildCompanionPrerequisiteReadiness():
FollowOnParityReadinessRecord<CompanionServerPrerequisite>[] {
  return [
    readinessRecord(
      "device_pairing",
      "Device pairing",
      "have_foundation",
      "The auth API already supports device requests, request polling, grants, and grant revocation.",
    ),
    readinessRecord(
      "token_rotation",
      "Token rotation",
      "have_foundation",
      "The auth API now exposes companion session exchange and refresh endpoints that rotate access and refresh credentials.",
    ),
    readinessRecord(
      "request_signing",
      "Request signing",
      "have_foundation",
      "The auth pipeline now verifies companion Ed25519 request signatures and records replay-cache state on signed mutations.",
    ),
    readinessRecord(
      "sse_resume",
      "SSE resume",
      "have_foundation",
      "The realtime events stream already supports afterCursor replay, Last-Event-ID resume, and explicit replay-gap responses.",
    ),
    readinessRecord(
      "per_device_audit",
      "Per-device audit",
      "have_foundation",
      "Gateway audit now records companion session exchange, refresh, revocation, signed request acceptance, replay rejection, timestamp failures, and signature failures with session/grant linkage.",
    ),
  ];
}

function buildPluginGuidance(
  addonsCatalogCount: number,
  installedAddonCount: number,
  runningAddonCount: number,
  plugins: IntegrationPluginRecord[],
  enabledPluginCount: number,
): {
  sdkSummary: string;
  referenceLifecycle: FollowOnParityReport["plugins"]["referenceLifecycle"];
  blockingIssues: string[];
  recommendedActions: string[];
} {
  const blockingIssues: string[] = [];
  const recommendedActions: string[] = [];
  const pluginCount = plugins.length;
  const hasRegisteredBreadth = addonsCatalogCount > 0 || pluginCount > 0;
  const referencePlugin = plugins.find((plugin) => plugin.pluginId === REFERENCE_INTEGRATION_PLUGIN_ID);
  const referenceLifecycle: FollowOnParityReport["plugins"]["referenceLifecycle"] = {
    referencePluginId: REFERENCE_INTEGRATION_PLUGIN_ID,
    present: Boolean(referencePlugin),
    enabled: referencePlugin?.enabled ?? false,
    source: referencePlugin?.source,
    matchesReferenceSource: doesPluginMatchReferenceSource(referencePlugin),
    capabilities: referencePlugin?.capabilities ?? [],
  };
  const hasReferencePluginScaffold = referenceLifecycle.present;

  if (!referenceLifecycle.present) {
    blockingIssues.push("The local reference integration plugin has not been installed through the operator lifecycle yet.");
  } else if (!referenceLifecycle.enabled) {
    blockingIssues.push("The local reference integration plugin is installed but currently disabled, so the lifecycle smoke path is incomplete.");
  } else if (!referenceLifecycle.matchesReferenceSource) {
    blockingIssues.push("The local reference integration plugin is installed, but its source no longer points at the repo reference scaffold.");
  } else {
    blockingIssues.push("A local workspace author SDK package and installable reference integration plugin now exist, but there is still no published SDK package or broader runtime contract.");
  }
  if (addonsCatalogCount === 0 && pluginCount === 0) {
    blockingIssues.push("No add-on catalog entries or integration plugins are currently registered.");
  }

  const sdkSummary = !hasRegisteredBreadth
    ? "No add-on catalog entries or integration plugins are currently registered, so there is no live operator breadth yet; the author contract, local workspace SDK package, and local reference scaffold exist, but the first reference lifecycle still needs to be installed and exercised."
    : referenceLifecycle.present && referenceLifecycle.enabled && referenceLifecycle.matchesReferenceSource
    ? `${addonsCatalogCount} cataloged add-on(s), ${installedAddonCount} installed (${runningAddonCount} running), and ${pluginCount} integration plugin(s) (${enabledPluginCount} enabled) show operator breadth; a local workspace author SDK package and installable reference integration plugin are now present, but the published SDK/runtime story is still partial.`
    : `${addonsCatalogCount} cataloged add-on(s), ${installedAddonCount} installed (${runningAddonCount} running), and ${pluginCount} integration plugin(s) (${enabledPluginCount} enabled) show operator breadth; the author contract and local reference scaffold now exist, but the reference lifecycle still needs to be installed, enabled, and source-aligned before it counts as the repeatable smoke path.`;

  recommendedActions.push("Use docs/PLUGIN_SDK_CONTRACT.md as the current author-contract baseline for extension work.");
  recommendedActions.push("Use packages/extensions-sdk/ as the local author SDK baseline for manifest validation and file helpers.");
  recommendedActions.push("Use templates/integration-plugins/reference-integration-plugin/ as the local installable plugin reference path.");
  recommendedActions.push("Use the generated or exported extension starter pack when the current contract doc and reference scaffolds need to be handed off outside the repo.");
  recommendedActions.push("Keep a smoke test around discovery, install metadata, enable/disable, and runtime reporting for the reference plugin lifecycle.");
  if (!referenceLifecycle.present) {
    recommendedActions.push("Install the local reference integration plugin through Mission Control or the integrations API before tomorrow's operator pass.");
  } else if (!referenceLifecycle.enabled) {
    recommendedActions.push("Re-enable the local reference integration plugin so the smoke path proves install plus active lifecycle state.");
  } else if (!referenceLifecycle.matchesReferenceSource) {
    recommendedActions.push("Reinstall the local reference integration plugin from templates/integration-plugins/reference-integration-plugin/ so the smoke path is anchored to the repo scaffold.");
  }

  return {
    sdkSummary,
    referenceLifecycle,
    blockingIssues,
    recommendedActions,
  };
}

function doesPluginMatchReferenceSource(plugin?: IntegrationPluginRecord): boolean {
  if (!plugin?.source) {
    return false;
  }
  return normalizePluginSource(plugin.source).includes(normalizePluginSource(REFERENCE_INTEGRATION_PLUGIN_SOURCE));
}

function normalizePluginSource(source: string): string {
  return source.replaceAll("\\", "/").toLowerCase();
}

function findCatalogEntry(
  integrationCatalog: IntegrationCatalogEntry[],
  catalogId: string,
): IntegrationCatalogEntry | undefined {
  return integrationCatalog.find((entry) => entry.catalogId === catalogId);
}

function asTargetRecord(entry?: IntegrationCatalogEntry): FollowOnParityTargetRecord | undefined {
  if (!entry) {
    return undefined;
  }
  return {
    catalogId: entry.catalogId,
    label: entry.label,
    maturity: entry.maturity,
    capabilities: [...entry.capabilities],
  };
}

function buildEpicRecord(input: {
  epicId: FollowOnParityEpicRecord["epicId"];
  label: string;
  state: FollowOnParityEpicState;
  summary: string;
  nextSlice: string;
}): FollowOnParityEpicRecord {
  return {
    epicId: input.epicId,
    label: input.label,
    state: input.state,
    summary: input.summary,
    nextSlice: input.nextSlice,
  };
}

function readinessRecord<Key extends string>(
  key: Key,
  label: string,
  state: FollowOnParityEpicState,
  note: string,
): FollowOnParityReadinessRecord<Key> {
  return {
    key,
    label,
    state,
    note,
  };
}
