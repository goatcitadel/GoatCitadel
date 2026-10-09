import React from "react";
import { act, create } from "react-test-renderer";
import { expect, it, vi } from "vitest";
import { useChatSurfaceNavigation } from "./useChatSurfaceNavigation";
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it.each(["same", "different", "legacy"])("publishes the exact matched turn after %s conversation selection", async (target) => {
  const history = vi.fn(); const navigate = vi.fn(); const select = vi.fn();
  let owner!: ReturnType<typeof useChatSurfaceNavigation>;
  function Harness() { owner = useChatSurfaceNavigation({ sessionData: { openHistoricalWindow: history, returnToLatest: vi.fn() }, selection: { selectedSessionId: "same", setSelectedSessionId: vi.fn() }, setSelectedTurnId: select, setSelectedContextTurnIds: vi.fn(), setPendingThreadContext: vi.fn(), setActiveGeneratedArtifact: vi.fn(), setSessionRailOpen: vi.fn(), onNavigateSurface: navigate, surfaceState: { messageMode: "chat" }, compactSurfaceLayout: false, workbenchController: { setDockOpen: vi.fn() }, activeGeneratedArtifact: null, selectedTurnId: null }); return null; }
  let renderer!: ReturnType<typeof create>;
  await act(async () => { renderer = create(<Harness />); });
  const hit = { workspaceId: "w", sessionId: target, messageId: "exact-message", turnId: target === "legacy" ? undefined : "exact-turn", sequence: 7, excerpt: "match", score: 1 };
  await act(async () => owner.handleSelectSessionFromRail(target, { searchHit: hit }));
  expect(history).toHaveBeenCalledExactlyOnceWith(target, hit);
  expect(select).toHaveBeenCalledWith(target === "legacy" ? null : "exact-turn");
  expect(navigate).toHaveBeenCalledExactlyOnceWith("chat", { sessionId: target, turnId: target === "legacy" ? null : "exact-turn", artifactId: null, ...(target === "legacy" ? { messageId: "exact-message", sequence: 7 } : {}) });
  await act(async () => renderer.unmount());
});
