import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ProviderRoutingSettings } from "./ProviderRoutingSettings";

const provider = {
  providerId: "anthropic-main",
  label: "Anthropic",
  models: ["claude-sonnet"],
  modelProbeSource: "template_fallback",
  modelRefreshStatus: "stale",
};
vi.mock("@goatcitadel/mission-control-shared/hooks/useProviderModelCatalog", () => ({
  useProviderModelCatalog: () => ({
    config: { activeProviderId: "anthropic-main", activeModel: "claude-sonnet" },
    providers: [provider],
    loading: false,
    error: null,
    loadModelsForProvider: vi.fn(),
    reload: vi.fn(),
  }),
}));
vi.mock("../../../features/native-routes/settings/sections/use-provider-routing", () => ({
  useProviderRouting: () => ({
    routingEditor: { hasRemoteChanges: false, baseRevision: 42, rebaseToCurrent: vi.fn() },
    routingProvider: provider,
    routingModel: "claude-sonnet",
    routingProviderId: "anthropic-main",
    routingChange: { hasPending: false, change: null, refresh: vi.fn() },
    mutation: { pending: false, uncertain: null },
    setRoutingProviderId: vi.fn(),
    setRoutingModel: vi.fn(),
  }),
}));
vi.mock("../../../features/native-routes/settings/sections/use-provider-plan-actions", () => ({
  useProviderPlanActions: () => ({ mutation: { pending: false, uncertain: null } }),
}));
vi.mock("../../data/use-model-label", () => ({
  useModelLabel: (providerId?: string, modelId?: string) =>
    providerId === "anthropic-main" && modelId === "claude-sonnet" ? "Claude Sonnet · Anthropic" : "Unknown model",
}));
vi.mock("@goatcitadel/mission-control-shared/components/chat/ChatChangePlanActionDialog", () => ({
  ChatChangePlanActionDialog: () => null,
}));
vi.mock("./ProviderModelSearch", () => ({ ProviderModelSearch: () => null }));
vi.mock("./ProviderOutcomeCheck", () => ({ ProviderOutcomeCheck: () => null }));
vi.mock("./ProviderChangeStatus", () => ({ ProviderChangeStatus: () => null }));

describe("installation default routing", () => {
  it("names the Gateway default by model and provider label, and the catalog evidence in plain words", () => {
    const markup = renderToStaticMarkup(<ProviderRoutingSettings />);
    expect(markup).toContain("Gateway default: Claude Sonnet · Anthropic.");
    expect(markup).toContain("Suggested list");
    expect(markup).toContain("needs a refresh");
    for (const raw of ["Gateway default: anthropic-main", "template_fallback", ">stale", "revision 42"])
      expect(markup).not.toContain(raw);
  });
});
