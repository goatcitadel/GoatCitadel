// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalRequest } from "@goatcitadel/contracts";
import { __resetInboxApprovalAttemptsForTests } from "../inbox/inbox-approval-attempts";
import { __resetMinuteClockForTests } from "../inbox/use-minute-clock";
import { OutsideRootWriteGrantOptions } from "./OutsideRootWriteGrantOptions";
import { refuseNetwork } from "../../../test/refuse-network";

const api = vi.hoisted(() => ({ approveChatTool: vi.fn(), fetchApproval: vi.fn() }));
// The decision bar locks when the active workspace is not the approval's; the grant follows the same preference.
const preferences = vi.hoisted(() => ({ activeWorkspaceId: "workspace-1" as string | undefined }));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({ useUiPreferences: () => preferences }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({ approveChatTool: api.approveChatTool }));
// Every approve re-reads the current record first, as the decision bar does.
vi.mock("@goatcitadel/mission-control-shared/api/approvals", () => ({ fetchApproval: api.fetchApproval }));
// The danger review summary names workspaces from the workspace list.
vi.mock("@goatcitadel/mission-control-shared/api/workspaces", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@goatcitadel/mission-control-shared/api/workspaces")>()),
  fetchWorkspaces: vi.fn(async () => ({ items: [] })),
}));
refuseNetwork();

const ROOT_A = "owr_0123456789abcdef";
const ROOT_B = "owr_fedcba9876543210";

function approvalWith(
  preview: Record<string, unknown>,
  status: ApprovalRequest["status"] = "pending",
  overrides: Partial<Record<"riskLevel" | "kind" | "expiresAt", string | undefined>> & {
    linkage?: Record<string, string>;
  } = {},
) {
  return {
    approvalId: "approval-1",
    kind: "fs.write",
    riskLevel: "danger",
    status,
    payload: {},
    preview,
    linkage: { sessionId: "session-1", toolName: "fs.write" },
    ...overrides,
    createdAt: "2026-10-19T00:00:00.000Z",
  } as unknown as ApprovalRequest;
}

const OUTSIDE_ROOT_PREVIEW = {
  outsideRootWrite: {
    kind: "outside_root_write",
    targets: ["C:/Scratch/report/out.txt"],
    candidates: [
      { rootId: ROOT_A, path: "C:/Scratch/report" },
      { rootId: ROOT_B, path: "C:/Scratch" },
    ],
    durations: ["15m", "1h", "8h"],
    defaultDuration: "1h",
  },
};

const CHANGED_RECORD =
  "This approval changed or is no longer in the current pending queue. Refresh it before deciding.";

let container: HTMLDivElement, root: Root, client: QueryClient;
const text = () => container.textContent ?? "";
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((item) => item.textContent?.trim() === label)!;
// The review dialog renders in a portal, outside the container.
const dialog = () => document.body.querySelector<HTMLElement>('[role="dialog"]');
const dialogButton = (label: string) =>
  [...(dialog()?.querySelectorAll("button") ?? [])].find((item) => item.textContent?.trim() === label);
