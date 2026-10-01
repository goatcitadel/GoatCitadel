import type {
  AgenticRunListItem,
  DemoBootstrapStateResponse,
  EvidenceEnvelope,
  OnboardingState,
} from "@goatcitadel/contracts";
import type { AppRoute } from "@next/app/route-model";
import type { SettingsWizardStepState } from "../SettingsShared";
import { isLikelyLocalProviderBaseUrl } from "./provider-format";
import { describeProviderReadinessFailure } from "./onboarding-readiness";

export type FirstRunEvidenceSnapshot = {
  recentRuns: AgenticRunListItem[];
  evidenceEnvelopes: EvidenceEnvelope[];
};

export function buildFirstRunEvidenceSnapshot(
  recentRuns: AgenticRunListItem[],
  evidenceEnvelopes: EvidenceEnvelope[],
): FirstRunEvidenceSnapshot {
  const runIds = new Set(recentRuns.map((run) => run.runId).filter((runId): runId is string => Boolean(runId)));
  return {
    recentRuns,
    evidenceEnvelopes: evidenceEnvelopes.filter((envelope) => {
      if (!envelope.runId) {
        return false;
      }
      return runIds.size === 0 || runIds.has(envelope.runId);
    }),
  };
}

type FirstOutcomePathItem = {
  id: string;
  label: string;
  description: string;
  actionDescription: string;
  state: SettingsWizardStepState;
  meta: string;
  actionLabel: string;
  route: AppRoute;
};

export type FirstRunGovernedJobState =
  | "provider-ready"
  | "provider-missing"
  | "demo/local"
  | "first-task-pending"
  | "proof-complete";

