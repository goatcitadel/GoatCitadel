// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TraceMemoryCandidateRecord } from "@goatcitadel/contracts";
import { fetchTraceMemoryCandidates } from "@goatcitadel/mission-control-shared/api/memory";
import { LibraryMemoryProposals } from "./LibraryMemoryProposals";

vi.mock("@goatcitadel/mission-control-shared/api/memory", () => ({
  fetchTraceMemoryCandidates: vi.fn(),
  fetchTraceMemoryCandidate: vi.fn(),
  promoteTraceMemoryCandidate: vi.fn(),
  rejectTraceMemoryCandidate: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/settings", () => ({
  fetchSettings: async () => ({ features: { memoryLifecycleAdminV1Enabled: true } }),
}));

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
        <LibraryMemoryProposals workspaceId="one" hideWhenEmpty />
      </QueryClientProvider>,
    ),
  );
}
const result = (items: TraceMemoryCandidateRecord[]) =>
  ({ items }) as unknown as Awaited<ReturnType<typeof fetchTraceMemoryCandidates>>;

it("renders nothing once a read finds no proposals", async () => {
  vi.mocked(fetchTraceMemoryCandidates).mockResolvedValue(result([]));
  await render();
  await vi.waitFor(() => expect(fetchTraceMemoryCandidates).toHaveBeenCalled());
  await vi.waitFor(() => expect(container.textContent).toBe(""));
});

it("shows the section while loading", async () => {
  vi.mocked(fetchTraceMemoryCandidates).mockReturnValue(new Promise(() => {}));
  await render();
  expect(container.textContent).toContain("Memory proposals");
});

it("shows the section after a failed read", async () => {
  vi.mocked(fetchTraceMemoryCandidates).mockRejectedValue(new Error("down"));
  await render();
  await vi.waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());
  expect(container.textContent).toContain("Memory proposals");
});

it("shows the section when it has rows", async () => {
  vi.mocked(fetchTraceMemoryCandidates).mockResolvedValue(result([proposal]));
  await render();
  await vi.waitFor(() => expect(container.textContent).toContain("Prefers short status updates"));
});
