import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ChatPageRenderSurfaceInput } from "./ChatPage";

const threadedState = vi.hoisted(() => ({
  input: null as ChatPageRenderSurfaceInput | null,
  hostProps: [] as Array<Record<string, unknown>>,
}));

vi.mock("@goatcitadel/threaded-surface-core", async () => {
  const ReactModule = await import("react");
  return {
    MissionThreadedControllerHost: (props: Record<string, unknown>) => {
      threadedState.hostProps.push(props);
      return ReactModule.createElement(
        "div",
        { "data-slot": "threaded-host" },
        (props.renderSurface as (input: ChatPageRenderSurfaceInput) => React.ReactNode)(threadedState.input!),
      );
    },
    formatSessionLabel: vi.fn(),
    getCapabilitySuggestionConfirmationCopy: vi.fn(),
    getDeleteSessionConfirmationMessage: vi.fn(),
    looksMachineSessionLabel: vi.fn(),
    revealGeneratedArtifactInSurface: vi.fn(),
    resolveSelectedTurnId: vi.fn(),
    resolveChatRefreshPlan: vi.fn(),
    resolveOptimisticChatPrefs: vi.fn(),
    shouldApplyFetchedMessagesAfterStream: vi.fn(),
    shouldExecuteLocalChatCommand: vi.fn(),
    shouldShowLearnedMemoryPanel: vi.fn(),
    shouldShowSuggestionsPanel: vi.fn(),
    shouldShowTracePanel: vi.fn(),
  };
});

vi.mock("./chat/ChatContextDockPanels", () => ({
  ChatContextDockPanels: () => <aside data-slot="context-dock">Context dock</aside>,
}));

vi.mock("./chat/ChatSurfaceLayout", () => ({
  ChatSurfaceLayout: ({
    mode,
    sessionRail,
    primaryColumn,
    workflowColumn,
    contextDock,
    dockOpen,
    hasActiveSession,
  }: Record<string, React.ReactNode>) => (
    <section
      data-slot="chat-surface-layout"
      data-mode={mode}
      data-dock-open={String(dockOpen)}
      data-active={String(hasActiveSession)}
    >
      {sessionRail}
      {primaryColumn}
      {workflowColumn}
      {contextDock}
    </section>
  ),
}));

vi.mock("./chat/ChatSessionSidebar", () => ({
  ChatSessionSidebar: () => <nav data-slot="session-rail">Session rail</nav>,
}));

vi.mock("./chat/MissionControlActiveSessionSurface", () => ({
  MissionControlActiveSessionSurface: () => <main data-slot="active-session">Active session</main>,
}));

vi.mock("./chat/MissionControlEmptyState", () => ({
  MissionControlEmptyState: () => <main data-slot="empty-state">Empty state</main>,
}));

vi.mock("./chat/MissionControlWorkSurfaces", () => ({
  ChatWorkSurface: ({ sessionRail, primaryColumn, contextDock, dockOpen }: Record<string, React.ReactNode>) => (
    <section data-slot="chat-work-surface" data-dock-open={String(dockOpen)}>
      {sessionRail}
      {primaryColumn}
      {contextDock}
    </section>
  ),
  CoworkWorkSurface: ({ sessionRail, primaryColumn, contextDock, coworkPanel }: Record<string, React.ReactNode>) => (
    <section data-slot="cowork-work-surface">
      {sessionRail}
      {primaryColumn}
      {contextDock}
      <div data-slot="cowork-panel">{JSON.stringify(coworkPanel)}</div>
    </section>
  ),
  CodeWorkSurface: ({ sessionRail, primaryColumn, contextDock, codePanel }: Record<string, React.ReactNode>) => (
    <section data-slot="code-work-surface">
      {sessionRail}
      {primaryColumn}
      {contextDock}
      <div data-slot="code-panel">{JSON.stringify(codePanel)}</div>
    </section>
  ),
}));

import { ChatPage } from "./ChatPage";

