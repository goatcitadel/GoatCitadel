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

const dialogButton = (label: string) =>
  [...document.body.querySelectorAll("button")].find((button) => button.textContent === label)!;

async function typeConfirmation(value: string) {
  const input = document.body.querySelector<HTMLInputElement>('[role="dialog"] input')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

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

  it("requires the evidence review and a typed confirmation for nuclear approval", async () => {
    const onApprove = vi.fn();
    await act(async () =>
      root.render(
        <RiskApprovalAction
          approval={approval("nuclear")}
          reviewedApproval={{ ...reviewedApproval, riskLevel: "nuclear" }}
          pending={false}
          onApprove={onApprove}
        />,
      ),
    );
    await act(async () => container.querySelector("button")?.click());
    expect(document.body.textContent).toContain("Confirm nuclear risk action");
    expect(document.body.textContent).toContain("pnpm test");
    const confirm = () =>
      [...document.body.querySelectorAll("button")].find((button) => button.textContent === "Approve once")!;
    expect(confirm().disabled).toBe(true);
    const input = document.body.querySelector<HTMLInputElement>('[role="dialog"] input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Approve");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(confirm().disabled).toBe(false);
    await act(async () => confirm().click());
    expect(onApprove).toHaveBeenCalledOnce();
  });

  it("withholds nuclear approval when the current action cannot be reviewed", async () => {
    const onApprove = vi.fn();
    await act(async () =>
      root.render(<RiskApprovalAction approval={approval("nuclear")} pending={false} onApprove={onApprove} />),
    );
    await act(async () => container.querySelector("button")?.click());
    const input = document.body.querySelector<HTMLInputElement>('[role="dialog"] input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "approve");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const confirm = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent === "Approve once",
    )!;
    expect(confirm.disabled).toBe(true);
    expect(document.body.textContent).toContain("current action preview is unavailable");
  });

  it("keeps nuclear approval closed for any word but the confirmation word", async () => {
    const onApprove = vi.fn();
    await act(async () =>
      root.render(
        <RiskApprovalAction
          approval={approval("nuclear")}
          reviewedApproval={{ ...reviewedApproval, riskLevel: "nuclear" }}
          pending={false}
          onApprove={onApprove}
        />,
      ),
    );
    await act(async () => container.querySelector("button")?.click());
    // The evidence is reviewable, so only the typed word can keep Approve once closed.
    expect(document.body.textContent).toContain("pnpm test");
    for (const word of ["yes", "approv"]) {
      await typeConfirmation(word);
      expect(dialogButton("Approve once").disabled).toBe(true);
    }
    await typeConfirmation("approve");
    expect(dialogButton("Approve once").disabled).toBe(false);
    expect(onApprove).not.toHaveBeenCalled();
  });

  it("starts a reopened nuclear review with an empty confirmation", async () => {
    await act(async () =>
      root.render(
        <RiskApprovalAction
          approval={approval("nuclear")}
          reviewedApproval={{ ...reviewedApproval, riskLevel: "nuclear" }}
          pending={false}
          onApprove={vi.fn()}
        />,
      ),
    );
    const review = container.querySelector("button")!;
    await act(async () => review.click());
    await typeConfirmation("approve");
    expect(dialogButton("Approve once").disabled).toBe(false);
    await act(async () => dialogButton("Cancel").click());
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    // The same mounted instance reopens it; nothing was re-rendered with a new key.
    expect(review.isConnected).toBe(true);
    await act(async () => review.click());
    expect(document.body.querySelector<HTMLInputElement>('[role="dialog"] input')?.value).toBe("");
    expect(dialogButton("Approve once").disabled).toBe(true);
  });

  it.each(["safe", "caution"] as const)("approves %s risk in one click", async (riskLevel) => {
    const onApprove = vi.fn();
    await act(async () =>
      root.render(<RiskApprovalAction approval={approval(riskLevel)} pending={false} onApprove={onApprove} />),
    );
    await act(async () => container.querySelector("button")?.click());
    expect(onApprove).toHaveBeenCalledOnce();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it("sends a risk level it doesn't know through the review and the typed confirmation", async () => {
    // A future Gateway may send a label this build doesn't know. It must not fall through to one click.
    const unknownRisk = "critical" as unknown as ApprovalRequest["riskLevel"];
    const onApprove = vi.fn();
    await act(async () =>
      root.render(
        <RiskApprovalAction
          approval={approval(unknownRisk)}
          reviewedApproval={{ ...reviewedApproval, riskLevel: unknownRisk }}
          pending={false}
          onApprove={onApprove}
        />,
      ),
    );
    const review = container.querySelector("button")!;
    expect(review.textContent).toBe("Review approval");
    await act(async () => review.click());
    expect(onApprove).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Confirm critical risk action");
    expect(document.body.textContent).toContain("pnpm test");
    expect(dialogButton("Approve once").disabled).toBe(true);
    await typeConfirmation("approve");
    await act(async () => dialogButton("Approve once").click());
    expect(onApprove).toHaveBeenCalledOnce();
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
