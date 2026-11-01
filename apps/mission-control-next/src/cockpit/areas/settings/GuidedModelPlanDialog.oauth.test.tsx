// @vitest-environment happy-dom
import { act } from "react";
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
  workspace: { activeWorkspaceId: undefined as string | undefined },
}));
vi.mock("@goatcitadel/mission-control-shared/hooks/useProviderModelCatalog", () => ({
  useProviderModelCatalog: mocks.catalog,
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  fetchChangePlans: mocks.plans,
  createChangePlan: vi.fn(),
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
      <div role="dialog" data-pending={String(props.pending)} data-waiting={String(Boolean(props.waiting))}>
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
