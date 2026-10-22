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

  it("is plain text when nothing can open the inspector", async () => {
    await act(async () => root.render(<TurnReceipt turn={turn} />));
    expect(container.querySelector("button")).toBeNull();
    expect(container.textContent).toContain("model-a");
  });
});
