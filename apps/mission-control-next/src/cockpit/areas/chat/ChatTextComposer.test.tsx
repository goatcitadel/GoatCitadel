// @vitest-environment happy-dom
import { act, createRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WHATSAPP_REPLY_WINDOW_CLOSED } from "@goatcitadel/contracts";
import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import {
  ChatTextComposer,
  cockpitSendBlockReason,
  ROUTE_CHECK_HINT_DELAY_MS,
  type ComposerProps,
} from "./ChatTextComposer";
import { withoutFileInput } from "./channel-file-input";
// Catalog labels read the query cache; these tests exercise the controls, so the model id stands in for its name.
vi.mock("../../data/use-model-label", () => ({
  useModelLabel: (_providerId?: string, modelId?: string) => modelId ?? "Unknown model",
  useProviderLabelLookup: () => () => undefined,
}));
vi.mock("./use-chat-model-labels", () => ({ useChatModelLabels: () => (modelId: string) => modelId }));
// Width and pointer are off by default (a desktop with a keyboard); the phone and touch tests switch them on.
const media = vi.hoisted(() => ({ phone: false, coarse: false }));
vi.mock("@goatcitadel/mission-control-shared/hooks/useMediaQuery", () => ({
  useMediaQuery: (query: string) =>
    (media.phone && query === "(width < 640px)") || (media.coarse && query === "(pointer: coarse)"),
}));
vi.mock("../../ui/Sheet", () => ({
  Sheet: ({ open, title, children }: { open: boolean; title: string; children: ReactNode }) =>
    open ? (
      <section role="dialog" aria-label={title}>
        {children}
      </section>
    ) : null,
}));

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  media.phone = false;
  media.coarse = false;
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
    queueItems: [],
    onResumeAll: vi.fn(),
    onRemoveQueuedItem: vi.fn(),
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

