// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MissionThreadedContextDockProps } from "@goatcitadel/threaded-surface-core";
import { ChatSessionOverflow, ChatSessionTitle } from "./ChatSessionControls";

let root: Root;
let container: HTMLDivElement;

function dock(overrides: Partial<MissionThreadedContextDockProps> = {}): MissionThreadedContextDockProps {
  return {
    renameTitle: "Original title",
    onRenameTitleChange: vi.fn(),
    onRenameSession: vi.fn(async () => {}),
    onToggleArchiveSession: vi.fn(async () => {}),
    onExportSnapshot: vi.fn(),
    selectedSession: { sessionId: "session-1" },
    sessionControlPending: null,
    ...overrides,
  } as unknown as MissionThreadedContextDockProps;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("Chat session controls", () => {
  it("uses the existing controller to rename the current conversation", async () => {
    const context = dock();
    await act(async () => root.render(<ChatSessionTitle title="Original title" dock={context} />));
    await act(async () => (container.querySelector('button[title="Rename conversation"]') as HTMLButtonElement).click());
    expect(context.onRenameTitleChange).toHaveBeenCalledWith("Original title");
    await act(async () => (container.querySelector('button[type="submit"]') as HTMLButtonElement).click());
    expect(context.onRenameSession).toHaveBeenCalledOnce();
  });

  it("exports immediately but requires confirmation before archiving", async () => {
    const context = dock();
    await act(async () => root.render(<ChatSessionOverflow dock={context} onFork={vi.fn()} />));
    await act(async () => (container.querySelector("summary") as HTMLElement).click());
    const exportButton = [...container.querySelectorAll("button")].find((button) => button.textContent === "Export conversation");
    await act(async () => exportButton?.click());
    expect(context.onExportSnapshot).toHaveBeenCalledOnce();
    await act(async () => (container.querySelector("summary") as HTMLElement).click());
    const archiveButton = [...container.querySelectorAll("button")].find((button) => button.textContent === "Archive conversation");
    await act(async () => archiveButton?.click());
    expect(context.onToggleArchiveSession).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Archive conversation?");
    const confirm = [...document.body.querySelectorAll("button")].find((button) => button.textContent === "Archive");
    await act(async () => confirm?.click());
    expect(context.onToggleArchiveSession).toHaveBeenCalledOnce();
  });
});
