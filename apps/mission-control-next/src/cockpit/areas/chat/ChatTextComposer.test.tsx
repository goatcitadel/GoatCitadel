// @vitest-environment happy-dom
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import {
  ChatTextComposer,
  cockpitSendBlockReason,
  ROUTE_CHECK_HINT_DELAY_MS,
  type ComposerProps,
} from "./ChatTextComposer";

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

it("optional background input preserves the composer while required input and approvals block it", () => {
  const prompt = {
    promptId: "optional",
    turnId: "turn",
    kind: "text" as const,
    title: "Style",
    question: "Which style?",
    required: false,
    delivery: "background" as const,
  };
  expect(cockpitSendBlockReason(composerProps({ pendingUserInput: prompt }))).toBeNull();
  expect(cockpitSendBlockReason(composerProps({ pendingUserInput: { ...prompt, required: true } }))).toContain(
    "decision",
  );
  expect(cockpitSendBlockReason(composerProps({ pendingUserInput: { ...prompt, delivery: undefined } }))).toContain(
    "decision",
  );
  expect(
    cockpitSendBlockReason(
      composerProps({
        pendingUserInput: prompt,
        pendingApproval: {} as MissionThreadedActiveSessionSurfaceProps["pendingApproval"],
      }),
    ),
  ).toContain("decision");
});

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
    onReturnToLatest: vi.fn(),
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
    onSetWebMode: vi.fn(),
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

  it("passes an immediate Enter to the controller while the display preflight is pending", async () => {
    const props = composerProps({ canSend: false, routePreflightLoading: true });
    await act(async () => root.render(<ChatTextComposer props={props} />));
    expect(sendButton().disabled).toBe(false);
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(props.onSend).toHaveBeenCalledOnce();
  });

  it("only shows the route-check hint once a check outlasts the delay", async () => {
    vi.useFakeTimers();
    try {
      const props = composerProps({ canSend: false, routePreflightLoading: true });
      await act(async () => root.render(<ChatTextComposer props={props} />));
      expect(container.textContent).not.toContain("Send will wait for the Gateway check");
      expect(container.querySelector("textarea")?.getAttribute("aria-describedby")).toBeNull();
      await act(async () => vi.advanceTimersByTimeAsync(ROUTE_CHECK_HINT_DELAY_MS));
      expect(container.textContent).toContain("Send will wait for the Gateway check");
      await act(async () =>
        root.render(<ChatTextComposer props={{ ...props, canSend: true, routePreflightLoading: false }} />),
      );
      expect(container.textContent).not.toContain("Send will wait for the Gateway check");
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends attached files alone while the route check is pending", async () => {
    const props = composerProps({
      draft: "",
      canSend: false,
      routePreflightLoading: true,
      pendingAttachments: [{ attachmentId: "a", fileName: "a.txt", mimeType: "text/plain", sizeBytes: 1 }],
    });
    await act(async () => root.render(<ChatTextComposer props={props} />));
    expect(sendButton().disabled).toBe(false);
    await act(async () => sendButton().click());
    expect(props.onSend).toHaveBeenCalledOnce();
  });

  it("offers a way back from a read-only earlier version and links the reason to the draft", async () => {
    const props = composerProps({ historicalReadOnly: true });
    await act(async () => root.render(<ChatTextComposer props={props} />));
    const reason = container.querySelector("#cockpit-chat-send-reason");
    expect(reason?.textContent).toContain("earlier version of the conversation");
    expect(container.querySelector("textarea")?.getAttribute("aria-describedby")).toBe("cockpit-chat-send-reason");
    const back = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Back to latest");
    await act(async () => back?.click());
    expect(props.onReturnToLatest).toHaveBeenCalledOnce();
    expect(props.onSend).not.toHaveBeenCalled();
  });

  it("names the controlling client and never points at another shell for an inline decision", () => {
    const banner = { model: { ownerLabel: "External controller" } } as ComposerProps["sessionControlBanner"];
    expect(cockpitSendBlockReason(composerProps({ sessionControlBanner: banner }))).toContain("External controller");
    const pending = cockpitSendBlockReason(
      composerProps({ pendingApproval: {} as MissionThreadedActiveSessionSurfaceProps["pendingApproval"] }),
    );
    expect(pending).toContain("above");
    expect(pending).not.toMatch(/current Chat|classic/i);
  });

  it("labels the shell switch as the classic view", async () => {
    await act(async () => root.render(<ChatTextComposer props={composerProps()} />));
    const labels = [...container.querySelectorAll("button")].map((b) => b.textContent?.trim());
    expect(labels).toContain("Open classic view");
    expect(labels).not.toContain("More controls");
  });

  it("does not send through a pending decision while the route is checking", async () => {
    const props = composerProps({
      canSend: false,
      routePreflightLoading: true,
      pendingApproval: {} as MissionThreadedActiveSessionSurfaceProps["pendingApproval"],
    });
    await act(async () => root.render(<ChatTextComposer props={props} />));
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(props.onSend).not.toHaveBeenCalled();
  });

  it("preserves the draft and blocks Enter while the Gateway is unavailable", async () => {
    const props = composerProps({ canSend: false, routePreflightLoading: true });
    await act(async () => root.render(<ChatTextComposer props={props} gatewayUnavailable />));
    expect(sendButton().disabled).toBe(true);
    expect(container.querySelector("textarea")?.value).toBe("Hello");
    expect(container.textContent).toContain("Gateway unavailable");
    await act(async () =>
      container.querySelector("textarea")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    expect(props.onSend).not.toHaveBeenCalled();
    await act(async () => root.render(<ChatTextComposer props={props} />));
    expect(sendButton().disabled).toBe(false);
    expect(container.querySelector("textarea")?.value).toBe("Hello");
  });

  it("opens personality settings when no presence record is attached", async () => {
    const props = composerProps();
    await act(async () => root.render(<ChatTextComposer props={props} />));
    const button = container.querySelector('button[aria-label="Open personality settings"]') as HTMLButtonElement;
    expect(button.textContent?.trim()).toBe("Personality");
    await act(async () => button.click());
    expect(props.onOpenPersonalitiesSettings).toHaveBeenCalledOnce();
    await act(async () =>
      root.render(<ChatTextComposer props={composerProps({ onOpenPersonalitiesSettings: undefined })} />),
    );
    expect(
      (container.querySelector('button[aria-label="Open personality settings"]') as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("keeps attached files sendable and blocks unresolved decisions or route changes", async () => {
    expect(
      cockpitSendBlockReason(
        composerProps({
          pendingAttachments: [{ attachmentId: "a", fileName: "a", mimeType: "text/plain", sizeBytes: 1 }],
        }),
      ),
    ).toBeNull();
    expect(
      cockpitSendBlockReason(
        composerProps({ pendingApproval: {} as MissionThreadedActiveSessionSurfaceProps["pendingApproval"] }),
      ),
    ).toContain("decision");
    expect(cockpitSendBlockReason(composerProps({ routeBoundaryAckRequired: true }))).toContain("Acknowledge");
    expect(cockpitSendBlockReason(composerProps({ canSend: false, providerOptions: [] }))).toBe(
      "No model is connected yet.",
    );
    const props = composerProps({
      draft: "$skill",
      commandSuggestions: [{ key: "one", command: "Skill", description: "Choose a skill", applyValue: "$skill" }],
    });
    await act(async () => root.render(<ChatTextComposer props={props} />));
    expect(sendButton().disabled).toBe(true);
    expect(props.onSend).not.toHaveBeenCalled();
  });

  it("uses the controller for attached-file send and model selection", async () => {
    const props = composerProps({
      draft: "",
      pendingAttachments: [{ attachmentId: "a", fileName: "a.txt", mimeType: "text/plain", sizeBytes: 1 }],
      providerOptions: [{ providerId: "local", label: "Local", models: ["model-a", "model-b"] }],
      selectedProviderId: "local",
      selectedModel: "model-a",
    });
    await act(async () => root.render(<ChatTextComposer props={props} />));
    await act(async () => sendButton().click());
    expect(props.onSend).toHaveBeenCalledOnce();
    await act(async () => (container.querySelector('button[aria-label="Remove a.txt"]') as HTMLButtonElement).click());
    expect(props.onRemoveAttachment).toHaveBeenCalledWith("a");
    const select = container.querySelector('select[aria-label="Model"]') as HTMLSelectElement;
    await act(async () => {
      select.value = "model-b";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(props.onRequestModelChange).toHaveBeenCalledWith("model-b");
  });

  it("sends or cancels an edit branch through the shared controller", async () => {
    const props = composerProps({ draft: "Revised message", editingTurnId: "turn-1" });
    await act(async () => root.render(<ChatTextComposer props={props} />));
    expect(container.textContent).toContain("Editing a new branch from this turn.");
    const send = [...container.querySelectorAll("button")].find(
      (element) => element.textContent?.trim() === "Send branch",
    ) as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    await act(async () => send.click());
    expect(props.onSend).toHaveBeenCalledOnce();
    const cancel = [...container.querySelectorAll("button")].find(
      (element) => element.textContent?.trim() === "Cancel branch",
    ) as HTMLButtonElement;
    await act(async () => cancel.click());
    expect(props.onCancelEdit).toHaveBeenCalledOnce();
  });

  it("selects a command suggestion without sending its text as a message", async () => {
    const props = composerProps({
      draft: "/status",
      commandSuggestions: [{ key: "status", command: "/status", description: "Show status", applyValue: "/status" }],
    });
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
    const button = [...container.querySelectorAll("button")].find(
      (element) => element.textContent?.trim() === "Open schedules",
    ) as HTMLButtonElement;
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
      chatTimerPanel: command === "/timer" ? ({ open: false } as ComposerProps["chatTimerPanel"]) : undefined,
      sessionStatusPanel: command === "/status" ? ({ open: false } as ComposerProps["sessionStatusPanel"]) : undefined,
      commandSuggestions: [{ key: command, command, description: "Local command", applyValue: command }],
    });
    await act(async () => root.render(<ChatTextComposer props={props} />));
    const button = [...container.querySelectorAll("button")].find(
      (element) => element.textContent?.trim() === (command === "/timer" ? "Open timer" : "Show status"),
    ) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    await act(async () => button.click());
    expect(props.onSend).toHaveBeenCalledOnce();
    expect(props.onApplyDraftCommand).not.toHaveBeenCalled();
  });

  it("keeps local commands blocked in a historical view or when an attachment is pending", async () => {
    const props = composerProps({
      draft: "/timer",
      canSend: false,
      historicalReadOnly: true,
      chatTimerPanel: { open: false } as ComposerProps["chatTimerPanel"],
    });
    await act(async () => root.render(<ChatTextComposer props={props} />));
    expect(sendButton().disabled).toBe(true);
    await act(async () =>
      root.render(
        <ChatTextComposer
          props={{
            ...props,
            historicalReadOnly: false,
            pendingAttachments: [{ attachmentId: "a", fileName: "a.txt", mimeType: "text/plain", sizeBytes: 1 }],
          }}
        />,
      ),
    );
    expect(sendButton().disabled).toBe(true);
  });

  it("does not send the Enter that confirms an IME composition", async () => {
    const props = composerProps();
    await act(async () => root.render(<ChatTextComposer props={props} />));
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () =>
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, bubbles: true })),
    );
    await act(async () =>
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true })),
    );
    expect(props.onSend).not.toHaveBeenCalled();
    await act(async () => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(props.onSend).toHaveBeenCalledOnce();
  });
});
