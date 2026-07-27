// Extracted verbatim from `../../SettingsNativePage.tsx` as part of the
// per-section settings decomposition.
import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Play, RefreshCw, Save } from "lucide-react";
import type {
  DemoBootstrapStateResponse,
  OnboardingState,
  ToolApprovalMode,
  ToolProfile,
} from "@goatcitadel/contracts";
import {
  bootstrapDemo,
  bootstrapOnboarding,
  completeOnboarding,
  fetchAgenticRuns,
  fetchDemoState,
  fetchEvidenceEnvelopes,
  fetchOnboardingState,
  fetchSettings,
  isApiRequestError,
} from "@goatcitadel/mission-control-shared/api/client";
import type { AppRoute } from "@next/app/route-model";
import {
  getErrorMessage,
  type Notice,
  SettingsActionList,
  SettingsButtonRow,
  SettingsField,
  SettingsFieldGrid,
  SettingsGrid,
  type SettingsNativePageProps,
  SettingsNotice,
  type SettingsSectionProps,
  SettingsSectionShell,
  SettingsWizardSteps,
  useAsyncLoad,
} from "../SettingsShared";
import { NativeCard, NativeDisclosureCard, NativeSectionIndex } from "../../NativeRoutePageLayout";
import { ErrorState, NativeButton, NativeMetricGrid } from "../../primitives";
import {
  BUDGET_MODE_OPTIONS,
  buildFirstRunEvidenceSnapshot,
  deriveEcosystemProofLaneItems,
  deriveFirstOutcomePathItems,
  deriveFirstRunGovernedJobState,
  deriveOnboardingProviderSmokeEvidenceItems,
  deriveSetupCenterItems,
  describeBudgetMode,
  describeToolApprovalMode,
  describeToolApprovalModeHelp,
  describeToolProfile,
  describeToolProfileLabel,
  type FirstRunEvidenceSnapshot,
  labelForBudgetMode,
  normalizeBudgetMode,
  normalizeToolApprovalMode,
  normalizeToolProfile,
  setupMeta,
  splitCommaList,
  TOOL_APPROVAL_MODE_OPTIONS,
  TOOL_PROFILE_OPTIONS,
} from "../../SettingsNativePage";

type OnboardingPageState = OnboardingState & {
  runtimeSettings: Awaited<ReturnType<typeof fetchSettings>> | null;
  demoState: DemoBootstrapStateResponse | null;
  firstRunEvidence: FirstRunEvidenceSnapshot;
};