/** Opens the composer's + panel; it renders in a portal, so it is found on the document. */
async function openPlusPanel(): Promise<HTMLElement> {
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Add and options"]')!.click());
  const panel = document.querySelector<HTMLElement>('[role="dialog"][aria-label="Add and options"]');
  expect(panel).not.toBeNull();
  return panel!;
}
/** Matches a button's text, or a + panel row's label (its first span; the row also shows a shortcut hint). */
const buttonIn = (scope: ParentNode, label: string) =>
  [...scope.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === label || button.querySelector("span")?.textContent === label,
  );

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
      expect(container.textContent).not.toContain("Checking the selected model");
      expect(container.querySelector("textarea")?.getAttribute("aria-describedby")).toBeNull();
      await act(async () => vi.advanceTimersByTimeAsync(ROUTE_CHECK_HINT_DELAY_MS));
      expect(container.textContent).toContain("Checking the selected model");
      await act(async () =>
        root.render(<ChatTextComposer props={{ ...props, canSend: true, routePreflightLoading: false }} />),
      );
      expect(container.textContent).not.toContain("Checking the selected model");
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

  it("leaves the layout switch to the sidebar instead of a generic classic link under the composer", async () => {
    await act(async () => root.render(<ChatTextComposer props={composerProps()} />));
    const panel = await openPlusPanel();
    expect(buttonIn(panel, "Commands and context")).toBeDefined();
    const labels = [...container.querySelectorAll("button"), ...panel.querySelectorAll("button")].map((b) =>
      b.textContent?.trim(),
    );
    expect(labels).not.toContain("Open classic view");
    expect(labels).not.toContain("More controls");
    expect(cockpitSendBlockReason(composerProps({ canSend: false })) ?? "").not.toMatch(/classic/i);
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
    expect(container.textContent).toContain("GoatCitadel is unavailable");
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
    await act(async () =>
      (container.querySelector('button[aria-label$="Model and reasoning options"]') as HTMLButtonElement).click(),
    );
    await vi.waitFor(() => {
      const button = document.body.querySelector<HTMLButtonElement>('button[aria-label$="Open personality settings"]');
      expect(button).toBeInstanceOf(HTMLButtonElement);
      expect(button?.disabled).toBe(false);
    });
    const button = document.body.querySelector('button[aria-label$="Open personality settings"]') as HTMLButtonElement;
    expect(button.textContent?.trim()).toBe("Personality");
    await act(async () => button.click());
    expect(props.onOpenPersonalitiesSettings).toHaveBeenCalledOnce();
    await act(async () =>
      root.render(<ChatTextComposer props={composerProps({ onOpenPersonalitiesSettings: undefined })} />),
    );
    expect(
      (document.body.querySelector('button[aria-label$="Open personality settings"]') as HTMLButtonElement).disabled,
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
    // The chip names the file's type and size, and removes through a lucide icon button, not a glyph.
    expect(container.querySelector('[aria-label="Attached files"]')?.textContent).toContain("Text · 1 B");
    expect(container.querySelector('button[aria-label="Remove a.txt"] svg')).not.toBeNull();
    await act(async () => (container.querySelector('button[aria-label="Remove a.txt"]') as HTMLButtonElement).click());
    expect(props.onRemoveAttachment).toHaveBeenCalledWith("a");
    await act(async () =>
      (container.querySelector('button[aria-label$="Model and reasoning options"]') as HTMLButtonElement).click(),
    );
    await vi.waitFor(() => {
      const select = document.body.querySelector<HTMLSelectElement>('select[aria-label="Model"]');
      expect(select).toBeInstanceOf(HTMLSelectElement);
      expect(select?.disabled).toBe(false);
    });
    const select = document.body.querySelector('select[aria-label="Model"]') as HTMLSelectElement;
    await act(async () => {
      select.value = "model-b";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(props.onRequestModelChange).toHaveBeenCalledWith("model-b");
  });

  it("sends or cancels an edit branch through the shared controller", async () => {
    const props = composerProps({ draft: "Revised message", editingTurnId: "turn-1" });
    await act(async () => root.render(<ChatTextComposer props={props} />));
    expect(container.textContent).toContain("Editing a new version of this message.");
    const send = [...container.querySelectorAll("button")].find(
      (element) => element.textContent?.trim() === "Send edited message",
    ) as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    await act(async () => send.click());
    expect(props.onSend).toHaveBeenCalledOnce();
    const cancel = [...container.querySelectorAll("button")].find(
      (element) => element.textContent?.trim() === "Cancel edit",
    ) as HTMLButtonElement;
    await act(async () => cancel.click());
    expect(props.onCancelEdit).toHaveBeenCalledOnce();
  });

  it("applies an uncommitted command suggestion on Enter and sends a committed command", async () => {
    const commandSuggestions = [
      { key: "status", command: "/status", description: "Show status", applyValue: "/status" },
    ];
    const partial = composerProps({ draft: "/stat", commandSuggestions });
    await act(async () => root.render(<ChatTextComposer props={partial} />));
    expect(sendButton().disabled).toBe(true);
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(partial.onApplyDraftCommand).toHaveBeenCalledWith("/status");
    expect(partial.onSend).not.toHaveBeenCalled();

    // The palette trigger keeps a complete slash command's suggestion listed; Enter must send, not re-apply.
    const committed = composerProps({ draft: "/status", commandSuggestions });
    await act(async () => root.render(<ChatTextComposer props={committed} />));
    expect(sendButton().disabled).toBe(false);
    await act(async () =>
      (container.querySelector("textarea") as HTMLTextAreaElement).dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
    );
    expect(committed.onSend).toHaveBeenCalledOnce();
    expect(committed.onApplyDraftCommand).not.toHaveBeenCalled();
  });

  it("Escape closes the slash menu and keeps the draft", async () => {
    const commandSuggestions = [
      { key: "status", command: "/status", description: "Show status", applyValue: "/status" },
    ];
    const props = composerProps({ draft: "/", commandSuggestions });
    await act(async () => root.render(<ChatTextComposer props={props} />));
    expect(container.querySelector('[role="listbox"]')).not.toBeNull();
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(container.querySelector('[role="listbox"]')).toBeNull();
    expect(textarea.value).toBe("/");
    expect(textarea.hasAttribute("aria-controls")).toBe(false);
    expect(props.onDraftChange).not.toHaveBeenCalled();
    // A dismissed menu does not apply its hidden suggestion on Enter.
    await act(async () => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(props.onApplyDraftCommand).not.toHaveBeenCalled();
    // The next keystroke brings the menu back.
    await act(async () => root.render(<ChatTextComposer props={{ ...props, draft: "/s" }} />));
    expect(container.querySelector('[role="listbox"]')).not.toBeNull();
  });

  it("badges only rows that differ from the usual state, and keeps the menu open while searching", async () => {
    const paletteState = (loading: boolean) => ({
      enabled: true,
      globalOpen: false,
      query: "",
      failures: [],
      onOpen: vi.fn(),
      onQueryChange: vi.fn(),
      onClose: vi.fn(),
      onIndexChange: vi.fn(),
      onSelect: vi.fn(),
      loading,
    });
    const props = composerProps({
      draft: "/",
      commandSuggestions: [
        {
          key: "a",
          command: "/status",
          description: "Show status",
          applyValue: "/status",
          availabilityLabel: "Available",
        },
        {
          key: "b",
          command: "/shell",
          description: "Run one command",
          applyValue: "/shell",
          availabilityLabel: "Needs review",
        },
      ] as ComposerProps["commandSuggestions"],
      composerPalette: paletteState(false),
    });
    await act(async () => root.render(<ChatTextComposer props={props} />));
    const options = [...container.querySelectorAll('[role="option"]')];
    expect(options[0]?.textContent).not.toContain("Available");
    expect(options[1]?.textContent).toContain("Needs review");

    const searching = composerProps({ draft: "/", commandSuggestions: [], composerPalette: paletteState(true) });
    await act(async () => root.render(<ChatTextComposer props={searching} />));
    expect(container.textContent).toContain("Searching");
  });

  it("puts the 'choose a suggestion' hint beside Send, not on its own line below", async () => {
    const props = composerProps({
      draft: "/he",
      commandSuggestions: [{ key: "help", command: "/help", description: "Show help", applyValue: "/help" }],
    });
    await act(async () => root.render(<ChatTextComposer props={props} />));
    const hint = [...container.querySelectorAll('[role="status"]')].find((element) =>
      element.textContent?.includes("Choose a suggestion before sending."),
    );
    expect(hint).toBeDefined();
    expect(hint?.parentElement?.contains(sendButton())).toBe(true);
  });

  it("the draft is text-md at every width", async () => {
    await act(async () => root.render(<ChatTextComposer props={composerProps()} />));
    const classes = (container.querySelector("textarea") as HTMLTextAreaElement).className.split(/\s+/);
    expect(classes).toContain("text-md");
    // No breakpoint shrinks it back below 16px, so phones never zoom on focus.
    expect(classes.filter((name) => /(?:^|:)text-(?:xs|sm)$/.test(name))).toEqual([]);
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
    expect(container.textContent).toContain(
      command === "/timer"
        ? "Open a reminder that stays with this conversation."
        : "Show the current status of this conversation",
    );
    expect(container.textContent).toContain("Nothing is sent to the model.");
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
    // Cancelable events, so `defaultPrevented` can tell whether the composer took the Enter.
    const ime229 = new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, bubbles: true, cancelable: true });
    await act(async () => textarea.dispatchEvent(ime229));
    expect(ime229.defaultPrevented).toBe(false);
    const imeComposing = new KeyboardEvent("keydown", {
      key: "Enter",
      isComposing: true,
      bubbles: true,
      cancelable: true,
    });
    await act(async () => textarea.dispatchEvent(imeComposing));
    expect(imeComposing.defaultPrevented).toBe(false);
    expect(props.onSend).not.toHaveBeenCalled();
    const plainEnter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    await act(async () => textarea.dispatchEvent(plainEnter));
    expect(plainEnter.defaultPrevented).toBe(true);
    expect(props.onSend).toHaveBeenCalledOnce();
  });

  it("does not choose a command when the Enter key confirms an IME composition in the palette", async () => {
    const props = composerProps({
      commandSuggestions: [{ key: "status", command: "/status", description: "Show status", applyValue: "/status" }],
      composerPalette: {
        enabled: true,
        globalOpen: true,
        query: "",
        failures: [],
        onOpen: vi.fn(),
        onQueryChange: vi.fn(),
        onClose: vi.fn(),
        onIndexChange: vi.fn(),
        onSelect: vi.fn(),
        loading: false,
      },
    });
    await act(async () => root.render(<ChatTextComposer props={props} />));
    const paletteInput = [...container.querySelectorAll("label")]
      .find((label) => label.textContent?.startsWith("Find a command"))
      ?.querySelector("input");
    expect(paletteInput).toBeInstanceOf(HTMLInputElement);
    const input = paletteInput as HTMLInputElement;
    const imeEnter = new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, bubbles: true, cancelable: true });
    await act(async () => input.dispatchEvent(imeEnter));
    expect(imeEnter.defaultPrevented).toBe(false);
    expect(props.composerPalette?.onSelect).not.toHaveBeenCalled();
    const plainEnter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    await act(async () => input.dispatchEvent(plainEnter));
    expect(plainEnter.defaultPrevented).toBe(true);
    expect(props.composerPalette?.onSelect).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "gives the suggestions listbox to exactly one focused owner with non-tabbable options (palette=%s)",
    async (globalOpen) => {
      const props = composerProps({
        commandSuggestions: [
          { key: "status", command: "/status", description: "Show status", applyValue: "/status" },
          { key: "help", command: "/help", description: "Show help", applyValue: "/help" },
        ],
        commandIndex: 1,
        composerPalette: {
          enabled: true,
          globalOpen,
          query: "",
          failures: [],
          onOpen: vi.fn(),
          onQueryChange: vi.fn(),
          onClose: vi.fn(),
          onIndexChange: vi.fn(),
          onSelect: vi.fn(),
          loading: false,
        },
      });
      await act(async () => root.render(<ChatTextComposer props={props} />));
      const owners = [...container.querySelectorAll('[aria-controls="cockpit-composer-suggestions"]')];
      expect(owners).toHaveLength(1);
      expect(owners[0]!.tagName).toBe(globalOpen ? "INPUT" : "TEXTAREA");
      expect(container.querySelectorAll("[aria-activedescendant]")).toHaveLength(1);
      expect(owners[0]!.getAttribute("aria-activedescendant")).toBe("cockpit-suggestion-1");
      const textarea = container.querySelector("textarea")!;
      // A textarea keeps its implicit textbox role (HTML-ARIA allows no explicit role on it), so it never
      // carries combobox-only aria-expanded; the listbox relationship rides on aria-controls/activedescendant.
      expect(textarea.hasAttribute("role")).toBe(false);
      expect(textarea.hasAttribute("aria-expanded")).toBe(false);
      expect(textarea.getAttribute("aria-autocomplete")).toBe("list");
      const options = [...container.querySelectorAll<HTMLElement>('[role="option"]')];
      expect(options.map((option) => option.tabIndex)).toEqual([-1, -1]);
      expect(container.querySelector(".shadow-overlay")).toBeNull();
      const mouseDown = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
      options[0]!.dispatchEvent(mouseDown);
      expect(mouseDown.defaultPrevented).toBe(true);
      await act(async () => options[0]!.click());
      expect(props.composerPalette?.onSelect).toHaveBeenCalledWith(props.commandSuggestions[0]);
    },
  );
});

