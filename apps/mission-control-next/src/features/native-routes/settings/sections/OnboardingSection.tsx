import { useDraftLeave } from "../../library/DraftLeaveDialog";
import { FocusedDetail } from "../../shared/FocusedDetail";
// Extracted verbatim from `../../SettingsNativePage.tsx` as part of the
// per-section settings decomposition.
import { useCallback, useEffect, useRef, useState } from "react";
import type { DemoBootstrapStateResponse, OnboardingState } from "@goatcitadel/contracts";
import {
  fetchAgenticRuns,
  fetchDemoState,
  fetchEvidenceEnvelopes,
  fetchOnboardingState,
  fetchSettings,
} from "@goatcitadel/mission-control-shared/api/client";
import type { AppRoute } from "@next/app/route-model";
import {
  getErrorMessage,
  humanizeEnumToken,
  type Notice,
  SettingsActionList,
  SettingsButtonRow,
  type SettingsNativePageProps,
  SettingsNotice,
  type SettingsSectionProps,
  SettingsSectionShell,
  SettingsWizardSteps,
  useAsyncLoad,
} from "../SettingsShared";
import { NativeCard, NativeDisclosureCard } from "../../NativeRoutePageLayout";
import { NativeButton, NativeMetricGrid } from "../../primitives";
import { GuidedModelSetup } from "./GuidedModelSetup";
import { LlamaCppSetupFlow } from "./LlamaCppSetupFlow";
import {
  buildFirstRunEvidenceSnapshot,
  deriveFirstOutcomePathItems,
  deriveFirstRunGovernedJobState,
  type FirstRunEvidenceSnapshot,
} from "../helpers/first-run-evidence";
import {
  deriveEcosystemProofLaneItems,
  deriveOnboardingProviderSmokeEvidenceItems,
  deriveSetupCenterItems,
  setupMeta,
} from "../helpers/onboarding-readiness";
import { useOnboardingCompletion } from "../use-onboarding-completion";

import { useOnboardingDefaults } from "../use-onboarding-defaults";
import { OnboardingDefaultsPanel } from "./OnboardingDefaultsPanel";
import { OnboardingDemoPanel } from "./OnboardingDemoPanel";

type OnboardingPageState = OnboardingState & {
  runtimeSettings: Awaited<ReturnType<typeof fetchSettings>> | null;
  demoState: DemoBootstrapStateResponse | null;
  firstRunEvidence: FirstRunEvidenceSnapshot;
};

