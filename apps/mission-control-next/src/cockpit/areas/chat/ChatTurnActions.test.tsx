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
});
