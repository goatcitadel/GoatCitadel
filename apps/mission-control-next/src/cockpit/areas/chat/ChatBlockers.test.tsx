// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import type { ApprovalRequest } from "@goatcitadel/contracts";
import { ChatBlockers } from "./ChatBlockers";
import { GatewayUnavailableContext } from "../../app/gateway-unavailable-context";

const api = vi.hoisted(() => ({
  fetchApproval: vi.fn(),
  fetchApprovals: vi.fn(),
  resolveApproval: vi.fn(),
  fetchApprovalReplay: vi.fn(),
  approveChatToolTemporarily: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/approvals", () => ({
  fetchApproval: api.fetchApproval,
  fetchApprovalReplay: api.fetchApprovalReplay,
}));
vi.mock("@goatcitadel/mission-control-shared/api/chat-continuation", () => ({
  fetchChatContinuation: vi.fn(async () => ({
    status: "blocked",
    reason: "This operation requires a fresh request.",
    nextAction: { kind: "ask_again", label: "Ask again" },
  })),
  prepareChatContinuation: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  fetchApprovals: api.fetchApprovals,
  fetchApprovalReplay: api.fetchApprovalReplay,
  resolveApproval: api.resolveApproval,
}));
vi.mock("@goatcitadel/mission-control-shared/api/chat", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@goatcitadel/mission-control-shared/api/chat")>()),
  approveChatToolTemporarily: api.approveChatToolTemporarily,
}));
// The approval reviews name workspaces from the workspace list.
vi.mock("@goatcitadel/mission-control-shared/api/workspaces", () => ({
  fetchWorkspaces: vi.fn(async () => ({ items: [] })),
}));
// The image fetch is the shared AttachmentImage's; this file covers which attachment the blocker asks for.
vi.mock("../../ui/AttachmentImage", () => ({
  AttachmentImage: ({ attachmentId, alt }: { attachmentId: string; alt: string }) => (
    <img data-attachment={attachmentId} alt={alt} />
  ),
}));
const specialist = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../inbox/specialist-approval-evidence", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../inbox/specialist-approval-evidence")>()),
  readSpecialistEvidence: specialist.read,
  specialistEvidenceMatches: () => true,
}));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({ activeWorkspaceId: "default" }),
}));
// Every read goes through the api modules mocked above. A request that slips past them would reach the Gateway URL,
// the operator's own install on this computer, so fetch is refused for the whole file (a read a test left running
// can still call it after the test) and any call fails the test.
const network = vi.fn((input: unknown) => Promise.reject(new Error(`Unmocked request: ${String(input)}`)));
const takeRequests = () => {
  const requests = network.mock.calls.map(([input]) => String(input));
  network.mockClear();
  return requests;
};
beforeAll(() => vi.stubGlobal("fetch", network));
afterAll(() => {
  const requests = takeRequests();
  vi.unstubAllGlobals();
  expect(requests).toEqual([]);
});

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;

