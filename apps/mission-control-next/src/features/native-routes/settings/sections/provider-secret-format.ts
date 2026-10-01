import type { ProviderModelCatalogOption } from "@goatcitadel/mission-control-shared/hooks/useProviderModelCatalog";

export function formatSecretStatusMeta(source: string | undefined, hasSecret: boolean): string {
  if (!hasSecret) {
    return "No key on file";
  }
  if (source === "keychain") {
    return "Key on file in OS keychain";
  }
  if (source === "env") {
    return "Key on file in local .env fallback";
  }
  if (source === "inline") {
    return "Key on file in inline config";
  }
  return "Key on file; value is never returned";
}

export function formatGoogleAdcReadinessMeta(readiness: ProviderModelCatalogOption["authReadiness"]): string {
  if (!readiness) {
    return "Gateway-local ADC readiness has not been inspected";
  }
  const source = formatGoogleAuthSourceLabel(readiness.source);
  if (readiness.status === "ready" && readiness.liveVerified) {
    return `${source}; live credential resolved by Gateway`;
  }
  if (readiness.status === "configured") {
    return `${source}; supported credential shape found, live token not claimed`;
  }
  return `${source}; ${readiness.status.replaceAll("_", " ")} (${readiness.reasonCode})`;
}

export function formatGoogleAuthSourceLabel(
  source: NonNullable<ProviderModelCatalogOption["authReadiness"]>["source"] | undefined,
): string {
  if (source === "adc_file") return "ADC file";
  if (source === "metadata") return "Google metadata service";
  if (source === "keychain") return "secure store";
  if (source === "env") return "environment";
  return "no credential source";
}