function makeInput(overrides: Partial<ChatPageRenderSurfaceInput> = {}): ChatPageRenderSurfaceInput {
  return {
    messageMode: "chat",
    sessionRail: {
      sessions: [],
      selectedSessionId: null,
      selectedSession: null,
      loadingSessions: false,
      workspaceSummaryCards: [],
      onSelectSession: vi.fn(),
      onCreateSession: vi.fn(),
      onDeleteSession: vi.fn(),
      onUpdateSessionTitle: vi.fn(),
    } as any,
    activeSessionSurfaceProps: null,
    emptyStateProps: {
      mode: "chat",
      onCreateSession: vi.fn(),
    } as any,
    contextDockProps: null,
    dockOpen: true,
    onDockOpenChange: vi.fn(),
    sessionRailOpen: true,
    onSessionRailOpenChange: vi.fn(),
    workflowPanel: null,
    ...overrides,
  } as unknown as ChatPageRenderSurfaceInput;
}

function renderWithInput(input: ChatPageRenderSurfaceInput, props: Record<string, unknown> = {}) {
  threadedState.input = input;
  threadedState.hostProps = [];
  return renderToStaticMarkup(<ChatPage workspaceId="default" {...props} />);
}

describe("ChatPage render surface", () => {
  it("passes host props through and lets callers replace the rendered surface", () => {
    const renderSurface = vi.fn(() => <div data-slot="custom-surface">Custom</div>);
    const markup = renderWithInput(makeInput(), { renderSurface, selectedSessionId: "sess-1" });

    expect(markup).toContain('data-slot="custom-surface"');
    expect(renderSurface).toHaveBeenCalledWith(threadedState.input);
    expect(threadedState.hostProps[0]).toMatchObject({
      workspaceId: "default",
      selectedSessionId: "sess-1",
    });
  });

  it("renders the empty chat surface with the session rail and closed dock state", () => {
    const markup = renderWithInput(makeInput({ dockOpen: true }));

    expect(markup).toContain('data-slot="chat-work-surface"');
    expect(markup).toContain('data-dock-open="false"');
    expect(markup).toContain("Session rail");
    expect(markup).toContain("Empty state");
  });

  it("renders active chat, Cowork, and Code work surfaces with context docks", () => {
    const activeInput = makeInput({
      activeSessionSurfaceProps: { sessionId: "sess-1" } as any,
      contextDockProps: { selectedTurnId: "turn-1" } as any,
      dockOpen: true,
    });

    expect(renderWithInput(activeInput)).toContain('data-slot="chat-work-surface"');
    expect(renderWithInput(activeInput)).toContain('data-dock-open="true"');
    expect(renderWithInput(activeInput)).toContain("Context dock");

    expect(
      renderWithInput(
        makeInput({
          messageMode: "cowork",
          activeSessionSurfaceProps: { sessionId: "sess-1" } as any,
          contextDockProps: { selectedTurnId: "turn-1" } as any,
          workflowPanel: {
            kind: "cowork",
            props: { runId: "run-1" },
          } as any,
        }),
      ),
    ).toContain('data-slot="cowork-work-surface"');

    expect(
      renderWithInput(
        makeInput({
          messageMode: "code",
          activeSessionSurfaceProps: { sessionId: "sess-1" } as any,
          workflowPanel: {
            kind: "code",
            props: { artifactId: "artifact-1" },
          } as any,
        }),
      ),
    ).toContain('data-slot="code-work-surface"');
  });

  it("routes Cowork and Code empty states through the workflow layout", () => {
    const coworkMarkup = renderWithInput(makeInput({ messageMode: "cowork", dockOpen: true }));
    const codeMarkup = renderWithInput(makeInput({ messageMode: "code", dockOpen: true }));

    expect(coworkMarkup).toContain('data-slot="chat-surface-layout"');
    expect(coworkMarkup).toContain('data-mode="cowork"');
    expect(coworkMarkup).toContain('data-dock-open="false"');
    expect(coworkMarkup).toContain("Empty state");
    expect(codeMarkup).toContain('data-mode="code"');
  });
});
