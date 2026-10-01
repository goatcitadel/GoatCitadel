// @vitest-environment happy-dom
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import { ChatTextComposer, cockpitSendBlockReason, type ComposerProps } from "./ChatTextComposer";

vi.mock("../../../shell-preference", () => ({ switchShell: vi.fn() }));

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function sendButton(): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find((element) => element.textContent?.trim() === "Send");
  if (!(button instanceof HTMLButtonElement)) throw new Error("Missing Send button");
  return button;
}

function composerProps(overrides: Partial<ComposerProps> = {}): ComposerProps {
  return {
    draft: "Hello",
    onDraftChange: vi.fn(),
    onSend: vi.fn(),
    onStopActiveTurn: vi.fn(),
    canSend: true,
    sending: false,
    hasActiveStream: false,
    historicalReadOnly: false,
    sessionControlBanner: null,
    pendingApproval: null,
    pendingUserInput: null,
    pendingAttachments: [],
    editingTurnId: null,
    onCancelEdit: vi.fn(),
    routeBoundaryAckRequired: false,
    routeBoundaryAcknowledged: false,
    routePreflight: null,
    routePreflightError: null,
    routePreflightLoading: false,
    providerOptions: [],
    selectedProviderId: undefined,
    selectedModel: undefined,
    modelSwitchDisabled: false,
    onRequestProviderChange: vi.fn(),
    onRequestModelChange: vi.fn(),
    currentThinkingLevel: "standard",
    onSetThinkingLevel: vi.fn(),
    activePersonality: null,
    onOpenPersonalitiesSettings: vi.fn(),
    planningMode: "off",
    onTogglePlanningMode: vi.fn(),
    currentWebMode: "off",
    onToggleResearchMode: vi.fn(),
    currentReviewDepth: "off",
    onToggleReviewMode: vi.fn(),
    onRemoveAttachment: vi.fn(),
    fileInputRef: createRef<HTMLInputElement>(),
    onAttachFiles: vi.fn(),
    onUploadFiles: vi.fn(),
    onAcknowledgeRouteBoundary: vi.fn(),
    commandSuggestions: [],
    commandIndex: 0,
    onApplyDraftCommand: vi.fn(),
    onComposerKeyDown: vi.fn(),
    onComposerPaste: vi.fn(),
    onDragEnter: vi.fn(),
    onDragOver: vi.fn(),
    onDragLeave: vi.fn(),
    onDrop: vi.fn(),
    isDragActive: false,
    composerRef: createRef<HTMLTextAreaElement>(),
    selectedSessionId: "session-1",
    ...overrides,
  };
}

