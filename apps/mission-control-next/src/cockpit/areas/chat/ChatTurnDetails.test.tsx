// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { APPROVAL_EXPIRY_ACTOR_ID, type ChatThreadTurnRecord, type ChatToolRunRecord } from "@goatcitadel/contracts";
import { fetchApproval } from "@goatcitadel/mission-control-shared/api/approvals";
import { ChatTurnDetails } from "./ChatTurnDetails";

vi.mock("@goatcitadel/mission-control-shared/hooks/useMediaQuery", () => ({ useMediaQuery: () => false }));
vi.mock("@goatcitadel/mission-control-shared/api/approvals", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchApproval: vi.fn(),
}));
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

describe("ChatTurnDetails approval decision (#499)", () => {
  const decidedAt = "2026-10-24T17:30:36.965Z";
  const gated = (status: ChatToolRunRecord["status"]) =>
    ({
      ...toolRun({ path: "Sandbox_Test_Brief.pdf" }),
      toolName: "documents.create",
      status,
      approvalId: "approval-1",
    }) as ChatToolRunRecord;
  const record = (overrides: Record<string, unknown>) => ({
    approvalId: "approval-1",
    kind: "tool_invoke",
    status: "approved",
    riskLevel: "caution",
    createdAt: "2026-10-24T17:30:25.275Z",
    resolvedAt: decidedAt,
    resolvedBy: "auth:operator",
    explanationStatus: "not_requested",
    ...overrides,
  });
  async function renderWithQuery(turn: ChatThreadTurnRecord) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <ChatTurnDetails turn={turn} streaming={false} readOnly={false} actions={actions} />
        </QueryClientProvider>,
      ),
    );
  }
  const row = () => container.querySelector('[data-tool-run-id="tool-run-1"]')!;
  afterEach(() => vi.mocked(fetchApproval).mockReset());

  it("keeps who approved and when on the tool row after the approval card clears", async () => {
    vi.mocked(fetchApproval).mockResolvedValue(record({}) as never);
    await renderWithQuery(turnWith([gated("executed")]));
    await vi.waitFor(() => expect(row().textContent).toContain("Approved by an operator"));
    expect(fetchApproval).toHaveBeenCalledWith("approval-1", expect.objectContaining({ workspaceId: "default" }));
    expect(row().querySelector("time")?.getAttribute("dateTime")).toBe(decidedAt);
    // The decision line states the decision only; the row's own status still reports what the tool did.
    expect(row().textContent).toContain("Done");
  });

  it("says a decision expired without an operator instead of crediting one", async () => {
    vi.mocked(fetchApproval).mockResolvedValue(
      record({ status: "rejected", resolvedBy: APPROVAL_EXPIRY_ACTOR_ID }) as never,
    );
    await renderWithQuery(turnWith([gated("blocked")]));
    await vi.waitFor(() => expect(row().textContent).toContain("Expired without an operator decision"));
    expect(row().textContent).not.toContain("by an operator");
  });

  it("does not read the record while the decision is still waiting in the approval card", async () => {
    await renderWithQuery(turnWith([gated("approval_required")]));
    expect(fetchApproval).not.toHaveBeenCalled();
    expect(row().textContent).not.toMatch(/Approved|Needed approval/);
  });

  it("says the tool needed approval when its decision record cannot be read", async () => {
    vi.mocked(fetchApproval).mockRejectedValue(new Error("offline"));
    await renderWithQuery(turnWith([gated("executed")]));
    await vi.waitFor(() =>
      expect(row().textContent).toContain("Needed approval. The decision record could not be loaded."),
    );
  });
});

describe("ChatTurnDetails tool name (#499)", () => {
  const documentRun = {
    ...toolRun({ path: "Sandbox_Test_Brief.pdf" }),
    toolName: "documents.create",
  } as ChatToolRunRecord;

  it("names the tool for the operator and keeps the raw tool name in technical details", () => {
    preferences.showTechnicalDetails = true;
    try {
      render(turnWith([documentRun]));
      const row = container.querySelector('[data-tool-run-id="tool-run-1"]')!;
      expect(row.firstElementChild?.textContent).toBe("Create document");
      const details = [...row.querySelectorAll("details")].find((node) =>
        node.querySelector("summary")?.textContent?.includes("Technical details"),
      );
      expect(details?.textContent).toContain("documents.create");
    } finally {
      preferences.showTechnicalDetails = false;
    }
  });

  it("does not show the raw tool name on the row when technical details are off", () => {
    render(turnWith([documentRun]));
    expect(container.textContent).not.toContain("documents.create");
  });
});

describe("ChatTurnDetails older-turn actions", () => {
  const actionsWrapper = () =>
    container.querySelector('button[aria-label="More message actions"]')!.parentElement!.parentElement!;

  it("shows the action row fully on the latest turn", () => {
    render(turnWith([]));
    expect(actionsWrapper().className).not.toContain("opacity-0");
  });

  it("keeps an older turn's actions in the page, hidden until hover or keyboard focus", () => {
    act(() =>
      root.render(
        <ChatTurnDetails turn={turnWith([])} streaming={false} readOnly={false} actions={actions} latest={false} />,
      ),
    );
    const wrapper = actionsWrapper();
    expect(wrapper.className).toContain("opacity-0");
    expect(wrapper.className).toContain("group-hover/turn:opacity-100");
    expect(wrapper.className).toContain("group-focus-within/turn:opacity-100");
    expect(wrapper.hasAttribute("hidden")).toBe(false);
    expect(wrapper.className).not.toContain("invisible");
    const buttons = [...wrapper.querySelectorAll("button")].map((button) => button.textContent?.trim());
    expect(buttons).toEqual(expect.arrayContaining(["Copy answer", "More"]));
  });
});