export function deriveFirstOutcomePathItems(
  onboarding: OnboardingState,
  demoState: DemoBootstrapStateResponse | null,
  firstRunEvidence: FirstRunEvidenceSnapshot = EMPTY_FIRST_RUN_EVIDENCE,
): FirstOutcomePathItem[] {
  const llmSettings = onboarding.settings?.llm;
  const activeProvider = (llmSettings?.providers ?? []).find(
    (provider) => provider.providerId === llmSettings?.activeProviderId,
  );
  const activeModel = (llmSettings?.activeModel ?? "").trim();
  const localEndpointReady = Boolean(activeProvider && isLikelyLocalProviderBaseUrl(activeProvider.baseUrl));
  const cloudProviderReady = Boolean(activeProvider?.hasApiKey);
  const providerCredentialReady = Boolean(activeProvider && (cloudProviderReady || localEndpointReady));
  const providerConnected = Boolean(activeProvider && activeModel && providerCredentialReady);
  const providerNeedsModelSelection = providerCredentialReady && !providerConnected;
  const demoSessions = demoState?.sessions ?? [];
  const demoTasks = demoState?.tasks ?? [];
  const demoReady = demoState?.status === "ready";
  const hasChatStart = demoSessions.some((session) => session.mode === "chat");
  const hasLegacyWorkStart = demoSessions.some((session) => session.mode === "cowork" || session.mode === "code");
  const hasSeededStartContext = Boolean(demoTasks.length > 0 || hasChatStart || hasLegacyWorkStart);
  const providerFailure = describeProviderReadinessFailure(onboarding);
  const latestProof = firstRunEvidence.evidenceEnvelopes[0];
  const proofRun = findRunForEvidence(firstRunEvidence.recentRuns, latestProof);
  const proofRoute = routeForFirstRunEvidence(proofRun, latestProof);
  const firstTaskRun = findFirstRunTaskCandidate(firstRunEvidence.recentRuns, demoSessions, demoTasks);
  const firstTaskSession = pickFirstRunDemoSession(demoSessions);
  const firstTaskRoute = routeForFirstTask(firstTaskRun, firstTaskSession);
  const firstTaskActionLabel = firstTaskRun?.runId ? "Open Run Detail" : firstTaskSession ? "Open Chat" : "Open Chat";

  return [
    {
      id: "provider-ready",
      label: "Provider-ready path",
      description: providerConnected
        ? `${activeProvider?.label ?? llmSettings?.activeProviderId} is selected with ${activeModel}; risky actions still stay approval-governed.`
        : providerFailure,
      actionDescription: "Open Providers & Models to choose a provider, model, secret source, or local endpoint.",
      state: providerConnected ? "complete" : providerNeedsModelSelection ? "active" : "pending",
      meta: providerConnected ? "provider-ready" : "provider-missing",
      actionLabel: "Configure",
      route: { area: "settings", section: "providers" },
    },
    {
      id: "provider-missing",
      label: "Provider missing fallback",
      description:
        providerCredentialReady || demoReady
          ? "The fallback remains available for local inspection without provider credentials."
          : "No provider or local endpoint is configured. Use the safe demo/local path before cloud-backed sends.",
      actionDescription:
        "Start or reopen the safe local demo path; it seeds inspectable data and does not send work to a cloud provider.",
      state: providerCredentialReady || !demoReady ? "pending" : "complete",
      meta: providerCredentialReady ? "provider-ready" : "provider-missing",
      actionLabel: "Start demo/local",
      route: { area: "settings", section: "onboarding" },
    },
    {
      id: "demo-local",
      label: "Demo/local path",
      description:
        demoReady || localEndpointReady
          ? "A demo workspace or local endpoint is available for truthful first-run inspection."
          : "Start the safe demo or configure a local OpenAI-compatible endpoint when no provider key is available.",
      actionDescription: "Open the local-first path for sample Work, memory, and project context.",
      state: demoReady || localEndpointReady ? "complete" : providerCredentialReady ? "pending" : "active",
      meta: "demo/local",
      actionLabel: demoReady ? "Open demo" : "Start demo",
      route: { area: "settings", section: "onboarding" },
    },
    {
      id: "first-task-pending",
      label: "First Work task",
      description: firstTaskRun
        ? "A recent durable run exists; inspect Run Detail before treating proof as complete."
        : firstTaskSession
          ? "A safe demo Chat thread exists; open it and run the first supervised task from seeded context."
          : hasSeededStartContext
            ? "Starter context exists; run a governed Work task before treating this step as complete."
            : "Create the first low-risk Work task after provider/local readiness is explicit.",
      actionDescription: firstTaskRun
        ? "Open the durable run detail projection for timeline, approvals, tools, artifacts, and remaining proof gaps."
        : firstTaskSession
          ? "Open the seeded demo thread; it is local/sample context and does not count as proof until a run records evidence."
          : "Open Work for the first supervised task, then choose Conversation, Plan, or Build posture.",
      state: firstTaskRun
        ? "complete"
        : !providerNeedsModelSelection && (providerConnected || demoReady || localEndpointReady)
          ? "active"
          : "pending",
      meta: firstTaskRun ? "recent-run-found" : hasSeededStartContext ? "starter-ready" : "first-task-pending",
      actionLabel: firstTaskActionLabel,
      route: firstTaskRoute,
    },
    {
      id: "proof-complete",
      label: "Proof artifact or trace",
      description: latestProof
        ? `Evidence envelope ${shortEvidenceId(latestProof.envelopeId)} records ${latestProof.eventKind}${
            latestProof.runId ? ` for run ${shortEvidenceId(latestProof.runId)}` : ""
          }.`
        : "No proof artifact or trace is recorded yet. A first-run task is not complete until evidence exists.",
      actionDescription: latestProof
        ? "Open the linked run surface and use Run details or artifacts to inspect retained evidence."
        : "Open generated artifacts or the Work proof panel after a governed task records evidence.",
      state: latestProof ? "complete" : firstTaskRun ? "active" : "pending",
      meta: latestProof ? "proof-complete" : "proof-needed",
      actionLabel: latestProof ? "Open Run Detail" : "Inspect proof",
      route: latestProof ? proofRoute : { area: "library", section: "artifacts" },
    },
  ];
}

