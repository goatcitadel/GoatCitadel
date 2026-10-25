// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { useModelLabel } from "./use-model-label";

const platform = vi.hoisted(() => ({ config: vi.fn(), models: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/platform", () => ({
  fetchLlmConfig: platform.config,
  fetchLlmModels: platform.models,
}));

function Probe({ options }: { options?: { showIdWhenUnnamed?: boolean } }) {
  return <p>{useModelLabel("stub", "verification-stub-chat", true, options)}</p>;
}

async function renderLabel(options?: { showIdWhenUnnamed?: boolean }) {
  const container = document.createElement("div");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrap = (child: ReactNode) => <QueryClientProvider client={client}>{child}</QueryClientProvider>;
  const root = createRoot(container);
  await act(async () => root.render(wrap(<Probe options={options} />)));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const text = container.textContent;
  act(() => root.unmount());
  return text;
}

describe("useModelLabel", () => {
  platform.config.mockResolvedValue({
    providerConfigs: [{ providerId: "stub", label: "Verification stub (loopback)" }],
  });
  platform.models.mockResolvedValue({ items: [] });

  it("keeps the model id beside the provider name by default", async () => {
    expect(await renderLabel()).toBe("verification-stub-chat · Verification stub (loopback)");
  });

  it("shows only the provider's display name when the model has none and the caller asks for it", async () => {
    expect(await renderLabel({ showIdWhenUnnamed: false })).toBe("Verification stub (loopback)");
  });

  it("still shows a catalog model name with the provider", async () => {
    platform.models.mockResolvedValueOnce({ items: [{ id: "verification-stub-chat", label: "Stub chat" }] });
    expect(await renderLabel({ showIdWhenUnnamed: false })).toBe("Stub chat · Verification stub (loopback)");
  });
});
