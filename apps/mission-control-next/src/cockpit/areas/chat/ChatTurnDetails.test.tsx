// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatThreadTurnRecord, ChatToolRunRecord } from "@goatcitadel/contracts";
import { ChatTurnDetails } from "./ChatTurnDetails";

vi.mock("@goatcitadel/mission-control-shared/hooks/useMediaQuery", () => ({ useMediaQuery: () => false }));
const preferences = vi.hoisted(() => ({ showTechnicalDetails: false }));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const useUiPreferences = actual.useUiPreferences as () => Record<string, unknown>;
  return { ...actual, useUiPreferences: () => ({ ...useUiPreferences(), ...preferences }) };
});

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

function toolRun(result: Record<string, unknown>): ChatToolRunRecord {
  return {
    toolRunId: "tool-run-1",
    turnId: "turn-1",
    sessionId: "sess-1",
    toolName: "fs.write",
    status: "executed",
    args: { path: "src/hero.css" },
    result,
    startedAt: "2026-10-12T00:00:00.000Z",
    finishedAt: "2026-10-12T00:00:01.000Z",
  } as unknown as ChatToolRunRecord;
}

function turnWith(toolRuns: ChatToolRunRecord[]): ChatThreadTurnRecord {
  return {
    turnId: "turn-1",
    assistantMessage: { content: "Done." },
    trace: { status: "completed" },
    branch: { siblingTurnIds: [], activeSiblingIndex: 0, siblingCount: 1 },
    citations: [],
    toolRuns,
  } as unknown as ChatThreadTurnRecord;
}

const actions = {
  onRetryTurn: vi.fn(),
  onStartNewThreadFromTurn: vi.fn(),
  onSwitchBranch: vi.fn(),
  onEditTurn: vi.fn(),
  onOpenRunDetails: vi.fn(),
  onCreateGeneratedArtifact: vi.fn(),
  onOpenGeneratedArtifact: vi.fn(),
} as unknown as Parameters<typeof ChatTurnDetails>[0]["actions"];

function render(turn: ChatThreadTurnRecord) {
  act(() => root.render(<ChatTurnDetails turn={turn} streaming={false} readOnly={false} actions={actions} />));
}

describe("ChatTurnDetails design advisories", () => {
  it("lists each advisory under the tool run with its line and an informational label", () => {
    render(
      turnWith([
        toolRun({
          bytesWritten: 120,
          designAdvisories: [
            { ruleId: "gradient-text", line: 3, summary: "Gradient text; carry emphasis with weight or size." },
            { ruleId: "kicker-eyebrow", line: 9, summary: "Kicker or eyebrow label above a heading." },
          ],
        }),
      ]),
    );

    const list = container.querySelector('[aria-label="Design advisories"]');
    expect(list).not.toBeNull();
    expect(container.textContent).toContain("Design advisories (2) · informational");
    expect(container.textContent).toContain("Gradient text; carry emphasis with weight or size.");
    expect(container.textContent).toContain("Kicker or eyebrow label above a heading.");
    expect(container.textContent).toContain("line 3");
    expect(container.textContent).toContain("line 9");
  });

  it("labels patch-scoped lines as lines of the patch text, not the file", () => {
    render(
      turnWith([
        toolRun({
          designAdvisories: [{ ruleId: "glass-by-default", line: 2, summary: "Backdrop blur.", scope: "patch" }],
        }),
      ]),
    );

    expect(container.textContent).toContain("line 2 of the patch text");
    expect(container.textContent).not.toContain("(line 2)");
  });

  it("keeps a technical tool error reachable under Technical details, with only the summary in the row", () => {
    const failed = {
      ...toolRun({}),
      status: "failed",
      error: "ECONNRESET at Socket.onread (node:net:1137:14)",
    } as unknown as ChatToolRunRecord;
    preferences.showTechnicalDetails = false;
    render(turnWith([failed]));
    expect(container.textContent).not.toContain("ECONNRESET");
    preferences.showTechnicalDetails = true;
    render(turnWith([{ ...failed }]));
    expect(container.textContent).toContain("Recorded error");
    expect(container.textContent).toContain("ECONNRESET at Socket.onread");
    preferences.showTechnicalDetails = false;
  });

  it("renders no advisory list when the tool result carries none", () => {
    render(turnWith([toolRun({ bytesWritten: 120 })]));

    expect(container.querySelector('[aria-label="Design advisories"]')).toBeNull();
    expect(container.textContent).not.toContain("Design advisories");
  });
});

describe("ChatTurnDetails copy feedback (CH-31)", () => {
  it("confirms a copy once, swaps the button label, and clears both after a moment", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    try {
      render(turnWith([]));
      const copy = () =>
        [...container.querySelectorAll("button")].find((b) => /Copy answer|Copied/.test(b.textContent ?? ""));
      await act(async () => copy()!.click());
      expect(writeText).toHaveBeenCalledWith("Done.");
      expect(container.querySelector('[role="status"]')?.textContent).toBe("Answer copied.");
      expect(copy()?.textContent).toBe("Copied");
      await act(async () => vi.advanceTimersByTime(2000));
      expect(container.querySelector('[role="status"]')).toBeNull();
      expect(copy()?.textContent).toBe("Copy answer");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps an operator-opened tool list open after streaming ends (CH-39)", () => {
    const executed = toolRun({ bytesWritten: 1 });
    act(() =>
      root.render(<ChatTurnDetails turn={turnWith([executed])} streaming readOnly={false} actions={actions} />),
    );
    const tools = () =>
      container.querySelector<HTMLDetailsElement>('details[aria-label="Tool activity for this turn"]')!;
    expect(tools().open).toBe(true);
    render(turnWith([executed]));
    expect(tools().open).toBe(true);
  });
});
