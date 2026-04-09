import type { ReactNode } from "react";
import type { FollowOnParityReport, OpenclawParityProgramReport } from "../../api/client";
import { FieldHelp } from "../../components/FieldHelp";
import { HelpHint } from "../../components/HelpHint";
import { Panel } from "../../components/Panel";
import { StatusChip } from "../../components/StatusChip";
import { formatProgramBlockerKind, mapParityTone, mapProgramParityTone } from "./system-page-helpers";

type SystemParityPanelProps = {
  openclawParity: OpenclawParityProgramReport | null;
  openclawParityError: string | null;
  followOnParity: FollowOnParityReport | null;
  followOnParityError: string | null;
  children: ReactNode;
};

export function SystemParityPanel({
  openclawParity,
  openclawParityError,
  followOnParity,
  followOnParityError,
  children,
}: SystemParityPanelProps) {
  return (
    <Panel
      title="OpenClaw Parity"
      subtitle={
        <>
          Track the full parity closeout program while keeping browser, canvas, deployment, companion, plugin, and voice
          follow-on work grounded in live runtime truth.
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
                  {openclawParity.blockerCounts.external_repo} · publication {openclawParity.blockerCounts.publication}.
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
                {followOnParity.addons.installedCount} add-ons installed · {followOnParity.addons.runningCount} running
              </p>
              <p className="stat-card-note">
                {followOnParity.plugins.enabledCount}/{followOnParity.plugins.totalCount} plugins enabled
              </p>
            </Panel>
          </div>
          {children}
          <div className="workflow-status-stack">
            {(openclawParity?.epics ?? followOnParity.epics).map((epic) =>
              "status" in epic ? (
                <div key={epic.epicId}>
                  <p className="office-subtitle">
                    <strong>
                      {epic.epicId} · {epic.label}
                    </strong>{" "}
                    <StatusChip tone={mapProgramParityTone(epic.status)}>{epic.status.replaceAll("_", " ")}</StatusChip>
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
  );
}
