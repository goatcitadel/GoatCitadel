import { lazy, Suspense, useState, type ComponentProps, type ReactNode } from "react";
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

/** One loading projection shared by optional leaves; failures stay local and visible. */
export function DeferredChatLeaf({
  label,
  identity,
  children,
  loadingVisible = true,
}: {
  label: string;
  identity: string;
  children: ReactNode;
  loadingVisible?: boolean;
}) {
  return (
    <AreaErrorBoundary label={label} resetKey={identity}>
      <Suspense
        fallback={
          loadingVisible ? (
            <p aria-busy="true" className="p-3 text-sm text-fg-muted">
              Loading {label.toLowerCase()}…
            </p>
          ) : null
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
