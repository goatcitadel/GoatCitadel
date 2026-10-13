// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatThreadTurnRecord, ChatToolRunRecord } from "@goatcitadel/contracts";
import { ChatTurnDetails } from "./ChatTurnDetails";

vi.mock("@goatcitadel/mission-control-shared/hooks/useMediaQuery", () => ({ useMediaQuery: () => false }));

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

  it("renders no advisory list when the tool result carries none", () => {
    render(turnWith([toolRun({ bytesWritten: 120 })]));

    expect(container.querySelector('[aria-label="Design advisories"]')).toBeNull();
    expect(container.textContent).not.toContain("Design advisories");
  });
});
