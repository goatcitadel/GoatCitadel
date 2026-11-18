// Compatibility export: the portable client is shared with the Gateway without UI dependencies.
export * from "@goatcitadel/session-control-client/http";
import {
  DEFAULT_GATEWAY_HOST,
  DEFAULT_GATEWAY_PORT,
  isTrustedGatewayHost,
} from "@goatcitadel/session-control-client/http";

export function inferDefaultGatewayBaseUrl(): string {
  if (typeof window === "undefined") {
    return `http://${DEFAULT_GATEWAY_HOST}:${DEFAULT_GATEWAY_PORT}`;
  }
  const protocol = window.location.protocol === "https:" ? "https:" : "http:";
  const host = window.location.hostname || DEFAULT_GATEWAY_HOST;
  if (isTrustedGatewayHost(host, import.meta.env.VITE_GATEWAY_ALLOWED_HOSTS)) {
    return `${protocol}//${host}:${DEFAULT_GATEWAY_PORT}`;
  }
  // eslint-disable-next-line no-console -- Report the rejected inferred host to the operator.
  console.warn(
    `[goatcitadel] refusing inferred gateway host "${host}" because it is not trusted; ` +
      `falling back to ${DEFAULT_GATEWAY_HOST}:${DEFAULT_GATEWAY_PORT}. Set VITE_GATEWAY_ALLOWED_HOSTS to override.`,
  );
  return `${protocol}//${DEFAULT_GATEWAY_HOST}:${DEFAULT_GATEWAY_PORT}`;
}
