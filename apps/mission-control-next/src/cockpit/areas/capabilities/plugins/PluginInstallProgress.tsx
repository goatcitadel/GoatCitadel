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
  if (state.phase === "failed") return [{ text: state.message, failure: true }];
  return [
    ...(flow.notice ? [{ text: flow.notice, failure: !flow.declined }] : []),
    ...(flow.unreadable ? [{ text: CANT_CHECK, failure: false }] : []),
  ];
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
      {done ? <p>{NEW_CHATS_NOTE}</p> : null}
      <ProgressAction flow={flow} secretsReady={secretsReady} onInstall={onInstall} onCheckAgain={onCheckAgain} />
      {/* Always in place, so each new line is read out; the pieces' rows carry it on screen too. */}
      <p role="status" className="text-fg">
        {progressLine(flow, name)}
      </p>
    </div>
  );
}

/** The one action where the install stands: Install, Continue or Check again, or none. */
function ProgressAction({
  flow,
  secretsReady,
  onInstall,
  onCheckAgain,
}: {
  flow: PluginInstall;
  secretsReady: boolean;
  onInstall: () => void;
  onCheckAgain?: () => void;
}) {
  const { state } = flow;
  const installable = state.phase === "ready" && state.inspection.installable;
  const checkAgain =
    (state.phase === "check_failed" && !state.inspectionId) || (state.phase === "failed" && !state.detail);
  return (
    <>
      {installable ? (
        <Button
          variant="primary"
          disabled={!secretsReady}
          loading={flow.asking}
          loadingLabel="Asking…"
          onClick={onInstall}
        >
          Install
        </Button>
      ) : null}
      {canContinue(flow) ? (
        <Button variant="primary" onClick={() => void flow.confirm({})}>
          Continue
        </Button>
      ) : null}
      {checkAgain && onCheckAgain ? <Button onClick={onCheckAgain}>Check again</Button> : null}
    </>
  );
}