beforeEach(() => {
  window.history.replaceState(
    { retained: true },
    "",
    "/chat?keep=yes&workspaceId=stale&sessionId=stale&approvalId=stale&runId=run%2Fcontext&shell=cockpit&shellScope=visit#receipt",
  );
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  api.fetchApproval.mockResolvedValue({
    approvalId: "approval/1",
    kind: "tool_invoke",
    status: "pending",
    riskLevel: "danger",
    payload: {},
    preview: { commands: ["pnpm test"] },
    createdAt: "2026-10-01T00:00:00Z",
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  client.clear();
  api.fetchApproval.mockReset();
  api.fetchApprovals.mockReset();
  api.approveChatToolTemporarily.mockReset();
  expect(takeRequests()).toEqual([]);
});

describe("Chat blockers", () => {
  it("requires a second confirmation for danger risk and keeps canonical links", async () => {
    const onApprovePending = vi.fn();
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <ChatBlockers
            props={
              {
                pendingApproval: { approvalId: "approval/1", kind: "tool_invoke", riskLevel: "danger" },
                pendingUserInput: {
                  promptId: "prompt-1",
                  turnId: "turn-1",
                  kind: "text",
                  title: "Choose a direction",
                  question: "Which path?",
                  required: true,
                },
                selectedSessionId: "session/1",
                approvalPending: false,
                userInputPending: false,
                onApprovePending,
                onDenyPending: vi.fn(),
                onSubmitUserInput: vi.fn(),
                onRefreshThread: vi.fn(),
              } satisfies Pick<
                MissionThreadedActiveSessionSurfaceProps,
                | "pendingApproval"
                | "pendingUserInput"
                | "selectedSessionId"
                | "approvalPending"
                | "userInputPending"
                | "onApprovePending"
                | "onDenyPending"
                | "onSubmitUserInput"
                | "onRefreshThread"
              >
            }
          />
        </QueryClientProvider>,
      ),
    );
    expect(container.textContent).toContain("Use a tool");
    expect(container.textContent).not.toContain("tool_invoke");
    expect(container.textContent).toContain("Which path?");
    const anchors = [...container.querySelectorAll("a")];
    // CH-N06: no "Open this conversation in Chat" link while already inside Chat.
    expect(anchors).toHaveLength(1);
    expect(container.textContent).not.toContain("Open this conversation in Chat");
    for (const [label, pathname, approvalId] of [["Inspect persisted approval", "/inbox", "approval/1"]] as const) {
      const anchor = anchors.find((link) => link.textContent === label)!;
      expect(anchor).toBeDefined();
      const target = new URL(anchor.href);
      expect(target.pathname).toBe(pathname);
      expect(target.searchParams.get("approvalId")).toBe(approvalId);
      expect(target.searchParams.get("workspaceId")).toBe("default");
      expect(target.searchParams.get("sessionId")).toBe("session/1");
      expect(target.searchParams.get("runId")).toBe("run/context");
      expect(target.searchParams.get("keep")).toBe("yes");
      expect(target.searchParams.get("shell")).toBe("cockpit");
      expect(target.searchParams.has("shellScope")).toBe(false);
      expect(target.hash).toBe("#receipt");
    }
    await vi.waitFor(() => expect(findButton("Review danger approval")).toBeDefined(), { timeout: 5_000 });
    const review = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Review danger approval",
    );
    await act(async () => review?.click());
    expect(onApprovePending).not.toHaveBeenCalled();
    expect(review?.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    const inline = container.querySelector<HTMLElement>('[aria-label="Exact approval review"]');
    expect(inline?.hidden).toBe(false);
    expect(inline?.textContent).toContain("pnpm test");
    expect([...inline!.querySelectorAll("button")].some((button) => button.textContent === "Approve once")).toBe(true);
    await act(async () =>
      [...inline!.querySelectorAll("button")].find((button) => button.textContent === "Cancel")!.click(),
    );
    expect(inline?.hidden).toBe(true);
    expect(document.activeElement).toBe(review);
    expect(onApprovePending).not.toHaveBeenCalled();
  });

  it("loads persisted evidence for nuclear risk before its review", async () => {
    api.fetchApproval.mockResolvedValue({
      approvalId: "approval/1",
      kind: "tool_invoke",
      status: "pending",
      riskLevel: "nuclear",
      payload: {},
      preview: { commands: ["rm -rf build"] },
      createdAt: "2026-10-01T00:00:00Z",
    });
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <ChatBlockers
            props={
              {
                pendingApproval: { approvalId: "approval/1", kind: "tool_invoke", riskLevel: "nuclear" },
                pendingUserInput: null,
                selectedSessionId: "session/1",
                approvalPending: false,
                userInputPending: false,
                onApprovePending: vi.fn(),
                onDenyPending: vi.fn(),
                onSubmitUserInput: vi.fn(),
                onRefreshThread: vi.fn(),
              } as unknown as Parameters<typeof ChatBlockers>[0]["props"]
            }
          />
        </QueryClientProvider>,
      ),
    );
    // One read of this approval by id, under the key the Inbox detail shares (IN-11); no queue read.
    await vi.waitFor(() =>
      expect(api.fetchApproval).toHaveBeenCalledExactlyOnceWith("approval/1", {
        workspaceId: "default",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(api.fetchApprovals).not.toHaveBeenCalled();
    expect(client.getQueryData(["approvals", "record", "default", "approval/1"])).toBeTruthy();
    const nativeRecord = [...container.querySelectorAll("a")].find(
      (link) => link.textContent === "Inspect persisted approval",
    )!;
    expect(nativeRecord).toBeDefined();
    const recordTarget = new URL(nativeRecord.href);
    expect(recordTarget.pathname).toBe("/inbox");
    expect(recordTarget.searchParams.get("approvalId")).toBe("approval/1");
    expect(recordTarget.searchParams.get("workspaceId")).toBe("default");
    expect(recordTarget.searchParams.get("sessionId")).toBe("session/1");
    expect(recordTarget.searchParams.get("runId")).toBe("run/context");
    expect(recordTarget.searchParams.get("keep")).toBe("yes");
    expect(recordTarget.hash).toBe("#receipt");
    expect(recordTarget.searchParams.get("shell")).toBe("cockpit");
    expect(recordTarget.searchParams.has("shellScope")).toBe(false);
    await vi.waitFor(() =>
      expect(
        [...container.querySelectorAll("button")].find((button) => button.textContent === "Review nuclear approval"),
      ).toBeDefined(),
    );
    const review = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Review nuclear approval",
    );
    await act(async () => review?.click());
    await vi.waitFor(() => expect(document.body.textContent).toContain("rm -rf build"));
    expect(document.body.textContent).toContain("Confirm nuclear-level action");
  });

  it("loads persisted evidence for a risk level this build does not know", async () => {
    api.fetchApproval.mockResolvedValue({
      approvalId: "approval/1",
      kind: "tool_invoke",
      status: "pending",
      riskLevel: "critical_infra",
      payload: {},
      preview: { commands: ["kubectl delete ns prod"] },
      createdAt: "2026-10-01T00:00:00Z",
    });
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <ChatBlockers
            props={
              {
                pendingApproval: { approvalId: "approval/1", kind: "tool_invoke", riskLevel: "critical_infra" },
                pendingUserInput: null,
                selectedSessionId: "session/1",
                approvalPending: false,
                userInputPending: false,
                onApprovePending: vi.fn(),
                onDenyPending: vi.fn(),
                onSubmitUserInput: vi.fn(),
                onRefreshThread: vi.fn(),
              } as unknown as Parameters<typeof ChatBlockers>[0]["props"]
            }
          />
        </QueryClientProvider>,
      ),
    );
    // One read of this approval by id, under the key the Inbox detail shares (IN-11); no queue read.
    await vi.waitFor(() =>
      expect(api.fetchApproval).toHaveBeenCalledExactlyOnceWith("approval/1", {
        workspaceId: "default",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(api.fetchApprovals).not.toHaveBeenCalled();
    expect(client.getQueryData(["approvals", "record", "default", "approval/1"])).toBeTruthy();
    expect(container.textContent).toContain("Critical infra");
    await vi.waitFor(() =>
      expect(
        [...container.querySelectorAll("button")].find((button) => button.textContent === "Review nuclear approval"),
      ).toBeDefined(),
    );
    const review = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Review nuclear approval",
    );
    await act(async () => review?.click());
    await vi.waitFor(() => expect(document.body.textContent).toContain("kubectl delete ns prod"));
  });
});

