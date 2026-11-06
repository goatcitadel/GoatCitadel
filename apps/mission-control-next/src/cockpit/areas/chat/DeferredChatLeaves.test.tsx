// @vitest-environment happy-dom
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  DeferredBtwSideChatPanel,
  DeferredSessionStatusPanel,
  DeferredCodeModeRequestCard,
  DeferredBrowserErrandCards,
} from "./DeferredChatLeaves";
import { ChatTurnDetails } from "./ChatTurnDetails";
const loads = vi.hoisted(() => ({
  aside: 0,
  status: 0,
  code: 0,
  errand: 0,
  rows: 0,
  releaseAside: undefined as (() => void) | undefined,
}));
vi.mock("../../ui/AreaErrorBoundary", () => ({
  AreaErrorBoundary: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("../../../features/threaded-surface/ThreadedBtwSideChatPanel", async () => {
  loads.aside += 1;
  await new Promise<void>((resolve) => {
    loads.releaseAside = resolve;
  });
  return {
    ThreadedBtwSideChatPanel: ({ sideChat }: { sideChat: { open: boolean } }) => {
      const [value, setValue] = useState(0);
      return sideChat.open ? <button type="button" onClick={() => setValue(value + 1)}>Aside draft {value}</button> : null;
    },
  };
});
vi.mock("../../../features/threaded-surface/ChatSessionStatusPanel", () => {
  loads.status += 1;
  return {
    ChatSessionStatusPanel: () => {
      const [value, setValue] = useState(0);
      return <button type="button" onClick={() => setValue(value + 1)}>Status view {value}</button>;
    },
  };
});
vi.mock("./ChatCodeModeRequestCard", () => {
  loads.code += 1;
  return {
    ChatCodeModeRequestCard: ({ turn }: { turn: { toolRuns: Array<{ status: string; approvalId?: string }> } }) => (
      <p>
        Code request {turn.toolRuns[0]?.status} {turn.toolRuns[0]?.approvalId}
      </p>
    ),
  };
});
vi.mock("./ChatBrowserErrandCard", () => {
  loads.errand += 1;
  return {
    ChatBrowserErrandCards: ({ toolRuns }: { toolRuns: Array<{ status: string; toolRunId: string }> }) => (
      <p>
        Errand {toolRuns[0]?.toolRunId} {toolRuns[0]?.status}
      </p>
    ),
  };
});
vi.mock("./ChatToolActivityBody", () => {
  loads.rows += 1;
  return {
    ChatToolActivityBody: () => {
      const [value, setValue] = useState(0);
      return <button type="button" onClick={() => setValue(value + 1)}>Tool detail {value}</button>;
    },
  };
});
vi.mock("@goatcitadel/mission-control-shared/hooks/useMediaQuery", () => ({ useMediaQuery: () => false }));
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
async function render(node: ReactNode) {
  await act(async () => {
    root.render(node);
    await vi.dynamicImportSettled();
  });
}
function clickButton() {
  act(() => container.querySelector("button")!.click());
}
const turn = (toolRuns: unknown[], status = "completed") =>
  ({
    turnId: "turn-1",
    assistantMessage: { content: "Done" },
    trace: { status },
    branch: { siblingTurnIds: [], activeSiblingIndex: 0, siblingCount: 1 },
    citations: [],
    toolRuns,
  }) as never;
const actions = {
  onRetryTurn: vi.fn(),
  onStartNewThreadFromTurn: vi.fn(),
  onSwitchBranch: vi.fn(),
  onEditTurn: vi.fn(),
  onOpenRunDetails: vi.fn(),
  onCreateGeneratedArtifact: vi.fn(),
  onOpenGeneratedArtifact: vi.fn(),
};

it("loads Aside on first open and retains its local state through close/reopen", async () => {
  const panel = (open: boolean) => (
    <DeferredBtwSideChatPanel sideChat={{ open, workspaceId: "default", parentSessionId: "session-1" } as never} />
  );
  await render(panel(false));
  expect(loads.aside).toBe(0);
  expect(container.textContent).toBe("");
  await act(async () => {
    root.render(panel(true));
  });
  await vi.waitFor(() => expect(loads.releaseAside).toBeTypeOf("function"));
  expect(loads.aside).toBe(1);
  await act(async () => root.render(panel(false)));
  expect(container.textContent).toBe("");
  await act(async () => {
    loads.releaseAside!();
    await vi.dynamicImportSettled();
  });
  expect(container.textContent).toBe("");
  await render(panel(true));
  clickButton();
  expect(container.textContent).toContain("Aside draft 1");
  await render(panel(false));
  expect(container.querySelector("button")).toBeNull();
  await render(panel(true));
  expect(loads.aside).toBe(1);
  expect(container.textContent).toContain("Aside draft 1");
});
it("loads status on demand and retains its mounted state while hidden", async () => {
  const panel = (open: boolean) => <DeferredSessionStatusPanel panel={{ open } as never} />;
  await render(panel(false));
  expect(loads.status).toBe(0);
  await render(panel(true));
  clickButton();
  await render(panel(false));
  expect(container.querySelector("[hidden]")).not.toBeNull();
  await render(panel(true));
  expect(loads.status).toBe(1);
  expect(container.textContent).toContain("Status view 1");
});
it("loads a restored Code Mode approval immediately without changing its receipt", async () => {
  await render(<DeferredCodeModeRequestCard turn={turn([])} workspaceId="default" onRefreshThread={vi.fn()} />);
  expect(loads.code).toBe(0);
  await render(
    <DeferredCodeModeRequestCard
      turn={turn(
        [{ toolName: "code_mode.request", status: "approval_required", approvalId: "approval-1" }],
        "waiting_for_approval",
      )}
      workspaceId="default"
      onRefreshThread={vi.fn()}
    />,
  );
  expect(loads.code).toBe(1);
  expect(container.textContent).toContain("Code request approval_required approval-1");
});
it("loads an active restored browser errand immediately with its exact run", async () => {
  await render(<DeferredBrowserErrandCards toolRuns={[]} />);
  expect(loads.errand).toBe(0);
  await render(
    <DeferredBrowserErrandCards
      toolRuns={[{ toolName: "browser.errand", toolRunId: "run-1", status: "approval_required" }] as never}
    />,
  );
  expect(loads.errand).toBe(1);
  expect(container.textContent).toContain("Errand run-1 approval_required");
});
it("keeps tool summaries and turn actions eager, then retains opened detail state", async () => {
  const record = turn([{ toolName: "fs.read", toolRunId: "tool-1", status: "executed", args: {}, result: {} }]);
  await render(<ChatTurnDetails turn={record} streaming={false} readOnly={false} actions={actions} />);
  expect(loads.rows).toBe(0);
  expect(container.querySelector('details[aria-label="Tool activity for this turn"]')).not.toBeNull();
  const toggle = async (open: boolean) => {
    await act(async () => {
      const details = container.querySelector<HTMLDetailsElement>('details[aria-label="Tool activity for this turn"]')!;
      details.open = open;
      details.dispatchEvent(new Event("toggle", { bubbles: false }));
      await vi.dynamicImportSettled();
    });
  };
  await toggle(true);
  act(() =>
    [...container.querySelectorAll("button")].find((button) => button.textContent === "Tool detail 0")!.click(),
  );
  await toggle(false);
  await toggle(true);
  expect(loads.rows).toBe(1);
  expect(container.textContent).toContain("Tool detail 1");
});
