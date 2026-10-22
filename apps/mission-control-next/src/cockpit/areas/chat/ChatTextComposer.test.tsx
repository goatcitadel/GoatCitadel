// @vitest-environment happy-dom
import { act, createRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import {
  ChatTextComposer,
  cockpitSendBlockReason,
  ROUTE_CHECK_HINT_DELAY_MS,
  type ComposerProps,
} from "./ChatTextComposer";
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
    const labels = [...container.querySelectorAll("button")].map((b) => b.textContent?.trim());
    expect(labels).toContain("Commands and context");
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
      (container.querySelector('button[aria-label="Model and reasoning options"]') as HTMLButtonElement).click(),
    );
    await vi.waitFor(() => {
      const button = document.body.querySelector<HTMLButtonElement>('button[aria-label="Open personality settings"]');
      expect(button).toBeInstanceOf(HTMLButtonElement);
      expect(button?.disabled).toBe(false);
    });
    const button = document.body.querySelector('button[aria-label="Open personality settings"]') as HTMLButtonElement;
    expect(button.textContent?.trim()).toBe("Personality");
    await act(async () => button.click());
    expect(props.onOpenPersonalitiesSettings).toHaveBeenCalledOnce();
    await act(async () =>
      root.render(<ChatTextComposer props={composerProps({ onOpenPersonalitiesSettings: undefined })} />),
    );
    expect(
      (document.body.querySelector('button[aria-label="Open personality settings"]') as HTMLButtonElement).disabled,
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
    expect(container.querySelector('[aria-label="Attached files"]')?.textContent).toContain("TXT · 1 B");
    expect(container.querySelector('button[aria-label="Remove a.txt"] svg')).not.toBeNull();
    await act(async () => (container.querySelector('button[aria-label="Remove a.txt"]') as HTMLButtonElement).click());
    expect(props.onRemoveAttachment).toHaveBeenCalledWith("a");
    await act(async () =>
      (container.querySelector('button[aria-label="Model and reasoning options"]') as HTMLButtonElement).click(),
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

describe("touch and phone composer", () => {
  const enter = (init: KeyboardEventInit = {}) =>
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init });

  it("keeps Enter as send and the Shift+Enter hint for a keyboard and fine pointer", async () => {
    const props = composerProps();
    await act(async () => root.render(<ChatTextComposer props={props} />));
    expect(container.textContent).toContain("Shift+Enter for a new line");
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
    expect(container.querySelector('button[aria-label="Model and reasoning options"]')).toBeNull();
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
    expect(sheet.querySelector('button[aria-label="Model and reasoning options"]')).not.toBeNull();
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