it("shows the memory query and uses the Inbox decision owner for a low-risk Chat approval", async () => {
  const record = {
    approvalId: "safe-new",
    kind: "memory.search",
    status: "pending",
    riskLevel: "safe",
    payload: { query: "launch decisions" },
    preview: {
      reviewKind: "knowledge.operation",
      toolName: "memory.search",
      query: "launch decisions",
      target: "Memory namespace: all namespaces",
      optionsSummary: "Maximum results: 12",
    },
    createdAt: "2026-10-01T00:00:00Z",
    explanationStatus: "not_requested",
  };
  api.fetchApproval.mockResolvedValue(record);
  api.fetchApprovalReplay.mockResolvedValue({ approval: { ...record, status: "approved" }, effects: [] });
  api.resolveApproval.mockImplementation(async () => {
    api.fetchApproval.mockResolvedValue({ ...record, status: "approved" });
    return { approval: { ...record, status: "approved" }, effects: [] };
  });
  const oldAction = vi.fn();
  const refresh = vi.fn();
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ChatBlockers
          props={
            {
              pendingApproval: { approvalId: record.approvalId, riskLevel: "safe" },
              selectedSessionId: "session/1",
              approvalPending: false,
              userInputPending: false,
              pendingUserInput: null,
              onApprovePending: oldAction,
              onDenyPending: oldAction,
              onRefreshThread: refresh,
              onSubmitUserInput: vi.fn(),
            } as Parameters<typeof ChatBlockers>[0]["props"]
          }
        />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() =>
    expect(
      [...container.querySelectorAll("button")].find((button) => button.textContent === "Approve once")?.disabled,
    ).toBe(false),
  );
  const button = [...container.querySelectorAll("button")].find((entry) => entry.textContent === "Approve once")!;
  expect(button.disabled).toBe(false);
  expect(container.textContent).toContain("launch decisions");
  await act(async () => {
    button.click();
    await vi.dynamicImportSettled();
  });
  await vi.waitFor(() => expect(container.textContent).toContain("Decision recorded"));
  expect(api.resolveApproval).toHaveBeenCalledExactlyOnceWith("safe-new", "approve");
  expect(api.fetchApproval).toHaveBeenCalledWith("safe-new", { workspaceId: "default" });
  expect(oldAction).not.toHaveBeenCalled();
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(container.textContent).not.toContain("Work completed");
});

it("keeps a persisted settled decision visible while its canonical record is refetched", async () => {
  const record = {
    approvalId: "settled",
    kind: "tool_invoke",
    status: "approved",
    riskLevel: "safe",
    payload: {},
    createdAt: "2026-10-01T00:00:00Z",
  };
  api.fetchApproval.mockResolvedValue(record);
  api.fetchApprovalReplay.mockResolvedValue({ approval: record, effects: [] });
  const props = {
    pendingApproval: { approvalId: "settled", riskLevel: "safe" },
    selectedSessionId: "s",
    onRefreshThread: vi.fn(),
  } as unknown as Parameters<typeof ChatBlockers>[0]["props"];
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ChatBlockers props={props} />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(container.textContent).toContain("Decision recorded"));
  api.fetchApproval.mockImplementation(() => new Promise(() => {}));
  await act(async () => {
    void client.invalidateQueries({ queryKey: ["approvals", "record"] });
  });
  expect(container.textContent).toContain("Decision recorded");
  expect(container.textContent).not.toContain("Checking the current approval");
  expect(container.textContent).not.toContain("Approve once");
});

function blockerProps(overrides: Record<string, unknown> = {}) {
  return {
    pendingApproval: { approvalId: "approval/1", riskLevel: "safe" },
    selectedSessionId: "session/1",
    approvalPending: false,
    userInputPending: false,
    pendingUserInput: null,
    onApprovePending: vi.fn(),
    onDenyPending: vi.fn(),
    onRefreshThread: vi.fn(),
    onSubmitUserInput: vi.fn(),
    ...overrides,
  } as unknown as Parameters<typeof ChatBlockers>[0]["props"];
}
const findButton = (label: string) =>
  [...container.querySelectorAll("button")].find((entry) => entry.textContent === label);

it.each([undefined, "Path: notes/ut14-note.txt"])(
  "names the file a document approval would write with target label %s (U-CH-046)",
  async (targetLabel) => {
    api.fetchApproval.mockResolvedValue({
      approvalId: "approval/1",
      kind: "documents.create",
      status: "pending",
      riskLevel: "caution",
      payload: {},
      preview: { toolName: "documents.create", ...(targetLabel ? {} : { path: "notes/ut14-note.txt" }) },
      targetLabel,
      createdAt: "2026-10-01T00:00:00Z",
    });
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <ChatBlockers
            props={blockerProps({
              pendingApproval: {
                approvalId: "approval/1",
                kind: "documents.create",
                toolName: "documents.create",
                riskLevel: "caution",
              },
            })}
          />
        </QueryClientProvider>,
      ),
    );
    await vi.waitFor(() =>
      expect(container.querySelector('section[aria-label="Pending approval"]')?.textContent).toContain(
        "Path: notes/ut14-note.txt",
      ),
    );
  },
);

it("offers Ask again once the record read after the local deadline says expired (U-CH-031)", async () => {
  const pendingRecord = {
    approvalId: "approval/1",
    kind: "documents.create",
    status: "pending",
    riskLevel: "caution",
    payload: {},
    preview: { toolName: "documents.create", path: "notes/note.txt" },
    // Long enough to read the live card first, short enough to cross in the test.
    expiresAt: new Date(Date.now() + 1500).toISOString(),
    linkage: { turnId: "turn-1" },
    createdAt: "2026-10-01T00:00:00Z",
  };
  const deadline = Date.parse(pendingRecord.expiresAt);
  api.fetchApproval.mockImplementation(async () => (Date.now() < deadline ? pendingRecord : sweptExpiredRecord));
  const composer = document.createElement("textarea");
  document.body.append(composer);
  const onDraftChange = vi.fn();
  try {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <ChatBlockers
            props={blockerProps({
              pendingApproval: { approvalId: "approval/1", kind: "documents.create", riskLevel: "caution" },
              composerRef: { current: composer },
              onDraftChange,
              thread: {
                turns: [
                  { turnId: "turn-0", userMessage: { content: "Something else" } },
                  { turnId: "turn-1", userMessage: { content: "Create the note" } },
                ],
              },
            })}
          />
        </QueryClientProvider>,
      ),
    );
    await vi.waitFor(() => expect(findButton("Approve once")).toBeDefined());
    expect(findButton("Ask again")).toBeUndefined();
    const readsBefore = api.fetchApproval.mock.calls.length;
    await vi.waitFor(() => expect(findButton("Ask again")).toBeDefined(), { timeout: 5000 });
    expect(api.fetchApproval.mock.calls.length).toBeGreaterThan(readsBefore);
    expect(container.textContent).toContain(
      "This approval expired. Ask again to put your request back in the message box.",
    );
    expect(findButton("Approve once")).toBeUndefined();
    await act(async () => findButton("Ask again")!.click());
    expect(onDraftChange).toHaveBeenCalledExactlyOnceWith("Create the note");
    expect(document.activeElement).toBe(composer);
  } finally {
    composer.remove();
  }
});

