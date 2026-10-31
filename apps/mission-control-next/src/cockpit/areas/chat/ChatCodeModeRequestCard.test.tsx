// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatThreadTurnRecord, ChatToolRunRecord } from "@goatcitadel/contracts";
import { __resetInboxApprovalAttemptsForTests } from "../inbox/inbox-approval-attempts";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { ChatCodeModeRequestCard } from "./ChatCodeModeRequestCard";

const api = vi.hoisted(() => ({
  fetchApproval: vi.fn(),
  resolveApproval: vi.fn(),
  fetchSettings: vi.fn(),
  patchSettings: vi.fn(),
  fetchCodeModeReadiness: vi.fn(),
  fetchCodeModeRun: vi.fn(),
  approvePlanInPlace: vi.fn(),
  keepCodeModeRun: vi.fn(),
  promoteCapabilityCandidate: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/approvals", () => ({
  fetchApproval: api.fetchApproval,
  fetchApprovalReplay: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  resolveApproval: api.resolveApproval,
  fetchSettings: api.fetchSettings,
  patchSettings: api.patchSettings,
  fetchCodeModeReadiness: api.fetchCodeModeReadiness,
  fetchCodeModeRun: api.fetchCodeModeRun,
  keepCodeModeRun: api.keepCodeModeRun,
  promoteCapabilityCandidate: api.promoteCapabilityCandidate,
}));
vi.mock("./channel-setup/approve-plan-in-place", () => ({ approvePlanInPlace: api.approvePlanInPlace }));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({ activeWorkspaceId: "default", showTechnicalDetails: false }),
}));

const GOAL = "read the text of saturday-plan.pdf";
const SOURCE = "return await capabilities.docs.extract_text({ path: input.path });";

function approval(status: "pending" | "approved" | "rejected" = "pending") {
  return {
    approvalId: "approval-1",
    kind: "code_mode.request",
    status,
    riskLevel: "caution",
    payload: { goal: GOAL, source: SOURCE },
    preview: { toolName: "code_mode.request" },
    linkage: { workspaceId: "default", sessionId: "session-1", turnId: "turn-1" },
    createdAt: "2026-10-30T00:00:00Z",
  };
}

function turnWith(run: Partial<ChatToolRunRecord>): ChatThreadTurnRecord {
  return {
    turnId: "turn-1",
    toolRuns: [
      {
        toolRunId: "run-1",
        turnId: "turn-1",
        sessionId: "session-1",
        toolName: "code_mode.request",
        status: "approval_required",
        approvalId: "approval-1",
        startedAt: "2026-10-30T00:00:00Z",
        args: { goal: GOAL, source: SOURCE, reads: ["saturday-plan.pdf"] },
        ...run,
      },
    ],
  } as unknown as ChatThreadTurnRecord;
}

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
const onRefreshThread = vi.fn();

async function render(turn: ChatThreadTurnRecord) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ChatCodeModeRequestCard turn={turn} workspaceId="default" onRefreshThread={onRefreshThread} />
      </QueryClientProvider>,
    ),
  );
}
const waitFor = (check: () => void) => vi.waitFor(check, { timeout: 15_000 });
const button = (label: string) => [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(label));
const waitForButton = (label: string) => waitFor(() => expect(button(label)).toBeDefined());

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  api.fetchApproval.mockResolvedValue(approval());
  api.fetchCodeModeReadiness.mockResolvedValue({
    enabled: true,
    sandboxEnabled: true,
    sandboxSupported: true,
    canRun: true,
  });
  api.resolveApproval.mockImplementation(async (_id: string, decision: string) => ({
    approval: approval(decision === "approve" ? "approved" : "rejected"),
    effects: [],
  }));
});

afterEach(() => {
  __resetInboxApprovalAttemptsForTests();
  act(() => root.unmount());
  container.remove();
  client.clear();
  vi.clearAllMocks();
});

