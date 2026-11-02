import { useEffect, useRef } from "react";
import { Button } from "../../../ui/Button";
import { SettingsApprovalDialog } from "../../settings/SettingsApprovalDialog";
import { CANT_BE_INSTALLED } from "./plugin-check-copy";
import {
  NEW_CHATS_NOTE,
  changesNewChats,
  firstUnfinishedPiece,
  progressLine,
  stepApprovalWords,
} from "./plugin-install-view";
import type { PluginInstall } from "./use-plugin-install";

const CANT_CHECK = "Can't check the install right now. It will try again.";

/** A line under the install: why it stopped (a failure), or what the last request met (a note). */
interface StopLine {
  text: string;
  failure: boolean;
}

/**
 * Why the install stopped or what the last request met, in plain words; none while all is well. A refused manifest has
 * its one line and the line that says it can't be installed. A decline is a note, not a failure: declining is the
 * operator's own choice. A request that didn't go through is a failure.
 */
function stopLines(flow: PluginInstall): StopLine[] {
  const { state } = flow;
  if (state.phase === "check_failed") {
    return [
      { text: state.message, failure: true },
      ...(state.inspectionId ? [{ text: CANT_BE_INSTALLED, failure: false }] : []),
    ];
  }
  // Being uninstalled isn't a failure: the uninstall below reads out its own progress, so this is a quiet line.
  if (state.phase === "failed" && isUninstalling(flow)) return [];
  if (state.phase === "failed") return [{ text: state.message, failure: true }];
  return [
    ...(flow.notice ? [{ text: flow.notice, failure: !flow.declined }] : []),
    ...(flow.unreadable ? [{ text: CANT_CHECK, failure: false }] : []),
  ];
}

/** The install handed over to an uninstall: its plugin reads as being uninstalled. */
function isUninstalling(flow: PluginInstall): boolean {
  return flow.state.phase === "failed" && flow.state.detail?.state === "uninstalling";
}

/**
 * The approval the install waits for, decided in the panel: the plugin's own (titled by GoatCitadel, "Install <name>")
 * or a skill's step ("Approve installing <skill>?", "Approve switching on <skill>?"). It belongs to the workspace the
 * plugin was checked or installed in, so it is read there; a decision is read back at once.
 */
function ApprovalInPlace({ flow, name }: { flow: PluginInstall; name: string }) {
  const { state } = flow;
  if (flow.asking) return null;
  if (state.phase === "planned" && state.approvalId) {
    // GoatCitadel's own title ("Install <name>") shows; the question is only the fallback.
    return (
      <SettingsApprovalDialog
        key={state.approvalId}
        approvalId={state.approvalId}
        workspaceId={flow.workspaceId}
        title={`Approve installing ${name}?`}
        reviewLabel="Review the change"
        loadFailureHint="Reload to try again."
        onResolved={() => flow.checkNow()}
      />
    );
  }
  if (state.phase !== "following" || !state.waitingApprovalId) return null;
  const piece = state.detail.pieces.find((item) => item.pendingApprovalId === state.waitingApprovalId);
  const words = stepApprovalWords(flow.waitingStep, piece?.label ?? name);
  return (
    <SettingsApprovalDialog
      key={state.waitingApprovalId}
      approvalId={state.waitingApprovalId}
      workspaceId={flow.workspaceId}
      title={words.title}
      {...(words.summary ? { summary: words.summary } : {})}
      reviewLabel="Review the change"
      loadFailureHint="Reload to try again."
      onResolved={() => flow.checkNow()}
    />
  );
}

/** Whether Continue has something to carry on: a skill whose next step this panel can ask for. */
function canContinue(flow: PluginInstall): boolean {
  if (flow.state.phase !== "following" || flow.asking || flow.chain) return false;
  const piece = firstUnfinishedPiece(flow.state.detail.pieces);
  return piece?.kind === "skill" && (piece.state === "check_passed" || piece.state === "installed_off");
}