const sweptExpiredRecord = {
  approvalId: "approval/1",
  kind: "documents.create",
  status: "rejected",
  resolutionOutcome: "expired",
  resolvedBy: "system:approval-expiry",
  riskLevel: "caution",
  payload: {},
  preview: { toolName: "documents.create", path: "notes/note.txt" },
  linkage: { turnId: "turn-1" },
  createdAt: "2026-10-01T00:00:00Z",
};
const expiredThread = { turns: [{ turnId: "turn-1", userMessage: { content: "Create the note" } }] };

async function renderExpired(overrides: Record<string, unknown>) {
  const composer = document.createElement("textarea");
  document.body.append(composer);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ChatBlockers
          props={blockerProps({
            pendingApproval: { approvalId: "approval/1", kind: "documents.create", riskLevel: "caution" },
            composerRef: { current: composer },
            onDraftChange: vi.fn(),
            ...overrides,
          })}
        />
      </QueryClientProvider>,
    ),
  );
  return composer;
}

/** A record that still reads pending once its deadline has passed on this clock. */
function lapsedPending() {
  return {
    approvalId: "approval/1",
    kind: "documents.create",
    status: "pending",
    riskLevel: "caution",
    payload: {},
    preview: { toolName: "documents.create", path: "notes/note.txt" },
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
    linkage: { turnId: "turn-1" },
    createdAt: "2026-10-01T00:00:00Z",
  };
}

it("does not say the action did not run or offer Ask again while the late read is not answered (U-CH-031)", async () => {
  api.fetchApproval.mockImplementation(() => new Promise(() => {}));
  const composer = await renderExpired({
    thread: expiredThread,
    draft: "",
    pendingApproval: {
      approvalId: "approval/1",
      kind: "documents.create",
      riskLevel: "caution",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    },
  });
  try {
    await vi.waitFor(() => expect(container.textContent).toContain("Checking whether it was decided"));
    expect(container.textContent).toContain("The time for this approval has passed.");
    expect(container.textContent).not.toContain("did not run");
    expect(findButton("Ask again")).toBeUndefined();
    // Nothing can be decided on it, so Jump to latest must not name it as waiting.
    expect(container.querySelector("[data-chat-waiting-decision]")).toBeNull();
  } finally {
    composer.remove();
  }
});

it("reads again after the deadline and follows an approved record (U-CH-031)", async () => {
  api.fetchApproval.mockResolvedValueOnce(lapsedPending());
  api.fetchApproval.mockResolvedValue({ ...lapsedPending(), status: "approved", resolutionOutcome: "approved" });
  const composer = await renderExpired({ thread: expiredThread, draft: "" });
  try {
    await vi.waitFor(() => expect(container.textContent).toContain("Approval decided"));
    expect(api.fetchApproval.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(container.textContent).not.toContain("did not run");
    expect(container.textContent).not.toContain("time for this approval has passed");
    expect(findButton("Ask again")).toBeUndefined();
  } finally {
    composer.remove();
  }
});

it("shows the confirmed expired block when the late read says expired (U-CH-031)", async () => {
  api.fetchApproval.mockResolvedValueOnce(lapsedPending());
  api.fetchApproval.mockResolvedValue(sweptExpiredRecord);
  const composer = await renderExpired({ thread: expiredThread, draft: "" });
  try {
    await vi.waitFor(() => expect(findButton("Ask again")).toBeDefined());
    expect(container.textContent).toContain("Approval expired");
    expect(container.textContent).toContain("This approval expired.");
  } finally {
    composer.remove();
  }
});

it("offers Check again, never Ask again, when the late read fails (U-CH-031)", async () => {
  api.fetchApproval.mockResolvedValueOnce(lapsedPending());
  api.fetchApproval.mockRejectedValueOnce(new Error("offline"));
  const composer = await renderExpired({ thread: expiredThread, draft: "" });
  try {
    await vi.waitFor(() => expect(findButton("Check again")).toBeDefined());
    expect(container.textContent).toContain("What happened to it is not confirmed yet.");
    expect(container.textContent).not.toContain("did not run");
    expect(findButton("Ask again")).toBeUndefined();
    api.fetchApproval.mockResolvedValue(sweptExpiredRecord);
    await act(async () => findButton("Check again")!.click());
    await vi.waitFor(() => expect(findButton("Ask again")).toBeDefined());
  } finally {
    composer.remove();
  }
});

it("keeps Ask again when the record read says the sweep expired it (U-CH-031)", async () => {
  api.fetchApproval.mockResolvedValue(sweptExpiredRecord);
  const onDraftChange = vi.fn();
  const composer = await renderExpired({ thread: expiredThread, onDraftChange, draft: "" });
  try {
    await vi.waitFor(() => expect(findButton("Ask again")).toBeDefined());
    expect(container.textContent).toContain("Approval expired");
    expect(container.textContent).not.toContain("Approval decided");
    expect(container.textContent).toContain("This approval expired. Ask again to put your request back");
    await act(async () => findButton("Ask again")!.click());
    expect(onDraftChange).toHaveBeenCalledExactlyOnceWith("Create the note");
  } finally {
    composer.remove();
  }
});

it("does not promise Ask again when no linked turn is found (U-CH-031)", async () => {
  api.fetchApproval.mockResolvedValue(sweptExpiredRecord);
  const composer = await renderExpired({ thread: { turns: [] }, draft: "" });
  try {
    await vi.waitFor(() => expect(container.textContent).toContain("This approval expired."));
    expect(findButton("Ask again")).toBeUndefined();
    expect(container.textContent).not.toContain("Ask again to put");
  } finally {
    composer.remove();
  }
});

it("leaves a message the operator has typed alone and says so (U-CH-031)", async () => {
  api.fetchApproval.mockResolvedValue(sweptExpiredRecord);
  const onDraftChange = vi.fn();
  const composer = await renderExpired({ thread: expiredThread, onDraftChange, draft: "Something I am typing" });
  try {
    await vi.waitFor(() => expect(findButton("Ask again")).toBeDefined());
    await act(async () => findButton("Ask again")!.click());
    expect(onDraftChange).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Your message box already has text. Clear it to ask again.");
    const note = container.querySelector(
      "#" + CSS.escape(findButton("Ask again")!.getAttribute("aria-describedby") ?? "none"),
    );
    expect(note?.textContent).toContain("Clear it to ask again.");
  } finally {
    composer.remove();
  }
});

it("does not call the request Ask again just restored the operator's own text (U-CH-031)", async () => {
  api.fetchApproval.mockResolvedValue(sweptExpiredRecord);
  const onDraftChange = vi.fn();
  const first = await renderExpired({ thread: expiredThread, onDraftChange, draft: "" });
  const second = document.createElement("textarea");
  try {
    await vi.waitFor(() => expect(findButton("Ask again")).toBeDefined());
    await act(async () => findButton("Ask again")!.click());
    expect(onDraftChange).toHaveBeenCalledExactlyOnceWith("Create the note");
    // The box now holds the restored request; a second click leaves it and says nothing about typed text.
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <ChatBlockers
            props={blockerProps({
              pendingApproval: { approvalId: "approval/1", kind: "documents.create", riskLevel: "caution" },
              composerRef: { current: second },
              onDraftChange,
              thread: expiredThread,
              draft: "Create the note",
            })}
          />
        </QueryClientProvider>,
      ),
    );
    await act(async () => findButton("Ask again")!.click());
    expect(onDraftChange).toHaveBeenCalledOnce();
    expect(container.textContent).not.toContain("already has text");
  } finally {
    first.remove();
    second.remove();
  }
});

