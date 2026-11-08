import { useEffect } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vitest";
import type { ChangePlanRecord, ChangePlanRequiredAction } from "@goatcitadel/contracts";
import { ChatChangePlanActionDialog } from "./ChatChangePlanActionDialog";
const gate = vi.hoisted(() => ({
  loads: 0,
  release: undefined as (() => void) | undefined,
  reject: undefined as ((error: Error) => void) | undefined,
  mounts: 0,
  unmounts: 0,
}));
let modal: { confirmDisabled?: boolean; onConfirm?: () => void | Promise<void> } | null = null;
vi.mock("../../api/capabilities", () => ({
  fetchCandidateSkillArtifactReview: vi.fn(),
  fetchCapabilityCandidate: vi.fn(),
}));
vi.mock("../ui", () => ({
  GCModal: (props: { children?: unknown; confirmDisabled?: boolean; onConfirm?: () => void | Promise<void> }) => {
    modal = props;
    useEffect(() => {
      gate.mounts++;
      return () => {
        gate.unmounts++;
      };
    }, []);
    return <section>{props.children as never}</section>;
  },
}));
vi.mock("./ChatChangePlanActionDialogBody", async () => {
  gate.loads++;
  let browserFailure: Error | undefined;
  // A throwing Vitest factory wraps its cause. Reject the actual lazy loader
  // through its export access so the boundary receives the browser TypeError.
  await new Promise<void>((resolve) => {
    gate.reject = (error) => {
      browserFailure = error;
      resolve();
    };
  });
  return {
    get ChatChangePlanActionDialogBody(): never {
      throw browserFailure;
    },
  };
});

function plan(requiredAction: ChangePlanRequiredAction): ChangePlanRecord {
  return {
    schemaVersion: 1,
    planId: "plan-1",
    origin: { surface: "chat", workspaceId: "workspace-1", sessionId: "session-1" },
    adapter: { adapterId: "test", version: 1 },
    kind: "provider_connection",
    scope: "provider",
    status: "awaiting_input",
    phase: "input",
    revision: 2,
    request: { kind: "provider_connection", providerId: "openai" },
    intentHash: "intent-hash",
    target: { ownerId: "provider_connection", resourceId: "openai", expectedRevision: 3 },
    title: "Connect OpenAI",
    summary: "Connect the provider.",
    impact: "A live verification runs.",
    risk: "safe",
    requiredAction,
    actionSnapshotHash: "snapshot-hash",
    approvalRefs: [],
    evidenceRefs: [],
    rollbackRefs: [],
    expiresAt: "2099-01-01T00:00:00.000Z",
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
  };
}

function callbacks() {
  return {
    onClose: vi.fn(),
    onConfirm: vi.fn(),
    onSubmitPublicForm: vi.fn(),
    onSubmitSecureInput: vi.fn(),
    onContinueOAuth: vi.fn(),
    onOpenApproval: vi.fn(),
    onReviewArtifacts: vi.fn(),
    onOpenNativePathPicker: vi.fn(),
  };
}

it("keeps a failed body nonconfirmable and exposes reload recovery in the existing modal", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined),
    handlers = callbacks();
  const reload = vi.fn();
  vi.stubGlobal("location", { reload });
  let renderer!: ReactTestRenderer;
  const current = plan({
    kind: "confirmation",
    actionId: "action-1",
    actionNonce: "nonce-1",
    title: "Apply current change",
    confirmationText: "Apply exact change?",
    purpose: "apply",
  } as ChangePlanRequiredAction);
  try {
    await act(async () => {
      renderer = create(<ChatChangePlanActionDialog plan={current} {...handlers} />);
    });
    await vi.waitFor(() => expect(gate.reject).toBeTypeOf("function"));
    expect(gate.loads).toBe(1);
    await act(async () => {
      renderer.update(<ChatChangePlanActionDialog plan={null} {...handlers} />);
    });
    expect(renderer.toJSON()).toBeNull();
    await act(async () => {
      gate.reject!(new TypeError("Failed to fetch dynamically imported module"));
      await vi.dynamicImportSettled();
    });
    expect(renderer.toJSON()).toBeNull();
    await act(async () => {
      renderer.update(<ChatChangePlanActionDialog plan={current} {...handlers} />);
      await vi.dynamicImportSettled();
    });
    expect(modal?.confirmDisabled).toBe(true);
    await act(async () => modal?.onConfirm?.());
    expect(handlers.onConfirm).not.toHaveBeenCalled();
    const retry = renderer.root.findAllByType("button").find((button) => button.children.join("") === "Retry page");
    expect(retry).toBeDefined();
    await act(async () => retry!.props.onClick());
    expect(reload).toHaveBeenCalledExactlyOnceWith();
    expect(modal?.confirmDisabled).toBe(true);
    expect(handlers.onConfirm).not.toHaveBeenCalled();
    expect(gate.mounts).toBe(2);
    await act(async () => {
      renderer.update(<ChatChangePlanActionDialog plan={null} {...handlers} />);
    });
    expect(renderer.toJSON()).toBeNull();
  } finally {
    if (renderer) await act(async () => renderer.unmount());
    log.mockRestore();
    vi.unstubAllGlobals();
  }
});
