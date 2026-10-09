import { useMemo, useState } from "react";
import {
  buildUniversalModelPickerOptions,
  type ProviderModelCatalogOption,
} from "@goatcitadel/mission-control-shared/hooks/useProviderModelCatalog";
import { Button } from "../../ui/Button";
import { providerFieldClass } from "./ProviderProfileFields";

const MAX_MATCHES = 50;
const CODEX_PROVIDER_ID = "openai-codex";
type RoutingChoice = { providerId: string; model: string };

/** llama.cpp is chosen only from current live evidence; anything else is checked under Local runtime first. */
function llamaNeedsCheck(provider: ProviderModelCatalogOption | undefined) {
  return (
    provider?.providerId === "llamacpp" &&
    (provider.modelProbeSource !== "live" ||
      provider.modelRefreshStatus !== "fresh" ||
      provider.modelProbeState !== "ready")
  );
}

/**
 * Searches every configured provider catalog and stages one provider and model in the routing draft. It never saves:
 * the routing review remains the only way to apply a change.
 */
export function ProviderModelSearch({
  providers,
  activeProviderId,
  activeModel,
  disabled,
  onSelect,
}: {
  providers: ProviderModelCatalogOption[];
  activeProviderId?: string;
  activeModel?: string;
  disabled: boolean;
  onSelect: (choice: RoutingChoice) => void;
}) {
  const [query, setQuery] = useState("");
  const matches = useMemo(
    () => (query.trim() ? buildUniversalModelPickerOptions({ providers, query, activeProviderId, activeModel }) : []),
    [providers, query, activeProviderId, activeModel],
  );
  const codex = providers.find((provider) => provider.providerId === CODEX_PROVIDER_ID);
  const codexModel = codex ? codex.defaultModel || codex.models[0] || "" : "";
  // The shortcut offers only what a search row would: a listed model the catalog does not mark blocked.
  const codexOption =
    codex && codexModel
      ? buildUniversalModelPickerOptions({ providers: [codex], activeProviderId, activeModel }).find(
          (option) => option.model === codexModel,
        )
      : undefined;
  const codexBlocked = Boolean(codexModel) && (!codexOption || codexOption.availability === "blocked");
  return (
    <div className="space-y-3">
      {codex && activeProviderId !== CODEX_PROVIDER_ID ? (
        <div className="space-y-1">
          <Button
            size="sm"
            disabled={disabled || !codexModel || codexBlocked}
            onClick={() => onSelect({ providerId: CODEX_PROVIDER_ID, model: codexModel })}
          >
            Use OpenAI Codex for Chat
          </Button>
          {!codexModel ? (
            <p className="text-xs text-fg-muted">Refresh OpenAI Codex models before using it for Chat.</p>
          ) : codexBlocked ? (
            <p className="text-xs text-fg-muted">
              OpenAI Codex is not available for Chat yet. Connect ChatGPT, then refresh its models.
            </p>
          ) : null}
        </div>
      ) : null}
      <label className="block text-sm text-fg-secondary">
        Search models across providers
        <input
          type="search"
          className={providerFieldClass}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Provider or model name"
        />
      </label>
      <p className="text-xs text-fg-muted">
        Choosing only fills the routing draft; review the routing change to apply it.
      </p>
      {query.trim() ? (
        matches.length ? (
          <>
            <ul aria-label="Matching provider models" className="divide-y divide-line-subtle">
              {matches.slice(0, MAX_MATCHES).map((option) => {
                const provider = providers.find((item) => item.providerId === option.providerId);
                const saved = option.providerId === activeProviderId && option.model === activeModel;
                const check = llamaNeedsCheck(provider);
                const blocked = option.availability === "blocked";
                return (
                  <li
                    key={option.id}
                    className="flex min-w-0 flex-wrap items-center justify-between gap-2 py-2 text-sm"
                  >
                    <span className="min-w-0 break-all text-fg">
                      {option.providerLabel} · {option.model}
                      <span className="block text-xs text-fg-muted">
                        {blocked ? "Blocked · " : ""}
                        {option.availabilityReason}
                      </span>
                    </span>
                    {saved ? (
                      <span className="text-xs font-medium text-accent">Saved default</span>
                    ) : check ? (
                      <span className="text-xs text-status-waiting">
                        Check the llama.cpp endpoint under Local runtime before choosing it.
                      </span>
                    ) : blocked ? null : (
                      <Button
                        size="sm"
                        disabled={disabled}
                        onClick={() => onSelect({ providerId: option.providerId, model: option.model })}
                      >
                        Choose
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
            {matches.length > MAX_MATCHES ? (
              <p className="text-xs text-fg-muted">
                Showing {MAX_MATCHES} of {matches.length} matches. Narrow the search to see the rest.
              </p>
            ) : null}
          </>
        ) : (
          <p className="text-sm text-fg-muted">No provider models match this search.</p>
        )
      ) : null}
    </div>
  );
}
