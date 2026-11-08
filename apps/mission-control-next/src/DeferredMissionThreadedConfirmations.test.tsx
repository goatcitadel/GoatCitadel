// @vitest-environment happy-dom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

let Confirmations: typeof import("../../../packages/threaded-surface-core/src/DeferredMissionThreadedConfirmations").DeferredMissionThreadedConfirmations;
type Props = ComponentProps<typeof Confirmations>;

let root: Root;
let host: HTMLDivElement;
const load = vi.fn<() => Promise<void>>();
const runtime = vi.fn((_props: Props) => <p>Ready confirmation controls</p>);

function closedProps(): Props {
  return {
    visible: true,
    planContext: {
      workspaceId: "workspace-current",
      prefsRef: { current: null },
      setPrefs: vi.fn(),
      setUiError: vi.fn(),
      pushLocalNotice: vi.fn(),
      recordChangePlanResult: (plan) => plan,
      onOpenApprovals: vi.fn(),
    },
    forkConfirm: null,
    forkPending: false,
    setForkConfirm: vi.fn(),
    blockHistoricalMutation: () => false,
    handleStartNewThreadFromTurn: vi.fn().mockResolvedValue(undefined),
    capabilitySuggestionConfirm: false,
    capabilityConfirmationCopy: null,
    capabilitySuggestionPending: false,
    setCapabilitySuggestionConfirm: vi.fn(),
    handleConfirmCapabilitySuggestion: vi.fn(),
    activeChangePlan: null,
    linkedDefaultChangePlan: null,
    changePlanActionPending: false,
    changePlanActionError: null,
    changePlanOAuthFlow: null,
    turnCount: 0,
    setActiveChangePlan: vi.fn(),
    setLinkedDefaultChangePlan: vi.fn(),
    setChangePlanActionError: vi.fn(),
    setChangePlanActionPending: vi.fn(),
    setChangePlanOAuthFlow: vi.fn(),
    sessionDeleteConfirm: null,
    sessionControlPending: null,
    setSessionDeleteConfirm: vi.fn(),
    handleConfirmDeleteSession: vi.fn(),
    archiveWorkspaceConfirmOpen: false,
    workspaceMissionSessionCount: 0,
    archiveWorkspacePending: false,
    setArchiveWorkspaceConfirmOpen: vi.fn(),
    handleConfirmArchiveWorkspace: vi.fn(),
  };
}

function holdRuntime() {
  let release!: () => void;
  load.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
  return () => release();
}

beforeEach(async () => {
  vi.resetModules();
  load.mockReset().mockResolvedValue(undefined);
  runtime.mockClear();
  vi.doMock("../../../packages/threaded-surface-core/src/MissionThreadedConfirmations", async () => {
    await load();
    return { MissionThreadedConfirmations: runtime };
  });
  Confirmations = (await import("../../../packages/threaded-surface-core/src/DeferredMissionThreadedConfirmations"))
    .DeferredMissionThreadedConfirmations;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.doUnmock("../../../packages/threaded-surface-core/src/MissionThreadedConfirmations");
  vi.doUnmock("@goatcitadel/mission-control-shared/api/client");
});

const render = (props: Props) => act(async () => root.render(
  <>
    <button type="button" data-confirm-opener>Open confirmation</button>
    <Confirmations {...props} />
  </>,
));
const pendingDialog = () => document.querySelector('[role="dialog"]');
const cancel = () => pendingDialog()?.querySelector<HTMLButtonElement>('button[aria-label="Cancel"]');

