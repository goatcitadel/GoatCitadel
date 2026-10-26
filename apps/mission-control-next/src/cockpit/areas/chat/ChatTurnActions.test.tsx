// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatThreadTurnRecord } from "@goatcitadel/contracts";
import { ChatTurnActions, type TurnActionHandlers } from "./ChatTurnActions";

const media = vi.hoisted(() => ({ phone: false }));
vi.mock("@goatcitadel/mission-control-shared/hooks/useMediaQuery", () => ({ useMediaQuery: () => media.phone }));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  media.phone = false;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const turn = {
  turnId: "turn-1",
  assistantMessage: { content: "Answer" },
  trace: { status: "completed" },
  branch: { siblingTurnIds: [], activeSiblingIndex: 0, siblingCount: 1 },
} as unknown as ChatThreadTurnRecord;

function handlers(): TurnActionHandlers {
  return {
    onRetryTurn: vi.fn(),
    onStartNewThreadFromTurn: vi.fn(),
    onSwitchBranch: vi.fn(),
    onEditTurn: vi.fn(),
    onOpenRunDetails: vi.fn(),
    onCreateGeneratedArtifact: vi.fn(),
  } as unknown as TurnActionHandlers;
}

const labels = () => [...container.querySelectorAll("button")].map((button) => button.textContent?.trim());