async function typeConfirmation(value: string) {
  const input = dialog()!.querySelector<HTMLInputElement>("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function click(element: HTMLElement) {
  await act(async () => {
    element.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
async function render(approval: ApprovalRequest, onResolved = vi.fn()) {
  // The re-read finds the record unchanged unless a test says otherwise.
  if (!api.fetchApproval.getMockImplementation()) api.fetchApproval.mockResolvedValue(approval);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <OutsideRootWriteGrantOptions
          approval={approval}
          workspaceId="workspace-1"
          sessionId="session-1"
          onResolved={onResolved}
        />
      </QueryClientProvider>,
    ),
  );
  return onResolved;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
  __resetInboxApprovalAttemptsForTests();
  __resetMinuteClockForTests();
  vi.useRealTimers();
  vi.resetAllMocks();
  preferences.activeWorkspaceId = "workspace-1";
});

describe("OutsideRootWriteGrantOptions", () => {
  it("renders nothing for approvals that are not outside-root writes or are already decided", async () => {
    await render(approvalWith({}));
    expect(container.innerHTML).toBe("");
    await render(approvalWith(OUTSIDE_ROOT_PREVIEW, "approved"));
    expect(container.innerHTML).toBe("");
  });

  it("offers the server's folders and opens the chosen one for the chosen time and place", async () => {
    api.approveChatTool.mockResolvedValue({ ok: true, approvalId: "approval-1", grant: { grantId: "grant-1" } });
    const onResolved = await render(approvalWith(OUTSIDE_ROOT_PREVIEW, "pending", { riskLevel: "caution" }));
    expect(text()).toContain("C:/Scratch/report");
    expect(text()).toContain("Other tools, deletes, protected runtime folders and network shares stay blocked");
    const select = container.querySelector("select")!;
    expect(select.value).toBe("1h");
    await act(async () => {
      container.querySelector<HTMLInputElement>(`input[value="${ROOT_B}"]`)!.click();
      container.querySelector<HTMLInputElement>('input[value="workspace"]')!.click();
      select.value = "8h";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await click(button("Approve and open folder"));
    await vi.waitFor(() =>
      expect(api.approveChatTool).toHaveBeenCalledWith("session-1", "approval-1", {
        allowScope: "workspace",
        writeGrant: { rootId: ROOT_B, duration: "8h" },
      }),
    );
    await vi.waitFor(() =>
      expect(onResolved).toHaveBeenCalledWith(
        "Approved. C:/Scratch is open to fs.write in this workspace for 8 hours.",
      ),
    );
  });

  it("says the write was approved once when the folder could not be opened", async () => {
    api.approveChatTool.mockResolvedValue({
      ok: true,
      approvalId: "approval-1",
      grantError: "Approval is too old to open a folder.",
    });
    const onResolved = await render(approvalWith(OUTSIDE_ROOT_PREVIEW, "pending", { riskLevel: "caution" }));
    await click(button("Approve and open folder"));
    await vi.waitFor(() =>
      expect(onResolved).toHaveBeenCalledWith(
        "Approved this write once. The folder was not opened: Approval is too old to open a folder.",
      ),
    );
    expect(api.approveChatTool).toHaveBeenCalledWith("session-1", "approval-1", {
      allowScope: "session",
      writeGrant: { rootId: ROOT_A, duration: "1h" },
    });
  });

  it("does not claim an approval when the request was already decided elsewhere", async () => {
    api.approveChatTool.mockResolvedValue({ ok: true, approvalId: "approval-1", resumed: false });
    const onResolved = await render(approvalWith(OUTSIDE_ROOT_PREVIEW, "pending", { riskLevel: "caution" }));
    await click(button("Approve and open folder"));
    await vi.waitFor(() =>
      expect(onResolved).toHaveBeenCalledWith(
        "This approval was already decided elsewhere, so nothing was opened. Check the recorded decision below.",
      ),
    );
  });

  it("keeps the decision locked and shows the error when the outcome is uncertain", async () => {
    api.approveChatTool.mockRejectedValue(new Error("network down"));
    const onResolved = await render(approvalWith(OUTSIDE_ROOT_PREVIEW, "pending", { riskLevel: "caution" }));
    await click(button("Approve and open folder"));
    await vi.waitFor(() => expect(text()).toContain("network down"));
    expect(onResolved).not.toHaveBeenCalled();
    expect(button("Approve and open folder").disabled).toBe(true);
  });

  it("opens the danger review before a danger approval opens a folder, naming what the approval opens", async () => {
    api.approveChatTool.mockResolvedValue({ ok: true, approvalId: "approval-1", grant: { grantId: "grant-1" } });
    const onResolved = await render(approvalWith(OUTSIDE_ROOT_PREVIEW));
    expect(button("Approve and open folder")).toBeUndefined();
    expect(button("Review danger approval")).toBeUndefined();
    await click(button("Review and open folder"));
    expect(api.approveChatTool).not.toHaveBeenCalled();
    expect(dialog()?.textContent).toContain("Confirm danger-level action");
    expect(dialog()?.textContent).toContain(
      "Approving also opens C:/Scratch/report to fs.write in this chat for 1 hour.",
    );
    expect(dialogButton("Approve once")).toBeUndefined();
    await click(dialogButton("Approve and open folder")!);
    await vi.waitFor(() =>
      expect(onResolved).toHaveBeenCalledWith(
        "Approved. C:/Scratch/report is open to fs.write in this chat for 1 hour.",
      ),
    );
    expect(api.approveChatTool).toHaveBeenCalledTimes(1);
    expect(api.approveChatTool).toHaveBeenCalledWith("session-1", "approval-1", {
      allowScope: "session",
      writeGrant: { rootId: ROOT_A, duration: "1h" },
    });
  });

  it("keeps a caution approval to one click", async () => {
    api.approveChatTool.mockResolvedValue({ ok: true, approvalId: "approval-1", grant: { grantId: "grant-1" } });
    await render(approvalWith(OUTSIDE_ROOT_PREVIEW, "pending", { riskLevel: "caution" }));
    await click(button("Approve and open folder"));
    expect(dialog()).toBeNull();
    await vi.waitFor(() => expect(api.approveChatTool).toHaveBeenCalledTimes(1));
  });

  it("needs the typed confirmation before a nuclear approval opens a folder", async () => {
    api.approveChatTool.mockResolvedValue({ ok: true, approvalId: "approval-1", grant: { grantId: "grant-1" } });
    await render(approvalWith(OUTSIDE_ROOT_PREVIEW, "pending", { riskLevel: "nuclear" }));
    await click(button("Review nuclear approval"));
    expect(dialogButton("Approve and open folder")!.disabled).toBe(true);
    await typeConfirmation("approv");
    expect(dialogButton("Approve and open folder")!.disabled).toBe(true);
    expect(api.approveChatTool).not.toHaveBeenCalled();
    await typeConfirmation("approve");
    expect(dialogButton("Approve and open folder")!.disabled).toBe(false);
    await click(dialogButton("Approve and open folder")!);
    await vi.waitFor(() => expect(api.approveChatTool).toHaveBeenCalledTimes(1));
  });

  it.each([
    ["caution", "Approve and open folder"],
    ["danger", "Review and open folder"],
  ])("cannot approve an expired %s approval", async (riskLevel, label) => {
    await render(approvalWith(OUTSIDE_ROOT_PREVIEW, "pending", { riskLevel, expiresAt: "2020-01-01T00:00:00.000Z" }));
    expect(button(label).disabled).toBe(true);
    await click(button(label));
    expect(dialog()).toBeNull();
    expect(api.approveChatTool).not.toHaveBeenCalled();
  });

  it("cannot approve when the approval has no risk level", async () => {
    await render(approvalWith(OUTSIDE_ROOT_PREVIEW, "pending", { riskLevel: undefined }));
    expect(button("Approve and open folder")).toBeUndefined();
    expect(button("Review and open folder")).toBeUndefined();
    // The decision bar above already says risk is unavailable; the folder section does not repeat it.
    expect(text()).not.toContain("Risk is unavailable");
    expect(api.approveChatTool).not.toHaveBeenCalled();
  });

  it.each(["caution", "danger"])(
    "offers no folder approve for a %s approval whose kind has no exact action preview",
    async (riskLevel) => {
      // A well-formed folder preview always lists its targets, which count as evidence; a kind with its own review
      // model (here a Change Plan request without its request summary) is the case with nothing exact to approve.
      // The decision bar then offers only Deny and says why, so the grant offers no approve at all.
      await render(approvalWith(OUTSIDE_ROOT_PREVIEW, "pending", { riskLevel, kind: "change.request" }));
      expect(button("Approve and open folder")).toBeUndefined();
      expect(button("Review and open folder")).toBeUndefined();
      expect(api.fetchApproval).not.toHaveBeenCalled();
      expect(api.approveChatTool).not.toHaveBeenCalled();
    },
  );

  it("closes the review and clears the typed word when the record changes while the review is open", async () => {
    api.approveChatTool.mockResolvedValue({ ok: true, approvalId: "approval-1", grant: { grantId: "grant-1" } });
    const reviewed = approvalWith(OUTSIDE_ROOT_PREVIEW, "pending", { riskLevel: "nuclear" });
    await render(reviewed);
    await click(button("Review nuclear approval"));
    await typeConfirmation("approve");
    expect(dialogButton("Approve and open folder")!.disabled).toBe(false);
    const changed = { ...reviewed, preview: { ...OUTSIDE_ROOT_PREVIEW, note: "changed" } } as ApprovalRequest;
    api.fetchApproval.mockResolvedValue(changed);
    await render(changed);
    // The changed record needs its own review: the open one closed and its typed word is gone.
    await vi.waitFor(() => expect(dialog()).toBeNull());
    await click(button("Review nuclear approval"));
    expect(dialog()!.querySelector<HTMLInputElement>("input")!.value).toBe("");
    expect(dialogButton("Approve and open folder")!.disabled).toBe(true);
    expect(api.approveChatTool).not.toHaveBeenCalled();
  });

  it("does not approve when the active workspace is not the approval's", async () => {
    preferences.activeWorkspaceId = "workspace-2";
    await render(approvalWith(OUTSIDE_ROOT_PREVIEW, "pending", { riskLevel: "caution" }));
    expect(button("Approve and open folder").disabled).toBe(true);
    await click(button("Approve and open folder"));
    expect(api.fetchApproval).not.toHaveBeenCalled();
    expect(api.approveChatTool).not.toHaveBeenCalled();
  });

  it("locks the approve control when the active workspace changes while the card stays mounted", async () => {
    const approval = approvalWith(OUTSIDE_ROOT_PREVIEW, "pending", { riskLevel: "caution" });
    await render(approval);
    expect(button("Approve and open folder").disabled).toBe(false);
    preferences.activeWorkspaceId = "workspace-2";
    await render(approval);
    expect(button("Approve and open folder").disabled).toBe(true);
    await click(button("Approve and open folder"));
    expect(api.approveChatTool).not.toHaveBeenCalled();
  });

  it.each([
    ["was decided elsewhere", { status: "approved" }],
    ["changed after review", { preview: { ...OUTSIDE_ROOT_PREVIEW, note: "changed" } }],
  ])("does not approve when the re-read record %s", async (_label, change) => {
    const approval = approvalWith(OUTSIDE_ROOT_PREVIEW, "pending", { riskLevel: "caution" });
    api.fetchApproval.mockResolvedValue({ ...approval, ...change });
    const onResolved = await render(approval);
    await click(button("Approve and open folder"));
    await vi.waitFor(() => expect(text()).toContain(CHANGED_RECORD));
    expect(api.fetchApproval).toHaveBeenCalledWith("approval-1", { workspaceId: "workspace-1" });
    expect(api.approveChatTool).not.toHaveBeenCalled();
    expect(onResolved).not.toHaveBeenCalled();
  });

  it("does not approve when the record is gone on the re-read", async () => {
    api.fetchApproval.mockResolvedValue(null);
    await render(approvalWith(OUTSIDE_ROOT_PREVIEW, "pending", { riskLevel: "caution" }));
    await click(button("Approve and open folder"));
    await vi.waitFor(() => expect(text()).toContain(CHANGED_RECORD));
    expect(api.approveChatTool).not.toHaveBeenCalled();
  });

  it("does not approve when the approval expires while the record is re-read", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-19T00:00:00.000Z"));
    const approval = approvalWith(OUTSIDE_ROOT_PREVIEW, "pending", {
      riskLevel: "caution",
      expiresAt: "2026-10-19T00:30:00.000Z",
    });
    api.fetchApproval.mockImplementation(async () => {
      vi.setSystemTime(new Date("2026-10-19T00:31:00.000Z"));
      return approval;
    });
    await render(approval);
    await click(button("Approve and open folder"));
    await vi.waitFor(() => expect(text()).toContain(CHANGED_RECORD));
    expect(api.approveChatTool).not.toHaveBeenCalled();
  });

  it("does not approve an approval from another chat", async () => {
    await render(
      approvalWith(OUTSIDE_ROOT_PREVIEW, "pending", {
        riskLevel: "caution",
        linkage: { sessionId: "session-2", toolName: "fs.write" },
      }),
    );
    await click(button("Approve and open folder"));
    expect(api.fetchApproval).not.toHaveBeenCalled();
    expect(api.approveChatTool).not.toHaveBeenCalled();
  });

  it("turns the approve control off once the approval expires, without another render", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date("2026-10-19T00:00:00.000Z"));
    await render(
      approvalWith(OUTSIDE_ROOT_PREVIEW, "pending", { riskLevel: "caution", expiresAt: "2026-10-19T00:00:05.000Z" }),
    );
    expect(button("Approve and open folder").disabled).toBe(false);
    await act(async () => {
      vi.advanceTimersByTime(6_000);
    });
    expect(button("Approve and open folder").disabled).toBe(true);
    expect(api.approveChatTool).not.toHaveBeenCalled();
  });

  it("stays a secondary button and says Approving… while the approval is recorded", async () => {
    api.approveChatTool.mockReturnValue(new Promise(() => {}));
    await render(approvalWith(OUTSIDE_ROOT_PREVIEW, "pending", { riskLevel: "caution" }));
    const approve = button("Approve and open folder");
    // The decision bar's Approve once is the primary action; also opening a folder is the secondary choice.
    expect(approve.className).not.toContain("bg-accent");
    expect(approve.className).toContain("bg-raised");
    await click(approve);
    await vi.waitFor(() => expect(api.approveChatTool).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(button("Approving…")?.getAttribute("aria-busy")).toBe("true"));
  });
});
