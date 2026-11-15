// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChatThreadTurnRecord, ChatToolRunRecord } from "@goatcitadel/contracts";
import { ChatToolActivityBody } from "./ChatToolActivityBody";

// The approval line reads the approval record; this file is about the row, so that read never answers.
vi.mock("@goatcitadel/mission-control-shared/api/approvals", () => ({
  fetchApproval: vi.fn(() => new Promise(() => {})),
}));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({ activeWorkspaceId: "default" }),
}));

const approved = {
  toolRunId: "run-1",
  turnId: "turn-1",
  sessionId: "session-1",
  toolName: "documents.create",
  status: "executed",
  args: { path: "notes/note.txt" },
  approvalId: "approval-1",
  startedAt: "2026-11-15T00:00:00.000Z",
  finishedAt: "2026-11-15T00:00:02.000Z",
  effectPotential: "external",
  effectDisposition: "executed",
  effectOutcomeKind: "uncertain",
  effectEvidence: {
    version: "goatcitadel.tool-effect.v1",
    outcomeKind: "uncertain",
    reason: "completed_without_canonical_effect_receipt",
    refs: [],
  },
} as unknown as ChatToolRunRecord;

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  client.clear();
});

async function render(live: boolean) {
  const turn = { turnId: "turn-1", toolRuns: [approved] } as unknown as ChatThreadTurnRecord;
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ChatToolActivityBody turn={turn} showTechnicalDetails={false} live={live} />
      </QueryClientProvider>,
    ),
  );
}

it("says the turn is finishing after an approval while it still runs (U-CH-047)", async () => {
  await render(true);
  expect(container.textContent).toContain("Finishing after your approval.");
  expect(container.textContent).not.toContain("Outcome uncertain");
  expect(container.textContent).not.toContain("canonical effect receipt");
});

it("shows the recorded uncertain outcome once the turn is no longer running (U-CH-047)", async () => {
  await render(false);
  expect(container.textContent).toContain("Outcome uncertain");
  expect(container.textContent).not.toContain("Finishing after your approval.");
});
