// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DurableDeadLetterRecord, DurableRunRecord, OperatorInboxItem } from "@goatcitadel/contracts";
import { UiPreferencesProvider } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { InboxRunRecovery } from "./InboxRunRecovery";

const api = vi.hoisted(() => ({
  fetchDurableRun: vi.fn(),
  fetchDurableDeadLetter: vi.fn(),
  fetchDurableDeadLetters: vi.fn(),
  retryDurableRun: vi.fn(),
  recoverDurableDeadLetter: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/durable", () => api);

const run: DurableRunRecord = {
  runId: "run-a",
  workflowKey: "maintenance.repair",
  status: "failed",
  attemptCount: 1,
  maxAttempts: 3,
  version: 4,
  payload: { workspaceId: "default" },
  createdAt: "2026-09-28T00:00:00Z",
  updatedAt: "2026-09-28T01:00:00Z",
};
const item: OperatorInboxItem = {
  id: "failed_run:run-a",
  kind: "failed_run",
  group: "needs_attention",
  title: "Recover failed run",
  summary: "Failed",
  createdAt: run.createdAt,
  updatedAt: run.updatedAt,
  source: { workspaceId: "default", runId: run.runId },
  href: "/ops/runtime?runId=run-a",
};
const letter: DurableDeadLetterRecord = {
  deadLetterId: "dead-a",
  runId: run.runId,
  reason: "Stopped",
  payload: {},
  createdAt: "2026-09-28T02:00:00Z",
};

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  for (const mock of Object.values(api)) mock.mockReset();
  api.fetchDurableRun.mockResolvedValue(run);
  api.fetchDurableDeadLetter.mockResolvedValue(letter);
  api.retryDurableRun.mockResolvedValue({ ...run, status: "queued", version: 5 });
  api.recoverDurableDeadLetter.mockResolvedValue({ ...run, status: "queued", version: 5 });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function renderRecovery(inboxItem = item) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <UiPreferencesProvider>
          <InboxRunRecovery item={inboxItem} workspaceId="default" />
        </UiPreferencesProvider>
      </QueryClientProvider>,
    ),
  );
  await act(async () => {
    await api.fetchDurableRun.mock.results[0]?.value;
    if (inboxItem.kind === "dead_letter") await Promise.allSettled([api.fetchDurableDeadLetter.mock.results[0]?.value]);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return client;
}

/** Make the next run read hang, invalidate, and let the refetch status reach React. */
async function startRecheck(client: QueryClient) {
  let release!: () => void;
  api.fetchDurableRun.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = () => resolve(run);
      }),
  );
  await act(async () => {
    void client.invalidateQueries({ queryKey: ["tasks"] });
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

describe("Inbox run recovery", () => {
  it("keeps the run and its retry, disabled, while it is rechecked", async () => {
    const client = await renderRecovery();
    const finish = await startRecheck(client);
    expect(container.textContent).toContain("Checking for changes…");
    expect(container.textContent).toContain("Workflow: maintenance.repair");
    expect(button("Retry run").disabled).toBe(true);
    await finish();
    expect(button("Retry run").disabled).toBe(false);
  });

  it("keeps an open retry review open while the run is rechecked", async () => {
    const client = await renderRecovery();
    await act(async () => button("Retry run").click());
    const finish = await startRecheck(client);
    expect(button("Confirm retry run").disabled).toBe(true);
    await finish();
    expect(button("Confirm retry run").disabled).toBe(false);
  });

  it("keeps the run beside a failed recheck", async () => {
    const client = await renderRecovery();
    api.fetchDurableRun.mockRejectedValueOnce(new Error("Gateway offline"));
    await act(async () => {
      void client.invalidateQueries({ queryKey: ["tasks"] });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());
    expect(container.textContent).toContain("Workflow: maintenance.repair");
    expect(container.textContent).toContain("Showing the last version from");
  });

  it("confirms, rereads the owner, then requests retry once", async () => {
    await renderRecovery();
    await act(async () => button("Retry run").click());
    expect(api.retryDurableRun).not.toHaveBeenCalled();
    await act(async () => button("Confirm retry run").click());
    // Open, the request's re-read, then the superseded run is reset and read once more.
    expect(api.fetchDurableRun).toHaveBeenCalledTimes(3);
    expect(api.retryDurableRun).toHaveBeenCalledOnce();
    expect(api.retryDurableRun).toHaveBeenCalledWith("run-a", { reason: "operator_inbox_retry" });
    expect(container.textContent).toContain("Inspect the current run to verify execution and effects");
    expect(api.recoverDurableDeadLetter).not.toHaveBeenCalled();
  });

  it("refuses a changed run after review", async () => {
    api.fetchDurableRun.mockResolvedValueOnce(run).mockResolvedValueOnce({ ...run, version: 5, updatedAt: "later" });
    await renderRecovery();
    await act(async () => button("Retry run").click());
    await act(async () => button("Confirm retry run").click());
    expect(api.retryDurableRun).not.toHaveBeenCalled();
    expect(container.textContent).toContain("The run or dead letter changed");
  });

  it("locks retry after an uncertain mutation response", async () => {
    api.retryDurableRun.mockRejectedValue(new Error("Connection lost"));
    await renderRecovery();
    await act(async () => button("Retry run").click());
    await act(async () => button("Confirm retry run").click());
    expect(api.retryDurableRun).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Recovery outcome is uncertain");
    expect([...container.querySelectorAll("button")].some((entry) => entry.textContent === "Retry run")).toBe(false);
  });

  it("recovers only the exact unresolved dead letter", async () => {
    const deadItem: OperatorInboxItem = {
      ...item,
      id: "dead_letter:dead-a",
      kind: "dead_letter",
      createdAt: letter.createdAt,
      source: { ...item.source, deadLetterId: "dead-a" },
    };
    api.fetchDurableRun.mockResolvedValue({ ...run, status: "dead_lettered" });
    await renderRecovery(deadItem);
    await act(async () => button("Recover run").click());
    await act(async () => button("Confirm recover run").click());
    expect(api.fetchDurableDeadLetter).toHaveBeenCalledWith("dead-a");
    expect(api.fetchDurableDeadLetters).not.toHaveBeenCalled();
    expect(api.recoverDurableDeadLetter).toHaveBeenCalledWith("dead-a");
    expect(api.retryDurableRun).not.toHaveBeenCalled();
  });

  it("says a stopped run that left recovery is no longer waiting", async () => {
    api.fetchDurableRun.mockResolvedValue({ ...run, status: "dead_lettered" });
    api.fetchDurableDeadLetter.mockRejectedValue(
      new ApiRequestError("API error 404", { kind: "http", method: "GET", path: "/x", status: 404 }),
    );
    await renderRecovery({
      ...item,
      id: "dead_letter:dead-a",
      kind: "dead_letter",
      createdAt: letter.createdAt,
      source: { ...item.source, deadLetterId: "dead-a" },
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.textContent).toContain("This stopped run is no longer waiting for recovery.");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});
