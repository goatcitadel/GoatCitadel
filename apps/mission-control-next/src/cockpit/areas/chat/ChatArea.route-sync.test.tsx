// @vitest-environment happy-dom
import { act, useEffect, useLayoutEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CockpitNavigationProvider } from "../../app/CockpitNavigationProvider";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { useChatOwnerNavigation, useChatSelectionReview } from "./use-chat-owner-navigation";
import {
  chatSelectionMatches,
  type ChatLocationSelection,
  type ChatSelectionEvidence,
} from "./chat-selection-evidence";
import { useSessionDraft, __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";
import { __resetFormDirtyRegistryForTests } from "../../../features/native-routes/library/use-form-dirty";

const scope = vi.hoisted(() => ({ activeWorkspaceId: "workspace-a", activeCitadelId: "citadel-a" }));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({ useUiPreferences: () => scope }));
vi.mock("../../../shell-preference", () => ({ switchShell: vi.fn() }));
const evidence = (selection: ChatLocationSelection): ChatSelectionEvidence => ({
  selectedSessionId: selection.sessionId ?? null,
  sessions: selection.sessionId
    ? [{ sessionId: selection.sessionId, workspaceId: "workspace-a", scope: "mission" }]
    : [],
  active: selection.sessionId
    ? {
        selectedSessionId: selection.sessionId,
        workspaceId: "workspace-a",
        selectedTurnId: selection.turnId ?? null,
        thread: { sessionId: selection.sessionId, turns: selection.turnId ? [{ turnId: selection.turnId }] : [] },
        activeGeneratedArtifact: selection.artifactId
          ? {
              artifactId: selection.artifactId,
              sessionId: selection.sessionId,
              workspaceId: "workspace-a",
              turnId: selection.turnId!,
            }
          : null,
      }
    : null,
});
let controller: ReturnType<typeof useChatOwnerNavigation>, review: ReturnType<typeof useChatSelectionReview>;
let publishSelection: (selection: ChatLocationSelection) => void;
let failHydration: () => void;
let draft: ReturnType<typeof useSessionDraft<{ text: string }>>;
let mounts = 0,
  unmounts = 0;
function Probe() {
  const route = useCockpitRoute();
  const [selected, setSelected] = useState<ChatLocationSelection>({ sessionId: "session-a" });
  const [hydrationFailed, setHydrationFailed] = useState(false);
  controller = useChatOwnerNavigation(scope.activeWorkspaceId, scope.activeCitadelId);
  review = useChatSelectionReview(JSON.stringify(selected));
  draft = useSessionDraft("chat-route-test", { text: "" }, 1, { label: "Conversation draft" });
  publishSelection = setSelected;
  failHydration = () => setHydrationFailed(true);
  useLayoutEffect(() => {
    controller.publish(hydrationFailed ? { ...evidence(selected), active: null } : evidence(selected));
  });
  useEffect(() => {
    mounts++;
    return () => {
      unmounts++;
    };
  }, []);
  return (
    <div>
      <p data-selected>{selected.sessionId}</p>
      <p data-route>{route.search}</p>
      <p data-draft>{draft.value.text}</p>
      {hydrationFailed ? <p role="alert">Conversation thread could not be loaded.</p> : null}
    </div>
  );
}
let root: Root, container: HTMLDivElement;
async function render() {
  await act(async () => {
    root.render(
      <CockpitNavigationProvider>
        <Probe />
      </CockpitNavigationProvider>,
    );
  });
}
async function click(text: string) {
  const button = [...document.querySelectorAll("button")].find((item) => item.textContent === text);
  expect(button).toBeDefined();
  await act(async () => {
    button!.click();
  });
}
beforeEach(() => {
  Object.assign(scope, { activeWorkspaceId: "workspace-a", activeCitadelId: "citadel-a" });
  __resetSessionDraftsForTests();
  __resetFormDirtyRegistryForTests();
  mounts = 0;
  unmounts = 0;
  window.history.replaceState(null, "", "/chat?sessionId=session-a&shell=cockpit");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  __resetSessionDraftsForTests();
  __resetFormDirtyRegistryForTests();
});