export function OnboardingSection({ route, navigate, setActiveWorkspaceId }: SettingsSectionProps) {
  const load = useCallback(async () => {
    const [onboarding, runtimeSettings, demoState, agenticRuns, evidenceEnvelopes] = await Promise.all([
      fetchOnboardingState(),
      fetchSettings().catch(() => null),
      fetchDemoState().catch(() => null),
      fetchAgenticRuns({ limit: 10 }).catch(() => ({ items: [] })),
      fetchEvidenceEnvelopes({ limit: 10 }).catch(() => ({ items: [] })),
    ]);
    return {
      ...onboarding,
      runtimeSettings,
      demoState,
      firstRunEvidence: buildFirstRunEvidenceSnapshot(agenticRuns.items ?? [], evidenceEnvelopes.items ?? []),
    } satisfies OnboardingPageState;
  }, []);
  const { loading, error, data, reload } = useAsyncLoad(load, [load]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [defaultsDraft, setDefaultsDraft] = useState<{
    defaultToolProfile: ToolProfile;
    toolApprovalMode: ToolApprovalMode;
    budgetMode: OnboardingState["settings"]["budgetMode"];
    networkAllowlist: string;
  }>({
    defaultToolProfile: "standard",
    toolApprovalMode: "approve_risky",
    budgetMode: "balanced",
    networkAllowlist: "",
  });
  const preserveDefaultsDraftRef = useRef(false);

  useEffect(() => {
    if (!data) {
      return;
    }
    if (preserveDefaultsDraftRef.current) {
      preserveDefaultsDraftRef.current = false;
      return;
    }
    setDefaultsDraft({
      defaultToolProfile: normalizeToolProfile(data.settings?.defaultToolProfile),
      toolApprovalMode: normalizeToolApprovalMode(data.settings?.toolApprovalMode),
      budgetMode: normalizeBudgetMode(data.settings?.budgetMode),
      networkAllowlist: data.settings?.networkAllowlist?.join(", ") ?? "",
    });
  }, [data]);

  const onboardingPromptSkippingRestriction = !data?.runtimeSettings
    ? "Settings could not be loaded, so first-run defaults that skip normal prompts stay unavailable."
    : data.runtimeSettings.deploymentProfile === "remote_hardened"
      ? "Remote Hardened keeps first-run defaults that skip normal prompts unavailable."
      : null;

  const applyDefaults = async () => {
    if (!data?.runtimeSettings) {
      setNotice({ tone: "warning", message: "Reload settings before applying first-run defaults." });
      return;
    }
    if (
      onboardingPromptSkippingRestriction &&
      (defaultsDraft.defaultToolProfile === "danger" || defaultsDraft.toolApprovalMode === "bypass")
    ) {
      setNotice({ tone: "warning", message: onboardingPromptSkippingRestriction });
      return;
    }
    try {
      await bootstrapOnboarding({
        expectedRevision: data.runtimeSettings.revision,
        defaultToolProfile: defaultsDraft.defaultToolProfile,
        toolApprovalMode: defaultsDraft.toolApprovalMode,
        budgetMode: defaultsDraft.budgetMode,
        networkAllowlist: splitCommaList(defaultsDraft.networkAllowlist),
        auth: {
          allowLoopbackBypass: false,
        },
      });
      setNotice({ tone: "success", message: "First-run defaults applied." });
      await reload();
    } catch (defaultsError) {
      if (isApiRequestError(defaultsError) && defaultsError.status === 409) {
        preserveDefaultsDraftRef.current = true;
        await reload();
        setNotice({
          tone: "warning",
          message:
            "Onboarding settings changed elsewhere. Your defaults draft is preserved; review the current settings, then apply again to retry.",
        });
        return;
      }
      setNotice({ tone: "error", message: getErrorMessage(defaultsError) });
    }
  };

  const markComplete = async () => {
    try {
      await completeOnboarding("operator");
      setNotice({ tone: "success", message: "Onboarding marked complete." });
      await reload();
    } catch (completeError) {
      setNotice({ tone: "error", message: getErrorMessage(completeError) });
    }
  };

  return (
    <SettingsSectionShell loading={loading} error={error} onRetry={reload}>
      {notice ? <SettingsNotice notice={notice} /> : null}
      {data ? (
        <>
          <NativeSectionIndex
            items={[
              { id: "onboarding-start", label: "Start Here" },
              { id: "onboarding-outcome", label: "Next outcome" },
              { id: "onboarding-setup", label: "Setup progress" },
              { id: "onboarding-first-run", label: "First-run defaults" },
              { id: "onboarding-reference", label: "Reference checks" },
            ]}
          />
          <SettingsGrid variant="detail-wide">
            <DemoStartPanel route={route} navigate={navigate} setActiveWorkspaceId={setActiveWorkspaceId} />
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
                  state: item.status === "complete" ? "complete" : item.status === "optional" ? "pending" : "active",
                }))}
              />
              {data.firstRunChecklist?.length ? (
                <SettingsActionList
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
            <NativeCard
              density="compact"
              className="mc-next-settings-panel"
              title="Apply first-run defaults"
              subtitle="Set the minimum runtime defaults without duplicating advanced setup."
            >
              <SettingsFieldGrid>
                <SettingsField label="Tool profile">
                  <select
                    className="mc-next-settings-input"
                    value={defaultsDraft.defaultToolProfile}
                    onChange={(event) => {
                      const nextProfile = normalizeToolProfile(event.target.value);
                      if (onboardingPromptSkippingRestriction && nextProfile === "danger") {
                        return;
                      }
                      setDefaultsDraft((current) => ({
                        ...current,
                        defaultToolProfile: nextProfile,
                      }));
                    }}
                  >
                    {TOOL_PROFILE_OPTIONS.map((profile) => (
                      <option
                        key={profile}
                        value={profile}
                        disabled={Boolean(onboardingPromptSkippingRestriction && profile === "danger")}
                      >
                        {describeToolProfileLabel(profile)}
                      </option>
                    ))}
                  </select>
                  <p className="mc-next-settings-field-note">{describeToolProfile(defaultsDraft.defaultToolProfile)}</p>
                </SettingsField>
                <SettingsField label="Tool approvals">
                  <select
                    className="mc-next-settings-input"
                    value={defaultsDraft.toolApprovalMode}
                    onChange={(event) => {
                      const nextMode = normalizeToolApprovalMode(event.target.value);
                      if (onboardingPromptSkippingRestriction && nextMode === "bypass") {
                        return;
                      }
                      setDefaultsDraft((current) => ({
                        ...current,
                        toolApprovalMode: nextMode,
                      }));
                    }}
                  >
                    {TOOL_APPROVAL_MODE_OPTIONS.map((mode) => (
                      <option
                        key={mode}
                        value={mode}
                        disabled={Boolean(onboardingPromptSkippingRestriction && mode === "bypass")}
                      >
                        {describeToolApprovalMode(mode)}
                      </option>
                    ))}
                  </select>
                  <p className="mc-next-settings-field-note">
                    {describeToolApprovalModeHelp(defaultsDraft.toolApprovalMode)}
                  </p>
                  {onboardingPromptSkippingRestriction ? (
                    <p className="mc-next-settings-field-note">{onboardingPromptSkippingRestriction}</p>
                  ) : null}
                </SettingsField>
                <SettingsField label="Budget mode">
                  <select
                    className="mc-next-settings-input"
                    value={defaultsDraft.budgetMode}
                    onChange={(event) =>
                      setDefaultsDraft((current) => ({
                        ...current,
                        budgetMode: normalizeBudgetMode(event.target.value),
                      }))
                    }
                  >
                    {BUDGET_MODE_OPTIONS.map((mode) => (
                      <option key={mode} value={mode}>
                        {labelForBudgetMode(mode)}
                      </option>
                    ))}
                  </select>
                  <p className="mc-next-settings-field-note">{describeBudgetMode(defaultsDraft.budgetMode)}</p>
                </SettingsField>
                <SettingsField label="Network allowlist" span={2}>
                  <input
                    className="mc-next-settings-input"
                    value={defaultsDraft.networkAllowlist}
                    onChange={(event) =>
                      setDefaultsDraft((current) => ({ ...current, networkAllowlist: event.target.value }))
                    }
                    placeholder="example.com, api.example.com"
                  />
                </SettingsField>
              </SettingsFieldGrid>
              <NativeMetricGrid
                items={[
                  {
                    label: "Auth",
                    value: data.settings?.auth?.mode ?? "unknown",
                    meta: data.settings?.auth?.tokenConfigured ? "token configured" : "no token configured",
                  },
                  {
                    label: "Mesh",
                    value: data.settings?.mesh?.enabled ? (data.settings?.mesh?.mode ?? "unknown") : "off",
                    meta: data.settings?.mesh?.nodeId || "no node id",
                  },
                ]}
              />
              <SettingsButtonRow>
                <NativeButton variant="default" onClick={() => void applyDefaults()}>
                  <Save size={16} />
                  Apply defaults
                </NativeButton>
                <NativeButton variant="secondary" onClick={() => void markComplete()}>
                  <CheckCircle2 size={16} />
                  Mark complete
                </NativeButton>
                <NativeButton variant="secondary" onClick={() => void reload()}>
                  <RefreshCw size={16} />
                  Refresh
                </NativeButton>
              </SettingsButtonRow>
            </NativeCard>
          </SettingsGrid>
        </>
      ) : null}
    </SettingsSectionShell>
  );
}

