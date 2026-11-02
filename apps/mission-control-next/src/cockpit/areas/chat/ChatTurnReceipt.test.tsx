// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatThreadTurnRecord } from "@goatcitadel/contracts";
import { InspectorProvider, useInspector } from "../../app/inspector";
import { TurnReceipt } from "./ChatTurnReceipt";

// Catalog labels read the query cache; the model id stands in for its name here.
vi.mock("../../data/use-model-label", () => ({
  useModelLabel: (_providerId?: string, modelId?: string) => modelId ?? "Unknown model",
}));

let root: Root;
let container: HTMLDivElement;
let inspector: ReturnType<typeof useInspector>;

function Probe() {
  inspector = useInspector();
  return null;
}

const turn = {
  turnId: "turn-1",
  trace: {
    status: "completed",
    model: "model-a",
    completion: { latencyMs: 1200, usage: { costUsd: 0.01, costSource: "provider" } },
  },
  toolRuns: [],
  citations: [],
} as unknown as ChatThreadTurnRecord;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("TurnReceipt", () => {
  it("opens the Message tab of the Chat inspector from a receipt", async () => {
    const onInspectTurn = vi.fn();
    await act(async () =>
      root.render(
        <InspectorProvider>
          <TurnReceipt turn={turn} onInspectTurn={onInspectTurn} />
          <Probe />
        </InspectorProvider>,
      ),
    );
    const receipt = container.querySelector("button")!;
    // The accessible name starts with the visible receipt.
    expect(receipt.textContent).toMatch(/^model-a · .+ · Open message details$/);
    await act(async () => receipt.click());
    // The Chat area owns the inspector (source "chat") and opens its Message tab for this turn; the receipt no longer
    // opens a second, receipt-only details view.
    expect(onInspectTurn).toHaveBeenCalledExactlyOnceWith("turn-1");
    expect(inspector.content).toBeNull();
  });

  it("says what Review answer found, and nothing when no review ran", async () => {
    const reviewed = (answerReview: unknown) =>
      ({ ...turn, trace: { ...turn.trace, reflection: { answerReview } } }) as unknown as ChatThreadTurnRecord;
    await act(async () =>
      root.render(<TurnReceipt turn={reviewed({ outcome: "passed", issues: [], action: "recorded" })} />),
    );
    expect(container.textContent).toContain("Reviewed: no issues");
    await act(async () =>
      root.render(
        <TurnReceipt turn={reviewed({ outcome: "issues_found", issues: ["a", "b"], action: "noted_in_answer" })} />,
      ),
    );
    expect(container.textContent).toContain("Reviewed: 2 issues, noted in the answer");
    await act(async () => root.render(<TurnReceipt turn={turn} />));
    expect(container.textContent).not.toContain("Review");
  });

  it("is plain text when nothing can open the inspector", async () => {
    await act(async () => root.render(<TurnReceipt turn={turn} />));
    expect(container.querySelector("button")).toBeNull();
    expect(container.textContent).toContain("model-a");
  });

  // #499: a turn that waited 12 s on an approval recorded 4 s of model time; the receipt read "1 tool · 4 s".
  it("reports the whole turn's recorded time, not only the time spent in model calls", async () => {
    const approvedTurn = {
      ...turn,
      trace: {
        ...turn.trace,
        startedAt: "2026-10-25T00:30:20.697Z",
        finishedAt: "2026-10-25T00:30:41.811Z",
        completion: { latencyMs: 4154 },
      },
      toolRuns: [{ toolRunId: "tool-1" }],
    } as unknown as ChatThreadTurnRecord;
    await act(async () => root.render(<TurnReceipt turn={approvedTurn} />));
    expect(container.textContent).toBe("model-a · 1 tool · 21 s total");
  });

  it("names model time as model time when the turn's finish was not recorded", async () => {
    await act(async () => root.render(<TurnReceipt turn={turn} />));
    expect(container.textContent).toContain("1 s model time");
    expect(container.textContent).not.toContain("total");
  });
});
