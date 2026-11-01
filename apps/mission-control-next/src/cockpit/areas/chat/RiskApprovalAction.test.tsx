// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalRequest } from "@goatcitadel/contracts";
import type { ChatPendingApprovalState } from "@goatcitadel/mission-control-shared/components/chat/ChatPendingApprovalPanel";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RiskApprovalAction } from "./RiskApprovalAction";
import { refuseNetwork } from "../../../test/refuse-network";

// The review summary names workspaces from the workspace list.
vi.mock("@goatcitadel/mission-control-shared/api/workspaces", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@goatcitadel/mission-control-shared/api/workspaces")>()),
  fetchWorkspaces: vi.fn(async () => ({ items: [] })),
}));
refuseNetwork();

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
  // The review summary reads workspace names through the query cache; give every render one.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const raw = createRoot(container);
  root = {
    render: (node) => raw.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>),
    unmount: () => raw.unmount(),
  } as Root;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("risk approval action", () => {
  it.each([
    ["Home", 0],
    ["End", 1200],
  ])("keeps %s inside focused action evidence without native ancestor scrolling or approval", async (key, top) => {
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
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const region = dialog.querySelector<HTMLElement>('[aria-label="Approval action details"]')!;
    Object.defineProperties(region, { scrollHeight: { value: 1600 }, clientHeight: { value: 400 } });
    dialog.scrollTop = 640;
    region.scrollTop = 180;
    region.scrollLeft = 12;
    region.focus();
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    await act(async () => {
      region.dispatchEvent(event);
    });
    // Happy DOM has no browser scroll default; cancellation is what prevents the native ancestor chain.
    expect(event.defaultPrevented).toBe(true);
    expect(region.scrollTop).toBe(top);
    expect(region.scrollLeft).toBe(12);
    expect(dialog.scrollTop).toBe(640);
    expect(document.activeElement).toBe(region);
    expect(region.textContent).toContain("pnpm test");
    expect(region.textContent).toContain("workspace/note.txt");
    expect(dialogButton("Approve once").disabled).toBe(true);
    expect(onApprove).not.toHaveBeenCalled();
  });

  it("leaves page, arrow, Tab, modified shortcuts and nested editing controls to native behavior", async () => {
    await act(async () =>
      root.render(
        <RiskApprovalAction
          approval={approval("danger")}
          reviewedApproval={reviewedApproval}
          pending={false}
          onApprove={vi.fn()}
        />,
      ),
    );
    await act(async () => container.querySelector("button")?.click());
    const region = document.querySelector<HTMLElement>('[aria-label="Approval action details"]')!;
    region.scrollTop = 180;
    region.focus();
    const nativeKeys: KeyboardEventInit[] = [
      ...["PageUp", "PageDown", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Tab"].map((key) => ({ key })),
      { key: "Tab", shiftKey: true },
      ...["Home", "End"].flatMap((key) => [
        { key, ctrlKey: true },
        { key, metaKey: true },
        { key, altKey: true },
        { key, shiftKey: true },
        { key, isComposing: true },
      ]),
    ];
    for (const init of nativeKeys) {
      const event = new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true });
      region.dispatchEvent(event);
      expect(event.defaultPrevented, JSON.stringify(init)).toBe(false);
      expect(region.scrollTop).toBe(180);
    }
    for (const tag of ["input", "textarea", "select", "button", "a", "summary", "div"]) {
      const control = document.createElement(tag);
      control.tabIndex = 0;
      if (tag === "div") control.contentEditable = "true";
      region.append(control);
      control.focus();
      for (const key of ["Home", "End"]) {
        const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
        control.dispatchEvent(event);
        expect(event.defaultPrevented, `${tag} ${key}`).toBe(false);
        expect(region.scrollTop).toBe(180);
        expect(document.activeElement).toBe(control);
      }
      control.remove();
    }
  });

  it("retains Escape dismissal from the focused evidence without an approval", async () => {
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
    const region = document.querySelector<HTMLElement>('[aria-label="Approval action details"]')!;
    region.focus();
    await act(async () => {
      region.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(onApprove).not.toHaveBeenCalled();
  });

  it("keeps long action metadata complete in its named keyboard scroller without dispatch on Cancel", async () => {
    const target = `folder/${"a".repeat(250)}`;
    const onApprove = vi.fn();
    await act(async () =>
      root.render(
        <RiskApprovalAction
          approval={{ ...approval("danger"), reason: target }}
          reviewedApproval={{ ...reviewedApproval, preview: { targets: [target], selector: target } }}
          pending={false}
          onApprove={onApprove}
        />,
      ),
    );
    await act(async () => container.querySelector("button")?.click());
    const region = document.querySelector<HTMLElement>('[role="region"][aria-label="Approval action details"]')!;
    expect(region.classList.contains("wrap-anywhere")).toBe(true);
    expect(region.classList.contains("max-w-full")).toBe(true);
    expect(region.textContent).toContain(target);
    expect(region.textContent).toContain(`Selector: ${target}`);
    expect(region.tabIndex).toBe(0);
    region.focus();
    expect(document.activeElement).toBe(region);
    await act(async () => dialogButton("Cancel").click());
    expect(onApprove).not.toHaveBeenCalled();
  });
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
    expect(document.body.textContent).toContain("Confirm danger-level action");
    expect(document.body.textContent).toContain("Action: Write file");
    expect(document.body.textContent).not.toContain("write_file");
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

  // R91 (BP1): a danger Change Plan's approval is its own plan text, bound to the plan by its id and the hash of the
  // plan's request (intentHash). R97: the fixtures use the payload a real approval carries, which has no action snapshot hash.
  describe("a danger Change Plan", () => {
    const realPlanPayload = {
      planId: "064ca5c1-eb4a-42e9-ae98-88ef5b9a367c",
      kind: "connector_install",
      scope: "capability",
      intentHash: "02b5bc0b0b2f9c55a65ec4328f8ba346706eb6273d0d8a227f121b35576d4e20",
      targetOwnerId: "capability_connector_install",
      targetResourceId: "mcp_template:aws-knowledge",
      adapterId: "connector-install",
      adapterVersion: 1,
      evidenceRefs: ["mcp_template:aws-knowledge"],
      rollbackRefs: [],
      rollbackNote: "Remove it again from Capabilities.",
    };
    const planApproval = (payload: Record<string, unknown>): ApprovalRequest => ({
      approvalId: "approval-1",
      kind: "change_plan_effect",
      riskLevel: "danger",
      status: "pending",
      payload,
      preview: {
        title: "Install AWS Knowledge",
        summary: "Allow knowledge-mcp.global.api.aws. Save AWS Knowledge, switched off, set to Reading is free.",
        impact: "Any tool can reach an allowed host, not only this connector.",
        risk: "danger",
      },
      linkage: { workspaceId: "default", actionType: "change_plan_effect" },
      createdAt: "2026-10-27T00:00:00Z",
      explanationStatus: "not_requested",
    });
    const pendingPlan = { ...approval("danger"), kind: "change_plan_effect", toolName: undefined };
    const approveOnce = () =>
      [...document.body.querySelectorAll("button")].find((button) => button.textContent === "Approve once")!;

    it("enables Approve once in the review for a real plan approval, showing what it changes", async () => {
      const onApprove = vi.fn();
      await act(async () =>
        root.render(
          <RiskApprovalAction
            approval={pendingPlan}
            reviewedApproval={planApproval(realPlanPayload)}
            pending={false}
            onApprove={onApprove}
          />,
        ),
      );
      await act(async () => container.querySelector("button")?.click());

      expect(document.body.textContent).toContain("Change: Install AWS Knowledge");
      expect(document.body.textContent).toContain("What it does: Allow knowledge-mcp.global.api.aws.");
      expect(document.body.textContent).toContain(
        "Approving lets this one change apply once, exactly as planned. Some changes then wait for you to continue them.",
      );
      expect(document.body.textContent).not.toContain("current action preview is unavailable");
      expect(approveOnce().disabled).toBe(false);
      await act(async () => approveOnce().click());
      expect(onApprove).toHaveBeenCalledTimes(1);
    });

    it("still refuses a plan approval that doesn't carry the hash of its plan's request", async () => {
      const onApprove = vi.fn();
      await act(async () =>
        root.render(
          <RiskApprovalAction
            approval={pendingPlan}
            reviewedApproval={planApproval({ ...realPlanPayload, intentHash: undefined })}
            pending={false}
            onApprove={onApprove}
          />,
        ),
      );
      await act(async () => container.querySelector("button")?.click());

      expect(document.body.textContent).toContain("current action preview is unavailable");
      expect(approveOnce().disabled).toBe(true);
      expect(onApprove).not.toHaveBeenCalled();
    });
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
    expect(document.body.textContent).toContain(command);
    expect(document.body.textContent).toContain(command);
    expect(document.body.querySelector("details[open]")).toBeNull();
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
    expect(document.body.textContent).toContain("Confirm nuclear-level action");
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

  it("accepts the confirmation word in any case with surrounding spaces", async () => {
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
    await act(async () => container.querySelector("button")?.click());
    await typeConfirmation("  APPROVE ");
    expect(dialogButton("Approve once").disabled).toBe(false);
  });

  it("labels the review with its risk and a shield icon, in the danger style", async () => {
    await act(async () =>
      root.render(
        <RiskApprovalAction
          approval={approval("danger")}
          reviewedApproval={reviewedApproval}
          pending={false}
          onApprove={vi.fn()}
        />,
      ),
    );
    const review = container.querySelector("button")!;
    expect(review.textContent).toBe("Review danger approval");
    expect(review.className).toContain("text-status-failed");
    expect(review.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("tells assistive technology why approval waits for the confirmation word", async () => {
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
    await act(async () => container.querySelector("button")?.click());
    const input = document.body.querySelector<HTMLInputElement>('[role="dialog"] input')!;
    const hint = document.getElementById(input.getAttribute("aria-describedby") ?? "");
    expect(hint?.textContent).toBe("Approve once stays unavailable until the text matches.");
    expect(document.body.querySelector('[role="dialog"] label code')?.textContent).toBe("approve");
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
    expect(review.textContent).toBe("Review nuclear approval");
    await act(async () => review.click());
    expect(onApprove).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Confirm critical-level action");
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
    expect(container.textContent).toContain(
      "Risk is unavailable, so Approve once is off. Check the approval summary above, or use Deny.",
    );
    expect(onApprove).not.toHaveBeenCalled();
  });

  it("approves a reviewed-in-place danger approval in one click without a second review", async () => {
    const onApprove = vi.fn();
    await act(async () =>
      root.render(
        <RiskApprovalAction
          approval={approval("danger")}
          reviewedApproval={reviewedApproval}
          reviewedInPlace
          pending={false}
          onApprove={onApprove}
        />,
      ),
    );
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => dialogButton("Approve once").click());
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it("keeps the typed confirmation for a nuclear approval even when reviewed in place", async () => {
    const onApprove = vi.fn();
    await act(async () =>
      root.render(
        <RiskApprovalAction
          approval={approval("nuclear")}
          reviewedApproval={{ ...reviewedApproval, riskLevel: "nuclear" }}
          reviewedInPlace
          pending={false}
          onApprove={onApprove}
        />,
      ),
    );
    expect(dialogButton("Approve once")).toBeUndefined();
    await act(async () => dialogButton("Review nuclear approval").click());
    expect(dialogButton("Approve once").disabled).toBe(true);
    expect(onApprove).not.toHaveBeenCalled();
  });

  it("keeps the review dialog for a danger approval without an action preview", async () => {
    const onApprove = vi.fn();
    await act(async () =>
      root.render(
        <RiskApprovalAction
          approval={approval("danger")}
          reviewedApproval={{ ...reviewedApproval, preview: {} }}
          reviewedInPlace
          pending={false}
          onApprove={onApprove}
        />,
      ),
    );
    expect(dialogButton("Approve once")).toBeUndefined();
    expect(dialogButton("Review danger approval")).toBeDefined();
  });

  it("names the review trigger, the confirm button and the consequence when a caller gives them", async () => {
    const onApprove = vi.fn();
    await act(async () =>
      root.render(
        <RiskApprovalAction
          approval={approval("danger")}
          reviewedApproval={reviewedApproval}
          pending={false}
          onApprove={onApprove}
          reviewLabel="Review and open folder"
          confirmLabel="Approve and open folder"
          consequence={<p>Approving also opens a folder.</p>}
        />,
      ),
    );
    expect(dialogButton("Review danger approval")).toBeUndefined();
    expect(document.body.textContent).not.toContain("Approving also opens a folder.");
    await act(async () => dialogButton("Review and open folder").click());
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
    const details = dialog.querySelector('[aria-label="Approval action details"]')!;
    const consequence = [...dialog.querySelectorAll("p")].find(
      (item) => item.textContent === "Approving also opens a folder.",
    )!;
    // The consequence comes before the action details.
    expect(consequence.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(dialogButton("Approve once")).toBeUndefined();
    await act(async () => dialogButton("Approve and open folder").click());
    expect(onApprove).toHaveBeenCalledOnce();
  });

  it("keeps the nuclear review label when a caller names the review trigger", async () => {
    await act(async () =>
      root.render(
        <RiskApprovalAction
          approval={approval("nuclear")}
          reviewedApproval={{ ...reviewedApproval, riskLevel: "nuclear" }}
          pending={false}
          onApprove={vi.fn()}
          reviewLabel="Review and open folder"
          confirmLabel="Approve and open folder"
        />,
      ),
    );
    expect(dialogButton("Review and open folder")).toBeUndefined();
    await act(async () => dialogButton("Review nuclear approval").click());
    expect(dialogButton("Approve and open folder").disabled).toBe(true);
  });

  it("keeps the default labels when no names are given", async () => {
    await act(async () =>
      root.render(
        <RiskApprovalAction
          approval={approval("danger")}
          reviewedApproval={reviewedApproval}
          pending={false}
          onApprove={vi.fn()}
        />,
      ),
    );
    await act(async () => dialogButton("Review danger approval").click());
    expect(dialogButton("Approve once")).toBeDefined();
    expect(dialogButton("Approve and open folder")).toBeUndefined();
  });

  it("names the confirm action in the review's description, missing-preview alert and typed confirmation", async () => {
    await act(async () =>
      root.render(
        <RiskApprovalAction
          approval={approval("danger")}
          reviewedApproval={{ ...reviewedApproval, preview: {} }}
          pending={false}
          onApprove={vi.fn()}
          confirmLabel="Approve and open folder"
        />,
      ),
    );
    await act(async () => dialogButton("Review danger approval").click());
    const dialog = () => document.body.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog().textContent).toContain("Review the exact action before you choose Approve and open folder.");
    expect(dialog().textContent).not.toContain("approving once");
    expect(dialog().querySelector('[role="alert"]')!.textContent).toBe(
      "The current action preview is unavailable, so Approve and open folder is off. Cancel, then use Deny or wait for the preview.",
    );
    await act(async () =>
      root.render(
        <RiskApprovalAction
          approval={approval("nuclear")}
          reviewedApproval={{ ...reviewedApproval, riskLevel: "nuclear" }}
          pending={false}
          onApprove={vi.fn()}
          confirmLabel="Approve and open folder"
        />,
      ),
    );
    await act(async () => dialogButton("Review nuclear approval").click());
    expect(dialog().textContent).toContain("Approve and open folder stays unavailable until the text matches.");
    expect(dialog().textContent).not.toContain("Approve once");
  });

  it("keeps the default review copy when no confirm action is named", async () => {
    await act(async () =>
      root.render(
        <RiskApprovalAction
          approval={approval("danger")}
          reviewedApproval={{ ...reviewedApproval, preview: {} }}
          pending={false}
          onApprove={vi.fn()}
        />,
      ),
    );
    await act(async () => dialogButton("Review danger approval").click());
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Review the exact action before approving once.");
    expect(dialog.querySelector('[role="alert"]')!.textContent).toBe(
      "The current action preview is unavailable, so Approve once is off. Cancel, then use Deny or wait for the preview.",
    );
  });

  it("renders a one-click approve as a secondary button with a loading label when asked", async () => {
    await act(async () =>
      root.render(
        <RiskApprovalAction
          approval={approval("caution")}
          pending
          onApprove={vi.fn()}
          approveLabel="Approve and open folder"
          approveVariant="secondary"
          loading
          loadingLabel="Approving…"
        />,
      ),
    );
    const busy = dialogButton("Approving…");
    expect(busy.getAttribute("aria-busy")).toBe("true");
    expect(busy.className).toContain("bg-raised");
    expect(busy.className).not.toContain("bg-accent");
  });

  it("keeps the one-click approve primary and idle by default", async () => {
    await act(async () =>
      root.render(<RiskApprovalAction approval={approval("caution")} pending={false} onApprove={vi.fn()} />),
    );
    const approve = dialogButton("Approve once");
    expect(approve.className).toContain("bg-accent");
    expect(approve.hasAttribute("aria-busy")).toBe(false);
  });
});
