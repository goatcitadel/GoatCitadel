import React from "react";
import { act, create } from "react-test-renderer";
import { expect, it, vi } from "vitest";
import { useChatSurfaceNavigation } from "./useChatSurfaceNavigation";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it.each(["different", "same"])(
  "asks for a conversation outside the loaded list to be read exactly when the rail chooses the %s one",
  async (which) => {
    // A Messaging conversation can be older than the first page of the list; choosing it must still show it.
    const ensure = vi.fn();
    const navigate = vi.fn();
    const select = vi.fn();
    let owner!: ReturnType<typeof useChatSurfaceNavigation>;
    function Harness() {
      owner = useChatSurfaceNavigation({
        sessionData: { openHistoricalWindow: vi.fn(), returnToLatest: vi.fn() },
        ensureSessionListed: ensure,
        selection: {
          selectedSessionId: which === "same" ? "old-channel" : "current",
          setSelectedSessionId: select,
        },
        setSelectedTurnId: vi.fn(),
        setSelectedContextTurnIds: vi.fn(),
        setPendingThreadContext: vi.fn(),
        setActiveGeneratedArtifact: vi.fn(),
        setSessionRailOpen: vi.fn(),
        onNavigateSurface: navigate,
        surfaceState: { messageMode: "chat" },
        compactSurfaceLayout: false,
        workbenchController: { setDockOpen: vi.fn() },
        activeGeneratedArtifact: null,
        selectedTurnId: null,
      });
      return null;
    }
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<Harness />);
    });
    await act(async () => owner.handleSelectSessionFromRail("old-channel"));
    expect(ensure).toHaveBeenCalledExactlyOnceWith("old-channel");
    expect(select).toHaveBeenCalledTimes(which === "same" ? 0 : 1);
    expect(navigate).toHaveBeenCalledExactlyOnceWith("chat", {
      sessionId: "old-channel",
      turnId: null,
      artifactId: null,
    });
    await act(async () => renderer.unmount());
  },
);

it("selects without listing anything when nothing owns the listing", async () => {
  // Hosts that never hand over a lister (the Classic shell's own tests, say) keep working unchanged.
  const select = vi.fn();
  let owner!: ReturnType<typeof useChatSurfaceNavigation>;
  function Harness() {
    owner = useChatSurfaceNavigation({
      sessionData: { openHistoricalWindow: vi.fn(), returnToLatest: vi.fn() },
      selection: { selectedSessionId: "current", setSelectedSessionId: select },
      setSelectedTurnId: vi.fn(),
      setSelectedContextTurnIds: vi.fn(),
      setPendingThreadContext: vi.fn(),
      setActiveGeneratedArtifact: vi.fn(),
      setSessionRailOpen: vi.fn(),
      onNavigateSurface: vi.fn(),
      surfaceState: { messageMode: "chat" },
      compactSurfaceLayout: false,
      workbenchController: { setDockOpen: vi.fn() },
      activeGeneratedArtifact: null,
      selectedTurnId: null,
    });
    return null;
  }
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(<Harness />);
  });
  await act(async () => owner.handleSelectSessionFromRail("another"));
  expect(select).toHaveBeenCalledWith("another");
  await act(async () => renderer.unmount());
});
