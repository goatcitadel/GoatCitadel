// @vitest-environment happy-dom
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChangePlanRecord, OnboardingState } from "@goatcitadel/contracts";
import { onboardingFixture } from "../../../features/native-routes/settings/onboarding.test-support";
import { __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";
import { CockpitGuidedModelSetup } from "./CockpitGuidedModelSetup";
import { SIGN_IN_WAITING_NOTE } from "./guided-provider-sign-in";

const mocks = vi.hoisted(() => ({
  catalog: vi.fn(),
  plans: vi.fn(),
  start: vi.fn(),
  poll: vi.fn(),
  complete: vi.fn(),
  create: vi.fn(),
  workspace: { activeWorkspaceId: undefined as string | undefined },
}));
vi.mock("@goatcitadel/mission-control-shared/hooks/useProviderModelCatalog", () => ({
  useProviderModelCatalog: mocks.catalog,
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  fetchChangePlans: mocks.plans,
  createChangePlan: mocks.create,
  cancelChangePlan: vi.fn(),
  completeChangePlanProviderOAuth: mocks.complete,
  confirmChangePlan: vi.fn(),
  pollChangePlanProviderOAuth: mocks.poll,
  respondToChangePlan: vi.fn(),
  startChangePlanProviderOAuth: mocks.start,
  submitChangePlanProviderSecret: vi.fn(),
}));
// A stand-in for the shared dialog: one button per callback this test drives.
vi.mock("@goatcitadel/mission-control-shared/components/chat/ChatChangePlanActionDialog", () => ({
  ChatChangePlanActionDialog: (props: {
    plan: ChangePlanRecord | null;
    pending: boolean;
    waiting?: boolean;
    contextNote?: string;
    error?: string | null;
    onClose: () => void;
    onContinueOAuth: (plan: ChangePlanRecord) => void | Promise<void>;
  }) =>
    props.plan ? (
      <div
        role="dialog"
        data-revision={props.plan.revision}
        data-pending={String(props.pending)}
        data-waiting={String(Boolean(props.waiting))}
      >
        {props.contextNote ? <p role="note">{props.contextNote}</p> : null}
        {props.error ? <p role="alert">{props.error}</p> : null}
        <button type="button" onClick={() => void props.onContinueOAuth(props.plan!)}>
          Continue sign-in
        </button>
        <button type="button" onClick={props.onClose}>
          Close
        </button>
      </div>
    ) : null,
}));
vi.mock("@goatcitadel/mission-control-shared/components/chat/ChatChangePlanCard", () => ({
  ChatChangePlanCard: () => null,
}));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => mocks.workspace,
}));
vi.mock("../../app/use-cockpit-route", () => ({ useCockpitRoute: () => ({ navigate: vi.fn() }) }));

// Captured before the fake clock installs: React's scheduler keeps its own real setImmediate.
const realSetImmediate = globalThis.setImmediate;
/** Lets React's scheduler run its queued tasks (a commit, then its passive effects) on the real clock. */
const drainScheduler = async () => {
  for (let turn = 0; turn < 10; turn += 1) await new Promise<void>((resolve) => realSetImmediate(() => resolve()));
};
/** Calls `onCommit` from a layout effect: during the commit, before that commit's passive effects run. */
function CommitProbe({ onCommit }: { onCommit?: () => void }) {
  useLayoutEffect(() => onCommit?.(), [onCommit]);
  return null;
}

let root: Root, container: HTMLDivElement, onboarding: OnboardingState, mounted: boolean;
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((item) => item.textContent?.trim() === label);
const dialog = () => container.querySelector('[role="dialog"]');
const oauthPlan = {
  planId: "plan-oauth",
  kind: "provider_connection",
  status: "awaiting_input",
  revision: 1,
  origin: { workspaceId: "default", surface: "settings" },
  request: { kind: "provider_connection", providerId: "test" },
  requiredAction: { kind: "oauth", actionId: "oauth-1", actionNonce: "nonce-1", title: "Sign in" },
};
const render = () =>
  act(async () => {
    root.render(
      <CockpitGuidedModelSetup onboarding={onboarding} reloadOnboarding={async () => {}} onEnterChat={() => {}} />,
    );
  });
