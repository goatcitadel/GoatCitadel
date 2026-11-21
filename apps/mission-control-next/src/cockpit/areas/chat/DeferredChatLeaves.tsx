import { isBackgroundChatUserInputPrompt, type ApprovalRequest } from "@goatcitadel/contracts";
import { lazy, Suspense, useRef, useState, type ComponentProps, type ReactNode } from "react";
import {
  createDeferredDialogRuntime,
  PendingDialog,
  useDeferredDialogRuntime,
} from "@goatcitadel/mission-control-shared/components/ui/deferred-dialog";
import type { ChatTimerPanel } from "../../../features/threaded-surface/ChatTimerPanel";
import type { SessionControlBanner } from "../../../features/threaded-surface/SessionControlBanner";
import { AreaErrorBoundary } from "../../ui/AreaErrorBoundary";

const BtwPanel = lazy(async () => ({
  default: (await import("../../../features/threaded-surface/ThreadedBtwSideChatPanel")).ThreadedBtwSideChatPanel,
}));
const SessionStatusPanel = lazy(async () => ({
  default: (await import("../../../features/threaded-surface/ChatSessionStatusPanel")).ChatSessionStatusPanel,
}));
const CodeModeCard = lazy(async () => ({
  default: (await import("./ChatCodeModeRequestCard")).ChatCodeModeRequestCard,
}));
const ErrandCards = lazy(async () => ({ default: (await import("./ChatBrowserErrandCard")).ChatBrowserErrandCards }));
const timerLoader = createDeferredDialogRuntime(() =>
  import("../../../features/threaded-surface/ChatTimerPanel").then(({ ChatTimerPanel }) => ChatTimerPanel),
);
const SessionControl = lazy(async () => ({
  default: (await import("../../../features/threaded-surface/SessionControlBanner")).SessionControlBanner,
}));
const ChatInspector = lazy(async () => ({ default: (await import("./ChatInspector")).ChatInspector }));
const ProjectAssignmentReview = lazy(async () => ({
  default: (await import("./ProjectAssignmentReview")).ProjectAssignmentReview,
}));
const ChatPendingQuestion = lazy(async () => ({
  default: (await import("./ChatPendingQuestion")).ChatPendingQuestion,
}));

export function DeferredPendingChatQuestion({
  identity,
  ...props
}: ComponentProps<typeof ChatPendingQuestion> & { identity: string }) {
  const { prompt } = props;
  return (
    <DeferredChatLeaf
      identity={identity}
      label="Answer controls"
      fallback={
        <section
          aria-label="Pending question"
          tabIndex={-1}
          data-chat-waiting-decision=""
          className="mt-3 border-l-2 border-status-waiting pl-3 text-sm"
        >
          <h3 className="font-semibold text-fg">{prompt.title || "Your input is needed"}</h3>
          {isBackgroundChatUserInputPrompt(prompt) ? (
            <p className="mt-1 text-xs text-fg-muted">Optional · Work continues</p>
          ) : null}
          <p className="mt-1 text-fg-secondary">{prompt.question}</p>
          <p aria-busy="true" className="mt-2 text-xs text-fg-muted">
            Loading answer controls…
          </p>
        </section>
      }
    >
      <ChatPendingQuestion {...props} />
    </DeferredChatLeaf>
  );
}

export function DeferredChatInspector(props: ComponentProps<typeof ChatInspector>) {
  return (
    <DeferredChatLeaf label="Conversation details" identity={props.input.sessionRail.selectedSessionId ?? ""}>
      <ChatInspector {...props} />
    </DeferredChatLeaf>
  );
}

export function DeferredProjectAssignmentReview({
  active,
  search,
  identity,
}: ComponentProps<typeof ProjectAssignmentReview> & { search: string; identity: string }) {
  const params = new URLSearchParams(search);
  if (!params.get("assignProjectId") || active.selectedSessionId !== params.get("sessionId")) return null;
  return (
    <DeferredChatLeaf label="Project assignment" identity={identity}>
      <ProjectAssignmentReview active={active} />
    </DeferredChatLeaf>
  );
}