it("keeps governed external-control recovery actions available while send is locked", async () => {
  const onRevoke = vi.fn();
  const onEmergencyTakeover = vi.fn();
  const props = composerProps({
    sessionControlBanner: {
      model: {
        externalControlActive: true,
        sendLocked: true,
        generation: 2,
        pendingRequestCount: 0,
        ownerLabel: "External controller",
        generationLabel: "Generation 2",
        tone: "external-live",
        sendLockReason: "Externally controlled",
        leaseStateLabel: "Live lease",
        capabilitiesLabel: "Send",
        clientInstanceId: "fixture-client",
        companionSessionId: "fixture-companion",
        tokenFingerprint: null,
        lastHeartbeatAt: null,
        leaseExpiresAt: null,
        reconnectExpiresAt: null,
      },
      onRevoke,
      onEmergencyTakeover,
      actionPending: null,
      actionError: null,
      statusError: null,
    } as ComposerProps["sessionControlBanner"],
  });
  await act(async () => root.render(<ChatTextComposer props={props} />));
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Revoke external session control"]')!.click(),
  );
  expect(onRevoke).toHaveBeenCalledOnce();
  expect(props.onSend).not.toHaveBeenCalled();
});

it("submits a running turn only through the shared queue admission and preserves blockers", async () => {
  const props = composerProps({
    draft: "Next request",
    sending: true,
    hasActiveStream: true,
    canSend: false,
    canSendWhileRunning: true,
    midTurnDisposition: "queue",
  });
  await act(async () => root.render(<ChatTextComposer props={props} />));
  const queue = [...container.querySelectorAll("button")].find((button) => button.textContent === "Queue message")!;
  expect(queue.disabled).toBe(false);
  await act(async () => queue.click());
  expect(props.onSend).toHaveBeenCalledOnce();
  await act(async () =>
    root.render(<ChatTextComposer props={{ ...props, pendingApproval: { approvalId: "waiting" } as never }} />),
  );
  expect(queue.disabled).toBe(true);
});