it("keeps confirmation code cold and preserves the pending Escape and focus behavior", async () => {
  const release = holdRuntime();
  const props = closedProps();
  await render(props);
  await act(async () => { await vi.dynamicImportSettled(); });
  expect(load).not.toHaveBeenCalled();
  expect(pendingDialog()).toBeNull();
  const opener = host.querySelector<HTMLButtonElement>("[data-confirm-opener]")!;
  opener.focus();

  await render({ ...props, archiveWorkspaceConfirmOpen: true });
  await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
  expect(pendingDialog()?.textContent).toContain("Archive Workspace Mission Chats");
  cancel()?.focus();
  await act(async () => cancel()?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(props.setArchiveWorkspaceConfirmOpen).toHaveBeenCalledExactlyOnceWith(false);
  expect(props.handleConfirmArchiveWorkspace).not.toHaveBeenCalled();

  await render(props);
  expect(document.activeElement).toBe(opener);
  await act(async () => {
    release();
    await vi.dynamicImportSettled();
  });
  expect(pendingDialog()).toBeNull();
  expect(runtime).not.toHaveBeenCalled();
});

it("uses the current confirmation and preserves pending action guards", async () => {
  const release = holdRuntime();
  const props = closedProps();
  await render({ ...props, archiveWorkspaceConfirmOpen: true, archiveWorkspacePending: true });
  await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
  expect(cancel()?.disabled).toBe(true);
  await act(async () => cancel()?.click());
  expect(props.setArchiveWorkspaceConfirmOpen).not.toHaveBeenCalled();

  const forkConfirm = { turnId: "current-turn", turnCount: 1, attachmentCount: 0, artifactCount: 0 };
  await render({ ...props, forkConfirm });
  expect(pendingDialog()?.textContent).toContain("Start a new conversation from this message?");
  await act(async () => {
    release();
    await vi.dynamicImportSettled();
  });
  await vi.waitFor(() => expect(runtime).toHaveBeenCalled());
  expect(runtime.mock.lastCall?.[0]).toMatchObject({ forkConfirm, archiveWorkspaceConfirmOpen: false });
  expect(pendingDialog()).toBeNull();
  expect(props.handleStartNewThreadFromTurn).not.toHaveBeenCalled();
});

it("keeps failed Change Plan loading dismissible and clears the original owner state", async () => {
  load.mockRejectedValueOnce(new Error("private fixture failure"));
  const props = closedProps();
  const activeChangePlan = { planId: "plan-current" } as NonNullable<Props["activeChangePlan"]>;
  await render({ ...props, activeChangePlan });
  await vi.waitFor(() => expect(pendingDialog()?.querySelector('[role="alert"]')?.textContent)
    .toBe("Confirmation controls could not load."));
  await act(async () => cancel()?.click());
  expect(props.setActiveChangePlan).toHaveBeenCalledExactlyOnceWith(null);
  expect(props.setLinkedDefaultChangePlan).toHaveBeenCalledExactlyOnceWith(null);
  expect(props.setChangePlanActionError).toHaveBeenCalledExactlyOnceWith(null);
  expect(runtime).not.toHaveBeenCalled();
});

it("polls a matching OAuth flow while the frame hides its confirmation view", async () => {
  const poll = vi.fn().mockResolvedValue({ status: "pending" });
  vi.doUnmock("../../../packages/threaded-surface-core/src/MissionThreadedConfirmations");
  vi.doMock("@goatcitadel/mission-control-shared/api/client", async (importOriginal) => ({
    ...await importOriginal<typeof import("@goatcitadel/mission-control-shared/api/client")>(),
    pollChangePlanProviderOAuth: poll,
  }));
  await vi.importActual("../../../packages/threaded-surface-core/src/MissionThreadedConfirmations");
  const props = closedProps();
  const activeChangePlan = {
    planId: "plan-current",
    origin: { sessionId: "session-current" },
  } as NonNullable<Props["activeChangePlan"]>;
  await render({
    ...props,
    visible: false,
    activeChangePlan,
    changePlanOAuthFlow: {
      planId: activeChangePlan.planId,
      planRevision: 3,
      actionId: "action-current",
      actionNonce: "nonce-current",
      flow: {
        flowId: "flow-current",
        providerId: "openai-codex",
        verificationUrl: "https://example.test/verify",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        pollAfterMs: 1000,
      },
    },
  });
  await act(async () => { await vi.dynamicImportSettled(); });
  await vi.waitFor(() => expect(poll).toHaveBeenCalledExactlyOnceWith(
    "plan-current",
    { workspaceId: "workspace-current", sessionId: "session-current" },
    { expectedRevision: 3, actionId: "action-current", actionNonce: "nonce-current", flowId: "flow-current" },
  ), { timeout: 4000 });
  expect(pendingDialog()).toBeNull();
});
