import { useId } from "react";
import type { ProviderModelCatalogOption } from "@goatcitadel/mission-control-shared/hooks/useProviderModelCatalog";

/** The provider page's one selection: every saved provider, one row each, picked with a radio. */
export function ProviderList({
  providers,
  selectedId,
  activeProviderId,
  disabled,
  disabledReason,
  onSelect,
}: {
  providers: ProviderModelCatalogOption[];
  selectedId: string;
  activeProviderId?: string;
  disabled: boolean;
  disabledReason?: string;
  onSelect: (providerId: string) => void;
}) {
  const id = useId();
  const selectedMissing = Boolean(selectedId) && !providers.some((item) => item.providerId === selectedId);
  return (
    <fieldset disabled={disabled} aria-describedby={disabled && disabledReason ? `${id}-reason` : undefined}>
      <legend className="text-sm font-medium text-fg">Provider</legend>
      {disabled && disabledReason ? (
        <p id={`${id}-reason`} className="mt-1 text-xs text-fg-muted">
          {disabledReason}
        </p>
      ) : null}
      {providers.length === 0 ? (
        <p className="mt-2 text-sm text-fg-muted">No saved providers yet. Add a provider profile to start.</p>
      ) : (
        <ul className="mt-2 divide-y divide-line-subtle border-y border-line-subtle">
          {providers.map((item, index) => {
            const rowId = `${id}-row-${index}`;
            return (
              <li key={item.providerId}>
                <label className="flex min-h-11 items-center gap-3 px-1 py-2">
                  <input
                    type="radio"
                    name={`${id}-provider`}
                    value={item.providerId}
                    checked={item.providerId === selectedId}
                    aria-labelledby={`${rowId}-name`}
                    aria-describedby={`${rowId}-state`}
                    onChange={() => onSelect(item.providerId)}
                  />
                  <span className="min-w-0">
                    <span id={`${rowId}-name`} className="block break-words text-sm font-medium text-fg">
                      {item.label}
                    </span>
                    <span id={`${rowId}-state`} className="block text-xs text-fg-muted">
                      {item.hasApiKey ? "Credential configured" : "No credential reported"}
                      {item.providerId === activeProviderId ? " · Default provider" : ""}
                    </span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
      {selectedMissing ? (
        <p className="mt-2 text-sm text-status-waiting">The selected provider is no longer saved. Pick another.</p>
      ) : null}
    </fieldset>
  );
}
