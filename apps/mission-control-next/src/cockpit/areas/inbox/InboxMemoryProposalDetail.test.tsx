// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OperatorInboxItem, TraceMemoryCandidateRecord } from "@goatcitadel/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { InboxMemoryProposalDetail } from "./InboxMemoryProposalDetail";
import { canResolveInboxMemoryProposal } from "./memory-proposal-guard";

const api = vi.hoisted(() => ({
  fetchTraceMemoryCandidate: vi.fn(),
  fetchTraceMemoryCandidates: vi.fn(),
  promoteTraceMemoryCandidate: vi.fn(),
  rejectTraceMemoryCandidate: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/memory", () => api);
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({ activeWorkspaceId: "workspace-a" }),
}));

const item: OperatorInboxItem = {
  id: "memory_proposal:candidate-a",
  kind: "memory_proposal",
  group: "proposals",
  title: "Review memory proposal",
  summary: "Use the project style guide.",
  createdAt: "2026-09-28T12:00:00.000Z",
  updatedAt: "2026-09-28T12:01:00.000Z",
  source: { workspaceId: "workspace-a", proposalId: "candidate-a" },
  href: "/library/memory?shell=classic",
};
const candidate: TraceMemoryCandidateRecord = {
  candidateId: "candidate-a",
  workspaceId: "workspace-a",
  candidateType: "repo_fact",
  status: "proposed",
  sourceText: "A project discussion",
  proposedInsight: "Use the project style guide.",
  confidence: 0.9,
  sourceRefs: [{ sourceType: "session", sourceRef: "session-a" }],
  authority: "agent_proposed",
  dedupeKey: "key-a",
  createdAt: "2026-09-28T12:00:00.000Z",
  updatedAt: "2026-09-28T12:01:00.000Z",
};

let root: Root;
let container: HTMLDivElement;

function button(label: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll("button")].find((element) => element.textContent?.trim() === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  api.fetchTraceMemoryCandidate.mockReset().mockResolvedValue(candidate);
  api.fetchTraceMemoryCandidates.mockReset();
  api.promoteTraceMemoryCandidate.mockReset().mockResolvedValue({
    learningId: "learning-a",
    workspaceId: "workspace-a",
    status: "trusted",
    insight: candidate.proposedInsight,
    sourceRefs: candidate.sourceRefs,
  });
  api.rejectTraceMemoryCandidate.mockReset().mockResolvedValue({ ...candidate, status: "rejected" });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <InboxMemoryProposalDetail item={item} workspaceId="workspace-a" />
      </QueryClientProvider>,
    ),
  );
  await settle();
}

describe("Inbox memory proposal review", () => {
  it("requires the exact proposed workspace record", () => {
    expect(canResolveInboxMemoryProposal(item, candidate, candidate, "workspace-a")).toBe(true);
    expect(
      canResolveInboxMemoryProposal(item, candidate, { ...candidate, proposedInsight: "Changed" }, "workspace-a"),
    ).toBe(false);
    expect(
      canResolveInboxMemoryProposal(item, candidate, { ...candidate, workspaceId: "workspace-b" }, "workspace-a"),
    ).toBe(false);
    expect(canResolveInboxMemoryProposal(item, candidate, { ...candidate, status: "promoted" }, "workspace-a")).toBe(
      false,
    );
    expect(
      canResolveInboxMemoryProposal(
        { ...item, source: { workspaceId: "workspace-a", proposalId: "other" } },
        candidate,
        candidate,
        "workspace-a",
      ),
    ).toBe(false);
  });

  it("shows the current proposal and confirms promotion after a fresh owner read", async () => {
    await render();
    expect(container.textContent).toContain("Proposed insight: Use the project style guide.");
    expect(api.fetchTraceMemoryCandidate).toHaveBeenCalledWith("candidate-a", {
      workspaceId: "workspace-a",
      signal: expect.any(AbortSignal),
    });
    expect(api.fetchTraceMemoryCandidates).not.toHaveBeenCalled();
    await act(async () => button("Promote to memory").click());
    expect(api.promoteTraceMemoryCandidate).not.toHaveBeenCalled();
    await act(async () => button("Confirm promotion").click());
    await settle();
    expect(api.fetchTraceMemoryCandidate).toHaveBeenCalledTimes(2);
    expect(api.promoteTraceMemoryCandidate).toHaveBeenCalledWith("candidate-a");
    expect(container.textContent).toContain("Gateway promoted the proposal");
    expect(container.textContent).not.toContain("Promote to memory");
  });

  it("does not mutate when the current proposal changed", async () => {
    await render();
    api.fetchTraceMemoryCandidate.mockResolvedValueOnce({ ...candidate, proposedInsight: "Changed" });
    await act(async () => button("Reject proposal").click());
    await act(async () => button("Confirm rejection").click());
    await settle();
    expect(api.rejectTraceMemoryCandidate).not.toHaveBeenCalled();
    expect(container.textContent).toContain("The proposal changed or left the pending queue");
  });

  it("confirms rejection and checks the owner response", async () => {
    await render();
    await act(async () => button("Reject proposal").click());
    expect(api.rejectTraceMemoryCandidate).not.toHaveBeenCalled();
    await act(async () => button("Confirm rejection").click());
    await settle();
    expect(api.rejectTraceMemoryCandidate).toHaveBeenCalledWith("candidate-a");
    expect(container.textContent).toContain("Gateway rejected the proposal");
  });

  it("treats a mismatched mutation response as uncertain", async () => {
    await render();
    api.promoteTraceMemoryCandidate.mockResolvedValueOnce({
      learningId: "learning-b",
      workspaceId: "workspace-b",
      status: "trusted",
      insight: candidate.proposedInsight,
      sourceRefs: candidate.sourceRefs,
    });
    await act(async () => button("Promote to memory").click());
    await act(async () => button("Confirm promotion").click());
    await settle();
    expect(container.textContent).toContain("Decision outcome is uncertain");
    expect(container.textContent).not.toContain("Gateway promoted the proposal");
  });

  it("locks decisions after an uncertain mutation result", async () => {
    await render();
    api.promoteTraceMemoryCandidate.mockRejectedValueOnce(new Error("Network lost"));
    await act(async () => button("Promote to memory").click());
    await act(async () => button("Confirm promotion").click());
    await settle();
    expect(container.textContent).toContain("Decision outcome is uncertain");
    expect(container.textContent).not.toContain("Promote to memory");
    expect(api.promoteTraceMemoryCandidate).toHaveBeenCalledTimes(1);
  });

  it("withholds actions for a foreign workspace owner record", async () => {
    api.fetchTraceMemoryCandidate.mockResolvedValue({ ...candidate, workspaceId: "workspace-b" });
    await render();
    expect(container.textContent).toContain("belongs to another workspace");
    expect(container.textContent).not.toContain("Promote to memory");
  });

  it.each([
    [
      "missing",
      () =>
        api.fetchTraceMemoryCandidate.mockRejectedValue(
          new ApiRequestError("API error 404", { kind: "http", method: "GET", path: "/x", status: 404 }),
        ),
    ],
    ["decided", () => api.fetchTraceMemoryCandidate.mockResolvedValue({ ...candidate, status: "rejected" })],
  ])("says a %s proposal is no longer waiting", async (_label, arrange) => {
    arrange();
    await render();
    expect(container.textContent).toContain("This proposal is no longer waiting.");
    expect(container.textContent).not.toContain("Promote to memory");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});