export function DeferredSessionControlBanner(props: ComponentProps<typeof SessionControlBanner>) {
  if (!props.model.externalControlActive) return null;
  return (
    <DeferredChatLeaf
      label="External session controls"
      identity={props.model.generationLabel}
      fallback={
        <p className="p-3 text-sm text-fg-muted" aria-busy="true">
          {props.model.sendLockReason ?? `This session is controlled by ${props.model.ownerLabel}.`}
        </p>
      }
    >
      <SessionControl {...props} />
    </DeferredChatLeaf>
  );
}

export function DeferredChatTimerPanel({ panel }: ComponentProps<typeof ChatTimerPanel>) {
  const { runtime: TimerPanel, failed } = useDeferredDialogRuntime(panel.open, timerLoader);
  const handoff = useRef(false);
  handoff.current = panel.open && Boolean(TimerPanel);
  if (!panel.open) return null;
  if (TimerPanel) return <TimerPanel panel={panel} />;

  return (
    <PendingDialog
      title="Set a Chat timer"
      description="This saved reminder appends a system notice and never invokes a provider or model."
      closeLabel="Close"
      className="cockpit-dialog cockpit-pending-dialog fixed inset-x-4 top-4 m-0 mx-auto w-auto max-w-xl border-line bg-overlay p-4 text-fg shadow-overlay backdrop:bg-scrim sm:top-24"
      onDismiss={panel.onClose}
      handoff={handoff}
    >
      <p className="mt-3 text-sm" role={failed ? "alert" : "status"}>
        {failed ? "The timer could not load. Close and reopen it to try again." : "Loading timer controls…"}
      </p>
    </PendingDialog>
  );
}

/** One loading projection shared by optional leaves; failures stay local and visible. */
export function DeferredChatLeaf({
  label,
  identity,
  children,
  loadingVisible = true,
  fallback,
}: {
  label: string;
  identity: string;
  children: ReactNode;
  loadingVisible?: boolean;
  fallback?: ReactNode;
}) {
  return (
    <AreaErrorBoundary label={label} resetKey={identity}>
      <Suspense
        fallback={
          loadingVisible
            ? (fallback ?? (
                <p aria-busy="true" className="p-3 text-sm text-fg-muted">
                  Loading {label.toLowerCase()}…
                </p>
              ))
            : null
        }
      >
        {children}
      </Suspense>
    </AreaErrorBoundary>
  );
}

/** Once opened, retain the mounted component through close/reopen in this parent scope. */
export function DeferredBtwSideChatPanel(props: ComponentProps<typeof BtwPanel>) {
  const [warm, setWarm] = useState(Boolean(props.sideChat?.open));
  if (props.sideChat?.open && !warm) setWarm(true);
  if (!warm && !props.sideChat?.open) return null;
  const identity = JSON.stringify([props.sideChat?.workspaceId, props.sideChat?.parentSessionId]);
  return (
    <div hidden={!props.sideChat?.open}>
      <DeferredChatLeaf label="Aside" identity={identity} loadingVisible={Boolean(props.sideChat?.open)}>
        <BtwPanel {...props} />
      </DeferredChatLeaf>
    </div>
  );
}

export function DeferredSessionStatusPanel({
  hidden = false,
  ...props
}: ComponentProps<typeof SessionStatusPanel> & { hidden?: boolean }) {
  const open = props.panel.open && !hidden;
  const [warm, setWarm] = useState(open);
  if (open && !warm) setWarm(true);
  if (!warm && !open) return null;
  return (
    <div hidden={!open} className="cockpit-chat-status-panel overflow-y-auto border-t border-line-subtle p-3">
      <DeferredChatLeaf label="Session status" identity="session-status">
        <SessionStatusPanel {...props} />
      </DeferredChatLeaf>
    </div>
  );
}

/** Matching restored and active runs request their code in the render that discovers them. */
export function DeferredCodeModeRequestCard(props: ComponentProps<typeof CodeModeCard>) {
  if (!props.turn.toolRuns.some((run) => run.toolName === "code_mode.request")) return null;
  return (
    <DeferredChatLeaf label="Code Mode request" identity={JSON.stringify([props.workspaceId, props.turn.turnId])}>
      <CodeModeCard {...props} />
    </DeferredChatLeaf>
  );
}
export function DeferredBrowserErrandCards(props: ComponentProps<typeof ErrandCards>) {
  if (!props.toolRuns.some((run) => run.toolName === "browser.errand")) return null;
  return (
    <DeferredChatLeaf
      label="Browser errand"
      identity={JSON.stringify(
        props.toolRuns.filter((run) => run.toolName === "browser.errand").map((run) => run.toolRunId),
      )}
    >
      <ErrandCards {...props} />
    </DeferredChatLeaf>
  );
}

