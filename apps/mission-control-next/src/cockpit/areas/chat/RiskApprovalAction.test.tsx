// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    await act(async () => root.render(<RiskApprovalAction approval={approval("danger")} pending={false} onApprove={onApprove} />));
    await act(async () => container.querySelector("button")?.click());
    expect(onApprove).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Confirm danger risk action");
    const confirm = [...document.body.querySelectorAll("button")].find((button) => button.textContent === "Approve once");
    await act(async () => confirm?.click());
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it("requires an uninterrupted one-second hold for nuclear approval", async () => {
    vi.useFakeTimers();
    const onApprove = vi.fn();
    await act(async () => root.render(<RiskApprovalAction approval={approval("nuclear")} pending={false} onApprove={onApprove} />));
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
    await act(async () => root.render(<RiskApprovalAction approval={approval(undefined)} pending={false} onApprove={onApprove} />));
    expect(container.querySelector("button")).toBeNull();
    expect(container.textContent).toContain("Review the persisted approval");
    expect(onApprove).not.toHaveBeenCalled();
  });
});
