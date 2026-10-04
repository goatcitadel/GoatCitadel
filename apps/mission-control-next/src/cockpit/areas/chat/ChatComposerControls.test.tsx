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
    onToggleResearchMode: vi.fn(),
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
  it("shows every route and mode control inline on wider screens", async () => {
    await act(async () => root.render(<ChatComposerControls props={props()} />));
    expect(control('select[aria-label="Provider"]')).not.toBeNull();
    expect(control('select[aria-label="Thinking effort"]')).not.toBeNull();
    expect(control("button[aria-expanded]")).toBeNull();
  });

  it("folds them behind one Options toggle on phones, keeping Attach and each control's name", async () => {
    media.phone = true;
    const input = props();
    await act(async () => root.render(<ChatComposerControls props={input} />));
    expect(control('button[aria-label="Attach files"]')).not.toBeNull();
    expect(control('select[aria-label="Provider"]')).toBeNull();
    const toggle = control("button[aria-expanded]") as HTMLButtonElement;
    expect(toggle.textContent).toContain("Options");
    expect(toggle.textContent).toContain("stub-chat · Standard");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    await act(async () => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const group = control(`#${toggle.getAttribute("aria-controls")}`);
    expect(group?.getAttribute("role")).toBe("group");
    for (const name of ["Provider", "Model", "Thinking effort"]) {
      expect(group?.querySelector(`select[aria-label="${name}"]`)).not.toBeNull();
    }
    const plan = [...(group?.querySelectorAll("button") ?? [])].find((button) => button.textContent === "Plan")!;
    await act(async () => plan.click());
    expect(input.onTogglePlanningMode).toHaveBeenCalledOnce();

    await act(async () => toggle.click());
    expect(control('select[aria-label="Provider"]')).toBeNull();
  });
});
