import { request } from "@goatcitadel/mission-control-shared/api/client-core";
import {
  createLlmChatCompletion,
  fetchLlmConfig,
  fetchLlmModels,
} from "@goatcitadel/mission-control-shared/api/platform";
import { ensure, pass } from "../runner/assert";
import type { CheckDef } from "../runner/types";
import { exerciseProvider } from "./dev-verification";

interface ProviderSummary {
  readonly providerId?: string;
}

const COMPLETION_PROMPT = "Reply with one word: ready.";

export const providerChecks: readonly CheckDef[] = [
  {
    id: "llm.providers",
    kind: "probe",
    domain: "llm",
    title: "Configured providers",
    tier: "read",
    routes: ["GET /api/v1/llm/providers"],
    async run(ctx) {
      const body = await request<{ readonly items?: readonly ProviderSummary[] }>("/api/v1/llm/providers", {
        signal: ctx.signal,
      });
      const ids = (body.items ?? []).map((provider) => provider.providerId ?? "");
      ensure(ids.length > 0, "No providers are configured.", body);
      ensure(
        ids.every((id) => id !== ""),
        "A provider has no id.",
        body,
      );
      return pass(`${ids.length} provider(s): ${ids.join(", ")}.`);
    },
  },
  {
    id: "llm.config",
    kind: "probe",
    domain: "llm",
    title: "Active provider and model",
    tier: "read",
    routes: ["GET /api/v1/llm/config"],
    async run() {
      const config = await fetchLlmConfig();
      ensure(config.activeProviderId, "No active provider is set.", config);
      ensure(config.activeModel, "No active model is set.", config);
      ensure(
        config.providers.some((provider) => provider.providerId === config.activeProviderId),
        `Active provider ${config.activeProviderId} is not in the provider list.`,
        config,
      );
      return pass(`Active: ${config.activeProviderId} / ${config.activeModel}.`);
    },
  },
  {
    id: "llm.completion",
    kind: "probe",
    domain: "llm",
    title: "Chat completion through the active provider",
    tier: "mutate",
    description: "Records a model-usage entry. In the sandbox the active provider is the deterministic stub.",
    routes: ["GET /api/v1/llm/config", "POST /api/v1/llm/chat-completions"],
    async run() {
      const config = await fetchLlmConfig();
      const reply = await createLlmChatCompletion({
        providerId: config.activeProviderId,
        model: config.activeModel,
        messages: [{ role: "user", content: COMPLETION_PROMPT }],
        max_tokens: 16,
      });
      const text = String(reply.choices?.[0]?.message?.content ?? "").trim();
      ensure(text !== "", "The provider returned an empty completion.", reply);
      return pass(`${config.activeModel} answered: “${text.slice(0, 80)}”.`, reply);
    },
  },
  {
    id: "llm.model-catalog",
    kind: "probe",
    domain: "llm",
    title: "Live model catalog",
    tier: "external",
    realSafe: true,
    description:
      "Asks the active provider for its model list. The gateway may answer from its catalog cache; a refresh reaches the provider's API and updates that cache. Spends no tokens. The sandbox stub may not serve a catalog.",
    routes: ["GET /api/v1/llm/config", "GET /api/v1/llm/models"],
    async run() {
      const config = await fetchLlmConfig();
      const catalog = await fetchLlmModels(config.activeProviderId);
      const warning = typeof catalog.warning === "string" && catalog.warning !== "" ? `: ${catalog.warning}` : "";
      ensure(catalog.source === "live", `The catalog came from ${catalog.source}${warning}.`, catalog);
      // The gateway serves a cached catalog as "live" with catalogStatus "stale" while it revalidates.
      ensure(
        catalog.catalogStatus !== "stale",
        "The catalog is a stale cached copy; the provider was not confirmed live.",
        catalog,
      );
      ensure(catalog.items.length > 0, `The live catalog lists no models${warning}.`, catalog);
      return pass(`${catalog.items.length} models listed live by ${config.activeProviderId}.`);
    },
  },
  {
    id: "llm.provider-exercise",
    kind: "probe",
    domain: "llm",
    title: "Provider exercise (simple prompt)",
    tier: "external",
    realSafe: true,
    description:
      "Sends one short prompt through the active provider. Spends tokens and records model-usage entries on this gateway.",
    routes: ["POST /api/v1/dev/verification/provider-exercise"],
    async run(ctx) {
      const result = await exerciseProvider({ scenario: "simple" }, ctx.signal);
      ensure(result.ok, `The provider exercise failed: ${result.error ?? "no error message"}.`, result);
      return pass(`${result.model ?? "The model"} answered in ${result.elapsedMs ?? "?"} ms.`, result);
    },
  },
];
