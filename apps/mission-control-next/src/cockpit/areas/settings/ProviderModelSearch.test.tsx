// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderModelCatalogOption } from "@goatcitadel/mission-control-shared/hooks/useProviderModelCatalog";
import { ProviderModelSearch } from "./ProviderModelSearch";

const providerA: ProviderModelCatalogOption = {
  providerId: "provider-a",
  label: "Provider A",
  baseUrl: "https://example.test/v1",
  sanitizedEndpointIdentity: "https://example.test",
  apiStyle: "openai-responses",
  defaultModel: "saved-model",
  models: ["saved-model", "available-model"],
  modelProbeSource: "live",
  modelProbeState: "ready",
  modelRefreshStatus: "fresh",
  hasApiKey: true,
};
const codex: ProviderModelCatalogOption = {
  ...providerA,
  providerId: "openai-codex",
  label: "OpenAI Codex",
  defaultModel: "codex-default",
  models: ["codex-default", "codex-other"],
};
let root: Root;
let container: HTMLDivElement;
const onSelect = vi.fn();
type Props = Partial<Parameters<typeof ProviderModelSearch>[0]>;
const render = (props: Props = {}) =>
  act(async () =>
    root.render(
      <ProviderModelSearch
        providers={[providerA]}
        activeProviderId="provider-a"
        activeModel="saved-model"
        disabled={false}
        onSelect={onSelect}
        {...props}
      />,
    ),
  );
const buttons = (label: string) =>
  [...container.querySelectorAll("button")].filter((item) => item.textContent === label);
async function search(text: string) {
  const input = container.querySelector<HTMLInputElement>('input[type="search"]')!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("cockpit cross-provider model search", () => {
  it("stages a searched provider and model without saving, and marks the saved default", async () => {
    await render({
      providers: [providerA, { ...providerA, providerId: "provider-b", label: "Provider B", models: ["other-model"] }],
    });
    await search("other");
    const choices = container.querySelector('[aria-label="Matching provider models"]')!;
    expect(choices.textContent).toContain("Provider B");
    expect(choices.textContent).toContain("other-model");
    expect(choices.textContent).not.toContain("available-model");
    await act(async () => buttons("Choose")[0]!.click());
    expect(onSelect).toHaveBeenCalledExactlyOnceWith({ providerId: "provider-b", model: "other-model" });
    expect(container.textContent).toContain("Choosing only fills the routing draft");
    await search("saved");
    expect(container.querySelector('[aria-label="Matching provider models"]')!.textContent).toContain("Saved default");
    expect(buttons("Choose")).toHaveLength(0);
  });

  it("offers no choice for a blocked model or a llama.cpp endpoint that needs checking", async () => {
    await render({
      providers: [
        { ...providerA, providerId: "provider-b", label: "Provider B", hasApiKey: false, models: ["blocked-model"] },
        {
          ...providerA,
          providerId: "llamacpp",
          label: "llama.cpp",
          baseUrl: "http://127.0.0.1:8080/v1",
          modelProbeSource: "template_fallback",
          modelProbeState: "fallback",
          models: ["local-model"],
        },
      ],
      activeProviderId: "provider-a",
    });
    await search("model");
    const choices = container.querySelector('[aria-label="Matching provider models"]')!;
    expect(choices.textContent).toContain("blocked-model");
    expect(choices.textContent).toContain("Blocked");
    expect(choices.textContent).toContain("Check the llama.cpp endpoint under Local runtime before choosing it.");
    expect(buttons("Choose")).toHaveLength(0);
  });

  it("bounds the rendered matches and asks for a narrower search", async () => {
    const many = Array.from({ length: 75 }, (_, index) => `bulk-model-${index}`);
    await render({ providers: [{ ...providerA, models: many }] });
    await search("bulk");
    expect(container.querySelectorAll('[aria-label="Matching provider models"] li')).toHaveLength(50);
    expect(container.textContent).toContain("Showing 50 of 75 matches. Narrow the search to see the rest.");
  });

  it("stages OpenAI Codex for Chat with its default model, only when it is not already the default", async () => {
    await render({ providers: [providerA, codex] });
    await act(async () => buttons("Use OpenAI Codex for Chat")[0]!.click());
    expect(onSelect).toHaveBeenCalledExactlyOnceWith({ providerId: "openai-codex", model: "codex-default" });
    await render({ providers: [providerA, codex], activeProviderId: "openai-codex", activeModel: "codex-default" });
    expect(buttons("Use OpenAI Codex for Chat")).toHaveLength(0);
    await render({ providers: [providerA, { ...codex, defaultModel: "", models: [] }] });
    expect(buttons("Use OpenAI Codex for Chat")[0]!.disabled).toBe(true);
    expect(container.textContent).toContain("Refresh OpenAI Codex models before using it for Chat.");
  });

  it("does not offer an OpenAI Codex default model its catalog no longer lists", async () => {
    await render({ providers: [providerA, { ...codex, models: ["codex-other"] }] });
    expect(buttons("Use OpenAI Codex for Chat")[0]!.disabled).toBe(true);
    expect(container.textContent).toContain(
      "OpenAI Codex is not available for Chat yet. Connect ChatGPT, then refresh its models.",
    );
  });

  it("does not offer OpenAI Codex for Chat while its model is blocked", async () => {
    await render({ providers: [providerA, { ...codex, hasApiKey: false }] });
    const shortcut = buttons("Use OpenAI Codex for Chat")[0]!;
    expect(shortcut.disabled).toBe(true);
    expect(container.textContent).toContain(
      "OpenAI Codex is not available for Chat yet. Connect ChatGPT, then refresh its models.",
    );
    await act(async () => shortcut.click());
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("disables every choice while routing is locked", async () => {
    await render({ providers: [providerA, codex], disabled: true });
    await search("model");
    expect([...container.querySelectorAll("button")].every((item) => item.disabled)).toBe(true);
  });
});
