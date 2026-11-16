// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MissionThreadedContextDockProps } from "@goatcitadel/threaded-surface-core";
import { ChatSessionTitle } from "./ChatSessionControls";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it("the conversation title is a page title (text-xl) that truncates instead of pushing the controls (U-GL-035)", async () => {
  const dock = {
    renameTitle: "t",
    onRenameTitleChange: vi.fn(),
    onRenameSession: vi.fn(async () => {}),
    sessionControlPending: null,
  } as unknown as MissionThreadedContextDockProps;
  for (const withDock of [dock, null]) {
    await act(async () => root.render(<ChatSessionTitle title="A long conversation title" dock={withDock} />));
    const h1 = container.querySelector("h1")!;
    expect(h1.className).toContain("text-xl");
    expect(h1.className).toContain("truncate");
    expect(h1.className).not.toContain("text-base");
  }
});
