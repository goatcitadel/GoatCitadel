// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DurableRunRecord } from "@goatcitadel/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkRunningIndicator } from "./WorkRunningIndicator";

const read = vi.hoisted(() =>
  vi.fn<typeof import("@goatcitadel/mission-control-shared/api/durable").fetchDurableRunHistory>(),
);
vi.mock("@goatcitadel/mission-control-shared/api/durable", () => ({ fetchDurableRunHistory: read }));

const running: DurableRunRecord = {
  runId: "run-a-running",
  workflowKey: "chat.turn.execute",
  payload: { workspaceId: "a" },
  status: "running",
  version: 1,
  attemptCount: 0,
  maxAttempts: 3,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
};

beforeEach(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    media: query,
    matches: true,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
});
afterEach(() => {
  read.mockReset();
  vi.unstubAllGlobals();
});

it("marks the running dot so forced colours can draw it (U-GL-001)", async () => {
  read.mockResolvedValue({ items: [running] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <WorkRunningIndicator workspaceId="a" />
      </QueryClientProvider>,
    );
  });
  try {
    await vi.waitFor(() => expect(container.querySelector('[data-status-dot="running"]')).not.toBeNull());
  } finally {
    await act(async () => root.unmount());
    container.remove();
    client.clear();
  }
});
