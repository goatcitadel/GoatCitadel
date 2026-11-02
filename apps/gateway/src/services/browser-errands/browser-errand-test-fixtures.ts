/** Fakes for the browser errand service and route tests: a scripted browser, gate and loop. */
import type { ToolInvokeRequest } from "@goatcitadel/contracts";
import type { ErrandBrowser, ErrandOverlayEvent } from "@goatcitadel/policy-engine";
import type { ErrandApprovalGate, ErrandApprovalGateDeps } from "./errand-approval-gate.js";
import type { ErrandLoopDeps, ErrandOutcome } from "./errand-loop.js";
import { BrowserErrandService, type BrowserErrandServiceDeps } from "./browser-errand-service.js";

/** The test runner's spy factory (vi.fn), passed in so this file stays free of test-only imports. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- spies wrap any function shape
export type Spy = <T extends (...args: any[]) => any>(impl: T) => T;

export interface FakeBrowser extends ErrandBrowser {
  fireOverlay(event: ErrandOverlayEvent): void;
  fireClosed(): void;
  renders: unknown[];
}

export function fakeBrowser(spy: Spy): FakeBrowser {
  const overlayListeners = new Set<(event: ErrandOverlayEvent) => void>();
  const closedListeners = new Set<() => void>();
  let closed = false;
  const renders: unknown[] = [];
  const browser = {
    renders,
    page: () => {
      throw new Error("no page in tests");
    },
    currentUrl: () => "https://shop.example/",
    captureForModel: async () => Buffer.from("model-png"),
    captureForPeople: async () => Buffer.from("people-png"),
    isClosed: () => closed,
    onClosed: (listener: () => void) => {
      closedListeners.add(listener);
      return () => closedListeners.delete(listener);
    },
    close: spy(async () => {
      closed = true;
    }),
    describeTarget: async () => null,
    describeTargetBeneathOverlay: async () => null,
    describeFocused: async () => null,
    describeFocusedBeneathOverlay: async () => null,
    runActions: async () => ({ ran: 0, halted: false }),
    overlay: {
      render: async (state: unknown) => {
        renders.push(state);
      },
      onEvent: (listener: (event: ErrandOverlayEvent) => void) => {
        overlayListeners.add(listener);
        return () => overlayListeners.delete(listener);
      },
      snapshot: async () => ({ connected: true, displayed: true, mode: "driving" }),
      withAutomationInput: async <T>(dispatch: () => Promise<T>) => await dispatch(),
    },
    fireOverlay: (event: ErrandOverlayEvent) => {
      for (const listener of [...overlayListeners]) listener(event);
    },
    fireClosed: () => {
      closed = true;
      for (const listener of [...closedListeners]) listener();
    },
  };
  return browser as unknown as FakeBrowser;
}

export function fakeGate(spy: Spy, overrides: Partial<ErrandApprovalGate> = {}): ErrandApprovalGate {
  return {
    request: spy(async () => "approved" as const),
    withdrawPending: spy(async () => undefined),
    recordAfterScreenshot: spy(async () => undefined),
    lastReason: undefined,
    ...overrides,
  };
}

export function outcome(status: ErrandOutcome["status"], partial: Partial<ErrandOutcome> = {}): ErrandOutcome {
  return { status, summary: `ended: ${status}`, steps: 1, modelRequests: 1, visitedUrls: [], ...partial };
}

/** A loop that runs until the errand's signal aborts. */
export function untilAborted(deps: ErrandLoopDeps): Promise<ErrandOutcome> {
  return new Promise((resolve) => {
    const finish = (): void => resolve(outcome("stopped", { summary: "The errand was stopped." }));
    if (deps.signal.aborted) finish();
    deps.signal.addEventListener("abort", finish, { once: true });
  });
}

export function errandRequest(overrides: Partial<ToolInvokeRequest> = {}): ToolInvokeRequest {
  return {
    toolName: "browser.errand",
    args: { goal: "find a USB-C hub under $40" },
    agentId: "assistant",
    sessionId: "session-1",
    turnId: "turn-1",
    toolRunId: "tool-run-1",
    surface: "chat",
    ...overrides,
  };
}

export function buildService(spy: Spy, overrides: Partial<BrowserErrandServiceDeps> = {}) {
  const browser = fakeBrowser(spy);
  const gate = fakeGate(spy);
  const uploads: Array<{ fileName: string; bytes: Buffer }> = [];
  const createGate = spy((_deps: ErrandApprovalGateDeps) => gate);
  const launchBrowser = spy(async () => browser as ErrandBrowser);
  const deps: BrowserErrandServiceDeps = {
    isEnabled: async () => true,
    deploymentProfile: () => "trusted_local",
    sessionChannel: async () => "mission",
    launchBrowser,
    callModel: spy(async () => {
      throw new Error("the fake loop never calls the model");
    }),
    gate: {
      approvals: {} as never,
      storage: {} as never,
      realtime: { subscribeRealtime: () => () => undefined },
      attachments: {
        upload: async (input) => {
          uploads.push({ fileName: input.fileName, bytes: input.bytes });
          return { attachmentId: `att-${uploads.length}`, sha256: "sha" };
        },
      },
    },
    createGate,
    runLoop: async () => outcome("done", { answer: "Found one." }),
    ...overrides,
  };
  return { service: new BrowserErrandService(deps), browser, gate, uploads, launchBrowser, createGate };
}