it("keeps read-only sources behind a toolbar chip until the operator opens them", async () => {
  const attachment = {
    attachmentId: "att-1",
    sourceId: "src",
    importId: "imp",
    itemId: "item",
    revision: 1,
    normalizedArtifactSha256: "a".repeat(64),
    attachedAt: "2026-10-01T00:00:00Z",
  };
  const controls = {
    attachments: [attachment],
    candidates: [],
    selectedAttachmentIds: [],
    loading: false,
    error: null,
    canMutate: true,
    busyAttachmentId: null,
    onToggleSelect: vi.fn(),
    onClearSelection: vi.fn(),
    onAttach: vi.fn(),
    onDetach: vi.fn(),
    onRequestKnowledgeSnapshot: vi.fn(),
    onReload: vi.fn(),
  } as unknown as NonNullable<ComposerProps["externalSourceControls"]>;
  await act(async () => root.render(<ChatTextComposer props={composerProps({ externalSourceControls: controls })} />));
  const chip = [...container.querySelectorAll("button")].find((button) => button.textContent === "Sources: 1")!;
  const panel = container.querySelector('section[aria-label="Read-only external source attachments"]')!;
  expect(chip.getAttribute("aria-expanded")).toBe("false");
  expect(panel.closest("[hidden]")).not.toBeNull();
  await act(async () => chip.click());
  expect(chip.getAttribute("aria-expanded")).toBe("true");
  expect(panel.closest("[hidden]")).toBeNull();
  // The draft starts at two lines and still grows.
  expect(container.querySelector("textarea")?.getAttribute("rows")).toBe("2");
});

