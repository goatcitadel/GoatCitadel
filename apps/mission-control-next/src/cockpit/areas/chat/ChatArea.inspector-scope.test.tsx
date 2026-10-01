// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { MissionThreadedRenderSurfaceInput } from "@goatcitadel/threaded-surface-core";
import { UiPreferencesProvider, useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { expect, it, vi } from "vitest";
import { ChatAreaView } from "./ChatArea";
import { InspectorProvider, InspectorPanel } from "../../app/inspector";

vi.mock("./ThreadList", () => ({ ThreadList: () => null }));
vi.mock("./SelectedThreadActivity", () => ({ SelectedThreadActivity: () => null }));
vi.mock("./ChatTextComposer", () => ({ ChatTextComposer: () => null }));
vi.mock("./ChatSessionControls", () => ({ ChatSessionTitle: () => null, ChatSessionOverflow: () => null }));
vi.mock("./ChatTranscript", () => ({ ChatTranscript: ({ props, onInspectTurn }: { props: { selectedSessionId: string }; onInspectTurn: (id: string) => void }) =>
  <button type="button" onClick={() => onInspectTurn(`${props.selectedSessionId}-turn`)}>Inspect exact turn</button> }));
vi.mock("./ChatInspector", () => ({ ChatInspector: ({ input, targetTurnId, initialTab }: { input: MissionThreadedRenderSurfaceInput; targetTurnId: string | null; initialTab: string }) =>
  <p>{input.sessionRail.selectedSessionId}:{targetTurnId ?? "latest"}:{initialTab}</p> }));
let preferences: ReturnType<typeof useUiPreferences>;
function Scope() { preferences = useUiPreferences(); return null; }
// Minimal rendering-only controller fixture; every runtime/mutation leaf is replaced above.
function input(id: string): MissionThreadedRenderSurfaceInput {
  return { sessionRail: { selectedSessionId: id, missionSessions: [], onCreateSession: vi.fn(), creatingSession: false },
    activeSessionSurfaceProps: { selectedSessionId: id, notices: [], sessionTitle: id, onSelectTurn: vi.fn(), thread: { turns: [] } },
  } as unknown as MissionThreadedRenderSurfaceInput;
}
it("registers B/latest after inspecting A/turn and drops the target again on same-ID workspace change", async () => {
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); client.setQueryData(["system", "onboarding"], { completed: true });
  const render = (id: string) => <QueryClientProvider client={client}><UiPreferencesProvider><InspectorProvider><Scope /><ChatAreaView input={input(id)} /><InspectorPanel /></InspectorProvider></UiPreferencesProvider></QueryClientProvider>;
  const key = () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "i", ctrlKey: true })); };
  const inspect = () => [...container.querySelectorAll("button")].find(button => button.textContent === "Inspect exact turn")!;
  try {
    await act(async () => { root.render(render("a")); });
    await act(async () => { inspect().click(); }); expect(container.textContent).toContain("a:a-turn:turn");
    await act(async () => { key(); root.render(render("b")); });
    await act(async () => { key(); }); expect(container.textContent).toContain("b:latest:run"); expect(container.textContent).not.toContain("a-turn");
    await act(async () => { inspect().click(); }); expect(container.textContent).toContain("b:b-turn:turn");
    await act(async () => { preferences.setActiveScope({ citadelId: "foreign", workspaceId: "foreign" }); });
    expect(container.querySelector("aside")).toBeNull();
    await act(async () => { key(); }); expect(container.textContent).toContain("b:latest:run"); expect(container.textContent).not.toContain("b-turn");
  } finally { await act(async () => { root.unmount(); }); container.remove(); client.clear(); }
});
