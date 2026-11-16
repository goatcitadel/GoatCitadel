// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { WorkRunDetail } from "./WorkRunDetail";

const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/durable", () => ({ fetchObserveRunTrace: api.fetch }));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({ activeWorkspaceId: "workspace-a", showTechnicalDetails: true }),
}));
vi.mock("../../app/use-cockpit-route", () => ({
  useCockpitRoute: () => ({ navigate: vi.fn(), pathname: "/work/runs/run-a", search: "", hash: "" }),
}));
vi.mock("@goatcitadel/mission-control-shared/api/workspaces", () => ({
  fetchWorkspaces: vi.fn(async () => ({ items: [] })),
}));
vi.mock("../../app/ScopeSwitcher", () => ({ ScopeSwitcher: () => null }));
vi.mock("./RunEvidenceSections", () => ({ RunEvidenceSections: () => null }));
vi.mock("./RunLineage", () => ({ RunLineage: () => null }));
vi.mock("./RunSignedReceipt", () => ({ RunSignedReceipt: () => null }));
vi.mock("./RunArtifacts", () => ({ RunArtifacts: () => null }));
vi.mock("./RunWorkspaceContext", () => ({ RunWorkspaceContext: () => null }));
vi.mock("./WorkRunControls", () => ({ WorkRunControls: () => null }));

const container = document.createElement("div");
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
let root: ReturnType<typeof createRoot>;

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  client.clear();
});

async function renderRun(trace: {
  lastError?: string;
  errors?: { source: string; id: string; message: string }[];
  approvalKind?: string;
}) {
  document.body.appendChild(container);
  root = createRoot(container);
  api.fetch.mockResolvedValue({
    run: {
      runId: "run-a",
      workflowKey: "chat.turn.execute",
      status: "cancelled",
      lastError: trace.lastError,
      payload: { workspaceId: "workspace-a" },
    },
    durable: { checkpoints: { state: "available", items: [] }, timeline: { state: "available", items: [] } },
    toolCalls: { state: "available", items: [] },
    providerUsage: { state: "unknown", items: [] },
    approvals: {
      state: "available",
      items: trace.approvalKind
        ? [{ approvalId: "ap-1", kind: trace.approvalKind, status: "pending", riskLevel: "caution" }]
        : [],
    },
    errors: { state: "available", items: trace.errors ?? [] },
  });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <WorkRunDetail runId="run-a" />
      </QueryClientProvider>,
    ),
  );
}

it("says an operator cancelled the run and keeps the recorded text in technical details", async () => {
  await renderRun({
    lastError: "cancelled by auth:[REDACTED]",
    errors: [{ source: "durable_run", id: "e1", message: "cancelled by auth:[REDACTED]" }],
  });
  await vi.waitFor(() => expect(container.textContent).toContain("Cancelled by an operator."));
  const alert = container.querySelector('p[role="alert"]')!;
  expect(alert.textContent).toBe("Cancelled by an operator.");
  const errors = container.querySelector('[aria-label="Recorded run errors"]')!;
  expect(errors.textContent).toContain("Run: Cancelled by an operator.");
  expect(errors.querySelector("summary")?.textContent).toBe("Recorded error");
  expect(errors.querySelector("details p")?.textContent).toBe("cancelled by auth:[REDACTED]");
  const status = container.querySelector('p[role="alert"]')!.parentElement!;
  expect(status.querySelector("details p")?.textContent).toBe("cancelled by auth:[REDACTED]");
});

it("keeps cancellation text it cannot classify as recorded", async () => {
  await renderRun({
    lastError: "cancelled by orchestration",
    errors: [{ source: "durable_run", id: "e1", message: "cancelled by orchestration" }],
  });
  await vi.waitFor(() => expect(container.querySelector('[aria-label="Recorded run errors"]')).not.toBeNull());
  expect(container.textContent).not.toContain("Cancelled by an operator.");
  expect(container.querySelector('[aria-label="Recorded run errors"]')!.textContent).toContain(
    "cancelled by orchestration",
  );
});

it("names an approval kind in plain words and reads Other for a value that is not a known kind", async () => {
  await renderRun({ approvalKind: "tool.invoke" });
  await vi.waitFor(() => expect(container.textContent).toContain("Use a tool"));
  act(() => root.unmount());
  root = createRoot(container);
  await renderRun({ approvalKind: "constructor" });
  await vi.waitFor(() => expect(container.textContent).toContain("Other"));
  expect(container.textContent).not.toContain("Constructor");
});