describe("Chat turn actions", () => {
  it("keeps Copy visible and secondary actions in a menu on wider screens", async () => {
    await act(async () =>
      root.render(
        <ChatTurnActions
          turn={turn}
          actions={handlers()}
          streaming={false}
          readOnly={false}
          hasAnswer
          onCopy={vi.fn()}
        />,
      ),
    );
    expect(labels()).toEqual(expect.arrayContaining(["Copy answer", "More"]));
    expect(labels()).not.toContain("Edit and resend");
  });

  it("names the edit action after what it edits", async () => {
    await act(async () =>
      root.render(
        <ChatTurnActions
          turn={turn}
          actions={handlers()}
          streaming={false}
          readOnly={false}
          hasAnswer
          onCopy={vi.fn()}
        />,
      ),
    );
    await act(async () => {
      const more = container.querySelector('button[aria-label="More message actions"]') as HTMLElement;
      more.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
      more.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, button: 0 }));
      more.click();
    });
    const items = await vi.waitFor(() => {
      const found = [...document.body.querySelectorAll('[role="menuitem"]')].map((node) => node.textContent);
      expect(found.length).toBeGreaterThan(0);
      return found;
    });
    expect(items).toContain("Edit your message and resend");
    expect(items).not.toContain("Edit and resend");
  });

  it("keeps Copy visible on phones and moves the rest behind a 44 px More menu", async () => {
    media.phone = true;
    const onCopy = vi.fn();
    await act(async () =>
      root.render(
        <ChatTurnActions
          turn={turn}
          actions={handlers()}
          streaming={false}
          readOnly={false}
          hasAnswer
          onCopy={onCopy}
        />,
      ),
    );
    expect(labels()).not.toContain("Fork");
    const more = container.querySelector('button[aria-label="More message actions"]')!;
    expect(more.className).toContain("min-h-11");
    const copy = [...container.querySelectorAll("button")].find((button) => button.textContent === "Copy answer")!;
    expect(copy.className).toContain("min-h-11");
    await act(async () => copy.click());
    expect(onCopy).toHaveBeenCalledOnce();
  });

  it("hides branching actions while streaming or read-only", async () => {
    await act(async () =>
      root.render(
        <ChatTurnActions turn={turn} actions={handlers()} streaming readOnly={false} hasAnswer onCopy={vi.fn()} />,
      ),
    );
    expect(labels()).toContain("Copy answer so far");
    expect(labels()).not.toContain("Fork");
    expect(labels()).not.toContain("Edit and resend");
  });

  it("marks the current answer version with aria-current", async () => {
    const branched = {
      ...turn,
      branch: { siblingTurnIds: ["turn-0", "turn-1"], activeSiblingIndex: 1, siblingCount: 2 },
    } as unknown as ChatThreadTurnRecord;
    const actions = handlers();
    await act(async () =>
      root.render(
        <ChatTurnActions
          turn={branched}
          actions={actions}
          streaming={false}
          readOnly={false}
          hasAnswer
          onCopy={vi.fn()}
        />,
      ),
    );
    const first = container.querySelector<HTMLButtonElement>('button[aria-label="Switch to version 1"]')!;
    const current = container.querySelector<HTMLButtonElement>('button[aria-label="Switch to version 2"]')!;
    expect(current.getAttribute("aria-current")).toBe("true");
    expect(current.disabled).toBe(true);
    expect(current.className).toContain("rounded-sm");
    expect(first.hasAttribute("aria-current")).toBe(false);
    await act(async () => first.click());
    expect(actions.onSwitchBranch).toHaveBeenCalledWith("turn-0");
  });

  const button = (label: string) =>
    [...document.body.querySelectorAll("button")].find((entry) => entry.textContent === label);

  async function renderWithTools(toolRuns: unknown[]) {
    const actions = handlers();
    const withTools = { ...turn, toolRuns } as unknown as ChatThreadTurnRecord;
    await act(async () =>
      root.render(
        <ChatTurnActions
          turn={withTools}
          actions={actions}
          streaming={false}
          readOnly={false}
          hasAnswer
          onCopy={vi.fn()}
        />,
      ),
    );
    return actions;
  }

  it("retries at once when no tool in the turn could change things", async () => {
    const actions = await renderWithTools([{ toolName: "read", effectPotential: "none", effectOutcomeKind: "none" }]);
    await act(async () => button("Retry")!.click());
    expect(actions.onRetryTurn).toHaveBeenCalledWith("turn-1");
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it.each([
    ["an effect that is not ruled out", { effectPotential: "unknown" }],
    ["a concrete outside change", { effectPotential: "none", effectOutcomeKind: "concrete" }],
    ["an uncertain outcome", { effectPotential: "none", effectOutcomeKind: "uncertain" }],
  ])("confirms a retry when a tool has %s", async (_case, run) => {
    const actions = await renderWithTools([
      { toolName: "write", ...run },
      { toolName: "read", effectPotential: "none", effectOutcomeKind: "none" },
    ]);
    await act(async () => button("Retry")!.click());
    expect(actions.onRetryTurn).not.toHaveBeenCalled();
    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("1 tool in this answer may change things outside the chat.");
    expect(dialog.textContent).toContain("Retrying may run them again. Approvals still apply.");
    const order = [...dialog.querySelectorAll("button")].map((entry) => entry.textContent);
    expect(order.indexOf("Retry answer")).toBeLessThan(order.indexOf("Cancel"));
    expect(button("Retry answer")!.className).toContain("bg-accent");
    await act(async () => button("Cancel")!.click());
    expect(actions.onRetryTurn).not.toHaveBeenCalled();
    await act(async () => button("Retry")!.click());
    await act(async () => button("Retry answer")!.click());
    expect(actions.onRetryTurn).toHaveBeenCalledExactlyOnceWith("turn-1");
  });

  it("counts every tool that may change things", async () => {
    await renderWithTools([
      { toolName: "a", effectPotential: "unknown" },
      { toolName: "b", effectPotential: "unknown" },
    ]);
    await act(async () => button("Retry")!.click());
    expect(document.body.querySelector('[role="dialog"]')!.textContent).toContain(
      "2 tools in this answer may change things outside the chat.",
    );
  });

  it("asks before retry only when a tool's effectPotential is a write or side effect", async () => {
    // A tool recorded as a read ("none") retries at once.
    const quiet = await renderWithTools([{ toolName: "read", effectPotential: "none" }]);
    await act(async () => button("Retry")!.click());
    expect(quiet.onRetryTurn).toHaveBeenCalledExactlyOnceWith("turn-1");
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    // A tool that may write ("unknown"), or one with no recorded potential, might change things: ask first.
    const effectful = await renderWithTools([
      { toolName: "write", effectPotential: "unknown" },
      { toolName: "legacy" },
    ]);
    await act(async () => button("Retry")!.click());
    expect(effectful.onRetryTurn).not.toHaveBeenCalled();
    expect(document.body.querySelector('[role="dialog"]')!.textContent).toContain(
      "2 tools in this answer may change things outside the chat.",
    );
  });
});
