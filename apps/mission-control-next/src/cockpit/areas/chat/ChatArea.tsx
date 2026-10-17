import { lazy, Suspense, useContext, useEffect, useRef, useState } from "react";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { useQuery } from "@tanstack/react-query";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { fetchOnboardingState } from "@goatcitadel/mission-control-shared/api/client";
import {
  MissionThreadedControllerHost,
  type MissionThreadedActiveSessionSurfaceProps,
  type MissionThreadedRenderSurfaceInput,
} from "@goatcitadel/threaded-surface-core";
import { ChatConversationsSheet } from "./ChatConversationsSheet";
import { ChatEmptyState, ChatSessionHeader, ChatSetupBanner } from "./ChatAreaChrome";
import { ChatTranscript } from "./ChatTranscript";
import { ChatStreamErrorNotice } from "./ChatStreamErrorNotice";
import { ChatTextComposer } from "./ChatTextComposer";
import { ChatInspector } from "./ChatInspector";
import { chatSelectionHref } from "./chat-selection-evidence";
import { readCockpitHistory } from "../../app/cockpit-history";
import { ThreadList } from "./ThreadList";
import { useInspector } from "../../app/inspector";
import { InspectorSourceContext } from "../../app/inspector-context";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { ChatOwnerNavigationBoundary } from "./ChatOwnerNavigationBoundary";
import { useChatOwnerNavigation } from "./use-chat-owner-navigation";
import { ThreadedBtwSideChatPanel } from "../../../features/threaded-surface/ThreadedBtwSideChatPanel";
import "../../../features/threaded-surface/styles/btw-side-chat.css";
import { ProjectAssignmentReview } from "./ProjectAssignmentReview";
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

  const inspectorSource = useContext(InspectorSourceContext);
  const conversationNavigation = useChatOwnerNavigation(activeWorkspaceId ?? "default", activeCitadelId);
  return (
    <div className="cockpit-chat-host flex min-h-0 min-w-0 flex-1 flex-col">
      <MissionThreadedControllerHost
        coworkViewModelFactory={null}
        workspaceId={activeWorkspaceId ?? "default"}
        surface="chat"
        lockSurface
        hidePageHeader
        renderWhileLoading
        secondaryEvidenceEnabled={inspectorSource === "chat"}
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
        onOpenLibraryImports={() => navigate("/library/knowledge?shell=cockpit#external-sources")}
        // System › Health owns runtime status natively, so Chat no longer needs a Classic handoff here.
        onOpenOpsRuntime={() => navigate("/system?shell=cockpit")}
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
  const { open, close, content: inspectorContent, register, closeIfOpen, getDismissalGeneration } = useInspector();
  const inspectorTurnId = useRef<string | null>(null);
  const inspectorTab = useRef<"run" | "turn" | "files">("run");
  const [buildOpen, setBuildOpen] = useState(false);
  const [conversationsOpen, setConversationsOpen] = useState(false);
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
  const buildSession = useRef(selectedSessionId);
  useEffect(() => {
    if (buildSession.current !== selectedSessionId) setBuildOpen(false);
    buildSession.current = selectedSessionId;
  }, [selectedSessionId]);
  // The host loads workbench state only on request, so the build editor asks while it is open.
  const onWorkbenchOpenChange = input.onWorkbenchOpenChange;
  useEffect(() => {
    onWorkbenchOpenChange?.(buildOpen);
  }, [onWorkbenchOpenChange, buildOpen]);
  useEffect(() => () => onWorkbenchOpenChange?.(false), [onWorkbenchOpenChange]);
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
      <ChatConversationsSheet
        open={conversationsOpen}
        onOpenChange={setConversationsOpen}
        rail={input.sessionRail}
        projectOptions={input.contextDockProps?.projectOptions}
      />
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <ChatSessionHeader
          input={input}
          active={active}
          session={session}
          selectedSessionId={selectedSessionId}
          buildEditor={
            codePanel
              ? {
                  open: buildOpen,
                  onToggle: () => {
                    if (!buildOpen) {
                      const turnId = buildEditorTurnId(active);
                      if (turnId) active?.onSelectTurn(turnId);
                    }
                    setBuildOpen((open) => !open);
                  },
                }
              : null
          }
          onOpenProjects={() => navigate("/chat/projects")}
          onOpenConversations={() => setConversationsOpen(true)}
          conversationsOpen={conversationsOpen}
          inspecting={inspectorContent?.source === "chat"}
          onInspect={() => (inspectorContent?.source === "chat" ? close() : openInspector())}
          onFork={active && latestTurnId ? () => active.onStartNewThreadFromTurn(latestTurnId) : undefined}
        />
        {active ? <ProjectAssignmentReview active={active} /> : null}
        {onboarding.data && !onboarding.isError && !onboarding.data.completed && !buildOpen ? (
          <ChatSetupBanner onReturnToSetup={() => navigate("/settings/first-run")} />
        ) : null}
        {buildOpen && active?.streamError ? (
          <ChatStreamErrorNotice
            error={active.streamError}
            source={active.streamErrorSource}
            onReload={active.onRefreshThread}
            className="mx-3 my-2"
          />
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
              onReviewPlan={input.onReviewChangePlan}
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
          <ChatEmptyState rail={input.sessionRail} onOpenConversations={() => setConversationsOpen(true)} />
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
            reasoningEfforts={input.contextDockProps?.selectedModelReasoningEfforts}
            onOpenSchedules={() => navigate("/work/schedules")}
          />
        ) : null}
        {input.btwSideChatProps ? <ThreadedBtwSideChatPanel sideChat={input.btwSideChatProps} /> : null}
        {active?.chatTimerPanel ? <ChatTimerPanel panel={active.chatTimerPanel} /> : null}
      </div>
    </section>
  );
}
