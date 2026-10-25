// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatThreadTurnRecord } from "@goatcitadel/contracts";
import { ChatInspectorTurnPanel } from "./ChatInspectorTurnPanel";

// Catalog labels read the query cache; the model id stands in for its name here.
vi.mock("../../data/use-model-label", () => ({
  useModelLabel: (_providerId?: string, modelId?: string) => modelId ?? "Unknown model",
}));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function turnWith(trace: Record<string, unknown>): ChatThreadTurnRecord {
  return {
    turnId: "turn-1",
    trace: { sessionId: "sess-1", model: "model-a", startedAt: "2026-10-25T00:30:20.697Z", ...trace },
    toolRuns: [],
    citations: [],
  } as unknown as ChatThreadTurnRecord;
}

function row(label: string): string | undefined {
  const term = [...container.querySelectorAll("dt")].find((node) => node.textContent === label);
  return term?.nextElementSibling?.textContent ?? undefined;
}

describe("ChatInspectorTurnPanel timing (#499)", () => {
  it("shows the whole turn's recorded time and the model-call time as separate, named figures", () => {
    // The live turn: 21 s from send to finish, 12 s of it waiting on an approval, one 4 s model call.
    act(() =>
      root.render(
        <ChatInspectorTurnPanel
          selectedTurn={turnWith({
            status: "completed",
            finishedAt: "2026-10-25T00:30:41.811Z",
            completion: { status: "complete", repaired: false, latencyMs: 4154 },
          })}
        />,
      ),
    );
    expect(row("Total time")).toBe("21 s");
    expect(row("Model time")).toBe("4 s");
    expect(row("Duration")).toBeUndefined();
  });

  it("does not report a total for a turn that has not finished", () => {
    act(() => root.render(<ChatInspectorTurnPanel selectedTurn={turnWith({ status: "waiting_for_approval" })} />));
    expect(row("Total time")).toBe("Not finished");
    expect(row("Model time")).toBe("Not recorded");
  });

  it("says a finished turn's total is not recorded when its finish time is missing", () => {
    act(() => root.render(<ChatInspectorTurnPanel selectedTurn={turnWith({ status: "completed" })} />));
    expect(row("Total time")).toBe("Not recorded");
  });
});
