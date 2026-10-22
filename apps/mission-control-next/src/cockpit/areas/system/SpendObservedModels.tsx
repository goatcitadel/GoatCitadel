import { plural } from "@goatcitadel/mission-control-shared/content/format";
import { useModelLabelLookup } from "../../data/use-model-label";
import { TechnicalDetails } from "../../ui/TechnicalDetails";

/**
 * Observed models by catalog name (VR-04). While the catalog loads, or when it can't be read, the row says so rather
 * than calling every model unnamed; the raw model IDs stay in technical details.
 */
export function SpendObservedModels({ providerKey, models }: { providerKey: string; models: readonly string[] }) {
  const lookup = useModelLabelLookup(providerKey, models.length > 0);
  const shown = models.slice(0, 3);
  const names = !models.length
    ? "Not reported"
    : lookup.status === "ready"
      ? `${shown.map(lookup.labelFor).join(", ")}${models.length > 3 ? `, +${models.length - 3} more` : ""}`
      : `${plural(models.length, "model")}, names ${lookup.status === "loading" ? "loading" : "unavailable"}`;
  return (
    <>
      <p className="mt-1 break-words text-xs text-fg-muted">Models observed: {names}</p>
      {models.length ? (
        <TechnicalDetails label="Model IDs">
          <p className="break-all font-mono text-xs">{models.join(", ")}</p>
        </TechnicalDetails>
      ) : null}
    </>
  );
}