it("pauses the decision buttons while the shell says GoatCitadel is unreachable (U-CH-027)", async () => {
  const pendingRecord = {
    ...sweptExpiredRecord,
    status: "pending",
    resolutionOutcome: undefined,
    resolvedBy: undefined,
  };
  api.fetchApproval.mockResolvedValue(pendingRecord);
  const renderCard = (unreachable: boolean) =>
    act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <GatewayUnavailableContext.Provider value={unreachable}>
            <ChatBlockers
              props={blockerProps({
                pendingApproval: { approvalId: "approval/1", kind: "documents.create", riskLevel: "caution" },
              })}
            />
          </GatewayUnavailableContext.Provider>
        </QueryClientProvider>,
      ),
    );
  await renderCard(true);
  await vi.waitFor(() => expect(findButton("Approve once")).toBeDefined());
  expect(findButton("Approve once")!.closest("fieldset")?.disabled).toBe(true);
  expect(container.textContent).toContain("GoatCitadel is unreachable, so this decision can");
  await renderCard(false);
  expect(findButton("Approve once")!.closest("fieldset")?.disabled).toBe(false);
});

it.each([
  { toolName: "memory.search", result: { items: [] }, message: "Search complete · 0 results" },
  { toolName: "browser.search", result: { results: [{}] }, message: "Search complete · 1 result" },
  { toolName: "memory.search", result: {}, message: "Search complete" },
  {
    toolName: "browser.search",
    result: { backend: "official", backendUsed: false, results: [] },
    message: "Search did not complete",
  },
])("shows $message from the recorded $toolName outcome", async ({ toolName, result, message }) => {
  const latestTurn = {
    turnId: "turn/1",
    trace: { sessionId: "session/1", status: "completed" },
    toolRuns: [
      { turnId: "turn/1", sessionId: "session/1", approvalId: "approval/1", toolName, status: "executed", result },
    ],
  } as NonNullable<Parameters<typeof ChatBlockers>[0]["latestTurn"]>;
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ChatBlockers props={blockerProps({ pendingApproval: null })} latestTurn={latestTurn} />
      </QueryClientProvider>,
    ),
  );
  expect(container.querySelector('[role="status"]')?.textContent).toBe(message);
});

it.each([
  { hint: true, result: { ok: true, contentItems: [{}] }, message: "Request complete · 1 item" },
  {
    hint: true,
    result: { ok: false, externalOutcome: "unknown_after_send" },
    message: "Request outcome unknown",
  },
  { hint: undefined, result: { ok: true, contentItems: [{}] }, message: undefined },
])("uses the saved read-only MCP review for $message", async ({ hint, result, message }) => {
  const toolName = "mcp.fixture.read";
  api.fetchApproval.mockResolvedValue({
    approvalId: "approval/1",
    kind: toolName,
    status: "approved",
    linkage: { sessionId: "session/1", turnId: "turn/1" },
    preview: { reviewKind: "mcp.operation", mcpReadOnlyHint: hint },
  });
  const latestTurn = {
    turnId: "turn/1",
    trace: { sessionId: "session/1", status: "completed" },
    toolRuns: [
      { turnId: "turn/1", sessionId: "session/1", approvalId: "approval/1", toolName, status: "executed", result },
    ],
  } as unknown as NonNullable<Parameters<typeof ChatBlockers>[0]["latestTurn"]>;
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ChatBlockers props={blockerProps({ pendingApproval: null })} latestTurn={latestTurn} />
      </QueryClientProvider>,
    ),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(api.fetchApproval).toHaveBeenCalledWith("approval/1", expect.objectContaining({ workspaceId: "default" }));
  expect(container.querySelector('[aria-label="MCP request approval"] [data-approval-read-status]')?.textContent).toBe(
    message,
  );
});

