import type { CapabilitySkillInstall } from "@goatcitadel/contracts";
import { Button } from "../../../ui/Button";
import { Section } from "../../../ui/Section";
import { StatusBadge } from "../../../ui/StatusBadge";
import { SettingsApprovalDialog } from "../../settings/SettingsApprovalDialog";
import {
  approvalWords,
  INSTALLED_CANT_SWITCH_ON,
  installSteps,
  INSTALLED_NOT_ON,
  progressLine,
} from "./skill-install-view";
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
 * opens it again. It belongs to the workspace the check was made in, so it is read there, whichever workspace is on
 * screen now. A decision is read back at once rather than at the next check.
 */
function ApprovalInPlace({ flow, install }: { flow: SkillInstall; install: WaitingInstall }) {
  const words = approvalWords(install.step, install.name);
  return (
    <SettingsApprovalDialog
      approvalId={install.approvalId}
      workspaceId={flow.workspaceId}
      title={words.title}
      summary={words.summary}
      reviewLabel="Review the change"
      loadFailureHint="Reload to try again."
      onResolved={() => flow.checkNow()}
    />
  );
}

/** A line under the steps: why a check or step stopped (a failure), or what the last request met (a note). */
interface StopLine {
  text: string;
  failure: boolean;
}

/** Whether switching on is the step that stopped: the install itself finished. */
const switchOnStopped = (flow: SkillInstall) => flow.state.phase === "failed" && flow.asked === "activate";

/**
 * Why the flow stopped or what the last request met, in plain words; none while all is well. A stop has one failure
 * line: the Gateway's own, which names the step, or the panel's when there is none. A decline or a refused request is
 * a note, not a failure: declining is the operator's own choice.
 */
function stopLines(flow: SkillInstall): StopLine[] {
  const { state } = flow;
  if (state.phase === "check_failed") return [{ text: state.message, failure: true }];
  if (state.phase === "failed") {
    const failure = { text: state.install?.failure ?? state.message, failure: true };
    return switchOnStopped(flow) ? [failure, { text: INSTALLED_CANT_SWITCH_ON, failure: false }] : [failure];
  }
  return [
    ...(flow.notice ? [{ text: flow.notice, failure: false }] : []),
    ...(flow.unreadable ? [{ text: CANT_CHECK, failure: false }] : []),
  ];
}

/**
 * Where the install stands: one line read out as it moves (the step list shows the same on screen), the step list
 * (Check, Install, Switch on) with the approval in place beside a step that waits, why it stopped, and the one action
 * the step offers: "Install and switch on" at a check that passed, "Switch on" for an install that isn't switched on,
 * "Check again" after a stop. `onCheckAgain` checks the source afresh; it is absent where the panel has its own way to
 * check (the Git address field). After switching on stopped, nothing is offered: the install finished, a new check
 * would only find it installed, and nothing here can switch it on. Nothing on the page names the install's steps, so
 * the panel announces them wherever the inspector shows it.
 */
export function SkillInstallProgress({
  flow,
  name,
  onCheckAgain,
}: {
  flow: SkillInstall;
  name: string;
  onCheckAgain?: () => void;
}) {
  const install = installOf(flow.state);
  const steps = installSteps(flow);
  const waiting = waitingInstall(flow);
  const stops = stopLines(flow);
  const checkAgain = (flow.state.phase === "failed" && !switchOnStopped(flow)) || flow.state.phase === "check_failed";
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
                    <ApprovalInPlace key={waiting.approvalId} flow={flow} install={waiting} />
                  ) : null}
                </span>
              </li>
            ))}
          </ol>
        ) : null}
        {offerSwitchOn && !flow.notice && !flow.asking ? <p className="text-fg-secondary">{INSTALLED_NOT_ON}</p> : null}
        {stops.length > 0 ? (
          <div role="alert" className="space-y-1">
            {stops.map((line) => (
              <p key={line.text} className={line.failure ? "text-status-failed" : "text-fg"}>
                {line.text}
              </p>
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
        {checkAgain && onCheckAgain ? <Button onClick={onCheckAgain}>Check again</Button> : null}
        {/* Always in place, so each new line is read out; the step badges carry it on screen. */}
        <p role="status" className="sr-only">
          {progressLine(flow, name)}
        </p>
      </div>
    </Section>
  );
}
