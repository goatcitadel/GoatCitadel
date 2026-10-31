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

  it("running then done", async () => {
    api.fetchApproval.mockResolvedValue(approval("approved"));
    await render(turnWith({}));
    await waitFor(() => expect(container.textContent).toContain("Running code…"));
    expect(container.querySelector("[aria-live='polite']")).not.toBeNull();
    await render(turnWith({ status: "executed", result: { status: "completed", durationMs: 1200, runId: "r1" } }));
    expect(container.textContent).toContain(`Ran code to ${GOAL}`);
    expect(container.textContent).not.toContain("Running code…");
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

  it("shows the first sentence of a failure", async () => {
    await render(turnWith({ status: "failed", error: "Code Mode is off. Turn it on from the card in Chat." }));
    expect(container.textContent).toContain("Code Mode is off.");
    expect(container.textContent).not.toContain("from the card");
  });

  it("drops a machine error code and keeps a dotted tool name whole", async () => {
    await render(
      turnWith({
        status: "executed",
        result: {
          status: "failed",
          error:
            "WRAPPER_EXECUTION_FAILED: Wrapper docs.extract_text did not execute: execution error: Path is outside read allowlist: /tmp/a.pdf",
        },
      }),
    );
    expect(container.textContent).toContain("Wrapper docs.extract_text did not execute.");
    expect(container.textContent).not.toContain("WRAPPER_EXECUTION_FAILED");
    expect(container.textContent).not.toContain("allowlist");
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
    await waitFor(() => expect(container.textContent).toContain("Saved as a tool for review"));
    expect(api.keepCodeModeRun).toHaveBeenCalledWith("r1", expect.objectContaining({ summary: GOAL }));
    expect(api.keepCodeModeRun.mock.calls[0]![1].name).toBe("Read The Text Of Saturday-Plan.Pdf");
    expect(api.promoteCapabilityCandidate).toHaveBeenCalledWith("candidate-1", 1, "version-1");
    expect(api.resolveApproval).toHaveBeenCalledWith("approval-life", "approve");
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
});
