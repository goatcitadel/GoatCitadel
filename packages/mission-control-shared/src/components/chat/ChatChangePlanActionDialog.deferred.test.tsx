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
  await new Promise<void>((resolve) => {
    gate.release = resolve;
  });
  return {
    ChatChangePlanActionDialogBody: ({
      plan,
      onReady,
    }: {
      plan: ChangePlanRecord;
      onReady: (ready: boolean) => void;
    }) => {
      useEffect(() => onReady(true), [onReady]);
      return <p>Current review {plan.planId}</p>;
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

it("demands a restored review immediately, keeps one modal through loading, and uses the current plan", async () => {
  const handlers = callbacks();
  const first = plan({
    kind: "confirmation",
    actionId: "action-1",
    actionNonce: "nonce-1",
    title: "Apply current change",
    confirmationText: "Apply the exact change?",
    purpose: "apply",
  } as ChangePlanRequiredAction);
  const second = { ...first, planId: "plan-2" };
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(<ChatChangePlanActionDialog plan={null} {...handlers} />);
    });
    expect(gate.loads).toBe(0);
    await act(async () => {
      renderer.update(<ChatChangePlanActionDialog plan={first} {...handlers} />);
    });
    await vi.waitFor(() => expect(gate.release).toBeTypeOf("function"));
    expect(gate.loads).toBe(1);
    expect(modal?.confirmDisabled).toBe(true);
    await act(async () => modal?.onConfirm?.());
    expect(handlers.onConfirm).not.toHaveBeenCalled();
    await act(async () => {
      renderer.update(<ChatChangePlanActionDialog plan={second} {...handlers} />);
    });
    await act(async () => {
      gate.release!();
      await vi.dynamicImportSettled();
    });
    expect(gate.mounts).toBe(1);
    expect(gate.unmounts).toBe(0);
    expect(JSON.stringify(renderer.toJSON())).toContain("plan-2");
    expect(modal?.confirmDisabled).toBe(false);
    await act(async () => modal?.onConfirm?.());
    expect(handlers.onConfirm).toHaveBeenCalledExactlyOnceWith(second);
    await act(async () => {
      renderer.update(<ChatChangePlanActionDialog plan={null} {...handlers} />);
    });
    expect(gate.unmounts).toBe(1);
    await act(async () => {
      renderer.update(<ChatChangePlanActionDialog plan={{ ...first, planId: "plan-3" }} {...handlers} />);
      await vi.dynamicImportSettled();
    });
    expect(gate.loads).toBe(1);
    expect(JSON.stringify(renderer.toJSON())).toContain("plan-3");
  } finally {
    gate.release?.();
    if (renderer) await act(async () => renderer.unmount());
  }
});
