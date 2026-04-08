/* eslint-disable max-lines */
import { useEffect, useState } from "react";
import {
  exportBrowserProofLaneDraft,
  exportCompanionBootstrapBrief,
  exportExtensionStarterPack,
  exportExtensionSdkBrief,
  exportPackagingProofLaneDraft,
  exportVoiceProofLaneDraft,
  exportA2UIProofLaneDraft,
  fetchA2UIProofLaneDraft,
  fetchBrowserProofLaneDraft,
  fetchDaemonLogs,
  fetchDaemonStatus,
  fetchExtensionStarterPack,
  fetchExtensionSdkBrief,
  fetchFollowOnParityReport,
  fetchOpenclawParityReport,
  fetchPackagingProofLaneDraft,
  fetchVoiceProofLaneDraft,
  fetchSystemVitals,
  restartDaemon,
  startDaemon,
  stopDaemon,
  type BrowserProofLaneDraft,
  type ExtensionStarterPackArtifactRecord,
  type ExtensionStarterPackDraft,
  type ExtensionSdkBriefDraft,
  type FollowOnParityReport,
  type FollowOnProofLaneArtifactRecord,
  type OpenclawParityProgramReport,
  type PackagingProofLaneDraft,
  type A2UIProofLaneDraft,
  type VoiceProofLaneDraft,
  type SystemVitalsResponse,
} from "../api/client";
import { ActionButton } from "../components/ActionButton";
import { FieldHelp } from "../components/FieldHelp";
import { HelpHint } from "../components/HelpHint";
import { PageGuideCard } from "../components/PageGuideCard";
import { PageHeader } from "../components/PageHeader";
import { Panel } from "../components/Panel";
import { StatusChip } from "../components/StatusChip";
import { pageCopy } from "../content/copy";
import {
  buildUiArtifactStatus,
  buildUiProfileArtifactStatus,
  normalizeA2UIProofLaneDraft,
  normalizeBrowserProofLaneDraft,
  normalizeExtensionSdkBriefDraft,
  normalizeExtensionStarterPackDraft,
  normalizeFollowOnParityReport,
  normalizeOpenclawParityProgramReport,
  normalizePackagingProofLaneDraft,
  normalizeSystemVitals,
  normalizeVoiceProofLaneDraft,
} from "./system-page-normalizers";
import {
  formatArtifactStatus,
  formatBytes,
  formatProgramBlockerKind,
  formatProofArtifactStatus,
  mapParityTone,
  mapProgramParityTone,
} from "./system/system-page-helpers";