it("keeps a changed MCP warning visible and opens the refreshed exact action with Review again", async () => {
  const kind = "mcp.fixture.read";
  const original: ApprovalRequest = {
    approvalId: "approval/1",
    kind,
    status: "pending",
    riskLevel: "danger",
    payload: {},
    preview: { reviewKind: "mcp.operation", target: "Original fixture", requestArguments: "No arguments" },
    linkage: { workspaceId: "default", sessionId: "session/1", turnId: "turn/1" },
    explanationStatus: "pending",
    createdAt: "2026-10-01T00:00:00Z",
  };
  const changed: ApprovalRequest = {
    ...original,
    payload: { item: "updated" },
    preview: { ...original.preview, target: "Updated fixture", requestArguments: '{"item":"updated"}' },
  };
  let releaseRefresh!: (record: ApprovalRequest) => void;
  const refresh = new Promise<ApprovalRequest>((resolve) => {
    releaseRefresh = resolve;
  });
  api.fetchApproval.mockResolvedValueOnce(original).mockResolvedValueOnce(changed).mockReturnValueOnce(refresh);
  api.resolveApproval.mockClear();
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ChatBlockers
          props={blockerProps({ pendingApproval: { approvalId: original.approvalId, kind, riskLevel: "danger" } })}
        />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(findButton("Review danger approval")).toBeDefined());
  await act(async () => findButton("Review danger approval")!.click());
  expect(container.querySelector('[aria-label="Exact approval review"]')?.textContent).toContain("No arguments");
  await act(async () => findButton("Approve once")!.click());
  const warning = "This MCP action changed. Review the updated action before deciding.";
  await vi.waitFor(() => expect(container.querySelector("[data-approval-warning]")?.textContent).toBe(warning));
  expect(findButton("Review again")).toBeUndefined();
  expect(findButton("Approve once")).toBeUndefined();

  await act(async () => releaseRefresh(changed));
  await vi.waitFor(() => expect(findButton("Review again")).toBeDefined());
  expect(container.querySelector("[data-approval-warning]")?.textContent).toBe(warning);
  expect(findButton("Approve once")).toBeUndefined();
  await act(async () => findButton("Review again")!.click());

  const inline = container.querySelector('[aria-label="Exact approval review"]');
  expect(inline?.textContent).toContain("Updated fixture");
  expect(inline?.textContent).toContain('{"item":"updated"}');
  expect(inline?.textContent).not.toContain("Original fixture");
  expect(container.querySelector("[data-approval-warning]")?.textContent).toBe(warning);
  expect(findButton("Approve once")).toBeDefined();
  expect(api.resolveApproval).not.toHaveBeenCalled();
});

it.each([
  { decision: "approve", status: "approved" as const, matches: true, notice: "Approved in another tab" },
  { decision: "approve", status: "rejected" as const, matches: true, notice: "Denied in another tab" },
  { decision: "approve", status: "approved" as const, matches: false, notice: undefined },
  { decision: "approve", status: "rejected" as const, matches: false, notice: undefined },
  { decision: "reject", status: "approved" as const, matches: true, notice: "Approved in another tab" },
  { decision: "reject", status: "approved" as const, matches: false, notice: undefined },
  { decision: "reject", status: "rejected" as const, matches: true, notice: "Denied in another tab" },
  { decision: "reject", status: "rejected" as const, matches: false, notice: undefined },
])(
  "reconciles a $status conflict after $decision when the MCP action matches ($matches)",
  async ({ decision, status, matches, notice }) => {
    const { ApiRequestError } = await import("@goatcitadel/mission-control-shared/api/http-internal");
    const kind = "mcp.fixture.read";
    const record: ApprovalRequest = {
      approvalId: `approval/conflict-${decision}-${status}-${matches}`,
      kind,
      status: "pending",
      riskLevel: "danger",
      payload: {},
      preview: {
        reviewKind: "mcp.operation",
        target: "Fixture",
        requestArguments: "No arguments",
        mcpReadOnlyHint: true,
      },
      linkage: { workspaceId: "default", sessionId: "session/1", turnId: "turn/1" },
      explanationStatus: "pending",
      createdAt: "2026-10-01T00:00:00Z",
    };
    const settled: ApprovalRequest = {
      ...record,
      status,
      payload: matches ? record.payload : { changed: true },
    };
    let sendConflict!: (error: Error) => void;
    api.fetchApproval.mockResolvedValue(record);
    api.resolveApproval.mockReset().mockReturnValue(
      new Promise((_, reject) => {
        sendConflict = reject;
      }),
    );
    const onRefreshThread = vi.fn();
    const makeTurn = (phase: "waiting_for_approval" | "running" | "completed") =>
      ({
        turnId: "turn/1",
        trace: { sessionId: "session/1", status: phase },
        toolRuns: [
          {
            toolRunId: "tool/1",
            turnId: "turn/1",
            sessionId: "session/1",
            approvalId: record.approvalId,
            toolName: kind,
            status: phase === "completed" ? (status === "approved" ? "executed" : "blocked") : "approval_required",
            ...(phase === "completed" && status === "approved" ? { result: { ok: true, contentItems: [{}] } } : {}),
          },
        ],
      }) as unknown as NonNullable<Parameters<typeof ChatBlockers>[0]["latestTurn"]>;
    const render = (phase: Parameters<typeof makeTurn>[0]) =>
      root.render(
        <QueryClientProvider client={client}>
          <ChatBlockers
            props={blockerProps({
              pendingApproval:
                phase === "waiting_for_approval" ? { approvalId: record.approvalId, kind, riskLevel: "danger" } : null,
              onRefreshThread,
            })}
            latestTurn={makeTurn(phase)}
          />
        </QueryClientProvider>,
      );
    await act(async () => render("waiting_for_approval"));
    await vi.waitFor(() => expect(findButton("Review danger approval")).toBeDefined());
    await act(async () => findButton("Review danger approval")!.click());
    await act(async () => findButton(decision === "approve" ? "Approve once" : "Deny")!.click());
    await vi.waitFor(() => expect(api.resolveApproval).toHaveBeenCalledExactlyOnceWith(record.approvalId, decision));
    api.fetchApproval.mockResolvedValue(settled);
    await act(async () => {
      client.setQueryData(["approvals", "record", "default", record.approvalId], settled);
      render("running");
    });
    expect(findButton("Approve once")).toBeUndefined();
    expect(container.textContent).not.toContain("Request complete");
    expect(container.textContent).not.toContain("in another tab");
    await act(async () =>
      sendConflict(
        new ApiRequestError("already resolved", {
          kind: "http",
          method: "POST",
          path: `/api/v1/approvals/${record.approvalId}/resolve`,
          status: 409,
        }),
      ),
    );
    if (notice) {
      await vi.waitFor(() => expect(container.textContent).toContain(notice));
      expect(onRefreshThread).toHaveBeenCalledOnce();
    } else {
      expect(container.textContent).not.toContain("in another tab");
      expect(onRefreshThread).not.toHaveBeenCalled();
    }
    expect(container.textContent?.includes("Resuming this turn…")).toBe(matches && status === "approved");
    await act(async () => render("completed"));
    expect(container.textContent?.includes("Request complete · 1 item")).toBe(status === "approved");
    expect(container.textContent?.includes("in another tab")).toBe(matches);
    if (notice) expect(container.textContent).toContain(notice);
    expect(api.resolveApproval).toHaveBeenCalledOnce();
  },
);