const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
/** Opens the pending sign-in plan and starts polling it. */
const startSignIn = async () => {
  await render();
  await act(async () => button("Connect provider")!.click());
  expect(dialog()).not.toBeNull();
  await act(async () => button("Continue sign-in")!.click());
  expect(mocks.start).toHaveBeenCalledOnce();
  await advance(1_000);
  expect(mocks.poll).toHaveBeenCalledOnce();
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  __resetSessionDraftsForTests();
  mocks.workspace.activeWorkspaceId = undefined;
  onboarding = onboardingFixture();
  onboarding.settings.llm.activeProviderId = "test";
  onboarding.settings.llm.activeModel = "test-model";
  mocks.catalog.mockReturnValue({
    providers: [
      {
        providerId: "test",
        label: "Test provider",
        hasApiKey: false,
        authReadiness: { status: "missing" },
        defaultModel: "test-model",
      },
    ],
    config: { defaultThinkingLevel: "standard" },
    loadModelsForProvider: vi.fn().mockResolvedValue(["test-model"]),
    reload: vi.fn(),
    loading: false,
  });
  mocks.plans.mockResolvedValue({ items: [oauthPlan] });
  mocks.start.mockResolvedValue({
    flowId: "flow-1",
    providerId: "openai-codex",
    verificationUrl: "https://auth.openai.com/device",
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    pollAfterMs: 1_000,
  });
  mocks.poll.mockResolvedValue({
    flowId: "flow-1",
    providerId: "openai-codex",
    status: "pending",
    retryAfterMs: 1_000,
  });
  vi.stubGlobal("open", vi.fn());
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mounted = true;
});
afterEach(() => {
  if (mounted) act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("guided setup provider sign-in polling", () => {
  it("cannot be cancelled once completion begins, and records the completed plan", async () => {
    let resolveComplete!: (plan: unknown) => void;
    mocks.complete.mockReturnValue(new Promise((resolve) => (resolveComplete = resolve)));
    mocks.poll.mockResolvedValue({ flowId: "flow-1", providerId: "openai-codex", status: "connected" });
    await render();
    await act(async () => button("Connect provider")!.click());
    await act(async () => button("Continue sign-in")!.click());
    await advance(1_000);
    expect(mocks.complete).toHaveBeenCalledOnce();
    // Completion owns the plan now: Close neither dismisses the dialog nor aborts the run.
    expect(dialog()?.getAttribute("data-pending")).toBe("true");
    expect(dialog()?.getAttribute("data-waiting")).toBe("false");
    await act(async () => button("Close")!.click());
    expect(dialog()).not.toBeNull();
    await act(async () => {
      resolveComplete({
        ...oauthPlan,
        revision: 2,
        requiredAction: { kind: "confirmation", actionId: "confirm-1", actionNonce: "nonce-2", title: "Confirm" },
      });
    });
    expect(dialog()?.getAttribute("data-revision")).toBe("2");
    expect(dialog()?.getAttribute("data-pending")).toBe("false");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
  it("closes while the sign-in is still pending and stops polling", async () => {
    await startSignIn();
    // The shared dialog refuses to close while pending, so a polling sign-in leaves it dismissible.
    expect(dialog()?.getAttribute("data-pending")).toBe("false");
    // ...but still says it waits on the browser, and its confirm action shows as working.
    expect(dialog()?.getAttribute("data-waiting")).toBe("true");
    expect(container.querySelector('[role="note"]')?.textContent).toBe(SIGN_IN_WAITING_NOTE);
    expect(container.querySelector("select")?.disabled).toBe(true);
    await act(async () => button("Continue sign-in")!.click());
    expect(mocks.start).toHaveBeenCalledOnce();
    await act(async () => button("Close")!.click());
    expect(dialog()).toBeNull();
    await advance(10_000);
    expect(mocks.poll).toHaveBeenCalledOnce();
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(container.querySelector("select")?.disabled).toBe(false);
  });
  it("stops polling on unmount", async () => {
    await startSignIn();
    act(() => root.unmount());
    mounted = false;
    await advance(10_000);
    expect(mocks.poll).toHaveBeenCalledOnce();
    expect(mocks.complete).not.toHaveBeenCalled();
  });
  it("stops polling when the workspace changes", async () => {
    await startSignIn();
    mocks.workspace.activeWorkspaceId = "other";
    await render();
    await advance(10_000);
    expect(mocks.poll).toHaveBeenCalledOnce();
    expect(mocks.complete).not.toHaveBeenCalled();
  });
  it("ends with an expiry error once the flow's expiresAt passes", async () => {
    mocks.start.mockResolvedValue({
      flowId: "flow-1",
      providerId: "openai-codex",
      verificationUrl: "https://auth.openai.com/device",
      expiresAt: new Date(Date.now() + 3_500).toISOString(),
      pollAfterMs: 1_000,
    });
    await startSignIn();
    await advance(10_000);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Sign-in expired. Start it again.");
    expect(dialog()?.getAttribute("data-pending")).toBe("false");
    expect(dialog()?.getAttribute("data-waiting")).toBe("false");
    expect(container.querySelector('[role="note"]')).toBeNull();
    expect(container.querySelector("select")?.disabled).toBe(false);
    const polls = mocks.poll.mock.calls.length;
    await advance(10_000);
    expect(mocks.poll).toHaveBeenCalledTimes(polls);
    expect(mocks.complete).not.toHaveBeenCalled();
  });
});

describe("guided setup sign-in completion across a workspace switch", () => {
  const revised = {
    ...oauthPlan,
    revision: 2,
    requiredAction: { kind: "confirmation", actionId: "confirm-1", actionNonce: "nonce-2", title: "Confirm" },
  };
  const createdPlan = {
    ...oauthPlan,
    planId: "plan-created",
    revision: 7,
    requiredAction: { kind: "oauth", actionId: "oauth-7", actionNonce: "nonce-7", title: "Sign in" },
  };
  const switchTo = async (workspaceId: string | undefined) => {
    mocks.workspace.activeWorkspaceId = workspaceId;
    await render();
  };
  /** Starts a sign-in whose completion stays in flight; the Gateway serves the old revision until it settles. */
  const startCompletion = async () => {
    let settle!: (plan: unknown) => void;
    let settled = false;
    mocks.complete.mockReturnValue(new Promise((resolve) => (settle = resolve)));
    mocks.plans.mockImplementation(async ({ workspaceId }: { workspaceId: string }) => ({
      items: workspaceId === "default" ? [settled ? revised : oauthPlan] : [],
    }));
    mocks.poll.mockResolvedValue({ flowId: "flow-1", providerId: "openai-codex", status: "connected" });
    await render();
    await act(async () => button("Connect provider")!.click());
    await act(async () => button("Continue sign-in")!.click());
    await advance(1_000);
    expect(mocks.complete).toHaveBeenCalledOnce();
    return () =>
      act(async () => {
        settled = true;
        settle(revised);
      });
  };

  it("leaves the new workspace untouched and shows the completed plan back in its own workspace", async () => {
    const settle = await startCompletion();
    await switchTo("other");
    expect(dialog()).toBeNull();
    await settle();
    expect(dialog()).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector("select")?.disabled).toBe(false);
    await switchTo(undefined);
    await act(async () => button("Connect provider")!.click());
    expect(dialog()?.getAttribute("data-revision")).toBe("2");
  });
  it("re-reads its workspace's plans when completion settles after a switch away and back", async () => {
    const settle = await startCompletion();
    await switchTo("other");
    // Back before completion settles: this read still returns the pre-completion revision.
    await switchTo(undefined);
    const readsBeforeSettle = mocks.plans.mock.calls.length;
    await settle();
    expect(mocks.plans.mock.calls.length).toBeGreaterThan(readsBeforeSettle);
    expect(mocks.plans).toHaveBeenLastCalledWith({ workspaceId: "default" }, { limit: 25 });
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await act(async () => button("Connect provider")!.click());
    expect(dialog()?.getAttribute("data-revision")).toBe("2");
  });
  it("keeps a plan revision it recorded when an older plan read answers after it", async () => {
    const settleFirst = await startCompletion();
    await switchTo("other");
    await switchTo(undefined);
    // A second sign-in in this visit, whose completion also stays in flight.
    let settleSecond!: (plan: unknown) => void;
    mocks.complete.mockReturnValue(new Promise((resolve) => (settleSecond = resolve)));
    await act(async () => button("Connect provider")!.click());
    expect(dialog()?.getAttribute("data-revision")).toBe("1");
    await act(async () => button("Continue sign-in")!.click());
    await advance(1_000);
    expect(mocks.complete).toHaveBeenCalledTimes(2);
    // The re-read after the first completion snapshots revision 2 but answers only after the second records 3.
    let answerRead: (() => void) | undefined;
    mocks.plans.mockImplementation(() => new Promise((resolve) => (answerRead = () => resolve({ items: [revised] }))));
    await settleFirst();
    // The second sign-in still runs, so the re-read waits for it to settle.
    expect(answerRead).toBeUndefined();
    const latest = {
      ...oauthPlan,
      revision: 3,
      requiredAction: { kind: "confirmation", actionId: "confirm-2", actionNonce: "nonce-3", title: "Confirm" },
    };
    await act(async () => settleSecond(latest));
    expect(dialog()?.getAttribute("data-revision")).toBe("3");
    expect(answerRead).toBeDefined();
    await act(async () => answerRead!());
    await act(async () => button("Close")!.click());
    await act(async () => button("Connect provider")!.click());
    expect(dialog()?.getAttribute("data-revision")).toBe("3");
  });
  it("keeps a plan an action created while a completion re-read was due", async () => {
    const settleFirst = await startCompletion();
    await switchTo("other");
    // Back in this workspace, its plan list names no connection plan, so Connect creates one. A read the Gateway
    // answers before the create persists snapshots that empty list, whenever its answer arrives.
    let created = false;
    const staleReads: Array<() => void> = [];
    mocks.plans.mockImplementation(() =>
      created
        ? Promise.resolve({ items: [createdPlan] })
        : new Promise((resolve) => staleReads.push(() => resolve({ items: [] }))),
    );
    await switchTo(undefined);
    let finishCreate!: () => void;
    mocks.create.mockReturnValue(
      new Promise((resolve) => {
        finishCreate = () => {
          created = true;
          resolve(createdPlan);
        };
      }),
    );
    await act(async () => button("Connect provider")!.click());
    expect(mocks.create).toHaveBeenCalledOnce();
    // The first completion settles while the create is in flight; a read started now would miss the new plan.
    await settleFirst();
    await act(async () => finishCreate());
    expect(dialog()?.getAttribute("data-revision")).toBe("7");
    await act(async () => staleReads.forEach((answer) => answer()));
    await act(async () => button("Close")!.click());
    await act(async () => button("Connect provider")!.click());
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(dialog()?.getAttribute("data-revision")).toBe("7");
  });
  it("discards a completion that settles after the switch commits but before its passive effects run", async () => {
    const completed = { ...oauthPlan, revision: 2, status: "completed", requiredAction: undefined };
    let settle!: (plan: unknown) => void;
    mocks.complete.mockReturnValue(new Promise((resolve) => (settle = resolve)));
    mocks.poll.mockResolvedValue({ flowId: "flow-1", providerId: "openai-codex", status: "connected" });
    const reloadOnboarding = vi.fn(async () => {});
    const tree = (onCommit?: () => void) => (
      <>
        <CockpitGuidedModelSetup onboarding={onboarding} reloadOnboarding={reloadOnboarding} onEnterChat={() => {}} />
        <CommitProbe onCommit={onCommit} />
      </>
    );
    await act(async () => root.render(tree()));
    await act(async () => button("Connect provider")!.click());
    await act(async () => button("Continue sign-in")!.click());
    await advance(1_000);
    expect(mocks.complete).toHaveBeenCalledOnce();
    const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
    try {
      // Outside act, React commits this update in one scheduler task and runs its passive effects in a later one.
      // The probe settles the completion during the commit, so the result arrives inside that gap.
      mocks.workspace.activeWorkspaceId = "other";
      root.render(tree(() => settle(completed)));
      await drainScheduler();
    } finally {
      actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    }
    await act(async () => {});
    expect(reloadOnboarding).not.toHaveBeenCalled();
    expect(dialog()).toBeNull();
  });
  it("releases busy for an action started after the switch commits but before its passive effects run", async () => {
    mocks.plans.mockResolvedValue({ items: [] });
    let failCreate!: () => void;
    mocks.create.mockReturnValueOnce(new Promise((_resolve, reject) => (failCreate = () => reject(new Error("boom")))));
    const tree = (onCommit?: () => void) => (
      <>
        <CockpitGuidedModelSetup onboarding={onboarding} reloadOnboarding={async () => {}} onEnterChat={() => {}} />
        <CommitProbe onCommit={onCommit} />
      </>
    );
    await act(async () => root.render(tree()));
    const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
    try {
      // The probe starts Connect during the switch's commit, so the action takes its generation inside the gap.
      mocks.workspace.activeWorkspaceId = "other";
      root.render(tree(() => button("Connect provider")!.click()));
      await drainScheduler();
    } finally {
      actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    }
    expect(mocks.create).toHaveBeenCalledOnce();
    await act(async () => failCreate());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("boom");
    expect(container.querySelector("select")?.disabled).toBe(false);
    // The action released busy, so the next Connect runs instead of returning early.
    mocks.create.mockResolvedValueOnce(createdPlan);
    await act(async () => button("Connect provider")!.click());
    expect(mocks.create).toHaveBeenCalledTimes(2);
    expect(dialog()?.getAttribute("data-revision")).toBe("7");
  });
});
