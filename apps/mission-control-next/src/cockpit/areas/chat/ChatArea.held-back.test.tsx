// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Window as HappyDomWindow } from "happy-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CockpitNavigationProvider } from "../../app/CockpitNavigationProvider";
import { commitCockpitNavigation } from "../../app/cockpit-history";
import { useSessionDraft, __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";
import { __resetFormDirtyRegistryForTests } from "../../../features/native-routes/library/use-form-dirty";
import { ChatArea } from "./ChatArea";

const host = vi.hoisted(() => ({ searches: [] as Array<string | undefined> }));
vi.mock("@goatcitadel/threaded-surface-core", () => ({
  MissionThreadedControllerHost: ({ routeSearch }: { routeSearch?: string }) => {
    host.searches.push(routeSearch);
    return null;
  },
}));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({ activeWorkspaceId: "workspace-a", activeCitadelId: "citadel-a" }),
}));
vi.mock("../../../shell-preference", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../shell-preference")>()),
  switchShell: vi.fn(),
}));

let root: Root;
let container: HTMLDivElement;
let draft: ReturnType<typeof useSessionDraft<{ text: string }>>;
function DraftProbe() {
  draft = useSessionDraft("held-back-draft", { text: "" }, 1, { label: "Conversation draft" });
  return null;
}
async function render() {
  // A new element each time, so the whole tree renders again.
  await act(async () =>
    root.render(
      <CockpitNavigationProvider>
        <ChatArea />
        <DraftProbe />
      </CockpitNavigationProvider>,
    ),
  );
}
async function settle() {
  await act(async () => {
    await (window as unknown as Pick<HappyDomWindow, "happyDOM">).happyDOM.waitUntilComplete();
  });
}

beforeEach(() => {
  host.searches = [];
  __resetSessionDraftsForTests();
  __resetFormDirtyRegistryForTests();
  window.history.replaceState(null, "", "/chat?sessionId=session-b&shell=cockpit");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  __resetSessionDraftsForTests();
  __resetFormDirtyRegistryForTests();
  vi.restoreAllMocks();
});

describe("cockpit Chat during a held Back", () => {
  it("keeps the controller on the shown conversation while the live URL names the held target", async () => {
    await render();
    await act(async () => {
      commitCockpitNavigation("/chat?sessionId=session-a");
    });
    await settle();
    await act(async () => draft.setValue({ text: "Unsaved" }));
    const shown = host.searches.length;
    // Browsers land a traversal in a later task; Happy DOM lands it inside go(), so hold the restore here.
    const go = window.history.go.bind(window.history);
    const restores: number[] = [];
    vi.spyOn(window.history, "go").mockImplementation((delta = 0) => {
      restores.push(delta);
    });
    await act(async () => window.history.back());
    expect(restores).toHaveLength(1);
    expect(window.location.search).toBe("?sessionId=session-b&shell=cockpit");
    // A render in this window, as a streaming reply causes, still names the conversation on screen.
    await render();
    expect(host.searches.length).toBeGreaterThan(shown);
    await act(async () => go(restores[0]));
    expect(window.location.search).toBe("?sessionId=session-a&shell=cockpit");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Unsaved changes");
    expect(new Set(host.searches.slice(shown))).toEqual(new Set(["?sessionId=session-a&shell=cockpit"]));
  });
});
