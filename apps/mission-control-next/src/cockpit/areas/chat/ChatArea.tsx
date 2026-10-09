import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { useQuery } from "@tanstack/react-query";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { fetchOnboardingState } from "@goatcitadel/mission-control-shared/api/client";
import {
  MissionThreadedControllerHost,
  type MissionThreadedActiveSessionSurfaceProps,
  type MissionThreadedRenderSurfaceInput,
} from "@goatcitadel/threaded-surface-core";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { ChatConversationFilters } from "./ChatConversationFilters";
import { ChatEmptyState, ChatHeaderSubtitle, ChatSetupBanner } from "./ChatAreaChrome";
import { ChatMobileConversationSelect } from "./ChatMobileConversationSelect";
import { ChatTranscript } from "./ChatTranscript";
import { ChatTextComposer } from "./ChatTextComposer";
import { ChatSessionOverflow, ChatSessionTitle } from "./ChatSessionControls";
import { ChatInspector } from "./ChatInspector";
import { chatSelectionHref } from "./chat-selection-evidence";
import { readCockpitHistory } from "../../app/cockpit-history";
import { SelectedThreadActivity } from "./SelectedThreadActivity";
import { ThreadList } from "./ThreadList";
import { useInspector } from "../../app/inspector";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { ChatOwnerNavigationBoundary } from "./ChatOwnerNavigationBoundary";
import { useChatOwnerNavigation } from "./use-chat-owner-navigation";
import { ChatTimerPanel } from "../../../features/threaded-surface/ChatTimerPanel";
import { ChatSessionStatusPanel } from "../../../features/threaded-surface/ChatSessionStatusPanel";

const LazyChatBuildEditor = lazy(async () => ({ default: (await import("./ChatBuildEditor")).ChatBuildEditor }));

export function buildEditorTurnId(active: MissionThreadedActiveSessionSurfaceProps | null): string | undefined {
  const selectedPath = active?.thread?.turns.filter((turn) => turn.branch.isSelectedPath) ?? [];
  return selectedPath.find((turn) => turn.turnId === active?.selectedTurnId)?.turnId ?? selectedPath.at(-1)?.turnId;
}

/** Only the one canonical artifact URL publication may complete this read. */
export function artifactInspectorHistoryMatches(origin: string, target: string, current: string) {
  if (current === origin) return true;
  const separator = origin.indexOf(":");
  const generation = Number(origin.slice(0, separator));
  return separator > 0 && Number.isSafeInteger(generation) && current === `${generation + 1}:${target}`;
}

export function ChatArea({
  onVisibleSessionChange,
  gatewayUnavailable,
}: {
  onVisibleSessionChange?: (sessionId: string | undefined) => void;
  gatewayUnavailable?: boolean;
}) {
  const { activeWorkspaceId, activeCitadelId } = useUiPreferences();
  // `search` is the page the views show: while a Back move is held, the live URL names its target.
  const { navigate, search } = useCockpitRoute();

  const conversationNavigation = useChatOwnerNavigation(activeWorkspaceId ?? "default", activeCitadelId);
  return (
    <div className="cockpit-chat-host flex min-h-0 min-w-0 flex-1 flex-col">
      <MissionThreadedControllerHost
        workspaceId={activeWorkspaceId ?? "default"}
        surface="chat"
        lockSurface
        hidePageHeader
        renderWhileLoading
        routeSearch={search}
        onNavigateSurface={conversationNavigation.request}
        onOpenApprovals={(approvalId) =>
          navigate(
            approvalId
              ? `/inbox?item=approval:${encodeURIComponent(approvalId)}&workspaceId=${encodeURIComponent(activeWorkspaceId ?? "default")}&shell=cockpit`
              : "/inbox?shell=cockpit",
          )
        }
        onOpenTasks={() => navigate("/work?shell=cockpit")}
        onOpenStartHere={() => navigate("/settings/first-run?shell=cockpit")}
        onOpenPersonalitiesSettings={() => navigate("/settings/general?shell=cockpit#work-personality")}
        onOpenProviderSettings={() => navigate("/settings/models?shell=cockpit#providers")}
        onReturnToChannels={(href) => navigate(href)}
        onOpenLocalAiSettings={() => navigate("/settings/models?shell=cockpit#local-ai")}
        onOpenLibraryArtifacts={() => navigate("/library/artifacts?shell=cockpit")}
        onOpenLibraryImports={() => navigate("/library/knowledge?shell=cockpit")}
        onOpenOpsRuntime={() => navigate("/system/health?shell=cockpit")}
        renderSurface={(input: MissionThreadedRenderSurfaceInput) => (
          <ChatOwnerNavigationBoundary input={input} owner={conversationNavigation}>
            {(reviewedInput) => (
              <ChatAreaView
                input={reviewedInput}
                gatewayUnavailable={gatewayUnavailable}
                onVisibleSessionChange={onVisibleSessionChange}
              />
            )}
          </ChatOwnerNavigationBoundary>
        )}
      />
    </div>
  );
}

