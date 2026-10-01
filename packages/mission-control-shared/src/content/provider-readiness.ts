import type { ProviderModelCatalogOption } from "../hooks/useProviderModelCatalog.js";
import type { StatusPresentation } from "./status-vocabulary.js";

type ReadinessInput = Partial<Pick<ProviderModelCatalogOption, "authReadiness" | "modelProbeState">>;

export function presentProviderReadiness(provider: ReadinessInput): StatusPresentation {
  switch (provider.authReadiness?.status) {
    case "missing":
      return { label: "Needs setup", tone: "waiting" };
    case "invalid":
      return { label: "Key rejected", tone: "failed" };
    case "unavailable":
      return { label: "Unavailable", tone: "failed" };
    case "ready":
      return { label: "Connected", tone: "done" };
    default:
      break;
  }
  if (provider.modelProbeState === "ready") return { label: "Connected", tone: "done" };
  if (provider.modelProbeState === "error") return { label: "Not answering", tone: "failed" };
  if (provider.modelProbeState === "empty") return { label: "No models loaded", tone: "waiting" };
  if (provider.authReadiness?.status === "configured") return { label: "Key saved", tone: "neutral" };
  return { label: "Not checked", tone: "neutral" };
}
