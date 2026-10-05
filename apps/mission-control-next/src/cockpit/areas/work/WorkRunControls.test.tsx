// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DurableDeadLetterRecord, DurableRunRecord } from "@goatcitadel/contracts";
import { UiPreferencesProvider } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkRunControls } from "./WorkRunControls";

const api = vi.hoisted(() => ({
  fetchDurableRun: vi.fn(),
  pauseDurableRun: vi.fn(),
  resumeDurableRun: vi.fn(),
  cancelDurableRun: vi.fn(),
  fetchDurableDeadLetters: vi.fn(),
  retryDurableRun: vi.fn(),
  recoverDurableDeadLetter: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/durable", () => api);

const run: DurableRunRecord = {
  runId: "run-a",
  workflowKey: "maintenance.repair",
  status: "running",
  attemptCount: 1,
  maxAttempts: 3,
  version: 2,
  payload: { workspaceId: "default" },
  createdAt: "2026-09-28T00:00:00Z",
  updatedAt: "2026-09-28T01:00:00Z",
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
  api.pauseDurableRun.mockResolvedValue({ ...run, status: "paused", version: 3 });
  api.resumeDurableRun.mockResolvedValue({ ...run, status: "queued", version: 3 });
  api.cancelDurableRun.mockResolvedValue({ ...run, status: "cancelled", version: 3 });
  api.fetchDurableDeadLetters.mockResolvedValue({ items: [letter] });
  api.retryDurableRun.mockResolvedValue({ ...run, status: "queued", version: 3 });
  api.recoverDurableDeadLetter.mockResolvedValue({ ...run, status: "queued", version: 3 });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function renderControls(client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <UiPreferencesProvider>
          <WorkRunControls runId="run-a" />
        </UiPreferencesProvider>
      </QueryClientProvider>,
    ),
  );
  await act(async () => {
    await api.fetchDurableRun.mock.results[0]?.value;
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  if (api.fetchDurableDeadLetters.mock.results.length) {
    await act(async () => {
      await api.fetchDurableDeadLetters.mock.results[0]?.value;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  return client;
}

/** Invalidate everything and let the refetch status reach React. */
async function invalidateAll(client: QueryClient) {
  await act(async () => {
    void client.invalidateQueries();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function button(label: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll("button")].find((entry) => entry.textContent === label);
  if (!found) throw new Error(`Missing ${label} button: ${document.body.textContent}`);
  return found;
}

describe("Work run controls", () => {
  it("confirms pause, rereads the current run, and reports the owner result", async () => {
    await renderControls();
    await act(async () => button("Pause").click());
    expect(api.pauseDurableRun).not.toHaveBeenCalled();
    await act(async () => button("Confirm pause").click());
    expect(api.fetchDurableRun.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(api.fetchDurableRun.mock.invocationCallOrder[1]!).toBeLessThan(
      api.pauseDurableRun.mock.invocationCallOrder[0]!,
    );
    expect(api.pauseDurableRun).toHaveBeenCalledWith("run-a");
    expect(container.textContent).toContain("Gateway returned paused");
  });

  it("asks a capitalized question and never pairs two Cancel buttons", async () => {
    await renderControls();
    await act(async () => button("Cancel").click());
    expect(document.body.textContent).toContain("Cancel this run?");
    expect(button("Keep running")).toBeDefined();
    await act(async () => button("Keep running").click());
    await act(async () => button("Pause").click());
    expect(document.body.textContent).toContain("Pause this run?");
    expect(button("Go back")).toBeDefined();
  });

  it("prevents a stale cancel request", async () => {
    api.fetchDurableRun.mockResolvedValueOnce(run).mockResolvedValueOnce({ ...run, status: "completed", version: 3 });
    await renderControls();
    await act(async () => button("Cancel").click());
    await act(async () => button("Confirm cancel").click());
    expect(api.cancelDurableRun).not.toHaveBeenCalled();
    expect(container.textContent).toContain("The run changed");
  });

  it("locks actions after an uncertain mutation response", async () => {
    api.cancelDurableRun.mockRejectedValue(new Error("Connection lost"));
    await renderControls();
    await act(async () => button("Cancel").click());
    await act(async () => button("Confirm cancel").click());
    expect(api.cancelDurableRun).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Action outcome is uncertain");
    expect([...container.querySelectorAll("button")].some((entry) => entry.textContent === "Cancel")).toBe(false);
  });

  it("hides direct controls for a run outside the selected workspace", async () => {
    api.fetchDurableRun.mockResolvedValue({ ...run, payload: { workspaceId: "other" } });
    await renderControls();
    expect(container.textContent).toContain("No direct control is available");
    expect([...container.querySelectorAll("button")].some((entry) => entry.textContent === "Pause")).toBe(false);
  });

  it("confirms retry and rereads a failed non-Chat run before requesting another attempt", async () => {
    api.fetchDurableRun.mockResolvedValue({ ...run, status: "failed" });
    await renderControls();
    await act(async () => button("Retry").click());
    expect(api.retryDurableRun).not.toHaveBeenCalled();
    await act(async () => button("Confirm retry").click());
    expect(api.retryDurableRun).toHaveBeenCalledWith("run-a", { reason: "operator_work_retry" });
    expect(container.textContent).toContain("Gateway returned queued");
  });

  it("does not offer manual replay for an admitted Chat run", async () => {
    api.fetchDurableRun.mockResolvedValue({
      ...run,
      status: "failed",
      workflowKey: "chat.turn.execute",
      payload: { workspaceId: "default", version: "chat.turn.execute.v2" },
    });
    await renderControls();
    expect([...container.querySelectorAll("button")].some((entry) => entry.textContent === "Retry")).toBe(false);
    expect(container.textContent).toContain("can't be retried from here. Send the request again in its conversation.");
  });

  it("recovers the exact unresolved dead letter only after a fresh owner read", async () => {
    api.fetchDurableRun.mockResolvedValue({ ...run, status: "dead_lettered" });
    await renderControls();
    await act(async () => button("Recover").click());
    expect(api.recoverDurableDeadLetter).not.toHaveBeenCalled();
    await act(async () => button("Confirm recover").click());
    expect(api.fetchDurableDeadLetters.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(api.recoverDurableDeadLetter).toHaveBeenCalledWith("dead-a");
  });

  it("hides recovery when the recent recovery list lacks a single unresolved failed delivery", async () => {
    api.fetchDurableRun.mockResolvedValue({ ...run, status: "dead_lettered" });
    api.fetchDurableDeadLetters.mockResolvedValue({ items: [] });
    await renderControls();
    expect(container.textContent).toContain("No single unresolved failed delivery");
    expect([...container.querySelectorAll("button")].some((entry) => entry.textContent === "Recover")).toBe(false);
  });

  it("refuses recovery when the dead letter resolves between review and request", async () => {
    api.fetchDurableRun.mockResolvedValue({ ...run, status: "dead_lettered" });
    api.fetchDurableDeadLetters
      .mockResolvedValueOnce({ items: [letter] })
      .mockResolvedValueOnce({ items: [{ ...letter, resolvedAt: "later" }] });
    await renderControls();
    await act(async () => button("Recover").click());
    await act(async () => button("Confirm recover").click());
    expect(api.recoverDurableDeadLetter).not.toHaveBeenCalled();
    expect(container.textContent).toContain("The run changed or its recovery record changed");
  });

  it("keeps the run controls while the run is rechecked", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <UiPreferencesProvider>
            <WorkRunControls runId="run-a" />
          </UiPreferencesProvider>
        </QueryClientProvider>,
      ),
    );
    await vi.waitFor(() => expect(button("Pause")).toBeDefined());
    let release!: () => void;
    api.fetchDurableRun.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(run);
        }),
    );
    await act(async () => {
      void client.invalidateQueries();
      // Query status reaches React on a zero-delay timer; let it fire inside act.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.textContent).toContain("Checking for changes…");
    expect(container.textContent).toContain("Last known status:");
    expect(button("Pause")).toBeDefined();
    expect(button("Pause").disabled).toBe(true);
    await act(async () => release());
    await vi.waitFor(() => expect(container.textContent).not.toContain("Checking for changes…"));
    expect(container.textContent).toContain("Current status:");
    expect(button("Pause").disabled).toBe(false);
  });

  it("keeps an open action review open while the run is rechecked", async () => {
    const client = await renderControls();
    await act(async () => button("Pause").click());
    let release!: () => void;
    api.fetchDurableRun.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(run);
        }),
    );
    await invalidateAll(client);
    expect(document.body.textContent).toContain("Pause this run?");
    expect(button("Confirm pause").disabled).toBe(true);
    await act(async () => release());
    await vi.waitFor(() => expect(button("Confirm pause").disabled).toBe(false));
  });

  it("keeps the run beside a failed recheck", async () => {
    const client = await renderControls();
    api.fetchDurableRun.mockRejectedValueOnce(new Error("Gateway offline"));
    await invalidateAll(client);
    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());
    expect(container.textContent).toContain("Last known status: running");
    expect(container.textContent).toContain("Showing the last version from");
    expect(button("Pause")).toBeDefined();
  });

  it("keeps the dead letter and Recover while the recovery record is rechecked", async () => {
    api.fetchDurableRun.mockResolvedValue({ ...run, status: "dead_lettered" });
    const client = await renderControls();
    expect(button("Recover").disabled).toBe(false);
    let release!: () => void;
    api.fetchDurableDeadLetters.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ items: [letter] });
        }),
    );
    await act(async () => {
      void client.invalidateQueries({ queryKey: ["tasks", "work-run-dead-letter"] });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.textContent).toContain("Checking for changes…");
    expect(container.textContent).not.toContain("Checking the current recovery record…");
    expect(container.textContent).not.toContain("No single unresolved failed delivery");
    expect(button("Recover").disabled).toBe(true);
    await act(async () => release());
    await vi.waitFor(() => expect(button("Recover").disabled).toBe(false));
  });
});