const EMPTY_FIRST_RUN_EVIDENCE: FirstRunEvidenceSnapshot = {
  recentRuns: [],
  evidenceEnvelopes: [],
};

export function deriveFirstRunGovernedJobState(
  onboarding: OnboardingState,
  demoState: DemoBootstrapStateResponse | null,
  firstRunEvidence: FirstRunEvidenceSnapshot = EMPTY_FIRST_RUN_EVIDENCE,
): FirstRunGovernedJobState {
  if (firstRunEvidence.evidenceEnvelopes.length > 0) {
    return "proof-complete";
  }
  const llmSettings = onboarding.settings?.llm;
  const activeProvider = (llmSettings?.providers ?? []).find(
    (provider) => provider.providerId === llmSettings?.activeProviderId,
  );
  const activeModel = (llmSettings?.activeModel ?? "").trim();
  const providerReady = Boolean(
    activeProvider && activeModel && (activeProvider.hasApiKey || isLikelyLocalProviderBaseUrl(activeProvider.baseUrl)),
  );
  const demoReady = demoState?.status === "ready";
  const taskStarted = firstRunEvidence.recentRuns.length > 0;
  if (taskStarted && (providerReady || demoReady)) {
    return "first-task-pending";
  }
  if (activeProvider && activeModel && isLikelyLocalProviderBaseUrl(activeProvider.baseUrl)) {
    return "demo/local";
  }
  if (providerReady) {
    return "provider-ready";
  }
  return demoReady ? "demo/local" : "provider-missing";
}

function findRunForEvidence(runs: AgenticRunListItem[], evidence: EvidenceEnvelope | undefined) {
  if (!evidence?.runId) {
    return undefined;
  }
  return runs.find((run) => run.runId === evidence.runId);
}

function findFirstRunTaskCandidate(
  runs: AgenticRunListItem[],
  sessions: DemoBootstrapStateResponse["sessions"][number][],
  tasks: DemoBootstrapStateResponse["tasks"],
) {
  const sessionIds = new Set(sessions.map((session) => session.sessionId).filter(Boolean));
  const taskIds = new Set(tasks.map((task) => task.taskId).filter(Boolean));
  return (
    runs.find((run) => run.parentSessionId && sessionIds.has(run.parentSessionId)) ??
    runs.find((run) => run.taskId && taskIds.has(run.taskId)) ??
    runs[0]
  );
}

function pickFirstRunDemoSession(sessions: DemoBootstrapStateResponse["sessions"][number][]) {
  return sessions.find((session) => session.mode === "chat") ?? sessions[0];
}

function routeForFirstTask(
  run: AgenticRunListItem | undefined,
  session: DemoBootstrapStateResponse["sessions"][number] | undefined,
): AppRoute {
  if (run?.runId) {
    const route: AppRoute = { area: "ops", section: "sessions", view: "run-detail", runId: run.runId };
    if (run.parentSessionId) {
      route.sessionId = run.parentSessionId;
    }
    return route;
  }
  if (session) {
    return {
      area: "chat",
      sessionId: session.sessionId,
      ...(session.projectId ? { projectId: session.projectId } : {}),
    };
  }
  return { area: "chat" };
}

function routeForFirstRunEvidence(
  run: AgenticRunListItem | undefined,
  evidence: EvidenceEnvelope | undefined,
): AppRoute {
  const runId = evidence?.runId ?? run?.runId;
  if (runId) {
    const route: AppRoute = { area: "ops", section: "sessions", view: "run-detail", runId };
    if (run?.parentSessionId) {
      route.sessionId = run.parentSessionId;
    }
    return route;
  }
  return { area: "ops", section: "sessions" };
}

function shortEvidenceId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}...` : value;
}