describe("cockpit controller route publication", () => {
  it("publishes only the exact rendered selection, preserves encoded IDs and clears optional targets without a remount", async () => {
    await render();
    await act(async () => {
      draft.setValue({ text: "Retained controller draft" });
    });
    const navigate = controller.request;
    const target = { sessionId: "session/b?x", turnId: "turn#b", artifactId: "artifact&b" };
    await act(async () => {
      navigate("chat", target);
    });
    expect(new URLSearchParams(window.location.search).get("sessionId")).toBe("session-a");
    await act(async () => {
      publishSelection(target);
    });
    expect(Object.fromEntries(new URLSearchParams(window.location.search))).toEqual({ shell: "cockpit", ...target });
    expect(controller.request).toBe(navigate);
    await act(async () => {
      navigate("chat", { sessionId: "session-c", turnId: null, artifactId: null });
      publishSelection({ sessionId: "session-c" });
    });
    expect(Object.fromEntries(new URLSearchParams(window.location.search))).toEqual({
      shell: "cockpit",
      sessionId: "session-c",
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(mounts).toBe(1);
    expect(unmounts).toBe(0);
    expect(draft.value.text).toBe("Retained controller draft");
  });

  it("reviews user selection before invoking the controller; Cancel changes neither selection nor URL", async () => {
    await render();
    await act(async () => {
      draft.setValue({ text: "Keep me" });
    });
    const select = vi.fn(() => {
      controller.request("chat", { sessionId: "session-b" });
      publishSelection({ sessionId: "session-b" });
    });
    await act(async () => {
      review(select);
    });
    expect(select).not.toHaveBeenCalled();
    await click("Cancel");
    expect(select).not.toHaveBeenCalled();
    expect(container.querySelector("[data-selected]")?.textContent).toBe("session-a");
    expect(new URLSearchParams(window.location.search).get("sessionId")).toBe("session-a");
    await act(async () => {
      review(select);
    });
    await click("Keep draft and close");
    expect(select).toHaveBeenCalledOnce();
    expect(new URLSearchParams(window.location.search).get("sessionId")).toBe("session-b");
    expect(draft.value.text).toBe("Keep me");
  });

  it.each(["scope", "navigation"])("does not publish pending selection after %s ABA", async (change) => {
    await render();
    await act(async () => {
      controller.request("chat", { sessionId: "session-b" });
    });
    if (change === "scope") {
      scope.activeWorkspaceId = "workspace-b";
      await render();
      scope.activeWorkspaceId = "workspace-a";
      await render();
    } else {
      window.history.pushState(null, "", "/work");
      window.dispatchEvent(new Event("goatcitadel:cockpit-location"));
      window.history.replaceState(null, "", "/chat?sessionId=session-a&shell=cockpit");
      window.dispatchEvent(new Event("popstate"));
    }
    await act(async () => {
      publishSelection({ sessionId: "session-b" });
    });
    expect(new URLSearchParams(window.location.search).get("sessionId")).toBe("session-a");
  });

  it("holds browser Back while the draft is unsaved, then preserves the mounted draft once confirmed", async () => {
    await render();
    await act(async () => {
      draft.setValue({ text: "Retained" });
      controller.request("chat", { sessionId: "session-b" });
      publishSelection({ sessionId: "session-b" });
    });
    const length = window.history.length;
    await act(async () => {
      window.history.back();
    });
    await vi.waitFor(() => expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1));
    expect(container.querySelector("[data-route]")?.textContent).toContain("sessionId=session-b");
    expect(new URLSearchParams(window.location.search).get("sessionId")).toBe("session-b");
    await click("Keep draft and close");
    await vi.waitFor(() =>
      expect(container.querySelector("[data-route]")?.textContent).toContain("sessionId=session-a"),
    );
    expect(window.history.length).toBe(length);
    expect(draft.value.text).toBe("Retained");
    expect(mounts).toBe(1);
    expect(unmounts).toBe(0);
    await act(async () => {
      window.history.forward();
    });
    await vi.waitFor(() => expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1));
    expect(new URLSearchParams(window.location.search).get("sessionId")).toBe("session-a");
    await click("Keep draft and close");
    await vi.waitFor(() =>
      expect(container.querySelector("[data-route]")?.textContent).toContain("sessionId=session-b"),
    );
    expect(window.history.length).toBe(length);
    expect(draft.value.text).toBe("Retained");
  });

  it("keeps the requested canonical session URL and visible owner aligned when hydration fails", async () => {
    await render();
    await act(async () => {
      review(() => {
        controller.request("chat", { sessionId: "failed-thread" });
        publishSelection({ sessionId: "failed-thread" });
        failHydration();
      });
    });
    expect(new URLSearchParams(window.location.search).get("sessionId")).toBe("failed-thread");
    expect(container.querySelector("[data-selected]")?.textContent).toBe("failed-thread");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Conversation thread could not be loaded.");
    expect(mounts).toBe(1);
    expect(unmounts).toBe(0);
  });

  it("can publish a canonical listed session even when its thread hydration fails", () => {
    const target = { sessionId: "failed-thread" };
    const listed = { ...evidence(target), active: null };
    expect(chatSelectionMatches(target, listed, "workspace-a")).toBe(true);
    expect(chatSelectionMatches({ ...target, turnId: "unread-turn" }, listed, "workspace-a")).toBe(false);
  });

  it("withholds foreign/missing canonical session, thread, turn and artifact evidence", () => {
    const target = { sessionId: "s", turnId: "t", artifactId: "a" },
      bound = evidence(target);
    expect(chatSelectionMatches(target, bound, "workspace-a")).toBe(true);
    expect(chatSelectionMatches(target, { ...bound, sessions: [] }, "workspace-a")).toBe(false);
    expect(
      chatSelectionMatches(
        target,
        { ...bound, sessions: [{ sessionId: "s", workspaceId: "foreign", scope: "mission" }] },
        "workspace-a",
      ),
    ).toBe(false);
    expect(
      chatSelectionMatches(
        target,
        { ...bound, active: { ...bound.active!, thread: { sessionId: "other", turns: [{ turnId: "t" }] } } },
        "workspace-a",
      ),
    ).toBe(false);
    expect(
      chatSelectionMatches(
        target,
        { ...bound, active: { ...bound.active!, thread: { sessionId: "s", turns: [] } } },
        "workspace-a",
      ),
    ).toBe(false);
    expect(
      chatSelectionMatches(
        target,
        {
          ...bound,
          active: {
            ...bound.active!,
            activeGeneratedArtifact: { artifactId: "a", workspaceId: "workspace-a", sessionId: "s", turnId: "foreign" },
          },
        },
        "workspace-a",
      ),
    ).toBe(false);
  });
});
