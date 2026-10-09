// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderModelCatalogOption } from "@goatcitadel/mission-control-shared/hooks/useProviderModelCatalog";
import { ProviderConnectionEvidence } from "./ProviderConnectionEvidence";

const api = vi.hoisted(() => ({ fetchProviderSecretStatus: vi.fn(), fetchOpenAICodexOAuthStatus: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);

const provider: ProviderModelCatalogOption = {
  providerId: "provider-a",
  label: "Provider A",
  baseUrl: "https://example.test/v1",
  sanitizedEndpointIdentity: "https://example.test",
  apiStyle: "openai-responses",
  resolvedApiStyle: "openai-chat-completions",
  defaultModel: "saved-model",
  models: ["saved-model", "available-model"],
  modelProbeSource: "live",
  modelProbeState: "ready",
  modelRefreshStatus: "fresh",
  hasApiKey: false,
  apiKeySource: "keychain",
  capabilities: { vision: false, audio: false, video: false, toolCalling: true, jsonMode: true },
};
let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
const render = (props: Partial<Parameters<typeof ProviderConnectionEvidence>[0]> = {}) =>
  act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ProviderConnectionEvidence provider={provider} {...props} />
      </QueryClientProvider>,
    ),
  );
async function open() {
  const details = container.querySelector("details")!;
  await act(async () => {
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  api.fetchProviderSecretStatus.mockResolvedValue({ providerId: "provider-a", hasSecret: true, source: "keychain" });
  api.fetchOpenAICodexOAuthStatus.mockResolvedValue({
    connected: true,
    requiresReauth: false,
    available: true,
    accountLabel: "Team plan",
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("cockpit provider connection details", () => {
  it("reads nothing until the details are opened", async () => {
    await render();
    expect(api.fetchProviderSecretStatus).not.toHaveBeenCalled();
    expect(api.fetchOpenAICodexOAuthStatus).not.toHaveBeenCalled();
  });

  it("shows the configured and executed API, posture, capabilities and readiness from the secure owner", async () => {
    await render();
    await open();
    expect(api.fetchProviderSecretStatus).toHaveBeenCalledExactlyOnceWith("provider-a", expect.anything());
    const text = container.textContent ?? "";
    expect(text).toContain("Configured API: openai-responses");
    expect(text).toContain("Gateway executes: openai-chat-completions");
    expect(text).toContain("Remote provider");
    const capabilities = container.querySelector('[aria-label="Provider A capabilities"]')!;
    expect(capabilities.textContent).toContain("toolCalling");
    expect(capabilities.textContent).toContain("jsonMode");
    expect(capabilities.textContent).not.toContain("vision");
    const checklist = container.querySelector('[aria-label="Provider A readiness checklist"]')!;
    expect(checklist.textContent).toContain("Credential or local endpoint");
    expect(checklist.textContent).toContain("Ready");
    expect(checklist.textContent).toContain("Model discovery");
    expect(checklist.querySelectorAll("button")).toHaveLength(0);
  });

  it("never claims readiness while the credential status is unknown", async () => {
    api.fetchProviderSecretStatus.mockRejectedValue(new Error("unavailable"));
    await render();
    await open();
    expect(container.querySelector('[aria-label="Provider A readiness checklist"]')).toBeNull();
    expect(container.textContent).toContain(
      "The readiness checklist needs the credential status, which could not be read.",
    );
  });

  it("uses the ChatGPT login status for OpenAI Codex instead of a key", async () => {
    await render({ provider: { ...provider, providerId: "openai-codex", label: "OpenAI Codex" } });
    await open();
    expect(api.fetchOpenAICodexOAuthStatus).toHaveBeenCalledOnce();
    expect(api.fetchProviderSecretStatus).not.toHaveBeenCalled();
    const checklist = container.querySelector('[aria-label="OpenAI Codex readiness checklist"]')!;
    expect(checklist.textContent).toContain("Team plan");
    expect(checklist.textContent).toContain("Ready");
  });

  it("treats a local endpoint without a key as ready and labels it local", async () => {
    api.fetchProviderSecretStatus.mockResolvedValue({ providerId: "provider-a", hasSecret: false, source: "none" });
    await render({ provider: { ...provider, baseUrl: "http://127.0.0.1:8080/v1", resolvedApiStyle: undefined } });
    await open();
    expect(container.textContent).toContain("Local runtime");
    expect(container.textContent).toContain("Local endpoint, no key required");
    expect(container.textContent).toContain("Gateway executes: openai-responses");
  });
});
