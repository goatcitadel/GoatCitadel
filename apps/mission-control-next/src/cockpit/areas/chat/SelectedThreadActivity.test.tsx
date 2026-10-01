// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { SelectedThreadActivity } from "./SelectedThreadActivity";
const mocks = vi.hoisted(() => ({ width: 800, activity: vi.fn(), media: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/hooks/useMediaQuery", () => ({ useMediaQuery: (query: string) => { mocks.media(query); return mocks.width < 1024; } }));
vi.mock("./use-thread-activity", () => ({ useThreadActivity: (ids: string[]) => { mocks.activity(ids); return { records: { s: { label: "Working", tone: "running" } }, loading: false, refresh: vi.fn() }; } }));
it("covers the actual tablet breakpoint with one selected read and disables the duplicate desktop read", async () => {
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    mocks.width = 800; await act(async () => root.render(<SelectedThreadActivity sessionId="s" />));
    expect(mocks.media).toHaveBeenLastCalledWith("(width < 1024px)"); expect(mocks.activity).toHaveBeenLastCalledWith(["s"]);
    expect(host.textContent).toBe("Working");
    mocks.width = 1280; await act(async () => root.render(<SelectedThreadActivity sessionId="s" />));
    expect(mocks.activity).toHaveBeenLastCalledWith([]); expect(host.textContent).toBe("");
  } finally { await act(async () => root.unmount()); host.remove(); }
});