it.each([
  { outcome: "approved", status: "approved", timely: "before", message: "Approved in another tab" },
  { outcome: "denied", status: "rejected", timely: "before", message: "Denied in another tab" },
  { outcome: "expired", status: "rejected", timely: "before", message: "Approval expired." },
  { outcome: "withdrawn", status: "rejected", timely: "before", message: "Approval withdrawn." },
  { outcome: "denied", status: "rejected", timely: "after", message: "Denied in another tab" },
] as const)(
  "reconciles a memory allowance decision settled $timely submit as $outcome",
  async ({ outcome, status, timely, message }) => {
    const { ApiRequestError } = await import("@goatcitadel/mission-control-shared/api/http-internal");
    const approval: ApprovalRequest = {
      approvalId: `knowledge/${outcome}-${timely}`,
      kind: "memory.search",
      riskLevel: "safe",
      status: "pending",
      payload: { query: "notes" },
      preview: { reviewKind: "knowledge.operation", toolName: "memory.search", query: "notes", target: "Memory" },
      linkage: {
        actionType: "tool.invoke",
        toolName: "memory.search",
        sessionId: "session/1",
        workspaceId: "default",
        turnId: "turn/1",
      },
      createdAt: "2026-11-16T18:00:00Z",
      explanationStatus: "pending",
    };
    const settled: ApprovalRequest = { ...approval, status, resolutionOutcome: outcome };
    const onRefreshThread = vi.fn();
    api.resolveApproval.mockClear();
    api.fetchApproval.mockResolvedValue(approval);
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <ChatBlockers
            props={blockerProps({
              pendingApproval: { approvalId: approval.approvalId, kind: approval.kind, riskLevel: "safe" },
              onRefreshThread,
            })}
          />
        </QueryClientProvider>,
      ),
    );
    await vi.waitFor(() => expect(findButton("Allow this tool in this Chat")).toBeDefined());
    await act(async () => findButton("Allow this tool in this Chat")!.click());
    if (timely === "before") {
      api.fetchApproval.mockResolvedValue(settled);
    } else {
      api.approveChatToolTemporarily.mockImplementationOnce(async () => {
        api.fetchApproval.mockResolvedValue(settled);
        throw new ApiRequestError("already decided", {
          kind: "http",
          method: "POST",
          path: "/api/v1/chat/tools/approve-temporarily",
          status: 409,
        });
      });
    }
    await act(async () => findButton("Approve and allow")!.click());
    await vi.waitFor(() => expect(container.textContent).toContain(message));
    expect(container.textContent).not.toContain("This tool is allowed");
    if (outcome !== "denied") expect(container.textContent).not.toContain("Denied in another tab");
    expect(api.resolveApproval).not.toHaveBeenCalled();
    expect(api.approveChatToolTemporarily).toHaveBeenCalledTimes(timely === "before" ? 0 : 1);
    expect(onRefreshThread).toHaveBeenCalledOnce();
  },
);

it("shows a failed record read as an error with Try again and Deny, not as checking (CH-02)", async () => {
  api.fetchApproval.mockRejectedValue(new Error("fixture outage"));
  const onDenyPending = vi.fn();
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ChatBlockers props={blockerProps({ onDenyPending })} />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(container.textContent).toContain("The approval record couldn’t load"));
  expect(container.textContent).not.toContain("Checking the current approval");
  expect(findButton("Approve once")).toBeUndefined();
  api.fetchApproval.mockClear();
  await act(async () => findButton("Try again")!.click());
  expect(api.fetchApproval).toHaveBeenCalledTimes(1);
  await vi.waitFor(() => expect(findButton("Deny")).toBeDefined());
  await act(async () => findButton("Deny")!.click());
  expect(onDenyPending).toHaveBeenCalledTimes(1);
});

it("offers Check again and Deny when the record is missing (CH-02)", async () => {
  const { ApiRequestError } = await import("@goatcitadel/mission-control-shared/api/http-internal");
  api.fetchApproval.mockRejectedValue(
    new ApiRequestError("gone", { kind: "http", method: "GET", path: "/api/approvals/approval-1", status: 404 }),
  );
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ChatBlockers props={blockerProps()} />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(container.textContent).toContain("The approval record wasn’t found"));
  expect(findButton("Check again")).toBeDefined();
  expect(findButton("Deny")).toBeDefined();
});