describe("ChatCodeModeRequestCard", { timeout: 30_000 }, () => {
  it("renders nothing when the turn has no code_mode.request run", async () => {
    await render(turnWith({ toolName: "web.search" }));
    expect(container.textContent).toBe("");
  });

  it("shows one line and a Run it button", async () => {
    await render(turnWith({}));
    await waitForButton("Run it");
    expect(container.textContent).toContain(`Run code to ${GOAL}`);
    expect(container.querySelector("details")?.open).toBe(false);
    expect(container.textContent).not.toMatch(/[0-9a-f]{32,}/);
    expect(button("Deny")).toBeDefined();
  });

  /** The row's own text, without the folded Details. */
  const rowText = () =>
    [...(container.firstElementChild?.children ?? [])]
      .filter((child) => child.tagName !== "DETAILS")
      .map((child) => child.textContent)
      .join(" ");

  it("names the files the code reads on the row, and shows its input in Details", async () => {
    const reads = ["verification/saturday-plan.pdf", "C:\\notes\\b.txt", "c.csv", "d.json"];
    await render(turnWith({ args: { goal: GOAL, source: SOURCE, reads, input: { path: reads[0] } } }));
    await waitForButton("Run it");
    expect(rowText()).toContain("Reads saturday-plan.pdf, b.txt, c.csv and 1 more");
    expect(rowText()).not.toContain("verification/");
    const details = container.querySelector("details")!;
    expect(details.textContent).toContain("verification/saturday-plan.pdf");
    expect(details.textContent).toContain('{"path":"verification/saturday-plan.pdf"}');
  });

  it("names an attachment by its file name, and never shows its id on the row", async () => {
    const attachmentId = "0b6f3c2e-8d1a-4e5f-9a7b-1c2d3e4f5a6b";
    const unknownId = "9f8e7d6c-5b4a-4321-8fed-cba987654321";
    const turn = turnWith({ args: { goal: GOAL, source: SOURCE, reads: [attachmentId, unknownId] } });
    await render({
      ...turn,
      userMessage: { attachments: [{ attachmentId, fileName: "plan.pdf", mimeType: "application/pdf", sizeBytes: 1 }] },
    } as unknown as ChatThreadTurnRecord);
    await waitForButton("Run it");
    expect(rowText()).toContain("Reads plan.pdf, an attachment");
    expect(rowText()).not.toContain(unknownId);
  });

  it("shows no Reads line when the request reads no files", async () => {
    await render(turnWith({ args: { goal: GOAL, source: SOURCE } }));
    await waitForButton("Run it");
    expect(rowText()).not.toContain("Reads");
  });

  it("Run it approves once and refreshes", async () => {
    await render(turnWith({}));
    await waitForButton("Run it");
    await act(async () => button("Run it")!.click());
    await waitFor(() => expect(onRefreshThread).toHaveBeenCalled());
    expect(api.resolveApproval).toHaveBeenCalledTimes(1);
    expect(api.resolveApproval).toHaveBeenCalledWith("approval-1", "approve");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("refreshes the thread when the record settles before the approve call returns", async () => {
    // The Gateway runs the code before it answers the approve call, and its approval_resolved event refetches the
    // record first: the row turns to "Running code…" and the decision buttons unmount before they hear back.
    let finishApprove!: () => void;
    api.resolveApproval.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishApprove = () => resolve({ approval: approval("approved"), effects: [] });
        }),
    );
    await render(turnWith({}));
    await waitForButton("Run it");
    await act(async () => button("Run it")!.click());
    await waitFor(() => expect(api.resolveApproval).toHaveBeenCalledTimes(1));
    api.fetchApproval.mockResolvedValue(approval("approved"));
    await act(async () => client.invalidateQueries({ queryKey: ["approvals"] }));
    await waitFor(() => expect(container.textContent).toContain("Running code…"));
    await act(async () => finishApprove());
    await waitFor(() => expect(onRefreshThread).toHaveBeenCalled());
  });

  it("asks to choose again when the request changed before the click was checked", async () => {
    // The model's explanation lands on the record a few seconds after it is created.
    api.fetchApproval.mockResolvedValueOnce({ ...approval(), explanationStatus: "pending" });
    api.fetchApproval.mockResolvedValue({
      ...approval(),
      explanationStatus: "completed",
      explanation: { summary: "Reads one PDF." },
    });
    await render(turnWith({}));
    await waitForButton("Run it");
    await act(async () => button("Run it")!.click());
    await waitFor(() => expect(container.textContent).toContain("This request was updated. Choose again."));
    expect(api.resolveApproval).not.toHaveBeenCalled();
    // The row re-reads the updated record; the buttons then remount for it.
    await waitFor(() =>
      expect(client.getQueryData(["approvals", "record", "default", "approval-1"])).toMatchObject({
        explanationStatus: "completed",
      }),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    await act(async () => button("Run it")!.click());
    await waitFor(() => expect(api.resolveApproval).toHaveBeenCalledWith("approval-1", "approve"));
    await waitFor(() => expect(container.textContent).not.toContain("Choose again"));
  });

  it("Turn on Code Mode and run enables then approves", async () => {
    api.fetchCodeModeReadiness.mockResolvedValue({
      enabled: false,
      sandboxEnabled: false,
      sandboxSupported: true,
      canRun: false,
      reason: "code_mode_off",
    });
    api.fetchSettings.mockResolvedValue({ revision: 7, features: {} });
    const order: string[] = [];
    api.patchSettings.mockImplementation(async () => {
      order.push("patch");
      return { revision: 8, changePlanReceipt: { planId: "plan-1", status: "awaiting_approval", revision: 1 } };
    });
    api.approvePlanInPlace.mockImplementation(async () => {
      order.push("plan");
      return { kind: "completed", plan: {} };
    });
    api.resolveApproval.mockImplementation(async () => {
      order.push("approve");
      return { approval: approval("approved"), effects: [] };
    });
    await render(turnWith({}));
    await waitForButton("Turn on Code Mode and run");
    expect(container.textContent).toContain("Code Mode is off");
    await act(async () => button("Turn on Code Mode and run")!.click());
    await waitFor(() => expect(api.resolveApproval).toHaveBeenCalledWith("approval-1", "approve"));
    expect(api.patchSettings.mock.calls).toEqual([
      [{ expectedRevision: 7, features: { codeModeV1Enabled: true } }],
      [{ expectedRevision: 7, features: { codeModeHostSandboxEnabled: true } }],
    ]);
    expect(api.approvePlanInPlace).toHaveBeenCalledWith("plan-1", "default");
    expect(order).toEqual(["patch", "plan", "patch", "plan", "approve"]);
  });

  it("does not approve when turning Code Mode on fails, and shows the error", async () => {
    api.fetchCodeModeReadiness.mockResolvedValue({
      enabled: false,
      sandboxEnabled: false,
      sandboxSupported: true,
      canRun: false,
      reason: "sandbox_off",
    });
    api.fetchSettings.mockResolvedValue({ revision: 7, features: {} });
    api.patchSettings.mockRejectedValue(new Error("Settings changed elsewhere."));
    await render(turnWith({}));
    await waitForButton("Turn on Code Mode and run");
    await act(async () => button("Turn on Code Mode and run")!.click());
    await waitFor(() => expect(container.querySelector(`[role="alert"]`)).not.toBeNull());
    expect(api.resolveApproval).not.toHaveBeenCalled();
  });

  const codeModeOff = {
    enabled: false,
    sandboxEnabled: false,
    sandboxSupported: true,
    canRun: false,
    reason: "code_mode_off",
  };
  const codeModeOn = { enabled: true, sandboxEnabled: true, sandboxSupported: true, canRun: true };

  it("says it is turning Code Mode on, and links to Inbox when a step must be finished there", async () => {
    api.fetchCodeModeReadiness.mockResolvedValue(codeModeOff);
    api.fetchSettings.mockResolvedValue({ revision: 7, features: {} });
    api.patchSettings.mockResolvedValue({
      revision: 8,
      changePlanReceipt: { planId: "plan-1", status: "awaiting_approval", revision: 1 },
    });
    let finishPlan!: (value: unknown) => void;
    api.approvePlanInPlace.mockReturnValue(new Promise((resolve) => (finishPlan = resolve)));
    await render(turnWith({}));
    await waitForButton("Turn on Code Mode and run");
    await act(async () => button("Turn on Code Mode and run")!.click());
    await waitFor(() => expect(container.textContent).toContain("Turning on Code Mode…"));
    await act(async () => finishPlan({ kind: "elsewhere", plan: { planId: "plan-1" }, approvalId: "settings-1" }));
    await waitFor(() => expect(container.querySelector(`[role="alert"]`)).not.toBeNull());
    const alert = container.querySelector(`[role="alert"]`)!;
    expect(alert.textContent).toContain("needs one more step in Inbox");
    const link = alert.querySelector("a")!;
    expect(link.textContent).toBe("Approve it in Inbox");
    expect(link.getAttribute("href")).toContain("approvalId=settings-1");
    expect(api.resolveApproval).not.toHaveBeenCalled();
    // Readiness is read again, whatever the outcome.
    expect(api.fetchCodeModeReadiness.mock.calls.length).toBeGreaterThan(1);
  });

  it("asks to choose again when the request changed while Code Mode was being turned on", async () => {
    // The click is checked against the record first; the model's explanation lands while the switches are applied.
    api.fetchCodeModeReadiness.mockResolvedValue(codeModeOff);
    api.fetchSettings.mockResolvedValue({ revision: 7, features: {} });
    api.patchSettings.mockResolvedValue({
      revision: 8,
      changePlanReceipt: { planId: "plan-1", status: "awaiting_approval", revision: 1 },
    });
    let finishPlan!: (value: unknown) => void;
    api.approvePlanInPlace.mockReturnValueOnce(new Promise((resolve) => (finishPlan = resolve)));
    api.approvePlanInPlace.mockResolvedValue({ kind: "completed", plan: {} });
    await render(turnWith({}));
    await waitForButton("Turn on Code Mode and run");
    await act(async () => button("Turn on Code Mode and run")!.click());
    await waitFor(() => expect(api.approvePlanInPlace).toHaveBeenCalledTimes(1));
    api.fetchApproval.mockResolvedValue({ ...approval(), explanationStatus: "completed" });
    await act(async () => client.invalidateQueries({ queryKey: ["approvals"] }));
    await waitFor(() =>
      expect(client.getQueryData(["approvals", "record", "default", "approval-1"])).toMatchObject({
        explanationStatus: "completed",
      }),
    );
    // Let the buttons remount for the updated record before the switches finish.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    // Both switches are now on.
    api.fetchCodeModeReadiness.mockResolvedValue(codeModeOn);
    await act(async () => finishPlan({ kind: "completed", plan: {} }));
    await waitFor(() => expect(container.textContent).toContain("This request was updated. Choose again."));
    await waitForButton("Run it");
    expect(button("Turn on Code Mode and run")).toBeUndefined();
    expect(api.resolveApproval).not.toHaveBeenCalled();
  });

  it("keeps the Inbox link when the request changed while turning Code Mode on stopped at an Inbox step", async () => {
    api.fetchCodeModeReadiness.mockResolvedValue(codeModeOff);
    api.fetchSettings.mockResolvedValue({ revision: 7, features: {} });
    api.patchSettings.mockResolvedValue({
      revision: 8,
      changePlanReceipt: { planId: "plan-1", status: "awaiting_approval", revision: 1 },
    });
    let finishPlan!: (value: unknown) => void;
    api.approvePlanInPlace.mockReturnValueOnce(new Promise((resolve) => (finishPlan = resolve)));
    await render(turnWith({}));
    await waitForButton("Turn on Code Mode and run");
    await act(async () => button("Turn on Code Mode and run")!.click());
    await waitFor(() => expect(api.approvePlanInPlace).toHaveBeenCalledTimes(1));
    api.fetchApproval.mockResolvedValue({ ...approval(), explanationStatus: "completed" });
    await act(async () => client.invalidateQueries({ queryKey: ["approvals"] }));
    await waitFor(() =>
      expect(client.getQueryData(["approvals", "record", "default", "approval-1"])).toMatchObject({
        explanationStatus: "completed",
      }),
    );
    // Let the buttons remount for the updated record before the switch stops at its Inbox step.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    await act(async () => finishPlan({ kind: "elsewhere", plan: { planId: "plan-1" }, approvalId: "settings-1" }));
    await waitFor(() => expect(container.textContent).toContain("needs one more step in Inbox"));
    const link = [...container.querySelectorAll("a")].find((a) => a.textContent === "Approve it in Inbox");
    expect(link?.getAttribute("href")).toContain("approvalId=settings-1");
    expect(api.resolveApproval).not.toHaveBeenCalled();
  });

  it("unsupported sandbox offers only Deny", async () => {
    api.fetchCodeModeReadiness.mockResolvedValue({
      enabled: true,
      sandboxEnabled: true,
      sandboxSupported: false,
      canRun: false,
      reason: "sandbox_unsupported",
    });
    await render(turnWith({}));
    await waitForButton("Deny");
    expect(container.textContent).toContain("This computer can't run Code Mode");
    expect(button("Run it")).toBeUndefined();
    expect(button("Turn on Code Mode and run")).toBeUndefined();
  });

  it("never offers to turn Code Mode on for a computer that can't run its sandbox", async () => {
    // An older Gateway reports Code Mode off first, even on a host whose sandbox probe failed.
    api.fetchCodeModeReadiness.mockResolvedValue({
      enabled: false,
      sandboxEnabled: false,
      sandboxSupported: false,
      canRun: false,
      reason: "code_mode_off",
    });
    await render(turnWith({}));
    await waitForButton("Deny");
    expect(container.textContent).toContain("This computer can't run Code Mode");
    expect(container.textContent).not.toContain("Code Mode is off");
    expect(button("Turn on Code Mode and run")).toBeUndefined();
    expect(button("Run it")).toBeUndefined();
  });

  it("does not offer Run it when Code Mode can't be checked, and checks again on Try again", async () => {
    api.fetchCodeModeReadiness.mockRejectedValueOnce(new Error("Gateway unavailable"));
    await render(turnWith({}));
    await waitForButton("Try again");
    expect(container.textContent).toContain("Couldn't check Code Mode.");
    expect(button("Deny")).toBeDefined();
    expect(button("Run it")).toBeUndefined();
    expect(button("Turn on Code Mode and run")).toBeUndefined();
    await act(async () => button("Try again")!.click());
    await waitForButton("Run it");
    expect(container.textContent).not.toContain("Couldn't check Code Mode");
  });

  it("does not decide the buttons from a readiness answer cached before this request", async () => {
    // An earlier request saw Code Mode off; it has been turned on since.
    client.setQueryData(["code-mode", "readiness"], {
      enabled: false,
      sandboxEnabled: false,
      sandboxSupported: true,
      canRun: false,
      reason: "code_mode_off",
    });
    let answer!: (value: unknown) => void;
    api.fetchCodeModeReadiness.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    await render(turnWith({}));
    await waitFor(() => expect(api.fetchCodeModeReadiness).toHaveBeenCalled());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(container.textContent).toContain("Checking the request…");
    expect(container.textContent).not.toContain("Code Mode is off");
    expect(button("Turn on Code Mode and run")).toBeUndefined();
    await act(async () => answer({ enabled: true, sandboxEnabled: true, sandboxSupported: true, canRun: true }));
    await waitForButton("Run it");
    expect(container.textContent).not.toContain("Checking Code Mode…");
  });

  /** The row's one status line, which stays mounted through every state so each outcome is announced. */
  const statusLine = () =>
    container.querySelector<HTMLElement>('[role="group"][aria-label="Code Mode request"] > [role="status"]');

  it("running then done, on one status line that is not a landmark", async () => {
    api.fetchApproval.mockResolvedValue(approval("approved"));
    await render(turnWith({}));
    await waitFor(() => expect(statusLine()?.textContent).toContain("Running code…"));
    const line = statusLine();
    await render(turnWith({ status: "executed", result: { status: "completed", durationMs: 1200, runId: "r1" } }));
    expect(statusLine()).toBe(line);
    expect(line?.textContent).toContain(`Ran code to ${GOAL}`);
    expect(container.textContent).not.toContain("Running code…");
    // Every turn that asks adds a row; none of them is a landmark.
    expect(container.querySelector("section")).toBeNull();
  });

  it("moves focus to the row's status line when a decision replaces the buttons", async () => {
    api.fetchApproval.mockResolvedValueOnce(approval());
    await render(turnWith({}));
    await waitForButton("Deny");
    api.fetchApproval.mockResolvedValueOnce(approval());
    api.fetchApproval.mockResolvedValue(approval("rejected"));
    act(() => button("Deny")!.focus());
    await act(async () => button("Deny")!.click());
    await waitFor(() => expect(statusLine()?.textContent).toBe("Not run"));
    expect(document.activeElement).toBe(statusLine());
  });

  it("denied shows Not run", async () => {
    await render(turnWith({ status: "blocked", result: { approvalOutcome: "denied" } }));
    expect(container.textContent).toContain("Not run");
    expect(button("Run it")).toBeUndefined();
  });

  it("shows Not run when the approval record is gone (404)", async () => {
    api.fetchApproval.mockRejectedValue(
      new ApiRequestError("not found", { kind: "http", method: "GET", path: "/approvals/approval-1", status: 404 }),
    );
    await render(turnWith({}));
    await waitFor(() => expect(container.textContent).toContain("Not run"));
    expect(container.textContent).not.toContain("Checking the request");
  });

  it("shows Not run for a started run with no approval id", async () => {
    await render(turnWith({ status: "started", approvalId: undefined }));
    expect(container.textContent).toContain("Not run");
    expect(container.textContent).not.toContain("Checking the request");
  });

  it("offers Try again when the record cannot be read", async () => {
    api.fetchApproval.mockRejectedValueOnce(new Error("boom"));
    await render(turnWith({}));
    await waitForButton("Try again");
    await act(async () => button("Try again")!.click());
    await waitForButton("Run it");
  });

  it("shows the first sentence of a failure, and the whole error in Details", async () => {
    await render(turnWith({ status: "failed", error: "Code Mode is off. Turn it on from the card in Chat." }));
    expect(rowText()).toContain("Code Mode is off.");
    expect(rowText()).not.toContain("from the card");
    expect(container.querySelector("details")!.textContent).toContain(
      "Code Mode is off. Turn it on from the card in Chat.",
    );
  });

  const failedWith = (error: string, extra: Record<string, unknown> = {}) =>
    turnWith({ status: "executed", result: { status: "failed", error, ...extra } });

  it("says a helper failure in plain words and keeps the cause in Details", async () => {
    const error =
      "WRAPPER_EXECUTION_FAILED: Wrapper docs.extract_text did not execute: execution error: Path is outside read allowlist: /tmp/a.pdf";
    await render(failedWith(error, { stderrPreview: "TypeError at line 3" }));
    expect(rowText()).toContain("The code couldn't read a file.");
    expect(rowText()).not.toContain("WRAPPER_EXECUTION_FAILED");
    expect(rowText()).not.toContain("docs.extract_text");
    const details = container.querySelector("details")!;
    expect(details.textContent).toContain("Path is outside read allowlist: /tmp/a.pdf");
    expect(details.textContent).toContain("TypeError at line 3");
  });

  it("says when the code tried to read a file that was not approved", async () => {
    await render(
      failedWith(
        'WRAPPER_EXECUTION_FAILED: ".env" is not in the files approved for this run, so docs.read_bytes cannot read it.',
      ),
    );
    expect(rowText()).toContain("The code tried to read a file that wasn't approved.");
    expect(container.querySelector("details")!.textContent).toContain('".env" is not in the files approved');
  });

  it.each([
    "WRAPPER_EXECUTION_FAILED: fs.stat must name a file or folder approved for this run.",
    "WRAPPER_EXECUTION_FAILED: code.search is not available in this run, which can read only the files approved for it.",
  ])("says a read outside the approved files was refused when the Gateway refuses %s", async (error) => {
    await render(failedWith(error));
    expect(rowText()).toContain("The code tried to read a file that wasn't approved.");
    expect(rowText()).not.toContain("A helper the code called failed.");
    expect(container.querySelector("details")!.textContent).toContain(error.replace("WRAPPER_EXECUTION_FAILED: ", ""));
  });

  const doneTurn = () =>
    turnWith({ status: "executed", result: { status: "completed", durationMs: 1200, runId: "r1" } });
  const staged = { candidateId: "candidate-1", versionId: "version-1", revision: 1 };

  it("Keep as a tool stages, then promotes in one click", async () => {
    api.keepCodeModeRun.mockResolvedValue(staged);
    api.promoteCapabilityCandidate.mockResolvedValue({
      pendingApproval: { approvalId: "approval-life", kind: "capability.lifecycle" },
    });
    await render(doneTurn());
    await act(async () => button("Keep as a tool")!.click());
    // The lifecycle approval was approved in the same click, so the tool is promoted, not waiting on review.
    await waitFor(() => expect(rowText()).toContain("Saved as a tool"));
    expect(rowText()).not.toContain("for review");
    expect(api.keepCodeModeRun).toHaveBeenCalledWith("r1", expect.objectContaining({ summary: GOAL }));
    expect(api.keepCodeModeRun.mock.calls[0]![1].name).toBe("Read The Text Of Saturday-Plan.Pdf");
    expect(api.promoteCapabilityCandidate).toHaveBeenCalledWith("candidate-1", 1, "version-1");
    expect(api.resolveApproval).toHaveBeenCalledWith("approval-life", "approve");
  });

  it("does not say Saved as a tool when the approved promotion failed or has not finished", async () => {
    api.keepCodeModeRun.mockResolvedValue(staged);
    api.promoteCapabilityCandidate.mockResolvedValue({
      pendingApproval: { approvalId: "approval-life", kind: "capability.lifecycle" },
    });
    const approvedWith = (status: string) => async () => ({
      approval: { ...approval("approved"), approvalId: "approval-life" },
      effects: [{ effectId: "effect-1", status }],
    });
    api.resolveApproval.mockImplementation(approvedWith("failed"));
    await render(doneTurn());
    await act(async () => button("Keep as a tool")!.click());
    await waitFor(() => expect(rowText()).toContain("Saved as a tool for review. It couldn't be turned on here."));
    act(() => root.unmount());
    root = createRoot(container);
    for (const status of ["pending", "running"]) {
      api.resolveApproval.mockImplementation(approvedWith(status));
      await render({ ...doneTurn(), turnId: `turn-${status}` } as ChatThreadTurnRecord);
      await act(async () => button("Keep as a tool")!.click());
      await waitFor(() => expect(rowText()).toContain("Saved as a tool. It's still being turned on."));
      act(() => root.unmount());
      root = createRoot(container);
    }
  });

  it("shows Saved as a tool when the tool was already promoted", async () => {
    api.keepCodeModeRun.mockResolvedValue(staged);
    api.promoteCapabilityCandidate.mockResolvedValue({ pendingApproval: null, noMutationRequired: true, detail: {} });
    await render(doneTurn());
    await act(async () => button("Keep as a tool")!.click());
    await waitFor(() => expect(rowText()).toContain("Saved as a tool"));
    expect(rowText()).not.toContain("for review");
    expect(api.resolveApproval).not.toHaveBeenCalled();
  });

  it("shows Saved as a tool for review when promote returns a change plan", async () => {
    api.keepCodeModeRun.mockResolvedValue(staged);
    api.promoteCapabilityCandidate.mockResolvedValue({
      pendingApproval: null,
      noMutationRequired: false,
      changePlan: {},
    });
    await render(doneTurn());
    await act(async () => button("Keep as a tool")!.click());
    await waitFor(() => expect(container.textContent).toContain("Saved as a tool for review"));
    expect(api.resolveApproval).not.toHaveBeenCalled();
  });

  it("says so when the tool was saved but could not be turned on here", async () => {
    api.keepCodeModeRun.mockResolvedValue(staged);
    api.promoteCapabilityCandidate.mockRejectedValue(new Error("Revision changed."));
    await render(doneTurn());
    await act(async () => button("Keep as a tool")!.click());
    await waitFor(() => expect(rowText()).toContain("Saved as a tool for review. It couldn't be turned on here."));
    expect(container.querySelector('a[href*="/capabilities"]')).not.toBeNull();
  });

  it("moves focus to the saved line after Keep as a tool", async () => {
    api.keepCodeModeRun.mockResolvedValue(staged);
    api.promoteCapabilityCandidate.mockResolvedValue({ pendingApproval: null, noMutationRequired: true, detail: {} });
    await render(doneTurn());
    act(() => button("Keep as a tool")!.focus());
    await act(async () => button("Keep as a tool")!.click());
    await waitFor(() => expect(rowText()).toContain("Saved as a tool"));
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.textContent).toContain("Saved as a tool");
  });
});
