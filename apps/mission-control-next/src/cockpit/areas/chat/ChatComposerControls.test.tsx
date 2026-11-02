// @vitest-environment happy-dom
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatComposerControls } from "./ChatComposerControls";
// Catalog labels read the query cache; these tests exercise the controls, so the model id stands in for its name.
vi.mock("../../data/use-model-label", () => ({
  useModelLabel: (_providerId?: string, modelId?: string) => modelId ?? "Unknown model",
  useProviderLabelLookup: () => () => undefined,
}));
vi.mock("./use-chat-model-labels", () => ({ useChatModelLabels: () => (modelId: string) => modelId }));

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
    routePreflight: null,
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
/** Model and effort controls live in the options popover, which renders in a portal. */
async function openOptions() {
  const trigger = control('button[aria-label$="Model and reasoning options"]') as HTMLButtonElement;
  await act(async () => trigger.click());
  await vi.waitFor(() => expect(document.querySelector('select[aria-label="Provider"]')).not.toBeNull());
}
const effortSelect = () => document.querySelector('select[aria-label="Effort"]') as HTMLSelectElement;

describe("Chat composer controls", () => {
  it.each([false, true])("keeps modes visible and folds model controls at phone=%s", async (phone) => {
    media.phone = phone;
    const input = props();
    await act(async () => root.render(<ChatComposerControls props={input} />));
    expect(control('select[aria-label="Provider"]')).toBeNull();
    expect(control('select[aria-label="Web search"]')).not.toBeNull();
    const trigger = control('button[aria-label$="Model and reasoning options"]') as HTMLButtonElement;
    expect(trigger).not.toBeNull();
    await openOptions();
    expect(document.querySelector('select[aria-label="Provider"]')).not.toBeNull();
    expect(document.querySelector('select[aria-label="Effort"]')).not.toBeNull();
    const plan = [...container.querySelectorAll("button")].find((button) => button.textContent === "Plan first")!;
    await act(async () => plan.click());
    expect(input.onTogglePlanningMode).toHaveBeenCalledOnce();
  });

  it.each([
    ["off", "off", "false"],
    ["advisory", "standard", "true"],
  ] as const)(
    "keeps static mode labels and reports state through aria-pressed (%s)",
    async (planningMode, review, pressed) => {
      await act(async () =>
        root.render(
          <ChatComposerControls props={props({ planningMode, currentReviewDepth: review } as Partial<Props>)} />,
        ),
      );
      const buttons = [...container.querySelectorAll("button")];
      for (const [label, help] of [
        ["Plan first", "Plan before acting."],
        ["Review answer", "Check each answer with one extra model call"],
      ] as const) {
        const toggle = buttons.find((button) => button.textContent === label)!;
        expect(toggle.getAttribute("aria-pressed")).toBe(pressed);
        // Hover keeps the tooltip; assistive tech gets the same explanation through aria-describedby.
        const helper = document.getElementById(toggle.getAttribute("aria-describedby")!);
        expect(helper?.textContent).toContain(help);
        expect(toggle.getAttribute("title")).toBe(helper?.textContent);
        expect(helper?.className).toContain("sr-only");
      }
    },
  );

  it("sets web search to any mode, including off", async () => {
    const input = props({ currentWebMode: "auto" });
    await act(async () => root.render(<ChatComposerControls props={input} />));
    const select = control('select[aria-label="Web search"]') as HTMLSelectElement;
    expect(select.value).toBe("auto");
    expect([...select.options].map((option) => option.textContent)).toEqual(["Auto", "Off", "Deep"]);
    await act(async () => {
      select.value = "off";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(input.onSetWebMode).toHaveBeenCalledWith("off");
  });

  it("shows a conversation saved with the retired Quick mode as Quick (retired), not as Auto", async () => {
    await act(async () => root.render(<ChatComposerControls props={props({ currentWebMode: "quick" })} />));
    const select = control('select[aria-label="Web search"]') as HTMLSelectElement;
    expect(select.value).toBe("quick");
    const retired = [...select.options].find((option) => option.value === "quick")!;
    expect(retired.textContent).toBe("Quick (retired)");
    expect(retired.disabled).toBe(true);
  });

  it("accessible name starts with the visible text", async () => {
    await act(async () =>
      root.render(<ChatComposerControls props={props({ activePersonality: { name: "Concise" } } as Partial<Props>)} />),
    );
    const trigger = control('button[aria-label$="Model and reasoning options"]') as HTMLButtonElement;
    expect(trigger.getAttribute("aria-label")).toMatch(new RegExp(`^${trigger.textContent!.trim()} · `));
    expect(trigger.getAttribute("aria-label")).toMatch(/^stub-chat/);
    expect(control('[role="group"][aria-label="Composer controls"]')).not.toBeNull();
    await openOptions();
    expect(effortSelect().closest("label")?.firstChild?.textContent?.trim()).toBe("Effort");
    expect(effortSelect().getAttribute("aria-label")).toMatch(/^Effort/);
    const personality = document.querySelector<HTMLButtonElement>('button[aria-label$="Open personality settings"]')!;
    expect(personality.textContent).toBe("Concise");
    expect(personality.getAttribute("aria-label")).toMatch(/^Concise/);
  });

  it("explains Plan first and Review answer in visible text in the options popover (CH-R07)", async () => {
    await act(async () => root.render(<ChatComposerControls props={props()} />));
    for (const label of ["Plan first", "Review answer"]) {
      const toggle = [...container.querySelectorAll("button")].find((button) => button.textContent === label)!;
      expect(toggle.className).toContain("min-h-8");
    }
    await openOptions();
    const help = document.querySelector('[role="dialog"] dl, [data-radix-popper-content-wrapper] dl')!;
    expect(help.textContent).toContain("Plan first: Plan before acting.");
    expect(help.textContent).toContain("Review answer: Check each answer with one extra model call");
    expect(help.closest(".sr-only")).toBeNull();
  });
});

it.each([
  [["high"], "extended"],
  [["xhigh"], "deep"],
  [["low", "medium", "high"], "minimal"],
] as const)(
  "offers only advertised effort values for %j and retains incompatible saved effort",
  async (catalog, supportedValue) => {
    const input = props({ currentThinkingLevel: "off" });
    await act(async () => root.render(<ChatComposerControls props={input} reasoningEfforts={[...catalog]} />));
    await openOptions();
    const select = effortSelect();
    expect(select.value).toBe("off");
    expect(select.selectedOptions[0]?.disabled).toBe(true);
    expect(select.selectedOptions[0]?.textContent).toContain("current, unsupported");
    expect([...select.options].filter((option) => !option.disabled).map((option) => option.value)).not.toContain("off");
    await act(async () => {
      select.value = supportedValue;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(input.onSetThinkingLevel).toHaveBeenCalledExactlyOnceWith(supportedValue);
  },
);
it("offers every thinking level with a support note when the catalog lists no efforts", async () => {
  const input = props({ currentThinkingLevel: "standard" });
  await act(async () => root.render(<ChatComposerControls props={input} />));
  await openOptions();
  const select = effortSelect();
  expect(select.disabled).toBe(false);
  expect([...select.options].map((option) => option.value)).toEqual([
    "off",
    "minimal",
    "standard",
    "extended",
    "deep",
    "max",
    "ultra",
  ]);
  expect([...select.options].some((option) => option.disabled)).toBe(false);
  expect(select.closest("label")?.textContent).toContain("support unverified");
  await act(async () => {
    select.value = "deep";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(input.onSetThinkingLevel).toHaveBeenCalledExactlyOnceWith("deep");
});
it("only offers Off when none is advertised and preserves the saved value across a model switch", async () => {
  const input = props({ currentThinkingLevel: "extended" });
  await act(async () => root.render(<ChatComposerControls props={input} reasoningEfforts={["none", "high"]} />));
  await openOptions();
  expect([...effortSelect().options].map((option) => option.value)).toEqual(["off", "extended"]);
  await act(async () =>
    root.render(<ChatComposerControls props={{ ...input, selectedModel: "other" }} reasoningEfforts={["xhigh"]} />),
  );
  const select = effortSelect();
  expect(select.value).toBe("extended");
  expect(select.selectedOptions[0]?.disabled).toBe(true);
  expect(input.onSetThinkingLevel).not.toHaveBeenCalled();
});

describe("Route fallback notice (CH-13)", () => {
  it("names the fallback and its location plainly, keeps the raw reason out, and offers another model", async () => {
    const input = props({
      routeBoundaryAckRequired: true,
      routePreflight: {
        effectiveProviderId: "cloudy",
        effectiveModel: "cloud-model",
        runtimeClass: "cloud",
        degradedReason: "provider_unavailable:local-runtime",
      } as never,
    });
    await act(async () => root.render(<ChatComposerControls props={input} />));
    expect(container.textContent).toContain("This message would go to cloud-model instead of your chosen model.");
    expect(container.textContent).toContain("It is a cloud model, so this conversation would leave this computer.");
    expect(container.textContent).not.toContain("provider_unavailable");
    const choose = [...container.querySelectorAll("button")].find((b) => b.textContent === "Choose another model")!;
    expect(choose).toBeDefined();
    await act(async () => choose.click());
    await vi.waitFor(() => expect(document.querySelector('select[aria-label="Provider"]')).not.toBeNull());
    const acknowledge = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Acknowledge fallback",
    )!;
    await act(async () => acknowledge.click());
    expect(input.onAcknowledgeRouteBoundary).toHaveBeenCalledTimes(1);
  });
});

describe("File output notice", () => {
  it("warns before send that a text-only provider cannot create the requested file and offers another model", async () => {
    const input = props({
      routePreflight: {
        effectiveProviderId: "claude-code-cli",
        effectiveModel: "claude-sonnet-5-5",
        runtimeClass: "cloud",
        fileOutputNotice: {
          providerLabel: "Claude Code CLI (local login)",
          message:
            "Claude Code CLI (local login) cannot use GoatCitadel tools, so it cannot create a PDF, document, or deck.",
          alternatives: [
            { providerId: "openai", label: "OpenAI" },
            { providerId: "anthropic", label: "Anthropic" },
          ],
        },
      } as never,
    });
    await act(async () => root.render(<ChatComposerControls props={input} />));
    const notice = [...container.querySelectorAll("div")].find((node) =>
      node.firstElementChild?.textContent?.includes("cannot create a PDF, document, or deck"),
    );
    expect(notice?.getAttribute("role")).toBeNull();
    expect(notice?.textContent).toContain("cannot create a PDF, document, or deck");
    expect(notice?.textContent).toContain("Can create files: OpenAI, Anthropic");
    const choose = [...container.querySelectorAll("button")].find((b) => b.textContent === "Choose another model")!;
    await act(async () => choose.click());
    await vi.waitFor(() => expect(document.querySelector('select[aria-label="Provider"]')).not.toBeNull());
  });
});

describe("Why this model hint", () => {
  it("says which model the next message will use and why, never the raw source", async () => {
    const other = { selectedModel: "stub-other" } as Partial<Props>;
    const input = props({
      ...other,
      routePreflight: { effectiveModel: "stub-chat", selectionSource: "global" } as never,
    });
    await act(async () => root.render(<ChatComposerControls props={input} />));
    expect(container.textContent).toContain("Will use stub-chat — Workspace default");
    const unknown = props({
      ...other,
      routePreflight: { effectiveModel: "stub-chat", selectionSource: "future_kind" } as never,
    });
    await act(async () => root.render(<ChatComposerControls props={unknown} />));
    expect(container.textContent).toContain("Will use stub-chat — Selected by routing rules");
    expect(container.textContent).not.toContain("future_kind");
  });

  it("folds the line into the model chip's tooltip when the route is simply the chosen model", async () => {
    const input = props({
      routePreflight: { effectiveProviderId: "stub", effectiveModel: "stub-chat", selectionSource: "session" } as never,
    });
    await act(async () => root.render(<ChatComposerControls props={input} />));
    expect(container.textContent).not.toContain("Will use");
    expect(control('button[aria-label$="Model and reasoning options"]')?.getAttribute("title")).toBe(
      "Set for this conversation",
    );
    // A fallback or adjustment is never folded away.
    const adjusted = props({
      routePreflight: {
        effectiveProviderId: "stub",
        effectiveModel: "stub-chat",
        selectionSource: "session",
        normalizationReason: "adjusted",
      } as never,
    });
    await act(async () => root.render(<ChatComposerControls props={adjusted} />));
    expect(container.textContent).toContain("Will use stub-chat — Set for this conversation; adjusted");
  });
});