it("moves focus to the composer when a decision removes the card it was in (CH-18)", async () => {
  api.fetchApproval.mockRejectedValue(new Error("fixture outage"));
  const composer = document.createElement("textarea");
  document.body.append(composer);
  const composerRef = { current: composer };
  try {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <ChatBlockers props={blockerProps({ composerRef })} />
        </QueryClientProvider>,
      ),
    );
    await vi.waitFor(() => expect(findButton("Deny")).toBeDefined());
    act(() => findButton("Deny")!.focus());
    expect(document.activeElement?.textContent).toBe("Deny");
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <ChatBlockers props={blockerProps({ composerRef, pendingApproval: null })} />
        </QueryClientProvider>,
      ),
    );
    expect(document.activeElement).toBe(composer);
  } finally {
    composer.remove();
  }
});

it("does not duplicate a code_mode.request approval", async () => {
  api.fetchApproval.mockResolvedValue({
    approvalId: "cm-1",
    kind: "code_mode.request",
    status: "pending",
    riskLevel: "caution",
    payload: { goal: "read a file", source: "return 1;" },
    preview: {},
    createdAt: "2026-10-01T00:00:00Z",
  });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ChatBlockers
          props={blockerProps({
            pendingApproval: { approvalId: "cm-1", kind: "code_mode.request", riskLevel: "caution" },
          })}
        />
      </QueryClientProvider>,
    ),
  );
  expect(container.textContent).not.toContain("Approval needed");
  expect(container.querySelector("button")).toBeNull();
});

it("enables Approve for a code_mode.run once specialist evidence matches", async () => {
  const record = {
    approvalId: "run-1",
    kind: "code_mode.run",
    status: "pending",
    riskLevel: "danger",
    payload: { runId: "r1" },
    preview: {},
    createdAt: "2026-10-01T00:00:00Z",
  };
  api.fetchApproval.mockResolvedValue(record);
  let release!: (value: unknown) => void;
  specialist.read.mockReturnValue(new Promise((resolve) => (release = resolve)));
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ChatBlockers
          props={blockerProps({ pendingApproval: { approvalId: "run-1", kind: "code_mode.run", riskLevel: "danger" } })}
        />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(findButton("Review danger approval")).toBeDefined());
  expect(findButton("Review danger approval")!.disabled).toBe(true);
  await act(async () => release({ replay: { approval: record, events: [], effects: [] } }));
  await vi.waitFor(() => expect(findButton("Review danger approval")!.disabled).toBe(false));
});

it("says why a code_mode.run approval can't be approved yet, and checks the code again on request", async () => {
  const record = {
    approvalId: "run-1",
    kind: "code_mode.run",
    status: "pending",
    riskLevel: "danger",
    payload: { runId: "r1" },
    preview: {},
    createdAt: "2026-10-01T00:00:00Z",
  };
  api.fetchApproval.mockResolvedValue(record);
  specialist.read.mockRejectedValueOnce(new Error("Gateway unavailable"));
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ChatBlockers
          props={blockerProps({ pendingApproval: { approvalId: "run-1", kind: "code_mode.run", riskLevel: "danger" } })}
        />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(findButton("Check again")).toBeDefined());
  expect(container.querySelector('[role="status"]')?.textContent).toContain("Gateway unavailable");
  expect(findButton("Review danger approval")!.disabled).toBe(true);
  specialist.read.mockResolvedValue({ replay: { approval: record, events: [], effects: [] } });
  await act(async () => findButton("Check again")!.click());
  await vi.waitFor(() => expect(findButton("Review danger approval")!.disabled).toBe(false));
  expect(findButton("Check again")).toBeUndefined();
});

it("does not send a second specialist read while Check again is still reading", async () => {
  const record = {
    approvalId: "run-1",
    kind: "code_mode.run",
    status: "pending",
    riskLevel: "danger",
    payload: { runId: "r1" },
    preview: {},
    createdAt: "2026-10-01T00:00:00Z",
  };
  const evidence = { replay: { approval: record, events: [], effects: [] } };
  api.fetchApproval.mockResolvedValue(record);
  specialist.read.mockResolvedValueOnce(evidence);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ChatBlockers
          props={blockerProps({ pendingApproval: { approvalId: "run-1", kind: "code_mode.run", riskLevel: "danger" } })}
        />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(findButton("Review danger approval")?.disabled).toBe(false));
  // A later read fails, so the earlier answer no longer counts; the failure stays recorded while it is read again.
  specialist.read.mockRejectedValueOnce(new Error("Gateway unavailable"));
  await act(async () => client.refetchQueries({ queryKey: ["approvals", "specialist"] }));
  await vi.waitFor(() => expect(findButton("Check again")).toBeDefined());
  let release!: (value: unknown) => void;
  specialist.read.mockReturnValue(new Promise((resolve) => (release = resolve)));
  await act(async () => findButton("Check again")!.click());
  const reads = specialist.read.mock.calls.length;
  await vi.waitFor(() => expect(findButton("Check again")?.disabled ?? true).toBe(true));
  await act(async () => findButton("Check again")?.click());
  expect(specialist.read).toHaveBeenCalledTimes(reads);
  await act(async () => release(evidence));
  await vi.waitFor(() => expect(findButton("Check again")).toBeUndefined());
});

it("approval blocker shows the errand screenshot", async () => {
  api.fetchApproval.mockResolvedValue({
    approvalId: "approval/1",
    kind: "browser.errand.action",
    status: "pending",
    riskLevel: "caution",
    payload: {},
    preview: {
      summary: 'Click "Place order" — Buy the hub',
      url: "https://shop.example/checkout",
      title: 'Click "Place order"',
      screenshotAttachmentId: "shot-1",
      screenshotSha256: "a".repeat(64),
    },
    createdAt: "2026-10-01T00:00:00Z",
  });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ChatBlockers
          props={blockerProps({
            pendingApproval: { approvalId: "approval/1", kind: "browser.errand.action", riskLevel: "caution" },
          })}
        />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(container.querySelector("img")).not.toBeNull());
  expect(container.querySelector("img")?.getAttribute("data-attachment")).toBe("shot-1");
  expect(container.textContent).toContain("Browser errand step");
  expect(container.textContent).not.toContain("browser.errand.action");
});