export function ChatAreaView({
  input,
  onVisibleSessionChange,
  gatewayUnavailable,
}: {
  input: MissionThreadedRenderSurfaceInput;
  onVisibleSessionChange?: (sessionId: string | undefined) => void;
  gatewayUnavailable?: boolean;
}) {
  const { navigate } = useCockpitRoute();
  const { activeCitadelId, activeWorkspaceId } = useUiPreferences();
  const onboarding = useQuery({ queryKey: ["system", "onboarding"], queryFn: fetchOnboardingState, staleTime: 60_000 });
  const { open, register, closeIfOpen, getDismissalGeneration } = useInspector();
  const inspectorTurnId = useRef<string | null>(null);
  const inspectorTab = useRef<"run" | "turn" | "files">("run");
  const [buildOpen, setBuildOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const active = input.activeSessionSurfaceProps;
  const selectedSessionId = input.sessionRail.selectedSessionId ?? undefined;
  const inspectorIdentity = JSON.stringify([
    getGatewayApiBaseUrl(),
    activeCitadelId,
    activeWorkspaceId,
    selectedSessionId,
  ]);
  const inspectorView = useRef({ identity: inspectorIdentity });
  if (inspectorView.current.identity !== inspectorIdentity) {
    inspectorView.current = { identity: inspectorIdentity };
    inspectorTurnId.current = null;
    inspectorTab.current = "run";
  }
  const renderedInspectorView = inspectorView.current;
  const pendingArtifact = useRef<{
    view: object;
    turnId: string;
    artifactId: string;
    target: string;
    history: string;
    dismissal: number;
    ready: boolean;
  } | null>(null);
  const [artifactReadRevision, setArtifactReadRevision] = useState(0);
  useEffect(() => {
    const pending = pendingArtifact.current;
    if (!pending) return;
    if (
      pending.view !== renderedInspectorView ||
      pending.dismissal !== (getDismissalGeneration?.() ?? 0) ||
      !artifactInspectorHistoryMatches(pending.history, pending.target, readCockpitHistory())
    ) {
      pendingArtifact.current = null;
      return;
    }
    const artifact = input.contextDockProps?.activeGeneratedArtifact;
    if (
      !pending.ready ||
      window.location.href !== pending.target ||
      artifact?.artifactId !== pending.artifactId ||
      artifact.turnId !== pending.turnId ||
      artifact.sessionId !== selectedSessionId ||
      artifact.workspaceId !== (activeWorkspaceId ?? "default") ||
      active?.selectedSessionId !== selectedSessionId ||
      input.contextDockProps?.selectedSessionId !== selectedSessionId
    )
      return;
    pendingArtifact.current = null;
    inspectorTurnId.current = pending.turnId;
    inspectorTab.current = "files";
    open({
      source: "chat",
      title: "Conversation",
      body: <ChatInspector input={input} targetTurnId={pending.turnId} initialTab="files" />,
    });
  }, [
    input,
    active,
    open,
    renderedInspectorView,
    selectedSessionId,
    activeWorkspaceId,
    getDismissalGeneration,
    artifactReadRevision,
  ]);
  useEffect(
    () => () => {
      pendingArtifact.current = null;
    },
    [],
  );
  const codePanel = input.workflowPanel?.kind === "code" ? input.workflowPanel : null;
  const latestLocalNotice = active?.notices.find((notice) => notice.id.startsWith("notice-"));
  const session = input.sessionRail.missionSessions.find((item) => item.sessionId === selectedSessionId);
  const latestTurnId = active?.thread?.turns.filter((turn) => turn.branch.isSelectedPath).at(-1)?.turnId;
  const openInspector = (turnId?: string, tab: "run" | "turn" | "files" = "run") => {
    if (inspectorView.current !== renderedInspectorView) return;
    inspectorTurnId.current = turnId ?? null;
    inspectorTab.current = tab;
    if (turnId) active?.onSelectTurn(turnId);
    open({
      source: "chat",
      title: "Conversation",
      body: <ChatInspector input={input} targetTurnId={inspectorTurnId.current} initialTab={inspectorTab.current} />,
    });
  };
  useEffect(() => {
    onVisibleSessionChange?.(selectedSessionId);
  }, [onVisibleSessionChange, selectedSessionId]);
  useEffect(() => setBuildOpen(false), [selectedSessionId]);
  useEffect(() => () => onVisibleSessionChange?.(undefined), [onVisibleSessionChange]);
  useEffect(() => {
    if (active && selectedSessionId)
      register("chat", {
        source: "chat",
        title: "Conversation",
        body: <ChatInspector input={input} targetTurnId={inspectorTurnId.current} initialTab={inspectorTab.current} />,
      });
    else closeIfOpen("chat");
  }, [input, active, selectedSessionId, register, closeIfOpen]);
  useEffect(() => () => closeIfOpen("chat"), [closeIfOpen]);
  return (
    <section aria-label="Chat" className="flex min-h-0 min-w-0 flex-1">
      <ThreadList rail={input.sessionRail} projectOptions={input.contextDockProps?.projectOptions} />
      {filtersOpen ? (
        <Dialog
          open
          onOpenChange={setFiltersOpen}
          title="Filter conversations"
          description="Choose a project or folder, then search within that view. These filters use the current conversation history."
        >
          <ChatConversationFilters rail={input.sessionRail} projectOptions={input.contextDockProps?.projectOptions} />
          <Button className="mt-3" onClick={() => setFiltersOpen(false)}>
            Done
          </Button>
        </Dialog>
      ) : null}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex min-h-12 items-center justify-between gap-2 border-b border-line-subtle px-3">
          <div className="min-w-0 flex-1">
            <ChatSessionTitle
              key={selectedSessionId}
              title={active?.sessionTitle ?? "Chat"}
              dock={input.contextDockProps}
            />
            <ChatHeaderSubtitle
              active={active}
              projectName={session?.projectName}
              loading={input.sessionRail.loading}
            />
          </div>
          <ChatMobileConversationSelect rail={input.sessionRail} onOpenFilters={() => setFiltersOpen(true)} />
          <SelectedThreadActivity session={session} />
          <Button
            size="sm"
            className="md:hidden max-sm:h-11 max-sm:px-4"
            aria-label="New conversation"
            disabled={input.sessionRail.creatingSession || input.sessionRail.loading}
            onClick={() => void input.sessionRail.onCreateSession()}
          >
            New
          </Button>
          {active ? (
            <Button size="sm" className="hidden md:inline-flex" onClick={() => openInspector()}>
              Inspect
            </Button>
          ) : null}
          {codePanel ? (
            <Button
              size="sm"
              className="whitespace-nowrap max-sm:h-11 max-sm:px-3"
              aria-expanded={buildOpen}
              aria-label={buildOpen ? "Back to conversation" : "Build editor"}
              onClick={() => {
                if (!buildOpen) {
                  const turnId = buildEditorTurnId(active);
                  if (turnId) active?.onSelectTurn(turnId);
                }
                setBuildOpen((open) => !open);
              }}
            >
              <span className="max-sm:hidden">{buildOpen ? "Back to conversation" : "Build editor"}</span>
              <span aria-hidden="true" className="sm:hidden">
                {buildOpen ? "Back" : "Build"}
              </span>
            </Button>
          ) : null}
          {active ? (
            <ChatSessionOverflow
              key={selectedSessionId}
              dock={input.contextDockProps}
              onFork={latestTurnId ? () => active.onStartNewThreadFromTurn(latestTurnId) : undefined}
              onInspect={() => openInspector()}
            />
          ) : null}
        </header>
        {onboarding.data && !onboarding.isError && !onboarding.data.completed && !buildOpen ? (
          <ChatSetupBanner onReturnToSetup={() => navigate("/settings/first-run")} />
        ) : null}
        {buildOpen && active?.streamError ? (
          <p role="alert" className="border-b border-status-failed bg-sunken px-3 py-2 text-sm text-fg-secondary">
            {active.streamError}
          </p>
        ) : null}
        {buildOpen && latestLocalNotice ? (
          <p role="status" className="border-b border-line-subtle bg-sunken px-3 py-2 text-sm text-fg-secondary">
            {latestLocalNotice.content}
          </p>
        ) : null}
        {buildOpen && codePanel ? (
          <Suspense
            fallback={
              <p role="status" className="p-4 text-sm text-fg-muted">
                Loading build editor…
              </p>
            }
          >
            <LazyChatBuildEditor key={selectedSessionId} panel={codePanel} />
          </Suspense>
        ) : active ? (
          <div className="cockpit-chat-content flex min-h-0 flex-1 flex-col">
            <ChatTranscript
              gatewayUnavailable={gatewayUnavailable}
              props={active}
              receipt={input.changePlanReceipt}
              onInspectTurn={(turnId) => openInspector(turnId, "turn")}
              onInspectRun={(turnId) => openInspector(turnId, "run")}
              onOpenArtifact={(turnId, artifactId) => {
                const exactId =
                  artifactId ??
                  active.thread?.turns.find((turn) => turn.turnId === turnId)?.generatedArtifacts?.[0]?.artifactId;
                if (!exactId || !selectedSessionId || inspectorView.current !== renderedInspectorView) return;
                const pending = {
                  view: renderedInspectorView,
                  turnId,
                  artifactId: exactId,
                  ready: false,
                  target: new URL(
                    chatSelectionHref({ sessionId: selectedSessionId, turnId, artifactId: exactId }),
                    window.location.origin,
                  ).href,
                  history: readCockpitHistory(),
                  dismissal: getDismissalGeneration?.() ?? 0,
                };
                pendingArtifact.current = pending;
                void Promise.resolve(active.onOpenGeneratedArtifact(turnId, exactId)).then(
                  () => {
                    if (pendingArtifact.current !== pending || inspectorView.current !== pending.view) return;
                    pending.ready = true;
                    setArtifactReadRevision((revision) => revision + 1);
                  },
                  () => {
                    if (pendingArtifact.current === pending) pendingArtifact.current = null;
                  },
                );
              }}
            />
          </div>
        ) : (
          <ChatEmptyState rail={input.sessionRail} />
        )}
        {active?.sessionStatusPanel?.open && !buildOpen ? (
          <div className="cockpit-chat-status-panel overflow-y-auto border-t border-line-subtle p-3">
            <ChatSessionStatusPanel panel={active.sessionStatusPanel} />
          </div>
        ) : null}
        {active && !buildOpen ? (
          <ChatTextComposer
            props={active}
            gatewayUnavailable={gatewayUnavailable}
            onOpenSchedules={() => navigate("/work/schedules")}
          />
        ) : null}
        {active?.chatTimerPanel ? <ChatTimerPanel panel={active.chatTimerPanel} /> : null}
      </div>
    </section>
  );
}
