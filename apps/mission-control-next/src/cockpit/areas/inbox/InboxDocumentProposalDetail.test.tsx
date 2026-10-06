// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DocumentPatchProposalRecord, OperatorInboxItem, OperatorInboxResponse } from "@goatcitadel/contracts";
import { UiPreferencesProvider } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InboxDocumentProposalDetail } from "./InboxDocumentProposalDetail";
import { queryKeys } from "../../data/query-keys";

const api = vi.hoisted(() => ({
  fetchOperatorInbox: vi.fn(),
  listDocumentPatchProposals: vi.fn(),
  fetchDocumentPatchProposal: vi.fn(),
  applyDocumentPatchProposal: vi.fn(),
  rejectDocumentPatchProposal: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/operator-inbox", () => ({
  fetchOperatorInbox: api.fetchOperatorInbox,
}));
vi.mock("@goatcitadel/mission-control-shared/api/chat", () => ({
  listDocumentPatchProposals: api.listDocumentPatchProposals,
  fetchDocumentPatchProposal: api.fetchDocumentPatchProposal,
  applyDocumentPatchProposal: api.applyDocumentPatchProposal,
  rejectDocumentPatchProposal: api.rejectDocumentPatchProposal,
}));

const item: OperatorInboxItem = {
  id: "document_proposal:proposal-a",
  kind: "document_proposal",
  group: "proposals",
  title: "Review note edit",
  summary: "A proposed document patch is waiting for review. Open its diff before applying it.",
  createdAt: "2026-09-28T00:00:00Z",
  updatedAt: "2026-09-28T00:01:00Z",
  source: { workspaceId: "default", proposalId: "proposal-a", sessionId: "session-a", turnId: "turn-a" },
  href: "/chat?sessionId=session-a&shell=classic",
};
const proposal: DocumentPatchProposalRecord = {
  proposalId: "proposal-a",
  schemaVersion: "document-patch-proposal.v1",
  workspaceId: "default",
  sessionId: "session-a",
  turnId: "turn-a",
  targetKind: "personal_note",
  targetId: "note-a",
  baseRevision: 1,
  proposedContent: "After",
  derivedDiff: "--- current\n+++ proposed\n@@ full replacement @@\n-Before\n+After",
  authorKind: "assistant",
  authorId: "assistant-a",
  state: "pending",
  createdAt: item.createdAt,
  updatedAt: item.updatedAt!,
};
const projection: OperatorInboxResponse = {
  authority: "derived_projection",
  workspaceId: "default",
  generatedAt: "2026-09-28T00:01:00Z",
  items: [item],
  coverage: [{ source: "document_proposals", state: "current" }],
  counts: {
    needs_decision: { known: 0, complete: true },
    proposals: { known: 1, complete: true },
    needs_attention: { known: 0, complete: false },
    updates: { known: 0, complete: false },
  },
};

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  for (const mock of Object.values(api)) mock.mockReset();
  api.fetchOperatorInbox.mockResolvedValue(projection);
  api.fetchDocumentPatchProposal.mockResolvedValue({ item: proposal });
  api.applyDocumentPatchProposal.mockResolvedValue({
    item: {
      ...proposal,
      state: "applied",
      appliedTargetId: "note-a",
      appliedRevision: 2,
      appliedContentHash: "hash-a",
    },
  });
  api.rejectDocumentPatchProposal.mockResolvedValue({ item: { ...proposal, state: "rejected" } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** The Inbox area keeps the Inbox cached; the detail reads that copy instead of fetching it again. */
async function renderDetail(inboxItem = item, cachedInbox: OperatorInboxResponse = projection) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queryKeys.inbox("default"), cachedInbox);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <UiPreferencesProvider>
          <InboxDocumentProposalDetail item={inboxItem} workspaceId="default" />
        </UiPreferencesProvider>
      </QueryClientProvider>,
    ),
  );
  await act(async () => {
    if (api.fetchDocumentPatchProposal.mock.results[0]) await api.fetchDocumentPatchProposal.mock.results[0].value;
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return client;
}

/** Make the next proposal read hang, invalidate, and let the refetch status reach React. */
async function startRecheck(client: QueryClient) {
  let release!: () => void;
  api.fetchDocumentPatchProposal.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = () => resolve({ item: proposal });
      }),
  );
  await act(async () => {
    void client.invalidateQueries({ queryKey: ["chat", "document-proposal"] });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return async () => {
    await act(async () => release());
    await vi.waitFor(() => expect(container.textContent).not.toContain("Checking for changes…"));
  };
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
    // Opening reads the proposal by id and checks the cached Inbox: no Inbox or list read.
    expect(api.fetchOperatorInbox).not.toHaveBeenCalled();
    expect(api.listDocumentPatchProposals).not.toHaveBeenCalled();
    expect(api.fetchDocumentPatchProposal).toHaveBeenCalledExactlyOnceWith("proposal-a", {
      workspaceId: "default",
      signal: expect.any(AbortSignal),
    });
    await act(async () => button("Review apply").click());
    expect(api.applyDocumentPatchProposal).not.toHaveBeenCalled();
    await act(async () => button("Confirm apply").click());
    // The decision re-reads the Inbox once and the proposal again, then the decided record is reset and read.
    expect(api.fetchOperatorInbox).toHaveBeenCalledTimes(1);
    expect(api.fetchDocumentPatchProposal).toHaveBeenCalledTimes(3);
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
    api.fetchDocumentPatchProposal.mockResolvedValueOnce({ item: proposal }).mockResolvedValueOnce({
      item: { ...proposal, proposedContent: "Different", derivedDiff: "-Before\n+Different" },
    });
    await renderDetail();
    await act(async () => button("Review apply").click());
    await act(async () => button("Confirm apply").click());
    expect(api.applyDocumentPatchProposal).not.toHaveBeenCalled();
    expect(container.textContent).toContain("proposal changed or left the pending queue");
  });

  it("never reads a proposal when the Inbox projection is foreign", async () => {
    await renderDetail(item, { ...projection, workspaceId: "other" });
    expect(api.fetchDocumentPatchProposal).not.toHaveBeenCalled();
    expect(container.textContent).toContain("This proposal is no longer waiting.");
  });

  it("refuses a foreign owner record", async () => {
    api.fetchDocumentPatchProposal.mockResolvedValue({ item: { ...proposal, workspaceId: "other" } });
    await renderDetail();
    expect(container.textContent).not.toContain("Review apply");
    expect(api.applyDocumentPatchProposal).not.toHaveBeenCalled();
  });

  it("keeps an oversized diff read-only in the bounded Inbox inspector", async () => {
    api.fetchDocumentPatchProposal.mockResolvedValue({
      item: { ...proposal, derivedDiff: `-${"x".repeat(64_001)}` },
    });
    await renderDetail();
    expect(container.textContent).toContain("too large for bounded Inbox review");
    expect(container.textContent).not.toContain("Review apply");
    expect(container.querySelector("pre")?.textContent?.length).toBeLessThanOrEqual(4_000);
  });

  it("keeps the diff and its decisions, disabled, while the proposal is rechecked", async () => {
    const client = await renderDetail();
    const finish = await startRecheck(client);
    expect(container.textContent).toContain("Checking for changes…");
    expect(container.textContent).toContain("+After");
    expect(container.textContent).not.toContain("Loading the current proposal");
    expect(button("Review apply").disabled).toBe(true);
    expect(button("Review rejection").disabled).toBe(true);
    await finish();
    expect(button("Review apply").disabled).toBe(false);
  });

  it("keeps an open review open while the proposal is rechecked", async () => {
    const client = await renderDetail();
    await act(async () => button("Review apply").click());
    const finish = await startRecheck(client);
    expect(button("Confirm apply").disabled).toBe(true);
    await finish();
    expect(button("Confirm apply").disabled).toBe(false);
  });

  it("keeps the diff beside a failed recheck", async () => {
    const client = await renderDetail();
    api.fetchDocumentPatchProposal.mockRejectedValueOnce(new Error("Gateway offline"));
    await act(async () => {
      void client.invalidateQueries({ queryKey: ["chat", "document-proposal"] });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());
    expect(container.textContent).toContain("+After");
    expect(container.textContent).toContain("Showing the last version from");
  });

  it("drops the decided proposal instead of showing it beside the outcome", async () => {
    await renderDetail();
    await act(async () => button("Review apply").click());
    api.fetchDocumentPatchProposal
      .mockResolvedValueOnce({ item: proposal })
      .mockResolvedValue({ item: { ...proposal, state: "applied" } });
    await act(async () => button("Confirm apply").click());
    await vi.waitFor(() => expect(container.textContent).toContain("This proposal is no longer waiting."));
    expect(container.textContent).toContain("Gateway recorded this document proposal as applied");
    expect(container.textContent).not.toContain("+After");
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
