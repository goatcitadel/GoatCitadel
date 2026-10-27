import { useState } from "react";
import { Check, Circle, Hand, LoaderCircle, X, type LucideIcon } from "lucide-react";
import { Button } from "../../../ui/Button";
import { NativeOwnerLink } from "../../../ui/NativeOwnerLink";
import { TechnicalDetails } from "../../../ui/TechnicalDetails";
import { cn } from "../../../lib/cn";
import { ConnectorSignInStep } from "./ConnectorSignInStep";
import { isActiveInstallState } from "./connector-install-store";
import type { ConnectorInstall, ConnectorInstallState, ConnectorInstallStep } from "./use-connector-install";

/** The steps a flow can list, in the order they happen. */
export type InstallStepId = "approval" | "plan" | "sign_in" | "switch_on" | "connect";
const STEP_ORDER: readonly InstallStepId[] = ["approval", "plan", "sign_in", "switch_on", "connect"];
const STEP_TITLES: Readonly<Record<InstallStepId, string>> = {
  approval: "Approve in Inbox",
  plan: "Allow and save",
  sign_in: "Sign in",
  switch_on: "Switch on",
  connect: "Connect",
};

type StepState = "done" | "running" | "waiting" | "not_started" | "failed";
/** Each step's state is a word and an icon, never colour alone. */
const STEP_LOOKS: Readonly<Record<StepState, { word: string; icon: LucideIcon; className: string }>> = {
  done: { word: "Done", icon: Check, className: "text-status-done" },
  running: { word: "In progress", icon: LoaderCircle, className: "text-status-running motion-safe:animate-spin" },
  waiting: { word: "Waiting", icon: Hand, className: "text-status-waiting" },
  not_started: { word: "Not started", icon: Circle, className: "text-fg-muted" },
  failed: { word: "Didn't finish", icon: X, className: "text-status-failed" },
};

const BUSY_WORDS: Readonly<Record<ConnectorInstallStep, string>> = {
  plan: "Installing…",
  approval: "Stopping…",
  sign_in: "Starting sign-in…",
  finish_sign_in: "Finishing sign-in…",
  switch_on: "Switching on…",
  connect: "Connecting…",
};
/** The failed step in plain words; the flow's own message follows it. */
const FAILED_WORDS: Readonly<Record<ConnectorInstallStep, string>> = {
  plan: "Couldn't allow and save it.",
  approval: "Couldn't get it approved.",
  sign_in: "Couldn't sign in.",
  finish_sign_in: "Couldn't finish signing in.",
  switch_on: "Couldn't switch it on.",
  connect: "Couldn't connect it.",
};
const WAITING_INBOX = "Waiting on you in Inbox";
const SIGNING_IN = "Finish signing in in your browser";

/** The Inbox page for the install's approval. Install plans are made in the installation's own workspace. */
const inboxApprovalHref = (approvalId: string) =>
  `/inbox?approvalId=${encodeURIComponent(approvalId)}&workspaceId=default`;

const stepOf = (step: ConnectorInstallStep): InstallStepId => (step === "finish_sign_in" ? "sign_in" : step);

function currentStep(state: ConnectorInstallState): InstallStepId | undefined {
  switch (state.phase) {
    case "working":
    case "failed":
      return stepOf(state.step);
    case "waiting_inbox":
      return "approval";
    case "signing_in":
      return "sign_in";
    default:
      return undefined;
  }
}

/** What the flow's button says while it runs. */
function busyLabel(state: ConnectorInstallState): string | undefined {
  if (state.phase === "working") return BUSY_WORDS[state.step];
  if (state.phase === "waiting_inbox") return "Waiting on Inbox…";
  if (state.phase === "signing_in") return "Waiting on sign-in…";
  return undefined;
}

/**
 * Stop acts only where it can (R84): while the install waits in Inbox, and once the app is saved. A plan that is
 * applying can't be stopped, and a withdrawal already in flight isn't sent twice.
 */
export function canStopInstall(state: ConnectorInstallState): boolean {
  if (state.phase === "waiting_inbox" || state.phase === "signing_in") return true;
  return state.phase === "working" && state.step !== "plan" && state.step !== "approval";
}

/** The one sentence read out when the flow moves on. `doneWords` says how this flow ends ("Installed."). */
export function installAnnouncement(state: ConnectorInstallState, doneWords: string): string {
  switch (state.phase) {
    case "idle":
      return "";
    case "working":
      return BUSY_WORDS[state.step];
    case "waiting_inbox":
      return WAITING_INBOX;
    case "signing_in":
      return state.manualError ?? SIGNING_IN;
    case "failed":
      return FAILED_WORDS[state.step];
    case "stopped":
      return state.message;
    case "done":
      return doneWords;
  }
}

/**
 * The flow's one live region. It stays on the page for as long as the flow can be shown, so each change is read out
 * once, including the last one when the panel turns into the saved server's view.
 */
export function InstallStatus({ state, doneWords }: { state: ConnectorInstallState; doneWords: string }) {
  return (
    <p role="status" className="sr-only">
      {installAnnouncement(state, doneWords)}
    </p>
  );
}

