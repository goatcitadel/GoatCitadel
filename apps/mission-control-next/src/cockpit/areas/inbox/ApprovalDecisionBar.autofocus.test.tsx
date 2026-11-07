// @vitest-environment happy-dom
import type { ApprovalRequest } from "@goatcitadel/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ApprovalDecisionBar } from "./ApprovalDecisionBar";
import { refuseNetwork } from "../../../test/refuse-network";

const preview = vi.hoisted(() => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { started: vi.fn(), release, held };
});
vi.mock("@goatcitadel/mission-control-shared/content/approval-purpose-evidence", async () => {
  preview.started();
  await preview.held;
  return {
    buildApprovalRequestReviewEvidenceModel: () => ({
      targets: ["Existing provider settings"],
      commands: [],
      changes: [],
      supporting: [],
    }),
  };
});
vi.mock("@goatcitadel/mission-control-shared/api/workspaces", () => ({
  fetchWorkspaces: vi.fn(async () => ({ items: [] })),
}));
refuseNetwork();

it("keeps the new focus when a requested Approve control finishes loading", async () => {
  const approval: ApprovalRequest = {
    approvalId: "held-preview",
    kind: "change_plan_effect",
    riskLevel: "danger",
    status: "pending",
    payload: {},
    preview: {},
    createdAt: "2026-11-01T00:00:00Z",
    explanationStatus: "pending",
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const render = (focusAction?: "approve") =>
    act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <button id="approval-origin" type="button">Open approval review</button>
          <button id="next-control" type="button">Next item</button>
          {focusAction ? (
            <ApprovalDecisionBar
              approval={approval}
              workspaceId="default"
              focusAction={focusAction}
              reviewedInPlace
              onResolved={vi.fn()}
              onInvalidated={vi.fn()}
            />
          ) : null}
        </QueryClientProvider>,
      );
    });
  const approve = () =>
    [...host.querySelectorAll("button")].find((button) => button.textContent === "Approve once");
  try {
    await render();
    const origin = host.querySelector<HTMLButtonElement>("#approval-origin")!;
    const next = host.querySelector<HTMLButtonElement>("#next-control")!;
    origin.focus();
    await render("approve");
    await vi.waitFor(() => expect(preview.started).toHaveBeenCalledOnce());
    expect(approve()).toBeUndefined();
    next.focus();
    await act(async () => preview.release());
    await vi.waitFor(() => expect(approve()).toBeDefined());
    expect(document.activeElement).toBe(next);

    await render();
    origin.focus();
    await render("approve");
    expect(document.activeElement).toBe(approve());
  } finally {
    preview.release();
    await act(async () => root.unmount());
    client.clear();
    host.remove();
  }
});
