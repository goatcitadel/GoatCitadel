// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TraceMemoryCandidateRecord } from "@goatcitadel/contracts";
import { fetchTraceMemoryCandidates } from "@goatcitadel/mission-control-shared/api/memory";
import { fetchSettings } from "@goatcitadel/mission-control-shared/api/settings";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { LibraryMemoryProposals } from "./LibraryMemoryProposals";
import { prepareReadyDialogFixture } from "../../../test/ready-dialog-fixture";

prepareReadyDialogFixture();

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

const switchState = vi.hoisted(() => ({ on: undefined as boolean | undefined }));
vi.mock("@goatcitadel/mission-control-shared/api/client", async (original) => ({
  ...(await original<object>()),
  fetchSettings: async () => ({ features: { memoryLifecycleAdminV1Enabled: switchState.on } }),
}));

let root: Root, container: HTMLDivElement, client: QueryClient;
beforeEach(() => {
  switchState.on = undefined;
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

it("says memory administration is turned off and links to its switch when proposals are refused for that reason", async () => {
  vi.mocked(fetchTraceMemoryCandidates).mockRejectedValue(
    new ApiRequestError("off", {
      kind: "http",
      method: "GET",
      path: "/api/v1/memory/trace-candidates",
      status: 409,
      body: { code: "FEATURE_DISABLED", details: { flag: "memoryLifecycleAdminV1Enabled" } },
    }),
  );
  await render();
  await vi.waitFor(() =>
    expect(container.textContent).toContain("Memory administration is turned off on this installation."),
  );
  expect(container.textContent).not.toContain("This feature is turned off for this installation.");
  const link = [...container.querySelectorAll("a")].find(
    (entry) => entry.textContent === "Turn it on in Settings › Advanced",
  );
  expect(new URL(link!.getAttribute("href")!, "http://cockpit.invalid").hash).toBe(
    "#feature-switch-memory-administration",
  );
});

it("reads proposals again, without a reload, once memory administration is turned on", async () => {
  const off = new ApiRequestError("off", {
    kind: "http",
    method: "GET",
    path: "/api/v1/memory/trace-candidates",
    status: 409,
    body: { code: "FEATURE_DISABLED", details: { flag: "memoryLifecycleAdminV1Enabled" } },
  });
  vi.mocked(fetchTraceMemoryCandidates).mockImplementation(async () => {
    if (switchState.on !== true) throw off;
    return { items: [] } as unknown as Awaited<ReturnType<typeof fetchTraceMemoryCandidates>>;
  });
  switchState.on = false;
  await render();
  await vi.waitFor(() =>
    expect(container.textContent).toContain("Memory administration is turned off on this installation."),
  );
  switchState.on = true;
  await act(async () => {
    await client.invalidateQueries({ queryKey: ["system", "settings-feature-switches"] });
  });
  await vi.waitFor(() => expect(container.textContent).toContain("No proposals waiting for review."));
  expect(container.textContent).not.toContain("turned off on this installation");
});

it.each([
  ["Review promotion", "Confirm memory promotion"],
  ["Review rejection", "Confirm memory rejection"],
])("the %s dialog confirm is the primary button (U-GL-008)", async (review, confirm) => {
  vi.mocked(fetchTraceMemoryCandidates).mockResolvedValue({ items: [proposal] } as unknown as Awaited<
    ReturnType<typeof fetchTraceMemoryCandidates>
  >);
  await render();
  const opener = () =>
    [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === review);
  await vi.waitFor(() => expect(opener()?.disabled).toBe(false));
  await act(async () => opener()!.click());
  const button = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
    (item) => item.textContent === confirm,
  )!;
  expect(button.className).toContain("bg-accent");
});
