// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { WorkRunDetail } from "./WorkRunDetail";

const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/durable", () => ({ fetchObserveRunTrace: api.fetch }));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({ useUiPreferences: () => ({ activeWorkspaceId: "workspace-a" }) }));
vi.mock("../../app/use-cockpit-route", () => ({ useCockpitRoute: () => ({ navigate: vi.fn() }) }));
vi.mock("./RunEvidenceSections", () => ({ RunEvidenceSections: () => null }));
vi.mock("./RunLineage", () => ({ RunLineage: () => null }));
vi.mock("./RunSignedReceipt", () => ({ RunSignedReceipt: () => null }));
vi.mock("./RunArtifacts", () => ({ RunArtifacts: () => null }));
vi.mock("./RunWorkspaceContext", () => ({ RunWorkspaceContext: () => null }));
vi.mock("./WorkRunControls", () => ({ WorkRunControls: () => null }));

const container = document.createElement("div");
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
let root: ReturnType<typeof createRoot>;
it("keeps the exact native approval owner visible when canonical trace coverage is incomplete", async () => {
  document.body.appendChild(container);
  root = createRoot(container);
  api.fetch.mockResolvedValue({
    run: { runId: "run-a", workflowKey: "chat.turn.execute", status: "waiting", payload: { workspaceId: "workspace-a" } },
    durable: { checkpoints: { state: "unknown", items: [] }, timeline: { state: "unknown", items: [] } },
    toolCalls: { state: "unknown", items: [] }, providerUsage: { state: "unknown", items: [] },
    approvals: { state: "unknown", missingIds: ["missing"], items: [{ approvalId: "actual-owner", kind: "tool.invoke", status: "pending", riskLevel: "caution" }] },
    errors: { state: "not_available", items: [] },
  });
  await act(async () => root.render(<QueryClientProvider client={client}><WorkRunDetail runId="run-a" /></QueryClientProvider>));
  await vi.waitFor(() => expect(container.textContent).toContain("this list may be incomplete"));
  expect(container.querySelector('a[href="/inbox?approvalId=actual-owner&shell=cockpit"]')?.textContent).toBe("Review linked decision");
});
afterEach(() => { act(() => root.unmount()); container.remove(); client.clear(); });
it.each(["workspace-a", "workspace-other"])("renders recorded errors only for the selected workspace (%s)", async (workspaceId) => {
  document.body.appendChild(container);
  root = createRoot(container);
  api.fetch.mockResolvedValue({
    run: { runId: "run-a", workflowKey: "chat.turn.execute", status: "failed", updatedAt: "2026-10-05T00:00:00Z", payload: { workspaceId } },
    durable: { checkpoints: { state: "available", items: [] }, timeline: { state: "available", items: [] } },
    toolCalls: { state: "available", items: [] }, providerUsage: { state: "unknown", items: [] },
    approvals: { state: "available", items: [] },
    errors: { state: "available", items: [{ source: "tool", id: "error-a", message: "Owner-reported tool failure" }] },
  });
  await act(async () => root.render(<QueryClientProvider client={client}><WorkRunDetail runId="run-a" /></QueryClientProvider>));
  await vi.waitFor(() => expect(container.textContent).toContain(workspaceId === "workspace-a" ? "Recorded run errors" : "Run outside this workspace"));
  expect(container.textContent?.includes("Owner-reported tool failure")).toBe(workspaceId === "workspace-a");
  expect(container.querySelector('[aria-label="Recorded run errors"] a')).toBeNull();
});
