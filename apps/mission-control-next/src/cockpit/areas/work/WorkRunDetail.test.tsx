// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { WorkRunDetail } from "./WorkRunDetail";
import { formatCostUsd } from "@goatcitadel/mission-control-shared/content/cost-summary";

const api = vi.hoisted(() => ({ fetch: vi.fn() }));
const route = vi.hoisted(() => ({ search: "", hash: "" }));
vi.mock("@goatcitadel/mission-control-shared/api/durable", () => ({ fetchObserveRunTrace: api.fetch }));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({ activeWorkspaceId: "workspace-a" }),
}));
vi.mock("../../app/use-cockpit-route", () => ({
  useCockpitRoute: () => ({ navigate: vi.fn(), search: route.search, hash: route.hash }),
}));
vi.mock("./RunEvidenceSections", () => ({ RunEvidenceSections: () => null }));
vi.mock("./RunLineage", () => ({ RunLineage: () => <p>Lineage evidence</p> }));
vi.mock("./RunSignedReceipt", () => ({
  RunSignedReceipt: ({ runId }: { runId: string }) => <p>Receipt for {runId}</p>,
}));
vi.mock("./RunArtifacts", () => ({ RunArtifacts: () => null }));
vi.mock("./RunWorkspaceContext", () => ({ RunWorkspaceContext: () => null }));
vi.mock("./WorkRunControls", () => ({ WorkRunControls: () => null }));

