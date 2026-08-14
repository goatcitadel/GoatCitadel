import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChangePlanRecord, ChangePlanRequiredAction } from "@goatcitadel/contracts";
import { ChatChangePlanActionDialog } from "./ChatChangePlanActionDialog";

let latestModalProps: {
  onConfirm?: () => void | Promise<void>;
  confirmDisabled?: boolean;
  confirmLabel?: string;
} | null = null;

vi.mock("../ui", () => ({
  GCModal: (props: {
    children?: unknown;
    onConfirm?: () => void | Promise<void>;
    confirmDisabled?: boolean;
    confirmLabel?: string;
  }) => {
    latestModalProps = props;
    return <section>{props.children as never}</section>;
  },
}));

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

describe("ChatChangePlanActionDialog", () => {
  beforeEach(() => {
    latestModalProps = null;
  });

  it("keeps a credential in password input and submits it only to the secure callback", async () => {
    const handlers = callbacks();
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <ChatChangePlanActionDialog
          plan={plan({
            kind: "secure_input",
            actionId: "secret-1",
            actionNonce: "nonce-1234567890123456",
            targetId: "openai",
            title: "Enter OpenAI key",
            expiresAt: "2099-01-01T00:00:00.000Z",
          })}
          {...handlers}
        />,
      );
    });
    const input = renderer.root.findByType("input");
    expect(input.props.type).toBe("password");
    await act(async () => input.props.onChange({ currentTarget: { value: "direct-secret" } }));
    await act(async () => latestModalProps?.onConfirm?.());

    expect(handlers.onSubmitSecureInput).toHaveBeenCalledWith(expect.objectContaining({ planId: "plan-1" }), {
      credential: "direct-secret",
    });
    expect(renderer.root.findByType("input").props.value).toBe("");
    expect(JSON.stringify(renderer.toJSON())).not.toContain("direct-secret");
  });

  it("renders bounded public fields and submits only their values", async () => {
    const handlers = callbacks();
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <ChatChangePlanActionDialog
          plan={plan({
            kind: "public_form",
            actionId: "form-1",
            actionNonce: "nonce-1234567890123456",
            title: "Choose behavior",
            fields: [
              {
                fieldId: "profile",
                label: "Profile",
                type: "select",
                required: true,
                options: [{ value: "safe", label: "Safe" }],
              },
              { fieldId: "observe", label: "Observe locally", type: "boolean" },
            ],
          })}
          {...handlers}
        />,
      );
    });
    expect(latestModalProps?.confirmDisabled).toBe(true);
    await act(async () => renderer.root.findByType("select").props.onChange({ currentTarget: { value: "safe" } }));
    await act(async () =>
      renderer.root.findAllByType("input")[0]?.props.onChange({ currentTarget: { checked: true } }),
    );
    await act(async () => latestModalProps?.onConfirm?.());

    expect(handlers.onSubmitPublicForm).toHaveBeenCalledWith(expect.objectContaining({ planId: "plan-1" }), {
      profile: "safe",
      observe: true,
    });
  });

  it("never renders a path text field for native source registration", () => {
    const handlers = callbacks();
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <ChatChangePlanActionDialog
          plan={plan({
            kind: "native_path_picker",
            actionId: "path-1",
            actionNonce: "nonce-1234567890123456",
            purpose: "managed_source_registration",
            title: "Choose source install",
          })}
          {...handlers}
        />,
      );
    });
    expect(renderer.root.findAllByType("input")).toHaveLength(0);
    expect(latestModalProps?.confirmLabel).toBe("Open native picker");
  });
});
