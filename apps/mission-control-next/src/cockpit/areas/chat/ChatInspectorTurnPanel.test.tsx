// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatThreadTurnRecord } from "@goatcitadel/contracts";
import { ChatInspectorTurnPanel } from "./ChatInspectorTurnPanel";

// Catalog labels read the query cache; the model id stands in for its name here.
// Sign-in modes come from the same LLM config read as the provider labels.
const authModes = vi.hoisted((): Record<string, string | undefined> => ({}));
vi.mock("../../data/use-model-label", () => ({
  useModelLabel: (_providerId?: string, modelId?: string) => modelId ?? "Unknown model",
  useProviderAuthMode: (providerId?: string) => (providerId ? authModes[providerId] : undefined),
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

describe("ChatInspectorTurnPanel cost (#499)", () => {
  afterEach(() => {
    for (const key of Object.keys(authModes)) delete authModes[key];
  });
  const cliTurn = () =>
    turnWith({
      status: "completed",
      routing: { effectiveProviderId: "claude-code-cli", effectiveModel: "claude-sonnet-5-5" },
      completion: { status: "complete", repaired: false, usage: { inputTokens: 1200, outputTokens: 300 } },
    });

  it("says a subscription sign-in's turn is included in the subscription instead of Unknown", () => {
    authModes["claude-code-cli"] = "claude-code-cli-login";
    act(() => root.render(<ChatInspectorTurnPanel selectedTurn={cliTurn()} />));
    expect(row("Cost")).toBe("Included in Claude subscription");
  });

  it("does not infer subscription billing from the provider id alone", () => {
    // No sign-in mode was read for the provider, so its billing is not established.
    act(() => root.render(<ChatInspectorTurnPanel selectedTurn={cliTurn()} />));
    expect(row("Cost")).toBe("Unknown");
  });

  it("keeps Unknown for an API-key provider that recorded no cost", () => {
    authModes["claude-code-cli"] = "api-key";
    act(() => root.render(<ChatInspectorTurnPanel selectedTurn={cliTurn()} />));
    expect(row("Cost")).toBe("Unknown");
  });
});

describe("ChatInspectorTurnPanel chosen because", () => {
  it("says a recorded fallback was a fallback, without printing ids", () => {
    act(() =>
      root.render(
        <ChatInspectorTurnPanel
          selectedTurn={turnWith({
            status: "completed",
            routing: {
              primaryProviderId: "p1",
              primaryModel: "model-a",
              effectiveProviderId: "p2",
              effectiveModel: "model-b",
              fallbackUsed: true,
              fallbackReason: "The provider was unavailable",
            },
          })}
        />,
      ),
    );
    expect(row("Chosen because")).toBe("Fell back from model-a because the provider was unavailable");
  });

  it("names the selected model when nothing changed and stays neutral when nothing is recorded", () => {
    act(() =>
      root.render(
        <ChatInspectorTurnPanel
          selectedTurn={turnWith({
            status: "completed",
            routing: { primaryModel: "model-a", effectiveModel: "model-a" },
          })}
        />,
      ),
    );
    expect(row("Chosen because")).toBe("The requested model; no fallback was needed");
    act(() => root.render(<ChatInspectorTurnPanel selectedTurn={turnWith({ status: "completed", model: "" })} />));
    expect(row("Chosen because")).toBe("Selected by routing rules");
  });
});