function StepList({ steps, state }: { steps: readonly InstallStepId[]; state: ConnectorInstallState }) {
  const current = currentStep(state);
  const at = current ? steps.indexOf(current) : -1;
  const stateAt = (index: number): StepState => {
    if (index < at) return "done";
    if (index > at) return "not_started";
    if (state.phase === "failed") return "failed";
    return state.phase === "working" ? "running" : "waiting";
  };
  return (
    <ol className="space-y-1.5">
      {steps.map((step, index) => {
        const look = STEP_LOOKS[stateAt(index)];
        const Icon = look.icon;
        return (
          <li
            key={step}
            data-install-step
            aria-current={index === at ? "step" : undefined}
            className="flex flex-wrap items-center gap-x-2 text-sm"
          >
            <Icon aria-hidden="true" className={cn("size-4 shrink-0", look.className)} />
            <span data-step-title className="text-fg">
              {STEP_TITLES[step]}
            </span>
            <span data-step-word className="text-xs text-fg-secondary">
              {look.word}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** What already happened, so a failure or a stop never leaves the operator guessing. */
function ChangedList({ changed, emptyLine }: { changed: readonly string[]; emptyLine?: string }) {
  if (changed.length === 0 && !emptyLine) return null;
  return (
    <div data-install-changed className="space-y-1">
      <p className="font-medium text-fg">What changed</p>
      {changed.length > 0 ? (
        <ul className="list-disc space-y-0.5 pl-5">
          {changed.map((sentence, index) => (
            // The same sentence can come twice, so the position keeps each key apart.
            <li key={`${index}:${sentence}`}>{sentence}</li>
          ))}
        </ul>
      ) : (
        <p>{emptyLine}</p>
      )}
    </div>
  );
}

function PhaseBody({ install, scope, doneLine }: { install: ConnectorInstall; scope: string; doneLine?: string }) {
  const { state } = install;
  switch (state.phase) {
    case "waiting_inbox":
      return (
        <div className="space-y-1 text-sm text-fg-secondary">
          <p>
            <span className="font-medium text-fg">{WAITING_INBOX}</span>{" "}
            <NativeOwnerLink scope={scope} href={inboxApprovalHref(state.approvalId)}>
              Open in Inbox
            </NativeOwnerLink>
          </p>
          <p>This request expires after 15 minutes.</p>
        </div>
      );
    case "signing_in":
      return <ConnectorSignInStep state={state} submit={install.submitManualCode} />;
    case "failed":
      return (
        <div className="space-y-2 text-sm text-fg-secondary">
          <p className="font-medium text-status-failed">{FAILED_WORDS[state.step]}</p>
          <p>{state.message}</p>
          <ChangedList changed={state.changed} emptyLine="Nothing was changed." />
          {state.detail ? (
            <TechnicalDetails label="Error details">
              <p className="break-all font-mono text-xs">{state.detail}</p>
            </TechnicalDetails>
          ) : null}
        </div>
      );
    case "stopped":
      return (
        <div className="space-y-2 text-sm text-fg-secondary">
          <p className="text-fg">{state.message}</p>
          <ChangedList changed={state.changed} />
        </div>
      );
    case "done":
      return doneLine ? <p className="text-sm text-fg">{doneLine}</p> : null;
    default:
      return null;
  }
}

/**
 * One install's progress, or a saved server's sign-in or connect: the flow's button (busy while it runs), Stop where it
 * can act, the steps with their state in words, and what each phase needs from the operator. A failure names its step,
 * says what already changed and keeps the error text inside Technical details. A finished or stopped result can be
 * dismissed. The flow itself is the hook's (`useConnectorInstall`); nothing here moves it on.
 */
export function ConnectorInstallProgress({
  install,
  scope,
  steps,
  action,
  doneLine,
}: {
  install: ConnectorInstall;
  /** The panel this sits in, for the Inbox link's leave review. */
  scope: string;
  /** The steps this flow runs. The Inbox step joins them once the flow has waited there. */
  steps: readonly InstallStepId[];
  /** The button that starts the flow. Left out, there is none (a finished install has nothing left to start). */
  action?: { label: string; run: () => void };
  /** Said once the flow is done, while the panel still shows it. */
  doneLine?: string;
}) {
  const { state } = install;
  // The hook doesn't say whether the flow waited in Inbox, so this view remembers it saw that.
  const [waited, setWaited] = useState(false);
  if (state.phase === "waiting_inbox" && !waited) setWaited(true);
  const current = currentStep(state);
  const listed = STEP_ORDER.filter(
    (step) => steps.includes(step) || step === current || (step === "approval" && waited),
  );
  const showSteps = isActiveInstallState(state) || state.phase === "failed";
  const settled = state.phase === "failed" || state.phase === "stopped";
  return (
    <div className="space-y-3">
      {action || canStopInstall(state) || settled ? (
        <div className="flex flex-wrap items-center gap-2">
          {action ? (
            <Button
              variant="primary"
              size="sm"
              loading={isActiveInstallState(state)}
              loadingLabel={busyLabel(state)}
              onClick={() => {
                setWaited(false);
                action.run();
              }}
            >
              {action.label}
            </Button>
          ) : null}
          {canStopInstall(state) ? (
            <Button size="sm" onClick={install.cancel}>
              Stop
            </Button>
          ) : null}
          {settled ? (
            <Button size="sm" variant="ghost" onClick={install.cancel}>
              Dismiss
            </Button>
          ) : null}
        </div>
      ) : null}
      {showSteps ? <StepList steps={listed} state={state} /> : null}
      <PhaseBody install={install} scope={scope} doneLine={doneLine} />
    </div>
  );
}
