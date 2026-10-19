// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalRequest } from "@goatcitadel/contracts";
import { __resetInboxApprovalAttemptsForTests } from "../inbox/inbox-approval-attempts";
import { OutsideRootWriteGrantOptions } from "./OutsideRootWriteGrantOptions";

const api = vi.hoisted(() => ({ approveChatTool: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({ approveChatTool: api.approveChatTool }));

const ROOT_A = "owr_0123456789abcdef";
const ROOT_B = "owr_fedcba9876543210";

function approvalWith(preview: Record<string, unknown>, status: ApprovalRequest["status"] = "pending") {
  return {
    approvalId: "approval-1",
    kind: "fs.write",
    riskLevel: "danger",
    status,
    payload: {},
    preview,
    linkage: { sessionId: "session-1", toolName: "fs.write" },
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

let container: HTMLDivElement, root: Root, client: QueryClient;
const text = () => container.textContent ?? "";
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((item) => item.textContent?.trim() === label)!;
async function click(element: HTMLElement) {
  await act(async () => {
    element.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
async function render(approval: ApprovalRequest, onResolved = vi.fn()) {
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
  vi.resetAllMocks();
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
    const onResolved = await render(approvalWith(OUTSIDE_ROOT_PREVIEW));
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
    const onResolved = await render(approvalWith(OUTSIDE_ROOT_PREVIEW));
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
    const onResolved = await render(approvalWith(OUTSIDE_ROOT_PREVIEW));
    await click(button("Approve and open folder"));
    await vi.waitFor(() =>
      expect(onResolved).toHaveBeenCalledWith(
        "This approval was already decided elsewhere, so nothing was opened. Check the recorded decision below.",
      ),
    );
  });

  it("keeps the decision locked and shows the error when the outcome is uncertain", async () => {
    api.approveChatTool.mockRejectedValue(new Error("network down"));
    const onResolved = await render(approvalWith(OUTSIDE_ROOT_PREVIEW));
    await click(button("Approve and open folder"));
    await vi.waitFor(() => expect(text()).toContain("network down"));
    expect(onResolved).not.toHaveBeenCalled();
    expect(button("Approve and open folder").disabled).toBe(true);
  });
});