const container = document.createElement("div");
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
let root: ReturnType<typeof createRoot>;
it("keeps the exact native approval owner visible when canonical trace coverage is incomplete", async () => {
  route.search =
    "?keep=yes&citadelId=c&workspaceId=stale&runId=other&sessionId=other&approvalId=stale&shell=classic&shellScope=visit";
  route.hash = "#receipt";
  document.body.appendChild(container);
  root = createRoot(container);
  api.fetch.mockResolvedValue({
    run: {
      runId: "run-a",
      workflowKey: "chat.turn.execute",
      status: "waiting",
      payload: { workspaceId: "workspace-a", sessionId: "session-a" },
    },
    durable: { checkpoints: { state: "unknown", items: [] }, timeline: { state: "unknown", items: [] } },
    toolCalls: { state: "unknown", items: [] },
    providerUsage: { state: "unknown", items: [] },
    approvals: {
      state: "unknown",
      missingIds: ["missing"],
      items: [{ approvalId: "actual-owner", kind: "tool.invoke", status: "pending", riskLevel: "caution" }],
    },
    errors: { state: "not_available", items: [] },
  });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <WorkRunDetail runId="run-a" />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(container.textContent).toContain("this list may be incomplete"));
  const history = [...container.querySelectorAll("a")].find(
    (link) => link.textContent?.trim() === "Open approval history",
  )!;
  const decision = [...container.querySelectorAll("a")].find(
    (link) => link.textContent?.trim() === "Review linked decision",
  )!;
  expect(history).toBeDefined();
  expect(decision).toBeDefined();
  for (const link of [history, decision]) {
    const target = new URL(link.href);
    expect(target.pathname).toBe("/inbox");
    expect(target.searchParams.get("workspaceId")).toBe("workspace-a");
    expect(target.searchParams.get("runId")).toBe("run-a");
    expect(target.searchParams.get("sessionId")).toBe("session-a");
    expect(target.searchParams.get("view")).toBe("history");
    expect(target.searchParams.get("shell")).toBe("cockpit");
    expect(target.searchParams.get("keep")).toBe("yes");
    expect(target.searchParams.get("citadelId")).toBe("c");
    expect(target.searchParams.has("shellScope")).toBe(false);
    expect(target.hash).toBe("#receipt");
  }
  expect(new URL(decision.href).searchParams.get("approvalId")).toBe("actual-owner");
  expect(new URL(history.href).searchParams.has("approvalId")).toBe(false);
  expect(container.textContent).not.toContain("Open approvals in the classic view");
  const conversation = [...container.querySelectorAll("a")].find(
    (link) => link.textContent?.trim() === "Open this conversation in Chat",
  )!;
  const health = [...container.querySelectorAll("a")].find(
    (link) => link.textContent?.trim() === "Open runtime health in System",
  )!;
  for (const [link, pathname] of [
    [conversation, "/chat"],
    [health, "/system"],
  ] as const) {
    expect(link).toBeDefined();
    const target = new URL(link.href);
    expect(target.pathname).toBe(pathname);
    expect(target.searchParams.get("workspaceId")).toBe("workspace-a");
    expect(target.searchParams.get("runId")).toBe("run-a");
    expect(target.searchParams.get("sessionId")).toBe("session-a");
    expect(target.searchParams.has("approvalId")).toBe(false);
    expect(target.searchParams.get("keep")).toBe("yes");
    expect(target.searchParams.get("citadelId")).toBe("c");
    expect(target.searchParams.get("shell")).toBe("cockpit");
    expect(target.searchParams.has("shellScope")).toBe(false);
    expect(target.hash).toBe("#receipt");
  }
  expect(container.textContent).not.toContain("Open the classic runtime view");
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  client.clear();
  route.search = "";
  route.hash = "";
});
it("keeps the signed evidence receipt reachable while technical details are hidden", async () => {
  document.body.appendChild(container);
  root = createRoot(container);
  api.fetch.mockResolvedValue({
    run: {
      runId: "run-a",
      workflowKey: "chat.turn.execute",
      status: "completed",
      payload: { workspaceId: "workspace-a" },
    },
    durable: { checkpoints: { state: "available", items: [] }, timeline: { state: "available", items: [] } },
    toolCalls: { state: "available", items: [] },
    providerUsage: { state: "unknown", items: [] },
    approvals: { state: "available", items: [] },
    errors: { state: "available", items: [] },
  });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <WorkRunDetail runId="run-a" />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(container.textContent).toContain("Receipt for run-a"));
  expect(container.textContent).not.toContain("Lineage evidence");
});
it.each(["workspace-a", "workspace-other"])(
  "renders recorded errors only for the selected workspace (%s)",
  async (workspaceId) => {
    document.body.appendChild(container);
    root = createRoot(container);
    api.fetch.mockResolvedValue({
      run: {
        runId: "run-a",
        workflowKey: "chat.turn.execute",
        status: "failed",
        updatedAt: "2026-10-05T00:00:00Z",
        payload: { workspaceId },
      },
      durable: { checkpoints: { state: "available", items: [] }, timeline: { state: "available", items: [] } },
      toolCalls: { state: "available", items: [] },
      providerUsage: { state: "unknown", items: [] },
      approvals: { state: "available", items: [] },
      errors: {
        state: "available",
        items: [{ source: "tool", id: "error-a", message: "Owner-reported tool failure" }],
      },
    });
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <WorkRunDetail runId="run-a" />
        </QueryClientProvider>,
      ),
    );
    await vi.waitFor(() =>
      expect(container.textContent).toContain(
        workspaceId === "workspace-a" ? "Recorded run errors" : "Run outside this workspace",
      ),
    );
    expect(container.textContent?.includes("Owner-reported tool failure")).toBe(workspaceId === "workspace-a");
    expect(container.querySelector('[aria-label="Recorded run errors"] a')).toBeNull();
  },
);
it("shows a recorded zero provider cost instead of Unknown", async () => {
  document.body.appendChild(container);
  root = createRoot(container);
  api.fetch.mockResolvedValue({
    run: {
      runId: "run-a",
      workflowKey: "chat.turn.execute",
      status: "completed",
      payload: { workspaceId: "workspace-a" },
    },
    durable: { checkpoints: { state: "available", items: [] }, timeline: { state: "available", items: [] } },
    toolCalls: { state: "available", items: [] },
    providerUsage: { state: "available", items: [{ turnId: "turn-a" }], totals: { costUsd: 0 } },
    approvals: { state: "available", items: [] },
    errors: { state: "available", items: [] },
  });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <WorkRunDetail runId="run-a" />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(container.textContent).toContain("Recorded cost"));
  expect(container.textContent).toContain(`${formatCostUsd(0)}+`);
});
