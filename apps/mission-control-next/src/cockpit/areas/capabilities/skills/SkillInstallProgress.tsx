import type { CapabilitySkillInstall } from "@goatcitadel/contracts";
import { Button } from "../../../ui/Button";
import { Section } from "../../../ui/Section";
import { StatusBadge } from "../../../ui/StatusBadge";
import { SettingsApprovalDialog } from "../../settings/SettingsApprovalDialog";
import { approvalWords, installSteps, INSTALLED_NOT_ON, progressLine } from "./skill-install-view";
import { installOf, type SkillInstall } from "./use-skill-install";

const CANT_CHECK = "Can't check the install right now. It will try again.";

type WaitingInstall = CapabilitySkillInstall & { step: "waiting_install" | "waiting_switch_on"; approvalId: string };

/** The install's step that waits for the operator's approval, read from the Gateway, if one does now. */
function waitingInstall(flow: SkillInstall): WaitingInstall | undefined {
  const install = installOf(flow.state);
  if (flow.state.phase !== "following" || flow.asking || !install?.approvalId) return undefined;
  return install.step === "waiting_install" || install.step === "waiting_switch_on"
    ? (install as WaitingInstall)
    : undefined;
}

/**
 * The step's approval, decided in the panel: it opens on its own once per approval, and its "Review the change" button
 * opens it again. It belongs to the workspace the install was asked from, so it is read there. A decision is read back
 * at once rather than at the next check.
 */
function ApprovalInPlace({
  flow,
  install,
  workspaceId,
}: {
  flow: SkillInstall;
  install: WaitingInstall;
  workspaceId: string;
}) {
  const words = approvalWords(install.step, install.name);
  return (
    <SettingsApprovalDialog
      approvalId={install.approvalId}
      workspaceId={workspaceId}
      title={words.title}
      summary={words.summary}
      reviewLabel="Review the change"
      loadFailureHint="Reload to try again."
      onResolved={() => flow.checkNow()}
    />
  );
}

/** Why the flow stopped or what the last request met, in plain words; none while all is well. */
function stopLines(flow: SkillInstall): string[] {
  const { state } = flow;
  if (state.phase === "check_failed") return [state.message];
  if (state.phase === "failed") return [state.message, ...(state.install?.failure ? [state.install.failure] : [])];
  return [...(flow.notice ? [flow.notice] : []), ...(flow.unreadable ? [CANT_CHECK] : [])];
}

/**
 * Where the install stands: one line read out as it moves (the step list shows the same on screen), the step list
 * (Check, Install, Switch on) with the approval in place beside a step that waits, why it stopped, and the one action
 * the step offers: "Install and switch on" at a check that passed, "Switch on" for an install that isn't switched on,
 * "Check again" after a stop. `onCheckAgain` checks the source afresh; it is absent where the panel has its own way to
 * check (the Git address field). Nothing on the page names the install's steps, so the panel announces them wherever
 * the inspector shows it.
 */
export function SkillInstallProgress({
  flow,
  name,
  workspaceId,
  onCheckAgain,
}: {
  flow: SkillInstall;
  name: string;
  workspaceId: string;
  onCheckAgain?: () => void;
}) {
  const install = installOf(flow.state);
  const steps = installSteps(flow);
  const waiting = waitingInstall(flow);
  const stops = stopLines(flow);
  const stopped = flow.state.phase === "failed" || flow.state.phase === "check_failed";
  const offerSwitchOn = install?.step === "installed_off" && !flow.chain && flow.state.phase === "following";
  return (
    <Section title="Progress" headingLevel={3}>
      <div className="space-y-3 text-sm">
        {steps.length > 0 ? (
          <ol className="divide-y divide-line-subtle">
            {steps.map((row) => (
              <li key={row.name} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="font-medium text-fg">{row.name}</span>
                <span className="flex flex-wrap items-center gap-2">
                  <StatusBadge status={row.status} />
                  {waiting && row.status.tone === "waiting" ? (
                    <ApprovalInPlace key={waiting.approvalId} flow={flow} install={waiting} workspaceId={workspaceId} />
                  ) : null}
                </span>
              </li>
            ))}
          </ol>
        ) : null}
        {offerSwitchOn && !flow.notice && !flow.asking ? <p className="text-fg-secondary">{INSTALLED_NOT_ON}</p> : null}
        {stops.length > 0 ? (
          <div role="alert" className="space-y-1 text-status-failed">
            {stops.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </div>
        ) : null}
        {install?.step === "check_passed" && (flow.state.phase === "ready" || flow.asking) ? (
          <Button variant="primary" loading={flow.asking} loadingLabel="Asking…" onClick={flow.confirm}>
            Install and switch on
          </Button>
        ) : null}
        {offerSwitchOn ? (
          <Button variant="primary" loading={flow.asking} loadingLabel="Asking…" onClick={flow.confirm}>
            Switch on
          </Button>
        ) : null}
        {stopped && onCheckAgain ? <Button onClick={onCheckAgain}>Check again</Button> : null}
        {/* Always in place, so each new line is read out; the step badges carry it on screen. */}
        <p role="status" className="sr-only">
          {progressLine(flow, name)}
        </p>
      </div>
    </Section>
  );
}
