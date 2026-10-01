import { canonicalJsonString, type LlamaCppRuntimeStatus, type LlamaCppSetupProjection } from "@goatcitadel/contracts";
import { fetchSettings } from "@goatcitadel/mission-control-shared/api/settings";
import { fetchLlamaCppSetup, startLlamaCppRuntime } from "@goatcitadel/mission-control-shared/api/platform";
import type { RuntimeSettingsResponse } from "@goatcitadel/mission-control-shared/api/types";

type SavedRuntime = RuntimeSettingsResponse["llamaCpp"];
export interface LocalRuntimeReview {
  workspaceId: string;
  settingsRevision: number;
  configuration: string;
  endpoint: string;
  modelLabel: string;
  commandLabel: string;
  eligible: boolean;
  reason: string;
}
export interface LocalRuntimeAttempt {
  workspaceId: string;
  settingsRevision: number;
  phase: "checking" | "starting" | "verified" | "uncertain";
  message: string;
}

// Host-wide presentation state survives navigation. It carries no credentials or
// runtime authority; the Gateway owns both the operation and every status read.
let attempt: LocalRuntimeAttempt | undefined;
const listeners = new Set<() => void>();
export const readLocalRuntimeAttempt = () => attempt;
export const subscribeLocalRuntimeAttempt = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
function publish(value: LocalRuntimeAttempt | undefined) {
  attempt = value;
  for (const listener of listeners) listener();
}
export function __resetLocalRuntimeAttemptForTests() {
  publish(undefined);
}
export function localRuntimeActionLocked(value = attempt) {
  return value !== undefined && value.phase !== "verified";
}

function publicEndpoint(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("The saved runtime endpoint cannot be reviewed here. Open Local AI settings.");
  }
  return url.href;
}
const filename = (value: string) => value.split(/[\\/]/).filter(Boolean).at(-1)?.slice(0, 160) ?? "Unavailable";
function configuration(saved: SavedRuntime) {
  const { status: _status, ...config } = saved;
  return canonicalJsonString(config);
}
function assertSettingsEvidence(settings: RuntimeSettingsResponse, setup: LlamaCppSetupProjection) {
  if (
    !Number.isSafeInteger(settings.revision) ||
    settings.revision < 1 ||
    setup.settingsRevision !== settings.revision ||
    !settings.llamaCpp ||
    setup.managementMode !== settings.llamaCpp.managementMode ||
    setup.baseUrl !== settings.llamaCpp.baseUrl ||
    setup.runtime.baseUrl !== settings.llamaCpp.baseUrl ||
    setup.runtime.enabled !== settings.llamaCpp.enabled
  ) {
    throw new Error("The runtime owners returned inconsistent settings evidence. Refresh the review.");
  }
}
function unavailableReason(saved: SavedRuntime, setup: LlamaCppSetupProjection): string | undefined {
  if (!saved.enabled) return "The local runtime is disabled. Review its configuration in Local AI settings.";
  if (setup.managementMode !== "managed") return "External servers must be started through their own process manager.";
  if (setup.pendingPlan) return "A runtime configuration plan is pending. Complete its existing review first.";
  if (!setup.binary.found || !saved.modelPath?.trim())
    return "A saved model and available runtime binary are required. Open Local AI settings.";
  const runtime = setup.runtime;
  if (setup.ownership !== "none" || runtime.leaseDiagnostics?.ownership !== "none" || runtime.pid !== undefined) {
    return "A process is owned or observed, or its ownership is unavailable. Review the current runtime in Local AI settings.";
  }
  if (
    runtime.processState !== "stopped" ||
    runtime.desiredState !== "stopped" ||
    runtime.healthy !== false ||
    runtime.leaseDiagnostics.state !== "idle" ||
    runtime.leaseDiagnostics.activeLeaseCount !== 0
  ) {
    return "Start is available here only for a stopped runtime with no active work. Review the current runtime in Local AI settings.";
  }
  return undefined;
}

