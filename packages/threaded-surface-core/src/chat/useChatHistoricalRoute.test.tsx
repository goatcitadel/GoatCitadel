import React from "react";
import { act, create } from "react-test-renderer";
import { expect, it, vi } from "vitest";
import { parseChatHistoricalRoute, useChatHistoricalRoute } from "./useChatHistoricalRoute";
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it("parses only an exact bounded message identity", () => {
  expect(parseChatHistoricalRoute("?sessionId=s&messageId=m%2F1&sequence=7&redirect=https://foreign", "w")).toEqual({ workspaceId: "w", sessionId: "s", messageId: "m/1", sequence: 7, score: 0, excerpt: "" });
  for (const query of ["sequence=-1", "sequence=0", "sequence=NaN", "sequence=1.5", "sequence=9007199254740992", ""]) expect(parseChatHistoricalRoute(`?sessionId=s&messageId=m&${query}`, "w")).toBeNull();
});
it("replays reload and Back/Forward anchors only for the scoped canonical selected conversation", async () => {
  const open = vi.fn(async () => true); const latest = vi.fn();
  function Harness({ route = "?sessionId=s&messageId=old&sequence=7", selected = "s", workspace = "w" }) {
    useChatHistoricalRoute({ routeSearch: route, workspaceId: "w", selectedSession: { sessionId: selected, workspaceId: workspace }, openHistoricalWindow: open, returnToLatest: latest }); return null;
  }
  let renderer!: ReturnType<typeof create>;
  await act(async () => { renderer = create(<Harness selected="other" />); }); expect(open).not.toHaveBeenCalled();
  await act(async () => renderer.update(<Harness workspace="foreign" />)); expect(open).not.toHaveBeenCalled();
  await act(async () => renderer.update(<Harness />)); expect(open).toHaveBeenCalledTimes(1); expect(open.mock.calls[0]).toEqual(["s", expect.objectContaining({ messageId: "old", sequence: 7, workspaceId: "w" })]);
  await act(async () => renderer.update(<Harness />)); expect(open).toHaveBeenCalledTimes(1);
  await act(async () => renderer.update(<Harness route="?sessionId=s" />)); expect(latest).toHaveBeenCalledOnce();
  await act(async () => renderer.update(<Harness />)); expect(open).toHaveBeenCalledTimes(2);
  await act(async () => renderer.update(<Harness route="?sessionId=s&messageId=newer&sequence=9" />)); expect(open).toHaveBeenLastCalledWith("s", expect.objectContaining({ messageId: "newer", sequence: 9 }));
  await act(async () => renderer.unmount());
});