export function SystemPage() {
  const [vitals, setVitals] = useState<SystemVitalsResponse | null>(null);
  const [openclawParity, setOpenclawParity] = useState<OpenclawParityProgramReport | null>(null);
  const [openclawParityError, setOpenclawParityError] = useState<string | null>(null);
  const [followOnParity, setFollowOnParity] = useState<FollowOnParityReport | null>(null);
  const [followOnParityError, setFollowOnParityError] = useState<string | null>(null);
  const [browserProofLane, setBrowserProofLane] = useState<BrowserProofLaneDraft | null>(null);
  const [browserProofLaneError, setBrowserProofLaneError] = useState<string | null>(null);
  const [browserProofLaneBusy, setBrowserProofLaneBusy] = useState(false);
  const [browserProofArtifactError, setBrowserProofArtifactError] = useState<string | null>(null);
  const [browserProofArtifactBusy, setBrowserProofArtifactBusy] = useState(false);
  const [voiceProofLane, setVoiceProofLane] = useState<VoiceProofLaneDraft | null>(null);
  const [voiceProofLaneError, setVoiceProofLaneError] = useState<string | null>(null);
  const [voiceProofLaneBusy, setVoiceProofLaneBusy] = useState(false);
  const [voiceProofArtifactError, setVoiceProofArtifactError] = useState<string | null>(null);
  const [voiceProofArtifactBusy, setVoiceProofArtifactBusy] = useState(false);
  const [a2uiProofLane, setA2UIProofLane] = useState<A2UIProofLaneDraft | null>(null);
  const [a2uiProofLaneError, setA2UIProofLaneError] = useState<string | null>(null);
  const [a2uiProofLaneBusy, setA2UIProofLaneBusy] = useState(false);
  const [a2uiProofArtifactError, setA2UIProofArtifactError] = useState<string | null>(null);
  const [a2uiProofArtifactBusy, setA2UIProofArtifactBusy] = useState(false);
  const [packagingProofLane, setPackagingProofLane] = useState<PackagingProofLaneDraft | null>(null);
  const [packagingProofLaneError, setPackagingProofLaneError] = useState<string | null>(null);
  const [packagingProofLaneBusy, setPackagingProofLaneBusy] = useState(false);
  const [packagingProofArtifactError, setPackagingProofArtifactError] = useState<string | null>(null);
  const [packagingProofArtifactBusy, setPackagingProofArtifactBusy] = useState(false);
  const [companionBriefArtifactError, setCompanionBriefArtifactError] = useState<string | null>(null);
  const [companionBriefArtifactBusy, setCompanionBriefArtifactBusy] = useState(false);
  const [extensionBrief, setExtensionBrief] = useState<ExtensionSdkBriefDraft | null>(null);
  const [extensionBriefError, setExtensionBriefError] = useState<string | null>(null);
  const [extensionBriefBusy, setExtensionBriefBusy] = useState(false);
  const [extensionBriefArtifactError, setExtensionBriefArtifactError] = useState<string | null>(null);
  const [extensionBriefArtifactBusy, setExtensionBriefArtifactBusy] = useState(false);
  const [extensionStarterPack, setExtensionStarterPack] = useState<ExtensionStarterPackDraft | null>(null);
  const [extensionStarterPackError, setExtensionStarterPackError] = useState<string | null>(null);
  const [extensionStarterPackBusy, setExtensionStarterPackBusy] = useState(false);
  const [extensionStarterPackArtifact, setExtensionStarterPackArtifact] =
    useState<ExtensionStarterPackArtifactRecord | null>(null);
  const [extensionStarterPackArtifactError, setExtensionStarterPackArtifactError] = useState<string | null>(null);
  const [extensionStarterPackArtifactBusy, setExtensionStarterPackArtifactBusy] = useState(false);
  const [daemonStatus, setDaemonStatus] = useState<Awaited<ReturnType<typeof fetchDaemonStatus>> | null>(null);
  const [daemonLogs, setDaemonLogs] = useState<
    Array<{ timestamp: string; level: "info" | "warn" | "error"; message: string }>
  >([]);
  const [daemonBusy, setDaemonBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshDaemon = async () => {
    const [status, logs] = await Promise.all([fetchDaemonStatus(), fetchDaemonLogs(100)]);
    setDaemonStatus(status);
    setDaemonLogs(logs.items);
  };

  const mergeLatestArtifact = (artifact: FollowOnProofLaneArtifactRecord) => {
    setFollowOnParity((current) => {
      if (!current) {
        return current;
      }
      switch (artifact.laneId) {
        case "browser":
          return {
            ...current,
            browser: {
              ...current.browser,
              latestArtifact: artifact,
              artifactStatus: buildUiProfileArtifactStatus(current.generatedAt, current.deploymentProfile, artifact),
            },
          };
        case "packaging":
          return {
            ...current,
            packaging: {
              ...current.packaging,
              latestArtifact: artifact,
              proofStatus: buildUiProfileArtifactStatus(current.generatedAt, current.deploymentProfile, artifact),
            },
          };
        case "a2ui":
          return {
            ...current,
            canvas: {
              ...current.canvas,
              latestArtifact: artifact,
              artifactStatus: buildUiProfileArtifactStatus(current.generatedAt, current.deploymentProfile, artifact),
            },
          };
        case "voice":
          return {
            ...current,
            voice: {
              ...current.voice,
              latestArtifact: artifact,
              artifactStatus: buildUiProfileArtifactStatus(current.generatedAt, current.deploymentProfile, artifact),
            },
          };
        case "companion":
          return {
            ...current,
            companion: {
              ...current.companion,
              latestArtifact: artifact,
              artifactStatus: buildUiArtifactStatus(current.generatedAt, artifact),
            },
          };
        case "extensions":
          return {
            ...current,
            plugins: {
              ...current.plugins,
              latestArtifact: artifact,
              artifactStatus: buildUiArtifactStatus(current.generatedAt, artifact),
            },
          };
        default:
          return current;
      }
    });
  };

  const loadBrowserProofLane = async () => {
    setBrowserProofLaneBusy(true);
    try {
      const draft = await fetchBrowserProofLaneDraft();
      setBrowserProofLane(normalizeBrowserProofLaneDraft(draft));
      setBrowserProofLaneError(null);
    } catch (err) {
      setBrowserProofLaneError((err as Error).message);
    } finally {
      setBrowserProofLaneBusy(false);
    }
  };

  const saveBrowserProofLane = async () => {
    setBrowserProofArtifactBusy(true);
    try {
      const artifact = await exportBrowserProofLaneDraft();
      mergeLatestArtifact(artifact);
      setBrowserProofArtifactError(null);
    } catch (err) {
      setBrowserProofArtifactError((err as Error).message);
    } finally {
      setBrowserProofArtifactBusy(false);
    }
  };

  const loadPackagingProofLane = async () => {
    setPackagingProofLaneBusy(true);
    try {
      const draft = await fetchPackagingProofLaneDraft();
      setPackagingProofLane(normalizePackagingProofLaneDraft(draft));
      setPackagingProofLaneError(null);
    } catch (err) {
      setPackagingProofLaneError((err as Error).message);
    } finally {
      setPackagingProofLaneBusy(false);
    }
  };

  const savePackagingProofLane = async () => {
    setPackagingProofArtifactBusy(true);
    try {
      const artifact = await exportPackagingProofLaneDraft();
      mergeLatestArtifact(artifact);
      setPackagingProofArtifactError(null);
    } catch (err) {
      setPackagingProofArtifactError((err as Error).message);
    } finally {
      setPackagingProofArtifactBusy(false);
    }
  };

  const loadVoiceProofLane = async () => {
    setVoiceProofLaneBusy(true);
    try {
      const draft = await fetchVoiceProofLaneDraft();
      setVoiceProofLane(normalizeVoiceProofLaneDraft(draft));
      setVoiceProofLaneError(null);
    } catch (err) {
      setVoiceProofLaneError((err as Error).message);
    } finally {
      setVoiceProofLaneBusy(false);
    }
  };

  const saveVoiceProofLane = async () => {
    setVoiceProofArtifactBusy(true);
    try {
      const artifact = await exportVoiceProofLaneDraft();
      mergeLatestArtifact(artifact);
      setVoiceProofArtifactError(null);
    } catch (err) {
      setVoiceProofArtifactError((err as Error).message);
    } finally {
      setVoiceProofArtifactBusy(false);
    }
  };

  const loadA2UIProofLane = async () => {
    setA2UIProofLaneBusy(true);
    try {
      const draft = await fetchA2UIProofLaneDraft();
      setA2UIProofLane(normalizeA2UIProofLaneDraft(draft));
      setA2UIProofLaneError(null);
    } catch (err) {
      setA2UIProofLaneError((err as Error).message);
    } finally {
      setA2UIProofLaneBusy(false);
    }
  };

  const saveA2UIProofLane = async () => {
    setA2UIProofArtifactBusy(true);
    try {
      const artifact = await exportA2UIProofLaneDraft();
      mergeLatestArtifact(artifact);
      setA2UIProofArtifactError(null);
    } catch (err) {
      setA2UIProofArtifactError((err as Error).message);
    } finally {
      setA2UIProofArtifactBusy(false);
    }
  };

  const saveCompanionBootstrapBrief = async () => {
    setCompanionBriefArtifactBusy(true);
    try {
      const artifact = await exportCompanionBootstrapBrief();
      mergeLatestArtifact(artifact);
      setCompanionBriefArtifactError(null);
    } catch (err) {
      setCompanionBriefArtifactError((err as Error).message);
    } finally {
      setCompanionBriefArtifactBusy(false);
    }
  };

  const loadExtensionSdkBrief = async () => {
    setExtensionBriefBusy(true);
    try {
      const draft = await fetchExtensionSdkBrief();
      setExtensionBrief(normalizeExtensionSdkBriefDraft(draft));
      setExtensionBriefError(null);
    } catch (err) {
      setExtensionBriefError((err as Error).message);
    } finally {
      setExtensionBriefBusy(false);
    }
  };

  const saveExtensionSdkBrief = async () => {
    setExtensionBriefArtifactBusy(true);
    try {
      const artifact = await exportExtensionSdkBrief();
      mergeLatestArtifact(artifact);
      setExtensionBriefArtifactError(null);
    } catch (err) {
      setExtensionBriefArtifactError((err as Error).message);
    } finally {
      setExtensionBriefArtifactBusy(false);
    }
  };

  const loadExtensionStarterPack = async () => {
    setExtensionStarterPackBusy(true);
    try {
      const draft = await fetchExtensionStarterPack();
      setExtensionStarterPack(normalizeExtensionStarterPackDraft(draft));
      setExtensionStarterPackError(null);
    } catch (err) {
      setExtensionStarterPackError((err as Error).message);
    } finally {
      setExtensionStarterPackBusy(false);
    }
  };

  const saveExtensionStarterPack = async () => {
    setExtensionStarterPackArtifactBusy(true);
    try {
      const artifact = await exportExtensionStarterPack();
      setExtensionStarterPackArtifact(artifact);
      setExtensionStarterPackArtifactError(null);
    } catch (err) {
      setExtensionStarterPackArtifactError((err as Error).message);
    } finally {
      setExtensionStarterPackArtifactBusy(false);
    }
  };

  useEffect(() => {
    void Promise.all([fetchSystemVitals(), fetchDaemonStatus(), fetchDaemonLogs(100)])
      .then(([nextVitals, nextDaemonStatus, nextDaemonLogs]) => {
        setVitals(normalizeSystemVitals(nextVitals));
        setDaemonStatus(nextDaemonStatus);
        setDaemonLogs(nextDaemonLogs.items);
      })
      .catch((err: Error) => setError(err.message));
    void fetchFollowOnParityReport()
      .then((report) => {
        setFollowOnParity(normalizeFollowOnParityReport(report));
        setFollowOnParityError(null);
      })
      .catch((err: Error) => setFollowOnParityError(err.message));
    void fetchOpenclawParityReport()
      .then((report) => {
        setOpenclawParity(normalizeOpenclawParityProgramReport(report));
        setOpenclawParityError(null);
      })
      .catch((err: Error) => setOpenclawParityError(err.message));
    void loadBrowserProofLane();
    void loadVoiceProofLane();
    void loadA2UIProofLane();
    void loadPackagingProofLane();
    void loadExtensionSdkBrief();
    void loadExtensionStarterPack();
  }, []);

  const daemonStateTone = daemonStatus?.running ? "success" : "warning";
  const daemonControlSupported = daemonStatus?.controllable ?? false;

  if (error) {
    return (
      <section className="workflow-page">
        <PageHeader
          eyebrow="Observability"
          title={pageCopy.system.title}
          subtitle={pageCopy.system.subtitle}
          hint="Inspect local runtime health, daemon lifecycle, and recent service events from one place."
        />
        <p className="error">{error}</p>
      </section>
    );
  }

  if (!vitals) {
    return (
      <section className="workflow-page">
        <PageHeader
          eyebrow="Observability"
          title={pageCopy.system.title}
          subtitle={pageCopy.system.subtitle}
          hint="Inspect local runtime health, daemon lifecycle, and recent service events from one place."
        />
        <p>Loading system vitals...</p>
      </section>
    );
  }

  const onDaemonStart = async () => {
    setDaemonBusy(true);
    try {
      const response = await startDaemon();
      setDaemonStatus(response.status);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDaemonBusy(false);
    }
  };

  const onDaemonStop = async () => {
    setDaemonBusy(true);
    try {
      const response = await stopDaemon();
      setDaemonStatus(response.status);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDaemonBusy(false);
    }
  };

  const onDaemonRestart = async () => {
    setDaemonBusy(true);
    try {
      const response = await restartDaemon();
      setDaemonStatus(response.status);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDaemonBusy(false);
    }
  };

  return (
    <section className="workflow-page">
      <PageHeader
        eyebrow="Observability"
        title={pageCopy.system.title}
        subtitle={pageCopy.system.subtitle}
        hint="Use this surface when you need to confirm local runtime health, inspect the current gateway process, or review recent service events."
        actions={
          <div className="workflow-summary-strip">
            <StatusChip tone="muted">
              {vitals.platform} {vitals.release}
            </StatusChip>
            <StatusChip tone={daemonStateTone}>{daemonStatus?.state ?? "unknown"}</StatusChip>
            <StatusChip tone={daemonStateTone}>
              {daemonStatus?.running ? "Gateway process running" : "Gateway process unavailable"}
            </StatusChip>
          </div>
        }
      />
      <PageGuideCard
        pageId="system"
        what={pageCopy.system.guide?.what ?? ""}
        when={pageCopy.system.guide?.when ?? ""}
        actions={pageCopy.system.guide?.actions ?? []}
      />
      <div className="workflow-status-stack">
        <FieldHelp>
          This page reports the live gateway process. Process lifecycle control must happen in your external service
          manager; Mission Control cannot start or stop the process directly.
        </FieldHelp>
      </div>
      <div className="metric-grid">
        <Panel title="Host Vitals" subtitle="Local machine and process health at a glance." className="stat-card">
          <p className="stat-card-value">{Math.round(vitals.uptimeSeconds)}s</p>
          <p className="stat-card-note">Uptime</p>
          <p className="stat-card-note">
            Hostname {vitals.hostname} · {vitals.cpuCount} cores
          </p>
        </Panel>
        <Panel title="Load Average" subtitle="Three-sample host load average." className="stat-card">
          <p className="stat-card-value system-stat-mono">{vitals.loadAverage.map((n) => n.toFixed(2)).join(" / ")}</p>
          <p className="stat-card-note">1m / 5m / 15m load</p>
        </Panel>
        <Panel title="Memory" subtitle="Host and process memory use." className="stat-card">
          <p className="stat-card-value">{formatBytes(vitals.memoryUsedBytes)}</p>
          <p className="stat-card-note">of {formatBytes(vitals.memoryTotalBytes)} host memory</p>
          <p className="stat-card-note">Process RSS {formatBytes(vitals.processRssBytes)}</p>
        </Panel>
      </div>
      <Panel
        title="OpenClaw Parity"
        subtitle={
          <>
            Track the full parity closeout program while keeping browser, canvas, deployment, companion, plugin, and
            voice follow-on work grounded in live runtime truth.
            <HelpHint
              label="OpenClaw parity help"
              text="This surface is intentionally conservative. It shows the full parity program plus the live follow-on foundations without pretending external proof or publication work is already done."
            />
          </>
        }
        actions={
          openclawParity ? (
            <div className="workflow-summary-strip">
              <StatusChip tone="success">
                {openclawParity.completedEpicIds.length}/{openclawParity.epics.length} complete
              </StatusChip>
              <StatusChip tone="warning">{openclawParity.openEpicIds.length} open</StatusChip>
              <StatusChip tone="muted">next {openclawParity.nextEpicId ?? "none"}</StatusChip>
            </div>
          ) : followOnParity ? (
            <div className="workflow-summary-strip">
              <StatusChip tone="muted">{followOnParity.deploymentProfile}</StatusChip>
              <StatusChip tone="muted">auth {followOnParity.authMode}</StatusChip>
              <StatusChip tone={followOnParity.voice.runtimeReadiness === "ready" ? "success" : "warning"}>
                voice {followOnParity.voice.runtimeReadiness}
              </StatusChip>
            </div>
          ) : undefined
        }
      >
        {followOnParityError ? (
          <>
            {openclawParityError ? (
              <p className="office-subtitle">OpenClaw parity program unavailable: {openclawParityError}</p>
            ) : null}
            <p className="office-subtitle">Follow-on parity report unavailable: {followOnParityError}</p>
          </>
        ) : followOnParity ? (
          <>
            <div className="workflow-status-stack">
              {openclawParityError ? (
                <p className="office-subtitle">OpenClaw parity program unavailable: {openclawParityError}</p>
              ) : openclawParity ? (
                <>
                  <FieldHelp>
                    Full-program status: {openclawParity.completedEpicIds.length} complete ·{" "}
                    {openclawParity.openEpicIds.length} open · next {openclawParity.nextEpicId ?? "none"}.
                  </FieldHelp>
                  <FieldHelp>Completion order: {openclawParity.completionOrder.join(" -> ")}</FieldHelp>
                  <FieldHelp>Next program slice: {openclawParity.nextSlice}</FieldHelp>
                  <FieldHelp>
                    Blockers: repo runtime {openclawParity.blockerCounts.repo_runtime} · manual/operator{" "}
                    {openclawParity.blockerCounts.manual_operator} · external repo{" "}
                    {openclawParity.blockerCounts.external_repo} · publication{" "}
                    {openclawParity.blockerCounts.publication}.
                  </FieldHelp>
                  {openclawParity.unsafeClaims.map((claim) => (
                    <FieldHelp key={`openclaw-unsafe-${claim}`}>Unsafe to claim yet: {claim}</FieldHelp>
                  ))}
                </>
              ) : null}
              <FieldHelp>
                Follow-on runtime posture: {followOnParity.deploymentProfile} · auth {followOnParity.authMode} · voice{" "}
                {followOnParity.voice.runtimeReadiness} · browser {followOnParity.browser.controlToolCount} control
                tool(s).
              </FieldHelp>
            </div>
            <div className="metric-grid">
              <Panel title="Browser" subtitle="Registered browser tools and catalog maturity." className="stat-card">
                <p className="stat-card-value">{followOnParity.browser.totalToolCount}</p>
                <p className="stat-card-note">
                  {followOnParity.browser.readToolCount} read · {followOnParity.browser.controlToolCount} control
                </p>
                <p className="stat-card-note">
                  Catalog {followOnParity.browser.automationCatalog?.maturity ?? "missing"}
                </p>
              </Panel>
              <Panel title="Voice" subtitle="Wake/talk runtime readiness and current state." className="stat-card">
                <p className="stat-card-value">{followOnParity.voice.runtimeReadiness}</p>
                <p className="stat-card-note">
                  Talk {followOnParity.voice.talkState} · Wake{" "}
                  {followOnParity.voice.wakeEnabled ? followOnParity.voice.wakeState : "disabled"}
                </p>
                <p className="stat-card-note">Model {followOnParity.voice.selectedModelId ?? "none selected"}</p>
              </Panel>
              <Panel title="Extensions" subtitle="Add-ons and integration plugin breadth." className="stat-card">
                <p className="stat-card-value">
                  {followOnParity.addons.catalogCount + followOnParity.plugins.totalCount}
                </p>
                <p className="stat-card-note">
                  {followOnParity.addons.installedCount} add-ons installed · {followOnParity.addons.runningCount}{" "}
                  running
                </p>
                <p className="stat-card-note">
                  {followOnParity.plugins.enabledCount}/{followOnParity.plugins.totalCount} plugins enabled
                </p>
              </Panel>
            </div>
            <div className="workflow-status-stack">
              <FieldHelp>Browser posture: {followOnParity.browser.guardrailSummary}</FieldHelp>
              <FieldHelp>
                Browser state tools in {followOnParity.deploymentProfile}:{" "}
                {followOnParity.browser.stateToolRuntime.allowedTools.length > 0
                  ? `allowed ${followOnParity.browser.stateToolRuntime.allowedTools.join(", ")}`
                  : "allowed none"}{" "}
                ·{" "}
                {followOnParity.browser.stateToolRuntime.blockedTools.length > 0
                  ? `blocked ${followOnParity.browser.stateToolRuntime.blockedTools.join(", ")}`
                  : "blocked none"}
                .
              </FieldHelp>
              <FieldHelp>
                Browser proof status: {formatProofArtifactStatus(followOnParity.browser.artifactStatus)}
              </FieldHelp>
              {followOnParity.browser.blockingIssues.map((issue) => (
                <p key={`browser-issue-${issue}`} className="error">
                  {issue}
                </p>
              ))}
              {followOnParity.browser.recommendedActions.map((action) => (
                <FieldHelp key={`browser-action-${action}`}>Browser next action: {action}</FieldHelp>
              ))}
              <div className="row-actions">
                <ActionButton
                  label={browserProofLaneBusy ? "Generating browser proof draft..." : "Generate browser proof draft"}
                  onClick={() => void loadBrowserProofLane()}
                  disabled={browserProofLaneBusy}
                />
                <ActionButton
                  label={
                    browserProofArtifactBusy ? "Exporting browser proof artifact..." : "Export browser proof artifact"
                  }
                  onClick={() => void saveBrowserProofLane()}
                  disabled={browserProofArtifactBusy}
                />
              </div>
              {browserProofLaneError ? (
                <p className="error">Browser proof lane unavailable: {browserProofLaneError}</p>
              ) : null}
              {browserProofArtifactError ? (
                <p className="error">Browser proof artifact export failed: {browserProofArtifactError}</p>
              ) : null}
              {browserProofLane ? (
                <>
                  <FieldHelp>Browser proof lane: {browserProofLane.summary}</FieldHelp>
                  <FieldHelp>
                    Checklist {browserProofLane.checklistPath} · Template {browserProofLane.templatePath}
                  </FieldHelp>
                  {browserProofLane.blockingIssues.map((issue) => (
                    <p key={`browser-proof-issue-${issue}`} className="error">
                      {issue}
                    </p>
                  ))}
                  {browserProofLane.steps.map((step) => (
                    <FieldHelp key={`browser-proof-step-${step.stepId}`}>
                      Browser proof step: {step.title} [{step.status}] · {step.instructions}
                    </FieldHelp>
                  ))}
                  <pre>{browserProofLane.markdown}</pre>
                </>
              ) : null}
              {followOnParity.browser.latestArtifact ? (
                <>
                  <FieldHelp>
                    Saved browser proof artifact: {followOnParity.browser.latestArtifact.relativePath}
                  </FieldHelp>
                  <FieldHelp>
                    Artifact bytes {followOnParity.browser.latestArtifact.bytes} · generated{" "}
                    {followOnParity.browser.latestArtifact.generatedAt}
                  </FieldHelp>
                </>
              ) : null}
            </div>
            <div className="workflow-status-stack">
              <FieldHelp>
                Packaging posture is {followOnParity.deploymentProfile} with auth mode {followOnParity.authMode},
                loopback bypass {followOnParity.packaging.allowLoopbackBypass ? "enabled" : "disabled"}, and{" "}
                {followOnParity.packaging.networkAllowlistCount} allowlisted hosts.
              </FieldHelp>
              <FieldHelp>Packaging summary: {followOnParity.packaging.postureSummary}</FieldHelp>
              <FieldHelp>
                Packaging proof status: {followOnParity.packaging.proofStatus.freshness}
                {followOnParity.packaging.proofStatus.hasArtifact
                  ? ` · latest profile ${followOnParity.packaging.proofStatus.latestArtifactDeploymentProfile ?? "unknown"} · ${followOnParity.packaging.proofStatus.matchedCurrentProfile ? "matches current profile" : "does not match current profile"}${typeof followOnParity.packaging.proofStatus.ageDays === "number" ? ` · ${followOnParity.packaging.proofStatus.ageDays} day(s) old` : ""}`
                  : " · no artifact recorded yet"}
                .
              </FieldHelp>
              {followOnParity.packaging.blockingIssues.map((issue) => (
                <p key={`packaging-issue-${issue}`} className="error">
                  {issue}
                </p>
              ))}
              {followOnParity.packaging.recommendedActions.map((action) => (
                <FieldHelp key={`packaging-action-${action}`}>Packaging next action: {action}</FieldHelp>
              ))}
              <div className="row-actions">
                <ActionButton
                  label={
                    packagingProofLaneBusy ? "Generating packaging proof draft..." : "Generate packaging proof draft"
                  }
                  onClick={() => void loadPackagingProofLane()}
                  disabled={packagingProofLaneBusy}
                />
                <ActionButton
                  label={
                    packagingProofArtifactBusy
                      ? "Exporting packaging proof artifact..."
                      : "Export packaging proof artifact"
                  }
                  onClick={() => void savePackagingProofLane()}
                  disabled={packagingProofArtifactBusy}
                />
              </div>
              {packagingProofLaneError ? (
                <p className="error">Packaging proof lane unavailable: {packagingProofLaneError}</p>
              ) : null}
              {packagingProofArtifactError ? (
                <p className="error">Packaging proof artifact export failed: {packagingProofArtifactError}</p>
              ) : null}
              {packagingProofLane ? (
                <>
                  <FieldHelp>Packaging proof lane: {packagingProofLane.summary}</FieldHelp>
                  <FieldHelp>
                    Checklist {packagingProofLane.checklistPath} · Template {packagingProofLane.templatePath}
                  </FieldHelp>
                  {packagingProofLane.blockingIssues.map((issue) => (
                    <p key={`packaging-proof-issue-${issue}`} className="error">
                      {issue}
                    </p>
                  ))}
                  {packagingProofLane.steps.map((step) => (
                    <FieldHelp key={`packaging-proof-step-${step.stepId}`}>
                      Packaging proof step: {step.title} [{step.status}] · {step.instructions}
                    </FieldHelp>
                  ))}
                  <pre>{packagingProofLane.markdown}</pre>
                </>
              ) : null}
              {followOnParity.packaging.latestArtifact ? (
                <>
                  <FieldHelp>
                    Saved packaging proof artifact: {followOnParity.packaging.latestArtifact.relativePath}
                  </FieldHelp>
                  <FieldHelp>
                    Artifact bytes {followOnParity.packaging.latestArtifact.bytes} · generated{" "}
                    {followOnParity.packaging.latestArtifact.generatedAt}
                  </FieldHelp>
                </>
              ) : null}
              {followOnParity.companion.platformTargets.length > 0 ? (
                <FieldHelp>
                  Companion and canvas targets:{" "}
                  {followOnParity.companion.platformTargets
                    .map((target) => `${target.label} (${target.maturity})`)
                    .join(", ")}
                  .
                </FieldHelp>
              ) : null}
            </div>
            <div className="workflow-status-stack">
              <FieldHelp>Canvas summary: {followOnParity.canvas.paritySummary}</FieldHelp>
              <FieldHelp>
                A2UI proof status: {formatProofArtifactStatus(followOnParity.canvas.artifactStatus)}
              </FieldHelp>
              {followOnParity.canvas.contract ? (
                <FieldHelp>
                  Canvas contract: {followOnParity.canvas.contract.contractId} · scopes{" "}
                  {followOnParity.canvas.contract.scopes.join(", ")} · transports{" "}
                  {followOnParity.canvas.contract.transports.join(", ")}.
                </FieldHelp>
              ) : null}
              {followOnParity.canvas.blockingIssues.map((issue) => (
                <p key={`canvas-issue-${issue}`} className="error">
                  {issue}
                </p>
              ))}
              {followOnParity.canvas.recommendedActions.map((action) => (
                <FieldHelp key={`canvas-action-${action}`}>Canvas next action: {action}</FieldHelp>
              ))}
              <div className="row-actions">
                <ActionButton
                  label={a2uiProofLaneBusy ? "Generating A2UI proof draft..." : "Generate A2UI proof draft"}
                  onClick={() => void loadA2UIProofLane()}
                  disabled={a2uiProofLaneBusy}
                />
                <ActionButton
                  label={a2uiProofArtifactBusy ? "Exporting A2UI proof artifact..." : "Export A2UI proof artifact"}
                  onClick={() => void saveA2UIProofLane()}
                  disabled={a2uiProofArtifactBusy}
                />
              </div>
              {a2uiProofLaneError ? <p className="error">A2UI proof lane unavailable: {a2uiProofLaneError}</p> : null}
              {a2uiProofArtifactError ? (
                <p className="error">A2UI proof artifact export failed: {a2uiProofArtifactError}</p>
              ) : null}
              {a2uiProofLane ? (
                <>
                  <FieldHelp>A2UI proof lane: {a2uiProofLane.summary}</FieldHelp>
                  <FieldHelp>
                    Checklist {a2uiProofLane.checklistPath} · Template {a2uiProofLane.templatePath}
                  </FieldHelp>
                  {a2uiProofLane.blockingIssues.map((issue) => (
                    <p key={`a2ui-proof-issue-${issue}`} className="error">
                      {issue}
                    </p>
                  ))}
                  {a2uiProofLane.steps.map((step) => (
                    <FieldHelp key={`a2ui-proof-step-${step.stepId}`}>
                      A2UI proof step: {step.title} [{step.status}] · {step.instructions}
                    </FieldHelp>
                  ))}
                  <pre>{a2uiProofLane.markdown}</pre>
                </>
              ) : null}
              {followOnParity.canvas.latestArtifact ? (
                <>
                  <FieldHelp>Saved A2UI proof artifact: {followOnParity.canvas.latestArtifact.relativePath}</FieldHelp>
                  <FieldHelp>
                    Artifact bytes {followOnParity.canvas.latestArtifact.bytes} · generated{" "}
                    {followOnParity.canvas.latestArtifact.generatedAt}
                  </FieldHelp>
                </>
              ) : null}
            </div>
            <div className="workflow-status-stack">
              <FieldHelp>Companion summary: {followOnParity.companion.paritySummary}</FieldHelp>
              <FieldHelp>
                Companion brief status: {formatArtifactStatus(followOnParity.companion.artifactStatus)}
              </FieldHelp>
              {followOnParity.companion.contract ? (
                <>
                  <FieldHelp>
                    Companion contract: {followOnParity.companion.contract.contractId} · target{" "}
                    {followOnParity.companion.contract.primaryTarget} · repo{" "}
                    {followOnParity.companion.contract.bootstrapRepo} · status{" "}
                    {followOnParity.companion.contract.bootstrapStatus}.
                  </FieldHelp>
                  <FieldHelp>
                    Companion bootstrap: {followOnParity.companion.contract.bootstrapFeatures.join(", ")} · transports{" "}
                    {followOnParity.companion.contract.transportLanes.join(", ")}.
                  </FieldHelp>
                  <FieldHelp>
                    Companion prerequisites: {followOnParity.companion.contract.serverPrerequisites.join(", ")}.
                  </FieldHelp>
                </>
              ) : null}
              {followOnParity.companion.authReadiness.map((item) => (
                <FieldHelp key={`companion-auth-${item.key}`}>
                  Companion auth readiness: {item.label}{" "}
                  <StatusChip tone={mapParityTone(item.state)}>{item.state.replaceAll("_", " ")}</StatusChip> ·{" "}
                  {item.note}
                </FieldHelp>
              ))}
              {followOnParity.companion.prerequisiteReadiness.map((item) => (
                <FieldHelp key={`companion-prereq-${item.key}`}>
                  Companion prerequisite: {item.label}{" "}
                  <StatusChip tone={mapParityTone(item.state)}>{item.state.replaceAll("_", " ")}</StatusChip> ·{" "}
                  {item.note}
                </FieldHelp>
              ))}
              {followOnParity.companion.blockingIssues.map((issue) => (
                <p key={`companion-issue-${issue}`} className="error">
                  {issue}
                </p>
              ))}
              {followOnParity.companion.recommendedActions.map((action) => (
                <FieldHelp key={`companion-action-${action}`}>Companion next action: {action}</FieldHelp>
              ))}
              <div className="row-actions">
                <ActionButton
                  label={
                    companionBriefArtifactBusy
                      ? "Exporting companion bootstrap brief..."
                      : "Export companion bootstrap brief"
                  }
                  onClick={() => void saveCompanionBootstrapBrief()}
                  disabled={companionBriefArtifactBusy}
                />
              </div>
              {companionBriefArtifactError ? (
                <p className="error">Companion bootstrap brief export failed: {companionBriefArtifactError}</p>
              ) : null}
              {followOnParity.companion.latestArtifact ? (
                <>
                  <FieldHelp>
                    Saved companion bootstrap brief: {followOnParity.companion.latestArtifact.relativePath}
                  </FieldHelp>
                  <FieldHelp>
                    Artifact bytes {followOnParity.companion.latestArtifact.bytes} · generated{" "}
                    {followOnParity.companion.latestArtifact.generatedAt}
                  </FieldHelp>
                </>
              ) : null}
            </div>
            <div className="workflow-status-stack">
              <FieldHelp>Extension summary: {followOnParity.plugins.sdkSummary}</FieldHelp>
              <FieldHelp>
                Extension brief status: {formatArtifactStatus(followOnParity.plugins.artifactStatus)}
              </FieldHelp>
              <FieldHelp>
                Reference plugin lifecycle: {followOnParity.plugins.referenceLifecycle.referencePluginId} ·{" "}
                {followOnParity.plugins.referenceLifecycle.present ? "installed" : "missing"} ·{" "}
                {followOnParity.plugins.referenceLifecycle.enabled ? "enabled" : "disabled"} ·{" "}
                {followOnParity.plugins.referenceLifecycle.matchesReferenceSource ? "source aligned" : "source drifted"}
                .
              </FieldHelp>
              {followOnParity.plugins.referenceLifecycle.source ? (
                <FieldHelp>Reference plugin source: {followOnParity.plugins.referenceLifecycle.source}</FieldHelp>
              ) : null}
              {followOnParity.plugins.referenceLifecycle.capabilities.length > 0 ? (
                <FieldHelp>
                  Reference plugin capabilities: {followOnParity.plugins.referenceLifecycle.capabilities.join(", ")}
                </FieldHelp>
              ) : null}
              {followOnParity.plugins.blockingIssues.map((issue) => (
                <p key={`plugin-issue-${issue}`} className="error">
                  {issue}
                </p>
              ))}
              {followOnParity.plugins.recommendedActions.map((action) => (
                <FieldHelp key={`plugin-action-${action}`}>Extension next action: {action}</FieldHelp>
              ))}
              <div className="row-actions">
                <ActionButton
                  label={extensionBriefBusy ? "Generating extension SDK brief..." : "Generate extension SDK brief"}
                  onClick={() => void loadExtensionSdkBrief()}
                  disabled={extensionBriefBusy}
                />
                <ActionButton
                  label={extensionBriefArtifactBusy ? "Exporting extension SDK brief..." : "Export extension SDK brief"}
                  onClick={() => void saveExtensionSdkBrief()}
                  disabled={extensionBriefArtifactBusy}
                />
                <ActionButton
                  label={
                    extensionStarterPackBusy
                      ? "Generating extension starter pack..."
                      : "Generate extension starter pack"
                  }
                  onClick={() => void loadExtensionStarterPack()}
                  disabled={extensionStarterPackBusy}
                />
                <ActionButton
                  label={
                    extensionStarterPackArtifactBusy
                      ? "Exporting extension starter pack..."
                      : "Export extension starter pack"
                  }
                  onClick={() => void saveExtensionStarterPack()}
                  disabled={extensionStarterPackArtifactBusy}
                />
              </div>
              {extensionBriefError ? (
                <p className="error">Extension SDK brief unavailable: {extensionBriefError}</p>
              ) : null}
              {extensionBriefArtifactError ? (
                <p className="error">Extension SDK brief export failed: {extensionBriefArtifactError}</p>
              ) : null}
              {extensionStarterPackError ? (
                <p className="error">Extension starter pack unavailable: {extensionStarterPackError}</p>
              ) : null}
              {extensionStarterPackArtifactError ? (
                <p className="error">Extension starter pack export failed: {extensionStarterPackArtifactError}</p>
              ) : null}
              {extensionBrief ? (
                <>
                  <FieldHelp>Extension SDK brief: {extensionBrief.summary}</FieldHelp>
                  <pre>{extensionBrief.markdown}</pre>
                </>
              ) : null}
              {extensionStarterPack ? (
                <>
                  <FieldHelp>Extension starter pack: {extensionStarterPack.summary}</FieldHelp>
                  <FieldHelp>Starter root: {extensionStarterPack.starterRoot}</FieldHelp>
                  <FieldHelp>Starter files: {extensionStarterPack.files.join(", ")}</FieldHelp>
                  <pre>{extensionStarterPack.markdown}</pre>
                </>
              ) : null}
              {followOnParity.plugins.latestArtifact ? (
                <>
                  <FieldHelp>Saved extension SDK brief: {followOnParity.plugins.latestArtifact.relativePath}</FieldHelp>
                  <FieldHelp>
                    Artifact bytes {followOnParity.plugins.latestArtifact.bytes} · generated{" "}
                    {followOnParity.plugins.latestArtifact.generatedAt}
                  </FieldHelp>
                </>
              ) : null}
              {extensionStarterPackArtifact ? (
                <>
                  <FieldHelp>Saved extension starter pack: {extensionStarterPackArtifact.starterRoot}</FieldHelp>
                  <FieldHelp>
                    Starter pack files {extensionStarterPackArtifact.fileCount} · total bytes{" "}
                    {extensionStarterPackArtifact.totalBytes}
                  </FieldHelp>
                </>
              ) : null}
            </div>
            <div className="workflow-status-stack">
              <FieldHelp>
                Voice proof status: {formatProofArtifactStatus(followOnParity.voice.artifactStatus)}
              </FieldHelp>
              {followOnParity.voice.blockingIssues.map((issue) => (
                <p key={`voice-issue-${issue}`} className="error">
                  {issue}
                </p>
              ))}
              {followOnParity.voice.recoveryActions.map((action) => (
                <FieldHelp key={`voice-recovery-${action}`}>Voice recovery action: {action}</FieldHelp>
              ))}
              {followOnParity.voice.recommendedActions.map((action) => (
                <FieldHelp key={`voice-action-${action}`}>Voice next action: {action}</FieldHelp>
              ))}
              <div className="row-actions">
                <ActionButton
                  label={voiceProofLaneBusy ? "Generating voice proof draft..." : "Generate voice proof draft"}
                  onClick={() => void loadVoiceProofLane()}
                  disabled={voiceProofLaneBusy}
                />
                <ActionButton
                  label={voiceProofArtifactBusy ? "Exporting voice proof artifact..." : "Export voice proof artifact"}
                  onClick={() => void saveVoiceProofLane()}
                  disabled={voiceProofArtifactBusy}
                />
              </div>
              {voiceProofLaneError ? (
                <p className="error">Voice proof lane unavailable: {voiceProofLaneError}</p>
              ) : null}
              {voiceProofArtifactError ? (
                <p className="error">Voice proof artifact export failed: {voiceProofArtifactError}</p>
              ) : null}
              {voiceProofLane ? (
                <>
                  <FieldHelp>Voice proof lane: {voiceProofLane.summary}</FieldHelp>
                  <FieldHelp>
                    Checklist {voiceProofLane.checklistPath} · Template {voiceProofLane.templatePath}
                  </FieldHelp>
                  {voiceProofLane.blockingIssues.map((issue) => (
                    <p key={`voice-proof-issue-${issue}`} className="error">
                      {issue}
                    </p>
                  ))}
                  {voiceProofLane.recoveryActions.map((action) => (
                    <FieldHelp key={`voice-proof-recovery-${action}`}>Voice recovery action: {action}</FieldHelp>
                  ))}
                  {voiceProofLane.steps.map((step) => (
                    <FieldHelp key={`voice-proof-step-${step.stepId}`}>
                      Voice proof step: {step.title} [{step.status}] · {step.instructions}
                    </FieldHelp>
                  ))}
                  <pre>{voiceProofLane.markdown}</pre>
                </>
              ) : null}
              {followOnParity.voice.latestArtifact ? (
                <>
                  <FieldHelp>Saved voice proof artifact: {followOnParity.voice.latestArtifact.relativePath}</FieldHelp>
                  <FieldHelp>
                    Artifact bytes {followOnParity.voice.latestArtifact.bytes} · generated{" "}
                    {followOnParity.voice.latestArtifact.generatedAt}
                  </FieldHelp>
                </>
              ) : null}
            </div>
            <div className="workflow-status-stack">
              {(openclawParity?.epics ?? followOnParity.epics).map((epic) =>
                "status" in epic ? (
                  <div key={epic.epicId}>
                    <p className="office-subtitle">
                      <strong>
                        {epic.epicId} · {epic.label}
                      </strong>{" "}
                      <StatusChip tone={mapProgramParityTone(epic.status)}>
                        {epic.status.replaceAll("_", " ")}
                      </StatusChip>
                    </p>
                    <p className="office-subtitle">{epic.summary}</p>
                    <p className="office-subtitle">Next slice: {epic.nextSlice}</p>
                    {epic.blockers.map((entry, index) => (
                      <FieldHelp key={`${epic.epicId}-blocker-${entry.kind}-${index}`}>
                        Blocker [{formatProgramBlockerKind(entry.kind)}]: {entry.summary}
                      </FieldHelp>
                    ))}
                  </div>
                ) : (
                  <div key={epic.epicId}>
                    <p className="office-subtitle">
                      <strong>
                        {epic.epicId} · {epic.label}
                      </strong>{" "}
                      <StatusChip tone={mapParityTone(epic.state)}>{epic.state.replaceAll("_", " ")}</StatusChip>
                    </p>
                    <p className="office-subtitle">{epic.summary}</p>
                    <p className="office-subtitle">Next slice: {epic.nextSlice}</p>
                  </div>
                ),
              )}
            </div>
          </>
        ) : (
          <p className="office-subtitle">Loading parity reports...</p>
        )}
      </Panel>
      <Panel
        title="Service Manager"
        subtitle={
          <>
            Manage the local GoatCitadel daemon lifecycle and inspect recent service events.
            <HelpHint
              label="Service manager help"
              text="Use Start, Stop, Restart, and Refresh to control the local daemon process. Refresh only reloads status and recent logs."
            />
          </>
        }
        actions={
          <div className="workflow-summary-strip">
            <StatusChip tone={daemonStateTone}>{daemonStatus?.state ?? "unknown"}</StatusChip>
            <StatusChip tone="muted">PID {daemonStatus?.pid ?? 0}</StatusChip>
            <StatusChip tone="muted">{Math.round(daemonStatus?.uptimeSeconds ?? 0)}s uptime</StatusChip>
          </div>
        }
      >
        <div className="row-actions">
          <ActionButton
            label="Start"
            onClick={onDaemonStart}
            disabled={daemonBusy || !daemonControlSupported || daemonStatus?.running}
          />
          <ActionButton
            label="Stop"
            onClick={onDaemonStop}
            disabled={daemonBusy || !daemonControlSupported || !daemonStatus?.running}
          />
          <ActionButton label="Restart" onClick={onDaemonRestart} disabled={daemonBusy || !daemonControlSupported} />
          <ActionButton label="Refresh" onClick={() => void refreshDaemon()} disabled={daemonBusy} />
        </div>
        {daemonStatus?.controlMessage ? <p className="office-subtitle">{daemonStatus.controlMessage}</p> : null}
        {daemonLogs.length > 0 ? (
          <pre>
            {daemonLogs
              .map((entry) => `[${entry.timestamp}] ${entry.level.toUpperCase()}: ${entry.message}`)
              .join("\n")}
          </pre>
        ) : (
          <p className="office-subtitle">No daemon log events yet.</p>
        )}
      </Panel>
    </section>
  );
}