describe("cockpit text composer", () => {
  it("sends a plain reply through the existing controller callback", async () => {
    const props = composerProps();
    await act(async () => root.render(<ChatTextComposer props={props} />));
    await act(async () => sendButton().click());
    expect(props.onSend).toHaveBeenCalledOnce();
  });

  it("opens personality settings when no presence record is attached", async () => {
    const props = composerProps();
    await act(async () => root.render(<ChatTextComposer props={props} />));
    const button = container.querySelector('button[aria-label="Open personality settings"]') as HTMLButtonElement;
    expect(button.textContent?.trim()).toBe("Personality");
    await act(async () => button.click());
    expect(props.onOpenPersonalitiesSettings).toHaveBeenCalledOnce();
    await act(async () => root.render(<ChatTextComposer props={composerProps({ onOpenPersonalitiesSettings: undefined })} />));
    expect((container.querySelector('button[aria-label="Open personality settings"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps attached files sendable and blocks unresolved decisions or route changes", async () => {
    expect(cockpitSendBlockReason(composerProps({ pendingAttachments: [{ attachmentId: "a", fileName: "a", mimeType: "text/plain", sizeBytes: 1 }] }))).toBeNull();
    expect(cockpitSendBlockReason(composerProps({ pendingApproval: {} as MissionThreadedActiveSessionSurfaceProps["pendingApproval"] }))).toContain("decision");
    expect(cockpitSendBlockReason(composerProps({ routeBoundaryAckRequired: true }))).toContain("Acknowledge");
    expect(cockpitSendBlockReason(composerProps({ canSend: false, providerOptions: [] }))).toBe("No model is connected yet.");
    const props = composerProps({ draft: "$skill", commandSuggestions: [{ key: "one", command: "Skill", description: "Choose a skill", applyValue: "$skill" }] });
    await act(async () => root.render(<ChatTextComposer props={props} />));
    expect(sendButton().disabled).toBe(true);
    expect(props.onSend).not.toHaveBeenCalled();
  });

  it("uses the controller for attached-file send and model selection", async () => {
    const props = composerProps({ draft: "", pendingAttachments: [{ attachmentId: "a", fileName: "a.txt", mimeType: "text/plain", sizeBytes: 1 }],
      providerOptions: [{ providerId: "local", label: "Local", models: ["model-a", "model-b"] }], selectedProviderId: "local", selectedModel: "model-a" });
    await act(async () => root.render(<ChatTextComposer props={props} />));
    await act(async () => sendButton().click());
    expect(props.onSend).toHaveBeenCalledOnce();
    await act(async () => (container.querySelector('button[aria-label="Remove a.txt"]') as HTMLButtonElement).click());
    expect(props.onRemoveAttachment).toHaveBeenCalledWith("a");
    const select = container.querySelector('select[aria-label="Model"]') as HTMLSelectElement;
    await act(async () => { select.value = "model-b"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(props.onRequestModelChange).toHaveBeenCalledWith("model-b");
  });

  it("sends or cancels an edit branch through the shared controller", async () => {
    const props = composerProps({ draft: "Revised message", editingTurnId: "turn-1" });
    await act(async () => root.render(<ChatTextComposer props={props} />));
    expect(container.textContent).toContain("Editing a new branch from this turn.");
    const send = [...container.querySelectorAll("button")].find((element) => element.textContent?.trim() === "Send branch") as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    await act(async () => send.click());
    expect(props.onSend).toHaveBeenCalledOnce();
    const cancel = [...container.querySelectorAll("button")].find((element) => element.textContent?.trim() === "Cancel branch") as HTMLButtonElement;
    await act(async () => cancel.click());
    expect(props.onCancelEdit).toHaveBeenCalledOnce();
  });

  it("selects a command suggestion without sending its text as a message", async () => {
    const props = composerProps({ draft: "/status", commandSuggestions: [{ key: "status", command: "/status", description: "Show status", applyValue: "/status" }] });
    await act(async () => root.render(<ChatTextComposer props={props} />));
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(props.onApplyDraftCommand).toHaveBeenCalledWith("/status");
    expect(props.onSend).not.toHaveBeenCalled();
  });

  it("opens the schedule owner without a model turn for the exact provider-free command", async () => {
    const props = composerProps({ draft: "/schedule", canSend: false });
    const onOpenSchedules = vi.fn();
    await act(async () => root.render(<ChatTextComposer props={props} onOpenSchedules={onOpenSchedules} />));
    const button = [...container.querySelectorAll("button")].find((element) => element.textContent?.trim() === "Open schedules") as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    await act(async () => button.click());
    expect(props.onDraftChange).toHaveBeenCalledWith("");
    expect(onOpenSchedules).toHaveBeenCalledOnce();
    expect(props.onSend).not.toHaveBeenCalled();
  });

  it.each(["/timer", "/status"])("passes %s through the controller without model readiness", async (command) => {
    const props = composerProps({
      draft: command,
      canSend: false,
      chatTimerPanel: command === "/timer" ? { open: false } as ComposerProps["chatTimerPanel"] : undefined,
      sessionStatusPanel: command === "/status" ? { open: false } as ComposerProps["sessionStatusPanel"] : undefined,
      commandSuggestions: [{ key: command, command, description: "Local command", applyValue: command }],
    });
    await act(async () => root.render(<ChatTextComposer props={props} />));
    const button = [...container.querySelectorAll("button")].find((element) => element.textContent?.trim() === (command === "/timer" ? "Open timer" : "Show status")) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    await act(async () => button.click());
    expect(props.onSend).toHaveBeenCalledOnce();
    expect(props.onApplyDraftCommand).not.toHaveBeenCalled();
  });

  it("keeps local commands blocked in a historical view or when an attachment is pending", async () => {
    const props = composerProps({ draft: "/timer", canSend: false, historicalReadOnly: true,
      chatTimerPanel: { open: false } as ComposerProps["chatTimerPanel"] });
    await act(async () => root.render(<ChatTextComposer props={props} />));
    expect(sendButton().disabled).toBe(true);
    await act(async () => root.render(<ChatTextComposer props={{ ...props, historicalReadOnly: false,
      pendingAttachments: [{ attachmentId: "a", fileName: "a.txt", mimeType: "text/plain", sizeBytes: 1 }] }} />));
    expect(sendButton().disabled).toBe(true);
  });
});
