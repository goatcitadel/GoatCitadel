// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ApprovalRequest } from "@goatcitadel/contracts";
let ChatBlockers: typeof import("./ChatBlockers").ChatBlockers;
let ChatApprovalRenderer: typeof import("./ChatApprovalRenderer").ChatApprovalRenderer;
let ApiRequestError: typeof import("@goatcitadel/mission-control-shared/api/http-internal").ApiRequestError;
const loader = vi.hoisted(() => ({ load: vi.fn<() => Promise<void>>() }));
const identity = vi.hoisted(() => ({
  gateway: "http://gateway-a",
  caller: "caller-a",
  callerRevision: 1,
  accessRevision: 1,
  workspaceId: "workspace-a",
}));
const navigation = vi.hoisted(() => ({ revision: 1, listeners: new Set<() => void>() }));
vi.mock("../../app/cockpit-history", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/cockpit-history")>()),
  readCockpitHistory: () => `${navigation.revision}:${window.location.href}`,
  subscribeCockpitHistory: (listener: () => void) => {
    navigation.listeners.add(listener);
    return () => navigation.listeners.delete(listener);
  },
}));
const api = vi.hoisted(() => ({
  fetchApproval: vi.fn(),
  resolveApproval: vi.fn(),
  fetchApprovalReplay: vi.fn(),
  fetchRuntimeLifecycle: vi.fn(),
  fetchDurableRun: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/approvals", () => api);
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({
  getGatewayApiBaseUrl: () => identity.gateway,
  getGatewayAccessRevision: () => identity.accessRevision,
}));
vi.mock("@goatcitadel/mission-control-shared/api/access-scope", () => ({
  getGatewayCallerScope: () => identity.caller,
  getGatewayCallerScopeRevision: () => identity.callerRevision,
  getGatewayAccessRevision: () => identity.accessRevision,
  subscribeGatewayCallerScope: () => () => {},
  subscribeGatewayAccessChange: () => () => {},
}));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({ activeWorkspaceId: identity.workspaceId }),
}));
let root: Root, host: HTMLDivElement, client: QueryClient, record: ApprovalRequest;
const resolved = vi.fn(),
  invalidated = vi.fn(),
  submit = vi.fn();
