// @vitest-environment happy-dom
// Uses the actual GCModal, DialogContent and Radix focus scope; only the API and import timing are fixtures.
import { expect, it, vi } from "vitest";
import type { ChangePlanRecord, ChangePlanRequiredAction } from "@goatcitadel/contracts";
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

it.each(["untouched", "keyboard", "pointer"] as const)(
  "hands loading focus to the real field only while untouched (%s)",
  async (intent) => {
    vi.resetModules();
    let release!: () => void, requested!: () => void;
    const requestedImport = new Promise<void>((resolve) => {
      requested = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.doMock("./ChatChangePlanActionDialogBody", async () => {
      requested();
      await gate;
      return await vi.importActual<typeof import("./ChatChangePlanActionDialogBody")>(
        "./ChatChangePlanActionDialogBody",
      );
    });
    vi.doMock("../../api/capabilities", () => ({
      fetchCandidateSkillArtifactReview: vi.fn(),
      fetchCapabilityCandidate: vi.fn(),
    }));
    const React = await import("react"),
      { createRoot } = await import("react-dom/client"),
      { ChatChangePlanActionDialog } = await import("./ChatChangePlanActionDialog");
    const opener = document.createElement("button");
    opener.textContent = "Open setup";
    document.body.append(opener);
    opener.focus();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container),
      handlers = callbacks();
    const value = plan({
      kind: "public_form",
      actionId: "form-action",
      actionNonce: "form-nonce",
      title: "Name the connection",
      fields: [{ fieldId: "name", label: "Account name", type: "text", required: true }],
    } as ChangePlanRequiredAction);
    const render = (current: ChangePlanRecord | null) =>
      React.createElement(ChatChangePlanActionDialog, { plan: current, ...handlers });
    try {
      await React.act(async () => {
        root.render(render(value));
      });
      await requestedImport;
      await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
      const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!,
        loading = dialog.querySelector<HTMLElement>('[aria-busy="true"]')!;
      expect(loading).not.toBeNull();
      await vi.waitFor(() => expect(document.activeElement).toBe(loading));
      const cancel = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === "Cancel",
      )!;
      if (intent !== "untouched") {
        await React.act(async () => {
          if (intent === "keyboard") loading.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
          else {
            cancel.dispatchEvent(
              new PointerEvent("pointermove", {
                bubbles: true,
                pointerId: 1,
                pointerType: "mouse",
                isPrimary: true,
                button: -1,
              }),
            );
            cancel.dispatchEvent(
              new PointerEvent("pointerdown", {
                bubbles: true,
                pointerId: 1,
                pointerType: "mouse",
                isPrimary: true,
                button: 0,
              }),
            );
          }
          cancel.focus();
          // An intentional return to the same loading target must not restore automatic handoff authority.
          if (intent === "pointer")
            loading.dispatchEvent(
              new PointerEvent("pointerdown", {
                bubbles: true,
                pointerId: 1,
                pointerType: "mouse",
                isPrimary: true,
                button: 0,
              }),
            );
          loading.focus();
        });
        expect(document.activeElement).toBe(loading);
      }
      await React.act(async () => {
        release();
        await vi.dynamicImportSettled();
      });
      // The input can commit before the body's ready effect decides the focus handoff.
      // Wait for the shell to remove its loading sentinel before checking focus.
      expect(dialog.isConnected).toBe(true);
      await vi.waitFor(() => {
        expect(document.querySelector('[role="dialog"]')).toBe(dialog);
        expect(dialog.querySelector('input[type="text"]')).not.toBeNull();
        expect(loading.isConnected).toBe(false);
      });
      const field = dialog.querySelector<HTMLInputElement>('input[type="text"]')!;
      expect(field).not.toBeNull();
      expect(document.querySelector('[role="dialog"]')).toBe(dialog);
      if (intent === "untouched") expect(document.activeElement).toBe(field);
      else expect(document.activeElement).not.toBe(field);
      expect(handlers.onSubmitPublicForm).not.toHaveBeenCalled();
      await React.act(async () => {
        root.render(render(null));
      });
      await vi.waitFor(() => expect(document.activeElement).toBe(opener));
      // The body is now cached and bodyReady precedes the next modal autofocus.
      // A previous intentional movement must not disable ordinary fresh-open focus.
      await React.act(async () => {
        root.render(render({ ...value, planId: "plan-cached" }));
      });
      await vi.waitFor(() => {
        const cachedDialog = document.querySelector<HTMLElement>('[role="dialog"]');
        expect(cachedDialog).not.toBeNull();
        expect(cachedDialog?.querySelector('[aria-busy="true"]')).toBeNull();
        const cachedField = cachedDialog?.querySelector<HTMLInputElement>('input[type="text"]');
        expect(cachedField).not.toBeNull();
        expect(document.activeElement).toBe(cachedField);
      });
      await React.act(async () => {
        root.render(render(null));
      });
      await vi.waitFor(() => expect(document.activeElement).toBe(opener));
    } finally {
      await React.act(async () => {
        release?.();
        await vi.dynamicImportSettled();
        root.unmount();
      });
      container.remove();
      opener.remove();
      vi.doUnmock("./ChatChangePlanActionDialogBody");
      vi.doUnmock("../../api/capabilities");
    }
  },
);
