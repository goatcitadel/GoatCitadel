// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { MissionThreadedRenderSurfaceInput } from "@goatcitadel/threaded-surface-core";
import { UiPreferencesProvider, useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { expect, it, vi } from "vitest";
import { ChatAreaView, artifactInspectorHistoryMatches } from "./ChatArea";
import { InspectorProvider, InspectorPanel } from "../../app/inspector";
import { chatSelectionHref } from "./chat-selection-evidence";
import { commitCockpitNavigation } from "../../app/cockpit-history";

vi.mock("./ThreadList", () => ({ ThreadList: () => null }));
vi.mock("./SelectedThreadActivity", () => ({ SelectedThreadActivity: () => null }));
vi.mock("./ChatTextComposer", () => ({ ChatTextComposer: () => null }));
vi.mock("./ChatSessionControls", () => ({ ChatSessionTitle: () => null, ChatSessionOverflow: () => null }));
vi.mock("./ChatTranscript", () => ({
  ChatTranscript: ({ onOpenArtifact }: { onOpenArtifact: (turn: string, artifact: string) => void }) => (
    <button type="button" onClick={() => onOpenArtifact("turn-1", "artifact-1")}>
      Open saved artifact
    </button>
  ),
}));
vi.mock("./ChatInspector", () => ({
  ChatInspector: ({ targetTurnId, initialTab }: { targetTurnId: string | null; initialTab: string }) => (
    <p>
      {targetTurnId ?? "latest"}:{initialTab}
    </p>
  ),
}));

it("accepts only the initiating history or its single exact artifact publication", () => {
  const target = "http://localhost/chat?shell=cockpit&sessionId=one&turnId=turn&artifactId=file";
  expect(artifactInspectorHistoryMatches("3:http://localhost/chat", target, "3:http://localhost/chat")).toBe(true);
  expect(artifactInspectorHistoryMatches("3:http://localhost/chat", target, `4:${target}`)).toBe(true);
  for (const current of [`5:${target}`, "4:http://localhost/settings", `4:${target}&artifactId=other`])
    expect(artifactInspectorHistoryMatches("3:http://localhost/chat", target, current)).toBe(false);
});

it.each(["current", "navigation", "scope", "dismissal", "unmount"] as const)(
  "completes an exact artifact read across URL publication only while its %s view is current",
  async (action) => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container),
      client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["system", "onboarding"], { completed: true });
    let preferences: ReturnType<typeof useUiPreferences>;
    function Scope() {
      preferences = useUiPreferences();
      return null;
    }
    let resolve!: () => void;
    const ownerRead = new Promise<void>((done) => {
      resolve = done;
    });
    const artifact = { artifactId: "artifact-1", sessionId: "session-1", turnId: "turn-1", workspaceId: "workspace-1" };
    let loaded = false,
      unmounted = false;
    // Rendering-only fixture. The actual provider owns history and dismissals;
    // a controlled completion stands in for the independently browser-tested API read.
    const input = () =>
      ({
        sessionRail: {
          selectedSessionId: "session-1",
          missionSessions: [],
          onCreateSession: vi.fn(),
          creatingSession: false,
        },
        activeSessionSurfaceProps: {
          selectedSessionId: "session-1",
          notices: [],
          sessionTitle: "Artifact test",
          selectedTurnId: "turn-1",
          onSelectTurn: vi.fn(),
          onOpenGeneratedArtifact: vi.fn(() => ownerRead),
          thread: { turns: [] },
        },
        contextDockProps: { selectedSessionId: "session-1", activeGeneratedArtifact: loaded ? artifact : null },
      }) as unknown as MissionThreadedRenderSurfaceInput;
    const render = () =>
      root.render(
        <QueryClientProvider client={client}>
          <UiPreferencesProvider>
            <InspectorProvider>
              <Scope />
              <ChatAreaView input={input()} />
              <InspectorPanel />
            </InspectorProvider>
          </UiPreferencesProvider>
        </QueryClientProvider>,
      );
    const click = (label: string) =>
      [...document.body.querySelectorAll("button")]
        .find((button) => button.textContent === label || button.getAttribute("aria-label") === label)!
        .click();
    const target = chatSelectionHref({
      sessionId: artifact.sessionId,
      turnId: artifact.turnId,
      artifactId: artifact.artifactId,
    });
    try {
      window.history.replaceState(null, "", "/chat?shell=cockpit&sessionId=session-1");
      await act(async () => {
        render();
      });
      await act(async () => {
        preferences!.setActiveScope({ citadelId: "personal", workspaceId: "workspace-1" });
      });
      await act(async () => {
        click("Open saved artifact");
      });
      expect(document.body.querySelector('[data-inspector-body="true"]')).toBeNull();
      if (action === "navigation")
        await act(async () => {
          commitCockpitNavigation("/settings/general?shell=cockpit");
        });
      if (action === "scope") {
        await act(async () => {
          preferences!.setActiveScope({ citadelId: "foreign", workspaceId: "foreign" });
        });
        await act(async () => {
          preferences!.setActiveScope({ citadelId: "personal", workspaceId: "workspace-1" });
        });
      }
      if (action === "dismissal") {
        await act(async () => {
          document.dispatchEvent(new KeyboardEvent("keydown", { key: "i", ctrlKey: true }));
        });
        await act(async () => {
          click("Close inspector");
        });
      }
      if (action === "unmount") {
        await act(async () => {
          root.unmount();
        });
        unmounted = true;
      }
      await act(async () => {
        loaded = true;
        commitCockpitNavigation(target);
        if (!unmounted) render();
        resolve();
        await ownerRead;
      });
      if (action === "current")
        expect(document.body.querySelector('[aria-label="Inspector: Conversation"]')?.textContent).toContain(
          "turn-1:files",
        );
      else expect(document.body.querySelector('[data-inspector-body="true"]')).toBeNull();
    } finally {
      if (!unmounted)
        await act(async () => {
          root.unmount();
        });
      container.remove();
      client.clear();
    }
  },
);
