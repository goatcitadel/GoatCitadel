import { redactStructuredSecrets } from "@goatcitadel/contracts";

export function projectDurableRouteResponse<T>(value: T): T {
  return redactStructuredSecrets(value).value;
}
