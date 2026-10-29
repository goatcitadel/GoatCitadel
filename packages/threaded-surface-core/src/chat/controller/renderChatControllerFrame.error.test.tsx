import { Children, isValidElement, type ReactNode } from "react";
import { expect, it } from "vitest";
import { renderChatControllerFrame } from "./renderChatControllerFrame";

function frame(error: string | null) {
  return renderChatControllerFrame({
    lockSurface: true,
    renderWhileLoading: true,
    error,
    hidePageHeader: true,
    approvalsCount: 0,
    workspaceName: "default",
    selectedSessionId: "session-1",
    visibleRunStateLabel: undefined,
    renderSurface: () => null,
    threadedSurfaceInput: {} as never,
    forkConfirm: null,
    forkPending: false,
    setForkConfirm: () => undefined,
    blockHistoricalMutation: () => false,
    handleStartNewThreadFromTurn: () => undefined,
    surfaceState: { messageMode: "chat", surfaceHeaderTitle: "", surfaceHeaderSubtitle: "", isCodeSurface: false },
    sessionData: { thread: null, loading: false, projects: null, sessions: null, isRefreshing: false },
    threadController: {} as never,
    contextActions: { capabilitySuggestionConfirm: null } as never,
    composerInteractions: {} as never,
    changePlanState: { activeChangePlan: null, linkedDefaultChangePlan: null } as never,
    planConfirmations: {} as never,
    planActions: {} as never,
    planOAuth: {} as never,
    sessionControls: { sessionDeleteConfirm: null, archiveWorkspaceConfirmOpen: false } as never,
  } as never);
}

/** The frame is a plain function, so its banner is a direct element in the returned tree; no DOM is needed. */
function bannerText(error: string | null): string | null {
  const find = (node: ReactNode): string | null => {
    let found: string | null = null;
    Children.forEach(node, (child) => {
      if (found !== null || !isValidElement<{ className?: string; children?: ReactNode }>(child)) return;
      if (child.type === "p" && child.props.className === "error") found = String(child.props.children);
      else found = find(child.props.children);
    });
    return found;
  };
  return find(frame(error));
}

it("shows a refused API request as its plain sentence, never the raw status and JSON", () => {
  const text = bannerText(
    'API error 422: {"error":"Claude Code CLI / claude-sonnet-5-5 does not support deep effort. Choose off effort instead.","code":"FIELD_INVALID"}',
  );
  expect(text).toBe("Claude Code CLI / claude-sonnet-5-5 does not support deep effort. Choose off effort instead.");
  expect(text).not.toContain("API error");
  expect(text).not.toContain("{");
});

it("keeps plain controller messages as they are, and shows nothing without an error", () => {
  expect(bannerText("This chat changed elsewhere. Your rename draft is preserved; review it and retry.")).toBe(
    "This chat changed elsewhere. Your rename draft is preserved; review it and retry.",
  );
  expect(bannerText(null)).toBeNull();
});