/**
 * Where the install stands: one line read out as it moves (each piece's row shows the same on screen), the approval it
 * waits for in place, why it stopped, and the one action it offers: Install at a check that can be installed (only once
 * every hook secret is filled), Continue for an install that isn't finished, Check again after a check that couldn't
 * run. `onCheckAgain` is absent where the panel has its own way to check (the source form).
 */
export function PluginInstallProgress({
  flow,
  name,
  secretsReady,
  onInstall,
  onCheckAgain,
}: {
  flow: PluginInstall;
  name: string;
  secretsReady: boolean;
  onInstall: () => void;
  onCheckAgain?: () => void;
}) {
  const { state } = flow;
  const stops = stopLines(flow);
  const done = state.phase === "done" && state.detail ? changesNewChats(state.detail.pieces) : false;
  const { status, pressed } = useFocusKept(actionOf(flow, Boolean(onCheckAgain)));
  return (
    <div className="space-y-3">
      <ApprovalInPlace flow={flow} name={name} />
      {stops.length > 0 ? (
        <div role="alert" className="space-y-1">
          {stops.map((line) => (
            <p key={line.text} className={line.failure ? "text-status-failed" : "text-fg"}>
              {line.text}
            </p>
          ))}
        </div>
      ) : null}
      {state.phase === "failed" && isUninstalling(flow) ? <p className="text-fg">{state.message}</p> : null}
      {done ? <p>{NEW_CHATS_NOTE}</p> : null}
      <ProgressAction
        flow={flow}
        secretsReady={secretsReady}
        onInstall={onInstall}
        onCheckAgain={onCheckAgain}
        onPressed={pressed}
      />
      {/* Always in place, so each new line is read out; the pieces' rows carry it on screen too. */}
      <p ref={status} tabIndex={-1} role="status" className="text-fg focus:outline-none">
        {progressLine(flow, name)}
      </p>
    </div>
  );
}

type ProgressActionKind = "install" | "continue" | "check_again" | undefined;

/** Which one action the install offers now, if any. */
function actionOf(flow: PluginInstall, canCheckAgain: boolean): ProgressActionKind {
  const { state } = flow;
  if (state.phase === "ready" && state.inspection.installable) return "install";
  if (canContinue(flow)) return "continue";
  const stopped =
    (state.phase === "check_failed" && !state.inspectionId) || (state.phase === "failed" && !state.detail);
  return stopped && canCheckAgain ? "check_again" : undefined;
}

/**
 * Keeps keyboard focus in the panel: when the button the operator pressed goes away (the install moved on), focus moves
 * to the progress line, which says where it stands, instead of falling to the page.
 */
function useFocusKept(action: ProgressActionKind) {
  const status = useRef<HTMLParagraphElement>(null);
  const pressedRef = useRef(false);
  const last = useRef(action);
  useEffect(() => {
    if (last.current === action) return;
    last.current = action;
    const lost = document.activeElement === null || document.activeElement === document.body;
    if (pressedRef.current && lost) status.current?.focus();
    pressedRef.current = false;
  }, [action]);
  return { status, pressed: () => (pressedRef.current = true) };
}

/** The one action where the install stands: Install, Continue or Check again, or none. */
function ProgressAction({
  flow,
  secretsReady,
  onInstall,
  onCheckAgain,
  onPressed,
}: {
  flow: PluginInstall;
  secretsReady: boolean;
  onInstall: () => void;
  onCheckAgain?: () => void;
  onPressed: () => void;
}) {
  const action = actionOf(flow, Boolean(onCheckAgain));
  const press = (run: () => void) => () => {
    onPressed();
    run();
  };
  return (
    <>
      {action === "install" ? (
        <Button
          variant="primary"
          disabled={!secretsReady}
          loading={flow.asking}
          loadingLabel="Asking…"
          onClick={press(onInstall)}
        >
          Install
        </Button>
      ) : null}
      {action === "continue" ? (
        <Button variant="primary" onClick={press(() => void flow.confirm({}))}>
          Continue
        </Button>
      ) : null}
      {action === "check_again" && onCheckAgain ? <Button onClick={press(onCheckAgain)}>Check again</Button> : null}
    </>
  );
}