// An owner change can start a retry load that outlives its test. Vitest keeps factory exports on a mock node
// shared across doMock calls, so a load settling after the next test's doMock would be returned to that test's
// import without running its factory (loader.load). afterEach waits for these loads.
const bodyLoads = new Set<Promise<unknown>>();
function installBodyMock() {
  vi.doMock("./ChatApprovalRendererBody", () => {
    const load = (async () => {
      await loader.load();
      return vi.importActual<typeof import("./ChatApprovalRendererBody")>("./ChatApprovalRendererBody");
    })();
    const drop = () => bodyLoads.delete(load);
    bodyLoads.add(load);
    void load.then(drop, drop);
    return load;
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (cause: Error) => void;
  const promise = new Promise<T>((success, failure) => {
    resolve = success;
    reject = failure;
  });
  return { promise, resolve, reject };
}
function deferCode() {
  const value = deferred<void>();
  loader.load.mockImplementationOnce(() => value.promise);
  return value;
}
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === label)!;
function makeRecord(approvalId = "approval-a", workspaceId = "workspace-a", sessionId = "session-a"): ApprovalRequest {
  return {
    approvalId,
    kind: "tool_invoke",
    status: "pending",
    riskLevel: "safe",
    payload: {},
    preview: { targets: ["safe-target.txt"] },
    linkage: { workspaceId, sessionId },
    createdAt: "2026-10-01T00:00:00Z",
    explanationStatus: "not_requested",
  };
}
function renderBlockers({
  approval = true,
  question = false,
  choice = false,
  secure = false,
  sessionId = "session-a",
} = {}) {
  const prompt = question
    ? {
        promptId: "question-a",
        turnId: "turn-a",
        kind: choice ? "single_select" : "text",
        title: "Current question",
        question: "Which direction?",
        required: true,
        secureConfiguration: secure
          ? {
              targetId: "fixture-target",
              targetLabel: "Fixture provider",
              secretFieldLabel: "Fixture secret",
              storage: "os_keychain",
              scope: "installation",
              verification: "live_probe",
            }
          : undefined,
        options: choice
          ? [
              { optionId: "left", label: "Left", description: "Keep the first direction." },
              { optionId: "right", label: "Right", description: "Use the second direction." },
            ]
          : undefined,
      }
    : null;
  root.render(
    <QueryClientProvider client={client}>
      <button type="button" id="outside">
        Outside
      </button>
      <ChatBlockers
        props={
          {
            pendingApproval: approval
              ? {
                  approvalId: record.approvalId,
                  kind: record.kind,
                  riskLevel: record.riskLevel,
                  affectedResources: ["safe-target.txt"],
                  reason: "Current request",
                  codePreview: "Exact preview",
                  expiresAt: "2030-01-01T00:00:00Z",
                }
              : null,
            pendingUserInput: prompt,
            selectedSessionId: sessionId,
            approvalPending: false,
            userInputPending: false,
            onApprovePending: vi.fn(),
            onDenyPending: vi.fn(),
            onRefreshThread: resolved,
            onSubmitUserInput: submit,
          } as Parameters<typeof ChatBlockers>[0]["props"]
        }
      />
    </QueryClientProvider>,
  );
}
function renderDirect({
  workspaceId = "workspace-a",
  sessionId = "session-a",
  approval = record,
  onResolved = resolved,
} = {}) {
  root.render(
    <QueryClientProvider client={client}>
      <button type="button" id="outside">
        Outside
      </button>
      <ChatApprovalRenderer
        approvalId={approval.approvalId}
        approval={approval}
        workspaceId={workspaceId}
        sessionId={sessionId}
        recordPending={false}
        onResolved={onResolved}
        onInvalidated={invalidated}
      />
    </QueryClientProvider>,
  );
}
beforeEach(async () => {
  vi.resetModules();
  navigation.revision = 1;
  navigation.listeners.clear();
  window.history.replaceState({ fixturePosition: 7 }, "", "/chat?sessionId=session-a&shell=cockpit#current");
  Object.assign(identity, {
    gateway: "http://gateway-a",
    caller: "caller-a",
    callerRevision: 1,
    accessRevision: 1,
    workspaceId: "workspace-a",
  });
  loader.load.mockReset().mockResolvedValue(undefined);
  Object.values(api).forEach((mock) => mock.mockReset());
  resolved.mockReset();
  invalidated.mockReset();
  submit.mockReset();
  record = makeRecord();
  api.fetchApproval.mockImplementation(async () => record);
  api.resolveApproval.mockImplementation(async () => {
    record = { ...record, status: "approved" };
    return { approval: record, effects: [] };
  });
  api.fetchApprovalReplay.mockImplementation(async () => ({ approval: record, effects: [], events: [] }));
  api.fetchRuntimeLifecycle.mockImplementation(async () => ({
    approval: record,
    canonical: { approvalId: record.approvalId },
    turns: [],
  }));
  installBodyMock();
  ChatBlockers = (await import("./ChatBlockers")).ChatBlockers;
  ChatApprovalRenderer = (await import("./ChatApprovalRenderer")).ChatApprovalRenderer;
  ApiRequestError = (await import("@goatcitadel/mission-control-shared/api/http-internal")).ApiRequestError;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  await Promise.allSettled([...bodyLoads]);
  // Let the mocker store the settled exports before the next test's doMock invalidates them.
  await new Promise((settle) => setTimeout(settle, 0));
  host.remove();
  client.clear();
  vi.restoreAllMocks();
});
it("does not import approval renderers or read an approval without a pending signal", async () => {
  await act(async () => renderBlockers({ approval: false, question: true }));
  expect(loader.load).not.toHaveBeenCalled();
  expect(api.fetchApproval).not.toHaveBeenCalled();
  expect(host.textContent).toContain("Which direction?");
  expect(api.resolveApproval).not.toHaveBeenCalled();
});
it("starts code with the signal while the canonical GET is held, preserves facts, then uses the original one-click owner", async () => {
  const code = deferCode(),
    read = deferred<ApprovalRequest>();
  record = { ...record, preview: { targets: ["canonical-only-target.txt"] } };
  api.fetchApproval.mockImplementationOnce(() => read.promise);
  await act(async () => renderBlockers());
  await vi.waitFor(() => {
    expect(loader.load).toHaveBeenCalledTimes(1);
    expect(api.fetchApproval).toHaveBeenCalledExactlyOnceWith(record.approvalId, {
      workspaceId: "workspace-a",
      signal: expect.any(AbortSignal),
    });
  });
  expect(host.textContent).toContain("Current request");
  expect(host.textContent).toContain("Touches: safe-target.txt");
  expect(host.textContent).toContain("Exact preview");
  expect(host.textContent).toContain("Checking the current approval");
  expect(button("Approve once")).toBeUndefined();
  await act(async () => read.resolve(record));
  await vi.waitFor(() => expect(host.textContent).toContain("Loading approval controls"));
  // Stream facts remain visible; full canonical review is still behind the missing code, so no decision is admitted.
  expect(host.textContent).not.toContain("canonical-only-target.txt");
  expect(host.querySelector('section[aria-label="Approval scope and consequences"]')).toBeNull();
  expect(api.resolveApproval).not.toHaveBeenCalled();
  await act(async () => {
    code.resolve();
    await import("./ChatApprovalRendererBody");
    await vi.dynamicImportSettled();
  });
  await vi.waitFor(() => expect(button("Approve once")?.disabled).toBe(false));
  const canonicalReview = host.querySelector('section[aria-label="Approval scope and consequences"]')!;
  expect(canonicalReview.textContent).toContain("canonical-only-target.txt");
  expect(canonicalReview.textContent).toContain(" · one linked conversation.");
  expect(canonicalReview.textContent).not.toContain("Scope: workspace workspace-a");
  expect(canonicalReview.textContent).toContain("Consequence:");
  await act(async () => button("Approve once").click());
  expect(api.resolveApproval).toHaveBeenCalledExactlyOnceWith("approval-a", "approve");
  expect(api.fetchApproval).toHaveBeenCalledWith("approval-a", { workspaceId: "workspace-a" });
  expect(resolved).toHaveBeenCalledTimes(1);
  expect(host.textContent).not.toContain("Work completed");
});
it.each([404, 401, 403, "foreign"] as const)(
  "keeps canonical %s records unavailable after code finishes",
  async (outcome) => {
    const code = deferCode();
    if (outcome === "foreign") api.fetchApproval.mockResolvedValue({ ...record, approvalId: "foreign-record" });
    else
      api.fetchApproval.mockRejectedValue(
        new ApiRequestError("fixture unavailable", {
          kind: "http",
          method: "GET",
          path: "/api/approvals/approval-a",
          status: outcome,
        }),
      );
    await act(async () => renderBlockers());
    await vi.waitFor(() => expect(host.textContent).toContain("Current approval unavailable"));
    await act(async () => code.resolve());
    expect(button("Approve once")).toBeUndefined();
    expect(button("Review approval")).toBeUndefined();
    expect(api.resolveApproval).not.toHaveBeenCalled();
    const continuation = [...host.querySelectorAll("a")].find(
      (link) => link.textContent === "Inspect persisted approval",
    )!;
    expect(continuation).toBeDefined();
    const target = new URL(continuation.href);
    expect(target.pathname).toBe("/inbox");
    expect(target.searchParams.get("approvalId")).toBe("approval-a");
    expect(target.searchParams.get("workspaceId")).toBe("workspace-a");
    expect(target.searchParams.get("sessionId")).toBe("session-a");
    expect(target.searchParams.get("shell")).toBe("cockpit");
    expect(target.searchParams.has("shellScope")).toBe(false);
    expect(target.hash).toBe("#current");
  },
);
it.each(["caller-return", "access", "gateway", "workspace-return", "session-return", "record-return"])(
  "uses only the current canonical props and callback after %s during code loading",
  async (transition) => {
    const code = deferCode(),
      oldResolved = vi.fn(),
      otherResolved = vi.fn(),
      currentResolved = vi.fn();
    await act(async () => renderDirect({ onResolved: oldResolved }));
    await vi.waitFor(() => expect(loader.load).toHaveBeenCalledTimes(1));
    if (transition === "caller-return") identity.callerRevision += 2;
    if (transition === "access") identity.accessRevision++;
    if (transition === "gateway") identity.gateway = "http://gateway-b";
    if (transition.endsWith("-return") && transition !== "caller-return") {
      await act(async () =>
        renderDirect({
          workspaceId: transition === "workspace-return" ? "workspace-b" : "workspace-a",
          sessionId: transition === "session-return" ? "session-b" : "session-a",
          approval: transition === "record-return" ? makeRecord("approval-b") : record,
          onResolved: otherResolved,
        }),
      );
    }
    record = { ...record, preview: { targets: ["current-target.txt"] } };
    await act(async () => renderDirect({ onResolved: currentResolved }));
    const outside = host.querySelector<HTMLButtonElement>("#outside")!;
    outside.focus();
    await act(async () => code.resolve());
    await vi.waitFor(() => expect(button("Approve once")?.disabled).toBe(false));
    expect(host.textContent).toContain("current-target.txt");
    expect(document.activeElement).toBe(outside);
    await act(async () => button("Approve once").click());
    expect(oldResolved).not.toHaveBeenCalled();
    expect(otherResolved).not.toHaveBeenCalled();
    expect(currentResolved).toHaveBeenCalledTimes(1);
    expect(api.resolveApproval).toHaveBeenCalledExactlyOnceWith("approval-a", "approve");
  },
);
it("discards an old-owner loading failure when no approval remains", async () => {
  const code = deferCode();
  await act(async () => renderBlockers({ question: true }));
  await vi.waitFor(() => expect(loader.load).toHaveBeenCalledTimes(1));
  identity.callerRevision += 2;
  await act(async () => renderBlockers({ approval: false, question: true }));
  await act(async () => code.reject(new Error("private fixture chunk path")));
  expect(host.textContent).not.toContain("could not load");
  expect(host.textContent).not.toContain("private fixture");
  expect(host.textContent).toContain("Which direction?");
  expect(api.resolveApproval).not.toHaveBeenCalled();
});
it("preserves the recorded decision while canonical follow-on code loads", async () => {
  const code = deferCode();
  record = { ...record, status: "approved" };
  api.fetchRuntimeLifecycle.mockResolvedValueOnce({
    approval: record,
    canonical: { approvalId: record.approvalId, runId: "original-run-a" },
    turns: [],
  });
  api.fetchDurableRun.mockResolvedValueOnce({
    runId: "original-run-a",
    workflowKey: "fixture.original",
    status: "running",
    payload: { workspaceId: "workspace-a" },
  });
  await act(async () => renderBlockers());
  await vi.waitFor(() => expect(host.textContent).toContain("Decision recorded"));
  expect(host.textContent).toContain("Loading follow-on work");
  expect(button("Approve once")).toBeUndefined();
  expect(api.fetchApprovalReplay).not.toHaveBeenCalled();
  await act(async () => code.resolve());
  await vi.waitFor(() =>
    expect(host.querySelector('section[aria-label="Decision and follow-on work"]')).not.toBeNull(),
  );
  await vi.waitFor(() => expect(api.fetchApprovalReplay).toHaveBeenCalledExactlyOnceWith("approval-a"));
  await vi.waitFor(() => expect(host.textContent).toContain("Original linked work"));
  expect(api.fetchDurableRun).toHaveBeenCalledExactlyOnceWith("original-run-a");
  expect(host.textContent).not.toContain("Work completed");
  expect(api.resolveApproval).not.toHaveBeenCalled();
});

function dialog() {
  return document.querySelector<HTMLDivElement>('[role="dialog"]');
}
function dialogButton(label: string) {
  return [...dialog()!.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === label)!;
}
async function failedCode({ question = false, choice = false, secure = false } = {}) {
  const code = deferCode();
  await act(async () => renderBlockers({ question, choice, secure }));
  await vi.waitFor(() => expect(loader.load).toHaveBeenCalledTimes(1));
  await act(async () => code.reject(new TypeError("Failed to fetch dynamically imported module: fixture-only")));
  await vi.waitFor(() => expect(button("Reload app")).toBeDefined());
}
async function openReload() {
  const trigger = button("Reload app");
  trigger.focus();
  await act(async () => trigger.click());
  await vi.waitFor(() =>
    expect(dialog()?.textContent).toContain("Unsent question answers and unsaved edits may be lost"),
  );
  return trigger;
}
it("exposes truthful code-load recovery without automatic reload, another import, decision or raw exception", async () => {
  const reload = vi.spyOn(window.location, "reload").mockImplementation(() => undefined);
  await failedCode();
  expect(host.textContent).toContain("Approval details could not load");
  expect(host.textContent).not.toContain("fixture-only");
  expect(button("Retry approval details")).toBeUndefined();
  await openReload();
  expect(document.activeElement).toBe(dialogButton("Cancel"));
  expect(dialog()?.textContent).toContain("Reloading does not submit an answer or an approval decision");
  expect(reload).not.toHaveBeenCalled();
  expect(loader.load).toHaveBeenCalledTimes(1);
  expect(api.resolveApproval).not.toHaveBeenCalled();
});
it.each(["text", "choice", "secure"] as const)(
  "keeps the real %s question DOM and answer across reload Cancel and Escape",
  async (kind) => {
    const reload = vi.spyOn(window.location, "reload").mockImplementation(() => undefined);
    await failedCode({ question: true, choice: kind === "choice", secure: kind === "secure" });
    const form = host.querySelector<HTMLFormElement>('form[aria-label="Pending question"]')!;
    const input = form.querySelector<HTMLInputElement>(
      kind === "choice" ? 'input[value="right"]' : kind === "secure" ? 'input[type="password"]' : 'input[type="text"]',
    )!;
    await act(async () => {
      input.focus();
      if (kind === "choice") input.click();
      else {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "s".repeat(23));
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    const assertRetained = () => {
      expect(host.querySelector('form[aria-label="Pending question"]')).toBe(form);
      expect(input.isConnected).toBe(true);
      // Do not capture or print secure input material in failure diagnostics.
      expect(kind === "choice" ? input.checked : input.value.length).toBe(kind === "choice" ? true : 23);
      expect(submit).not.toHaveBeenCalled();
      expect(api.resolveApproval).not.toHaveBeenCalled();
      expect(reload).not.toHaveBeenCalled();
    };
    const trigger = await openReload();
    assertRetained();
    await act(async () => dialogButton("Cancel").click());
    await vi.waitFor(() => expect(dialog()).toBeNull());
    assertRetained();
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
    await openReload();
    await act(async () =>
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }),
      ),
    );
    await vi.waitFor(() => expect(dialog()).toBeNull());
    assertRetained();
    expect(loader.load).toHaveBeenCalledTimes(1);
    expect(button("Submit response").disabled).toBe(false);
  },
);
it("consumes explicit current-document consent once without submitting inputs, deciding or writing draft storage", async () => {
  const reload = vi.spyOn(window.location, "reload").mockImplementation(() => undefined);
  await failedCode({ question: true, choice: true });
  const form = host.querySelector('form[aria-label="Pending question"]')!;
  await openReload();
  const confirm = dialogButton("Reload app");
  const localWrite = vi.spyOn(window.localStorage, "setItem"),
    sessionWrite = vi.spyOn(window.sessionStorage, "setItem");
  const url = window.location.href,
    state = window.history.state;
  await act(async () => {
    confirm.click();
    confirm.click();
  });
  expect(reload).toHaveBeenCalledTimes(1);
  expect(submit).not.toHaveBeenCalled();
  expect(api.resolveApproval).not.toHaveBeenCalled();
  expect(localWrite).not.toHaveBeenCalled();
  expect(sessionWrite).not.toHaveBeenCalled();
  expect(window.location.href).toBe(url);
  expect(window.history.state).toEqual(state);
  // The unit reload spy leaves this document in place; real reload/canonical recovery is a separate browser proof.
  expect(host.querySelector('form[aria-label="Pending question"]')).toBe(form);
});
it.each(["caller", "access", "gateway", "url", "history-aba"] as const)(
  "refuses a still-connected confirmation after uncommitted %s departure",
  async (departure) => {
    const reload = vi.spyOn(window.location, "reload").mockImplementation(() => undefined);
    await failedCode();
    await openReload();
    const confirm = dialogButton("Reload app");
    if (departure === "caller") identity.callerRevision += 2;
    if (departure === "access") identity.accessRevision++;
    if (departure === "gateway") identity.gateway = "http://gateway-b";
    if (departure === "url")
      window.history.replaceState(window.history.state, "", "/chat?sessionId=session-b&shell=cockpit");
    if (departure === "history-aba") navigation.revision += 2;
    expect(confirm.isConnected).toBe(true);
    await act(async () => confirm.click());
    expect(reload).not.toHaveBeenCalled();
    expect(api.resolveApproval).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  },
);
it.each(["caller-return", "workspace-return", "session-return", "record-return", "history-return"] as const)(
  "invalidates reload consent through committed %s and preserves outside focus",
  async (departure) => {
    const reload = vi.spyOn(window.location, "reload").mockImplementation(() => undefined);
    await failedCode();
    await openReload();
    const stale = dialogButton("Reload app");
    if (departure === "caller-return") identity.callerRevision += 2;
    if (departure === "history-return") {
      navigation.revision += 2;
      await act(async () => navigation.listeners.forEach((listener) => listener()));
    }
    if (departure === "workspace-return") identity.workspaceId = "workspace-b";
    if (departure === "record-return") record = makeRecord("approval-b");
    await act(async () => renderBlockers({ sessionId: departure === "session-return" ? "session-b" : "session-a" }));
    identity.workspaceId = "workspace-a";
    record = makeRecord();
    await act(async () => renderBlockers());
    const outside = host.querySelector<HTMLButtonElement>("#outside")!;
    outside.focus();
    await act(async () => stale.click());
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(outside);
    expect(reload).not.toHaveBeenCalled();
    expect(api.resolveApproval).not.toHaveBeenCalled();
  },
);
