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

  const tools = () => container.querySelector<HTMLDetailsElement>('details[aria-label="Tool activity for this turn"]')!;
  const operatorToggles = (open: boolean) =>
    act(() => {
      tools().open = open;
      tools().dispatchEvent(new Event("toggle"));
    });

  it("keeps an operator-opened tool list open after streaming ends (CH-39)", () => {
    const executed = toolRun({ bytesWritten: 1 });
    act(() =>
      root.render(<ChatTurnDetails turn={turnWith([executed])} streaming readOnly={false} actions={actions} />),
    );
    expect(tools().open).toBe(true);
    operatorToggles(false);
    operatorToggles(true);
    render(turnWith([executed]));
    expect(tools().open).toBe(true);
  });

  it("keeps the list open while a turn resumed after an approval is still running, then folds it", () => {
    const executed = toolRun({ bytesWritten: 1 });
    const running = { ...turnWith([executed]), trace: { status: "running" } } as unknown as ChatThreadTurnRecord;
    act(() => root.render(<ChatTurnDetails turn={running} streaming readOnly={false} actions={actions} />));
    expect(tools().open).toBe(true);
    // The Gateway resumes an approved turn without a browser stream: not streaming, but not finished either.
    act(() => root.render(<ChatTurnDetails turn={running} streaming={false} readOnly={false} actions={actions} />));
    expect(tools().open).toBe(true);
    render(turnWith([executed]));
    expect(tools().open).toBe(false);
  });

  it("folds a list that only opened for streaming once the turn settles cleanly", () => {
    const executed = toolRun({ bytesWritten: 1 });
    act(() =>
      root.render(<ChatTurnDetails turn={turnWith([executed])} streaming readOnly={false} actions={actions} />),
    );
    expect(tools().open).toBe(true);
    render(turnWith([executed]));
    expect(tools().open).toBe(false);
  });

  it("leaves the list folded for a Code Mode request the card above reports", () => {
    const request = { ...toolRun({}), toolName: "code_mode.request", args: { goal: "read a file" } };
    // A turn parked on the request: the card asks, so the list does not open beside it.
    const parked = {
      ...turnWith([{ ...request, status: "approval_required" } as ChatToolRunRecord]),
      trace: { status: "waiting_for_approval" },
    } as unknown as ChatThreadTurnRecord;
    render(parked);
    expect(tools().open).toBe(false);
    // After Deny or Run it the same turn continues without a browser stream; the card already states the request.
    const continuing = (run: ChatToolRunRecord) =>
      ({ ...turnWith([run]), trace: { status: "running" } }) as unknown as ChatThreadTurnRecord;
    const denied = { ...request, status: "blocked", error: "Denied by the operator." } as ChatToolRunRecord;
    render(continuing(denied));
    expect(tools().open).toBe(false);
    // Denied (blocked) and failed requests are already stated by the Code Mode card in the reply.
    render(turnWith([denied]));
    expect(tools().open).toBe(false);
    render(parked);
    const ran = { ...request, result: { status: "completed", value: 3 } } as ChatToolRunRecord;
    render(continuing({ ...ran, status: "started" } as ChatToolRunRecord));
    expect(tools().open).toBe(false);
    render(continuing(ran));
    expect(tools().open).toBe(false);
    render(turnWith([ran]));
    expect(tools().open).toBe(false);
    render(turnWith([{ ...request, result: { status: "failed", error: "Code Mode is off." } } as ChatToolRunRecord]));
    expect(tools().open).toBe(false);
    // Another tool that needs attention still opens it.
    render(turnWith([{ ...toolRun({}), status: "blocked" } as ChatToolRunRecord]));
    expect(tools().open).toBe(true);
  });

  it.each([
    ["denied", { status: "blocked", error: "Denied by the operator." }, "started"],
    ["failed", { result: { status: "failed", error: "Code Mode is off." } }, "approval_required"],
  ])(
    "opens the list while a turn with a %s and a later Code Mode request continues, as the card reports only the later",
    (_label, earlier, laterStatus) => {
      const request = { ...toolRun({}), toolName: "code_mode.request", args: { goal: "read a file" } };
      const runs = [
        { ...request, ...earlier },
        { ...request, toolRunId: "tool-run-2", status: laterStatus },
      ] as ChatToolRunRecord[];
      render({ ...turnWith(runs), trace: { status: "running" } } as unknown as ChatThreadTurnRecord);
      expect(tools().open).toBe(true);
    },
  );
});

