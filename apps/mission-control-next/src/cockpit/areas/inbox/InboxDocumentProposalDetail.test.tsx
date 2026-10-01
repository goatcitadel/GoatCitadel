// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DocumentPatchProposalRecord, OperatorInboxItem, OperatorInboxResponse } from "@goatcitadel/contracts";
import { UiPreferencesProvider } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InboxDocumentProposalDetail } from "./InboxDocumentProposalDetail";

const api = vi.hoisted(() => ({ fetchOperatorInbox: vi.fn(), listDocumentPatchProposals: vi.fn(),
  applyDocumentPatchProposal: vi.fn(), rejectDocumentPatchProposal: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/operator-inbox", () => ({ fetchOperatorInbox: api.fetchOperatorInbox }));
vi.mock("@goatcitadel/mission-control-shared/api/chat", () => ({
  listDocumentPatchProposals: api.listDocumentPatchProposals,
  applyDocumentPatchProposal: api.applyDocumentPatchProposal,
  rejectDocumentPatchProposal: api.rejectDocumentPatchProposal,
}));

const item: OperatorInboxItem = {
  id: "document_proposal:proposal-a", kind: "document_proposal", group: "proposals", title: "Review note edit",
  summary: "A proposed document patch is waiting for review. Open its diff before applying it.",
  createdAt: "2026-09-28T00:00:00Z", updatedAt: "2026-09-28T00:01:00Z",
  source: { workspaceId: "default", proposalId: "proposal-a", sessionId: "session-a", turnId: "turn-a" },
  href: "/chat?sessionId=session-a&shell=classic",
};
const proposal: DocumentPatchProposalRecord = {
  proposalId: "proposal-a", schemaVersion: "document-patch-proposal.v1", workspaceId: "default",
  sessionId: "session-a", turnId: "turn-a", targetKind: "personal_note", targetId: "note-a", baseRevision: 1,
  proposedContent: "After", derivedDiff: "--- current\n+++ proposed\n@@ full replacement @@\n-Before\n+After",
  authorKind: "assistant", authorId: "assistant-a", state: "pending",
  createdAt: item.createdAt, updatedAt: item.updatedAt!,
};
const projection: OperatorInboxResponse = {
  authority: "derived_projection", workspaceId: "default", generatedAt: "2026-09-28T00:01:00Z",
  items: [item], coverage: [{ source: "document_proposals", state: "current" }],
  counts: {
    needs_decision: { known: 0, complete: true }, proposals: { known: 1, complete: true },
    needs_attention: { known: 0, complete: false }, updates: { known: 0, complete: false },
  },
};

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  for (const mock of Object.values(api)) mock.mockReset();
  api.fetchOperatorInbox.mockResolvedValue(projection);
  api.listDocumentPatchProposals.mockResolvedValue({ items: [proposal] });
  api.applyDocumentPatchProposal.mockResolvedValue({ item: { ...proposal, state: "applied", appliedTargetId: "note-a",
    appliedRevision: 2, appliedContentHash: "hash-a" } });
  api.rejectDocumentPatchProposal.mockResolvedValue({ item: { ...proposal, state: "rejected" } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => { act(() => root.unmount()); container.remove(); });

async function renderDetail(inboxItem = item) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(<QueryClientProvider client={client}><UiPreferencesProvider>
    <InboxDocumentProposalDetail item={inboxItem} workspaceId="default" />
  </UiPreferencesProvider></QueryClientProvider>));
  await act(async () => {
    await api.fetchOperatorInbox.mock.results[0]?.value;
    if (api.listDocumentPatchProposals.mock.results[0]) await api.listDocumentPatchProposals.mock.results[0].value;
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function button(label: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll("button")].find((entry) => entry.textContent === label);
  if (!found) throw new Error(`Missing ${label} button: ${document.body.textContent}`);
  return found;
}

describe("Inbox document proposal", () => {
  it("shows the derived diff, re-reads both owners, and applies only after confirmation", async () => {
    await renderDetail();
    expect(container.textContent).toContain("-Before");
    expect(container.textContent).toContain("+After");
    await act(async () => button("Review apply").click());
    expect(api.applyDocumentPatchProposal).not.toHaveBeenCalled();
    await act(async () => button("Confirm apply").click());
    expect(api.fetchOperatorInbox).toHaveBeenCalledTimes(2);
    expect(api.listDocumentPatchProposals).toHaveBeenCalledTimes(2);
    expect(api.applyDocumentPatchProposal).toHaveBeenCalledWith("proposal-a", "default");
    expect(container.textContent).toContain("Gateway recorded this document proposal as applied");
  });

  it("rejects the same exact reviewed proposal through its owner", async () => {
    await renderDetail();
    await act(async () => button("Review rejection").click());
    await act(async () => button("Confirm rejection").click());
    expect(api.rejectDocumentPatchProposal).toHaveBeenCalledWith("proposal-a", "default");
    expect(api.applyDocumentPatchProposal).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Gateway recorded this document proposal as rejected");
  });

  it("refuses a changed diff after review", async () => {
    api.listDocumentPatchProposals.mockResolvedValueOnce({ items: [proposal] })
      .mockResolvedValueOnce({ items: [{ ...proposal, proposedContent: "Different", derivedDiff: "-Before\n+Different" }] });
    await renderDetail();
    await act(async () => button("Review apply").click());
    await act(async () => button("Confirm apply").click());
    expect(api.applyDocumentPatchProposal).not.toHaveBeenCalled();
    expect(container.textContent).toContain("proposal changed or left the pending queue");
  });

  it("never reads a proposal when the Inbox projection is foreign", async () => {
    api.fetchOperatorInbox.mockResolvedValue({ ...projection, workspaceId: "other" });
    await renderDetail();
    expect(api.listDocumentPatchProposals).not.toHaveBeenCalled();
    expect(container.textContent).toContain("not found in the current bounded pending list");
  });

  it("refuses a foreign owner record", async () => {
    api.listDocumentPatchProposals.mockResolvedValue({ items: [{ ...proposal, workspaceId: "other" }] });
    await renderDetail();
    expect(container.textContent).not.toContain("Review apply");
    expect(api.applyDocumentPatchProposal).not.toHaveBeenCalled();
  });

  it("keeps an oversized diff read-only in the bounded Inbox inspector", async () => {
    api.listDocumentPatchProposals.mockResolvedValue({ items: [{ ...proposal, derivedDiff: `-${"x".repeat(64_001)}` }] });
    await renderDetail();
    expect(container.textContent).toContain("too large for bounded Inbox review");
    expect(container.textContent).not.toContain("Review apply");
    expect(container.querySelector("pre")?.textContent?.length).toBeLessThanOrEqual(4_000);
  });

  it("locks another decision after an uncertain owner response", async () => {
    api.applyDocumentPatchProposal.mockRejectedValue(new Error("Connection lost"));
    await renderDetail();
    await act(async () => button("Review apply").click());
    await act(async () => button("Confirm apply").click());
    expect(api.applyDocumentPatchProposal).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Document decision outcome is uncertain");
    expect(container.textContent).not.toContain("Review apply");
  });
});
