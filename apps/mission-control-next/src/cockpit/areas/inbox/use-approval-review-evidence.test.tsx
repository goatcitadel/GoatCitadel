// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ApprovalRequest } from "@goatcitadel/contracts";
import { expect, it, vi } from "vitest";
import { useApprovalReviewEvidence } from "./use-approval-review-evidence";

const load = vi.hoisted(() => {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { started: vi.fn(), release, wait };
});

vi.mock("@goatcitadel/mission-control-shared/content/approval-purpose-evidence", async (importOriginal) => {
  load.started();
  await load.wait;
  return importOriginal();
});

const generic: ApprovalRequest = {
  approvalId: "shell-approval",
  kind: "shell.exec",
  riskLevel: "danger",
  status: "pending",
  payload: {},
  preview: { command: "pnpm test" },
  createdAt: "2026-11-01T00:00:00Z",
  explanationStatus: "pending",
};

it("keeps generic evidence synchronous and withholds an invalid specialized preview while its parser loads", async () => {
  const specialized: ApprovalRequest = {
    ...generic,
    approvalId: "snapshot-approval",
    kind: "external_source.knowledge_snapshot",
    // A generic preview is never authority for an invalid external-source request.
    preview: { command: "pnpm test" },
  };
  const root = createRoot(document.createElement("div"));
  let current!: ReturnType<typeof useApprovalReviewEvidence>;
  function Review({ approval }: { approval: ApprovalRequest }) {
    current = useApprovalReviewEvidence(approval);
    return null;
  }
  const render = (approval: ApprovalRequest) => act(() => root.render(<Review approval={approval} />));
  try {
    render(generic);
    expect(current.evidence?.commands).toEqual(["Command: pnpm test"]);
    expect(load.started).not.toHaveBeenCalled();

    render(specialized);
    expect(current).toEqual({ evidence: null, loading: true, unavailable: false });
    await vi.waitFor(() => expect(load.started).toHaveBeenCalledOnce());

    render(generic);
    await act(async () => load.release());
    expect(current.evidence?.commands).toEqual(["Command: pnpm test"]);
    render(specialized);
    await vi.waitFor(() => expect(current).toEqual({ evidence: null, loading: false, unavailable: false }));
  } finally {
    load.release();
    act(() => root.unmount());
  }
});