describe("composer + panel and mode pills", () => {
  it("keeps attach, commands and modes behind the + and runs each from the panel", async () => {
    const onOpen = vi.fn();
    const props = composerProps({
      composerPalette: { enabled: true, onOpen } as unknown as ComposerProps["composerPalette"],
    });
    await act(async () => root.render(<ChatTextComposer props={props} />));
    // Only the +, the model chip and Send sit on the row.
    expect(container.querySelector('button[aria-label="Attach files"]')).toBeNull();
    expect(buttonIn(container, "Plan first")).toBeUndefined();
    expect(container.querySelector('button[aria-label$="Model and reasoning options"]')).not.toBeNull();
    let panel = await openPlusPanel();
    await act(async () => buttonIn(panel, "Attach files")!.click());
    expect(props.onAttachFiles).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="dialog"][aria-label="Add and options"]')).toBeNull();
    panel = await openPlusPanel();
    await act(async () => buttonIn(panel, "Plan first")!.click());
    expect(props.onTogglePlanningMode).toHaveBeenCalledOnce();
    // A mode toggle keeps the panel open; an action that leaves it closes it.
    expect(document.querySelector('[role="dialog"][aria-label="Add and options"]')).not.toBeNull();
    await act(async () => buttonIn(panel, "Commands and context")!.click());
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("shows each mode that is not at its default as a pill that turns it back off", async () => {
    const props = composerProps({ planningMode: "advisory", currentWebMode: "deep", currentReviewDepth: "standard" });
    await act(async () => root.render(<ChatTextComposer props={props} />));
    const pills = container.querySelector('[aria-label="Composer controls"]')!;
    expect(pills.textContent).toContain("Plan first");
    expect(pills.textContent).toContain("Web: Deep");
    expect(pills.textContent).toContain("Review answer");
    await act(async () => pills.querySelector<HTMLButtonElement>('button[aria-label="Turn off Plan first"]')!.click());
    expect(props.onTogglePlanningMode).toHaveBeenCalledOnce();
    await act(async () =>
      pills.querySelector<HTMLButtonElement>('button[aria-label="Set web search back to Auto"]')!.click(),
    );
    expect(props.onSetWebMode).toHaveBeenCalledWith("auto");
    await act(async () =>
      pills.querySelector<HTMLButtonElement>('button[aria-label="Turn off Review answer"]')!.click(),
    );
    expect(props.onToggleReviewMode).toHaveBeenCalledOnce();
  });

  it("shows no pills at the defaults", async () => {
    const props = composerProps({ planningMode: "off", currentWebMode: "auto", currentReviewDepth: "off" });
    await act(async () => root.render(<ChatTextComposer props={props} />));
    expect(container.querySelector('button[aria-label^="Turn off"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Set web search back to Auto"]')).toBeNull();
  });
});

describe("touch and phone composer", () => {
  const enter = (init: KeyboardEventInit = {}) =>
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init });

  it("keeps Enter as send and the Shift+Enter hint for a keyboard and fine pointer", async () => {
    const props = composerProps();
    await act(async () => root.render(<ChatTextComposer props={props} />));
    expect(container.querySelector("textarea")?.getAttribute("placeholder")).toContain("Shift+Enter for a new line");
    const event = enter();
    await act(async () => container.querySelector("textarea")!.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(props.onSend).toHaveBeenCalledOnce();
  });

  it("makes a plain Enter a new line on touch, hides the Shift hint and sends from the button or Ctrl+Enter", async () => {
    media.coarse = true;
    const props = composerProps();
    await act(async () => root.render(<ChatTextComposer props={props} />));
    expect(container.textContent).not.toContain("Shift+Enter");
    expect(container.querySelector("textarea")?.getAttribute("placeholder")).not.toContain("Shift+Enter");
    const textarea = container.querySelector("textarea")!;
    const plain = enter();
    await act(async () => textarea.dispatchEvent(plain));
    expect(plain.defaultPrevented).toBe(false);
    expect(props.onSend).not.toHaveBeenCalled();
    const ctrl = enter({ ctrlKey: true });
    await act(async () => textarea.dispatchEvent(ctrl));
    expect(ctrl.defaultPrevented).toBe(true);
    expect(props.onSend).toHaveBeenCalledOnce();
    await act(async () => sendButton().click());
    expect(props.onSend).toHaveBeenCalledTimes(2);
  });

  it("still applies a highlighted partial command suggestion with Enter on touch", async () => {
    media.coarse = true;
    const suggestion = {
      applyValue: "/status ",
      label: "/status",
    } as unknown as ComposerProps["commandSuggestions"][number];
    const props = composerProps({ draft: "/sta", commandSuggestions: [suggestion] });
    await act(async () => root.render(<ChatTextComposer props={props} />));
    const event = enter();
    await act(async () => container.querySelector("textarea")!.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(props.onApplyDraftCommand).toHaveBeenCalledWith("/status ");
    expect(props.onSend).not.toHaveBeenCalled();
  });

  it("folds the controls into one Options sheet on a phone and keeps a named icon Send beside the draft", async () => {
    media.phone = true;
    media.coarse = true;
    const props = composerProps();
    await act(async () => root.render(<ChatTextComposer props={props} />));
    const textarea = container.querySelector("textarea")!;
    expect(textarea.className).toContain("text-md");
    const row = container.querySelector<HTMLElement>('[aria-label="Composer controls"]')!;
    expect(row.parentElement).toBe(textarea.parentElement);
    const options = row.querySelector<HTMLButtonElement>('button[aria-label="Options"]')!;
    expect(options.getAttribute("aria-expanded")).toBe("false");
    // Mode, model, web and voice controls are not stacked above the draft.
    expect(container.querySelector('button[aria-label$="Model and reasoning options"]')).toBeNull();
    expect(container.querySelector('select[aria-label="Web search"]')).toBeNull();
    expect(container.textContent).not.toContain("Voice and images");
    expect(container.textContent).not.toContain("Commands and context");
    // The hidden file input stays mounted so Attach works from the sheet.
    expect(container.querySelector('input[aria-label="Choose files to attach"]')).not.toBeNull();
    await act(async () => sendButton().click());
    expect(props.onSend).toHaveBeenCalledOnce();
    await act(async () => options.click());
    const sheet = container.querySelector<HTMLElement>('[role="dialog"][aria-label="Message options"]')!;
    expect(options.getAttribute("aria-expanded")).toBe("true");
    expect(sheet.querySelector('button[aria-label$="Model and reasoning options"]')).not.toBeNull();
    expect(sheet.querySelector('button[aria-label="Attach files"]')).not.toBeNull();
    expect(sheet.textContent).toContain("Voice and images");
    expect(sheet.querySelectorAll('input[aria-label="Choose files to attach"]')).toHaveLength(0);
    await act(async () => sheet.querySelector<HTMLButtonElement>('button[aria-label="Attach files"]')!.click());
    expect(props.onAttachFiles).toHaveBeenCalledOnce();
  });

  it("keeps a running turn stoppable and queueable from the phone row", async () => {
    media.phone = true;
    const props = composerProps({ hasActiveStream: true, canSendWhileRunning: true });
    await act(async () => root.render(<ChatTextComposer props={props} />));
    const row = container.querySelector<HTMLElement>('[aria-label="Composer controls"]')!;
    await act(async () => row.querySelector<HTMLButtonElement>('button[aria-label="Stop response"]')!.click());
    expect(props.onStopActiveTurn).toHaveBeenCalledOnce();
    expect([...row.querySelectorAll("button")].some((button) => button.textContent === "Queue message")).toBe(true);
  });
});

describe("channel conversation composer", () => {
  const ask = { mode: "ask", channelLabel: "Telegram", targetTitle: "You", status: "on" } as const;
  const post = { mode: "post", channelLabel: "Telegram", targetTitle: "Maya", status: "on" } as const;
  const buttonNamed = (label: string) =>
    [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === label);
  const placeholder = () => container.querySelector("textarea")?.getAttribute("placeholder");

  it("asks GoatCitadel in the operator's own conversation", async () => {
    const props = composerProps({ channelReply: ask });
    await act(async () => root.render(<ChatTextComposer props={props} />));
    expect(placeholder()).toBe("Ask GoatCitadel. The answer also goes to Telegram.");
    expect(sendButton().disabled).toBe(false);
    await act(async () => sendButton().click());
    expect(props.onSend).toHaveBeenCalledOnce();
  });

  it("posts verbatim in someone else's or a group conversation", async () => {
    const props = composerProps({ channelReply: post });
    await act(async () => root.render(<ChatTextComposer props={props} />));
    expect(placeholder()).toBe("Posts to Maya on Telegram as your bot");
    expect(buttonNamed("Send")).toBeUndefined();
    await act(async () => buttonNamed("Post to Maya")!.click());
    expect(props.onSend).toHaveBeenCalledOnce();
    const group = { ...post, targetTitle: "Family group" };
    await act(async () => root.render(<ChatTextComposer props={{ ...props, channelReply: group }} />));
    expect(placeholder()).toBe("Posts to Family group on Telegram as your bot");
    expect(buttonNamed("Post to Family group")).toBeDefined();
  });

  it("keeps the submit label for a running turn, an edit and a send in flight", async () => {
    await act(async () =>
      root.render(
        <ChatTextComposer
          props={composerProps({ channelReply: post, hasActiveStream: true, canSendWhileRunning: true })}
        />,
      ),
    );
    expect(buttonNamed("Queue message")).toBeDefined();
    await act(async () =>
      root.render(<ChatTextComposer props={composerProps({ channelReply: post, editingTurnId: "turn-1" })} />),
    );
    expect(buttonNamed("Send edited message")).toBeDefined();
    await act(async () =>
      root.render(<ChatTextComposer props={composerProps({ channelReply: post, sending: true })} />),
    );
    expect(buttonNamed("Sending…")).toBeDefined();
  });

  it("hides model and attachment tools in channel conversations", async () => {
    for (const channelReply of [ask, post]) {
      await act(async () => root.render(<ChatTextComposer props={composerProps({ channelReply })} />));
      expect(container.querySelector('button[aria-label$="Model and reasoning options"]')).toBeNull();
      const panel = await openPlusPanel();
      expect(buttonIn(panel, "Attach files")).toBeUndefined();
      expect(panel.querySelector('select[aria-label="Web search"]')).toBeNull();
      expect(buttonIn(panel, "Plan first")).toBeUndefined();
      expect(buttonIn(panel, "Review answer")).toBeUndefined();
      expect(panel.textContent).not.toContain("Voice and images");
      await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    }
    await act(async () => root.render(<ChatTextComposer props={composerProps()} />));
    expect(container.querySelector('button[aria-label$="Model and reasoning options"]')).not.toBeNull();
    const panel = await openPlusPanel();
    expect(buttonIn(panel, "Attach files")).toBeDefined();
    expect(panel.querySelector('select[aria-label="Web search"]')).not.toBeNull();
    expect(buttonIn(panel, "Plan first")).toBeDefined();
    expect(panel.textContent).toContain("Voice and images");
  });

  it("keeps the queue, the route notices and the way to a command beside the draft", async () => {
    const props = composerProps({ channelReply: post, routeBoundaryAckRequired: true });
    await act(async () => root.render(<ChatTextComposer props={props} />));
    expect(buttonNamed("Acknowledge fallback")).toBeDefined();
    // The model tools are hidden, so the notice cannot send the operator to a model picker.
    expect(buttonNamed("Choose another model")).toBeUndefined();
    expect(buttonIn(await openPlusPanel(), "Commands and context")).toBeDefined();
  });

  it("hides the Options sheet's model and attachment tools on a phone", async () => {
    media.phone = true;
    media.coarse = true;
    const props = composerProps({ channelReply: post });
    await act(async () => root.render(<ChatTextComposer props={props} />));
    expect(placeholder()).toBe("Posts to Maya on Telegram as your bot");
    // The icon button keeps the full label as its accessible name.
    await act(async () => buttonNamed("Post to Maya")!.click());
    expect(props.onSend).toHaveBeenCalledOnce();
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Composer controls"] button[aria-label="Options"]')!
        .click(),
    );
    const sheet = container.querySelector<HTMLElement>('[role="dialog"][aria-label="Message options"]')!;
    expect(sheet.querySelector('button[aria-label="Attach files"]')).toBeNull();
    expect(sheet.querySelector('button[aria-label$="Model and reasoning options"]')).toBeNull();
    expect(sheet.textContent).not.toContain("Voice and images");
    expect(sheet.textContent).toContain("Commands and context");
  });

  it("explains a removed channel beside Send and does not send", async () => {
    const props = composerProps({ channelReply: { ...post, status: "removed" } });
    await act(async () => root.render(<ChatTextComposer props={props} />));
    const reason = container.querySelector("#cockpit-chat-send-reason");
    expect(reason?.textContent).toBe("This channel was removed. Its conversations stay readable.");
    expect(container.querySelector("textarea")?.getAttribute("aria-describedby")).toBe("cockpit-chat-send-reason");
    // The button no longer promises where the message would go, and it cannot send.
    expect(buttonNamed("Post to Maya")).toBeUndefined();
    expect(container.querySelector('button[aria-label="Post to Maya"]')).toBeNull();
    expect(sendButton().disabled).toBe(true);
    // Nothing invites typing a message that cannot go anywhere: the box is off and says why instead of "Posts to".
    const draft = container.querySelector("textarea")!;
    expect(draft.disabled).toBe(true);
    expect(draft.placeholder).toBe("This channel was removed. Its conversations stay readable.");
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    await act(async () => container.querySelector("textarea")!.dispatchEvent(enter));
    expect(props.onSend).not.toHaveBeenCalled();
  });

  it("asks for the channel to be turned back on while it is off", async () => {
    const props = composerProps({ channelReply: { ...ask, status: "off" } });
    await act(async () => root.render(<ChatTextComposer props={props} />));
    expect(container.querySelector("#cockpit-chat-send-reason")?.textContent).toBe("Turn Telegram back on to reply.");
    expect(sendButton().disabled).toBe(true);
    expect(cockpitSendBlockReason(props)).toBe("Turn Telegram back on to reply.");
    const draft = container.querySelector("textarea")!;
    expect(draft.disabled).toBe(true);
    expect(draft.placeholder).toBe("Turn Telegram back on to reply.");
  });

  it("says why a WhatsApp reply can't go once their last message is a day old, in the one reason line", async () => {
    const hoursAgo = (hours: number) => new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const whatsapp = { ...post, channelLabel: "WhatsApp" } as const;
    const props = composerProps({
      channelReply: { ...whatsapp, replyWindow: { channelKey: "whatsapp", lastInboundAt: hoursAgo(25) } },
    });
    await act(async () => root.render(<ChatTextComposer props={props} />));
    const reason = container.querySelector("#cockpit-chat-send-reason");
    expect(reason?.textContent).toBe(WHATSAPP_REPLY_WINDOW_CLOSED);
    // The sentence rides the composer's existing reason line: no second live region appears for it.
    expect(container.querySelectorAll('[role="status"], [role="alert"], [aria-live]')).toHaveLength(1);
    expect(reason?.getAttribute("role")).toBe("status");
    const draft = container.querySelector("textarea")!;
    expect(draft.disabled).toBe(true);
    expect(draft.placeholder).toBe(WHATSAPP_REPLY_WINDOW_CLOSED);
    expect(draft.getAttribute("aria-describedby")).toBe("cockpit-chat-send-reason");
    expect(sendButton().disabled).toBe(true);
    expect(cockpitSendBlockReason(props)).toBe(WHATSAPP_REPLY_WINDOW_CLOSED);
    await act(async () =>
      container
        .querySelector("textarea")!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })),
    );
    expect(props.onSend).not.toHaveBeenCalled();

    // An hour after their message the window is open, and nothing is blocked.
    const open = composerProps({
      channelReply: { ...whatsapp, replyWindow: { channelKey: "whatsapp", lastInboundAt: hoursAgo(1) } },
    });
    await act(async () => root.render(<ChatTextComposer props={open} />));
    expect(container.querySelector("#cockpit-chat-send-reason")).toBeNull();
    expect(container.querySelectorAll('[role="status"], [role="alert"], [aria-live]')).toHaveLength(0);
    expect(container.querySelector("textarea")!.disabled).toBe(false);
    expect(container.querySelector("textarea")!.placeholder).toBe("Posts to Maya on WhatsApp as your bot");
  });

  it("stays sendable while the channel needs attention", async () => {
    const props = composerProps({ channelReply: { ...post, status: "needs_attention" } });
    await act(async () => root.render(<ChatTextComposer props={props} />));
    expect(container.querySelector("#cockpit-chat-send-reason")).toBeNull();
    expect(container.querySelector("textarea")!.disabled).toBe(false);
    expect(container.querySelector("textarea")!.placeholder).toBe("Posts to Maya on Telegram as your bot");
    await act(async () => buttonNamed("Post to Maya")!.click());
    expect(props.onSend).toHaveBeenCalledOnce();
  });

  it("adds no file from a drop or a paste, and still pastes text", async () => {
    const base = composerProps({ channelReply: post, onDrop: vi.fn(), onComposerPaste: vi.fn() });
    await act(async () => root.render(<ChatTextComposer props={withoutFileInput(base)} />));
    const file = new File(["x"], "a.txt", { type: "text/plain" });
    const fire = (target: Element, type: string, extra: Record<string, unknown>) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      for (const [key, value] of Object.entries(extra)) Object.defineProperty(event, key, { value });
      act(() => void target.dispatchEvent(event));
      return event;
    };
    const drop = fire(container.querySelector("form")!, "drop", { dataTransfer: { types: ["Files"], files: [file] } });
    expect(base.onDrop).not.toHaveBeenCalled();
    expect(drop.defaultPrevented).toBe(true);
    const textarea = container.querySelector("textarea")!;
    const image = fire(textarea, "paste", { clipboardData: { types: ["Files"], files: [file], items: [] } });
    expect(base.onComposerPaste).not.toHaveBeenCalled();
    expect(image.defaultPrevented).toBe(true);
    const text = fire(textarea, "paste", { clipboardData: { types: ["text/plain"], files: [], items: [] } });
    expect(base.onComposerPaste).toHaveBeenCalledOnce();
    expect(text.defaultPrevented).toBe(false);
  });

  it("does not send a file that is attached, with or without a message", async () => {
    const pendingAttachments = [{ attachmentId: "a", fileName: "a.txt", mimeType: "text/plain", sizeBytes: 1 }];
    const reason = "Files aren't sent in channel conversations. Remove them to send.";
    for (const draft of ["", "Hello"]) {
      const props = composerProps({ channelReply: post, pendingAttachments, draft });
      await act(async () => root.render(<ChatTextComposer props={props} />));
      expect((buttonNamed("Post to Maya") as HTMLButtonElement).disabled).toBe(true);
      expect(container.querySelector("#cockpit-chat-send-reason")?.textContent).toBe(reason);
      // The chip stays so the operator can remove the file.
      expect(container.textContent).toContain("a.txt");
      expect(props.onSend).not.toHaveBeenCalled();
    }
  });

  it("shows a neutral, unsendable composer while the channel is being checked", async () => {
    const props = composerProps({ channelCheck: "checking" });
    await act(async () => root.render(<ChatTextComposer props={props} />));
    expect(placeholder()).toBe("Checking this channel…");
    expect(container.querySelector("#cockpit-chat-send-reason")?.textContent).toBe("Checking this channel…");
    expect(sendButton().disabled).toBe(true);
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    await act(async () => container.querySelector("textarea")!.dispatchEvent(enter));
    expect(props.onSend).not.toHaveBeenCalled();
    expect(container.querySelector('button[aria-label="Attach files"]')).toBeNull();
    expect(container.querySelector('button[aria-label$="Model and reasoning options"]')).toBeNull();
    expect(buttonNamed("Plan first")).toBeUndefined();
    expect(container.textContent).not.toContain("Voice and images");
  });

  it("says so when the channel could not be checked", async () => {
    const props = composerProps({ channelCheck: "unavailable" });
    await act(async () => root.render(<ChatTextComposer props={props} />));
    const message = "Couldn't check this channel. Try again from Messaging.";
    expect(placeholder()).toBe(message);
    expect(container.querySelector("#cockpit-chat-send-reason")?.textContent).toBe(message);
    expect(sendButton().disabled).toBe(true);
    expect(cockpitSendBlockReason(props)).toBe(message);
  });
});