const ChatEmptyState = lazy(async () => ({ default: (await import("./ChatSetupViews")).ChatEmptyState }));
const ChatSetupGate = lazy(async () => ({ default: (await import("./ChatSetupViews")).ChatSetupGate }));
const loadingConversations = (
  <div className="flex min-h-0 flex-1 flex-col items-center justify-center-safe p-5 text-center">
    <p role="status" className="text-sm text-fg-muted">
      Loading conversations…
    </p>
  </div>
);

const LazyChatBuildEditor = lazy(async () => ({ default: (await import("./ChatBuildEditor")).ChatBuildEditor }));
const ChatApprovalTarget = lazy(async () => ({
  default: (await import("./ChatApprovalTarget")).ChatApprovalTarget,
}));

const ChatAllowanceReceipt = lazy(async () => ({
  default: (await import("./ChatAllowances")).ChatAllowanceReceipt,
}));
const ChatExpiredApprovalRecovery = lazy(async () => ({
  default: (await import("./ChatExpiredApprovalRecovery")).ChatExpiredApprovalRecovery,
}));

export function DeferredChatSetup({
  identity,
  ...props
}: Omit<ComponentProps<typeof ChatSetupGate>, "hidden"> & { identity: string }) {
  return (
    <DeferredChatLeaf label="Chat setup" identity={identity}>
      <ChatSetupGate {...props} hidden={false} />
    </DeferredChatLeaf>
  );
}

export function DeferredChatEmpty({
  identity,
  ...props
}: ComponentProps<typeof ChatEmptyState> & { identity: string }) {
  if (props.rail.loading) return loadingConversations;
  return (
    <DeferredChatLeaf label="Conversations" identity={identity} loadingVisible fallback={loadingConversations}>
      <ChatEmptyState {...props} />
    </DeferredChatLeaf>
  );
}

const loadingWorkbench = (
  <p aria-busy="true" className="p-4 text-sm text-fg-muted">
    Loading code workbench…
  </p>
);

export function DeferredChatBuildEditor({
  panel,
  sessionId,
  unavailable,
}: {
  panel: ComponentProps<typeof LazyChatBuildEditor>["panel"] | null;
  sessionId?: string;
  unavailable?: boolean;
}) {
  if (!panel) {
    if (!unavailable) return loadingWorkbench;
    return (
      <p role="alert" className="p-4 text-sm text-status-failed">
        The build editor could not load. Return to the conversation and try again.
      </p>
    );
  }
  return (
    <Suspense fallback={loadingWorkbench}>
      <LazyChatBuildEditor key={sessionId} panel={panel} />
    </Suspense>
  );
}

export function DeferredChatApprovalTarget({ approval }: { approval?: ApprovalRequest }) {
  const targetPreview = approval?.preview;
  const showTarget =
    targetPreview &&
    (typeof targetPreview.path === "string" ||
      typeof targetPreview.target === "string" ||
      (typeof targetPreview.command === "string" && typeof targetPreview.toolName === "string") ||
      (approval?.kind === "code_mode.run" && typeof targetPreview.codePreview === "string"));
  if (!showTarget) return null;
  return (
    <DeferredChatLeaf label="Approval target" identity={approval?.approvalId} fallback={null}>
      <ChatApprovalTarget kind={approval?.kind} preview={targetPreview} />
    </DeferredChatLeaf>
  );
}

export function DeferredChatAllowanceReceipt(props: ComponentProps<typeof ChatAllowanceReceipt>) {
  return (
    <DeferredChatLeaf
      label="Temporary allowance"
      identity={props.grant.grantId}
      fallback={<p className="mt-3 text-sm text-fg-secondary">{props.message}</p>}
    >
      <ChatAllowanceReceipt key={props.grant.grantId} {...props} />
    </DeferredChatLeaf>
  );
}

export function DeferredChatExpiredApprovalRecovery({
  approvalId,
  ...props
}: ComponentProps<typeof ChatExpiredApprovalRecovery> & { approvalId: string }) {
  return (
    <DeferredChatLeaf label="Approval recovery" identity={approvalId}>
      <ChatExpiredApprovalRecovery {...props} />
    </DeferredChatLeaf>
  );
}
