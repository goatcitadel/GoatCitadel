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
