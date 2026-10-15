// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TraceMemoryCandidateRecord } from "@goatcitadel/contracts";
import { fetchTraceMemoryCandidates } from "@goatcitadel/mission-control-shared/api/memory";
import { fetchSettings } from "@goatcitadel/mission-control-shared/api/settings";
import { LibraryMemoryProposals } from "./LibraryMemoryProposals";

vi.mock("@goatcitadel/mission-control-shared/api/memory", () => ({
  fetchTraceMemoryCandidates: vi.fn(),
  fetchTraceMemoryCandidate: vi.fn(),
  promoteTraceMemoryCandidate: vi.fn(),
  rejectTraceMemoryCandidate: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/settings", () => ({ fetchSettings: vi.fn() }));

const proposal = {
  candidateId: "cand-1",
  workspaceId: "one",
  proposedInsight: "Prefers short status updates",
  status: "proposed",
  authority: "agent_proposed",
  sourceRefs: ["turn-1"],
  updatedAt: "2026-10-01T00:00:00Z",
} as unknown as TraceMemoryCandidateRecord;

let root: Root, container: HTMLDivElement, client: QueryClient;
beforeEach(() => {
  vi.resetAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(fetchSettings).mockResolvedValue({ features: { memoryLifecycleAdminV1Enabled: true } } as Awaited<
    ReturnType<typeof fetchSettings>
  >);
});
afterEach(() => {
  act(() => root.unmount());
  client.clear();
  container.remove();
});
async function render() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <LibraryMemoryProposals workspaceId="one" />
      </QueryClientProvider>,
    ),
  );
}

it("says plainly when no proposals are waiting for review", async () => {
  vi.mocked(fetchTraceMemoryCandidates).mockResolvedValue({ items: [] } as unknown as Awaited<
    ReturnType<typeof fetchTraceMemoryCandidates>
  >);
  await render();
  await vi.waitFor(() => expect(container.textContent).toContain("No proposals waiting for review."));
});

it("labels proposal status, source and reference count in plain words", async () => {
  vi.mocked(fetchTraceMemoryCandidates).mockResolvedValue({ items: [proposal] } as unknown as Awaited<
    ReturnType<typeof fetchTraceMemoryCandidates>
  >);
  await render();
  await vi.waitFor(() => expect(container.textContent).toContain("Prefers short status updates"));
  expect(container.textContent).toContain("Waiting for review");
  expect(container.textContent).toContain("Proposed by an agent · 1 source reference");
  expect(container.textContent).not.toContain("agent_proposed");
  expect(container.textContent).not.toContain("No proposals waiting for review.");
});
