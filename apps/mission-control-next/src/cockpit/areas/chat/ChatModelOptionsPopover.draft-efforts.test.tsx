// @vitest-environment happy-dom
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatCompletionReasoningEffort } from "@goatcitadel/contracts";
import { ChatComposerControls } from "./ChatComposerControls";

vi.mock("../../data/use-model-label", () => ({
  useModelLabel: (_providerId?: string, modelId?: string) => modelId ?? "Unknown model",
  useProviderLabelLookup: () => () => undefined,
}));
vi.mock("./use-chat-model-labels", () => ({ useChatModelLabels: () => (modelId: string) => modelId }));
vi.mock("@goatcitadel/mission-control-shared/hooks/useMediaQuery", () => ({ useMediaQuery: () => false }));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

type Props = Parameters<typeof ChatComposerControls>[0]["props"];
const effortsByModel: Record<string, ChatCompletionReasoningEffort[] | undefined> = {
  "stub/current": ["low", "medium", "high"],
  "stub/deep-thinker": ["none", "high", "xhigh"],
  "stub/unlisted": undefined,
};
function props(overrides: Partial<Props> = {}): Props {
  return {
    routePreflight: null,
    providerOptions: [
      {
        providerId: "stub",
        label: "Stub",
        models: ["current", "deep-thinker", "unlisted"],
        defaultModel: "current",
        disabled: false,
      },
    ],
    selectedProviderId: "stub",
    selectedModel: "current",
    modelSwitchDisabled: false,
    onRequestProviderChange: vi.fn(),
    onRequestModelChange: vi.fn(),
    onRequestModelChoice: vi.fn(),
    reasoningEffortsFor: (providerId: string, model: string) => effortsByModel[`${providerId}/${model}`],
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

const committedEfforts: ChatCompletionReasoningEffort[] = ["low", "medium", "high"];
async function openWith(input: Props) {
  await act(async () => root.render(<ChatComposerControls props={input} reasoningEfforts={[...committedEfforts]} />));
  const trigger = container.querySelector('button[aria-label$="Model and reasoning options"]') as HTMLButtonElement;
  await act(async () => trigger.click());
  await vi.waitFor(() => expect(document.querySelector('select[aria-label="Provider"]')).not.toBeNull());
}
const select = (label: string) => document.querySelector(`select[aria-label="${label}"]`) as HTMLSelectElement;
const pick = (label: string, value: string) =>
  act(async () => {
    const element = select(label);
    element.value = value;
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
const done = () =>
  act(async () => [...document.body.querySelectorAll("button")].find((node) => node.textContent === "Done")!.click());
const effortValues = () => [...select("Effort").options].map((option) => option.value);

describe("the model popover's effort choices follow the model that is held, not the one in use", () => {
  it("offers the held model's own levels once a different model is picked", async () => {
    await openWith(props());
    expect(effortValues()).toEqual(["minimal", "standard", "extended"]);
    await pick("Model", "deep-thinker");
    expect(effortValues()).toEqual(["off", "extended", "deep"]);
    expect(select("Effort").closest("label")?.textContent).not.toContain("support unverified");
  });

  it("resets an effort the held model does not offer, and sends a valid pair on Done", async () => {
    const input = props();
    await openWith(input);
    await pick("Model", "deep-thinker");
    expect(select("Effort").value).toBe("off");
    await done();
    expect(input.onRequestModelChoice).toHaveBeenCalledExactlyOnceWith({ model: "deep-thinker", thinkingLevel: "off" });
  });

  it("keeps the effort when the held model offers it, and sends only the model", async () => {
    const input = props({ currentThinkingLevel: "extended" });
    await openWith(input);
    await pick("Model", "deep-thinker");
    expect(select("Effort").value).toBe("extended");
    await done();
    expect(input.onRequestModelChoice).toHaveBeenCalledExactlyOnceWith({ model: "deep-thinker" });
  });

  it("sends an effort picked for the held model together with that model", async () => {
    const input = props();
    await openWith(input);
    await pick("Model", "deep-thinker");
    await pick("Effort", "deep");
    await done();
    expect(input.onRequestModelChoice).toHaveBeenCalledExactlyOnceWith({
      model: "deep-thinker",
      thinkingLevel: "deep",
    });
  });

  it("shows the effort as unverified, never the model in use's list, when the held model is not in the catalog", async () => {
    const input = props();
    await openWith(input);
    await pick("Model", "unlisted");
    expect(effortValues()).toEqual(["off", "minimal", "standard", "extended", "deep", "max", "ultra"]);
    expect(select("Effort").closest("label")?.textContent).toContain("support unverified");
    expect(select("Effort").value).toBe("standard");
    await done();
    expect(input.onRequestModelChoice).toHaveBeenCalledExactlyOnceWith({ model: "unlisted" });
  });

  it("treats the effort as unverified when the surface cannot look up another model", async () => {
    await openWith(props({ reasoningEffortsFor: undefined } as Partial<Props>));
    await pick("Model", "deep-thinker");
    expect(select("Effort").closest("label")?.textContent).toContain("support unverified");
  });

  it("goes back to the model in use's list when the pick is put back", async () => {
    await openWith(props());
    await pick("Model", "deep-thinker");
    await pick("Model", "current");
    expect(effortValues()).toEqual(["minimal", "standard", "extended"]);
  });
});