/** Reads saved configuration and owner status; it never saves configuration. */
export async function readLocalRuntimeReview(workspaceId: string): Promise<LocalRuntimeReview> {
  if (!workspaceId.trim()) throw new Error("Select a workspace before reviewing the local runtime.");
  const [settings, setup] = await Promise.all([fetchSettings(), fetchLlamaCppSetup(workspaceId)]);
  assertSettingsEvidence(settings, setup);
  const reason = unavailableReason(settings.llamaCpp, setup);
  return {
    workspaceId,
    settingsRevision: settings.revision,
    configuration: configuration(settings.llamaCpp),
    endpoint: publicEndpoint(settings.llamaCpp.baseUrl),
    modelLabel: filename(settings.llamaCpp.modelPath ?? ""),
    commandLabel: filename(setup.binary.label ?? settings.llamaCpp.command),
    eligible: !reason,
    reason: reason ?? "The configured managed runtime is stopped and has no active work.",
  };
}

function assertStartedRuntime(runtime: LlamaCppRuntimeStatus, endpoint: string) {
  if (
    !runtime.enabled ||
    publicEndpoint(runtime.baseUrl) !== endpoint ||
    runtime.desiredState !== "running" ||
    !["starting", "running"].includes(runtime.processState) ||
    typeof runtime.healthy !== "boolean" ||
    (runtime.healthy && runtime.processState !== "running") ||
    runtime.leaseDiagnostics?.ownership !== "owned" ||
    !Number.isSafeInteger(runtime.pid) ||
    runtime.pid! <= 0
  ) {
    throw new Error("A matching owned runtime was not confirmed after the request.");
  }
}

/**
 * The existing Start API has no revision precondition. The before/after checks
 * detect observable drift, but cannot make this operation atomic with settings.
 */
export async function startReviewedLocalRuntime(review: LocalRuntimeReview, isCurrent: () => boolean): Promise<void> {
  if (localRuntimeActionLocked()) throw new Error("A host-wide start is already pending or has an uncertain result.");
  if (!review.eligible) throw new Error("This runtime is not eligible for a start from System Health.");
  const identity = { workspaceId: review.workspaceId, settingsRevision: review.settingsRevision };
  publish({ ...identity, phase: "checking", message: "Rechecking the reviewed runtime configuration…" });
  let submitted = false;
  try {
    const current = await readLocalRuntimeReview(review.workspaceId);
    if (!isCurrent()) throw new Error("The runtime start review is no longer open.");
    if (
      !current.eligible ||
      current.settingsRevision !== review.settingsRevision ||
      current.configuration !== review.configuration ||
      current.endpoint !== review.endpoint ||
      current.commandLabel !== review.commandLabel
    ) {
      throw new Error("The runtime configuration or ownership changed. Refresh and review it again.");
    }
    publish({ ...identity, phase: "starting", message: "The Gateway is starting the saved managed runtime…" });
    submitted = true;
    const response = await startLlamaCppRuntime();
    assertStartedRuntime(response, review.endpoint);
    const [settings, setup] = await Promise.all([fetchSettings(), fetchLlamaCppSetup(review.workspaceId)]);
    assertSettingsEvidence(settings, setup);
    if (
      settings.revision !== review.settingsRevision ||
      configuration(settings.llamaCpp) !== review.configuration ||
      setup.pendingPlan ||
      setup.ownership !== "owned" ||
      setup.runtime.pid !== response.pid
    ) {
      throw new Error("The runtime or configuration changed before startup could be verified.");
    }
    assertStartedRuntime(setup.runtime, review.endpoint);
    publish({
      ...identity,
      phase: "verified",
      message: setup.runtime.healthy
        ? "The Gateway reports that the managed runtime is running and its health probe passed. Chat readiness is a separate check."
        : `The Gateway reports an owned runtime ${setup.runtime.processState}; its health probe has not passed.`,
    });
  } catch (error) {
    if (submitted) {
      publish({
        ...identity,
        phase: "uncertain",
        message:
          "The start request has no verified outcome. Another start is locked here. Review the current runtime in Local AI settings before taking further action.",
      });
    } else {
      publish(undefined);
      throw error;
    }
  }
}