export function OnboardingSection(props: SettingsSectionProps) {
  const { route, navigate, activeWorkspaceId } = props;
  const [modelSetup, setModelSetup] = useState<"llamacpp" | "other">(route.view === "llamacpp" ? "llamacpp" : "other");
  const [panel, setPanel] = useState<"defaults" | "verification" | "demo" | null>(null);
  const [evidenceRequested, setEvidenceRequested] = useState(false);
  const leave = useDraftLeave();
  const load = useCallback(async () => {
    const [onboarding, runtimeSettings, demoState, agenticRuns, evidenceEnvelopes] = await Promise.all([
      fetchOnboardingState(),
      fetchSettings().catch(() => null),
      evidenceRequested ? fetchDemoState().catch(() => null) : Promise.resolve(null),
      evidenceRequested ? fetchAgenticRuns({ limit: 10 }).catch(() => ({ items: [] })) : Promise.resolve({ items: [] }),
      evidenceRequested
        ? fetchEvidenceEnvelopes({ limit: 10 }).catch(() => ({ items: [] }))
        : Promise.resolve({ items: [] }),
    ]);
    return {
      ...onboarding,
      runtimeSettings,
      demoState,
      firstRunEvidence: buildFirstRunEvidenceSnapshot(agenticRuns.items ?? [], evidenceEnvelopes.items ?? []),
    } satisfies OnboardingPageState;
  }, [evidenceRequested]);
  const { loading, error, data, reload } = useAsyncLoad(load, [load]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const completion = useOnboardingCompletion({ state: error ? undefined : data ?? undefined, scope: `${activeWorkspaceId}:${panel}` });
  const defaultsOwner = useOnboardingDefaults({ state: error ? undefined : data ?? undefined, runtime: error ? undefined : data?.runtimeSettings ?? undefined,
    workspaceId: activeWorkspaceId, active: panel === "defaults", onSettled: reload });
  const defaults = defaultsOwner.draft;

  const markComplete = async () => {
    try {
      if (!(await completion.complete())) return;
      setNotice({ tone: "success", message: "Onboarding marked complete." });
      await reload();
    } catch (completeError) {
      setNotice({ tone: "error", message: getErrorMessage(completeError) });
    }
  };

  useEffect(() => {
    setPanel(null);
  }, [activeWorkspaceId]);
  useEffect(() => {
    if (route.view === "llamacpp") setModelSetup("llamacpp");
  }, [route.view]);
  const openVerification = () =>
    leave.request(() => {
      setEvidenceRequested(true);
      setPanel("verification");
    });
  const closePanel = () => leave.request(() => setPanel(null));
  const hashAction = useRef(() => {});
  hashAction.current = () => {
    const hash = globalThis.location?.hash;
    if (hash === "#onboarding-start") leave.request(() => setPanel("demo"));
    else if (["#onboarding-later", "#onboarding-reference", "#onboarding-first-run"].includes(hash ?? ""))
      openVerification();
    else if (hash === "#onboarding-defaults") leave.request(() => setPanel("defaults"));
  };
  useEffect(() => {
    const target = () => hashAction.current();
    target();
    globalThis.window?.addEventListener?.("hashchange", target);
    return () => globalThis.window?.removeEventListener?.("hashchange", target);
  }, []);
  return (
    <SettingsSectionShell loading={loading && !data} error={error} onRetry={reload}>
      {notice ? <SettingsNotice notice={notice} /> : null}
      {completion.notice || completion.attempt ? <SettingsNotice notice={{ tone: "warning", message: completion.attempt?.message ?? completion.notice! }} /> : null}
      {data ? (
        <div className="mc-next-settings-stack mc-next-preference-stack">
          {panel === "defaults" ? (
            <FocusedDetail title="First-run defaults" onClose={closePanel}>
              <OnboardingDefaultsPanel control={defaultsOwner} completion={completion} onComplete={markComplete} />
            </FocusedDetail>
          ) : panel === "verification" ? (
            <FocusedDetail title="Setup verification" onClose={closePanel}>
              <div className="mc-next-settings-stack">
                <NativeCard
                  id="onboarding-first-run"
                  density="compact"
                  className="mc-next-settings-panel"
                  title="First-run setup"
                  subtitle="Configured readiness for the first trustworthy send."
                  stats={[
                    { label: "Status", value: data.completed ? "Complete" : "Open" },
                    { label: "Provider", value: data.settings?.llm?.activeProviderId || "Unset" },
                    { label: "Model", value: data.settings?.llm?.activeModel || "Unset" },
                  ]}
                >
                  <SettingsWizardSteps
                    steps={(data.checklist ?? []).map((item) => ({
                      label: item.label,
                      description: item.detail ?? item.status,
                      state:
                        item.status === "complete" ? "complete" : item.status === "optional" ? "pending" : "active",
                    }))}
                  />
                  {data.firstRunChecklist?.length ? (
                    <SettingsActionList
                      ariaLabel="First-run checklist"
                      items={data.firstRunChecklist.map((item) => ({
                        id: item.id,
                        label: item.label,
                        description: item.detail,
                        meta: item.proofRefs.map((ref) => ref.label).join(" · "),
                        actionLabel:
                          item.status === "complete" ? "Ready" : item.status === "optional" ? "Optional" : "Do next",
                      }))}
                      maxHeight=""
                    />
                  ) : null}
                  <SettingsActionList
                    ariaLabel="First-run settings routes"
                    items={[
                      {
                        label: "Configure providers",
                        description: "Select the active provider/model and choose where provider secrets are stored.",
                        onClick: () => navigate({ area: "settings", section: "providers", theme: route.theme }),
                      },
                      {
                        label: "Check local runtimes",
                        description: "Inspect daemon, llama.cpp, NPU, and voice runtime readiness before sending work.",
                        onClick: () => navigate({ area: "settings", section: "runtime", theme: route.theme }),
                      },
                      {
                        label: "Review access",
                        description:
                          "Confirm gateway auth posture, install tokens, and device access before exposing the app.",
                        onClick: () => navigate({ area: "settings", section: "access", theme: route.theme }),
                      },
                    ]}
                  />
                </NativeCard>
                <FirstOutcomePathPanel
                  route={route}
                  navigate={navigate}
                  onboarding={data}
                  demoState={data.demoState}
                  firstRunEvidence={data.firstRunEvidence}
                />
                <ProviderSmokeEvidencePanel route={route} navigate={navigate} onboarding={data} />
                <SetupCenterPanel route={route} navigate={navigate} onboarding={data} />
                {data.setupReadiness ? (
                  <NativeDisclosureCard
                    id="onboarding-reference"
                    title="Remote profile readiness"
                    subtitle="Gateway-owned setup profile for local, LAN, tailnet, and remote-hardened use."
                  >
                    <NativeMetricGrid
                      items={[
                        { label: "Gateway", value: data.setupReadiness.profile?.gatewayUrl ?? "unknown" },
                        { label: "Auth", value: data.setupReadiness.profile?.authMode ?? "unknown" },
                        {
                          label: "Posture",
                          value: (data.setupReadiness.profile?.deploymentPosture ?? "unknown").replaceAll("_", " "),
                        },
                        {
                          label: "Blocked",
                          value: `${data.setupReadiness.summary?.blocked ?? 0} / ${data.setupReadiness.summary?.needsInput ?? 0} input`,
                        },
                      ]}
                    />
                    <SettingsWizardSteps
                      steps={(data.setupReadiness.items ?? []).slice(0, 6).map((item) => ({
                        label: item.label,
                        description: `${item.value}: ${item.detail}`,
                        state:
                          item.status === "ready"
                            ? "complete"
                            : item.status === "blocked"
                              ? "active"
                              : item.status === "needs_input"
                                ? "active"
                                : "pending",
                      }))}
                    />
                    <SettingsActionList
                      ariaLabel="Setup readiness checks"
                      items={(data.setupReadiness.items ?? []).map((item) => ({
                        id: item.id,
                        label: item.label,
                        description: item.detail,
                        meta: `${item.status.replaceAll("_", " ")} · ${item.value}`,
                        actionLabel:
                          item.status === "ready"
                            ? "Ready"
                            : item.status === "blocked"
                              ? "Blocked"
                              : item.status === "needs_input"
                                ? "Needs input"
                                : "Needs proof",
                      }))}
                      maxHeight="min(42vh, 24rem)"
                    />
                  </NativeDisclosureCard>
                ) : null}

                <EcosystemProofLanePanel route={route} navigate={navigate} />
              </div>
            </FocusedDetail>
          ) : panel === "demo" ? (
            <FocusedDetail title="Try a safe demo" onClose={closePanel}>
              <OnboardingDemoPanel {...props} />
            </FocusedDetail>
          ) : (
            <>
              <SettingsButtonRow>
                <NativeButton
                  variant={modelSetup === "llamacpp" ? "default" : "outline"}
                  aria-pressed={modelSetup === "llamacpp"}
                  onClick={() => setModelSetup("llamacpp")}
                >
                  Set up llama.cpp
                </NativeButton>
                <NativeButton
                  variant={modelSetup === "other" ? "default" : "outline"}
                  aria-pressed={modelSetup === "other"}
                  onClick={() => setModelSetup("other")}
                >
                  Other providers
                </NativeButton>
              </SettingsButtonRow>
              {modelSetup === "llamacpp" ? (
                <LlamaCppSetupFlow workspaceId={activeWorkspaceId} route={route} navigate={navigate} />
              ) : (
                <GuidedModelSetup
                  excludeLlamaCpp
                  workspaceId={activeWorkspaceId}
                  onboarding={data}
                  route={route}
                  navigate={navigate}
                  reloadOnboarding={reload}
                  setNotice={setNotice}
                />
              )}

              <SettingsButtonRow>
                <NativeButton variant="secondary" onClick={openVerification}>
                  Verification evidence
                </NativeButton>
                <NativeButton variant="outline" onClick={() => leave.request(() => setPanel("defaults"))}>
                  First-run defaults{defaults.isDirty ? " · Unsaved" : ""}
                </NativeButton>
                <NativeButton variant="outline" onClick={() => leave.request(() => setPanel("demo"))}>
                  Try a safe demo
                </NativeButton>
              </SettingsButtonRow>
            </>
          )}
        </div>
      ) : null}
      {leave.dialog}
    </SettingsSectionShell>
  );
}

function FirstOutcomePathPanel({
  route,
  navigate,
  onboarding,
  demoState,
  firstRunEvidence,
}: {
  route: AppRoute;
  navigate: SettingsNativePageProps["navigate"];
  onboarding: OnboardingState;
  demoState: DemoBootstrapStateResponse | null;
  firstRunEvidence: FirstRunEvidenceSnapshot;
}) {
  const items = deriveFirstOutcomePathItems(onboarding, demoState, firstRunEvidence);
  const completeCount = items.filter((item) => item.state === "complete").length;
  const nextItem = items.find((item) => item.state !== "complete") ?? items[items.length - 1];
  const pathState = deriveFirstRunGovernedJobState(onboarding, demoState, firstRunEvidence);

  return (
    <NativeCard
      id="onboarding-outcome"
      density="compact"
      className="mc-next-settings-panel"
      title="First trusted outcome"
      subtitle="Start with the safe local demo; connect a provider when you are ready for cloud-backed work."
      stats={[
        { label: "Path state", value: humanizeEnumToken(pathState) },
        { label: "Progress", value: `${completeCount}/${items.length}` },
        { label: "Next", value: nextItem?.label ?? "Ready" },
        { label: "Evidence", value: items.at(-1)?.state === "complete" ? "Produced" : "Needed" },
      ]}
    >
      <SettingsWizardSteps
        steps={items.map((item) => ({
          label: item.label,
          description: item.description,
          state: item.state,
        }))}
      />
      <SettingsActionList
        ariaLabel="First trusted outcome routes"
        items={items.map((item) => ({
          id: item.id,
          label: item.label,
          description: item.actionDescription,
          meta: humanizeEnumToken(item.meta),
          actionLabel: item.actionLabel,
          onClick: () => navigate({ ...item.route, theme: route.theme }),
        }))}
        maxHeight=""
      />
    </NativeCard>
  );
}

function ProviderSmokeEvidencePanel({
  route,
  navigate,
  onboarding,
}: {
  route: AppRoute;
  navigate: SettingsNativePageProps["navigate"];
  onboarding: OnboardingState;
}) {
  const items = deriveOnboardingProviderSmokeEvidenceItems(onboarding);
  const completeCount = items.filter((item) => item.state === "complete").length;
  const nextItem = items.find((item) => item.state !== "complete") ?? items.at(-1);

  return (
    <NativeDisclosureCard
      id="onboarding-provider-proof"
      title="Provider smoke evidence"
      subtitle="Configured providers are not release proof until a live smoke lane records pass/fail evidence."
      stats={[
        { label: "State", value: nextItem?.label ?? "Ready" },
        { label: "Complete", value: `${completeCount}/${items.length}` },
        { label: "Live proof", value: items.at(-1)?.state === "complete" ? "Recorded" : "Needed" },
      ]}
    >
      <SettingsWizardSteps
        steps={items.map((item) => ({
          label: item.label,
          description: item.description,
          state: item.state,
        }))}
      />
      <SettingsActionList
        ariaLabel="Provider smoke evidence"
        items={[
          {
            id: "provider-smoke-settings",
            label: "Provider diagnostics",
            description: "Review the active provider, model, credential source, and diagnostics before a live smoke.",
            meta: "Configured state",
            actionLabel: "Open providers",
            onClick: () => navigate({ area: "settings", section: "providers", theme: route.theme }),
          },
          {
            id: "provider-smoke-live-proof",
            label: "Live provider proof lane",
            description:
              "Run pnpm verify:install with GOATCITADEL_VERIFY_INSTALL_LIVE_PROVIDER=1 and real credentials to produce release pass/fail evidence.",
            meta: "Fresh credentials required",
            actionLabel: "Manual lane",
          },
        ]}
        maxHeight=""
      />
    </NativeDisclosureCard>
  );
}

function SetupCenterPanel({
  route,
  navigate,
  onboarding,
}: {
  route: AppRoute;
  navigate: SettingsNativePageProps["navigate"];
  onboarding: OnboardingState;
}) {
  const items = deriveSetupCenterItems(onboarding);
  const readyCount = items.filter((item) => item.state === "complete").length;
  const needsInputCount = items.filter((item) => item.state === "active").length;

  return (
    <NativeCard
      id="onboarding-setup"
      density="compact"
      className="mc-next-settings-panel"
      title="Setup Center"
      subtitle="One checklist for providers, local runtimes, channels, tools, database posture, and packaging readiness."
      stats={[
        { label: "Ready", value: String(readyCount) },
        { label: "Needs input", value: String(needsInputCount) },
        { label: "Mode", value: onboarding.completed ? "Complete" : "Guided" },
      ]}
    >
      <SettingsWizardSteps steps={items.map(({ label, description, state }) => ({ label, description, state }))} />
      <SettingsActionList
        ariaLabel="Setup Center routes"
        items={[
          {
            label: "Provider connection checks",
            description: "Check configured model providers and exact key/source status.",
            meta: setupMeta(onboarding.checklist?.find((item) => item.id === "llm")?.status),
            onClick: () => navigate({ area: "settings", section: "providers", theme: route.theme }),
          },
          {
            label: "Runtime health",
            description: "Check daemon, database, llama.cpp, NPU, voice, and local runtime readiness.",
            meta: setupMeta(onboarding.checklist?.find((item) => item.id === "runtime")?.status),
            onClick: () => navigate({ area: "settings", section: "runtime", theme: route.theme }),
          },
          {
            label: "Channels and MCP",
            description: "Configure Slack, Telegram, Discord, MCP servers, and tool access from one path.",
            meta: "Optional until connected",
            onClick: () => navigate({ area: "settings", section: "channels", theme: route.theme }),
          },
          {
            label: "Capabilities",
            description: "Inspect skills, tools, providers, generated candidates, and degraded capabilities.",
            meta: "Catalog view",
            onClick: () => navigate({ area: "library", section: "capabilities", theme: route.theme }),
          },
        ]}
      />
    </NativeCard>
  );
}

function EcosystemProofLanePanel({
  route,
  navigate,
}: {
  route: AppRoute;
  navigate: SettingsNativePageProps["navigate"];
}) {
  const items = deriveEcosystemProofLaneItems();

  return (
    <NativeDisclosureCard
      id="onboarding-ecosystem-proof"
      title="Ecosystem proof lanes"
      subtitle="Follow-on setup order for ecosystem claims; blocked lanes stay explicit until a named proof lane passes."
      stats={[
        { label: "First", value: items[0]?.label ?? "None" },
        { label: "Lanes", value: String(items.length) },
        { label: "Claims", value: "Proof-gated" },
      ]}
    >
      <SettingsActionList
        ariaLabel="Ecosystem proof routes"
        items={items.map((item) => ({
          ...item,
          onClick: () => navigate({ ...item.route, theme: route.theme }),
        }))}
        maxHeight=""
      />
    </NativeDisclosureCard>
  );
}