function DemoStartPanel({
  route,
  navigate,
  setActiveWorkspaceId,
}: {
  route: AppRoute;
  navigate: SettingsNativePageProps["navigate"];
  setActiveWorkspaceId: (workspaceId: string) => void;
}) {
  const load = useCallback(async () => fetchDemoState(), []);
  const { loading, error, data, reload } = useAsyncLoad(load, [load]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  const startDemo = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const result = await bootstrapDemo();
      if (result.workspace?.workspaceId) {
        setActiveWorkspaceId(result.workspace.workspaceId);
      }
      const nextSession = result.sessions.find((item) => item.mode === "chat") ?? result.sessions[0];
      setNotice({ tone: result.status === "ready" ? "success" : "warning", message: result.notes[0] ?? "Demo ready." });
      await reload();
      navigate({
        area: "chat",
        sessionId: nextSession?.sessionId,
        theme: route.theme,
      });
    } catch (demoError) {
      setNotice({ tone: "error", message: getErrorMessage(demoError) });
    } finally {
      setBusy(false);
    }
  };

  const promptPreview = data?.starterPrompts?.slice(0, 3) ?? [];
  const workspaceLabel = data?.workspace?.name ?? "Not created";

  return (
    <NativeCard
      id="onboarding-start"
      density="compact"
      className="mc-next-settings-panel"
      title="Start Here"
      subtitle="Create a safe local demo workspace with sample Work and memory data."
      stats={[
        { label: "Demo", value: loading ? "Checking" : (data?.status ?? "Unknown") },
        { label: "Workspace", value: workspaceLabel },
        { label: "Credentials", value: "Not required" },
      ]}
    >
      {notice ? <SettingsNotice notice={notice} /> : null}
      {error ? <ErrorState size="inline" description={error} /> : null}
      <SettingsWizardSteps
        steps={[
          {
            label: "Safe demo workspace",
            description: data?.workspace
              ? "Existing demo workspace will be reused."
              : "Creates a local-only workspace with no provider or channel credentials.",
            state: data?.workspace ? "complete" : "active",
          },
          {
            label: "Sample mission",
            description: "Seeds a planning run and build review scenario you can inspect without sending messages.",
            state: data?.sessions?.length ? "complete" : "active",
          },
          {
            label: "Guided context",
            description: "Adds starter prompts and a memory example so Guided mode has something concrete to explain.",
            state: data?.status === "ready" ? "complete" : "pending",
          },
        ]}
      />
      <SettingsActionList
        items={promptPreview.map((prompt) => ({
          id: `${prompt.surface}-${prompt.title}`,
          label: prompt.title,
          description: prompt.prompt,
          meta: prompt.surface,
          actionLabel: "Sample",
        }))}
        emptyLabel="Starter prompts will appear after the demo state loads."
      />
      <SettingsButtonRow>
        <NativeButton variant="default" onClick={() => void startDemo()} disabled={busy}>
          <Play size={16} />
          {data?.status === "ready" ? "Open demo" : "Start safe demo"}
        </NativeButton>
        <NativeButton variant="secondary" onClick={() => void reload()} disabled={busy}>
          <RefreshCw size={16} />
          Refresh
        </NativeButton>
      </SettingsButtonRow>
    </NativeCard>
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
      subtitle="Follow one path from provider readiness to a proof-backed Work result."
      stats={[
        { label: "Path state", value: pathState },
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
        items={items.map((item) => ({
          id: item.id,
          label: item.label,
          description: item.actionDescription,
          meta: item.meta,
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
        items={items.map((item) => ({
          ...item,
          onClick: () => navigate({ ...item.route, theme: route.theme }),
        }))}
        maxHeight=""
      />
    </NativeDisclosureCard>
  );
}