describe("ChatTurnDetails tool rows", () => {
  it("reads a Code Mode request whose code failed as Failed, with its reason", () => {
    const failed = {
      ...toolRun({ runId: "r1", status: "failed", error: "Code Mode is off.", durationMs: 0 }),
      toolName: "code_mode.request",
      args: { goal: "read a file" },
      // An approved tool call that settled records empty guidance.
      failureGuidance: "",
    } as ChatToolRunRecord;
    render(turnWith([failed]));
    const summary = container.querySelector('details[aria-label="Tool activity for this turn"] > summary')!;
    expect(summary.textContent).toContain("Tried to use 1 tool");
    expect(summary.textContent).not.toContain("done");
    const row = container.querySelector('[data-tool-run-id="tool-run-1"]')!;
    expect(row.textContent).toContain("Failed");
    expect(row.textContent).toContain("Code Mode is off.");
  });

  it("says why a Code Mode request failed in plain words, with its recorded error under technical details", () => {
    const error =
      "WRAPPER_EXECUTION_FAILED: Wrapper docs.extract_text did not execute: execution error: Path is outside read allowlist: /tmp/a.pdf";
    const failed = {
      ...toolRun({ runId: "r1", status: "failed", error, durationMs: 0 }),
      toolName: "code_mode.request",
      args: { goal: "read a file" },
    } as ChatToolRunRecord;
    const row = () => container.querySelector('[data-tool-run-id="tool-run-1"]')!;
    render(turnWith([failed]));
    expect(row().textContent).toContain("The code couldn't read a file.");
    expect(row().textContent).not.toContain("WRAPPER_EXECUTION_FAILED");
    preferences.showTechnicalDetails = true;
    try {
      render(turnWith([{ ...failed }]));
      expect(row().textContent).toContain("Recorded error");
      expect(row().textContent).toContain(error);
    } finally {
      preferences.showTechnicalDetails = false;
    }
  });

  it("names what a call touched, how long it took and the lines it changed", () => {
    const edit = {
      ...toolRun({ bytesWritten: 1 }),
      toolName: "fs.patch",
      args: { path: "src/hero.css", oldText: "a {}\n", newText: "a { color: red; }\nb {}\n" },
    } as ChatToolRunRecord;
    render(turnWith([edit]));
    const summary = container.querySelector('details[aria-label="Tool activity for this turn"] > summary')!;
    expect(summary.textContent).toContain("Changed hero.css");
    const row = container.querySelector('[data-tool-run-id="tool-run-1"]')!;
    expect(row.querySelector('[title="src/hero.css"]')?.textContent).toBe("hero.css");
    // A real space, not just a margin, so a screen reader does not run the name and target together.
    expect(row.textContent).toContain("Edit file hero.css");
    expect(row.textContent).toContain("+2 −1");
    expect(row.textContent).toContain("2 lines added, 1 line removed");
    expect(row.textContent).toContain("1 s");
  });
});

describe("ChatTurnDetails retried tools", () => {
  const attempt = (id: string, status: ChatToolRunRecord["status"], error?: string) =>
    ({ ...toolRun({}), toolRunId: id, toolName: "shell.exec", status, error }) as ChatToolRunRecord;

  it("shows back-to-back tries of a failed tool as one row and keeps the failures listed", () => {
    render(
      turnWith([
        attempt("a", "failed", "exit code 1"),
        attempt("b", "failed", "exit code 2"),
        attempt("c", "executed"),
      ]),
    );
    const rows = container.querySelectorAll('details[aria-label="Tool activity for this turn"] > ul > li');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.getAttribute("data-tool-run-id")).toBe("c");
    expect(rows[0]!.textContent).toContain("3 tries");
    expect(rows[0]!.textContent).toContain("2 earlier tries");
    expect([...rows[0]!.querySelectorAll("ol > li")].map((li) => li.getAttribute("data-tool-run-id"))).toEqual([
      "a",
      "b",
    ]);
    // An earlier try keeps its own target and effect note: a failed try may still have had an outside effect.
    render(
      turnWith([
        { ...attempt("a", "failed", "exit code 1"), args: { command: "pnpm deploy" }, effectOutcomeKind: "uncertain" },
        attempt("b", "executed"),
      ] as ChatToolRunRecord[]),
    );
    const earlier = container.querySelector('[data-tool-run-id="a"]')!;
    expect(earlier.querySelector('[title="pnpm deploy"]')?.textContent).toBe("pnpm deploy");
    expect(earlier.textContent).toContain("Automatic replay is suppressed.");
    render(
      turnWith([
        attempt("a", "failed", "exit code 1"),
        attempt("b", "failed", "exit code 2"),
        attempt("c", "executed"),
      ]),
    );
    // The summary still counts every call, failures included.
    expect(
      container.querySelector('details[aria-label="Tool activity for this turn"] > summary')!.textContent,
    ).toContain("3 tool calls");
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
