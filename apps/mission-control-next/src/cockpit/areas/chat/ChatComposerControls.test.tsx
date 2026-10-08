// @vitest-environment happy-dom
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatComposerControls } from "./ChatComposerControls";

const media = vi.hoisted(() => ({ phone: false }));
vi.mock("@goatcitadel/mission-control-shared/hooks/useMediaQuery", () => ({ useMediaQuery: () => media.phone }));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  media.phone = false;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

type Props = Parameters<typeof ChatComposerControls>[0]["props"];
function props(overrides: Partial<Props> = {}): Props {
  return {
    providerOptions: [{ providerId: "stub", label: "Stub", models: ["stub-chat"], disabled: false }],
    selectedProviderId: "stub",
    selectedModel: "stub-chat",
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
    pendingAttachments: [],
    onRemoveAttachment: vi.fn(),
    fileInputRef: createRef<HTMLInputElement>(),
    onAttachFiles: vi.fn(),
    onUploadFiles: vi.fn(),
    historicalReadOnly: false,
    sending: false,
    routeBoundaryAckRequired: false,
    routeBoundaryAcknowledged: false,
    onAcknowledgeRouteBoundary: vi.fn(),
    ...overrides,
  } as unknown as Props;
}

const control = (selector: string) => container.querySelector(selector);

describe("Chat composer controls", () => {
  it.each([false, true])("keeps modes visible and folds model controls at phone=%s", async (phone) => {
    media.phone = phone;
    const input = props();
    await act(async () => root.render(<ChatComposerControls props={input} />));
    expect(control('select[aria-label="Provider"]')).toBeNull();
    expect(control('select[aria-label="Web search"]')).not.toBeNull();
    const trigger = control('button[aria-label="Model and reasoning options"]') as HTMLButtonElement;
    expect(trigger).not.toBeNull();
    await act(async () => trigger.click());
    expect(document.querySelector('select[aria-label="Provider"]')).not.toBeNull();
    expect(document.querySelector('select[aria-label="Thinking effort"]')).not.toBeNull();
    const plan = [...container.querySelectorAll("button")].find((button) => button.textContent === "Plan")!;
    await act(async () => plan.click());
    expect(input.onTogglePlanningMode).toHaveBeenCalledOnce();
  });

  it("sets web search to any mode, including off", async () => {
    const input = props({ currentWebMode: "auto" });
    await act(async () => root.render(<ChatComposerControls props={input} />));
    const select = control('select[aria-label="Web search"]') as HTMLSelectElement;
    expect(select.value).toBe("auto");
    expect([...select.options].map((option) => option.textContent)).toEqual(["Auto", "Off", "Quick", "Deep"]);
    await act(async () => {
      select.value = "off";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(input.onSetWebMode).toHaveBeenCalledWith("off");
  });
});
