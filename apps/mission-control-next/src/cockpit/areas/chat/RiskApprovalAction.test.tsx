// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalRequest } from "@goatcitadel/contracts";
import type { ChatPendingApprovalState } from "@goatcitadel/mission-control-shared/components/chat/ChatPendingApprovalPanel";
import { RiskApprovalAction } from "./RiskApprovalAction";

let root: Root;
let container: HTMLDivElement;

const approval = (riskLevel: ChatPendingApprovalState["riskLevel"]): ChatPendingApprovalState => ({
  approvalId: "approval-1",
  kind: "tool_invoke",
  riskLevel,
  toolName: "write_file",
  reason: "Changes a project file",
});
const reviewedApproval: ApprovalRequest = {
  approvalId: "approval-1",
  kind: "tool_invoke",
  riskLevel: "danger",
  status: "pending",
  payload: {},
  preview: { commands: ["pnpm test"], targets: ["workspace/note.txt"] },
  createdAt: "2026-10-01T00:00:00Z",
  explanationStatus: "not_requested",
};

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("risk approval action", () => {
  it("requires a second confirmation before a danger approval", async () => {
    const onApprove = vi.fn();
    await act(async () =>
      root.render(
        <RiskApprovalAction
          approval={approval("danger")}
          reviewedApproval={reviewedApproval}
          pending={false}
          onApprove={onApprove}
        />,
      ),
    );
    await act(async () => container.querySelector("button")?.click());
    expect(onApprove).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Confirm danger risk action");
    expect(document.body.textContent).toContain("pnpm test");
    expect(document.body.textContent).toContain("workspace/note.txt");
    const confirm = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent === "Approve once",
    );
    await act(async () => confirm?.click());
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it("withholds danger approval when the current action cannot be reviewed", async () => {
    const onApprove = vi.fn();
    await act(async () =>
      root.render(<RiskApprovalAction approval={approval("danger")} pending={false} onApprove={onApprove} />),
    );
    await act(async () => container.querySelector("button")?.click());
    const confirm = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent === "Approve once",
    )!;
    expect(confirm.disabled).toBe(true);
    expect(document.body.textContent).toContain("current action preview is unavailable");
    expect(onApprove).not.toHaveBeenCalled();
  });

  it("keeps the complete persisted command available when the compact summary is shortened", async () => {
    const command = `run ${"a".repeat(180)}`;
    await act(async () =>
      root.render(
        <RiskApprovalAction
          approval={approval("danger")}
          reviewedApproval={{ ...reviewedApproval, preview: { command } }}
          pending={false}
          onApprove={vi.fn()}
        />,
      ),
    );
    await act(async () => container.querySelector("button")?.click());
    expect(document.body.textContent).toContain("Full persisted action preview");
    expect(document.body.textContent).toContain(command);
    expect(document.body.querySelector("details")?.open).toBe(true);
  });

  it("keeps a specific browser selector actionable while a generic summary is insufficient", async () => {
    await act(async () =>
      root.render(
        <RiskApprovalAction
          approval={approval("danger")}
          reviewedApproval={{ ...reviewedApproval, preview: { selector: "#delete-record" } }}
          pending={false}
          onApprove={vi.fn()}
        />,
      ),
    );
    await act(async () => container.querySelector("button")?.click());
    expect(document.body.textContent).toContain("Selector: #delete-record");
    expect(
      [...document.body.querySelectorAll("button")].find((button) => button.textContent === "Approve once")?.disabled,
    ).toBe(false);
    await act(async () =>
      root.render(
        <RiskApprovalAction
          approval={approval("danger")}
          reviewedApproval={{ ...reviewedApproval, preview: { summary: "Review action" } }}
          pending={false}
          onApprove={vi.fn()}
        />,
      ),
    );
    expect(
      [...document.body.querySelectorAll("button")].find((button) => button.textContent === "Approve once")?.disabled,
    ).toBe(true);
  });

  it("requires an uninterrupted one-second hold for nuclear approval", async () => {
    vi.useFakeTimers();
    const onApprove = vi.fn();
    await act(async () =>
      root.render(<RiskApprovalAction approval={approval("nuclear")} pending={false} onApprove={onApprove} />),
    );
    const button = container.querySelector("button")!;
    await act(async () => button.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })));
    await act(async () => vi.advanceTimersByTime(999));
    expect(onApprove).not.toHaveBeenCalled();
    await act(async () => button.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Enter" })));
    await act(async () => vi.advanceTimersByTime(1_000));
    expect(onApprove).not.toHaveBeenCalled();
    await act(async () => button.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })));
    await act(async () => vi.advanceTimersByTime(1_000));
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it("never offers direct approval when risk is missing", async () => {
    const onApprove = vi.fn();
    await act(async () =>
      root.render(<RiskApprovalAction approval={approval(undefined)} pending={false} onApprove={onApprove} />),
    );
    expect(container.querySelector("button")).toBeNull();
    expect(container.textContent).toContain("Review the persisted approval");
    expect(onApprove).not.toHaveBeenCalled();
  });
});
