// @vitest-environment happy-dom
import { act, useLayoutEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type { ChatSessionRecord } from "@goatcitadel/contracts";
import type { ChatSessionsResponse } from "@goatcitadel/mission-control-shared/api/client";
import { resetChatSessionCreationForTests } from "@goatcitadel/mission-control-shared/state/chat-session-creation";
import { useManualChatSessionCreation } from "../../../../../../packages/threaded-surface-core/src/chat/useManualChatSessionCreation";
import { CockpitNavigationProvider } from "../../app/CockpitNavigationProvider";
import { useChatOwnerNavigation } from "./use-chat-owner-navigation";
import { __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";
import { __resetFormDirtyRegistryForTests } from "../../../features/native-routes/library/use-form-dirty";

const api = vi.hoisted(() => ({ create: vi.fn(), status: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", async (original) => ({
  ...(await original<typeof import("@goatcitadel/mission-control-shared/api/client")>()),
  createChatSession: api.create,
  fetchChatSessionStatus: api.status,
}));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({ activeWorkspaceId: "workspace-a", activeCitadelId: "citadel-a" }),
}));
const session = (sessionId: string): ChatSessionRecord => ({
  sessionId,
  revision: 1,
  sessionKey: `mission:operator:${sessionId}`,
  workspaceId: "workspace-a",
  scope: "mission",
  mode: "chat",
  includeInHistory: true,
  pinned: false,
  lifecycleStatus: "active",
  channel: "mission",
  account: "operator",
  updatedAt: "2026-10-01T00:00:00Z",
  lastActivityAt: "2026-10-01T00:00:00Z",
  tokenTotal: 0,
  costUsdTotal: 0,
});
let root: Root, host: HTMLDivElement;
let navigation: ReturnType<typeof useChatOwnerNavigation>;
let creation: ReturnType<typeof useManualChatSessionCreation>;
let select: (id: string) => void;
function Harness() {
  const [selected, setSelected] = useState<string | null>("prior");
  const [sessions, setSessions] = useState<ChatSessionsResponse | null>({
    items: [session("prior"), session("existing/one")],
  });
  const [history, setHistory] = useState<"active" | "archived">("active");
  const [error, setError] = useState<string | null>(null);
  navigation = useChatOwnerNavigation("workspace-a", "citadel-a");
  creation = useManualChatSessionCreation({
    workspaceId: "workspace-a",
    selectedProjectId: "all",
    selectedSessionId: selected,
    historyView: history,
    setSessions,
    setHistoryView: setHistory,
    setSelectedSessionId: setSelected,
    setError,
    onSessionCreated: (record) => navigation.request("chat", { sessionId: record.sessionId }),
  });
  select = setSelected;
  useLayoutEffect(() =>
    navigation.publish({ selectedSessionId: selected, sessions: sessions?.items ?? [], active: null }),
  );
  return <p>{error ?? selected}</p>;
}
async function render(path: string) {
  window.history.replaceState(null, "", path);
  await act(async () =>
    root.render(
      <CockpitNavigationProvider>
        <Harness />
      </CockpitNavigationProvider>,
    ),
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  resetChatSessionCreationForTests();
  __resetSessionDraftsForTests();
  __resetFormDirtyRegistryForTests();
  api.create.mockResolvedValue(session("created/one"));
  api.status.mockResolvedValue({ sessionId: "created/one", workspaceId: "workspace-a" });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  __resetSessionDraftsForTests();
  __resetFormDirtyRegistryForTests();
});

it.each(["/", "/chat/"])(
  "publishes an existing selection from %s only after matching canonical owner evidence",
  async (path) => {
    await render(`${path}?sessionId=prior&shell=cockpit`);
    await act(async () => navigation.request("chat", { sessionId: "existing/one" }));
    expect(window.location.pathname).toBe(path);
    expect(new URLSearchParams(window.location.search).get("sessionId")).toBe("prior");
    await act(async () => select("existing/one"));
    expect(window.location.pathname).toBe("/chat");
    expect(new URLSearchParams(window.location.search).get("sessionId")).toBe("existing/one");
    expect(window.location.search).toContain("existing%2Fone");
  },
);
it.each(["/", "/chat/"])(
  "publishes the actual creation owner's independently verified session from %s",
  async (path) => {
    await render(`${path}?sessionId=prior&shell=cockpit`);
    await act(async () => creation.create("chat"));
    expect(api.create).toHaveBeenCalledExactlyOnceWith(
      { workspaceId: "workspace-a", mode: "chat" },
      { originSurface: "chat" },
    );
    expect(api.status).toHaveBeenCalledExactlyOnceWith("created/one", expect.any(AbortSignal));
    expect(window.location.pathname).toBe("/chat");
    expect(new URLSearchParams(window.location.search).get("sessionId")).toBe("created/one");
    expect(host.textContent).toBe("created/one");
  },
);
it.each(["/chat/projects", "/chat/projects/project-a", "/projects/project-a"])(
  "never lets retained publication take over Projects at %s",
  async (path) => {
    await render(`${path}?workspaceId=workspace-a&shell=cockpit#context`);
    const destination = window.location.href;
    await act(async () => navigation.request("chat", { sessionId: "existing/one" }));
    await act(async () => select("existing/one"));
    expect(window.location.href).toBe(destination);
    expect(new URLSearchParams(window.location.search).get("sessionId")).toBeNull();
  },
);
